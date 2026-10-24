#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "cloud_transport_format.h"

#define WATTPOST_CLOUD_PAIR_URL_MAX_LEN 160u
#define WATTPOST_CLOUD_PAIRING_ID_MAX_LEN 48u
#define WATTPOST_CLOUD_OTA_VERSION_MAX_LEN 24u
#define WATTPOST_CLOUD_OTA_BUILD_ID_MAX_LEN 13u
#define WATTPOST_CLOUD_OTA_ERROR_MAX_LEN 64u

typedef enum {
    WATTPOST_CLOUD_STATE_DISABLED = 0,
    WATTPOST_CLOUD_STATE_WAITING_NETWORK,
    WATTPOST_CLOUD_STATE_CONNECTING,
    WATTPOST_CLOUD_STATE_ONLINE,
    WATTPOST_CLOUD_STATE_BACKOFF,
} wattpost_cloud_state_t;

typedef enum {
    WATTPOST_CLOUD_PAIRING_NONE = 0,
    WATTPOST_CLOUD_PAIRING_REQUESTING,
    WATTPOST_CLOUD_PAIRING_PENDING,
    WATTPOST_CLOUD_PAIRING_CLAIMED,
    WATTPOST_CLOUD_PAIRING_EXPIRED,
    WATTPOST_CLOUD_PAIRING_CANCELLED,
    WATTPOST_CLOUD_PAIRING_ERROR,
} wattpost_cloud_pairing_state_t;

typedef enum {
    WATTPOST_CLOUD_ACTION_NONE = 0,
    WATTPOST_CLOUD_ACTION_PAIR,
    WATTPOST_CLOUD_ACTION_DISCONNECT,
} wattpost_cloud_action_kind_t;

typedef enum {
    WATTPOST_CLOUD_ACTION_IDLE = 0,
    WATTPOST_CLOUD_ACTION_RUNNING,
    WATTPOST_CLOUD_ACTION_SUCCESS,
    WATTPOST_CLOUD_ACTION_ERROR,
} wattpost_cloud_action_state_t;

typedef enum {
    WATTPOST_CLOUD_ACTION_ERROR_NONE = 0,
    WATTPOST_CLOUD_ACTION_ERROR_CLOUD_UNAVAILABLE,
    WATTPOST_CLOUD_ACTION_ERROR_ALREADY_PAIRED,
    WATTPOST_CLOUD_ACTION_ERROR_NOT_PAIRED,
    WATTPOST_CLOUD_ACTION_ERROR_STORAGE,
    WATTPOST_CLOUD_ACTION_ERROR_REMOTE_REJECTED,
    WATTPOST_CLOUD_ACTION_ERROR_INVALID_RESPONSE,
} wattpost_cloud_action_error_t;

typedef enum {
    WATTPOST_CLOUD_OTA_IDLE = 0,
    WATTPOST_CLOUD_OTA_AVAILABLE,
    WATTPOST_CLOUD_OTA_DOWNLOADING,
    WATTPOST_CLOUD_OTA_VERIFYING,
    WATTPOST_CLOUD_OTA_INSTALLING,
    WATTPOST_CLOUD_OTA_SUCCESS,
    WATTPOST_CLOUD_OTA_FAILED,
    WATTPOST_CLOUD_OTA_ROLLED_BACK,
} wattpost_cloud_ota_state_t;

typedef enum {
    WATTPOST_CLOUD_ACTION_START_OK = 0,
    WATTPOST_CLOUD_ACTION_START_BUSY,
    WATTPOST_CLOUD_ACTION_START_UNAVAILABLE,
    WATTPOST_CLOUD_ACTION_START_ALREADY_PAIRED,
    WATTPOST_CLOUD_ACTION_START_NOT_PAIRED,
    WATTPOST_CLOUD_ACTION_START_STORAGE_ERROR,
} wattpost_cloud_action_start_result_t;

typedef bool (*wattpost_cloud_telemetry_provider_t)(
    wattpost_cloud_telemetry_t *telemetry);
typedef bool (*wattpost_cloud_settings_provider_t)(
    char *json,
    size_t capacity);

typedef struct {
    bool task_started;
    bool network_available;
    wattpost_cloud_state_t state;
    uint32_t attempts;
    uint32_t successes;
    uint32_t failures;
    int32_t last_http_status;
    int32_t last_esp_error;
    uint32_t current_backoff_ms;
    uint32_t stack_free_min_bytes;
    uint32_t heap_free_before_last;
    uint32_t heap_free_after_last;
    uint32_t largest_free_before_last;
    uint32_t largest_free_after_last;
    uint32_t last_success_age_s;

    uint32_t telemetry_attempts;
    uint32_t telemetry_successes;
    uint32_t telemetry_failures;
    uint32_t telemetry_last_sample_seq;
    uint32_t telemetry_last_success_age_s;

    uint32_t history_attempts;
    uint32_t history_successes;
    uint32_t history_failures;
    uint32_t history_records_sent;

    uint32_t settings_attempts;
    uint32_t settings_successes;
    uint32_t settings_failures;
    uint32_t settings_last_success_age_s;

    bool registration_known;
    bool registered;
    bool paired_known;
    bool paired;

    wattpost_cloud_pairing_state_t pairing_state;
    uint32_t pairing_generation;
    char pairing_url[WATTPOST_CLOUD_PAIR_URL_MAX_LEN];

    wattpost_cloud_action_kind_t action_kind;
    wattpost_cloud_action_state_t action_state;
    wattpost_cloud_action_error_t action_error;
    uint32_t action_generation;
    bool disconnect_pending;

    bool ota_automatic_updates;
    bool ota_preference_cloud_supported;
    bool ota_preference_cloud_confirmed;
    bool ota_preference_cloud_automatic_updates;
    bool ota_preference_pending;
    uint32_t ota_preference_pending_generation;
    bool ota_preference_pending_automatic_updates;
    uint32_t ota_preference_last_success_age_s;
    bool ota_update_available;
    wattpost_cloud_ota_state_t ota_state;
    uint32_t ota_release_id;
    uint32_t ota_progress_bytes;
    uint32_t ota_progress_total;
    uint32_t ota_progress_attempt;
    char ota_target_version[WATTPOST_CLOUD_OTA_VERSION_MAX_LEN];
    char ota_target_build_id[WATTPOST_CLOUD_OTA_BUILD_ID_MAX_LEN];
    char ota_error[WATTPOST_CLOUD_OTA_ERROR_MAX_LEN];
} wattpost_cloud_transport_snapshot_t;

/*
 * Registers the source of the current scrubbed telemetry snapshot. The callback
 * is invoked immediately before an upload, so outage/retry never creates a
 * backlog of old live samples.
 */
void wattpost_cloud_transport_set_telemetry_provider(
    wattpost_cloud_telemetry_provider_t provider);

/* Provides only the current valid canonical settings JSON; the Cloud task owns
 * its output buffer and decides when a changed snapshot needs upload. */
void wattpost_cloud_transport_set_settings_provider(
    wattpost_cloud_settings_provider_t provider);

/*
 * Starts the best-effort Cloud task. Failure to start must never block local
 * firmware operation.
 */
bool wattpost_cloud_transport_start(bool network_available);

/*
 * Called by the Wi-Fi/IP event path. This only wakes/suspends Cloud work; it
 * never owns Wi-Fi recovery and never triggers a reboot.
 */
void wattpost_cloud_transport_network_changed(bool network_available);

/*
 * Queue a local pairing request. The Cloud task performs network work
 * asynchronously. The safe one-time pairing URL appears in the snapshot when
 * the backend creates it.
 */
wattpost_cloud_action_start_result_t
wattpost_cloud_transport_pairing_start(uint32_t *operation_generation);

/*
 * Explicitly disconnect the current Cloud ownership. This persists a newer
 * ownership_epoch first, so an offline request survives reboot semantically:
 * the next authenticated hello clears the old server-side owner.
 */
wattpost_cloud_action_start_result_t
wattpost_cloud_transport_disconnect_start(uint32_t *operation_generation);

/* Request the newest published release immediately as an explicit user action.
 * This remains allowed even when the device-owned automatic-update preference is
 * disabled. */
wattpost_cloud_action_start_result_t wattpost_cloud_transport_ota_install_start(void);

/* Keep the diagnostic/runtime snapshot coherent with a locally persisted
 * preference change and wake the existing Cloud task; no new task or session is
 * created. */
void wattpost_cloud_transport_ota_preference_changed(bool enabled);

bool wattpost_cloud_transport_snapshot(
    wattpost_cloud_transport_snapshot_t *snapshot);

const char *wattpost_cloud_state_str(wattpost_cloud_state_t state);
const char *wattpost_cloud_pairing_state_str(
    wattpost_cloud_pairing_state_t state);
const char *wattpost_cloud_action_kind_str(wattpost_cloud_action_kind_t kind);
const char *wattpost_cloud_action_state_str(wattpost_cloud_action_state_t state);
const char *wattpost_cloud_action_error_str(
    wattpost_cloud_action_error_t error);
const char *wattpost_cloud_ota_state_str(wattpost_cloud_ota_state_t state);
