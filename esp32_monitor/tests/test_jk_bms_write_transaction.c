#include "jk_bms_write_transaction.h"

#include <assert.h>
#include <stdio.h>

#define EPOCH 17u

static jk_bms_write_command_t command(void) {
    jk_bms_write_command_t cmd = {0};
    assert(jk_bms_write_prepare("cell_voltage.ovp_v", 3.65, &cmd) == JK_BMS_WRITE_OK);
    return cmd;
}

static void until_readback(jk_bms_write_transaction_t *tx) {
    jk_bms_write_command_t cmd = command();
    jk_bms_write_transaction_init(tx);
    assert(jk_bms_write_transaction_begin(tx, &cmd, EPOCH, 1000000));
    assert(jk_bms_write_transaction_next(tx, EPOCH, 1100000) ==
           JK_BMS_WRITE_TX_ACTION_SEND_WRITE);
    assert(jk_bms_write_transaction_next(tx, EPOCH, 1200000) ==
           JK_BMS_WRITE_TX_ACTION_NONE);
    jk_bms_write_transaction_write_sent(tx, tx->generation, EPOCH, true, 1300000);
    assert(tx->state == JK_BMS_WRITE_TX_READ_QUEUED);
    assert(jk_bms_write_transaction_next(tx, EPOCH, 2100000) ==
           JK_BMS_WRITE_TX_ACTION_REQUEST_SETTINGS);
    jk_bms_write_transaction_read_requested(
        tx, tx->generation, EPOCH, true, 5, 2200000);
    assert(tx->state == JK_BMS_WRITE_TX_VERIFYING);
}

static void test_success_and_mismatch(void) {
    jk_bms_write_transaction_t tx;
    until_readback(&tx);
    jk_bms_settings_t snapshot = {.valid = true, .received_count = 5,
                                  .cell_ovp_v = 3.65f};
    jk_bms_write_transaction_receive(&tx, EPOCH, &snapshot);
    assert(tx.state == JK_BMS_WRITE_TX_VERIFYING);
    snapshot.received_count = 6;
    jk_bms_write_transaction_receive(&tx, EPOCH + 1, &snapshot);
    assert(tx.state == JK_BMS_WRITE_TX_VERIFYING);
    jk_bms_write_transaction_receive(&tx, EPOCH, &snapshot);
    assert(tx.state == JK_BMS_WRITE_TX_VERIFIED);
    assert(!jk_bms_write_transaction_active(&tx));

    jk_bms_write_command_t cmd = command();
    assert(jk_bms_write_transaction_begin(&tx, &cmd, EPOCH, 3000000));
    assert(tx.state == JK_BMS_WRITE_TX_QUEUED);
    until_readback(&tx);
    snapshot.cell_ovp_v = 3.60f;
    jk_bms_write_transaction_receive(&tx, EPOCH, &snapshot);
    assert(tx.state == JK_BMS_WRITE_TX_MISMATCH);
}

static void test_disconnect_races(void) {
    jk_bms_write_transaction_t tx = {0};
    jk_bms_write_command_t cmd = command();
    assert(jk_bms_write_transaction_begin(&tx, &cmd, EPOCH, 0));
    jk_bms_write_transaction_disconnect(&tx);
    assert(tx.state == JK_BMS_WRITE_TX_NOT_SENT);

    assert(jk_bms_write_transaction_begin(&tx, &cmd, EPOCH, 100));
    assert(jk_bms_write_transaction_next(&tx, EPOCH, 200) ==
           JK_BMS_WRITE_TX_ACTION_SEND_WRITE);
    jk_bms_write_transaction_disconnect(&tx);
    assert(tx.state == JK_BMS_WRITE_TX_UNCERTAIN);
    jk_bms_write_transaction_write_sent(&tx, tx.generation, EPOCH, true, 300);
    assert(tx.state == JK_BMS_WRITE_TX_UNCERTAIN);

    assert(jk_bms_write_transaction_begin(&tx, &cmd, EPOCH, 500));
    assert(jk_bms_write_transaction_next(&tx, EPOCH, 550) ==
           JK_BMS_WRITE_TX_ACTION_SEND_WRITE);
    jk_bms_write_transaction_write_sent(&tx, tx.generation, EPOCH, false, 570);
    assert(tx.state == JK_BMS_WRITE_TX_UNCERTAIN);
    assert(jk_bms_write_transaction_next(&tx, EPOCH, 600) ==
           JK_BMS_WRITE_TX_ACTION_NONE);

    assert(jk_bms_write_transaction_begin(&tx, &cmd, EPOCH, 700));
    assert(jk_bms_write_transaction_next(&tx, EPOCH + 1, 800) ==
           JK_BMS_WRITE_TX_ACTION_NONE);
    assert(tx.state == JK_BMS_WRITE_TX_NOT_SENT);
}

static void test_timeout_and_no_retry(void) {
    jk_bms_write_transaction_t tx = {0};
    jk_bms_write_command_t cmd = command();
    assert(jk_bms_write_transaction_begin(&tx, &cmd, EPOCH, 10));
    assert(jk_bms_write_transaction_next(&tx, EPOCH, 10000010) ==
           JK_BMS_WRITE_TX_ACTION_NONE);
    assert(tx.state == JK_BMS_WRITE_TX_NOT_SENT);

    until_readback(&tx);
    assert(jk_bms_write_transaction_next(&tx, EPOCH, 17200001) ==
           JK_BMS_WRITE_TX_ACTION_NONE);
    assert(tx.state == JK_BMS_WRITE_TX_UNCERTAIN);
    assert(tx.reason == JK_BMS_WRITE_REASON_READBACK_TIMEOUT);
    assert(jk_bms_write_transaction_next(&tx, EPOCH, 20000000) ==
           JK_BMS_WRITE_TX_ACTION_NONE);
}

static void test_read_request_failure(void) {
    jk_bms_write_transaction_t tx = {0};
    jk_bms_write_command_t cmd = command();
    assert(jk_bms_write_transaction_begin(&tx, &cmd, EPOCH, 10));
    assert(jk_bms_write_transaction_next(&tx, EPOCH, 20) ==
           JK_BMS_WRITE_TX_ACTION_SEND_WRITE);
    jk_bms_write_transaction_write_sent(&tx, tx.generation, EPOCH, true, 30);
    assert(jk_bms_write_transaction_next(&tx, EPOCH, 40) ==
           JK_BMS_WRITE_TX_ACTION_REQUEST_SETTINGS);
    jk_bms_write_transaction_read_requested(&tx, tx.generation, EPOCH, false, 5, 50);
    assert(tx.state == JK_BMS_WRITE_TX_UNCERTAIN);
}

static void test_readonly_refresh_requires_new_settings_frame(void) {
    jk_bms_settings_refresh_t probe;
    jk_bms_settings_refresh_init(&probe);
    assert(jk_bms_settings_refresh_begin(&probe, EPOCH, 1000000));
    assert(jk_bms_settings_refresh_active(&probe));
    assert(jk_bms_settings_refresh_next(&probe, EPOCH, 1100000));
    assert(!jk_bms_settings_refresh_next(&probe, EPOCH, 1200000));
    const uint32_t gen = probe.generation;
    jk_bms_settings_refresh_requested(&probe, gen, EPOCH, true, 9u, 1300000);
    jk_bms_settings_refresh_receive(&probe, EPOCH, 9u);
    assert(probe.state == JK_BMS_REFRESH_WAITING);
    jk_bms_settings_refresh_receive(&probe, EPOCH + 1, 10u);
    assert(probe.state == JK_BMS_REFRESH_WAITING);
    jk_bms_settings_refresh_receive(&probe, EPOCH, 10u);
    assert(probe.state == JK_BMS_REFRESH_RECEIVED);
    assert(!jk_bms_settings_refresh_active(&probe));
    assert(jk_bms_settings_refresh_begin(&probe, EPOCH, 2000000));
    assert(jk_bms_settings_refresh_next(&probe, EPOCH, 2100000));
    /* A fast BLE settings notification may beat the GATT send's return. */
    probe.read_baseline = 10u;
    jk_bms_settings_refresh_receive(&probe, EPOCH, 11u);
    assert(probe.state == JK_BMS_REFRESH_RECEIVED);
    jk_bms_settings_refresh_requested(&probe, probe.generation, EPOCH, true, 10u, 2150000);
    assert(probe.state == JK_BMS_REFRESH_RECEIVED);
    assert(jk_bms_settings_refresh_begin(&probe, EPOCH, 2100000));
    assert(jk_bms_settings_refresh_next(&probe, EPOCH, 2100100));
    jk_bms_settings_refresh_requested(&probe, probe.generation, EPOCH, false, 10u, 2200000);
    assert(probe.state == JK_BMS_REFRESH_UNAVAILABLE);
    assert(probe.reason == JK_BMS_REFRESH_REASON_READ_TRANSPORT);
    assert(jk_bms_settings_refresh_begin(&probe, EPOCH, 3000000));
    assert(jk_bms_settings_refresh_next(&probe, EPOCH, 3100000));
    jk_bms_settings_refresh_requested(&probe, probe.generation, EPOCH, true, 10u, 3200000);
    assert(!jk_bms_settings_refresh_next(&probe, EPOCH, 18300001));
    assert(probe.state == JK_BMS_REFRESH_UNAVAILABLE);
    assert(probe.reason == JK_BMS_REFRESH_REASON_READ_TIMEOUT);
    assert(jk_bms_settings_refresh_begin(&probe, EPOCH, 20000000));
    jk_bms_settings_refresh_disconnect(&probe);
    assert(probe.reason == JK_BMS_REFRESH_REASON_LINK_CHANGED);
    assert(jk_bms_settings_refresh_begin(&probe, EPOCH, 22000000));
    assert(!jk_bms_settings_refresh_next(&probe, EPOCH, 33000000));
    assert(probe.reason == JK_BMS_REFRESH_REASON_QUEUE_TIMEOUT);
}

static void test_models(void) {
    assert(jk_bms_write_model_supported("JK_PB2A16S20P"));
    assert(jk_bms_write_model_supported("JK-PB2A16S20P"));
    assert(jk_bms_write_model_supported("jk_b2a24s"));
    assert(jk_bms_write_model_supported("JK_02_32S"));
    assert(!jk_bms_write_model_supported(NULL));
    assert(!jk_bms_write_model_supported(""));
    assert(!jk_bms_write_model_supported("JK04"));
    assert(!jk_bms_write_model_supported("JK02_24S"));
    assert(!jk_bms_write_model_supported("UNKNOWN"));
}

int main(void) {
    test_success_and_mismatch();
    test_disconnect_races();
    test_timeout_and_no_retry();
    test_read_request_failure();
    test_models();
    test_readonly_refresh_requires_new_settings_frame();
    puts("JK BMS write transaction: OK");
    return 0;
}
