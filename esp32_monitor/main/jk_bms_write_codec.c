#include "jk_bms_write_codec.h"

#include <float.h>
#include <limits.h>
#include <math.h>
#include <stddef.h>
#include <string.h>

/* Deliberately independent of JK_SETTINGS_META: reading offsets and writable
 * registers are not interchangeable (for example: 0x1E/0x1F vs 0x3A/0x3B).
 * Protocol basis: syssi/esphome-jk-bms JK02_32S number/switch registries
 * and documented 20-byte write frame. Physical BMS acceptance NOT verified.
 */
#define UF(key, reg, len, factor, field) \
    {key, reg, len, JK_BMS_WRITE_UNSIGNED, JK_BMS_WRITE_READ_FLOAT, factor, offsetof(jk_bms_settings_t, field)}
#define SF(key, reg, len, factor, field) \
    {key, reg, len, JK_BMS_WRITE_SIGNED, JK_BMS_WRITE_READ_FLOAT, factor, offsetof(jk_bms_settings_t, field)}
#define U32(key, reg, len, field) \
    {key, reg, len, JK_BMS_WRITE_UNSIGNED, JK_BMS_WRITE_READ_U32, 1, offsetof(jk_bms_settings_t, field)}
#define U8(key, reg, len, field) \
    {key, reg, len, JK_BMS_WRITE_UNSIGNED, JK_BMS_WRITE_READ_U8, 1, offsetof(jk_bms_settings_t, field)}
#define I8(key, reg, field) \
    {key, reg, 1, JK_BMS_WRITE_SIGNED, JK_BMS_WRITE_READ_I8, 1, offsetof(jk_bms_settings_t, field)}
#define B(key, reg, field) \
    {key, reg, 4, JK_BMS_WRITE_BOOLEAN, JK_BMS_WRITE_READ_BOOL, 1, offsetof(jk_bms_settings_t, field)}

static const jk_bms_write_spec_t write_specs[] = {
    U8("battery.cell_count", 0x1C, 4, cell_count),
    UF("battery.nominal_capacity_ah", 0x20, 4, 1000, nominal_capacity_ah),
    /* battery.device_address: no verified write register */

    UF("cell_voltage.ovp_v", 0x04, 4, 1000, cell_ovp_v),
    UF("cell_voltage.ovpr_v", 0x05, 4, 1000, cell_ovpr_v),
    UF("cell_voltage.request_charge_v", 0x09, 4, 1000, cell_request_charge_voltage_v),
    UF("cell_voltage.request_float_v", 0x0A, 4, 1000, cell_request_float_voltage_v),
    UF("cell_voltage.soc_100_v", 0x07, 4, 1000, cell_soc100_voltage_v),
    UF("cell_voltage.soc_0_v", 0x08, 4, 1000, cell_soc0_voltage_v),
    UF("cell_voltage.start_balance_v", 0x22, 4, 1000, start_balance_voltage_v),
    UF("cell_voltage.uvpr_v", 0x03, 4, 1000, cell_uvpr_v),
    UF("cell_voltage.uvp_v", 0x02, 4, 1000, cell_uvp_v),
    UF("cell_voltage.power_off_v", 0x0B, 4, 1000, power_off_voltage_v),
    /* cell_voltage.smart_sleep_v: conflicting 1-byte write vs 4-byte read */

    B("balancing.enabled", 0x1F, balancer_switch),
    UF("balancing.trigger_delta_v", 0x06, 4, 1000, balance_trigger_voltage_v),
    UF("balancing.start_voltage_v", 0x22, 4, 1000, start_balance_voltage_v),
    UF("balancing.max_current_a", 0x13, 4, 1000, max_balance_current_a),

    UF("current_limits.max_charge_a", 0x0C, 4, 1000, max_charge_current_a),
    U32("current_limits.charge_ocp_delay_s", 0x0D, 4, charge_ocp_delay_s),
    U32("current_limits.charge_ocpr_time_s", 0x0E, 4, charge_ocpr_time_s),
    UF("current_limits.max_discharge_a", 0x0F, 4, 1000, max_discharge_current_a),
    U32("current_limits.discharge_ocp_delay_s", 0x10, 4, discharge_ocp_delay_s),
    U32("current_limits.discharge_ocpr_time_s", 0x11, 4, discharge_ocpr_time_s),
    U32("current_limits.scp_delay_us", 0x21, 4, scp_delay_us),
    U32("current_limits.scpr_time_s", 0x12, 4, scpr_time_s),
    /* Precharge is byte 274, but register 0x25 writes a 4-byte payload.
     * Retained out of the allowlist until readback/storage semantics are clear. */

    SF("temperature.charge_otp_c", 0x14, 4, 10, charge_otp_c),
    SF("temperature.charge_otpr_c", 0x15, 4, 10, charge_otpr_c),
    SF("temperature.charge_utp_c", 0x18, 4, 10, charge_utp_c),
    SF("temperature.charge_utpr_c", 0x19, 4, 10, charge_utpr_c),
    SF("temperature.discharge_otp_c", 0x16, 4, 10, discharge_otp_c),
    SF("temperature.discharge_otpr_c", 0x17, 4, 10, discharge_otpr_c),
    I8("temperature.discharge_utp_c", 0x3A, discharge_utp_c),
    I8("temperature.discharge_utpr_c", 0x3B, discharge_utpr_c),
    SF("temperature.mosfet_otp_c", 0x1A, 4, 10, mosfet_otp_c),
    SF("temperature.mosfet_otpr_c", 0x1B, 4, 10, mosfet_otpr_c),
    I8("temperature.heating_start_c", 0x37, heating_start_temp_c),
    I8("temperature.heating_stop_c", 0x38, heating_stop_temp_c),

    B("switches.charge", 0x1D, charge_switch),
    B("switches.discharge", 0x1E, discharge_switch),
    B("switches.balancer", 0x1F, balancer_switch),
    B("switches.heating", 0x27, heating_switch),
    B("switches.charging_float_mode", 0x30, charging_float_mode),
    B("switches.disable_temperature_sensors", 0x28, disable_temperature_sensors),
    B("switches.display_always_on", 0x2B, display_always_on),
    /* Port mode / GPS heartbeat / special charger: not a proven 1:1 write. */
    B("switches.disable_pcl_module", 0x2E, disable_pcl_module),
    B("switches.timed_stored_data", 0x2F, timed_stored_data),
    B("switches.smart_sleep", 0x2D, smart_sleep_switch),
    U8("sleep.smart_sleep_time_hours", 0x39, 1, smart_sleep_time_hours),
};

const jk_bms_write_spec_t *jk_bms_write_specs(size_t *count) {
    if (count != NULL) {
        *count = sizeof(write_specs) / sizeof(write_specs[0]);
    }
    return write_specs;
}

const jk_bms_write_spec_t *jk_bms_write_find(const char *api_key) {
    if (api_key == NULL) {
        return NULL;
    }
    size_t count;
    const jk_bms_write_spec_t *specs = jk_bms_write_specs(&count);
    for (size_t i = 0; i < count; ++i) {
        if (strcmp(specs[i].api_key, api_key) == 0) {
            return &specs[i];
        }
    }
    return NULL;
}

static bool valid_raw(const jk_bms_write_spec_t *spec, double encoded) {
    if (spec->wire_type == JK_BMS_WRITE_BOOLEAN) {
        return encoded == 0.0 || encoded == 1.0;
    }
    if (spec->wire_type == JK_BMS_WRITE_SIGNED) {
        return spec->payload_length == 1
                   ? encoded >= INT8_MIN && encoded <= INT8_MAX
                   : encoded >= INT32_MIN && encoded <= INT32_MAX;
    }
    return encoded >= 0.0 && encoded <= (spec->payload_length == 1
                                             ? UINT8_MAX : UINT32_MAX);
}

jk_bms_write_status_t jk_bms_write_prepare(const char *api_key,
                                             double value,
                                             jk_bms_write_command_t *command) {
    if (command == NULL) {
        return JK_BMS_WRITE_INVALID;
    }
    memset(command, 0, sizeof(*command));

    const jk_bms_write_spec_t *spec = jk_bms_write_find(api_key);
    if (spec == NULL) {
        return JK_BMS_WRITE_UNSUPPORTED;
    }
    if (!isfinite(value)) {
        return JK_BMS_WRITE_INVALID;
    }
    /* The JK02_32S wire frame is 4 bytes for cell_count, but its settings
     * readback field is a single byte. Never permit a count outside 1..32.
     */
    if (strcmp(api_key, "battery.cell_count") == 0 &&
        (value < 1.0 || value > 32.0)) {
        return JK_BMS_WRITE_INVALID;
    }
    const double scaled = value * (double) spec->scale;
    if (!isfinite(scaled) || !valid_raw(spec, scaled)) {
        return JK_BMS_WRITE_INVALID;
    }
    const double rounded = round(scaled);
    if (fabs(rounded - scaled) > 0.000001) {
        return JK_BMS_WRITE_NOT_REPRESENTABLE;
    }
    const uint32_t raw = spec->wire_type == JK_BMS_WRITE_SIGNED
                             ? (uint32_t) (int32_t) rounded
                             : (uint32_t) rounded;

    command->spec = spec;
    command->raw_value = raw;
    uint8_t *frame = command->frame;
    frame[0] = 0xAA;
    frame[1] = 0x55;
    frame[2] = 0x90;
    frame[3] = 0xEB;
    frame[4] = spec->register_id;
    frame[5] = spec->payload_length;
    for (uint8_t i = 0; i < spec->payload_length; ++i) {
        frame[6 + i] = (uint8_t) (raw >> (8u * i));
    }
    for (size_t i = 0; i < JK_BMS_WRITE_FRAME_LENGTH - 1; ++i) {
        frame[JK_BMS_WRITE_FRAME_LENGTH - 1] += frame[i];
    }
    return JK_BMS_WRITE_OK;
}

jk_bms_write_readback_t jk_bms_write_compare(
    const jk_bms_write_command_t *command,
    const jk_bms_settings_t *settings,
    uint32_t previous_received_count) {
    if (command == NULL || command->spec == NULL ||
        settings == NULL || !settings->valid ||
        settings->received_count <= previous_received_count) {
        return JK_BMS_WRITE_READBACK_UNAVAILABLE;
    }
    const jk_bms_write_spec_t *spec = command->spec;
    const uint8_t *field = ((const uint8_t *) settings) + spec->settings_offset;
    double actual;
    switch (spec->read_kind) {
        case JK_BMS_WRITE_READ_FLOAT: {
            float v;
            memcpy(&v, field, sizeof(v));
            actual = (double) v * spec->scale;
            break;
        }
        case JK_BMS_WRITE_READ_U32: {
            uint32_t v;
            memcpy(&v, field, sizeof(v));
            actual = (double) v;
            break;
        }
        case JK_BMS_WRITE_READ_U8: {
            uint8_t v;
            memcpy(&v, field, sizeof(v));
            actual = (double) v;
            break;
        }
        case JK_BMS_WRITE_READ_I8: {
            int8_t v;
            memcpy(&v, field, sizeof(v));
            actual = (double) v;
            break;
        }
        case JK_BMS_WRITE_READ_BOOL: {
            bool v;
            memcpy(&v, field, sizeof(v));
            actual = v ? 1.0 : 0.0;
            break;
        }
        default:
            return JK_BMS_WRITE_READBACK_UNAVAILABLE;
    }
    if (!isfinite(actual)) {
        return JK_BMS_WRITE_READBACK_UNAVAILABLE;
    }
    /* The JK parser stores scaled U32 settings as float (e.g. raw 200000
     * becomes 200.000015 A after multiplying by 0.001f). Re-scaling to
     * integer milliamps can therefore differ by >0.01, although the wire
     * value was exact. Bound the acceptable float rounding error by its
     * relative precision, but NEVER accept an ambiguous half-raw-unit.
     * This check is shared by the preflight CAS and the post-write readback.
     */
    const double tolerance = spec->read_kind == JK_BMS_WRITE_READ_FLOAT
        ? fmax(0.01, fabs(actual) * (double) FLT_EPSILON * 2.0)
        : 0.01;
    const double rounded = round(actual);
    if (tolerance >= 0.5 || fabs(actual - rounded) > tolerance ||
        rounded < INT32_MIN || rounded > UINT32_MAX) {
        return JK_BMS_WRITE_READBACK_UNAVAILABLE;
    }
    const int64_t integer = (int64_t) rounded;
    const uint32_t observed = (uint32_t) integer &
                              (spec->payload_length == 1 ? 0xFFu : UINT32_MAX);
    const uint32_t expected = command->raw_value &
                              (spec->payload_length == 1 ? 0xFFu : UINT32_MAX);
    return observed == expected ? JK_BMS_WRITE_READBACK_MATCH
                                : JK_BMS_WRITE_READBACK_MISMATCH;
}
