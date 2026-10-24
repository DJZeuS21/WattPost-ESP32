#include <assert.h>
#include <string.h>

#include "provisioning_policy.h"

static void test_normal_device_does_not_open_first_setup(void) {
    assert(wattpost_provision_boot_action(
               WATTPOST_CONFIG_LOAD_OK, true) ==
           WATTPOST_PROVISION_BOOT_NORMAL);
}

static void test_missing_wifi_opens_first_setup(void) {
    assert(wattpost_provision_boot_action(
               WATTPOST_CONFIG_LOAD_EMPTY, false) ==
           WATTPOST_PROVISION_BOOT_FIRST_SETUP);
    assert(wattpost_provision_boot_action(
               WATTPOST_CONFIG_LOAD_OK, false) ==
           WATTPOST_PROVISION_BOOT_FIRST_SETUP);
}

static void test_corrupt_user_config_does_not_get_overwritten(void) {
    assert(wattpost_provision_boot_action(
               WATTPOST_CONFIG_LOAD_CORRUPT, false) ==
           WATTPOST_PROVISION_BOOT_CONFIG_ERROR);
    assert(wattpost_provision_boot_action(
               WATTPOST_CONFIG_LOAD_UNSUPPORTED, false) ==
           WATTPOST_PROVISION_BOOT_CONFIG_ERROR);
    assert(wattpost_provision_boot_action(
               WATTPOST_CONFIG_LOAD_STORAGE_ERROR, false) ==
           WATTPOST_PROVISION_BOOT_CONFIG_ERROR);
}

static void test_ssid_uses_only_short_mac_suffix(void) {
    const uint8_t mac[6] = {0x24, 0x6F, 0x28, 0x11, 0xA7, 0xC2};
    char ssid[WATTPOST_SETUP_SSID_MAX_LEN + 1];
    assert(wattpost_setup_ssid_from_mac(mac, ssid, sizeof(ssid)));
    assert(strcmp(ssid, "WattPost-A7C2") == 0);
    assert(strstr(ssid, "246F") == NULL);
}

static void test_setup_ap_timeout(void) {
    assert(!wattpost_setup_ap_timeout_due(
        WATTPOST_SETUP_AP_TIMEOUT_SECONDS - 1));
    assert(wattpost_setup_ap_timeout_due(
        WATTPOST_SETUP_AP_TIMEOUT_SECONDS));
}

static void test_action_strings(void) {
    assert(strcmp(wattpost_provision_boot_action_str(
                      WATTPOST_PROVISION_BOOT_NORMAL), "normal") == 0);
    assert(strcmp(wattpost_provision_boot_action_str(
                      WATTPOST_PROVISION_BOOT_FIRST_SETUP), "first_setup") == 0);
    assert(strcmp(wattpost_provision_boot_action_str(
                      WATTPOST_PROVISION_BOOT_CONFIG_ERROR),
                  "config_error") == 0);
}

int main(void) {
    test_normal_device_does_not_open_first_setup();
    test_missing_wifi_opens_first_setup();
    test_corrupt_user_config_does_not_get_overwritten();
    test_ssid_uses_only_short_mac_suffix();
    test_setup_ap_timeout();
    test_action_strings();
    return 0;
}
