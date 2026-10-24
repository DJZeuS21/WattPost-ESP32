#include <assert.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "jk_bms_parser.h"
#include "temperature_profiles.h"
#include "history_average.h"

// -----------------------------------------------------------------------------
// Test 1: Protocol Family and Semantic Profile Detection
// -----------------------------------------------------------------------------
static void test_1_family_and_semantic_profiles(void) {
    printf("[1] Testing protocol_family and semantic_profile detection...\n");
    temperature_resolver_init();

    // 1. PB_HW14 (current setup)
    jk_bms_device_info_t dev_hw14 = {.valid = true, .model = "JK_PB2A16S20P", .hardware_version = "14.XA", .software_version = "14.20"};
    jk_bms_data_t data = {.valid = true, .raw_temperatures = {289, 287, 284, 289, 287, 284}, .raw_temperature_valid = {true, true, true, true, true, true}};
    jk_bms_settings_t settings = {.valid = true};
    temp_capabilities_t caps;

    temperature_resolve_capabilities(&dev_hw14, &data, &settings, &caps);
    assert(caps.protocol_family == PROTOCOL_FAMILY_JK02_32S);
    assert(caps.semantic_profile == SEMANTIC_PROFILE_PB_HW14);
    assert(strcmp(protocol_family_to_str(caps.protocol_family), "JK02_32S") == 0);
    assert(strcmp(semantic_profile_to_str(caps.semantic_profile), "PB_HW14") == 0);

    // 2. PB_V15
    jk_bms_device_info_t dev_v15 = {.valid = true, .model = "JK_PB2A16S20P", .hardware_version = "15.0", .software_version = "15.10"};
    temperature_resolve_capabilities(&dev_v15, &data, &settings, &caps);
    assert(caps.semantic_profile == SEMANTIC_PROFILE_PB_V15);

    // 3. PB_V19
    jk_bms_device_info_t dev_v19 = {.valid = true, .model = "JK_PB2A16S20P", .hardware_version = "19.A", .software_version = "19.01"};
    temperature_resolve_capabilities(&dev_v19, &data, &settings, &caps);
    assert(caps.semantic_profile == SEMANTIC_PROFILE_PB_V19);

    // 4. PB_V24
    jk_bms_device_info_t dev_v24 = {.valid = true, .model = "JK_PB2A16S20P", .hardware_version = "24.0", .software_version = "24.01"};
    temperature_resolve_capabilities(&dev_v24, &data, &settings, &caps);
    assert(caps.semantic_profile == SEMANTIC_PROFILE_PB_V24);

    // 5. Generic JK02 (B2A)
    jk_bms_device_info_t dev_b2a = {.valid = true, .model = "JK_B2A16S20P", .hardware_version = "11.0", .software_version = "11.20"};
    temperature_resolve_capabilities(&dev_b2a, &data, &settings, &caps);
    assert(caps.semantic_profile == SEMANTIC_PROFILE_GENERIC_JK02);

    // 6. JK04
    jk_bms_device_info_t dev_jk04 = {.valid = true, .model = "JK_04S", .hardware_version = "1.0", .software_version = "1.0"};
    temperature_resolve_capabilities(&dev_jk04, &data, &settings, &caps);
    assert(caps.protocol_family == PROTOCOL_FAMILY_JK04);

    printf("    Protocol families and semantic profiles resolved cleanly. PASS\n");
}

// -----------------------------------------------------------------------------
// Test 2: PB_HW14 Structural Aliases (254->MOS, 256->T1, 258->T2)
// -----------------------------------------------------------------------------
static void test_2_pb_hw14_structural_aliases(void) {
    printf("[2] Testing PB_HW14 structural aliases (254->MOS, 256->T1, 258->T2)...\n");
    temperature_resolver_init();

    jk_bms_device_info_t dev = {.valid = true, .model = "JK_PB2A16S20P", .hardware_version = "14.XA", .software_version = "14.20"};
    jk_bms_data_t data = {
        .valid = true,
        .raw_temperature_status_mask = 0xFF,
        .raw_temperatures = {289, 287, 284, 289, 287, 284},
        .raw_temperature_valid = {true, true, true, true, true, true},
        .temperatures_c = {28.9f, 28.7f, 28.4f, 28.9f, 28.7f, 28.4f},
    };
    jk_bms_settings_t settings = {.valid = true, .disable_temperature_sensors = false};

    temp_capabilities_t caps;
    temperature_resolve_capabilities(&dev, &data, &settings, &caps);

    assert(caps.semantic_profile == SEMANTIC_PROFILE_PB_HW14);

    // Independent sources
    assert(caps.channels[0].alias_of == NULL); // MOS @144
    assert(caps.channels[1].alias_of == NULL); // T1 @162
    assert(caps.channels[2].alias_of == NULL); // T2 @164

    // Structural aliases
    assert(caps.channels[3].alias_of != NULL && strcmp(caps.channels[3].alias_of, "mos") == 0); // 254 -> MOS
    assert(caps.channels[4].alias_of != NULL && strcmp(caps.channels[4].alias_of, "t1") == 0);  // 256 -> T1
    assert(caps.channels[5].alias_of != NULL && strcmp(caps.channels[5].alias_of, "t2") == 0);  // 258 -> T2

    // Resolved mask must include ONLY independent sources (bits 0, 1, 2 = 7)
    assert(caps.resolved_mask == 0x07);

    printf("    Structural aliases correctly assigned for PB_HW14. Resolved mask = 0x07. PASS\n");
}

// -----------------------------------------------------------------------------
// Test 3: PB_V15 / PB_V19 (254->MOS alias, 256 & 258 independent)
// -----------------------------------------------------------------------------
static void test_3_pb_v15_v19_profile(void) {
    printf("[3] Testing PB_V15 / PB_V19 (254->MOS alias, 256 & 258 independent)...\n");
    temperature_resolver_init();

    jk_bms_device_info_t dev = {.valid = true, .model = "JK_PB2A16S20P", .hardware_version = "15.0", .software_version = "15.20"};
    jk_bms_data_t data = {
        .valid = true,
        .raw_temperatures = {289, 287, 284, 289, 278, 280}, // 256=27.8C, 258=28.0C
        .raw_temperature_valid = {true, true, true, true, true, true},
        .temperatures_c = {28.9f, 28.7f, 28.4f, 28.9f, 27.8f, 28.0f},
    };
    jk_bms_settings_t settings = {.valid = true, .disable_temperature_sensors = false};

    temp_capabilities_t caps;
    temperature_resolve_capabilities(&dev, &data, &settings, &caps);

    assert(caps.semantic_profile == SEMANTIC_PROFILE_PB_V15);
    assert(caps.channels[3].alias_of != NULL && strcmp(caps.channels[3].alias_of, "mos") == 0); // 254 is alias
    assert(caps.channels[4].alias_of == NULL); // 256 is independent probe
    assert(caps.channels[5].alias_of == NULL); // 258 is independent probe
    assert(caps.channels[4].presence == TEMP_PRESENCE_PRESENT);
    assert(caps.channels[5].presence == TEMP_PRESENCE_PRESENT);

    // Resolved mask = 1 + 2 + 4 + 16 + 32 = 55 (0x37)
    assert(caps.resolved_mask == 0x37);

    printf("    PB_V15 / PB_V19 correctly marks 256 and 258 as independent. PASS\n");
}

// -----------------------------------------------------------------------------
// Test 4: Unknown Model / Profile
// -----------------------------------------------------------------------------
static void test_4_unknown_model_profile(void) {
    printf("[4] Testing unknown model / profile...\n");
    temperature_resolver_init();

    jk_bms_device_info_t dev = {.valid = true, .model = "UNKNOWN_MODEL_XYZ"};
    jk_bms_data_t data = {
        .valid = true,
        .raw_temperature_status_mask = 0xFF,
        .raw_temperatures = {250, 250, 0, 0, 0, 0},
        .raw_temperature_valid = {true, true, true, true, true, true},
    };
    jk_bms_settings_t settings = {.valid = true};

    temp_capabilities_t caps;
    temperature_resolve_capabilities(&dev, &data, &settings, &caps);

    assert(caps.semantic_profile == SEMANTIC_PROFILE_UNKNOWN);
    assert(caps.resolution_source == TEMP_RES_SOURCE_UNKNOWN);
    assert(caps.resolved_mask == 0);

    printf("    Unknown model safely defaults to unknown semantic profile. PASS\n");
}

// -----------------------------------------------------------------------------
// Test 5: Manual Override Priority
// -----------------------------------------------------------------------------
static void test_5_manual_override(void) {
    printf("[5] Testing manual override priority...\n");
    temperature_resolver_init();

    assert(temperature_config_set_mode(TEMP_MODE_MANUAL, 0x03)); // MOS + T1

    jk_bms_device_info_t dev = {.valid = true, .model = "JK_PB2A16S20P", .hardware_version = "14.XA"};
    jk_bms_data_t data = {
        .valid = true,
        .raw_temperatures = {289, 287, 284, 289, 287, 284},
        .raw_temperature_valid = {true, true, true, true, true, true},
    };
    jk_bms_settings_t settings = {.valid = true};

    temp_capabilities_t caps;
    temperature_resolve_capabilities(&dev, &data, &settings, &caps);

    assert(caps.mode == TEMP_MODE_MANUAL);
    assert(caps.resolution_source == TEMP_RES_SOURCE_MANUAL);
    assert(caps.resolved_mask == 0x03);

    // Reset to Auto
    assert(temperature_config_set_mode(TEMP_MODE_AUTO, -1));
    printf("    Manual override strictly enforced. PASS\n");
}

// -----------------------------------------------------------------------------
// Test 6: 0.0°C is a Valid Temperature
// -----------------------------------------------------------------------------
static void test_6_zero_degrees_valid(void) {
    printf("[6] Testing 0.0°C valid temperature...\n");
    temperature_resolver_init();

    jk_bms_device_info_t dev = {.valid = true, .model = "JK_PB2A16S20P", .hardware_version = "14.XA"};
    jk_bms_data_t data = {
        .valid = true,
        .raw_temperatures = {250, 0, 250, 250, 0, 250}, // T1 is exactly 0 raw = 0.0 C
        .raw_temperature_valid = {true, true, true, true, true, true},
        .temperatures_c = {25.0f, 0.0f, 25.0f, 25.0f, 0.0f, 25.0f},
    };
    jk_bms_settings_t settings = {.valid = true};

    temp_capabilities_t caps;
    temperature_resolve_capabilities(&dev, &data, &settings, &caps);

    assert(caps.channels[1].presence == TEMP_PRESENCE_PRESENT);
    assert(caps.channels[1].value_valid == true);
    assert(caps.channels[1].val_c == 0.0f);
    assert((caps.resolved_mask & (1 << 1)) != 0);

    // History averaging
    wattpost_history_average_t avg = {0};
    wattpost_history_average_add_with_caps(&avg, &data, &caps);
    assert(avg.temp_sample_count[1] == 1);
    assert((avg.temp_present_mask & (1 << 1)) != 0);

    printf("    0.0°C correctly preserved as valid reading in telemetry & history. PASS\n");
}

// -----------------------------------------------------------------------------
// Test 7: History v2 Filtering
// -----------------------------------------------------------------------------
static void test_7_history_v2_filtering(void) {
    printf("[7] Testing History v2 filtering of structural aliases...\n");
    temperature_resolver_init();

    jk_bms_device_info_t dev = {.valid = true, .model = "JK_PB2A16S20P", .hardware_version = "14.XA"};
    jk_bms_data_t data = {
        .valid = true,
        .raw_temperatures = {289, 287, 284, 289, 287, 284},
        .raw_temperature_valid = {true, true, true, true, true, true},
        .temperatures_c = {28.9f, 28.7f, 28.4f, 28.9f, 28.7f, 28.4f},
    };
    jk_bms_settings_t settings = {.valid = true, .disable_temperature_sensors = false};

    temp_capabilities_t caps;
    temperature_resolve_capabilities(&dev, &data, &settings, &caps);

    wattpost_history_average_t avg = {0};
    wattpost_history_average_add_with_caps(&avg, &data, &caps);

    // Only independent channels (MOS, T1, T2) should be accumulated
    assert(avg.temp_sample_count[0] == 1);
    assert(avg.temp_sample_count[1] == 1);
    assert(avg.temp_sample_count[2] == 1);
    assert(avg.temp_sample_count[3] == 0); // 254 (alias) excluded
    assert(avg.temp_sample_count[4] == 0); // 256 (alias) excluded
    assert(avg.temp_sample_count[5] == 0); // 258 (alias) excluded
    assert(avg.temp_present_mask == 0x07);

    printf("    History v2 accumulation strictly excludes structural aliases. PASS\n");
}

int main(void) {
    test_1_family_and_semantic_profiles();
    test_2_pb_hw14_structural_aliases();
    test_3_pb_v15_v19_profile();
    test_4_unknown_model_profile();
    test_5_manual_override();
    test_6_zero_degrees_valid();
    test_7_history_v2_filtering();

    printf("\n>>> ALL TEMPERATURE RESOLVER & PROTOCOL/SEMANTIC TESTS PASSED! <<<\n");
    return 0;
}
