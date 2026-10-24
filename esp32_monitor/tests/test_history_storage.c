#define _GNU_SOURCE
#include <assert.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "esp_partition.h"
#include "esp_log.h"

static uint8_t mock_flash[131072]; // 128 KiB
static uint32_t mock_erase_count[32];
static int mock_partial_write_bytes = -1;
static esp_partition_t mock_partition = {
    .size = sizeof(mock_flash),
    .label = "history"
};

const esp_partition_t *esp_partition_find_first(int type, int subtype, const char *label) {
    (void) type; (void) subtype;
    if (strcmp(label, "history") == 0) {
        return &mock_partition;
    }
    return NULL;
}

esp_err_t esp_partition_read(const esp_partition_t *part, size_t src_offset, void *dst, size_t size) {
    if (src_offset + size > part->size) {
        return ESP_FAIL;
    }
    memcpy(dst, mock_flash + src_offset, size);
    return ESP_OK;
}

esp_err_t esp_partition_write(const esp_partition_t *part, size_t dst_offset, const void *src, size_t size) {
    if (dst_offset + size > part->size) {
        return ESP_FAIL;
    }
    const uint8_t *bytes = src;
    const bool fail = mock_partial_write_bytes >= 0;
    size_t programmed = size;
    if (fail && (size_t) mock_partial_write_bytes < programmed) {
        programmed = (size_t) mock_partial_write_bytes;
    }
    for (size_t i = 0; i < programmed; ++i) {
        mock_flash[dst_offset + i] &= bytes[i];
    }
    mock_partial_write_bytes = -1;
    return fail ? ESP_FAIL : ESP_OK;
}

esp_err_t esp_partition_erase_range(const esp_partition_t *part, size_t offset, size_t size) {
    if (offset + size > part->size || offset % 4096 != 0 || size % 4096 != 0) {
        return ESP_FAIL;
    }
    for (size_t sector = offset / 4096; sector < (offset + size) / 4096; ++sector) {
        mock_erase_count[sector]++;
    }
    memset(mock_flash + offset, 0xFF, size);
    return ESP_OK;
}

// Override time() for deterministic history intervals
static time_t current_mock_time = 1771680000;
#define time(x) current_mock_time

// Include history.c directly in test translation unit
#include "history.h"
#include "history_average.h"
#include "history_query.h"
#include "history.c"


// Helper to push a sample and force save
static void push_and_save(jk_bms_data_t *data, time_t t) {
    current_mock_time = t;
    wattpost_history_save(data);
}

// Collector for visitor verification
typedef struct {
    uint32_t count;
    uint32_t timestamps[2500];
    bool strictly_ordered;
} test_visitor_ctx_t;

static bool test_collector(const wattpost_history_record_t *record, void *context) {
    test_visitor_ctx_t *ctx = context;
    if (ctx->count > 0) {
        if (record->timestamp <= ctx->timestamps[ctx->count - 1]) {
            ctx->strictly_ordered = false;
        }
    }
    ctx->timestamps[ctx->count++] = record->timestamp;
    return true;
}

static test_visitor_ctx_t collect_window(wattpost_history_query_t query) {
    test_visitor_ctx_t ctx = {.count = 0, .strictly_ordered = true};
    wattpost_history_visit_window(&query, test_collector, &ctx);
    return ctx;
}

static void test_paged_history_windows(void) {
    printf("[12/12] Testing paged history windows before and after wrap-around...\n");

    memset(mock_flash, 0xFF, sizeof(mock_flash));
    memset(&average, 0, sizeof(average));
    current_mock_time = 1771680000;
    assert(wattpost_history_init());

    jk_bms_data_t sample = {
        .valid = true,
        .cell_count = 4,
        .cell_active_mask = 0x0F,
        .pack_voltage_v = 13.4f,
        .current_a = -1.0f,
        .state_of_charge = 80,
        .cell_voltage_v = {3.35f, 3.35f, 3.35f, 3.35f},
    };
    const uint32_t start = (uint32_t) current_mock_time;
    for (uint32_t write = 0; write < 400; ++write) {
        push_and_save(&sample, current_mock_time);
        current_mock_time += 600;
    }

    test_visitor_ctx_t ctx = collect_window((wattpost_history_query_t) {
        .limit = 144,
        .bound = WATTPOST_HISTORY_LATEST,
    });
    assert(ctx.count == 144);
    assert(ctx.strictly_ordered);
    assert(ctx.timestamps[0] == start + 256 * 600);
    assert(ctx.timestamps[143] == start + 399 * 600);

    const uint32_t pivot = start + 250 * 600;
    ctx = collect_window((wattpost_history_query_t) {
        .limit = 50,
        .bound = WATTPOST_HISTORY_BEFORE,
        .timestamp = pivot,
    });
    assert(ctx.count == 50);
    assert(ctx.strictly_ordered);
    assert(ctx.timestamps[0] == start + 200 * 600);
    assert(ctx.timestamps[49] == start + 249 * 600);

    ctx = collect_window((wattpost_history_query_t) {
        .limit = 50,
        .bound = WATTPOST_HISTORY_AFTER,
        .timestamp = pivot,
    });
    assert(ctx.count == 50);
    assert(ctx.strictly_ordered);
    assert(ctx.timestamps[0] == start + 251 * 600);
    assert(ctx.timestamps[49] == start + 300 * 600);

    ctx = collect_window((wattpost_history_query_t) {
        .limit = 50,
        .bound = WATTPOST_HISTORY_BEFORE,
        .timestamp = start,
    });
    assert(ctx.count == 0);
    ctx = collect_window((wattpost_history_query_t) {
        .limit = 50,
        .bound = WATTPOST_HISTORY_AFTER,
        .timestamp = start + 399 * 600,
    });
    assert(ctx.count == 0);

    for (uint32_t write = 400; write < 2112; ++write) {
        push_and_save(&sample, current_mock_time);
        current_mock_time += 600;
    }
    assert(newest_index == 63);

    ctx = collect_window((wattpost_history_query_t) {
        .limit = 144,
        .bound = WATTPOST_HISTORY_LATEST,
    });
    assert(ctx.count == 144);
    assert(ctx.strictly_ordered);
    assert(ctx.timestamps[0] == start + 1968 * 600);
    assert(ctx.timestamps[143] == start + 2111 * 600);

    const uint32_t wrapped_pivot = start + 1500 * 600;
    ctx = collect_window((wattpost_history_query_t) {
        .limit = 128,
        .bound = WATTPOST_HISTORY_BEFORE,
        .timestamp = wrapped_pivot,
    });
    assert(ctx.count == 128);
    assert(ctx.strictly_ordered);
    assert(ctx.timestamps[0] == start + 1372 * 600);
    assert(ctx.timestamps[127] == start + 1499 * 600);

    ctx = collect_window((wattpost_history_query_t) {
        .limit = 128,
        .bound = WATTPOST_HISTORY_AFTER,
        .timestamp = wrapped_pivot,
    });
    assert(ctx.count == 128);
    assert(ctx.strictly_ordered);
    assert(ctx.timestamps[0] == start + 1501 * 600);
    assert(ctx.timestamps[127] == start + 1628 * 600);

    printf("      Latest/before/after windows remain ordered across wrap-around. PASS\n");
}

// -------------------------------------------------------------
// Test 1: Layout & Struct Offsets Verification
// -------------------------------------------------------------
static void test_struct_layout(void) {
    printf("[1/12] Testing 64-byte record layout and offsets...\n");

    assert(sizeof(wattpost_history_record_t) == 64);
    assert(offsetof(wattpost_history_record_t, version) == 0);
    assert(offsetof(wattpost_history_record_t, timestamp) == 1);
    assert(offsetof(wattpost_history_record_t, pack_voltage_mv) == 5);
    assert(offsetof(wattpost_history_record_t, current_deci_a) == 9);
    assert(offsetof(wattpost_history_record_t, state_of_charge) == 11);
    assert(offsetof(wattpost_history_record_t, cell_count) == 12);
    assert(offsetof(wattpost_history_record_t, cell_active_mask) == 13);
    assert(offsetof(wattpost_history_record_t, temp_present_mask) == 17);
    assert(offsetof(wattpost_history_record_t, cell_voltage_mv) == 18);
    assert(offsetof(wattpost_history_record_t, temperature_deci_c) == 50);
    assert(offsetof(wattpost_history_record_t, crc16) == 62);

    // Verify CRC coverage (bytes 0..61 = exactly 62 bytes)
    assert(offsetof(wattpost_history_record_t, crc16) == 62);

    wattpost_history_record_t r = {0};
    r.version = 2;
    r.timestamp = 1771680000;
    r.pack_voltage_mv = 26700;
    r.crc16 = wattpost_history_calc_crc16(&r);
    assert(r.crc16 != 0);

    printf("      Record layout: 64 bytes exact, CRC16 covers 62 bytes. PASS\n");
}

// -------------------------------------------------------------
// Test 2: Sector Boundaries (Records 0..63 -> Sector 0, 64..127 -> Sector 1)
// -------------------------------------------------------------
static void test_sector_boundaries(void) {
    printf("[2/12] Testing sector boundary transitions...\n");

    memset(mock_flash, 0xFF, sizeof(mock_flash));
    assert(wattpost_history_init());

    jk_bms_data_t sample = {
        .valid = true,
        .cell_count = 8,
        .cell_active_mask = 0x000000FF,
        .temp_present_mask = 0x07,
        .pack_voltage_v = 26.7f,
        .current_a = -1.5f,
        .state_of_charge = 98,
        .temperatures_c = {28.0f, 25.0f, 26.0f, 0, 0, 0},
        .cell_voltage_v = {3.34f, 3.34f, 3.34f, 3.34f, 3.34f, 3.34f, 3.34f, 3.34f},
    };

    time_t t = 1771680000;

    // Write records 0 to 63 (all in sector 0, offset 0..4095)
    for (int i = 0; i < 64; ++i) {
        push_and_save(&sample, t);
        t += 600;
    }

    assert(newest_index == 63);
    // Byte 4096 (start of sector 1) must still be 0xFF (unwritten)
    assert(mock_flash[4096] == 0xFF);
    assert(mock_flash[4097] == 0xFF);

    // Write record 64 -> transitions to sector 1
    push_and_save(&sample, t);
    t += 600;

    assert(newest_index == 64);
    // Sector 1 record 64 must be valid at offset 4096
    wattpost_history_record_t r64;
    memcpy(&r64, mock_flash + 4096, sizeof(r64));
    assert(valid(&r64));
    assert(r64.version == 2);

    // Sector 0 record 63 must remain valid at offset 4032 (63 * 64)
    wattpost_history_record_t r63;
    memcpy(&r63, mock_flash + 4032, sizeof(r63));
    assert(valid(&r63));

    printf("      Sector boundary transition: record 63 (sec 0) -> 64 (sec 1). PASS\n");
}

// -------------------------------------------------------------
// Test 3 & 4: Full 2048 Records Fill, Wrap-around & Chronological Order
// -------------------------------------------------------------
static void test_full_fill_and_wraparound(void) {
    printf("[3/12] Testing full partition fill (2048 records) and wrap-around...\n");

    memset(mock_flash, 0xFF, sizeof(mock_flash));
    assert(wattpost_history_init());

    jk_bms_data_t sample = {
        .valid = true,
        .cell_count = 8,
        .cell_active_mask = 0x000000FF,
        .temp_present_mask = 0x07,
        .pack_voltage_v = 26.7f,
        .current_a = -1.5f,
        .state_of_charge = 98,
        .temperatures_c = {28.0f, 25.0f, 26.0f, 0, 0, 0},
        .cell_voltage_v = {3.34f, 3.34f, 3.34f, 3.34f, 3.34f, 3.34f, 3.34f, 3.34f},
    };

    time_t t_start = 1771680000;
    time_t t = t_start;

    // Fill all 2048 slots (indices 0..2047)
    for (int i = 0; i < 2048; ++i) {
        push_and_save(&sample, t);
        t += 600;
    }

    assert(newest_index == 2047);

    // Verify all 2016 exported records are visited in strict chronological order
    test_visitor_ctx_t ctx = {.count = 0, .strictly_ordered = true};
    wattpost_history_visit_recent(test_collector, &ctx);
    assert(ctx.count == 2016);
    assert(ctx.strictly_ordered);
    assert(ctx.timestamps[0] == t_start + (2048 - 2016) * 600);
    assert(ctx.timestamps[2015] == t - 600);

    printf("      Full 2048 records filled and verified. PASS\n");

    // Test Wrap-around: write record 2048 (slot 0) and 2049 (slot 1)
    printf("[4/12] Testing wrap-around to slot 0 and sector 0 rewrite...\n");
    push_and_save(&sample, t); // Record 2048 (slot 0, erases sector 0)
    t += 600;
    push_and_save(&sample, t); // Record 2049 (slot 1)
    t += 600;

    assert(newest_index == 1);

    // After erasing sector 0 (64 slots) and writing 2 new records,
    // valid records in partition = 31 sectors (1984 records) + 2 records = 1986 records.
    memset(&ctx, 0, sizeof(ctx));
    ctx.strictly_ordered = true;
    wattpost_history_visit_recent(test_collector, &ctx);
    assert(ctx.count == 1986);
    assert(ctx.strictly_ordered);
    assert(ctx.timestamps[0] == t_start + 64 * 600); // Oldest is record 64 (start of sector 1)
    assert(ctx.timestamps[ctx.count - 1] == t - 600); // Newest is record 2049 (slot 1)

    // Now write 62 more records to completely refill sector 0 (slots 2..63)
    for (int i = 2; i < 64; ++i) {
        push_and_save(&sample, t);
        t += 600;
    }
    assert(newest_index == 63);

    // Now partition has all 2048 slots full again -> visits full 2016 records in strict order
    memset(&ctx, 0, sizeof(ctx));
    ctx.strictly_ordered = true;
    wattpost_history_visit_recent(test_collector, &ctx);
    assert(ctx.count == 2016);
    assert(ctx.strictly_ordered);
    assert(ctx.timestamps[ctx.count - 1] == t - 600);

    printf("      Wrap-around and chronological traversal: PASS\n");
}

// -------------------------------------------------------------
// Test 5: Reboot Recovery (Resume from newest slot)
// -------------------------------------------------------------
static void test_reboot_recovery(void) {
    printf("[5/12] Testing reboot recovery...\n");

    // Simulate reboot: init scans partition and resumes newest_index = 63
    assert(wattpost_history_init());
    assert(newest_index == 63);

    jk_bms_data_t sample = {
        .valid = true,
        .cell_count = 8,
        .cell_active_mask = 0x000000FF,
        .temp_present_mask = 0x07,
        .pack_voltage_v = 26.7f,
        .current_a = -1.5f,
        .state_of_charge = 98,
        .temperatures_c = {28.0f, 25.0f, 26.0f, 0, 0, 0},
        .cell_voltage_v = {3.34f, 3.34f, 3.34f, 3.34f, 3.34f, 3.34f, 3.34f, 3.34f},
    };

    time_t t = current_mock_time + 600;
    push_and_save(&sample, t);

    // Next write must go to slot 64 (start of sector 1)
    assert(newest_index == 64);

    printf("      Reboot recovery correctly resumed without wiping history: PASS\n");
}

// -------------------------------------------------------------
// Test 6: Power-loss / Corrupt CRC Record Handling
// -------------------------------------------------------------
static void test_corrupt_record_handling(void) {
    printf("[6/12] Testing corrupted record / power loss detection...\n");

    // Corrupt record at slot 64 in flash
    mock_flash[64 * 64 + 62] ^= 0x55; // Corrupt CRC16

    // Reboot scan should reject slot 64 and find slot 63 as newest valid record
    assert(wattpost_history_init());
    assert(newest_index == 63);

    // Next write safely overwrites slot 64 with valid record
    jk_bms_data_t sample = {
        .valid = true,
        .cell_count = 8,
        .cell_active_mask = 0x000000FF,
        .temp_present_mask = 0x07,
        .pack_voltage_v = 26.7f,
        .current_a = -1.5f,
        .state_of_charge = 98,
        .temperatures_c = {28.0f, 25.0f, 26.0f, 0, 0, 0},
        .cell_voltage_v = {3.34f, 3.34f, 3.34f, 3.34f, 3.34f, 3.34f, 3.34f, 3.34f},
    };
    time_t t = current_mock_time + 600;
    push_and_save(&sample, t);

    assert(newest_index == 64);
    wattpost_history_record_t r64;
    memcpy(&r64, mock_flash + 64 * 64, sizeof(r64));
    assert(valid(&r64));

    printf("      Corrupt record safely rejected and recovered on reboot: PASS\n");
}

// -------------------------------------------------------------
// Test 7: Old History v1 Partition Clean Initialization
// -------------------------------------------------------------
static void test_old_v1_partition_init(void) {
    printf("[7/12] Testing upgrade from old History v1 (16-byte records)...\n");

    // Fill flash with simulated 16-byte v1 records
    // In v1: bytes 0..3 timestamp (e.g. 1771680000), bytes 4..5 voltage, etc.
    memset(mock_flash, 0, sizeof(mock_flash));
    for (size_t offset = 0; offset < sizeof(mock_flash); offset += 16) {
        uint32_t ts = 1771680000 + (uint32_t)(offset / 16) * 600;
        memcpy(mock_flash + offset, &ts, sizeof(ts));
        uint16_t v = 26700;
        memcpy(mock_flash + offset + 4, &v, sizeof(v));
    }

    // When v2 boot scanner reads 64-byte chunks:
    // chunk.version (byte 0) is timestamp & 0xFF (not 2)
    // or if byte 0 happens to be 2, CRC16 at offset 62 will not match.
    // Therefore all chunks fail valid() check.
    assert(wattpost_history_init());

    // Must initialize cleanly: newest_index = -1, newest_timestamp = 0, erases sector 0
    assert(newest_index == -1);
    assert(newest_timestamp == 0);
    assert(mock_flash[0] == 0xFF);
    assert(mock_flash[4095] == 0xFF);

    // Save first v2 record
    jk_bms_data_t sample = {
        .valid = true,
        .cell_count = 8,
        .cell_active_mask = 0x000000FF,
        .temp_present_mask = 0x07,
        .pack_voltage_v = 26.7f,
        .current_a = -1.5f,
        .state_of_charge = 98,
        .temperatures_c = {28.0f, 25.0f, 26.0f, 0, 0, 0},
        .cell_voltage_v = {3.34f, 3.34f, 3.34f, 3.34f, 3.34f, 3.34f, 3.34f, 3.34f},
    };
    time_t t = 1771680000;
    push_and_save(&sample, t);

    assert(newest_index == 0);
    assert(newest_timestamp == (uint32_t) t);

    printf("      Old v1 partition safely detected and cleanly reset to v2: PASS\n");
}

static void test_partial_slot_recovery(void) {
    printf("[8/12] Testing consecutive dirty-slot recovery with NOR semantics...\n");

    memset(mock_flash, 0xFF, sizeof(mock_flash));
    memset(&average, 0, sizeof(average));
    assert(wattpost_history_init());

    jk_bms_data_t sample = {
        .valid = true,
        .cell_count = 8,
        .cell_active_mask = 0x000000FF,
        .pack_voltage_v = 26.7f,
        .current_a = -1.5f,
        .state_of_charge = 98,
        .cell_voltage_v = {3.34f, 3.34f, 3.34f, 3.34f, 3.34f, 3.34f, 3.34f, 3.34f},
    };

    time_t t = 1771680000;
    push_and_save(&sample, t);
    t += 600;
    push_and_save(&sample, t);
    t += 600;
    assert(newest_index == 1);

    for (uint32_t slot = 2; slot <= 4; ++slot) {
        memset(mock_flash + slot * sizeof(wattpost_history_record_t), 0x00, 8);
    }
    memset(&average, 0, sizeof(average));
    assert(wattpost_history_init());
    assert(newest_index == 1);

    push_and_save(&sample, t);
    assert(newest_index == 5);

    wattpost_history_record_t partial;
    wattpost_history_record_t recovered;
    memcpy(&partial, mock_flash + 2 * sizeof(partial), sizeof(partial));
    memcpy(&recovered, mock_flash + 5 * sizeof(recovered), sizeof(recovered));
    assert(!valid(&partial));
    assert(valid(&recovered));

    test_visitor_ctx_t ctx = {.count = 0, .strictly_ordered = true};
    wattpost_history_visit_recent(test_collector, &ctx);
    assert(ctx.count == 3);
    assert(ctx.strictly_ordered);

    printf("      Three dirty slots skipped; history resumed without an erase-loop. PASS\n");
}

static void test_empty_reboot_does_not_wear_sector_zero(void) {
    printf("[9/12] Testing repeated empty/corrupt-partition reboot wear...\n");

    memset(mock_flash, 0xFF, sizeof(mock_flash));
    memset(mock_erase_count, 0, sizeof(mock_erase_count));
    memset(&average, 0, sizeof(average));
    for (int reboot = 0; reboot < 5; ++reboot) {
        assert(wattpost_history_init());
    }
    assert(mock_erase_count[0] == 0);

    memset(mock_flash, 0x00, sizeof(mock_flash));
    memset(mock_erase_count, 0, sizeof(mock_erase_count));
    assert(wattpost_history_init());
    assert(mock_erase_count[0] == 1);
    for (int reboot = 0; reboot < 5; ++reboot) {
        assert(wattpost_history_init());
    }
    assert(mock_erase_count[0] == 1);

    printf("      Empty sector is not erased; corrupt sector is erased only once. PASS\n");
}

static void test_three_full_turn_erase_distribution(void) {
    printf("[10/12] Testing erase distribution over three full turns...\n");

    memset(mock_flash, 0xFF, sizeof(mock_flash));
    memset(mock_erase_count, 0, sizeof(mock_erase_count));
    memset(&average, 0, sizeof(average));
    current_mock_time = 1771680000;
    assert(wattpost_history_init());

    jk_bms_data_t sample = {
        .valid = true,
        .cell_count = 4,
        .cell_active_mask = 0x0F,
        .pack_voltage_v = 13.4f,
        .current_a = -1.0f,
        .state_of_charge = 80,
        .cell_voltage_v = {3.35f, 3.35f, 3.35f, 3.35f},
    };
    for (uint32_t write = 0; write < 3u * 2048u; ++write) {
        push_and_save(&sample, current_mock_time);
        current_mock_time += 600;
    }

    uint32_t min_erases = UINT32_MAX;
    uint32_t max_erases = 0;
    printf("      Erases per sector:");
    for (uint32_t sector = 0; sector < 32; ++sector) {
        if (mock_erase_count[sector] < min_erases) {
            min_erases = mock_erase_count[sector];
        }
        if (mock_erase_count[sector] > max_erases) {
            max_erases = mock_erase_count[sector];
        }
        printf(" %u", mock_erase_count[sector]);
    }
    printf("\n");
    assert(newest_index == 2047);
    assert(max_erases - min_erases <= 1);
    for (uint32_t slot = 0; slot < 2048; ++slot) {
        wattpost_history_record_t record;
        assert(read_record(slot, &record));
    }
    printf("      Three turns: min=%u, max=%u, all 2048 slots valid. PASS\n",
           min_erases, max_erases);
}

static void test_interrupted_write_wear(void) {
    printf("[11/12] Testing interrupted-write recovery wear...\n");

    jk_bms_data_t sample = {
        .valid = true,
        .cell_count = 4,
        .cell_active_mask = 0x0F,
        .pack_voltage_v = 13.4f,
        .current_a = -1.0f,
        .state_of_charge = 80,
        .cell_voltage_v = {3.35f, 3.35f, 3.35f, 3.35f},
    };

    memset(mock_flash, 0xFF, sizeof(mock_flash));
    memset(mock_erase_count, 0, sizeof(mock_erase_count));
    memset(&average, 0, sizeof(average));
    current_mock_time = 1771680000;
    assert(wattpost_history_init());
    push_and_save(&sample, current_mock_time);
    current_mock_time += 600;
    push_and_save(&sample, current_mock_time);
    current_mock_time += 600;
    mock_partial_write_bytes = 8;
    push_and_save(&sample, current_mock_time);
    assert(newest_index == 1);
    memset(&average, 0, sizeof(average));
    assert(wattpost_history_init());
    current_mock_time += 600;
    push_and_save(&sample, current_mock_time);
    assert(newest_index == 3);
    assert(mock_erase_count[0] == 0);

    memset(mock_flash, 0xFF, sizeof(mock_flash));
    memset(mock_erase_count, 0, sizeof(mock_erase_count));
    memset(&average, 0, sizeof(average));
    current_mock_time = 1771680000;
    assert(wattpost_history_init());
    for (uint32_t write = 0; write < 64; ++write) {
        push_and_save(&sample, current_mock_time);
        current_mock_time += 600;
    }
    mock_partial_write_bytes = 8;
    push_and_save(&sample, current_mock_time);
    assert(newest_index == 63);
    assert(mock_erase_count[1] == 1);
    memset(&average, 0, sizeof(average));
    assert(wattpost_history_init());
    current_mock_time += 600;
    push_and_save(&sample, current_mock_time);
    assert(newest_index == 64);
    assert(mock_erase_count[1] == 2);
    for (uint32_t write = 0; write < 4; ++write) {
        current_mock_time += 600;
        push_and_save(&sample, current_mock_time);
    }
    assert(mock_erase_count[1] == 2);

    printf("      Same-sector extra erases=0; boundary recovery extra erases=1, then stable. PASS\n");
}

static void test_full_history_erase(void) {
    printf("[13/13] Testing explicit full History erase...\n");

    memset(mock_flash, 0x00, sizeof(mock_flash));
    memset(&average, 0xA5, sizeof(average));
    newest_index = 42;
    newest_timestamp = 1771680000;
    last_erased_sector = 7;

    assert(wattpost_history_erase());
    assert(newest_index == -1);
    assert(newest_timestamp == 0);
    assert(last_erased_sector == 0);
    for (size_t index = 0; index < sizeof(mock_flash); ++index) {
        assert(mock_flash[index] == 0xFF);
    }
    const uint8_t *average_bytes = (const uint8_t *) &average;
    for (size_t index = 0; index < sizeof(average); ++index) {
        assert(average_bytes[index] == 0);
    }

    printf("      Full partition and in-memory accumulation cleared. PASS\n");
}

int main(void) {
    test_struct_layout();
    test_sector_boundaries();
    test_full_fill_and_wraparound();
    test_reboot_recovery();
    test_corrupt_record_handling();
    test_old_v1_partition_init();
    test_partial_slot_recovery();
    test_empty_reboot_does_not_wear_sector_zero();
    test_three_full_turn_erase_distribution();
    test_interrupted_write_wear();
    test_paged_history_windows();
    test_full_history_erase();

    printf("\n>>> ALL 13 HISTORY V2 STORAGE, RECOVERY, PAGINATION, ERASE & WEAR TESTS PASSED! <<<\n");
    return 0;
}
