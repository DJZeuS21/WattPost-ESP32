import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
SECURITY = (ROOT / "main" / "local_api_security.c").read_text(encoding="utf-8")


class LocalApiSecuritySourceTests(unittest.TestCase):
    def test_request_token_endpoint_is_registered(self):
        self.assertIn('"/api/device/request-token"', MAIN)
        self.assertIn(".handler = request_token_handler", MAIN)

    def test_request_token_uses_csprng_and_ram_only_storage(self):
        self.assertIn("esp_fill_random", MAIN)
        self.assertIn("static char local_request_token", MAIN)
        self.assertNotIn("nvs_set_str", MAIN)
        self.assertNotIn("nvs_set_blob(handle, \"request", MAIN)

    def test_request_token_endpoint_checks_allowed_host(self):
        start = MAIN.index("static esp_err_t request_token_handler")
        end = MAIN.index("static const embedded_asset_t", start)
        handler = MAIN[start:end]
        self.assertIn("local_request_host_allowed(request)", handler)
        self.assertIn('"403 Forbidden"', handler)
        self.assertIn('"forbidden_origin"', handler)
        self.assertIn('"Cache-Control", "no-store"', handler)

    def test_provisioning_transition_rotates_token(self):
        start = MAIN.index("static bool start_first_setup_ap")
        end = MAIN.index("static void maintain_first_setup_ap", start)
        self.assertIn("rotate_local_request_token();", MAIN[start:end])

    def test_legacy_temperature_mutation_uses_stage1_guard(self):
        start = MAIN.index("static esp_err_t temperature_config_post_handler")
        end = MAIN.index("static void start_server", start)
        handler = MAIN[start:end]
        self.assertIn("local_mutation_request_allowed(request)", handler)
        self.assertIn('"Cache-Control", "no-store"', handler)

    def test_production_code_does_not_enable_cors(self):
        combined = MAIN + SECURITY
        self.assertNotIn("Access-Control-Allow-Origin", combined)
        self.assertNotIn("HTTP_OPTIONS", MAIN)

    def test_token_is_never_logged(self):
        for match in re.finditer(r"ESP_LOG[IEWDVA]\([^;]+;", MAIN, re.DOTALL):
            self.assertNotIn("local_request_token", match.group(0))


if __name__ == "__main__":
    unittest.main()
