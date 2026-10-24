#include "device_identity.h"

#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "device_identity_platform.h"
#include "nvs.h"

#define IDENTITY_NAMESPACE "wp_identity"
#define IDENTITY_KEY_A "id_a"
#define IDENTITY_KEY_B "id_b"

#define IDENTITY_RECORD_SIZE 80u
#define IDENTITY_CRC_OFFSET 76u

enum {
    OFFSET_MAGIC = 0,
    OFFSET_SCHEMA = 4,
    OFFSET_SIZE = 6,
    OFFSET_GENERATION = 8,
    OFFSET_OWNERSHIP_EPOCH = 12,
    OFFSET_DEVICE_ID = 16,
    OFFSET_DEVICE_SECRET = 32,
    OFFSET_RESERVED = 64,
    OFFSET_CRC = 76,
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
    wattpost_device_identity_t identity;
} slot_result_t;

static uint16_t read_u16_le(const uint8_t *p) {
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static uint32_t read_u32_le(const uint8_t *p) {
    return (uint32_t)p[0] |
           ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

static void write_u16_le(uint8_t *p, uint16_t value) {
    p[0] = (uint8_t)value;
    p[1] = (uint8_t)(value >> 8);
}

static void write_u32_le(uint8_t *p, uint32_t value) {
    p[0] = (uint8_t)value;
    p[1] = (uint8_t)(value >> 8);
    p[2] = (uint8_t)(value >> 16);
    p[3] = (uint8_t)(value >> 24);
}

static uint32_t crc32_ieee(const uint8_t *data, size_t length) {
    uint32_t crc = UINT32_C(0xFFFFFFFF);
    for (size_t i = 0; i < length; ++i) {
        crc ^= data[i];
        for (unsigned bit = 0; bit < 8; ++bit) {
            const uint32_t mask = (uint32_t)-(int32_t)(crc & 1u);
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

static bool bytes_all_ff(const uint8_t *data, size_t length) {
    for (size_t i = 0; i < length; ++i) {
        if (data[i] != 0xFFu) {
            return false;
        }
    }
    return true;
}

static bool identity_valid(const wattpost_device_identity_t *identity) {
    if (!identity ||
        identity->ownership_epoch < WATTPOST_OWNERSHIP_EPOCH_INITIAL) {
        return false;
    }
    if (bytes_all_zero(identity->device_id, sizeof(identity->device_id)) ||
        bytes_all_ff(identity->device_id, sizeof(identity->device_id))) {
        return false;
    }
    if (bytes_all_zero(identity->device_secret, sizeof(identity->device_secret)) ||
        bytes_all_ff(identity->device_secret, sizeof(identity->device_secret))) {
        return false;
    }
    return true;
}

static bool identity_equal(const wattpost_device_identity_t *a,
                           const wattpost_device_identity_t *b) {
    return a && b &&
           a->ownership_epoch == b->ownership_epoch &&
           memcmp(a->device_id, b->device_id, sizeof(a->device_id)) == 0 &&
           memcmp(a->device_secret, b->device_secret,
                  sizeof(a->device_secret)) == 0;
}

static bool encode_record(const wattpost_device_identity_t *identity,
                          uint32_t generation,
                          uint8_t record[IDENTITY_RECORD_SIZE]) {
    if (!identity_valid(identity) || generation == 0) {
        return false;
    }

    memset(record, 0, IDENTITY_RECORD_SIZE);
    record[OFFSET_MAGIC + 0] = 'W';
    record[OFFSET_MAGIC + 1] = 'P';
    record[OFFSET_MAGIC + 2] = 'I';
    record[OFFSET_MAGIC + 3] = 'D';
    write_u16_le(record + OFFSET_SCHEMA, WATTPOST_DEVICE_IDENTITY_SCHEMA_VERSION);
    write_u16_le(record + OFFSET_SIZE, IDENTITY_RECORD_SIZE);
    write_u32_le(record + OFFSET_GENERATION, generation);
    write_u32_le(record + OFFSET_OWNERSHIP_EPOCH, identity->ownership_epoch);
    memcpy(record + OFFSET_DEVICE_ID, identity->device_id,
           sizeof(identity->device_id));
    memcpy(record + OFFSET_DEVICE_SECRET, identity->device_secret,
           sizeof(identity->device_secret));
    write_u32_le(record + OFFSET_CRC, crc32_ieee(record, IDENTITY_CRC_OFFSET));
    return true;
}

static slot_state_t decode_record(const uint8_t *record,
                                  size_t length,
                                  uint32_t *generation,
                                  wattpost_device_identity_t *identity) {
    if (!record || length != IDENTITY_RECORD_SIZE) {
        return SLOT_CORRUPT;
    }

    if (record[OFFSET_MAGIC + 0] != 'W' ||
        record[OFFSET_MAGIC + 1] != 'P' ||
        record[OFFSET_MAGIC + 2] != 'I' ||
        record[OFFSET_MAGIC + 3] != 'D') {
        return SLOT_CORRUPT;
    }

    if (read_u16_le(record + OFFSET_SCHEMA) !=
        WATTPOST_DEVICE_IDENTITY_SCHEMA_VERSION) {
        return SLOT_UNSUPPORTED;
    }
    if (read_u16_le(record + OFFSET_SIZE) != IDENTITY_RECORD_SIZE) {
        return SLOT_CORRUPT;
    }

    const uint32_t stored_generation =
        read_u32_le(record + OFFSET_GENERATION);
    if (stored_generation == 0) {
        return SLOT_CORRUPT;
    }

    for (size_t i = OFFSET_RESERVED; i < IDENTITY_CRC_OFFSET; ++i) {
        if (record[i] != 0) {
            return SLOT_CORRUPT;
        }
    }

    const uint32_t expected_crc = read_u32_le(record + OFFSET_CRC);
    if (crc32_ieee(record, IDENTITY_CRC_OFFSET) != expected_crc) {
        return SLOT_CORRUPT;
    }

    wattpost_device_identity_t parsed;
    memset(&parsed, 0, sizeof(parsed));
    parsed.ownership_epoch =
        read_u32_le(record + OFFSET_OWNERSHIP_EPOCH);
    memcpy(parsed.device_id, record + OFFSET_DEVICE_ID,
           sizeof(parsed.device_id));
    memcpy(parsed.device_secret, record + OFFSET_DEVICE_SECRET,
           sizeof(parsed.device_secret));
    if (!identity_valid(&parsed)) {
        memset(&parsed, 0, sizeof(parsed));
        return SLOT_CORRUPT;
    }

    if (generation) {
        *generation = stored_generation;
    }
    if (identity) {
        *identity = parsed;
    }
    memset(&parsed, 0, sizeof(parsed));
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
    if (length != IDENTITY_RECORD_SIZE) {
        result.state = SLOT_CORRUPT;
        return result;
    }

    uint8_t record[IDENTITY_RECORD_SIZE];
    size_t actual_length = sizeof(record);
    err = nvs_get_blob(handle, key, record, &actual_length);
    if (err != ESP_OK || actual_length != sizeof(record)) {
        memset(record, 0, sizeof(record));
        result.state = SLOT_IO_ERROR;
        return result;
    }

    result.state = decode_record(record, sizeof(record), &result.generation,
                                 &result.identity);
    memset(record, 0, sizeof(record));
    return result;
}

static bool generation_is_newer(uint32_t a, uint32_t b) {
    return (int32_t)(a - b) > 0;
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

wattpost_identity_result_t
wattpost_device_identity_load(wattpost_device_identity_t *identity) {
    if (!identity) {
        return WATTPOST_IDENTITY_STORAGE_ERROR;
    }
    memset(identity, 0, sizeof(*identity));

    nvs_handle_t handle;
    esp_err_t err = nvs_open(IDENTITY_NAMESPACE, NVS_READONLY, &handle);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        return WATTPOST_IDENTITY_EMPTY;
    }
    if (err != ESP_OK) {
        return WATTPOST_IDENTITY_STORAGE_ERROR;
    }

    const slot_result_t a = read_slot(handle, IDENTITY_KEY_A);
    const slot_result_t b = read_slot(handle, IDENTITY_KEY_B);
    nvs_close(handle);

    if (a.state == SLOT_IO_ERROR || b.state == SLOT_IO_ERROR) {
        return WATTPOST_IDENTITY_STORAGE_ERROR;
    }
    if (a.state == SLOT_UNSUPPORTED || b.state == SLOT_UNSUPPORTED) {
        return WATTPOST_IDENTITY_UNSUPPORTED;
    }

    if (a.state == SLOT_VALID && b.state == SLOT_VALID) {
        if (memcmp(a.identity.device_id, b.identity.device_id,
                   sizeof(a.identity.device_id)) != 0 ||
            memcmp(a.identity.device_secret, b.identity.device_secret,
                   sizeof(a.identity.device_secret)) != 0) {
            return WATTPOST_IDENTITY_CORRUPT;
        }
        if (a.generation == b.generation &&
            a.identity.ownership_epoch != b.identity.ownership_epoch) {
            return WATTPOST_IDENTITY_CORRUPT;
        }
    }

    const slot_result_t *newest = newest_valid_slot(&a, &b);
    if (newest) {
        *identity = newest->identity;
        const bool recovered =
            a.state != SLOT_VALID || b.state != SLOT_VALID ||
            (a.state == SLOT_VALID && b.state == SLOT_VALID &&
             (a.generation == b.generation ||
              a.identity.ownership_epoch != b.identity.ownership_epoch));
        return recovered ? WATTPOST_IDENTITY_RECOVERED
                         : WATTPOST_IDENTITY_OK;
    }

    if (a.state == SLOT_CORRUPT || b.state == SLOT_CORRUPT) {
        return WATTPOST_IDENTITY_CORRUPT;
    }
    return WATTPOST_IDENTITY_EMPTY;
}

static bool save_identity(const wattpost_device_identity_t *identity) {
    if (!identity_valid(identity)) {
        return false;
    }

    nvs_handle_t handle;
    if (nvs_open(IDENTITY_NAMESPACE, NVS_READWRITE, &handle) != ESP_OK) {
        return false;
    }

    const slot_result_t a = read_slot(handle, IDENTITY_KEY_A);
    const slot_result_t b = read_slot(handle, IDENTITY_KEY_B);
    if (a.state == SLOT_IO_ERROR || b.state == SLOT_IO_ERROR ||
        a.state == SLOT_UNSUPPORTED || b.state == SLOT_UNSUPPORTED ||
        ((a.state == SLOT_CORRUPT || b.state == SLOT_CORRUPT) &&
         newest_valid_slot(&a, &b) == NULL)) {
        nvs_close(handle);
        return false;
    }

    const slot_result_t *newest = newest_valid_slot(&a, &b);
    uint32_t generation = newest ? newest->generation + 1u : 1u;
    if (generation == 0) {
        generation = 1u;
    }

    const char *target_key = IDENTITY_KEY_A;
    if (a.state == SLOT_VALID && b.state == SLOT_VALID) {
        target_key = newest == &a ? IDENTITY_KEY_B : IDENTITY_KEY_A;
    } else if (a.state == SLOT_VALID) {
        target_key = IDENTITY_KEY_B;
    } else if (b.state == SLOT_VALID) {
        target_key = IDENTITY_KEY_A;
    } else if (a.state == SLOT_CORRUPT) {
        target_key = IDENTITY_KEY_A;
    } else if (b.state == SLOT_CORRUPT) {
        target_key = IDENTITY_KEY_B;
    }

    uint8_t record[IDENTITY_RECORD_SIZE];
    if (!encode_record(identity, generation, record)) {
        nvs_close(handle);
        return false;
    }

    esp_err_t err = nvs_set_blob(handle, target_key, record, sizeof(record));
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }

    if (err == ESP_OK) {
        uint8_t verify[IDENTITY_RECORD_SIZE];
        size_t verify_length = sizeof(verify);
        err = nvs_get_blob(handle, target_key, verify, &verify_length);
        if (err == ESP_OK &&
            (verify_length != sizeof(record) ||
             memcmp(verify, record, sizeof(record)) != 0)) {
            err = ESP_FAIL;
        }
        memset(verify, 0, sizeof(verify));
    }

    memset(record, 0, sizeof(record));
    nvs_close(handle);
    return err == ESP_OK;
}

wattpost_identity_result_t
wattpost_device_identity_init(wattpost_device_identity_t *identity) {
    if (!identity) {
        return WATTPOST_IDENTITY_STORAGE_ERROR;
    }

    wattpost_identity_result_t result = wattpost_device_identity_load(identity);
    if (result == WATTPOST_IDENTITY_OK) {
        return result;
    }
    if (result == WATTPOST_IDENTITY_RECOVERED) {
        /*
         * Restore redundancy from the surviving/current record without ever
         * generating a replacement identity. One write is sufficient because
         * save_identity() always targets the missing/corrupt/older slot.
         */
        if (!save_identity(identity)) {
            memset(identity, 0, sizeof(*identity));
            return WATTPOST_IDENTITY_STORAGE_ERROR;
        }
        wattpost_device_identity_t verified;
        const wattpost_identity_result_t verify_result =
            wattpost_device_identity_load(&verified);
        const bool repaired =
            verify_result == WATTPOST_IDENTITY_OK &&
            identity_equal(identity, &verified);
        memset(&verified, 0, sizeof(verified));
        if (!repaired) {
            memset(identity, 0, sizeof(*identity));
            return WATTPOST_IDENTITY_STORAGE_ERROR;
        }
        return WATTPOST_IDENTITY_RECOVERED;
    }
    if (result != WATTPOST_IDENTITY_EMPTY) {
        return result;
    }

    wattpost_device_identity_t generated;
    memset(&generated, 0, sizeof(generated));
    generated.ownership_epoch = WATTPOST_OWNERSHIP_EPOCH_INITIAL;

    uint8_t random_material[WATTPOST_DEVICE_ID_BYTES +
                            WATTPOST_DEVICE_SECRET_BYTES];
    if (!wattpost_device_identity_random_fill(random_material,
                                               sizeof(random_material))) {
        memset(random_material, 0, sizeof(random_material));
        return WATTPOST_IDENTITY_RANDOM_ERROR;
    }

    memcpy(generated.device_id, random_material, WATTPOST_DEVICE_ID_BYTES);
    memcpy(generated.device_secret,
           random_material + WATTPOST_DEVICE_ID_BYTES,
           WATTPOST_DEVICE_SECRET_BYTES);
    memset(random_material, 0, sizeof(random_material));

    if (!identity_valid(&generated)) {
        memset(&generated, 0, sizeof(generated));
        return WATTPOST_IDENTITY_RANDOM_ERROR;
    }
    /*
     * A created identity is considered ready only after both redundant slots
     * contain the same identity and ownership epoch.
     */
    if (!save_identity(&generated) || !save_identity(&generated)) {
        memset(&generated, 0, sizeof(generated));
        return WATTPOST_IDENTITY_STORAGE_ERROR;
    }

    wattpost_device_identity_t verified;
    result = wattpost_device_identity_load(&verified);
    if (result != WATTPOST_IDENTITY_OK ||
        !identity_equal(&generated, &verified)) {
        memset(&generated, 0, sizeof(generated));
        memset(&verified, 0, sizeof(verified));
        return WATTPOST_IDENTITY_STORAGE_ERROR;
    }

    *identity = generated;
    memset(&generated, 0, sizeof(generated));
    memset(&verified, 0, sizeof(verified));
    return WATTPOST_IDENTITY_CREATED;
}

bool wattpost_device_identity_advance_ownership_epoch(
    wattpost_device_identity_t *updated_identity) {
    if (!updated_identity) {
        return false;
    }
    memset(updated_identity, 0, sizeof(*updated_identity));

    wattpost_device_identity_t current;
    const wattpost_identity_result_t result =
        wattpost_device_identity_load(&current);
    if (result != WATTPOST_IDENTITY_OK &&
        result != WATTPOST_IDENTITY_RECOVERED) {
        memset(&current, 0, sizeof(current));
        return false;
    }
    if (current.ownership_epoch == UINT32_MAX) {
        memset(&current, 0, sizeof(current));
        return false;
    }

    wattpost_device_identity_t next = current;
    next.ownership_epoch++;

    /*
     * Ownership generation is security-critical for offline Factory Reset.
     * Do not report success until both slots carry the new epoch, so loss of
     * either one later cannot roll ownership state backwards.
     */
    if (!save_identity(&next) || !save_identity(&next)) {
        memset(&current, 0, sizeof(current));
        memset(&next, 0, sizeof(next));
        return false;
    }

    wattpost_device_identity_t verified;
    const wattpost_identity_result_t verify_result =
        wattpost_device_identity_load(&verified);
    if (verify_result != WATTPOST_IDENTITY_OK ||
        !identity_equal(&next, &verified)) {
        memset(&current, 0, sizeof(current));
        memset(&next, 0, sizeof(next));
        memset(&verified, 0, sizeof(verified));
        return false;
    }

    *updated_identity = next;
    memset(&current, 0, sizeof(current));
    memset(&next, 0, sizeof(next));
    memset(&verified, 0, sizeof(verified));
    return true;
}

const char *wattpost_device_identity_result_str(wattpost_identity_result_t result) {
    switch (result) {
        case WATTPOST_IDENTITY_OK: return "ok";
        case WATTPOST_IDENTITY_CREATED: return "created";
        case WATTPOST_IDENTITY_EMPTY: return "empty";
        case WATTPOST_IDENTITY_RECOVERED: return "recovered";
        case WATTPOST_IDENTITY_CORRUPT: return "corrupt";
        case WATTPOST_IDENTITY_UNSUPPORTED: return "unsupported";
        case WATTPOST_IDENTITY_STORAGE_ERROR: return "storage_error";
        case WATTPOST_IDENTITY_RANDOM_ERROR: return "random_error";
        default: return "unknown";
    }
}
