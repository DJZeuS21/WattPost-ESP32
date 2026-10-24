#pragma once

#include <stdbool.h>
#include <stddef.h>

/*
 * Platform entropy hook used only for first-time identity creation.
 * The ESP32 implementation enables the documented early-boot entropy source.
 * Host tests provide a deterministic implementation.
 */
bool wattpost_device_identity_random_fill(void *buffer, size_t length);
