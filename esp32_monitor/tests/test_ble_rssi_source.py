import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BLE = (ROOT / "main/jk_bms_ble.c").read_text(encoding="utf-8")
HEADER = (ROOT / "main/jk_bms_ble.h").read_text(encoding="utf-8")
MAIN = (ROOT / "main/main.c").read_text(encoding="utf-8")


class BleRssiSourceTests(unittest.TestCase):
    def test_controller_rssi_read_uses_active_connection_and_epoch_guard(self):
        poll = BLE[BLE.index("static void poll_task(void *parameter) {"):
                   BLE.index("bool jk_bms_ble_start(")]
        self.assertIn("ble_gap_conn_rssi(sample_conn_handle, &measured_rssi)", poll)
        self.assertIn("sample_conn_handle = connection_handle", poll)
        self.assertIn("sample_epoch = ble_connection_epoch", poll)
        self.assertIn("ble_connection_epoch == sample_epoch", poll)
        self.assertIn("connection_handle == sample_conn_handle", poll)
        self.assertIn("rc == 0 && measured_rssi != 127", poll)
        self.assertIn("JK_BMS_RSSI_POLL_INTERVAL_SECONDS 10u", BLE)
        self.assertLess(poll.index("portEXIT_CRITICAL(&data_lock);\n\n        if (sample_rssi)"),
                        poll.index("ble_gap_conn_rssi(sample_conn_handle"))

    def test_sample_is_diagnostic_only_and_does_not_change_recovery(self):
        poll = BLE[BLE.index("static void poll_task(void *parameter) {"):
                   BLE.index("bool jk_bms_ble_start(")]
        probe = poll[poll.index("if (sample_rssi) {"):
                     poll.index("if (action == POLL_RECOVER)", poll.index("if (sample_rssi) {"))]
        self.assertNotIn("ble_gap_terminate", probe)
        self.assertNotIn("send_command", probe)
        self.assertNotIn("restart", probe)
        self.assertNotIn("nvs_", probe)
        self.assertIn("action == POLL_NONE", poll)

    def test_stale_rssi_is_kept_through_disconnect_but_not_new_target(self):
        gap = BLE[BLE.index("static int gap_event(struct ble_gap_event *event, void *arg) {"):
                  BLE.index("static void on_reset(int reason)")]
        disconnect = gap[gap.index("case BLE_GAP_EVENT_DISCONNECT"):
                         gap.index("case BLE_GAP_EVENT_NOTIFY_RX")]
        self.assertIn("next_rssi_sample_seconds = 0", disconnect)
        self.assertNotIn("last_rssi_measured_us = 0", disconnect)
        self.assertIn("last_rssi_measured_us = 0", BLE[BLE.index("bool jk_bms_ble_select_commit"):
                                                          BLE.index("jk_bms_ble_reconnect_start_result_t jk_bms_ble_reconnect_start")])
        self.assertIn("last_rssi_measured_us = 0", BLE[BLE.index("bool jk_bms_ble_forget_commit"):
                                                          BLE.index("bool jk_bms_ble_scan_snapshot")])
        getter = BLE[BLE.index("bool jk_bms_ble_rssi_snapshot("):
                     BLE.index("const char *jk_bms_ble_state")]
        self.assertIn("snapshot->age_s <= JK_BMS_RSSI_FRESH_SECONDS", getter)
        self.assertIn("sample_epoch == epoch", getter)
        self.assertIn("link_connected", getter)

    def test_api_uses_numeric_current_or_null_and_last_age(self):
        self.assertIn("jk_bms_ble_rssi_snapshot_t", HEADER)
        handler = MAIN[MAIN.index("static esp_err_t device_status_handler"):
                       MAIN.index("typedef struct {", MAIN.index("static esp_err_t device_status_handler"))]
        self.assertIn("jk_bms_ble_rssi_snapshot(&bms_rssi)", handler)
        for key in ('rssi_dbm', 'rssi_last_dbm', 'rssi_last_age_s'):
            self.assertIn('\\\"' + key + '\\"', handler)
        self.assertIn('if (bms_rssi.current)', handler)
        self.assertIn('if (bms_rssi.valid)', handler)
        self.assertNotIn('\\\"rssi_dbm\\\":null', handler)


if __name__ == "__main__":
    unittest.main()
