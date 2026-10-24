#include "cloud_transport_format.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

static const char BASE64URL[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

static bool appendf(
    char *output,
    size_t output_size,
    size_t *used,
    const char *format,
    ...) {
    if (!output || !used || !format || *used >= output_size) {
        return false;
    }

    va_list args;
    va_start(args, format);
    const int written = vsnprintf(
        output + *used,
        output_size - *used,
        format,
        args);
    va_end(args);

    if (written < 0 || (size_t) written >= output_size - *used) {
        if (output_size > 0u) {
            output[0] = '\0';
        }
        *used = 0u;
        return false;
    }

    *used += (size_t) written;
    return true;
}

bool wattpost_cloud_format_device_id(
    const uint8_t device_id[WATTPOST_DEVICE_ID_BYTES],
    char *output,
    size_t output_size) {
    static const char HEX[] = "0123456789abcdef";
    if (!device_id || !output ||
        output_size < WATTPOST_CLOUD_DEVICE_ID_HEX_LEN + 1u) {
        return false;
    }

    for (size_t i = 0; i < WATTPOST_DEVICE_ID_BYTES; ++i) {
        output[i * 2u] = HEX[device_id[i] >> 4];
        output[i * 2u + 1u] = HEX[device_id[i] & 0x0Fu];
    }
    output[WATTPOST_CLOUD_DEVICE_ID_HEX_LEN] = '\0';
    return true;
}

bool wattpost_cloud_format_device_secret(
    const uint8_t device_secret[WATTPOST_DEVICE_SECRET_BYTES],
    char *output,
    size_t output_size) {
    if (!device_secret || !output ||
        output_size < WATTPOST_CLOUD_DEVICE_SECRET_B64_LEN + 1u) {
        return false;
    }

    size_t in = 0;
    size_t out = 0;
    while (in + 3u <= WATTPOST_DEVICE_SECRET_BYTES) {
        const uint32_t value =
            ((uint32_t) device_secret[in] << 16) |
            ((uint32_t) device_secret[in + 1u] << 8) |
            (uint32_t) device_secret[in + 2u];
        output[out++] = BASE64URL[(value >> 18) & 0x3Fu];
        output[out++] = BASE64URL[(value >> 12) & 0x3Fu];
        output[out++] = BASE64URL[(value >> 6) & 0x3Fu];
        output[out++] = BASE64URL[value & 0x3Fu];
        in += 3u;
    }

    const size_t remaining = WATTPOST_DEVICE_SECRET_BYTES - in;
    if (remaining == 1u) {
        const uint32_t value = (uint32_t) device_secret[in] << 16;
        output[out++] = BASE64URL[(value >> 18) & 0x3Fu];
        output[out++] = BASE64URL[(value >> 12) & 0x3Fu];
    } else if (remaining == 2u) {
        const uint32_t value =
            ((uint32_t) device_secret[in] << 16) |
            ((uint32_t) device_secret[in + 1u] << 8);
        output[out++] = BASE64URL[(value >> 18) & 0x3Fu];
        output[out++] = BASE64URL[(value >> 12) & 0x3Fu];
        output[out++] = BASE64URL[(value >> 6) & 0x3Fu];
    }

    if (out != WATTPOST_CLOUD_DEVICE_SECRET_B64_LEN) {
        memset(output, 0, output_size);
        return false;
    }
    output[out] = '\0';
    return true;
}

bool wattpost_cloud_format_authorization(
    const wattpost_device_identity_t *identity,
    char *output,
    size_t output_size) {
    if (!identity || !output) {
        return false;
    }

    char device_id[WATTPOST_CLOUD_DEVICE_ID_HEX_LEN + 1u];
    char secret[WATTPOST_CLOUD_DEVICE_SECRET_B64_LEN + 1u];
    if (!wattpost_cloud_format_device_id(
            identity->device_id, device_id, sizeof(device_id)) ||
        !wattpost_cloud_format_device_secret(
            identity->device_secret, secret, sizeof(secret))) {
        memset(device_id, 0, sizeof(device_id));
        memset(secret, 0, sizeof(secret));
        return false;
    }

    const int written = snprintf(
        output,
        output_size,
        "WattPostDevice %s.%s",
        device_id,
        secret);
    memset(device_id, 0, sizeof(device_id));
    memset(secret, 0, sizeof(secret));
    if (written <= 0 || (size_t) written >= output_size) {
        if (output_size > 0) {
            memset(output, 0, output_size);
        }
        return false;
    }
    return true;
}

bool wattpost_cloud_format_epoch(
    uint32_t ownership_epoch,
    char *output,
    size_t output_size) {
    if (!output || ownership_epoch == 0u) {
        return false;
    }
    const int written = snprintf(
        output, output_size, "%lu", (unsigned long) ownership_epoch);
    return written > 0 && (size_t) written < output_size;
}

static bool metadata_safe(const char *value) {
    if (!value || value[0] == '\0' || strlen(value) > 64u) {
        return false;
    }
    for (const unsigned char *p = (const unsigned char *) value; *p; ++p) {
        if (*p < 0x20u || *p == '"' || *p == '\\') {
            return false;
        }
    }
    return true;
}

bool wattpost_cloud_format_hello_json(
    const char *firmware_version,
    const char *build_id,
    uint32_t history_floor_timestamp,
    char *output,
    size_t output_size) {
    if (!metadata_safe(firmware_version) ||
        !metadata_safe(build_id) ||
        !output) {
        return false;
    }

    const bool floor_valid =
        history_floor_timestamp >= 1700000000u &&
        history_floor_timestamp <= 4102444800u;
    const int written = floor_valid
        ? snprintf(
            output,
            output_size,
            "{\"schema_version\":1,"
            "\"firmware_version\":\"%s\","
            "\"build_id\":\"%s\","
            "\"history_floor_timestamp\":%lu}",
            firmware_version,
            build_id,
            (unsigned long) history_floor_timestamp)
        : snprintf(
            output,
            output_size,
            "{\"schema_version\":1,"
            "\"firmware_version\":\"%s\","
            "\"build_id\":\"%s\"}",
            firmware_version,
            build_id);
    return written > 0 && (size_t) written < output_size;
}

static bool finite_in_range(float value, float minimum, float maximum) {
    return isfinite(value) && value >= minimum && value <= maximum;
}

static bool temperature_id_valid(const char *id) {
    static const char *const allowed[] = {
        "mos", "t1", "t2", "ext254", "ext256", "ext258",
    };
    if (!id) {
        return false;
    }
    for (size_t i = 0u; i < sizeof(allowed) / sizeof(allowed[0]); ++i) {
        if (strcmp(id, allowed[i]) == 0) {
            return true;
        }
    }
    return false;
}

static bool telemetry_valid(
    const wattpost_cloud_telemetry_t *telemetry) {
    if (!telemetry ||
        telemetry->boot_count == 0u ||
        telemetry->sample_seq == 0u ||
        telemetry->cell_count > WATTPOST_CLOUD_TELEMETRY_MAX_CELLS ||
        telemetry->temperature_count > WATTPOST_CLOUD_TELEMETRY_MAX_TEMPS ||
        (telemetry->internet_reachable && !telemetry->wifi_connected) ||
        (telemetry->data_fresh && !telemetry->bms_connected)) {
        return false;
    }

    if (!telemetry->data_fresh) {
        return telemetry->cell_count == 0u &&
               telemetry->temperature_count == 0u;
    }

    if (telemetry->cell_count == 0u ||
        telemetry->soc > 100u ||
        !finite_in_range(telemetry->voltage_v, 0.0f, 1000.0f) ||
        !finite_in_range(telemetry->current_a, -10000.0f, 10000.0f) ||
        !finite_in_range(telemetry->power_w, -10000000.0f, 10000000.0f) ||
        !finite_in_range(telemetry->min_cell_voltage_v, 0.0f, 10.0f) ||
        !finite_in_range(telemetry->max_cell_voltage_v, 0.0f, 10.0f) ||
        !finite_in_range(telemetry->cell_spread_v, 0.0f, 10.0f) ||
        telemetry->min_cell_voltage_v > telemetry->max_cell_voltage_v) {
        return false;
    }

    if (telemetry->cell_indices_valid &&
        (telemetry->max_cell_index >= telemetry->cell_count ||
         telemetry->min_cell_index >= telemetry->cell_count)) {
        return false;
    }

    if (telemetry->remaining_capacity_valid &&
        !finite_in_range(
            telemetry->remaining_capacity_ah, 0.0f, 1000000.0f)) {
        return false;
    }
    if (telemetry->nominal_capacity_valid &&
        !finite_in_range(
            telemetry->nominal_capacity_ah, 0.0f, 1000000.0f)) {
        return false;
    }

    for (uint8_t i = 0u; i < telemetry->cell_count; ++i) {
        if (!finite_in_range(telemetry->cells_v[i], 0.0f, 10.0f)) {
            return false;
        }
    }
    for (uint8_t i = 0u; i < telemetry->temperature_count; ++i) {
        if (!finite_in_range(telemetry->temperatures_c[i], -100.0f, 200.0f) ||
            !temperature_id_valid(telemetry->temperature_ids[i])) {
            return false;
        }
        for (uint8_t previous = 0u; previous < i; ++previous) {
            if (strcmp(telemetry->temperature_ids[i],
                       telemetry->temperature_ids[previous]) == 0) {
                return false;
            }
        }
    }

    return true;
}

static const char *charger_status(
    const wattpost_cloud_telemetry_t *telemetry) {
    if (!telemetry->data_fresh) {
        return "unknown";
    }
    if (telemetry->current_a > 0.05f) {
        return "charging";
    }
    if (telemetry->current_a < -0.05f) {
        return "discharging";
    }
    return "idle";
}

bool wattpost_cloud_format_telemetry_json(
    const wattpost_cloud_telemetry_t *telemetry,
    const char *firmware_version,
    const char *build_id,
    char *output,
    size_t output_size) {
    if (!output || output_size == 0u ||
        !metadata_safe(firmware_version) ||
        !metadata_safe(build_id) ||
        !telemetry_valid(telemetry)) {
        return false;
    }

    size_t used = 0u;
    output[0] = '\0';

    if (!appendf(
            output,
            output_size,
            &used,
            "{\"schema_version\":1,"
            "\"boot_count\":%lu,"
            "\"sample_seq\":%lu,"
            "\"device_uptime_s\":%lu,"
            "\"firmware_version\":\"%s\","
            "\"build_id\":\"%s\","
            "\"bms\":{\"connected\":%s,\"data_fresh\":%s},"
            "\"network\":{\"wifi_connected\":%s,"
            "\"internet_reachable\":%s},"
            "\"battery\":{",
            (unsigned long) telemetry->boot_count,
            (unsigned long) telemetry->sample_seq,
            (unsigned long) telemetry->device_uptime_s,
            firmware_version,
            build_id,
            telemetry->bms_connected ? "true" : "false",
            telemetry->data_fresh ? "true" : "false",
            telemetry->wifi_connected ? "true" : "false",
            telemetry->internet_reachable ? "true" : "false")) {
        return false;
    }

    if (!telemetry->data_fresh) {
        return appendf(
            output,
            output_size,
            &used,
            "\"voltage_v\":null,"
            "\"current_a\":null,"
            "\"power_w\":null,"
            "\"soc\":null,"
            "\"remaining_capacity_ah\":null,"
            "\"nominal_capacity_ah\":null,"
            "\"charger_status\":\"unknown\","
            "\"cell_count\":0,"
            "\"min_cell_voltage_v\":null,"
            "\"max_cell_voltage_v\":null,"
            "\"cell_spread_v\":null,"
            "\"max_cell_index\":null,"
            "\"min_cell_index\":null,"
            "\"cells_v\":[],"
            "\"temperatures_c\":[],"
            "\"temperature_ids\":[]}}");
    }

    if (!appendf(
            output,
            output_size,
            &used,
            "\"voltage_v\":%.3f,"
            "\"current_a\":%.3f,"
            "\"power_w\":%.1f,"
            "\"soc\":%u,"
            "\"remaining_capacity_ah\":",
            telemetry->voltage_v,
            telemetry->current_a,
            telemetry->power_w,
            (unsigned int) telemetry->soc)) {
        return false;
    }

    if (telemetry->remaining_capacity_valid) {
        if (!appendf(
                output,
                output_size,
                &used,
                "%.3f",
                telemetry->remaining_capacity_ah)) {
            return false;
        }
    } else if (!appendf(output, output_size, &used, "null")) {
        return false;
    }

    if (!appendf(
            output,
            output_size,
            &used,
            ",\"nominal_capacity_ah\":")) {
        return false;
    }
    if (telemetry->nominal_capacity_valid) {
        if (!appendf(
                output,
                output_size,
                &used,
                "%.3f",
                telemetry->nominal_capacity_ah)) {
            return false;
        }
    } else if (!appendf(output, output_size, &used, "null")) {
        return false;
    }

    if (!appendf(
            output,
            output_size,
            &used,
            ",\"charger_status\":\"%s\","
            "\"cell_count\":%u,"
            "\"min_cell_voltage_v\":%.3f,"
            "\"max_cell_voltage_v\":%.3f,"
            "\"cell_spread_v\":%.3f,"
            "\"max_cell_index\":",
            charger_status(telemetry),
            (unsigned int) telemetry->cell_count,
            telemetry->min_cell_voltage_v,
            telemetry->max_cell_voltage_v,
            telemetry->cell_spread_v)) {
        return false;
    }

    if (telemetry->cell_indices_valid) {
        if (!appendf(
                output,
                output_size,
                &used,
                "%u",
                (unsigned int) telemetry->max_cell_index)) {
            return false;
        }
    } else if (!appendf(output, output_size, &used, "null")) {
        return false;
    }

    if (!appendf(output, output_size, &used, ",\"min_cell_index\":")) {
        return false;
    }
    if (telemetry->cell_indices_valid) {
        if (!appendf(
                output,
                output_size,
                &used,
                "%u",
                (unsigned int) telemetry->min_cell_index)) {
            return false;
        }
    } else if (!appendf(output, output_size, &used, "null")) {
        return false;
    }

    if (!appendf(output, output_size, &used, ",\"cells_v\":[")) {
        return false;
    }

    for (uint8_t i = 0u; i < telemetry->cell_count; ++i) {
        if (!appendf(
                output,
                output_size,
                &used,
                "%s%.3f",
                i == 0u ? "" : ",",
                telemetry->cells_v[i])) {
            return false;
        }
    }

    if (!appendf(
            output,
            output_size,
            &used,
            "],\"temperatures_c\":[")) {
        return false;
    }

    for (uint8_t i = 0u; i < telemetry->temperature_count; ++i) {
        if (!appendf(
                output,
                output_size,
                &used,
                "%s%.1f",
                i == 0u ? "" : ",",
                telemetry->temperatures_c[i])) {
            return false;
        }
    }

    if (!appendf(
            output,
            output_size,
            &used,
            "],\"temperature_ids\":[")) {
        return false;
    }

    for (uint8_t i = 0u; i < telemetry->temperature_count; ++i) {
        if (!appendf(
                output,
                output_size,
                &used,
                "%s\"%s\"",
                i == 0u ? "" : ",",
                telemetry->temperature_ids[i])) {
            return false;
        }
    }

    return appendf(output, output_size, &used, "]}}");
}
