"""Narrow remote connection control must not grow into remote BMS setting writes."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "main" / "cloud_transport.c").read_text(encoding="utf-8")


class CloudBmsSourceTests(unittest.TestCase):
    def test_outgoing_https_only_no_remote_settings(self):
        section = SOURCE.split("/* Explicit browser-originated BMS *connection* commands only.", 1)[1].split("static bool report_ota_status", 1)[0]
        self.assertIn('CLOUD_BMS_COMMAND_URL', SOURCE)
        self.assertIn('CLOUD_BMS_RESULT_URL', SOURCE)
        for name in ('jk_bms_ble_scan_start(', 'jk_bms_ble_select_start(', 'jk_bms_ble_reconnect_start('):
            self.assertIn(name, section)
        for forbidden in ('settings_write(', 'jk_bms_ble_forget_start(', 'wattpost_history_erase(', 'nvs_erase(', 'esp_restart('):
            self.assertNotIn(forbidden, section)
        self.assertIn('cJSON_AddStringToObject(item, "address_hint"', section)
        self.assertNotIn('cJSON_AddStringToObject(item, "address"', section)

    def test_result_dedup_and_cloud_outage_local_isolation(self):
        section = SOURCE.split('static bool cloud_bms_report(', 1)[1].split('static bool report_ota_status(', 1)[0]
        self.assertIn('status == 200 || status == 409', section)
        self.assertIn('CLOUD_BMS_POLL_IDLE_MS', SOURCE)
        self.assertIn('CLOUD_BMS_POLL_ACTIVE_MS', SOURCE)
        self.assertIn('if (regular_snapshot.paired &&', SOURCE)


if __name__ == '__main__':
    unittest.main()
