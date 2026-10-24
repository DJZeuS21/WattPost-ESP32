#include "device_config.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "nvs.h"

#define CONFIG_NAMESPACE "wp_cfg"
#define CONFIG_KEY_A "cfg_a"
#define CONFIG_KEY_B "cfg_b"

#define CONFIG_RECORD_SIZE 128u
#define CONFIG_CRC_OFFSET 124u
#define CONFIG_MAX_READ_SIZE 512u

#define CONFIG_FLAG_WIFI (1u << 0)
#define CONFIG_FLAG_BMS  (1u << 1)
#define CONFIG_FLAGS_KNOWN (CONFIG_FLAG_WIFI | CONFIG_FLAG_BMS)

enum {
    OFFSET_MAGIC = 0,
    OFFSET_SCHEMA = 4,
    OFFSET_SIZE = 6,
    OFFSET_GENERATION = 8,
    OFFSET_FLAGS = 12,
    OFFSET_SSID_LEN = 16,
    OFFSET_PASSWORD_LEN = 17,
    OFFSET_BMS_ADDR_TYPE = 18,
    OFFSET_RESERVED_0 = 19,
    OFFSET_SSID = 20,
    OFFSET_PASSWORD = 52,
    OFFSET_BMS_ADDRESS = 116,
    OFFSET_RESERVED_1 = 122,
    OFFSET_CRC = 124,
};

typedef enum {
    SLOT_ABSENT = 0,
    SLOT_VALID,
    SLOT_CORRUPT,
    SLOT_UNSUPPORTED,
    SLOT_IO_ERROR,
} slot_state_t;

typedef struct {
    slot_state_t state;
    uint32_t generation;
    wattpost_device_config_t config;
} slot_result_t;

static uint16_t read_u16_le(const uint8_t *p) {
    return (uint16_t) p[0] | ((uint16_t) p[1] << 8);
}

static uint32_t read_u32_le(const uint8_t *p) {
    return (uint32_t) p[0] |
           ((uint32_t) p[1] << 8) |
           ((uint32_t) p[2] << 16) |
           ((uint32_t) p[3] << 24);
}

static void write_u16_le(uint8_t *p, uint16_t value) {
    p[0] = (uint8_t) value;
    p[1] = (uint8_t) (value >> 8);
}

static void write_u32_le(uint8_t *p, uint32_t value) {
    p[0] = (uint8_t) value;
    p[1] = (uint8_t) (value >> 8);
    p[2] = (uint8_t) (value >> 16);
    p[3] = (uint8_t) (value >> 24);
}

static uint32_t crc32_ieee(const uint8_t *data, size_t length) {
    uint32_t crc = UINT32_C(0xFFFFFFFF);
    for (size_t i = 0; i < length; ++i) {
        crc ^= data[i];
        for (unsigned bit = 0; bit < 8; ++bit) {
            const uint32_t mask = (uint32_t) -(int32_t) (crc & 1u);
            crc = (crc >> 1) ^ (UINT32_C(0xEDB88320) & mask);
        }
    }
    return ~crc;
}

static bool bytes_all_zero(const uint8_t *data, size_t length) {
    for (size_t i = 0; i < length; ++i) {
        if (data[i] != 0) {
            return false;
        }
    }
    return true;
}

void wattpost_device_config_defaults(wattpost_device_config_t *config) {
    if (config) {
        memset(config, 0, sizeof(*config));
    }
}

bool wattpost_device_config_validate(const wattpost_device_config_t *config) {
    if (!config) {
        return false;
    }

    if (config->wifi_configured) {
        if (config->wifi_ssid_len == 0 ||
            config->wifi_ssid_len > WATTPOST_WIFI_SSID_MAX_LEN ||
            config->wifi_password_len > WATTPOST_WIFI_PASSWORD_MAX_LEN) {
            return false;
        }
    } else if (config->wifi_ssid_len != 0 || config->wifi_password_len != 0) {
        return false;
    }

    if (config->bms_configured) {
        if (config->bms_address_type > 3 ||
            bytes_all_zero(config->bms_address, WATTPOST_BMS_ADDRESS_LEN)) {
            return false;
        }
    } else if (config->bms_address_type != 0 ||
               !bytes_all_zero(config->bms_address, WATTPOST_BMS_ADDRESS_LEN)) {
        return false;
    }

    return true;
}

void wattpost_device_config_clear_wifi(wattpost_device_config_t *config) {
    if (!config) {
        return;
    }
    config->wifi_configured = false;
    config->wifi_ssid_len = 0;
    memset(config->wifi_ssid, 0, sizeof(config->wifi_ssid));
    config->wifi_password_len = 0;
    memset(config->wifi_password, 0, sizeof(config->wifi_password));
}

void wattpost_device_config_clear_bms(wattpost_device_config_t *config) {
    if (!config) {
        return;
    }
    config->bms_configured = false;
    config->bms_address_type = 0;
    memset(config->bms_address, 0, sizeof(config->bms_address));
}

static bool encode_record(const wattpost_device_config_t *config,
                          uint32_t generation,
                          uint8_t record[CONFIG_RECORD_SIZE]) {
    if (!wattpost_device_config_validate(config)) {
        return false;
    }

    memset(record, 0, CONFIG_RECORD_SIZE);
    record[OFFSET_MAGIC + 0] = 'W';
    record[OFFSET_MAGIC + 1] = 'P';
    record[OFFSET_MAGIC + 2] = 'C';
    record[OFFSET_MAGIC + 3] = 'F';
    write_u16_le(record + OFFSET_SCHEMA, WATTPOST_DEVICE_CONFIG_SCHEMA_VERSION);
    write_u16_le(record + OFFSET_SIZE, CONFIG_RECORD_SIZE);
    write_u32_le(record + OFFSET_GENERATION, generation);

    uint32_t flags = 0;
    if (config->wifi_configured) {
        flags |= CONFIG_FLAG_WIFI;
        record[OFFSET_SSID_LEN] = config->wifi_ssid_len;
        record[OFFSET_PASSWORD_LEN] = config->wifi_password_len;
        memcpy(record + OFFSET_SSID, config->wifi_ssid, config->wifi_ssid_len);
        memcpy(record + OFFSET_PASSWORD, config->wifi_password, config->wifi_password_len);
    }
    if (config->bms_configured) {
        flags |= CONFIG_FLAG_BMS;
        record[OFFSET_BMS_ADDR_TYPE] = config->bms_address_type;
        memcpy(record + OFFSET_BMS_ADDRESS, config->bms_address,
               WATTPOST_BMS_ADDRESS_LEN);
    }
    write_u32_le(record + OFFSET_FLAGS, flags);
    write_u32_le(record + OFFSET_CRC, crc32_ieee(record, CONFIG_CRC_OFFSET));
    return true;
}

static slot_state_t decode_record(const uint8_t *record,
                                  size_t length,
                                  uint32_t *generation,
                                  wattpost_device_config_t *config) {
    if (!record || length < 8) {
        return SLOT_CORRUPT;
    }

    if (record[OFFSET_MAGIC + 0] != 'W' ||
        record[OFFSET_MAGIC + 1] != 'P' ||
        record[OFFSET_MAGIC + 2] != 'C' ||
        record[OFFSET_MAGIC + 3] != 'F') {
        return SLOT_CORRUPT;
    }

    const uint16_t schema = read_u16_le(record + OFFSET_SCHEMA);
    if (schema != WATTPOST_DEVICE_CONFIG_SCHEMA_VERSION) {
        return SLOT_UNSUPPORTED;
    }

    if (length != CONFIG_RECORD_SIZE ||
        read_u16_le(record + OFFSET_SIZE) != CONFIG_RECORD_SIZE) {
        return SLOT_CORRUPT;
    }

    if (record[OFFSET_RESERVED_0] != 0 ||
        record[OFFSET_RESERVED_1] != 0 ||
        record[OFFSET_RESERVED_1 + 1] != 0) {
        return SLOT_CORRUPT;
    }

    const uint32_t expected_crc = read_u32_le(record + OFFSET_CRC);
    if (crc32_ieee(record, CONFIG_CRC_OFFSET) != expected_crc) {
        return SLOT_CORRUPT;
    }

    const uint32_t flags = read_u32_le(record + OFFSET_FLAGS);
    if ((flags & ~CONFIG_FLAGS_KNOWN) != 0) {
        return SLOT_CORRUPT;
    }

    wattpost_device_config_t parsed;
    wattpost_device_config_defaults(&parsed);

    if ((flags & CONFIG_FLAG_WIFI) != 0) {
        parsed.wifi_configured = true;
        parsed.wifi_ssid_len = record[OFFSET_SSID_LEN];
        parsed.wifi_password_len = record[OFFSET_PASSWORD_LEN];
        if (parsed.wifi_ssid_len > WATTPOST_WIFI_SSID_MAX_LEN ||
            parsed.wifi_password_len > WATTPOST_WIFI_PASSWORD_MAX_LEN) {
            return SLOT_CORRUPT;
        }
        memcpy(parsed.wifi_ssid, record + OFFSET_SSID, parsed.wifi_ssid_len);
        memcpy(parsed.wifi_password, record + OFFSET_PASSWORD,
               parsed.wifi_password_len);
    } else if (record[OFFSET_SSID_LEN] != 0 ||
               record[OFFSET_PASSWORD_LEN] != 0) {
        return SLOT_CORRUPT;
    }

    if ((flags & CONFIG_FLAG_BMS) != 0) {
        parsed.bms_configured = true;
        parsed.bms_address_type = record[OFFSET_BMS_ADDR_TYPE];
        memcpy(parsed.bms_address, record + OFFSET_BMS_ADDRESS,
               WATTPOST_BMS_ADDRESS_LEN);
    } else if (record[OFFSET_BMS_ADDR_TYPE] != 0 ||
               !bytes_all_zero(record + OFFSET_BMS_ADDRESS,
                               WATTPOST_BMS_ADDRESS_LEN)) {
        return SLOT_CORRUPT;
    }

    if (!wattpost_device_config_validate(&parsed)) {
        return SLOT_CORRUPT;
    }

    if (generation) {
        *generation = read_u32_le(record + OFFSET_GENERATION);
    }
    if (config) {
        *config = parsed;
    }
    return SLOT_VALID;
}

static slot_result_t read_slot(nvs_handle_t handle, const char *key) {
    slot_result_t result;
    memset(&result, 0, sizeof(result));
    result.state = SLOT_ABSENT;

    size_t length = 0;
    esp_err_t err = nvs_get_blob(handle, key, NULL, &length);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        return result;
    }
    if (err != ESP_OK) {
        result.state = SLOT_IO_ERROR;
        return result;
    }
    if (length == 0 || length > CONFIG_MAX_READ_SIZE) {
        result.state = SLOT_CORRUPT;
        return result;
    }

    uint8_t *record = malloc(length);
    if (!record) {
        result.state = SLOT_IO_ERROR;
        return result;
    }

    size_t actual_length = length;
    err = nvs_get_blob(handle, key, record, &actual_length);
    if (err != ESP_OK || actual_length != length) {
        free(record);
        result.state = SLOT_IO_ERROR;
        return result;
    }

    result.state = decode_record(record, length, &result.generation,
                                 &result.config);
    free(record);
    return result;
}

static bool generation_is_newer(uint32_t a, uint32_t b) {
    return (int32_t) (a - b) > 0;
}

static const slot_result_t *newest_valid_slot(const slot_result_t *a,
                                               const slot_result_t *b) {
    if (a->state == SLOT_VALID && b->state == SLOT_VALID) {
        if (a->generation == b->generation) {
            return a;
        }
        return generation_is_newer(a->generation, b->generation) ? a : b;
    }
    if (a->state == SLOT_VALID) {
        return a;
    }
    if (b->state == SLOT_VALID) {
        return b;
    }
    return NULL;
}

wattpost_config_load_result_t
wattpost_device_config_load(wattpost_device_config_t *config) {
    if (!config) {
        return WATTPOST_CONFIG_LOAD_STORAGE_ERROR;
    }
    wattpost_device_config_defaults(config);

    nvs_handle_t handle;
    esp_err_t err = nvs_open(CONFIG_NAMESPACE, NVS_READONLY, &handle);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        return WATTPOST_CONFIG_LOAD_EMPTY;
    }
    if (err != ESP_OK) {
        return WATTPOST_CONFIG_LOAD_STORAGE_ERROR;
    }

    const slot_result_t a = read_slot(handle, CONFIG_KEY_A);
    const slot_result_t b = read_slot(handle, CONFIG_KEY_B);
    nvs_close(handle);

    if (a.state == SLOT_IO_ERROR || b.state == SLOT_IO_ERROR) {
        return WATTPOST_CONFIG_LOAD_STORAGE_ERROR;
    }

    const slot_result_t *newest = newest_valid_slot(&a, &b);
    if (newest) {
        *config = newest->config;
        const bool degraded =
            (a.state != SLOT_VALID && a.state != SLOT_ABSENT) ||
            (b.state != SLOT_VALID && b.state != SLOT_ABSENT) ||
            (a.state == SLOT_VALID && b.state == SLOT_VALID &&
             a.generation == b.generation);
        return degraded ? WATTPOST_CONFIG_LOAD_RECOVERED
                        : WATTPOST_CONFIG_LOAD_OK;
    }

    if (a.state == SLOT_CORRUPT || b.state == SLOT_CORRUPT) {
        return WATTPOST_CONFIG_LOAD_CORRUPT;
    }
    if (a.state == SLOT_UNSUPPORTED || b.state == SLOT_UNSUPPORTED) {
        return WATTPOST_CONFIG_LOAD_UNSUPPORTED;
    }
    return WATTPOST_CONFIG_LOAD_EMPTY;
}

const char *wattpost_device_config_load_result_str(
    wattpost_config_load_result_t result) {
    switch (result) {
        case WATTPOST_CONFIG_LOAD_OK: return "ok";
        case WATTPOST_CONFIG_LOAD_EMPTY: return "empty";
        case WATTPOST_CONFIG_LOAD_RECOVERED: return "recovered";
        case WATTPOST_CONFIG_LOAD_CORRUPT: return "corrupt";
        case WATTPOST_CONFIG_LOAD_UNSUPPORTED: return "unsupported";
        case WATTPOST_CONFIG_LOAD_STORAGE_ERROR: return "storage_error";
        default: return "unknown";
    }
}

bool wattpost_device_config_save(const wattpost_device_config_t *config) {
    if (!wattpost_device_config_validate(config)) {
        return false;
    }

    nvs_handle_t handle;
    if (nvs_open(CONFIG_NAMESPACE, NVS_READWRITE, &handle) != ESP_OK) {
        return false;
    }

    const slot_result_t a = read_slot(handle, CONFIG_KEY_A);
    const slot_result_t b = read_slot(handle, CONFIG_KEY_B);
    if (a.state == SLOT_IO_ERROR || b.state == SLOT_IO_ERROR ||
        a.state == SLOT_UNSUPPORTED || b.state == SLOT_UNSUPPORTED) {
        /*
         * A downgraded firmware must never overwrite a slot written by a
         * future schema it cannot understand. Require an explicit migration
         * path in the newer firmware instead.
         */
        nvs_close(handle);
        return false;
    }

    const slot_result_t *newest = newest_valid_slot(&a, &b);
    uint32_t generation = newest ? newest->generation + 1u : 1u;
    if (generation == 0) {
        generation = 1u;
    }

    const char *target_key = CONFIG_KEY_A;
    if (a.state == SLOT_VALID && b.state == SLOT_VALID) {
        target_key = newest == &a ? CONFIG_KEY_B : CONFIG_KEY_A;
    } else if (a.state == SLOT_VALID) {
        target_key = CONFIG_KEY_B;
    } else if (b.state == SLOT_VALID) {
        target_key = CONFIG_KEY_A;
    }

    uint8_t record[CONFIG_RECORD_SIZE];
    if (!encode_record(config, generation, record)) {
        nvs_close(handle);
        return false;
    }

    esp_err_t err = nvs_set_blob(handle, target_key, record, sizeof(record));
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }

    if (err == ESP_OK) {
        uint8_t verify[CONFIG_RECORD_SIZE];
        size_t verify_length = sizeof(verify);
        err = nvs_get_blob(handle, target_key, verify, &verify_length);
        if (err == ESP_OK &&
            (verify_length != sizeof(record) ||
             memcmp(verify, record, sizeof(record)) != 0)) {
            err = ESP_FAIL;
        }
    }

    nvs_close(handle);
    return err == ESP_OK;
}

static bool load_for_scoped_update(wattpost_device_config_t *config) {
    const wattpost_config_load_result_t result =
        wattpost_device_config_load(config);
    if (result == WATTPOST_CONFIG_LOAD_EMPTY) {
        wattpost_device_config_defaults(config);
        return true;
    }
    return result == WATTPOST_CONFIG_LOAD_OK ||
           result == WATTPOST_CONFIG_LOAD_RECOVERED;
}

bool wattpost_device_config_clear_wifi_persisted(void) {
    wattpost_device_config_t config;
    if (!load_for_scoped_update(&config)) {
        return false;
    }
    if (!config.wifi_configured) {
        return true;
    }
    wattpost_device_config_clear_wifi(&config);
    return wattpost_device_config_save(&config);
}

bool wattpost_device_config_clear_bms_persisted(void) {
    wattpost_device_config_t config;
    if (!load_for_scoped_update(&config)) {
        return false;
    }
    if (!config.bms_configured) {
        return true;
    }
    wattpost_device_config_clear_bms(&config);
    return wattpost_device_config_save(&config);
}

bool wattpost_device_config_erase_store(void) {
    nvs_handle_t handle;
    esp_err_t err = nvs_open(CONFIG_NAMESPACE, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return false;
    }
    err = nvs_erase_all(handle);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    return err == ESP_OK;
}
