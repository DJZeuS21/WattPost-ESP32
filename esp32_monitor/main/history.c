#include "history.h"
#include "history_average.h"

#include <stddef.h>
#include <string.h>
#include <time.h>

#include "esp_log.h"
#include "esp_partition.h"

enum {
    HISTORY_PAGE_SIZE = 4096,
    HISTORY_INTERVAL_SECONDS = 600,
    HISTORY_EXPORT_POINTS = 14 * 24 * 6,
    HISTORY_MIN_TIMESTAMP = 1700000000,
    HISTORY_MAX_TIMESTAMP = 4102444800,
};

static const char *TAG = "history";
static const esp_partition_t *partition;
static int32_t newest_index = -1;
static uint32_t newest_timestamp;
static int32_t last_erased_sector = -1;
static uint8_t page[HISTORY_PAGE_SIZE];
static wattpost_history_average_t average;

static uint32_t record_count(void) {

    return partition ? (partition->size / sizeof(wattpost_history_record_t)) : 0;
}

static bool valid(const wattpost_history_record_t *record) {
    if (record == NULL ||
        record->version != WATTPOST_HISTORY_VERSION ||
        record->timestamp < HISTORY_MIN_TIMESTAMP ||
        record->timestamp > HISTORY_MAX_TIMESTAMP ||
        record->pack_voltage_mv == 0 ||
        record->cell_count == 0 ||
        record->cell_count > JK_BMS_MAX_CELLS) {
        return false;
    }
    return record->crc16 == wattpost_history_calc_crc16(record);
}

static bool read_record(uint32_t index, wattpost_history_record_t *record) {
    if (partition == NULL || record == NULL) {
        return false;
    }
    return esp_partition_read(partition, index * sizeof(*record), record, sizeof(*record)) == ESP_OK &&
           valid(record);
}

static bool bytes_are_erased(const uint8_t *bytes, size_t size) {
    for (size_t index = 0; index < size; ++index) {
        if (bytes[index] != 0xFF) {
            return false;
        }
    }
    return true;
}

static bool prepare_next_slot(uint32_t *index, size_t *offset) {
    const uint32_t count = record_count();
    if (index == NULL || offset == NULL || count == 0) {
        return false;
    }

    uint32_t candidate = newest_index < 0 ? 0 : ((uint32_t) newest_index + 1) % count;
    for (uint32_t attempts = 0; attempts < count; ++attempts) {
        const size_t candidate_offset = candidate * sizeof(wattpost_history_record_t);
        const uint32_t sector = (uint32_t) (candidate_offset / HISTORY_PAGE_SIZE);
        if ((int32_t) sector != last_erased_sector) {
            if (esp_partition_erase_range(partition, sector * HISTORY_PAGE_SIZE,
                                          HISTORY_PAGE_SIZE) != ESP_OK) {
                ESP_LOGE(TAG, "Не вдалося очистити сектор історії %lu",
                         (unsigned long) sector);
                return false;
            }
            last_erased_sector = (int32_t) sector;
            *index = candidate;
            *offset = candidate_offset;
            return true;
        }

        uint8_t bytes[sizeof(wattpost_history_record_t)];
        if (esp_partition_read(partition, candidate_offset, bytes, sizeof(bytes)) != ESP_OK) {
            ESP_LOGE(TAG, "Не вдалося перевірити слот історії %lu",
                     (unsigned long) candidate);
            return false;
        }
        if (bytes_are_erased(bytes, sizeof(bytes))) {
            *index = candidate;
            *offset = candidate_offset;
            return true;
        }

        ESP_LOGW(TAG, "Пропущено частково записаний слот історії %lu",
                 (unsigned long) candidate);
        candidate = (candidate + 1) % count;
    }
    return false;
}

bool wattpost_history_init(void) {
    partition = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, 0x40, "history");
    if (partition == NULL || partition->size < HISTORY_PAGE_SIZE) {
        ESP_LOGE(TAG, "Розділ історії не знайдено");
        return false;
    }

    newest_index = -1;
    newest_timestamp = 0;
    last_erased_sector = -1;
    bool first_sector_erased = false;

    for (size_t offset = 0; offset < partition->size; offset += sizeof(page)) {
        if (esp_partition_read(partition, offset, page, sizeof(page)) != ESP_OK) {
            ESP_LOGE(TAG, "Не вдалося прочитати історію");
            return false;
        }
        if (offset == 0) {
            first_sector_erased = bytes_are_erased(page, sizeof(page));
        }
        for (size_t index = 0; index < sizeof(page) / sizeof(wattpost_history_record_t); ++index) {
            wattpost_history_record_t record;
            memcpy(&record, page + index * sizeof(record), sizeof(record));
            if (valid(&record) && record.timestamp >= newest_timestamp) {
                newest_timestamp = record.timestamp;
                newest_index = (int32_t) ((offset / sizeof(page)) *
                                          (sizeof(page) / sizeof(record)) + index);
            }
        }
    }

    if (newest_index >= 0) {
        last_erased_sector = (int32_t) ((newest_index * sizeof(wattpost_history_record_t)) / HISTORY_PAGE_SIZE);
        ESP_LOGI(TAG, "Історія v2 готова: останній запис %ld, індекс %ld",
                 (long) newest_timestamp, (long) newest_index);
    } else {
        ESP_LOGI(TAG, "Історія v2 порожня, ініціалізація розділу");
        if (!first_sector_erased &&
            esp_partition_erase_range(partition, 0, HISTORY_PAGE_SIZE) != ESP_OK) {
            ESP_LOGE(TAG, "Не вдалося очистити перший сектор історії");
            return false;
        }
        last_erased_sector = 0;
    }
    return true;
}

uint32_t wattpost_history_newest_timestamp(void) {
    return newest_timestamp;
}

bool wattpost_history_erase(void) {
    if (partition == NULL || partition->size == 0 ||
        partition->size % HISTORY_PAGE_SIZE != 0) {
        ESP_LOGE(TAG, "Неможливо очистити розділ історії");
        return false;
    }

    if (esp_partition_erase_range(partition, 0, partition->size) != ESP_OK) {
        ESP_LOGE(TAG, "Не вдалося повністю очистити історію");
        return false;
    }

    newest_index = -1;
    newest_timestamp = 0;
    last_erased_sector = 0;
    memset(&average, 0, sizeof(average));
    ESP_LOGI(TAG, "Історію повністю очищено");
    return true;
}

void wattpost_history_save_with_caps(const jk_bms_data_t *data, const temp_capabilities_t *caps) {
    if (partition == NULL || data == NULL || !data->valid) {
        return;
    }
    const time_t now = time(NULL);
    if (now < HISTORY_MIN_TIMESTAMP) {
        return;
    }
    wattpost_history_average_add_with_caps(&average, data, caps);
    if (now - newest_timestamp < HISTORY_INTERVAL_SECONDS) {
        return;
    }
    if (average.common_samples == 0) {
        return;
    }


    uint32_t index;
    size_t offset;
    if (!prepare_next_slot(&index, &offset)) {
        return;
    }

    wattpost_history_record_t record = {0};
    record.version = WATTPOST_HISTORY_VERSION;
    record.timestamp = (uint32_t) now;

    const double pack_v = wattpost_history_average_common(average.pack_voltage_sum, &average);
    record.pack_voltage_mv = (uint32_t) (pack_v * 1000.0 + 0.5);

    const double current = wattpost_history_average_common(average.current_sum, &average);
    const double current_deci_a = current * 10.0;
    record.current_deci_a = (int16_t) (current_deci_a + (current_deci_a < 0 ? -0.5 : 0.5));

    record.state_of_charge = (uint8_t) ((average.soc_sum + average.common_samples / 2) / average.common_samples);
    record.cell_count = average.cell_count;

    // Form active masks strictly from channels with valid samples in this 10-minute interval
    record.cell_active_mask = 0;
    for (uint8_t cell = 0; cell < JK_BMS_MAX_CELLS; ++cell) {
        if (average.cell_sample_count[cell] > 0) {
            record.cell_active_mask |= (1u << cell);
            const double cell_v = wattpost_history_average_cell(&average, cell);
            record.cell_voltage_mv[cell] = (uint16_t) (cell_v * 1000.0 + 0.5);
        } else {
            record.cell_voltage_mv[cell] = 0;
        }
    }

    record.temp_present_mask = 0;
    for (uint8_t temp = 0; temp < JK_BMS_MAX_TEMPS; ++temp) {
        if (average.temp_sample_count[temp] > 0) {
            record.temp_present_mask |= (1u << temp);
            const double temp_c = wattpost_history_average_temp(&average, temp);
            const double temp_deci = temp_c * 10.0;
            record.temperature_deci_c[temp] = (int16_t) (temp_deci + (temp_deci < 0 ? -0.5 : 0.5));
        } else {
            record.temperature_deci_c[temp] = 0;
        }
    }

    record.crc16 = wattpost_history_calc_crc16(&record);

    if (esp_partition_write(partition, offset, &record, sizeof(record)) != ESP_OK) {
        ESP_LOGE(TAG, "Не вдалося зберегти історію");
        return;
    }

    wattpost_history_record_t stored;
    if (!read_record(index, &stored)) {
        ESP_LOGE(TAG, "Перевірка запису історії не пройдена");
        return;
    }

    newest_index = (int32_t) index;
    newest_timestamp = record.timestamp;
    memset(&average, 0, sizeof(average));
    ESP_LOGI(TAG, "Історію v2 збережено: t=%lu, cells=0x%lX, temps=0x%02X",
             (unsigned long) record.timestamp,
             (unsigned long) record.cell_active_mask,
             record.temp_present_mask);
}

void wattpost_history_save(const jk_bms_data_t *data) {
    wattpost_history_save_with_caps(data, NULL);
}

void wattpost_history_visit_recent(wattpost_history_visitor_t visitor, void *context) {

    if (partition == NULL || newest_index < 0 || visitor == NULL) {
        return;
    }
    const uint32_t count = record_count();
    if (count == 0) {
        return;
    }
    const uint32_t points = count < HISTORY_EXPORT_POINTS ? count : HISTORY_EXPORT_POINTS;
    const uint32_t first = ((uint32_t) newest_index + count - points + 1) % count;
    for (uint32_t position = 0; position < points; ++position) {
        const uint32_t index = (first + position) % count;
        wattpost_history_record_t record;
        if (read_record(index, &record) && !visitor(&record, context)) {
            return;
        }
    }
}

typedef struct {
    const wattpost_history_query_t *query;
    uint32_t eligible;
} history_count_context_t;

typedef struct {
    const wattpost_history_query_t *query;
    wattpost_history_visitor_t visitor;
    void *visitor_context;
    uint32_t skip;
    uint16_t emitted;
} history_window_context_t;

static bool history_query_matches(const wattpost_history_record_t *record,
                                  const wattpost_history_query_t *query) {
    if (query->bound == WATTPOST_HISTORY_BEFORE) {
        return record->timestamp < query->timestamp;
    }
    if (query->bound == WATTPOST_HISTORY_AFTER) {
        return record->timestamp > query->timestamp;
    }
    return true;
}

static bool count_history_match(const wattpost_history_record_t *record, void *context) {
    history_count_context_t *count = context;
    if (history_query_matches(record, count->query)) {
        ++count->eligible;
    }
    return true;
}

static bool emit_history_match(const wattpost_history_record_t *record, void *context) {
    history_window_context_t *window = context;
    if (!history_query_matches(record, window->query)) {
        return true;
    }
    if (window->skip > 0) {
        --window->skip;
        return true;
    }
    if (window->emitted >= window->query->limit) {
        return false;
    }
    if (!window->visitor(record, window->visitor_context)) {
        return false;
    }
    ++window->emitted;
    return window->emitted < window->query->limit;
}

void wattpost_history_visit_window(const wattpost_history_query_t *query,
                                   wattpost_history_visitor_t visitor, void *context) {
    if (query == NULL || visitor == NULL || query->limit == 0 ||
        query->limit > WATTPOST_HISTORY_MAX_LIMIT ||
        query->bound < WATTPOST_HISTORY_LATEST || query->bound > WATTPOST_HISTORY_AFTER) {
        return;
    }

    history_window_context_t window = {
        .query = query,
        .visitor = visitor,
        .visitor_context = context,
    };
    if (query->bound != WATTPOST_HISTORY_AFTER) {
        history_count_context_t count = {.query = query};
        wattpost_history_visit_recent(count_history_match, &count);
        if (count.eligible > query->limit) {
            window.skip = count.eligible - query->limit;
        }
    }
    wattpost_history_visit_recent(emit_history_match, &window);
}
