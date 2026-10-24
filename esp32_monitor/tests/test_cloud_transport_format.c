#include <assert.h>
#include <math.h>
#include <stdint.h>
#include <string.h>

#include "cloud_transport_format.h"

static wattpost_device_identity_t sample_identity(void) {
    wattpost_device_identity_t identity = {0};
    for (uint8_t i = 0; i < WATTPOST_DEVICE_ID_BYTES; ++i) {
        identity.device_id[i] = i;
    }
    for (uint8_t i = 0; i < WATTPOST_DEVICE_SECRET_BYTES; ++i) {
        identity.device_secret[i] = i;
    }
    identity.ownership_epoch = 42u;
    return identity;
}

static wattpost_cloud_telemetry_t sample_telemetry(void) {
    wattpost_cloud_telemetry_t telemetry = {0};
    telemetry.boot_count = 7u;
    telemetry.sample_seq = 11u;
    telemetry.device_uptime_s = 12345u;
    telemetry.bms_connected = true;
    telemetry.data_fresh = true;
    telemetry.wifi_connected = true;
    telemetry.internet_reachable = true;
    telemetry.voltage_v = 26.4f;
    telemetry.current_a = -4.2f;
    telemetry.power_w = -110.9f;
    telemetry.soc = 82u;
    telemetry.remaining_capacity_valid = true;
    telemetry.remaining_capacity_ah = 230.1f;
    telemetry.nominal_capacity_valid = true;
    telemetry.nominal_capacity_ah = 280.0f;
    telemetry.cell_count = 2u;
    telemetry.min_cell_voltage_v = 3.295f;
    telemetry.max_cell_voltage_v = 3.307f;
    telemetry.cell_spread_v = 0.012f;
    telemetry.cell_indices_valid = true;
    telemetry.max_cell_index = 1u;
    telemetry.min_cell_index = 0u;
    telemetry.cells_v[0] = 3.295f;
    telemetry.cells_v[1] = 3.307f;
    telemetry.temperature_count = 3u;
    telemetry.temperatures_c[0] = 28.1f;
    telemetry.temperatures_c[1] = 27.9f;
    telemetry.temperatures_c[2] = 31.0f;
    telemetry.temperature_ids[0] = "t1";
    telemetry.temperature_ids[1] = "t2";
    telemetry.temperature_ids[2] = "mos";
    return telemetry;
}

int main(void) {
    wattpost_device_identity_t identity = sample_identity();

    char device_id[WATTPOST_CLOUD_DEVICE_ID_HEX_LEN + 1u];
    assert(wattpost_cloud_format_device_id(
        identity.device_id, device_id, sizeof(device_id)));
    assert(strcmp(device_id, "000102030405060708090a0b0c0d0e0f") == 0);

    char secret[WATTPOST_CLOUD_DEVICE_SECRET_B64_LEN + 1u];
    assert(wattpost_cloud_format_device_secret(
        identity.device_secret, secret, sizeof(secret)));
    assert(strcmp(
        secret,
        "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8") == 0);

    char authorization[WATTPOST_CLOUD_AUTHORIZATION_MAX_LEN];
    assert(wattpost_cloud_format_authorization(
        &identity, authorization, sizeof(authorization)));
    assert(strcmp(
        authorization,
        "WattPostDevice "
        "000102030405060708090a0b0c0d0e0f."
        "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8") == 0);

    char epoch[WATTPOST_CLOUD_EPOCH_MAX_LEN];
    assert(wattpost_cloud_format_epoch(
        identity.ownership_epoch, epoch, sizeof(epoch)));
    assert(strcmp(epoch, "42") == 0);
    assert(!wattpost_cloud_format_epoch(0u, epoch, sizeof(epoch)));

    char hello[WATTPOST_CLOUD_HELLO_JSON_MAX_LEN];
    assert(wattpost_cloud_format_hello_json(
        "V18.4.16", "abcdef123456", 0u, hello, sizeof(hello)));
    assert(strcmp(
        hello,
        "{\"schema_version\":1,"
        "\"firmware_version\":\"V18.4.16\","
        "\"build_id\":\"abcdef123456\"}") == 0);
    assert(wattpost_cloud_format_hello_json(
        "V18.4.16", "abcdef123456", 1760000000u, hello, sizeof(hello)));
    assert(strstr(hello, "\"history_floor_timestamp\":1760000000") != NULL);
    assert(wattpost_cloud_format_hello_json(
        "V18.4.16", "abcdef123456", 1699999999u, hello, sizeof(hello)));
    assert(strstr(hello, "history_floor_timestamp") == NULL);
    assert(!wattpost_cloud_format_hello_json(
        "bad\"version", "abcdef123456", 0u, hello, sizeof(hello)));
    assert(!wattpost_cloud_format_hello_json(
        "V18.4.16", "bad\\build", 0u, hello, sizeof(hello)));

    wattpost_cloud_telemetry_t telemetry = sample_telemetry();
    char telemetry_json[WATTPOST_CLOUD_TELEMETRY_JSON_MAX_LEN];
    assert(wattpost_cloud_format_telemetry_json(
        &telemetry,
        "V18.4.16",
        "abcdef123456",
        telemetry_json,
        sizeof(telemetry_json)));
    assert(strstr(telemetry_json, "\"schema_version\":1") != NULL);
    assert(strstr(telemetry_json, "\"boot_count\":7") != NULL);
    assert(strstr(telemetry_json, "\"sample_seq\":11") != NULL);
    assert(strstr(telemetry_json, "\"device_uptime_s\":12345") != NULL);
    assert(strstr(
        telemetry_json,
        "\"bms\":{\"connected\":true,\"data_fresh\":true}") != NULL);
    assert(strstr(
        telemetry_json,
        "\"network\":{\"wifi_connected\":true,"
        "\"internet_reachable\":true}") != NULL);
    assert(strstr(telemetry_json, "\"charger_status\":\"discharging\"") != NULL);
    assert(strstr(telemetry_json, "\"max_cell_index\":1") != NULL);
    assert(strstr(telemetry_json, "\"min_cell_index\":0") != NULL);
    assert(strstr(telemetry_json, "\"cells_v\":[3.295,3.307]") != NULL);
    assert(strstr(
        telemetry_json,
        "\"temperatures_c\":[28.1,27.9,31.0]") != NULL);
    assert(strstr(
        telemetry_json,
        "\"temperature_ids\":[\"t1\",\"t2\",\"mos\"]") != NULL);
    assert(strstr(telemetry_json, "wifi_ssid") == NULL);
    assert(strstr(telemetry_json, "device_secret") == NULL);
    assert(strstr(telemetry_json, "bms_mac") == NULL);

    telemetry.data_fresh = false;
    telemetry.bms_connected = false;
    telemetry.cell_count = 0u;
    telemetry.temperature_count = 0u;
    telemetry.remaining_capacity_valid = false;
    telemetry.nominal_capacity_valid = false;
    assert(wattpost_cloud_format_telemetry_json(
        &telemetry,
        "V18.4.16",
        "abcdef123456",
        telemetry_json,
        sizeof(telemetry_json)));
    assert(strstr(telemetry_json, "\"voltage_v\":null") != NULL);
    assert(strstr(telemetry_json, "\"soc\":null") != NULL);
    assert(strstr(telemetry_json, "\"charger_status\":\"unknown\"") != NULL);
    assert(strstr(telemetry_json, "\"max_cell_index\":null") != NULL);
    assert(strstr(telemetry_json, "\"min_cell_index\":null") != NULL);
    assert(strstr(telemetry_json, "\"cells_v\":[]") != NULL);

    telemetry = sample_telemetry();
    telemetry.boot_count = 0u;
    assert(!wattpost_cloud_format_telemetry_json(
        &telemetry,
        "V18.4.16",
        "abcdef123456",
        telemetry_json,
        sizeof(telemetry_json)));

    telemetry = sample_telemetry();
    telemetry.temperature_ids[2] = "unknown";
    assert(!wattpost_cloud_format_telemetry_json(
        &telemetry,
        "V18.4.16",
        "abcdef123456",
        telemetry_json,
        sizeof(telemetry_json)));

    telemetry = sample_telemetry();
    telemetry.temperature_ids[2] = "t1";
    assert(!wattpost_cloud_format_telemetry_json(
        &telemetry,
        "V18.4.16",
        "abcdef123456",
        telemetry_json,
        sizeof(telemetry_json)));

    telemetry = sample_telemetry();
    telemetry.internet_reachable = true;
    telemetry.wifi_connected = false;
    assert(!wattpost_cloud_format_telemetry_json(
        &telemetry,
        "V18.4.16",
        "abcdef123456",
        telemetry_json,
        sizeof(telemetry_json)));

    telemetry = sample_telemetry();
    telemetry.max_cell_index = telemetry.cell_count;
    assert(!wattpost_cloud_format_telemetry_json(
        &telemetry,
        "V18.4.16",
        "abcdef123456",
        telemetry_json,
        sizeof(telemetry_json)));

    telemetry = sample_telemetry();
    telemetry.cells_v[0] = NAN;
    assert(!wattpost_cloud_format_telemetry_json(
        &telemetry,
        "V18.4.16",
        "abcdef123456",
        telemetry_json,
        sizeof(telemetry_json)));

    char too_small[8];
    assert(!wattpost_cloud_format_device_id(
        identity.device_id, too_small, sizeof(too_small)));
    assert(!wattpost_cloud_format_authorization(
        &identity, too_small, sizeof(too_small)));
    telemetry = sample_telemetry();
    assert(!wattpost_cloud_format_telemetry_json(
        &telemetry,
        "V18.4.16",
        "abcdef123456",
        too_small,
        sizeof(too_small)));

    memset(&identity, 0, sizeof(identity));
    memset(&telemetry, 0, sizeof(telemetry));
    memset(device_id, 0, sizeof(device_id));
    memset(secret, 0, sizeof(secret));
    memset(authorization, 0, sizeof(authorization));
    memset(epoch, 0, sizeof(epoch));
    memset(hello, 0, sizeof(hello));
    memset(telemetry_json, 0, sizeof(telemetry_json));
    return 0;
}
