#pragma once

#include <stdbool.h>
#include <stdint.h>

enum {
    WATTPOST_MDNS_ANNOUNCE_SECONDS = 5 * 60,
};

static inline bool wattpost_mdns_announce_due(uint32_t age_seconds) {
    return age_seconds >= WATTPOST_MDNS_ANNOUNCE_SECONDS;
}
