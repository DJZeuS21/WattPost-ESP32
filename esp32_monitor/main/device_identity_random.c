#include "device_identity_platform.h"

#include "bootloader_random.h"
#include "esp_random.h"

bool wattpost_device_identity_random_fill(void *buffer, size_t length) {
    if (!buffer || length == 0) {
        return false;
    }

    /*
     * Identity creation runs before application RF/ADC users are started.
     * ESP-IDF explicitly permits this entropy source from application early
     * startup when true random data is required before Wi-Fi/Bluetooth.
     */
    bootloader_random_enable();
    esp_fill_random(buffer, length);
    bootloader_random_disable();
    return true;
}
