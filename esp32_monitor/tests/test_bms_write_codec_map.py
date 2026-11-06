"""Keep the JK02_32S write allowlist aligned with the canonical UI schema.

The new codec is offline-only; entries here are not proof of hardware writes.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = (ROOT / "web/js/settings-schema.js").read_text()
CODEC = (ROOT / "main/jk_bms_write_codec.c").read_text()

# Missing write evidence or ambiguous wire-length/readback semantics.
DEFERRED = {
    "battery.device_address",
    "cell_voltage.smart_sleep_v",
    "current_limits.discharge_precharge_s",
    "switches.special_charger",
    "switches.port_is_rs485",
    "switches.gps_heartbeat",
}


class JkBmsWriteMapTest(unittest.TestCase):
    def test_ui_schema_coverage_is_explicit(self):
        ui_section = SCHEMA.split("const SETTINGS_SCHEMA = [", 1)[1].split("];", 1)[0]
        ui_keys = re.findall(r"^\s*key: '([^']+)'", ui_section, re.M)
        self.assertEqual(len(ui_keys), 53)
        self.assertEqual(len(ui_keys), len(set(ui_keys)))

        mapped = re.findall(
            r'^\s*(?:UF|SF|U32|U8|I8|B)\("([^"]+)"',
            CODEC.split("static const jk_bms_write_spec_t write_specs[] = {", 1)[1].split("};", 1)[0],
            re.M,
        )
        self.assertEqual(len(mapped), len(set(mapped)))
        self.assertEqual(set(ui_keys) - set(mapped), DEFERRED)
        self.assertFalse(set(mapped) - set(ui_keys))
        self.assertFalse(set(mapped) & DEFERRED)

    def test_no_network_or_ble_write_activation_in_codec(self):
        self.assertNotIn("ble_gattc_write", CODEC)
        self.assertNotIn("httpd_register_uri_handler", CODEC)

    def test_write_transport_is_local_only_and_connection_scoped(self):
        ble = (ROOT / "main/jk_bms_ble.c").read_text()
        main = (ROOT / "main/main.c").read_text()
        local = (ROOT / "web/js/transports/local-transport.js").read_text()
        cloud = (ROOT / "web/js/transports/cloud-transport.js").read_text()
        parser = (ROOT / "main/bms_write_request.c").read_text()

        self.assertIn("jk_bms_ble_write_start(", ble)
        self.assertIn("jk_bms_write_transaction_receive(", ble)
        self.assertIn("double expected_before", ble)
        self.assertIn("expected_connection_epoch != ble_connection_epoch", ble)
        self.assertIn("JK_BMS_BLE_WRITE_START_STALE_VALUE", ble)
        self.assertIn("jk_bms_write_compare(", ble)
        self.assertIn("event->notify_rx.conn_handle == connection_handle", ble)
        self.assertIn("jk_bms_ble_write_start(", main)
        self.assertIn('local_write_available', main)
        self.assertIn("bms_write_policy_handler", main)
        self.assertIn("bms_write_status_handler", main)
        self.assertIn("bms_write_start_handler", main)
        self.assertIn("local_mutation_request_allowed(request)", main)
        self.assertIn("!first_setup_ap_active && !recovery_ap_active", main)
        self.assertEqual(main.count('"/api/device/bms/settings/write"'), 2)
        self.assertIn('"/api/device/bms/settings/write-policy"', main)
        self.assertIn("wattpost_bms_write_request_parse(", main)
        self.assertIn("expected_before", parser)
        self.assertIn("connection_epoch", parser)
        self.assertIn("jk_bms_write_find(", parser)
        self.assertIn("bmsSettingsWrite: true", local)
        self.assertIn("bmsSettingsWrite: false", cloud)
        self.assertNotIn("startBmsSettingWrite", cloud)
        self.assertIn("fetchBmsWriteOperation", local)
        self.assertIn("startBmsSettingWrite", local)
        self.assertIn("startBmsSettingsRefresh", local)
        self.assertIn("fetchBmsSettingsRefresh", local)
        self.assertNotIn("startBmsSettingsRefresh", cloud)
        self.assertEqual(main.count('"/api/device/bms/settings/refresh"'), 2)
        self.assertIn("bms_refresh_start_handler", main)
        self.assertIn("bms_refresh_status_handler", main)
        self.assertIn("jk_bms_settings_refresh_receive(", ble)
        self.assertIn("jk_bms_settings_refresh_active(&settings_refresh)", ble)


if __name__ == "__main__":
    unittest.main()
