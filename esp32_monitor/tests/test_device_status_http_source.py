import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
SDK_DEFAULTS = (ROOT / "sdkconfig.defaults").read_text(encoding="utf-8")


def block(start_marker, end_marker):
    start = MAIN.index(start_marker)
    end = MAIN.index(end_marker, start)
    return MAIN[start:end]


class DeviceStatusHttpSourceTests(unittest.TestCase):
    def test_status_route_is_registered_as_local_read(self):
        self.assertIn('"/api/device/status"', MAIN)
        self.assertIn(".handler = device_status_handler", MAIN)
        handler = block(
            "static esp_err_t device_status_handler",
            "typedef struct {",
        )
        self.assertIn("local_request_host_allowed(request)", handler)
        self.assertIn('"403 Forbidden"', handler)
        self.assertIn('"Cache-Control", "no-store"', handler)

    def test_status_exposes_contract_shape(self):
        handler = block(
            "static esp_err_t device_status_handler",
            "typedef struct {",
        )
        for field in (
            '"api_version"',
            '"mode"',
            '"setup_state"',
            '"wifi"',
            '"bms"',
            '"cloud"',
            '"firmware"',
            '"system"',
            '"internet_state"',
            '"operation"',
        ):
            self.assertIn(field.replace('"', '\\"'), handler)

    def test_status_uses_runtime_operation_snapshots(self):
        handler = block(
            "static esp_err_t device_status_handler",
            "typedef struct {",
        )
        self.assertIn("wifi_operation_generation", handler)
        self.assertIn("wifi_operation_state_str", handler)
        self.assertIn("wifi_operation_phase_str", handler)
        self.assertIn("jk_bms_ble_operation_snapshot", handler)
        self.assertIn("bms_operation_state_str", handler)
        self.assertIn("bms_operation_phase_str", handler)

    def test_status_exposes_sta_ip_for_setup_success_fallback(self):
        handler = block(
            "static esp_err_t device_status_handler",
            "typedef struct {",
        )
        self.assertIn("netif_ipv4_string(wifi_netif", handler)
        self.assertIn('\\\"ip\\\":\\\"%s\\\"', handler)

    def test_status_strings_are_json_escaped(self):
        handler = block(
            "static esp_err_t device_status_handler",
            "typedef struct {",
        )
        self.assertGreaterEqual(handler.count("wattpost_json_escape"), 6)
        self.assertIn("wifi_ssid_display", handler)
        self.assertIn("dev_info.device_name", handler)
        self.assertIn("dev_info.model", handler)
        self.assertIn("bms_address_hint", handler)

    def test_status_does_not_return_secrets_or_full_bms_address(self):
        handler = block(
            "static esp_err_t device_status_handler",
            "typedef struct {",
        )
        lowered = handler.lower()
        self.assertNotIn("wifi_password", lowered)
        self.assertNotIn("wattpost_ota_token", lowered)
        self.assertNotIn("local_request_token", lowered)
        self.assertNotIn("bms_address[", lowered)
        self.assertNotIn("target_address", lowered)
        self.assertNotIn("device_secret", lowered)
        self.assertNotIn("device_id", lowered)
        self.assertNotIn("authorization", lowered)

    def test_cloud_status_is_scrubbed_and_local_actions_are_registered(self):
        handler = block(
            "static esp_err_t device_status_handler",
            "typedef struct {",
        )
        for field in (
            "transport_state",
            "network_available",
            "paired_known",
            "paired",
            "disconnect_pending",
            "pairing",
            "pair_url",
        ):
            self.assertIn(field, handler)
        self.assertIn('"/api/device/cloud/pair"', MAIN)
        self.assertIn('"/api/device/cloud/disconnect"', MAIN)
        self.assertIn('"/api/device/ota"', MAIN)
        self.assertIn('"/api/device/ota/install"', MAIN)
        self.assertIn("wattpost_cloud_transport_ota_install_start", MAIN)

    def test_runtime_mode_and_setup_state_are_separate(self):
        mode = block(
            "static const char *device_runtime_mode",
            "static const char *device_bms_runtime_state",
        )
        setup = block(
            "static const char *device_setup_state",
            "static const char *wifi_runtime_state",
        )
        self.assertIn('"first_setup"', mode)
        self.assertIn('"normal"', mode)
        self.assertIn('"wifi_required"', setup)
        self.assertIn('"bms_required"', setup)
        self.assertIn('"configured"', setup)
        self.assertIn('"config_error"', setup)

    def test_http_handler_capacity_tracks_registered_routes(self):
        registered = MAIN.count("httpd_register_uri_handler(server")
        self.assertEqual(registered, 27)
        self.assertIn("config.max_uri_handlers = 27;", MAIN)

    def test_local_http_keeps_socket_budget_beside_cloud_transport(self):
        server = block("static void start_server", "static bool start_mdns")
        self.assertIn("config.lru_purge_enable = true;", server)
        self.assertIn("CONFIG_LWIP_MAX_SOCKETS=16", SDK_DEFAULTS)


if __name__ == "__main__":
    unittest.main()
