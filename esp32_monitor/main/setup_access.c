#include "setup_access.h"

_Static_assert(WATTPOST_SETUP_AP_CODE_LEN >= 8u, "WPA2 minimum length");

const char *wattpost_setup_ap_code(void) {
    return "12345678";
}
