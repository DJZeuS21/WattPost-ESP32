#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "jk_bms_parser.h"

#define WATTPOST_SETTINGS_JSON_MAX_LEN 3072u

typedef struct {
    bool valid;
    const jk_bms_settings_t *settings;
    const jk_bms_device_info_t *device_info;
    const jk_bms_data_t *live_data;
    const char *protocol_family;
    const char *chemistry;
} wattpost_settings_json_input_t;

/* Formats the canonical local /api/settings response into caller-owned memory. */
bool wattpost_settings_format_json(
    const wattpost_settings_json_input_t *input,
    char *output,
    size_t output_capacity);
