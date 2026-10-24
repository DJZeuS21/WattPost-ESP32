import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
CLOUD = (ROOT / "main" / "cloud_transport.c").read_text(encoding="utf-8")


class RamBudgetSourceTests(unittest.TestCase):
    def test_http_json_responses_share_one_static_union(self):
        self.assertIn("typedef union {", MAIN)
        for member in (
            "char wifi_scan[6144]",
            "char bms_scan[4096]",
            "char live[5120]",
            "char diagnostics[3072]",
            "char device_status[3072]",
        ):
            self.assertIn(member, MAIN)
        self.assertEqual(MAIN.count("static http_json_response_buffer_t http_json_response"), 1)
        for old in (
            "static char wifi_scan_response[",
            "static char bms_scan_response[",
            "static char live_response[",
            "static char diagnostics_response[",
            "static char device_status_response[",
        ):
            self.assertNotIn(old, MAIN)

    def test_cloud_upload_payloads_share_one_static_union(self):
        for member in (
            "char telemetry[WATTPOST_CLOUD_TELEMETRY_JSON_MAX_LEN]",
            "char history[WATTPOST_CLOUD_HISTORY_JSON_MAX_LEN]",
            "char settings[CLOUD_SETTINGS_JSON_MAX_LEN]",
        ):
            self.assertIn(member, CLOUD)
        self.assertEqual(CLOUD.count("static cloud_json_scratch_t cloud_json_scratch"), 1)
        for old in (
            "static char cloud_telemetry_json[",
            "static char cloud_history_json[",
            "static char cloud_settings_json[",
        ):
            self.assertNotIn(old, CLOUD)

    def test_history_and_boot_button_stack_safety_budget(self):
        self.assertIn('"history",\n            5120,', MAIN)
        self.assertIn('"boot_button",\n            3072,', MAIN)

    def test_persistent_application_task_high_water_marks_are_exposed(self):
        for field in (
            "history_stack_free_min_bytes",
            "internet_probe_stack_free_min_bytes",
            "recovery_stack_free_min_bytes",
            "boot_button_stack_free_min_bytes",
        ):
            self.assertIn(field, MAIN)
        for task in (
            "history_task_handle",
            "internet_reachability_task_handle",
            "recovery_task_handle",
            "boot_button_task_handle",
        ):
            self.assertIn(f"task_stack_free_min_bytes({task})", MAIN)


if __name__ == "__main__":
    unittest.main()
