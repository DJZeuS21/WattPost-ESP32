#pragma once

#include <stdbool.h>

#include "device_config.h"

typedef enum {
    WATTPOST_BMS_BOOT_CONNECT_SELECTED = 0,
    WATTPOST_BMS_BOOT_SELECTION_REQUIRED,
    WATTPOST_BMS_BOOT_CONFIG_ERROR,
} wattpost_bms_boot_action_t;

static inline wattpost_bms_boot_action_t wattpost_bms_boot_action(
    wattpost_config_load_result_t config_result,
    bool bms_configured) {
    if (config_result == WATTPOST_CONFIG_LOAD_EMPTY) {
        return WATTPOST_BMS_BOOT_SELECTION_REQUIRED;
    }

    if (config_result == WATTPOST_CONFIG_LOAD_OK ||
        config_result == WATTPOST_CONFIG_LOAD_RECOVERED) {
        return bms_configured
            ? WATTPOST_BMS_BOOT_CONNECT_SELECTED
            : WATTPOST_BMS_BOOT_SELECTION_REQUIRED;
    }

    return WATTPOST_BMS_BOOT_CONFIG_ERROR;
}

static inline bool wattpost_bms_recovery_enabled(
    wattpost_bms_boot_action_t action) {
    return action == WATTPOST_BMS_BOOT_CONNECT_SELECTED;
}

static inline const char *wattpost_bms_boot_action_str(
    wattpost_bms_boot_action_t action) {
    switch (action) {
        case WATTPOST_BMS_BOOT_CONNECT_SELECTED: return "connect_selected";
        case WATTPOST_BMS_BOOT_SELECTION_REQUIRED: return "selection_required";
        case WATTPOST_BMS_BOOT_CONFIG_ERROR: return "config_error";
        default: return "unknown";
    }
}
