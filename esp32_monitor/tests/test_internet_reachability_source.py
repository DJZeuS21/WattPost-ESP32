import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
CMAKE = (ROOT / "main" / "CMakeLists.txt").read_text(encoding="utf-8")


def block(start_marker, end_marker):
    start = MAIN.index(start_marker)
    end = MAIN.index(end_marker, start)
    return MAIN[start:end]


class InternetReachabilitySourceTests(unittest.TestCase):
    def test_probe_is_device_side_and_uses_minimal_connectivity_http(self):
        probe = block(
            "static wattpost_internet_state_t internet_reachability_probe",
            "static void internet_reachability_task",
        )
        self.assertIn(
            '#define WATTPOST_INTERNET_PROBE_HOST "connectivitycheck.gstatic.com"',
            MAIN,
        )
        self.assertIn('#define WATTPOST_INTERNET_PROBE_PATH "/generate_204"', MAIN)
        self.assertIn("WATTPOST_INTERNET_PROBE_TIMEOUT_MS 3000", MAIN)
        self.assertIn("getaddrinfo(", probe)
        self.assertIn("SO_RCVTIMEO", probe)
        self.assertIn("SO_SNDTIMEO", probe)
        self.assertIn('"HEAD " WATTPOST_INTERNET_PROBE_PATH', probe)
        self.assertIn("recv(", probe)
        self.assertIn('sscanf(response, "HTTP/%*u.%*u %d"', probe)
        self.assertNotIn("esp_http_client", probe)
        self.assertNotIn("wattpost.pp.ua", probe.lower())
        self.assertNotIn("WATTPOST_BUILD_ID", probe)
        self.assertNotIn("local_request_token", probe)
        self.assertNotIn("wifi_ssid_display", probe)
        # Cloud transport now legitimately uses esp_http_client, but the
        # independent Internet reachability probe must remain a minimal socket
        # check and must not become a dependency of Cloud transport.
        self.assertIn("esp_http_client", CMAKE)

    def test_probe_does_not_equate_wifi_ip_with_internet(self):
        handler = block(
            "static esp_err_t device_status_handler",
            "typedef struct {",
        )
        self.assertIn("internet_reachability_runtime_state()", handler)
        self.assertIn(
            '\\"internet_state\\":\\"%s\\"',
            handler,
        )
        self.assertNotIn(
            '\\"internet_state\\":\\"unknown\\"',
            handler,
        )

    def test_network_changes_invalidate_old_probe_result(self):
        event = block(
            "static void network_event",
            "static void history_task",
        )
        self.assertIn("internet_reachability_network_changed(false)", event)
        self.assertIn("internet_reachability_network_changed(true)", event)

        task = block(
            "static void internet_reachability_task",
            "static void network_event",
        )
        self.assertIn("generation == internet_reachability_generation", task)
        self.assertIn("internet_reachability_state = result", task)
        self.assertIn("WATTPOST_INTERNET_PROBE_INTERVAL_MS", task)

    def test_probe_task_is_best_effort_and_not_cloud_dependency(self):
        app = MAIN[MAIN.index("void app_main(void)"):]
        self.assertIn('"internet_probe"', app)
        self.assertIn("Internet reachability task unavailable", app)
        self.assertNotIn("ESP_ERROR_CHECK(xTaskCreate", app)


if __name__ == "__main__":
    unittest.main()
