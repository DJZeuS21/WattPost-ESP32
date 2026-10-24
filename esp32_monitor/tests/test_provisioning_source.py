import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
ACCESS = (ROOT / "main" / "setup_access.c").read_text(encoding="utf-8")
POLICY = (ROOT / "main" / "provisioning_policy.c").read_text(encoding="utf-8")


class ProvisioningSourceTests(unittest.TestCase):
    def test_first_setup_ap_is_wpa2_and_apsta(self):
        self.assertIn("WIFI_AUTH_WPA2_PSK", MAIN)
        self.assertIn("WIFI_MODE_APSTA", MAIN)
        self.assertIn("esp_netif_create_default_wifi_ap()", MAIN)

    def test_first_setup_uses_shared_user_facing_access_code(self):
        self.assertIn('return "12345678";', ACCESS)
        self.assertIn("wattpost_setup_ap_code()", MAIN)
        self.assertIn("start_first_setup_ap()", MAIN)
        self.assertNotIn("wp_factory", MAIN)
        self.assertNotIn("setup_pwd", MAIN)

    def test_blank_device_enters_first_setup_without_manufacturing_data(self):
        self.assertNotIn("factory_data_required", POLICY)
        self.assertNotIn("WATTPOST_PROVISION_BOOT_FACTORY_DATA_REQUIRED", MAIN)
        self.assertNotIn("wattpost_factory_setup_password_load", MAIN)

    def test_first_setup_server_has_direct_ip_path(self):
        first_setup = self._first_setup_function()
        self.assertIn("start_server();", first_setup)
        self.assertIn("esp_netif_get_ip_info", first_setup)
        self.assertIn("direct URL http://", first_setup)

    def test_first_setup_timeout_starts_only_after_setup_is_complete(self):
        self.assertIn("maintain_first_setup_ap();", MAIN)
        maintain_start = MAIN.index("static void maintain_first_setup_ap(void) {")
        maintain_end = MAIN.index("static void recovery_restore_sta_after_ap_start_failure", maintain_start)
        maintain = MAIN[maintain_start:maintain_end]
        self.assertIn('strcmp(device_setup_state(), "configured") != 0', maintain)
        self.assertIn("first_setup_completed_us = 0", maintain)
        self.assertIn("first_setup_completed_us = esp_timer_get_time()", maintain)
        self.assertIn("wattpost_setup_ap_timeout_due", maintain)
        self.assertIn("monotonic_age_seconds(first_setup_completed_us)", maintain)
        self.assertIn(
            "provision_boot_action = WATTPOST_PROVISION_BOOT_NORMAL",
            maintain,
        )
        self.assertNotIn("esp_wifi_stop()", maintain)
        self.assertIn("!wifi_has_ip", maintain)
        self.assertIn("wifi_rollback_pending_snapshot()", maintain)
        self.assertNotIn("first_setup_ap_started_us", MAIN)

    @staticmethod
    def _first_setup_function():
        start = MAIN.index("static bool start_first_setup_ap")
        end = MAIN.index("static void maintain_first_setup_ap", start)
        return MAIN[start:end]


if __name__ == "__main__":
    unittest.main()
