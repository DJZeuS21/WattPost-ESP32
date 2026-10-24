#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "captive_dns_protocol.h"

static size_t make_query(
    uint8_t *buffer,
    uint16_t qtype,
    uint16_t qclass) {
    static const uint8_t name[] = {
        7, 'e','x','a','m','p','l','e',
        3, 'c','o','m',
        0,
    };

    memset(buffer, 0, 64);
    buffer[0] = 0x12;
    buffer[1] = 0x34;
    buffer[2] = 0x01; /* recursion desired */
    buffer[5] = 0x01; /* one question */

    size_t cursor = 12;
    memcpy(buffer + cursor, name, sizeof(name));
    cursor += sizeof(name);
    buffer[cursor++] = (uint8_t) (qtype >> 8);
    buffer[cursor++] = (uint8_t) qtype;
    buffer[cursor++] = (uint8_t) (qclass >> 8);
    buffer[cursor++] = (uint8_t) qclass;
    return cursor;
}

static void test_a_query_redirects_to_ap(void) {
    uint8_t request[64];
    const size_t request_len = make_query(request, 1, 1);
    uint8_t response[128];
    const uint8_t ip[4] = {192, 168, 4, 1};

    const int len = wattpost_captive_dns_build_response(
        request, request_len, response, sizeof(response), ip);
    assert(len == (int) request_len + 16);
    assert(response[0] == 0x12 && response[1] == 0x34);
    assert((response[2] & 0x80) != 0);
    assert((response[2] & 0x01) != 0);
    assert(response[5] == 1);
    assert(response[7] == 1);
    assert(response[8] == 0 && response[9] == 0);
    assert(response[10] == 0 && response[11] == 0);

    const size_t answer = request_len;
    assert(response[answer] == 0xc0);
    assert(response[answer + 1] == 0x0c);
    assert(response[answer + 2] == 0 && response[answer + 3] == 1);
    assert(response[answer + 10] == 0 && response[answer + 11] == 4);
    assert(memcmp(response + answer + 12, ip, sizeof(ip)) == 0);
}

static void test_aaaa_query_returns_no_data(void) {
    uint8_t request[64];
    const size_t request_len = make_query(request, 28, 1);
    uint8_t response[128];
    const uint8_t ip[4] = {192, 168, 4, 1};

    const int len = wattpost_captive_dns_build_response(
        request, request_len, response, sizeof(response), ip);
    assert(len == (int) request_len);
    assert(response[7] == 0);
}

static void test_malformed_packets_are_rejected(void) {
    uint8_t request[64] = {0};
    uint8_t response[128] = {0};
    const uint8_t ip[4] = {192, 168, 4, 1};

    assert(wattpost_captive_dns_build_response(
               request, 5, response, sizeof(response), ip) == -1);

    const size_t request_len = make_query(request, 1, 1);
    request[12] = 0xc0; /* compressed pointer not accepted in QNAME */
    assert(wattpost_captive_dns_build_response(
               request, request_len, response, sizeof(response), ip) == -1);

    make_query(request, 1, 1);
    request[5] = 2; /* more than one question */
    assert(wattpost_captive_dns_build_response(
               request, request_len, response, sizeof(response), ip) == 0);
}

static void test_response_capacity_is_enforced(void) {
    uint8_t request[64];
    const size_t request_len = make_query(request, 1, 1);
    uint8_t response[32];
    const uint8_t ip[4] = {192, 168, 4, 1};

    assert(wattpost_captive_dns_build_response(
               request,
               request_len,
               response,
               request_len,
               ip) == -1);
}

int main(void) {
    test_a_query_redirects_to_ap();
    test_aaaa_query_returns_no_data();
    test_malformed_packets_are_rejected();
    test_response_capacity_is_enforced();
    return 0;
}
