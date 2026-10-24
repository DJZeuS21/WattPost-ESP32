#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "jk_bms_parser.h"

typedef enum {
    PROTOCOL_FAMILY_UNKNOWN = 0,
    PROTOCOL_FAMILY_JK04 = 1,
    PROTOCOL_FAMILY_JK02_24S = 2,
    PROTOCOL_FAMILY_JK02_32S = 3,
} protocol_family_t;

typedef enum {
    SEMANTIC_PROFILE_UNKNOWN = 0,
    SEMANTIC_PROFILE_PB_HW14 = 1,
    SEMANTIC_PROFILE_PB_V15 = 2,
    SEMANTIC_PROFILE_PB_V19 = 3,
    SEMANTIC_PROFILE_PB_V24 = 4,
    SEMANTIC_PROFILE_GENERIC_JK02 = 5,
} semantic_profile_t;

typedef enum {
    TEMP_SUPPORTED_UNKNOWN = 0,
    TEMP_SUPPORTED_TRUE = 1,
    TEMP_SUPPORTED_FALSE = 2,
} temp_supported_t;

typedef enum {
    TEMP_PRESENCE_UNKNOWN = 0,
    TEMP_PRESENCE_PRESENT = 1,
    TEMP_PRESENCE_ABSENT = 2,
} temp_presence_t;

typedef enum {
    TEMP_RES_SOURCE_UNKNOWN = 0,
    TEMP_RES_SOURCE_MANUAL = 1,
    TEMP_RES_SOURCE_PROTOCOL = 2,
    TEMP_RES_SOURCE_PROFILE = 3,
} temp_resolution_source_t;

typedef enum {
    TEMP_MODE_AUTO = 0,
    TEMP_MODE_MANUAL = 1,
} temp_detection_mode_t;

typedef enum {
    STATUS_MASK_POLICY_UNTRUSTED = 0,    // e.g. 0xFF on PB series
    STATUS_MASK_POLICY_TRUSTED_1_OK = 1, // 1 = normal/present, 0 = missing
    STATUS_MASK_POLICY_UNKNOWN = 2,
} status_mask_policy_t;

typedef struct {
    const char *id;                  // "mos", "t1", "t2", "ext254", "ext256", "ext258"
    const char *name;                // "MOSFET", "T1", "T2", "EXT254", "EXT256", "EXT258"
    uint16_t offset;                 // 144, 162, 164, 254, 256, 258
    temp_supported_t supported;
    temp_presence_t presence;
    bool present;                    // backward compat: presence == TEMP_PRESENCE_PRESENT
    bool enabled;                    // present && !settings.disable_temperature_sensors
    bool value_valid;                // in valid physical range and not fault sentinel
    float val_c;                     // temperature in deg C (if value_valid, else 0.0f)
    const char *alias_of;            // NULL, "mos", "t1", "t2"
    temp_resolution_source_t resolution_source;
} temp_channel_info_t;

typedef struct {
    temp_detection_mode_t mode;
    int8_t manual_mask;              // -1 if auto, 0..63 if manual
    protocol_family_t protocol_family;
    semantic_profile_t semantic_profile;
    uint8_t raw_status_mask;         // frame[214] as received
    uint8_t resolved_mask;           // bitmask of active independent present channels (0..63)
    temp_resolution_source_t resolution_source;
    temp_channel_info_t channels[JK_BMS_MAX_TEMPS];
} temp_capabilities_t;

void temperature_resolver_init(void);

void temperature_resolve_capabilities(const jk_bms_device_info_t *device_info,
                                      const jk_bms_data_t *telemetry,
                                      const jk_bms_settings_t *settings,
                                      temp_capabilities_t *out_caps);

bool temperature_config_set_mode(temp_detection_mode_t mode, int8_t manual_mask);
bool temperature_config_reset(void);
void temperature_config_get(temp_detection_mode_t *mode, int8_t *manual_mask);

const char *protocol_family_to_str(protocol_family_t val);
const char *semantic_profile_to_str(semantic_profile_t val);
const char *temp_supported_to_str(temp_supported_t val);
const char *temp_presence_to_str(temp_presence_t val);
const char *temp_res_source_to_str(temp_resolution_source_t val);
const char *temp_mode_to_str(temp_detection_mode_t val);

