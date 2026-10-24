#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "device_identity.h"
#include "nvs.h"

#define MOCK_RECORD_MAX 128

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
} failure_t;

static bool namespace_exists;
static mock_blob_t persisted_a;
static mock_blob_t persisted_b;
static mock_blob_t pending_a;
static mock_blob_t pending_b;
static failure_t failure;
static bool commit_happened;
static unsigned commit_calls;
static unsigned fail_commit_call;
static unsigned random_calls;
static bool random_returns_zero;
static char last_namespace[32];

static void reset_mock(void) {
    namespace_exists = false;
    memset(&persisted_a, 0, sizeof(persisted_a));
    memset(&persisted_b, 0, sizeof(persisted_b));
    memset(&pending_a, 0, sizeof(pending_a));
    memset(&pending_b, 0, sizeof(pending_b));
    failure = FAIL_NONE;
    commit_happened = false;
    commit_calls = 0;
    fail_commit_call = 0;
    random_calls = 0;
    random_returns_zero = false;
    memset(last_namespace, 0, sizeof(last_namespace));
}

static mock_blob_t *blob_for_key(const char *key, bool pending) {
    if (strcmp(key, "id_a") == 0) {
        return pending ? &pending_a : &persisted_a;
    }
    if (strcmp(key, "id_b") == 0) {
        return pending ? &pending_b : &persisted_b;
    }
    return NULL;
}

esp_err_t nvs_open(const char *namespace_name, nvs_open_mode_t open_mode,
                   nvs_handle_t *out_handle) {
    strncpy(last_namespace, namespace_name, sizeof(last_namespace) - 1);
    if (failure == FAIL_OPEN) {
        return ESP_FAIL;
    }
    if (strcmp(namespace_name, "wp_identity") != 0) {
        return ESP_FAIL;
    }
    if (open_mode == NVS_READONLY && !namespace_exists) {
        return ESP_ERR_NVS_NOT_FOUND;
    }
    *out_handle = 1;
    return ESP_OK;
}

esp_err_t nvs_get_blob(nvs_handle_t handle, const char *key, void *out_value,
                       size_t *length) {
    (void)handle;
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
    (void)handle;
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

esp_err_t nvs_commit(nvs_handle_t handle) {
    (void)handle;
    ++commit_calls;
    if (failure == FAIL_COMMIT ||
        (fail_commit_call != 0 && commit_calls == fail_commit_call)) {
        return ESP_FAIL;
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
    (void)handle;
    memset(&pending_a, 0, sizeof(pending_a));
    memset(&pending_b, 0, sizeof(pending_b));
}

esp_err_t nvs_get_u8(nvs_handle_t handle, const char *key, uint8_t *out_value) {
    (void)handle;
    (void)key;
    (void)out_value;
    return ESP_FAIL;
}

esp_err_t nvs_set_u8(nvs_handle_t handle, const char *key, uint8_t value) {
    (void)handle;
    (void)key;
    (void)value;
    return ESP_FAIL;
}

esp_err_t nvs_erase_key(nvs_handle_t handle, const char *key) {
    (void)handle;
    (void)key;
    return ESP_FAIL;
}

esp_err_t nvs_get_str(nvs_handle_t handle, const char *key, char *out_value,
                      size_t *length) {
    (void)handle;
    (void)key;
    (void)out_value;
    (void)length;
    return ESP_FAIL;
}

esp_err_t nvs_erase_all(nvs_handle_t handle) {
    (void)handle;
    return ESP_FAIL;
}

bool wattpost_device_identity_random_fill(void *buffer, size_t length) {
    ++random_calls;
    if (!buffer || length == 0) {
        return false;
    }
    if (random_returns_zero) {
        memset(buffer, 0, length);
        return true;
    }

    uint8_t *bytes = buffer;
    for (size_t i = 0; i < length; ++i) {
        bytes[i] = (uint8_t)(0x31u + (uint8_t)(i * 17u));
    }
    return true;
}

static bool identity_equal(const wattpost_device_identity_t *a,
                           const wattpost_device_identity_t *b) {
    return a->ownership_epoch == b->ownership_epoch &&
           memcmp(a->device_id, b->device_id, sizeof(a->device_id)) == 0 &&
           memcmp(a->device_secret, b->device_secret,
                  sizeof(a->device_secret)) == 0;
}

static void test_first_init_creates_stable_identity(void) {
    reset_mock();

    wattpost_device_identity_t first;
    assert(wattpost_device_identity_init(&first) == WATTPOST_IDENTITY_CREATED);
    assert(random_calls == 1);
    assert(first.ownership_epoch == WATTPOST_OWNERSHIP_EPOCH_INITIAL);
    assert(persisted_a.present);
    assert(persisted_b.present);
    assert(strcmp(last_namespace, "wp_identity") == 0);

    wattpost_device_identity_t second;
    assert(wattpost_device_identity_init(&second) == WATTPOST_IDENTITY_OK);
    assert(random_calls == 1);
    assert(identity_equal(&first, &second));
}

static void test_epoch_advance_preserves_hardware_identity(void) {
    reset_mock();

    wattpost_device_identity_t original;
    assert(wattpost_device_identity_init(&original) == WATTPOST_IDENTITY_CREATED);

    commit_happened = false;
    wattpost_device_identity_t advanced;
    assert(wattpost_device_identity_advance_ownership_epoch(&advanced));
    assert(advanced.ownership_epoch == original.ownership_epoch + 1u);
    assert(memcmp(advanced.device_id, original.device_id,
                  sizeof(original.device_id)) == 0);
    assert(memcmp(advanced.device_secret, original.device_secret,
                  sizeof(original.device_secret)) == 0);
    assert(persisted_a.present && persisted_b.present);

    wattpost_device_identity_t loaded;
    assert(wattpost_device_identity_load(&loaded) == WATTPOST_IDENTITY_OK);
    assert(identity_equal(&advanced, &loaded));
    assert(random_calls == 1);
}

static void test_failed_epoch_write_preserves_previous_identity(void) {
    reset_mock();

    wattpost_device_identity_t original;
    assert(wattpost_device_identity_init(&original) == WATTPOST_IDENTITY_CREATED);

    commit_happened = false;
    failure = FAIL_SET;
    wattpost_device_identity_t ignored;
    assert(!wattpost_device_identity_advance_ownership_epoch(&ignored));
    failure = FAIL_NONE;

    wattpost_device_identity_t loaded;
    assert(wattpost_device_identity_load(&loaded) == WATTPOST_IDENTITY_OK);
    assert(identity_equal(&original, &loaded));

    commit_happened = false;
    failure = FAIL_COMMIT;
    assert(!wattpost_device_identity_advance_ownership_epoch(&ignored));
    failure = FAIL_NONE;
    assert(wattpost_device_identity_load(&loaded) == WATTPOST_IDENTITY_OK);
    assert(identity_equal(&original, &loaded));
}

static void test_partial_epoch_mirror_recovers_monotonic_value(void) {
    reset_mock();

    wattpost_device_identity_t original;
    assert(wattpost_device_identity_init(&original) == WATTPOST_IDENTITY_CREATED);
    assert(commit_calls == 2u);

    /*
     * First copy of epoch 2 commits, second redundant copy fails. The reset
     * caller receives failure, but the next boot must never roll back to epoch 1.
     */
    fail_commit_call = 4u;
    wattpost_device_identity_t ignored;
    assert(!wattpost_device_identity_advance_ownership_epoch(&ignored));

    wattpost_device_identity_t recovered;
    assert(wattpost_device_identity_load(&recovered) ==
           WATTPOST_IDENTITY_RECOVERED);
    assert(recovered.ownership_epoch == 2u);
    assert(memcmp(recovered.device_id, original.device_id,
                  sizeof(original.device_id)) == 0);

    wattpost_device_identity_t repaired;
    assert(wattpost_device_identity_init(&repaired) ==
           WATTPOST_IDENTITY_RECOVERED);
    assert(repaired.ownership_epoch == 2u);

    wattpost_device_identity_t loaded;
    assert(wattpost_device_identity_load(&loaded) == WATTPOST_IDENTITY_OK);
    assert(identity_equal(&repaired, &loaded));
}

static void test_corrupt_identity_is_never_silently_regenerated(void) {
    reset_mock();

    wattpost_device_identity_t original;
    assert(wattpost_device_identity_init(&original) == WATTPOST_IDENTITY_CREATED);
    assert(random_calls == 1);

    persisted_a.data[20] ^= 0x5Au;
    persisted_b.data[21] ^= 0x33u;
    wattpost_device_identity_t loaded;
    assert(wattpost_device_identity_load(&loaded) == WATTPOST_IDENTITY_CORRUPT);
    assert(wattpost_device_identity_init(&loaded) == WATTPOST_IDENTITY_CORRUPT);
    assert(random_calls == 1);
}

static void test_redundant_slot_recovers_without_epoch_rollback(void) {
    reset_mock();

    wattpost_device_identity_t first;
    assert(wattpost_device_identity_init(&first) == WATTPOST_IDENTITY_CREATED);

    wattpost_device_identity_t second;
    assert(wattpost_device_identity_advance_ownership_epoch(&second));
    assert(second.ownership_epoch == 2u);

    /* Both slots now carry epoch 2. Corrupt the newest storage generation. */
    persisted_b.data[40] ^= 0x23u;

    wattpost_device_identity_t recovered;
    assert(wattpost_device_identity_load(&recovered) ==
           WATTPOST_IDENTITY_RECOVERED);
    assert(recovered.ownership_epoch == 2u);
    assert(memcmp(recovered.device_id, first.device_id,
                  sizeof(first.device_id)) == 0);

    /* Early-boot init repairs the redundant slot without changing identity. */
    wattpost_device_identity_t repaired;
    assert(wattpost_device_identity_init(&repaired) ==
           WATTPOST_IDENTITY_RECOVERED);
    assert(repaired.ownership_epoch == 2u);
    assert(memcmp(repaired.device_id, first.device_id,
                  sizeof(first.device_id)) == 0);

    wattpost_device_identity_t loaded;
    assert(wattpost_device_identity_load(&loaded) == WATTPOST_IDENTITY_OK);
    assert(identity_equal(&repaired, &loaded));
    assert(random_calls == 1);
}

static void test_unsupported_schema_is_not_overwritten(void) {
    reset_mock();

    wattpost_device_identity_t identity;
    assert(wattpost_device_identity_init(&identity) == WATTPOST_IDENTITY_CREATED);

    persisted_a.data[4] = 99u;
    persisted_a.data[5] = 0u;

    wattpost_device_identity_t loaded;
    assert(wattpost_device_identity_load(&loaded) ==
           WATTPOST_IDENTITY_UNSUPPORTED);
    assert(wattpost_device_identity_init(&loaded) ==
           WATTPOST_IDENTITY_UNSUPPORTED);
    assert(random_calls == 1);
    assert(persisted_a.data[4] == 99u);
}

static void test_invalid_random_material_is_rejected(void) {
    reset_mock();
    random_returns_zero = true;

    wattpost_device_identity_t identity;
    assert(wattpost_device_identity_init(&identity) ==
           WATTPOST_IDENTITY_RANDOM_ERROR);
    assert(random_calls == 1);
    assert(!persisted_a.present && !persisted_b.present);
}

static void test_storage_errors_are_explicit(void) {
    reset_mock();
    failure = FAIL_OPEN;

    wattpost_device_identity_t identity;
    assert(wattpost_device_identity_init(&identity) ==
           WATTPOST_IDENTITY_STORAGE_ERROR);

    reset_mock();
    assert(wattpost_device_identity_init(&identity) == WATTPOST_IDENTITY_CREATED);
    commit_happened = true;
    failure = FAIL_READBACK;
    assert(wattpost_device_identity_load(&identity) ==
           WATTPOST_IDENTITY_STORAGE_ERROR);
}

static void test_result_strings(void) {
    assert(strcmp(wattpost_device_identity_result_str(WATTPOST_IDENTITY_OK),
                  "ok") == 0);
    assert(strcmp(wattpost_device_identity_result_str(WATTPOST_IDENTITY_CREATED),
                  "created") == 0);
    assert(strcmp(wattpost_device_identity_result_str(WATTPOST_IDENTITY_EMPTY),
                  "empty") == 0);
    assert(strcmp(wattpost_device_identity_result_str(WATTPOST_IDENTITY_RECOVERED),
                  "recovered") == 0);
    assert(strcmp(wattpost_device_identity_result_str(WATTPOST_IDENTITY_CORRUPT),
                  "corrupt") == 0);
    assert(strcmp(wattpost_device_identity_result_str(WATTPOST_IDENTITY_UNSUPPORTED),
                  "unsupported") == 0);
    assert(strcmp(wattpost_device_identity_result_str(WATTPOST_IDENTITY_STORAGE_ERROR),
                  "storage_error") == 0);
    assert(strcmp(wattpost_device_identity_result_str(WATTPOST_IDENTITY_RANDOM_ERROR),
                  "random_error") == 0);
}

int main(void) {
    test_first_init_creates_stable_identity();
    test_epoch_advance_preserves_hardware_identity();
    test_failed_epoch_write_preserves_previous_identity();
    test_partial_epoch_mirror_recovers_monotonic_value();
    test_corrupt_identity_is_never_silently_regenerated();
    test_redundant_slot_recovers_without_epoch_rollback();
    test_unsupported_schema_is_not_overwritten();
    test_invalid_random_material_is_rejected();
    test_storage_errors_are_explicit();
    test_result_strings();
    return 0;
}
