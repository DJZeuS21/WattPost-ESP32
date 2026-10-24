#include "cloud_transport_policy.h"

uint32_t wattpost_cloud_retry_after_failure(uint32_t previous_backoff_ms) {
    if (previous_backoff_ms < WATTPOST_CLOUD_RETRY_INITIAL_MS) {
        return WATTPOST_CLOUD_RETRY_INITIAL_MS;
    }
    if (previous_backoff_ms >= WATTPOST_CLOUD_RETRY_MAX_MS) {
        return WATTPOST_CLOUD_RETRY_MAX_MS;
    }

    uint32_t next = previous_backoff_ms * 2u;
    if (next < previous_backoff_ms || next > WATTPOST_CLOUD_RETRY_MAX_MS) {
        next = WATTPOST_CLOUD_RETRY_MAX_MS;
    }
    return next;
}

uint32_t wattpost_cloud_retry_after_success(void) {
    return 0u;
}
