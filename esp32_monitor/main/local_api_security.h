#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define WATTPOST_REQUEST_TOKEN_BYTES 16u
#define WATTPOST_REQUEST_TOKEN_HEX_LEN (WATTPOST_REQUEST_TOKEN_BYTES * 2u)

typedef enum {
    WATTPOST_LOCAL_MUTATION_AUTH_OK = 0,
    WATTPOST_LOCAL_MUTATION_AUTH_HOST,
    WATTPOST_LOCAL_MUTATION_AUTH_ORIGIN,
    WATTPOST_LOCAL_MUTATION_AUTH_CONTENT_TYPE,
    WATTPOST_LOCAL_MUTATION_AUTH_TOKEN,
} wattpost_local_mutation_auth_result_t;

bool wattpost_local_host_allowed(
    const char *host_header,
    const char *sta_ipv4,
    const char *ap_ipv4);

bool wattpost_local_origin_matches_host(
    const char *origin,
    const char *host_header);

bool wattpost_local_content_type_is_json(const char *content_type);

void wattpost_request_token_encode(
    const uint8_t random_bytes[WATTPOST_REQUEST_TOKEN_BYTES],
    char token[WATTPOST_REQUEST_TOKEN_HEX_LEN + 1u]);

bool wattpost_request_token_matches(
    const char *expected_token,
    const char *supplied_token);

wattpost_local_mutation_auth_result_t wattpost_local_mutation_authorize(
    const char *host_header,
    const char *origin,
    const char *content_type,
    const char *supplied_token,
    const char *expected_token,
    const char *sta_ipv4,
    const char *ap_ipv4);

const char *wattpost_local_mutation_auth_result_str(
    wattpost_local_mutation_auth_result_t result);
