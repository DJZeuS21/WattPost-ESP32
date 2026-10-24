#pragma once

#include <stdbool.h>
#include <stdint.h>

#define WATTPOST_DEVICE_CONFIG_SCHEMA_VERSION 1u
#define WATTPOST_WIFI_SSID_MAX_LEN 32u
#define WATTPOST_WIFI_PASSWORD_MAX_LEN 64u
#define WATTPOST_BMS_ADDRESS_LEN 6u

typedef enum {
    WATTPOST_CONFIG_LOAD_OK = 0,
    WATTPOST_CONFIG_LOAD_EMPTY,
    WATTPOST_CONFIG_LOAD_RECOVERED,
    WATTPOST_CONFIG_LOAD_CORRUPT,
    WATTPOST_CONFIG_LOAD_UNSUPPORTED,
    WATTPOST_CONFIG_LOAD_STORAGE_ERROR,
} wattpost_config_load_result_t;

typedef struct {
    bool wifi_configured;
    uint8_t wifi_ssid_len;
    uint8_t wifi_ssid[WATTPOST_WIFI_SSID_MAX_LEN];
    uint8_t wifi_password_len;
    uint8_t wifi_password[WATTPOST_WIFI_PASSWORD_MAX_LEN];

    bool bms_configured;
    uint8_t bms_address_type;
    uint8_t bms_address[WATTPOST_BMS_ADDRESS_LEN];
} wattpost_device_config_t;

void wattpost_device_config_defaults(wattpost_device_config_t *config);
bool wattpost_device_config_validate(const wattpost_device_config_t *config);

wattpost_config_load_result_t
wattpost_device_config_load(wattpost_device_config_t *config);
const char *wattpost_device_config_load_result_str(
    wattpost_config_load_result_t result);

bool wattpost_device_config_save(const wattpost_device_config_t *config);

void wattpost_device_config_clear_wifi(wattpost_device_config_t *config);
void wattpost_device_config_clear_bms(wattpost_device_config_t *config);

/* Persisted scoped reset helpers. */
bool wattpost_device_config_clear_wifi_persisted(void);
bool wattpost_device_config_clear_bms_persisted(void);

/*
 * Erases only the Stage 1 device-config namespace (wp_cfg).
 * It does not erase History, diagnostics, coredump, or legacy wattpost keys.
 */
bool wattpost_device_config_erase_store(void);
