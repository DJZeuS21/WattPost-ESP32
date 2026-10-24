#include "ble_candidate_policy.h"

#include <ctype.h>
#include <string.h>

int wattpost_bms_candidate_rank(
    bool advertises_ffe0,
    const uint8_t *name,
    size_t name_len) {
    if (advertises_ffe0) {
        return 2;
    }
    if (!name || name_len < 2u) {
        return 0;
    }

    const unsigned char first = (unsigned char) name[0];
    const unsigned char second = (unsigned char) name[1];
    return toupper(first) == 'J' && toupper(second) == 'K' ? 1 : 0;
}

size_t wattpost_bms_candidate_safe_name(
    const uint8_t *name,
    size_t name_len,
    char *output,
    size_t output_size) {
    if (!output || output_size == 0u) {
        return 0u;
    }

    output[0] = '\0';
    if (!name || name_len == 0u) {
        const char fallback[] = "JK BMS";
        const size_t copy_len =
            sizeof(fallback) - 1u < output_size - 1u
                ? sizeof(fallback) - 1u
                : output_size - 1u;
        memcpy(output, fallback, copy_len);
        output[copy_len] = '\0';
        return copy_len;
    }

    size_t written = 0u;
    for (size_t i = 0; i < name_len && written + 1u < output_size; ++i) {
        const uint8_t value = name[i];
        output[written++] =
            value >= 0x20u && value <= 0x7eu ? (char) value : '?';
    }
    output[written] = '\0';

    if (written == 0u) {
        return wattpost_bms_candidate_safe_name(
            NULL, 0u, output, output_size);
    }
    return written;
}
