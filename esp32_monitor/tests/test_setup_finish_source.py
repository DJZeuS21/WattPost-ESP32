import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / 'main' / 'main.c').read_text(encoding='utf-8')


def block(begin, end):
    return MAIN.split(begin, 1)[1].split(end, 1)[0]


class WifiOnlyFirstSetupTests(unittest.TestCase):
    def test_completion_is_explicit_and_request_token_protected(self):
        handler = block('static esp_err_t setup_finish_without_bms_handler', 'static esp_err_t bms_scan_start_handler')
        self.assertIn('local_mutation_request_allowed(request)', handler)
        self.assertIn('request->content_len != 2', handler)
        self.assertIn('first_setup_ap_active', handler)
        self.assertIn('!device_wifi_configured', handler)
        self.assertIn('!wifi_has_ip', handler)
        self.assertIn('!wifi_station_ip_ready()', handler)
        self.assertIn('wifi_validation_active_snapshot()', handler)
        self.assertIn('wifi_rollback_pending_snapshot()', handler)
        self.assertIn('first_setup_wifi_retry_required', handler)
        self.assertIn('first_setup_bms_deferred = true;', handler)
        for unsafe in ('wattpost_device_config_save', 'clear_bms', 'nvs_', 'esp_restart', 'jk_bms_ble_select'):
            self.assertNotIn(unsafe, handler)

    def test_success_only_changes_ap_completion_and_root_routing(self):
        maintain = block('static void maintain_first_setup_ap(void)', 'static void recovery_restore_sta_after_ap_start_failure')
        routing = block('static esp_err_t web_asset_handler', 'static esp_err_t json_response_too_large')
        self.assertIn('!first_setup_bms_deferred', maintain)
        self.assertIn('!wifi_has_ip', maintain)
        self.assertIn('wifi_station_ip_ready()', maintain)
        self.assertIn('wattpost_setup_ap_timeout_due(', maintain)
        self.assertIn('!first_setup_bms_deferred', routing)
        self.assertIn('recovery_ap_active ||', routing)
        self.assertIn('first_setup_bms_deferred ? "true" : "false"', MAIN)
        self.assertIn('first_setup_bms_deferred = false;', MAIN)

    def test_handler_registered_in_local_api(self):
        self.assertIn('"/api/device/setup/finish"', MAIN)
        self.assertIn('httpd_register_uri_handler(server, &setup_finish_post)', MAIN)


if __name__ == '__main__':
    unittest.main()
