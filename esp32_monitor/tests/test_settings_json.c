#include "settings_json.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static void assert_contains(const char *json, const char *needle) {
    assert(strstr(json, needle) != NULL);
}

int main(void) {
    jk_bms_settings_t settings = {0};
    settings.received_count = 53u;
    settings.smart_sleep_voltage_v = 2.900f;
    settings.cell_uvp_v = 2.500f;
    settings.cell_uvpr_v = 2.800f;
    settings.cell_ovp_v = 3.650f;
    settings.cell_ovpr_v = 3.550f;
    settings.cell_soc100_voltage_v = 3.450f;
    settings.cell_soc0_voltage_v = 2.900f;
    settings.cell_request_charge_voltage_v = 3.500f;
    settings.cell_request_float_voltage_v = 3.400f;
    settings.power_off_voltage_v = 2.700f;
    settings.start_balance_voltage_v = 3.400f;
    settings.balancer_switch = true;
    settings.balance_trigger_voltage_v = 0.010f;
    settings.max_balance_current_a = 2.000f;
    settings.max_charge_current_a = 100.000f;
    settings.charge_ocp_delay_s = 10u;
    settings.charge_ocpr_time_s = 30u;
    settings.max_discharge_current_a = 150.000f;
    settings.discharge_ocp_delay_s = 10u;
    settings.discharge_ocpr_time_s = 30u;
    settings.scpr_time_s = 1u;
    settings.scp_delay_us = 100u;
    settings.discharge_precharge_time_s = 5u;
    settings.charge_otp_c = 60.0f;
    settings.charge_otpr_c = 55.0f;
    settings.discharge_otp_c = 70.0f;
    settings.discharge_otpr_c = 65.0f;
    settings.charge_utp_c = 0.0f;
    settings.charge_utpr_c = 5.0f;
    settings.mosfet_otp_c = 80.0f;
    settings.mosfet_otpr_c = 75.0f;
    settings.heating_start_temp_c = -10;
    settings.heating_stop_temp_c = 0;
    settings.discharge_utp_c = -20;
    settings.discharge_utpr_c = -15;
    settings.cell_count = 16u;
    settings.nominal_capacity_ah = 280.000f;
    settings.device_address = 1u;
    settings.charge_switch = true;
    settings.discharge_switch = true;
    settings.smart_sleep_time_hours = 24u;

    jk_bms_device_info_t device_info = {0};
    device_info.valid = true;
    (void) snprintf(device_info.model, sizeof(device_info.model), "JK \"Model\"");
    (void) snprintf(device_info.hardware_version, sizeof(device_info.hardware_version), "HW-1");
    (void) snprintf(device_info.software_version, sizeof(device_info.software_version), "SW-2");
    (void) snprintf(device_info.manufacturing_date, sizeof(device_info.manufacturing_date), "2026-09");
    (void) snprintf(device_info.serial_number, sizeof(device_info.serial_number), "BMS-SERIAL-123");
    (void) snprintf(device_info.device_name, sizeof(device_info.device_name), "Cabin battery");
    (void) snprintf(device_info.passcode, sizeof(device_info.passcode), "BMSKEY!");
    (void) snprintf(device_info.user_data, sizeof(device_info.user_data), "USER-SECRET");
    (void) snprintf(device_info.setup_passcode, sizeof(device_info.setup_passcode), "SETUP-CRED");
    device_info.power_on_count = 8u;
    device_info.uptime_seconds = 123456u;

    jk_bms_data_t live_data = {0};
    live_data.valid = true;
    live_data.battery_type_id = 4u;
    live_data.state_of_health = 98u;

    const wattpost_settings_json_input_t input = {
        .valid = true,
        .settings = &settings,
        .device_info = &device_info,
        .live_data = &live_data,
        .protocol_family = "JK02_32S",
        .chemistry = "LFP",
    };
    char json[WATTPOST_SETTINGS_JSON_MAX_LEN];
    assert(wattpost_settings_format_json(&input, json, sizeof(json)));

    assert_contains(json, "\"valid\":true");
    assert_contains(json, "\"received_count\":53");
    assert_contains(json, "\"protocol_family\":\"JK02_32S\"");
    assert_contains(json, "\"model\":\"JK \\\"Model\\\"\"");
    assert_contains(json, "\"device_sn\":\"BMS-SERIAL-123\"");
    assert_contains(json, "\"nominal_capacity_ah\":280.000");
    assert_contains(json, "\"chemistry\":\"LFP\"");
    assert_contains(json, "\"state_of_health\":98");
    assert_contains(json, "\"smart_sleep_time_hours\":24");
    assert(strstr(json, "BMSKEY!") == NULL);
    assert(strstr(json, "USER-SECRET") == NULL);
    assert(strstr(json, "SETUP-CRED") == NULL);
    assert(strstr(json, "passcode") == NULL);
    assert(strstr(json, "wifi_password") == NULL);
    assert(strstr(json, "device_secret") == NULL);
    assert(strstr(json, "ota_token") == NULL);
    assert(strstr(json, "coredump") == NULL);

    live_data.valid = false;
    assert(wattpost_settings_format_json(&input, json, sizeof(json)));
    assert_contains(json, "\"state_of_health\":null");

    wattpost_settings_json_input_t invalid_input = input;
    invalid_input.valid = false;
    assert(wattpost_settings_format_json(&invalid_input, json, sizeof(json)));
    assert(strcmp(
        json,
        "{\"valid\":false,\"received_count\":53,"
        "\"message\":\"Налаштування BMS ще не отримано\"}") == 0);

    memset(json, 'x', sizeof(json));
    assert(!wattpost_settings_format_json(&input, json, 16u));
    assert(json[0] == '\0');
    assert(!wattpost_settings_format_json(NULL, json, sizeof(json)));

    puts("Settings JSON formatter tests passed");
    return 0;
}
