#include "history_query.h"

#include <stddef.h>
#include <stdlib.h>
#include <string.h>

enum {
    HISTORY_QUERY_BUFFER_SIZE = 128,
    HISTORY_MIN_TIMESTAMP = 1700000000,
    HISTORY_MAX_TIMESTAMP = 4102444800,
};

static bool parse_decimal(const char *value, uint32_t minimum, uint32_t maximum,
                          uint32_t *result) {
    if (value == NULL || value[0] == '\0' || result == NULL) {
        return false;
    }
    for (const char *cursor = value; *cursor != '\0'; ++cursor) {
        if (*cursor < '0' || *cursor > '9') {
            return false;
        }
    }
    char *end = NULL;
    const unsigned long parsed = strtoul(value, &end, 10);
    if (end == NULL || *end != '\0' || parsed < minimum || parsed > maximum) {
        return false;
    }
    *result = (uint32_t) parsed;
    return true;
}

bool wattpost_history_query_parse(const char *query, wattpost_history_query_t *result) {
    if (query == NULL || result == NULL) {
        return false;
    }
    const size_t length = strlen(query);
    if (length == 0 || length >= HISTORY_QUERY_BUFFER_SIZE) {
        return false;
    }

    char buffer[HISTORY_QUERY_BUFFER_SIZE];
    memcpy(buffer, query, length + 1);

    wattpost_history_query_t parsed = {
        .limit = WATTPOST_HISTORY_DEFAULT_LIMIT,
        .bound = WATTPOST_HISTORY_LATEST,
        .timestamp = 0,
    };
    bool limit_seen = false;
    bool bound_seen = false;

    char *pair = buffer;
    while (pair != NULL && pair[0] != '\0') {
        char *next = strchr(pair, '&');
        if (next != NULL) {
            *next = '\0';
            ++next;
            if (next[0] == '\0') {
                return false;
            }
        }

        char *separator = strchr(pair, '=');
        if (separator == NULL || separator == pair) {
            return false;
        }
        *separator = '\0';
        const char *value = separator + 1;
        uint32_t number = 0;

        if (strcmp(pair, "limit") == 0) {
            if (limit_seen ||
                !parse_decimal(value, 1, WATTPOST_HISTORY_MAX_LIMIT, &number)) {
                return false;
            }
            parsed.limit = (uint16_t) number;
            limit_seen = true;
        } else if (strcmp(pair, "before") == 0 || strcmp(pair, "after") == 0) {
            if (bound_seen ||
                !parse_decimal(value, HISTORY_MIN_TIMESTAMP, HISTORY_MAX_TIMESTAMP, &number)) {
                return false;
            }
            parsed.bound = strcmp(pair, "before") == 0 ?
                           WATTPOST_HISTORY_BEFORE : WATTPOST_HISTORY_AFTER;
            parsed.timestamp = number;
            bound_seen = true;
        } else {
            return false;
        }
        pair = next;
    }

    *result = parsed;
    return true;
}
