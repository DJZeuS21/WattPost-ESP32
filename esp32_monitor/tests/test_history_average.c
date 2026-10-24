#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "history.h"
#include "history_average.h"

int main(void) {
    // 1. Verify exact 64-byte struct size
    assert(sizeof(wattpost_history_record_t) == 64);

    // 2. Test independent per-channel averaging for 8S pack + 3 temp sensors
    wattpost_history_average_t average = {0};

    jk_bms_data_t sample1 = {
        .valid = true,
        .cell_count = 8,
        .cell_active_mask = 0x000000FF,
        .temp_present_mask = 0x07, // MOS, T1, T2
        .pack_voltage_v = 26.70f,
        .current_a = -10.0f,
        .state_of_charge = 98,
        .temperatures_c = {28.0f, 25.0f, 26.0f, 0.0f, 0.0f, 0.0f},
        .cell_voltage_v = {3.340f, 3.341f, 3.339f, 3.340f, 3.342f, 3.340f, 3.338f, 3.340f},
    };

    jk_bms_data_t sample2 = {
        .valid = true,
        .cell_count = 8,
        .cell_active_mask = 0x000000FF,
        .temp_present_mask = 0x07, // MOS, T1, T2
        .pack_voltage_v = 26.74f,
        .current_a = -20.0f,
        .state_of_charge = 98,
        .temperatures_c = {29.0f, 26.0f, 27.0f, 0.0f, 0.0f, 0.0f},
        .cell_voltage_v = {3.342f, 3.343f, 3.341f, 3.342f, 3.344f, 3.342f, 3.340f, 3.342f},
    };

    wattpost_history_average_add(&average, &sample1);
    wattpost_history_average_add(&average, &sample2);

    assert(average.common_samples == 2);
    assert(average.cell_count == 8);
    assert(average.cell_active_mask == 0x000000FF);
    assert(average.temp_present_mask == 0x07);

    // Common averages
    assert(fabs(wattpost_history_average_common(average.pack_voltage_sum, &average) - 26.72) < 0.001);
    assert(fabs(wattpost_history_average_common(average.current_sum, &average) - (-15.0)) < 0.001);

    // Per-cell averages
    assert(average.cell_sample_count[0] == 2);
    assert(fabs(wattpost_history_average_cell(&average, 0) - 3.341) < 0.001);
    assert(average.cell_sample_count[8] == 0); // Inactive cell 9
    assert(wattpost_history_average_cell(&average, 8) == 0.0);

    // Per-temperature averages
    assert(average.temp_sample_count[0] == 2); // MOS
    assert(fabs(wattpost_history_average_temp(&average, 0) - 28.5) < 0.01);
    assert(average.temp_sample_count[1] == 2); // T1
    assert(fabs(wattpost_history_average_temp(&average, 1) - 25.5) < 0.01);
    assert(average.temp_sample_count[2] == 2); // T2
    assert(fabs(wattpost_history_average_temp(&average, 2) - 26.5) < 0.01);
    assert(average.temp_sample_count[3] == 0); // T3 absent
    assert(wattpost_history_average_temp(&average, 3) == 0.0);

    // 3. Test CRC16 calculation and record validation
    wattpost_history_record_t record = {0};
    record.version = WATTPOST_HISTORY_VERSION;
    record.timestamp = 1771680000;
    record.pack_voltage_mv = 26720;
    record.current_deci_a = -150;
    record.state_of_charge = 98;
    record.cell_count = 8;
    record.cell_active_mask = 0x000000FF;
    record.temp_present_mask = 0x07;
    for (uint8_t i = 0; i < 8; ++i) {
        record.cell_voltage_mv[i] = 3341;
    }
    record.temperature_deci_c[0] = 285;
    record.temperature_deci_c[1] = 255;
    record.temperature_deci_c[2] = 265;
    record.crc16 = wattpost_history_calc_crc16(&record);

    assert(record.crc16 != 0);
    assert(record.crc16 == wattpost_history_calc_crc16(&record));

    // Corrupted record check
    record.temperature_deci_c[0] ^= 0x01;
    assert(record.crc16 != wattpost_history_calc_crc16(&record));

    puts("test_history_average: all tests passed successfully");
    return 0;
}

