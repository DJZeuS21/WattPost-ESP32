#include <assert.h>

#include "mdns_policy.h"

int main(void) {
    assert(!wattpost_mdns_announce_due(299));
    assert(wattpost_mdns_announce_due(300));

    assert(wattpost_mdns_announce_due(21600));
    return 0;
}
