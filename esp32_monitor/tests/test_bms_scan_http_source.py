import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")


def block(start_marker, end_marker):
    start = MAIN.index(start_marker)
    end = MAIN.index(end_marker, start)
    return MAIN[start:end]


class BmsScanHttpSourceTests(unittest.TestCase):
    def test_scan_routes_are_registered(self):
        self.assertGreaterEqual(MAIN.count('"/api/device/bms/scan"'), 2)
        self.assertIn(".handler = bms_scan_start_handler", MAIN)
        self.assertIn(".handler = bms_scan_get_handler", MAIN)

    def test_post_uses_local_mutation_security_gate(self):
        handler = block(
            "static esp_err_t bms_scan_start_handler",
            "static esp_err_t bms_scan_get_handler",
        )
        self.assertIn("local_mutation_request_allowed(request)", handler)
        self.assertIn("jk_bms_ble_scan_start(&generation)", handler)
        self.assertIn('"202 Accepted"', handler)
        self.assertIn('"409 Conflict"', handler)
        self.assertIn('"busy"', handler)

    def test_get_is_host_protected(self):
        handler = block(
            "static esp_err_t bms_scan_get_handler",
            "static esp_err_t bms_select_start_handler",
        )
        self.assertIn("local_request_host_allowed(request)", handler)
        self.assertIn('"403 Forbidden"', handler)
        self.assertIn("jk_bms_ble_scan_snapshot(&snapshot)", handler)

    def test_response_exposes_only_safe_candidate_fields(self):
        handler = block(
            "static esp_err_t bms_scan_get_handler",
            "static esp_err_t bms_select_start_handler",
        )
        self.assertIn("candidate_id", handler)
        self.assertIn("name", handler)
        self.assertIn("rssi_dbm", handler)
        self.assertIn("address_hint", handler)
        self.assertNotIn("ble_addr_t", handler)
        self.assertNotIn("address.val", handler)
        self.assertNotIn("bssid", handler.lower())

    def test_names_and_hints_are_json_escaped(self):
        handler = block(
            "static esp_err_t bms_scan_get_handler",
            "static esp_err_t bms_select_start_handler",
        )
        self.assertGreaterEqual(handler.count("wattpost_json_escape"), 2)

    def test_scan_does_not_implicitly_select_or_persist_bms(self):
        start_handler = block(
            "static esp_err_t bms_scan_start_handler",
            "static esp_err_t bms_scan_get_handler",
        )
        get_handler = block(
            "static esp_err_t bms_scan_get_handler",
            "static esp_err_t bms_select_start_handler",
        )
        combined = start_handler + get_handler
        self.assertNotIn("wattpost_device_config_save", combined)
        self.assertNotIn("configure_target", combined)
        self.assertNotIn("jk_bms_ble_select_start", combined)


if __name__ == "__main__":
    unittest.main()
