#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * Returns 0 for "not a likely JK candidate", 1 for a JK-like local name,
 * and 2 when the advertisement explicitly exposes service UUID 0xFFE0.
 * Ranking never means automatic binding; final selection must be validated.
 */
int wattpost_bms_candidate_rank(
    bool advertises_ffe0,
    const uint8_t *name,
    size_t name_len);

size_t wattpost_bms_candidate_safe_name(
    const uint8_t *name,
    size_t name_len,
    char *output,
    size_t output_size);
