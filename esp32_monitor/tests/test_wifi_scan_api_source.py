import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")


class WifiScanApiSourceTests(unittest.TestCase):
    def test_scan_endpoints_are_registered(self):
        self.assertGreaterEqual(MAIN.count('"/api/device/wifi/scan"'), 2)
        self.assertIn(".handler = wifi_scan_start_handler", MAIN)
        self.assertIn(".handler = wifi_scan_get_handler", MAIN)

    def test_scan_start_is_protected_by_local_mutation_gate(self):
        start = MAIN.index("static esp_err_t wifi_scan_start_handler")
        end = MAIN.index("static esp_err_t wifi_scan_get_handler", start)
        handler = MAIN[start:end]
        self.assertIn("local_mutation_request_allowed(request)", handler)
        self.assertIn("esp_wifi_scan_start(&scan_config, false)", handler)
        self.assertIn('"202 Accepted"', handler)
        self.assertIn('"busy"', handler)

    def test_scan_completion_is_event_driven(self):
        self.assertIn("WIFI_EVENT_SCAN_DONE", MAIN)
        self.assertIn("wifi_scan_handle_done", MAIN)
        self.assertIn("esp_wifi_scan_get_ap_records", MAIN)

    def test_scan_results_are_bounded_and_hide_bssid(self):
        self.assertIn("#define WATTPOST_WIFI_SCAN_MAX_CANDIDATES 16u", MAIN)
        start = MAIN.index("static esp_err_t wifi_scan_get_handler")
        end = MAIN.index("static esp_err_t wifi_configure_start_handler", start)
        handler = MAIN[start:end]
        self.assertIn("candidate_id", handler)
        self.assertIn("rssi_dbm", handler)
        self.assertIn("channel", handler)
        self.assertIn("auth", handler)
        self.assertNotIn("bssid", handler)

    def test_hidden_networks_are_not_exposed_as_empty_candidates(self):
        done_start = MAIN.index("static void wifi_scan_handle_done")
        done_end = MAIN.index("static esp_err_t wifi_scan_start_handler", done_start)
        done = MAIN[done_start:done_end]
        self.assertIn("if (ssid_len == 0u)", done)

    def test_scan_requires_started_wifi_driver(self):
        start = MAIN.index("static esp_err_t wifi_scan_start_handler")
        end = MAIN.index("static esp_err_t wifi_scan_get_handler", start)
        self.assertIn("if (!wifi_driver_started)", MAIN[start:end])


if __name__ == "__main__":
    unittest.main()
