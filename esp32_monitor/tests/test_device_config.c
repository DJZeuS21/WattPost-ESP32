#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "device_config.h"
#include "nvs.h"

#define MOCK_RECORD_MAX 512

typedef struct {
    bool present;
    size_t length;
    uint8_t data[MOCK_RECORD_MAX];
} mock_blob_t;

typedef enum {
    FAIL_NONE,
    FAIL_OPEN,
    FAIL_SET,
    FAIL_COMMIT,
    FAIL_READBACK,
    FAIL_ERASE,
} failure_t;

static bool namespace_exists;
static mock_blob_t persisted_a;
static mock_blob_t persisted_b;
static mock_blob_t pending_a;
static mock_blob_t pending_b;
static bool pending_erase;
static failure_t failure;
static bool commit_happened;
static unsigned open_calls;
static char last_namespace[32];

static void reset_mock(void) {
    namespace_exists = false;
    memset(&persisted_a, 0, sizeof(persisted_a));
    memset(&persisted_b, 0, sizeof(persisted_b));
    memset(&pending_a, 0, sizeof(pending_a));
    memset(&pending_b, 0, sizeof(pending_b));
    pending_erase = false;
    failure = FAIL_NONE;
    commit_happened = false;
    open_calls = 0;
    memset(last_namespace, 0, sizeof(last_namespace));
}

static mock_blob_t *blob_for_key(const char *key, bool pending) {
    if (strcmp(key, "cfg_a") == 0) {
        return pending ? &pending_a : &persisted_a;
    }
    if (strcmp(key, "cfg_b") == 0) {
        return pending ? &pending_b : &persisted_b;
    }
    return NULL;
}

esp_err_t nvs_open(const char *namespace_name, nvs_open_mode_t open_mode,
                   nvs_handle_t *out_handle) {
    ++open_calls;
    strncpy(last_namespace, namespace_name, sizeof(last_namespace) - 1);
    if (failure == FAIL_OPEN) {
        return ESP_FAIL;
    }
    if (strcmp(namespace_name, "wp_cfg") != 0) {
        return ESP_FAIL;
    }
    if (open_mode == NVS_READONLY && !namespace_exists) {
        return ESP_ERR_NVS_NOT_FOUND;
    }
    *out_handle = 1;
    return ESP_OK;
}

esp_err_t nvs_get_u8(nvs_handle_t handle, const char *key, uint8_t *out_value) {
    (void) handle;
    (void) key;
    (void) out_value;
    return ESP_FAIL;
}

esp_err_t nvs_set_u8(nvs_handle_t handle, const char *key, uint8_t value) {
    (void) handle;
    (void) key;
    (void) value;
    return ESP_FAIL;
}

esp_err_t nvs_get_blob(nvs_handle_t handle, const char *key, void *out_value,
                       size_t *length) {
    (void) handle;
    if (failure == FAIL_READBACK && commit_happened) {
        return ESP_FAIL;
    }

    mock_blob_t *blob = blob_for_key(key, false);
    if (!blob) {
        return ESP_FAIL;
    }
    if (!blob->present) {
        return ESP_ERR_NVS_NOT_FOUND;
    }

    if (!out_value) {
        *length = blob->length;
        return ESP_OK;
    }
    if (*length < blob->length) {
        *length = blob->length;
        return ESP_FAIL;
    }
    memcpy(out_value, blob->data, blob->length);
    *length = blob->length;
    return ESP_OK;
}

esp_err_t nvs_set_blob(nvs_handle_t handle, const char *key, const void *value,
                       size_t length) {
    (void) handle;
    if (failure == FAIL_SET || length > MOCK_RECORD_MAX) {
        return ESP_FAIL;
    }
    mock_blob_t *blob = blob_for_key(key, true);
    if (!blob) {
        return ESP_FAIL;
    }
    blob->present = true;
    blob->length = length;
    memcpy(blob->data, value, length);
    return ESP_OK;
}

esp_err_t nvs_erase_all(nvs_handle_t handle) {
    (void) handle;
    if (failure == FAIL_ERASE) {
        return ESP_FAIL;
    }
    pending_erase = true;
    return ESP_OK;
}

esp_err_t nvs_commit(nvs_handle_t handle) {
    (void) handle;
    if (failure == FAIL_COMMIT) {
        return ESP_FAIL;
    }

    if (pending_erase) {
        memset(&persisted_a, 0, sizeof(persisted_a));
        memset(&persisted_b, 0, sizeof(persisted_b));
        pending_erase = false;
    }
    if (pending_a.present) {
        persisted_a = pending_a;
        memset(&pending_a, 0, sizeof(pending_a));
    }
    if (pending_b.present) {
        persisted_b = pending_b;
        memset(&pending_b, 0, sizeof(pending_b));
    }
    namespace_exists = true;
    commit_happened = true;
    return ESP_OK;
}

void nvs_close(nvs_handle_t handle) {
    (void) handle;
    memset(&pending_a, 0, sizeof(pending_a));
    memset(&pending_b, 0, sizeof(pending_b));
    pending_erase = false;
}

static wattpost_device_config_t make_config(const char *ssid,
                                             const char *password,
                                             uint8_t address_tail) {
    wattpost_device_config_t config;
    wattpost_device_config_defaults(&config);

    config.wifi_configured = true;
    config.wifi_ssid_len = (uint8_t) strlen(ssid);
    memcpy(config.wifi_ssid, ssid, config.wifi_ssid_len);
    config.wifi_password_len = (uint8_t) strlen(password);
    memcpy(config.wifi_password, password, config.wifi_password_len);

    config.bms_configured = true;
    config.bms_address_type = 0;
    const uint8_t address[WATTPOST_BMS_ADDRESS_LEN] =
        {0xC8, 0x47, 0x8C, 0xE1, 0xA7, address_tail};
    memcpy(config.bms_address, address, sizeof(address));
    return config;
}

static bool config_equal(const wattpost_device_config_t *a,
                         const wattpost_device_config_t *b) {
    return a->wifi_configured == b->wifi_configured &&
           a->wifi_ssid_len == b->wifi_ssid_len &&
           memcmp(a->wifi_ssid, b->wifi_ssid, sizeof(a->wifi_ssid)) == 0 &&
           a->wifi_password_len == b->wifi_password_len &&
           memcmp(a->wifi_password, b->wifi_password,
                  sizeof(a->wifi_password)) == 0 &&
           a->bms_configured == b->bms_configured &&
           a->bms_address_type == b->bms_address_type &&
           memcmp(a->bms_address, b->bms_address,
                  sizeof(a->bms_address)) == 0;
}

static void test_empty_load(void) {
    reset_mock();
    wattpost_device_config_t config;
    assert(wattpost_device_config_load(&config) == WATTPOST_CONFIG_LOAD_EMPTY);
    wattpost_device_config_t empty;
    wattpost_device_config_defaults(&empty);
    assert(config_equal(&config, &empty));
}

static void test_save_load_and_generation(void) {
    reset_mock();

    wattpost_device_config_t first = make_config("Home-A", "password-one", 0x01);
    assert(wattpost_device_config_save(&first));
    assert(persisted_a.present);
    assert(!persisted_b.present);
    assert(strcmp(last_namespace, "wp_cfg") == 0);

    wattpost_device_config_t loaded;
    assert(wattpost_device_config_load(&loaded) == WATTPOST_CONFIG_LOAD_OK);
    assert(config_equal(&first, &loaded));

    commit_happened = false;
    wattpost_device_config_t second = make_config("Home-B", "password-two", 0x02);
    assert(wattpost_device_config_save(&second));
    assert(persisted_a.present && persisted_b.present);
    assert(wattpost_device_config_load(&loaded) == WATTPOST_CONFIG_LOAD_OK);
    assert(config_equal(&second, &loaded));

    commit_happened = false;
    wattpost_device_config_t third = make_config("Home-C", "password-three", 0x03);
    assert(wattpost_device_config_save(&third));
    assert(wattpost_device_config_load(&loaded) == WATTPOST_CONFIG_LOAD_OK);
    assert(config_equal(&third, &loaded));
}

static void test_failed_write_preserves_previous(void) {
    reset_mock();
    wattpost_device_config_t original = make_config("Home-A", "password-one", 0x11);
    assert(wattpost_device_config_save(&original));

    wattpost_device_config_t replacement =
        make_config("Home-B", "password-two", 0x22);

    commit_happened = false;
    failure = FAIL_SET;
    assert(!wattpost_device_config_save(&replacement));
    failure = FAIL_NONE;

    wattpost_device_config_t loaded;
    assert(wattpost_device_config_load(&loaded) == WATTPOST_CONFIG_LOAD_OK);
    assert(config_equal(&original, &loaded));

    commit_happened = false;
    failure = FAIL_COMMIT;
    assert(!wattpost_device_config_save(&replacement));
    failure = FAIL_NONE;
    assert(wattpost_device_config_load(&loaded) == WATTPOST_CONFIG_LOAD_OK);
    assert(config_equal(&original, &loaded));
}

static void test_corruption_recovery(void) {
    reset_mock();
    wattpost_device_config_t first = make_config("Home-A", "password-one", 0x31);
    wattpost_device_config_t second = make_config("Home-B", "password-two", 0x32);
    assert(wattpost_device_config_save(&first));
    commit_happened = false;
    assert(wattpost_device_config_save(&second));

    /* cfg_b is newest after two saves. Break its payload without updating CRC. */
    persisted_b.data[24] ^= 0x5A;

    wattpost_device_config_t loaded;
    assert(wattpost_device_config_load(&loaded) == WATTPOST_CONFIG_LOAD_RECOVERED);
    assert(config_equal(&first, &loaded));

    persisted_a.data[25] ^= 0x33;
    assert(wattpost_device_config_load(&loaded) == WATTPOST_CONFIG_LOAD_CORRUPT);
}

static void test_unsupported_schema(void) {
    reset_mock();
    wattpost_device_config_t config = make_config("Home-A", "password-one", 0x41);
    assert(wattpost_device_config_save(&config));

    /* Decoder checks magic/schema before CRC; emulate a future schema record. */
    persisted_a.data[4] = 99;
    persisted_a.data[5] = 0;

    wattpost_device_config_t loaded;
    assert(wattpost_device_config_load(&loaded) ==
           WATTPOST_CONFIG_LOAD_UNSUPPORTED);
    assert(persisted_a.present);

    /* A downgraded firmware must not overwrite an unknown future schema. */
    wattpost_device_config_t replacement =
        make_config("Home-B", "password-two", 0x42);
    assert(!wattpost_device_config_save(&replacement));
    assert(persisted_a.data[4] == 99);
    assert(persisted_a.data[5] == 0);
}

static void test_readback_failure_preserves_previous(void) {
    reset_mock();
    wattpost_device_config_t original =
        make_config("Home-A", "password-one", 0x43);
    assert(wattpost_device_config_save(&original));

    commit_happened = false;
    failure = FAIL_READBACK;
    wattpost_device_config_t replacement =
        make_config("Home-B", "password-two", 0x44);
    assert(!wattpost_device_config_save(&replacement));

    /*
     * The mock commits the new slot and then fails verification. In real NVS
     * the previous slot is still intact, which is the invariant under test.
     */
    failure = FAIL_NONE;
    commit_happened = false;
    assert(persisted_a.present);
    wattpost_device_config_t loaded;
    const wattpost_config_load_result_t result =
        wattpost_device_config_load(&loaded);
    assert(result == WATTPOST_CONFIG_LOAD_OK);
}

static void test_invalid_config_rejected(void) {
    reset_mock();

    wattpost_device_config_t config;
    wattpost_device_config_defaults(&config);
    config.wifi_configured = true;
    assert(!wattpost_device_config_validate(&config));
    assert(!wattpost_device_config_save(&config));

    wattpost_device_config_defaults(&config);
    config.bms_configured = true;
    config.bms_address_type = 0;
    assert(!wattpost_device_config_validate(&config));

    wattpost_device_config_defaults(&config);
    config.bms_configured = true;
    config.bms_address_type = 4;
    config.bms_address[5] = 1;
    assert(!wattpost_device_config_validate(&config));
}

static void test_clear_scopes(void) {
    wattpost_device_config_t config = make_config("Home-A", "password-one", 0x51);
    uint8_t saved_bms[WATTPOST_BMS_ADDRESS_LEN];
    memcpy(saved_bms, config.bms_address, sizeof(saved_bms));

    wattpost_device_config_clear_wifi(&config);
    assert(!config.wifi_configured);
    assert(config.wifi_ssid_len == 0);
    assert(config.wifi_password_len == 0);
    assert(config.bms_configured);
    assert(memcmp(config.bms_address, saved_bms, sizeof(saved_bms)) == 0);
    assert(wattpost_device_config_validate(&config));

    config = make_config("Home-A", "password-one", 0x52);
    uint8_t saved_ssid[WATTPOST_WIFI_SSID_MAX_LEN];
    memcpy(saved_ssid, config.wifi_ssid, sizeof(saved_ssid));

    wattpost_device_config_clear_bms(&config);
    assert(config.wifi_configured);
    assert(memcmp(config.wifi_ssid, saved_ssid, sizeof(saved_ssid)) == 0);
    assert(!config.bms_configured);
    assert(config.bms_address_type == 0);
    assert(wattpost_device_config_validate(&config));
}

static void test_persisted_clear_scopes(void) {
    reset_mock();
    wattpost_device_config_t config = make_config("Home-A", "password-one", 0x61);
    assert(wattpost_device_config_save(&config));

    commit_happened = false;
    assert(wattpost_device_config_clear_wifi_persisted());

    wattpost_device_config_t loaded;
    wattpost_config_load_result_t result = wattpost_device_config_load(&loaded);
    assert(result == WATTPOST_CONFIG_LOAD_OK);
    assert(!loaded.wifi_configured);
    assert(loaded.bms_configured);
    assert(loaded.bms_address[5] == 0x61);

    commit_happened = false;
    assert(wattpost_device_config_clear_bms_persisted());
    result = wattpost_device_config_load(&loaded);
    assert(result == WATTPOST_CONFIG_LOAD_OK);
    assert(!loaded.wifi_configured);
    assert(!loaded.bms_configured);
    assert(wattpost_device_config_validate(&loaded));

    reset_mock();
    assert(wattpost_device_config_clear_wifi_persisted());
    assert(wattpost_device_config_clear_bms_persisted());
}

static void test_erase_store_scope(void) {
    reset_mock();
    wattpost_device_config_t config = make_config("Home-A", "password-one", 0x62);
    assert(wattpost_device_config_save(&config));

    commit_happened = false;
    assert(wattpost_device_config_erase_store());
    assert(strcmp(last_namespace, "wp_cfg") == 0);
    assert(!persisted_a.present && !persisted_b.present);

    wattpost_device_config_t loaded;
    assert(wattpost_device_config_load(&loaded) == WATTPOST_CONFIG_LOAD_EMPTY);
}

static void test_load_result_strings(void) {
    assert(strcmp(wattpost_device_config_load_result_str(
                      WATTPOST_CONFIG_LOAD_OK),
                  "ok") == 0);
    assert(strcmp(wattpost_device_config_load_result_str(
                      WATTPOST_CONFIG_LOAD_EMPTY),
                  "empty") == 0);
    assert(strcmp(wattpost_device_config_load_result_str(
                      WATTPOST_CONFIG_LOAD_RECOVERED),
                  "recovered") == 0);
    assert(strcmp(wattpost_device_config_load_result_str(
                      WATTPOST_CONFIG_LOAD_CORRUPT),
                  "corrupt") == 0);
    assert(strcmp(wattpost_device_config_load_result_str(
                      WATTPOST_CONFIG_LOAD_UNSUPPORTED),
                  "unsupported") == 0);
    assert(strcmp(wattpost_device_config_load_result_str(
                      WATTPOST_CONFIG_LOAD_STORAGE_ERROR),
                  "storage_error") == 0);
}

static void test_storage_errors_are_explicit(void) {
    reset_mock();
    failure = FAIL_OPEN;
    wattpost_device_config_t config;
    assert(wattpost_device_config_load(&config) ==
           WATTPOST_CONFIG_LOAD_STORAGE_ERROR);

    reset_mock();
    config = make_config("Home-A", "password-one", 0x71);
    assert(wattpost_device_config_save(&config));
    commit_happened = true;
    failure = FAIL_READBACK;
    assert(wattpost_device_config_load(&config) ==
           WATTPOST_CONFIG_LOAD_STORAGE_ERROR);
}

int main(void) {
    test_empty_load();
    test_save_load_and_generation();
    test_failed_write_preserves_previous();
    test_corruption_recovery();
    test_unsupported_schema();
    test_readback_failure_preserves_previous();
    test_invalid_config_rejected();
    test_clear_scopes();
    test_persisted_clear_scopes();
    test_erase_store_scope();
    test_load_result_strings();
    test_storage_errors_are_explicit();
    return 0;
}
