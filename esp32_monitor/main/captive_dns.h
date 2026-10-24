#pragma once

#include <stdbool.h>

#include "esp_netif.h"

bool wattpost_captive_dns_start(esp_netif_t *ap_netif);
void wattpost_captive_dns_stop(void);
bool wattpost_captive_dns_is_active(void);
