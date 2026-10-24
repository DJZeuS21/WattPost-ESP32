#include "jk_bms_parser.h"

#include <math.h>
#include <string.h>

enum {
    JK_CELL_ACTIVE_MV = 500,
};

static const jk_setting_meta_t JK_SETTINGS_META[] = {
    // Cell Voltage Protections & Thresholds
    {"smart_sleep_voltage_v", 0x01, 6, 4, JK_SETTING_DATA_U32, 0, 0.001f, "V"},
    {"cell_uvp_v", 0x02, 10, 4, JK_SETTING_DATA_U32, 0, 0.001f, "V"},
    {"cell_uvpr_v", 0x03, 14, 4, JK_SETTING_DATA_U32, 0, 0.001f, "V"},
    {"cell_ovp_v", 0x04, 18, 4, JK_SETTING_DATA_U32, 0, 0.001f, "V"},
    {"cell_ovpr_v", 0x05, 22, 4, JK_SETTING_DATA_U32, 0, 0.001f, "V"},
    {"balance_trigger_voltage_v", 0x06, 26, 4, JK_SETTING_DATA_U32, 0, 0.001f, "V"},
    {"cell_soc100_voltage_v", 0x07, 30, 4, JK_SETTING_DATA_U32, 0, 0.001f, "V"},
    {"cell_soc0_voltage_v", 0x08, 34, 4, JK_SETTING_DATA_U32, 0, 0.001f, "V"},
    {"cell_request_charge_voltage_v", 0x09, 38, 4, JK_SETTING_DATA_U32, 0, 0.001f, "V"},
    {"cell_request_float_voltage_v", 0x0A, 42, 4, JK_SETTING_DATA_U32, 0, 0.001f, "V"},
    {"power_off_voltage_v", 0x0B, 46, 4, JK_SETTING_DATA_U32, 0, 0.001f, "V"},
    {"start_balance_voltage_v", 0x22, 138, 4, JK_SETTING_DATA_U32, 0, 0.001f, "V"},

    // Current Limits & Delays
    {"max_charge_current_a", 0x0C, 50, 4, JK_SETTING_DATA_U32, 0, 0.001f, "A"},
    {"charge_ocp_delay_s", 0x0D, 54, 4, JK_SETTING_DATA_U32, 0, 1.0f, "s"},
    {"charge_ocpr_time_s", 0x0E, 58, 4, JK_SETTING_DATA_U32, 0, 1.0f, "s"},
    {"max_discharge_current_a", 0x0F, 62, 4, JK_SETTING_DATA_U32, 0, 0.001f, "A"},
    {"discharge_ocp_delay_s", 0x10, 66, 4, JK_SETTING_DATA_U32, 0, 1.0f, "s"},
    {"discharge_ocpr_time_s", 0x11, 70, 4, JK_SETTING_DATA_U32, 0, 1.0f, "s"},
    {"scpr_time_s", 0x12, 74, 4, JK_SETTING_DATA_U32, 0, 1.0f, "s"},
    {"max_balance_current_a", 0x13, 78, 4, JK_SETTING_DATA_U32, 0, 0.001f, "A"},
    {"scp_delay_us", 0x21, 134, 4, JK_SETTING_DATA_U32, 0, 1.0f, "us"},
    {"discharge_precharge_time_s", 0x23, 274, 1, JK_SETTING_DATA_U8, 0, 1.0f, "s"},

    // Temperature Protections
    {"charge_otp_c", 0x14, 82, 4, JK_SETTING_DATA_I32, 0, 0.1f, "°C"},
    {"charge_otpr_c", 0x15, 86, 4, JK_SETTING_DATA_I32, 0, 0.1f, "°C"},
    {"discharge_otp_c", 0x16, 90, 4, JK_SETTING_DATA_I32, 0, 0.1f, "°C"},
    {"discharge_otpr_c", 0x17, 94, 4, JK_SETTING_DATA_I32, 0, 0.1f, "°C"},
    {"charge_utp_c", 0x18, 98, 4, JK_SETTING_DATA_I32, 0, 0.1f, "°C"},
    {"charge_utpr_c", 0x19, 102, 4, JK_SETTING_DATA_I32, 0, 0.1f, "°C"},
    {"mosfet_otp_c", 0x1A, 106, 4, JK_SETTING_DATA_I32, 0, 0.1f, "°C"},
    {"mosfet_otpr_c", 0x1B, 110, 4, JK_SETTING_DATA_I32, 0, 0.1f, "°C"},
    {"heating_start_temp_c", 0x24, 284, 1, JK_SETTING_DATA_I8, 0, 1.0f, "°C"},
    {"heating_stop_temp_c", 0x25, 285, 1, JK_SETTING_DATA_I8, 0, 1.0f, "°C"},
    {"discharge_utp_c", 0x1E, 296, 1, JK_SETTING_DATA_I8, 0, 1.0f, "°C"},
    {"discharge_utpr_c", 0x1F, 297, 1, JK_SETTING_DATA_I8, 0, 1.0f, "°C"},

    // Battery Pack Configuration
    {"cell_count", 0x1C, 114, 4, JK_SETTING_DATA_U32, 0, 1.0f, ""},
    {"nominal_capacity_ah", 0x20, 130, 4, JK_SETTING_DATA_U32, 0, 0.001f, "Ah"},
    {"device_address", 0x00, 270, 1, JK_SETTING_DATA_U8, 0, 1.0f, ""},

    // Core Switches
    {"charge_switch", 0x1D, 118, 4, JK_SETTING_DATA_BOOL_BYTE, 0, 1.0f, ""},
    {"discharge_switch", 0x1E, 122, 4, JK_SETTING_DATA_BOOL_BYTE, 0, 1.0f, ""},
    {"balancer_switch", 0x1F, 126, 4, JK_SETTING_DATA_BOOL_BYTE, 0, 1.0f, ""},

    // Advanced Switches
    {"heating_switch", 0x27, 282, 1, JK_SETTING_DATA_BIT, 0, 1.0f, ""},
    {"disable_temperature_sensors", 0x28, 282, 1, JK_SETTING_DATA_BIT, 1, 1.0f, ""},
    {"gps_heartbeat", 0x00, 282, 1, JK_SETTING_DATA_BIT, 2, 1.0f, ""},
    {"port_switch_rs485", 0x00, 282, 1, JK_SETTING_DATA_BIT, 3, 1.0f, ""},
    {"display_always_on", 0x2B, 282, 1, JK_SETTING_DATA_BIT, 4, 1.0f, ""},
    {"special_charger", 0x00, 282, 1, JK_SETTING_DATA_BIT, 5, 1.0f, ""},
    {"smart_sleep_switch", 0x2D, 282, 1, JK_SETTING_DATA_BIT, 6, 1.0f, ""},
    {"disable_pcl_module", 0x2E, 282, 1, JK_SETTING_DATA_BIT, 7, 1.0f, ""},
    {"timed_stored_data", 0x2F, 283, 1, JK_SETTING_DATA_BIT, 0, 1.0f, ""},
    {"charging_float_mode", 0x30, 283, 1, JK_SETTING_DATA_BIT, 1, 1.0f, ""},

    // Timers
    {"smart_sleep_time_hours", 0x39, 286, 1, JK_SETTING_DATA_U8, 0, 1.0f, "h"},
};

const jk_setting_meta_t *jk_bms_get_setting_metadata(size_t *count) {
    if (count != NULL) {
        *count = sizeof(JK_SETTINGS_META) / sizeof(JK_SETTINGS_META[0]);
    }
    return JK_SETTINGS_META;
}

static uint16_t read_u16_le(const uint8_t *data) {
    return (uint16_t) data[0] | ((uint16_t) data[1] << 8);
}

static uint32_t read_u32_le(const uint8_t *data) {
    return (uint32_t) data[0] | ((uint32_t) data[1] << 8) |
           ((uint32_t) data[2] << 16) | ((uint32_t) data[3] << 24);
}

static uint8_t crc8_sum(const uint8_t *data, size_t length) {
    uint8_t crc = 0;
    for (size_t index = 0; index < length; ++index) {
        crc += data[index];
    }
    return crc;
}

static bool is_preamble(const uint8_t *data, size_t length) {
    return length >= 4 && data[0] == 0x55 && data[1] == 0xAA &&
           data[2] == 0xEB && data[3] == 0x90;
}

static bool decode_cell_info(const uint8_t *frame, jk_bms_data_t *result) {
    if (frame[4] != JK_FRAME_TYPE_CELL_INFO ||
        crc8_sum(frame, JK_FRAME_LENGTH - 1) != frame[JK_FRAME_LENGTH - 1]) {
        return false;
    }

    if (result == NULL) {
        return true;
    }

    memset(result, 0, sizeof(*result));

    // Enabled cells bitmask from byte 70..73 in JK02_32S telemetry frame
    const uint32_t raw_cell_mask = read_u32_le(&frame[70]);
    result->cell_active_mask = raw_cell_mask;

    float min_v = 1000.0f;
    float max_v = 0.0f;

    for (uint8_t cell = 0; cell < JK_BMS_MAX_CELLS; ++cell) {
        const uint16_t millivolts = read_u16_le(&frame[6 + cell * 2]);
        const bool mask_enabled = (raw_cell_mask == 0) || ((raw_cell_mask & (1u << cell)) != 0);
        if (millivolts > JK_CELL_ACTIVE_MV && mask_enabled) {
            const float voltage = millivolts * 0.001f;
            result->cell_voltage_v[cell] = voltage;
            result->cell_active_mask |= (1u << cell);
            ++result->cell_count;
            if (voltage < min_v) {
                min_v = voltage;
            }
            if (voltage > max_v) {
                max_v = voltage;
            }
        } else {
            result->cell_voltage_v[cell] = 0.0f;
            result->cell_active_mask &= ~(1u << cell);
        }
    }

    if (result->cell_count == 0) {
        return false;
    }

    // Cell wire resistances start at offset 80 (32S), uint16_t mOhm
    for (uint8_t i = 0; i < JK_BMS_MAX_CELLS; ++i) {
        result->cell_wire_resistance_ohm[i] = read_u16_le(&frame[80 + i * 2]) * 0.001f;
    }

    result->min_cell_voltage_v = min_v;
    result->max_cell_voltage_v = max_v;
    result->cell_spread_v = max_v - min_v;
    result->bms_average_cell_voltage_mv = read_u16_le(&frame[74]);
    result->bms_cell_voltage_delta_mv = read_u16_le(&frame[76]);
    result->bms_max_cell_index = frame[78];
    result->bms_min_cell_index = frame[79];

    // Raw temperature status mask directly from byte 214 (unmodified)
    result->raw_temperature_status_mask = frame[214];
    const int16_t raw_temps[JK_BMS_MAX_TEMPS] = {
        (int16_t) read_u16_le(&frame[144]), // 0: MOSFET @144
        (int16_t) read_u16_le(&frame[162]), // 1: T1 @162
        (int16_t) read_u16_le(&frame[164]), // 2: T2 @164
        (int16_t) read_u16_le(&frame[254]), // 3: EXT254 @254
        (int16_t) read_u16_le(&frame[256]), // 4: EXT256 @256
        (int16_t) read_u16_le(&frame[258]), // 5: EXT258 @258
    };

    for (uint8_t i = 0; i < JK_BMS_MAX_TEMPS; ++i) {
        result->raw_temperatures[i] = raw_temps[i];
        if (raw_temps[i] != (int16_t)0x7FFF && raw_temps[i] >= -400 && raw_temps[i] <= 1200) {
            result->raw_temperature_valid[i] = true;
            result->temperatures_c[i] = raw_temps[i] * 0.1f;
        } else {
            result->raw_temperature_valid[i] = false;
            result->temperatures_c[i] = 0.0f;
        }
    }

    // Backward-compatible scalar aliases
    result->mosfet_temperature_c = result->temperatures_c[0];
    result->temperature_1_c = result->temperatures_c[1];
    result->temperature_2_c = result->temperatures_c[2];

    // Offsets below are the JK02_32S variant of the documented 300-byte frame.
    result->pack_voltage_v = read_u32_le(&frame[150]) * 0.001f;
    result->current_a = (int32_t) read_u32_le(&frame[158]) * 0.001f;
    result->power_w = result->pack_voltage_v * result->current_a;

    // Alarm flags at offset 166 (32-bit bitmask in JK02_32S)
    result->alarm_flags = read_u32_le(&frame[166]);

    // Balancing metrics at offset 170 and 172

    result->balancing_current_a = (int16_t) read_u16_le(&frame[170]) * 0.001f;
    result->balancing_action = frame[172];
    result->balancing = (frame[172] != 0);

    // State of charge at offset 173
    result->state_of_charge = frame[173];

    const uint32_t remaining_mah = read_u32_le(&frame[174]);
    const uint32_t nominal_mah = read_u32_le(&frame[178]);
    result->remaining_capacity_ah = remaining_mah <= 10000000u ? remaining_mah * 0.001f : NAN;
    result->nominal_capacity_ah = nominal_mah > 0 && nominal_mah <= 10000000u ? nominal_mah * 0.001f : NAN;

    // Cycle statistics at offset 182 and 186
    result->cycle_count = read_u32_le(&frame[182]);
    const uint32_t cycle_mah = read_u32_le(&frame[186]);
    result->cycle_capacity_ah = cycle_mah <= 100000000u ? cycle_mah * 0.001f : 0.0f;

    // MOS switches at offset 198 and 199
    result->charge_mos_enabled = (frame[198] != 0);
    result->discharge_mos_enabled = (frame[199] != 0);
    result->charging = result->charge_mos_enabled;
    result->discharging = result->discharge_mos_enabled;

    // Heating status at offset 215
    result->heating_status = (frame[215] != 0);

    // State of Health at offset 190 (0-based, uint8_t in JK02_32S, %)
    result->state_of_health = frame[190];

    // Battery type / chemistry at offset 275 (0-based, uint8_t in JK02_32S)
    result->battery_type_id = frame[275];

    result->valid = true;
    return true;





}

static bool decode_settings_info(const uint8_t *frame, jk_bms_settings_t *result) {
    if (frame[4] != JK_FRAME_TYPE_SETTINGS ||
        crc8_sum(frame, JK_FRAME_LENGTH - 1) != frame[JK_FRAME_LENGTH - 1]) {
        return false;
    }

    if (result == NULL) {
        return true;
    }

    memset(result, 0, sizeof(*result));

    // Voltage thresholds (scale 0.001 V)
    result->smart_sleep_voltage_v = read_u32_le(&frame[6]) * 0.001f;
    result->cell_uvp_v = read_u32_le(&frame[10]) * 0.001f;
    result->cell_uvpr_v = read_u32_le(&frame[14]) * 0.001f;
    result->cell_ovp_v = read_u32_le(&frame[18]) * 0.001f;
    result->cell_ovpr_v = read_u32_le(&frame[22]) * 0.001f;
    result->balance_trigger_voltage_v = read_u32_le(&frame[26]) * 0.001f;
    result->cell_soc100_voltage_v = read_u32_le(&frame[30]) * 0.001f;
    result->cell_soc0_voltage_v = read_u32_le(&frame[34]) * 0.001f;
    result->cell_request_charge_voltage_v = read_u32_le(&frame[38]) * 0.001f;
    result->cell_request_float_voltage_v = read_u32_le(&frame[42]) * 0.001f;
    result->power_off_voltage_v = read_u32_le(&frame[46]) * 0.001f;
    result->start_balance_voltage_v = read_u32_le(&frame[138]) * 0.001f;

    // Current limits & delays
    result->max_charge_current_a = read_u32_le(&frame[50]) * 0.001f;
    result->charge_ocp_delay_s = read_u32_le(&frame[54]);
    result->charge_ocpr_time_s = read_u32_le(&frame[58]);
    result->max_discharge_current_a = read_u32_le(&frame[62]) * 0.001f;
    result->discharge_ocp_delay_s = read_u32_le(&frame[66]);
    result->discharge_ocpr_time_s = read_u32_le(&frame[70]);
    result->scpr_time_s = read_u32_le(&frame[74]);
    result->max_balance_current_a = read_u32_le(&frame[78]) * 0.001f;
    result->scp_delay_us = read_u32_le(&frame[134]);
    result->discharge_precharge_time_s = frame[274];

    // Temperature protections (scale 0.1 °C for 32-bit signed, 1.0 °C for 8-bit signed)
    result->charge_otp_c = (int32_t) read_u32_le(&frame[82]) * 0.1f;
    result->charge_otpr_c = (int32_t) read_u32_le(&frame[86]) * 0.1f;
    result->discharge_otp_c = (int32_t) read_u32_le(&frame[90]) * 0.1f;
    result->discharge_otpr_c = (int32_t) read_u32_le(&frame[94]) * 0.1f;
    result->charge_utp_c = (int32_t) read_u32_le(&frame[98]) * 0.1f;
    result->charge_utpr_c = (int32_t) read_u32_le(&frame[102]) * 0.1f;
    result->mosfet_otp_c = (int32_t) read_u32_le(&frame[106]) * 0.1f;
    result->mosfet_otpr_c = (int32_t) read_u32_le(&frame[110]) * 0.1f;
    result->heating_start_temp_c = (int8_t) frame[284];
    result->heating_stop_temp_c = (int8_t) frame[285];
    result->discharge_utp_c = (int8_t) frame[296];
    result->discharge_utpr_c = (int8_t) frame[297];

    // Battery pack configuration
    result->cell_count = (uint8_t) read_u32_le(&frame[114]);
    result->nominal_capacity_ah = read_u32_le(&frame[130]) * 0.001f;
    result->device_address = frame[270];

    // Core switches
    result->charge_switch = frame[118] != 0;
    result->discharge_switch = frame[122] != 0;
    result->balancer_switch = frame[126] != 0;

    // Advanced function switches (byte 282 & 283)
    const uint8_t mask282 = frame[282];
    result->heating_switch = (mask282 & 0x01) != 0;
    result->disable_temperature_sensors = (mask282 & 0x02) != 0;
    result->gps_heartbeat = (mask282 & 0x04) != 0;
    result->port_switch_rs485 = (mask282 & 0x08) != 0;
    result->display_always_on = (mask282 & 0x10) != 0;
    result->special_charger = (mask282 & 0x20) != 0;
    result->smart_sleep_switch = (mask282 & 0x40) != 0;
    result->disable_pcl_module = (mask282 & 0x80) != 0;

    const uint8_t mask283 = frame[283];
    result->timed_stored_data = (mask283 & 0x01) != 0;
    result->charging_float_mode = (mask283 & 0x02) != 0;

    // Timers
    result->smart_sleep_time_hours = frame[286];

    // Wire resistances (up to 16 cells, scale 0.001 Ohm)
    for (uint8_t i = 0; i < JK_BMS_MAX_CELLS; ++i) {
        result->wire_resistance_ohm[i] = read_u32_le(&frame[142 + i * 4]) * 0.001f;
    }

    result->valid = true;
    return true;



}

static void extract_string(const uint8_t *src, size_t src_len, char *dst, size_t dst_size) {
    if (!dst || dst_size == 0) return;
    size_t i = 0;
    while (i < src_len && i < dst_size - 1 && src[i] != '\0' && (src[i] >= 32 && src[i] <= 126)) {
        dst[i] = (char) src[i];
        i++;
    }
    while (i > 0 && dst[i - 1] == ' ') {
        i--;
    }
    dst[i] = '\0';
}

static bool decode_device_info(const uint8_t *frame, jk_bms_device_info_t *result) {
    if (frame[4] != JK_FRAME_TYPE_DEVICE_INFO ||
        crc8_sum(frame, JK_FRAME_LENGTH - 1) != frame[JK_FRAME_LENGTH - 1]) {
        return false;
    }

    if (result == NULL) {
        return true;
    }

    memset(result, 0, sizeof(*result));
    extract_string(&frame[6], 16, result->model, sizeof(result->model));
    extract_string(&frame[22], 8, result->hardware_version, sizeof(result->hardware_version));
    extract_string(&frame[30], 8, result->software_version, sizeof(result->software_version));
    result->uptime_seconds = read_u32_le(&frame[38]);
    result->power_on_count = read_u32_le(&frame[42]);
    extract_string(&frame[46], 16, result->device_name, sizeof(result->device_name));
    extract_string(&frame[62], 8, result->passcode, sizeof(result->passcode));
    extract_string(&frame[78], 8, result->manufacturing_date, sizeof(result->manufacturing_date));
    extract_string(&frame[86], 11, result->serial_number, sizeof(result->serial_number));
    extract_string(&frame[102], 16, result->user_data, sizeof(result->user_data));
    extract_string(&frame[118], 16, result->setup_passcode, sizeof(result->setup_passcode));
    result->valid = true;
    return true;
}

void jk_bms_parser_reset(jk_bms_parser_t *parser) {
    parser->length = 0;
}

uint8_t jk_bms_parser_push(jk_bms_parser_t *parser, const uint8_t *data, size_t length,
                           jk_bms_data_t *telemetry_out, jk_bms_settings_t *settings_out,
                           jk_bms_device_info_t *device_info_out) {
    if (is_preamble(data, length)) {
        jk_bms_parser_reset(parser);
    }
    if (length > sizeof(parser->bytes) - parser->length) {
        jk_bms_parser_reset(parser);
        return JK_FRAME_TYPE_NONE;
    }

    memcpy(&parser->bytes[parser->length], data, length);
    parser->length += length;
    if (parser->length < JK_FRAME_LENGTH) {
        return JK_FRAME_TYPE_NONE;
    }

    const uint8_t frame_type = parser->bytes[4];
    uint8_t decoded_type = JK_FRAME_TYPE_NONE;

    if (frame_type == JK_FRAME_TYPE_CELL_INFO) {
        if (decode_cell_info(parser->bytes, telemetry_out)) {
            decoded_type = JK_FRAME_TYPE_CELL_INFO;
        }
    } else if (frame_type == JK_FRAME_TYPE_SETTINGS) {
        if (decode_settings_info(parser->bytes, settings_out)) {
            decoded_type = JK_FRAME_TYPE_SETTINGS;
        }
    } else if (frame_type == JK_FRAME_TYPE_DEVICE_INFO) {
        if (decode_device_info(parser->bytes, device_info_out)) {
            decoded_type = JK_FRAME_TYPE_DEVICE_INFO;
        }
    }

    jk_bms_parser_reset(parser);
    return decoded_type;
}

const char *jk_bms_battery_chemistry_str(uint8_t type_id) {
    switch (type_id) {
        case 0x00: return "LFP";
        case 0x01: return "Li-ion";
        case 0x02: return "LTO";
        default:   return "Unknown";
    }
}

bool jk_bms_cell_index_valid(uint8_t index, uint8_t cell_count) {
    return index < cell_count;
}
