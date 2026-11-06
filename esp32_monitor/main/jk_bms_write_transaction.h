#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "jk_bms_write_codec.h"

/* One on-demand JK02_32S write transaction; no automatic retries.
 * Local LAN mutation eligibility and CAS validation are checked separately.
 * Both write and read-refresh trackers are protected by BLE data_lock.
 */
typedef enum {
    JK_BMS_WRITE_TX_IDLE = 0,
    JK_BMS_WRITE_TX_QUEUED,
    JK_BMS_WRITE_TX_SENDING,
    JK_BMS_WRITE_TX_READ_QUEUED,
    JK_BMS_WRITE_TX_READING,
    JK_BMS_WRITE_TX_VERIFYING,
    JK_BMS_WRITE_TX_VERIFIED,
    JK_BMS_WRITE_TX_MISMATCH,
    JK_BMS_WRITE_TX_UNCERTAIN,
    JK_BMS_WRITE_TX_NOT_SENT,
} jk_bms_write_tx_state_t;

typedef enum {
    JK_BMS_WRITE_TX_ACTION_NONE = 0,
    JK_BMS_WRITE_TX_ACTION_SEND_WRITE,
    JK_BMS_WRITE_TX_ACTION_REQUEST_SETTINGS,
} jk_bms_write_tx_action_t;

typedef enum {
    JK_BMS_WRITE_REASON_NONE = 0,
    JK_BMS_WRITE_REASON_QUEUE_TIMEOUT,
    JK_BMS_WRITE_REASON_LINK_CHANGED,
    JK_BMS_WRITE_REASON_WRITE_TRANSPORT,
    JK_BMS_WRITE_REASON_READ_TRANSPORT,
    JK_BMS_WRITE_REASON_READBACK_TIMEOUT,
    JK_BMS_WRITE_REASON_OPERATION_TIMEOUT,
} jk_bms_write_reason_t;

typedef enum {
    JK_BMS_REFRESH_IDLE = 0,
    JK_BMS_REFRESH_QUEUED,
    JK_BMS_REFRESH_REQUESTING,
    JK_BMS_REFRESH_WAITING,
    JK_BMS_REFRESH_RECEIVED,
    JK_BMS_REFRESH_UNAVAILABLE,
} jk_bms_refresh_state_t;

typedef enum {
    JK_BMS_REFRESH_REASON_NONE = 0,
    JK_BMS_REFRESH_REASON_LINK_CHANGED,
    JK_BMS_REFRESH_REASON_QUEUE_TIMEOUT,
    JK_BMS_REFRESH_REASON_READ_TRANSPORT,
    JK_BMS_REFRESH_REASON_READ_TIMEOUT,
} jk_bms_refresh_reason_t;

typedef struct {
    jk_bms_refresh_state_t state;
    jk_bms_refresh_reason_t reason;
    uint32_t generation;
    uint32_t connection_epoch;
    uint32_t read_baseline;
    int64_t deadline_us;
} jk_bms_settings_refresh_t;

typedef struct {
    jk_bms_write_tx_state_t state;
    jk_bms_write_reason_t reason;
    uint32_t generation;
    uint32_t connection_epoch;
    uint32_t read_baseline;
    int64_t deadline_us;
    jk_bms_write_command_t command;
} jk_bms_write_transaction_t;

void jk_bms_write_transaction_init(jk_bms_write_transaction_t *tx);

bool jk_bms_write_transaction_begin(
    jk_bms_write_transaction_t *tx,
    const jk_bms_write_command_t *command,
    uint32_t connection_epoch, int64_t now_us);

jk_bms_write_tx_action_t jk_bms_write_transaction_next(
    jk_bms_write_transaction_t *tx, uint32_t connection_epoch, int64_t now_us);

void jk_bms_write_transaction_write_sent(
    jk_bms_write_transaction_t *tx, uint32_t generation,
    uint32_t connection_epoch, bool accepted_by_host, int64_t now_us);

void jk_bms_write_transaction_read_requested(
    jk_bms_write_transaction_t *tx, uint32_t generation,
    uint32_t connection_epoch, bool accepted_by_host,
    uint32_t read_baseline, int64_t now_us);

void jk_bms_write_transaction_receive(
    jk_bms_write_transaction_t *tx, uint32_t connection_epoch,
    const jk_bms_settings_t *settings);

void jk_bms_write_transaction_disconnect(jk_bms_write_transaction_t *tx);

/* Only known JK02_32S model signatures are eligible; the telemetry fallback
 * that assumes JK02_32S for unrecognized models is NOT appropriate for writes.
 */
bool jk_bms_write_model_supported(const char *model);

bool jk_bms_write_transaction_active(const jk_bms_write_transaction_t *tx);

/* An explicit read-only 0x96 probe, never a second BMS settings write.
 * Only a NEW settings frame from the same BLE connection can complete it.
 */
void jk_bms_settings_refresh_init(jk_bms_settings_refresh_t *probe);
bool jk_bms_settings_refresh_active(const jk_bms_settings_refresh_t *probe);
bool jk_bms_settings_refresh_begin(jk_bms_settings_refresh_t *probe,
                                   uint32_t connection_epoch, int64_t now_us);
bool jk_bms_settings_refresh_next(jk_bms_settings_refresh_t *probe,
                                  uint32_t connection_epoch, int64_t now_us);
void jk_bms_settings_refresh_requested(jk_bms_settings_refresh_t *probe,
                                        uint32_t generation, uint32_t connection_epoch,
                                        bool accepted_by_host, uint32_t baseline,
                                        int64_t now_us);
void jk_bms_settings_refresh_receive(jk_bms_settings_refresh_t *probe,
                                      uint32_t connection_epoch, uint32_t received_count);
void jk_bms_settings_refresh_disconnect(jk_bms_settings_refresh_t *probe);
