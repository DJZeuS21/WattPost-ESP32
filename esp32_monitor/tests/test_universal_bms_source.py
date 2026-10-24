import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
KCONFIG = (ROOT / "main" / "Kconfig.projbuild").read_text(encoding="utf-8")
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
BLE = (ROOT / "main" / "jk_bms_ble.c").read_text(encoding="utf-8")
BLE_HEADER = (ROOT / "main" / "jk_bms_ble.h").read_text(encoding="utf-8")


class UniversalBmsSourceTests(unittest.TestCase):
    def test_compile_time_bms_mac_removed(self):
        self.assertNotIn("WATTPOST_BMS_MAC", KCONFIG)
        self.assertNotIn("CONFIG_WATTPOST_BMS_MAC", BLE)

    def test_ble_start_accepts_runtime_target(self):
        self.assertIn(
            "jk_bms_ble_start(const jk_bms_ble_target_t *target)",
            BLE,
        )
        self.assertIn(
            "bool jk_bms_ble_start(const jk_bms_ble_target_t *target);",
            BLE_HEADER,
        )

    def test_missing_target_does_not_start_automatic_scan(self):
        self.assertIn("configured && !connected && !connecting", BLE)
        self.assertIn("scan_owner == BLE_SCAN_OWNER_NONE", BLE)
        self.assertIn("configure_target(target)", BLE)

    def test_nvs_address_is_converted_only_at_ble_boundary(self):
        self.assertIn(
            "target_address.val[JK_BMS_BLE_ADDRESS_LEN - 1 - index]",
            BLE,
        )

    def test_normal_status_exposes_only_short_address_hint(self):
        self.assertIn("bms_address_hint", MAIN)
        self.assertNotIn("bms_mac", MAIN)
        self.assertNotIn("\"bms_address\"", MAIN)


if __name__ == "__main__":
    unittest.main()
