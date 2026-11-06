#include "jk_bms_write_transaction.h"

#include <ctype.h>
#include <string.h>

/* Deadlines only bound one explicit operation, not BLE lifetime/recovery.
 * One transport write, one settings request; no automatic retry. */
#define QUEUED_TIMEOUT_US INT64_C(10000000)
#define READBACK_TIMEOUT_US INT64_C(15000000)

static bool terminal(jk_bms_write_tx_state_t state) {
    return state == JK_BMS_WRITE_TX_IDLE ||
           state == JK_BMS_WRITE_TX_VERIFIED ||
           state == JK_BMS_WRITE_TX_MISMATCH ||
           state == JK_BMS_WRITE_TX_UNCERTAIN ||
           state == JK_BMS_WRITE_TX_NOT_SENT;
}

bool jk_bms_write_transaction_active(const jk_bms_write_transaction_t *tx) {
    return tx != NULL && !terminal(tx->state);
}

void jk_bms_write_transaction_init(jk_bms_write_transaction_t *tx) {
    if (tx == NULL) {
        return;
    }
    memset(tx, 0, sizeof(*tx));
    tx->state = JK_BMS_WRITE_TX_IDLE;
}

bool jk_bms_write_transaction_begin(
    jk_bms_write_transaction_t *tx,
    const jk_bms_write_command_t *command,
    uint32_t connection_epoch, int64_t now_us) {
    if (tx == NULL || command == NULL || command->spec == NULL ||
        connection_epoch == 0u || now_us < 0 ||
        jk_bms_write_transaction_active(tx)) {
        return false;
    }
    ++tx->generation;
    if (tx->generation == 0u) {
        tx->generation = 1u;
    }
    tx->command = *command;
    tx->reason = JK_BMS_WRITE_REASON_NONE;
    tx->connection_epoch = connection_epoch;
    tx->read_baseline = 0;
    tx->deadline_us = now_us + QUEUED_TIMEOUT_US;
    tx->state = JK_BMS_WRITE_TX_QUEUED;
    return true;
}

void jk_bms_write_transaction_disconnect(jk_bms_write_transaction_t *tx) {
    if (!jk_bms_write_transaction_active(tx)) {
        return;
    }
    /* An operation reserved for dispatch may already have reached NimBLE.
     * The only definitely unsent phase is QUEUED. */
    tx->state = tx->state == JK_BMS_WRITE_TX_QUEUED
                    ? JK_BMS_WRITE_TX_NOT_SENT
                    : JK_BMS_WRITE_TX_UNCERTAIN;
    tx->reason = JK_BMS_WRITE_REASON_LINK_CHANGED;
}

jk_bms_write_tx_action_t jk_bms_write_transaction_next(
    jk_bms_write_transaction_t *tx, uint32_t connection_epoch,
    int64_t now_us) {
    if (!jk_bms_write_transaction_active(tx)) {
        return JK_BMS_WRITE_TX_ACTION_NONE;
    }
    if (connection_epoch == 0u || connection_epoch != tx->connection_epoch) {
        jk_bms_write_transaction_disconnect(tx);
        return JK_BMS_WRITE_TX_ACTION_NONE;
    }
    if (now_us >= tx->deadline_us) {
        const jk_bms_write_tx_state_t old_state = tx->state;
        tx->state = old_state == JK_BMS_WRITE_TX_QUEUED
            ? JK_BMS_WRITE_TX_NOT_SENT : JK_BMS_WRITE_TX_UNCERTAIN;
        tx->reason = old_state == JK_BMS_WRITE_TX_QUEUED
            ? JK_BMS_WRITE_REASON_QUEUE_TIMEOUT
            : old_state == JK_BMS_WRITE_TX_VERIFYING
                ? JK_BMS_WRITE_REASON_READBACK_TIMEOUT
                : JK_BMS_WRITE_REASON_OPERATION_TIMEOUT;
        return JK_BMS_WRITE_TX_ACTION_NONE;
    }
    if (tx->state == JK_BMS_WRITE_TX_QUEUED) {
        tx->state = JK_BMS_WRITE_TX_SENDING;
        return JK_BMS_WRITE_TX_ACTION_SEND_WRITE;
    }
    if (tx->state == JK_BMS_WRITE_TX_READ_QUEUED) {
        tx->state = JK_BMS_WRITE_TX_READING;
        return JK_BMS_WRITE_TX_ACTION_REQUEST_SETTINGS;
    }
    return JK_BMS_WRITE_TX_ACTION_NONE;
}

void jk_bms_write_transaction_write_sent(
    jk_bms_write_transaction_t *tx, uint32_t generation,
    uint32_t connection_epoch, bool accepted_by_host, int64_t now_us) {
    if (tx == NULL || tx->state != JK_BMS_WRITE_TX_SENDING ||
        generation != tx->generation) {
        return;
    }
    if (connection_epoch != tx->connection_epoch || !accepted_by_host) {
        tx->state = JK_BMS_WRITE_TX_UNCERTAIN;
        tx->reason = connection_epoch != tx->connection_epoch
            ? JK_BMS_WRITE_REASON_LINK_CHANGED
            : JK_BMS_WRITE_REASON_WRITE_TRANSPORT;
    } else {
        tx->state = JK_BMS_WRITE_TX_READ_QUEUED;
        tx->deadline_us = now_us + READBACK_TIMEOUT_US;
    }
}

void jk_bms_write_transaction_read_requested(
    jk_bms_write_transaction_t *tx, uint32_t generation,
    uint32_t connection_epoch, bool accepted_by_host,
    uint32_t read_baseline, int64_t now_us) {
    if (tx == NULL || tx->state != JK_BMS_WRITE_TX_READING ||
        generation != tx->generation) {
        return;
    }
    if (connection_epoch != tx->connection_epoch || !accepted_by_host) {
        tx->state = JK_BMS_WRITE_TX_UNCERTAIN;
        tx->reason = connection_epoch != tx->connection_epoch
            ? JK_BMS_WRITE_REASON_LINK_CHANGED
            : JK_BMS_WRITE_REASON_READ_TRANSPORT;
    } else {
        tx->read_baseline = read_baseline;
        tx->state = JK_BMS_WRITE_TX_VERIFYING;
        tx->deadline_us = now_us + READBACK_TIMEOUT_US;
    }
}

void jk_bms_write_transaction_receive(
    jk_bms_write_transaction_t *tx, uint32_t connection_epoch,
    const jk_bms_settings_t *settings) {
    if (tx == NULL || tx->state != JK_BMS_WRITE_TX_VERIFYING ||
        tx->connection_epoch != connection_epoch) {
        return;
    }
    const jk_bms_write_readback_t compared =
        jk_bms_write_compare(&tx->command, settings, tx->read_baseline);
    if (compared == JK_BMS_WRITE_READBACK_MATCH) {
        tx->state = JK_BMS_WRITE_TX_VERIFIED;
    } else if (compared == JK_BMS_WRITE_READBACK_MISMATCH) {
        tx->state = JK_BMS_WRITE_TX_MISMATCH;
    }
}

/* Require an explicit known model prefix, not the read parser's fallback.
 * This is a conservative classifier, NOT proof of a specific hardware variant.
 */
static bool prefix(const char *model, const char *known) {
    if (model == NULL || known == NULL) return false;
    for (; *known; ++model, ++known) {
        if (!*model) return false;
        char candidate = (char) toupper((unsigned char) *model);
        if (candidate == '-') candidate = '_';
        if (candidate != *known) return false;
    }
    return true;
}

bool jk_bms_write_model_supported(const char *model) {
    return prefix(model, "JK_PB") ||
           prefix(model, "JK_B2A") ||
           prefix(model, "JK_B1A") ||
           prefix(model, "JK_02_32") ||
           prefix(model, "JK02_32");
}

/* A bounded, user-triggered, read-only BLE settings refresh. */
#define REFRESH_QUEUE_TIMEOUT_US INT64_C(10000000)
#define REFRESH_READ_TIMEOUT_US INT64_C(15000000)

void jk_bms_settings_refresh_init(jk_bms_settings_refresh_t *probe) {
    if (!probe) return;
    memset(probe, 0, sizeof(*probe));
    probe->state = JK_BMS_REFRESH_IDLE;
}

bool jk_bms_settings_refresh_active(const jk_bms_settings_refresh_t *probe) {
    return probe && (probe->state == JK_BMS_REFRESH_QUEUED ||
                     probe->state == JK_BMS_REFRESH_REQUESTING ||
                     probe->state == JK_BMS_REFRESH_WAITING);
}

bool jk_bms_settings_refresh_begin(jk_bms_settings_refresh_t *probe,
                                   uint32_t epoch, int64_t now_us) {
    if (!probe || !epoch || now_us < 0 || jk_bms_settings_refresh_active(probe))
        return false;
    if (++probe->generation == 0u) probe->generation = 1u;
    probe->connection_epoch = epoch;
    probe->reason = JK_BMS_REFRESH_REASON_NONE;
    probe->read_baseline = 0u;
    probe->state = JK_BMS_REFRESH_QUEUED;
    probe->deadline_us = now_us + REFRESH_QUEUE_TIMEOUT_US;
    return true;
}

void jk_bms_settings_refresh_disconnect(jk_bms_settings_refresh_t *probe) {
    if (!jk_bms_settings_refresh_active(probe)) return;
    probe->state = JK_BMS_REFRESH_UNAVAILABLE;
    probe->reason = JK_BMS_REFRESH_REASON_LINK_CHANGED;
}

bool jk_bms_settings_refresh_next(jk_bms_settings_refresh_t *probe,
                                  uint32_t epoch, int64_t now_us) {
    if (!jk_bms_settings_refresh_active(probe)) return false;
    if (!epoch || epoch != probe->connection_epoch) {
        jk_bms_settings_refresh_disconnect(probe);
        return false;
    }
    if (now_us >= probe->deadline_us) {
        probe->reason = probe->state == JK_BMS_REFRESH_QUEUED
            ? JK_BMS_REFRESH_REASON_QUEUE_TIMEOUT
            : JK_BMS_REFRESH_REASON_READ_TIMEOUT;
        probe->state = JK_BMS_REFRESH_UNAVAILABLE;
        return false;
    }
    if (probe->state != JK_BMS_REFRESH_QUEUED) return false;
    probe->state = JK_BMS_REFRESH_REQUESTING;
    return true;
}

void jk_bms_settings_refresh_requested(jk_bms_settings_refresh_t *probe,
                                        uint32_t generation, uint32_t epoch,
                                        bool accepted, uint32_t baseline,
                                        int64_t now_us) {
    if (!probe || probe->state != JK_BMS_REFRESH_REQUESTING ||
        generation != probe->generation) return;
    if (epoch != probe->connection_epoch || !accepted) {
        probe->state = JK_BMS_REFRESH_UNAVAILABLE;
        probe->reason = epoch != probe->connection_epoch
            ? JK_BMS_REFRESH_REASON_LINK_CHANGED
            : JK_BMS_REFRESH_REASON_READ_TRANSPORT;
    } else {
        probe->read_baseline = baseline;
        probe->state = JK_BMS_REFRESH_WAITING;
        probe->deadline_us = now_us + REFRESH_READ_TIMEOUT_US;
    }
}

void jk_bms_settings_refresh_receive(jk_bms_settings_refresh_t *probe,
                                      uint32_t epoch, uint32_t received_count) {
    if (!probe ||
        (probe->state != JK_BMS_REFRESH_WAITING &&
         probe->state != JK_BMS_REFRESH_REQUESTING) ||
        epoch != probe->connection_epoch ||
        received_count <= probe->read_baseline) return;
    probe->state = JK_BMS_REFRESH_RECEIVED;
}
