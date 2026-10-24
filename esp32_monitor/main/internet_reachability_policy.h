#pragma once

#include <stdbool.h>

typedef enum {
    WATTPOST_INTERNET_UNKNOWN = 0,
    WATTPOST_INTERNET_REACHABLE,
    WATTPOST_INTERNET_UNREACHABLE,
} wattpost_internet_state_t;

static inline wattpost_internet_state_t wattpost_internet_probe_result(
    bool request_completed,
    int http_status) {
    return request_completed && http_status == 204
        ? WATTPOST_INTERNET_REACHABLE
        : WATTPOST_INTERNET_UNREACHABLE;
}

static inline const char *wattpost_internet_state_str(
    wattpost_internet_state_t state) {
    switch (state) {
        case WATTPOST_INTERNET_REACHABLE: return "reachable";
        case WATTPOST_INTERNET_UNREACHABLE: return "unreachable";
        case WATTPOST_INTERNET_UNKNOWN:
        default:
            return "unknown";
    }
}
