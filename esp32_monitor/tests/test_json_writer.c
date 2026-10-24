#include <assert.h>
#include <stddef.h>
#include <string.h>

#include "json_writer.h"

int main(void) {
    char escaped[64];
    assert(wattpost_json_escape(escaped, sizeof(escaped), "A\"B\\C\n\t\x01"));
    assert(strcmp(escaped, "A\\\"B\\\\C\\n\\t\\u0001") == 0);

    char exact[3];
    assert(wattpost_json_escape(exact, sizeof(exact), "\\"));
    assert(strcmp(exact, "\\\\") == 0);

    char too_small[2];
    assert(!wattpost_json_escape(too_small, sizeof(too_small), "\\"));

    char json[16] = "";
    size_t used = 0;
    assert(wattpost_json_appendf(json, sizeof(json), &used, "{%s", "\"x\":"));
    assert(wattpost_json_appendf(json, sizeof(json), &used, "%d}", 1));
    assert(strcmp(json, "{\"x\":1}") == 0);
    assert(!wattpost_json_appendf(json, used + 1, &used, "x"));
    return 0;
}
