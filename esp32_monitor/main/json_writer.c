#include "json_writer.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

bool wattpost_json_escape(char *dst, size_t capacity, const char *src) {
    if (dst == NULL || capacity == 0 || src == NULL) {
        return false;
    }

    size_t used = 0;
    for (const unsigned char *input = (const unsigned char *) src; *input != '\0'; ++input) {
        char encoded[7];
        const char *piece = encoded;
        size_t length;
        switch (*input) {
            case '"': piece = "\\\""; length = 2; break;
            case '\\': piece = "\\\\"; length = 2; break;
            case '\b': piece = "\\b"; length = 2; break;
            case '\f': piece = "\\f"; length = 2; break;
            case '\n': piece = "\\n"; length = 2; break;
            case '\r': piece = "\\r"; length = 2; break;
            case '\t': piece = "\\t"; length = 2; break;
            default:
                if (*input < 0x20) {
                    snprintf(encoded, sizeof(encoded), "\\u%04x", *input);
                    length = 6;
                } else {
                    encoded[0] = (char) *input;
                    length = 1;
                }
                break;
        }
        if (length >= capacity - used) {
            dst[0] = '\0';
            return false;
        }
        memcpy(dst + used, piece, length);
        used += length;
    }
    dst[used] = '\0';
    return true;
}

bool wattpost_json_appendf(char *dst, size_t capacity, size_t *used,
                           const char *format, ...) {
    if (dst == NULL || used == NULL || format == NULL || *used >= capacity) {
        return false;
    }

    va_list args;
    va_start(args, format);
    const int written = vsnprintf(dst + *used, capacity - *used, format, args);
    va_end(args);
    if (written < 0 || (size_t) written >= capacity - *used) {
        return false;
    }
    *used += (size_t) written;
    return true;
}
