#include "local_api_security.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>

#define WATTPOST_LOCAL_HOST_MAX_LEN 63u

typedef struct {
    char host[WATTPOST_LOCAL_HOST_MAX_LEN + 1u];
} wattpost_parsed_host_t;

static bool parse_http_host(
    const char *value,
    wattpost_parsed_host_t *parsed) {
    if (!value || !parsed) {
        return false;
    }

    const size_t length = strlen(value);
    if (length == 0 || length > WATTPOST_LOCAL_HOST_MAX_LEN + 6u) {
        return false;
    }

    const char *colon = NULL;
    for (size_t i = 0; i < length; ++i) {
        const unsigned char c = (unsigned char) value[i];
        if (isspace(c) || c == '/' || c == '\\' || c == '@' ||
            c == ',' || c == '?' || c == '#') {
            return false;
        }
        if (c == ':') {
            if (colon != NULL) {
                /* Stage 1 local API is IPv4/hostname only. */
                return false;
            }
            colon = &value[i];
        }
    }

    size_t host_length = colon ? (size_t) (colon - value) : length;
    if (host_length == 0 || host_length > WATTPOST_LOCAL_HOST_MAX_LEN) {
        return false;
    }

    if (colon != NULL) {
        const char *port = colon + 1;
        if (*port == '\0') {
            return false;
        }
        unsigned int port_number = 0;
        size_t digits = 0;
        while (*port) {
            if (!isdigit((unsigned char) *port) || digits >= 5u) {
                return false;
            }
            port_number = port_number * 10u + (unsigned int) (*port - '0');
            ++digits;
            ++port;
        }
        if (port_number != 80u) {
            return false;
        }
    }

    if (value[host_length - 1u] == '.') {
        return false;
    }

    for (size_t i = 0; i < host_length; ++i) {
        parsed->host[i] = (char) tolower((unsigned char) value[i]);
    }
    parsed->host[host_length] = '\0';
    return true;
}

static bool host_equals(const char *lhs, const char *rhs) {
    return lhs && rhs && rhs[0] != '\0' && strcasecmp(lhs, rhs) == 0;
}

bool wattpost_local_host_allowed(
    const char *host_header,
    const char *sta_ipv4,
    const char *ap_ipv4) {
    wattpost_parsed_host_t parsed = {0};
    if (!parse_http_host(host_header, &parsed)) {
        return false;
    }

    if (strcmp(parsed.host, "bms.local") == 0) {
        return true;
    }
    if (host_equals(parsed.host, sta_ipv4)) {
        return true;
    }
    if (host_equals(parsed.host, ap_ipv4)) {
        return true;
    }
    return false;
}

bool wattpost_local_origin_matches_host(
    const char *origin,
    const char *host_header) {
    if (!origin || !host_header) {
        return false;
    }

    static const char prefix[] = "http://";
    if (strncasecmp(origin, prefix, sizeof(prefix) - 1u) != 0) {
        return false;
    }

    const char *origin_host = origin + sizeof(prefix) - 1u;
    if (*origin_host == '\0' ||
        strchr(origin_host, '/') != NULL ||
        strchr(origin_host, '?') != NULL ||
        strchr(origin_host, '#') != NULL) {
        return false;
    }

    wattpost_parsed_host_t parsed_origin = {0};
    wattpost_parsed_host_t parsed_host = {0};
    if (!parse_http_host(origin_host, &parsed_origin) ||
        !parse_http_host(host_header, &parsed_host)) {
        return false;
    }

    return strcmp(parsed_origin.host, parsed_host.host) == 0;
}

bool wattpost_local_content_type_is_json(const char *content_type) {
    if (!content_type) {
        return false;
    }

    static const char json_type[] = "application/json";
    const size_t json_len = sizeof(json_type) - 1u;
    if (strncasecmp(content_type, json_type, json_len) != 0) {
        return false;
    }

    const char *tail = content_type + json_len;
    while (*tail && isspace((unsigned char) *tail)) {
        ++tail;
    }
    return *tail == '\0' || *tail == ';';
}

void wattpost_request_token_encode(
    const uint8_t random_bytes[WATTPOST_REQUEST_TOKEN_BYTES],
    char token[WATTPOST_REQUEST_TOKEN_HEX_LEN + 1u]) {
    static const char hex[] = "0123456789abcdef";
    if (!random_bytes || !token) {
        return;
    }

    for (size_t i = 0; i < WATTPOST_REQUEST_TOKEN_BYTES; ++i) {
        token[i * 2u] = hex[(random_bytes[i] >> 4u) & 0x0fu];
        token[i * 2u + 1u] = hex[random_bytes[i] & 0x0fu];
    }
    token[WATTPOST_REQUEST_TOKEN_HEX_LEN] = '\0';
}

bool wattpost_request_token_matches(
    const char *expected_token,
    const char *supplied_token) {
    if (!expected_token || !supplied_token ||
        strlen(expected_token) != WATTPOST_REQUEST_TOKEN_HEX_LEN ||
        strlen(supplied_token) != WATTPOST_REQUEST_TOKEN_HEX_LEN) {
        return false;
    }

    unsigned int diff = 0;
    for (size_t i = 0; i < WATTPOST_REQUEST_TOKEN_HEX_LEN; ++i) {
        diff |= (unsigned int) (
            (unsigned char) expected_token[i] ^
            (unsigned char) supplied_token[i]);
    }
    return diff == 0u;
}

wattpost_local_mutation_auth_result_t wattpost_local_mutation_authorize(
    const char *host_header,
    const char *origin,
    const char *content_type,
    const char *supplied_token,
    const char *expected_token,
    const char *sta_ipv4,
    const char *ap_ipv4) {
    if (!wattpost_local_host_allowed(host_header, sta_ipv4, ap_ipv4)) {
        return WATTPOST_LOCAL_MUTATION_AUTH_HOST;
    }
    if (!wattpost_local_origin_matches_host(origin, host_header)) {
        return WATTPOST_LOCAL_MUTATION_AUTH_ORIGIN;
    }
    if (!wattpost_local_content_type_is_json(content_type)) {
        return WATTPOST_LOCAL_MUTATION_AUTH_CONTENT_TYPE;
    }
    if (!wattpost_request_token_matches(expected_token, supplied_token)) {
        return WATTPOST_LOCAL_MUTATION_AUTH_TOKEN;
    }
    return WATTPOST_LOCAL_MUTATION_AUTH_OK;
}

const char *wattpost_local_mutation_auth_result_str(
    wattpost_local_mutation_auth_result_t result) {
    switch (result) {
        case WATTPOST_LOCAL_MUTATION_AUTH_OK: return "ok";
        case WATTPOST_LOCAL_MUTATION_AUTH_HOST: return "host";
        case WATTPOST_LOCAL_MUTATION_AUTH_ORIGIN: return "origin";
        case WATTPOST_LOCAL_MUTATION_AUTH_CONTENT_TYPE: return "content_type";
        case WATTPOST_LOCAL_MUTATION_AUTH_TOKEN: return "token";
        default: return "unknown";
    }
}
