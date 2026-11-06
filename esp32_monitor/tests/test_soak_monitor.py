import importlib.util
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MONITOR_PATH = PROJECT_ROOT / "tools" / "soak_monitor.py"
SPEC = importlib.util.spec_from_file_location("wattpost_soak_monitor", MONITOR_PATH)
MONITOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MONITOR)


class SoakMonitorSummaryTest(unittest.TestCase):
    def test_summary_reports_counter_deltas_and_does_not_treat_ble_reconnect_as_restart(self):
        samples = [
            {
                "ts": "2026-09-15T00:00:00+03:00", "ok": True,
                "connection_uptime": 100, "history_age_seconds": 100,
                "wifi_disconnect_count": 1, "wifi_reconnect_count": 1,
                "ble_recovery_count": 0, "disconnect_count": 0,
                "mdns_recovery_count": 2, "mdns_announce_count": 3,
            },
            {"ts": "2026-09-15T00:05:00+03:00", "ok": False, "error": "timeout"},
            {
                "ts": "2026-09-15T00:10:00+03:00", "ok": True,
                "connection_uptime": 20, "history_age_seconds": 620,
                "wifi_disconnect_count": 3, "wifi_reconnect_count": 3,
                "ble_recovery_count": 1, "disconnect_count": 1,
                "mdns_recovery_count": 4, "mdns_announce_count": 8,
            },
        ]
        summary = MONITOR.summarize(samples)
        self.assertEqual(summary["samples"], 3)
        self.assertEqual(summary["successful_samples"], 2)
        self.assertEqual(summary["failed_samples"], 1)
        self.assertEqual(summary["inferred_restarts"], 0)
        self.assertEqual(summary["max_history_age_seconds"], 620)
        self.assertEqual(summary["counter_deltas"]["wifi_disconnect_count"], 2)
        self.assertEqual(summary["counter_deltas"]["ble_recovery_count"], 1)
        self.assertEqual(summary["counter_deltas"]["mdns_announce_count"], 5)

    def test_summary_infers_restart_only_when_runtime_counter_resets(self):
        samples = [
            {
                "ok": True, "connection_uptime": 1000,
                "wifi_disconnect_count": 2, "wifi_reconnect_count": 2,
                "ble_recovery_count": 1, "disconnect_count": 4,
                "mdns_recovery_count": 3, "mdns_announce_count": 20,
            },
            {
                "ok": True, "connection_uptime": 10,
                "wifi_disconnect_count": 0, "wifi_reconnect_count": 0,
                "ble_recovery_count": 0, "disconnect_count": 0,
                "mdns_recovery_count": 0, "mdns_announce_count": 1,
            },
        ]
        self.assertEqual(MONITOR.summarize(samples)["inferred_restarts"], 1)

    def test_single_sample_has_unknown_counter_deltas(self):
        summary = MONITOR.summarize([{"ok": True, "connection_uptime": 5}])
        self.assertEqual(summary["inferred_restarts"], 0)
        self.assertIsNone(summary["counter_deltas"]["wifi_disconnect_count"])


if __name__ == "__main__":
    unittest.main()
