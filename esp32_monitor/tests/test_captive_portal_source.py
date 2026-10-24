import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
DNS = (ROOT / "main" / "captive_dns.c").read_text(encoding="utf-8")


def function_block(signature, next_signature):
    start = MAIN.index(signature)
    end = MAIN.index(next_signature, start)
    return MAIN[start:end]


class CaptivePortalSourceTests(unittest.TestCase):
    def test_first_setup_configures_dhcp_uri_and_starts_dns(self):
        block = function_block(
            "static bool start_first_setup_ap",
            "static void maintain_first_setup_ap",
        )
        self.assertIn("configure_captive_portal_dhcp(wifi_ap_netif)", block)
        self.assertIn("wattpost_captive_dns_start(wifi_ap_netif)", block)
        self.assertLess(
            block.index("configure_captive_portal_dhcp(wifi_ap_netif)"),
            block.index("esp_wifi_start()"),
        )

    def test_dhcp_captive_portal_uri_is_absolute_ap_ip(self):
        block = function_block(
            "static bool configure_captive_portal_dhcp",
            "static bool request_header_value",
        )
        self.assertIn("ESP_NETIF_CAPTIVEPORTAL_URI", block)
        self.assertIn('"http://%s/"', block)
        self.assertIn("netif_ipv4_string(ap_netif", block)
        self.assertNotIn("Host", block)

    def test_foreign_host_redirects_to_absolute_ap_ip_before_assets(self):
        block = function_block(
            "static esp_err_t web_asset_handler",
            "static esp_err_t json_response_too_large",
        )
        redirect = function_block(
            "static esp_err_t captive_portal_redirect",
            "static esp_err_t device_api_error",
        )
        self.assertIn(
            "provisioning_ap_active() && !local_request_host_allowed(request)",
            block,
        )
        self.assertLess(
            block.index("local_request_host_allowed(request)"),
            block.index("find_web_asset(asset_uri)"),
        )
        self.assertIn('"http://%s/"', redirect)
        self.assertIn('"Location"', redirect)
        self.assertNotIn("request_header_value", redirect)

    def test_unknown_non_api_probe_redirects_but_unknown_api_stays_404(self):
        block = function_block(
            "static esp_err_t web_asset_handler",
            "static esp_err_t json_response_too_large",
        )
        self.assertIn('strncmp(request->uri, "/api/", 5u) != 0', block)
        self.assertIn("captive_portal_redirect(request)", block)
        self.assertIn("HTTPD_404_NOT_FOUND", block)

    def test_timeout_preserves_validated_sta(self):
        block = function_block(
            "static void maintain_first_setup_ap",
            "static bool start_bms",
        )
        self.assertIn("device_wifi_configured && wifi_has_ip", block)
        self.assertIn("esp_wifi_set_mode(WIFI_MODE_STA)", block)
        self.assertIn("esp_wifi_stop()", block)
        self.assertIn("wattpost_captive_dns_stop()", block)
        self.assertLess(
            block.index("esp_wifi_set_mode(WIFI_MODE_STA)"),
            block.index("wattpost_captive_dns_stop()"),
        )

    def test_dns_runtime_is_bounded_udp53_and_stoppable(self):
        self.assertIn("#define CAPTIVE_DNS_PORT 53", DNS)
        self.assertIn("#define CAPTIVE_DNS_PACKET_MAX 512", DNS)
        self.assertIn("wattpost_captive_dns_build_response", DNS)
        self.assertIn("SO_RCVTIMEO", DNS)
        self.assertIn("shutdown(sock, SHUT_RDWR)", DNS)
        self.assertIn("portENTER_CRITICAL(&dns_lock)", DNS)

    def test_setup_password_is_not_logged_by_captive_code(self):
        self.assertNotIn("setup_password", DNS)
        self.assertNotIn("password", DNS.lower())


if __name__ == "__main__":
    unittest.main()
