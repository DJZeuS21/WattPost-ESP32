#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "device_identity.h"

#define WATTPOST_CLOUD_DEVICE_ID_HEX_LEN (WATTPOST_DEVICE_ID_BYTES * 2u)
#define WATTPOST_CLOUD_DEVICE_SECRET_B64_LEN 43u
#define WATTPOST_CLOUD_AUTHORIZATION_MAX_LEN 96u
#define WATTPOST_CLOUD_EPOCH_MAX_LEN 11u
#define WATTPOST_CLOUD_HELLO_JSON_MAX_LEN 192u

#define WATTPOST_CLOUD_TELEMETRY_MAX_CELLS 16u
#define WATTPOST_CLOUD_TELEMETRY_MAX_TEMPS 6u
#define WATTPOST_CLOUD_TELEMETRY_JSON_MAX_LEN 1536u

typedef struct {
    uint32_t boot_count;
    uint32_t sample_seq;
    uint32_t device_uptime_s;

    bool bms_connected;
    bool data_fresh;
    bool wifi_connected;
    bool internet_reachable;

    float voltage_v;
    float current_a;
    float power_w;
    uint8_t soc;

    bool remaining_capacity_valid;
    float remaining_capacity_ah;
    bool nominal_capacity_valid;
    float nominal_capacity_ah;

    uint8_t cell_count;
    float min_cell_voltage_v;
    float max_cell_voltage_v;
    float cell_spread_v;
    bool cell_indices_valid;
    uint8_t max_cell_index;
    uint8_t min_cell_index;
    float cells_v[WATTPOST_CLOUD_TELEMETRY_MAX_CELLS];

    uint8_t temperature_count;
    float temperatures_c[WATTPOST_CLOUD_TELEMETRY_MAX_TEMPS];
    const char *temperature_ids[WATTPOST_CLOUD_TELEMETRY_MAX_TEMPS];
} wattpost_cloud_telemetry_t;

bool wattpost_cloud_format_device_id(
    const uint8_t device_id[WATTPOST_DEVICE_ID_BYTES],
    char *output,
    size_t output_size);

bool wattpost_cloud_format_device_secret(
    const uint8_t device_secret[WATTPOST_DEVICE_SECRET_BYTES],
    char *output,
    size_t output_size);

bool wattpost_cloud_format_authorization(
    const wattpost_device_identity_t *identity,
    char *output,
    size_t output_size);

bool wattpost_cloud_format_epoch(
    uint32_t ownership_epoch,
    char *output,
    size_t output_size);

bool wattpost_cloud_format_hello_json(
    const char *firmware_version,
    const char *build_id,
    uint32_t history_floor_timestamp,
    char *output,
    size_t output_size);

bool wattpost_cloud_format_telemetry_json(
    const wattpost_cloud_telemetry_t *telemetry,
    const char *firmware_version,
    const char *build_id,
    char *output,
    size_t output_size);
