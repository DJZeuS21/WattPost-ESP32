import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
KCONFIG = (ROOT / "main" / "Kconfig.projbuild").read_text(encoding="utf-8")


class UniversalWifiSourceTests(unittest.TestCase):
    def test_compile_time_wifi_credentials_removed_from_kconfig(self):
        self.assertNotIn("WATTPOST_WIFI_SSID", KCONFIG)
        self.assertNotIn("WATTPOST_WIFI_PASSWORD", KCONFIG)

    def test_runtime_does_not_reference_compile_time_wifi_credentials(self):
        self.assertNotIn("CONFIG_WATTPOST_WIFI_SSID", MAIN)
        self.assertNotIn("CONFIG_WATTPOST_WIFI_PASSWORD", MAIN)

    def test_wifi_driver_uses_ram_storage(self):
        self.assertIn("esp_wifi_set_storage(WIFI_STORAGE_RAM)", MAIN)

    def test_missing_config_has_explicit_provisioning_path(self):
        self.assertIn("WATTPOST_WIFI_BOOT_PROVISIONING_REQUIRED", MAIN)
        self.assertIn("WATTPOST_PROVISION_BOOT_FIRST_SETUP", MAIN)
        self.assertIn("start_first_setup_ap", MAIN)

    def test_live_api_never_formats_wifi_password(self):
        log_calls = "\n".join(
            line for line in MAIN.splitlines() if "ESP_LOG" in line
        )
        self.assertNotRegex(log_calls, re.compile(r"password", re.IGNORECASE))
        self.assertNotIn('"wifi_password"', MAIN)


if __name__ == "__main__":
    unittest.main()
