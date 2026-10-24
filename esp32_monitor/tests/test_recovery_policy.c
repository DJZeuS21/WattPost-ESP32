#include <assert.h>

#include "recovery_policy.h"

int main(void) {
    assert(!wattpost_bms_restart_due(299));
    assert(wattpost_bms_restart_due(300));

    assert(WATTPOST_RECOVERY_SUCCESS_GRACE_SECONDS == 8);
    return 0;
}
