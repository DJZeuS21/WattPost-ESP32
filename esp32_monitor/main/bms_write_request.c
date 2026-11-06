#include "bms_write_request.h"

#include <math.h>
#include <string.h>

#include "cJSON.h"
#include "jk_bms_write_codec.h"

wattpost_bms_write_request_result_t wattpost_bms_write_request_parse(
    const char *json, size_t length, wattpost_bms_write_request_t *out) {
    if (out == NULL || json == NULL || length == 0u || length > 256u) {
        return WATTPOST_BMS_WRITE_REQUEST_INVALID;
    }
    memset(out, 0, sizeof(*out));

    cJSON *root = cJSON_ParseWithLengthOpts(json, length + 1u, NULL, true);
    if (root == NULL || !cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return WATTPOST_BMS_WRITE_REQUEST_INVALID;
    }

    unsigned key_count = 0u;
    unsigned value_count = 0u;
    unsigned previous_count = 0u;
    unsigned epoch_count = 0u;
    bool unknown = false;
    for (const cJSON *item = root->child; item; item = item->next) {
        if (item->string == NULL) {
            unknown = true;
        } else if (strcmp(item->string, "key") == 0) {
            ++key_count;
        } else if (strcmp(item->string, "value") == 0) {
            ++value_count;
        } else if (strcmp(item->string, "expected_before") == 0) {
            ++previous_count;
        } else if (strcmp(item->string, "connection_epoch") == 0) {
            ++epoch_count;
        } else {
            unknown = true;
        }
    }

    const cJSON *key = cJSON_GetObjectItemCaseSensitive(root, "key");
    const cJSON *value = cJSON_GetObjectItemCaseSensitive(root, "value");
    const cJSON *previous =
        cJSON_GetObjectItemCaseSensitive(root, "expected_before");
    const cJSON *epoch =
        cJSON_GetObjectItemCaseSensitive(root, "connection_epoch");
    bool valid =
        !unknown && key_count == 1u && value_count == 1u &&
        previous_count == 1u && epoch_count == 1u &&
        cJSON_IsString(key) && key->valuestring != NULL &&
        strlen(key->valuestring) > 0u &&
        strlen(key->valuestring) < sizeof(out->key) &&
        cJSON_IsNumber(epoch) && isfinite(epoch->valuedouble) &&
        epoch->valuedouble >= 1.0 &&
        epoch->valuedouble <= (double) UINT32_MAX &&
        floor(epoch->valuedouble) == epoch->valuedouble;

    if (!valid) {
        cJSON_Delete(root);
        return WATTPOST_BMS_WRITE_REQUEST_INVALID;
    }
    const jk_bms_write_spec_t *spec = jk_bms_write_find(key->valuestring);
    if (spec == NULL) {
        cJSON_Delete(root);
        return WATTPOST_BMS_WRITE_REQUEST_UNSUPPORTED;
    }
    if (spec->wire_type == JK_BMS_WRITE_BOOLEAN) {
        valid = cJSON_IsBool(value) && cJSON_IsBool(previous);
        if (valid) {
            out->value = cJSON_IsTrue(value) ? 1.0 : 0.0;
            out->expected_before = cJSON_IsTrue(previous) ? 1.0 : 0.0;
        }
    } else {
        valid = cJSON_IsNumber(value) && cJSON_IsNumber(previous);
        if (valid) {
            out->value = value->valuedouble;
            out->expected_before = previous->valuedouble;
        }
    }

    jk_bms_write_command_t command = {0};
    jk_bms_write_command_t expected = {0};
    if (valid) {
        valid =
            jk_bms_write_prepare(key->valuestring, out->value, &command) ==
                JK_BMS_WRITE_OK &&
            jk_bms_write_prepare(
                key->valuestring, out->expected_before, &expected) ==
                JK_BMS_WRITE_OK &&
            command.raw_value != expected.raw_value;
    }
    if (valid) {
        memcpy(out->key, key->valuestring, strlen(key->valuestring) + 1u);
        out->connection_epoch = (uint32_t) epoch->valuedouble;
    }
    cJSON_Delete(root);
    return valid ? WATTPOST_BMS_WRITE_REQUEST_OK
                 : WATTPOST_BMS_WRITE_REQUEST_INVALID;
}
