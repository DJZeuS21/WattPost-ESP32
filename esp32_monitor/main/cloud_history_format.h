#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "history.h"

#define WATTPOST_CLOUD_HISTORY_MAX_RECORDS 12u
#define WATTPOST_CLOUD_HISTORY_JSON_MAX_LEN 4096u

typedef struct {
    char *json;
    size_t capacity;
    size_t used;
    uint32_t last_timestamp;
    uint16_t count;
    bool failed;
    bool finished;
} wattpost_cloud_history_formatter_t;

bool wattpost_cloud_history_format_init(
    wattpost_cloud_history_formatter_t *formatter,
    char *json,
    size_t capacity);

bool wattpost_cloud_history_format_append(
    wattpost_cloud_history_formatter_t *formatter,
    const wattpost_history_record_t *record);

bool wattpost_cloud_history_format_finish(
    wattpost_cloud_history_formatter_t *formatter);
