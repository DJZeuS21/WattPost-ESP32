#include "bms_write_request.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static void valid(const char *json, const char *key, double value,
                  double old, uint32_t epoch) {
    wattpost_bms_write_request_t parsed = {0};
    assert(wattpost_bms_write_request_parse(
               json, strlen(json), &parsed) == WATTPOST_BMS_WRITE_REQUEST_OK);
    assert(strcmp(parsed.key, key) == 0);
    assert(parsed.value == value);
    assert(parsed.expected_before == old);
    assert(parsed.connection_epoch == epoch);
}

static void invalid(const char *json) {
    wattpost_bms_write_request_t parsed = {0};
    assert(wattpost_bms_write_request_parse(
               json, strlen(json), &parsed) ==
           WATTPOST_BMS_WRITE_REQUEST_INVALID);
}

int main(void) {
    valid("{\"key\":\"cell_voltage.ovp_v\",\"value\":3.65,"
          "\"expected_before\":3.6,\"connection_epoch\":42}",
          "cell_voltage.ovp_v", 3.65, 3.6, 42);
    valid("{\"key\":\"switches.charge\",\"value\":false,"
          "\"expected_before\":true,\"connection_epoch\":4294967295}",
          "switches.charge", 0, 1, UINT32_MAX);
    valid("{\"key\":\"temperature.heating_start_c\",\"value\":-6,"
          "\"expected_before\":-5,\"connection_epoch\":1}",
          "temperature.heating_start_c", -6, -5, 1);
    valid("{\"key\":\"battery.nominal_capacity_ah\",\"value\":100.001,"
          "\"expected_before\":100,\"connection_epoch\":2}",
          "battery.nominal_capacity_ah", 100.001, 100, 2);
    wattpost_bms_write_request_t parsed = {0};
    const char *unsupported =
        "{\"key\":\"cell_voltage.smart_sleep_v\",\"value\":3.1,"
        "\"expected_before\":3,\"connection_epoch\":42}";
    assert(wattpost_bms_write_request_parse(
               unsupported, strlen(unsupported), &parsed) ==
           WATTPOST_BMS_WRITE_REQUEST_UNSUPPORTED);

    const char *invalid_cases[] = {
        "{}",
        "[]",
        "{",
        "null",
        "{\"key\":\"cell_voltage.ovp_v\",\"value\":3.7,\"connection_epoch\":1}",
        "{\"key\":\"cell_voltage.ovp_v\",\"value\":3.7,"
            "\"expected_before\":3.6}",
        "{\"key\":\"cell_voltage.ovp_v\",\"value\":3.7,"
            "\"expected_before\":3.6,\"connection_epoch\":0}",
        "{\"key\":\"cell_voltage.ovp_v\",\"value\":3.7,"
            "\"expected_before\":3.6,\"connection_epoch\":-1}",
        "{\"key\":\"cell_voltage.ovp_v\",\"value\":3.7,"
            "\"expected_before\":3.6,\"connection_epoch\":1.5}",
        "{\"key\":\"cell_voltage.ovp_v\",\"value\":3.7,"
            "\"expected_before\":3.6,\"connection_epoch\":4294967296}",
        "{\"key\":\"cell_voltage.ovp_v\",\"value\":3.7,"
            "\"expected_before\":3.6,\"connection_epoch\":\"1\"}",
        "{\"key\":\"cell_voltage.ovp_v\",\"value\":3.7,"
            "\"expected_before\":3.6,\"connection_epoch\":1,\"junk\":true}",
        "{\"key\":\"cell_voltage.ovp_v\",\"value\":3.7,"
            "\"value\":3.6,\"expected_before\":3.6,\"connection_epoch\":1}",
        "{\"key\":\"cell_voltage.ovp_v\",\"value\":3.7,"
            "\"expected_before\":3.7,\"connection_epoch\":1}",
        "{\"key\":\"cell_voltage.ovp_v\",\"value\":3.7001,"
            "\"expected_before\":3.6,\"connection_epoch\":1}",
        "{\"key\":\"cell_voltage.ovp_v\",\"value\":-3.7,"
            "\"expected_before\":3.6,\"connection_epoch\":1}",
        "{\"key\":\"cell_voltage.ovp_v\",\"value\":true,"
            "\"expected_before\":3.6,\"connection_epoch\":1}",
        "{\"key\":\"switches.charge\",\"value\":1,"
            "\"expected_before\":true,\"connection_epoch\":1}",
        "{\"key\":\"switches.charge\",\"value\":false,"
            "\"expected_before\":0,\"connection_epoch\":1}",
        "{\"key\":\"battery.cell_count\",\"value\":2.5,"
            "\"expected_before\":16,\"connection_epoch\":1}",
        "{\"key\":\"temperature.heating_start_c\",\"value\":-5.5,"
            "\"expected_before\":-5,\"connection_epoch\":1}",
        "{\"key\":\"sleep.smart_sleep_time_hours\",\"value\":256,"
            "\"expected_before\":12,\"connection_epoch\":1}",
        "{\"key\":\"cell_voltage.ovp_v\",\"value\":3.7,"
            "\"expected_before\":3.6,\"connection_epoch\":1} garbage",
    };
    for (size_t i = 0; i < sizeof(invalid_cases) / sizeof(invalid_cases[0]); i++) {
        invalid(invalid_cases[i]);
    }
    assert(wattpost_bms_write_request_parse(
               NULL, 0, &parsed) == WATTPOST_BMS_WRITE_REQUEST_INVALID);
    assert(wattpost_bms_write_request_parse(
               "{}", 2, NULL) == WATTPOST_BMS_WRITE_REQUEST_INVALID);
    puts("BMS write HTTP request: OK");
    return 0;
}
