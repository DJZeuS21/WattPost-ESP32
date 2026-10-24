#pragma once

#include <stdbool.h>

#include "device_config.h"

typedef enum {
    WATTPOST_WIFI_BOOT_CONNECT_SAVED = 0,
    WATTPOST_WIFI_BOOT_PROVISIONING_REQUIRED,
    WATTPOST_WIFI_BOOT_CONFIG_ERROR,
} wattpost_wifi_boot_action_t;

static inline wattpost_wifi_boot_action_t wattpost_wifi_boot_action(
    wattpost_config_load_result_t config_result,
    bool wifi_configured) {
    if (config_result == WATTPOST_CONFIG_LOAD_EMPTY) {
        return WATTPOST_WIFI_BOOT_PROVISIONING_REQUIRED;
    }

    if (config_result == WATTPOST_CONFIG_LOAD_OK ||
        config_result == WATTPOST_CONFIG_LOAD_RECOVERED) {
        return wifi_configured
            ? WATTPOST_WIFI_BOOT_CONNECT_SAVED
            : WATTPOST_WIFI_BOOT_PROVISIONING_REQUIRED;
    }

    return WATTPOST_WIFI_BOOT_CONFIG_ERROR;
}

static inline bool wattpost_wifi_recovery_enabled(
    wattpost_wifi_boot_action_t action) {
    return action == WATTPOST_WIFI_BOOT_CONNECT_SAVED;
}

static inline const char *wattpost_wifi_boot_action_str(
    wattpost_wifi_boot_action_t action) {
    switch (action) {
        case WATTPOST_WIFI_BOOT_CONNECT_SAVED: return "connect_saved";
        case WATTPOST_WIFI_BOOT_PROVISIONING_REQUIRED:
            return "provisioning_required";
        case WATTPOST_WIFI_BOOT_CONFIG_ERROR: return "config_error";
        default: return "unknown";
    }
}
