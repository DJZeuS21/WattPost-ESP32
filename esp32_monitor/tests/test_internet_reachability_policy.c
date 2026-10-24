#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "internet_reachability_policy.h"

int main(void) {
    assert(wattpost_internet_probe_result(true, 204) ==
           WATTPOST_INTERNET_REACHABLE);
    assert(wattpost_internet_probe_result(true, 200) ==
           WATTPOST_INTERNET_UNREACHABLE);
    assert(wattpost_internet_probe_result(true, 302) ==
           WATTPOST_INTERNET_UNREACHABLE);
    assert(wattpost_internet_probe_result(false, 0) ==
           WATTPOST_INTERNET_UNREACHABLE);

    assert(strcmp(
        wattpost_internet_state_str(WATTPOST_INTERNET_UNKNOWN),
        "unknown") == 0);
    assert(strcmp(
        wattpost_internet_state_str(WATTPOST_INTERNET_REACHABLE),
        "reachable") == 0);
    assert(strcmp(
        wattpost_internet_state_str(WATTPOST_INTERNET_UNREACHABLE),
        "unreachable") == 0);

    puts("internet reachability policy: OK");
    return 0;
}
