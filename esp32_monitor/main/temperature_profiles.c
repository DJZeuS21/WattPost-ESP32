#include "temperature_profiles.h"

#include <ctype.h>
#include <math.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#ifdef ESP_PLATFORM
#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"
static const char *TAG = "temp_prof";
#else
#define ESP_LOGI(...) do {} while(0)
#define ESP_LOGW(...) do {} while(0)
#define ESP_LOGE(...) do {} while(0)
#endif

// Channel metadata descriptors with stable offset IDs
static const struct {
    const char *id;
    const char *name;
    uint16_t offset;
} CHANNEL_DESCRIPTORS[JK_BMS_MAX_TEMPS] = {
    {"mos",    "MOSFET", 144},
    {"t1",     "T1",     162},
    {"t2",     "T2",     164},
    {"ext254", "EXT254", 254},
    {"ext256", "EXT256", 256},
    {"ext258", "EXT258", 258},
};

// State variables
static temp_detection_mode_t config_mode = TEMP_MODE_AUTO;
static int8_t config_manual_mask = -1;

static bool prefix_match_norm(const char *str, const char *prefix) {
    if (!str || !prefix || prefix[0] == '\0') {
        return false;
    }
    size_t i = 0;
    while (prefix[i] != '\0') {
        if (str[i] == '\0') {
            return false;
        }
        char c1 = (char) toupper((unsigned char) str[i]);
        char c2 = (char) toupper((unsigned char) prefix[i]);
        if (c1 == '-') c1 = '_';
        if (c2 == '-') c2 = '_';
        if (c1 != c2) {
            return false;
        }
        i++;
    }
    return true;
}

void temperature_resolver_init(void) {
#ifdef ESP_PLATFORM
    nvs_handle_t handle;
    if (nvs_open("wattpost", NVS_READONLY, &handle) == ESP_OK) {
        uint8_t mode = 0;
        uint8_t mask = 0;
        if (nvs_get_u8(handle, "temp_mode", &mode) == ESP_OK) {
            config_mode = (mode == 1) ? TEMP_MODE_MANUAL : TEMP_MODE_AUTO;
        }
        if (nvs_get_u8(handle, "temp_mask", &mask) == ESP_OK) {
            config_manual_mask = (int8_t) (mask & 0x3F);
        }
        nvs_close(handle);
        ESP_LOGI(TAG, "Конфігурацію температур завантажено: mode=%s, manual_mask=%d",
                 config_mode == TEMP_MODE_MANUAL ? "manual" : "auto", config_manual_mask);
    }
#endif
}

bool temperature_config_set_mode(temp_detection_mode_t mode, int8_t manual_mask) {
    temp_detection_mode_t new_mode;
    int8_t new_manual_mask;
    if (mode == TEMP_MODE_MANUAL) {
        if (manual_mask < 0 || manual_mask > 63) {
            return false;
        }
        new_mode = TEMP_MODE_MANUAL;
        new_manual_mask = manual_mask;
    } else {
        new_mode = TEMP_MODE_AUTO;
        new_manual_mask = -1;
    }
#ifdef ESP_PLATFORM
    nvs_handle_t handle;
    esp_err_t err = nvs_open("wattpost", NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Не вдалося відкрити NVS: %d", err);
        return false;
    }
    err = nvs_set_u8(handle, "temp_mode", new_mode == TEMP_MODE_MANUAL ? 1 : 0);
    if (err == ESP_OK) {
        err = nvs_set_u8(handle, "temp_mask",
                         new_manual_mask >= 0 ? (uint8_t) new_manual_mask : 0);
    }
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Не вдалося зберегти конфігурацію температур: %d", err);
        return false;
    }
#endif
    config_mode = new_mode;
    config_manual_mask = new_manual_mask;
    return true;
}


bool temperature_config_reset(void) {
#ifdef ESP_PLATFORM
    nvs_handle_t handle;
    esp_err_t err = nvs_open("wattpost", NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Не вдалося відкрити NVS для reset температур: %d", err);
        return false;
    }

    esp_err_t mode_err = nvs_erase_key(handle, "temp_mode");
    if (mode_err != ESP_OK && mode_err != ESP_ERR_NVS_NOT_FOUND) {
        nvs_close(handle);
        ESP_LOGE(TAG, "Не вдалося стерти temp_mode: %d", mode_err);
        return false;
    }

    esp_err_t mask_err = nvs_erase_key(handle, "temp_mask");
    if (mask_err != ESP_OK && mask_err != ESP_ERR_NVS_NOT_FOUND) {
        nvs_close(handle);
        ESP_LOGE(TAG, "Не вдалося стерти temp_mask: %d", mask_err);
        return false;
    }

    err = nvs_commit(handle);
    nvs_close(handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Не вдалося commit reset температур: %d", err);
        return false;
    }
#endif

    config_mode = TEMP_MODE_AUTO;
    config_manual_mask = -1;
    return true;
}

void temperature_config_get(temp_detection_mode_t *mode, int8_t *manual_mask) {
    if (mode) *mode = config_mode;
    if (manual_mask) *manual_mask = config_manual_mask;
}

static protocol_family_t detect_protocol_family(const char *model) {
    if (prefix_match_norm(model, "JK_04") || prefix_match_norm(model, "JK04")) {
        return PROTOCOL_FAMILY_JK04;
    }
    if (prefix_match_norm(model, "JK_02_24") || prefix_match_norm(model, "JK02_24")) {
        return PROTOCOL_FAMILY_JK02_24S;
    }
    // Default 300-byte BLE telemetry protocol
    return PROTOCOL_FAMILY_JK02_32S;
}

static semantic_profile_t detect_semantic_profile(const char *model, const char *hw_version) {
    if (prefix_match_norm(model, "JK_PB") || prefix_match_norm(model, "JK-PB")) {
        if (prefix_match_norm(hw_version, "15.") || prefix_match_norm(hw_version, "V15") || prefix_match_norm(hw_version, "15")) {
            return SEMANTIC_PROFILE_PB_V15;
        }
        if (prefix_match_norm(hw_version, "19.") || prefix_match_norm(hw_version, "V19") || prefix_match_norm(hw_version, "19")) {
            return SEMANTIC_PROFILE_PB_V19;
        }
        if (prefix_match_norm(hw_version, "24.") || prefix_match_norm(hw_version, "V24") || prefix_match_norm(hw_version, "24")) {
            return SEMANTIC_PROFILE_PB_V24;
        }
        // PB HW14 (e.g. 14.XA, 14.x, or unversioned PB default)
        return SEMANTIC_PROFILE_PB_HW14;
    }
    if (prefix_match_norm(model, "JK_B2A") || prefix_match_norm(model, "JK-B2A") ||
        prefix_match_norm(model, "JK_B1A") || prefix_match_norm(model, "JK-B1A")) {
        return SEMANTIC_PROFILE_GENERIC_JK02;
    }
    return SEMANTIC_PROFILE_UNKNOWN;
}

void temperature_resolve_capabilities(const jk_bms_device_info_t *device_info,
                                      const jk_bms_data_t *telemetry,
                                      const jk_bms_settings_t *settings,
                                      temp_capabilities_t *out_caps) {
    if (!out_caps) {
        return;
    }
    memset(out_caps, 0, sizeof(*out_caps));

    for (size_t i = 0; i < JK_BMS_MAX_TEMPS; ++i) {
        out_caps->channels[i].id = CHANNEL_DESCRIPTORS[i].id;
        out_caps->channels[i].name = CHANNEL_DESCRIPTORS[i].name;
        out_caps->channels[i].offset = CHANNEL_DESCRIPTORS[i].offset;
    }

    const char *model = (device_info && device_info->valid) ? device_info->model : "";
    const char *hw = (device_info && device_info->valid) ? device_info->hardware_version : "";

    out_caps->protocol_family = detect_protocol_family(model);
    out_caps->semantic_profile = detect_semantic_profile(model, hw);
    out_caps->raw_status_mask = telemetry ? telemetry->raw_temperature_status_mask : 0;
    out_caps->mode = config_mode;
    out_caps->manual_mask = config_manual_mask;

    if (!telemetry || !telemetry->valid) {
        out_caps->resolution_source = TEMP_RES_SOURCE_UNKNOWN;
        return;
    }

    const bool global_sensors_enabled = (settings && settings->valid) ? !settings->disable_temperature_sensors : true;

    // 1. Manual override takes absolute precedence
    if (config_mode == TEMP_MODE_MANUAL && config_manual_mask >= 0) {
        out_caps->resolution_source = TEMP_RES_SOURCE_MANUAL;
        uint8_t resolved = 0;

        for (size_t i = 0; i < JK_BMS_MAX_TEMPS; ++i) {
            const bool in_mask = (config_manual_mask & (1 << i)) != 0;
            temp_channel_info_t *ch = &out_caps->channels[i];
            ch->supported = in_mask ? TEMP_SUPPORTED_TRUE : TEMP_SUPPORTED_FALSE;
            ch->presence = in_mask ? TEMP_PRESENCE_PRESENT : TEMP_PRESENCE_ABSENT;
            ch->present = in_mask;
            ch->value_valid = in_mask ? telemetry->raw_temperature_valid[i] : false;
            ch->val_c = ch->value_valid ? telemetry->temperatures_c[i] : 0.0f;
            ch->enabled = in_mask && global_sensors_enabled;
            ch->alias_of = NULL;
            ch->resolution_source = TEMP_RES_SOURCE_MANUAL;
            if (ch->present && ch->value_valid) {
                resolved |= (1 << i);
            }
        }
        out_caps->resolved_mask = resolved;
        return;
    }

    // 2. Auto mode: resolve based on semantic profile & protocol family
    switch (out_caps->semantic_profile) {
        case SEMANTIC_PROFILE_PB_HW14: {
            out_caps->resolution_source = TEMP_RES_SOURCE_PROFILE;
            // PB_HW14 has 3 independent sources (MOS@144, T1@162, T2@164)
            // and 3 structural aliases (254->MOS, 256->T1, 258->T2)
            const char *aliases[JK_BMS_MAX_TEMPS] = {
                NULL,   // 0: MOS @144
                NULL,   // 1: T1 @162
                NULL,   // 2: T2 @164
                "mos",  // 3: EXT254 @254 -> alias MOS
                "t1",   // 4: EXT256 @256 -> alias T1
                "t2",   // 5: EXT258 @258 -> alias T2
            };

            for (size_t i = 0; i < JK_BMS_MAX_TEMPS; ++i) {
                temp_channel_info_t *ch = &out_caps->channels[i];
                ch->supported = TEMP_SUPPORTED_TRUE;
                ch->alias_of = aliases[i];
                ch->resolution_source = TEMP_RES_SOURCE_PROFILE;

                if (telemetry->raw_temperatures[i] == (int16_t)0x7FFF) {
                    ch->presence = TEMP_PRESENCE_ABSENT;
                    ch->value_valid = false;
                } else if (telemetry->raw_temperature_valid[i]) {
                    ch->presence = TEMP_PRESENCE_PRESENT;
                    ch->value_valid = true;
                } else {
                    ch->presence = TEMP_PRESENCE_UNKNOWN;
                    ch->value_valid = false;
                }
            }
            break;
        }

        case SEMANTIC_PROFILE_PB_V15:
        case SEMANTIC_PROFILE_PB_V19: {
            out_caps->resolution_source = TEMP_RES_SOURCE_PROFILE;
            // PB_V15 / PB_V19: 254->MOS alias; 256 and 258 are independent external sensors
            const char *aliases[JK_BMS_MAX_TEMPS] = {
                NULL,   // 0: MOS @144
                NULL,   // 1: T1 @162
                NULL,   // 2: T2 @164
                "mos",  // 3: EXT254 @254 -> alias MOS
                NULL,   // 4: EXT256 @256 -> independent
                NULL,   // 5: EXT258 @258 -> independent
            };

            for (size_t i = 0; i < JK_BMS_MAX_TEMPS; ++i) {
                temp_channel_info_t *ch = &out_caps->channels[i];
                ch->supported = TEMP_SUPPORTED_TRUE;
                ch->alias_of = aliases[i];
                ch->resolution_source = TEMP_RES_SOURCE_PROFILE;

                if (telemetry->raw_temperatures[i] == (int16_t)0x7FFF) {
                    ch->presence = TEMP_PRESENCE_ABSENT;
                    ch->value_valid = false;
                } else if (i == 0 || i == 1 || i == 2 || i == 3) {
                    // MOS, T1, T2, EXT254
                    if (telemetry->raw_temperature_valid[i]) {
                        ch->presence = TEMP_PRESENCE_PRESENT;
                        ch->value_valid = true;
                    } else {
                        ch->presence = TEMP_PRESENCE_UNKNOWN;
                        ch->value_valid = false;
                    }
                } else {
                    // Independent external sensors 256, 258: present if active reading
                    if (telemetry->raw_temperature_valid[i] && telemetry->raw_temperatures[i] != 0) {
                        ch->presence = TEMP_PRESENCE_PRESENT;
                        ch->value_valid = true;
                    } else {
                        ch->presence = TEMP_PRESENCE_UNKNOWN;
                        ch->value_valid = false;
                    }
                }
            }
            break;
        }

        case SEMANTIC_PROFILE_PB_V24: {
            out_caps->resolution_source = TEMP_RES_SOURCE_PROFILE;
            // PB_V24: MOS, T1, T2 known; 254..258 semantics unknown
            for (size_t i = 0; i < JK_BMS_MAX_TEMPS; ++i) {
                temp_channel_info_t *ch = &out_caps->channels[i];
                ch->alias_of = NULL;
                if (i <= 2) {
                    ch->supported = TEMP_SUPPORTED_TRUE;
                    ch->resolution_source = TEMP_RES_SOURCE_PROFILE;
                    if (telemetry->raw_temperatures[i] == (int16_t)0x7FFF) {
                        ch->presence = TEMP_PRESENCE_ABSENT;
                        ch->value_valid = false;
                    } else if (telemetry->raw_temperature_valid[i]) {
                        ch->presence = TEMP_PRESENCE_PRESENT;
                        ch->value_valid = true;
                    } else {
                        ch->presence = TEMP_PRESENCE_UNKNOWN;
                        ch->value_valid = false;
                    }
                } else {
                    ch->supported = TEMP_SUPPORTED_UNKNOWN;
                    ch->presence = TEMP_PRESENCE_UNKNOWN;
                    ch->value_valid = false;
                    ch->resolution_source = TEMP_RES_SOURCE_UNKNOWN;
                }
            }
            break;
        }

        case SEMANTIC_PROFILE_GENERIC_JK02: {
            out_caps->resolution_source = TEMP_RES_SOURCE_PROFILE;
            // Standard JK02 non-PB: MOS, T1, T2 supported; 254..258 unsupported
            for (size_t i = 0; i < JK_BMS_MAX_TEMPS; ++i) {
                temp_channel_info_t *ch = &out_caps->channels[i];
                ch->alias_of = NULL;
                if (i <= 2) {
                    ch->supported = TEMP_SUPPORTED_TRUE;
                    ch->resolution_source = TEMP_RES_SOURCE_PROFILE;
                    if (telemetry->raw_temperatures[i] == (int16_t)0x7FFF) {
                        ch->presence = TEMP_PRESENCE_ABSENT;
                        ch->value_valid = false;
                    } else if (telemetry->raw_temperature_valid[i]) {
                        ch->presence = TEMP_PRESENCE_PRESENT;
                        ch->value_valid = true;
                    } else {
                        ch->presence = TEMP_PRESENCE_ABSENT;
                        ch->value_valid = false;
                    }
                } else {
                    ch->supported = TEMP_SUPPORTED_FALSE;
                    ch->presence = TEMP_PRESENCE_ABSENT;
                    ch->value_valid = false;
                    ch->resolution_source = TEMP_RES_SOURCE_PROFILE;
                }
            }
            break;
        }

        default: {
            // Unknown semantic profile
            if (out_caps->raw_status_mask != 0xFF && out_caps->raw_status_mask != 0x00 &&
                (out_caps->raw_status_mask & 0x03) != 0) {
                out_caps->resolution_source = TEMP_RES_SOURCE_PROTOCOL;
                for (size_t i = 0; i < JK_BMS_MAX_TEMPS; ++i) {
                    temp_channel_info_t *ch = &out_caps->channels[i];
                    const bool bit_normal = (out_caps->raw_status_mask & (1 << i)) != 0;
                    ch->supported = TEMP_SUPPORTED_UNKNOWN;
                    ch->presence = bit_normal ? TEMP_PRESENCE_PRESENT : TEMP_PRESENCE_ABSENT;
                    ch->value_valid = bit_normal ? telemetry->raw_temperature_valid[i] : false;
                    ch->alias_of = NULL;
                    ch->resolution_source = TEMP_RES_SOURCE_PROTOCOL;
                }
            } else {
                out_caps->resolution_source = TEMP_RES_SOURCE_UNKNOWN;
                for (size_t i = 0; i < JK_BMS_MAX_TEMPS; ++i) {
                    temp_channel_info_t *ch = &out_caps->channels[i];
                    ch->supported = TEMP_SUPPORTED_UNKNOWN;
                    ch->presence = TEMP_PRESENCE_UNKNOWN;
                    ch->value_valid = false;
                    ch->alias_of = NULL;
                    ch->resolution_source = TEMP_RES_SOURCE_UNKNOWN;
                }
            }
            break;
        }
    }

    // Common pass for final fields
    uint8_t resolved = 0;
    for (size_t i = 0; i < JK_BMS_MAX_TEMPS; ++i) {
        temp_channel_info_t *ch = &out_caps->channels[i];
        ch->present = (ch->presence == TEMP_PRESENCE_PRESENT);
        ch->enabled = ch->present && global_sensors_enabled;
        ch->val_c = ch->value_valid ? telemetry->temperatures_c[i] : 0.0f;
        if (ch->present && ch->value_valid && ch->alias_of == NULL) {
            resolved |= (1 << i);
        }
    }
    out_caps->resolved_mask = resolved;
}

const char *protocol_family_to_str(protocol_family_t val) {
    switch (val) {
        case PROTOCOL_FAMILY_JK02_32S: return "JK02_32S";
        case PROTOCOL_FAMILY_JK02_24S: return "JK02_24S";
        case PROTOCOL_FAMILY_JK04: return "JK04";
        default: return "unknown";
    }
}

const char *semantic_profile_to_str(semantic_profile_t val) {
    switch (val) {
        case SEMANTIC_PROFILE_PB_HW14: return "PB_HW14";
        case SEMANTIC_PROFILE_PB_V15: return "PB_V15";
        case SEMANTIC_PROFILE_PB_V19: return "PB_V19";
        case SEMANTIC_PROFILE_PB_V24: return "PB_V24";
        case SEMANTIC_PROFILE_GENERIC_JK02: return "generic_jk02";
        default: return "unknown";
    }
}

const char *temp_supported_to_str(temp_supported_t val) {
    switch (val) {
        case TEMP_SUPPORTED_TRUE: return "true";
        case TEMP_SUPPORTED_FALSE: return "false";
        default: return "unknown";
    }
}

const char *temp_presence_to_str(temp_presence_t val) {
    switch (val) {
        case TEMP_PRESENCE_PRESENT: return "present";
        case TEMP_PRESENCE_ABSENT: return "absent";
        default: return "unknown";
    }
}

const char *temp_res_source_to_str(temp_resolution_source_t val) {
    switch (val) {
        case TEMP_RES_SOURCE_MANUAL: return "manual";
        case TEMP_RES_SOURCE_PROTOCOL: return "protocol";
        case TEMP_RES_SOURCE_PROFILE: return "profile";
        default: return "unknown";
    }
}

const char *temp_mode_to_str(temp_detection_mode_t val) {
    return (val == TEMP_MODE_MANUAL) ? "manual" : "auto";
}
