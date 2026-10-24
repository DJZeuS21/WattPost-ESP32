#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define JK_BMS_MAX_CELLS 16
#define JK_BMS_MAX_TEMPS 6
#define JK_FRAME_LENGTH 300

typedef struct {
    bool valid;
    bool balancing;
    uint8_t balancing_action;          // 0 = off, 1 = charging/balance, 2 = discharging
    float balancing_current_a;         // balance current in A
    bool charging;                     // backward-compat: charge MOS enabled
    bool discharging;                  // backward-compat: discharge MOS enabled
    bool charge_mos_enabled;           // frame[198] != 0
    bool discharge_mos_enabled;        // frame[199] != 0
    bool heating_status;               // frame[215] != 0
    uint32_t alarm_flags;              // frame[166..169] 32-bit bitmask
    uint32_t cycle_count;              // frame[182]

    float cycle_capacity_ah;           // frame[186] cumulative capacity in Ah
    uint8_t cell_count;
    uint32_t cell_active_mask;
    uint8_t raw_temperature_status_mask;
    uint8_t temp_present_mask;
    uint8_t state_of_charge;
    float pack_voltage_v;
    float current_a;
    float power_w;
    float remaining_capacity_ah;
    float nominal_capacity_ah;
    float min_cell_voltage_v;
    float max_cell_voltage_v;
    float cell_spread_v;
    uint16_t bms_average_cell_voltage_mv; // frame[74..75]
    uint16_t bms_cell_voltage_delta_mv;   // frame[76..77]
    uint8_t bms_max_cell_index;           // frame[78], zero-based
    uint8_t bms_min_cell_index;           // frame[79], zero-based
    float cell_voltage_v[JK_BMS_MAX_CELLS];
    float cell_wire_resistance_ohm[JK_BMS_MAX_CELLS];
    int16_t raw_temperatures[JK_BMS_MAX_TEMPS];
    bool raw_temperature_valid[JK_BMS_MAX_TEMPS];
    float temperatures_c[JK_BMS_MAX_TEMPS];

    // Backward-compatible scalar aliases
    float temperature_1_c;
    float temperature_2_c;
    float mosfet_temperature_c;

    // Battery chemistry / type code (frame[275] in JK02_32S)
    uint8_t battery_type_id;

    // State of Health (frame[190] in JK02_32S, %)
    uint8_t state_of_health;
} jk_bms_data_t;







typedef struct {
    bool valid;
    uint32_t received_count;
    char model[20];
    char hardware_version[12];
    char software_version[12];
    uint32_t uptime_seconds;
    uint32_t power_on_count;
    char device_name[20];
    char passcode[8];
    char manufacturing_date[12];
    char serial_number[16];
    char user_data[20];
    char setup_passcode[20];
} jk_bms_device_info_t;


typedef struct {
    bool valid;
    uint32_t received_count;

    // Cell Voltage Protection & Thresholds (V)
    float smart_sleep_voltage_v;
    float cell_uvp_v;
    float cell_uvpr_v;
    float cell_ovp_v;
    float cell_ovpr_v;
    float balance_trigger_voltage_v;
    float cell_soc100_voltage_v;
    float cell_soc0_voltage_v;
    float cell_request_charge_voltage_v;
    float cell_request_float_voltage_v;
    float power_off_voltage_v;
    float start_balance_voltage_v;

    // Current Limits & Delays
    float max_charge_current_a;
    uint32_t charge_ocp_delay_s;
    uint32_t charge_ocpr_time_s;
    float max_discharge_current_a;
    uint32_t discharge_ocp_delay_s;
    uint32_t discharge_ocpr_time_s;
    uint32_t scpr_time_s;
    float max_balance_current_a;
    uint32_t scp_delay_us;
    uint8_t discharge_precharge_time_s;

    // Temperature Protections (°C)
    float charge_otp_c;
    float charge_otpr_c;
    float discharge_otp_c;
    float discharge_otpr_c;
    float charge_utp_c;
    float charge_utpr_c;
    float mosfet_otp_c;
    float mosfet_otpr_c;
    int8_t heating_start_temp_c;
    int8_t heating_stop_temp_c;
    int8_t discharge_utp_c;
    int8_t discharge_utpr_c;

    // Battery Pack & Hardware
    uint8_t cell_count;
    float nominal_capacity_ah;
    uint8_t device_address;

    // Switches
    bool charge_switch;
    bool discharge_switch;
    bool balancer_switch;
    bool heating_switch;
    bool disable_temperature_sensors;
    bool gps_heartbeat;
    bool port_switch_rs485;
    bool display_always_on;
    bool special_charger;
    bool smart_sleep_switch;
    bool disable_pcl_module;
    bool timed_stored_data;
    bool charging_float_mode;

    // Timers
    uint8_t smart_sleep_time_hours;

    // Wire Resistances (Ohm, channels 1..16)
    float wire_resistance_ohm[JK_BMS_MAX_CELLS];
} jk_bms_settings_t;




typedef enum {
    JK_FRAME_TYPE_NONE = 0,
    JK_FRAME_TYPE_SETTINGS = 0x01,
    JK_FRAME_TYPE_CELL_INFO = 0x02,
    JK_FRAME_TYPE_DEVICE_INFO = 0x03,
} jk_frame_type_t;

typedef enum {
    JK_SETTING_DATA_U8,
    JK_SETTING_DATA_I8,
    JK_SETTING_DATA_U16,
    JK_SETTING_DATA_I16,
    JK_SETTING_DATA_U32,
    JK_SETTING_DATA_I32,
    JK_SETTING_DATA_BOOL_BYTE,
    JK_SETTING_DATA_BIT,
} jk_setting_data_type_t;

typedef struct {
    const char *key;
    uint8_t register_id;
    uint16_t offset;
    uint8_t length;
    jk_setting_data_type_t type;
    uint8_t bit_index;
    float scale;
    const char *unit;
} jk_setting_meta_t;

typedef struct {
    uint8_t bytes[400];
    size_t length;
} jk_bms_parser_t;

void jk_bms_parser_reset(jk_bms_parser_t *parser);
uint8_t jk_bms_parser_push(jk_bms_parser_t *parser, const uint8_t *data, size_t length,
                           jk_bms_data_t *telemetry_out, jk_bms_settings_t *settings_out,
                           jk_bms_device_info_t *device_info_out);

const jk_setting_meta_t *jk_bms_get_setting_metadata(size_t *count);
const char *jk_bms_battery_chemistry_str(uint8_t type_id);
bool jk_bms_cell_index_valid(uint8_t index, uint8_t cell_count);
