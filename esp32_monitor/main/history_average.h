#pragma once

#include <stdint.h>

#include "temperature_profiles.h"

typedef struct {
    double pack_voltage_sum;
    double current_sum;
    uint32_t soc_sum;
    uint32_t common_samples;
    uint8_t cell_count;
    uint32_t cell_active_mask;
    uint8_t temp_present_mask;

    double cell_voltage_sum[JK_BMS_MAX_CELLS];
    uint32_t cell_sample_count[JK_BMS_MAX_CELLS];

    double temp_sum[JK_BMS_MAX_TEMPS];
    uint32_t temp_sample_count[JK_BMS_MAX_TEMPS];
} wattpost_history_average_t;

static inline void wattpost_history_average_add_with_caps(wattpost_history_average_t *average,
                                                         const jk_bms_data_t *data,
                                                         const temp_capabilities_t *caps) {
    if (average == NULL || data == NULL || !data->valid) {
        return;
    }

    average->pack_voltage_sum += data->pack_voltage_v;
    average->current_sum += data->current_a;
    average->soc_sum += data->state_of_charge;
    average->common_samples++;
    average->cell_count = data->cell_count;
    average->cell_active_mask |= data->cell_active_mask;

    for (uint8_t cell = 0; cell < JK_BMS_MAX_CELLS; ++cell) {
        if ((data->cell_active_mask & (1u << cell)) && data->cell_voltage_v[cell] > 0.5f) {
            average->cell_voltage_sum[cell] += data->cell_voltage_v[cell];
            average->cell_sample_count[cell]++;
        }
    }

    for (uint8_t temp = 0; temp < JK_BMS_MAX_TEMPS; ++temp) {
        if (caps != NULL) {
            const temp_channel_info_t *ch = &caps->channels[temp];
            if (ch->presence == TEMP_PRESENCE_PRESENT && ch->value_valid && ch->enabled && ch->alias_of == NULL) {
                average->temp_sum[temp] += ch->val_c;
                average->temp_sample_count[temp]++;
                average->temp_present_mask |= (1u << temp);
            }
        } else {
            if ((data->temp_present_mask & (1u << temp)) && data->temperatures_c[temp] > -100.0f) {
                average->temp_sum[temp] += data->temperatures_c[temp];
                average->temp_sample_count[temp]++;
                average->temp_present_mask |= (1u << temp);
            }
        }
    }
}

static inline void wattpost_history_average_add(wattpost_history_average_t *average,
                                                const jk_bms_data_t *data) {
    wattpost_history_average_add_with_caps(average, data, NULL);
}


static inline double wattpost_history_average_common(double sum,
                                                      const wattpost_history_average_t *average) {
    return (average && average->common_samples) ? sum / average->common_samples : 0.0;
}

static inline double wattpost_history_average_cell(const wattpost_history_average_t *average,
                                                    uint8_t cell) {
    if (average == NULL || cell >= JK_BMS_MAX_CELLS || average->cell_sample_count[cell] == 0) {
        return 0.0;
    }
    return average->cell_voltage_sum[cell] / average->cell_sample_count[cell];
}

static inline double wattpost_history_average_temp(const wattpost_history_average_t *average,
                                                    uint8_t temp) {
    if (average == NULL || temp >= JK_BMS_MAX_TEMPS || average->temp_sample_count[temp] == 0) {
        return 0.0;
    }
    return average->temp_sum[temp] / average->temp_sample_count[temp];
}

