#include "remote_ota.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include "mbedtls/base64.h"
#include "mbedtls/pk.h"
#include "mbedtls/sha256.h"
#include "nvs.h"

#define REMOTE_OTA_NAMESPACE "remote_ota"
#define REMOTE_OTA_KEY_RELEASE "release"
#define REMOTE_OTA_KEY_VERSION "version"
#define REMOTE_OTA_KEY_BUILD "build"
#define REMOTE_OTA_KEY_AUTOMATIC "auto_update"
#define REMOTE_OTA_MAX_IMAGE_BYTES 0x1D0000u
#define REMOTE_OTA_MANIFEST_MAX_LEN 256u

extern const unsigned char _binary_wattpost_firmware_public_key_pub_start[];
extern const unsigned char _binary_wattpost_firmware_public_key_pub_end[];

typedef struct {
    unsigned major;
    unsigned minor;
    unsigned patch;
} semantic_version_t;

static bool parse_version(const char *value, semantic_version_t *out) {
    if (value == NULL || out == NULL || value[0] != 'V') {
        return false;
    }
    unsigned major = 0u;
    unsigned minor = 0u;
    unsigned patch = 0u;
    char tail = '\0';
    if (sscanf(value, "V%u.%u.%u%c", &major, &minor, &patch, &tail) != 3 ||
        major > 999u || minor > 999u || patch > 999u) {
        return false;
    }
    out->major = major;
    out->minor = minor;
    out->patch = patch;
    return true;
}

bool wattpost_remote_ota_version_is_newer(
    const char *candidate,
    const char *current) {
    semantic_version_t lhs = {0};
    semantic_version_t rhs = {0};
    if (!parse_version(candidate, &lhs) || !parse_version(current, &rhs)) {
        return false;
    }
    if (lhs.major != rhs.major) return lhs.major > rhs.major;
    if (lhs.minor != rhs.minor) return lhs.minor > rhs.minor;
    return lhs.patch > rhs.patch;
}

static bool exact_hex(const char *value, size_t length) {
    if (value == NULL || strlen(value) != length) {
        return false;
    }
    for (size_t i = 0; i < length; ++i) {
        if (!isxdigit((unsigned char) value[i]) ||
            (value[i] >= 'A' && value[i] <= 'F')) {
            return false;
        }
    }
    return true;
}

static bool valid_build_id(const char *value) {
    return exact_hex(value, WATTPOST_REMOTE_OTA_BUILD_ID_LEN);
}

static bool valid_download_path(const char *value, uint32_t release_id) {
    if (value == NULL || value[0] != '/') {
        return false;
    }
    char expected[WATTPOST_REMOTE_OTA_DOWNLOAD_PATH_MAX_LEN] = {0};
    const int written = snprintf(
        expected,
        sizeof(expected),
        "/api/v1/device/ota/firmware/%lu",
        (unsigned long) release_id);
    return written > 0 && (size_t) written < sizeof(expected) &&
        strcmp(value, expected) == 0;
}

bool wattpost_remote_ota_target_validate(
    const wattpost_remote_ota_target_t *target,
    const char *current_version) {
    if (target == NULL || target->release_id == 0u ||
        !wattpost_remote_ota_version_is_newer(target->version, current_version) ||
        !valid_build_id(target->build_id) ||
        target->size_bytes == 0u || target->size_bytes > REMOTE_OTA_MAX_IMAGE_BYTES ||
        !exact_hex(target->sha256, WATTPOST_REMOTE_OTA_SHA256_HEX_LEN) ||
        target->signature[0] == '\0' ||
        strlen(target->signature) >= WATTPOST_REMOTE_OTA_SIGNATURE_MAX_LEN ||
        !valid_download_path(target->download_path, target->release_id)) {
        return false;
    }
    return true;
}

static bool canonical_manifest(
    const wattpost_remote_ota_target_t *target,
    char output[REMOTE_OTA_MANIFEST_MAX_LEN],
    size_t *length_out) {
    const int written = snprintf(
        output,
        REMOTE_OTA_MANIFEST_MAX_LEN,
        "WATTPOST-FIRMWARE-MANIFEST-V1\n"
        "version=%s\n"
        "build_id=%s\n"
        "size_bytes=%lu\n"
        "sha256=%s\n",
        target->version,
        target->build_id,
        (unsigned long) target->size_bytes,
        target->sha256);
    if (written <= 0 || written >= (int) REMOTE_OTA_MANIFEST_MAX_LEN) {
        return false;
    }
    *length_out = (size_t) written;
    return true;
}

static bool decode_signature(
    const char *encoded,
    uint8_t *output,
    size_t output_capacity,
    size_t *output_length) {
    const size_t length = strlen(encoded);
    if (length < 80u || length >= WATTPOST_REMOTE_OTA_SIGNATURE_MAX_LEN) {
        return false;
    }
    char padded[WATTPOST_REMOTE_OTA_SIGNATURE_MAX_LEN + 4u] = {0};
    if (length + 4u > sizeof(padded)) {
        return false;
    }
    for (size_t i = 0; i < length; ++i) {
        const char c = encoded[i];
        if (isalnum((unsigned char) c)) {
            padded[i] = c;
        } else if (c == '-') {
            padded[i] = '+';
        } else if (c == '_') {
            padded[i] = '/';
        } else {
            return false;
        }
    }
    size_t padded_length = length;
    while ((padded_length % 4u) != 0u) {
        padded[padded_length++] = '=';
    }
    size_t decoded = 0u;
    if (mbedtls_base64_decode(
            output,
            output_capacity,
            &decoded,
            (const unsigned char *) padded,
            padded_length) != 0 ||
        decoded < 64u || decoded > 80u) {
        return false;
    }
    *output_length = decoded;
    return true;
}

bool wattpost_remote_ota_verify_manifest_signature(
    const wattpost_remote_ota_target_t *target) {
    if (target == NULL) {
        return false;
    }
    char manifest[REMOTE_OTA_MANIFEST_MAX_LEN] = {0};
    size_t manifest_length = 0u;
    uint8_t digest[32] = {0};
    uint8_t signature[80] = {0};
    size_t signature_length = 0u;
    bool valid = false;

    if (!canonical_manifest(target, manifest, &manifest_length) ||
        !decode_signature(
            target->signature,
            signature,
            sizeof(signature),
            &signature_length) ||
        mbedtls_sha256(
            (const unsigned char *) manifest,
            manifest_length,
            digest,
            0) != 0) {
        goto cleanup;
    }

    mbedtls_pk_context public_key;
    mbedtls_pk_init(&public_key);
    const size_t public_key_length =
        (size_t) (_binary_wattpost_firmware_public_key_pub_end -
                  _binary_wattpost_firmware_public_key_pub_start);
    const int parse_result = mbedtls_pk_parse_public_key(
        &public_key,
        _binary_wattpost_firmware_public_key_pub_start,
        public_key_length);
    if (parse_result == 0 &&
        mbedtls_pk_verify(
            &public_key,
            MBEDTLS_MD_SHA256,
            digest,
            sizeof(digest),
            signature,
            signature_length) == 0) {
        valid = true;
    }
    mbedtls_pk_free(&public_key);

cleanup:
    memset(manifest, 0, sizeof(manifest));
    memset(digest, 0, sizeof(digest));
    memset(signature, 0, sizeof(signature));
    return valid;
}

static int hex_value(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
    return -1;
}

bool wattpost_remote_ota_parse_sha256(
    const char *hex,
    uint8_t output[32]) {
    if (!exact_hex(hex, WATTPOST_REMOTE_OTA_SHA256_HEX_LEN) || output == NULL) {
        return false;
    }
    for (size_t i = 0; i < 32u; ++i) {
        const int high = hex_value(hex[i * 2u]);
        const int low = hex_value(hex[i * 2u + 1u]);
        if (high < 0 || low < 0) {
            memset(output, 0, 32u);
            return false;
        }
        output[i] = (uint8_t) ((high << 4) | low);
    }
    return true;
}

bool wattpost_remote_ota_marker_load(wattpost_remote_ota_marker_t *marker) {
    if (marker == NULL) {
        return false;
    }
    memset(marker, 0, sizeof(*marker));
    nvs_handle_t handle;
    if (nvs_open(REMOTE_OTA_NAMESPACE, NVS_READONLY, &handle) != ESP_OK) {
        return false;
    }
    size_t version_length = sizeof(marker->version);
    size_t build_length = sizeof(marker->build_id);
    const bool valid =
        nvs_get_u32(handle, REMOTE_OTA_KEY_RELEASE, &marker->release_id) == ESP_OK &&
        nvs_get_str(handle, REMOTE_OTA_KEY_VERSION, marker->version, &version_length) == ESP_OK &&
        nvs_get_str(handle, REMOTE_OTA_KEY_BUILD, marker->build_id, &build_length) == ESP_OK &&
        marker->release_id != 0u &&
        parse_version(marker->version, &(semantic_version_t){0}) &&
        valid_build_id(marker->build_id);
    nvs_close(handle);
    if (!valid) {
        memset(marker, 0, sizeof(*marker));
    }
    return valid;
}

bool wattpost_remote_ota_marker_save(const wattpost_remote_ota_target_t *target) {
    if (target == NULL || target->release_id == 0u ||
        !valid_build_id(target->build_id)) {
        return false;
    }
    semantic_version_t parsed = {0};
    if (!parse_version(target->version, &parsed)) {
        return false;
    }
    nvs_handle_t handle;
    if (nvs_open(REMOTE_OTA_NAMESPACE, NVS_READWRITE, &handle) != ESP_OK) {
        return false;
    }
    esp_err_t err = nvs_set_u32(handle, REMOTE_OTA_KEY_RELEASE, target->release_id);
    if (err == ESP_OK) err = nvs_set_str(handle, REMOTE_OTA_KEY_VERSION, target->version);
    if (err == ESP_OK) err = nvs_set_str(handle, REMOTE_OTA_KEY_BUILD, target->build_id);
    if (err == ESP_OK) err = nvs_commit(handle);
    nvs_close(handle);
    return err == ESP_OK;
}

bool wattpost_remote_ota_marker_clear(void) {
    nvs_handle_t handle;
    esp_err_t err = nvs_open(REMOTE_OTA_NAMESPACE, NVS_READWRITE, &handle);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        return true;
    }
    if (err != ESP_OK) {
        return false;
    }

    const char *keys[] = {
        REMOTE_OTA_KEY_RELEASE,
        REMOTE_OTA_KEY_VERSION,
        REMOTE_OTA_KEY_BUILD,
    };
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); ++i) {
        const esp_err_t erase_err = nvs_erase_key(handle, keys[i]);
        if (erase_err != ESP_OK && erase_err != ESP_ERR_NVS_NOT_FOUND) {
            err = erase_err;
            break;
        }
    }
    if (err == ESP_OK) err = nvs_commit(handle);
    nvs_close(handle);
    return err == ESP_OK;
}

bool wattpost_remote_ota_automatic_updates_get(void) {
    nvs_handle_t handle;
    if (nvs_open(REMOTE_OTA_NAMESPACE, NVS_READONLY, &handle) != ESP_OK) {
        return true;
    }
    uint8_t stored = 1u;
    const esp_err_t err = nvs_get_u8(handle, REMOTE_OTA_KEY_AUTOMATIC, &stored);
    nvs_close(handle);
    if (err != ESP_OK || stored > 1u) {
        return true;
    }
    return stored == 1u;
}

bool wattpost_remote_ota_automatic_updates_set(bool enabled) {
    nvs_handle_t handle;
    if (nvs_open(REMOTE_OTA_NAMESPACE, NVS_READWRITE, &handle) != ESP_OK) {
        return false;
    }
    esp_err_t err = nvs_set_u8(
        handle, REMOTE_OTA_KEY_AUTOMATIC, enabled ? 1u : 0u);
    if (err == ESP_OK) err = nvs_commit(handle);
    nvs_close(handle);
    return err == ESP_OK;
}
