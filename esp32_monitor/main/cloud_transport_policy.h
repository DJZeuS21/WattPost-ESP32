#pragma once

#include <stdint.h>

#define WATTPOST_CLOUD_RETRY_INITIAL_MS 5000u
#define WATTPOST_CLOUD_RETRY_MAX_MS 60000u
#define WATTPOST_CLOUD_HELLO_INTERVAL_MS 15000u

uint32_t wattpost_cloud_retry_after_failure(uint32_t previous_backoff_ms);
uint32_t wattpost_cloud_retry_after_success(void);
