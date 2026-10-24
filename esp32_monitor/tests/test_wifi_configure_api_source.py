import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")


def function_block(signature, next_signature):
    start = MAIN.index(signature)
    end = MAIN.index(next_signature, start)
    return MAIN[start:end]


class WifiConfigureApiSourceTests(unittest.TestCase):
    def test_configure_endpoint_is_registered_and_protected(self):
        self.assertIn('"/api/device/wifi/configure"', MAIN)
        self.assertIn(".handler = wifi_configure_start_handler", MAIN)
        handler = function_block(
            "static esp_err_t wifi_configure_start_handler",
            "static const embedded_asset_t",
        )
        self.assertIn("local_mutation_request_allowed(request)", handler)

    def test_configure_allows_first_setup_and_installed_revalidation(self):
        handler = function_block(
            "static esp_err_t wifi_configure_start_handler",
            "static const embedded_asset_t",
        )
        self.assertIn("const bool first_setup_configure", handler)
        self.assertIn(
            "provision_boot_action == WATTPOST_PROVISION_BOOT_FIRST_SETUP",
            handler,
        )
        self.assertIn("const bool installed_configure", handler)
        self.assertIn(
            "provision_boot_action == WATTPOST_PROVISION_BOOT_NORMAL",
            handler,
        )
        self.assertIn("WATTPOST_WIFI_BOOT_CONNECT_SAVED", handler)
        self.assertIn("if (!first_setup_configure && !installed_configure)", handler)
        self.assertIn('"invalid_state"', handler)

    def test_request_body_is_bounded_and_strict_json(self):
        handler = function_block(
            "static esp_err_t wifi_configure_start_handler",
            "static const embedded_asset_t",
        )
        parser = function_block(
            "static bool parse_wifi_configure_request",
            "static bool wifi_candidate_for_configure",
        )
        self.assertIn("WATTPOST_WIFI_CONFIGURE_BODY_MAX 512u", MAIN)
        self.assertIn('"413 Payload Too Large"', handler)
        self.assertIn("cJSON_ParseWithLengthOpts", parser)
        self.assertIn("unknown_field", parser)
        self.assertIn("password_count == 1u", parser)

    def test_candidate_and_hidden_modes_are_supported(self):
        parser = function_block(
            "static bool parse_wifi_configure_request",
            "static bool wifi_candidate_for_configure",
        )
        handler = function_block(
            "static esp_err_t wifi_configure_start_handler",
            "static const embedded_asset_t",
        )
        self.assertIn("scan_generation_count == 1u", parser)
        self.assertIn("candidate_id_count == 1u", parser)
        self.assertIn("hidden_ssid_count == 1u", parser)
        self.assertIn('"stale_scan"', handler)
        self.assertIn('"candidate_not_found"', handler)
        apply_pending = function_block(
            "static bool wifi_validation_apply_pending_config",
            "static bool wifi_validation_handle_disconnect",
        )
        self.assertIn("wifi_validation.candidate_bssid_set", handler)
        self.assertIn("sta_config.sta.bssid_set = true", apply_pending)
        self.assertIn("WIFI_ALL_CHANNEL_SCAN", MAIN)

    def test_password_is_scrubbed_from_http_and_json_buffers(self):
        parser = function_block(
            "static void scrub_json_passwords",
            "static bool wifi_candidate_for_configure",
        )
        handler = function_block(
            "static esp_err_t wifi_configure_start_handler",
            "static const embedded_asset_t",
        )
        self.assertIn("memset(item->valuestring, 0", parser)
        self.assertIn("memset(body, 0, sizeof(body))", handler)
        self.assertIn("memset(&parsed, 0, sizeof(parsed))", handler)

        for match in re.finditer(r"ESP_LOG[IEWDVA]\([^;]+;", MAIN, re.DOTALL):
            self.assertNotIn("parsed.password", match.group(0))
            self.assertNotIn("wifi_password", match.group(0))

    def test_persistent_save_only_happens_after_got_ip(self):
        configure = function_block(
            "static esp_err_t wifi_configure_start_handler",
            "static const embedded_asset_t",
        )
        got_ip = function_block(
            "static bool wifi_validation_handle_got_ip",
            "static void maintain_wifi_validation",
        )
        self.assertNotIn("wattpost_device_config_save", configure)
        self.assertIn("wattpost_device_config_save(&pending)", got_ip)
        self.assertIn("WIFI_OPERATION_PHASE_SAVING", got_ip)

    def test_failed_validation_keeps_persistent_config_untouched(self):
        fail = function_block(
            "static void wifi_validation_finish_error",
            "static bool wifi_validation_handle_disconnect",
        )
        self.assertNotIn("wattpost_device_config_save", fail)
        self.assertIn(
            "memset(\n            &wifi_validation.pending_config",
            fail,
        )

    def test_disconnect_reasons_map_to_stable_errors(self):
        mapper = function_block(
            "static const char *wifi_validation_error_for_disconnect_reason",
            "static bool wifi_validation_active_snapshot",
        )
        self.assertIn("WIFI_REASON_AUTH_FAIL", mapper)
        self.assertIn("WIFI_REASON_HANDSHAKE_TIMEOUT", mapper)
        self.assertIn('"wifi_auth_failed"', mapper)
        self.assertIn("WIFI_REASON_NO_AP_FOUND", mapper)
        self.assertIn('"wifi_not_found"', mapper)
        self.assertIn('"wifi_connect_failed"', mapper)

    def test_validation_has_timeout_and_ap_does_not_expire_mid_connect(self):
        self.assertIn("WATTPOST_WIFI_VALIDATION_TIMEOUT_SECONDS 30u", MAIN)
        maintain_validation = function_block(
            "static void maintain_wifi_validation",
            "static esp_err_t request_token_handler",
        )
        self.assertIn("wifi_validation_finish_error", maintain_validation)
        ap_maintain = function_block(
            "static void maintain_first_setup_ap",
            "static bool start_bms",
        )
        self.assertIn("wifi_validation_active_snapshot()", ap_maintain)

    def test_success_promotes_runtime_to_saved_config(self):
        got_ip = function_block(
            "static bool wifi_validation_handle_got_ip",
            "static void maintain_wifi_validation",
        )
        self.assertIn("device_wifi_configured = true", got_ip)
        self.assertIn(
            "wifi_boot_action = WATTPOST_WIFI_BOOT_CONNECT_SAVED",
            got_ip,
        )
        self.assertIn("WIFI_OPERATION_SUCCESS", got_ip)


if __name__ == "__main__":
    unittest.main()
