#include <assert.h>
#include <stdint.h>
#include <string.h>

#include "cloud_history_format.h"

_Static_assert(sizeof(wattpost_history_record_t) == 64u, "History v2 record changed");

static wattpost_history_record_t sample_record(uint32_t timestamp) {
    wattpost_history_record_t record = {0};
    record.version = WATTPOST_HISTORY_VERSION;
    record.timestamp = timestamp;
    record.pack_voltage_mv = 26400u;
    record.current_deci_a = -42;
    record.state_of_charge = 82u;
    record.cell_count = 2u;
    record.cell_active_mask = 0x09u;
    record.temp_present_mask = 0x05u;
    record.cell_voltage_mv[0] = 3300u;
    record.cell_voltage_mv[3] = 3304u;
    record.temperature_deci_c[0] = 281;
    record.temperature_deci_c[2] = 310;
    record.crc16 = wattpost_history_calc_crc16(&record);
    return record;
}

static void test_exact_local_browser_shape(void) {
    char json[WATTPOST_CLOUD_HISTORY_JSON_MAX_LEN];
    wattpost_cloud_history_formatter_t formatter;
    wattpost_history_record_t record = sample_record(1760000000u);

    assert(wattpost_cloud_history_format_init(&formatter, json, sizeof(json)));
    assert(wattpost_cloud_history_format_append(&formatter, &record));
    assert(wattpost_cloud_history_format_finish(&formatter));
    assert(formatter.count == 1u);
    assert(strcmp(
        json,
        "{\"schema_version\":1,\"records\":[{\"t\":1760000000,"
        "\"v\":26.400,\"a\":-4.2,\"s\":82,\"cell_count\":2,"
        "\"cell_mask\":9,\"temp_mask\":5,\"cells\":[3300,3304],"
        "\"temps\":[281,null,310,null,null,null]}]}") == 0);
}

static void test_batch_bounds_and_maximum_record_shape(void) {
    char json[WATTPOST_CLOUD_HISTORY_JSON_MAX_LEN];
    wattpost_cloud_history_formatter_t formatter;
    assert(wattpost_cloud_history_format_init(&formatter, json, sizeof(json)));

    const uint32_t first_timestamp = 4102444800u - 11u * 600u;
    for (uint8_t record_index = 0u;
         record_index < WATTPOST_CLOUD_HISTORY_MAX_RECORDS;
         ++record_index) {
        wattpost_history_record_t record = sample_record(
            first_timestamp + (uint32_t) record_index * 600u);
        record.pack_voltage_mv = 1000000u;
        record.current_deci_a = INT16_MIN;
        record.state_of_charge = 100u;
        record.cell_count = 16u;
        record.cell_active_mask = 0xFFFFu;
        record.temp_present_mask = 0x3Fu;
        for (uint8_t cell = 0u; cell < 16u; ++cell) {
            record.cell_voltage_mv[cell] = 6000u;
        }
        for (uint8_t temperature = 0u; temperature < 6u; ++temperature) {
            record.temperature_deci_c[temperature] = 2000;
        }
        record.crc16 = wattpost_history_calc_crc16(&record);
        assert(wattpost_cloud_history_format_append(&formatter, &record));
    }
    assert(formatter.count == WATTPOST_CLOUD_HISTORY_MAX_RECORDS);
    assert(formatter.used < sizeof(json));
    assert(wattpost_cloud_history_format_finish(&formatter));
    assert(formatter.used == strlen(json));
    assert(strstr(json, "\"cell_count\":16") != NULL);
    assert(strstr(json, "\"v\":1000.000,\"a\":-3276.8") != NULL);
    assert(json[formatter.used - 2u] == ']');
    assert(json[formatter.used - 1u] == '}');
}

static void test_invalid_records_and_order_are_rejected(void) {
    char json[WATTPOST_CLOUD_HISTORY_JSON_MAX_LEN];
    wattpost_cloud_history_formatter_t formatter;
    wattpost_history_record_t first = sample_record(1760000000u);
    wattpost_history_record_t invalid = sample_record(1760000600u);

    invalid.cell_active_mask = 0u;
    invalid.crc16 = wattpost_history_calc_crc16(&invalid);
    assert(wattpost_cloud_history_format_init(&formatter, json, sizeof(json)));
    assert(!wattpost_cloud_history_format_append(&formatter, &invalid));
    assert(formatter.failed);
    assert(json[0] == '\0');

    assert(wattpost_cloud_history_format_init(&formatter, json, sizeof(json)));
    assert(wattpost_cloud_history_format_append(&formatter, &first));
    assert(!wattpost_cloud_history_format_append(&formatter, &first));
    assert(formatter.failed);
    assert(json[0] == '\0');

    first = sample_record(1760000000u);
    invalid = sample_record(1760000600u);
    invalid.crc16 ^= 1u;
    assert(wattpost_cloud_history_format_init(&formatter, json, sizeof(json)));
    assert(wattpost_cloud_history_format_append(&formatter, &first));
    assert(!wattpost_cloud_history_format_append(&formatter, &invalid));
    assert(json[0] == '\0');
}

static void test_empty_overflow_and_invalid_capacity(void) {
    char json[WATTPOST_CLOUD_HISTORY_JSON_MAX_LEN];
    char too_small[32];
    wattpost_cloud_history_formatter_t formatter;
    wattpost_history_record_t record = sample_record(1760000000u);

    assert(!wattpost_cloud_history_format_init(
        &formatter, json, WATTPOST_CLOUD_HISTORY_JSON_MAX_LEN + 1u));
    assert(wattpost_cloud_history_format_init(&formatter, json, sizeof(json)));
    assert(!wattpost_cloud_history_format_finish(&formatter));
    assert(json[0] == '\0');

    assert(wattpost_cloud_history_format_init(
        &formatter, too_small, sizeof(too_small)));
    assert(!wattpost_cloud_history_format_append(&formatter, &record));
    assert(formatter.failed);
    assert(too_small[0] == '\0');
}

int main(void) {
    test_exact_local_browser_shape();
    test_batch_bounds_and_maximum_record_shape();
    test_invalid_records_and_order_are_rejected();
    test_empty_overflow_and_invalid_capacity();
    return 0;
}
