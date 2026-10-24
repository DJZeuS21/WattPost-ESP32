#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "jk_bms_parser.h"

#define JK_BMS_BLE_ADDRESS_LEN 6u
#define JK_BMS_BLE_SCAN_MAX_CANDIDATES 12u
#define JK_BMS_BLE_SCAN_NAME_MAX_LEN 31u
#define JK_BMS_BLE_ADDRESS_HINT_MAX_LEN 11u

typedef enum {
    JK_BMS_BLE_SCAN_IDLE = 0,
    JK_BMS_BLE_SCAN_RUNNING,
    JK_BMS_BLE_SCAN_SUCCESS,
    JK_BMS_BLE_SCAN_ERROR,
} jk_bms_ble_scan_state_t;

typedef enum {
    JK_BMS_BLE_SCAN_START_OK = 0,
    JK_BMS_BLE_SCAN_START_BUSY,
    JK_BMS_BLE_SCAN_START_UNAVAILABLE,
} jk_bms_ble_scan_start_result_t;

typedef enum {
    JK_BMS_BLE_OPERATION_IDLE = 0,
    JK_BMS_BLE_OPERATION_RUNNING,
    JK_BMS_BLE_OPERATION_SUCCESS,
    JK_BMS_BLE_OPERATION_ERROR,
} jk_bms_ble_operation_state_t;

typedef enum {
    JK_BMS_BLE_PHASE_NONE = 0,
    JK_BMS_BLE_PHASE_SCANNING,
    JK_BMS_BLE_PHASE_CONNECTING,
    JK_BMS_BLE_PHASE_VALIDATING,
    JK_BMS_BLE_PHASE_SAVING,
    JK_BMS_BLE_PHASE_RECONNECTING,
    JK_BMS_BLE_PHASE_RESETTING,
} jk_bms_ble_operation_phase_t;

typedef enum {
    JK_BMS_BLE_ERROR_NONE = 0,
    JK_BMS_BLE_ERROR_BUSY,
    JK_BMS_BLE_ERROR_STALE_SCAN,
    JK_BMS_BLE_ERROR_CANDIDATE_NOT_FOUND,
    JK_BMS_BLE_ERROR_CONNECT_FAILED,
    JK_BMS_BLE_ERROR_INVALID_BMS,
    JK_BMS_BLE_ERROR_STORAGE,
    JK_BMS_BLE_ERROR_SUBSYSTEM_UNAVAILABLE,
} jk_bms_ble_operation_error_t;

typedef struct {
    uint32_t generation;
    jk_bms_ble_operation_state_t state;
    jk_bms_ble_operation_phase_t phase;
    jk_bms_ble_operation_error_t error;
} jk_bms_ble_operation_snapshot_t;

typedef enum {
    JK_BMS_BLE_SELECT_START_OK = 0,
    JK_BMS_BLE_SELECT_START_BUSY,
    JK_BMS_BLE_SELECT_START_STALE_SCAN,
    JK_BMS_BLE_SELECT_START_NOT_FOUND,
    JK_BMS_BLE_SELECT_START_UNAVAILABLE,
} jk_bms_ble_select_start_result_t;

typedef enum {
    JK_BMS_BLE_RECONNECT_START_OK = 0,
    JK_BMS_BLE_RECONNECT_START_NOT_CONFIGURED,
    JK_BMS_BLE_RECONNECT_START_BUSY,
    JK_BMS_BLE_RECONNECT_START_UNAVAILABLE,
} jk_bms_ble_reconnect_start_result_t;

typedef enum {
    JK_BMS_BLE_FORGET_START_OK = 0,
    JK_BMS_BLE_FORGET_START_NOT_CONFIGURED,
    JK_BMS_BLE_FORGET_START_BUSY,
} jk_bms_ble_forget_start_result_t;

typedef struct {
    uint16_t candidate_id;
    char name[JK_BMS_BLE_SCAN_NAME_MAX_LEN + 1u];
    int8_t rssi_dbm;
    char address_hint[JK_BMS_BLE_ADDRESS_HINT_MAX_LEN + 1u];
} jk_bms_ble_scan_candidate_t;

typedef struct {
    uint32_t generation;
    jk_bms_ble_scan_state_t state;
    int error_status;
    jk_bms_ble_operation_snapshot_t operation;
    size_t candidate_count;
    jk_bms_ble_scan_candidate_t
        candidates[JK_BMS_BLE_SCAN_MAX_CANDIDATES];
} jk_bms_ble_scan_snapshot_t;

typedef struct {
    uint8_t address_type;
    /* Canonical display order: AA:BB:CC:DD:EE:FF. */
    uint8_t address[JK_BMS_BLE_ADDRESS_LEN];
} jk_bms_ble_target_t;

bool jk_bms_ble_start(const jk_bms_ble_target_t *target);
jk_bms_ble_scan_start_result_t jk_bms_ble_scan_start(uint32_t *operation_generation);
bool jk_bms_ble_scan_snapshot(jk_bms_ble_scan_snapshot_t *snapshot);
jk_bms_ble_select_start_result_t jk_bms_ble_select_start(
    uint32_t scan_generation,
    uint16_t candidate_id,
    uint32_t *operation_generation);
bool jk_bms_ble_select_take_validated_target(
    jk_bms_ble_target_t *target,
    uint32_t *operation_generation);
bool jk_bms_ble_select_commit(uint32_t operation_generation, bool persisted);
jk_bms_ble_reconnect_start_result_t jk_bms_ble_reconnect_start(
    uint32_t *operation_generation);
jk_bms_ble_forget_start_result_t jk_bms_ble_forget_start(
    uint32_t *operation_generation);
bool jk_bms_ble_forget_commit(
    uint32_t operation_generation,
    bool persisted);
bool jk_bms_ble_operation_snapshot(jk_bms_ble_operation_snapshot_t *snapshot);
bool jk_bms_ble_has_target(void);
bool jk_bms_ble_is_connected(void);
const char *jk_bms_ble_state(void);
const char *jk_bms_ble_phase(void);
uint32_t jk_bms_ble_connection_attempts(void);
uint32_t jk_bms_ble_connection_successes(void);
uint32_t jk_bms_ble_disconnect_count(void);
int jk_bms_ble_last_disconnect_reason(void);
uint32_t jk_bms_ble_connection_uptime(void);
uint32_t jk_bms_ble_recovery_count(void);
uint32_t jk_bms_ble_poll_stack_free_min_bytes(void);
uint32_t jk_bms_ble_last_valid_frame_age(void);
uint32_t jk_bms_ble_down_time(void);
uint32_t jk_bms_ble_notifications(void);
uint32_t jk_bms_ble_notification_bytes(void);
uint16_t jk_bms_ble_last_notification_length(void);
uint8_t jk_bms_ble_last_frame_type(void);
uint32_t jk_bms_ble_frame_count(uint8_t type);
int jk_bms_ble_last_status(void);
bool jk_bms_ble_get_data(jk_bms_data_t *data);
bool jk_bms_ble_get_settings(jk_bms_settings_t *settings);
bool jk_bms_ble_get_device_info(jk_bms_device_info_t *device_info);

