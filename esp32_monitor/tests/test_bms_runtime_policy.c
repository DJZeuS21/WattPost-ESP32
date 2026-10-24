#include <assert.h>
#include <string.h>

#include "bms_runtime_policy.h"

static void test_selected_target_connects(void) {
    assert(wattpost_bms_boot_action(WATTPOST_CONFIG_LOAD_OK, true) ==
           WATTPOST_BMS_BOOT_CONNECT_SELECTED);
    assert(wattpost_bms_boot_action(WATTPOST_CONFIG_LOAD_RECOVERED, true) ==
           WATTPOST_BMS_BOOT_CONNECT_SELECTED);
}

static void test_missing_target_requires_selection(void) {
    assert(wattpost_bms_boot_action(WATTPOST_CONFIG_LOAD_EMPTY, false) ==
           WATTPOST_BMS_BOOT_SELECTION_REQUIRED);
    assert(wattpost_bms_boot_action(WATTPOST_CONFIG_LOAD_OK, false) ==
           WATTPOST_BMS_BOOT_SELECTION_REQUIRED);
    assert(wattpost_bms_boot_action(WATTPOST_CONFIG_LOAD_RECOVERED, false) ==
           WATTPOST_BMS_BOOT_SELECTION_REQUIRED);
}

static void test_config_errors_do_not_select_random_target(void) {
    assert(wattpost_bms_boot_action(WATTPOST_CONFIG_LOAD_CORRUPT, false) ==
           WATTPOST_BMS_BOOT_CONFIG_ERROR);
    assert(wattpost_bms_boot_action(WATTPOST_CONFIG_LOAD_UNSUPPORTED, false) ==
           WATTPOST_BMS_BOOT_CONFIG_ERROR);
    assert(wattpost_bms_boot_action(WATTPOST_CONFIG_LOAD_STORAGE_ERROR, false) ==
           WATTPOST_BMS_BOOT_CONFIG_ERROR);
}

static void test_recovery_requires_selected_target(void) {
    assert(wattpost_bms_recovery_enabled(
        WATTPOST_BMS_BOOT_CONNECT_SELECTED));
    assert(!wattpost_bms_recovery_enabled(
        WATTPOST_BMS_BOOT_SELECTION_REQUIRED));
    assert(!wattpost_bms_recovery_enabled(
        WATTPOST_BMS_BOOT_CONFIG_ERROR));
}

static void test_action_strings(void) {
    assert(strcmp(wattpost_bms_boot_action_str(
                      WATTPOST_BMS_BOOT_CONNECT_SELECTED),
                  "connect_selected") == 0);
    assert(strcmp(wattpost_bms_boot_action_str(
                      WATTPOST_BMS_BOOT_SELECTION_REQUIRED),
                  "selection_required") == 0);
    assert(strcmp(wattpost_bms_boot_action_str(
                      WATTPOST_BMS_BOOT_CONFIG_ERROR),
                  "config_error") == 0);
}

int main(void) {
    test_selected_target_connects();
    test_missing_target_requires_selection();
    test_config_errors_do_not_select_random_target();
    test_recovery_requires_selected_target();
    test_action_strings();
    return 0;
}
