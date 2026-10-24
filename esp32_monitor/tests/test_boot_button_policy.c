#include <assert.h>
#include <stdbool.h>
#include <stdint.h>

#include "boot_button_policy.h"

int main(void) {
    wattpost_boot_button_state_t state = {0};

    for (unsigned i = 0; i < 199; ++i) {
        assert(wattpost_boot_button_update(
            &state,
            true,
            WATTPOST_BOOT_BUTTON_POLL_MS) == WATTPOST_BOOT_BUTTON_ACTION_NONE);
    }
    assert(state.pressed_ms == 4975u);
    assert(state.tracking_press);

    assert(wattpost_boot_button_update(
        &state,
        false,
        WATTPOST_BOOT_BUTTON_POLL_MS) == WATTPOST_BOOT_BUTTON_ACTION_NONE);
    assert(state.pressed_ms == 0u);
    assert(!state.tracking_press);

    assert(wattpost_boot_button_update(
        &state,
        true,
        WATTPOST_BOOT_RECOVERY_HOLD_MS) == WATTPOST_BOOT_BUTTON_ACTION_NONE);
    assert(wattpost_boot_button_update(
        &state,
        false,
        WATTPOST_BOOT_BUTTON_POLL_MS) == WATTPOST_BOOT_BUTTON_ACTION_RECOVERY);

    assert(wattpost_boot_button_update(
        &state,
        true,
        WATTPOST_BOOT_FACTORY_RESET_HOLD_MS - WATTPOST_BOOT_BUTTON_POLL_MS) ==
        WATTPOST_BOOT_BUTTON_ACTION_NONE);
    assert(wattpost_boot_button_update(
        &state,
        false,
        WATTPOST_BOOT_BUTTON_POLL_MS) == WATTPOST_BOOT_BUTTON_ACTION_RECOVERY);

    assert(wattpost_boot_button_update(
        &state,
        true,
        WATTPOST_BOOT_FACTORY_RESET_HOLD_MS) == WATTPOST_BOOT_BUTTON_ACTION_NONE);
    assert(wattpost_boot_button_update(
        &state,
        false,
        WATTPOST_BOOT_BUTTON_POLL_MS) ==
        WATTPOST_BOOT_BUTTON_ACTION_FACTORY_RESET);

    assert(wattpost_boot_button_update(
        &state,
        false,
        WATTPOST_BOOT_BUTTON_POLL_MS) == WATTPOST_BOOT_BUTTON_ACTION_NONE);
    return 0;
}
