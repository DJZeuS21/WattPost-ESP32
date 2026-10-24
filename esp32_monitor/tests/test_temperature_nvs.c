#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "nvs.h"
#include "temperature_profiles.h"

typedef enum {
    FAIL_NONE,
    FAIL_OPEN,
    FAIL_FIRST_SET,
    FAIL_SECOND_SET,
    FAIL_FIRST_ERASE,
    FAIL_SECOND_ERASE,
    FAIL_COMMIT,
} failure_t;

static failure_t failure;
static unsigned set_calls;
static unsigned erase_calls;
static uint8_t pending_mode;
static uint8_t pending_mask;
static bool erased_mode;
static bool erased_mask;

esp_err_t nvs_open(const char *namespace_name, nvs_open_mode_t open_mode,
                   nvs_handle_t *out_handle) {
    assert(strcmp(namespace_name, "wattpost") == 0);
    (void) open_mode;
    if (failure == FAIL_OPEN) return ESP_FAIL;
    *out_handle = 1;
    set_calls = 0;
    erase_calls = 0;
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
    ++set_calls;
    if ((failure == FAIL_FIRST_SET && set_calls == 1) ||
        (failure == FAIL_SECOND_SET && set_calls == 2)) {
        return ESP_FAIL;
    }
    if (strcmp(key, "temp_mode") == 0) pending_mode = value;
    if (strcmp(key, "temp_mask") == 0) pending_mask = value;
    return ESP_OK;
}

esp_err_t nvs_erase_key(nvs_handle_t handle, const char *key) {
    (void) handle;
    ++erase_calls;
    if ((failure == FAIL_FIRST_ERASE && erase_calls == 1) ||
        (failure == FAIL_SECOND_ERASE && erase_calls == 2)) {
        return ESP_FAIL;
    }
    if (strcmp(key, "temp_mode") == 0) erased_mode = true;
    if (strcmp(key, "temp_mask") == 0) erased_mask = true;
    return ESP_OK;
}

esp_err_t nvs_commit(nvs_handle_t handle) {
    (void) handle;
    return failure == FAIL_COMMIT ? ESP_FAIL : ESP_OK;
}

void nvs_close(nvs_handle_t handle) {
    (void) handle;
}

static void assert_config(temp_detection_mode_t expected_mode, int8_t expected_mask) {
    temp_detection_mode_t mode;
    int8_t mask;
    temperature_config_get(&mode, &mask);
    assert(mode == expected_mode);
    assert(mask == expected_mask);
}

int main(void) {
    failure = FAIL_NONE;
    assert(temperature_config_set_mode(TEMP_MODE_MANUAL, 7));
    assert(pending_mode == 1 && pending_mask == 7);
    assert_config(TEMP_MODE_MANUAL, 7);

    const failure_t set_failures[] = {
        FAIL_OPEN,
        FAIL_FIRST_SET,
        FAIL_SECOND_SET,
        FAIL_COMMIT,
    };
    for (size_t i = 0; i < sizeof(set_failures) / sizeof(set_failures[0]); ++i) {
        failure = set_failures[i];
        assert(!temperature_config_set_mode(TEMP_MODE_AUTO, -1));
        assert_config(TEMP_MODE_MANUAL, 7);
    }

    failure = FAIL_NONE;
    assert(temperature_config_set_mode(TEMP_MODE_MANUAL, 11));
    assert_config(TEMP_MODE_MANUAL, 11);

    const failure_t reset_failures[] = {
        FAIL_OPEN,
        FAIL_FIRST_ERASE,
        FAIL_SECOND_ERASE,
        FAIL_COMMIT,
    };
    for (size_t i = 0; i < sizeof(reset_failures) / sizeof(reset_failures[0]); ++i) {
        failure = reset_failures[i];
        erased_mode = false;
        erased_mask = false;
        assert(!temperature_config_reset());
        assert_config(TEMP_MODE_MANUAL, 11);
    }

    failure = FAIL_NONE;
    erased_mode = false;
    erased_mask = false;
    assert(temperature_config_reset());
    assert(erased_mode);
    assert(erased_mask);
    assert_config(TEMP_MODE_AUTO, -1);
    return 0;
}
