#include <stdio.h>
#include <stdbool.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

#include "driver/gpio.h"
#include "esp_event.h"
#include "esp_core_dump.h"
#include "esp_heap_caps.h"
#include "esp_attr.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "cJSON.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_sntp.h"
#include "lwip/netdb.h"
#include "lwip/sockets.h"
#include "mdns.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "bms_runtime_policy.h"
#include "boot_button_policy.h"
#include "captive_dns.h"
#include "cloud_transport.h"
#include "device_config.h"
#include "device_identity.h"
#include "setup_access.h"
#include "history.h"
#include "internet_reachability_policy.h"
#include "json_writer.h"
#include "jk_bms_ble.h"
#include "local_api_security.h"
#include "mdns_policy.h"
#include "provisioning_policy.h"
#include "recovery_policy.h"
#include "remote_ota.h"
#include "settings_json.h"
#include "temperature_profiles.h"
#include "wifi_runtime_policy.h"
#include "wattpost_secrets.h"
#include "wattpost_build.h"


static const char *TAG = "wattpost-mini";
static httpd_handle_t server;
static esp_netif_t *wifi_netif;
static esp_netif_t *wifi_ap_netif;
static bool sntp_started;
static bool mdns_started;
static volatile bool mdns_recovery_pending;
static bool wifi_has_ip;
static bool wifi_ever_had_ip;
static bool wifi_sta_started;
static bool wifi_driver_started;
static bool wifi_connecting;
static bool wifi_runtime_error;
static bool device_wifi_configured;
static bool device_bms_configured;
static wattpost_config_load_result_t device_config_status = WATTPOST_CONFIG_LOAD_STORAGE_ERROR;
static wattpost_wifi_boot_action_t wifi_boot_action = WATTPOST_WIFI_BOOT_CONFIG_ERROR;
static wattpost_bms_boot_action_t bms_boot_action = WATTPOST_BMS_BOOT_CONFIG_ERROR;
static wattpost_provision_boot_action_t provision_boot_action = WATTPOST_PROVISION_BOOT_CONFIG_ERROR;
static bool first_setup_ap_active;
/* Explicitly finished setup with Wi-Fi only; not a persisted BMS selection. */
static bool first_setup_bms_deferred;
static int64_t first_setup_completed_us;
static bool recovery_ap_active;
static bool recovery_completion_pending;
static int64_t recovery_completed_us;
static char setup_ap_ssid[WATTPOST_SETUP_SSID_MAX_LEN + 1];
static char wifi_ssid_display[WATTPOST_WIFI_SSID_MAX_LEN + 1];
static char bms_address_hint[12];
static char local_request_token[WATTPOST_REQUEST_TOKEN_HEX_LEN + 1];
static char captive_portal_uri[32];
static bool restart_pending;
static volatile bool scheduled_restart_pending;
static TaskHandle_t recovery_task_handle;
static TaskHandle_t internet_reachability_task_handle;
static TaskHandle_t boot_button_task_handle;
static TaskHandle_t history_task_handle;

#define WATTPOST_BOOT_BUTTON_GPIO GPIO_NUM_0

static portMUX_TYPE physical_button_action_lock = portMUX_INITIALIZER_UNLOCKED;
static bool physical_recovery_requested;
static bool physical_factory_reset_requested;

#define WATTPOST_INTERNET_PROBE_HOST "connectivitycheck.gstatic.com"
#define WATTPOST_INTERNET_PROBE_PORT "80"
#define WATTPOST_INTERNET_PROBE_PATH "/generate_204"
#define WATTPOST_INTERNET_PROBE_TIMEOUT_MS 3000
#define WATTPOST_INTERNET_PROBE_INTERVAL_MS 60000

static portMUX_TYPE internet_reachability_lock = portMUX_INITIALIZER_UNLOCKED;
static wattpost_internet_state_t internet_reachability_state =
    WATTPOST_INTERNET_UNKNOWN;
static uint32_t internet_reachability_generation;

typedef enum {
    SYSTEM_ACTION_NONE = 0,
    SYSTEM_ACTION_REBOOT,
    SYSTEM_ACTION_FACTORY_RESET,
} system_action_t;

static portMUX_TYPE system_action_lock = portMUX_INITIALIZER_UNLOCKED;
static system_action_t system_action_pending = SYSTEM_ACTION_NONE;
static uint32_t system_action_generation;
static volatile bool ota_validation_pending;
static uint32_t wifi_disconnect_count;
static uint32_t wifi_reconnect_count;
static uint32_t mdns_recovery_count;
static uint32_t mdns_announce_count;
static int64_t wifi_down_since_us;
static int64_t mdns_last_start_us;
static int64_t mdns_last_announce_us;
static const char *last_restart_reason;
static const char *mdns_last_recovery_reason = "none";
static const char *mdns_pending_reason = "none";

#define WATTPOST_WIFI_SCAN_MAX_CANDIDATES 16u

typedef enum {
    WIFI_OPERATION_IDLE = 0,
    WIFI_OPERATION_RUNNING,
    WIFI_OPERATION_SUCCESS,
    WIFI_OPERATION_ERROR,
} wifi_operation_state_t;

typedef enum {
    WIFI_OPERATION_PHASE_NONE = 0,
    WIFI_OPERATION_PHASE_SCANNING,
    WIFI_OPERATION_PHASE_VALIDATING,
    WIFI_OPERATION_PHASE_CONNECTING,
    WIFI_OPERATION_PHASE_SAVING,
    WIFI_OPERATION_PHASE_RECONNECTING,
    WIFI_OPERATION_PHASE_RESETTING,
} wifi_operation_phase_t;

typedef struct {
    uint16_t candidate_id;
    char ssid[33];
    int8_t rssi_dbm;
    uint8_t channel;
    wifi_auth_mode_t authmode;
    uint8_t bssid[6];
} wifi_scan_candidate_t;

static portMUX_TYPE wifi_scan_lock = portMUX_INITIALIZER_UNLOCKED;
static bool wifi_scan_running;
static uint32_t wifi_scan_generation;
static uint32_t wifi_scan_completed_generation;
static uint32_t wifi_operation_generation;
static wifi_operation_state_t wifi_operation_state = WIFI_OPERATION_IDLE;
static wifi_operation_phase_t wifi_operation_phase = WIFI_OPERATION_PHASE_NONE;
static const char *wifi_operation_error_code;
static wifi_scan_candidate_t wifi_scan_candidates[WATTPOST_WIFI_SCAN_MAX_CANDIDATES];
/*
 * WIFI_EVENT_SCAN_DONE runs on ESP-IDF's sys_evt task, whose stack is much
 * smaller than our application tasks. Keep the bounded scan work buffers in
 * BSS rather than allocating ~kilobytes on the event-task stack.
 */
static wifi_ap_record_t wifi_scan_ap_records[WATTPOST_WIFI_SCAN_MAX_CANDIDATES];
static wifi_scan_candidate_t wifi_scan_candidates_scratch[WATTPOST_WIFI_SCAN_MAX_CANDIDATES];
static size_t wifi_scan_candidate_count;
/*
 * esp_http_server invokes URI handlers serially on its single server task.
 * These response buffers therefore never need to exist at the same time.
 * Keep them in BSS (not on the HTTP task stack) but overlap their storage so
 * normal runtime does not permanently reserve the sum of all response sizes.
 */
typedef union {
    char wifi_scan[6144];
    char bms_scan[4096];
    char live[5120];
    char diagnostics[3072];
    char device_status[3072];
} http_json_response_buffer_t;
static http_json_response_buffer_t http_json_response;

#define WATTPOST_WIFI_CONFIGURE_BODY_MAX 512u
#define WATTPOST_WIFI_VALIDATION_TIMEOUT_SECONDS 30u

typedef struct {
    bool active;
    bool installed_switch;
    bool recovery_flow;
    bool start_pending;
    bool expected_disconnect;
    bool start_armed;
    bool pending_applied;
    bool association_confirmed;
    bool candidate_bssid_set;
    uint8_t candidate_bssid[6];
    uint8_t candidate_channel;
    int64_t started_us;
    wattpost_device_config_t pending_config;
    wattpost_device_config_t rollback_config;
} wifi_validation_state_t;

typedef struct {
    bool pending;
    bool connecting;
    wattpost_device_config_t config;
} wifi_rollback_state_t;

typedef struct {
    bool active;
    bool recovery_flow;
    bool start_pending;
    int64_t started_us;
} wifi_reconnect_state_t;

static wifi_validation_state_t wifi_validation;
static wifi_rollback_state_t wifi_rollback;
static bool wifi_rollback_preempt_requested;
static bool wifi_scan_start_pending;
static bool first_setup_wifi_retry_required;
static wifi_reconnect_state_t wifi_reconnect_operation;

static bool load_device_config_for_mutation(
    wattpost_device_config_t *config);

typedef struct {
    uint32_t boot_count;
    uint32_t panic_count;
    bool coredump_present;
    bool coredump_valid;
    size_t coredump_size;
    char panic_reason[192];
    char panic_task[17];
    uint32_t panic_pc;
    uint32_t panic_backtrace[16];
    uint32_t panic_backtrace_depth;
    bool panic_backtrace_corrupted;
} diagnostic_state_t;

static diagnostic_state_t diagnostics;

static const char *const ALARM_NAMES[32] = {
    "low_capacity",                // bit 0
    "mosfet_overtemperature",      // bit 1
    "charging_overvoltage",        // bit 2
    "discharging_undervoltage",    // bit 3
    "battery_overtemperature",     // bit 4
    "charge_overcurrent",          // bit 5
    "discharge_overcurrent",       // bit 6
    "cell_pressure_difference",    // bit 7
    "battery_box_overtemperature", // bit 8
    "battery_undertemperature",    // bit 9
    "cell_overvoltage",            // bit 10
    "cell_undervoltage",           // bit 11
    "short_circuit",               // bit 12
    "ic_inspection_fault",         // bit 13
    "software_lock_mos",           // bit 14
    "discharge_undertemperature",  // bit 15
    "charge_undertemperature",     // bit 16
    "discharge_overtemperature",   // bit 17
    "charge_overtemperature",      // bit 18
    "precharge_failure",           // bit 19
    "parallel_protection",         // bit 20
    "equalization_line_drop",      // bit 21
    "internal_communication_fault",// bit 22
    "current_sensor_anomaly",      // bit 23
    "eeprom_fault",                // bit 24
    "rtc_fault",                   // bit 25
    "heating_fault",               // bit 26
    "gps_fault",                   // bit 27
    "discharge_mosfet_fault",      // bit 28
    "charge_mosfet_fault",         // bit 29
    NULL,                          // bit 30
    NULL,                          // bit 31
};





enum {
    RESTART_REASON_MAGIC = 0x57505253,
    RESTART_REASON_LEGACY_WIFI_TIMEOUT = 1,
    RESTART_REASON_BMS_TIMEOUT = 2,
};

RTC_NOINIT_ATTR static uint32_t saved_restart_magic;
RTC_NOINIT_ATTR static uint32_t saved_restart_reason;

#define WEB_ASSET(uri, symbol, content_type) \
    extern const unsigned char symbol##_start[] asm("_binary_" #symbol "_start"); \
    extern const unsigned char symbol##_end[] asm("_binary_" #symbol "_end");
#include "web_assets.inc"
#undef WEB_ASSET

typedef struct {
    const char *uri;
    const unsigned char *start;
    const unsigned char *end;
    const char *content_type;
} embedded_asset_t;

#define WEB_ASSET(uri, symbol, content_type) \
    {uri, symbol##_start, symbol##_end, content_type},
static const embedded_asset_t web_assets[] = {
#include "web_assets.inc"
};
#undef WEB_ASSET

static void maintain_first_setup_ap(void);
static void maintain_recovery_ap(void);
static bool start_recovery_ap(void);
static const char *internet_reachability_runtime_state(void);

static uint32_t monotonic_age_seconds(int64_t since_us) {
    if (since_us <= 0) {
        return 0;
    }
    return (uint32_t) ((esp_timer_get_time() - since_us) / 1000000);
}

static const char *ota_state_to_str(esp_ota_img_states_t state) {
    switch (state) {
        case ESP_OTA_IMG_NEW: return "new";
        case ESP_OTA_IMG_PENDING_VERIFY: return "pending_verify";
        case ESP_OTA_IMG_VALID: return "valid";
        case ESP_OTA_IMG_INVALID: return "invalid";
        case ESP_OTA_IMG_ABORTED: return "aborted";
        case ESP_OTA_IMG_UNDEFINED: return "undefined";
        default: return "unknown";
    }
}

static const char *current_ota_state(void) {
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
    if (running == NULL || esp_ota_get_state_partition(running, &state) != ESP_OK) {
        return "unknown";
    }
    return ota_state_to_str(state);
}

static const char *ota_rollback_configured_json(void) {
#ifdef CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE
    return "true";
#else
    return "false";
#endif
}

static uint32_t esp_uptime_seconds(void) {
    return (uint32_t) (esp_timer_get_time() / 1000000);
}

static bool cloud_telemetry_snapshot(
    wattpost_cloud_telemetry_t *telemetry) {
    if (!telemetry || diagnostics.boot_count == 0u) {
        return false;
    }

    memset(telemetry, 0, sizeof(*telemetry));
    telemetry->boot_count = diagnostics.boot_count;
    telemetry->device_uptime_s = esp_uptime_seconds();
    telemetry->wifi_connected = wifi_has_ip;

    portENTER_CRITICAL(&internet_reachability_lock);
    telemetry->internet_reachable =
        wifi_has_ip &&
        internet_reachability_state == WATTPOST_INTERNET_REACHABLE;
    portEXIT_CRITICAL(&internet_reachability_lock);

    telemetry->bms_connected = jk_bms_ble_is_connected();

    jk_bms_data_t data;
    memset(&data, 0, sizeof(data));
    telemetry->data_fresh = jk_bms_ble_get_data(&data);
    if (!telemetry->data_fresh) {
        memset(&data, 0, sizeof(data));
        return true;
    }

    telemetry->voltage_v = data.pack_voltage_v;
    telemetry->current_a = data.current_a;
    telemetry->power_w = data.power_w;
    telemetry->soc = data.state_of_charge;
    telemetry->remaining_capacity_valid =
        isfinite(data.remaining_capacity_ah) &&
        data.remaining_capacity_ah >= 0.0f;
    telemetry->remaining_capacity_ah =
        telemetry->remaining_capacity_valid
            ? data.remaining_capacity_ah
            : 0.0f;
    telemetry->nominal_capacity_valid =
        isfinite(data.nominal_capacity_ah) &&
        data.nominal_capacity_ah >= 0.0f;
    telemetry->nominal_capacity_ah =
        telemetry->nominal_capacity_valid
            ? data.nominal_capacity_ah
            : 0.0f;
    telemetry->min_cell_voltage_v = data.min_cell_voltage_v;
    telemetry->max_cell_voltage_v = data.max_cell_voltage_v;
    telemetry->cell_spread_v =
        (float) data.bms_cell_voltage_delta_mv * 0.001f;

    uint8_t cell_count = 0u;
    for (uint8_t cell = 0u;
         cell < JK_BMS_MAX_CELLS &&
         cell_count < WATTPOST_CLOUD_TELEMETRY_MAX_CELLS;
         ++cell) {
        if ((data.cell_active_mask & (1u << cell)) == 0u) {
            continue;
        }
        telemetry->cells_v[cell_count++] =
            data.cell_voltage_v[cell];
    }
    telemetry->cell_count = cell_count;
    telemetry->cell_indices_valid =
        jk_bms_cell_index_valid(data.bms_max_cell_index, data.cell_count) &&
        jk_bms_cell_index_valid(data.bms_min_cell_index, data.cell_count);
    if (telemetry->cell_indices_valid) {
        telemetry->max_cell_index = data.bms_max_cell_index;
        telemetry->min_cell_index = data.bms_min_cell_index;
    }

    jk_bms_device_info_t device_info;
    jk_bms_settings_t settings;
    memset(&device_info, 0, sizeof(device_info));
    memset(&settings, 0, sizeof(settings));
    jk_bms_ble_get_device_info(&device_info);
    jk_bms_ble_get_settings(&settings);

    temp_capabilities_t temp_caps;
    temperature_resolve_capabilities(
        &device_info,
        &data,
        &settings,
        &temp_caps);

    uint8_t temperature_count = 0u;
    for (uint8_t i = 0u;
         i < JK_BMS_MAX_TEMPS &&
         temperature_count < WATTPOST_CLOUD_TELEMETRY_MAX_TEMPS;
         ++i) {
        const temp_channel_info_t *channel =
            &temp_caps.channels[i];
        if (channel->alias_of != NULL ||
            !channel->enabled ||
            !channel->value_valid) {
            continue;
        }
        telemetry->temperatures_c[temperature_count] = channel->val_c;
        telemetry->temperature_ids[temperature_count] = channel->id;
        ++temperature_count;
    }
    telemetry->temperature_count = temperature_count;

    memset(&temp_caps, 0, sizeof(temp_caps));
    memset(&settings, 0, sizeof(settings));
    memset(&device_info, 0, sizeof(device_info));
    memset(&data, 0, sizeof(data));
    return true;
}

static wattpost_config_load_result_t load_device_config_snapshot(
    wattpost_device_config_t *config) {
    const wattpost_config_load_result_t result =
        wattpost_device_config_load(config);

    device_config_status = result;
    device_wifi_configured =
        (result == WATTPOST_CONFIG_LOAD_OK ||
         result == WATTPOST_CONFIG_LOAD_RECOVERED) &&
        config->wifi_configured;
    device_bms_configured =
        (result == WATTPOST_CONFIG_LOAD_OK ||
         result == WATTPOST_CONFIG_LOAD_RECOVERED) &&
        config->bms_configured;

    memset(wifi_ssid_display, 0, sizeof(wifi_ssid_display));
    if (device_wifi_configured) {
        memcpy(wifi_ssid_display, config->wifi_ssid, config->wifi_ssid_len);
        wifi_ssid_display[config->wifi_ssid_len] = '\0';
    }

    memset(bms_address_hint, 0, sizeof(bms_address_hint));
    if (device_bms_configured) {
        snprintf(bms_address_hint, sizeof(bms_address_hint), "...%02X:%02X",
                 config->bms_address[4], config->bms_address[5]);
    }

    if (result == WATTPOST_CONFIG_LOAD_OK ||
        result == WATTPOST_CONFIG_LOAD_EMPTY) {
        ESP_LOGI(TAG, "Device config: status=%s wifi=%s bms=%s schema=%u",
                 wattpost_device_config_load_result_str(result),
                 device_wifi_configured ? "configured" : "missing",
                 device_bms_configured ? "configured" : "missing",
                 (unsigned) WATTPOST_DEVICE_CONFIG_SCHEMA_VERSION);
    } else if (result == WATTPOST_CONFIG_LOAD_RECOVERED) {
        ESP_LOGW(TAG, "Device config: status=%s wifi=%s bms=%s schema=%u",
                 wattpost_device_config_load_result_str(result),
                 device_wifi_configured ? "configured" : "missing",
                 device_bms_configured ? "configured" : "missing",
                 (unsigned) WATTPOST_DEVICE_CONFIG_SCHEMA_VERSION);
    } else {
        ESP_LOGE(TAG, "Device config: status=%s; stored credentials not used",
                 wattpost_device_config_load_result_str(result));
    }

    return result;
}

static void init_persistent_diagnostics(void) {
    memset(&diagnostics, 0, sizeof(diagnostics));

    nvs_handle_t handle;
    esp_err_t err = nvs_open("diagnostics", NVS_READWRITE, &handle);
    if (err == ESP_OK) {
        uint32_t boot_count = 0;
        uint32_t panic_count = 0;
        if (nvs_get_u32(handle, "boot_count", &boot_count) != ESP_OK) {
            boot_count = 0;
        }
        if (nvs_get_u32(handle, "panic_count", &panic_count) != ESP_OK) {
            panic_count = 0;
        }
        ++boot_count;
        if (esp_reset_reason() == ESP_RST_PANIC) {
            ++panic_count;
        }
        diagnostics.boot_count = boot_count;
        diagnostics.panic_count = panic_count;
        if (nvs_set_u32(handle, "boot_count", boot_count) != ESP_OK ||
            nvs_set_u32(handle, "panic_count", panic_count) != ESP_OK ||
            nvs_commit(handle) != ESP_OK) {
            ESP_LOGW(TAG, "Не вдалося зберегти diagnostic boot counters");
        }
        nvs_close(handle);
    } else {
        ESP_LOGW(TAG, "Не вдалося відкрити diagnostics NVS: %s", esp_err_to_name(err));
    }

    size_t coredump_address = 0;
    size_t coredump_size = 0;
    err = esp_core_dump_image_get(&coredump_address, &coredump_size);
    if (err != ESP_OK || coredump_size == 0) {
        return;
    }

    diagnostics.coredump_present = true;
    diagnostics.coredump_size = coredump_size;
    diagnostics.coredump_valid = esp_core_dump_image_check() == ESP_OK;
    if (!diagnostics.coredump_valid) {
        ESP_LOGW(TAG, "Core dump присутній, але integrity check не пройдено");
        return;
    }

    if (esp_core_dump_get_panic_reason(diagnostics.panic_reason,
                                       sizeof(diagnostics.panic_reason)) != ESP_OK) {
        diagnostics.panic_reason[0] = '\0';
    }

    esp_core_dump_summary_t summary = {0};
    if (esp_core_dump_get_summary(&summary) == ESP_OK) {
        strlcpy(diagnostics.panic_task, summary.exc_task, sizeof(diagnostics.panic_task));
        diagnostics.panic_pc = summary.exc_pc;
        diagnostics.panic_backtrace_depth = summary.exc_bt_info.depth;
        if (diagnostics.panic_backtrace_depth > 16) {
            diagnostics.panic_backtrace_depth = 16;
        }
        for (uint32_t index = 0; index < diagnostics.panic_backtrace_depth; ++index) {
            diagnostics.panic_backtrace[index] = summary.exc_bt_info.bt[index];
        }
        diagnostics.panic_backtrace_corrupted = summary.exc_bt_info.corrupted;
    }

    ESP_LOGW(TAG, "Збережено core dump: %u bytes, task=%s, pc=0x%08lX",
             (unsigned int) diagnostics.coredump_size,
             diagnostics.panic_task[0] ? diagnostics.panic_task : "unknown",
             (unsigned long) diagnostics.panic_pc);
}

static bool wifi_station_ip_ready(void);

static const char *device_setup_state(void) {
    if (device_config_status == WATTPOST_CONFIG_LOAD_CORRUPT ||
        device_config_status == WATTPOST_CONFIG_LOAD_UNSUPPORTED ||
        device_config_status == WATTPOST_CONFIG_LOAD_STORAGE_ERROR) {
        return "config_error";
    }
    if (!device_wifi_configured) {
        return "wifi_required";
    }
    if (!device_bms_configured) {
        return "bms_required";
    }
    return "configured";
}

static const char *wifi_runtime_state(void) {
    if (wifi_runtime_error ||
        wifi_boot_action == WATTPOST_WIFI_BOOT_CONFIG_ERROR) {
        return "error";
    }
    if (wifi_has_ip) {
        return "connected";
    }
    if (wifi_connecting || wifi_sta_started) {
        return "connecting";
    }
    return "disconnected";
}

static bool provisioning_ap_active(void) {
    return first_setup_ap_active || recovery_ap_active;
}

static const char *device_runtime_mode(void) {
    if (recovery_ap_active) {
        return "recovery";
    }
    return first_setup_ap_active ||
           (provision_boot_action == WATTPOST_PROVISION_BOOT_FIRST_SETUP &&
            strcmp(device_setup_state(), "configured") != 0)
        ? "first_setup"
        : "normal";
}

static const char *device_bms_runtime_state(void) {
    if (bms_boot_action == WATTPOST_BMS_BOOT_CONFIG_ERROR) {
        return "error";
    }
    if (!device_bms_configured) {
        return "disconnected";
    }
    if (jk_bms_ble_is_connected()) {
        return "connected";
    }
    const char *state = jk_bms_ble_state();
    return strcmp(state, "connecting") == 0 ||
           strcmp(state, "target_seen") == 0
        ? "connecting"
        : "disconnected";
}

static bool wifi_current_rssi(int8_t *rssi) {
    if (!rssi || !wifi_has_ip || !wifi_sta_started) {
        return false;
    }
    wifi_ap_record_t record = {0};
    if (esp_wifi_sta_get_ap_info(&record) != ESP_OK) {
        return false;
    }
    *rssi = record.rssi;
    return true;
}

static uint32_t wifi_down_time(void) {
    if (!wifi_sta_started ||
        !wattpost_wifi_recovery_enabled(wifi_boot_action)) {
        return 0;
    }
    return wifi_has_ip ? 0 : monotonic_age_seconds(wifi_down_since_us);
}

static void rotate_local_request_token(void) {
    uint8_t random_bytes[WATTPOST_REQUEST_TOKEN_BYTES] = {0};
    esp_fill_random(random_bytes, sizeof(random_bytes));
    wattpost_request_token_encode(random_bytes, local_request_token);
    memset(random_bytes, 0, sizeof(random_bytes));
}

static bool netif_ipv4_string(
    esp_netif_t *netif,
    char *buffer,
    size_t buffer_size) {
    if (!netif || !buffer || buffer_size < 16u) {
        return false;
    }

    esp_netif_ip_info_t ip_info = {0};
    if (esp_netif_get_ip_info(netif, &ip_info) != ESP_OK ||
        ip_info.ip.addr == 0u) {
        buffer[0] = '\0';
        return false;
    }

    const int written = snprintf(
        buffer, buffer_size, IPSTR, IP2STR(&ip_info.ip));
    return written > 0 && (size_t) written < buffer_size;
}


static bool configure_captive_portal_dhcp(esp_netif_t *ap_netif) {
    if (!ap_netif) {
        return false;
    }

    char ap_ip[16] = {0};
    if (!netif_ipv4_string(ap_netif, ap_ip, sizeof(ap_ip))) {
        return false;
    }

    const int written = snprintf(
        captive_portal_uri,
        sizeof(captive_portal_uri),
        "http://%s/",
        ap_ip);
    if (written <= 0 || (size_t) written >= sizeof(captive_portal_uri)) {
        captive_portal_uri[0] = '\0';
        return false;
    }

    esp_netif_dhcp_status_t status = ESP_NETIF_DHCP_INIT;
    if (esp_netif_dhcps_get_status(ap_netif, &status) != ESP_OK) {
        captive_portal_uri[0] = '\0';
        return false;
    }

    bool restart = false;
    if (status == ESP_NETIF_DHCP_STARTED) {
        if (esp_netif_dhcps_stop(ap_netif) != ESP_OK) {
            captive_portal_uri[0] = '\0';
            return false;
        }
        restart = true;
    }

    const esp_err_t option_err = esp_netif_dhcps_option(
        ap_netif,
        ESP_NETIF_OP_SET,
        ESP_NETIF_CAPTIVEPORTAL_URI,
        captive_portal_uri,
        strlen(captive_portal_uri));

    esp_err_t restart_err = ESP_OK;
    if (restart) {
        restart_err = esp_netif_dhcps_start(ap_netif);
    }

    if (option_err != ESP_OK || restart_err != ESP_OK) {
        captive_portal_uri[0] = '\0';
        return false;
    }
    return true;
}

static bool request_header_value(
    httpd_req_t *request,
    const char *name,
    char *buffer,
    size_t buffer_size) {
    if (!request || !name || !buffer || buffer_size == 0u) {
        return false;
    }

    const size_t value_len = httpd_req_get_hdr_value_len(request, name);
    if (value_len == 0u || value_len + 1u > buffer_size) {
        buffer[0] = '\0';
        return false;
    }

    if (httpd_req_get_hdr_value_str(
            request, name, buffer, buffer_size) != ESP_OK) {
        buffer[0] = '\0';
        return false;
    }
    return true;
}

static bool local_request_host_allowed(httpd_req_t *request) {
    char host[80] = {0};
    if (!request_header_value(request, "Host", host, sizeof(host))) {
        return false;
    }

    char sta_ip[16] = {0};
    char ap_ip[16] = {0};
    netif_ipv4_string(wifi_netif, sta_ip, sizeof(sta_ip));
    if (provisioning_ap_active()) {
        netif_ipv4_string(wifi_ap_netif, ap_ip, sizeof(ap_ip));
    }

    return wattpost_local_host_allowed(host, sta_ip, ap_ip);
}


static esp_err_t captive_portal_redirect(httpd_req_t *request) {
    char ap_ip[16] = {0};
    if (!provisioning_ap_active() ||
        !netif_ipv4_string(wifi_ap_netif, ap_ip, sizeof(ap_ip))) {
        httpd_resp_send_err(request, HTTPD_404_NOT_FOUND, "Not found");
        return ESP_FAIL;
    }

    char location[32];
    const int written = snprintf(
        location,
        sizeof(location),
        "http://%s/",
        ap_ip);
    if (written <= 0 || (size_t) written >= sizeof(location)) {
        httpd_resp_send_err(
            request,
            HTTPD_500_INTERNAL_SERVER_ERROR,
            "Redirect unavailable");
        return ESP_FAIL;
    }

    httpd_resp_set_status(request, "302 Found");
    httpd_resp_set_hdr(request, "Location", location);
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    httpd_resp_set_type(request, "text/plain");
    return httpd_resp_sendstr(request, "Open WattPost local setup");
}

static esp_err_t device_api_error(
    httpd_req_t *request,
    const char *status,
    const char *code) {
    if (!request || !status || !code) {
        return ESP_FAIL;
    }

    char response[128];
    const int written = snprintf(
        response,
        sizeof(response),
        "{\"ok\":false,\"error\":{\"code\":\"%s\"}}",
        code);
    if (written <= 0 || (size_t) written >= sizeof(response)) {
        return ESP_FAIL;
    }

    httpd_resp_set_status(request, status);
    httpd_resp_set_type(request, "application/json");
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    return httpd_resp_sendstr(request, response);
}


static bool system_action_blocks_mutations(void) {
    bool blocked;
    portENTER_CRITICAL(&system_action_lock);
    blocked =
        system_action_pending != SYSTEM_ACTION_NONE ||
        scheduled_restart_pending ||
        restart_pending;
    portEXIT_CRITICAL(&system_action_lock);
    return blocked;
}

static bool local_mutation_request_allowed(httpd_req_t *request) {
    char host[80] = {0};
    char origin[96] = {0};
    char content_type[80] = {0};
    char supplied_token[WATTPOST_REQUEST_TOKEN_HEX_LEN + 1] = {0};

    const bool has_host =
        request_header_value(request, "Host", host, sizeof(host));
    const bool has_origin =
        request_header_value(request, "Origin", origin, sizeof(origin));
    const bool has_content_type =
        request_header_value(
            request, "Content-Type", content_type, sizeof(content_type));
    const bool has_token =
        request_header_value(
            request,
            "X-WattPost-Request-Token",
            supplied_token,
            sizeof(supplied_token));

    char sta_ip[16] = {0};
    char ap_ip[16] = {0};
    netif_ipv4_string(wifi_netif, sta_ip, sizeof(sta_ip));
    if (provisioning_ap_active()) {
        netif_ipv4_string(wifi_ap_netif, ap_ip, sizeof(ap_ip));
    }

    const wattpost_local_mutation_auth_result_t auth =
        wattpost_local_mutation_authorize(
            has_host ? host : NULL,
            has_origin ? origin : NULL,
            has_content_type ? content_type : NULL,
            has_token ? supplied_token : NULL,
            local_request_token,
            sta_ip,
            ap_ip);

    memset(supplied_token, 0, sizeof(supplied_token));

    if (auth == WATTPOST_LOCAL_MUTATION_AUTH_OK) {
        if (system_action_blocks_mutations()) {
            device_api_error(request, "409 Conflict", "busy");
            return false;
        }
        return true;
    }

    if (!has_token) {
        device_api_error(
            request, "403 Forbidden", "request_token_required");
    } else if (auth == WATTPOST_LOCAL_MUTATION_AUTH_TOKEN) {
        device_api_error(
            request, "403 Forbidden", "request_token_invalid");
    } else if (auth == WATTPOST_LOCAL_MUTATION_AUTH_CONTENT_TYPE) {
        device_api_error(
            request, "400 Bad Request", "invalid_request");
    } else {
        device_api_error(
            request, "403 Forbidden", "forbidden_origin");
    }
    return false;
}

static const char *wifi_operation_state_str(
    wifi_operation_state_t state) {
    switch (state) {
        case WIFI_OPERATION_IDLE: return "idle";
        case WIFI_OPERATION_RUNNING: return "running";
        case WIFI_OPERATION_SUCCESS: return "success";
        case WIFI_OPERATION_ERROR: return "error";
        default: return "error";
    }
}

static const char *wifi_operation_phase_str(
    wifi_operation_phase_t phase) {
    switch (phase) {
        case WIFI_OPERATION_PHASE_NONE: return "none";
        case WIFI_OPERATION_PHASE_SCANNING: return "scanning";
        case WIFI_OPERATION_PHASE_VALIDATING: return "validating";
        case WIFI_OPERATION_PHASE_CONNECTING: return "connecting";
        case WIFI_OPERATION_PHASE_SAVING: return "saving";
        case WIFI_OPERATION_PHASE_RECONNECTING: return "reconnecting";
        case WIFI_OPERATION_PHASE_RESETTING: return "resetting";
        default: return "none";
    }
}

static const char *wifi_auth_mode_str(wifi_auth_mode_t authmode) {
    switch (authmode) {
        case WIFI_AUTH_OPEN: return "open";
        case WIFI_AUTH_WEP: return "wep";
        case WIFI_AUTH_WPA_PSK: return "wpa";
        case WIFI_AUTH_WPA2_PSK: return "wpa2";
        case WIFI_AUTH_WPA_WPA2_PSK: return "wpa_wpa2";
        case WIFI_AUTH_ENTERPRISE: return "enterprise";
        case WIFI_AUTH_WPA3_PSK: return "wpa3";
        case WIFI_AUTH_WPA2_WPA3_PSK: return "wpa2_wpa3";
        case WIFI_AUTH_WAPI_PSK: return "wapi";
        case WIFI_AUTH_OWE: return "owe";
        case WIFI_AUTH_WPA3_ENT_192: return "wpa3_enterprise_192";
        case WIFI_AUTH_WPA3_EXT_PSK: return "wpa3";
        case WIFI_AUTH_WPA3_EXT_PSK_MIXED_MODE: return "wpa3_mixed";
        case WIFI_AUTH_DPP: return "dpp";
        case WIFI_AUTH_WPA3_ENTERPRISE: return "wpa3_enterprise";
        case WIFI_AUTH_WPA2_WPA3_ENTERPRISE:
            return "wpa2_wpa3_enterprise";
        case WIFI_AUTH_WPA_ENTERPRISE: return "wpa_enterprise";
        default: return "unknown";
    }
}


static const char *wifi_validation_error_for_disconnect_reason(
    uint8_t reason) {
    switch (reason) {
        case WIFI_REASON_AUTH_EXPIRE:
        case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
        case WIFI_REASON_GROUP_KEY_UPDATE_TIMEOUT:
        case WIFI_REASON_802_1X_AUTH_FAILED:
        case WIFI_REASON_AUTH_FAIL:
        case WIFI_REASON_HANDSHAKE_TIMEOUT:
            return "wifi_auth_failed";
        case WIFI_REASON_NO_AP_FOUND:
        case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY:
        case WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD:
        case WIFI_REASON_NO_AP_FOUND_IN_RSSI_THRESHOLD:
            return "wifi_not_found";
        default:
            return "wifi_connect_failed";
    }
}

static bool wifi_operation_busy_locked(void) {
    return wifi_operation_state == WIFI_OPERATION_RUNNING ||
           wifi_rollback.pending;
}

/* Only an explicit Wi-Fi action from First Setup may preempt background rollback.
 * Other operations still use wifi_operation_busy_locked(). */
static bool wifi_setup_operation_busy_locked(void) {
    return wifi_operation_state == WIFI_OPERATION_RUNNING ||
           (wifi_rollback.pending && !first_setup_ap_active);
}

static bool wifi_validation_active_snapshot(void) {
    bool active;
    portENTER_CRITICAL(&wifi_scan_lock);
    active = wifi_validation.active;
    portEXIT_CRITICAL(&wifi_scan_lock);
    return active;
}

static bool wifi_rollback_pending_snapshot(void) {
    bool pending;
    portENTER_CRITICAL(&wifi_scan_lock);
    pending = wifi_rollback.pending;
    portEXIT_CRITICAL(&wifi_scan_lock);
    return pending;
}

static bool wifi_reconnect_active_snapshot(void) {
    bool active;
    portENTER_CRITICAL(&wifi_scan_lock);
    active = wifi_reconnect_operation.active;
    portEXIT_CRITICAL(&wifi_scan_lock);
    return active;
}

static bool wifi_sta_config_from_device_config(
    const wattpost_device_config_t *device_config,
    wifi_config_t *sta_config) {
    if (!device_config ||
        !sta_config ||
        !device_config->wifi_configured ||
        !wattpost_device_config_validate(device_config)) {
        return false;
    }

    memset(sta_config, 0, sizeof(*sta_config));
    memcpy(
        sta_config->sta.ssid,
        device_config->wifi_ssid,
        device_config->wifi_ssid_len);
    memcpy(
        sta_config->sta.password,
        device_config->wifi_password,
        device_config->wifi_password_len);
    sta_config->sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    sta_config->sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
    sta_config->sta.threshold.authmode = WIFI_AUTH_OPEN;
    return true;
}

static void wifi_validation_finish_error(const char *error_code) {
    bool rollback_required = false;
    bool preserve_current_connection = false;

    portENTER_CRITICAL(&wifi_scan_lock);
    if (wifi_validation.active) {
        if (first_setup_ap_active) first_setup_wifi_retry_required = true;
        preserve_current_connection =
            wifi_validation.installed_switch &&
            wifi_validation.start_pending;
        rollback_required =
            wifi_validation.installed_switch &&
            !wifi_validation.start_pending;
        if (rollback_required) {
            wifi_rollback.pending = true;
            wifi_rollback.connecting = false;
            wifi_rollback.config = wifi_validation.rollback_config;
        }

        memset(
            &wifi_validation.pending_config,
            0,
            sizeof(wifi_validation.pending_config));
        memset(
            &wifi_validation.rollback_config,
            0,
            sizeof(wifi_validation.rollback_config));
        wifi_validation.active = false;
        wifi_validation.installed_switch = false;
        wifi_validation.recovery_flow = false;
        wifi_validation.start_pending = false;
        wifi_validation.expected_disconnect = false;
        wifi_validation.start_armed = false;
        wifi_validation.pending_applied = false;
        wifi_validation.association_confirmed = false;
        wifi_validation.candidate_bssid_set = false;
        memset(
            wifi_validation.candidate_bssid,
            0,
            sizeof(wifi_validation.candidate_bssid));
        wifi_validation.candidate_channel = 0u;
        wifi_validation.started_us = 0;
        wifi_operation_state = WIFI_OPERATION_ERROR;
        wifi_operation_phase = WIFI_OPERATION_PHASE_NONE;
        wifi_operation_error_code =
            error_code ? error_code : "wifi_connect_failed";
    }
    portEXIT_CRITICAL(&wifi_scan_lock);

    if (!preserve_current_connection) {
        wifi_connecting = false;
        wifi_has_ip = false;
        wifi_sta_started = rollback_required;
    }
}

static bool wifi_validation_apply_pending_config(void) {
    wattpost_device_config_t pending = {0};
    bool active = false;
    bool bssid_set = false;
    uint8_t bssid[6] = {0};
    uint8_t channel = 0u;

    portENTER_CRITICAL(&wifi_scan_lock);
    active = wifi_validation.active && !wifi_validation.start_pending &&
             !wifi_validation.expected_disconnect && !wifi_validation.pending_applied;
    if (active) {
        wifi_validation.pending_applied = true;
        wifi_validation.association_confirmed = false;
        pending = wifi_validation.pending_config;
        bssid_set = wifi_validation.candidate_bssid_set;
        memcpy(
            bssid,
            wifi_validation.candidate_bssid,
            sizeof(bssid));
        channel = wifi_validation.candidate_channel;
        wifi_operation_phase = WIFI_OPERATION_PHASE_CONNECTING;
    }
    portEXIT_CRITICAL(&wifi_scan_lock);

    if (!active) {
        return false;
    }

    wifi_config_t sta_config;
    if (!wifi_sta_config_from_device_config(&pending, &sta_config)) {
        memset(&pending, 0, sizeof(pending));
        memset(bssid, 0, sizeof(bssid));
        wifi_validation_finish_error("invalid_request");
        return false;
    }

    if (bssid_set) {
        sta_config.sta.bssid_set = true;
        memcpy(
            sta_config.sta.bssid,
            bssid,
            sizeof(sta_config.sta.bssid));
        sta_config.sta.channel = channel;
    }

    esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &sta_config);
    memset(&sta_config, 0, sizeof(sta_config));
    memset(&pending, 0, sizeof(pending));
    memset(bssid, 0, sizeof(bssid));

    if (err != ESP_OK) {
        wifi_validation_finish_error("invalid_request");
        return false;
    }

    wifi_sta_started = true;
    wifi_connecting = true;
    wifi_has_ip = false;
    wifi_runtime_error = false;

    err = esp_wifi_connect();
    if (err != ESP_OK) {
        wifi_validation_finish_error("wifi_connect_failed");
        return false;
    }
    return true;
}

static void start_pending_installed_wifi_validation(void) {
    bool start = false;

    portENTER_CRITICAL(&wifi_scan_lock);
    if (wifi_validation.active &&
        wifi_validation.installed_switch &&
        wifi_validation.start_pending && wifi_validation.start_armed) {
        wifi_validation.start_pending = false;
        wifi_validation.started_us = esp_timer_get_time();
        /* Also stop an old association that has no IP yet. */
        wifi_validation.expected_disconnect = true;
        wifi_operation_phase = WIFI_OPERATION_PHASE_CONNECTING;
        start = true;
    }
    portEXIT_CRITICAL(&wifi_scan_lock);

    if (!start) {
        return;
    }

    const esp_err_t disconnect_err = esp_wifi_disconnect();
    if (disconnect_err == ESP_ERR_WIFI_NOT_CONNECT) {
        portENTER_CRITICAL(&wifi_scan_lock);
        if (wifi_validation.active) {
            wifi_validation.expected_disconnect = false;
        }
        portEXIT_CRITICAL(&wifi_scan_lock);
        wifi_has_ip = false;
        wifi_validation_apply_pending_config();
    } else if (disconnect_err != ESP_OK) {
        wifi_validation_finish_error("wifi_connect_failed");
    }
}

static bool wifi_validation_handle_disconnect(uint8_t reason) {
    bool active = false;
    bool expected_disconnect = false;
    bool waiting_start = false;

    portENTER_CRITICAL(&wifi_scan_lock);
    active = wifi_validation.active;
    waiting_start = active && wifi_validation.start_pending;
    if (active && wifi_validation.expected_disconnect) {
        expected_disconnect = true;
        wifi_validation.expected_disconnect = false;
    }
    portEXIT_CRITICAL(&wifi_scan_lock);

    if (!active) {
        return false;
    }

    wifi_has_ip = false;
    if (waiting_start) { wifi_connecting = false; return true; }
    if (expected_disconnect) {
        wifi_validation_apply_pending_config();
        return true;
    }

    wifi_validation_finish_error(
        wifi_validation_error_for_disconnect_reason(reason));
    return true;
}

static void wifi_validation_handle_connected(const wifi_event_sta_connected_t *event) {
    if (event == NULL) return;
    portENTER_CRITICAL(&wifi_scan_lock);
    if (wifi_validation.active && wifi_validation.pending_applied &&
        !wifi_validation.start_pending && !wifi_validation.expected_disconnect &&
        event->ssid_len == wifi_validation.pending_config.wifi_ssid_len &&
        memcmp(event->ssid, wifi_validation.pending_config.wifi_ssid, event->ssid_len) == 0 &&
        (!wifi_validation.candidate_bssid_set ||
         memcmp(event->bssid, wifi_validation.candidate_bssid, 6) == 0)) {
        wifi_validation.association_confirmed = true;
    }
    portEXIT_CRITICAL(&wifi_scan_lock);
}

static bool wifi_validation_handle_got_ip(void) {
    wattpost_device_config_t pending = {0};
    bool active;
    bool ready = false;
    bool bssid_set = false;
    uint8_t bssid[6] = {0};
    bool recovery_flow = false;

    portENTER_CRITICAL(&wifi_scan_lock);
    active = wifi_validation.active;
    ready = active && !wifi_validation.start_pending &&
            !wifi_validation.expected_disconnect && wifi_validation.pending_applied &&
            wifi_validation.association_confirmed;
    if (ready) {
        bssid_set = wifi_validation.candidate_bssid_set;
        memcpy(bssid, wifi_validation.candidate_bssid, sizeof(bssid));
        pending = wifi_validation.pending_config;
        recovery_flow = wifi_validation.recovery_flow;
        wifi_operation_phase = WIFI_OPERATION_PHASE_SAVING;
    }
    portEXIT_CRITICAL(&wifi_scan_lock);

    if (!active) {
        return true;
    }

    if (!ready) return false;
    wifi_ap_record_t associated = {0};
    if (esp_wifi_sta_get_ap_info(&associated) != ESP_OK ||
        strlen((const char *) associated.ssid) != pending.wifi_ssid_len ||
        memcmp(associated.ssid, pending.wifi_ssid, pending.wifi_ssid_len) != 0 ||
        (bssid_set && memcmp(associated.bssid, bssid, sizeof(bssid)) != 0)) {
        memset(&pending, 0, sizeof(pending));
        return false;
    }
    const bool saved = wattpost_device_config_save(&pending);
    if (!saved) {
        memset(&pending, 0, sizeof(pending));
        wifi_validation_finish_error("storage_error");
        esp_wifi_disconnect();
        return false;
    }

    device_config_status = WATTPOST_CONFIG_LOAD_OK;
    device_wifi_configured = true;
    first_setup_wifi_retry_required = false;
    memset(wifi_ssid_display, 0, sizeof(wifi_ssid_display));
    memcpy(
        wifi_ssid_display,
        pending.wifi_ssid,
        pending.wifi_ssid_len);
    wifi_ssid_display[pending.wifi_ssid_len] = '\0';
    wifi_boot_action = WATTPOST_WIFI_BOOT_CONNECT_SAVED;
    wifi_sta_started = true;
    wifi_connecting = false;

    portENTER_CRITICAL(&wifi_scan_lock);
    memset(
        &wifi_validation.pending_config,
        0,
        sizeof(wifi_validation.pending_config));
    memset(
        &wifi_validation.rollback_config,
        0,
        sizeof(wifi_validation.rollback_config));
    wifi_validation.active = false;
    wifi_validation.installed_switch = false;
    wifi_validation.recovery_flow = false;
    wifi_validation.start_pending = false;
    wifi_validation.expected_disconnect = false;
    wifi_validation.start_armed = false;
    wifi_validation.pending_applied = false;
    wifi_validation.association_confirmed = false;
    wifi_validation.candidate_bssid_set = false;
    memset(
        wifi_validation.candidate_bssid,
        0,
        sizeof(wifi_validation.candidate_bssid));
    wifi_validation.candidate_channel = 0u;
    wifi_validation.started_us = 0;
    wifi_operation_state = WIFI_OPERATION_SUCCESS;
    wifi_operation_phase = WIFI_OPERATION_PHASE_NONE;
    wifi_operation_error_code = NULL;
    if (recovery_flow) {
        recovery_completion_pending = true;
        recovery_completed_us = esp_timer_get_time();
    }
    portEXIT_CRITICAL(&wifi_scan_lock);

    memset(&pending, 0, sizeof(pending));
    return true;
}

static void maintain_wifi_validation(void) {
    int64_t started_us = 0;
    bool active;

    portENTER_CRITICAL(&wifi_scan_lock);
    active = wifi_validation.active;
    if (active) {
        started_us = wifi_validation.started_us;
    }
    portEXIT_CRITICAL(&wifi_scan_lock);

    if (!active ||
        started_us <= 0 ||
        monotonic_age_seconds(started_us) <
            WATTPOST_WIFI_VALIDATION_TIMEOUT_SECONDS) {
        return;
    }

    ESP_LOGW(TAG, "Wi-Fi validation timeout");
    wifi_validation_finish_error("wifi_connect_failed");
    esp_wifi_disconnect();
}

static void maintain_wifi_rollback(void) {
    wattpost_device_config_t rollback_config = {0};
    bool restore = false;

    portENTER_CRITICAL(&wifi_scan_lock);
    if (wifi_rollback.pending && !wifi_rollback.connecting &&
        !wifi_rollback_preempt_requested && !wifi_validation.active && !wifi_scan_running) {
        rollback_config = wifi_rollback.config;
        wifi_rollback.connecting = true;
        restore = true;
    }
    portEXIT_CRITICAL(&wifi_scan_lock);

    if (!restore) {
        return;
    }

    wifi_config_t sta_config;
    if (!wifi_sta_config_from_device_config(
            &rollback_config, &sta_config)) {
        portENTER_CRITICAL(&wifi_scan_lock);
        wifi_rollback.connecting = false;
        portEXIT_CRITICAL(&wifi_scan_lock);
        memset(&rollback_config, 0, sizeof(rollback_config));
        return;
    }

    esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &sta_config);
    memset(&sta_config, 0, sizeof(sta_config));
    if (err == ESP_OK) {
        wifi_sta_started = true;
        wifi_connecting = true;
        wifi_runtime_error = false;
        err = esp_wifi_connect();
    }

    if (err != ESP_OK) {
        wifi_connecting = false;
        portENTER_CRITICAL(&wifi_scan_lock);
        wifi_rollback.connecting = false;
        portEXIT_CRITICAL(&wifi_scan_lock);
        ESP_LOGW(
            TAG,
            "Wi-Fi rollback retry failed: %s",
            esp_err_to_name(err));
    } else {
        ESP_LOGW(
            TAG,
            "Wi-Fi validation failed; restoring previous saved network");
    }

    memset(&rollback_config, 0, sizeof(rollback_config));
}

static void wifi_rollback_handle_disconnect(void) {
    portENTER_CRITICAL(&wifi_scan_lock);
    if (wifi_rollback.pending) {
        wifi_rollback.connecting = false;
    }
    portEXIT_CRITICAL(&wifi_scan_lock);
    wifi_has_ip = false;
    wifi_connecting = false;
}

static void wifi_rollback_handle_got_ip(void) {
    portENTER_CRITICAL(&wifi_scan_lock);
    if (wifi_rollback.pending) {
        memset(
            &wifi_rollback.config,
            0,
            sizeof(wifi_rollback.config));
        wifi_rollback.pending = false;
        wifi_rollback.connecting = false;
    }
    portEXIT_CRITICAL(&wifi_scan_lock);
}

static void wifi_reconnect_finish(
    wifi_operation_state_t state,
    const char *error_code) {
    portENTER_CRITICAL(&wifi_scan_lock);
    if (wifi_reconnect_operation.active) {
        const bool recovery_flow = wifi_reconnect_operation.recovery_flow;
        wifi_reconnect_operation.active = false;
        wifi_reconnect_operation.recovery_flow = false;
        wifi_reconnect_operation.start_pending = false;
        wifi_reconnect_operation.started_us = 0;
        wifi_operation_state = state;
        wifi_operation_phase = WIFI_OPERATION_PHASE_NONE;
        wifi_operation_error_code =
            state == WIFI_OPERATION_ERROR
                ? (error_code ? error_code : "wifi_connect_failed")
                : NULL;
        if (state == WIFI_OPERATION_SUCCESS && recovery_flow) {
            recovery_completion_pending = true;
            recovery_completed_us = esp_timer_get_time();
        }
    }
    portEXIT_CRITICAL(&wifi_scan_lock);
}

static void maintain_wifi_reconnect_operation(void) {
    bool start_pending = false;
    int64_t started_us = 0;
    bool active = false;

    portENTER_CRITICAL(&wifi_scan_lock);
    active = wifi_reconnect_operation.active;
    if (active && wifi_reconnect_operation.start_pending) {
        wifi_reconnect_operation.start_pending = false;
        wifi_reconnect_operation.started_us = esp_timer_get_time();
        start_pending = true;
    }
    if (active) {
        started_us = wifi_reconnect_operation.started_us;
    }
    portEXIT_CRITICAL(&wifi_scan_lock);

    if (start_pending) {
        wattpost_device_config_t saved_config;
        if (!load_device_config_for_mutation(&saved_config) ||
            !saved_config.wifi_configured) {
            memset(&saved_config, 0, sizeof(saved_config));
            wifi_reconnect_finish(
                WIFI_OPERATION_ERROR,
                "storage_error");
            return;
        }

        wifi_config_t sta_config;
        const bool valid_config =
            wifi_sta_config_from_device_config(
                &saved_config, &sta_config);
        memset(&saved_config, 0, sizeof(saved_config));
        if (!valid_config) {
            wifi_reconnect_finish(
                WIFI_OPERATION_ERROR,
                "storage_error");
            return;
        }

        esp_err_t err =
            esp_wifi_set_config(WIFI_IF_STA, &sta_config);
        memset(&sta_config, 0, sizeof(sta_config));
        if (err != ESP_OK) {
            wifi_reconnect_finish(
                WIFI_OPERATION_ERROR,
                "wifi_connect_failed");
            return;
        }

        wifi_runtime_error = false;
        if (wifi_has_ip) {
            err = esp_wifi_disconnect();
            if (err == ESP_ERR_WIFI_NOT_CONNECT) {
                wifi_has_ip = false;
                wifi_connecting = true;
                err = esp_wifi_connect();
            }
        } else {
            wifi_connecting = true;
            err = esp_wifi_connect();
        }

        if (err != ESP_OK) {
            wifi_connecting = false;
            wifi_reconnect_finish(
                WIFI_OPERATION_ERROR,
                "wifi_connect_failed");
            return;
        }
    }

    if (active &&
        started_us > 0 &&
        monotonic_age_seconds(started_us) >=
            WATTPOST_WIFI_VALIDATION_TIMEOUT_SECONDS) {
        wifi_reconnect_finish(
            WIFI_OPERATION_ERROR,
            "wifi_connect_failed");
    }
}

static esp_err_t request_token_handler(httpd_req_t *request) {
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");

    if (!local_request_host_allowed(request)) {
        return device_api_error(
            request, "403 Forbidden", "forbidden_origin");
    }

    char response[96];
    const int written = snprintf(
        response,
        sizeof(response),
        "{\"ok\":true,\"data\":{\"request_token\":\"%s\"}}",
        local_request_token);
    if (written <= 0 || (size_t) written >= sizeof(response)) {
        httpd_resp_send_err(
            request, HTTPD_500_INTERNAL_SERVER_ERROR, "Response too large");
        return ESP_FAIL;
    }

    httpd_resp_set_type(request, "application/json");
    return httpd_resp_sendstr(request, response);
}



typedef struct {
    bool hidden;
    uint32_t scan_generation;
    uint16_t candidate_id;
    char hidden_ssid[WATTPOST_WIFI_SSID_MAX_LEN + 1u];
    uint8_t password[WATTPOST_WIFI_PASSWORD_MAX_LEN + 1u];
    size_t password_len;
} wifi_configure_request_t;

static void scrub_json_passwords(cJSON *root) {
    if (!root || !cJSON_IsObject(root)) {
        return;
    }
    for (cJSON *item = root->child; item != NULL; item = item->next) {
        if (item->string &&
            strcmp(item->string, "password") == 0 &&
            cJSON_IsString(item) &&
            item->valuestring) {
            memset(item->valuestring, 0, strlen(item->valuestring));
        }
    }
}

static bool json_integer_in_range(
    const cJSON *item,
    uint32_t minimum,
    uint32_t maximum,
    uint32_t *value) {
    if (!cJSON_IsNumber(item) || !isfinite(item->valuedouble) ||
        item->valuedouble < (double) minimum ||
        item->valuedouble > (double) maximum ||
        floor(item->valuedouble) != item->valuedouble) {
        return false;
    }
    if (value) {
        *value = (uint32_t) item->valuedouble;
    }
    return true;
}

static bool parse_wifi_configure_request(
    char *body,
    size_t body_length,
    wifi_configure_request_t *parsed,
    const char **error_code) {
    if (!body || !parsed || !error_code) {
        return false;
    }
    memset(parsed, 0, sizeof(*parsed));
    *error_code = "invalid_json";

    cJSON *root = cJSON_ParseWithLengthOpts(
        body, body_length + 1u, NULL, true);
    if (!root || !cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return false;
    }

    unsigned password_count = 0;
    unsigned scan_generation_count = 0;
    unsigned candidate_id_count = 0;
    unsigned hidden_ssid_count = 0;
    bool unknown_field = false;

    for (cJSON *item = root->child; item != NULL; item = item->next) {
        if (!item->string) {
            unknown_field = true;
            continue;
        }
        if (strcmp(item->string, "password") == 0) {
            ++password_count;
        } else if (strcmp(item->string, "scan_generation") == 0) {
            ++scan_generation_count;
        } else if (strcmp(item->string, "candidate_id") == 0) {
            ++candidate_id_count;
        } else if (strcmp(item->string, "hidden_ssid") == 0) {
            ++hidden_ssid_count;
        } else {
            unknown_field = true;
        }
    }

    const cJSON *password =
        cJSON_GetObjectItemCaseSensitive(root, "password");
    const cJSON *scan_generation =
        cJSON_GetObjectItemCaseSensitive(root, "scan_generation");
    const cJSON *candidate_id =
        cJSON_GetObjectItemCaseSensitive(root, "candidate_id");
    const cJSON *hidden_ssid =
        cJSON_GetObjectItemCaseSensitive(root, "hidden_ssid");

    bool valid = !unknown_field &&
                 password_count == 1u &&
                 cJSON_IsString(password) &&
                 password->valuestring != NULL;

    if (valid) {
        parsed->password_len = strlen(password->valuestring);
        valid = parsed->password_len <= WATTPOST_WIFI_PASSWORD_MAX_LEN;
    }
    if (valid) {
        memcpy(
            parsed->password,
            password->valuestring,
            parsed->password_len);
        parsed->password[parsed->password_len] = '\0';
    }

    const bool candidate_mode =
        scan_generation_count == 1u &&
        candidate_id_count == 1u &&
        hidden_ssid_count == 0u;
    const bool hidden_mode =
        hidden_ssid_count == 1u &&
        scan_generation_count == 0u &&
        candidate_id_count == 0u;

    if (valid && candidate_mode) {
        uint32_t generation = 0;
        uint32_t candidate = 0;
        valid = json_integer_in_range(
                    scan_generation, 1u, UINT32_MAX, &generation) &&
                json_integer_in_range(
                    candidate_id, 1u, UINT16_MAX, &candidate);
        if (valid) {
            parsed->hidden = false;
            parsed->scan_generation = generation;
            parsed->candidate_id = (uint16_t) candidate;
        }
    } else if (valid && hidden_mode) {
        valid = cJSON_IsString(hidden_ssid) &&
                hidden_ssid->valuestring != NULL;
        if (valid) {
            const size_t ssid_len = strlen(hidden_ssid->valuestring);
            valid = ssid_len > 0u &&
                    ssid_len <= WATTPOST_WIFI_SSID_MAX_LEN;
            if (valid) {
                parsed->hidden = true;
                memcpy(
                    parsed->hidden_ssid,
                    hidden_ssid->valuestring,
                    ssid_len);
                parsed->hidden_ssid[ssid_len] = '\0';
            }
        }
    } else {
        valid = false;
    }

    *error_code = valid ? NULL : "invalid_request";
    scrub_json_passwords(root);
    cJSON_Delete(root);

    if (!valid) {
        memset(parsed, 0, sizeof(*parsed));
    }
    return valid;
}

static bool wifi_candidate_for_configure(
    uint32_t generation,
    uint16_t candidate_id,
    wifi_scan_candidate_t *candidate,
    const char **error_code) {
    if (!candidate || !error_code) {
        return false;
    }

    bool found = false;
    portENTER_CRITICAL(&wifi_scan_lock);
    if (wifi_setup_operation_busy_locked()) {
        *error_code = "busy";
    } else if (generation != wifi_scan_generation ||
               generation != wifi_scan_completed_generation) {
        *error_code = "stale_scan";
    } else {
        *error_code = "candidate_not_found";
        for (size_t i = 0; i < wifi_scan_candidate_count; ++i) {
            if (wifi_scan_candidates[i].candidate_id == candidate_id) {
                *candidate = wifi_scan_candidates[i];
                found = true;
                *error_code = NULL;
                break;
            }
        }
    }
    portEXIT_CRITICAL(&wifi_scan_lock);
    return found;
}

static bool load_device_config_for_mutation(
    wattpost_device_config_t *config) {
    const wattpost_config_load_result_t result =
        wattpost_device_config_load(config);
    if (result == WATTPOST_CONFIG_LOAD_EMPTY) {
        wattpost_device_config_defaults(config);
        return true;
    }
    return result == WATTPOST_CONFIG_LOAD_OK ||
           result == WATTPOST_CONFIG_LOAD_RECOVERED;
}

static void wifi_scan_mark_error(const char *error_code) {
    portENTER_CRITICAL(&wifi_scan_lock);
    if (wifi_scan_running) {
        wifi_scan_running = false;
        wifi_operation_state = WIFI_OPERATION_ERROR;
        wifi_operation_phase = WIFI_OPERATION_PHASE_NONE;
        wifi_operation_error_code = error_code;
    }
    portEXIT_CRITICAL(&wifi_scan_lock);
}

static void wifi_scan_handle_done(
    const wifi_event_sta_scan_done_t *event) {
    bool expected_scan;
    portENTER_CRITICAL(&wifi_scan_lock);
    expected_scan = wifi_scan_running;
    portEXIT_CRITICAL(&wifi_scan_lock);

    if (!expected_scan) {
        return;
    }
    if (!event || event->status != 0u) {
        wifi_scan_mark_error("subsystem_unavailable");
        return;
    }

    memset(wifi_scan_ap_records, 0, sizeof(wifi_scan_ap_records));
    uint16_t count = WATTPOST_WIFI_SCAN_MAX_CANDIDATES;
    const esp_err_t err = esp_wifi_scan_get_ap_records(
        &count, wifi_scan_ap_records);
    if (err != ESP_OK) {
        wifi_scan_mark_error("subsystem_unavailable");
        return;
    }

    memset(
        wifi_scan_candidates_scratch,
        0,
        sizeof(wifi_scan_candidates_scratch));
    size_t candidate_count = 0;

    for (uint16_t i = 0;
         i < count && candidate_count < WATTPOST_WIFI_SCAN_MAX_CANDIDATES;
         ++i) {
        const size_t ssid_len = strnlen(
            (const char *) wifi_scan_ap_records[i].ssid,
            sizeof(wifi_scan_candidates_scratch[0].ssid) - 1u);
        if (ssid_len == 0u) {
            continue;
        }

        wifi_scan_candidate_t *candidate =
            &wifi_scan_candidates_scratch[candidate_count];
        candidate->candidate_id = (uint16_t) (candidate_count + 1u);
        memcpy(candidate->ssid, wifi_scan_ap_records[i].ssid, ssid_len);
        candidate->ssid[ssid_len] = '\0';
        candidate->rssi_dbm = wifi_scan_ap_records[i].rssi;
        candidate->channel = wifi_scan_ap_records[i].primary;
        candidate->authmode = wifi_scan_ap_records[i].authmode;
        memcpy(
            candidate->bssid,
            wifi_scan_ap_records[i].bssid,
            sizeof(candidate->bssid));
        ++candidate_count;
    }

    portENTER_CRITICAL(&wifi_scan_lock);
    memset(wifi_scan_candidates, 0, sizeof(wifi_scan_candidates));
    memcpy(
        wifi_scan_candidates,
        wifi_scan_candidates_scratch,
        candidate_count * sizeof(wifi_scan_candidates_scratch[0]));
    wifi_scan_candidate_count = candidate_count;
    wifi_scan_running = false;
    wifi_scan_completed_generation = wifi_scan_generation;
    wifi_operation_state = WIFI_OPERATION_SUCCESS;
    wifi_operation_phase = WIFI_OPERATION_PHASE_NONE;
    wifi_operation_error_code = NULL;
    portEXIT_CRITICAL(&wifi_scan_lock);
}

/* Runs only on recovery_task: an old rollback cannot apply its radio config
 * after a newly accepted First Setup operation has started. */
static void maintain_wifi_setup_preemption(void) {
    bool cancelled = false;
    bool start_scan = false;
    portENTER_CRITICAL(&wifi_scan_lock);
    if (wifi_rollback_preempt_requested) {
        memset(&wifi_rollback, 0, sizeof(wifi_rollback));
        wifi_rollback_preempt_requested = false;
        cancelled = true;
    }
    if (wifi_scan_start_pending && !cancelled) {
        wifi_scan_start_pending = false;
        start_scan = true;
    }
    portEXIT_CRITICAL(&wifi_scan_lock);
    if (cancelled && wifi_scan_start_pending) {
        esp_wifi_disconnect();
        wifi_has_ip = false;
        wifi_connecting = false;
        return; /* Start the scan on the next existing worker cycle. */
    }
    if (start_scan) {
        wifi_scan_config_t config = {0};
        config.show_hidden = false;
        config.scan_type = WIFI_SCAN_TYPE_ACTIVE;
        const esp_err_t err = esp_wifi_scan_start(&config, false);
        if (err != ESP_OK) wifi_scan_mark_error(err == ESP_ERR_WIFI_STATE ? "busy" : "subsystem_unavailable");
    }
}

static esp_err_t wifi_scan_start_handler(httpd_req_t *request) {
    if (!local_mutation_request_allowed(request)) {
        return ESP_OK;
    }
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");

    if (!wifi_driver_started) {
        return device_api_error(
            request, "503 Service Unavailable", "subsystem_unavailable");
    }

    uint32_t operation_generation = 0;
    bool busy = false;
    bool deferred_scan = false;
    portENTER_CRITICAL(&wifi_scan_lock);
    if (wifi_setup_operation_busy_locked()) {
        busy = true;
    } else {
        if (wifi_rollback.pending && first_setup_ap_active) {
            wifi_rollback_preempt_requested = true;
            wifi_scan_start_pending = true;
            deferred_scan = true;
        }
        ++wifi_scan_generation;
        ++wifi_operation_generation;
        operation_generation = wifi_operation_generation;
        wifi_scan_running = true;
        wifi_scan_candidate_count = 0;
        memset(wifi_scan_candidates, 0, sizeof(wifi_scan_candidates));
        wifi_operation_state = WIFI_OPERATION_RUNNING;
        wifi_operation_phase = WIFI_OPERATION_PHASE_SCANNING;
        wifi_operation_error_code = NULL;
    }
    portEXIT_CRITICAL(&wifi_scan_lock);

    if (busy) {
        return device_api_error(request, "409 Conflict", "busy");
    }

    wifi_scan_config_t scan_config = {0};
    scan_config.show_hidden = false;
    scan_config.scan_type = WIFI_SCAN_TYPE_ACTIVE;

    const esp_err_t err = deferred_scan ? ESP_OK : esp_wifi_scan_start(&scan_config, false);
    if (err != ESP_OK) {
        wifi_scan_mark_error(
            err == ESP_ERR_WIFI_STATE ? "busy" : "subsystem_unavailable");
        return device_api_error(
            request,
            err == ESP_ERR_WIFI_STATE
                ? "409 Conflict"
                : "503 Service Unavailable",
            err == ESP_ERR_WIFI_STATE
                ? "busy"
                : "subsystem_unavailable");
    }

    char response[192];
    const int written = snprintf(
        response,
        sizeof(response),
        "{\"ok\":true,\"operation\":{"
        "\"generation\":%lu,\"state\":\"running\","
        "\"phase\":\"scanning\",\"error_code\":null}}",
        (unsigned long) operation_generation);
    if (written <= 0 || (size_t) written >= sizeof(response)) {
        wifi_scan_mark_error("internal_error");
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }

    httpd_resp_set_status(request, "202 Accepted");
    httpd_resp_set_type(request, "application/json");
    const esp_err_t result = httpd_resp_sendstr(request, response);
    if (deferred_scan && recovery_task_handle != NULL) xTaskNotifyGive(recovery_task_handle);
    return result;
}

static esp_err_t wifi_scan_get_handler(httpd_req_t *request) {
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    if (!local_request_host_allowed(request)) {
        return device_api_error(
            request, "403 Forbidden", "forbidden_origin");
    }

    uint32_t scan_generation;
    uint32_t operation_generation;
    wifi_operation_state_t operation_state;
    wifi_operation_phase_t operation_phase;
    const char *operation_error;
    size_t candidate_count;
    wifi_scan_candidate_t candidates[WATTPOST_WIFI_SCAN_MAX_CANDIDATES];

    portENTER_CRITICAL(&wifi_scan_lock);
    scan_generation = wifi_scan_generation;
    operation_generation = wifi_operation_generation;
    operation_state = wifi_operation_state;
    operation_phase = wifi_operation_phase;
    operation_error = wifi_operation_error_code;
    candidate_count = wifi_scan_candidate_count;
    memcpy(
        candidates,
        wifi_scan_candidates,
        candidate_count * sizeof(candidates[0]));
    portEXIT_CRITICAL(&wifi_scan_lock);

    char error_json[64] = "null";
    if (operation_error != NULL) {
        snprintf(
            error_json,
            sizeof(error_json),
            "\"%s\"",
            operation_error);
    }

    size_t used = 0;
    if (!wattpost_json_appendf(
            http_json_response.wifi_scan,
            sizeof(http_json_response.wifi_scan),
            &used,
            "{\"ok\":true,\"data\":{"
            "\"scan_generation\":%lu,"
            "\"operation\":{"
            "\"generation\":%lu,"
            "\"state\":\"%s\","
            "\"phase\":\"%s\","
            "\"error_code\":%s},"
            "\"candidates\":[",
            (unsigned long) scan_generation,
            (unsigned long) operation_generation,
            wifi_operation_state_str(operation_state),
            wifi_operation_phase_str(operation_phase),
            error_json)) {
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }

    for (size_t i = 0; i < candidate_count; ++i) {
        char ssid_json[sizeof(candidates[i].ssid) * 6u];
        if (!wattpost_json_escape(
                ssid_json,
                sizeof(ssid_json),
                candidates[i].ssid)) {
            return device_api_error(
                request, "500 Internal Server Error", "internal_error");
        }
        if (!wattpost_json_appendf(
                http_json_response.wifi_scan,
                sizeof(http_json_response.wifi_scan),
                &used,
                "%s{\"candidate_id\":%u,"
                "\"ssid\":\"%s\","
                "\"rssi_dbm\":%d,"
                "\"channel\":%u,"
                "\"auth\":\"%s\"}",
                i == 0u ? "" : ",",
                (unsigned int) candidates[i].candidate_id,
                ssid_json,
                (int) candidates[i].rssi_dbm,
                (unsigned int) candidates[i].channel,
                wifi_auth_mode_str(candidates[i].authmode))) {
            return device_api_error(
                request, "500 Internal Server Error", "internal_error");
        }
    }

    if (!wattpost_json_appendf(
            http_json_response.wifi_scan,
            sizeof(http_json_response.wifi_scan),
            &used,
            "]}}")) {
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }

    httpd_resp_set_type(request, "application/json");
    return httpd_resp_sendstr(request, http_json_response.wifi_scan);
}




static const char *bms_operation_state_str(
    jk_bms_ble_operation_state_t state) {
    switch (state) {
        case JK_BMS_BLE_OPERATION_IDLE: return "idle";
        case JK_BMS_BLE_OPERATION_RUNNING: return "running";
        case JK_BMS_BLE_OPERATION_SUCCESS: return "success";
        case JK_BMS_BLE_OPERATION_ERROR: return "error";
        default: return "error";
    }
}

static const char *bms_operation_phase_str(
    jk_bms_ble_operation_phase_t phase_value) {
    switch (phase_value) {
        case JK_BMS_BLE_PHASE_NONE: return "none";
        case JK_BMS_BLE_PHASE_SCANNING: return "scanning";
        case JK_BMS_BLE_PHASE_CONNECTING: return "connecting";
        case JK_BMS_BLE_PHASE_VALIDATING: return "validating";
        case JK_BMS_BLE_PHASE_SAVING: return "saving";
        case JK_BMS_BLE_PHASE_RECONNECTING: return "reconnecting";
        case JK_BMS_BLE_PHASE_RESETTING: return "resetting";
        default: return "none";
    }
}

static const char *bms_operation_error_str(
    jk_bms_ble_operation_error_t error) {
    switch (error) {
        case JK_BMS_BLE_ERROR_NONE: return NULL;
        case JK_BMS_BLE_ERROR_BUSY: return "busy";
        case JK_BMS_BLE_ERROR_STALE_SCAN: return "stale_scan";
        case JK_BMS_BLE_ERROR_CANDIDATE_NOT_FOUND:
            return "candidate_not_found";
        case JK_BMS_BLE_ERROR_CONNECT_FAILED: return "bms_connect_failed";
        case JK_BMS_BLE_ERROR_INVALID_BMS: return "bms_invalid";
        case JK_BMS_BLE_ERROR_STORAGE: return "storage_error";
        case JK_BMS_BLE_ERROR_SUBSYSTEM_UNAVAILABLE:
            return "subsystem_unavailable";
        default: return "internal_error";
    }
}


/* Read-only cache identity; no identity creation or secret exposure via HTTP. */
static void history_context_string(char context[64]) {
    context[0] = '\0';
    wattpost_device_identity_t identity = {0};
    if (wattpost_device_identity_load(&identity) == WATTPOST_IDENTITY_OK) {
        static const char hex[] = "0123456789abcdef";
        for (size_t i = 0; i < WATTPOST_DEVICE_ID_BYTES; ++i) {
            context[i * 2] = hex[identity.device_id[i] >> 4];
            context[i * 2 + 1] = hex[identity.device_id[i] & 15u];
        }
        snprintf(context + 32, 32, ":%lu", (unsigned long) identity.ownership_epoch);
    }
    memset(&identity, 0, sizeof(identity));
}

static esp_err_t device_status_handler(httpd_req_t *request) {
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    if (!local_request_host_allowed(request)) {
        return device_api_error(
            request, "403 Forbidden", "forbidden_origin");
    }

    uint32_t wifi_generation;
    wifi_operation_state_t wifi_state;
    wifi_operation_phase_t wifi_phase;
    const char *wifi_error;
    portENTER_CRITICAL(&wifi_scan_lock);
    wifi_generation = wifi_operation_generation;
    wifi_state = wifi_operation_state;
    wifi_phase = wifi_operation_phase;
    wifi_error = wifi_operation_error_code;
    portEXIT_CRITICAL(&wifi_scan_lock);

    jk_bms_ble_operation_snapshot_t bms_operation;
    if (!jk_bms_ble_operation_snapshot(&bms_operation)) {
        return device_api_error(
            request,
            "503 Service Unavailable",
            "subsystem_unavailable");
    }

    jk_bms_device_info_t dev_info = {0};
    jk_bms_ble_get_device_info(&dev_info);

    int8_t wifi_rssi = 0;
    char wifi_rssi_json[16] = "null";
    if (wifi_current_rssi(&wifi_rssi)) {
        snprintf(
            wifi_rssi_json,
            sizeof(wifi_rssi_json),
            "%d",
            (int) wifi_rssi);
    }

    char sta_ip[16] = {0};
    netif_ipv4_string(wifi_netif, sta_ip, sizeof(sta_ip));

    char ssid_json[(WATTPOST_WIFI_SSID_MAX_LEN + 1u) * 6u];
    char ip_json[sizeof(sta_ip) * 6u];
    char bms_name_json[sizeof(dev_info.device_name) * 6u];
    char bms_model_json[sizeof(dev_info.model) * 6u];
    char bms_hint_json[sizeof(bms_address_hint) * 6u];
    char restart_json[96];
    if (!wattpost_json_escape(
            ssid_json,
            sizeof(ssid_json),
            device_wifi_configured ? wifi_ssid_display : "") ||
        !wattpost_json_escape(
            ip_json,
            sizeof(ip_json),
            sta_ip) ||
        !wattpost_json_escape(
            bms_name_json,
            sizeof(bms_name_json),
            dev_info.valid ? dev_info.device_name : "") ||
        !wattpost_json_escape(
            bms_model_json,
            sizeof(bms_model_json),
            dev_info.valid ? dev_info.model : "") ||
        !wattpost_json_escape(
            bms_hint_json,
            sizeof(bms_hint_json),
            device_bms_configured ? bms_address_hint : "") ||
        !wattpost_json_escape(
            restart_json,
            sizeof(restart_json),
            last_restart_reason ? last_restart_reason : "unknown")) {
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }

    char wifi_error_json[64] = "null";
    if (wifi_error != NULL) {
        snprintf(
            wifi_error_json,
            sizeof(wifi_error_json),
            "\"%s\"",
            wifi_error);
    }

    const char *bms_error =
        bms_operation_error_str(bms_operation.error);
    char bms_error_json[64] = "null";
    if (bms_error != NULL) {
        snprintf(
            bms_error_json,
            sizeof(bms_error_json),
            "\"%s\"",
            bms_error);
    }

    const char *internet_state = internet_reachability_runtime_state();

    wattpost_cloud_transport_snapshot_t cloud = {0};
    if (!wattpost_cloud_transport_snapshot(&cloud)) {
        return device_api_error(
            request, "503 Service Unavailable", "subsystem_unavailable");
    }
    char cloud_pair_url_json[
        WATTPOST_CLOUD_PAIR_URL_MAX_LEN * 2u];
    if (!wattpost_json_escape(
            cloud_pair_url_json,
            sizeof(cloud_pair_url_json),
            cloud.pairing_url)) {
        memset(&cloud, 0, sizeof(cloud));
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }
    char cloud_pair_url_value[
        WATTPOST_CLOUD_PAIR_URL_MAX_LEN * 2u + 3u] = "null";
    if (cloud.pairing_url[0] != '\0') {
        const int pair_url_written = snprintf(
            cloud_pair_url_value,
            sizeof(cloud_pair_url_value),
            "\"%s\"",
            cloud_pair_url_json);
        if (pair_url_written <= 0 ||
            (size_t) pair_url_written >= sizeof(cloud_pair_url_value)) {
            memset(&cloud, 0, sizeof(cloud));
            memset(cloud_pair_url_json, 0, sizeof(cloud_pair_url_json));
            return device_api_error(
                request, "500 Internal Server Error", "internal_error");
        }
    }
    const char *cloud_action_error =
        wattpost_cloud_action_error_str(cloud.action_error);
    char cloud_action_error_json[64] = "null";
    if (cloud_action_error != NULL) {
        snprintf(
            cloud_action_error_json,
            sizeof(cloud_action_error_json),
            "\"%s\"",
            cloud_action_error);
    }

    char history_context[64];
    history_context_string(history_context);
    size_t used = 0u;
    if (!wattpost_json_appendf(
            http_json_response.device_status,
            sizeof(http_json_response.device_status),
            &used,
            "{\"ok\":true,\"data\":{"
            "\"api_version\":1,"
            "\"history_context\":\"%s\","
            "\"mode\":\"%s\","
            "\"setup_state\":\"%s\","
            "\"setup_completed_without_bms\":%s,"
            "\"wifi\":{"
            "\"configured\":%s,"
            "\"state\":\"%s\","
            "\"ssid\":\"%s\","
            "\"rssi_dbm\":%s,"
            "\"ip\":\"%s\","
            "\"internet_state\":\"%s\","
            "\"operation\":{"
            "\"generation\":%lu,"
            "\"state\":\"%s\","
            "\"phase\":\"%s\","
            "\"error_code\":%s}},"
            "\"bms\":{"
            "\"configured\":%s,"
            "\"state\":\"%s\","
            "\"name\":\"%s\","
            "\"model\":\"%s\","
            "\"address_hint\":\"%s\","
            "\"rssi_dbm\":null,"
            "\"operation\":{"
            "\"generation\":%lu,"
            "\"state\":\"%s\","
            "\"phase\":\"%s\","
            "\"error_code\":%s}},"
            "\"cloud\":{"
            "\"transport_state\":\"%s\","
            "\"network_available\":%s,"
            "\"registration_known\":%s,"
            "\"paired_known\":%s,"
            "\"paired\":%s,"
            "\"disconnect_pending\":%s,"
            "\"pairing\":{"
            "\"state\":\"%s\","
            "\"generation\":%lu,"
            "\"pair_url\":%s},"
            "\"operation\":{"
            "\"generation\":%lu,"
            "\"kind\":\"%s\","
            "\"state\":\"%s\","
            "\"error_code\":%s}},"
            "\"firmware\":{"
            "\"version\":\"%s\","
            "\"build_id\":\"%s\","
            "\"ota_state\":\"%s\","
            "\"rollback_configured\":%s,"
            "\"validation_pending\":%s},"
            "\"system\":{"
            "\"uptime_s\":%lu,"
            "\"last_restart_reason\":\"%s\"}}}",
            history_context,
            device_runtime_mode(),
            device_setup_state(),
            first_setup_bms_deferred ? "true" : "false",
            device_wifi_configured ? "true" : "false",
            wifi_runtime_state(),
            ssid_json,
            wifi_rssi_json,
            ip_json,
            internet_state,
            (unsigned long) wifi_generation,
            wifi_operation_state_str(wifi_state),
            wifi_operation_phase_str(wifi_phase),
            wifi_error_json,
            device_bms_configured ? "true" : "false",
            device_bms_runtime_state(),
            bms_name_json,
            bms_model_json,
            bms_hint_json,
            (unsigned long) bms_operation.generation,
            bms_operation_state_str(bms_operation.state),
            bms_operation_phase_str(bms_operation.phase),
            bms_error_json,
            wattpost_cloud_state_str(cloud.state),
            cloud.network_available ? "true" : "false",
            cloud.registration_known ? "true" : "false",
            cloud.paired_known ? "true" : "false",
            cloud.paired ? "true" : "false",
            cloud.disconnect_pending ? "true" : "false",
            wattpost_cloud_pairing_state_str(cloud.pairing_state),
            (unsigned long) cloud.pairing_generation,
            cloud_pair_url_value,
            (unsigned long) cloud.action_generation,
            wattpost_cloud_action_kind_str(cloud.action_kind),
            wattpost_cloud_action_state_str(cloud.action_state),
            cloud_action_error_json,
            WATTPOST_FIRMWARE_VERSION,
            WATTPOST_BUILD_ID,
            current_ota_state(),
            ota_rollback_configured_json(),
            ota_validation_pending ? "true" : "false",
            (unsigned long) esp_uptime_seconds(),
            restart_json)) {
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }

    httpd_resp_set_type(request, "application/json");
    const esp_err_t response_result =
        httpd_resp_sendstr(request, http_json_response.device_status);
    memset(http_json_response.device_status, 0, sizeof(http_json_response.device_status));
    memset(&cloud, 0, sizeof(cloud));
    memset(cloud_pair_url_json, 0, sizeof(cloud_pair_url_json));
    memset(cloud_pair_url_value, 0, sizeof(cloud_pair_url_value));
    memset(cloud_action_error_json, 0, sizeof(cloud_action_error_json));
    return response_result;
}

typedef struct {
    uint32_t scan_generation;
    uint16_t candidate_id;
} bms_select_request_t;

static bool parse_bms_select_request(
    const char *body,
    size_t body_length,
    bms_select_request_t *parsed) {
    if (!body || !parsed) {
        return false;
    }
    memset(parsed, 0, sizeof(*parsed));

    cJSON *root = cJSON_ParseWithLengthOpts(
        body, body_length + 1u, NULL, true);
    if (!root || !cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return false;
    }

    unsigned scan_generation_count = 0u;
    unsigned candidate_id_count = 0u;
    bool unknown_field = false;

    for (cJSON *item = root->child; item != NULL; item = item->next) {
        if (!item->string) {
            unknown_field = true;
            continue;
        }
        if (strcmp(item->string, "scan_generation") == 0) {
            ++scan_generation_count;
        } else if (strcmp(item->string, "candidate_id") == 0) {
            ++candidate_id_count;
        } else {
            unknown_field = true;
        }
    }

    uint32_t generation = 0;
    uint32_t candidate = 0;
    const bool valid =
        !unknown_field &&
        scan_generation_count == 1u &&
        candidate_id_count == 1u &&
        json_integer_in_range(
            cJSON_GetObjectItemCaseSensitive(root, "scan_generation"),
            1u,
            UINT32_MAX,
            &generation) &&
        json_integer_in_range(
            cJSON_GetObjectItemCaseSensitive(root, "candidate_id"),
            1u,
            UINT16_MAX,
            &candidate);

    cJSON_Delete(root);
    if (!valid) {
        return false;
    }

    parsed->scan_generation = generation;
    parsed->candidate_id = (uint16_t) candidate;
    return true;
}


static bool parse_empty_json_object(
    const char *body,
    size_t body_length) {
    if (!body || body_length == 0u) {
        return true;
    }

    cJSON *root = cJSON_ParseWithLengthOpts(
        body, body_length + 1u, NULL, true);
    const bool valid =
        root != NULL &&
        cJSON_IsObject(root) &&
        root->child == NULL;
    cJSON_Delete(root);
    return valid;
}

static bool parse_automatic_updates_request(
    const char *body,
    size_t body_length,
    bool *enabled_out) {
    if (!body || body_length == 0u || enabled_out == NULL) {
        return false;
    }

    cJSON *root = cJSON_ParseWithLengthOpts(
        body, body_length + 1u, NULL, true);
    if (!root || !cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return false;
    }

    unsigned field_count = 0u;
    bool unknown_field = false;
    for (cJSON *item = root->child; item != NULL; item = item->next) {
        if (item->string != NULL && strcmp(item->string, "automatic_updates") == 0) {
            ++field_count;
        } else {
            unknown_field = true;
        }
    }
    const cJSON *automatic =
        cJSON_GetObjectItemCaseSensitive(root, "automatic_updates");
    const bool valid =
        !unknown_field && field_count == 1u && cJSON_IsBool(automatic);
    if (valid) {
        *enabled_out = cJSON_IsTrue(automatic);
    }
    cJSON_Delete(root);
    return valid;
}


static bool parse_confirmation_request(
    const char *body,
    size_t body_length,
    const char *expected_confirmation) {
    if (!body || body_length == 0u || !expected_confirmation) {
        return false;
    }

    cJSON *root = cJSON_ParseWithLengthOpts(
        body, body_length + 1u, NULL, true);
    if (!root || !cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return false;
    }

    unsigned confirm_count = 0u;
    bool unknown_field = false;
    for (cJSON *item = root->child; item != NULL; item = item->next) {
        if (!item->string) {
            unknown_field = true;
            continue;
        }
        if (strcmp(item->string, "confirm") == 0) {
            ++confirm_count;
        } else {
            unknown_field = true;
        }
    }

    const cJSON *confirm =
        cJSON_GetObjectItemCaseSensitive(root, "confirm");
    const bool valid =
        !unknown_field &&
        confirm_count == 1u &&
        cJSON_IsString(confirm) &&
        confirm->valuestring != NULL &&
        strcmp(confirm->valuestring, expected_confirmation) == 0;

    cJSON_Delete(root);
    return valid;
}



static esp_err_t cloud_pair_start_handler(httpd_req_t *request) {
    if (!local_mutation_request_allowed(request)) {
        return ESP_OK;
    }
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");

    if ((size_t) request->content_len > 64u) {
        return device_api_error(
            request, "413 Payload Too Large", "content_too_large");
    }

    char body[65] = {0};
    size_t received_total = 0u;
    while (received_total < (size_t) request->content_len) {
        const int received = httpd_req_recv(
            request,
            body + received_total,
            (size_t) request->content_len - received_total);
        if (received <= 0) {
            memset(body, 0, sizeof(body));
            return device_api_error(
                request, "400 Bad Request", "invalid_request");
        }
        received_total += (size_t) received;
    }
    body[received_total] = '\0';

    const bool valid_body =
        parse_empty_json_object(body, received_total);
    memset(body, 0, sizeof(body));
    if (!valid_body) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }

    uint32_t generation = 0u;
    const wattpost_cloud_action_start_result_t result =
        wattpost_cloud_transport_pairing_start(&generation);
    if (result == WATTPOST_CLOUD_ACTION_START_BUSY) {
        return device_api_error(request, "409 Conflict", "busy");
    }
    if (result == WATTPOST_CLOUD_ACTION_START_ALREADY_PAIRED) {
        return device_api_error(
            request, "409 Conflict", "already_paired");
    }
    if (result != WATTPOST_CLOUD_ACTION_START_OK) {
        return device_api_error(
            request,
            "503 Service Unavailable",
            "cloud_unavailable");
    }

    char response[192];
    const int written = snprintf(
        response,
        sizeof(response),
        "{\"ok\":true,\"operation\":{"
        "\"generation\":%lu,\"state\":\"running\","
        "\"phase\":\"pairing\",\"error_code\":null}}",
        (unsigned long) generation);
    if (written <= 0 || (size_t) written >= sizeof(response)) {
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }

    httpd_resp_set_status(request, "202 Accepted");
    httpd_resp_set_type(request, "application/json");
    return httpd_resp_sendstr(request, response);
}

static esp_err_t firmware_update_status_handler(httpd_req_t *request) {
    wattpost_cloud_transport_snapshot_t snapshot;
    if (!wattpost_cloud_transport_snapshot(&snapshot)) {
        return device_api_error(
            request, "503 Service Unavailable", "cloud_unavailable");
    }

    char *response = http_json_response.live;
    const size_t capacity = sizeof(http_json_response.live);
    response[0] = '\0';
    size_t used = 0u;
    const bool has_target =
        snapshot.ota_target_version[0] != '\0' &&
        snapshot.ota_target_build_id[0] != '\0';
    const bool has_state = snapshot.ota_state != WATTPOST_CLOUD_OTA_IDLE;
    bool ok = wattpost_json_appendf(
        response,
        capacity,
        &used,
        "{\"ok\":true,\"data\":{"
        "\"automatic_updates_supported\":true,"
        "\"automatic_updates\":%s,"
        "\"current_version\":\"%s\","
        "\"current_build_id\":\"%s\","
        "\"device_online\":%s,"
        "\"update_available\":%s,"
        "\"latest_release\":",
        wattpost_remote_ota_automatic_updates_get() ? "true" : "false",
        WATTPOST_FIRMWARE_VERSION,
        WATTPOST_BUILD_ID,
        snapshot.state == WATTPOST_CLOUD_STATE_ONLINE ? "true" : "false",
        snapshot.ota_update_available ? "true" : "false");
    if (ok && has_target) {
        ok = wattpost_json_appendf(
            response,
            capacity,
            &used,
            "{\"release_id\":%lu,\"version\":\"%s\","
            "\"build_id\":\"%s\",\"changelog\":\"\"}",
            (unsigned long) snapshot.ota_release_id,
            snapshot.ota_target_version,
            snapshot.ota_target_build_id);
    } else if (ok) {
        ok = wattpost_json_appendf(response, capacity, &used, "null");
    }
    if (ok) {
        ok = wattpost_json_appendf(response, capacity, &used, ",\"state\":");
    }
    if (ok && has_state) {
        ok = wattpost_json_appendf(
            response,
            capacity,
            &used,
            "{\"release_id\":%lu,\"state\":\"%s\","
            "\"version\":\"%s\",\"build_id\":\"%s\",\"error\":",
            (unsigned long) snapshot.ota_release_id,
            wattpost_cloud_ota_state_str(snapshot.ota_state),
            snapshot.ota_target_version,
            snapshot.ota_target_build_id);
        if (ok && snapshot.ota_error[0] != '\0') {
            ok = wattpost_json_appendf(
                response,
                capacity,
                &used,
                "\"%s\"",
                snapshot.ota_error);
        } else if (ok) {
            ok = wattpost_json_appendf(response, capacity, &used, "null");
        }
        if (ok && snapshot.ota_state == WATTPOST_CLOUD_OTA_DOWNLOADING &&
            snapshot.ota_progress_attempt > 0u && snapshot.ota_progress_total > 0u) {
            ok = wattpost_json_appendf(
                response, capacity, &used,
                ",\"downloaded_bytes\":%lu,\"total_bytes\":%lu,"
                "\"download_attempt\":%lu",
                (unsigned long) snapshot.ota_progress_bytes,
                (unsigned long) snapshot.ota_progress_total,
                (unsigned long) snapshot.ota_progress_attempt);
        }
        if (ok) {
            ok = wattpost_json_appendf(response, capacity, &used, "}");
        }
    } else if (ok) {
        ok = wattpost_json_appendf(response, capacity, &used, "null");
    }
    if (ok) {
        ok = wattpost_json_appendf(response, capacity, &used, "}}");
    }

    memset(&snapshot, 0, sizeof(snapshot));
    if (!ok) {
        memset(response, 0, capacity);
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }
    httpd_resp_set_type(request, "application/json");
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    const esp_err_t result = httpd_resp_sendstr(request, response);
    memset(response, 0, capacity);
    return result;
}

static esp_err_t firmware_update_preferences_handler(httpd_req_t *request) {
    if (!local_mutation_request_allowed(request)) {
        return ESP_OK;
    }
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    if (request->content_len <= 0) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }
    if ((size_t) request->content_len > 64u) {
        return device_api_error(
            request, "413 Payload Too Large", "content_too_large");
    }

    char body[65] = {0};
    size_t received_total = 0u;
    while (received_total < (size_t) request->content_len) {
        const int received = httpd_req_recv(
            request,
            body + received_total,
            (size_t) request->content_len - received_total);
        if (received <= 0) {
            memset(body, 0, sizeof(body));
            return device_api_error(
                request, "400 Bad Request", "invalid_request");
        }
        received_total += (size_t) received;
    }
    body[received_total] = '\0';

    bool enabled = true;
    const bool valid = parse_automatic_updates_request(
        body, received_total, &enabled);
    memset(body, 0, sizeof(body));
    if (!valid) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }
    if (!wattpost_remote_ota_automatic_updates_set(enabled)) {
        return device_api_error(
            request, "500 Internal Server Error", "storage_error");
    }
    const bool confirmed = wattpost_remote_ota_automatic_updates_get();
    wattpost_cloud_transport_ota_preference_changed(confirmed);

    char response[96];
    const int written = snprintf(
        response,
        sizeof(response),
        "{\"ok\":true,\"data\":{\"automatic_updates\":%s}}",
        confirmed ? "true" : "false");
    if (written <= 0 || (size_t) written >= sizeof(response)) {
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }
    httpd_resp_set_type(request, "application/json");
    return httpd_resp_sendstr(request, response);
}


static esp_err_t firmware_update_install_handler(httpd_req_t *request) {
    if (!local_mutation_request_allowed(request)) {
        return ESP_OK;
    }
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    if ((size_t) request->content_len > 64u) {
        return device_api_error(
            request, "413 Payload Too Large", "content_too_large");
    }
    char body[65] = {0};
    size_t received_total = 0u;
    while (received_total < (size_t) request->content_len) {
        const int received = httpd_req_recv(
            request,
            body + received_total,
            (size_t) request->content_len - received_total);
        if (received <= 0) {
            memset(body, 0, sizeof(body));
            return device_api_error(
                request, "400 Bad Request", "invalid_request");
        }
        received_total += (size_t) received;
    }
    body[received_total] = '\0';
    const bool valid = parse_empty_json_object(body, received_total);
    memset(body, 0, sizeof(body));
    if (!valid) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }

    const wattpost_cloud_action_start_result_t result =
        wattpost_cloud_transport_ota_install_start();
    if (result == WATTPOST_CLOUD_ACTION_START_BUSY) {
        return device_api_error(request, "409 Conflict", "busy");
    }
    if (result == WATTPOST_CLOUD_ACTION_START_NOT_PAIRED) {
        return device_api_error(request, "409 Conflict", "not_paired");
    }
    if (result != WATTPOST_CLOUD_ACTION_START_OK) {
        return device_api_error(
            request, "503 Service Unavailable", "cloud_unavailable");
    }
    httpd_resp_set_status(request, "202 Accepted");
    httpd_resp_set_type(request, "application/json");
    return httpd_resp_sendstr(
        request,
        "{\"ok\":true,\"data\":{\"state\":\"requested\"}}");
}

static esp_err_t cloud_disconnect_handler(httpd_req_t *request) {
    if (!local_mutation_request_allowed(request)) {
        return ESP_OK;
    }
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");

    if (request->content_len <= 0) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }
    if ((size_t) request->content_len > 128u) {
        return device_api_error(
            request, "413 Payload Too Large", "content_too_large");
    }

    char body[129] = {0};
    size_t received_total = 0u;
    while (received_total < (size_t) request->content_len) {
        const int received = httpd_req_recv(
            request,
            body + received_total,
            (size_t) request->content_len - received_total);
        if (received <= 0) {
            memset(body, 0, sizeof(body));
            return device_api_error(
                request, "400 Bad Request", "invalid_request");
        }
        received_total += (size_t) received;
    }
    body[received_total] = '\0';

    const bool confirmed = parse_confirmation_request(
        body, received_total, "disconnect_cloud");
    memset(body, 0, sizeof(body));
    if (!confirmed) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }

    uint32_t generation = 0u;
    const wattpost_cloud_action_start_result_t result =
        wattpost_cloud_transport_disconnect_start(&generation);
    if (result == WATTPOST_CLOUD_ACTION_START_BUSY) {
        return device_api_error(request, "409 Conflict", "busy");
    }
    if (result == WATTPOST_CLOUD_ACTION_START_NOT_PAIRED) {
        return device_api_error(
            request, "409 Conflict", "not_paired");
    }
    if (result == WATTPOST_CLOUD_ACTION_START_STORAGE_ERROR) {
        return device_api_error(
            request,
            "500 Internal Server Error",
            "storage_error");
    }
    if (result != WATTPOST_CLOUD_ACTION_START_OK) {
        return device_api_error(
            request,
            "503 Service Unavailable",
            "cloud_unavailable");
    }

    char response[208];
    const int written = snprintf(
        response,
        sizeof(response),
        "{\"ok\":true,\"operation\":{"
        "\"generation\":%lu,\"state\":\"running\","
        "\"phase\":\"disconnecting\",\"error_code\":null}}",
        (unsigned long) generation);
    if (written <= 0 || (size_t) written >= sizeof(response)) {
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }

    httpd_resp_set_status(request, "202 Accepted");
    httpd_resp_set_type(request, "application/json");
    return httpd_resp_sendstr(request, response);
}

static bool device_operation_busy_for_factory_reset(void) {
    bool wifi_busy;
    portENTER_CRITICAL(&wifi_scan_lock);
    wifi_busy = wifi_operation_busy_locked();
    portEXIT_CRITICAL(&wifi_scan_lock);
    if (wifi_busy) {
        return true;
    }

    jk_bms_ble_operation_snapshot_t bms_operation;
    return jk_bms_ble_operation_snapshot(&bms_operation) &&
           bms_operation.state == JK_BMS_BLE_OPERATION_RUNNING;
}

static bool system_action_reserve(
    system_action_t action,
    uint32_t *operation_generation) {
    bool reserved = false;
    portENTER_CRITICAL(&system_action_lock);
    if (action != SYSTEM_ACTION_NONE &&
        operation_generation != NULL &&
        system_action_pending == SYSTEM_ACTION_NONE &&
        !scheduled_restart_pending &&
        !restart_pending) {
        ++system_action_generation;
        if (system_action_generation == 0u) {
            ++system_action_generation;
        }
        system_action_pending = action;
        *operation_generation = system_action_generation;
        reserved = true;
    }
    portEXIT_CRITICAL(&system_action_lock);
    return reserved;
}

static void system_action_release(void) {
    portENTER_CRITICAL(&system_action_lock);
    if (!scheduled_restart_pending && !restart_pending) {
        system_action_pending = SYSTEM_ACTION_NONE;
    }
    portEXIT_CRITICAL(&system_action_lock);
}

static void schedule_deferred_restart(void) {
    portENTER_CRITICAL(&system_action_lock);
    scheduled_restart_pending = true;
    portEXIT_CRITICAL(&system_action_lock);
    if (recovery_task_handle != NULL) {
        xTaskNotifyGive(recovery_task_handle);
    }
}

static bool erase_nvs_namespace(const char *namespace_name) {
    nvs_handle_t handle;
    esp_err_t err = nvs_open(namespace_name, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Factory Reset: NVS namespace %s unavailable: %s",
                 namespace_name, esp_err_to_name(err));
        return false;
    }

    err = nvs_erase_all(handle);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Factory Reset: failed to erase %s: %s",
                 namespace_name, esp_err_to_name(err));
        return false;
    }
    return true;
}

static bool perform_full_factory_reset(void) {
    /*
     * Cloud ownership must be invalidated before any destructive local reset.
     * If the critical identity write fails, preserve all local user data and
     * report reset failure instead of claiming a transferable clean state.
     */
    wattpost_device_identity_t reset_identity;
    if (!wattpost_device_identity_advance_ownership_epoch(&reset_identity)) {
        memset(&reset_identity, 0, sizeof(reset_identity));
        ESP_LOGE(TAG, "Factory Reset: ownership generation update failed; reset aborted");
        return false;
    }
    memset(&reset_identity, 0, sizeof(reset_identity));

    if (history_task_handle != NULL) {
        vTaskSuspend(history_task_handle);
    }

    bool success = true;
    if (!temperature_config_reset()) {
        ESP_LOGE(TAG, "Factory Reset: temperature state reset failed");
        success = false;
    }
    if (!wattpost_device_config_erase_store()) {
        ESP_LOGE(TAG, "Factory Reset: device config erase failed");
        success = false;
    }
    if (!erase_nvs_namespace("wattpost")) {
        success = false;
    }
    if (!wattpost_history_erase()) {
        success = false;
    }
    if (!erase_nvs_namespace("diagnostics")) {
        success = false;
    }
    if (!erase_nvs_namespace("remote_ota")) {
        success = false;
    }
    const esp_err_t coredump_err = esp_core_dump_image_erase();
    if (coredump_err != ESP_OK) {
        ESP_LOGE(TAG, "Factory Reset: coredump erase failed: %s",
                 esp_err_to_name(coredump_err));
        success = false;
    }

    if (!success && history_task_handle != NULL) {
        vTaskResume(history_task_handle);
    }
    return success;
}

static bool consume_deferred_restart(void) {
    bool pending = false;
    portENTER_CRITICAL(&system_action_lock);
    if (scheduled_restart_pending) {
        scheduled_restart_pending = false;
        restart_pending = true;
        pending = true;
    }
    portEXIT_CRITICAL(&system_action_lock);
    return pending;
}

/* Finishing First Setup without BMS is an explicit user action. No NVS,
 * BMS target, History or Cloud identity is modified by this operation. */
static esp_err_t setup_finish_without_bms_handler(httpd_req_t *request) {
    if (!local_mutation_request_allowed(request)) {
        return ESP_OK;
    }
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");

    if (request->content_len != 2) {
        return device_api_error(request, "400 Bad Request", "invalid_request");
    }
    char body[2];
    size_t received = 0;
    while (received < sizeof(body)) {
        const int count = httpd_req_recv(
            request, body + received, sizeof(body) - received);
        if (count <= 0) {
            return device_api_error(request, "400 Bad Request", "invalid_request");
        }
        received += (size_t) count;
    }
    if (body[0] != '{' || body[1] != '}') {
        return device_api_error(request, "400 Bad Request", "invalid_request");
    }

    if (!first_setup_ap_active || recovery_ap_active ||
        !device_wifi_configured || !wifi_has_ip ||
        !wifi_station_ip_ready() ||
        wifi_validation_active_snapshot() ||
        wifi_rollback_pending_snapshot() ||
        first_setup_wifi_retry_required) {
        return device_api_error(request, "409 Conflict", "not_ready");
    }

    first_setup_bms_deferred = true;
    httpd_resp_set_type(request, "application/json");
    return httpd_resp_sendstr(
        request, "{\"ok\":true,\"data\":{\"setup_completed_without_bms\":true}}");
}

static esp_err_t bms_scan_start_handler(httpd_req_t *request) {
    if (!local_mutation_request_allowed(request)) {
        return ESP_OK;
    }
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");

    uint32_t generation = 0;
    const jk_bms_ble_scan_start_result_t result =
        jk_bms_ble_scan_start(&generation);

    if (result == JK_BMS_BLE_SCAN_START_BUSY) {
        return device_api_error(request, "409 Conflict", "busy");
    }
    if (result != JK_BMS_BLE_SCAN_START_OK) {
        return device_api_error(
            request,
            "503 Service Unavailable",
            "subsystem_unavailable");
    }

    char response[192];
    const int written = snprintf(
        response,
        sizeof(response),
        "{\"ok\":true,\"operation\":{"
        "\"generation\":%lu,\"state\":\"running\","
        "\"phase\":\"scanning\",\"error_code\":null}}",
        (unsigned long) generation);
    if (written <= 0 || (size_t) written >= sizeof(response)) {
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }

    httpd_resp_set_status(request, "202 Accepted");
    httpd_resp_set_type(request, "application/json");
    return httpd_resp_sendstr(request, response);
}

static esp_err_t bms_scan_get_handler(httpd_req_t *request) {
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    if (!local_request_host_allowed(request)) {
        return device_api_error(
            request, "403 Forbidden", "forbidden_origin");
    }

    jk_bms_ble_scan_snapshot_t snapshot;
    if (!jk_bms_ble_scan_snapshot(&snapshot)) {
        return device_api_error(
            request,
            "503 Service Unavailable",
            "subsystem_unavailable");
    }

    const char *operation_error =
        bms_operation_error_str(snapshot.operation.error);
    char error_json[64] = "null";
    if (operation_error != NULL) {
        snprintf(
            error_json,
            sizeof(error_json),
            "\"%s\"",
            operation_error);
    }

    size_t used = 0;
    if (!wattpost_json_appendf(
            http_json_response.bms_scan,
            sizeof(http_json_response.bms_scan),
            &used,
            "{\"ok\":true,\"data\":{"
            "\"scan_generation\":%lu,"
            "\"operation\":{"
            "\"generation\":%lu,"
            "\"state\":\"%s\","
            "\"phase\":\"%s\","
            "\"error_code\":%s},"
            "\"candidates\":[",
            (unsigned long) snapshot.generation,
            (unsigned long) snapshot.operation.generation,
            bms_operation_state_str(snapshot.operation.state),
            bms_operation_phase_str(snapshot.operation.phase),
            error_json)) {
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }

    for (size_t i = 0; i < snapshot.candidate_count; ++i) {
        char name_json[
            sizeof(snapshot.candidates[i].name) * 6u];
        char hint_json[
            sizeof(snapshot.candidates[i].address_hint) * 6u];

        if (!wattpost_json_escape(
                name_json,
                sizeof(name_json),
                snapshot.candidates[i].name) ||
            !wattpost_json_escape(
                hint_json,
                sizeof(hint_json),
                snapshot.candidates[i].address_hint)) {
            return device_api_error(
                request, "500 Internal Server Error", "internal_error");
        }

        if (!wattpost_json_appendf(
                http_json_response.bms_scan,
                sizeof(http_json_response.bms_scan),
                &used,
                "%s{\"candidate_id\":%u,"
                "\"name\":\"%s\","
                "\"rssi_dbm\":%d,"
                "\"address_hint\":\"%s\"}",
                i == 0u ? "" : ",",
                (unsigned int) snapshot.candidates[i].candidate_id,
                name_json,
                (int) snapshot.candidates[i].rssi_dbm,
                hint_json)) {
            return device_api_error(
                request, "500 Internal Server Error", "internal_error");
        }
    }

    if (!wattpost_json_appendf(
            http_json_response.bms_scan,
            sizeof(http_json_response.bms_scan),
            &used,
            "]}}")) {
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }

    httpd_resp_set_type(request, "application/json");
    return httpd_resp_sendstr(request, http_json_response.bms_scan);
}


static esp_err_t bms_select_start_handler(httpd_req_t *request) {
    if (!local_mutation_request_allowed(request)) {
        return ESP_OK;
    }
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");

    if (request->content_len <= 0) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }
    if ((size_t) request->content_len > 192u) {
        return device_api_error(
            request, "413 Payload Too Large", "content_too_large");
    }

    char body[193];
    memset(body, 0, sizeof(body));
    size_t received_total = 0u;
    while (received_total < (size_t) request->content_len) {
        const int received = httpd_req_recv(
            request,
            body + received_total,
            (size_t) request->content_len - received_total);
        if (received <= 0) {
            memset(body, 0, sizeof(body));
            return device_api_error(
                request, "400 Bad Request", "invalid_request");
        }
        received_total += (size_t) received;
    }
    body[received_total] = '\0';

    bms_select_request_t parsed;
    const bool valid = parse_bms_select_request(
        body, received_total, &parsed);
    memset(body, 0, sizeof(body));
    if (!valid) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }

    uint32_t operation_generation = 0u;
    const jk_bms_ble_select_start_result_t result =
        jk_bms_ble_select_start(
            parsed.scan_generation,
            parsed.candidate_id,
            &operation_generation);
    memset(&parsed, 0, sizeof(parsed));

    if (result == JK_BMS_BLE_SELECT_START_BUSY) {
        return device_api_error(request, "409 Conflict", "busy");
    }
    if (result == JK_BMS_BLE_SELECT_START_STALE_SCAN) {
        return device_api_error(
            request, "409 Conflict", "stale_scan");
    }
    if (result == JK_BMS_BLE_SELECT_START_NOT_FOUND) {
        return device_api_error(
            request, "404 Not Found", "candidate_not_found");
    }
    if (result != JK_BMS_BLE_SELECT_START_OK) {
        return device_api_error(
            request,
            "503 Service Unavailable",
            "subsystem_unavailable");
    }

    char response[192];
    const int written = snprintf(
        response,
        sizeof(response),
        "{\"ok\":true,\"operation\":{"
        "\"generation\":%lu,\"state\":\"running\","
        "\"phase\":\"connecting\",\"error_code\":null}}",
        (unsigned long) operation_generation);
    if (written <= 0 || (size_t) written >= sizeof(response)) {
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }

    httpd_resp_set_status(request, "202 Accepted");
    httpd_resp_set_type(request, "application/json");
    return httpd_resp_sendstr(request, response);
}


static esp_err_t bms_reconnect_handler(httpd_req_t *request) {
    if (!local_mutation_request_allowed(request)) {
        return ESP_OK;
    }
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");

    if ((size_t) request->content_len > 64u) {
        return device_api_error(
            request, "413 Payload Too Large", "content_too_large");
    }

    char body[65];
    memset(body, 0, sizeof(body));
    size_t received_total = 0u;
    while (received_total < (size_t) request->content_len) {
        const int received = httpd_req_recv(
            request,
            body + received_total,
            (size_t) request->content_len - received_total);
        if (received <= 0) {
            memset(body, 0, sizeof(body));
            return device_api_error(
                request, "400 Bad Request", "invalid_request");
        }
        received_total += (size_t) received;
    }
    body[received_total] = '\0';

    const bool valid_body =
        parse_empty_json_object(body, received_total);
    memset(body, 0, sizeof(body));
    if (!valid_body) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }

    uint32_t operation_generation = 0u;
    const jk_bms_ble_reconnect_start_result_t result =
        jk_bms_ble_reconnect_start(&operation_generation);

    if (result == JK_BMS_BLE_RECONNECT_START_NOT_CONFIGURED) {
        return device_api_error(
            request, "409 Conflict", "not_configured");
    }
    if (result == JK_BMS_BLE_RECONNECT_START_BUSY) {
        return device_api_error(request, "409 Conflict", "busy");
    }
    if (result != JK_BMS_BLE_RECONNECT_START_OK) {
        return device_api_error(
            request,
            "503 Service Unavailable",
            "subsystem_unavailable");
    }

    char response[192];
    const int written = snprintf(
        response,
        sizeof(response),
        "{\"ok\":true,\"operation\":{"
        "\"generation\":%lu,\"state\":\"running\","
        "\"phase\":\"reconnecting\",\"error_code\":null}}",
        (unsigned long) operation_generation);
    if (written <= 0 || (size_t) written >= sizeof(response)) {
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }

    httpd_resp_set_status(request, "202 Accepted");
    httpd_resp_set_type(request, "application/json");
    return httpd_resp_sendstr(request, response);
}

static esp_err_t bms_forget_handler(httpd_req_t *request) {
    if (!local_mutation_request_allowed(request)) {
        return ESP_OK;
    }
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");

    if (request->content_len <= 0) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }
    if ((size_t) request->content_len > 128u) {
        return device_api_error(
            request, "413 Payload Too Large", "content_too_large");
    }

    char body[129];
    memset(body, 0, sizeof(body));
    size_t received_total = 0u;
    while (received_total < (size_t) request->content_len) {
        const int received = httpd_req_recv(
            request,
            body + received_total,
            (size_t) request->content_len - received_total);
        if (received <= 0) {
            memset(body, 0, sizeof(body));
            return device_api_error(
                request, "400 Bad Request", "invalid_request");
        }
        received_total += (size_t) received;
    }
    body[received_total] = '\0';

    const bool confirmed = parse_confirmation_request(
        body, received_total, "forget_bms");
    memset(body, 0, sizeof(body));
    if (!confirmed) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }

    uint32_t operation_generation = 0u;
    const jk_bms_ble_forget_start_result_t start_result =
        jk_bms_ble_forget_start(&operation_generation);
    if (start_result == JK_BMS_BLE_FORGET_START_NOT_CONFIGURED) {
        return device_api_error(
            request, "409 Conflict", "not_configured");
    }
    if (start_result == JK_BMS_BLE_FORGET_START_BUSY) {
        return device_api_error(request, "409 Conflict", "busy");
    }

    if (!temperature_config_reset() ||
        !wattpost_device_config_clear_bms_persisted()) {
        jk_bms_ble_forget_commit(operation_generation, false);
        return device_api_error(
            request, "500 Internal Server Error", "storage_error");
    }

    wattpost_device_config_t config_after;
    const wattpost_config_load_result_t load_result =
        wattpost_device_config_load(&config_after);
    device_config_status = load_result;
    device_bms_configured = false;
    bms_address_hint[0] = '\0';
    bms_boot_action = WATTPOST_BMS_BOOT_SELECTION_REQUIRED;
    memset(&config_after, 0, sizeof(config_after));

    if (!jk_bms_ble_forget_commit(
            operation_generation, true)) {
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }

    jk_bms_ble_operation_snapshot_t operation;
    if (!jk_bms_ble_operation_snapshot(&operation)) {
        return device_api_error(
            request,
            "503 Service Unavailable",
            "subsystem_unavailable");
    }

    const char *operation_error =
        bms_operation_error_str(operation.error);
    char error_json[64] = "null";
    if (operation_error != NULL) {
        snprintf(
            error_json,
            sizeof(error_json),
            "\"%s\"",
            operation_error);
    }

    char response[192];
    const int written = snprintf(
        response,
        sizeof(response),
        "{\"ok\":true,\"operation\":{"
        "\"generation\":%lu,\"state\":\"%s\","
        "\"phase\":\"%s\",\"error_code\":%s}}",
        (unsigned long) operation.generation,
        bms_operation_state_str(operation.state),
        bms_operation_phase_str(operation.phase),
        error_json);
    if (written <= 0 || (size_t) written >= sizeof(response)) {
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }

    httpd_resp_set_status(request, "202 Accepted");
    httpd_resp_set_type(request, "application/json");
    return httpd_resp_sendstr(request, response);
}

static esp_err_t wifi_reconnect_handler(httpd_req_t *request) {
    if (!local_mutation_request_allowed(request)) {
        return ESP_OK;
    }
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");

    if (!device_wifi_configured ||
        wifi_boot_action != WATTPOST_WIFI_BOOT_CONNECT_SAVED) {
        return device_api_error(
            request, "409 Conflict", "not_configured");
    }
    if (!wifi_driver_started) {
        return device_api_error(
            request,
            "503 Service Unavailable",
            "subsystem_unavailable");
    }
    if ((size_t) request->content_len > 64u) {
        return device_api_error(
            request, "413 Payload Too Large", "content_too_large");
    }

    char body[65] = {0};
    size_t received_total = 0u;
    while (received_total < (size_t) request->content_len) {
        const int received = httpd_req_recv(
            request,
            body + received_total,
            (size_t) request->content_len - received_total);
        if (received <= 0) {
            memset(body, 0, sizeof(body));
            return device_api_error(
                request, "400 Bad Request", "invalid_request");
        }
        received_total += (size_t) received;
    }
    body[received_total] = '\0';

    const bool request_valid =
        parse_empty_json_object(body, received_total);
    memset(body, 0, sizeof(body));
    if (!request_valid) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }

    uint32_t operation_generation = 0u;
    bool busy = false;
    portENTER_CRITICAL(&wifi_scan_lock);
    if (wifi_operation_busy_locked()) {
        busy = true;
    } else {
        ++wifi_operation_generation;
        operation_generation = wifi_operation_generation;
        wifi_reconnect_operation.active = true;
        wifi_reconnect_operation.recovery_flow = recovery_ap_active;
        wifi_reconnect_operation.start_pending = true;
        wifi_reconnect_operation.started_us = 0;
        wifi_operation_state = WIFI_OPERATION_RUNNING;
        wifi_operation_phase = WIFI_OPERATION_PHASE_RECONNECTING;
        wifi_operation_error_code = NULL;
    }
    portEXIT_CRITICAL(&wifi_scan_lock);

    if (busy) {
        return device_api_error(request, "409 Conflict", "busy");
    }

    char response[192];
    const int written = snprintf(
        response,
        sizeof(response),
        "{\"ok\":true,\"operation\":{"
        "\"generation\":%lu,\"state\":\"running\","
        "\"phase\":\"reconnecting\",\"error_code\":null}}",
        (unsigned long) operation_generation);
    if (written <= 0 || (size_t) written >= sizeof(response)) {
        wifi_reconnect_finish(
            WIFI_OPERATION_ERROR,
            "internal_error");
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }

    httpd_resp_set_status(request, "202 Accepted");
    httpd_resp_set_type(request, "application/json");
    const esp_err_t response_result =
        httpd_resp_sendstr(request, response);
    if (recovery_task_handle != NULL) {
        xTaskNotifyGive(recovery_task_handle);
    }
    return response_result;
}

static esp_err_t wifi_reset_handler(httpd_req_t *request) {
    if (!local_mutation_request_allowed(request)) {
        return ESP_OK;
    }
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");

    if (!device_wifi_configured) {
        return device_api_error(
            request, "409 Conflict", "not_configured");
    }
    if (request->content_len <= 0) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }
    if ((size_t) request->content_len > 128u) {
        return device_api_error(
            request, "413 Payload Too Large", "content_too_large");
    }

    char body[129] = {0};
    size_t received_total = 0u;
    while (received_total < (size_t) request->content_len) {
        const int received = httpd_req_recv(
            request,
            body + received_total,
            (size_t) request->content_len - received_total);
        if (received <= 0) {
            memset(body, 0, sizeof(body));
            return device_api_error(
                request, "400 Bad Request", "invalid_request");
        }
        received_total += (size_t) received;
    }
    body[received_total] = '\0';

    const bool confirmed = parse_confirmation_request(
        body, received_total, "reset_wifi");
    memset(body, 0, sizeof(body));
    if (!confirmed) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }

    uint32_t operation_generation = 0u;
    bool busy = false;
    portENTER_CRITICAL(&wifi_scan_lock);
    if (wifi_operation_busy_locked()) {
        busy = true;
    } else {
        ++wifi_operation_generation;
        operation_generation = wifi_operation_generation;
        wifi_operation_state = WIFI_OPERATION_RUNNING;
        wifi_operation_phase = WIFI_OPERATION_PHASE_RESETTING;
        wifi_operation_error_code = NULL;
    }
    portEXIT_CRITICAL(&wifi_scan_lock);

    if (busy) {
        return device_api_error(request, "409 Conflict", "busy");
    }

    if (!wattpost_device_config_clear_wifi_persisted()) {
        portENTER_CRITICAL(&wifi_scan_lock);
        wifi_operation_state = WIFI_OPERATION_ERROR;
        wifi_operation_phase = WIFI_OPERATION_PHASE_NONE;
        wifi_operation_error_code = "storage_error";
        portEXIT_CRITICAL(&wifi_scan_lock);
        return device_api_error(
            request, "500 Internal Server Error", "storage_error");
    }

    device_config_status = WATTPOST_CONFIG_LOAD_OK;
    device_wifi_configured = false;
    wifi_ssid_display[0] = '\0';
    wifi_boot_action = WATTPOST_WIFI_BOOT_PROVISIONING_REQUIRED;

    char response[192];
    const int written = snprintf(
        response,
        sizeof(response),
        "{\"ok\":true,\"operation\":{"
        "\"generation\":%lu,\"state\":\"running\","
        "\"phase\":\"resetting\",\"error_code\":null}}",
        (unsigned long) operation_generation);
    if (written <= 0 || (size_t) written >= sizeof(response)) {
        const esp_err_t response_result = device_api_error(
            request, "500 Internal Server Error", "internal_error");
        schedule_deferred_restart();
        return response_result;
    }

    httpd_resp_set_status(request, "202 Accepted");
    httpd_resp_set_type(request, "application/json");
    const esp_err_t response_result =
        httpd_resp_sendstr(request, response);
    schedule_deferred_restart();
    return response_result;
}


static esp_err_t system_reboot_handler(httpd_req_t *request) {
    if (!local_mutation_request_allowed(request)) {
        return ESP_OK;
    }
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");

    if (request->content_len <= 0) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }
    if ((size_t) request->content_len > 128u) {
        return device_api_error(
            request, "413 Payload Too Large", "content_too_large");
    }

    char body[129] = {0};
    size_t received_total = 0u;
    while (received_total < (size_t) request->content_len) {
        const int received = httpd_req_recv(
            request,
            body + received_total,
            (size_t) request->content_len - received_total);
        if (received <= 0) {
            memset(body, 0, sizeof(body));
            return device_api_error(
                request, "400 Bad Request", "invalid_request");
        }
        received_total += (size_t) received;
    }
    body[received_total] = '\0';

    const bool confirmed = parse_confirmation_request(
        body, received_total, "reboot");
    memset(body, 0, sizeof(body));
    if (!confirmed) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }

    uint32_t operation_generation = 0u;
    if (!system_action_reserve(
            SYSTEM_ACTION_REBOOT,
            &operation_generation)) {
        return device_api_error(request, "409 Conflict", "busy");
    }

    char response[192];
    const int written = snprintf(
        response,
        sizeof(response),
        "{\"ok\":true,\"operation\":{"
        "\"generation\":%lu,\"state\":\"running\","
        "\"phase\":\"restarting\",\"error_code\":null}}",
        (unsigned long) operation_generation);
    if (written <= 0 || (size_t) written >= sizeof(response)) {
        system_action_release();
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }

    httpd_resp_set_status(request, "202 Accepted");
    httpd_resp_set_type(request, "application/json");
    const esp_err_t response_result =
        httpd_resp_sendstr(request, response);
    schedule_deferred_restart();
    return response_result;
}

static esp_err_t system_factory_reset_handler(httpd_req_t *request) {
    if (!local_mutation_request_allowed(request)) {
        return ESP_OK;
    }
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");

    if (request->content_len <= 0) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }
    if ((size_t) request->content_len > 128u) {
        return device_api_error(
            request, "413 Payload Too Large", "content_too_large");
    }

    char body[129] = {0};
    size_t received_total = 0u;
    while (received_total < (size_t) request->content_len) {
        const int received = httpd_req_recv(
            request,
            body + received_total,
            (size_t) request->content_len - received_total);
        if (received <= 0) {
            memset(body, 0, sizeof(body));
            return device_api_error(
                request, "400 Bad Request", "invalid_request");
        }
        received_total += (size_t) received;
    }
    body[received_total] = '\0';

    const bool confirmed = parse_confirmation_request(
        body, received_total, "factory_reset");
    memset(body, 0, sizeof(body));
    if (!confirmed) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }

    uint32_t operation_generation = 0u;
    if (device_operation_busy_for_factory_reset() ||
        !system_action_reserve(
            SYSTEM_ACTION_FACTORY_RESET,
            &operation_generation)) {
        return device_api_error(request, "409 Conflict", "busy");
    }

    char response[192];
    const int written = snprintf(
        response,
        sizeof(response),
        "{\"ok\":true,\"operation\":{"
        "\"generation\":%lu,\"state\":\"running\","
        "\"phase\":\"resetting\",\"error_code\":null}}",
        (unsigned long) operation_generation);
    if (written <= 0 || (size_t) written >= sizeof(response)) {
        system_action_release();
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }

    if (!perform_full_factory_reset()) {
        system_action_release();
        return device_api_error(
            request, "500 Internal Server Error", "storage_error");
    }

    device_config_status = WATTPOST_CONFIG_LOAD_EMPTY;
    device_wifi_configured = false;
    device_bms_configured = false;
    wifi_ssid_display[0] = '\0';
    bms_address_hint[0] = '\0';
    wifi_boot_action = WATTPOST_WIFI_BOOT_PROVISIONING_REQUIRED;
    bms_boot_action = WATTPOST_BMS_BOOT_SELECTION_REQUIRED;
    provision_boot_action = WATTPOST_PROVISION_BOOT_FIRST_SETUP;

    httpd_resp_set_status(request, "202 Accepted");
    httpd_resp_set_type(request, "application/json");
    const esp_err_t response_result =
        httpd_resp_sendstr(request, response);
    schedule_deferred_restart();
    return response_result;
}

static esp_err_t wifi_configure_start_handler(httpd_req_t *request) {
    if (!local_mutation_request_allowed(request)) {
        return ESP_OK;
    }
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");

    const bool first_setup_configure =
        provision_boot_action == WATTPOST_PROVISION_BOOT_FIRST_SETUP &&
        first_setup_ap_active &&
        !device_wifi_configured;
    const bool installed_configure =
        (provision_boot_action == WATTPOST_PROVISION_BOOT_NORMAL || first_setup_ap_active) &&
        device_wifi_configured &&
        wifi_boot_action == WATTPOST_WIFI_BOOT_CONNECT_SAVED;

    if (!first_setup_configure && !installed_configure) {
        return device_api_error(
            request, "409 Conflict", "invalid_state");
    }
    if (!wifi_driver_started) {
        return device_api_error(
            request, "503 Service Unavailable", "subsystem_unavailable");
    }
    if (request->content_len <= 0) {
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }
    if ((size_t) request->content_len > WATTPOST_WIFI_CONFIGURE_BODY_MAX) {
        return device_api_error(
            request, "413 Payload Too Large", "content_too_large");
    }

    char body[WATTPOST_WIFI_CONFIGURE_BODY_MAX + 1u];
    memset(body, 0, sizeof(body));
    size_t received_total = 0;
    while (received_total < (size_t) request->content_len) {
        const int received = httpd_req_recv(
            request,
            body + received_total,
            (size_t) request->content_len - received_total);
        if (received <= 0) {
            memset(body, 0, sizeof(body));
            return device_api_error(
                request, "400 Bad Request", "invalid_request");
        }
        received_total += (size_t) received;
    }
    body[received_total] = '\0';

    wifi_configure_request_t parsed;
    const char *parse_error = NULL;
    if (!parse_wifi_configure_request(
            body, received_total, &parsed, &parse_error)) {
        memset(body, 0, sizeof(body));
        return device_api_error(
            request,
            strcmp(parse_error, "invalid_json") == 0
                ? "400 Bad Request"
                : "400 Bad Request",
            parse_error ? parse_error : "invalid_request");
    }
    memset(body, 0, sizeof(body));

    wifi_scan_candidate_t candidate;
    memset(&candidate, 0, sizeof(candidate));
    const char *selection_error = NULL;
    if (!parsed.hidden &&
        !wifi_candidate_for_configure(
            parsed.scan_generation,
            parsed.candidate_id,
            &candidate,
            &selection_error)) {
        memset(&parsed, 0, sizeof(parsed));
        if (selection_error && strcmp(selection_error, "busy") == 0) {
            return device_api_error(request, "409 Conflict", "busy");
        }
        if (selection_error && strcmp(selection_error, "stale_scan") == 0) {
            return device_api_error(
                request, "409 Conflict", "stale_scan");
        }
        return device_api_error(
            request, "404 Not Found", "candidate_not_found");
    }

    wattpost_device_config_t current_config;
    if (!load_device_config_for_mutation(&current_config)) {
        memset(&parsed, 0, sizeof(parsed));
        memset(&candidate, 0, sizeof(candidate));
        return device_api_error(
            request, "500 Internal Server Error", "storage_error");
    }
    if (installed_configure && !current_config.wifi_configured) {
        memset(&parsed, 0, sizeof(parsed));
        memset(&candidate, 0, sizeof(candidate));
        memset(&current_config, 0, sizeof(current_config));
        return device_api_error(
            request, "409 Conflict", "not_configured");
    }

    wattpost_device_config_t pending_config = current_config;
    wattpost_device_config_clear_wifi(&pending_config);
    const char *ssid = parsed.hidden
        ? parsed.hidden_ssid
        : candidate.ssid;
    const size_t ssid_len = strlen(ssid);
    if (ssid_len == 0u || ssid_len > WATTPOST_WIFI_SSID_MAX_LEN) {
        memset(&parsed, 0, sizeof(parsed));
        memset(&candidate, 0, sizeof(candidate));
        memset(&pending_config, 0, sizeof(pending_config));
        memset(&current_config, 0, sizeof(current_config));
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }

    pending_config.wifi_configured = true;
    pending_config.wifi_ssid_len = (uint8_t) ssid_len;
    memcpy(pending_config.wifi_ssid, ssid, ssid_len);
    pending_config.wifi_password_len = (uint8_t) parsed.password_len;
    memcpy(
        pending_config.wifi_password,
        parsed.password,
        parsed.password_len);

    if (!wattpost_device_config_validate(&pending_config)) {
        memset(&parsed, 0, sizeof(parsed));
        memset(&candidate, 0, sizeof(candidate));
        memset(&pending_config, 0, sizeof(pending_config));
        memset(&current_config, 0, sizeof(current_config));
        return device_api_error(
            request, "400 Bad Request", "invalid_request");
    }

    uint32_t operation_generation = 0;
    bool busy = false;
    bool stale = false;
    portENTER_CRITICAL(&wifi_scan_lock);
    if (wifi_setup_operation_busy_locked()) {
        busy = true;
    } else if (!parsed.hidden &&
               (parsed.scan_generation != wifi_scan_generation ||
                parsed.scan_generation != wifi_scan_completed_generation)) {
        stale = true;
    } else {
        ++wifi_operation_generation;
        operation_generation = wifi_operation_generation;
        wifi_validation.active = true;
        if (wifi_rollback.pending && first_setup_ap_active) wifi_rollback_preempt_requested = true;
        wifi_validation.installed_switch = installed_configure;
        wifi_validation.recovery_flow = recovery_ap_active;
        wifi_validation.start_pending = installed_configure;
        wifi_validation.expected_disconnect = false;
        wifi_validation.start_armed = false;
        wifi_validation.pending_applied = false;
        wifi_validation.association_confirmed = false;
        wifi_validation.started_us =
            installed_configure ? 0 : esp_timer_get_time();
        wifi_validation.pending_config = pending_config;
        if (installed_configure) {
            wifi_validation.rollback_config = current_config;
        } else {
            memset(
                &wifi_validation.rollback_config,
                0,
                sizeof(wifi_validation.rollback_config));
        }
        wifi_validation.candidate_bssid_set = !parsed.hidden;
        if (!parsed.hidden) {
            memcpy(
                wifi_validation.candidate_bssid,
                candidate.bssid,
                sizeof(wifi_validation.candidate_bssid));
            wifi_validation.candidate_channel = candidate.channel;
        } else {
            memset(
                wifi_validation.candidate_bssid,
                0,
                sizeof(wifi_validation.candidate_bssid));
            wifi_validation.candidate_channel = 0u;
        }
        wifi_operation_state = WIFI_OPERATION_RUNNING;
        wifi_operation_phase = WIFI_OPERATION_PHASE_VALIDATING;
        wifi_operation_error_code = NULL;
    }
    portEXIT_CRITICAL(&wifi_scan_lock);

    if (busy || stale) {
        memset(&parsed, 0, sizeof(parsed));
        memset(&candidate, 0, sizeof(candidate));
        memset(&pending_config, 0, sizeof(pending_config));
        memset(&current_config, 0, sizeof(current_config));
        return device_api_error(
            request,
            "409 Conflict",
            busy ? "busy" : "stale_scan");
    }

    bool connect_started = true;
    if (first_setup_configure) {
        connect_started = wifi_validation_apply_pending_config();
    }

    memset(&parsed, 0, sizeof(parsed));
    memset(&candidate, 0, sizeof(candidate));
    memset(&pending_config, 0, sizeof(pending_config));
    memset(&current_config, 0, sizeof(current_config));

    if (!connect_started) {
        return device_api_error(
            request,
            "503 Service Unavailable",
            "wifi_connect_failed");
    }

    char response[192];
    const int written = snprintf(
        response,
        sizeof(response),
        "{\"ok\":true,\"operation\":{"
        "\"generation\":%lu,\"state\":\"running\","
        "\"phase\":\"connecting\",\"error_code\":null}}",
        (unsigned long) operation_generation);
    if (written <= 0 || (size_t) written >= sizeof(response)) {
        wifi_validation_finish_error("internal_error");
        if (first_setup_configure) {
            esp_wifi_disconnect();
        }
        return device_api_error(
            request, "500 Internal Server Error", "internal_error");
    }

    httpd_resp_set_status(request, "202 Accepted");
    httpd_resp_set_type(request, "application/json");
    const esp_err_t response_result =
        httpd_resp_sendstr(request, response);
    portENTER_CRITICAL(&wifi_scan_lock);
    if (wifi_validation.active && wifi_operation_generation == operation_generation) {
        wifi_validation.start_armed = true;
    }
    portEXIT_CRITICAL(&wifi_scan_lock);
    if (installed_configure && recovery_task_handle != NULL) {
        xTaskNotifyGive(recovery_task_handle);
    }
    return response_result;
}

static const embedded_asset_t *find_web_asset(const char *uri) {
    const size_t uri_length = strcspn(uri, "?");
    for (size_t index = 0; index < sizeof(web_assets) / sizeof(web_assets[0]); ++index) {
        const embedded_asset_t *asset = &web_assets[index];
        if (strlen(asset->uri) == uri_length && memcmp(asset->uri, uri, uri_length) == 0) {
            return asset;
        }
    }
    return NULL;
}

static esp_err_t web_asset_handler(httpd_req_t *request) {
    if (provisioning_ap_active() && !local_request_host_allowed(request)) {
        return captive_portal_redirect(request);
    }

    const size_t request_path_length = strcspn(request->uri, "?");
    const bool request_is_root =
        request_path_length == 1u && request->uri[0] == '/';
    const bool setup_portal_root =
        provisioning_ap_active() &&
        (recovery_ap_active ||
         (strcmp(device_setup_state(), "configured") != 0 &&
          !first_setup_bms_deferred));
    const char *asset_uri =
        setup_portal_root && request_is_root
            ? "/setup.html"
            : request->uri;

    const embedded_asset_t *asset = find_web_asset(asset_uri);
    if (asset == NULL) {
        if (provisioning_ap_active() &&
            strncmp(request->uri, "/api/", 5u) != 0) {
            return captive_portal_redirect(request);
        }
        httpd_resp_send_err(request, HTTPD_404_NOT_FOUND, "Not found");
        return ESP_FAIL;
    }

    httpd_resp_set_type(request, asset->content_type);
    httpd_resp_set_hdr(request, "Content-Encoding", "gzip");
    httpd_resp_set_hdr(request, "Vary", "Accept-Encoding");
    httpd_resp_set_hdr(
        request,
        "Cache-Control",
        strcmp(asset->uri, "/") == 0 ||
                strcmp(asset->uri, "/setup.html") == 0
            ? "no-store"
            : "public, max-age=3600");
    return httpd_resp_send(
        request,
        (const char *) asset->start,
        asset->end - asset->start);
}

static esp_err_t json_response_too_large(httpd_req_t *request) {
    httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "Відповідь завелика");
    return ESP_FAIL;
}

static esp_err_t live_handler(httpd_req_t *request) {
    jk_bms_data_t data;
    const bool online = jk_bms_ble_get_data(&data);

    jk_bms_device_info_t dev_info = {0};
    jk_bms_ble_get_device_info(&dev_info);
    char model_json[sizeof(dev_info.model) * 6];
    char hardware_json[sizeof(dev_info.hardware_version) * 6];
    char software_json[sizeof(dev_info.software_version) * 6];
    char wifi_ssid_json[sizeof(wifi_ssid_display) * 6];
    if (!wattpost_json_escape(model_json, sizeof(model_json), dev_info.valid ? dev_info.model : "") ||
        !wattpost_json_escape(hardware_json, sizeof(hardware_json),
                              dev_info.valid ? dev_info.hardware_version : "") ||
        !wattpost_json_escape(software_json, sizeof(software_json),
                              dev_info.valid ? dev_info.software_version : "") ||
        !wattpost_json_escape(wifi_ssid_json, sizeof(wifi_ssid_json),
                              device_wifi_configured ? wifi_ssid_display : "")) {
        return json_response_too_large(request);
    }

    int8_t wifi_rssi = 0;
    char wifi_rssi_json[16] = "null";
    if (wifi_current_rssi(&wifi_rssi)) {
        snprintf(wifi_rssi_json, sizeof(wifi_rssi_json), "%d", (int) wifi_rssi);
    }

    jk_bms_settings_t settings_probe = {0};
    const bool settings_valid = jk_bms_ble_get_settings(&settings_probe);

    temp_capabilities_t temp_caps;
    temperature_resolve_capabilities(&dev_info, &data, &settings_probe, &temp_caps);

    const char *message = online ? "Дані BMS отримано" :
                          jk_bms_ble_is_connected() ? "Очікування даних BMS" :
                                                       "Очікування BMS";
    char remaining_capacity[20];

    char nominal_capacity[20];
    if (online && isfinite(data.remaining_capacity_ah)) {
        snprintf(remaining_capacity, sizeof(remaining_capacity), "%.3f", data.remaining_capacity_ah);
    } else {
        strcpy(remaining_capacity, "null");
    }
    if (online && isfinite(data.nominal_capacity_ah)) {
        snprintf(nominal_capacity, sizeof(nominal_capacity), "%.3f", data.nominal_capacity_ah);
    } else {
        strcpy(nominal_capacity, "null");
    }

    const char *charger_status = (data.current_a > 0.05f) ? "charging" :
                                  (data.current_a < -0.05f) ? "discharging" : "idle";
    const char *balancing_action_str = (data.balancing_action == 1) ? "charging" :
                                       (data.balancing_action == 2) ? "discharging" : "off";

    char bms_max_cell_index[5] = "null";
    char bms_min_cell_index[5] = "null";
    if (jk_bms_cell_index_valid(data.bms_max_cell_index, data.cell_count)) {
        snprintf(bms_max_cell_index, sizeof(bms_max_cell_index), "%u",
                 (unsigned int) data.bms_max_cell_index);
    }
    if (jk_bms_cell_index_valid(data.bms_min_cell_index, data.cell_count)) {
        snprintf(bms_min_cell_index, sizeof(bms_min_cell_index), "%u",
                 (unsigned int) data.bms_min_cell_index);
    }

    size_t used = 0;
    if (!wattpost_json_appendf(
        http_json_response.live, sizeof(http_json_response.live), &used,
        "{\"online\":%s,\"cell_count\":%u,\"cell_active_mask\":%lu,\"temp_present_mask\":%u,"
        "\"raw_temperature_status_mask\":%u,\"resolved_temperature_mask\":%u,"
        "\"protocol_family\":\"%s\",\"semantic_profile\":\"%s\","
        "\"temperature_detection_mode\":\"%s\",\"temperature_resolution_source\":\"%s\","
        "\"model\":\"%s\",\"hardware_version\":\"%s\",\"software_version\":\"%s\","
        "\"firmware_version\":\"%s\",\"web_version\":\"%s\",\"build_id\":\"%s\","
        "\"device_config_status\":\"%s\",\"setup_state\":\"%s\","
        "\"wifi_configured\":%s,\"wifi_state\":\"%s\",\"wifi_ssid\":\"%s\",\"wifi_rssi_dbm\":%s,"
        "\"bms_configured\":%s,\"bms_address_hint\":\"%s\","
        "\"ota_state\":\"%s\",\"ota_rollback_configured\":%s,\"ota_validation_pending\":%s,"
        "\"esp_uptime\":%lu,\"boot_count\":%lu,\"panic_count\":%lu,"
        "\"free_heap\":%lu,\"minimum_free_heap\":%lu,"
        "\"coredump_present\":%s,\"coredump_valid\":%s,\"coredump_size\":%lu,"
        "\"charger_status\":\"%s\",\"charging\":%s,\"discharging\":%s,"
        "\"charge_mos_enabled\":%s,\"discharge_mos_enabled\":%s,"
        "\"balancing\":%s,\"balancing_action\":\"%s\",\"balancing_current_a\":%.3f,"
        "\"heating_status\":%s,"
        "\"alarm_flags\":%u,"
        "\"cycle_count\":%lu,\"cycle_capacity_ah\":%.3f,"
        "\"settings_valid\":%s,\"message\":\"%s\",\"ble_state\":\"%s\","
        "\"ble_phase\":\"%s\",\"ble_connected\":%s,\"connect_count\":%lu,"
        "\"disconnect_count\":%lu,\"last_disconnect_reason\":%d,\"connection_uptime\":%lu,"
        "\"wifi_disconnect_count\":%lu,\"wifi_reconnect_count\":%lu,"
        "\"mdns_started\":%s,\"mdns_recovery_count\":%lu,\"mdns_announce_count\":%lu,"
        "\"mdns_last_recovery_reason\":\"%s\",\"mdns_start_age\":%lu,\"mdns_announce_age\":%lu,"
        "\"ble_recovery_count\":%lu,\"last_valid_bms_frame_age\":%lu,"
        "\"wifi_down_time\":%lu,\"bms_down_time\":%lu,\"last_restart_reason\":\"%s\","
        "\"ble_attempts\":%lu,\"ble_successes\":%lu,"
        "\"ble_notifications\":%lu,\"ble_notification_bytes\":%lu,"
        "\"ble_last_notification_length\":%u,\"ble_last_frame_type\":%u,"
        "\"ble_frames_1\":%lu,\"ble_frames_2\":%lu,\"ble_frames_3\":%lu,\"ble_last_status\":%d,"
        "\"voltage_v\":%.3f,\"current_a\":%.3f,\"power_w\":%.1f,"
        "\"soc\":%u,\"remaining_capacity_ah\":%s,\"nominal_capacity_ah\":%s,"
        "\"temperature_1_c\":%.1f,\"temperature_2_c\":%.1f,"
        "\"mosfet_temperature_c\":%.1f,\"min_cell_voltage_v\":%.3f,"
        "\"max_cell_voltage_v\":%.3f,\"cell_spread_v\":%.3f,"
        "\"bms_cell_average_mv\":%u,\"bms_cell_delta_mv\":%u,"
        "\"bms_max_cell_index\":%s,\"bms_min_cell_index\":%s,"
        "\"temperatures\":[",
        online ? "true" : "false", data.cell_count,
        (unsigned long) data.cell_active_mask,
        temp_caps.resolved_mask,
        temp_caps.raw_status_mask,
        temp_caps.resolved_mask,
        protocol_family_to_str(temp_caps.protocol_family),
        semantic_profile_to_str(temp_caps.semantic_profile),
        temp_mode_to_str(temp_caps.mode),
        temp_res_source_to_str(temp_caps.resolution_source),
        model_json, hardware_json, software_json,
        WATTPOST_FIRMWARE_VERSION, WATTPOST_WEB_VERSION, WATTPOST_BUILD_ID,
        wattpost_device_config_load_result_str(device_config_status),
        device_setup_state(),
        device_wifi_configured ? "true" : "false",
        wifi_runtime_state(), wifi_ssid_json, wifi_rssi_json,
        device_bms_configured ? "true" : "false", bms_address_hint,
        current_ota_state(), ota_rollback_configured_json(), ota_validation_pending ? "true" : "false",
        (unsigned long) esp_uptime_seconds(),
        (unsigned long) diagnostics.boot_count,
        (unsigned long) diagnostics.panic_count,
        (unsigned long) esp_get_free_heap_size(),
        (unsigned long) esp_get_minimum_free_heap_size(),
        diagnostics.coredump_present ? "true" : "false",
        diagnostics.coredump_valid ? "true" : "false",
        (unsigned long) diagnostics.coredump_size,
        charger_status,
        data.charging ? "true" : "false",
        data.discharging ? "true" : "false",
        data.charge_mos_enabled ? "true" : "false",
        data.discharge_mos_enabled ? "true" : "false",
        data.balancing ? "true" : "false",
        balancing_action_str,
        data.balancing_current_a,
        data.heating_status ? "true" : "false",
        (unsigned int) data.alarm_flags,
        (unsigned long) data.cycle_count,
        data.cycle_capacity_ah,
        settings_valid ? "true" : "false",
        message, jk_bms_ble_state(),
        jk_bms_ble_phase(), jk_bms_ble_is_connected() ? "true" : "false",
        (unsigned long) jk_bms_ble_connection_successes(),
        (unsigned long) jk_bms_ble_disconnect_count(),
        jk_bms_ble_last_disconnect_reason(),
        (unsigned long) jk_bms_ble_connection_uptime(),
        (unsigned long) wifi_disconnect_count,
        (unsigned long) wifi_reconnect_count,
        mdns_started ? "true" : "false",
        (unsigned long) mdns_recovery_count,
        (unsigned long) mdns_announce_count,
        mdns_last_recovery_reason,
        (unsigned long) monotonic_age_seconds(mdns_last_start_us),
        (unsigned long) monotonic_age_seconds(mdns_last_announce_us),
        (unsigned long) jk_bms_ble_recovery_count(),
        (unsigned long) jk_bms_ble_last_valid_frame_age(),
        (unsigned long) wifi_down_time(),
        (unsigned long) jk_bms_ble_down_time(), last_restart_reason,
        (unsigned long) jk_bms_ble_connection_attempts(),
        (unsigned long) jk_bms_ble_connection_successes(),
        (unsigned long) jk_bms_ble_notifications(),
        (unsigned long) jk_bms_ble_notification_bytes(),
        jk_bms_ble_last_notification_length(), jk_bms_ble_last_frame_type(),
        (unsigned long) jk_bms_ble_frame_count(1),
        (unsigned long) jk_bms_ble_frame_count(2),
        (unsigned long) jk_bms_ble_frame_count(3), jk_bms_ble_last_status(),
        data.pack_voltage_v,
        data.current_a, data.power_w, data.state_of_charge, remaining_capacity, nominal_capacity,
        data.temperature_1_c,
        data.temperature_2_c, data.mosfet_temperature_c, data.min_cell_voltage_v,
        data.max_cell_voltage_v, data.cell_spread_v,
        (unsigned int) data.bms_average_cell_voltage_mv,
        (unsigned int) data.bms_cell_voltage_delta_mv,
        bms_max_cell_index, bms_min_cell_index)) {
        return json_response_too_large(request);
    }



    for (uint8_t i = 0; i < JK_BMS_MAX_TEMPS; ++i) {
        const temp_channel_info_t *ch = &temp_caps.channels[i];
        char val_buf[16];
        if (ch->value_valid) {
            snprintf(val_buf, sizeof(val_buf), "%.1f", ch->val_c);
        } else {
            snprintf(val_buf, sizeof(val_buf), "null");
        }
        char alias_buf[16];
        if (ch->alias_of) {
            snprintf(alias_buf, sizeof(alias_buf), "\"%s\"", ch->alias_of);
        } else {
            snprintf(alias_buf, sizeof(alias_buf), "null");
        }

        const char *supp_str = (ch->supported == TEMP_SUPPORTED_TRUE) ? "true" :
                               ((ch->supported == TEMP_SUPPORTED_FALSE) ? "false" : "\"unknown\"");

        if (!wattpost_json_appendf(
            http_json_response.live, sizeof(http_json_response.live), &used,
            "%s{\"id\":\"%s\",\"name\":\"%s\",\"supported\":%s,\"presence\":\"%s\","
            "\"present\":%s,\"enabled\":%s,\"value_valid\":%s,\"val_c\":%s,"
            "\"alias_of\":%s,\"resolution_source\":\"%s\"}",
            i == 0 ? "" : ",",
            ch->id, ch->name,
            supp_str,
            temp_presence_to_str(ch->presence),
            ch->present ? "true" : "false",
            ch->enabled ? "true" : "false",
            ch->value_valid ? "true" : "false",
            val_buf,
            alias_buf,
            temp_res_source_to_str(ch->resolution_source))) {
            return json_response_too_large(request);
        }
    }

    if (!wattpost_json_appendf(http_json_response.live, sizeof(http_json_response.live), &used,
                               "],\"alarms\":[")) {
        return json_response_too_large(request);
    }

    bool first_alarm = true;
    for (uint8_t bit = 0; bit < 32; ++bit) {
        if ((data.alarm_flags & (1u << bit)) != 0 && ALARM_NAMES[bit] != NULL) {
            if (!wattpost_json_appendf(http_json_response.live, sizeof(http_json_response.live), &used,
                                       "%s\"%s\"", first_alarm ? "" : ",",
                                       ALARM_NAMES[bit])) {
                return json_response_too_large(request);
            }
            first_alarm = false;
        }
    }


    if (!wattpost_json_appendf(http_json_response.live, sizeof(http_json_response.live), &used,
                               "],\"cells\":[")) {
        return json_response_too_large(request);
    }

    bool first_cell = true;
    for (uint8_t cell = 0; cell < JK_BMS_MAX_CELLS; ++cell) {
        if (data.cell_active_mask & (1u << cell)) {
            if (!wattpost_json_appendf(http_json_response.live, sizeof(http_json_response.live), &used,
                                       "%s%.3f", first_cell ? "" : ",",
                                       data.cell_voltage_v[cell])) {
                return json_response_too_large(request);
            }
            first_cell = false;
        }
    }

    if (!wattpost_json_appendf(http_json_response.live, sizeof(http_json_response.live), &used,
                               "],\"cell_wire_resistance\":[")) {
        return json_response_too_large(request);
    }

    bool first_res = true;
    for (uint8_t cell = 0; cell < JK_BMS_MAX_CELLS; ++cell) {
        if (data.cell_active_mask & (1u << cell)) {
            if (!wattpost_json_appendf(http_json_response.live, sizeof(http_json_response.live), &used,
                                       "%s%.4f", first_res ? "" : ",",
                                       data.cell_wire_resistance_ohm[cell])) {
                return json_response_too_large(request);
            }
            first_res = false;
        }
    }

    if (!wattpost_json_appendf(http_json_response.live, sizeof(http_json_response.live), &used, "]}")) {
        return json_response_too_large(request);
    }


    httpd_resp_set_type(request, "application/json");
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    return httpd_resp_sendstr(request, http_json_response.live);
}



typedef struct {
    httpd_req_t *request;
    bool first;
} history_response_t;

static bool send_history_record(const wattpost_history_record_t *record, void *context) {
    history_response_t *response = context;
    char json[512];
    size_t used = (size_t) snprintf(
        json, sizeof(json),
        "%s{\"t\":%lu,\"v\":%.3f,\"a\":%.1f,\"s\":%u,\"cell_count\":%u,\"cell_mask\":%lu,\"temp_mask\":%u,\"cells\":[",
        response->first ? "" : ",",
        (unsigned long) record->timestamp,
        record->pack_voltage_mv * 0.001f,
        record->current_deci_a * 0.1f,
        record->state_of_charge,
        record->cell_count,
        (unsigned long) record->cell_active_mask,
        record->temp_present_mask);

    bool first_cell = true;
    for (uint8_t cell = 0; cell < JK_BMS_MAX_CELLS && used < sizeof(json); ++cell) {
        if (record->cell_active_mask & (1u << cell)) {
            used += (size_t) snprintf(json + used, sizeof(json) - used,
                                      "%s%u", first_cell ? "" : ",", record->cell_voltage_mv[cell]);
            first_cell = false;
        }
    }

    if (used < sizeof(json)) {
        used += (size_t) snprintf(json + used, sizeof(json) - used, "],\"temps\":[");
    }

    for (uint8_t temp = 0; temp < JK_BMS_MAX_TEMPS && used < sizeof(json); ++temp) {
        if (record->temp_present_mask & (1u << temp)) {
            used += (size_t) snprintf(json + used, sizeof(json) - used,
                                      "%s%d", temp == 0 ? "" : ",", record->temperature_deci_c[temp]);
        } else {
            used += (size_t) snprintf(json + used, sizeof(json) - used,
                                      "%snull", temp == 0 ? "" : ",");
        }
    }

    if (used < sizeof(json)) {
        used += (size_t) snprintf(json + used, sizeof(json) - used, "]}");
    }

    response->first = false;
    return used > 0 && used < sizeof(json) &&
           httpd_resp_send_chunk(response->request, json, used) == ESP_OK;
}


static esp_err_t history_handler(httpd_req_t *request) {
    wattpost_history_query_t query;
    const size_t query_length = httpd_req_get_url_query_len(request);
    const bool paged = query_length > 0;
    if (query_length >= 128) {
        httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "invalid history query");
        return ESP_FAIL;
    }
    if (paged) {
        char query_string[128];
        if (httpd_req_get_url_query_str(request, query_string, sizeof(query_string)) != ESP_OK ||
                !wattpost_history_query_parse(query_string, &query)) {
            httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "invalid history query");
            return ESP_FAIL;
        }
    }

    httpd_resp_set_type(request, "application/json");
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    char history_context[64];
    history_context_string(history_context);
    if (history_context[0] != '\0') {
        httpd_resp_set_hdr(request, "X-WattPost-History-Context", history_context);
    }
    if (httpd_resp_send_chunk(request, "[", 1) != ESP_OK) {
        return ESP_FAIL;
    }
    history_response_t response = {.request = request, .first = true};
    if (paged) {
        wattpost_history_visit_window(&query, send_history_record, &response);
    } else {
        wattpost_history_visit_recent(send_history_record, &response);
    }
    return httpd_resp_send_chunk(request, "]", 1) == ESP_OK &&
                   httpd_resp_send_chunk(request, NULL, 0) == ESP_OK ? ESP_OK : ESP_FAIL;
}

static bool ota_authorized(httpd_req_t *request) {
    const size_t expected_length = strlen(WATTPOST_OTA_TOKEN);
    const size_t received_length = httpd_req_get_hdr_value_len(request, "X-WattPost-Token");
    if (expected_length == 0 || expected_length >= 96 || received_length != expected_length) {
        return false;
    }
    char received_token[96];
    return httpd_req_get_hdr_value_str(request, "X-WattPost-Token", received_token,
                                       sizeof(received_token)) == ESP_OK &&
           strcmp(received_token, WATTPOST_OTA_TOKEN) == 0;
}

static uint32_t task_stack_free_min_bytes(TaskHandle_t task) {
    return task == NULL ? 0u : (uint32_t) uxTaskGetStackHighWaterMark(task);
}

static esp_err_t diagnostics_handler(httpd_req_t *request) {
    char reason_json[sizeof(diagnostics.panic_reason) * 2];
    char task_json[sizeof(diagnostics.panic_task) * 2];
    wattpost_cloud_transport_snapshot_t cloud_transport = {0};
    wattpost_cloud_transport_snapshot(&cloud_transport);
    char cloud_last_success_age[16] = "null";
    if (cloud_transport.successes > 0u) {
        snprintf(
            cloud_last_success_age,
            sizeof(cloud_last_success_age),
            "%lu",
            (unsigned long) cloud_transport.last_success_age_s);
    }
    char cloud_telemetry_last_success_age[16] = "null";
    if (cloud_transport.telemetry_successes > 0u) {
        snprintf(
            cloud_telemetry_last_success_age,
            sizeof(cloud_telemetry_last_success_age),
            "%lu",
            (unsigned long) cloud_transport.telemetry_last_success_age_s);
    }
    char cloud_settings_last_success_age[16] = "null";
    if (cloud_transport.settings_successes > 0u) {
        snprintf(
            cloud_settings_last_success_age,
            sizeof(cloud_settings_last_success_age),
            "%lu",
            (unsigned long) cloud_transport.settings_last_success_age_s);
    }
    if (!wattpost_json_escape(reason_json, sizeof(reason_json), diagnostics.panic_reason) ||
        !wattpost_json_escape(task_json, sizeof(task_json), diagnostics.panic_task)) {
        return json_response_too_large(request);
    }

    size_t used = 0;
    if (!wattpost_json_appendf(
            http_json_response.diagnostics, sizeof(http_json_response.diagnostics), &used,
            "{\"firmware_version\":\"%s\",\"build_id\":\"%s\","
            "\"last_restart_reason\":\"%s\",\"esp_uptime\":%lu,"
            "\"boot_count\":%lu,\"panic_count\":%lu,"
            "\"free_heap\":%lu,\"minimum_free_heap\":%lu,\"largest_free_block\":%lu,"
            "\"jk_bms_poll_stack_free_min_bytes\":%lu,"
            "\"history_stack_free_min_bytes\":%lu,"
            "\"internet_probe_stack_free_min_bytes\":%lu,"
            "\"recovery_stack_free_min_bytes\":%lu,"
            "\"boot_button_stack_free_min_bytes\":%lu,"
            "\"cloud_transport\":{"
              "\"task_started\":%s,\"network_available\":%s,"
              "\"state\":\"%s\",\"attempts\":%lu,\"successes\":%lu,\"failures\":%lu,"
              "\"last_http_status\":%ld,\"last_esp_error\":%ld,"
              "\"current_backoff_ms\":%lu,\"stack_free_min_bytes\":%lu,"
              "\"heap_free_before_last\":%lu,\"heap_free_after_last\":%lu,"
              "\"largest_free_before_last\":%lu,\"largest_free_after_last\":%lu,"
              "\"last_success_age_s\":%s,"
              "\"telemetry_attempts\":%lu,\"telemetry_successes\":%lu,"
              "\"telemetry_failures\":%lu,\"telemetry_last_sample_seq\":%lu,"
              "\"telemetry_last_success_age_s\":%s,"
              "\"history_attempts\":%lu,\"history_successes\":%lu,"
              "\"history_failures\":%lu,\"history_records_sent\":%lu,"
              "\"settings_attempts\":%lu,\"settings_successes\":%lu,"
              "\"settings_failures\":%lu,\"settings_last_success_age_s\":%s},"
            "\"coredump\":{\"present\":%s,\"valid\":%s,\"size\":%lu,"
            "\"panic_reason\":\"%s\",\"task\":\"%s\",\"pc\":%lu,"
            "\"backtrace_corrupted\":%s,\"backtrace\":[",
            WATTPOST_FIRMWARE_VERSION, WATTPOST_BUILD_ID,
            last_restart_reason,
            (unsigned long) esp_uptime_seconds(),
            (unsigned long) diagnostics.boot_count,
            (unsigned long) diagnostics.panic_count,
            (unsigned long) esp_get_free_heap_size(),
            (unsigned long) esp_get_minimum_free_heap_size(),
            (unsigned long) heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
            (unsigned long) jk_bms_ble_poll_stack_free_min_bytes(),
            (unsigned long) task_stack_free_min_bytes(history_task_handle),
            (unsigned long) task_stack_free_min_bytes(internet_reachability_task_handle),
            (unsigned long) task_stack_free_min_bytes(recovery_task_handle),
            (unsigned long) task_stack_free_min_bytes(boot_button_task_handle),
            cloud_transport.task_started ? "true" : "false",
            cloud_transport.network_available ? "true" : "false",
            wattpost_cloud_state_str(cloud_transport.state),
            (unsigned long) cloud_transport.attempts,
            (unsigned long) cloud_transport.successes,
            (unsigned long) cloud_transport.failures,
            (long) cloud_transport.last_http_status,
            (long) cloud_transport.last_esp_error,
            (unsigned long) cloud_transport.current_backoff_ms,
            (unsigned long) cloud_transport.stack_free_min_bytes,
            (unsigned long) cloud_transport.heap_free_before_last,
            (unsigned long) cloud_transport.heap_free_after_last,
            (unsigned long) cloud_transport.largest_free_before_last,
            (unsigned long) cloud_transport.largest_free_after_last,
            cloud_last_success_age,
            (unsigned long) cloud_transport.telemetry_attempts,
            (unsigned long) cloud_transport.telemetry_successes,
            (unsigned long) cloud_transport.telemetry_failures,
            (unsigned long) cloud_transport.telemetry_last_sample_seq,
            cloud_telemetry_last_success_age,
            (unsigned long) cloud_transport.history_attempts,
            (unsigned long) cloud_transport.history_successes,
            (unsigned long) cloud_transport.history_failures,
            (unsigned long) cloud_transport.history_records_sent,
            (unsigned long) cloud_transport.settings_attempts,
            (unsigned long) cloud_transport.settings_successes,
            (unsigned long) cloud_transport.settings_failures,
            cloud_settings_last_success_age,
            diagnostics.coredump_present ? "true" : "false",
            diagnostics.coredump_valid ? "true" : "false",
            (unsigned long) diagnostics.coredump_size,
            reason_json, task_json,
            (unsigned long) diagnostics.panic_pc,
            diagnostics.panic_backtrace_corrupted ? "true" : "false")) {
        return json_response_too_large(request);
    }

    for (uint32_t index = 0; index < diagnostics.panic_backtrace_depth; ++index) {
        if (!wattpost_json_appendf(http_json_response.diagnostics, sizeof(http_json_response.diagnostics), &used,
                                   "%s%lu", index == 0 ? "" : ",",
                                   (unsigned long) diagnostics.panic_backtrace[index])) {
            return json_response_too_large(request);
        }
    }
    if (!wattpost_json_appendf(http_json_response.diagnostics, sizeof(http_json_response.diagnostics), &used, "]}}")) {
        return json_response_too_large(request);
    }

    httpd_resp_set_type(request, "application/json");
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    return httpd_resp_sendstr(request, http_json_response.diagnostics);
}

static esp_err_t coredump_download_handler(httpd_req_t *request) {
    if (!ota_authorized(request)) {
        httpd_resp_send_err(request, HTTPD_401_UNAUTHORIZED, "Потрібен токен OTA");
        return ESP_FAIL;
    }

    size_t address = 0;
    size_t size = 0;
    if (esp_core_dump_image_get(&address, &size) != ESP_OK || size == 0) {
        httpd_resp_send_err(request, HTTPD_404_NOT_FOUND, "Core dump відсутній");
        return ESP_FAIL;
    }

    const esp_partition_t *core = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_COREDUMP, "coredump");
    if (core == NULL || address != core->address || size > core->size) {
        httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "Core dump partition invalid");
        return ESP_FAIL;
    }

    httpd_resp_set_type(request, "application/octet-stream");
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    httpd_resp_set_hdr(request, "Content-Disposition", "attachment; filename=\"wattpost-coredump.bin\"");

    uint8_t buffer[512];
    for (size_t offset = 0; offset < size; offset += sizeof(buffer)) {
        const size_t chunk = size - offset < sizeof(buffer) ? size - offset : sizeof(buffer);
        if (esp_partition_read(core, offset, buffer, chunk) != ESP_OK ||
            httpd_resp_send_chunk(request, (const char *) buffer, chunk) != ESP_OK) {
            return ESP_FAIL;
        }
    }
    return httpd_resp_send_chunk(request, NULL, 0) == ESP_OK ? ESP_OK : ESP_FAIL;
}



static void restart_after_ota(void *unused) {
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
}

static const char *detect_restart_reason(void) {
    if (saved_restart_magic == RESTART_REASON_MAGIC) {
        const uint32_t reason = saved_restart_reason;
        saved_restart_magic = 0;
        saved_restart_reason = 0;
        return reason == RESTART_REASON_LEGACY_WIFI_TIMEOUT ? "wifi_timeout" :
               reason == RESTART_REASON_BMS_TIMEOUT ? "bms_timeout" : "manual";
    }
    switch (esp_reset_reason()) {
        case ESP_RST_POWERON: return "power_on";
        case ESP_RST_SW: return "manual";
        case ESP_RST_PANIC: return "panic";
        case ESP_RST_INT_WDT:
        case ESP_RST_TASK_WDT:
        case ESP_RST_WDT: return "watchdog";
        case ESP_RST_BROWNOUT: return "brownout";
        default: return "other";
    }
}

static void recovery_restart(uint32_t reason) {
    if (restart_pending) {
        return;
    }
    restart_pending = true;
    saved_restart_magic = RESTART_REASON_MAGIC;
    saved_restart_reason = reason;
    ESP_LOGE(TAG, "Аварійне перезавантаження: %s",
             reason == RESTART_REASON_LEGACY_WIFI_TIMEOUT ? "wifi_timeout" : "bms_timeout");
    esp_restart();
}

static esp_err_t ota_handler(httpd_req_t *request) {
    if (!ota_authorized(request)) {
        httpd_resp_send_err(request, HTTPD_401_UNAUTHORIZED, "Потрібен токен OTA");
        return ESP_FAIL;
    }

    const esp_partition_t *partition = esp_ota_get_next_update_partition(NULL);
    if (partition == NULL || request->content_len <= 0 ||
        request->content_len > partition->size) {
        httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "Некоректний розмір прошивки");
        return ESP_FAIL;
    }

    esp_ota_handle_t update;
    esp_err_t err = esp_ota_begin(partition, request->content_len, &update);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Не вдалося почати OTA: %s", esp_err_to_name(err));
        httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "Не вдалося почати OTA");
        return ESP_FAIL;
    }

    char buffer[1024];
    int remaining = request->content_len;
    while (remaining > 0) {
        const int received = httpd_req_recv(request, buffer,
                                            remaining < (int) sizeof(buffer) ?
                                                remaining : sizeof(buffer));
        if (received == HTTPD_SOCK_ERR_TIMEOUT) {
            continue;
        }
        if (received <= 0 || esp_ota_write(update, buffer, received) != ESP_OK) {
            esp_ota_abort(update);
            httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "Помилка запису OTA");
            return ESP_FAIL;
        }
        remaining -= received;
    }

    err = esp_ota_end(update);
    if (err == ESP_OK) {
        err = esp_ota_set_boot_partition(partition);
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Не вдалося завершити OTA: %s", esp_err_to_name(err));
        httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "Некоректна прошивка");
        return ESP_FAIL;
    }

    httpd_resp_sendstr(request, "{\"ok\":true,\"message\":\"Перезавантаження\"}");
    xTaskCreate(restart_after_ota, "restart_after_ota", 2048, NULL, 5, NULL);
    return ESP_OK;
}

static void ota_validation_task(void *unused) {
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
    if (running == NULL || esp_ota_get_state_partition(running, &state) != ESP_OK) {
        ESP_LOGI(TAG, "OTA validation: running partition has no rollback state");
        ota_validation_pending = false;
        vTaskDelete(NULL);
        return;
    }

    if (state != ESP_OTA_IMG_NEW && state != ESP_OTA_IMG_PENDING_VERIFY) {
        ota_validation_pending = false;
        vTaskDelete(NULL);
        return;
    }

    ota_validation_pending = true;
    ESP_LOGI(TAG, "OTA validation: %s, waiting 10 seconds before confirmation",
             ota_state_to_str(state));
    vTaskDelay(pdMS_TO_TICKS(10000));

    const esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "OTA validation: firmware marked valid");
    } else {
        ESP_LOGE(TAG, "OTA validation: failed to mark firmware valid: %s", esp_err_to_name(err));
    }
    ota_validation_pending = false;
    vTaskDelete(NULL);
}

static bool format_current_settings_json(
    char *output,
    size_t output_capacity,
    bool require_valid_settings) {
    if (output == NULL || output_capacity == 0u) {
        return false;
    }
    output[0] = '\0';

    jk_bms_settings_t settings = {0};
    const bool valid = jk_bms_ble_get_settings(&settings);
    if (require_valid_settings && !valid) {
        memset(&settings, 0, sizeof(settings));
        return false;
    }

    jk_bms_device_info_t device_info = {0};
    (void) jk_bms_ble_get_device_info(&device_info);
    jk_bms_data_t live_data = {0};
    (void) jk_bms_ble_get_data(&live_data);

    temp_capabilities_t temp_caps = {0};
    if (valid) {
        temperature_resolve_capabilities(
            &device_info,
            NULL,
            &settings,
            &temp_caps);
    }
    const wattpost_settings_json_input_t input = {
        .valid = valid,
        .settings = &settings,
        .device_info = &device_info,
        .live_data = &live_data,
        .protocol_family = valid
            ? protocol_family_to_str(temp_caps.protocol_family)
            : "unknown",
        .chemistry = jk_bms_battery_chemistry_str(live_data.battery_type_id),
    };
    const bool formatted =
        wattpost_settings_format_json(&input, output, output_capacity);

    memset(&temp_caps, 0, sizeof(temp_caps));
    memset(&live_data, 0, sizeof(live_data));
    memset(&device_info, 0, sizeof(device_info));
    memset(&settings, 0, sizeof(settings));
    return formatted;
}

static bool cloud_settings_snapshot(char *output, size_t output_capacity) {
    return format_current_settings_json(output, output_capacity, true);
}

static esp_err_t settings_handler(httpd_req_t *request) {
    char *response = malloc(WATTPOST_SETTINGS_JSON_MAX_LEN);
    if (response == NULL) {
        return json_response_too_large(request);
    }
    if (!format_current_settings_json(
            response,
            WATTPOST_SETTINGS_JSON_MAX_LEN,
            false)) {
        memset(response, 0, WATTPOST_SETTINGS_JSON_MAX_LEN);
        free(response);
        return json_response_too_large(request);
    }

    httpd_resp_set_type(request, "application/json");
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    const esp_err_t result = httpd_resp_sendstr(request, response);
    memset(response, 0, WATTPOST_SETTINGS_JSON_MAX_LEN);
    free(response);
    return result;
}

static esp_err_t temperature_config_get_handler(httpd_req_t *request) {
    temp_detection_mode_t mode;
    int8_t manual_mask;
    temperature_config_get(&mode, &manual_mask);

    jk_bms_device_info_t dev_info = {0};
    jk_bms_ble_get_device_info(&dev_info);
    char model_json[sizeof(dev_info.model) * 6];
    char hardware_json[sizeof(dev_info.hardware_version) * 6];
    char software_json[sizeof(dev_info.software_version) * 6];
    if (!wattpost_json_escape(model_json, sizeof(model_json), dev_info.valid ? dev_info.model : "") ||
        !wattpost_json_escape(hardware_json, sizeof(hardware_json),
                              dev_info.valid ? dev_info.hardware_version : "") ||
        !wattpost_json_escape(software_json, sizeof(software_json),
                              dev_info.valid ? dev_info.software_version : "")) {
        return json_response_too_large(request);
    }

    jk_bms_data_t data = {0};
    jk_bms_ble_get_data(&data);

    jk_bms_settings_t settings = {0};
    jk_bms_ble_get_settings(&settings);

    temp_capabilities_t caps;
    temperature_resolve_capabilities(&dev_info, &data, &settings, &caps);

    char response[384];
    char manual_mask_str[16];
    if (manual_mask >= 0) {
        snprintf(manual_mask_str, sizeof(manual_mask_str), "%d", manual_mask);
    } else {
        snprintf(manual_mask_str, sizeof(manual_mask_str), "null");
    }

    size_t used = 0;
    if (!wattpost_json_appendf(
            response, sizeof(response), &used,
            "{\"mode\":\"%s\",\"manual_mask\":%s,\"resolved_mask\":%u,\"resolution_source\":\"%s\","
            "\"protocol_family\":\"%s\",\"semantic_profile\":\"%s\","
            "\"model\":\"%s\",\"hardware\":\"%s\",\"software\":\"%s\"}",
            temp_mode_to_str(mode), manual_mask_str, caps.resolved_mask,
            temp_res_source_to_str(caps.resolution_source),
            protocol_family_to_str(caps.protocol_family),
            semantic_profile_to_str(caps.semantic_profile),
            model_json, hardware_json, software_json)) {
        return json_response_too_large(request);
    }


    httpd_resp_set_type(request, "application/json");
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    return httpd_resp_sendstr(request, response);
}

static esp_err_t temperature_config_post_handler(httpd_req_t *request) {
    if (!local_mutation_request_allowed(request)) {
        return ESP_OK;
    }
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");

    char body[128];
    const int total = request->content_len;
    if (total <= 0 || total >= (int) sizeof(body)) {
        httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "Некоректний розмір запиту");
        return ESP_FAIL;
    }
    int received = httpd_req_recv(request, body, total);
    if (received <= 0) {
        httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "Помилка читання");
        return ESP_FAIL;
    }
    body[received] = '\0';

    temp_detection_mode_t mode = TEMP_MODE_AUTO;
    int8_t mask = -1;

    if (strstr(body, "\"mode\":\"manual\"") || strstr(body, "\"mode\": \"manual\"")) {
        mode = TEMP_MODE_MANUAL;
        const char *mask_ptr = strstr(body, "\"mask\":");
        if (!mask_ptr) mask_ptr = strstr(body, "\"mask\" :");
        if (mask_ptr) {
            mask_ptr += 7;
            while (*mask_ptr == ' ' || *mask_ptr == ':') mask_ptr++;
            int val = atoi(mask_ptr);
            if (val >= 0 && val <= 63) {
                mask = (int8_t) val;
            } else {
                httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "Маска має бути в межах 0..63");
                return ESP_FAIL;
            }
        } else {
            httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "Потрібно вказати mask (0..63)");
            return ESP_FAIL;
        }
    } else if (strstr(body, "\"mode\":\"auto\"") || strstr(body, "\"mode\": \"auto\"")) {
        mode = TEMP_MODE_AUTO;
        mask = -1;
    } else {
        httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "Невідомий mode. Дозволено auto або manual");
        return ESP_FAIL;
    }

    if (!temperature_config_set_mode(mode, mask)) {
        httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "Не вдалося зберегти налаштування");
        return ESP_FAIL;
    }

    return temperature_config_get_handler(request);
}

static void start_server(void) {
    if (server != NULL) {
        return;
    }

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.max_uri_handlers = 29;
    config.stack_size = 8192;
    config.lru_purge_enable = true;
    config.send_wait_timeout = 20;
    config.uri_match_fn = httpd_uri_match_wildcard;
    ESP_ERROR_CHECK(httpd_start(&server, &config));

    const httpd_uri_t live = {
        .uri = "/api/live",
        .method = HTTP_GET,
        .handler = live_handler,
    };
    const httpd_uri_t history = {
        .uri = "/api/history",
        .method = HTTP_GET,
        .handler = history_handler,
    };
    const httpd_uri_t settings = {
        .uri = "/api/settings",
        .method = HTTP_GET,
        .handler = settings_handler,
    };
    const httpd_uri_t ota = {
        .uri = "/api/ota",
        .method = HTTP_POST,
        .handler = ota_handler,
    };
    const httpd_uri_t temp_config_get = {
        .uri = "/api/config/temperature",
        .method = HTTP_GET,
        .handler = temperature_config_get_handler,
    };
    const httpd_uri_t temp_config_post = {
        .uri = "/api/config/temperature",
        .method = HTTP_POST,
        .handler = temperature_config_post_handler,
    };
    const httpd_uri_t request_token_uri = {
        .uri = "/api/device/request-token",
        .method = HTTP_GET,
        .handler = request_token_handler,
    };
    const httpd_uri_t device_status_uri = {
        .uri = "/api/device/status",
        .method = HTTP_GET,
        .handler = device_status_handler,
    };
    const httpd_uri_t wifi_scan_post = {
        .uri = "/api/device/wifi/scan",
        .method = HTTP_POST,
        .handler = wifi_scan_start_handler,
    };
    const httpd_uri_t wifi_scan_get = {
        .uri = "/api/device/wifi/scan",
        .method = HTTP_GET,
        .handler = wifi_scan_get_handler,
    };
    const httpd_uri_t wifi_configure_post = {
        .uri = "/api/device/wifi/configure",
        .method = HTTP_POST,
        .handler = wifi_configure_start_handler,
    };
    const httpd_uri_t wifi_reconnect_post = {
        .uri = "/api/device/wifi/reconnect",
        .method = HTTP_POST,
        .handler = wifi_reconnect_handler,
    };
    const httpd_uri_t wifi_reset_post = {
        .uri = "/api/device/wifi/reset",
        .method = HTTP_POST,
        .handler = wifi_reset_handler,
    };
    const httpd_uri_t setup_finish_post = {
        .uri = "/api/device/setup/finish",
        .method = HTTP_POST,
        .handler = setup_finish_without_bms_handler,
    };
    const httpd_uri_t bms_scan_post = {
        .uri = "/api/device/bms/scan",
        .method = HTTP_POST,
        .handler = bms_scan_start_handler,
    };
    const httpd_uri_t bms_scan_get = {
        .uri = "/api/device/bms/scan",
        .method = HTTP_GET,
        .handler = bms_scan_get_handler,
    };
    const httpd_uri_t bms_select_post = {
        .uri = "/api/device/bms/select",
        .method = HTTP_POST,
        .handler = bms_select_start_handler,
    };
    const httpd_uri_t bms_reconnect_post = {
        .uri = "/api/device/bms/reconnect",
        .method = HTTP_POST,
        .handler = bms_reconnect_handler,
    };
    const httpd_uri_t bms_forget_post = {
        .uri = "/api/device/bms/forget",
        .method = HTTP_POST,
        .handler = bms_forget_handler,
    };
    const httpd_uri_t firmware_update_get = {
        .uri = "/api/device/ota",
        .method = HTTP_GET,
        .handler = firmware_update_status_handler,
    };
    const httpd_uri_t firmware_update_preferences_put = {
        .uri = "/api/device/ota/preferences",
        .method = HTTP_PUT,
        .handler = firmware_update_preferences_handler,
    };
    const httpd_uri_t firmware_update_install_post = {
        .uri = "/api/device/ota/install",
        .method = HTTP_POST,
        .handler = firmware_update_install_handler,
    };
    const httpd_uri_t cloud_pair_post = {
        .uri = "/api/device/cloud/pair",
        .method = HTTP_POST,
        .handler = cloud_pair_start_handler,
    };
    const httpd_uri_t cloud_disconnect_post = {
        .uri = "/api/device/cloud/disconnect",
        .method = HTTP_POST,
        .handler = cloud_disconnect_handler,
    };
    const httpd_uri_t system_reboot_post = {
        .uri = "/api/device/system/reboot",
        .method = HTTP_POST,
        .handler = system_reboot_handler,
    };
    const httpd_uri_t system_factory_reset_post = {
        .uri = "/api/device/system/factory-reset",
        .method = HTTP_POST,
        .handler = system_factory_reset_handler,
    };
    const httpd_uri_t diagnostics_uri = {
        .uri = "/api/diagnostics",
        .method = HTTP_GET,
        .handler = diagnostics_handler,
    };
    const httpd_uri_t coredump_uri = {
        .uri = "/api/diagnostics/coredump",
        .method = HTTP_GET,
        .handler = coredump_download_handler,
    };
    const httpd_uri_t web = {
        .uri = "*",
        .method = HTTP_GET,
        .handler = web_asset_handler,
    };
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &live));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &history));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &settings));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &ota));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &temp_config_get));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &temp_config_post));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &request_token_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &device_status_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &wifi_scan_post));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &wifi_scan_get));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &wifi_configure_post));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &wifi_reconnect_post));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &wifi_reset_post));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &setup_finish_post));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &bms_scan_post));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &bms_scan_get));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &bms_select_post));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &bms_reconnect_post));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &bms_forget_post));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &firmware_update_get));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &firmware_update_preferences_put));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &firmware_update_install_post));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &cloud_pair_post));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &cloud_disconnect_post));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &system_reboot_post));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &system_factory_reset_post));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &diagnostics_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &coredump_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &web));

    ESP_LOGI(TAG, "Веб-сервер запущено");
}

static bool start_mdns(void) {
    if (mdns_started) {
        return true;
    }

    esp_err_t err = mdns_init();
    if (err == ESP_OK) {
        err = mdns_hostname_set("BMS");
    }
    if (err == ESP_OK) {
        err = mdns_instance_name_set("WattPost Mini");
    }
    if (err == ESP_OK) {
        err = mdns_service_add(NULL, "_http", "_tcp", 80, NULL, 0);
    }
    if (err == ESP_OK && wifi_netif != NULL) {
        err = mdns_netif_action(wifi_netif, MDNS_EVENT_ANNOUNCE_IP4);
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Не вдалося запустити mDNS: %s", esp_err_to_name(err));
        mdns_free();
        mdns_started = false;
        return false;
    }

    const int64_t now = esp_timer_get_time();
    mdns_started = true;
    mdns_last_start_us = now;
    mdns_last_announce_us = now;
    ESP_LOGI(TAG, "mDNS: http://BMS.local/");
    return true;
}

static bool restart_mdns(const char *reason) {
    ESP_LOGW(TAG, "Відновлення mDNS: %s", reason);
    if (mdns_started) {
        mdns_free();
        mdns_started = false;
    }

    if (!start_mdns()) {
        mdns_pending_reason = reason;
        mdns_recovery_pending = true;
        return false;
    }

    ++mdns_recovery_count;
    mdns_last_recovery_reason = reason;
    mdns_pending_reason = "none";
    mdns_recovery_pending = false;
    return true;
}

static void maintain_mdns(void) {
    if (!wifi_has_ip || wifi_netif == NULL) {
        return;
    }

    if (mdns_recovery_pending) {
        restart_mdns(mdns_pending_reason);
        return;
    }

    if (!mdns_started) {
        start_mdns();
        return;
    }

    if (wattpost_mdns_refresh_due(monotonic_age_seconds(mdns_last_start_us))) {
        restart_mdns("periodic_refresh");
        return;
    }

    if (!wattpost_mdns_announce_due(monotonic_age_seconds(mdns_last_announce_us))) {
        return;
    }

    esp_err_t err = mdns_netif_action(wifi_netif, MDNS_EVENT_ANNOUNCE_IP4);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "mDNS announce не виконано: %s", esp_err_to_name(err));
        restart_mdns("announce_failed");
        return;
    }

    mdns_last_announce_us = esp_timer_get_time();
    ++mdns_announce_count;
}

static const char *internet_reachability_runtime_state(void) {
    if (!wifi_has_ip) {
        return "unknown";
    }

    wattpost_internet_state_t state;
    portENTER_CRITICAL(&internet_reachability_lock);
    state = internet_reachability_state;
    portEXIT_CRITICAL(&internet_reachability_lock);
    return wattpost_internet_state_str(state);
}

static void internet_reachability_network_changed(bool has_ip) {
    TaskHandle_t task = NULL;

    portENTER_CRITICAL(&internet_reachability_lock);
    ++internet_reachability_generation;
    internet_reachability_state = WATTPOST_INTERNET_UNKNOWN;
    task = internet_reachability_task_handle;
    portEXIT_CRITICAL(&internet_reachability_lock);

    if (has_ip && task != NULL) {
        xTaskNotifyGive(task);
    }
}

static bool internet_reachability_send_all(
    int socket_fd,
    const char *data,
    size_t length) {
    size_t sent = 0u;
    while (sent < length) {
        const int rc = send(socket_fd, data + sent, length - sent, 0);
        if (rc <= 0) {
            return false;
        }
        sent += (size_t) rc;
    }
    return true;
}

static wattpost_internet_state_t internet_reachability_probe(void) {
    struct addrinfo hints = {
        .ai_family = AF_INET,
        .ai_socktype = SOCK_STREAM,
    };
    struct addrinfo *addresses = NULL;
    if (getaddrinfo(
            WATTPOST_INTERNET_PROBE_HOST,
            WATTPOST_INTERNET_PROBE_PORT,
            &hints,
            &addresses) != 0 ||
        addresses == NULL) {
        return WATTPOST_INTERNET_UNREACHABLE;
    }

    int socket_fd = -1;
    for (const struct addrinfo *address = addresses;
         address != NULL;
         address = address->ai_next) {
        socket_fd = socket(address->ai_family, address->ai_socktype, 0);
        if (socket_fd < 0) {
            continue;
        }

        const struct timeval timeout = {
            .tv_sec = WATTPOST_INTERNET_PROBE_TIMEOUT_MS / 1000,
            .tv_usec =
                (WATTPOST_INTERNET_PROBE_TIMEOUT_MS % 1000) * 1000,
        };
        const int recv_timeout_rc = setsockopt(
            socket_fd,
            SOL_SOCKET,
            SO_RCVTIMEO,
            &timeout,
            sizeof(timeout));
        const int send_timeout_rc = setsockopt(
            socket_fd,
            SOL_SOCKET,
            SO_SNDTIMEO,
            &timeout,
            sizeof(timeout));
        if (recv_timeout_rc != 0 || send_timeout_rc != 0) {
            close(socket_fd);
            socket_fd = -1;
            continue;
        }

        if (connect(socket_fd, address->ai_addr, address->ai_addrlen) == 0) {
            break;
        }

        close(socket_fd);
        socket_fd = -1;
    }
    freeaddrinfo(addresses);

    if (socket_fd < 0) {
        return WATTPOST_INTERNET_UNREACHABLE;
    }

    static const char request[] =
        "HEAD " WATTPOST_INTERNET_PROBE_PATH " HTTP/1.1\r\n"
        "Host: " WATTPOST_INTERNET_PROBE_HOST "\r\n"
        "Connection: close\r\n"
        "User-Agent: WattPost-Reachability/1\r\n"
        "\r\n";

    char response[96] = {0};
    const bool sent = internet_reachability_send_all(
        socket_fd,
        request,
        sizeof(request) - 1u);
    const int received = sent
        ? recv(socket_fd, response, sizeof(response) - 1u, 0)
        : -1;
    close(socket_fd);

    int status = 0;
    const bool parsed =
        received > 0 &&
        sscanf(response, "HTTP/%*u.%*u %d", &status) == 1;
    memset(response, 0, sizeof(response));

    return wattpost_internet_probe_result(parsed, status);
}

static void internet_reachability_task(void *unused) {
    (void) unused;
    bool first_iteration = true;

    while (true) {
        if (!first_iteration) {
            ulTaskNotifyTake(
                pdTRUE,
                pdMS_TO_TICKS(WATTPOST_INTERNET_PROBE_INTERVAL_MS));
        }
        first_iteration = false;

        if (!wifi_has_ip) {
            continue;
        }

        uint32_t generation;
        portENTER_CRITICAL(&internet_reachability_lock);
        generation = internet_reachability_generation;
        portEXIT_CRITICAL(&internet_reachability_lock);

        const wattpost_internet_state_t result =
            internet_reachability_probe();

        bool committed = false;
        portENTER_CRITICAL(&internet_reachability_lock);
        if (generation == internet_reachability_generation && wifi_has_ip) {
            internet_reachability_state = result;
            committed = true;
        }
        portEXIT_CRITICAL(&internet_reachability_lock);

        if (committed) {
            ESP_LOGI(
                TAG,
                "Internet reachability: %s",
                wattpost_internet_state_str(result));
        }
    }
}

static bool wifi_station_ip_ready(void) {
    esp_netif_ip_info_t current = {0};
    return wifi_netif != NULL && esp_netif_is_netif_up(wifi_netif) &&
           esp_netif_get_ip_info(wifi_netif, &current) == ESP_OK &&
           current.ip.addr != 0;
}

static bool wifi_got_ip_event_is_current(const ip_event_got_ip_t *event) {
    esp_netif_ip_info_t current = {0};
    return event != NULL && wifi_netif != NULL && event->esp_netif == wifi_netif &&
           esp_netif_is_netif_up(wifi_netif) &&
           esp_netif_get_ip_info(wifi_netif, &current) == ESP_OK && current.ip.addr != 0 &&
           current.ip.addr == event->ip_info.ip.addr;
}

static void network_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_SCAN_DONE) {
        wifi_scan_handle_done((const wifi_event_sta_scan_done_t *) data);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        if (wifi_boot_action == WATTPOST_WIFI_BOOT_CONNECT_SAVED) {
            wifi_connecting = true;
            const esp_err_t err = esp_wifi_connect();
            if (err != ESP_OK) {
                wifi_connecting = false;
                wifi_runtime_error = true;
                ESP_LOGE(TAG, "Wi-Fi connect start failed: %s",
                         esp_err_to_name(err));
            }
        }
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_CONNECTED) {
        wifi_validation_handle_connected((const wifi_event_sta_connected_t *) data);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        ++wifi_disconnect_count;
        internet_reachability_network_changed(false);
        wattpost_cloud_transport_network_changed(false);
        const wifi_event_sta_disconnected_t *event = data;
        if (wifi_validation_handle_disconnect(
                event ? event->reason : WIFI_REASON_UNSPECIFIED)) {
            return;
        }
        if (wifi_has_ip || wifi_down_since_us <= 0) {
            wifi_down_since_us = esp_timer_get_time();
        }
        wifi_has_ip = false;

        if (wifi_rollback_pending_snapshot()) {
            wifi_rollback_handle_disconnect();
            return;
        }

        if (wifi_reconnect_active_snapshot()) {
            wifi_connecting = true;
            const esp_err_t err = esp_wifi_connect();
            if (err != ESP_OK) {
                wifi_connecting = false;
                wifi_runtime_error = true;
                ESP_LOGW(
                    TAG,
                    "Requested Wi-Fi reconnect retry failed: %s",
                    esp_err_to_name(err));
            }
            return;
        }

        if (wifi_scan_running) { wifi_connecting = false; return; }
        if (wifi_boot_action == WATTPOST_WIFI_BOOT_CONNECT_SAVED) {
            wifi_connecting = true;
            ESP_LOGW(TAG, "Wi-Fi втрачено, повторне підключення");
            const esp_err_t err = esp_wifi_connect();
            if (err != ESP_OK) {
                wifi_connecting = false;
                wifi_runtime_error = true;
                ESP_LOGE(TAG, "Wi-Fi reconnect start failed: %s",
                         esp_err_to_name(err));
            }
        } else {
            wifi_connecting = false;
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *event = data;
        if (!wifi_got_ip_event_is_current(event)) return;
        if (!wifi_validation_handle_got_ip()) {
            return;
        }
        wifi_rollback_handle_got_ip();
        if (wifi_reconnect_active_snapshot()) {
            wifi_reconnect_finish(WIFI_OPERATION_SUCCESS, NULL);
        }
        const bool reconnected = wifi_ever_had_ip && !wifi_has_ip;
        ESP_LOGI(TAG, "Адреса: " IPSTR, IP2STR(&event->ip_info.ip));
        if (reconnected) {
            ++wifi_reconnect_count;
            mdns_pending_reason = "wifi_reconnect";
            mdns_recovery_pending = true;
        }
        wifi_has_ip = true;
        wifi_connecting = false;
        wifi_runtime_error = false;
        wifi_ever_had_ip = true;
        internet_reachability_network_changed(true);
        wattpost_cloud_transport_network_changed(true);
        if (!sntp_started) {
            esp_sntp_setoperatingmode(ESP_SNTP_OPMODE_POLL);
            esp_sntp_setservername(0, "pool.ntp.org");
            esp_sntp_init();
            sntp_started = true;
        }
        start_server();
        if (!reconnected) {
            start_mdns();
        }
    }
}

static void history_task(void *unused) {
    while (true) {
        jk_bms_data_t data;
        if (jk_bms_ble_get_data(&data)) {
            jk_bms_device_info_t dev_info = {0};
            jk_bms_ble_get_device_info(&dev_info);
            jk_bms_settings_t settings = {0};
            jk_bms_ble_get_settings(&settings);
            temp_capabilities_t caps;
            temperature_resolve_capabilities(&dev_info, &data, &settings, &caps);
            wattpost_history_save_with_caps(&data, &caps);
        }
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}


static void maintain_bms_selection_persist(void) {
    jk_bms_ble_target_t target;
    uint32_t operation_generation = 0u;
    if (!jk_bms_ble_select_take_validated_target(
            &target,
            &operation_generation)) {
        return;
    }

    wattpost_device_config_t config = {0};
    bool persisted = false;
    if (load_device_config_for_mutation(&config) &&
        temperature_config_reset()) {
        wattpost_device_config_clear_bms(&config);
        config.bms_configured = true;
        config.bms_address_type = target.address_type;
        memcpy(
            config.bms_address,
            target.address,
            sizeof(config.bms_address));

        persisted =
            wattpost_device_config_validate(&config) &&
            wattpost_device_config_save(&config);
    }

    if (persisted) {
        device_config_status = WATTPOST_CONFIG_LOAD_OK;
        device_bms_configured = true;
        snprintf(
            bms_address_hint,
            sizeof(bms_address_hint),
            "...%02X:%02X",
            target.address[4],
            target.address[5]);
        bms_boot_action = WATTPOST_BMS_BOOT_CONNECT_SELECTED;
    }

    if (!jk_bms_ble_select_commit(
            operation_generation,
            persisted)) {
        ESP_LOGW(
            TAG,
            "BMS selection commit generation mismatch");
    } else if (persisted) {
        ESP_LOGI(
            TAG,
            "BMS selection persisted target=%s",
            bms_address_hint);
    } else {
        ESP_LOGE(
            TAG,
            "BMS selection validation succeeded but config save failed");
    }

    memset(&target, 0, sizeof(target));
    memset(&config, 0, sizeof(config));
}

static void request_physical_recovery(void) {
    bool notify = false;
    portENTER_CRITICAL(&physical_button_action_lock);
    if (!physical_factory_reset_requested && !physical_recovery_requested) {
        physical_recovery_requested = true;
        notify = true;
    }
    portEXIT_CRITICAL(&physical_button_action_lock);

    if (notify && recovery_task_handle != NULL) {
        xTaskNotifyGive(recovery_task_handle);
    }
}

static bool consume_physical_recovery(void) {
    bool requested = false;
    portENTER_CRITICAL(&physical_button_action_lock);
    if (physical_recovery_requested) {
        physical_recovery_requested = false;
        requested = true;
    }
    portEXIT_CRITICAL(&physical_button_action_lock);
    return requested;
}

static void defer_physical_recovery(void) {
    portENTER_CRITICAL(&physical_button_action_lock);
    if (!physical_factory_reset_requested) {
        physical_recovery_requested = true;
    }
    portEXIT_CRITICAL(&physical_button_action_lock);
}

static void request_physical_factory_reset(void) {
    bool notify = false;
    portENTER_CRITICAL(&physical_button_action_lock);
    physical_recovery_requested = false;
    if (!physical_factory_reset_requested) {
        physical_factory_reset_requested = true;
        notify = true;
    }
    portEXIT_CRITICAL(&physical_button_action_lock);

    if (notify && recovery_task_handle != NULL) {
        xTaskNotifyGive(recovery_task_handle);
    }
}

static bool consume_physical_factory_reset(void) {
    bool requested = false;
    portENTER_CRITICAL(&physical_button_action_lock);
    if (physical_factory_reset_requested) {
        physical_factory_reset_requested = false;
        requested = true;
    }
    portEXIT_CRITICAL(&physical_button_action_lock);
    return requested;
}

static void defer_physical_factory_reset(void) {
    portENTER_CRITICAL(&physical_button_action_lock);
    physical_recovery_requested = false;
    physical_factory_reset_requested = true;
    portEXIT_CRITICAL(&physical_button_action_lock);
}

static void boot_button_task(void *unused) {
    (void) unused;

    const gpio_config_t config = {
        .pin_bit_mask = 1ULL << WATTPOST_BOOT_BUTTON_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    const esp_err_t err = gpio_config(&config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "BOOT input init failed: %s", esp_err_to_name(err));
        boot_button_task_handle = NULL;
        vTaskDelete(NULL);
        return;
    }

    wattpost_boot_button_state_t state = {0};
    bool armed = false;
    ESP_LOGI(
        TAG,
        "BOOT input ready: Recovery >=%u ms, Factory Reset >=%u ms; action on release",
        (unsigned) WATTPOST_BOOT_RECOVERY_HOLD_MS,
        (unsigned) WATTPOST_BOOT_FACTORY_RESET_HOLD_MS);

    while (true) {
        const bool pressed = gpio_get_level(WATTPOST_BOOT_BUTTON_GPIO) == 0;

        /*
         * Never treat a level that was already low when the task started as a
         * runtime action. This preserves the ROM GPIO0 boot strap/download mode.
         */
        if (!armed) {
            if (!pressed) {
                armed = true;
                memset(&state, 0, sizeof(state));
            }
        } else {
            const wattpost_boot_button_action_t action =
                wattpost_boot_button_update(
                    &state,
                    pressed,
                    WATTPOST_BOOT_BUTTON_POLL_MS);
            if (action == WATTPOST_BOOT_BUTTON_ACTION_RECOVERY) {
                ESP_LOGW(TAG, "BOOT hold released; requesting Wi-Fi Recovery Portal");
                request_physical_recovery();
            } else if (action == WATTPOST_BOOT_BUTTON_ACTION_FACTORY_RESET) {
                ESP_LOGW(TAG, "BOOT hold released; requesting full Factory Reset");
                request_physical_factory_reset();
            }
        }

        vTaskDelay(pdMS_TO_TICKS(WATTPOST_BOOT_BUTTON_POLL_MS));
    }
}

static void recovery_task(void *unused) {
    while (true) {
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(5000));
        if (consume_deferred_restart()) {
            vTaskDelay(pdMS_TO_TICKS(500));
            esp_restart();
        }

        if (consume_physical_factory_reset()) {
            uint32_t operation_generation = 0u;
            if (device_operation_busy_for_factory_reset() ||
                !system_action_reserve(
                    SYSTEM_ACTION_FACTORY_RESET,
                    &operation_generation)) {
                ESP_LOGW(TAG, "Physical Factory Reset deferred: operation busy");
                defer_physical_factory_reset();
            } else if (perform_full_factory_reset()) {
                ESP_LOGW(
                    TAG,
                    "Physical Factory Reset complete; restarting into First Setup");
                schedule_deferred_restart();
            } else {
                ESP_LOGE(TAG, "Physical Factory Reset failed");
                system_action_release();
            }
        }

        if (consume_physical_recovery()) {
            if (device_operation_busy_for_factory_reset()) {
                ESP_LOGW(TAG, "Physical Wi-Fi Recovery deferred: operation busy");
                defer_physical_recovery();
            } else if (!start_recovery_ap()) {
                ESP_LOGW(TAG, "Physical Wi-Fi Recovery unavailable in current state");
            }
        }

        maintain_bms_selection_persist();
        maintain_wifi_setup_preemption();
        start_pending_installed_wifi_validation();
        maintain_wifi_validation();
        maintain_wifi_rollback();
        maintain_wifi_reconnect_operation();
        maintain_first_setup_ap();
        maintain_recovery_ap();
        maintain_mdns();

        if (wattpost_bms_recovery_enabled(bms_boot_action) &&
            wattpost_bms_restart_due(jk_bms_ble_last_valid_frame_age())) {
            recovery_restart(RESTART_REASON_BMS_TIMEOUT);
        }
    }
}

static bool init_wifi_stack(bool create_ap) {
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    wifi_netif = esp_netif_create_default_wifi_sta();
    if (wifi_netif == NULL) {
        ESP_LOGE(TAG, "Failed to create Wi-Fi STA netif");
        wifi_runtime_error = true;
        return false;
    }
    ESP_ERROR_CHECK(esp_netif_set_hostname(wifi_netif, "BMS"));

    if (create_ap) {
        wifi_ap_netif = esp_netif_create_default_wifi_ap();
        if (wifi_ap_netif == NULL) {
            ESP_LOGE(TAG, "Failed to create provisioning AP netif");
            wifi_runtime_error = true;
            return false;
        }
    }

    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                               network_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                               network_event, NULL));
    return true;
}

static void start_wifi(const wattpost_device_config_t *device_config,
                       wattpost_config_load_result_t config_result) {
    wifi_boot_action =
        wattpost_wifi_boot_action(config_result, device_wifi_configured);
    ESP_LOGI(TAG, "Wi-Fi boot action: %s",
             wattpost_wifi_boot_action_str(wifi_boot_action));

    if (wifi_boot_action == WATTPOST_WIFI_BOOT_PROVISIONING_REQUIRED) {
        ESP_LOGW(TAG, "Wi-Fi config missing; First Setup path owns Wi-Fi");
        return;
    }
    if (wifi_boot_action == WATTPOST_WIFI_BOOT_CONFIG_ERROR) {
        ESP_LOGE(TAG, "Wi-Fi startup blocked by device config error");
        wifi_runtime_error = true;
        return;
    }
    if (!device_config || !device_config->wifi_configured) {
        ESP_LOGE(TAG, "Wi-Fi startup invariant failed: config unavailable");
        wifi_runtime_error = true;
        return;
    }
    if (!init_wifi_stack(false)) {
        return;
    }

    wifi_down_since_us = esp_timer_get_time();

    wifi_config_t config = {0};
    memcpy(config.sta.ssid, device_config->wifi_ssid,
           device_config->wifi_ssid_len);
    memcpy(config.sta.password, device_config->wifi_password,
           device_config->wifi_password_len);
    /*
     * Do not impose a WPA2-only threshold. Provisioning validates the target
     * network separately; OPEN here means "do not reject stronger auth modes".
     */
    config.sta.threshold.authmode = WIFI_AUTH_OPEN;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &config));
    wifi_sta_started = true;
    wifi_connecting = true;
    ESP_ERROR_CHECK(esp_wifi_start());
    wifi_driver_started = true;

    /* Remove the temporary driver-config copy from this stack frame. */
    memset(&config, 0, sizeof(config));
}

static bool start_first_setup_ap(void) {
    const char *setup_code = wattpost_setup_ap_code();
    if (!setup_code || strlen(setup_code) < 8u) {
        ESP_LOGE(TAG, "First Setup AP access code unavailable");
        return false;
    }
    if (!init_wifi_stack(true)) {
        return false;
    }

    uint8_t ap_mac[6] = {0};
    if (esp_wifi_get_mac(WIFI_IF_AP, ap_mac) != ESP_OK ||
        !wattpost_setup_ssid_from_mac(
            ap_mac, setup_ap_ssid, sizeof(setup_ap_ssid))) {
        ESP_LOGE(TAG, "First Setup AP identity unavailable");
        return false;
    }

    wifi_config_t ap_config = {0};
    strlcpy((char *) ap_config.ap.ssid, setup_ap_ssid,
            sizeof(ap_config.ap.ssid));
    ap_config.ap.ssid_len = strlen(setup_ap_ssid);
    strlcpy((char *) ap_config.ap.password, setup_code,
            sizeof(ap_config.ap.password));
    ap_config.ap.channel = 1;
    ap_config.ap.max_connection = 2;
    ap_config.ap.authmode = WIFI_AUTH_WPA2_PSK;

    wifi_boot_action = WATTPOST_WIFI_BOOT_PROVISIONING_REQUIRED;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap_config));
    if (!configure_captive_portal_dhcp(wifi_ap_netif)) {
        ESP_LOGW(TAG, "Captive portal DHCP option 114 unavailable; DNS/IP fallback remains");
    }
    ESP_ERROR_CHECK(esp_wifi_start());
    wifi_driver_started = true;

    first_setup_ap_active = true;
    first_setup_bms_deferred = false;
    first_setup_completed_us = 0;
    /* Provisioning mode transition invalidates any token generated at boot. */
    rotate_local_request_token();
    start_server();
    if (!wattpost_captive_dns_start(wifi_ap_netif)) {
        ESP_LOGW(TAG, "Captive DNS failed to start; direct AP IP remains available");
    }

    esp_netif_ip_info_t ip_info = {0};
    if (esp_netif_get_ip_info(wifi_ap_netif, &ip_info) == ESP_OK) {
        ESP_LOGI(TAG, "First Setup AP: %s, direct URL http://" IPSTR "/",
                 setup_ap_ssid, IP2STR(&ip_info.ip));
    } else {
        ESP_LOGI(TAG, "First Setup AP: %s", setup_ap_ssid);
    }

    memset(&ap_config, 0, sizeof(ap_config));
    return true;
}

static void maintain_first_setup_ap(void) {
    if (!first_setup_ap_active) return;
    if (wifi_validation_active_snapshot() || wifi_rollback_pending_snapshot() ||
        wifi_scan_running || first_setup_wifi_retry_required || !wifi_has_ip ||
        !wifi_station_ip_ready()) {
        first_setup_completed_us = 0;
        return;
    }

    /*
     * A blank device is already in an explicit provisioning mode. Do not let
     * a wall-clock deadline make it disappear while the user is reading the
     * wizard, choosing Wi-Fi or pairing the BMS. The bounded AP lifetime starts
     * only after First Setup is fully complete.
     */
    if (strcmp(device_setup_state(), "configured") != 0 &&
        !first_setup_bms_deferred) {
        first_setup_completed_us = 0;
        return;
    }
    /* Completed setup now follows installed-device Wi-Fi semantics. */
    provision_boot_action = WATTPOST_PROVISION_BOOT_NORMAL;
    if (first_setup_completed_us <= 0) {
        first_setup_completed_us = esp_timer_get_time();
        return;
    }
    if (!wattpost_setup_ap_timeout_due(
            monotonic_age_seconds(first_setup_completed_us))) {
        return;
    }

    ESP_LOGW(TAG, "First Setup completion grace expired; captive services disabled");

    esp_err_t err;
    if (device_wifi_configured && wifi_has_ip) {
        /*
         * Keep the validated home-network STA online. Stopping the whole Wi-Fi
         * driver here would drop the connection that First Setup just saved.
         */
        err = esp_wifi_set_mode(WIFI_MODE_STA);
        if (err != ESP_OK) {
            ESP_LOGE(
                TAG,
                "Failed to disable First Setup AP while preserving STA: %s",
                esp_err_to_name(err));
            return;
        }
    }

    wattpost_captive_dns_stop();
    first_setup_ap_active = false;
    first_setup_completed_us = 0;
}

static void recovery_restore_sta_after_ap_start_failure(void) {
    const esp_err_t mode_err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (mode_err != ESP_OK) {
        ESP_LOGE(
            TAG,
            "Recovery rollback failed to restore STA mode: %s",
            esp_err_to_name(mode_err));
        wifi_runtime_error = true;
        return;
    }

    const esp_err_t start_err = esp_wifi_start();
    if (start_err != ESP_OK) {
        ESP_LOGE(
            TAG,
            "Recovery rollback failed to restart STA: %s",
            esp_err_to_name(start_err));
        wifi_runtime_error = true;
        return;
    }

    wifi_driver_started = true;
    wifi_sta_started = true;
    wifi_connecting = true;
}

static bool start_recovery_ap(void) {
    if (recovery_ap_active) {
        return true;
    }
    if (first_setup_ap_active ||
        !device_wifi_configured ||
        wifi_boot_action != WATTPOST_WIFI_BOOT_CONNECT_SAVED ||
        !wifi_driver_started) {
        return false;
    }

    if (wifi_ap_netif == NULL) {
        wifi_ap_netif = esp_netif_create_default_wifi_ap();
        if (wifi_ap_netif == NULL) {
            ESP_LOGE(TAG, "Recovery AP netif creation failed");
            return false;
        }
    }

    const char *setup_code = wattpost_setup_ap_code();
    if (!setup_code || strlen(setup_code) < 8u) {
        ESP_LOGE(TAG, "Recovery AP access code unavailable");
        return false;
    }

    uint8_t ap_mac[6] = {0};
    if (esp_wifi_get_mac(WIFI_IF_AP, ap_mac) != ESP_OK ||
        !wattpost_setup_ssid_from_mac(
            ap_mac,
            setup_ap_ssid,
            sizeof(setup_ap_ssid))) {
        ESP_LOGE(TAG, "Recovery AP identity unavailable");
        return false;
    }

    wifi_config_t ap_config = {0};
    strlcpy(
        (char *) ap_config.ap.ssid,
        setup_ap_ssid,
        sizeof(ap_config.ap.ssid));
    ap_config.ap.ssid_len = strlen(setup_ap_ssid);
    strlcpy(
        (char *) ap_config.ap.password,
        setup_code,
        sizeof(ap_config.ap.password));
    ap_config.ap.channel = 1;
    ap_config.ap.max_connection = 2;
    ap_config.ap.authmode = WIFI_AUTH_WPA2_PSK;

    const esp_err_t stop_err = esp_wifi_stop();
    if (stop_err != ESP_OK) {
        ESP_LOGE(
            TAG,
            "Recovery AP failed to pause STA: %s",
            esp_err_to_name(stop_err));
        memset(&ap_config, 0, sizeof(ap_config));
        return false;
    }
    wifi_driver_started = false;

    esp_err_t err = esp_wifi_set_mode(WIFI_MODE_APSTA);
    if (err == ESP_OK) {
        err = esp_wifi_set_config(WIFI_IF_AP, &ap_config);
    }
    if (err == ESP_OK && !configure_captive_portal_dhcp(wifi_ap_netif)) {
        ESP_LOGW(
            TAG,
            "Recovery captive DHCP option unavailable; DNS/IP fallback remains");
    }
    memset(&ap_config, 0, sizeof(ap_config));

    if (err != ESP_OK) {
        ESP_LOGE(
            TAG,
            "Recovery AP configuration failed: %s",
            esp_err_to_name(err));
        recovery_restore_sta_after_ap_start_failure();
        return false;
    }

    portENTER_CRITICAL(&wifi_scan_lock);
    recovery_completion_pending = false;
    recovery_completed_us = 0;
    portEXIT_CRITICAL(&wifi_scan_lock);
    recovery_ap_active = true;

    err = esp_wifi_start();
    if (err != ESP_OK) {
        ESP_LOGE(
            TAG,
            "Recovery AP failed to start: %s",
            esp_err_to_name(err));
        recovery_ap_active = false;
        recovery_restore_sta_after_ap_start_failure();
        return false;
    }

    wifi_driver_started = true;
    wifi_sta_started = true;
    wifi_connecting = true;

    /* Recovery transition invalidates tokens issued on the home LAN. */
    rotate_local_request_token();
    start_server();
    if (!wattpost_captive_dns_start(wifi_ap_netif)) {
        ESP_LOGW(
            TAG,
            "Recovery captive DNS failed; direct AP IP remains available");
    }

    esp_netif_ip_info_t ip_info = {0};
    if (esp_netif_get_ip_info(wifi_ap_netif, &ip_info) == ESP_OK) {
        ESP_LOGW(
            TAG,
            "Recovery AP active: %s, direct URL http://" IPSTR "/",
            setup_ap_ssid,
            IP2STR(&ip_info.ip));
    } else {
        ESP_LOGW(TAG, "Recovery AP active: %s", setup_ap_ssid);
    }
    return true;
}

static bool stop_recovery_ap(const char *reason) {
    if (!recovery_ap_active) {
        return true;
    }

    const esp_err_t err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (err != ESP_OK) {
        ESP_LOGE(
            TAG,
            "Failed to disable Recovery AP: %s",
            esp_err_to_name(err));
        return false;
    }

    wattpost_captive_dns_stop();
    recovery_ap_active = false;
    portENTER_CRITICAL(&wifi_scan_lock);
    recovery_completion_pending = false;
    recovery_completed_us = 0;
    portEXIT_CRITICAL(&wifi_scan_lock);
    rotate_local_request_token();

    ESP_LOGI(
        TAG,
        "Recovery AP disabled: %s",
        reason ? reason : "completed");
    return true;
}

static void maintain_recovery_ap(void) {
    if (!recovery_ap_active) {
        return;
    }

    bool completion_pending = false;
    int64_t completed_us = 0;
    portENTER_CRITICAL(&wifi_scan_lock);
    completion_pending = recovery_completion_pending;
    completed_us = recovery_completed_us;
    portEXIT_CRITICAL(&wifi_scan_lock);

    /*
     * Recovery is a user-controlled access path and has no idle timeout.
     * Close it only after a Wi-Fi action started from Recovery actually
     * succeeds, with a short handoff grace so the portal can show success.
     */
    if (completion_pending &&
        completed_us > 0 &&
        monotonic_age_seconds(completed_us) >=
            WATTPOST_RECOVERY_SUCCESS_GRACE_SECONDS) {
        stop_recovery_ap("wifi_restored");
    }
}

static bool start_bms(const wattpost_device_config_t *device_config,
                      wattpost_config_load_result_t config_result) {
    bms_boot_action =
        wattpost_bms_boot_action(config_result, device_bms_configured);
    ESP_LOGI(TAG, "BMS boot action: %s%s%s",
             wattpost_bms_boot_action_str(bms_boot_action),
             device_bms_configured ? " target=" : "",
             device_bms_configured ? bms_address_hint : "");

    jk_bms_ble_target_t target = {0};
    const jk_bms_ble_target_t *target_ptr = NULL;
    if (bms_boot_action == WATTPOST_BMS_BOOT_CONNECT_SELECTED) {
        if (!device_config || !device_config->bms_configured) {
            ESP_LOGE(TAG, "BMS startup invariant failed: target unavailable");
            bms_boot_action = WATTPOST_BMS_BOOT_CONFIG_ERROR;
            return jk_bms_ble_start(NULL);
        }
        target.address_type = device_config->bms_address_type;
        memcpy(target.address, device_config->bms_address,
               sizeof(target.address));
        target_ptr = &target;
    }

    const bool started = jk_bms_ble_start(target_ptr);
    memset(&target, 0, sizeof(target));
    return started;
}

void app_main(void) {
    const esp_err_t err = nvs_flash_init();
    if (err != ESP_OK) {
        /*
         * Once Stage 1 user configuration exists, a generic NVS init error
         * must never silently become a factory reset. Preserve flash contents
         * for diagnostics/recovery and fail explicitly instead.
         */
        ESP_LOGE(TAG, "NVS initialization failed: %s; automatic erase disabled",
                 esp_err_to_name(err));
        ESP_ERROR_CHECK(err);
    }

    wattpost_device_identity_t boot_identity;
    const wattpost_identity_result_t identity_result =
        wattpost_device_identity_init(&boot_identity);
    const bool cloud_identity_available =
        identity_result == WATTPOST_IDENTITY_OK ||
        identity_result == WATTPOST_IDENTITY_CREATED ||
        identity_result == WATTPOST_IDENTITY_RECOVERED;
    if (identity_result == WATTPOST_IDENTITY_OK ||
        identity_result == WATTPOST_IDENTITY_CREATED) {
        ESP_LOGI(TAG, "Device identity: %s",
                 wattpost_device_identity_result_str(identity_result));
    } else if (identity_result == WATTPOST_IDENTITY_RECOVERED) {
        ESP_LOGW(TAG, "Device identity: recovered from redundant storage");
    } else {
        /*
         * Cloud identity failure must not block local BLE/History/Setup.
         * A later Cloud transport will remain unavailable until identity
         * storage is repaired; never regenerate corrupt identity silently.
         */
        ESP_LOGE(TAG, "Device identity unavailable: %s",
                 wattpost_device_identity_result_str(identity_result));
    }
    memset(&boot_identity, 0, sizeof(boot_identity));

    ESP_LOGI(TAG, "WattPost Mini %s build %s", WATTPOST_FIRMWARE_VERSION, WATTPOST_BUILD_ID);
    last_restart_reason = detect_restart_reason();
    rotate_local_request_token();

    wattpost_device_config_t boot_device_config;
    const wattpost_config_load_result_t config_result =
        load_device_config_snapshot(&boot_device_config);

    init_persistent_diagnostics();
    temperature_resolver_init();
    if (!wattpost_history_init()) {
        ESP_LOGE(TAG, "History initialization failed");
    }

    provision_boot_action = wattpost_provision_boot_action(
        config_result, device_wifi_configured);
    ESP_LOGI(TAG, "Provisioning boot action: %s",
             wattpost_provision_boot_action_str(provision_boot_action));

    if (provision_boot_action == WATTPOST_PROVISION_BOOT_NORMAL) {
        start_wifi(&boot_device_config, config_result);
    } else if (provision_boot_action == WATTPOST_PROVISION_BOOT_FIRST_SETUP) {
        if (!start_first_setup_ap()) {
            ESP_LOGE(TAG, "First Setup AP failed to start");
        }
    } else {
        ESP_LOGE(TAG, "First Setup blocked by device config error");
    }

    if (!start_bms(&boot_device_config, config_result)) {
        ESP_LOGW(TAG, "BLE startup did not start; continuing without active BMS transport");
    }

    /* Wi-Fi password and full BMS address are no longer needed in app_main. */
    memset(&boot_device_config, 0, sizeof(boot_device_config));
    if (xTaskCreate(
            history_task,
            "history",
            5120,
            NULL,
            4,
            &history_task_handle) != pdPASS) {
        history_task_handle = NULL;
        ESP_LOGW(TAG, "History task unavailable");
    }
    if (xTaskCreate(
            internet_reachability_task,
            "internet_probe",
            4096,
            NULL,
            3,
            &internet_reachability_task_handle) != pdPASS) {
        internet_reachability_task_handle = NULL;
        ESP_LOGW(TAG, "Internet reachability task unavailable");
    }
    wattpost_cloud_transport_set_telemetry_provider(
        cloud_telemetry_snapshot);
    wattpost_cloud_transport_set_settings_provider(
        cloud_settings_snapshot);
    if (cloud_identity_available) {
        if (!wattpost_cloud_transport_start(wifi_has_ip)) {
            ESP_LOGW(TAG, "Cloud transport task unavailable; local operation continues");
        }
    } else {
        ESP_LOGW(TAG, "Cloud transport disabled: device identity unavailable");
    }
    xTaskCreate(
        recovery_task,
        "recovery",
        4096,
        NULL,
        4,
        &recovery_task_handle);
    if (xTaskCreate(
            boot_button_task,
            "boot_button",
            3072,
            NULL,
            3,
            &boot_button_task_handle) != pdPASS) {
        boot_button_task_handle = NULL;
        ESP_LOGW(TAG, "BOOT button task unavailable");
    }
    xTaskCreate(ota_validation_task, "ota_validate", 2048, NULL, 3, NULL);


}
