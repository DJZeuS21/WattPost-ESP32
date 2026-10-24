import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
CMAKE = (ROOT / "main" / "CMakeLists.txt").read_text(encoding="utf-8")
POLICY = (ROOT / "main" / "boot_button_policy.h").read_text(encoding="utf-8")


def block(start_marker, end_marker):
    start = MAIN.index(start_marker)
    end = MAIN.index(end_marker, start)
    return MAIN[start:end]


class BootRecoverySourceTests(unittest.TestCase):
    def test_runtime_boot_button_is_gpio0_active_low_with_pullup(self):
        task = block(
            "static void boot_button_task",
            "static void recovery_task",
        )
        self.assertIn("#define WATTPOST_BOOT_BUTTON_GPIO GPIO_NUM_0", MAIN)
        self.assertIn("GPIO_MODE_INPUT", task)
        self.assertIn("GPIO_PULLUP_ENABLE", task)
        self.assertIn("GPIO_PULLDOWN_DISABLE", task)
        self.assertIn("gpio_get_level(WATTPOST_BOOT_BUTTON_GPIO) == 0", task)
        self.assertIn("esp_driver_gpio", CMAKE)

    def test_hold_contract_uses_release_to_select_recovery_or_factory_reset(self):
        self.assertIn("WATTPOST_BOOT_BUTTON_POLL_MS = 25", POLICY)
        self.assertIn("WATTPOST_BOOT_RECOVERY_HOLD_MS = 5000", POLICY)
        self.assertIn("WATTPOST_BOOT_FACTORY_RESET_HOLD_MS = 15000", POLICY)
        self.assertIn("WATTPOST_BOOT_BUTTON_ACTION_RECOVERY", POLICY)
        self.assertIn("WATTPOST_BOOT_BUTTON_ACTION_FACTORY_RESET", POLICY)
        self.assertIn("if (pressed)", POLICY)
        self.assertIn("const uint32_t held_ms = state->pressed_ms", POLICY)

        task = block(
            "static void boot_button_task",
            "static void recovery_task",
        )
        self.assertIn("request_physical_recovery()", task)
        self.assertIn("request_physical_factory_reset()", task)
        self.assertIn("action on release", task)

    def test_startup_low_level_is_not_treated_as_runtime_action(self):
        task = block(
            "static void boot_button_task",
            "static void recovery_task",
        )
        self.assertIn("bool armed = false", task)
        self.assertIn("if (!armed)", task)
        self.assertIn("if (!pressed)", task)
        self.assertIn("armed = true", task)
        self.assertIn("ROM GPIO0 boot strap/download mode", task)

    def test_physical_recovery_is_deferred_while_an_operation_is_busy(self):
        task = block(
            "static void recovery_task",
            "static bool init_wifi_stack",
        )
        self.assertIn("consume_physical_recovery()", task)
        self.assertIn("device_operation_busy_for_factory_reset()", task)
        self.assertIn("defer_physical_recovery()", task)
        self.assertIn("start_recovery_ap()", task)

    def test_physical_factory_reset_still_clears_data_then_restarts(self):
        task = block(
            "static void recovery_task",
            "static bool init_wifi_stack",
        )
        self.assertIn("consume_physical_factory_reset()", task)
        self.assertIn("defer_physical_factory_reset()", task)
        self.assertIn("perform_full_factory_reset()", task)
        self.assertIn("schedule_deferred_restart()", task)
        self.assertIn("restarting into First Setup", task)

        reset = block(
            "static bool perform_full_factory_reset",
            "static bool consume_deferred_restart",
        )
        self.assertIn("temperature_config_reset()", reset)
        self.assertIn("wattpost_device_config_erase_store()", reset)
        self.assertIn('erase_nvs_namespace("wattpost")', reset)
        self.assertIn("wattpost_history_erase()", reset)
        self.assertIn('erase_nvs_namespace("diagnostics")', reset)
        self.assertIn("esp_core_dump_image_erase()", reset)

    def test_button_task_is_created_only_after_application_startup(self):
        app = MAIN[MAIN.index("void app_main(void)"):]
        self.assertIn('"boot_button"', app)
        self.assertIn("boot_button_task", app)
        self.assertNotIn("gpio_get_level", MAIN[:MAIN.index("static void boot_button_task")])


if __name__ == "__main__":
    unittest.main()
