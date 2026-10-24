#include <assert.h>
#include <stdint.h>

#include "cloud_transport_policy.h"

int main(void) {
    assert(wattpost_cloud_retry_after_failure(0u) ==
           WATTPOST_CLOUD_RETRY_INITIAL_MS);
    assert(wattpost_cloud_retry_after_failure(1000u) ==
           WATTPOST_CLOUD_RETRY_INITIAL_MS);
    assert(wattpost_cloud_retry_after_failure(5000u) == 10000u);
    assert(wattpost_cloud_retry_after_failure(10000u) == 20000u);
    assert(wattpost_cloud_retry_after_failure(30000u) ==
           WATTPOST_CLOUD_RETRY_MAX_MS);
    assert(wattpost_cloud_retry_after_failure(WATTPOST_CLOUD_RETRY_MAX_MS) ==
           WATTPOST_CLOUD_RETRY_MAX_MS);
    assert(wattpost_cloud_retry_after_failure(UINT32_MAX) ==
           WATTPOST_CLOUD_RETRY_MAX_MS);
    assert(wattpost_cloud_retry_after_success() == 0u);
    return 0;
}
