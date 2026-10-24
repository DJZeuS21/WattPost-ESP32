#include <assert.h>
#include <string.h>

#include "setup_access.h"

int main(void) {
    const char *code = wattpost_setup_ap_code();
    assert(code != NULL);
    assert(strcmp(code, "12345678") == 0);
    assert(strlen(code) == WATTPOST_SETUP_AP_CODE_LEN);
    assert(WATTPOST_SETUP_AP_CODE_LEN == 8u);
    return 0;
}
