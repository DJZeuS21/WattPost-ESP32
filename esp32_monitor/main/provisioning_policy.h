#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "device_config.h"

#define WATTPOST_SETUP_AP_TIMEOUT_SECONDS 8u
#define WATTPOST_SETUP_SSID_MAX_LEN 14u

typedef enum {
    WATTPOST_PROVISION_BOOT_NORMAL = 0,
    WATTPOST_PROVISION_BOOT_FIRST_SETUP,
    WATTPOST_PROVISION_BOOT_CONFIG_ERROR,
} wattpost_provision_boot_action_t;

wattpost_provision_boot_action_t wattpost_provision_boot_action(
    wattpost_config_load_result_t config_result,
    bool wifi_configured);

const char *wattpost_provision_boot_action_str(
    wattpost_provision_boot_action_t action);

bool wattpost_setup_ssid_from_mac(
    const uint8_t mac[6],
    char *ssid,
    size_t ssid_size);

static inline bool wattpost_setup_ap_timeout_due(uint32_t active_seconds) {
    return active_seconds >= WATTPOST_SETUP_AP_TIMEOUT_SECONDS;
}
