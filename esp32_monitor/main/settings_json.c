#include "settings_json.h"

#include <stdio.h>
#include <string.h>

#include "json_writer.h"

static bool escape_fixed_string(
    char *output,
    size_t output_capacity,
    const char *input,
    size_t input_capacity) {
    char bounded[64];
    if (output == NULL || input == NULL || input_capacity >= sizeof(bounded)) {
        return false;
    }
    size_t length = 0u;
    while (length < input_capacity && input[length] != '\0') {
        ++length;
    }
    memcpy(bounded, input, length);
    bounded[length] = '\0';
    return wattpost_json_escape(output, output_capacity, bounded);
}

static bool append_valid_settings(
    const wattpost_settings_json_input_t *input,
    char *output,
    size_t capacity,
    size_t *used) {
    const jk_bms_settings_t *settings = input->settings;
    const jk_bms_device_info_t *device_info = input->device_info;
    const jk_bms_data_t *live_data = input->live_data;

    char model[sizeof(device_info->model) * 6u];
    char hardware[sizeof(device_info->hardware_version) * 6u];
    char software[sizeof(device_info->software_version) * 6u];
    char manufacture_date[sizeof(device_info->manufacturing_date) * 6u];
    char serial[sizeof(device_info->serial_number) * 6u];
    char name[sizeof(device_info->device_name) * 6u];
    char protocol[48];
    char chemistry[96];
    if (!escape_fixed_string(
            model, sizeof(model),
            device_info->valid ? device_info->model : "",
            device_info->valid ? sizeof(device_info->model) : 1u) ||
        !escape_fixed_string(
            hardware, sizeof(hardware),
            device_info->valid ? device_info->hardware_version : "",
            device_info->valid ? sizeof(device_info->hardware_version) : 1u) ||
        !escape_fixed_string(
            software, sizeof(software),
            device_info->valid ? device_info->software_version : "",
            device_info->valid ? sizeof(device_info->software_version) : 1u) ||
        !escape_fixed_string(
            manufacture_date, sizeof(manufacture_date),
            device_info->valid ? device_info->manufacturing_date : "",
            device_info->valid ? sizeof(device_info->manufacturing_date) : 1u) ||
        !escape_fixed_string(
            serial, sizeof(serial),
            device_info->valid ? device_info->serial_number : "",
            device_info->valid ? sizeof(device_info->serial_number) : 1u) ||
        !escape_fixed_string(
            name, sizeof(name),
            device_info->valid ? device_info->device_name : "",
            device_info->valid ? sizeof(device_info->device_name) : 1u) ||
        !wattpost_json_escape(
            protocol, sizeof(protocol),
            input->protocol_family != NULL ? input->protocol_family : "unknown") ||
        !wattpost_json_escape(
            chemistry, sizeof(chemistry),
            input->chemistry != NULL ? input->chemistry : "unknown")) {
        return false;
    }

    char soh[16];
    if (live_data->valid && live_data->state_of_health <= 100u) {
        (void) snprintf(soh, sizeof(soh), "%u", (unsigned int) live_data->state_of_health);
    } else {
        (void) strcpy(soh, "null");
    }

    return wattpost_json_appendf(
        output, capacity, used,
        "{"
        "\"valid\":true,"
        "\"received_count\":%lu,"
        "\"protocol_family\":\"%s\","
        "\"device\":{"
          "\"model\":\"%s\","
          "\"hardware_version\":\"%s\","
          "\"software_version\":\"%s\","
          "\"manufacture_date\":\"%s\","
          "\"protocol_family\":\"%s\","
          "\"device_sn\":\"%s\","
          "\"device_name\":\"%s\","
          "\"power_on_count\":%lu,"
          "\"uptime_seconds\":%lu"
        "},"
        "\"cell_voltage\":{"
          "\"smart_sleep_v\":%.3f,"
          "\"uvp_v\":%.3f,"
          "\"uvpr_v\":%.3f,"
          "\"ovp_v\":%.3f,"
          "\"ovpr_v\":%.3f,"
          "\"soc_100_v\":%.3f,"
          "\"soc_0_v\":%.3f,"
          "\"request_charge_v\":%.3f,"
          "\"request_float_v\":%.3f,"
          "\"power_off_v\":%.3f,"
          "\"start_balance_v\":%.3f"
        "},"
        "\"balancing\":{"
          "\"enabled\":%s,"
          "\"trigger_delta_v\":%.3f,"
          "\"start_voltage_v\":%.3f,"
          "\"max_current_a\":%.3f"
        "},"
        "\"current_limits\":{"
          "\"max_charge_a\":%.3f,"
          "\"charge_ocp_delay_s\":%lu,"
          "\"charge_ocpr_time_s\":%lu,"
          "\"max_discharge_a\":%.3f,"
          "\"discharge_ocp_delay_s\":%lu,"
          "\"discharge_ocpr_time_s\":%lu,"
          "\"scpr_time_s\":%lu,"
          "\"scp_delay_us\":%lu,"
          "\"discharge_precharge_s\":%u"
        "},"
        "\"temperature\":{"
          "\"charge_otp_c\":%.1f,"
          "\"charge_otpr_c\":%.1f,"
          "\"discharge_otp_c\":%.1f,"
          "\"discharge_otpr_c\":%.1f,"
          "\"charge_utp_c\":%.1f,"
          "\"charge_utpr_c\":%.1f,"
          "\"mosfet_otp_c\":%.1f,"
          "\"mosfet_otpr_c\":%.1f,"
          "\"heating_start_c\":%d,"
          "\"heating_stop_c\":%d,"
          "\"discharge_utp_c\":%d,"
          "\"discharge_utpr_c\":%d"
        "},"
        "\"battery\":{"
          "\"cell_count\":%u,"
          "\"nominal_capacity_ah\":%.3f,"
          "\"battery_type_id\":%u,"
          "\"chemistry\":\"%s\","
          "\"state_of_health\":%s,"
          "\"device_address\":%u"
        "},"
        "\"switches\":{"
          "\"charge\":%s,"
          "\"discharge\":%s,"
          "\"balancer\":%s,"
          "\"heating\":%s,"
          "\"disable_temperature_sensors\":%s,"
          "\"gps_heartbeat\":%s,"
          "\"port_is_rs485\":%s,"
          "\"display_always_on\":%s,"
          "\"special_charger\":%s,"
          "\"smart_sleep\":%s,"
          "\"disable_pcl_module\":%s,"
          "\"timed_stored_data\":%s,"
          "\"charging_float_mode\":%s"
        "},"
        "\"sleep\":{\"smart_sleep_time_hours\":%u}"
        "}",
        (unsigned long) settings->received_count,
        protocol,
        model, hardware, software, manufacture_date, protocol, serial, name,
        (unsigned long) (device_info->valid ? device_info->power_on_count : 0u),
        (unsigned long) (device_info->valid ? device_info->uptime_seconds : 0u),
        settings->smart_sleep_voltage_v, settings->cell_uvp_v,
        settings->cell_uvpr_v, settings->cell_ovp_v, settings->cell_ovpr_v,
        settings->cell_soc100_voltage_v, settings->cell_soc0_voltage_v,
        settings->cell_request_charge_voltage_v,
        settings->cell_request_float_voltage_v, settings->power_off_voltage_v,
        settings->start_balance_voltage_v,
        settings->balancer_switch ? "true" : "false",
        settings->balance_trigger_voltage_v, settings->start_balance_voltage_v,
        settings->max_balance_current_a,
        settings->max_charge_current_a,
        (unsigned long) settings->charge_ocp_delay_s,
        (unsigned long) settings->charge_ocpr_time_s,
        settings->max_discharge_current_a,
        (unsigned long) settings->discharge_ocp_delay_s,
        (unsigned long) settings->discharge_ocpr_time_s,
        (unsigned long) settings->scpr_time_s,
        (unsigned long) settings->scp_delay_us,
        (unsigned int) settings->discharge_precharge_time_s,
        settings->charge_otp_c, settings->charge_otpr_c,
        settings->discharge_otp_c, settings->discharge_otpr_c,
        settings->charge_utp_c, settings->charge_utpr_c,
        settings->mosfet_otp_c, settings->mosfet_otpr_c,
        (int) settings->heating_start_temp_c,
        (int) settings->heating_stop_temp_c,
        (int) settings->discharge_utp_c,
        (int) settings->discharge_utpr_c,
        (unsigned int) settings->cell_count,
        settings->nominal_capacity_ah,
        (unsigned int) live_data->battery_type_id,
        chemistry,
        soh,
        (unsigned int) settings->device_address,
        settings->charge_switch ? "true" : "false",
        settings->discharge_switch ? "true" : "false",
        settings->balancer_switch ? "true" : "false",
        settings->heating_switch ? "true" : "false",
        settings->disable_temperature_sensors ? "true" : "false",
        settings->gps_heartbeat ? "true" : "false",
        settings->port_switch_rs485 ? "true" : "false",
        settings->display_always_on ? "true" : "false",
        settings->special_charger ? "true" : "false",
        settings->smart_sleep_switch ? "true" : "false",
        settings->disable_pcl_module ? "true" : "false",
        settings->timed_stored_data ? "true" : "false",
        settings->charging_float_mode ? "true" : "false",
        (unsigned int) settings->smart_sleep_time_hours);
}

bool wattpost_settings_format_json(
    const wattpost_settings_json_input_t *input,
    char *output,
    size_t output_capacity) {
    if (output == NULL || output_capacity == 0u) {
        return false;
    }
    output[0] = '\0';
    if (input == NULL || input->settings == NULL ||
        input->device_info == NULL || input->live_data == NULL) {
        return false;
    }

    size_t used = 0u;
    bool success;
    if (input->valid) {
        success = append_valid_settings(input, output, output_capacity, &used);
    } else {
        success = wattpost_json_appendf(
            output, output_capacity, &used,
            "{\"valid\":false,\"received_count\":%lu,"
            "\"message\":\"Налаштування BMS ще не отримано\"}",
            (unsigned long) input->settings->received_count);
    }
    if (!success) {
        output[0] = '\0';
    }
    return success;
}
