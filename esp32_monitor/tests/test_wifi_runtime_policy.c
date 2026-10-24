#include <assert.h>
#include <string.h>

#include "wifi_runtime_policy.h"

static void test_saved_config_connects(void) {
    assert(wattpost_wifi_boot_action(WATTPOST_CONFIG_LOAD_OK, true) ==
           WATTPOST_WIFI_BOOT_CONNECT_SAVED);
    assert(wattpost_wifi_boot_action(WATTPOST_CONFIG_LOAD_RECOVERED, true) ==
           WATTPOST_WIFI_BOOT_CONNECT_SAVED);
}

static void test_missing_wifi_requires_provisioning(void) {
    assert(wattpost_wifi_boot_action(WATTPOST_CONFIG_LOAD_EMPTY, false) ==
           WATTPOST_WIFI_BOOT_PROVISIONING_REQUIRED);
    assert(wattpost_wifi_boot_action(WATTPOST_CONFIG_LOAD_OK, false) ==
           WATTPOST_WIFI_BOOT_PROVISIONING_REQUIRED);
    assert(wattpost_wifi_boot_action(WATTPOST_CONFIG_LOAD_RECOVERED, false) ==
           WATTPOST_WIFI_BOOT_PROVISIONING_REQUIRED);
}

static void test_config_errors_do_not_enter_provisioning(void) {
    assert(wattpost_wifi_boot_action(WATTPOST_CONFIG_LOAD_CORRUPT, false) ==
           WATTPOST_WIFI_BOOT_CONFIG_ERROR);
    assert(wattpost_wifi_boot_action(WATTPOST_CONFIG_LOAD_UNSUPPORTED, false) ==
           WATTPOST_WIFI_BOOT_CONFIG_ERROR);
    assert(wattpost_wifi_boot_action(WATTPOST_CONFIG_LOAD_STORAGE_ERROR, false) ==
           WATTPOST_WIFI_BOOT_CONFIG_ERROR);
}

static void test_recovery_only_runs_for_configured_sta(void) {
    assert(wattpost_wifi_recovery_enabled(
        WATTPOST_WIFI_BOOT_CONNECT_SAVED));
    assert(!wattpost_wifi_recovery_enabled(
        WATTPOST_WIFI_BOOT_PROVISIONING_REQUIRED));
    assert(!wattpost_wifi_recovery_enabled(
        WATTPOST_WIFI_BOOT_CONFIG_ERROR));
}

static void test_action_strings(void) {
    assert(strcmp(wattpost_wifi_boot_action_str(
                      WATTPOST_WIFI_BOOT_CONNECT_SAVED),
                  "connect_saved") == 0);
    assert(strcmp(wattpost_wifi_boot_action_str(
                      WATTPOST_WIFI_BOOT_PROVISIONING_REQUIRED),
                  "provisioning_required") == 0);
    assert(strcmp(wattpost_wifi_boot_action_str(
                      WATTPOST_WIFI_BOOT_CONFIG_ERROR),
                  "config_error") == 0);
}

int main(void) {
    test_saved_config_connects();
    test_missing_wifi_requires_provisioning();
    test_config_errors_do_not_enter_provisioning();
    test_recovery_only_runs_for_configured_sta();
    test_action_strings();
    return 0;
}
