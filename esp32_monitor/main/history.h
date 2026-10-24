#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "history_query.h"
#include "jk_bms_parser.h"
#include "temperature_profiles.h"


#define WATTPOST_HISTORY_VERSION 2

typedef struct __attribute__((packed)) {
    uint8_t version;
    uint32_t timestamp;
    uint32_t pack_voltage_mv;
    int16_t current_deci_a;
    uint8_t state_of_charge;
    uint8_t cell_count;
    uint32_t cell_active_mask;
    uint8_t temp_present_mask;
    uint16_t cell_voltage_mv[16];
    int16_t temperature_deci_c[6];
    uint16_t crc16;
} wattpost_history_record_t;

_Static_assert(sizeof(wattpost_history_record_t) == 64, "Формат історії має бути строго 64-байтовим");

typedef bool (*wattpost_history_visitor_t)(const wattpost_history_record_t *record, void *context);

static inline uint16_t wattpost_history_calc_crc16(const wattpost_history_record_t *record) {
    if (record == NULL) {
        return 0;
    }
    const uint8_t *bytes = (const uint8_t *) record;
    const size_t len = offsetof(wattpost_history_record_t, crc16);
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < len; ++i) {
        crc ^= (uint16_t) bytes[i];
        for (uint8_t bit = 0; bit < 8; ++bit) {
            if (crc & 1) {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }
    return crc;
}

bool wattpost_history_init(void);
bool wattpost_history_erase(void);
uint32_t wattpost_history_newest_timestamp(void);
void wattpost_history_save(const jk_bms_data_t *data);
void wattpost_history_save_with_caps(const jk_bms_data_t *data, const temp_capabilities_t *caps);

void wattpost_history_visit_recent(wattpost_history_visitor_t visitor, void *context);
void wattpost_history_visit_window(const wattpost_history_query_t *query,
                                   wattpost_history_visitor_t visitor, void *context);
