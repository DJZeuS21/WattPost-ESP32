#pragma once

#include <stddef.h>
#include <stdint.h>

/*
 * Build a captive-portal DNS response.
 * Returns response length, 0 for a syntactically valid unsupported query,
 * or -1 for malformed/oversized input.
 */
int wattpost_captive_dns_build_response(
    const uint8_t *request,
    size_t request_length,
    uint8_t *response,
    size_t response_capacity,
    const uint8_t ap_ipv4[4]);
