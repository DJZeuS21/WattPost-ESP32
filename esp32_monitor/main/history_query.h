#pragma once

#include <stdbool.h>
#include <stdint.h>

enum {
    WATTPOST_HISTORY_DEFAULT_LIMIT = 144,
    WATTPOST_HISTORY_MAX_LIMIT = 256,
};

typedef enum {
    WATTPOST_HISTORY_LATEST = 0,
    WATTPOST_HISTORY_BEFORE,
    WATTPOST_HISTORY_AFTER,
} wattpost_history_bound_t;

typedef struct {
    uint16_t limit;
    wattpost_history_bound_t bound;
    uint32_t timestamp;
} wattpost_history_query_t;

bool wattpost_history_query_parse(const char *query, wattpost_history_query_t *result);
