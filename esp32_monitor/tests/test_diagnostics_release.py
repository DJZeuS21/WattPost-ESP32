import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class DiagnosticsReleaseTest(unittest.TestCase):
    def test_partition_layout_reserves_coredump_without_moving_history(self):
        rows = []
        for raw in (ROOT / "partitions.csv").read_text().splitlines():
            raw = raw.strip()
            if not raw or raw.startswith("#"):
                continue
            parts = [part.strip() for part in raw.split(",")]
            rows.append(parts[:5])
        by_name = {row[0]: row for row in rows}
        self.assertEqual(by_name["ota_0"][3:5], ["0x020000", "0x1D0000"])
        self.assertEqual(by_name["coredump"][1:5], ["data", "coredump", "0x1F0000", "0x010000"])
        self.assertEqual(by_name["ota_1"][3:5], ["0x200000", "0x1E0000"])
        self.assertEqual(by_name["history"][3:5], ["0x3E0000", "0x020000"])

    def test_diagnostic_coredump_config_is_persistent_default(self):
        text = (ROOT / "sdkconfig.defaults").read_text()
        for expected in (
            "CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH=y",
            "CONFIG_ESP_COREDUMP_DATA_FORMAT_ELF=y",
            "CONFIG_ESP_COREDUMP_CHECK_BOOT=y",
            "CONFIG_ESP_COREDUMP_MAX_TASKS_NUM=32",
            "CONFIG_ESP_COREDUMP_STACK_SIZE=1536",
        ):
            self.assertIn(expected, text)

    def test_runtime_diagnostics_and_protected_raw_dump_are_wired(self):
        source = (ROOT / "main/main.c").read_text()
        for expected in (
            'nvs_open("diagnostics", NVS_READWRITE',
            "esp_core_dump_image_check()",
            "esp_core_dump_get_panic_reason",
            "esp_core_dump_get_summary",
            '"/api/diagnostics"',
            '"/api/diagnostics/coredump"',
            "esp_get_minimum_free_heap_size()",
        ):
            self.assertIn(expected, source)
        self.assertIn(r'\"jk_bms_poll_stack_free_min_bytes\"', source)

        ble_source = (ROOT / "main/jk_bms_ble.c").read_text()
        self.assertIn("#define JK_BMS_POLL_TASK_STACK_SIZE 4096u", ble_source)
        self.assertIn("&poll_task_handle", ble_source)
        self.assertIn("uxTaskGetStackHighWaterMark(task)", ble_source)

        handler = re.search(
            r"static esp_err_t coredump_download_handler\(.*?\n}\n",
            source,
            flags=re.S,
        )
        self.assertIsNotNone(handler)
        self.assertIn("ota_authorized(request)", handler.group(0))


if __name__ == "__main__":
    unittest.main()
