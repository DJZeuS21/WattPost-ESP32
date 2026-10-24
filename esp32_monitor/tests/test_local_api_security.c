#include <assert.h>
#include <stdint.h>
#include <string.h>

#include "local_api_security.h"

static const char *STA_IP = "192.168.1.20";
static const char *AP_IP = "192.168.4.1";
static const char *TOKEN = "00112233445566778899aabbccddeeff";

static void test_host_allowlist(void) {
    assert(wattpost_local_host_allowed("bms.local", STA_IP, AP_IP));
    assert(wattpost_local_host_allowed("BMS.LOCAL:80", STA_IP, AP_IP));
    assert(wattpost_local_host_allowed("192.168.1.20", STA_IP, AP_IP));
    assert(wattpost_local_host_allowed("192.168.4.1:80", STA_IP, AP_IP));

    assert(!wattpost_local_host_allowed("evil.example", STA_IP, AP_IP));
    assert(!wattpost_local_host_allowed("bms.local.evil", STA_IP, AP_IP));
    assert(!wattpost_local_host_allowed("bms.local:8080", STA_IP, AP_IP));
    assert(!wattpost_local_host_allowed("bms.local@evil", STA_IP, AP_IP));
    assert(!wattpost_local_host_allowed("bms.local.", STA_IP, AP_IP));
    assert(!wattpost_local_host_allowed("[::1]", STA_IP, AP_IP));
    assert(!wattpost_local_host_allowed("", STA_IP, AP_IP));
    assert(!wattpost_local_host_allowed(NULL, STA_IP, AP_IP));
}

static void test_origin_matches_host(void) {
    assert(wattpost_local_origin_matches_host(
        "http://bms.local", "bms.local"));
    assert(wattpost_local_origin_matches_host(
        "http://BMS.LOCAL:80", "bms.local"));
    assert(wattpost_local_origin_matches_host(
        "http://192.168.4.1", "192.168.4.1:80"));

    assert(!wattpost_local_origin_matches_host(
        "https://bms.local", "bms.local"));
    assert(!wattpost_local_origin_matches_host(
        "http://evil.example", "bms.local"));
    assert(!wattpost_local_origin_matches_host(
        "http://bms.local.evil", "bms.local"));
    assert(!wattpost_local_origin_matches_host(
        "http://bms.local/path", "bms.local"));
    assert(!wattpost_local_origin_matches_host(
        "null", "bms.local"));
    assert(!wattpost_local_origin_matches_host(
        NULL, "bms.local"));
}

static void test_json_content_type(void) {
    assert(wattpost_local_content_type_is_json("application/json"));
    assert(wattpost_local_content_type_is_json(
        "Application/JSON; charset=utf-8"));
    assert(wattpost_local_content_type_is_json("application/json ; charset=UTF-8"));

    assert(!wattpost_local_content_type_is_json("text/plain"));
    assert(!wattpost_local_content_type_is_json("application/jsonp"));
    assert(!wattpost_local_content_type_is_json(NULL));
}

static void test_request_token_encoding_and_match(void) {
    const uint8_t bytes[WATTPOST_REQUEST_TOKEN_BYTES] = {
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
        0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
    };
    char token[WATTPOST_REQUEST_TOKEN_HEX_LEN + 1] = {0};
    wattpost_request_token_encode(bytes, token);
    assert(strcmp(token, TOKEN) == 0);
    assert(wattpost_request_token_matches(TOKEN, token));
    assert(!wattpost_request_token_matches(
        TOKEN, "00112233445566778899aabbccddeefe"));
    assert(!wattpost_request_token_matches(TOKEN, "short"));
    assert(!wattpost_request_token_matches(NULL, token));
}

static void test_combined_authorization(void) {
    assert(wattpost_local_mutation_authorize(
               "bms.local",
               "http://bms.local",
               "application/json",
               TOKEN,
               TOKEN,
               STA_IP,
               AP_IP) == WATTPOST_LOCAL_MUTATION_AUTH_OK);

    assert(wattpost_local_mutation_authorize(
               "evil.example",
               "http://evil.example",
               "application/json",
               TOKEN,
               TOKEN,
               STA_IP,
               AP_IP) == WATTPOST_LOCAL_MUTATION_AUTH_HOST);

    assert(wattpost_local_mutation_authorize(
               "bms.local",
               "http://evil.example",
               "application/json",
               TOKEN,
               TOKEN,
               STA_IP,
               AP_IP) == WATTPOST_LOCAL_MUTATION_AUTH_ORIGIN);

    assert(wattpost_local_mutation_authorize(
               "bms.local",
               "http://bms.local",
               "text/plain",
               TOKEN,
               TOKEN,
               STA_IP,
               AP_IP) == WATTPOST_LOCAL_MUTATION_AUTH_CONTENT_TYPE);

    assert(wattpost_local_mutation_authorize(
               "bms.local",
               "http://bms.local",
               "application/json",
               "00112233445566778899aabbccddeefe",
               TOKEN,
               STA_IP,
               AP_IP) == WATTPOST_LOCAL_MUTATION_AUTH_TOKEN);
}

static void test_result_strings(void) {
    assert(strcmp(wattpost_local_mutation_auth_result_str(
                      WATTPOST_LOCAL_MUTATION_AUTH_OK), "ok") == 0);
    assert(strcmp(wattpost_local_mutation_auth_result_str(
                      WATTPOST_LOCAL_MUTATION_AUTH_HOST), "host") == 0);
    assert(strcmp(wattpost_local_mutation_auth_result_str(
                      WATTPOST_LOCAL_MUTATION_AUTH_ORIGIN), "origin") == 0);
    assert(strcmp(wattpost_local_mutation_auth_result_str(
                      WATTPOST_LOCAL_MUTATION_AUTH_CONTENT_TYPE),
                  "content_type") == 0);
    assert(strcmp(wattpost_local_mutation_auth_result_str(
                      WATTPOST_LOCAL_MUTATION_AUTH_TOKEN), "token") == 0);
}

int main(void) {
    test_host_allowlist();
    test_origin_matches_host();
    test_json_content_type();
    test_request_token_encoding_and_match();
    test_combined_authorization();
    test_result_strings();
    return 0;
}
