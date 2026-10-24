import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")


def block(start_marker, end_marker):
    start = MAIN.index(start_marker)
    end = MAIN.index(end_marker, start)
    return MAIN[start:end]


class WifiDeviceManagementSourceTests(unittest.TestCase):
    def test_reconnect_and_reset_routes_are_registered_and_protected(self):
        self.assertIn('"/api/device/wifi/reconnect"', MAIN)
        self.assertIn(".handler = wifi_reconnect_handler", MAIN)
        self.assertIn('"/api/device/wifi/reset"', MAIN)
        self.assertIn(".handler = wifi_reset_handler", MAIN)

        reconnect = block(
            "static esp_err_t wifi_reconnect_handler",
            "static esp_err_t wifi_reset_handler",
        )
        reset = block(
            "static esp_err_t wifi_reset_handler",
            "static esp_err_t system_reboot_handler",
        )
        self.assertIn("local_mutation_request_allowed(request)", reconnect)
        self.assertIn("local_mutation_request_allowed(request)", reset)

    def test_reconnect_accepts_only_empty_json_and_defers_radio_work(self):
        reconnect = block(
            "static esp_err_t wifi_reconnect_handler",
            "static esp_err_t wifi_reset_handler",
        )
        maintain = block(
            "static void maintain_wifi_reconnect_operation",
            "static esp_err_t request_token_handler",
        )
        self.assertIn("parse_empty_json_object", reconnect)
        self.assertIn("wifi_reconnect_operation.start_pending = true", reconnect)
        self.assertIn("WIFI_OPERATION_PHASE_RECONNECTING", reconnect)
        self.assertIn("httpd_resp_sendstr(request, response)", reconnect)
        self.assertIn("xTaskNotifyGive(recovery_task_handle)", reconnect)
        self.assertNotIn("esp_wifi_disconnect()", reconnect)
        self.assertNotIn("esp_wifi_connect()", reconnect)
        self.assertNotIn("esp_wifi_set_config", reconnect)
        self.assertIn("load_device_config_for_mutation(&saved_config)", maintain)
        self.assertIn("wifi_sta_config_from_device_config", maintain)
        self.assertIn("esp_wifi_disconnect()", maintain)
        self.assertIn("esp_wifi_connect()", maintain)

    def test_reconnect_success_is_only_on_got_ip_and_has_timeout(self):
        reconnect = block(
            "static esp_err_t wifi_reconnect_handler",
            "static esp_err_t wifi_reset_handler",
        )
        event = block(
            "static void network_event",
            "static void history_task",
        )
        maintain = block(
            "static void maintain_wifi_reconnect_operation",
            "static esp_err_t request_token_handler",
        )
        self.assertNotIn("WIFI_OPERATION_SUCCESS", reconnect)
        self.assertIn(
            "wifi_reconnect_finish(WIFI_OPERATION_SUCCESS, NULL)",
            event,
        )
        self.assertIn("WATTPOST_WIFI_VALIDATION_TIMEOUT_SECONDS", maintain)
        self.assertIn('"wifi_connect_failed"', maintain)

    def test_installed_switch_keeps_old_persisted_config_until_new_got_ip(self):
        configure = block(
            "static esp_err_t wifi_configure_start_handler",
            "static const embedded_asset_t",
        )
        got_ip = block(
            "static bool wifi_validation_handle_got_ip",
            "static void maintain_wifi_validation",
        )
        self.assertIn("wattpost_device_config_t current_config", configure)
        self.assertIn("wattpost_device_config_t pending_config = current_config", configure)
        self.assertIn("wifi_validation.rollback_config = current_config", configure)
        self.assertNotIn("wattpost_device_config_save", configure)
        self.assertIn("wattpost_device_config_save(&pending)", got_ip)

    def test_installed_switch_is_deferred_until_after_http_response(self):
        configure = block(
            "static esp_err_t wifi_configure_start_handler",
            "static const embedded_asset_t",
        )
        starter = block(
            "static void start_pending_installed_wifi_validation",
            "static bool wifi_validation_handle_disconnect",
        )
        disconnect = block(
            "static bool wifi_validation_handle_disconnect",
            "static bool wifi_validation_handle_got_ip",
        )
        self.assertIn("wifi_validation.start_pending = installed_configure", configure)
        self.assertIn("httpd_resp_sendstr(request, response)", configure)
        self.assertIn("xTaskNotifyGive(recovery_task_handle)", configure)
        self.assertEqual(configure.count("esp_wifi_disconnect()"), 1)
        self.assertIn(
            "if (first_setup_configure) {\n            esp_wifi_disconnect();",
            configure,
        )
        self.assertIn("wifi_validation.expected_disconnect = true", starter)
        self.assertIn("wifi_validation.start_armed", starter)
        self.assertLess(configure.index("httpd_resp_sendstr(request, response)"), configure.index("wifi_validation.start_armed = true"))
        self.assertIn("esp_wifi_disconnect()", starter)
        self.assertIn("wifi_validation_apply_pending_config()", starter)
        self.assertIn("wifi_validation_apply_pending_config()", disconnect)

    def test_failed_installed_switch_schedules_ram_rollback_without_save(self):
        finish = block(
            "static void wifi_validation_finish_error",
            "static bool wifi_validation_apply_pending_config",
        )
        rollback = block(
            "static void maintain_wifi_rollback",
            "static void wifi_rollback_handle_disconnect",
        )
        self.assertIn("wifi_rollback.pending = true", finish)
        self.assertIn("wifi_rollback.config = wifi_validation.rollback_config", finish)
        self.assertIn("preserve_current_connection", finish)
        self.assertIn("wifi_validation.start_pending", finish)
        self.assertNotIn("wattpost_device_config_save", finish)
        self.assertIn("wifi_sta_config_from_device_config", rollback)
        self.assertIn("esp_wifi_set_config", rollback)
        self.assertIn("esp_wifi_connect", rollback)
        self.assertNotIn("wattpost_device_config_save", rollback)

    def test_rollback_success_does_not_turn_failed_switch_into_success(self):
        got_ip = block(
            "static void wifi_rollback_handle_got_ip",
            "static void wifi_reconnect_finish",
        )
        self.assertIn("wifi_rollback.pending = false", got_ip)
        self.assertNotIn("wifi_operation_state", got_ip)
        self.assertNotIn("WIFI_OPERATION_SUCCESS", got_ip)

    def test_scan_done_keeps_large_work_buffers_off_sys_evt_stack(self):
        scan_done = block(
            "static void wifi_scan_handle_done",
            "static esp_err_t wifi_scan_start_handler",
        )
        self.assertIn("wifi_scan_ap_records", scan_done)
        self.assertIn("wifi_scan_candidates_scratch", scan_done)
        self.assertNotIn("wifi_ap_record_t records[", scan_done)
        self.assertNotIn("wifi_scan_candidate_t candidates[", scan_done)
        self.assertIn(
            "static wifi_ap_record_t wifi_scan_ap_records[WATTPOST_WIFI_SCAN_MAX_CANDIDATES]",
            MAIN,
        )

    def test_scan_candidate_validity_is_independent_of_shared_operation_result(self):
        candidate = block(
            "static bool wifi_candidate_for_configure",
            "static void wifi_scan_mark_error",
        )
        scan_done = block(
            "static void wifi_scan_handle_done",
            "static esp_err_t wifi_scan_start_handler",
        )
        self.assertIn("wifi_scan_completed_generation", candidate)
        self.assertNotIn("wifi_operation_state != WIFI_OPERATION_SUCCESS", candidate)
        self.assertIn(
            "wifi_scan_completed_generation = wifi_scan_generation",
            scan_done,
        )

    def test_reset_wifi_requires_exact_confirmation(self):
        reset = block(
            "static esp_err_t wifi_reset_handler",
            "static esp_err_t system_reboot_handler",
        )
        self.assertIn(
            'parse_confirmation_request(\n        body, received_total, "reset_wifi")',
            reset,
        )
        self.assertNotIn("wattpost_setup_ap_code", reset)
        self.assertNotIn("invalid_state", reset)

    def test_reset_wifi_is_scoped_and_reboots_after_http_response(self):
        reset = block(
            "static esp_err_t wifi_reset_handler",
            "static esp_err_t system_reboot_handler",
        )
        recovery = block(
            "static void recovery_task",
            "static bool init_wifi_stack",
        )
        self.assertIn("wattpost_device_config_clear_wifi_persisted()", reset)
        self.assertNotIn("clear_bms", reset)
        self.assertNotIn("history", reset.lower())
        self.assertNotIn("nvs_flash_erase", reset)
        self.assertIn("schedule_deferred_restart()", reset)
        normal_response = reset.index("httpd_resp_sendstr(request, response)")
        normal_schedule = reset.rindex("schedule_deferred_restart()")
        self.assertGreater(normal_schedule, normal_response)
        self.assertIn("consume_deferred_restart()", recovery)
        self.assertIn("esp_restart()", recovery)

    def test_recovery_task_can_be_woken_after_async_http_acceptance(self):
        recovery = block(
            "static void recovery_task",
            "static bool init_wifi_stack",
        )
        self.assertIn("ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(5000))", recovery)
        self.assertIn("start_pending_installed_wifi_validation()", recovery)
        self.assertIn("maintain_wifi_reconnect_operation()", recovery)
        self.assertIn("&recovery_task_handle", MAIN)

    def test_wifi_mutations_are_single_flight_including_reset(self):
        busy = block(
            "static bool wifi_operation_busy_locked",
            "static bool wifi_validation_active_snapshot",
        )
        self.assertIn(
            "wifi_operation_state == WIFI_OPERATION_RUNNING",
            busy,
        )
        self.assertIn("wifi_rollback.pending", busy)

    def test_wifi_network_code_is_not_logged(self):
        for match in re.finditer(r"ESP_LOG[IEWDVA]\([^;]+;", MAIN, re.DOTALL):
            text = match.group(0)
            self.assertNotIn("wifi_password", text)
            self.assertNotIn("parsed.password", text)


if __name__ == "__main__":
    unittest.main()
