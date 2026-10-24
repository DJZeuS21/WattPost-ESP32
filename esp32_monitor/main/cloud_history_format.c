#include "cloud_history_format.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

enum {
    HISTORY_MIN_TIMESTAMP = 1700000000u,
    HISTORY_MAX_TIMESTAMP = 4102444800u,
    HISTORY_MAX_PACK_MILLIVOLTS = 1000000u,
    HISTORY_CELL_MASK = 0xFFFFu,
    HISTORY_TEMP_MASK = 0x3Fu,
};

static void fail(wattpost_cloud_history_formatter_t *formatter) {
    if (formatter == NULL) {
        return;
    }
    formatter->failed = true;
    formatter->used = 0u;
    if (formatter->json != NULL && formatter->capacity > 0u) {
        formatter->json[0] = '\0';
    }
}

static bool appendf(
    wattpost_cloud_history_formatter_t *formatter,
    const char *format,
    ...) {
    if (formatter == NULL || formatter->json == NULL || format == NULL ||
        formatter->failed || formatter->used >= formatter->capacity) {
        fail(formatter);
        return false;
    }

    va_list args;
    va_start(args, format);
    const int written = vsnprintf(
        formatter->json + formatter->used,
        formatter->capacity - formatter->used,
        format,
        args);
    va_end(args);

    if (written < 0 || (size_t) written >= formatter->capacity - formatter->used) {
        fail(formatter);
        return false;
    }
    formatter->used += (size_t) written;
    return true;
}

static bool record_valid(const wattpost_history_record_t *record) {
    if (record == NULL ||
        record->version != WATTPOST_HISTORY_VERSION ||
        record->timestamp < HISTORY_MIN_TIMESTAMP ||
        record->timestamp > HISTORY_MAX_TIMESTAMP ||
        record->pack_voltage_mv == 0u ||
        record->pack_voltage_mv > HISTORY_MAX_PACK_MILLIVOLTS ||
        record->state_of_charge > 100u ||
        record->cell_count == 0u ||
        record->cell_count > 16u ||
        record->cell_active_mask == 0u ||
        (record->cell_active_mask & ~HISTORY_CELL_MASK) != 0u ||
        record->temp_present_mask > HISTORY_TEMP_MASK ||
        record->crc16 != wattpost_history_calc_crc16(record)) {
        return false;
    }

    uint32_t cell_count = 0u;
    for (uint8_t index = 0u; index < 16u; ++index) {
        if ((record->cell_active_mask & (1u << index)) == 0u) {
            continue;
        }
        ++cell_count;
        if (record->cell_voltage_mv[index] < 500u ||
            record->cell_voltage_mv[index] > 6000u) {
            return false;
        }
    }
    if (cell_count != record->cell_count) {
        return false;
    }

    for (uint8_t index = 0u; index < 6u; ++index) {
        if ((record->temp_present_mask & (1u << index)) != 0u &&
            (record->temperature_deci_c[index] < -1000 ||
             record->temperature_deci_c[index] > 2000)) {
            return false;
        }
    }
    return true;
}

bool wattpost_cloud_history_format_init(
    wattpost_cloud_history_formatter_t *formatter,
    char *json,
    size_t capacity) {
    if (formatter == NULL || json == NULL || capacity == 0u ||
        capacity > WATTPOST_CLOUD_HISTORY_JSON_MAX_LEN) {
        return false;
    }
    memset(formatter, 0, sizeof(*formatter));
    formatter->json = json;
    formatter->capacity = capacity;
    json[0] = '\0';
    return appendf(formatter, "{\"schema_version\":1,\"records\":[");
}

bool wattpost_cloud_history_format_append(
    wattpost_cloud_history_formatter_t *formatter,
    const wattpost_history_record_t *record) {
    if (formatter == NULL || formatter->failed || formatter->finished ||
        formatter->count >= WATTPOST_CLOUD_HISTORY_MAX_RECORDS ||
        !record_valid(record) ||
        (formatter->count > 0u && record->timestamp <= formatter->last_timestamp)) {
        fail(formatter);
        return false;
    }

    if (!appendf(
            formatter,
            "%s{\"t\":%lu,\"v\":%.3f,\"a\":%.1f,\"s\":%u,"
            "\"cell_count\":%u,\"cell_mask\":%lu,\"temp_mask\":%u,\"cells\":[",
            formatter->count == 0u ? "" : ",",
            (unsigned long) record->timestamp,
            (double) record->pack_voltage_mv / 1000.0,
            (double) record->current_deci_a / 10.0,
            (unsigned int) record->state_of_charge,
            (unsigned int) record->cell_count,
            (unsigned long) record->cell_active_mask,
            (unsigned int) record->temp_present_mask)) {
        return false;
    }

    bool first_cell = true;
    for (uint8_t index = 0u; index < 16u; ++index) {
        if ((record->cell_active_mask & (1u << index)) == 0u) {
            continue;
        }
        if (!appendf(
                formatter,
                "%s%u",
                first_cell ? "" : ",",
                (unsigned int) record->cell_voltage_mv[index])) {
            return false;
        }
        first_cell = false;
    }

    if (!appendf(formatter, "],\"temps\":[")) {
        return false;
    }
    for (uint8_t index = 0u; index < 6u; ++index) {
        if (!appendf(
                formatter,
                "%s",
                index == 0u ? "" : ",")) {
            return false;
        }
        if ((record->temp_present_mask & (1u << index)) != 0u) {
            if (!appendf(
                    formatter,
                    "%d",
                    (int) record->temperature_deci_c[index])) {
                return false;
            }
        } else if (!appendf(formatter, "null")) {
            return false;
        }
    }

    if (!appendf(formatter, "]}")) {
        return false;
    }
    ++formatter->count;
    formatter->last_timestamp = record->timestamp;
    return true;
}

bool wattpost_cloud_history_format_finish(
    wattpost_cloud_history_formatter_t *formatter) {
    if (formatter == NULL || formatter->failed || formatter->finished ||
        formatter->count == 0u) {
        fail(formatter);
        return false;
    }
    if (!appendf(formatter, "]}")) {
        return false;
    }
    formatter->finished = true;
    return true;
}
