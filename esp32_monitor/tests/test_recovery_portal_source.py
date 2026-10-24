import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
POLICY = (ROOT / "main" / "recovery_policy.h").read_text(encoding="utf-8")


def block(start_marker, end_marker):
    start = MAIN.index(start_marker)
    end = MAIN.index(end_marker, start)
    return MAIN[start:end]


class RecoveryPortalSourceTests(unittest.TestCase):
    def test_runtime_mode_distinguishes_recovery_from_first_setup(self):
        runtime = block(
            "static const char *device_runtime_mode",
            "static const char *device_bms_runtime_state",
        )
        self.assertIn("if (recovery_ap_active)", runtime)
        self.assertIn('return "recovery"', runtime)
        self.assertIn('? "first_setup"', runtime)
        self.assertIn('strcmp(device_setup_state(), "configured") != 0', runtime)

    def test_recovery_is_manual_and_has_no_idle_timeout(self):
        self.assertIn(
            "WATTPOST_RECOVERY_SUCCESS_GRACE_SECONDS = 8",
            POLICY,
        )
        self.assertNotIn("RECOVERY_AP_TIMEOUT", POLICY)
        self.assertNotIn("RECOVERY_AP_TRIGGER", POLICY)
        self.assertNotIn("WIFI_RESTART_SECONDS", POLICY)

        task = block("static void recovery_task", "static bool init_wifi_stack")
        self.assertIn("consume_physical_recovery()", task)
        self.assertIn("start_recovery_ap()", task)
        self.assertNotIn("wattpost_recovery_ap_due", task)
        self.assertNotIn("wattpost_wifi_restart_due", task)
        self.assertNotIn("RESTART_REASON_LEGACY_WIFI_TIMEOUT", task)

    def test_recovery_ap_configuration_and_lazy_ap_netif(self):
        start = block(
            "static bool start_recovery_ap(void) {",
            "static bool stop_recovery_ap",
        )
        self.assertIn("wifi_ap_netif == NULL", start)
        self.assertIn("esp_netif_create_default_wifi_ap()", start)
        self.assertIn("wattpost_setup_ap_code()", start)
        self.assertIn("WIFI_AUTH_WPA2_PSK", start)
        self.assertIn("wattpost_setup_ssid_from_mac", start)
        self.assertIn("WIFI_MODE_APSTA", start)
        self.assertIn("configure_captive_portal_dhcp(wifi_ap_netif)", start)
        self.assertIn("wattpost_captive_dns_start(wifi_ap_netif)", start)
        self.assertIn("rotate_local_request_token()", start)
        self.assertNotIn("wattpost_device_config_clear_wifi_persisted", start)
        self.assertNotIn("wattpost_device_config_erase_store", start)
        self.assertNotIn("nvs_flash_erase", start)

    def test_recovery_closes_only_after_user_wifi_success(self):
        maintain = block(
            "static void maintain_recovery_ap(void) {",
            "static bool start_bms",
        )
        stop = block(
            "static bool stop_recovery_ap",
            "static void maintain_recovery_ap",
        )
        self.assertIn("recovery_completion_pending", maintain)
        self.assertIn("WATTPOST_RECOVERY_SUCCESS_GRACE_SECONDS", maintain)
        self.assertIn("stop_recovery_ap(\"wifi_restored\")", maintain)
        self.assertNotIn("wattpost_recovery_ap_timeout_due", maintain)
        self.assertIn("WIFI_MODE_STA", stop)
        self.assertIn("wattpost_captive_dns_stop()", stop)
        self.assertNotIn("erase", maintain.lower())
        self.assertNotIn("clear_wifi", maintain)

        configure = block(
            "static esp_err_t wifi_configure_start_handler",
            "static const embedded_asset_t",
        )
        reconnect = block(
            "static esp_err_t wifi_reconnect_handler",
            "static esp_err_t wifi_reset_handler",
        )
        got_ip = block(
            "static bool wifi_validation_handle_got_ip",
            "static void maintain_wifi_validation",
        )
        reconnect_finish = block(
            "static void wifi_reconnect_finish",
            "static void maintain_wifi_reconnect_operation",
        )
        self.assertIn(
            "wifi_validation.recovery_flow = recovery_ap_active",
            configure,
        )
        self.assertIn(
            "wifi_reconnect_operation.recovery_flow = recovery_ap_active",
            reconnect,
        )
        self.assertIn("if (recovery_flow)", got_ip)
        self.assertIn(
            "state == WIFI_OPERATION_SUCCESS && recovery_flow",
            reconnect_finish,
        )

    def test_normal_boot_does_not_preallocate_ap_netif(self):
        startup = block("static void start_wifi", "static bool start_first_setup_ap")
        self.assertIn("init_wifi_stack(false)", startup)
        self.assertIn("esp_wifi_set_mode(WIFI_MODE_STA)", startup)
        self.assertNotIn("WIFI_MODE_APSTA", startup)

    def test_recovery_root_uses_lightweight_portal_and_captive_redirect(self):
        handler = block(
            "static esp_err_t web_asset_handler",
            "static esp_err_t json_response_too_large",
        )
        self.assertIn("provisioning_ap_active()", handler)
        self.assertIn("recovery_ap_active ||", handler)
        self.assertIn('"/setup.html"', handler)
        self.assertIn("captive_portal_redirect(request)", handler)

    def test_inactive_ap_ip_is_not_added_to_normal_host_allowlists(self):
        host = block(
            "static bool local_request_host_allowed",
            "static esp_err_t captive_portal_redirect",
        )
        mutation = block(
            "static bool local_mutation_request_allowed",
            "static const char *wifi_operation_state_str",
        )
        for source in (host, mutation):
            self.assertIn("if (provisioning_ap_active())", source)
            self.assertIn("netif_ipv4_string(wifi_ap_netif", source)


if __name__ == "__main__":
    unittest.main()
