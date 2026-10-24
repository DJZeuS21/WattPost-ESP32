#pragma once

#include <stdbool.h>
#include <stddef.h>

bool wattpost_json_escape(char *dst, size_t capacity, const char *src);
bool wattpost_json_appendf(char *dst, size_t capacity, size_t *used,
                           const char *format, ...);
