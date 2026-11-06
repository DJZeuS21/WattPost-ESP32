#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define WATTPOST_BMS_WRITE_KEY_MAX_LEN 64u

typedef enum {
    WATTPOST_BMS_WRITE_REQUEST_OK = 0,
    WATTPOST_BMS_WRITE_REQUEST_INVALID,
    WATTPOST_BMS_WRITE_REQUEST_UNSUPPORTED,
} wattpost_bms_write_request_result_t;

typedef struct {
    char key[WATTPOST_BMS_WRITE_KEY_MAX_LEN];
    double value;
    double expected_before;
    uint32_t connection_epoch;
} wattpost_bms_write_request_t;

/* Strictly parse one CAS request. Never accept unknown/duplicate fields,
 * coercion of booleans, or an unsupported JK02_32S register.
 */
wattpost_bms_write_request_result_t wattpost_bms_write_request_parse(
    const char *json, size_t length, wattpost_bms_write_request_t *out);
