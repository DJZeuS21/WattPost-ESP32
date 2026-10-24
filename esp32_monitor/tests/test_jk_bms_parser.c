#include <assert.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "jk_bms_parser.h"

static void write_u16_le(uint8_t *data, uint16_t value) {
    data[0] = (uint8_t) value;
    data[1] = (uint8_t) (value >> 8);
}

static void write_u32_le(uint8_t *data, uint32_t value) {
    for (size_t index = 0; index < 4; ++index) {
        data[index] = (uint8_t) (value >> (index * 8));
    }
}

static void finish_frame(uint8_t *frame) {
    uint8_t crc = 0;
    for (size_t index = 0; index < 299; ++index) {
        crc += frame[index];
    }
    frame[299] = crc;
}

static void build_sample_cell_frame(uint8_t *frame) {
    memset(frame, 0, 300);
    frame[0] = 0x55;
    frame[1] = 0xAA;
    frame[2] = 0xEB;
    frame[3] = 0x90;
    frame[4] = 0x02; // Frame type 2: Cell info

    const uint16_t voltages[] = {3340, 3341, 3339, 3340, 0, 0, 0, 0,
                                 0, 0, 0, 0, 3299, 0, 0, 0};
    for (size_t cell = 0; cell < sizeof(voltages) / sizeof(voltages[0]); ++cell) {
        write_u16_le(&frame[6 + cell * 2], voltages[cell]);
    }
    write_u32_le(&frame[70], 0x0000000F); // Enabled cells bitmask: 4 cells
    write_u16_le(&frame[74], 3340);        // BMS average cell voltage
    write_u16_le(&frame[76], 2);           // BMS cell voltage delta
    frame[78] = 1;                         // BMS max-voltage cell index
    frame[79] = 2;                         // BMS min-voltage cell index
    write_u16_le(&frame[80], 2);          // Cell 0 resistance: 2 mOhm = 0.002 Ohm
    write_u16_le(&frame[82], 3);          // Cell 1 resistance: 3 mOhm = 0.003 Ohm
    write_u32_le(&frame[150], 13360);
    write_u32_le(&frame[158], (uint32_t) -1250);
    write_u16_le(&frame[144], 311); // MOS temp: 31.1 C
    write_u16_le(&frame[162], 251); // T1: 25.1 C
    write_u16_le(&frame[164], 253); // T2: 25.3 C
    write_u32_le(&frame[166], 0x00000005); // Alarms: low_capacity + charging_overvoltage

    write_u16_le(&frame[170], 1200);       // Balance current: 1.200 A

    frame[172] = 1;                    // Balancing action: 1 (charging)
    frame[173] = 77;
    write_u32_le(&frame[174], 246500);
    write_u32_le(&frame[178], 320000);
    write_u32_le(&frame[182], 42);     // Cycle count: 42
    write_u32_le(&frame[186], 13230000); // Cumulative capacity: 13230.0 Ah
    frame[190] = 99;                   // State of Health: 99%
    frame[198] = 1;                    // Charge MOS on

    frame[199] = 0;                    // Discharge MOS off
    frame[214] = 0x38;                 // Status mask
    frame[215] = 1;                    // Heating active
    finish_frame(frame);
}


static void build_sample_settings_frame(uint8_t *frame) {

    memset(frame, 0, 300);
    frame[0] = 0x55;
    frame[1] = 0xAA;
    frame[2] = 0xEB;
    frame[3] = 0x90;
    frame[4] = 0x01; // Frame type 1: Settings
    frame[5] = 0x42; // Counter

    // Voltage thresholds (mV)
    write_u32_le(&frame[6], 3000);    // Smart sleep: 3.000 V
    write_u32_le(&frame[10], 2900);   // Cell UVP: 2.900 V
    write_u32_le(&frame[14], 3100);   // Cell UVPR: 3.100 V
    write_u32_le(&frame[18], 3650);   // Cell OVP: 3.650 V
    write_u32_le(&frame[22], 3550);   // Cell OVPR: 3.550 V
    write_u32_le(&frame[26], 10);     // Balance trigger delta: 0.010 V (10 mV)
    write_u32_le(&frame[30], 3450);   // SOC 100%: 3.450 V
    write_u32_le(&frame[34], 3000);   // SOC 0%: 3.000 V
    write_u32_le(&frame[38], 3600);   // Request charge voltage: 3.600 V
    write_u32_le(&frame[42], 3400);   // Request float voltage: 3.400 V
    write_u32_le(&frame[46], 2800);   // Power off voltage: 2.800 V
    write_u32_le(&frame[138], 3300);  // Start balance voltage: 3.300 V

    // Current limits & delays
    write_u32_le(&frame[50], 50000);  // Max charge current: 50.0 A
    write_u32_le(&frame[54], 30);     // Charge OCP delay: 30 s
    write_u32_le(&frame[58], 60);     // Charge OCPR time: 60 s
    write_u32_le(&frame[62], 150000); // Max discharge current: 150.0 A
    write_u32_le(&frame[66], 30);     // Discharge OCP delay: 30 s
    write_u32_le(&frame[70], 60);     // Discharge OCPR time: 60 s
    write_u32_le(&frame[74], 60);     // SCPR time: 60 s
    write_u32_le(&frame[78], 2000);   // Max balance current: 2.0 A
    write_u32_le(&frame[134], 1500);  // SCP delay: 1500 us
    frame[274] = 5;                   // Discharge precharge time: 5 s

    // Temperature protections (0.1 °C, signed)
    write_u32_le(&frame[82], 700);    // Charge OTP: 70.0 °C
    write_u32_le(&frame[86], 600);    // Charge OTP recovery: 60.0 °C
    write_u32_le(&frame[90], 700);    // Discharge OTP: 70.0 °C
    write_u32_le(&frame[94], 600);    // Discharge OTP recovery: 60.0 °C
    write_u32_le(&frame[98], (uint32_t) -200);  // Charge UTP: -20.0 °C
    write_u32_le(&frame[102], (uint32_t) -100); // Charge UTP recovery: -10.0 °C
    write_u32_le(&frame[106], 850);   // MOSFET OTP: 85.0 °C
    write_u32_le(&frame[110], 750);   // MOSFET OTP recovery: 75.0 °C
    frame[284] = (uint8_t) (int8_t) 2;   // Heating start temp: 2 °C
    frame[285] = (uint8_t) (int8_t) 7;   // Heating stop temp: 7 °C
    frame[296] = (uint8_t) (int8_t) -20; // Discharge UTP: -20 °C
    frame[297] = (uint8_t) (int8_t) -10; // Discharge UTP recovery: -10 °C

    // Battery pack configuration
    write_u32_le(&frame[114], 8);      // Cell count: 8
    write_u32_le(&frame[130], 315000); // Capacity: 315.000 Ah
    frame[270] = 1;                    // Device address: 1

    // Core switches
    frame[118] = 1; // Charge enabled
    frame[122] = 1; // Discharge enabled
    frame[126] = 1; // Balancer enabled

    // Advanced switches bitmasks
    // Byte 282: bit 0 (heating=1), bit 3 (port_rs485=1), bit 4 (display_on=1), bit 6 (smart_sleep=1)
    frame[282] = 0x01 | 0x08 | 0x10 | 0x40;
    // Byte 283: bit 0 (timed_stored=1), bit 1 (charging_float=1)
    frame[283] = 0x01 | 0x02;

    frame[286] = 12; // Smart sleep time: 12 h

    // Wire resistances: 0.001 to 0.008 Ohm
    for (uint8_t i = 0; i < JK_BMS_MAX_CELLS; ++i) {
        write_u32_le(&frame[142 + i * 4], (uint32_t) ((i + 1) * 2));
    }

    finish_frame(frame);
}

int main(void) {
    uint8_t cell_frame[300];
    build_sample_cell_frame(cell_frame);

    uint8_t settings_frame[300];
    build_sample_settings_frame(settings_frame);

    jk_bms_parser_t parser = {0};
    jk_bms_data_t telemetry = {0};
    jk_bms_settings_t settings = {0};

    // Test 1: Push cell frame in chunks
    assert(jk_bms_parser_push(&parser, cell_frame, 128, &telemetry, &settings, NULL) == JK_FRAME_TYPE_NONE);
    assert(jk_bms_parser_push(&parser, cell_frame + 128, 128, &telemetry, &settings, NULL) == JK_FRAME_TYPE_NONE);
    assert(jk_bms_parser_push(&parser, cell_frame + 256, 44, &telemetry, &settings, NULL) == JK_FRAME_TYPE_CELL_INFO);
    assert(telemetry.valid);
    assert(telemetry.cell_count == 4);
    assert(telemetry.cell_active_mask == 0x0F);
    assert(telemetry.raw_temperature_status_mask == 0x38);
    assert(fabsf(telemetry.temperatures_c[0] - 31.1f) < 0.1f);
    assert(fabsf(telemetry.temperatures_c[1] - 25.1f) < 0.1f);
    assert(fabsf(telemetry.temperatures_c[2] - 25.3f) < 0.1f);
    assert(telemetry.temperatures_c[3] == 0.0f);
    assert(fabsf(telemetry.mosfet_temperature_c - 31.1f) < 0.1f);
    assert(fabsf(telemetry.temperature_1_c - 25.1f) < 0.1f);
    assert(fabsf(telemetry.temperature_2_c - 25.3f) < 0.1f);

    assert(telemetry.state_of_charge == 77);
    assert(telemetry.remaining_capacity_ah > 246.49f && telemetry.remaining_capacity_ah < 246.51f);
    assert(telemetry.nominal_capacity_ah > 319.99f && telemetry.nominal_capacity_ah < 320.01f);
    assert(telemetry.balancing && telemetry.charging && !telemetry.discharging);
    assert(telemetry.charge_mos_enabled == true);
    assert(telemetry.discharge_mos_enabled == false);
    assert(telemetry.balancing_action == 1);
    assert(fabsf(telemetry.balancing_current_a - 1.200f) < 0.001f);
    assert(telemetry.alarm_flags == 0x0005);
    assert(telemetry.cycle_count == 42);
    assert(fabsf(telemetry.cycle_capacity_ah - 13230.0f) < 0.1f);
    assert(telemetry.heating_status == true);
    assert(fabsf(telemetry.cell_wire_resistance_ohm[0] - 0.002f) < 0.0001f);
    assert(fabsf(telemetry.cell_wire_resistance_ohm[1] - 0.003f) < 0.0001f);
    assert(telemetry.cell_voltage_v[0] > 3.339f && telemetry.cell_voltage_v[0] < 3.341f);
    assert(telemetry.min_cell_voltage_v > 3.338f && telemetry.min_cell_voltage_v < 3.340f);
    assert(telemetry.max_cell_voltage_v > 3.340f && telemetry.max_cell_voltage_v < 3.342f);
    assert(telemetry.bms_average_cell_voltage_mv == 3340);
    assert(telemetry.bms_cell_voltage_delta_mv == 2);
    assert(telemetry.bms_max_cell_index == 1);
    assert(telemetry.bms_min_cell_index == 2);
    assert(jk_bms_cell_index_valid(0, telemetry.cell_count));
    assert(jk_bms_cell_index_valid(telemetry.cell_count - 1, telemetry.cell_count));
    assert(!jk_bms_cell_index_valid(telemetry.cell_count, telemetry.cell_count));
    assert(!jk_bms_cell_index_valid(0, 0));
    assert(telemetry.state_of_health == 99);
    assert(telemetry.battery_type_id == 0);

    assert(strcmp(jk_bms_battery_chemistry_str(0), "LFP") == 0);
    assert(strcmp(jk_bms_battery_chemistry_str(1), "Li-ion") == 0);
    assert(strcmp(jk_bms_battery_chemistry_str(2), "LTO") == 0);
    assert(strcmp(jk_bms_battery_chemistry_str(3), "Unknown") == 0);




    // Test 2: Push settings frame in chunks
    jk_bms_parser_reset(&parser);
    assert(jk_bms_parser_push(&parser, settings_frame, 100, &telemetry, &settings, NULL) == JK_FRAME_TYPE_NONE);
    assert(jk_bms_parser_push(&parser, settings_frame + 100, 100, &telemetry, &settings, NULL) == JK_FRAME_TYPE_NONE);
    assert(jk_bms_parser_push(&parser, settings_frame + 200, 100, &telemetry, &settings, NULL) == JK_FRAME_TYPE_SETTINGS);
    assert(settings.valid);

    // Verify all parsed settings
    assert(fabsf(settings.smart_sleep_voltage_v - 3.000f) < 0.001f);
    assert(fabsf(settings.cell_uvp_v - 2.900f) < 0.001f);
    assert(fabsf(settings.cell_uvpr_v - 3.100f) < 0.001f);
    assert(fabsf(settings.cell_ovp_v - 3.650f) < 0.001f);
    assert(fabsf(settings.cell_ovpr_v - 3.550f) < 0.001f);
    assert(fabsf(settings.balance_trigger_voltage_v - 0.010f) < 0.001f);
    assert(fabsf(settings.cell_soc100_voltage_v - 3.450f) < 0.001f);
    assert(fabsf(settings.cell_soc0_voltage_v - 3.000f) < 0.001f);
    assert(fabsf(settings.cell_request_charge_voltage_v - 3.600f) < 0.001f);
    assert(fabsf(settings.cell_request_float_voltage_v - 3.400f) < 0.001f);
    assert(fabsf(settings.power_off_voltage_v - 2.800f) < 0.001f);
    assert(fabsf(settings.start_balance_voltage_v - 3.300f) < 0.001f);

    assert(fabsf(settings.max_charge_current_a - 50.000f) < 0.001f);
    assert(settings.charge_ocp_delay_s == 30);
    assert(settings.charge_ocpr_time_s == 60);
    assert(fabsf(settings.max_discharge_current_a - 150.000f) < 0.001f);
    assert(settings.discharge_ocp_delay_s == 30);
    assert(settings.discharge_ocpr_time_s == 60);
    assert(settings.scpr_time_s == 60);
    assert(fabsf(settings.max_balance_current_a - 2.000f) < 0.001f);
    assert(settings.scp_delay_us == 1500);
    assert(settings.discharge_precharge_time_s == 5);

    assert(fabsf(settings.charge_otp_c - 70.0f) < 0.1f);
    assert(fabsf(settings.charge_otpr_c - 60.0f) < 0.1f);
    assert(fabsf(settings.discharge_otp_c - 70.0f) < 0.1f);
    assert(fabsf(settings.discharge_otpr_c - 60.0f) < 0.1f);
    assert(fabsf(settings.charge_utp_c - (-20.0f)) < 0.1f);
    assert(fabsf(settings.charge_utpr_c - (-10.0f)) < 0.1f);
    assert(fabsf(settings.mosfet_otp_c - 85.0f) < 0.1f);
    assert(fabsf(settings.mosfet_otpr_c - 75.0f) < 0.1f);
    assert(settings.heating_start_temp_c == 2);
    assert(settings.heating_stop_temp_c == 7);
    assert(settings.discharge_utp_c == -20);
    assert(settings.discharge_utpr_c == -10);

    assert(settings.cell_count == 8);
    assert(fabsf(settings.nominal_capacity_ah - 315.000f) < 0.001f);
    assert(settings.device_address == 1);

    assert(settings.charge_switch == true);
    assert(settings.discharge_switch == true);
    assert(settings.balancer_switch == true);
    assert(settings.heating_switch == true);
    assert(settings.disable_temperature_sensors == false);
    assert(settings.gps_heartbeat == false);
    assert(settings.port_switch_rs485 == true);
    assert(settings.display_always_on == true);
    assert(settings.special_charger == false);
    assert(settings.smart_sleep_switch == true);
    assert(settings.disable_pcl_module == false);
    assert(settings.timed_stored_data == true);
    assert(settings.charging_float_mode == true);
    assert(settings.smart_sleep_time_hours == 12);

    assert(fabsf(settings.wire_resistance_ohm[0] - 0.002f) < 0.0001f);
    assert(fabsf(settings.wire_resistance_ohm[7] - 0.016f) < 0.0001f);

    // Test 3: Subsequent cell frame should not wipe settings
    assert(jk_bms_parser_push(&parser, cell_frame, 300, &telemetry, &settings, NULL) == JK_FRAME_TYPE_CELL_INFO);
    assert(telemetry.valid);
    assert(settings.valid);
    assert(fabsf(settings.cell_uvp_v - 2.900f) < 0.001f);

    // Test 4: Modifying settings frame updates settings correctly
    write_u32_le(&settings_frame[10], 2850); // Change UVP to 2.850 V
    finish_frame(settings_frame);
    assert(jk_bms_parser_push(&parser, settings_frame, 300, &telemetry, &settings, NULL) == JK_FRAME_TYPE_SETTINGS);
    assert(fabsf(settings.cell_uvp_v - 2.850f) < 0.001f);

    // Test 5: Corrupted CRC should be rejected
    settings_frame[299] ^= 0x55;
    assert(jk_bms_parser_push(&parser, settings_frame, 300, &telemetry, &settings, NULL) == JK_FRAME_TYPE_NONE);


    // Test 6: Metadata descriptors
    size_t meta_count = 0;
    const jk_setting_meta_t *meta = jk_bms_get_setting_metadata(&meta_count);
    assert(meta != NULL && meta_count > 30);

    puts("test_jk_bms_parser: all tests passed successfully");
    return 0;
}
