#include "provisioning_policy.h"

#include <stdio.h>

wattpost_provision_boot_action_t wattpost_provision_boot_action(
    wattpost_config_load_result_t config_result,
    bool wifi_configured) {
    if (config_result == WATTPOST_CONFIG_LOAD_CORRUPT ||
        config_result == WATTPOST_CONFIG_LOAD_UNSUPPORTED ||
        config_result == WATTPOST_CONFIG_LOAD_STORAGE_ERROR) {
        return WATTPOST_PROVISION_BOOT_CONFIG_ERROR;
    }

    return wifi_configured
        ? WATTPOST_PROVISION_BOOT_NORMAL
        : WATTPOST_PROVISION_BOOT_FIRST_SETUP;
}

const char *wattpost_provision_boot_action_str(
    wattpost_provision_boot_action_t action) {
    switch (action) {
        case WATTPOST_PROVISION_BOOT_NORMAL: return "normal";
        case WATTPOST_PROVISION_BOOT_FIRST_SETUP: return "first_setup";
        case WATTPOST_PROVISION_BOOT_CONFIG_ERROR: return "config_error";
        default: return "unknown";
    }
}

bool wattpost_setup_ssid_from_mac(
    const uint8_t mac[6],
    char *ssid,
    size_t ssid_size) {
    if (!mac || !ssid || ssid_size < WATTPOST_SETUP_SSID_MAX_LEN + 1u) {
        return false;
    }
    const int written = snprintf(
        ssid, ssid_size, "WattPost-%02X%02X", mac[4], mac[5]);
    return written > 0 && (size_t) written < ssid_size;
}
