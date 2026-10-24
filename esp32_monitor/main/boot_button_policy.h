#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum {
    WATTPOST_BOOT_BUTTON_POLL_MS = 25,
    WATTPOST_BOOT_RECOVERY_HOLD_MS = 5000,
    WATTPOST_BOOT_FACTORY_RESET_HOLD_MS = 15000,
};

typedef enum {
    WATTPOST_BOOT_BUTTON_ACTION_NONE = 0,
    WATTPOST_BOOT_BUTTON_ACTION_RECOVERY,
    WATTPOST_BOOT_BUTTON_ACTION_FACTORY_RESET,
} wattpost_boot_button_action_t;

typedef struct {
    uint32_t pressed_ms;
    bool tracking_press;
} wattpost_boot_button_state_t;

static inline wattpost_boot_button_action_t wattpost_boot_button_update(
    wattpost_boot_button_state_t *state,
    bool pressed,
    uint32_t elapsed_ms) {
    if (state == NULL) {
        return WATTPOST_BOOT_BUTTON_ACTION_NONE;
    }

    if (pressed) {
        state->tracking_press = true;
        if (UINT32_MAX - state->pressed_ms < elapsed_ms) {
            state->pressed_ms = UINT32_MAX;
        } else {
            state->pressed_ms += elapsed_ms;
        }
        return WATTPOST_BOOT_BUTTON_ACTION_NONE;
    }

    if (!state->tracking_press) {
        state->pressed_ms = 0u;
        return WATTPOST_BOOT_BUTTON_ACTION_NONE;
    }

    const uint32_t held_ms = state->pressed_ms;
    state->pressed_ms = 0u;
    state->tracking_press = false;

    if (held_ms >= WATTPOST_BOOT_FACTORY_RESET_HOLD_MS) {
        return WATTPOST_BOOT_BUTTON_ACTION_FACTORY_RESET;
    }
    if (held_ms >= WATTPOST_BOOT_RECOVERY_HOLD_MS) {
        return WATTPOST_BOOT_BUTTON_ACTION_RECOVERY;
    }
    return WATTPOST_BOOT_BUTTON_ACTION_NONE;
}
