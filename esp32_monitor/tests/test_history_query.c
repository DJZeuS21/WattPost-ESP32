#include <assert.h>
#include <stdint.h>
#include <stdio.h>

#include "history_query.h"

static void assert_parse(const char *query, uint16_t limit,
                         wattpost_history_bound_t bound, uint32_t timestamp) {
    wattpost_history_query_t parsed;
    assert(wattpost_history_query_parse(query, &parsed));
    assert(parsed.limit == limit);
    assert(parsed.bound == bound);
    assert(parsed.timestamp == timestamp);
}

static void assert_rejected(const char *query) {
    wattpost_history_query_t parsed;
    assert(!wattpost_history_query_parse(query, &parsed));
}

int main(void) {
    assert_parse("limit=144", 144, WATTPOST_HISTORY_LATEST, 0);
    assert_parse("before=1788210000&limit=32", 32,
                 WATTPOST_HISTORY_BEFORE, 1788210000);
    assert_parse("limit=256&after=1788210000", 256,
                 WATTPOST_HISTORY_AFTER, 1788210000);
    assert_parse("after=1788210000", 144,
                 WATTPOST_HISTORY_AFTER, 1788210000);
    assert_parse("before=1788210000", 144,
                 WATTPOST_HISTORY_BEFORE, 1788210000);

    assert_rejected(NULL);
    assert_rejected("");
    assert_rejected("limit=0");
    assert_rejected("limit=257");
    assert_rejected("limit=12x");
    assert_rejected("limit=");
    assert_rejected("before=1788210000&after=1788210600");
    assert_rejected("before=1699999999");
    assert_rejected("after=4102444801");
    assert_rejected("unknown=1");
    assert_rejected("limit=1&limit=2");
    assert_rejected("before=1788210000&before=1788210600");
    assert_rejected("limit=1&");

    puts("test_history_query: all tests passed successfully");
    return 0;
}
