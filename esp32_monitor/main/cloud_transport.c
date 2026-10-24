#include "cloud_transport.h"

#include <ctype.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "cloud_history_format.h"
#include "cloud_transport_format.h"
#include "cloud_transport_policy.h"
#include "history.h"
#include "history_query.h"
#include "jk_bms_ble.h"
#include "device_identity.h"
#include "remote_ota.h"

#include "esp_crt_bundle.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"
#include "wattpost_build.h"

#define CLOUD_BASE_URL "https://wattpost.pp.ua"
#define CLOUD_HELLO_URL CLOUD_BASE_URL "/api/v1/device/hello"
#define CLOUD_TELEMETRY_URL CLOUD_BASE_URL "/api/v1/device/telemetry"
#define CLOUD_HISTORY_URL CLOUD_BASE_URL "/api/v1/device/history"
#define CLOUD_HISTORY_STATUS_URL CLOUD_BASE_URL "/api/v1/device/history/status"
#define CLOUD_SETTINGS_URL CLOUD_BASE_URL "/api/v1/device/settings"
#define CLOUD_BMS_COMMAND_URL CLOUD_BASE_URL "/api/v1/device/bms/command"
#define CLOUD_BMS_RESULT_URL CLOUD_BASE_URL "/api/v1/device/bms/result"
#define CLOUD_OTA_URL CLOUD_BASE_URL "/api/v1/device/ota"
#define CLOUD_OTA_INSTALL_URL CLOUD_BASE_URL "/api/v1/device/ota/install"
#define CLOUD_OTA_STATUS_URL CLOUD_BASE_URL "/api/v1/device/ota/status"
#define CLOUD_OTA_PREFERENCES_URL CLOUD_BASE_URL "/api/v1/device/ota/preferences"
#define CLOUD_PAIRINGS_URL CLOUD_BASE_URL "/api/v1/device/pairings"
#define CLOUD_PAIRING_STATUS_URL_MAX_LEN 160u
#define CLOUD_PAIR_URL_PREFIX CLOUD_BASE_URL "/pair#token="
#define CLOUD_PAIR_TOKEN_LENGTH 43u
#define CLOUD_RESPONSE_MAX_LEN 768u
#define CLOUD_HTTP_TIMEOUT_MS 5000
#define CLOUD_TASK_STACK_BYTES 10240
#define CLOUD_TASK_PRIORITY 3
#define CLOUD_USER_AGENT "WattPost-ESP32/1"
#define CLOUD_PAIRING_POLL_INTERVAL_MS 2000u
#define CLOUD_TELEMETRY_INTERVAL_MS 5000u
#define CLOUD_HISTORY_INTERVAL_MS 15000u
#define CLOUD_SETTINGS_CHECK_INTERVAL_MS 15000u
#define CLOUD_SETTINGS_ATTEMPT_INTERVAL_MS 60000u
#define CLOUD_OTA_POLL_INTERVAL_MS 30000u
#define CLOUD_BMS_POLL_IDLE_MS 4000u
#define CLOUD_BMS_POLL_ACTIVE_MS 1500u
#define CLOUD_OTA_PREFERENCE_INTERVAL_MS 60000u
#define CLOUD_OTA_PREFERENCE_JSON_MAX_LEN 96u
#define CLOUD_OTA_DOWNLOAD_URL_MAX_LEN 192u
#define CLOUD_OTA_STATUS_JSON_MAX_LEN 192u
#define CLOUD_OTA_CHUNK_SIZE 1024u
#define CLOUD_OTA_MAX_CONSECUTIVE_READ_TIMEOUTS 3u
#define CLOUD_OTA_MAX_DOWNLOAD_ATTEMPTS 3u
#define CLOUD_OTA_RANGE_SIZE (64u * 1024u)
#define CLOUD_OTA_MAX_RANGE_REQUESTS 128u
#define CLOUD_OTA_MAX_NO_PROGRESS_RECONNECTS 3u
#define CLOUD_HISTORY_MIN_TIMESTAMP 1700000000u
#define CLOUD_SETTINGS_JSON_MAX_LEN 4096u
#define CLOUD_SETTINGS_BODY_PREFIX "{\"schema_version\":1,\"settings\":"

static const char *TAG = "wattpost-cloud";

typedef struct {
    char data[CLOUD_RESPONSE_MAX_LEN];
    size_t used;
    bool overflow;
} cloud_response_capture_t;

static portMUX_TYPE cloud_lock = portMUX_INITIALIZER_UNLOCKED;
static TaskHandle_t cloud_task_handle;
static bool cloud_network_available;
static bool cloud_disconnect_epoch_ready;
static uint32_t cloud_action_generation;
static uint32_t cloud_telemetry_sequence;
static wattpost_cloud_telemetry_provider_t cloud_telemetry_provider;
static wattpost_cloud_settings_provider_t cloud_settings_provider;
static char cloud_pairing_id[WATTPOST_CLOUD_PAIRING_ID_MAX_LEN];
/*
 * Telemetry, History and settings uploads are serialized by the single Cloud
 * task. Overlay their bounded payload buffers instead of reserving all three
 * permanently. This keeps network behavior unchanged and leaves Cloud OTA room
 * for a future streaming download without adding another long-lived buffer.
 */
typedef struct {
    bool supported;
    bool automatic_updates_valid;
    bool automatic_updates;
    bool pending;
    uint32_t pending_generation;
    bool pending_automatic_updates;
} cloud_ota_preference_sync_t;

typedef union {
    char telemetry[WATTPOST_CLOUD_TELEMETRY_JSON_MAX_LEN];
    char history[WATTPOST_CLOUD_HISTORY_JSON_MAX_LEN];
    char settings[CLOUD_SETTINGS_JSON_MAX_LEN];
    uint8_t ota_chunk[CLOUD_OTA_CHUNK_SIZE];
} cloud_json_scratch_t;
static cloud_json_scratch_t cloud_json_scratch;
static wattpost_cloud_history_formatter_t cloud_history_formatter;
static uint32_t cloud_history_cursor;
static bool cloud_history_cursor_ready;
static bool cloud_settings_force_resend;
static wattpost_cloud_transport_snapshot_t cloud_snapshot = {
    .state = WATTPOST_CLOUD_STATE_DISABLED,
    .last_http_status = 0,
    .last_esp_error = ESP_OK,
    .pairing_state = WATTPOST_CLOUD_PAIRING_NONE,
    .action_kind = WATTPOST_CLOUD_ACTION_NONE,
    .action_state = WATTPOST_CLOUD_ACTION_IDLE,
    .action_error = WATTPOST_CLOUD_ACTION_ERROR_NONE,
    .ota_automatic_updates = true,
    .ota_state = WATTPOST_CLOUD_OTA_IDLE,
};
static int64_t cloud_last_success_us;
static int64_t cloud_last_telemetry_success_us;
static int64_t cloud_last_hello_attempt_us;
static int64_t cloud_last_telemetry_attempt_us;
static int64_t cloud_last_history_attempt_us;
static int64_t cloud_last_settings_check_us;
static int64_t cloud_last_settings_attempt_us;
static int64_t cloud_last_settings_success_us;
static int64_t cloud_last_bms_poll_us;
typedef enum {
    CLOUD_BMS_NONE,
    CLOUD_BMS_SCAN,
    CLOUD_BMS_SELECT,
    CLOUD_BMS_RECONNECT
} cloud_bms_kind_t;
/* Only the Cloud task owns these fields; never transfer BLE MACs to Cloud. */
static cloud_bms_kind_t cloud_bms_kind;
static uint32_t cloud_bms_generation;
static uint32_t cloud_bms_ble_generation;
static bool cloud_bms_result_ready;
static bool cloud_bms_result_success;
static const char *cloud_bms_error;
static int64_t cloud_last_ota_poll_us;
static int64_t cloud_last_ota_preference_success_us;
static bool cloud_ota_manual_requested;
static bool cloud_ota_preference_force_report = true;
static uint32_t cloud_settings_fingerprint;
static size_t cloud_settings_fingerprint_length;
static bool cloud_settings_fingerprint_ready;

static uint32_t saturating_increment(uint32_t value) {
    return value == UINT32_MAX ? value : value + 1u;
}

static uint32_t next_generation(uint32_t value) {
    ++value;
    return value == 0u ? 1u : value;
}

static uint32_t age_seconds(int64_t timestamp_us) {
    if (timestamp_us <= 0) {
        return UINT32_MAX;
    }
    const int64_t now = esp_timer_get_time();
    if (now <= timestamp_us) {
        return 0u;
    }
    const uint64_t seconds = (uint64_t)(now - timestamp_us) / UINT64_C(1000000);
    return seconds > UINT32_MAX ? UINT32_MAX : (uint32_t) seconds;
}

static bool network_available_snapshot(void) {
    bool available;
    portENTER_CRITICAL(&cloud_lock);
    available = cloud_network_available;
    portEXIT_CRITICAL(&cloud_lock);
    return available;
}

static void set_runtime_state(
    wattpost_cloud_state_t state,
    uint32_t backoff_ms) {
    portENTER_CRITICAL(&cloud_lock);
    cloud_snapshot.state = state;
    cloud_snapshot.current_backoff_ms = backoff_ms;
    portEXIT_CRITICAL(&cloud_lock);
}

static void update_stack_high_water(void) {
    const uint32_t free_bytes =
        (uint32_t) uxTaskGetStackHighWaterMark(NULL);
    portENTER_CRITICAL(&cloud_lock);
    if (cloud_snapshot.stack_free_min_bytes == 0u ||
        free_bytes < cloud_snapshot.stack_free_min_bytes) {
        cloud_snapshot.stack_free_min_bytes = free_bytes;
    }
    portEXIT_CRITICAL(&cloud_lock);
}

static void record_attempt_start(uint32_t heap_free, uint32_t largest_free) {
    portENTER_CRITICAL(&cloud_lock);
    cloud_snapshot.attempts = saturating_increment(cloud_snapshot.attempts);
    cloud_snapshot.heap_free_before_last = heap_free;
    cloud_snapshot.largest_free_before_last = largest_free;
    cloud_snapshot.last_http_status = 0;
    cloud_snapshot.last_esp_error = ESP_OK;
    portEXIT_CRITICAL(&cloud_lock);
}

static void record_attempt_result(
    bool success,
    esp_err_t error,
    int http_status,
    uint32_t heap_free,
    uint32_t largest_free,
    uint32_t backoff_ms) {
    const int64_t success_time_us =
        success ? esp_timer_get_time() : 0;
    portENTER_CRITICAL(&cloud_lock);
    cloud_snapshot.heap_free_after_last = heap_free;
    cloud_snapshot.largest_free_after_last = largest_free;
    cloud_snapshot.last_http_status = http_status;
    cloud_snapshot.last_esp_error = (int32_t) error;
    cloud_snapshot.current_backoff_ms = backoff_ms;
    if (success) {
        cloud_snapshot.successes = saturating_increment(cloud_snapshot.successes);
        cloud_snapshot.state = WATTPOST_CLOUD_STATE_ONLINE;
        cloud_last_success_us = success_time_us;
    } else {
        cloud_snapshot.failures = saturating_increment(cloud_snapshot.failures);
        cloud_snapshot.state = WATTPOST_CLOUD_STATE_BACKOFF;
    }
    portEXIT_CRITICAL(&cloud_lock);
}

static void record_telemetry_attempt(void) {
    portENTER_CRITICAL(&cloud_lock);
    cloud_snapshot.telemetry_attempts =
        saturating_increment(cloud_snapshot.telemetry_attempts);
    portEXIT_CRITICAL(&cloud_lock);
}

static void record_telemetry_result(bool success, uint32_t sample_seq) {
    const int64_t success_time_us =
        success ? esp_timer_get_time() : 0;
    portENTER_CRITICAL(&cloud_lock);
    if (success) {
        cloud_snapshot.telemetry_successes =
            saturating_increment(cloud_snapshot.telemetry_successes);
        cloud_snapshot.telemetry_last_sample_seq = sample_seq;
        cloud_last_telemetry_success_us = success_time_us;
    } else {
        cloud_snapshot.telemetry_failures =
            saturating_increment(cloud_snapshot.telemetry_failures);
    }
    portEXIT_CRITICAL(&cloud_lock);
}

static void record_history_attempt(void) {
    portENTER_CRITICAL(&cloud_lock);
    cloud_snapshot.history_attempts =
        saturating_increment(cloud_snapshot.history_attempts);
    portEXIT_CRITICAL(&cloud_lock);
}

static void record_history_result(bool success, uint16_t records_sent) {
    portENTER_CRITICAL(&cloud_lock);
    if (success) {
        cloud_snapshot.history_successes =
            saturating_increment(cloud_snapshot.history_successes);
        if (UINT32_MAX - cloud_snapshot.history_records_sent < records_sent) {
            cloud_snapshot.history_records_sent = UINT32_MAX;
        } else {
            cloud_snapshot.history_records_sent += records_sent;
        }
    } else {
        cloud_snapshot.history_failures =
            saturating_increment(cloud_snapshot.history_failures);
    }
    portEXIT_CRITICAL(&cloud_lock);
}

static void record_settings_attempt(void) {
    portENTER_CRITICAL(&cloud_lock);
    cloud_snapshot.settings_attempts =
        saturating_increment(cloud_snapshot.settings_attempts);
    portEXIT_CRITICAL(&cloud_lock);
}

static void record_settings_result(bool success) {
    const int64_t success_time_us = success ? esp_timer_get_time() : 0;
    portENTER_CRITICAL(&cloud_lock);
    if (success) {
        cloud_snapshot.settings_successes =
            saturating_increment(cloud_snapshot.settings_successes);
        cloud_last_settings_success_us = success_time_us;
    } else {
        cloud_snapshot.settings_failures =
            saturating_increment(cloud_snapshot.settings_failures);
    }
    portEXIT_CRITICAL(&cloud_lock);
}

static void response_capture_reset(cloud_response_capture_t *capture) {
    if (!capture) {
        return;
    }
    memset(capture, 0, sizeof(*capture));
}

static esp_err_t cloud_http_event(esp_http_client_event_t *event) {
    if (!event || event->event_id != HTTP_EVENT_ON_DATA ||
        !event->user_data || !event->data || event->data_len <= 0) {
        return ESP_OK;
    }

    cloud_response_capture_t *capture = event->user_data;
    const size_t data_len = (size_t) event->data_len;
    if (capture->used + data_len >= sizeof(capture->data)) {
        capture->overflow = true;
        return ESP_OK;
    }

    memcpy(capture->data + capture->used, event->data, data_len);
    capture->used += data_len;
    capture->data[capture->used] = '\0';
    return ESP_OK;
}

static bool safe_pairing_id(const char *value) {
    if (!value) {
        return false;
    }
    const size_t length = strlen(value);
    if (length == 0u || length >= WATTPOST_CLOUD_PAIRING_ID_MAX_LEN) {
        return false;
    }
    for (size_t i = 0; i < length; ++i) {
        const unsigned char c = (unsigned char) value[i];
        if (!(isalnum(c) || c == '-')) {
            return false;
        }
    }
    return true;
}

static bool safe_pair_url(const char *value) {
    if (!value) {
        return false;
    }
    const size_t prefix_len = strlen(CLOUD_PAIR_URL_PREFIX);
    if (strncmp(value, CLOUD_PAIR_URL_PREFIX, prefix_len) != 0) {
        return false;
    }
    const char *token = value + prefix_len;
    if (strlen(token) != CLOUD_PAIR_TOKEN_LENGTH) {
        return false;
    }
    for (size_t i = 0; i < CLOUD_PAIR_TOKEN_LENGTH; ++i) {
        const unsigned char c = (unsigned char) token[i];
        if (!(isalnum(c) || c == '-' || c == '_')) {
            return false;
        }
    }
    return true;
}

static bool parse_success_data(
    const cloud_response_capture_t *capture,
    cJSON **root_out,
    cJSON **data_out) {
    if (!capture || capture->overflow || capture->used == 0u ||
        !root_out || !data_out) {
        return false;
    }

    cJSON *root = cJSON_ParseWithLengthOpts(
        capture->data, capture->used + 1u, NULL, true);
    if (!root || !cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return false;
    }

    const cJSON *ok = cJSON_GetObjectItemCaseSensitive(root, "ok");
    cJSON *data = cJSON_GetObjectItemCaseSensitive(root, "data");
    if (!cJSON_IsTrue(ok) || !cJSON_IsObject(data)) {
        cJSON_Delete(root);
        return false;
    }

    *root_out = root;
    *data_out = data;
    return true;
}

static bool parse_hello_response(
    const cloud_response_capture_t *capture,
    bool *registered_out,
    bool *paired_out) {
    cJSON *root = NULL;
    cJSON *data = NULL;
    if (!parse_success_data(capture, &root, &data)) {
        return false;
    }

    const cJSON *registered =
        cJSON_GetObjectItemCaseSensitive(data, "registered");
    const cJSON *paired =
        cJSON_GetObjectItemCaseSensitive(data, "paired");
    const bool valid =
        cJSON_IsBool(registered) &&
        cJSON_IsBool(paired);

    if (valid) {
        *registered_out = cJSON_IsTrue(registered);
        *paired_out = cJSON_IsTrue(paired);
    }
    cJSON_Delete(root);
    return valid;
}

static bool parse_optional_history_timestamp(
    const cJSON *item,
    bool *present_out,
    uint32_t *timestamp_out) {
    if (item == NULL || present_out == NULL || timestamp_out == NULL) {
        return false;
    }
    if (cJSON_IsNull(item)) {
        *present_out = false;
        *timestamp_out = 0u;
        return true;
    }
    if (!cJSON_IsNumber(item) ||
        item->valuedouble < (double) CLOUD_HISTORY_MIN_TIMESTAMP ||
        item->valuedouble > 4102444800.0) {
        return false;
    }
    const uint32_t timestamp = (uint32_t) item->valuedouble;
    if ((double) timestamp != item->valuedouble) {
        return false;
    }
    *present_out = true;
    *timestamp_out = timestamp;
    return true;
}

static bool parse_history_status_response(
    const cloud_response_capture_t *capture,
    uint32_t *cursor_out) {
    cJSON *root = NULL;
    cJSON *data = NULL;
    if (cursor_out == NULL || !parse_success_data(capture, &root, &data)) {
        return false;
    }

    bool latest_present = false;
    bool floor_present = false;
    uint32_t latest_timestamp = 0u;
    uint32_t history_sync_after = 0u;
    const bool valid =
        parse_optional_history_timestamp(
            cJSON_GetObjectItemCaseSensitive(data, "latest_timestamp"),
            &latest_present,
            &latest_timestamp) &&
        parse_optional_history_timestamp(
            cJSON_GetObjectItemCaseSensitive(data, "history_sync_after"),
            &floor_present,
            &history_sync_after) &&
        (!latest_present || !floor_present ||
         latest_timestamp > history_sync_after);

    if (valid) {
        if (latest_present) {
            *cursor_out = latest_timestamp;
        } else if (floor_present) {
            *cursor_out = history_sync_after;
        } else {
            *cursor_out = CLOUD_HISTORY_MIN_TIMESTAMP - 1u;
        }
    }
    cJSON_Delete(root);
    return valid;
}

static bool parse_history_upload_response(
    const cloud_response_capture_t *capture,
    uint16_t expected_count,
    uint32_t last_record_timestamp,
    uint32_t *latest_timestamp_out) {
    cJSON *root = NULL;
    cJSON *data = NULL;
    if (latest_timestamp_out == NULL ||
        !parse_success_data(capture, &root, &data)) {
        return false;
    }

    const cJSON *accepted = cJSON_GetObjectItemCaseSensitive(data, "accepted");
    const cJSON *latest =
        cJSON_GetObjectItemCaseSensitive(data, "latest_timestamp");
    bool latest_present = false;
    uint32_t latest_timestamp = 0u;
    const bool valid =
        cJSON_IsNumber(accepted) &&
        accepted->valuedouble == (double) expected_count &&
        parse_optional_history_timestamp(
            latest, &latest_present, &latest_timestamp) &&
        latest_present && latest_timestamp >= last_record_timestamp;
    if (valid) {
        *latest_timestamp_out = latest_timestamp;
    }
    cJSON_Delete(root);
    return valid;
}

static bool parse_pairing_create_response(
    const cloud_response_capture_t *capture,
    char pairing_id[WATTPOST_CLOUD_PAIRING_ID_MAX_LEN],
    char pair_url[WATTPOST_CLOUD_PAIR_URL_MAX_LEN]) {
    cJSON *root = NULL;
    cJSON *data = NULL;
    if (!parse_success_data(capture, &root, &data)) {
        return false;
    }

    const cJSON *id = cJSON_GetObjectItemCaseSensitive(data, "pairing_id");
    const cJSON *url = cJSON_GetObjectItemCaseSensitive(data, "pair_url");
    const bool valid =
        cJSON_IsString(id) && id->valuestring &&
        cJSON_IsString(url) && url->valuestring &&
        safe_pairing_id(id->valuestring) &&
        safe_pair_url(url->valuestring) &&
        strlen(url->valuestring) < WATTPOST_CLOUD_PAIR_URL_MAX_LEN;

    if (valid) {
        strlcpy(
            pairing_id,
            id->valuestring,
            WATTPOST_CLOUD_PAIRING_ID_MAX_LEN);
        strlcpy(
            pair_url,
            url->valuestring,
            WATTPOST_CLOUD_PAIR_URL_MAX_LEN);
    }
    cJSON_Delete(root);
    return valid;
}

static bool parse_pairing_status_response(
    const cloud_response_capture_t *capture,
    const char *expected_pairing_id,
    wattpost_cloud_pairing_state_t *state_out) {
    cJSON *root = NULL;
    cJSON *data = NULL;
    if (!parse_success_data(capture, &root, &data)) {
        return false;
    }

    const cJSON *id = cJSON_GetObjectItemCaseSensitive(data, "pairing_id");
    const cJSON *status_item = cJSON_GetObjectItemCaseSensitive(data, "status");
    bool valid =
        cJSON_IsString(id) && id->valuestring &&
        cJSON_IsString(status_item) && status_item->valuestring &&
        strcmp(id->valuestring, expected_pairing_id) == 0;

    wattpost_cloud_pairing_state_t parsed_state =
        WATTPOST_CLOUD_PAIRING_ERROR;
    if (valid && strcmp(status_item->valuestring, "pending") == 0) {
        parsed_state = WATTPOST_CLOUD_PAIRING_PENDING;
    } else if (valid && strcmp(status_item->valuestring, "claimed") == 0) {
        parsed_state = WATTPOST_CLOUD_PAIRING_CLAIMED;
    } else if (valid && strcmp(status_item->valuestring, "expired") == 0) {
        parsed_state = WATTPOST_CLOUD_PAIRING_EXPIRED;
    } else if (valid && strcmp(status_item->valuestring, "cancelled") == 0) {
        parsed_state = WATTPOST_CLOUD_PAIRING_CANCELLED;
    } else {
        valid = false;
    }

    if (valid) {
        *state_out = parsed_state;
    }
    cJSON_Delete(root);
    return valid;
}

static bool json_string_copy(
    const cJSON *item,
    char *output,
    size_t output_capacity) {
    if (!cJSON_IsString(item) || item->valuestring == NULL ||
        output == NULL || output_capacity == 0u) {
        return false;
    }
    const size_t length = strlen(item->valuestring);
    if (length == 0u || length >= output_capacity) {
        return false;
    }
    strlcpy(output, item->valuestring, output_capacity);
    return true;
}

static wattpost_cloud_ota_state_t ota_state_from_server(const char *value) {
    if (value == NULL) return WATTPOST_CLOUD_OTA_IDLE;
    if (strcmp(value, "offered") == 0) return WATTPOST_CLOUD_OTA_AVAILABLE;
    if (strcmp(value, "downloading") == 0) return WATTPOST_CLOUD_OTA_DOWNLOADING;
    if (strcmp(value, "installing") == 0) return WATTPOST_CLOUD_OTA_INSTALLING;
    if (strcmp(value, "success") == 0) return WATTPOST_CLOUD_OTA_SUCCESS;
    if (strcmp(value, "failed") == 0) return WATTPOST_CLOUD_OTA_FAILED;
    if (strcmp(value, "rolled_back") == 0) return WATTPOST_CLOUD_OTA_ROLLED_BACK;
    return WATTPOST_CLOUD_OTA_IDLE;
}

static bool parse_ota_target_response(
    const cloud_response_capture_t *capture,
    wattpost_remote_ota_target_t *target_out,
    bool *target_present_out,
    bool *server_manual_trigger_out,
    bool *server_trigger_known_out,
    cloud_ota_preference_sync_t *preference_out,
    wattpost_cloud_ota_state_t *server_state_out,
    char state_version[WATTPOST_CLOUD_OTA_VERSION_MAX_LEN],
    char state_build[WATTPOST_CLOUD_OTA_BUILD_ID_MAX_LEN],
    char state_error[WATTPOST_CLOUD_OTA_ERROR_MAX_LEN]) {
    cJSON *root = NULL;
    cJSON *data = NULL;
    if (target_out == NULL || target_present_out == NULL ||
        server_manual_trigger_out == NULL || server_trigger_known_out == NULL ||
        preference_out == NULL || server_state_out == NULL ||
        !parse_success_data(capture, &root, &data)) {
        return false;
    }

    memset(target_out, 0, sizeof(*target_out));
    *target_present_out = false;
    *server_manual_trigger_out = false;
    *server_trigger_known_out = false;
    memset(preference_out, 0, sizeof(*preference_out));
    *server_state_out = WATTPOST_CLOUD_OTA_IDLE;
    state_version[0] = '\0';
    state_build[0] = '\0';
    state_error[0] = '\0';

    bool valid = true;
    const cJSON *automatic = cJSON_GetObjectItemCaseSensitive(data, "automatic_updates");
    const cJSON *target = cJSON_GetObjectItemCaseSensitive(data, "target");
    const cJSON *state = cJSON_GetObjectItemCaseSensitive(data, "state");
    const cJSON *preference = cJSON_GetObjectItemCaseSensitive(data, "preference");
    valid = cJSON_IsTrue(automatic) && (cJSON_IsNull(target) || cJSON_IsObject(target));

    if (valid && preference != NULL) {
        if (!cJSON_IsObject(preference)) {
            valid = false;
        } else {
            const cJSON *supported =
                cJSON_GetObjectItemCaseSensitive(preference, "supported");
            const cJSON *confirmed =
                cJSON_GetObjectItemCaseSensitive(preference, "automatic_updates");
            const cJSON *pending =
                cJSON_GetObjectItemCaseSensitive(preference, "pending");
            if (!cJSON_IsBool(supported) ||
                !(cJSON_IsNull(confirmed) || cJSON_IsBool(confirmed)) ||
                !(cJSON_IsNull(pending) || cJSON_IsObject(pending))) {
                valid = false;
            } else {
                preference_out->supported = cJSON_IsTrue(supported);
                if (cJSON_IsBool(confirmed)) {
                    preference_out->automatic_updates_valid = true;
                    preference_out->automatic_updates = cJSON_IsTrue(confirmed);
                }
                if (cJSON_IsObject(pending)) {
                    const cJSON *generation =
                        cJSON_GetObjectItemCaseSensitive(pending, "generation");
                    const cJSON *desired =
                        cJSON_GetObjectItemCaseSensitive(pending, "automatic_updates");
                    valid =
                        cJSON_IsNumber(generation) && generation->valuedouble >= 0.0 &&
                        generation->valuedouble <= (double) UINT32_MAX &&
                        (double) (uint32_t) generation->valuedouble == generation->valuedouble &&
                        cJSON_IsBool(desired);
                    if (valid) {
                        preference_out->pending = true;
                        preference_out->pending_generation =
                            (uint32_t) generation->valuedouble;
                        preference_out->pending_automatic_updates =
                            cJSON_IsTrue(desired);
                    }
                }
            }
        }
    }

    if (valid && cJSON_IsObject(target)) {
        const cJSON *release_id = cJSON_GetObjectItemCaseSensitive(target, "release_id");
        const cJSON *size_bytes = cJSON_GetObjectItemCaseSensitive(target, "size_bytes");
        const cJSON *version = cJSON_GetObjectItemCaseSensitive(target, "version");
        const cJSON *build = cJSON_GetObjectItemCaseSensitive(target, "build_id");
        const cJSON *sha = cJSON_GetObjectItemCaseSensitive(target, "sha256");
        const cJSON *signature = cJSON_GetObjectItemCaseSensitive(target, "signature");
        const cJSON *path = cJSON_GetObjectItemCaseSensitive(target, "download_path");
        valid =
            cJSON_IsNumber(release_id) && release_id->valuedouble >= 1.0 &&
            release_id->valuedouble <= (double) UINT32_MAX &&
            (double) (uint32_t) release_id->valuedouble == release_id->valuedouble &&
            cJSON_IsNumber(size_bytes) && size_bytes->valuedouble >= 1.0 &&
            size_bytes->valuedouble <= (double) UINT32_MAX &&
            (double) (uint32_t) size_bytes->valuedouble == size_bytes->valuedouble &&
            json_string_copy(version, target_out->version, sizeof(target_out->version)) &&
            json_string_copy(build, target_out->build_id, sizeof(target_out->build_id)) &&
            json_string_copy(sha, target_out->sha256, sizeof(target_out->sha256)) &&
            json_string_copy(signature, target_out->signature, sizeof(target_out->signature)) &&
            json_string_copy(path, target_out->download_path, sizeof(target_out->download_path));
        if (valid) {
            target_out->release_id = (uint32_t) release_id->valuedouble;
            target_out->size_bytes = (uint32_t) size_bytes->valuedouble;
            *target_present_out = true;
        }
    }

    if (valid && !cJSON_IsNull(state)) {
        if (!cJSON_IsObject(state)) {
            valid = false;
        } else {
            const cJSON *state_name = cJSON_GetObjectItemCaseSensitive(state, "state");
            const cJSON *version = cJSON_GetObjectItemCaseSensitive(state, "version");
            const cJSON *build = cJSON_GetObjectItemCaseSensitive(state, "build_id");
            const cJSON *trigger = cJSON_GetObjectItemCaseSensitive(state, "trigger");
            const cJSON *error = cJSON_GetObjectItemCaseSensitive(state, "error");
            if (!cJSON_IsString(state_name) || state_name->valuestring == NULL ||
                !json_string_copy(version, state_version, WATTPOST_CLOUD_OTA_VERSION_MAX_LEN) ||
                !json_string_copy(build, state_build, WATTPOST_CLOUD_OTA_BUILD_ID_MAX_LEN)) {
                valid = false;
            } else {
                *server_state_out = ota_state_from_server(state_name->valuestring);
                if (*server_state_out == WATTPOST_CLOUD_OTA_IDLE) {
                    valid = false;
                }
                if (valid && cJSON_IsString(trigger) && trigger->valuestring != NULL) {
                    if (strcmp(trigger->valuestring, "manual") == 0) {
                        *server_manual_trigger_out = true;
                        *server_trigger_known_out = true;
                    } else if (strcmp(trigger->valuestring, "auto") == 0) {
                        *server_manual_trigger_out = false;
                        *server_trigger_known_out = true;
                    } else {
                        valid = false;
                    }
                }
                if (valid && !cJSON_IsNull(error)) {
                    valid = json_string_copy(error, state_error, WATTPOST_CLOUD_OTA_ERROR_MAX_LEN);
                }
            }
        }
    }

    cJSON_Delete(root);
    if (!valid) {
        memset(target_out, 0, sizeof(*target_out));
        *target_present_out = false;
        *server_manual_trigger_out = false;
        *server_trigger_known_out = false;
        memset(preference_out, 0, sizeof(*preference_out));
        *server_state_out = WATTPOST_CLOUD_OTA_IDLE;
        state_version[0] = '\0';
        state_build[0] = '\0';
        state_error[0] = '\0';
    }
    return valid;
}

static void ota_snapshot_set(
    wattpost_cloud_ota_state_t state,
    bool update_available,
    uint32_t release_id,
    const char *version,
    const char *build_id,
    const char *error) {
    const bool automatic_updates =
        wattpost_remote_ota_automatic_updates_get();
    portENTER_CRITICAL(&cloud_lock);
    cloud_snapshot.ota_automatic_updates = automatic_updates;
    cloud_snapshot.ota_state = state;
    cloud_snapshot.ota_update_available = update_available;
    cloud_snapshot.ota_release_id = release_id;
    if (state != WATTPOST_CLOUD_OTA_DOWNLOADING) {
        cloud_snapshot.ota_progress_bytes = 0u;
        cloud_snapshot.ota_progress_total = 0u;
        cloud_snapshot.ota_progress_attempt = 0u;
    }
    strlcpy(
        cloud_snapshot.ota_target_version,
        version ? version : "",
        sizeof(cloud_snapshot.ota_target_version));
    strlcpy(
        cloud_snapshot.ota_target_build_id,
        build_id ? build_id : "",
        sizeof(cloud_snapshot.ota_target_build_id));
    strlcpy(
        cloud_snapshot.ota_error,
        error ? error : "",
        sizeof(cloud_snapshot.ota_error));
    portEXIT_CRITICAL(&cloud_lock);
}

static void ota_progress_snapshot_set(
    uint32_t written, uint32_t total, uint32_t attempt) {
    portENTER_CRITICAL(&cloud_lock);
    cloud_snapshot.ota_progress_bytes = written;
    cloud_snapshot.ota_progress_total = total;
    cloud_snapshot.ota_progress_attempt = attempt;
    portEXIT_CRITICAL(&cloud_lock);
}

static bool clear_request_body(esp_http_client_handle_t client) {
    /*
     * ESP-IDF 5.5.5 implements set_post_field(NULL, 0) by deleting the
     * Content-Type header. If that header is already absent it returns
     * ESP_ERR_NOT_FOUND even though the desired no-body state is achieved.
     * Treat both outcomes as success.
     */
    const esp_err_t err =
        esp_http_client_set_post_field(client, NULL, 0);
    return err == ESP_OK || err == ESP_ERR_NOT_FOUND;
}

static bool configure_authenticated_request(
    esp_http_client_handle_t client,
    esp_http_client_method_t method,
    const char *url,
    const char *body,
    wattpost_device_identity_t *identity,
    char authorization[WATTPOST_CLOUD_AUTHORIZATION_MAX_LEN],
    char epoch[WATTPOST_CLOUD_EPOCH_MAX_LEN]) {
    memset(identity, 0, sizeof(*identity));
    const wattpost_identity_result_t identity_result =
        wattpost_device_identity_load(identity);
    if (identity_result != WATTPOST_IDENTITY_OK &&
        identity_result != WATTPOST_IDENTITY_RECOVERED) {
        return false;
    }

    if (!wattpost_cloud_format_authorization(
            identity,
            authorization,
            WATTPOST_CLOUD_AUTHORIZATION_MAX_LEN) ||
        !wattpost_cloud_format_epoch(
            identity->ownership_epoch,
            epoch,
            WATTPOST_CLOUD_EPOCH_MAX_LEN)) {
        return false;
    }

    if (esp_http_client_set_url(client, url) != ESP_OK ||
        esp_http_client_set_method(client, method) != ESP_OK ||
        esp_http_client_set_header(
            client, "Authorization", authorization) != ESP_OK ||
        esp_http_client_set_header(
            client, "X-WattPost-Ownership-Epoch", epoch) != ESP_OK) {
        return false;
    }

    if (body != NULL) {
        if (esp_http_client_set_header(
                client, "Content-Type", "application/json") != ESP_OK ||
            esp_http_client_set_post_field(
                client, body, (int) strlen(body)) != ESP_OK) {
            return false;
        }
    } else if (!clear_request_body(client)) {
        return false;
    }
    return true;
}

static void scrub_authenticated_request(
    esp_http_client_handle_t client,
    wattpost_device_identity_t *identity,
    char authorization[WATTPOST_CLOUD_AUTHORIZATION_MAX_LEN],
    char epoch[WATTPOST_CLOUD_EPOCH_MAX_LEN]) {
    if (client != NULL) {
        esp_http_client_delete_header(client, "Authorization");
        esp_http_client_delete_header(client, "X-WattPost-Ownership-Epoch");
        (void) clear_request_body(client);
        esp_http_client_set_user_data(client, NULL);
    }
    if (identity) {
        memset(identity, 0, sizeof(*identity));
    }
    memset(authorization, 0, WATTPOST_CLOUD_AUTHORIZATION_MAX_LEN);
    memset(epoch, 0, WATTPOST_CLOUD_EPOCH_MAX_LEN);
}

static esp_err_t perform_authenticated_request(
    esp_http_client_handle_t client,
    esp_http_client_method_t method,
    const char *url,
    const char *body,
    cloud_response_capture_t *capture,
    int *http_status_out) {
    wattpost_device_identity_t identity;
    char authorization[WATTPOST_CLOUD_AUTHORIZATION_MAX_LEN] = {0};
    char epoch[WATTPOST_CLOUD_EPOCH_MAX_LEN] = {0};
    response_capture_reset(capture);

    if (!configure_authenticated_request(
            client,
            method,
            url,
            body,
            &identity,
            authorization,
            epoch)) {
        scrub_authenticated_request(
            client, &identity, authorization, epoch);
        *http_status_out = 0;
        return ESP_ERR_INVALID_STATE;
    }

    if (esp_http_client_set_user_data(client, capture) != ESP_OK) {
        scrub_authenticated_request(
            client, &identity, authorization, epoch);
        *http_status_out = 0;
        return ESP_FAIL;
    }

    const esp_err_t error = esp_http_client_perform(client);
    const int status =
        error == ESP_OK ? esp_http_client_get_status_code(client) : 0;

    scrub_authenticated_request(
        client, &identity, authorization, epoch);

    if (error != ESP_OK) {
        /*
         * Keep the client handle, but discard a failed socket. A later
         * perform() will establish a new verified TLS connection.
         */
        esp_http_client_close(client);
    }

    *http_status_out = status;
    return error;
}

/* Explicit browser-originated BMS *connection* commands only. This path
 * must not accept settings writes, BLE MACs or destructive reset commands.
 * An accepted command is delivered once by the owner-scoped server; terminal
 * delivery is retried after transient Cloud outages. */
static void cloud_bms_begin(
    cloud_bms_kind_t kind, uint32_t server_generation,
    uint32_t scan_generation, uint16_t candidate_id) {
    cloud_bms_kind = kind;
    cloud_bms_generation = server_generation;
    cloud_bms_ble_generation = 0u;
    cloud_bms_result_ready = false;
    cloud_bms_result_success = false;
    cloud_bms_error = NULL;

    if (kind == CLOUD_BMS_SCAN) {
        const jk_bms_ble_scan_start_result_t result =
            jk_bms_ble_scan_start(&cloud_bms_ble_generation);
        if (result != JK_BMS_BLE_SCAN_START_OK) {
            cloud_bms_error = result == JK_BMS_BLE_SCAN_START_BUSY
                ? "busy" : "subsystem_unavailable";
            cloud_bms_result_ready = true;
        }
    } else if (kind == CLOUD_BMS_SELECT) {
        const jk_bms_ble_select_start_result_t result =
            jk_bms_ble_select_start(
                scan_generation, candidate_id, &cloud_bms_ble_generation);
        if (result != JK_BMS_BLE_SELECT_START_OK) {
            cloud_bms_error =
                result == JK_BMS_BLE_SELECT_START_BUSY ? "busy" :
                result == JK_BMS_BLE_SELECT_START_STALE_SCAN ? "stale_scan" :
                result == JK_BMS_BLE_SELECT_START_NOT_FOUND
                    ? "candidate_not_found" : "subsystem_unavailable";
            cloud_bms_result_ready = true;
        }
    } else if (kind == CLOUD_BMS_RECONNECT) {
        const jk_bms_ble_reconnect_start_result_t result =
            jk_bms_ble_reconnect_start(&cloud_bms_ble_generation);
        if (result != JK_BMS_BLE_RECONNECT_START_OK) {
            cloud_bms_error =
                result == JK_BMS_BLE_RECONNECT_START_BUSY ? "busy" :
                result == JK_BMS_BLE_RECONNECT_START_NOT_CONFIGURED
                    ? "not_configured" : "subsystem_unavailable";
            cloud_bms_result_ready = true;
        }
    }
}

static const char *cloud_bms_operation_error(jk_bms_ble_operation_error_t err) {
    switch (err) {
        case JK_BMS_BLE_ERROR_BUSY: return "busy";
        case JK_BMS_BLE_ERROR_STALE_SCAN: return "stale_scan";
        case JK_BMS_BLE_ERROR_CANDIDATE_NOT_FOUND: return "candidate_not_found";
        case JK_BMS_BLE_ERROR_CONNECT_FAILED: return "bms_connect_failed";
        case JK_BMS_BLE_ERROR_INVALID_BMS: return "bms_invalid";
        case JK_BMS_BLE_ERROR_STORAGE: return "storage_error";
        case JK_BMS_BLE_ERROR_SUBSYSTEM_UNAVAILABLE: return "subsystem_unavailable";
        default: return "request_failed";
    }
}

static void cloud_bms_check_finished(void) {
    if (cloud_bms_kind == CLOUD_BMS_NONE || cloud_bms_result_ready) {
        return;
    }
    jk_bms_ble_operation_snapshot_t operation;
    if (!jk_bms_ble_operation_snapshot(&operation)) {
        return;
    }
    if (operation.generation != cloud_bms_ble_generation) {
        cloud_bms_error = "operation_reset";
        cloud_bms_result_ready = true;
    } else if (operation.state == JK_BMS_BLE_OPERATION_SUCCESS) {
        cloud_bms_result_success = true;
        cloud_bms_result_ready = true;
    } else if (operation.state == JK_BMS_BLE_OPERATION_ERROR) {
        cloud_bms_error = cloud_bms_operation_error(operation.error);
        cloud_bms_result_ready = true;
    }
}

static bool cloud_bms_report(esp_http_client_handle_t client) {
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) return false;
    cJSON_AddNumberToObject(root, "generation", cloud_bms_generation);
    cJSON_AddStringToObject(root, "state",
        cloud_bms_result_success ? "success" : "error");
    if (cloud_bms_result_success) {
        cJSON_AddNullToObject(root, "error_code");
    } else {
        cJSON_AddStringToObject(root, "error_code",
            cloud_bms_error ? cloud_bms_error : "request_failed");
    }
    if (cloud_bms_result_success && cloud_bms_kind == CLOUD_BMS_SCAN) {
        jk_bms_ble_scan_snapshot_t scan;
        if (!jk_bms_ble_scan_snapshot(&scan) ||
            scan.operation.generation != cloud_bms_ble_generation) {
            cJSON_Delete(root);
            return false;
        }
        cJSON_AddNumberToObject(root, "scan_generation", scan.generation);
        cJSON *list = cJSON_AddArrayToObject(root, "candidates");
        if (list == NULL) {
            cJSON_Delete(root);
            return false;
        }
        for (size_t index = 0; index < scan.candidate_count; ++index) {
            const jk_bms_ble_scan_candidate_t *candidate = &scan.candidates[index];
            cJSON *item = cJSON_CreateObject();
            if (item == NULL) { cJSON_Delete(root); return false; }
            cJSON_AddNumberToObject(item, "candidate_id", candidate->candidate_id);
            cJSON_AddStringToObject(item, "name", candidate->name);
            cJSON_AddStringToObject(item, "address_hint", candidate->address_hint);
            cJSON_AddNumberToObject(item, "rssi_dbm", candidate->rssi_dbm);
            cJSON_AddItemToArray(list, item);
        }
    }
    char *payload = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (payload == NULL) return false;
    cloud_response_capture_t response;
    int status = 0;
    const esp_err_t result = perform_authenticated_request(
        client, HTTP_METHOD_PUT, CLOUD_BMS_RESULT_URL, payload, &response, &status);
    cJSON_free(payload);
    memset(&response, 0, sizeof(response));
    if (result == ESP_OK && (status == 200 || status == 409)) {
        /* A 409 is a stale/expired job. Do not replay a BLE mutation. */
        cloud_bms_kind = CLOUD_BMS_NONE;
        cloud_bms_generation = 0u;
        cloud_bms_ble_generation = 0u;
        cloud_bms_result_ready = false;
        return true;
    }
    return false;
}

static void run_bms_poll_attempt(esp_http_client_handle_t client) {
    cloud_last_bms_poll_us = esp_timer_get_time();
    if (cloud_bms_kind != CLOUD_BMS_NONE) {
        cloud_bms_check_finished();
        if (cloud_bms_result_ready) (void) cloud_bms_report(client);
        return;
    }

    cloud_response_capture_t response;
    int status = 0;
    const esp_err_t result = perform_authenticated_request(
        client, HTTP_METHOD_GET, CLOUD_BMS_COMMAND_URL, NULL, &response, &status);
    if (result != ESP_OK || status != 200 || response.overflow) {
        memset(&response, 0, sizeof(response));
        return;
    }
    cJSON *root = NULL;
    cJSON *data = NULL;
    if (!parse_success_data(&response, &root, &data)) {
        memset(&response, 0, sizeof(response));
        return;
    }
    const cJSON *command = cJSON_GetObjectItemCaseSensitive(data, "command");
    if (cJSON_IsObject(command)) {
        const cJSON *generation = cJSON_GetObjectItemCaseSensitive(command, "generation");
        const cJSON *kind = cJSON_GetObjectItemCaseSensitive(command, "kind");
        const cJSON *scan = cJSON_GetObjectItemCaseSensitive(command, "scan_generation");
        const cJSON *candidate = cJSON_GetObjectItemCaseSensitive(command, "candidate_id");
        if (cJSON_IsNumber(generation) && generation->valuedouble >= 1 &&
            generation->valuedouble <= UINT32_MAX &&
            (double)(uint32_t)generation->valuedouble == generation->valuedouble &&
            cJSON_IsString(kind) && cJSON_IsNumber(scan) && cJSON_IsNumber(candidate) &&
            scan->valuedouble >= 0 && scan->valuedouble <= UINT32_MAX &&
            candidate->valuedouble >= 0 && candidate->valuedouble <= 12 &&
            (double)(uint32_t)scan->valuedouble == scan->valuedouble &&
            (double)(uint32_t)candidate->valuedouble == candidate->valuedouble) {
            const cloud_bms_kind_t action =
                strcmp(kind->valuestring, "scan") == 0 ? CLOUD_BMS_SCAN :
                strcmp(kind->valuestring, "select") == 0 ? CLOUD_BMS_SELECT :
                strcmp(kind->valuestring, "reconnect") == 0 ? CLOUD_BMS_RECONNECT :
                CLOUD_BMS_NONE;
            if (action != CLOUD_BMS_NONE) {
                cloud_bms_begin(action, (uint32_t) generation->valuedouble,
                                (uint32_t) scan->valuedouble,
                                (uint16_t) candidate->valuedouble);
            }
        }
    }
    cJSON_Delete(root);
    memset(&response, 0, sizeof(response));
}

static bool report_ota_status(
    esp_http_client_handle_t client,
    uint32_t release_id,
    const char *state,
    const char *error) {
    char body[CLOUD_OTA_STATUS_JSON_MAX_LEN] = {0};
    const int written = error == NULL
        ? snprintf(
            body,
            sizeof(body),
            "{\"release_id\":%lu,\"state\":\"%s\",\"error\":null}",
            (unsigned long) release_id,
            state)
        : snprintf(
            body,
            sizeof(body),
            "{\"release_id\":%lu,\"state\":\"%s\",\"error\":\"%s\"}",
            (unsigned long) release_id,
            state,
            error);
    if (written <= 0 || (size_t) written >= sizeof(body)) {
        memset(body, 0, sizeof(body));
        return false;
    }
    cloud_response_capture_t capture;
    int http_status = 0;
    const esp_err_t request_error = perform_authenticated_request(
        client,
        HTTP_METHOD_PUT,
        CLOUD_OTA_STATUS_URL,
        body,
        &capture,
        &http_status);
    memset(body, 0, sizeof(body));
    memset(&capture, 0, sizeof(capture));
    return request_error == ESP_OK && http_status == 200;
}

/*
 * Acknowledged transfer progress is best-effort: failure to report progress
 * must never abort a valid firmware image download. No second HTTP client or
 * extra task is needed; this is called only after closing a completed Range.
 */
static bool report_ota_download_progress(
    esp_http_client_handle_t client,
    uint32_t release_id, uint32_t written, uint32_t attempt) {
    char body[CLOUD_OTA_STATUS_JSON_MAX_LEN] = {0};
    const int size = snprintf(
        body, sizeof(body),
        "{\"release_id\":%lu,\"state\":\"downloading\",\"error\":null,"
        "\"downloaded_bytes\":%lu,\"download_attempt\":%lu}",
        (unsigned long) release_id, (unsigned long) written,
        (unsigned long) attempt);
    if (size <= 0 || (size_t) size >= sizeof(body)) {
        return false;
    }
    cloud_response_capture_t capture;
    int http_status = 0;
    const esp_err_t err = perform_authenticated_request(
        client, HTTP_METHOD_PUT, CLOUD_OTA_STATUS_URL, body, &capture, &http_status);
    memset(body, 0, sizeof(body));
    memset(&capture, 0, sizeof(capture));
    return err == ESP_OK && http_status == 200;
}

static bool report_ota_preference(
    esp_http_client_handle_t client,
    bool automatic_updates,
    bool generation_valid,
    uint32_t generation) {
    char body[CLOUD_OTA_PREFERENCE_JSON_MAX_LEN] = {0};
    const int written = generation_valid
        ? snprintf(
            body, sizeof(body),
            "{\"automatic_updates\":%s,\"command_generation\":%lu}",
            automatic_updates ? "true" : "false",
            (unsigned long) generation)
        : snprintf(
            body, sizeof(body),
            "{\"automatic_updates\":%s,\"command_generation\":null}",
            automatic_updates ? "true" : "false");
    if (written <= 0 || (size_t) written >= sizeof(body)) {
        return false;
    }
    cloud_response_capture_t capture;
    int http_status = 0;
    const esp_err_t request_error = perform_authenticated_request(
        client, HTTP_METHOD_PUT, CLOUD_OTA_PREFERENCES_URL, body, &capture, &http_status);
    memset(body, 0, sizeof(body));
    memset(&capture, 0, sizeof(capture));
    if (request_error != ESP_OK || http_status != 200) {
        return false;
    }
    cloud_last_ota_preference_success_us = esp_timer_get_time();
    portENTER_CRITICAL(&cloud_lock);
    cloud_ota_preference_force_report = false;
    cloud_snapshot.ota_preference_cloud_supported = true;
    cloud_snapshot.ota_preference_cloud_confirmed = true;
    cloud_snapshot.ota_preference_cloud_automatic_updates = automatic_updates;
    if (generation_valid &&
        cloud_snapshot.ota_preference_pending &&
        cloud_snapshot.ota_preference_pending_generation == generation) {
        cloud_snapshot.ota_preference_pending = false;
        cloud_snapshot.ota_preference_pending_generation = 0u;
        cloud_snapshot.ota_preference_pending_automatic_updates = false;
    }
    portEXIT_CRITICAL(&cloud_lock);
    return true;
}

static bool request_manual_ota(esp_http_client_handle_t client) {
    cloud_response_capture_t capture;
    int http_status = 0;
    const esp_err_t request_error = perform_authenticated_request(
        client,
        HTTP_METHOD_POST,
        CLOUD_OTA_INSTALL_URL,
        NULL,
        &capture,
        &http_status);
    memset(&capture, 0, sizeof(capture));
    return request_error == ESP_OK && (http_status == 200 || http_status == 409);
}

static bool fetch_ota_target(
    esp_http_client_handle_t client,
    wattpost_remote_ota_target_t *target,
    bool *target_present,
    bool *server_manual_trigger,
    bool *server_trigger_known,
    cloud_ota_preference_sync_t *preference,
    wattpost_cloud_ota_state_t *server_state,
    char state_version[WATTPOST_CLOUD_OTA_VERSION_MAX_LEN],
    char state_build[WATTPOST_CLOUD_OTA_BUILD_ID_MAX_LEN],
    char state_error[WATTPOST_CLOUD_OTA_ERROR_MAX_LEN]) {
    cloud_response_capture_t capture;
    int http_status = 0;
    cloud_last_ota_poll_us = esp_timer_get_time();
    const esp_err_t request_error = perform_authenticated_request(
        client,
        HTTP_METHOD_GET,
        CLOUD_OTA_URL,
        NULL,
        &capture,
        &http_status);
    const bool valid =
        request_error == ESP_OK && http_status == 200 &&
        parse_ota_target_response(
            &capture,
            target,
            target_present,
            server_manual_trigger,
            server_trigger_known,
            preference,
            server_state,
            state_version,
            state_build,
            state_error);
    memset(&capture, 0, sizeof(capture));
    return valid;
}

static bool stream_ota_image(
    esp_http_client_handle_t client,
    const wattpost_remote_ota_target_t *target,
    uint32_t download_attempt,
    const esp_partition_t **partition_out,
    const char **error_out) {
    if (partition_out == NULL || error_out == NULL) {
        return false;
    }
    *partition_out = NULL;
    *error_out = "download_failed";
    const esp_partition_t *partition = esp_ota_get_next_update_partition(NULL);
    if (partition == NULL || target->size_bytes > partition->size) {
        *error_out = "image_too_large";
        return false;
    }

    char url[CLOUD_OTA_DOWNLOAD_URL_MAX_LEN] = {0};
    const int url_len = snprintf(
        url,
        sizeof(url),
        CLOUD_BASE_URL "%s",
        target->download_path);
    if (url_len <= 0 || (size_t) url_len >= sizeof(url)) {
        *error_out = "invalid_manifest";
        return false;
    }

    /*
     * esp_ota_begin(partition, image_size, ...) synchronously erases the target
     * range. Finish that erase before any firmware HTTP response is opened.
     */
    esp_ota_handle_t update = 0;
    const esp_err_t ota_error =
        esp_ota_begin(partition, target->size_bytes, &update);
    if (ota_error != ESP_OK) {
        memset(url, 0, sizeof(url));
        *error_out = "ota_begin_failed";
        return false;
    }

    mbedtls_sha256_context sha;
    mbedtls_sha256_init(&sha);
    if (mbedtls_sha256_starts(&sha, 0) != 0) {
        esp_ota_abort(update);
        mbedtls_sha256_free(&sha);
        memset(url, 0, sizeof(url));
        *error_out = "hash_failed";
        return false;
    }

    uint32_t total = 0u;
    uint32_t last_reported = 0u;
    const uint32_t report_step = target->size_bytes / 10u;
    ota_progress_snapshot_set(0u, target->size_bytes, download_attempt);
    (void) report_ota_download_progress(
        client, target->release_id, 0u, download_attempt);
    uint32_t range_requests = 0u;
    uint32_t no_progress_reconnects = 0u;
    bool stream_ok = true;

    while (total < target->size_bytes) {
        if (++range_requests > CLOUD_OTA_MAX_RANGE_REQUESTS) {
            stream_ok = false;
            *error_out = "download_failed";
            break;
        }

        const uint32_t range_start = total;
        const uint32_t remaining = target->size_bytes - range_start;
        const uint32_t range_length =
            remaining < CLOUD_OTA_RANGE_SIZE ? remaining : CLOUD_OTA_RANGE_SIZE;
        const uint32_t range_end = range_start + range_length - 1u;
        char range_header[48] = {0};
        const int range_written = snprintf(
            range_header,
            sizeof(range_header),
            "bytes=%lu-%lu",
            (unsigned long) range_start,
            (unsigned long) range_end);
        if (range_written <= 0 || (size_t) range_written >= sizeof(range_header)) {
            stream_ok = false;
            *error_out = "invalid_manifest";
            break;
        }

        wattpost_device_identity_t identity;
        char authorization[WATTPOST_CLOUD_AUTHORIZATION_MAX_LEN] = {0};
        char epoch[WATTPOST_CLOUD_EPOCH_MAX_LEN] = {0};
        bool request_open = false;
        bool request_ready =
            configure_authenticated_request(
                client,
                HTTP_METHOD_GET,
                url,
                NULL,
                &identity,
                authorization,
                epoch) &&
            esp_http_client_set_header(client, "Range", range_header) == ESP_OK &&
            esp_http_client_set_user_data(client, NULL) == ESP_OK;

        if (request_ready) {
            const esp_err_t open_error = esp_http_client_open(client, 0);
            request_open = open_error == ESP_OK;
        }

        int64_t content_length = -1;
        int http_status = 0;
        if (request_open) {
            content_length = esp_http_client_fetch_headers(client);
            http_status = esp_http_client_get_status_code(client);
            request_ready =
                content_length == (int64_t) range_length &&
                http_status == 206;
        } else {
            request_ready = false;
        }

        if (!request_ready) {
            if (request_open) {
                esp_http_client_close(client);
                esp_http_client_clear_response_buffer(client);
            }
            esp_http_client_delete_header(client, "Range");
            scrub_authenticated_request(client, &identity, authorization, epoch);
            memset(range_header, 0, sizeof(range_header));
            if (http_status == 200) {
                stream_ok = false;
                *error_out = "range_unsupported";
                break;
            }
            if (++no_progress_reconnects > CLOUD_OTA_MAX_NO_PROGRESS_RECONNECTS) {
                stream_ok = false;
                *error_out = "download_failed";
                break;
            }
            vTaskDelay(pdMS_TO_TICKS(250));
            continue;
        }

        uint32_t segment_received = 0u;
        uint32_t consecutive_read_timeouts = 0u;
        bool fatal_segment_error = false;
        while (segment_received < range_length) {
            const uint32_t segment_remaining = range_length - segment_received;
            const int want = (int) (
                segment_remaining < sizeof(cloud_json_scratch.ota_chunk)
                    ? segment_remaining
                    : sizeof(cloud_json_scratch.ota_chunk));
            const int received = esp_http_client_read(
                client,
                (char *) cloud_json_scratch.ota_chunk,
                want);
            if (received == -ESP_ERR_HTTP_EAGAIN) {
                if (++consecutive_read_timeouts <=
                    CLOUD_OTA_MAX_CONSECUTIVE_READ_TIMEOUTS) {
                    continue;
                }
                break;
            }
            if (received <= 0) {
                break;
            }
            consecutive_read_timeouts = 0u;
            if (esp_ota_write(
                    update,
                    cloud_json_scratch.ota_chunk,
                    (size_t) received) != ESP_OK) {
                fatal_segment_error = true;
                *error_out = "ota_write_failed";
                break;
            }
            if (mbedtls_sha256_update(
                    &sha,
                    cloud_json_scratch.ota_chunk,
                    (size_t) received) != 0) {
                fatal_segment_error = true;
                *error_out = "hash_failed";
                break;
            }
            segment_received += (uint32_t) received;
            total += (uint32_t) received;
        }

        esp_http_client_close(client);
        esp_http_client_clear_response_buffer(client);
        esp_http_client_delete_header(client, "Range");
        scrub_authenticated_request(client, &identity, authorization, epoch);
        memset(range_header, 0, sizeof(range_header));

        if (fatal_segment_error) {
            stream_ok = false;
            break;
        }
        ota_progress_snapshot_set(total, target->size_bytes, download_attempt);
        if (total > last_reported &&
            (total - last_reported >= report_step || total == target->size_bytes)) {
            if (report_ota_download_progress(
                    client, target->release_id, total, download_attempt)) {
                last_reported = total;
            }
        }
        if (segment_received == range_length) {
            no_progress_reconnects = 0u;
            continue;
        }

        /* Resume from exactly the bytes already written and hashed. */
        if (total > range_start) {
            no_progress_reconnects = 0u;
            continue;
        }
        if (++no_progress_reconnects > CLOUD_OTA_MAX_NO_PROGRESS_RECONNECTS) {
            stream_ok = false;
            *error_out = consecutive_read_timeouts >
                    CLOUD_OTA_MAX_CONSECUTIVE_READ_TIMEOUTS
                ? "download_timeout"
                : "download_failed";
            break;
        }
        vTaskDelay(pdMS_TO_TICKS(250));
    }

    uint8_t actual_hash[32] = {0};
    uint8_t expected_hash[32] = {0};
    if (stream_ok && total != target->size_bytes) {
        stream_ok = false;
        *error_out = "size_mismatch";
    }
    if (stream_ok && mbedtls_sha256_finish(&sha, actual_hash) != 0) {
        stream_ok = false;
        *error_out = "hash_failed";
    }
    if (stream_ok &&
        (!wattpost_remote_ota_parse_sha256(target->sha256, expected_hash) ||
         memcmp(actual_hash, expected_hash, sizeof(actual_hash)) != 0)) {
        stream_ok = false;
        *error_out = "hash_mismatch";
    }

    mbedtls_sha256_free(&sha);
    memset(cloud_json_scratch.ota_chunk, 0, sizeof(cloud_json_scratch.ota_chunk));
    memset(actual_hash, 0, sizeof(actual_hash));
    memset(expected_hash, 0, sizeof(expected_hash));
    esp_http_client_delete_header(client, "Range");
    memset(url, 0, sizeof(url));

    if (!stream_ok) {
        esp_ota_abort(update);
        return false;
    }
    if (esp_ota_end(update) != ESP_OK) {
        *error_out = "ota_end_failed";
        return false;
    }
    *partition_out = partition;
    return true;
}

static bool ota_download_error_retryable(const char *error) {
    return error != NULL &&
        (strcmp(error, "download_failed") == 0 ||
         strcmp(error, "download_timeout") == 0);
}

static bool install_ota_target(
    esp_http_client_handle_t client,
    const wattpost_remote_ota_target_t *target) {
    if (!wattpost_remote_ota_target_validate(target, WATTPOST_FIRMWARE_VERSION)) {
        ota_snapshot_set(
            WATTPOST_CLOUD_OTA_FAILED,
            true,
            target->release_id,
            target->version,
            target->build_id,
            "invalid_manifest");
        (void) report_ota_status(
            client, target->release_id, "failed", "invalid_manifest");
        return false;
    }
    if (!wattpost_remote_ota_verify_manifest_signature(target)) {
        ota_snapshot_set(
            WATTPOST_CLOUD_OTA_FAILED,
            true,
            target->release_id,
            target->version,
            target->build_id,
            "signature_invalid");
        (void) report_ota_status(
            client, target->release_id, "failed", "signature_invalid");
        return false;
    }

    if (!report_ota_status(client, target->release_id, "downloading", NULL)) {
        return false;
    }
    ota_snapshot_set(
        WATTPOST_CLOUD_OTA_DOWNLOADING,
        true,
        target->release_id,
        target->version,
        target->build_id,
        NULL);

    const char *failure = NULL;
    const esp_partition_t *target_partition = NULL;
    bool downloaded = false;
    for (uint32_t attempt = 1u; attempt <= CLOUD_OTA_MAX_DOWNLOAD_ATTEMPTS; ++attempt) {
        failure = NULL;
        target_partition = NULL;
        if (stream_ota_image(
                client, target, attempt, &target_partition, &failure)) {
            downloaded = true;
            break;
        }
        if (!ota_download_error_retryable(failure) ||
            attempt == CLOUD_OTA_MAX_DOWNLOAD_ATTEMPTS) {
            break;
        }
        ESP_LOGW(
            TAG,
            "Remote OTA transport attempt %lu/%u failed (%s); retrying from byte 0",
            (unsigned long) attempt,
            CLOUD_OTA_MAX_DOWNLOAD_ATTEMPTS,
            failure);
        vTaskDelay(pdMS_TO_TICKS(500));
    }
    if (!downloaded) {
        if (failure == NULL) {
            failure = "download_failed";
        }
        ota_snapshot_set(
            WATTPOST_CLOUD_OTA_FAILED,
            true,
            target->release_id,
            target->version,
            target->build_id,
            failure);
        (void) report_ota_status(client, target->release_id, "failed", failure);
        return false;
    }

    ota_snapshot_set(
        WATTPOST_CLOUD_OTA_VERIFYING,
        true,
        target->release_id,
        target->version,
        target->build_id,
        NULL);
    if (!report_ota_status(client, target->release_id, "installing", NULL)) {
        ota_snapshot_set(
            WATTPOST_CLOUD_OTA_FAILED,
            true,
            target->release_id,
            target->version,
            target->build_id,
            "status_failed");
        return false;
    }
    if (!wattpost_remote_ota_marker_save(target)) {
        (void) report_ota_status(
            client, target->release_id, "failed", "marker_storage_failed");
        ota_snapshot_set(
            WATTPOST_CLOUD_OTA_FAILED,
            true,
            target->release_id,
            target->version,
            target->build_id,
            "marker_storage_failed");
        return false;
    }

    if (target_partition == NULL ||
        esp_ota_set_boot_partition(target_partition) != ESP_OK) {
        (void) wattpost_remote_ota_marker_clear();
        (void) report_ota_status(
            client, target->release_id, "failed", "boot_partition_failed");
        ota_snapshot_set(
            WATTPOST_CLOUD_OTA_FAILED,
            true,
            target->release_id,
            target->version,
            target->build_id,
            "boot_partition_failed");
        return false;
    }

    ota_snapshot_set(
        WATTPOST_CLOUD_OTA_INSTALLING,
        true,
        target->release_id,
        target->version,
        target->build_id,
        NULL);
    ESP_LOGI(
        TAG,
        "Remote OTA ready: release=%lu version=%s build=%s, rebooting",
        (unsigned long) target->release_id,
        target->version,
        target->build_id);
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
    return true;
}

static bool process_ota_boot_marker(esp_http_client_handle_t client) {
    static bool loaded;
    static bool present;
    static wattpost_remote_ota_marker_t marker;
    if (!loaded) {
        present = wattpost_remote_ota_marker_load(&marker);
        loaded = true;
    }
    if (!present) {
        return false;
    }

    if (strcmp(marker.build_id, WATTPOST_BUILD_ID) != 0) {
        ota_snapshot_set(
            WATTPOST_CLOUD_OTA_ROLLED_BACK,
            true,
            marker.release_id,
            marker.version,
            marker.build_id,
            "boot_rollback");
        if (report_ota_status(
                client, marker.release_id, "rolled_back", "boot_rollback")) {
            (void) wattpost_remote_ota_marker_clear();
            memset(&marker, 0, sizeof(marker));
            present = false;
            return false;
        }
        return true;
    }

    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
    if (running == NULL || esp_ota_get_state_partition(running, &state) != ESP_OK) {
        return true;
    }
    if (state == ESP_OTA_IMG_NEW || state == ESP_OTA_IMG_PENDING_VERIFY) {
        ota_snapshot_set(
            WATTPOST_CLOUD_OTA_INSTALLING,
            true,
            marker.release_id,
            marker.version,
            marker.build_id,
            NULL);
        return true;
    }
    if (state == ESP_OTA_IMG_VALID) {
        ota_snapshot_set(
            WATTPOST_CLOUD_OTA_SUCCESS,
            false,
            marker.release_id,
            marker.version,
            marker.build_id,
            NULL);
        if (report_ota_status(client, marker.release_id, "success", NULL)) {
            (void) wattpost_remote_ota_marker_clear();
            memset(&marker, 0, sizeof(marker));
            present = false;
            return false;
        }
        return true;
    }

    ota_snapshot_set(
        WATTPOST_CLOUD_OTA_FAILED,
        true,
        marker.release_id,
        marker.version,
        marker.build_id,
        "validation_failed");
    if (report_ota_status(
            client, marker.release_id, "failed", "validation_failed")) {
        (void) wattpost_remote_ota_marker_clear();
        memset(&marker, 0, sizeof(marker));
        present = false;
        return false;
    }
    return true;
}

static bool run_ota_poll_attempt(esp_http_client_handle_t client) {
    bool manual = false;
    bool manual_authorized = false;
    portENTER_CRITICAL(&cloud_lock);
    manual = cloud_ota_manual_requested;
    portEXIT_CRITICAL(&cloud_lock);

    if (manual) {
        if (!request_manual_ota(client)) {
            return false;
        }
        manual_authorized = true;
        portENTER_CRITICAL(&cloud_lock);
        cloud_ota_manual_requested = false;
        portEXIT_CRITICAL(&cloud_lock);
    }

    wattpost_remote_ota_target_t target;
    memset(&target, 0, sizeof(target));
    bool target_present = false;
    bool server_manual_trigger = false;
    bool server_trigger_known = false;
    cloud_ota_preference_sync_t preference;
    memset(&preference, 0, sizeof(preference));
    wattpost_cloud_ota_state_t server_state = WATTPOST_CLOUD_OTA_IDLE;
    char state_version[WATTPOST_CLOUD_OTA_VERSION_MAX_LEN] = {0};
    char state_build[WATTPOST_CLOUD_OTA_BUILD_ID_MAX_LEN] = {0};
    char state_error[WATTPOST_CLOUD_OTA_ERROR_MAX_LEN] = {0};
    const bool fetched = fetch_ota_target(
        client,
        &target,
        &target_present,
        &server_manual_trigger,
        &server_trigger_known,
        &preference,
        &server_state,
        state_version,
        state_build,
        state_error);
    if (!fetched) {
        memset(&target, 0, sizeof(target));
        return false;
    }

    portENTER_CRITICAL(&cloud_lock);
    cloud_snapshot.ota_preference_cloud_supported = preference.supported;
    cloud_snapshot.ota_preference_cloud_confirmed = preference.automatic_updates_valid;
    if (preference.automatic_updates_valid) {
        cloud_snapshot.ota_preference_cloud_automatic_updates =
            preference.automatic_updates;
    }
    cloud_snapshot.ota_preference_pending = preference.pending;
    cloud_snapshot.ota_preference_pending_generation =
        preference.pending ? preference.pending_generation : 0u;
    cloud_snapshot.ota_preference_pending_automatic_updates =
        preference.pending && preference.pending_automatic_updates;
    portEXIT_CRITICAL(&cloud_lock);

    if (preference.pending) {
        const bool current = wattpost_remote_ota_automatic_updates_get();
        const bool desired = preference.pending_automatic_updates;
        if (current != desired &&
            !wattpost_remote_ota_automatic_updates_set(desired)) {
            memset(&target, 0, sizeof(target));
            return false;
        }
        const bool confirmed = wattpost_remote_ota_automatic_updates_get();
        portENTER_CRITICAL(&cloud_lock);
        cloud_snapshot.ota_automatic_updates = confirmed;
        portEXIT_CRITICAL(&cloud_lock);
        if (!report_ota_preference(
                client, confirmed, true, preference.pending_generation)) {
            portENTER_CRITICAL(&cloud_lock);
            cloud_ota_preference_force_report = true;
            portEXIT_CRITICAL(&cloud_lock);
        }
    }

    if (!target_present) {
        const bool retry_available =
            (server_state == WATTPOST_CLOUD_OTA_FAILED ||
             server_state == WATTPOST_CLOUD_OTA_ROLLED_BACK) &&
            wattpost_remote_ota_version_is_newer(
                state_version, WATTPOST_FIRMWARE_VERSION);
        if ((server_state == WATTPOST_CLOUD_OTA_FAILED ||
             server_state == WATTPOST_CLOUD_OTA_ROLLED_BACK) &&
            !retry_available) {
            ota_snapshot_set(
                WATTPOST_CLOUD_OTA_IDLE, false, 0u, NULL, NULL, NULL);
        } else {
            ota_snapshot_set(
                server_state,
                retry_available,
                0u,
                state_version,
                state_build,
                state_error);
        }
        memset(&target, 0, sizeof(target));
        return true;
    }

    ota_snapshot_set(
        WATTPOST_CLOUD_OTA_AVAILABLE,
        true,
        target.release_id,
        target.version,
        target.build_id,
        NULL);

    const bool automatic_updates =
        wattpost_remote_ota_automatic_updates_get();
    const bool explicit_manual =
        manual_authorized || (server_trigger_known && server_manual_trigger);
    if (!automatic_updates && !explicit_manual) {
        /*
         * Current production Cloud still creates legacy auto offers. Keep the
         * signed target visible, but the physical device owns the policy and
         * must not start a background install while its NVS preference is OFF.
         */
        memset(&target, 0, sizeof(target));
        return true;
    }

    const bool result = install_ota_target(client, &target);
    memset(&target, 0, sizeof(target));
    return result;
}

static esp_err_t perform_hello(
    esp_http_client_handle_t client,
    cloud_response_capture_t *capture,
    int *http_status_out) {
    char hello_json[WATTPOST_CLOUD_HELLO_JSON_MAX_LEN] = {0};
    if (!wattpost_cloud_format_hello_json(
            WATTPOST_FIRMWARE_VERSION,
            WATTPOST_BUILD_ID,
            wattpost_history_newest_timestamp(),
            hello_json,
            sizeof(hello_json))) {
        *http_status_out = 0;
        return ESP_FAIL;
    }

    const esp_err_t error = perform_authenticated_request(
        client,
        HTTP_METHOD_POST,
        CLOUD_HELLO_URL,
        hello_json,
        capture,
        http_status_out);
    memset(hello_json, 0, sizeof(hello_json));
    return error;
}

static esp_http_client_handle_t create_client(void) {
    const esp_http_client_config_t config = {
        .url = CLOUD_HELLO_URL,
        .user_agent = CLOUD_USER_AGENT,
        .timeout_ms = CLOUD_HTTP_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .keep_alive_enable = true,
        .disable_auto_redirect = true,
        .max_authorization_retries = -1,
        .buffer_size = 512,
        .buffer_size_tx = 512,
        .event_handler = cloud_http_event,
    };
    return esp_http_client_init(&config);
}

static void clear_pairing_locked(wattpost_cloud_pairing_state_t state);

static void update_registration_state(bool registered, bool paired) {
    portENTER_CRITICAL(&cloud_lock);
    cloud_snapshot.registration_known = true;
    cloud_snapshot.registered = registered;
    cloud_snapshot.paired_known = true;
    cloud_snapshot.paired = paired;
    if (!paired &&
        cloud_snapshot.pairing_state == WATTPOST_CLOUD_PAIRING_CLAIMED) {
        clear_pairing_locked(WATTPOST_CLOUD_PAIRING_NONE);
    }
    portEXIT_CRITICAL(&cloud_lock);
}

static void clear_pairing_locked(wattpost_cloud_pairing_state_t state) {
    cloud_snapshot.pairing_state = state;
    memset(cloud_snapshot.pairing_url, 0, sizeof(cloud_snapshot.pairing_url));
    memset(cloud_pairing_id, 0, sizeof(cloud_pairing_id));
}

static void finish_action_locked(
    wattpost_cloud_action_state_t state,
    wattpost_cloud_action_error_t error) {
    cloud_snapshot.action_state = state;
    cloud_snapshot.action_error = error;
}

static void finish_pairing_action_error(
    wattpost_cloud_action_error_t error) {
    portENTER_CRITICAL(&cloud_lock);
    clear_pairing_locked(WATTPOST_CLOUD_PAIRING_ERROR);
    finish_action_locked(WATTPOST_CLOUD_ACTION_ERROR, error);
    portEXIT_CRITICAL(&cloud_lock);
}

static void finish_disconnect_action_success(void) {
    portENTER_CRITICAL(&cloud_lock);
    cloud_snapshot.disconnect_pending = false;
    cloud_snapshot.paired_known = true;
    cloud_snapshot.paired = false;
    clear_pairing_locked(WATTPOST_CLOUD_PAIRING_NONE);
    finish_action_locked(
        WATTPOST_CLOUD_ACTION_SUCCESS,
        WATTPOST_CLOUD_ACTION_ERROR_NONE);
    cloud_disconnect_epoch_ready = false;
    portEXIT_CRITICAL(&cloud_lock);
}

static bool action_snapshot(
    wattpost_cloud_action_kind_t *kind,
    wattpost_cloud_action_state_t *state,
    bool *disconnect_epoch_ready,
    wattpost_cloud_pairing_state_t *pairing_state,
    char pairing_id[WATTPOST_CLOUD_PAIRING_ID_MAX_LEN]) {
    portENTER_CRITICAL(&cloud_lock);
    *kind = cloud_snapshot.action_kind;
    *state = cloud_snapshot.action_state;
    *disconnect_epoch_ready = cloud_disconnect_epoch_ready;
    *pairing_state = cloud_snapshot.pairing_state;
    strlcpy(
        pairing_id,
        cloud_pairing_id,
        WATTPOST_CLOUD_PAIRING_ID_MAX_LEN);
    portEXIT_CRITICAL(&cloud_lock);
    return true;
}

static bool run_hello_attempt(
    esp_http_client_handle_t client,
    uint32_t *backoff_ms,
    bool *registered_out,
    bool *paired_out) {
    cloud_last_hello_attempt_us = esp_timer_get_time();
    cloud_response_capture_t capture;
    set_runtime_state(WATTPOST_CLOUD_STATE_CONNECTING, *backoff_ms);
    record_attempt_start(
        esp_get_free_heap_size(),
        heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));

    int http_status = 0;
    const esp_err_t error =
        perform_hello(client, &capture, &http_status);
    bool registered = false;
    bool paired = false;
    const bool valid_response =
        error == ESP_OK &&
        http_status == 200 &&
        parse_hello_response(&capture, &registered, &paired);
    memset(&capture, 0, sizeof(capture));

    if (valid_response) {
        *backoff_ms = wattpost_cloud_retry_after_success();
        record_attempt_result(
            true,
            ESP_OK,
            http_status,
            esp_get_free_heap_size(),
            heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
            *backoff_ms);
        update_registration_state(registered, paired);
        *registered_out = registered;
        *paired_out = paired;
        return true;
    }

    *backoff_ms = wattpost_cloud_retry_after_failure(*backoff_ms);
    record_attempt_result(
        false,
        error == ESP_OK ? ESP_FAIL : error,
        http_status,
        esp_get_free_heap_size(),
        heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
        *backoff_ms);
    ESP_LOGW(
        TAG,
        "Cloud hello failed: err=%s status=%d retry_ms=%lu",
        esp_err_to_name(error == ESP_OK ? ESP_FAIL : error),
        http_status,
        (unsigned long) *backoff_ms);
    return false;
}

static bool run_telemetry_attempt(
    esp_http_client_handle_t client,
    uint32_t *backoff_ms) {
    cloud_last_telemetry_attempt_us = esp_timer_get_time();

    wattpost_cloud_telemetry_provider_t provider;
    portENTER_CRITICAL(&cloud_lock);
    provider = cloud_telemetry_provider;
    portEXIT_CRITICAL(&cloud_lock);
    if (provider == NULL) {
        return true;
    }

    wattpost_cloud_telemetry_t telemetry;
    memset(&telemetry, 0, sizeof(telemetry));
    if (!provider(&telemetry)) {
        memset(&telemetry, 0, sizeof(telemetry));
        ESP_LOGW(TAG, "Cloud telemetry snapshot unavailable");
        return true;
    }

    cloud_telemetry_sequence =
        next_generation(cloud_telemetry_sequence);
    telemetry.sample_seq = cloud_telemetry_sequence;

    if (!wattpost_cloud_format_telemetry_json(
            &telemetry,
            WATTPOST_FIRMWARE_VERSION,
            WATTPOST_BUILD_ID,
            cloud_json_scratch.telemetry,
            sizeof(cloud_json_scratch.telemetry))) {
        record_telemetry_attempt();
        record_telemetry_result(false, telemetry.sample_seq);
        memset(&telemetry, 0, sizeof(telemetry));
        memset(cloud_json_scratch.telemetry, 0, sizeof(cloud_json_scratch.telemetry));
        ESP_LOGW(TAG, "Cloud telemetry snapshot rejected locally");
        return true;
    }

    cloud_response_capture_t capture;
    record_telemetry_attempt();
    record_attempt_start(
        esp_get_free_heap_size(),
        heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));

    int http_status = 0;
    const esp_err_t error = perform_authenticated_request(
        client,
        HTTP_METHOD_PUT,
        CLOUD_TELEMETRY_URL,
        cloud_json_scratch.telemetry,
        &capture,
        &http_status);
    const uint32_t sample_seq = telemetry.sample_seq;
    const bool success =
        error == ESP_OK && http_status == 204;

    memset(&capture, 0, sizeof(capture));
    memset(&telemetry, 0, sizeof(telemetry));
    memset(cloud_json_scratch.telemetry, 0, sizeof(cloud_json_scratch.telemetry));

    if (success) {
        *backoff_ms = wattpost_cloud_retry_after_success();
        record_attempt_result(
            true,
            ESP_OK,
            http_status,
            esp_get_free_heap_size(),
            heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
            *backoff_ms);
        record_telemetry_result(true, sample_seq);
        ESP_LOGD(
            TAG,
            "Cloud telemetry accepted: sample_seq=%lu",
            (unsigned long) sample_seq);
        return true;
    }

    *backoff_ms = wattpost_cloud_retry_after_failure(*backoff_ms);
    record_attempt_result(
        false,
        error == ESP_OK ? ESP_FAIL : error,
        http_status,
        esp_get_free_heap_size(),
        heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
        *backoff_ms);
    record_telemetry_result(false, sample_seq);
    ESP_LOGW(
        TAG,
        "Cloud telemetry failed: err=%s status=%d retry_ms=%lu",
        esp_err_to_name(error == ESP_OK ? ESP_FAIL : error),
        http_status,
        (unsigned long) *backoff_ms);
    return false;
}

static bool interval_due(
    int64_t last_attempt_us,
    uint32_t interval_ms) {
    if (last_attempt_us <= 0) {
        return true;
    }
    const int64_t elapsed_us =
        esp_timer_get_time() - last_attempt_us;
    return elapsed_us >= (int64_t) interval_ms * 1000;
}

static uint32_t settings_crc32(const char *data, size_t length) {
    uint32_t crc = UINT32_MAX;
    for (size_t index = 0u; index < length; ++index) {
        crc ^= (uint8_t) data[index];
        for (uint8_t bit = 0u; bit < 8u; ++bit) {
            crc = (crc & 1u) != 0u
                ? (crc >> 1u) ^ 0xEDB88320u
                : crc >> 1u;
        }
    }
    return ~crc;
}

static void clear_cloud_settings_payload(void) {
    memset(cloud_json_scratch.settings, 0, sizeof(cloud_json_scratch.settings));
}

static bool wrap_cloud_settings_payload(size_t settings_length) {
    static const char prefix[] = CLOUD_SETTINGS_BODY_PREFIX;
    const size_t prefix_length = sizeof(prefix) - 1u;
    if (settings_length == 0u ||
        prefix_length + settings_length + 2u > sizeof(cloud_json_scratch.settings)) {
        return false;
    }

    memmove(
        cloud_json_scratch.settings + prefix_length,
        cloud_json_scratch.settings,
        settings_length);
    memcpy(cloud_json_scratch.settings, prefix, prefix_length);
    cloud_json_scratch.settings[prefix_length + settings_length] = '}';
    cloud_json_scratch.settings[prefix_length + settings_length + 1u] = '\0';
    return true;
}

static void run_settings_check(esp_http_client_handle_t client) {
    cloud_last_settings_check_us = esp_timer_get_time();

    wattpost_cloud_settings_provider_t provider;
    portENTER_CRITICAL(&cloud_lock);
    provider = cloud_settings_provider;
    portEXIT_CRITICAL(&cloud_lock);
    if (provider == NULL) {
        return;
    }

    clear_cloud_settings_payload();
    if (!provider(cloud_json_scratch.settings, sizeof(cloud_json_scratch.settings))) {
        clear_cloud_settings_payload();
        return;
    }

    size_t settings_length = 0u;
    while (settings_length < sizeof(cloud_json_scratch.settings) &&
           cloud_json_scratch.settings[settings_length] != '\0') {
        ++settings_length;
    }
    if (settings_length == 0u || settings_length >= sizeof(cloud_json_scratch.settings)) {
        clear_cloud_settings_payload();
        ESP_LOGW(TAG, "Cloud settings snapshot rejected locally");
        return;
    }

    const uint32_t fingerprint =
        settings_crc32(cloud_json_scratch.settings, settings_length);
    bool force_resend;
    portENTER_CRITICAL(&cloud_lock);
    force_resend = cloud_settings_force_resend;
    portEXIT_CRITICAL(&cloud_lock);
    const bool unchanged = cloud_settings_fingerprint_ready &&
        cloud_settings_fingerprint == fingerprint &&
        cloud_settings_fingerprint_length == settings_length;
    if ((unchanged && !force_resend) ||
        !interval_due(
            cloud_last_settings_attempt_us,
            CLOUD_SETTINGS_ATTEMPT_INTERVAL_MS)) {
        clear_cloud_settings_payload();
        return;
    }

    if (!wrap_cloud_settings_payload(settings_length)) {
        clear_cloud_settings_payload();
        record_settings_attempt();
        record_settings_result(false);
        ESP_LOGW(TAG, "Cloud settings request formatting failed");
        return;
    }

    if (force_resend) {
        portENTER_CRITICAL(&cloud_lock);
        cloud_settings_force_resend = false;
        portEXIT_CRITICAL(&cloud_lock);
    }
    cloud_last_settings_attempt_us = esp_timer_get_time();
    record_settings_attempt();

    cloud_response_capture_t capture;
    int http_status = 0;
    const esp_err_t error = perform_authenticated_request(
        client,
        HTTP_METHOD_PUT,
        CLOUD_SETTINGS_URL,
        cloud_json_scratch.settings,
        &capture,
        &http_status);
    const bool success = error == ESP_OK && http_status == 200;
    memset(&capture, 0, sizeof(capture));
    clear_cloud_settings_payload();

    record_settings_result(success);
    if (!success) {
        portENTER_CRITICAL(&cloud_lock);
        cloud_settings_force_resend = true;
        portEXIT_CRITICAL(&cloud_lock);
        ESP_LOGW(TAG, "Cloud settings upload failed: status=%d", http_status);
        return;
    }

    cloud_settings_fingerprint = fingerprint;
    cloud_settings_fingerprint_length = settings_length;
    cloud_settings_fingerprint_ready = true;
    ESP_LOGD(TAG, "Cloud settings snapshot accepted");
}

static uint32_t interval_remaining_ms(
    int64_t last_attempt_us,
    uint32_t interval_ms) {
    if (last_attempt_us <= 0) {
        return 1u;
    }
    const int64_t elapsed_us =
        esp_timer_get_time() - last_attempt_us;
    const int64_t interval_us =
        (int64_t) interval_ms * 1000;
    if (elapsed_us >= interval_us) {
        return 1u;
    }
    const uint64_t remaining_us =
        (uint64_t) (interval_us - elapsed_us);
    const uint64_t remaining_ms =
        (remaining_us + 999u) / 1000u;
    return remaining_ms > UINT32_MAX
        ? UINT32_MAX
        : (uint32_t) remaining_ms;
}

static bool append_history_record(
    const wattpost_history_record_t *record,
    void *context) {
    wattpost_cloud_history_formatter_t *formatter = context;
    return wattpost_cloud_history_format_append(formatter, record);
}

static void clear_cloud_history_payload(void) {
    memset(cloud_json_scratch.history, 0, sizeof(cloud_json_scratch.history));
    memset(&cloud_history_formatter, 0, sizeof(cloud_history_formatter));
}

static bool run_history_attempt(esp_http_client_handle_t client) {
    cloud_last_history_attempt_us = esp_timer_get_time();
    record_history_attempt();

    if (!cloud_history_cursor_ready) {
        cloud_response_capture_t capture;
        int http_status = 0;
        const esp_err_t error = perform_authenticated_request(
            client,
            HTTP_METHOD_GET,
            CLOUD_HISTORY_STATUS_URL,
            NULL,
            &capture,
            &http_status);
        uint32_t cursor = 0u;
        const bool success =
            error == ESP_OK &&
            http_status == 200 &&
            parse_history_status_response(&capture, &cursor);
        memset(&capture, 0, sizeof(capture));
        if (!success) {
            record_history_result(false, 0u);
            ESP_LOGW(TAG, "Cloud History cursor failed: status=%d", http_status);
            return false;
        }
        cloud_history_cursor = cursor;
        cloud_history_cursor_ready = true;
        record_history_result(true, 0u);
        return true;
    }

    if (!wattpost_cloud_history_format_init(
            &cloud_history_formatter,
            cloud_json_scratch.history,
            sizeof(cloud_json_scratch.history))) {
        clear_cloud_history_payload();
        record_history_result(false, 0u);
        ESP_LOGW(TAG, "Cloud History formatter unavailable");
        return false;
    }

    wattpost_history_query_t query = {
        .limit = WATTPOST_CLOUD_HISTORY_MAX_RECORDS,
        .bound = WATTPOST_HISTORY_AFTER,
        .timestamp = cloud_history_cursor,
    };
    wattpost_history_visit_window(
        &query,
        append_history_record,
        &cloud_history_formatter);
    if (cloud_history_formatter.failed) {
        clear_cloud_history_payload();
        record_history_result(false, 0u);
        ESP_LOGW(TAG, "Cloud History record rejected locally");
        return false;
    }
    if (cloud_history_formatter.count == 0u) {
        clear_cloud_history_payload();
        record_history_result(true, 0u);
        return true;
    }
    if (!wattpost_cloud_history_format_finish(&cloud_history_formatter)) {
        clear_cloud_history_payload();
        record_history_result(false, 0u);
        ESP_LOGW(TAG, "Cloud History batch formatting failed");
        return false;
    }

    const uint16_t record_count = cloud_history_formatter.count;
    const uint32_t last_record_timestamp = cloud_history_formatter.last_timestamp;
    cloud_response_capture_t capture;
    int http_status = 0;
    const esp_err_t error = perform_authenticated_request(
        client,
        HTTP_METHOD_PUT,
        CLOUD_HISTORY_URL,
        cloud_json_scratch.history,
        &capture,
        &http_status);
    uint32_t latest_timestamp = 0u;
    const bool success =
        error == ESP_OK &&
        http_status == 200 &&
        parse_history_upload_response(
            &capture,
            record_count,
            last_record_timestamp,
            &latest_timestamp);
    memset(&capture, 0, sizeof(capture));
    clear_cloud_history_payload();

    if (!success) {
        if (http_status == 409) {
            cloud_history_cursor_ready = false;
        }
        record_history_result(false, 0u);
        ESP_LOGW(TAG, "Cloud History upload failed: status=%d", http_status);
        return false;
    }

    cloud_history_cursor = latest_timestamp;
    record_history_result(true, record_count);
    ESP_LOGD(TAG, "Cloud History batch accepted: records=%u", record_count);
    return true;
}

static bool create_pairing_attempt(
    esp_http_client_handle_t client,
    uint32_t *backoff_ms) {
    cloud_response_capture_t capture;
    record_attempt_start(
        esp_get_free_heap_size(),
        heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));

    int http_status = 0;
    const esp_err_t error = perform_authenticated_request(
        client,
        HTTP_METHOD_POST,
        CLOUD_PAIRINGS_URL,
        NULL,
        &capture,
        &http_status);

    char pairing_id[WATTPOST_CLOUD_PAIRING_ID_MAX_LEN] = {0};
    char pair_url[WATTPOST_CLOUD_PAIR_URL_MAX_LEN] = {0};
    const bool valid_response =
        error == ESP_OK &&
        http_status == 201 &&
        parse_pairing_create_response(
            &capture, pairing_id, pair_url);
    memset(&capture, 0, sizeof(capture));

    if (valid_response) {
        *backoff_ms = wattpost_cloud_retry_after_success();
        record_attempt_result(
            true,
            ESP_OK,
            http_status,
            esp_get_free_heap_size(),
            heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
            *backoff_ms);
        portENTER_CRITICAL(&cloud_lock);
        strlcpy(
            cloud_pairing_id,
            pairing_id,
            sizeof(cloud_pairing_id));
        strlcpy(
            cloud_snapshot.pairing_url,
            pair_url,
            sizeof(cloud_snapshot.pairing_url));
        cloud_snapshot.pairing_state =
            WATTPOST_CLOUD_PAIRING_PENDING;
        cloud_snapshot.pairing_generation =
            cloud_snapshot.action_generation;
        finish_action_locked(
            WATTPOST_CLOUD_ACTION_SUCCESS,
            WATTPOST_CLOUD_ACTION_ERROR_NONE);
        portEXIT_CRITICAL(&cloud_lock);
        memset(pairing_id, 0, sizeof(pairing_id));
        memset(pair_url, 0, sizeof(pair_url));
        return true;
    }

    memset(pairing_id, 0, sizeof(pairing_id));
    memset(pair_url, 0, sizeof(pair_url));

    if (error == ESP_OK && http_status == 409) {
        update_registration_state(true, true);
        record_attempt_result(
            false,
            ESP_FAIL,
            http_status,
            esp_get_free_heap_size(),
            heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
            *backoff_ms);
        finish_pairing_action_error(
            WATTPOST_CLOUD_ACTION_ERROR_ALREADY_PAIRED);
        return false;
    }

    *backoff_ms = wattpost_cloud_retry_after_failure(*backoff_ms);
    record_attempt_result(
        false,
        error == ESP_OK ? ESP_FAIL : error,
        http_status,
        esp_get_free_heap_size(),
        heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
        *backoff_ms);

    if (error == ESP_OK && http_status >= 400 && http_status < 500) {
        finish_pairing_action_error(
            WATTPOST_CLOUD_ACTION_ERROR_REMOTE_REJECTED);
    }
    return false;
}

static bool poll_pairing_attempt(
    esp_http_client_handle_t client,
    uint32_t *backoff_ms,
    const char *pairing_id) {
    char url[CLOUD_PAIRING_STATUS_URL_MAX_LEN];
    const int written = snprintf(
        url,
        sizeof(url),
        CLOUD_PAIRINGS_URL "/%s",
        pairing_id);
    if (written <= 0 || (size_t) written >= sizeof(url)) {
        portENTER_CRITICAL(&cloud_lock);
        clear_pairing_locked(WATTPOST_CLOUD_PAIRING_ERROR);
        portEXIT_CRITICAL(&cloud_lock);
        return false;
    }

    cloud_response_capture_t capture;
    record_attempt_start(
        esp_get_free_heap_size(),
        heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));

    int http_status = 0;
    const esp_err_t error = perform_authenticated_request(
        client,
        HTTP_METHOD_GET,
        url,
        NULL,
        &capture,
        &http_status);
    memset(url, 0, sizeof(url));

    wattpost_cloud_pairing_state_t state =
        WATTPOST_CLOUD_PAIRING_ERROR;
    const bool valid_response =
        error == ESP_OK &&
        http_status == 200 &&
        parse_pairing_status_response(
            &capture, pairing_id, &state);
    memset(&capture, 0, sizeof(capture));

    if (!valid_response) {
        *backoff_ms = wattpost_cloud_retry_after_failure(*backoff_ms);
        record_attempt_result(
            false,
            error == ESP_OK ? ESP_FAIL : error,
            http_status,
            esp_get_free_heap_size(),
            heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
            *backoff_ms);
        if (error == ESP_OK && http_status == 404) {
            portENTER_CRITICAL(&cloud_lock);
            cloud_snapshot.paired_known = true;
            cloud_snapshot.paired = false;
            clear_pairing_locked(WATTPOST_CLOUD_PAIRING_CANCELLED);
            portEXIT_CRITICAL(&cloud_lock);
        }
        return false;
    }

    *backoff_ms = wattpost_cloud_retry_after_success();
    record_attempt_result(
        true,
        ESP_OK,
        http_status,
        esp_get_free_heap_size(),
        heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
        *backoff_ms);

    portENTER_CRITICAL(&cloud_lock);
    cloud_snapshot.pairing_state = state;
    if (state == WATTPOST_CLOUD_PAIRING_CLAIMED) {
        cloud_snapshot.paired_known = true;
        cloud_snapshot.paired = true;
        memset(
            cloud_snapshot.pairing_url,
            0,
            sizeof(cloud_snapshot.pairing_url));
        memset(cloud_pairing_id, 0, sizeof(cloud_pairing_id));
    } else if (state == WATTPOST_CLOUD_PAIRING_EXPIRED ||
               state == WATTPOST_CLOUD_PAIRING_CANCELLED) {
        cloud_snapshot.paired_known = true;
        cloud_snapshot.paired = false;
        memset(
            cloud_snapshot.pairing_url,
            0,
            sizeof(cloud_snapshot.pairing_url));
        memset(cloud_pairing_id, 0, sizeof(cloud_pairing_id));
    }
    portEXIT_CRITICAL(&cloud_lock);
    return true;
}

static void cloud_transport_task(void *unused) {
    (void) unused;
    esp_http_client_handle_t client = NULL;
    uint32_t backoff_ms = 0u;
    bool settings_was_paired = false;

    while (true) {
        update_stack_high_water();

        if (!network_available_snapshot()) {
            set_runtime_state(
                WATTPOST_CLOUD_STATE_WAITING_NETWORK,
                backoff_ms);
            ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
            continue;
        }

        if (client == NULL) {
            client = create_client();
            if (client == NULL) {
                backoff_ms =
                    wattpost_cloud_retry_after_failure(backoff_ms);
                record_attempt_start(
                    esp_get_free_heap_size(),
                    heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
                record_attempt_result(
                    false,
                    ESP_ERR_NO_MEM,
                    0,
                    esp_get_free_heap_size(),
                    heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
                    backoff_ms);
                ulTaskNotifyTake(
                    pdTRUE, pdMS_TO_TICKS(backoff_ms));
                continue;
            }
        }

        wattpost_cloud_action_kind_t action_kind;
        wattpost_cloud_action_state_t action_state;
        bool disconnect_epoch_ready;
        wattpost_cloud_pairing_state_t pairing_state;
        char pairing_id[WATTPOST_CLOUD_PAIRING_ID_MAX_LEN] = {0};
        action_snapshot(
            &action_kind,
            &action_state,
            &disconnect_epoch_ready,
            &pairing_state,
            pairing_id);

        if (action_state == WATTPOST_CLOUD_ACTION_RUNNING &&
            action_kind == WATTPOST_CLOUD_ACTION_DISCONNECT) {
            if (!disconnect_epoch_ready) {
                ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(100u));
                continue;
            }

            bool registered = false;
            bool paired = false;
            if (run_hello_attempt(
                    client,
                    &backoff_ms,
                    &registered,
                    &paired)) {
                if (registered && !paired) {
                    finish_disconnect_action_success();
                    ESP_LOGI(TAG, "Cloud ownership disconnected");
                    ulTaskNotifyTake(
                        pdTRUE,
                        pdMS_TO_TICKS(WATTPOST_CLOUD_HELLO_INTERVAL_MS));
                } else {
                    portENTER_CRITICAL(&cloud_lock);
                    finish_action_locked(
                        WATTPOST_CLOUD_ACTION_ERROR,
                        WATTPOST_CLOUD_ACTION_ERROR_INVALID_RESPONSE);
                    portEXIT_CRITICAL(&cloud_lock);
                }
            } else {
                ulTaskNotifyTake(
                    pdTRUE,
                    pdMS_TO_TICKS(backoff_ms));
            }
            continue;
        }

        if (action_state == WATTPOST_CLOUD_ACTION_RUNNING &&
            action_kind == WATTPOST_CLOUD_ACTION_PAIR &&
            pairing_state == WATTPOST_CLOUD_PAIRING_REQUESTING) {
            bool registered = false;
            bool paired = false;
            if (!run_hello_attempt(
                    client,
                    &backoff_ms,
                    &registered,
                    &paired)) {
                ulTaskNotifyTake(
                    pdTRUE,
                    pdMS_TO_TICKS(backoff_ms));
                continue;
            }
            if (!registered) {
                finish_pairing_action_error(
                    WATTPOST_CLOUD_ACTION_ERROR_INVALID_RESPONSE);
                continue;
            }
            if (paired) {
                finish_pairing_action_error(
                    WATTPOST_CLOUD_ACTION_ERROR_ALREADY_PAIRED);
                continue;
            }

            if (create_pairing_attempt(client, &backoff_ms)) {
                ulTaskNotifyTake(
                    pdTRUE,
                    pdMS_TO_TICKS(CLOUD_PAIRING_POLL_INTERVAL_MS));
            } else if (backoff_ms > 0u) {
                ulTaskNotifyTake(
                    pdTRUE,
                    pdMS_TO_TICKS(backoff_ms));
            }
            continue;
        }

        if (pairing_state == WATTPOST_CLOUD_PAIRING_PENDING &&
            pairing_id[0] != '\0') {
            const bool poll_ok =
                poll_pairing_attempt(
                    client, &backoff_ms, pairing_id);
            memset(pairing_id, 0, sizeof(pairing_id));
            if (poll_ok) {
                wattpost_cloud_transport_snapshot_t snapshot;
                wattpost_cloud_transport_snapshot(&snapshot);
                const uint32_t wait_ms =
                    snapshot.pairing_state ==
                            WATTPOST_CLOUD_PAIRING_PENDING
                        ? CLOUD_PAIRING_POLL_INTERVAL_MS
                        : 1u;
                memset(&snapshot, 0, sizeof(snapshot));
                ulTaskNotifyTake(
                    pdTRUE, pdMS_TO_TICKS(wait_ms));
            } else {
                ulTaskNotifyTake(
                    pdTRUE,
                    pdMS_TO_TICKS(
                        backoff_ms > 0u
                            ? backoff_ms
                            : CLOUD_PAIRING_POLL_INTERVAL_MS));
            }
            continue;
        }

        memset(pairing_id, 0, sizeof(pairing_id));

        wattpost_cloud_transport_snapshot_t regular_snapshot;
        wattpost_cloud_transport_snapshot(&regular_snapshot);

        if (!regular_snapshot.registration_known ||
            interval_due(
                cloud_last_hello_attempt_us,
                WATTPOST_CLOUD_HELLO_INTERVAL_MS)) {
            bool registered = false;
            bool paired = false;
            if (!run_hello_attempt(
                    client,
                    &backoff_ms,
                    &registered,
                    &paired)) {
                memset(&regular_snapshot, 0, sizeof(regular_snapshot));
                update_stack_high_water();
                ulTaskNotifyTake(
                    pdTRUE, pdMS_TO_TICKS(backoff_ms));
                continue;
            }
            ESP_LOGD(TAG, "Cloud hello succeeded");
            wattpost_cloud_transport_snapshot(&regular_snapshot);
        }

        if (regular_snapshot.paired &&
            interval_due(cloud_last_bms_poll_us,
                cloud_bms_kind == CLOUD_BMS_NONE
                    ? CLOUD_BMS_POLL_IDLE_MS : CLOUD_BMS_POLL_ACTIVE_MS)) {
            run_bms_poll_attempt(client);
        }
        if (!regular_snapshot.paired && cloud_bms_kind != CLOUD_BMS_NONE) {
            cloud_bms_kind = CLOUD_BMS_NONE;
            cloud_bms_result_ready = false;
        }

        bool ota_boot_pending = false;
        bool ota_manual_requested = false;
        if (regular_snapshot.paired) {
            bool preference_force_report = false;
            portENTER_CRITICAL(&cloud_lock);
            preference_force_report = cloud_ota_preference_force_report;
            portEXIT_CRITICAL(&cloud_lock);
            if (preference_force_report ||
                interval_due(
                    cloud_last_ota_preference_success_us,
                    CLOUD_OTA_PREFERENCE_INTERVAL_MS)) {
                const bool local_preference =
                    wattpost_remote_ota_automatic_updates_get();
                if (!report_ota_preference(
                        client, local_preference, false, 0u)) {
                    portENTER_CRITICAL(&cloud_lock);
                    cloud_ota_preference_force_report = true;
                    portEXIT_CRITICAL(&cloud_lock);
                }
            }
            ota_boot_pending = process_ota_boot_marker(client);
            portENTER_CRITICAL(&cloud_lock);
            ota_manual_requested = cloud_ota_manual_requested;
            portEXIT_CRITICAL(&cloud_lock);
            if (!ota_boot_pending &&
                (ota_manual_requested ||
                 interval_due(cloud_last_ota_poll_us, CLOUD_OTA_POLL_INTERVAL_MS))) {
                if (!run_ota_poll_attempt(client)) {
                    ESP_LOGW(TAG, "Cloud OTA poll/action failed; local operation continues");
                }
                wattpost_cloud_transport_snapshot(&regular_snapshot);
            }
        }

        bool provider_available;
        bool settings_provider_available;
        portENTER_CRITICAL(&cloud_lock);
        provider_available = cloud_telemetry_provider != NULL;
        settings_provider_available = cloud_settings_provider != NULL;
        portEXIT_CRITICAL(&cloud_lock);

        if (regular_snapshot.paired &&
            provider_available &&
            interval_due(
                cloud_last_telemetry_attempt_us,
                CLOUD_TELEMETRY_INTERVAL_MS)) {
            if (!run_telemetry_attempt(client, &backoff_ms)) {
                memset(&regular_snapshot, 0, sizeof(regular_snapshot));
                update_stack_high_water();
                ulTaskNotifyTake(
                    pdTRUE, pdMS_TO_TICKS(backoff_ms));
                continue;
            }
        }

        if (!regular_snapshot.paired) {
            cloud_history_cursor = 0u;
            ota_snapshot_set(WATTPOST_CLOUD_OTA_IDLE, false, 0u, NULL, NULL, NULL);
            portENTER_CRITICAL(&cloud_lock);
            cloud_ota_manual_requested = false;
            cloud_ota_preference_force_report = true;
            cloud_snapshot.ota_preference_cloud_supported = false;
            cloud_snapshot.ota_preference_cloud_confirmed = false;
            cloud_snapshot.ota_preference_pending = false;
            cloud_snapshot.ota_preference_pending_generation = 0u;
            cloud_snapshot.ota_preference_pending_automatic_updates = false;
            portEXIT_CRITICAL(&cloud_lock);
            cloud_history_cursor_ready = false;
            settings_was_paired = false;
            cloud_settings_fingerprint_ready = false;
            cloud_settings_fingerprint = 0u;
            cloud_settings_fingerprint_length = 0u;
            portENTER_CRITICAL(&cloud_lock);
            cloud_settings_force_resend = false;
            portEXIT_CRITICAL(&cloud_lock);
        } else if (interval_due(
                       cloud_last_history_attempt_us,
                       CLOUD_HISTORY_INTERVAL_MS)) {
            (void) run_history_attempt(client);
        }

        if (regular_snapshot.paired) {
            if (!settings_was_paired) {
                portENTER_CRITICAL(&cloud_lock);
                cloud_settings_force_resend = true;
                portEXIT_CRITICAL(&cloud_lock);
                settings_was_paired = true;
            }
            if (settings_provider_available &&
                interval_due(
                    cloud_last_settings_check_us,
                    CLOUD_SETTINGS_CHECK_INTERVAL_MS)) {
                run_settings_check(client);
            }
        }

        uint32_t wait_ms = interval_remaining_ms(
            cloud_last_hello_attempt_us,
            WATTPOST_CLOUD_HELLO_INTERVAL_MS);
        if (regular_snapshot.paired) {
            if (provider_available) {
                const uint32_t telemetry_wait_ms =
                    interval_remaining_ms(
                        cloud_last_telemetry_attempt_us,
                        CLOUD_TELEMETRY_INTERVAL_MS);
                if (telemetry_wait_ms < wait_ms) {
                    wait_ms = telemetry_wait_ms;
                }
            }
            const uint32_t history_wait_ms = interval_remaining_ms(
                cloud_last_history_attempt_us,
                CLOUD_HISTORY_INTERVAL_MS);
            if (history_wait_ms < wait_ms) {
                wait_ms = history_wait_ms;
            }
            if (settings_provider_available) {
                const uint32_t settings_wait_ms = interval_remaining_ms(
                    cloud_last_settings_check_us,
                    CLOUD_SETTINGS_CHECK_INTERVAL_MS);
                if (settings_wait_ms < wait_ms) {
                    wait_ms = settings_wait_ms;
                }
            }
            const uint32_t bms_wait_ms = interval_remaining_ms(
                cloud_last_bms_poll_us,
                cloud_bms_kind == CLOUD_BMS_NONE
                    ? CLOUD_BMS_POLL_IDLE_MS : CLOUD_BMS_POLL_ACTIVE_MS);
            if (bms_wait_ms < wait_ms) {
                wait_ms = bms_wait_ms;
            }
            const uint32_t ota_wait_ms = interval_remaining_ms(
                cloud_last_ota_poll_us,
                CLOUD_OTA_POLL_INTERVAL_MS);
            if (ota_wait_ms < wait_ms) {
                wait_ms = ota_wait_ms;
            }
            bool preference_force_report = false;
            portENTER_CRITICAL(&cloud_lock);
            preference_force_report = cloud_ota_preference_force_report;
            portEXIT_CRITICAL(&cloud_lock);
            const uint32_t preference_wait_ms = preference_force_report
                ? 1u
                : interval_remaining_ms(
                    cloud_last_ota_preference_success_us,
                    CLOUD_OTA_PREFERENCE_INTERVAL_MS);
            if (preference_wait_ms < wait_ms) {
                wait_ms = preference_wait_ms;
            }
        }

        memset(&regular_snapshot, 0, sizeof(regular_snapshot));
        update_stack_high_water();
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(wait_ms));
    }
}

void wattpost_cloud_transport_set_telemetry_provider(
    wattpost_cloud_telemetry_provider_t provider) {
    TaskHandle_t task;
    portENTER_CRITICAL(&cloud_lock);
    cloud_telemetry_provider = provider;
    task = cloud_task_handle;
    portEXIT_CRITICAL(&cloud_lock);

    if (task != NULL) {
        xTaskNotifyGive(task);
    }
}

void wattpost_cloud_transport_set_settings_provider(
    wattpost_cloud_settings_provider_t provider) {
    TaskHandle_t task;
    portENTER_CRITICAL(&cloud_lock);
    cloud_settings_provider = provider;
    task = cloud_task_handle;
    portEXIT_CRITICAL(&cloud_lock);

    if (task != NULL) {
        xTaskNotifyGive(task);
    }
}

bool wattpost_cloud_transport_start(bool network_available) {
    const bool automatic_updates =
        wattpost_remote_ota_automatic_updates_get();
    portENTER_CRITICAL(&cloud_lock);
    if (cloud_task_handle != NULL) {
        portEXIT_CRITICAL(&cloud_lock);
        return true;
    }
    cloud_network_available = network_available;
    cloud_snapshot.network_available = network_available;
    cloud_snapshot.ota_automatic_updates = automatic_updates;
    cloud_snapshot.state = network_available
        ? WATTPOST_CLOUD_STATE_CONNECTING
        : WATTPOST_CLOUD_STATE_WAITING_NETWORK;
    portEXIT_CRITICAL(&cloud_lock);

    TaskHandle_t task = NULL;
    if (xTaskCreate(
            cloud_transport_task,
            "cloud",
            CLOUD_TASK_STACK_BYTES,
            NULL,
            CLOUD_TASK_PRIORITY,
            &task) != pdPASS) {
        portENTER_CRITICAL(&cloud_lock);
        cloud_snapshot.task_started = false;
        cloud_snapshot.state = WATTPOST_CLOUD_STATE_DISABLED;
        portEXIT_CRITICAL(&cloud_lock);
        return false;
    }

    portENTER_CRITICAL(&cloud_lock);
    cloud_task_handle = task;
    cloud_snapshot.task_started = true;
    portEXIT_CRITICAL(&cloud_lock);
    return true;
}

void wattpost_cloud_transport_network_changed(bool network_available) {
    TaskHandle_t task;
    portENTER_CRITICAL(&cloud_lock);
    if (network_available && !cloud_network_available) {
        cloud_settings_force_resend = true;
    }
    cloud_network_available = network_available;
    cloud_snapshot.network_available = network_available;
    task = cloud_task_handle;
    portEXIT_CRITICAL(&cloud_lock);

    if (task != NULL) {
        xTaskNotifyGive(task);
    }
}

void wattpost_cloud_transport_ota_preference_changed(bool enabled) {
    TaskHandle_t task;
    portENTER_CRITICAL(&cloud_lock);
    cloud_snapshot.ota_automatic_updates = enabled;
    cloud_ota_preference_force_report = true;
    task = cloud_task_handle;
    portEXIT_CRITICAL(&cloud_lock);
    if (task != NULL) {
        xTaskNotifyGive(task);
    }
}

wattpost_cloud_action_start_result_t
wattpost_cloud_transport_pairing_start(uint32_t *operation_generation) {
    if (!operation_generation) {
        return WATTPOST_CLOUD_ACTION_START_UNAVAILABLE;
    }

    TaskHandle_t task;
    portENTER_CRITICAL(&cloud_lock);
    if (cloud_task_handle == NULL) {
        portEXIT_CRITICAL(&cloud_lock);
        return WATTPOST_CLOUD_ACTION_START_UNAVAILABLE;
    }
    if (!cloud_network_available) {
        portEXIT_CRITICAL(&cloud_lock);
        return WATTPOST_CLOUD_ACTION_START_UNAVAILABLE;
    }
    if (cloud_snapshot.action_state == WATTPOST_CLOUD_ACTION_RUNNING ||
        cloud_snapshot.pairing_state == WATTPOST_CLOUD_PAIRING_PENDING) {
        portEXIT_CRITICAL(&cloud_lock);
        return WATTPOST_CLOUD_ACTION_START_BUSY;
    }
    if (cloud_snapshot.paired_known && cloud_snapshot.paired) {
        portEXIT_CRITICAL(&cloud_lock);
        return WATTPOST_CLOUD_ACTION_START_ALREADY_PAIRED;
    }

    cloud_action_generation =
        next_generation(cloud_action_generation);
    cloud_snapshot.action_generation = cloud_action_generation;
    cloud_snapshot.action_kind = WATTPOST_CLOUD_ACTION_PAIR;
    cloud_snapshot.action_state = WATTPOST_CLOUD_ACTION_RUNNING;
    cloud_snapshot.action_error = WATTPOST_CLOUD_ACTION_ERROR_NONE;
    cloud_snapshot.pairing_state =
        WATTPOST_CLOUD_PAIRING_REQUESTING;
    cloud_snapshot.pairing_generation =
        cloud_action_generation;
    memset(
        cloud_snapshot.pairing_url,
        0,
        sizeof(cloud_snapshot.pairing_url));
    memset(cloud_pairing_id, 0, sizeof(cloud_pairing_id));
    *operation_generation = cloud_action_generation;
    task = cloud_task_handle;
    portEXIT_CRITICAL(&cloud_lock);

    xTaskNotifyGive(task);
    return WATTPOST_CLOUD_ACTION_START_OK;
}

wattpost_cloud_action_start_result_t
wattpost_cloud_transport_disconnect_start(uint32_t *operation_generation) {
    if (!operation_generation) {
        return WATTPOST_CLOUD_ACTION_START_UNAVAILABLE;
    }

    TaskHandle_t task;
    uint32_t generation;
    portENTER_CRITICAL(&cloud_lock);
    if (cloud_task_handle == NULL) {
        portEXIT_CRITICAL(&cloud_lock);
        return WATTPOST_CLOUD_ACTION_START_UNAVAILABLE;
    }
    if (cloud_snapshot.action_state == WATTPOST_CLOUD_ACTION_RUNNING) {
        portEXIT_CRITICAL(&cloud_lock);
        return WATTPOST_CLOUD_ACTION_START_BUSY;
    }
    if (!cloud_snapshot.paired_known || !cloud_snapshot.paired) {
        portEXIT_CRITICAL(&cloud_lock);
        return WATTPOST_CLOUD_ACTION_START_NOT_PAIRED;
    }

    cloud_action_generation =
        next_generation(cloud_action_generation);
    generation = cloud_action_generation;
    cloud_snapshot.action_generation = generation;
    cloud_snapshot.action_kind =
        WATTPOST_CLOUD_ACTION_DISCONNECT;
    cloud_snapshot.action_state =
        WATTPOST_CLOUD_ACTION_RUNNING;
    cloud_snapshot.action_error =
        WATTPOST_CLOUD_ACTION_ERROR_NONE;
    cloud_snapshot.disconnect_pending = true;
    cloud_disconnect_epoch_ready = false;
    *operation_generation = generation;
    task = cloud_task_handle;
    portEXIT_CRITICAL(&cloud_lock);

    wattpost_device_identity_t updated_identity;
    const bool advanced =
        wattpost_device_identity_advance_ownership_epoch(
            &updated_identity);
    memset(&updated_identity, 0, sizeof(updated_identity));

    portENTER_CRITICAL(&cloud_lock);
    if (!advanced) {
        cloud_snapshot.disconnect_pending = false;
        finish_action_locked(
            WATTPOST_CLOUD_ACTION_ERROR,
            WATTPOST_CLOUD_ACTION_ERROR_STORAGE);
        cloud_disconnect_epoch_ready = false;
        portEXIT_CRITICAL(&cloud_lock);
        return WATTPOST_CLOUD_ACTION_START_STORAGE_ERROR;
    }
    cloud_disconnect_epoch_ready = true;
    clear_pairing_locked(WATTPOST_CLOUD_PAIRING_NONE);
    portEXIT_CRITICAL(&cloud_lock);

    xTaskNotifyGive(task);
    return WATTPOST_CLOUD_ACTION_START_OK;
}

wattpost_cloud_action_start_result_t
wattpost_cloud_transport_ota_install_start(void) {
    TaskHandle_t task;
    portENTER_CRITICAL(&cloud_lock);
    if (cloud_task_handle == NULL || !cloud_network_available) {
        portEXIT_CRITICAL(&cloud_lock);
        return WATTPOST_CLOUD_ACTION_START_UNAVAILABLE;
    }
    if (!cloud_snapshot.paired_known || !cloud_snapshot.paired) {
        portEXIT_CRITICAL(&cloud_lock);
        return WATTPOST_CLOUD_ACTION_START_NOT_PAIRED;
    }
    if (cloud_snapshot.action_state == WATTPOST_CLOUD_ACTION_RUNNING ||
        cloud_snapshot.ota_state == WATTPOST_CLOUD_OTA_DOWNLOADING ||
        cloud_snapshot.ota_state == WATTPOST_CLOUD_OTA_VERIFYING ||
        cloud_snapshot.ota_state == WATTPOST_CLOUD_OTA_INSTALLING) {
        portEXIT_CRITICAL(&cloud_lock);
        return WATTPOST_CLOUD_ACTION_START_BUSY;
    }
    cloud_ota_manual_requested = true;
    task = cloud_task_handle;
    portEXIT_CRITICAL(&cloud_lock);
    xTaskNotifyGive(task);
    return WATTPOST_CLOUD_ACTION_START_OK;
}

bool wattpost_cloud_transport_snapshot(
    wattpost_cloud_transport_snapshot_t *snapshot) {
    if (!snapshot) {
        return false;
    }
    int64_t last_success_us;
    int64_t last_telemetry_success_us;
    int64_t last_settings_success_us;
    portENTER_CRITICAL(&cloud_lock);
    *snapshot = cloud_snapshot;
    last_success_us = cloud_last_success_us;
    last_telemetry_success_us = cloud_last_telemetry_success_us;
    last_settings_success_us = cloud_last_settings_success_us;
    portEXIT_CRITICAL(&cloud_lock);
    snapshot->last_success_age_s = age_seconds(last_success_us);
    snapshot->telemetry_last_success_age_s =
        age_seconds(last_telemetry_success_us);
    snapshot->settings_last_success_age_s =
        age_seconds(last_settings_success_us);
    return true;
}

const char *wattpost_cloud_state_str(wattpost_cloud_state_t state) {
    switch (state) {
        case WATTPOST_CLOUD_STATE_DISABLED: return "disabled";
        case WATTPOST_CLOUD_STATE_WAITING_NETWORK: return "waiting_network";
        case WATTPOST_CLOUD_STATE_CONNECTING: return "connecting";
        case WATTPOST_CLOUD_STATE_ONLINE: return "online";
        case WATTPOST_CLOUD_STATE_BACKOFF: return "backoff";
        default: return "unknown";
    }
}

const char *wattpost_cloud_pairing_state_str(
    wattpost_cloud_pairing_state_t state) {
    switch (state) {
        case WATTPOST_CLOUD_PAIRING_NONE: return "none";
        case WATTPOST_CLOUD_PAIRING_REQUESTING: return "requesting";
        case WATTPOST_CLOUD_PAIRING_PENDING: return "pending";
        case WATTPOST_CLOUD_PAIRING_CLAIMED: return "claimed";
        case WATTPOST_CLOUD_PAIRING_EXPIRED: return "expired";
        case WATTPOST_CLOUD_PAIRING_CANCELLED: return "cancelled";
        case WATTPOST_CLOUD_PAIRING_ERROR: return "error";
        default: return "unknown";
    }
}

const char *wattpost_cloud_action_kind_str(
    wattpost_cloud_action_kind_t kind) {
    switch (kind) {
        case WATTPOST_CLOUD_ACTION_NONE: return "none";
        case WATTPOST_CLOUD_ACTION_PAIR: return "pair";
        case WATTPOST_CLOUD_ACTION_DISCONNECT: return "disconnect";
        default: return "unknown";
    }
}

const char *wattpost_cloud_action_state_str(
    wattpost_cloud_action_state_t state) {
    switch (state) {
        case WATTPOST_CLOUD_ACTION_IDLE: return "idle";
        case WATTPOST_CLOUD_ACTION_RUNNING: return "running";
        case WATTPOST_CLOUD_ACTION_SUCCESS: return "success";
        case WATTPOST_CLOUD_ACTION_ERROR: return "error";
        default: return "unknown";
    }
}

const char *wattpost_cloud_action_error_str(
    wattpost_cloud_action_error_t error) {
    switch (error) {
        case WATTPOST_CLOUD_ACTION_ERROR_NONE: return NULL;
        case WATTPOST_CLOUD_ACTION_ERROR_CLOUD_UNAVAILABLE:
            return "cloud_unavailable";
        case WATTPOST_CLOUD_ACTION_ERROR_ALREADY_PAIRED:
            return "already_paired";
        case WATTPOST_CLOUD_ACTION_ERROR_NOT_PAIRED:
            return "not_paired";
        case WATTPOST_CLOUD_ACTION_ERROR_STORAGE:
            return "storage_error";
        case WATTPOST_CLOUD_ACTION_ERROR_REMOTE_REJECTED:
            return "remote_rejected";
        case WATTPOST_CLOUD_ACTION_ERROR_INVALID_RESPONSE:
            return "invalid_response";
        default:
            return "internal_error";
    }
}

const char *wattpost_cloud_ota_state_str(wattpost_cloud_ota_state_t state) {
    switch (state) {
        case WATTPOST_CLOUD_OTA_IDLE: return "idle";
        case WATTPOST_CLOUD_OTA_AVAILABLE: return "available";
        case WATTPOST_CLOUD_OTA_DOWNLOADING: return "downloading";
        case WATTPOST_CLOUD_OTA_VERIFYING: return "verifying";
        case WATTPOST_CLOUD_OTA_INSTALLING: return "installing";
        case WATTPOST_CLOUD_OTA_SUCCESS: return "success";
        case WATTPOST_CLOUD_OTA_FAILED: return "failed";
        case WATTPOST_CLOUD_OTA_ROLLED_BACK: return "rolled_back";
        default: return "unknown";
    }
}
