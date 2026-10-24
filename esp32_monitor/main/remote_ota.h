#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define WATTPOST_REMOTE_OTA_VERSION_MAX_LEN 24u
#define WATTPOST_REMOTE_OTA_BUILD_ID_LEN 12u
#define WATTPOST_REMOTE_OTA_BUILD_ID_MAX_LEN 13u
#define WATTPOST_REMOTE_OTA_SHA256_HEX_LEN 64u
#define WATTPOST_REMOTE_OTA_SHA256_MAX_LEN 65u
#define WATTPOST_REMOTE_OTA_SIGNATURE_MAX_LEN 129u
#define WATTPOST_REMOTE_OTA_DOWNLOAD_PATH_MAX_LEN 128u

typedef struct {
    uint32_t release_id;
    char version[WATTPOST_REMOTE_OTA_VERSION_MAX_LEN];
    char build_id[WATTPOST_REMOTE_OTA_BUILD_ID_MAX_LEN];
    uint32_t size_bytes;
    char sha256[WATTPOST_REMOTE_OTA_SHA256_MAX_LEN];
    char signature[WATTPOST_REMOTE_OTA_SIGNATURE_MAX_LEN];
    char download_path[WATTPOST_REMOTE_OTA_DOWNLOAD_PATH_MAX_LEN];
} wattpost_remote_ota_target_t;

typedef struct {
    uint32_t release_id;
    char version[WATTPOST_REMOTE_OTA_VERSION_MAX_LEN];
    char build_id[WATTPOST_REMOTE_OTA_BUILD_ID_MAX_LEN];
} wattpost_remote_ota_marker_t;

bool wattpost_remote_ota_version_is_newer(
    const char *candidate,
    const char *current);

bool wattpost_remote_ota_target_validate(
    const wattpost_remote_ota_target_t *target,
    const char *current_version);

bool wattpost_remote_ota_verify_manifest_signature(
    const wattpost_remote_ota_target_t *target);

bool wattpost_remote_ota_parse_sha256(
    const char *hex,
    uint8_t output[32]);

bool wattpost_remote_ota_marker_load(wattpost_remote_ota_marker_t *marker);
bool wattpost_remote_ota_marker_save(const wattpost_remote_ota_target_t *target);
bool wattpost_remote_ota_marker_clear(void);

/* Device-owned preference. Missing/corrupt NVS state defaults to enabled. */
bool wattpost_remote_ota_automatic_updates_get(void);
bool wattpost_remote_ota_automatic_updates_set(bool enabled);
