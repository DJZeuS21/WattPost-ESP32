#include <assert.h>
#include <stdint.h>
#include <string.h>

#include "ble_candidate_policy.h"

static void test_rank_prefers_ffe0(void) {
    const uint8_t unrelated[] = "Battery";
    assert(wattpost_bms_candidate_rank(
               true, unrelated, sizeof(unrelated) - 1u) == 2);
}

static void test_rank_accepts_jk_name_without_auto_proof(void) {
    const uint8_t name1[] = "JK-BMS";
    const uint8_t name2[] = "jk_pb2a16s20p";
    const uint8_t other[] = "Solar";

    assert(wattpost_bms_candidate_rank(
               false, name1, sizeof(name1) - 1u) == 1);
    assert(wattpost_bms_candidate_rank(
               false, name2, sizeof(name2) - 1u) == 1);
    assert(wattpost_bms_candidate_rank(
               false, other, sizeof(other) - 1u) == 0);
    assert(wattpost_bms_candidate_rank(false, NULL, 0u) == 0);
}

static void test_safe_name_scrubs_non_printable_bytes(void) {
    const uint8_t raw[] = {'J', 'K', 0x00, 0x7f, '-', 'X'};
    char output[16];
    const size_t length = wattpost_bms_candidate_safe_name(
        raw, sizeof(raw), output, sizeof(output));
    assert(length == sizeof(raw));
    assert(strcmp(output, "JK?" "?-X") == 0);
}

static void test_safe_name_is_bounded_and_has_fallback(void) {
    const uint8_t raw[] = "JK-VERY-LONG-NAME";
    char short_output[5];
    const size_t length = wattpost_bms_candidate_safe_name(
        raw, sizeof(raw) - 1u, short_output, sizeof(short_output));
    assert(length == 4u);
    assert(strcmp(short_output, "JK-V") == 0);

    char fallback[16];
    assert(wattpost_bms_candidate_safe_name(
               NULL, 0u, fallback, sizeof(fallback)) == 6u);
    assert(strcmp(fallback, "JK BMS") == 0);
}

int main(void) {
    test_rank_prefers_ffe0();
    test_rank_accepts_jk_name_without_auto_proof();
    test_safe_name_scrubs_non_printable_bytes();
    test_safe_name_is_bounded_and_has_fallback();
    return 0;
}
