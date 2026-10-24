#pragma once

#include <stdbool.h>
#include <stdint.h>

enum {
    WATTPOST_BMS_RESTART_SECONDS = 5 * 60,
    WATTPOST_RECOVERY_SUCCESS_GRACE_SECONDS = 8,
};

static inline bool wattpost_bms_restart_due(uint32_t down_seconds) {
    return down_seconds >= WATTPOST_BMS_RESTART_SECONDS;
}
