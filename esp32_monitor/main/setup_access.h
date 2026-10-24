#pragma once

#include <stddef.h>

#define WATTPOST_SETUP_AP_CODE_LEN 8u

/* Shared user-facing WPA2 access code for First Setup and Recovery APs. */
const char *wattpost_setup_ap_code(void);
