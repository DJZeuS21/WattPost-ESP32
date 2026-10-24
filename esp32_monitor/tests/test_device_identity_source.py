import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
IDENTITY = (ROOT / "main" / "device_identity.c").read_text(encoding="utf-8")
RANDOM = (ROOT / "main" / "device_identity_random.c").read_text(encoding="utf-8")
CMAKE = (ROOT / "main" / "CMakeLists.txt").read_text(encoding="utf-8")


def block(start_marker: str, end_marker: str) -> str:
    start = MAIN.index(start_marker)
    end = MAIN.index(end_marker, start)
    return MAIN[start:end]


class DeviceIdentitySourceTests(unittest.TestCase):
    def test_identity_uses_separate_namespace_and_dual_slots(self):
        self.assertIn('#define IDENTITY_NAMESPACE "wp_identity"', IDENTITY)
        self.assertIn('#define IDENTITY_KEY_A "id_a"', IDENTITY)
        self.assertIn('#define IDENTITY_KEY_B "id_b"', IDENTITY)
        self.assertNotIn('"wp_cfg"', IDENTITY)
        self.assertNotIn("nvs_erase_all", IDENTITY)

    def test_identity_creation_uses_documented_early_boot_entropy_source(self):
        self.assertIn("bootloader_random_enable()", RANDOM)
        self.assertIn("esp_fill_random(buffer, length)", RANDOM)
        self.assertIn("bootloader_random_disable()", RANDOM)
        self.assertLess(
            RANDOM.index("bootloader_random_enable()"),
            RANDOM.index("esp_fill_random(buffer, length)"),
        )
        self.assertLess(
            RANDOM.index("esp_fill_random(buffer, length)"),
            RANDOM.index("bootloader_random_disable()"),
        )
        self.assertIn("bootloader_support", CMAKE)
        self.assertIn("esp_hw_support", CMAKE)

    def test_identity_is_initialized_before_wifi_and_bms_startup(self):
        app = MAIN[MAIN.index("void app_main(void)") :]
        self.assertIn("wattpost_device_identity_init(&boot_identity)", app)
        self.assertLess(
            app.index("wattpost_device_identity_init(&boot_identity)"),
            app.index("load_device_config_snapshot(&boot_device_config)"),
        )
        self.assertLess(
            app.index("wattpost_device_identity_init(&boot_identity)"),
            app.index("start_wifi(&boot_device_config"),
        )
        self.assertLess(
            app.index("wattpost_device_identity_init(&boot_identity)"),
            app.index("start_bms(&boot_device_config"),
        )

    def test_identity_failure_does_not_block_local_boot(self):
        app = MAIN[MAIN.index("void app_main(void)") :]
        identity_error = app[
            app.index('ESP_LOGE(TAG, "Device identity unavailable: %s"') :
            app.index('ESP_LOGI(TAG, "WattPost Mini %s build %s"')
        ]
        self.assertNotIn("ESP_ERROR_CHECK", identity_error)
        self.assertNotIn("return;", identity_error)

    def test_factory_reset_advances_epoch_before_destructive_storage_changes(self):
        reset = block(
            "static bool perform_full_factory_reset",
            "static bool consume_deferred_restart",
        )
        advance = reset.index(
            "wattpost_device_identity_advance_ownership_epoch(&reset_identity)"
        )
        self.assertLess(advance, reset.index("vTaskSuspend(history_task_handle)"))
        self.assertLess(advance, reset.index("temperature_config_reset()"))
        self.assertLess(advance, reset.index("wattpost_device_config_erase_store()"))
        self.assertLess(advance, reset.index("wattpost_history_erase()"))
        abort = reset[
            reset.index("if (!wattpost_device_identity_advance_ownership_epoch") :
            reset.index("if (history_task_handle != NULL)")
        ]
        self.assertIn("return false;", abort)

    def test_scoped_wifi_and_bms_resets_do_not_touch_identity(self):
        bms = block(
            "static esp_err_t bms_forget_handler",
            "static esp_err_t wifi_reconnect_handler",
        )
        wifi = block(
            "static esp_err_t wifi_reset_handler",
            "static esp_err_t system_reboot_handler",
        )
        self.assertIn("wattpost_device_config_clear_bms_persisted()", bms)
        self.assertIn("wattpost_device_config_clear_wifi_persisted()", wifi)
        self.assertNotIn("wattpost_device_identity_", bms)
        self.assertNotIn("wattpost_device_identity_", wifi)

    def test_no_identity_secret_is_added_to_http_or_diagnostics_code(self):
        # Only the public ID is allowed in the agreed history cache context.
        # It is not a credential: the independent device_secret stays private.
        self.assertNotIn(".device_secret", MAIN)
        self.assertNotIn('"device_secret"', MAIN)
        self.assertNotIn('"device_id"', MAIN)
        start = MAIN.index('static void history_context_string(')
        end = MAIN.index('static esp_err_t device_status_handler(', start)
        context = MAIN[start:end]
        self.assertIn('wattpost_device_identity_load(&identity)', context)
        self.assertIn('identity.device_id', context)
        self.assertIn('identity.ownership_epoch', context)
        self.assertIn('memset(&identity, 0, sizeof(identity))', context)
        self.assertNotIn('wattpost_device_identity_init', context)
        self.assertNotIn('advance_ownership_epoch', context)
        self.assertNotIn('.device_id', MAIN[:start] + MAIN[end:])


if __name__ == "__main__":
    unittest.main()
