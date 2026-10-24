import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
PACKAGER = (ROOT / "tools" / "package_web.py").read_text(encoding="utf-8")


def block(start_marker, end_marker):
    start = MAIN.index(start_marker)
    end = MAIN.index(end_marker, start)
    return MAIN[start:end]


class FirstSetupWebRoutingSourceTests(unittest.TestCase):
    def test_incomplete_first_setup_root_uses_lightweight_shell(self):
        handler = block(
            "static esp_err_t web_asset_handler",
            "static esp_err_t json_response_too_large",
        )
        self.assertIn("provisioning_ap_active()", handler)
        self.assertIn('strcmp(device_setup_state(), "configured") != 0', handler)
        self.assertIn("request->uri[0] == '/'", handler)
        self.assertIn('"/setup.html"', handler)
        self.assertIn("find_web_asset(asset_uri)", handler)

    def test_configured_first_setup_root_is_not_forced_to_setup_shell(self):
        handler = block(
            "static esp_err_t web_asset_handler",
            "static esp_err_t json_response_too_large",
        )
        condition = handler[
            handler.index("const bool setup_portal_root"):
            handler.index("const char *asset_uri")
        ]
        self.assertIn('"configured"', condition)
        self.assertIn("provisioning_ap_active()", condition)
        self.assertIn("recovery_ap_active ||", condition)

    def test_setup_html_is_no_store(self):
        handler = block(
            "static esp_err_t web_asset_handler",
            "static esp_err_t json_response_too_large",
        )
        self.assertIn('strcmp(asset->uri, "/setup.html") == 0', handler)
        self.assertIn('"no-store"', handler)

    def test_packager_has_only_canonical_setup_assets(self):
        for route, relative in (
            ('"/setup.html"', '"setup.html"'),
            ('"/css/setup.css"', '"css/setup.css"'),
            ('"/js/setup-api.js"', '"js/setup-api.js"'),
            ('"/js/setup.js"', '"js/setup.js"'),
        ):
            self.assertIn(route, PACKAGER)
            self.assertIn(relative, PACKAGER)

        self.assertNotIn("main/web", PACKAGER)

    def test_packager_stamps_all_html_but_strips_dev_only_from_index_only(self):
        self.assertIn('if relative == "index.html":', PACKAGER)
        self.assertIn('if relative.endswith(".html"):', PACKAGER)
        self.assertIn("VERSION_TOKEN", PACKAGER)


if __name__ == "__main__":
    unittest.main()
