#include "jk_bms_ble.h"

#include <stdio.h>
#include <string.h>

#include "ble_candidate_policy.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "host/ble_gap.h"
#include "host/ble_gatt.h"
#include "host/ble_hs_adv.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_npl.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "os/os_mbuf.h"

static const char *TAG = "jk-bms-ble";
static const ble_uuid16_t JK_SERVICE_UUID = BLE_UUID16_INIT(0xFFE0);
static const ble_uuid16_t JK_CHARACTERISTIC_UUID = BLE_UUID16_INIT(0xFFE1);
static bool configured;
static bool connected;
static bool connecting;
static bool target_seen;

static bool status_notification_received;
static bool cmd_0x96_sent;
static bool settings_retry_done;
static int64_t last_cmd_0x96_us;

static uint32_t connection_attempts;

static uint32_t connection_successes;
static uint32_t disconnect_count;
static uint32_t connected_since_seconds;
static uint32_t recovery_count;
static TaskHandle_t poll_task_handle;
static uint32_t notifications;
static uint32_t notification_bytes;
static uint16_t last_notification_length;
static uint8_t last_frame_type;
static uint32_t frame_counts[4];
static int last_status;
static int last_disconnect_reason;
static const char *phase = "idle";
static ble_addr_t target_address;
static uint16_t connection_handle;
static uint16_t write_handle;
static uint16_t notify_handle;
static jk_bms_parser_t parser;
static jk_bms_data_t latest_data;
static jk_bms_settings_t latest_settings;
static jk_bms_device_info_t latest_device_info;
static int64_t last_data_us;

#define JK_BMS_USER_SCAN_DURATION_MS 8000
#define JK_BMS_POLL_TASK_STACK_SIZE 4096u

typedef enum {
    BLE_SCAN_OWNER_NONE = 0,
    BLE_SCAN_OWNER_AUTO,
    BLE_SCAN_OWNER_USER,
} ble_scan_owner_t;

typedef struct {
    ble_addr_t address;
    char name[JK_BMS_BLE_SCAN_NAME_MAX_LEN + 1u];
    int8_t rssi_dbm;
    uint8_t rank;
} jk_bms_scan_candidate_internal_t;

static int64_t ble_started_us;
static uint32_t recovery_deadline_seconds;
static struct ble_npl_callout scan_retry_callout;
static bool nimble_synced;
static ble_scan_owner_t scan_owner = BLE_SCAN_OWNER_NONE;
static uint32_t user_scan_generation;
static jk_bms_ble_scan_state_t user_scan_state = JK_BMS_BLE_SCAN_IDLE;
static int user_scan_error_status;
static jk_bms_scan_candidate_internal_t
    user_scan_candidates[JK_BMS_BLE_SCAN_MAX_CANDIDATES];
static size_t user_scan_candidate_count;

static uint32_t bms_operation_generation;
static jk_bms_ble_operation_state_t bms_operation_state =
    JK_BMS_BLE_OPERATION_IDLE;
static jk_bms_ble_operation_phase_t bms_operation_phase =
    JK_BMS_BLE_PHASE_NONE;
static jk_bms_ble_operation_error_t bms_operation_error =
    JK_BMS_BLE_ERROR_NONE;

static bool selection_active;
static bool selection_validated;
static bool selection_save_claimed;
static ble_addr_t selection_address;
static uint32_t selection_operation_generation;
static jk_bms_ble_operation_error_t selection_disconnect_error =
    JK_BMS_BLE_ERROR_CONNECT_FAILED;

static bool reconnect_active;
static uint32_t reconnect_deadline_seconds;
static bool forget_active;
static bool forget_persisted;
static uint32_t forget_operation_generation;
static uint32_t forget_deadline_seconds;

static portMUX_TYPE data_lock = portMUX_INITIALIZER_UNLOCKED;

static int gap_event(struct ble_gap_event *event, void *arg);
static void scan(void);

static void retry_scan(struct ble_npl_event *event) {
    (void) event;
    scan();
}

static void end_connection(uint16_t conn_handle, const char *step, int status) {
    last_status = status;
    phase = step;
    portENTER_CRITICAL(&data_lock);
    if (selection_active && !selection_validated) {
        selection_disconnect_error = JK_BMS_BLE_ERROR_INVALID_BMS;
    }
    portEXIT_CRITICAL(&data_lock);
    ESP_LOGW(TAG, "%s не вдалося: %d", step, status);
    ble_gap_terminate(conn_handle, BLE_ERR_REM_USER_CONN_TERM);
}

static bool configure_target(const jk_bms_ble_target_t *target) {
    if (target == NULL) {
        configured = false;
        memset(&target_address, 0, sizeof(target_address));
        return true;
    }
    if (target->address_type > 3) {
        return false;
    }

    target_address.type = target->address_type;
    for (size_t index = 0; index < JK_BMS_BLE_ADDRESS_LEN; ++index) {
        /*
         * Persistent config stores canonical display order. NimBLE ble_addr_t
         * uses little-endian byte order internally.
         */
        target_address.val[JK_BMS_BLE_ADDRESS_LEN - 1 - index] =
            target->address[index];
    }
    configured = true;
    return true;
}

static bool is_target(const ble_addr_t *address) {
    return configured &&
           address->type == target_address.type &&
           memcmp(address->val, target_address.val,
                  sizeof(target_address.val)) == 0;
}



static uint32_t begin_bms_operation_locked(
    jk_bms_ble_operation_phase_t phase_value) {
    ++bms_operation_generation;
    if (bms_operation_generation == 0u) {
        bms_operation_generation = 1u;
    }
    bms_operation_state = JK_BMS_BLE_OPERATION_RUNNING;
    bms_operation_phase = phase_value;
    bms_operation_error = JK_BMS_BLE_ERROR_NONE;
    return bms_operation_generation;
}

static void finish_bms_operation_locked(
    jk_bms_ble_operation_state_t state,
    jk_bms_ble_operation_error_t error) {
    bms_operation_state = state;
    bms_operation_phase = JK_BMS_BLE_PHASE_NONE;
    bms_operation_error = error;
}

static void fail_selection_locked(jk_bms_ble_operation_error_t error) {
    selection_active = false;
    selection_validated = false;
    selection_save_claimed = false;
    memset(&selection_address, 0, sizeof(selection_address));
    selection_operation_generation = 0u;
    selection_disconnect_error = JK_BMS_BLE_ERROR_CONNECT_FAILED;
    finish_bms_operation_locked(JK_BMS_BLE_OPERATION_ERROR, error);
}

static bool advertisement_has_jk_service(
    const struct ble_hs_adv_fields *fields) {
    if (!fields) {
        return false;
    }
    for (uint8_t i = 0; i < fields->num_uuids16; ++i) {
        if (ble_uuid_u16(&fields->uuids16[i].u) == 0xFFE0u) {
            return true;
        }
    }
    return false;
}

static bool scan_candidate_address_equal(
    const ble_addr_t *lhs,
    const ble_addr_t *rhs) {
    return lhs && rhs &&
           lhs->type == rhs->type &&
           memcmp(lhs->val, rhs->val, sizeof(lhs->val)) == 0;
}

static bool scan_candidate_is_better(
    const jk_bms_scan_candidate_internal_t *lhs,
    const jk_bms_scan_candidate_internal_t *rhs) {
    if (lhs->rank != rhs->rank) {
        return lhs->rank > rhs->rank;
    }
    return lhs->rssi_dbm > rhs->rssi_dbm;
}

static void collect_user_scan_candidate(
    const struct ble_gap_disc_desc *advertisement) {
    if (!advertisement || !advertisement->data) {
        return;
    }

    struct ble_hs_adv_fields fields;
    memset(&fields, 0, sizeof(fields));
    if (ble_hs_adv_parse_fields(
            &fields,
            advertisement->data,
            advertisement->length_data) != 0) {
        return;
    }

    const bool has_ffe0 = advertisement_has_jk_service(&fields);
    const int rank = wattpost_bms_candidate_rank(
        has_ffe0, fields.name, fields.name_len);
    if (rank <= 0) {
        return;
    }

    jk_bms_scan_candidate_internal_t incoming;
    memset(&incoming, 0, sizeof(incoming));
    incoming.address = advertisement->addr;
    incoming.rssi_dbm = advertisement->rssi;
    incoming.rank = (uint8_t) rank;
    wattpost_bms_candidate_safe_name(
        fields.name,
        fields.name_len,
        incoming.name,
        sizeof(incoming.name));

    portENTER_CRITICAL(&data_lock);

    if (scan_owner != BLE_SCAN_OWNER_USER ||
        user_scan_state != JK_BMS_BLE_SCAN_RUNNING) {
        portEXIT_CRITICAL(&data_lock);
        return;
    }

    for (size_t i = 0; i < user_scan_candidate_count; ++i) {
        jk_bms_scan_candidate_internal_t *existing =
            &user_scan_candidates[i];
        if (!scan_candidate_address_equal(
                &existing->address, &incoming.address)) {
            continue;
        }

        if (incoming.rank > existing->rank) {
            existing->rank = incoming.rank;
        }
        if (incoming.rssi_dbm > existing->rssi_dbm) {
            existing->rssi_dbm = incoming.rssi_dbm;
        }
        if (fields.name_len > 0u) {
            strlcpy(
                existing->name,
                incoming.name,
                sizeof(existing->name));
        }
        portEXIT_CRITICAL(&data_lock);
        return;
    }

    if (user_scan_candidate_count < JK_BMS_BLE_SCAN_MAX_CANDIDATES) {
        user_scan_candidates[user_scan_candidate_count++] = incoming;
        portEXIT_CRITICAL(&data_lock);
        return;
    }

    size_t weakest = 0u;
    for (size_t i = 1u; i < user_scan_candidate_count; ++i) {
        if (scan_candidate_is_better(
                &user_scan_candidates[weakest],
                &user_scan_candidates[i])) {
            weakest = i;
        }
    }
    if (scan_candidate_is_better(
            &incoming, &user_scan_candidates[weakest])) {
        user_scan_candidates[weakest] = incoming;
    }

    portEXIT_CRITICAL(&data_lock);
}

static void finalize_user_scan(int reason) {
    bool resume_auto = false;

    portENTER_CRITICAL(&data_lock);
    if (scan_owner != BLE_SCAN_OWNER_USER) {
        portEXIT_CRITICAL(&data_lock);
        return;
    }

    scan_owner = BLE_SCAN_OWNER_NONE;
    user_scan_error_status = reason;
    user_scan_state =
        reason == 0 ? JK_BMS_BLE_SCAN_SUCCESS : JK_BMS_BLE_SCAN_ERROR;
    if (bms_operation_state == JK_BMS_BLE_OPERATION_RUNNING &&
        bms_operation_phase == JK_BMS_BLE_PHASE_SCANNING) {
        finish_bms_operation_locked(
            reason == 0
                ? JK_BMS_BLE_OPERATION_SUCCESS
                : JK_BMS_BLE_OPERATION_ERROR,
            reason == 0
                ? JK_BMS_BLE_ERROR_NONE
                : JK_BMS_BLE_ERROR_SUBSYSTEM_UNAVAILABLE);
    }

    for (size_t i = 1u; i < user_scan_candidate_count; ++i) {
        jk_bms_scan_candidate_internal_t value = user_scan_candidates[i];
        size_t j = i;
        while (j > 0u &&
               scan_candidate_is_better(
                   &value, &user_scan_candidates[j - 1u])) {
            user_scan_candidates[j] = user_scan_candidates[j - 1u];
            --j;
        }
        user_scan_candidates[j] = value;
    }

    resume_auto = configured && !connected && !connecting;
    portEXIT_CRITICAL(&data_lock);

    if (resume_auto) {
        scan();
    }
}

static void send_command(uint16_t conn_handle, uint16_t attr_handle, uint8_t command) {
    uint8_t frame[20] = {0xAA, 0x55, 0x90, 0xEB, command};
    for (size_t index = 0; index < sizeof(frame) - 1; ++index) {
        frame[sizeof(frame) - 1] += frame[index];
    }
    const int rc = ble_gattc_write_no_rsp_flat(conn_handle, attr_handle,
                                                frame, sizeof(frame));
    if (rc != 0) {
        ESP_LOGW(TAG, "Не вдалося надіслати команду 0x%02X: %d", command, rc);
    }
}

static int characteristic_discovered(uint16_t conn_handle, const struct ble_gatt_error *error,
                                     const struct ble_gatt_chr *characteristic, void *arg) {
    if (error->status == 0) {
        if (ble_uuid_cmp(&characteristic->uuid.u, &JK_CHARACTERISTIC_UUID.u) == 0) {
            portENTER_CRITICAL(&data_lock);
            if (characteristic->properties & BLE_GATT_CHR_PROP_NOTIFY) {
                notify_handle = characteristic->val_handle;
            }
            if (characteristic->properties &
                (BLE_GATT_CHR_PROP_WRITE | BLE_GATT_CHR_PROP_WRITE_NO_RSP)) {
                write_handle = characteristic->val_handle;
            }
            portEXIT_CRITICAL(&data_lock);
        }
        return 0;
    }
    uint16_t command_handle;
    portENTER_CRITICAL(&data_lock);
    command_handle = write_handle;
    const bool channels_ready = command_handle != 0 && notify_handle != 0;
    if (channels_ready) {
        phase = "commands";
    }
    portEXIT_CRITICAL(&data_lock);
    if (error->status != BLE_HS_EDONE || !channels_ready) {
        end_connection(conn_handle, "Канали BMS", error->status);
        return 0;
    }
    send_command(conn_handle, command_handle, 0x97);
    return 0;
}

static int service_discovered(uint16_t conn_handle, const struct ble_gatt_error *error,
                              const struct ble_gatt_svc *service, void *arg) {
    if (error->status == BLE_HS_EDONE) {
        return 0;
    }
    if (error->status != 0 || service == NULL) {
        end_connection(conn_handle, "Сервіс BMS", error->status);
        return 0;
    }
    phase = "characteristics";
    const int rc = ble_gattc_disc_all_chrs(conn_handle, service->start_handle,
                                           service->end_handle, characteristic_discovered, NULL);
    if (rc != 0) {
        end_connection(conn_handle, "Пошук каналів BMS", rc);
    }
    return 0;
}

static int start_connection_to_address(const ble_addr_t *address) {
    if (!address) {
        return BLE_HS_EINVAL;
    }

    uint8_t own_address_type;
    int rc = ble_hs_id_infer_auto(0, &own_address_type);
    if (rc != 0) {
        ESP_LOGW(TAG, "Не вдалося визначити адресу ESP32: %d", rc);
        return rc;
    }

    connecting = true;
    phase = "connecting";
    ++connection_attempts;
    rc = ble_gap_connect(
        own_address_type,
        address,
        30000,
        NULL,
        gap_event,
        NULL);
    if (rc != 0) {
        connecting = false;
        ESP_LOGW(TAG, "Не вдалося підключитися до BMS: %d", rc);
    }
    return rc;
}

static void connect(const struct ble_gap_disc_desc *advertisement) {
    const int cancel_rc = ble_gap_disc_cancel();
    if (cancel_rc != 0) {
        ESP_LOGW(TAG, "Не вдалося зупинити BLE-пошук: %d", cancel_rc);
        return;
    }

    portENTER_CRITICAL(&data_lock);
    if (scan_owner == BLE_SCAN_OWNER_AUTO) {
        scan_owner = BLE_SCAN_OWNER_NONE;
    }
    portEXIT_CRITICAL(&data_lock);

    if (start_connection_to_address(&advertisement->addr) != 0) {
        scan();
    }
}

static void scan(void) {
    portENTER_CRITICAL(&data_lock);
    const bool should_start =
        configured && !connected && !connecting &&
        !selection_active && !forget_active &&
        scan_owner == BLE_SCAN_OWNER_NONE;
    if (should_start) {
        scan_owner = BLE_SCAN_OWNER_AUTO;
    }
    portEXIT_CRITICAL(&data_lock);

    if (!should_start) {
        return;
    }

    uint8_t own_address_type;
    int rc = ble_hs_id_infer_auto(0, &own_address_type);
    if (rc != 0) {
        portENTER_CRITICAL(&data_lock);
        if (scan_owner == BLE_SCAN_OWNER_AUTO) {
            scan_owner = BLE_SCAN_OWNER_NONE;
        }
        portEXIT_CRITICAL(&data_lock);
        ESP_LOGW(TAG, "Не вдалося визначити адресу ESP32: %d", rc);
        return;
    }

    struct ble_gap_disc_params params = {0};
    params.filter_duplicates = 1;
    params.passive = 1;
    rc = ble_gap_disc(
        own_address_type,
        BLE_HS_FOREVER,
        &params,
        gap_event,
        NULL);
    if (rc == 0) {
        return;
    }

    portENTER_CRITICAL(&data_lock);
    if (scan_owner == BLE_SCAN_OWNER_AUTO) {
        scan_owner = BLE_SCAN_OWNER_NONE;
    }
    portEXIT_CRITICAL(&data_lock);

    if (rc == BLE_HS_EALREADY) {
        return;
    }

    ESP_LOGW(TAG, "Не вдалося почати BLE-пошук: %d; повтор через 5 с", rc);
    const ble_npl_error_t retry = ble_npl_callout_reset(
        &scan_retry_callout, ble_npl_time_ms_to_ticks32(5000));
    if (retry != BLE_NPL_OK) {
        ESP_LOGE(TAG, "Не вдалося запланувати повтор BLE-пошуку: %d", retry);
    }
}

static int gap_event(struct ble_gap_event *event, void *arg) {
    switch (event->type) {
        case BLE_GAP_EVENT_DISC: {
            ble_scan_owner_t owner;
            bool forgetting;
            portENTER_CRITICAL(&data_lock);
            owner = scan_owner;
            forgetting = forget_active;
            portEXIT_CRITICAL(&data_lock);

            if (owner == BLE_SCAN_OWNER_USER) {
                collect_user_scan_candidate(&event->disc);
                return 0;
            }

            bool manual_operation;
            portENTER_CRITICAL(&data_lock);
            manual_operation = selection_active ||
                user_scan_state == JK_BMS_BLE_SCAN_RUNNING;
            portEXIT_CRITICAL(&data_lock);
            if (owner == BLE_SCAN_OWNER_AUTO && !forgetting &&
                !manual_operation && !connected && !connecting &&
                is_target(&event->disc.addr)) {
                target_seen = true;
                phase = "target_seen";
                ESP_LOGI(TAG, "JK BMS знайдено, підключення");
                connect(&event->disc);
            }
            return 0;
        }
        case BLE_GAP_EVENT_DISC_COMPLETE: {
            ble_scan_owner_t owner;
            portENTER_CRITICAL(&data_lock);
            owner = scan_owner;
            if (owner == BLE_SCAN_OWNER_AUTO) {
                scan_owner = BLE_SCAN_OWNER_NONE;
            }
            portEXIT_CRITICAL(&data_lock);

            if (owner == BLE_SCAN_OWNER_USER) {
                finalize_user_scan(event->disc_complete.reason);
            }
            return 0;
        }
        case BLE_GAP_EVENT_CONNECT:
            connecting = false;
            last_status = event->connect.status;
            if (event->connect.status != 0) {
                bool failed_selection = false;
                portENTER_CRITICAL(&data_lock);
                if (selection_active) {
                    fail_selection_locked(JK_BMS_BLE_ERROR_CONNECT_FAILED);
                    failed_selection = true;
                }
                portEXIT_CRITICAL(&data_lock);
                ESP_LOGW(TAG, "Підключення до BMS не вдалося: %d", event->connect.status);
                if (failed_selection || configured) {
                    scan();
                }
                return 0;
            }
            const uint16_t conn_handle = event->connect.conn_handle;
            bool accept_connection;
            portENTER_CRITICAL(&data_lock);
            accept_connection = configured || selection_active;
            portEXIT_CRITICAL(&data_lock);
            if (!accept_connection) {
                ESP_LOGW(TAG, "Ігнорування BLE connection після forget");
                ble_gap_terminate(
                    conn_handle,
                    BLE_ERR_REM_USER_CONN_TERM);
                return 0;
            }

            const uint32_t connected_at = (uint32_t) (esp_timer_get_time() / 1000000);
            portENTER_CRITICAL(&data_lock);
            connected = true;
            status_notification_received = false;
            cmd_0x96_sent = false;
            settings_retry_done = false;
            last_cmd_0x96_us = 0;
            connected_since_seconds = connected_at;
            recovery_deadline_seconds = connected_since_seconds + 30;
            phase = "service";
            connection_handle = conn_handle;
            write_handle = 0;
            notify_handle = 0;
            if (selection_active) {
                bms_operation_phase = JK_BMS_BLE_PHASE_VALIDATING;
                selection_disconnect_error = JK_BMS_BLE_ERROR_INVALID_BMS;
            }
            portEXIT_CRITICAL(&data_lock);
            ++connection_successes;
            jk_bms_parser_reset(&parser);
            ESP_LOGI(TAG, "Підключено до JK BMS");
            const int rc = ble_gattc_disc_svc_by_uuid(conn_handle, &JK_SERVICE_UUID.u,
                                                       service_discovered, NULL);
            if (rc != 0) {
                end_connection(conn_handle, "Пошук сервісу BMS", rc);
            }
            return 0;
        case BLE_GAP_EVENT_DISCONNECT: {
            bool validated_selection_pending_save = false;
            portENTER_CRITICAL(&data_lock);
            connected = false;
            status_notification_received = false;
            cmd_0x96_sent = false;
            settings_retry_done = false;
            last_cmd_0x96_us = 0;
            connected_since_seconds = 0;
            recovery_deadline_seconds = 0;
            latest_data.valid = false;
            if (selection_active && !selection_validated) {
                fail_selection_locked(selection_disconnect_error);
            } else if (selection_active && selection_validated) {
                validated_selection_pending_save = true;
            }
            portEXIT_CRITICAL(&data_lock);
            connecting = false;
            last_status = event->disconnect.reason;
            last_disconnect_reason = event->disconnect.reason;
            ++disconnect_count;
            phase = "disconnected";
            ESP_LOGW(TAG, "BMS відключено");
            if (!validated_selection_pending_save) {
                scan();
            }
            return 0;
        }
        case BLE_GAP_EVENT_NOTIFY_RX: {
            bool accept_notification;
            portENTER_CRITICAL(&data_lock);
            accept_notification = configured || selection_active;
            portEXIT_CRITICAL(&data_lock);
            if (!accept_notification ||
                event->notify_rx.attr_handle != notify_handle) {
                return 0;
            }
            const uint16_t length = OS_MBUF_PKTLEN(event->notify_rx.om);
            ++notifications;
            notification_bytes += length;
            last_notification_length = length;
            uint8_t payload[320];
            if (length > sizeof(payload) ||
                os_mbuf_copydata(event->notify_rx.om, 0, length, payload) != 0) {
                ESP_LOGW(TAG, "Некоректний фрагмент даних BMS");
                return 0;
            }
            if (length >= 5 && payload[0] == 0x55 && payload[1] == 0xAA &&
                payload[2] == 0xEB && payload[3] == 0x90) {
                last_frame_type = payload[4];
                if (last_frame_type < sizeof(frame_counts) / sizeof(frame_counts[0])) {
                    ++frame_counts[last_frame_type];
                }
            }
            jk_bms_data_t decoded_telemetry;
            jk_bms_settings_t decoded_settings;
            jk_bms_device_info_t decoded_device_info;
            const uint8_t decoded_type = jk_bms_parser_push(&parser, payload, length,
                                                            &decoded_telemetry, &decoded_settings,
                                                            &decoded_device_info);
            if (decoded_type == JK_FRAME_TYPE_CELL_INFO) {
                portENTER_CRITICAL(&data_lock);
                latest_data = decoded_telemetry;
                last_data_us = esp_timer_get_time();
                recovery_deadline_seconds = (uint32_t) (last_data_us / 1000000) + 30;
                status_notification_received = true;
                phase = "data";
                if (selection_active && !selection_validated) {
                    selection_validated = true;
                    bms_operation_phase = JK_BMS_BLE_PHASE_SAVING;
                }
                if (reconnect_active) {
                    reconnect_active = false;
                    reconnect_deadline_seconds = 0;
                    finish_bms_operation_locked(
                        JK_BMS_BLE_OPERATION_SUCCESS,
                        JK_BMS_BLE_ERROR_NONE);
                }
                portEXIT_CRITICAL(&data_lock);

                ESP_LOGI(TAG, "BMS: %.2f V, %.2f A, %uS, SOH raw: %u%%, Battery type raw: 0x%02X (%s)",
                         decoded_telemetry.pack_voltage_v, decoded_telemetry.current_a,
                         decoded_telemetry.cell_count, decoded_telemetry.state_of_health,
                         decoded_telemetry.battery_type_id,
                         jk_bms_battery_chemistry_str(decoded_telemetry.battery_type_id));



            } else if (decoded_type == JK_FRAME_TYPE_SETTINGS) {
                uint32_t received_count;
                portENTER_CRITICAL(&data_lock);
                const uint32_t prev_count = latest_settings.received_count;
                latest_settings = decoded_settings;
                latest_settings.valid = true;
                latest_settings.received_count = prev_count + 1;
                received_count = latest_settings.received_count;
                portEXIT_CRITICAL(&data_lock);
                ESP_LOGI(TAG, "BMS Налаштування #%lu: UVP=%.3fV UVPR=%.3fV OVP=%.3fV OVPR=%.3fV Bal=%.3fV/%.3fV Cells=%u Cap=%.1fAh",
                         (unsigned long) received_count,
                         decoded_settings.cell_uvp_v, decoded_settings.cell_uvpr_v,
                         decoded_settings.cell_ovp_v, decoded_settings.cell_ovpr_v,
                         decoded_settings.balance_trigger_voltage_v, decoded_settings.start_balance_voltage_v,
                         decoded_settings.cell_count, decoded_settings.nominal_capacity_ah);
            } else if (decoded_type == JK_FRAME_TYPE_DEVICE_INFO) {
                uint32_t received_count;
                bool start_stream = false;
                uint16_t command_conn_handle = 0;
                uint16_t command_attr_handle = 0;
                portENTER_CRITICAL(&data_lock);
                const uint32_t prev_count = latest_device_info.received_count;
                latest_device_info = decoded_device_info;
                latest_device_info.valid = true;
                latest_device_info.received_count = prev_count + 1;
                received_count = latest_device_info.received_count;
                if (!cmd_0x96_sent && write_handle != 0) {
                    cmd_0x96_sent = true;
                    last_cmd_0x96_us = esp_timer_get_time();
                    command_conn_handle = connection_handle;
                    command_attr_handle = write_handle;
                    start_stream = true;
                }
                portEXIT_CRITICAL(&data_lock);
                ESP_LOGI(TAG, "BMS Інфо #%lu: Model=%s HW=%s SW=%s Name=%s",
                         (unsigned long) received_count,
                         decoded_device_info.model, decoded_device_info.hardware_version,
                         decoded_device_info.software_version, decoded_device_info.device_name);

                if (start_stream) {
                    ESP_LOGI(TAG, "Початок потоку: відправка 0x96 після отримання Device Info (0x03)");
                    send_command(command_conn_handle, command_attr_handle, 0x96);
                }
            }
            return 0;

        }
        default:
            return 0;
    }
}

static void on_reset(int reason) {
    portENTER_CRITICAL(&data_lock);
    nimble_synced = false;
    if (scan_owner == BLE_SCAN_OWNER_USER) {
        user_scan_state = JK_BMS_BLE_SCAN_ERROR;
        user_scan_error_status = reason;
    }
    if (selection_active && !selection_validated) {
        fail_selection_locked(JK_BMS_BLE_ERROR_SUBSYSTEM_UNAVAILABLE);
    }
    if (reconnect_active) {
        reconnect_active = false;
        reconnect_deadline_seconds = 0;
        finish_bms_operation_locked(
            JK_BMS_BLE_OPERATION_ERROR,
            JK_BMS_BLE_ERROR_SUBSYSTEM_UNAVAILABLE);
    }
    connected = false;
    connecting = false;
    if (forget_active && forget_persisted) {
        forget_active = false;
        forget_persisted = false;
        forget_operation_generation = 0u;
        forget_deadline_seconds = 0u;
        finish_bms_operation_locked(
            JK_BMS_BLE_OPERATION_SUCCESS,
            JK_BMS_BLE_ERROR_NONE);
    }
    scan_owner = BLE_SCAN_OWNER_NONE;
    portEXIT_CRITICAL(&data_lock);
    ESP_LOGW(TAG, "BLE перезапущено: %d", reason);
}

static void on_sync(void) {
    const int rc = ble_hs_util_ensure_addr(0);
    if (rc != 0) {
        ESP_LOGE(TAG, "BLE-адресу ESP32 не підготовлено: %d", rc);
        return;
    }
    portENTER_CRITICAL(&data_lock);
    nimble_synced = true;
    portEXIT_CRITICAL(&data_lock);
    scan();
}

static void host_task(void *parameter) {
    nimble_port_run();
    nimble_port_freertos_deinit();
}

static void poll_task(void *parameter) {
    typedef enum {
        POLL_NONE,
        POLL_RECOVER,
        POLL_SEND_FALLBACK,
        POLL_SEND_SETTINGS_RETRY,
    } poll_action_t;

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        const int64_t now_us = esp_timer_get_time();
        const uint32_t now_seconds = (uint32_t) (now_us / 1000000);
        const bool gap_discovery_active = ble_gap_disc_active();
        const bool gap_connection_active = ble_gap_conn_active();
        poll_action_t action = POLL_NONE;
        uint16_t action_conn_handle = 0;
        uint16_t action_attr_handle = 0;

        portENTER_CRITICAL(&data_lock);
        if (forget_active && forget_persisted) {
            if (!gap_discovery_active &&
                !gap_connection_active &&
                !connected &&
                !connecting) {
                forget_active = false;
                forget_persisted = false;
                forget_operation_generation = 0u;
                forget_deadline_seconds = 0u;
                finish_bms_operation_locked(
                    JK_BMS_BLE_OPERATION_SUCCESS,
                    JK_BMS_BLE_ERROR_NONE);
            } else if (forget_deadline_seconds != 0u &&
                       now_seconds >= forget_deadline_seconds) {
                forget_active = false;
                forget_persisted = false;
                forget_operation_generation = 0u;
                forget_deadline_seconds = 0u;
                finish_bms_operation_locked(
                    JK_BMS_BLE_OPERATION_ERROR,
                    JK_BMS_BLE_ERROR_SUBSYSTEM_UNAVAILABLE);
            }
        }

        if (reconnect_active &&
            reconnect_deadline_seconds != 0 &&
            now_seconds >= reconnect_deadline_seconds) {
            reconnect_active = false;
            reconnect_deadline_seconds = 0;
            finish_bms_operation_locked(
                JK_BMS_BLE_OPERATION_ERROR,
                JK_BMS_BLE_ERROR_CONNECT_FAILED);
        }

        if (!selection_active && !reconnect_active && !forget_active &&
            connected && recovery_deadline_seconds != 0 &&
            now_seconds >= recovery_deadline_seconds) {
            ++recovery_count;
            recovery_deadline_seconds = 0;
            phase = "recovering";
            action = POLL_RECOVER;
            action_conn_handle = connection_handle;
        } else if (!forget_active &&
                   connected && write_handle != 0 && notify_handle != 0 && !cmd_0x96_sent &&
                   connected_since_seconds != 0 &&
                   now_seconds - connected_since_seconds >= 3) {
            cmd_0x96_sent = true;
            last_cmd_0x96_us = now_us;
            action = POLL_SEND_FALLBACK;
            action_conn_handle = connection_handle;
            action_attr_handle = write_handle;
        } else if (!forget_active &&
                   connected && write_handle != 0 && notify_handle != 0 && cmd_0x96_sent &&
                   !latest_settings.valid && !settings_retry_done && last_cmd_0x96_us != 0 &&
                   now_us - last_cmd_0x96_us >= 8000000) {
            settings_retry_done = true;
            last_cmd_0x96_us = now_us;
            action = POLL_SEND_SETTINGS_RETRY;
            action_conn_handle = connection_handle;
            action_attr_handle = write_handle;
        }
        portEXIT_CRITICAL(&data_lock);

        if (action == POLL_RECOVER) {
            ESP_LOGW(TAG, "Потік BMS завис, перепідключення");
            const int rc = ble_gap_terminate(action_conn_handle, BLE_ERR_REM_USER_CONN_TERM);
            if (rc != 0) {
                portENTER_CRITICAL(&data_lock);
                if (connected && connection_handle == action_conn_handle) {
                    recovery_deadline_seconds = now_seconds + 5;
                }
                portEXIT_CRITICAL(&data_lock);
                ESP_LOGW(TAG, "Не вдалося почати BLE recovery: %d", rc);
            }
            continue;
        }

        if (action == POLL_SEND_FALLBACK) {
            ESP_LOGI(TAG, "Таймаут 0x03: відправка 0x96 за розкладом");
            send_command(action_conn_handle, action_attr_handle, 0x96);
        } else if (action == POLL_SEND_SETTINGS_RETRY) {
            ESP_LOGI(TAG, "Одноразовий повтор 0x96 для отримання налаштувань BMS");
            send_command(action_conn_handle, action_attr_handle, 0x96);
        }
    }
}


bool jk_bms_ble_start(const jk_bms_ble_target_t *target) {
    portENTER_CRITICAL(&data_lock);
    nimble_synced = false;
    scan_owner = BLE_SCAN_OWNER_NONE;
    user_scan_generation = 0;
    user_scan_state = JK_BMS_BLE_SCAN_IDLE;
    user_scan_error_status = 0;
    user_scan_candidate_count = 0;
    memset(user_scan_candidates, 0, sizeof(user_scan_candidates));
    bms_operation_generation = 0;
    bms_operation_state = JK_BMS_BLE_OPERATION_IDLE;
    bms_operation_phase = JK_BMS_BLE_PHASE_NONE;
    bms_operation_error = JK_BMS_BLE_ERROR_NONE;
    selection_active = false;
    selection_validated = false;
    selection_save_claimed = false;
    selection_operation_generation = 0;
    memset(&selection_address, 0, sizeof(selection_address));
    reconnect_active = false;
    reconnect_deadline_seconds = 0;
    forget_active = false;
    forget_persisted = false;
    forget_operation_generation = 0;
    forget_deadline_seconds = 0;
    portEXIT_CRITICAL(&data_lock);

    if (!configure_target(target)) {
        ESP_LOGE(TAG, "Некоректна адреса вибраної BMS");
        return false;
    }
    if (!configured) {
        ESP_LOGW(TAG, "BMS не вибрана; NimBLE запускається без auto-connect target");
    }

    ble_started_us = configured ? esp_timer_get_time() : 0;
    jk_bms_parser_reset(&parser);
    const esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Не вдалося запустити NimBLE: %s", esp_err_to_name(err));
        return false;
    }
    if (ble_npl_callout_init(&scan_retry_callout, nimble_port_get_dflt_eventq(),
                             retry_scan, NULL) != 0) {
        ESP_LOGE(TAG, "Не вдалося підготувати повтор BLE-пошуку");
        return false;
    }
    ble_hs_cfg.reset_cb = on_reset;
    ble_hs_cfg.sync_cb = on_sync;
    nimble_port_freertos_init(host_task);
    poll_task_handle = NULL;
    xTaskCreate(
        poll_task,
        "jk_bms_poll",
        JK_BMS_POLL_TASK_STACK_SIZE,
        NULL,
        5,
        &poll_task_handle);
    return true;
}


jk_bms_ble_scan_start_result_t jk_bms_ble_scan_start(
    uint32_t *operation_generation) {
    portENTER_CRITICAL(&data_lock);
    const bool ready = nimble_synced;
    const bool preempt_auto = scan_owner == BLE_SCAN_OWNER_AUTO;
    const bool busy =
        connected || connecting || selection_active || reconnect_active ||
        forget_active || scan_owner == BLE_SCAN_OWNER_USER ||
        user_scan_state == JK_BMS_BLE_SCAN_RUNNING;
    if (!ready || busy) {
        portEXIT_CRITICAL(&data_lock);
        return !ready
            ? JK_BMS_BLE_SCAN_START_UNAVAILABLE
            : JK_BMS_BLE_SCAN_START_BUSY;
    }

    // The old saved target can be absent while its perpetual background scan
    // holds BLE discovery. A user-requested scan must take precedence without
    // dropping the saved target or terminating a real BLE connection.
    scan_owner = BLE_SCAN_OWNER_USER;
    ++user_scan_generation;
    if (user_scan_generation == 0u) {
        user_scan_generation = 1u;
    }
    user_scan_state = JK_BMS_BLE_SCAN_RUNNING;
    user_scan_error_status = 0;
    user_scan_candidate_count = 0;
    memset(user_scan_candidates, 0, sizeof(user_scan_candidates));
    const uint32_t current_operation_generation =
        begin_bms_operation_locked(JK_BMS_BLE_PHASE_SCANNING);
    portEXIT_CRITICAL(&data_lock);

    if (preempt_auto) {
        // NimBLE guarantees that a successful cancel fully stops discovery;
        // there is no DISC_COMPLETE callback for ble_gap_disc_cancel().
        const int cancel_rc = ble_gap_disc_cancel();
        if (cancel_rc != 0 && cancel_rc != BLE_HS_EALREADY) {
            // If cancellation failed while the original discovery is still
            // active, preserve its auto owner instead of orphaning it.
            const bool auto_still_scanning = ble_gap_disc_active();
            portENTER_CRITICAL(&data_lock);
            if (scan_owner == BLE_SCAN_OWNER_USER) {
                scan_owner = auto_still_scanning
                    ? BLE_SCAN_OWNER_AUTO : BLE_SCAN_OWNER_NONE;
                user_scan_state = JK_BMS_BLE_SCAN_ERROR;
                user_scan_error_status = cancel_rc;
                finish_bms_operation_locked(
                    JK_BMS_BLE_OPERATION_ERROR,
                    JK_BMS_BLE_ERROR_SUBSYSTEM_UNAVAILABLE);
            }
            portEXIT_CRITICAL(&data_lock);
            scan();
            return JK_BMS_BLE_SCAN_START_UNAVAILABLE;
        }
    }

    if (ble_gap_disc_active() || ble_gap_conn_active()) {
        portENTER_CRITICAL(&data_lock);
        if (scan_owner == BLE_SCAN_OWNER_USER) {
            scan_owner = BLE_SCAN_OWNER_NONE;
            user_scan_state = JK_BMS_BLE_SCAN_ERROR;
            user_scan_error_status = BLE_HS_EBUSY;
            finish_bms_operation_locked(
                JK_BMS_BLE_OPERATION_ERROR,
                JK_BMS_BLE_ERROR_BUSY);
        }
        portEXIT_CRITICAL(&data_lock);
        scan();
        return JK_BMS_BLE_SCAN_START_BUSY;
    }

    uint8_t own_address_type;
    const int address_rc = ble_hs_id_infer_auto(0, &own_address_type);
    if (address_rc != 0) {
        portENTER_CRITICAL(&data_lock);
        if (scan_owner == BLE_SCAN_OWNER_USER) {
            scan_owner = BLE_SCAN_OWNER_NONE;
            user_scan_state = JK_BMS_BLE_SCAN_ERROR;
            user_scan_error_status = address_rc;
            finish_bms_operation_locked(
                JK_BMS_BLE_OPERATION_ERROR,
                JK_BMS_BLE_ERROR_SUBSYSTEM_UNAVAILABLE);
        }
        portEXIT_CRITICAL(&data_lock);
        scan();
        return JK_BMS_BLE_SCAN_START_UNAVAILABLE;
    }

    struct ble_gap_disc_params params = {0};
    params.filter_duplicates = 0;
    params.passive = 0;

    const int rc = ble_gap_disc(
        own_address_type,
        JK_BMS_USER_SCAN_DURATION_MS,
        &params,
        gap_event,
        NULL);
    if (rc != 0) {
        portENTER_CRITICAL(&data_lock);
        if (scan_owner == BLE_SCAN_OWNER_USER) {
            scan_owner = BLE_SCAN_OWNER_NONE;
            user_scan_state = JK_BMS_BLE_SCAN_ERROR;
            user_scan_error_status = rc;
            finish_bms_operation_locked(
                JK_BMS_BLE_OPERATION_ERROR,
                rc == BLE_HS_EALREADY || rc == BLE_HS_EBUSY
                    ? JK_BMS_BLE_ERROR_BUSY
                    : JK_BMS_BLE_ERROR_SUBSYSTEM_UNAVAILABLE);
        }
        portEXIT_CRITICAL(&data_lock);
        scan();
        return rc == BLE_HS_EALREADY || rc == BLE_HS_EBUSY
            ? JK_BMS_BLE_SCAN_START_BUSY
            : JK_BMS_BLE_SCAN_START_UNAVAILABLE;
    }

    if (operation_generation) {
        *operation_generation = current_operation_generation;
    }
    return JK_BMS_BLE_SCAN_START_OK;
}


jk_bms_ble_select_start_result_t jk_bms_ble_select_start(
    uint32_t scan_generation,
    uint16_t candidate_id,
    uint32_t *operation_generation) {
    ble_addr_t selected_address;
    memset(&selected_address, 0, sizeof(selected_address));

    portENTER_CRITICAL(&data_lock);
    if (!nimble_synced) {
        portEXIT_CRITICAL(&data_lock);
        return JK_BMS_BLE_SELECT_START_UNAVAILABLE;
    }
    if (connected || connecting || selection_active ||
        reconnect_active || forget_active ||
        scan_owner == BLE_SCAN_OWNER_USER ||
        user_scan_state == JK_BMS_BLE_SCAN_RUNNING) {
        portEXIT_CRITICAL(&data_lock);
        return JK_BMS_BLE_SELECT_START_BUSY;
    }
    if (user_scan_state != JK_BMS_BLE_SCAN_SUCCESS ||
        scan_generation != user_scan_generation) {
        portEXIT_CRITICAL(&data_lock);
        return JK_BMS_BLE_SELECT_START_STALE_SCAN;
    }
    if (candidate_id == 0u ||
        candidate_id > user_scan_candidate_count) {
        portEXIT_CRITICAL(&data_lock);
        return JK_BMS_BLE_SELECT_START_NOT_FOUND;
    }

    const bool preempt_auto = scan_owner == BLE_SCAN_OWNER_AUTO;
    selected_address =
        user_scan_candidates[(size_t) candidate_id - 1u].address;
    selection_active = true;
    selection_validated = false;
    selection_save_claimed = false;
    selection_address = selected_address;
    selection_disconnect_error = JK_BMS_BLE_ERROR_CONNECT_FAILED;
    selection_operation_generation =
        begin_bms_operation_locked(JK_BMS_BLE_PHASE_CONNECTING);
    const uint32_t current_generation =
        selection_operation_generation;
    portEXIT_CRITICAL(&data_lock);

    if (preempt_auto) {
        const int cancel_rc = ble_gap_disc_cancel();
        if (cancel_rc != 0 && cancel_rc != BLE_HS_EALREADY) {
            portENTER_CRITICAL(&data_lock);
            if (selection_active &&
                selection_operation_generation == current_generation) {
                fail_selection_locked(JK_BMS_BLE_ERROR_SUBSYSTEM_UNAVAILABLE);
            }
            portEXIT_CRITICAL(&data_lock);
            scan();
            return JK_BMS_BLE_SELECT_START_UNAVAILABLE;
        }
        portENTER_CRITICAL(&data_lock);
        if (scan_owner == BLE_SCAN_OWNER_AUTO) {
            scan_owner = BLE_SCAN_OWNER_NONE;
        }
        portEXIT_CRITICAL(&data_lock);
    }

    if (ble_gap_disc_active() || ble_gap_conn_active()) {
        portENTER_CRITICAL(&data_lock);
        if (selection_active &&
            selection_operation_generation == current_generation) {
            fail_selection_locked(JK_BMS_BLE_ERROR_BUSY);
        }
        portEXIT_CRITICAL(&data_lock);
        scan();
        return JK_BMS_BLE_SELECT_START_BUSY;
    }

    const int rc = start_connection_to_address(&selected_address);
    if (rc != 0) {
        portENTER_CRITICAL(&data_lock);
        if (selection_active &&
            selection_operation_generation == current_generation) {
            fail_selection_locked(JK_BMS_BLE_ERROR_CONNECT_FAILED);
        }
        portEXIT_CRITICAL(&data_lock);
        scan();
        return rc == BLE_HS_EALREADY || rc == BLE_HS_EBUSY
            ? JK_BMS_BLE_SELECT_START_BUSY
            : JK_BMS_BLE_SELECT_START_UNAVAILABLE;
    }

    if (operation_generation) {
        *operation_generation = current_generation;
    }
    return JK_BMS_BLE_SELECT_START_OK;
}

bool jk_bms_ble_select_take_validated_target(
    jk_bms_ble_target_t *target,
    uint32_t *operation_generation) {
    if (!target || !operation_generation) {
        return false;
    }

    portENTER_CRITICAL(&data_lock);
    if (!selection_active ||
        !selection_validated ||
        selection_save_claimed ||
        bms_operation_state != JK_BMS_BLE_OPERATION_RUNNING ||
        bms_operation_phase != JK_BMS_BLE_PHASE_SAVING) {
        portEXIT_CRITICAL(&data_lock);
        return false;
    }

    memset(target, 0, sizeof(*target));
    target->address_type = selection_address.type;
    for (size_t index = 0; index < JK_BMS_BLE_ADDRESS_LEN; ++index) {
        target->address[index] =
            selection_address.val[JK_BMS_BLE_ADDRESS_LEN - 1u - index];
    }
    *operation_generation = selection_operation_generation;
    selection_save_claimed = true;
    portEXIT_CRITICAL(&data_lock);
    return true;
}

bool jk_bms_ble_select_commit(
    uint32_t operation_generation,
    bool persisted) {
    bool reconnect_selected = false;
    bool terminate_temporary = false;
    uint16_t temporary_conn_handle = 0;

    portENTER_CRITICAL(&data_lock);
    if (!selection_active ||
        !selection_validated ||
        !selection_save_claimed ||
        operation_generation == 0u ||
        operation_generation != selection_operation_generation) {
        portEXIT_CRITICAL(&data_lock);
        return false;
    }

    if (persisted) {
        target_address = selection_address;
        configured = true;
        selection_active = false;
        selection_validated = false;
        selection_save_claimed = false;
        memset(&selection_address, 0, sizeof(selection_address));
        selection_operation_generation = 0u;
        selection_disconnect_error = JK_BMS_BLE_ERROR_CONNECT_FAILED;
        finish_bms_operation_locked(
            JK_BMS_BLE_OPERATION_SUCCESS,
            JK_BMS_BLE_ERROR_NONE);
        reconnect_selected = !connected && !connecting;
    } else {
        terminate_temporary = connected;
        temporary_conn_handle = connection_handle;
        fail_selection_locked(JK_BMS_BLE_ERROR_STORAGE);
    }
    portEXIT_CRITICAL(&data_lock);

    if (terminate_temporary) {
        const int rc = ble_gap_terminate(
            temporary_conn_handle,
            BLE_ERR_REM_USER_CONN_TERM);
        if (rc != 0) {
            ESP_LOGW(
                TAG,
                "Не вдалося від'єднати temporary BMS після storage error: %d",
                rc);
        }
    } else if (reconnect_selected) {
        scan();
    }
    return true;
}


jk_bms_ble_reconnect_start_result_t jk_bms_ble_reconnect_start(
    uint32_t *operation_generation) {
    bool terminate_connected = false;
    uint16_t conn_handle = 0;
    bool start_scan = false;
    const uint32_t now_seconds =
        (uint32_t) (esp_timer_get_time() / 1000000);

    portENTER_CRITICAL(&data_lock);
    if (!nimble_synced) {
        portEXIT_CRITICAL(&data_lock);
        return JK_BMS_BLE_RECONNECT_START_UNAVAILABLE;
    }
    if (!configured) {
        portEXIT_CRITICAL(&data_lock);
        return JK_BMS_BLE_RECONNECT_START_NOT_CONFIGURED;
    }
    if (selection_active || reconnect_active || forget_active ||
        scan_owner == BLE_SCAN_OWNER_USER ||
        user_scan_state == JK_BMS_BLE_SCAN_RUNNING ||
        connecting) {
        portEXIT_CRITICAL(&data_lock);
        return JK_BMS_BLE_RECONNECT_START_BUSY;
    }

    const uint32_t current_generation =
        begin_bms_operation_locked(JK_BMS_BLE_PHASE_RECONNECTING);
    reconnect_active = true;
    reconnect_deadline_seconds = now_seconds + 30u;

    if (connected) {
        terminate_connected = true;
        conn_handle = connection_handle;
    } else if (scan_owner == BLE_SCAN_OWNER_NONE) {
        start_scan = true;
    }
    portEXIT_CRITICAL(&data_lock);

    if (terminate_connected) {
        const int rc = ble_gap_terminate(
            conn_handle,
            BLE_ERR_REM_USER_CONN_TERM);
        if (rc != 0) {
            portENTER_CRITICAL(&data_lock);
            if (reconnect_active &&
                bms_operation_generation == current_generation) {
                reconnect_active = false;
                reconnect_deadline_seconds = 0;
                finish_bms_operation_locked(
                    JK_BMS_BLE_OPERATION_ERROR,
                    JK_BMS_BLE_ERROR_SUBSYSTEM_UNAVAILABLE);
            }
            portEXIT_CRITICAL(&data_lock);
            return JK_BMS_BLE_RECONNECT_START_UNAVAILABLE;
        }
    } else if (start_scan) {
        scan();
    }

    if (operation_generation) {
        *operation_generation = current_generation;
    }
    return JK_BMS_BLE_RECONNECT_START_OK;
}


jk_bms_ble_forget_start_result_t jk_bms_ble_forget_start(
    uint32_t *operation_generation) {
    portENTER_CRITICAL(&data_lock);
    if (!configured) {
        portEXIT_CRITICAL(&data_lock);
        return JK_BMS_BLE_FORGET_START_NOT_CONFIGURED;
    }
    if (selection_active || reconnect_active || forget_active ||
        bms_operation_state == JK_BMS_BLE_OPERATION_RUNNING) {
        portEXIT_CRITICAL(&data_lock);
        return JK_BMS_BLE_FORGET_START_BUSY;
    }

    forget_operation_generation =
        begin_bms_operation_locked(JK_BMS_BLE_PHASE_RESETTING);
    forget_active = true;
    forget_persisted = false;
    forget_deadline_seconds = 0;
    const uint32_t generation = forget_operation_generation;
    portEXIT_CRITICAL(&data_lock);

    if (operation_generation) {
        *operation_generation = generation;
    }
    return JK_BMS_BLE_FORGET_START_OK;
}

bool jk_bms_ble_forget_commit(
    uint32_t operation_generation,
    bool persisted) {
    bool cancel_scan = false;
    bool cancel_connect = false;
    bool terminate_connected = false;
    uint16_t conn_handle = 0;
    const uint32_t now_seconds =
        (uint32_t) (esp_timer_get_time() / 1000000);

    portENTER_CRITICAL(&data_lock);
    if (!forget_active ||
        operation_generation == 0u ||
        operation_generation != forget_operation_generation) {
        portEXIT_CRITICAL(&data_lock);
        return false;
    }

    if (!persisted) {
        forget_active = false;
        forget_persisted = false;
        forget_operation_generation = 0u;
        forget_deadline_seconds = 0u;
        finish_bms_operation_locked(
            JK_BMS_BLE_OPERATION_ERROR,
            JK_BMS_BLE_ERROR_STORAGE);
        portEXIT_CRITICAL(&data_lock);
        return true;
    }

    forget_persisted = true;
    cancel_scan = scan_owner != BLE_SCAN_OWNER_NONE;
    cancel_connect = connecting;
    terminate_connected = connected;
    conn_handle = connection_handle;

    configured = false;
    memset(&target_address, 0, sizeof(target_address));
    target_seen = false;

    scan_owner = BLE_SCAN_OWNER_NONE;
    user_scan_state = JK_BMS_BLE_SCAN_IDLE;
    user_scan_error_status = 0;
    user_scan_candidate_count = 0;
    memset(user_scan_candidates, 0, sizeof(user_scan_candidates));

    selection_active = false;
    selection_validated = false;
    selection_save_claimed = false;
    selection_operation_generation = 0u;
    memset(&selection_address, 0, sizeof(selection_address));

    reconnect_active = false;
    reconnect_deadline_seconds = 0;

    latest_data.valid = false;
    latest_settings.valid = false;
    latest_device_info.valid = false;
    status_notification_received = false;
    recovery_deadline_seconds = 0;
    phase = "not_configured";

    const bool cleanup_required =
        cancel_scan || cancel_connect || terminate_connected;
    if (cleanup_required) {
        forget_deadline_seconds = now_seconds + 5u;
    } else {
        forget_active = false;
        forget_persisted = false;
        forget_operation_generation = 0u;
        forget_deadline_seconds = 0u;
        finish_bms_operation_locked(
            JK_BMS_BLE_OPERATION_SUCCESS,
            JK_BMS_BLE_ERROR_NONE);
    }
    portEXIT_CRITICAL(&data_lock);

    bool cleanup_started = true;
    if (cancel_scan) {
        const int rc = ble_gap_disc_cancel();
        if (rc != 0 && rc != BLE_HS_EALREADY) {
            cleanup_started = false;
            ESP_LOGW(TAG, "Не вдалося зупинити BLE scan після forget: %d", rc);
        }
    }
    if (cancel_connect) {
        const int rc = ble_gap_conn_cancel();
        if (rc != 0 && rc != BLE_HS_EALREADY) {
            cleanup_started = false;
            ESP_LOGW(TAG, "Не вдалося скасувати BLE connect після forget: %d", rc);
        }
    }
    if (terminate_connected) {
        const int rc = ble_gap_terminate(
            conn_handle,
            BLE_ERR_REM_USER_CONN_TERM);
        if (rc != 0 && rc != BLE_HS_EALREADY) {
            cleanup_started = false;
            ESP_LOGW(TAG, "Не вдалося від'єднати BMS після forget: %d", rc);
        }
    }

    if (!cleanup_started) {
        portENTER_CRITICAL(&data_lock);
        if (forget_active &&
            forget_operation_generation == operation_generation) {
            forget_active = false;
            forget_persisted = false;
            forget_operation_generation = 0u;
            forget_deadline_seconds = 0u;
            finish_bms_operation_locked(
                JK_BMS_BLE_OPERATION_ERROR,
                JK_BMS_BLE_ERROR_SUBSYSTEM_UNAVAILABLE);
        }
        portEXIT_CRITICAL(&data_lock);
    }

    return true;
}

bool jk_bms_ble_scan_snapshot(jk_bms_ble_scan_snapshot_t *snapshot) {
    if (!snapshot) {
        return false;
    }

    memset(snapshot, 0, sizeof(*snapshot));

    portENTER_CRITICAL(&data_lock);
    snapshot->generation = user_scan_generation;
    snapshot->state = user_scan_state;
    snapshot->error_status = user_scan_error_status;
    snapshot->operation.generation = bms_operation_generation;
    snapshot->operation.state = bms_operation_state;
    snapshot->operation.phase = bms_operation_phase;
    snapshot->operation.error = bms_operation_error;

    if (user_scan_state == JK_BMS_BLE_SCAN_SUCCESS) {
        snapshot->candidate_count = user_scan_candidate_count;
        for (size_t i = 0; i < user_scan_candidate_count; ++i) {
            const jk_bms_scan_candidate_internal_t *source =
                &user_scan_candidates[i];
            jk_bms_ble_scan_candidate_t *candidate =
                &snapshot->candidates[i];

            candidate->candidate_id = (uint16_t) (i + 1u);
            strlcpy(
                candidate->name,
                source->name,
                sizeof(candidate->name));
            candidate->rssi_dbm = source->rssi_dbm;
            snprintf(
                candidate->address_hint,
                sizeof(candidate->address_hint),
                "...%02X:%02X",
                source->address.val[1],
                source->address.val[0]);
        }
    }
    portEXIT_CRITICAL(&data_lock);

    return true;
}


bool jk_bms_ble_operation_snapshot(
    jk_bms_ble_operation_snapshot_t *snapshot) {
    if (!snapshot) {
        return false;
    }

    portENTER_CRITICAL(&data_lock);
    snapshot->generation = bms_operation_generation;
    snapshot->state = bms_operation_state;
    snapshot->phase = bms_operation_phase;
    snapshot->error = bms_operation_error;
    portEXIT_CRITICAL(&data_lock);
    return true;
}

bool jk_bms_ble_has_target(void) {
    return configured;
}

bool jk_bms_ble_is_connected(void) {
    return connected;
}

const char *jk_bms_ble_state(void) {
    if (!configured) {
        return "not_configured";
    }
    if (connected) {
        return "connected";
    }
    if (connecting) {
        return "connecting";
    }
    return target_seen ? "target_seen" : "scanning";
}

const char *jk_bms_ble_phase(void) {
    return phase;
}

uint32_t jk_bms_ble_connection_attempts(void) {
    return connection_attempts;
}

uint32_t jk_bms_ble_connection_successes(void) {
    return connection_successes;
}

uint32_t jk_bms_ble_disconnect_count(void) {
    return disconnect_count;
}

int jk_bms_ble_last_disconnect_reason(void) {
    return last_disconnect_reason;
}

uint32_t jk_bms_ble_connection_uptime(void) {
    return connected_since_seconds == 0 ? 0 :
           (uint32_t) (esp_timer_get_time() / 1000000) - connected_since_seconds;
}

uint32_t jk_bms_ble_recovery_count(void) {
    return recovery_count;
}

uint32_t jk_bms_ble_poll_stack_free_min_bytes(void) {
    TaskHandle_t task = poll_task_handle;
    return task == NULL ? 0u : (uint32_t) uxTaskGetStackHighWaterMark(task);
}

uint32_t jk_bms_ble_last_valid_frame_age(void) {
    int64_t reference;
    bool recovery_suppressed;
    portENTER_CRITICAL(&data_lock);
    recovery_suppressed =
        !configured || selection_active || reconnect_active || forget_active;
    reference = last_data_us != 0 ? last_data_us : ble_started_us;
    portEXIT_CRITICAL(&data_lock);

    if (recovery_suppressed) {
        return 0;
    }
    return reference == 0 ? 0 :
           (uint32_t) ((esp_timer_get_time() - reference) / 1000000);
}

uint32_t jk_bms_ble_down_time(void) {
    const uint32_t age = jk_bms_ble_last_valid_frame_age();
    return age > 30 ? age - 30 : 0;
}

uint32_t jk_bms_ble_notifications(void) {
    return notifications;
}

uint32_t jk_bms_ble_notification_bytes(void) {
    return notification_bytes;
}

uint16_t jk_bms_ble_last_notification_length(void) {
    return last_notification_length;
}

uint8_t jk_bms_ble_last_frame_type(void) {
    return last_frame_type;
}

uint32_t jk_bms_ble_frame_count(uint8_t type) {
    return type < sizeof(frame_counts) / sizeof(frame_counts[0]) ? frame_counts[type] : 0;
}

int jk_bms_ble_last_status(void) {
    return last_status;
}

bool jk_bms_ble_get_data(jk_bms_data_t *data) {
    bool fresh;
    portENTER_CRITICAL(&data_lock);
    *data = latest_data;
    fresh = data->valid && esp_timer_get_time() - last_data_us < 15000000;
    portEXIT_CRITICAL(&data_lock);
    data->valid = fresh;
    return fresh;
}

bool jk_bms_ble_get_settings(jk_bms_settings_t *settings) {
    if (settings == NULL) {
        return false;
    }
    portENTER_CRITICAL(&data_lock);
    *settings = latest_settings;
    portEXIT_CRITICAL(&data_lock);
    return settings->valid;
}

bool jk_bms_ble_get_device_info(jk_bms_device_info_t *device_info) {
    if (device_info == NULL) {
        return false;
    }
    portENTER_CRITICAL(&data_lock);
    *device_info = latest_device_info;
    portEXIT_CRITICAL(&data_lock);
    return device_info->valid;
}
