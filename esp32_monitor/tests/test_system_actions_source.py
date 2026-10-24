import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
CONFIG = (ROOT / "main" / "device_config.c").read_text(encoding="utf-8")
TEMP = (ROOT / "main" / "temperature_profiles.c").read_text(encoding="utf-8")


def block(start_marker, end_marker):
    start = MAIN.index(start_marker)
    end = MAIN.index(end_marker, start)
    return MAIN[start:end]


class SystemActionsSourceTests(unittest.TestCase):
    def test_system_routes_are_registered_and_secured(self):
        self.assertIn('"/api/device/system/reboot"', MAIN)
        self.assertIn('"/api/device/system/factory-reset"', MAIN)
        reboot = block(
            "static esp_err_t system_reboot_handler",
            "static esp_err_t system_factory_reset_handler",
        )
        factory = block(
            "static esp_err_t system_factory_reset_handler",
            "static esp_err_t wifi_configure_start_handler",
        )
        for handler in (reboot, factory):
            self.assertIn("local_mutation_request_allowed(request)", handler)
            self.assertIn('"202 Accepted"', handler)
            self.assertIn("parse_confirmation_request", handler)
        self.assertIn('"reboot"', reboot)
        self.assertIn('"factory_reset"', factory)

    def test_reboot_changes_no_persistent_state(self):
        reboot = block(
            "static esp_err_t system_reboot_handler",
            "static esp_err_t system_factory_reset_handler",
        )
        self.assertNotIn("wattpost_device_config_", reboot)
        self.assertNotIn("temperature_config_", reboot)
        self.assertNotIn("nvs_", reboot.lower())
        self.assertNotIn("history", reboot.lower())
        self.assertLess(
            reboot.index("httpd_resp_sendstr"),
            reboot.index("schedule_deferred_restart()"),
        )

    def test_factory_reset_does_not_depend_on_per_device_setup_data(self):
        factory = block(
            "static esp_err_t system_factory_reset_handler",
            "static esp_err_t wifi_configure_start_handler",
        )
        self.assertNotIn("wattpost_factory_setup_password_load", factory)
        self.assertNotIn("WATTPOST_FACTORY_CONFIG", factory)
        self.assertNotIn("wp_factory", factory)
        self.assertIn("perform_full_factory_reset()", factory)

    def test_factory_reset_scope_erases_all_user_data_and_diagnostics(self):
        factory = block(
            "static esp_err_t system_factory_reset_handler",
            "static esp_err_t wifi_configure_start_handler",
        )
        self.assertIn("perform_full_factory_reset()", factory)

        full_reset = block(
            "static bool perform_full_factory_reset",
            "static bool consume_deferred_restart",
        )
        self.assertIn("temperature_config_reset()", full_reset)
        self.assertIn("wattpost_device_config_erase_store()", full_reset)
        self.assertIn('erase_nvs_namespace("wattpost")', full_reset)
        self.assertIn("wattpost_history_erase()", full_reset)
        self.assertIn('erase_nvs_namespace("diagnostics")', full_reset)
        self.assertIn("esp_core_dump_image_erase()", full_reset)
        self.assertNotIn("nvs_flash_erase", full_reset)

        erase_store = CONFIG[
            CONFIG.index("bool wattpost_device_config_erase_store"):
        ]
        self.assertIn("nvs_open(CONFIG_NAMESPACE", erase_store)
        self.assertIn("nvs_erase_all(handle)", erase_store)
        self.assertNotIn('"wattpost"', erase_store)
        self.assertNotIn('"diagnostics"', erase_store)

    def test_factory_reset_suspends_history_writer_during_partition_erase(self):
        full_reset = block(
            "static bool perform_full_factory_reset",
            "static bool consume_deferred_restart",
        )
        self.assertLess(
            full_reset.index("vTaskSuspend(history_task_handle)"),
            full_reset.index("wattpost_history_erase()"),
        )
        self.assertIn("vTaskResume(history_task_handle)", full_reset)
        app = MAIN[MAIN.index("void app_main(void)"):]
        self.assertIn("&history_task_handle", app)

    def test_temperature_reset_erases_only_override_keys(self):
        reset = TEMP[
            TEMP.index("bool temperature_config_reset"):
            TEMP.index("void temperature_config_get")
        ]
        self.assertIn('nvs_open("wattpost"', reset)
        self.assertIn('nvs_erase_key(handle, "temp_mode")', reset)
        self.assertIn('nvs_erase_key(handle, "temp_mask")', reset)
        self.assertIn("nvs_commit(handle)", reset)
        self.assertIn("config_mode = TEMP_MODE_AUTO", reset)
        self.assertIn("config_manual_mask = -1", reset)
        self.assertNotIn("nvs_erase_all", reset)

    def test_replay_is_blocked_by_ram_only_system_action_reservation(self):
        global_guard = block(
            "static bool system_action_blocks_mutations",
            "static bool local_mutation_request_allowed",
        )
        self.assertIn("system_action_pending != SYSTEM_ACTION_NONE", global_guard)
        self.assertIn("scheduled_restart_pending", global_guard)
        self.assertIn("restart_pending", global_guard)

        local_guard = block(
            "static bool local_mutation_request_allowed",
            "static const char *wifi_operation_state_str",
        )
        self.assertIn("system_action_blocks_mutations()", local_guard)
        self.assertIn('"409 Conflict", "busy"', local_guard)

        reserve = block(
            "static bool system_action_reserve",
            "static void system_action_release",
        )
        self.assertIn("system_action_pending == SYSTEM_ACTION_NONE", reserve)
        self.assertIn("!scheduled_restart_pending", reserve)
        self.assertIn("!restart_pending", reserve)
        self.assertIn("system_action_pending = action", reserve)

        reboot = block(
            "static esp_err_t system_reboot_handler",
            "static esp_err_t system_factory_reset_handler",
        )
        factory = block(
            "static esp_err_t system_factory_reset_handler",
            "static esp_err_t wifi_configure_start_handler",
        )
        self.assertIn("SYSTEM_ACTION_REBOOT,", reboot)
        self.assertIn("&operation_generation", reboot)
        self.assertIn("SYSTEM_ACTION_FACTORY_RESET,", factory)
        self.assertIn("&operation_generation", factory)
        self.assertIn('"409 Conflict", "busy"', reboot)
        self.assertIn('"409 Conflict", "busy"', factory)

    def test_system_actions_return_shared_operation_contract(self):
        reboot = block(
            "static esp_err_t system_reboot_handler",
            "static esp_err_t system_factory_reset_handler",
        )
        factory = block(
            "static esp_err_t system_factory_reset_handler",
            "static esp_err_t wifi_configure_start_handler",
        )
        for handler in (reboot, factory):
            self.assertIn('"operation\\":{', handler)
            self.assertIn('"generation\\":%lu', handler)
            self.assertIn('"state\\":\\"running\\"', handler)
            self.assertIn('"error_code\\":null', handler)
        self.assertIn('"phase\\":\\"restarting\\"', reboot)
        self.assertIn('"phase\\":\\"resetting\\"', factory)
        self.assertIn("++system_action_generation", MAIN)

    def test_factory_reset_blocks_active_wifi_or_bms_operation(self):
        helper = block(
            "static bool device_operation_busy_for_factory_reset",
            "static bool system_action_reserve",
        )
        self.assertIn("wifi_operation_busy_locked()", helper)
        self.assertIn("jk_bms_ble_operation_snapshot(&bms_operation)", helper)
        self.assertIn(
            "bms_operation.state == JK_BMS_BLE_OPERATION_RUNNING",
            helper,
        )

        factory = block(
            "static esp_err_t system_factory_reset_handler",
            "static esp_err_t wifi_configure_start_handler",
        )
        self.assertIn("device_operation_busy_for_factory_reset()", factory)
        self.assertLess(
            factory.index("device_operation_busy_for_factory_reset()"),
            factory.index("perform_full_factory_reset()"),
        )

    def test_factory_storage_failure_does_not_schedule_reboot(self):
        factory = block(
            "static esp_err_t system_factory_reset_handler",
            "static esp_err_t wifi_configure_start_handler",
        )
        failure = factory[
            factory.index("if (!perform_full_factory_reset()"):
            factory.index("device_config_status = WATTPOST_CONFIG_LOAD_EMPTY")
        ]
        self.assertIn("system_action_release()", failure)
        self.assertIn('"storage_error"', failure)
        self.assertNotIn("schedule_deferred_restart()", failure)


if __name__ == "__main__":
    unittest.main()
