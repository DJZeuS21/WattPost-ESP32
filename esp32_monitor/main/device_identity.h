#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define WATTPOST_DEVICE_IDENTITY_SCHEMA_VERSION 1u
#define WATTPOST_DEVICE_ID_BYTES 16u
#define WATTPOST_DEVICE_SECRET_BYTES 32u
#define WATTPOST_OWNERSHIP_EPOCH_INITIAL 1u

typedef enum {
    WATTPOST_IDENTITY_OK = 0,
    WATTPOST_IDENTITY_CREATED,
    WATTPOST_IDENTITY_EMPTY,
    WATTPOST_IDENTITY_RECOVERED,
    WATTPOST_IDENTITY_CORRUPT,
    WATTPOST_IDENTITY_UNSUPPORTED,
    WATTPOST_IDENTITY_STORAGE_ERROR,
    WATTPOST_IDENTITY_RANDOM_ERROR,
} wattpost_identity_result_t;

typedef struct {
    uint8_t device_id[WATTPOST_DEVICE_ID_BYTES];
    uint8_t device_secret[WATTPOST_DEVICE_SECRET_BYTES];
    uint32_t ownership_epoch;
} wattpost_device_identity_t;

/*
 * Loads the persistent hardware identity without creating or changing it.
 * Secrets are returned only to firmware callers; no HTTP/API exposure is
 * implemented by this module.
 */
wattpost_identity_result_t
wattpost_device_identity_load(wattpost_device_identity_t *identity);

/*
 * Loads the identity, or creates it only when the dedicated identity store is
 * proven empty. Corrupt/unsupported records are never silently replaced.
 *
 * This must run during early app startup, before Wi-Fi/Bluetooth/ADC users are
 * started, because first-time creation temporarily enables the ESP-IDF early
 * boot entropy source.
 */
wattpost_identity_result_t
wattpost_device_identity_init(wattpost_device_identity_t *identity);

/*
 * Persists ownership_epoch + 1 while preserving device_id/device_secret.
 * Returns true only after both redundant slots confirm the new epoch; partial
 * writes are recovered by generation on the next boot. Returns false on
 * storage errors or epoch exhaustion.
 */
bool wattpost_device_identity_advance_ownership_epoch(
    wattpost_device_identity_t *updated_identity);

const char *wattpost_device_identity_result_str(wattpost_identity_result_t result);
