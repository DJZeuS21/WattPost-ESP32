#include "captive_dns_protocol.h"

#include <stdbool.h>
#include <string.h>

#define DNS_HEADER_LEN 12u
#define DNS_TYPE_A 1u
#define DNS_CLASS_IN 1u
#define DNS_ANSWER_LEN 16u
#define DNS_TTL_SECONDS 30u

static uint16_t read_u16_be(const uint8_t *p) {
    return (uint16_t) (((uint16_t) p[0] << 8u) | p[1]);
}

static void write_u16_be(uint8_t *p, uint16_t value) {
    p[0] = (uint8_t) (value >> 8u);
    p[1] = (uint8_t) value;
}

static void write_u32_be(uint8_t *p, uint32_t value) {
    p[0] = (uint8_t) (value >> 24u);
    p[1] = (uint8_t) (value >> 16u);
    p[2] = (uint8_t) (value >> 8u);
    p[3] = (uint8_t) value;
}

int wattpost_captive_dns_build_response(
    const uint8_t *request,
    size_t request_length,
    uint8_t *response,
    size_t response_capacity,
    const uint8_t ap_ipv4[4]) {
    if (!request || !response || !ap_ipv4 ||
        request_length < DNS_HEADER_LEN ||
        response_capacity < DNS_HEADER_LEN) {
        return -1;
    }

    /* Standard query only, not a response, exactly one question. */
    if ((request[2] & 0x80u) != 0u ||
        (request[2] & 0x78u) != 0u ||
        read_u16_be(request + 4u) != 1u) {
        return 0;
    }

    size_t cursor = DNS_HEADER_LEN;
    while (true) {
        if (cursor >= request_length) {
            return -1;
        }
        const uint8_t label_len = request[cursor++];
        if (label_len == 0u) {
            break;
        }
        if (label_len > 63u ||
            (label_len & 0xc0u) != 0u ||
            cursor + label_len > request_length) {
            return -1;
        }
        cursor += label_len;
    }

    if (cursor + 4u > request_length) {
        return -1;
    }
    const uint16_t qtype = read_u16_be(request + cursor);
    const uint16_t qclass = read_u16_be(request + cursor + 2u);
    const size_t question_end = cursor + 4u;

    const bool answer_a =
        qtype == DNS_TYPE_A && qclass == DNS_CLASS_IN;
    const size_t response_length =
        question_end + (answer_a ? DNS_ANSWER_LEN : 0u);
    if (response_length > response_capacity) {
        return -1;
    }

    memset(response, 0, response_capacity);
    memcpy(response, request, question_end);

    /* QR=1, preserve RD. This captive responder is not recursive. */
    response[2] = (uint8_t) (0x80u | (request[2] & 0x01u));
    response[3] = 0x00u;
    write_u16_be(response + 4u, 1u);
    write_u16_be(response + 6u, answer_a ? 1u : 0u);
    write_u16_be(response + 8u, 0u);
    write_u16_be(response + 10u, 0u);

    if (!answer_a) {
        return (int) response_length;
    }

    uint8_t *answer = response + question_end;
    /* Compression pointer to QNAME at offset 12. */
    answer[0] = 0xc0u;
    answer[1] = 0x0cu;
    write_u16_be(answer + 2u, DNS_TYPE_A);
    write_u16_be(answer + 4u, DNS_CLASS_IN);
    write_u32_be(answer + 6u, DNS_TTL_SECONDS);
    write_u16_be(answer + 10u, 4u);
    memcpy(answer + 12u, ap_ipv4, 4u);

    return (int) response_length;
}
