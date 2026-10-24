import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class NoSharedServiceTokenTest(unittest.TestCase):
    def test_cmake_does_not_embed_shared_token_or_require_secret_file(self):
        cmake = (ROOT / "CMakeLists.txt").read_text()
        for forbidden in (
            "WATTPOST_OTA_TOKEN",
            "wattpost_secrets.h",
            "secrets.local",
            "SECRET_FILE",
        ):
            self.assertNotIn(forbidden, cmake)

    def test_old_raw_ota_and_coredump_routes_are_removed(self):
        source = (ROOT / "main/main.c").read_text()
        for forbidden in (
            "WATTPOST_OTA_TOKEN",
            "wattpost_secrets.h",
            "ota_authorized(",
            '"/api/ota"',
            '"/api/diagnostics/coredump"',
            "coredump_download_handler",
            "static esp_err_t ota_handler",
        ):
            self.assertNotIn(forbidden, source)

        # The remaining HTTP wildcard must give unknown /api/* URLs a 404.
        web_handler = source.split("static esp_err_t web_asset_handler(", 1)[1].split(
            "static esp_err_t json_response_too_large(", 1
        )[0]
        self.assertIn('"/api/"', web_handler)
        self.assertIn("HTTPD_404_NOT_FOUND", web_handler)

    def test_signed_cloud_ota_and_read_only_diagnostics_still_exist(self):
        main = (ROOT / "main/main.c").read_text()
        remote = (ROOT / "main/remote_ota.c").read_text()
        cloud = (ROOT / "main/cloud_transport.c").read_text()
        self.assertIn('"/api/device/ota/install"', main)
        self.assertIn('"/api/device/ota/preferences"', main)
        self.assertIn('"/api/diagnostics"', main)
        self.assertIn("esp_core_dump_image_check()", main)
        self.assertIn("wattpost_remote_ota_verify_manifest_signature", remote)
        self.assertIn("wattpost_remote_ota_verify_manifest_signature", cloud)
        self.assertIn("esp_ota_begin(", cloud)


if __name__ == "__main__":
    unittest.main()
