import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BLE = (ROOT / "main" / "jk_bms_ble.c").read_text(encoding="utf-8")
HEADER = (ROOT / "main" / "jk_bms_ble.h").read_text(encoding="utf-8")


def block(start_marker, end_marker):
    start = BLE.index(start_marker)
    end = BLE.index(end_marker, start)
    return BLE[start:end]


class BleScanApiSourceTests(unittest.TestCase):
    def test_public_snapshot_does_not_expose_full_address(self):
        self.assertIn("jk_bms_ble_scan_candidate_t", HEADER)
        candidate = HEADER[
            HEADER.index("typedef struct {", HEADER.index("JK_BMS_BLE_SCAN_START_OK")):
            HEADER.index("} jk_bms_ble_scan_candidate_t;") + len("} jk_bms_ble_scan_candidate_t;")
        ]
        self.assertIn("address_hint", candidate)
        self.assertNotIn("address[", candidate)
        self.assertNotIn("ble_addr_t", candidate)

    def test_user_scan_is_finite_active_and_checks_real_stack_busy_state(self):
        scan = block(
            "jk_bms_ble_scan_start_result_t jk_bms_ble_scan_start",
            "bool jk_bms_ble_scan_snapshot",
        )
        self.assertIn("JK_BMS_USER_SCAN_DURATION_MS 8000", BLE)
        self.assertIn("params.passive = 0", scan)
        self.assertIn("params.filter_duplicates = 0", scan)
        self.assertIn("ble_gap_disc_active()", scan)
        self.assertIn("ble_gap_conn_active()", scan)
        self.assertIn("BLE_SCAN_OWNER_USER", scan)

    def test_user_discovery_collects_but_never_connects(self):
        gap = block(
            "static int gap_event",
            "static void on_reset",
        )
        user_start = gap.index("if (owner == BLE_SCAN_OWNER_USER)")
        user_end = gap.index("if (owner == BLE_SCAN_OWNER_AUTO", user_start)
        user_path = gap[user_start:user_end]
        self.assertIn("collect_user_scan_candidate", user_path)
        self.assertNotIn("connect(", user_path)

    def test_auto_discovery_still_connects_only_selected_target(self):
        gap = block(
            "static int gap_event",
            "static void on_reset",
        )
        self.assertIn("owner == BLE_SCAN_OWNER_AUTO", gap)
        self.assertIn("is_target(&event->disc.addr)", gap)
        self.assertIn("connect(&event->disc)", gap)

    def test_candidates_are_filtered_ranked_deduplicated_and_bounded(self):
        collector = block(
            "static void collect_user_scan_candidate",
            "static void finalize_user_scan",
        )
        finalize = block(
            "static void finalize_user_scan",
            "static void send_command",
        )
        self.assertIn("ble_hs_adv_parse_fields", collector)
        self.assertIn("advertisement_has_jk_service", collector)
        self.assertIn("wattpost_bms_candidate_rank", collector)
        self.assertIn("scan_candidate_address_equal", collector)
        self.assertIn("JK_BMS_BLE_SCAN_MAX_CANDIDATES", collector)
        self.assertIn("scan_candidate_is_better", finalize)

    def test_scan_completion_restores_existing_auto_target_search(self):
        finalize = block(
            "static void finalize_user_scan",
            "static void send_command",
        )
        self.assertIn("configured && !connected && !connecting", finalize)
        self.assertIn("scan();", finalize)

    def test_transport_scan_owner_blocks_parallel_scans(self):
        auto_scan = block(
            "static void scan(void)",
            "static int gap_event",
        )
        user_scan = block(
            "jk_bms_ble_scan_start_result_t jk_bms_ble_scan_start",
            "bool jk_bms_ble_scan_snapshot",
        )
        self.assertIn("scan_owner == BLE_SCAN_OWNER_NONE", auto_scan)
        self.assertIn("scan_owner == BLE_SCAN_OWNER_USER", user_scan)
        self.assertIn("BLE_SCAN_OWNER_AUTO", user_scan)
        self.assertIn("ble_gap_disc_cancel()", user_scan)
        self.assertIn("auto_still_scanning", user_scan)
        self.assertIn("scan_owner = auto_still_scanning", user_scan)
        self.assertIn("scan_owner = BLE_SCAN_OWNER_USER", user_scan)
        self.assertIn("scan();", user_scan)

    def test_select_preempts_only_background_scan_preserves_active_connection(self):
        selected = block(
            "jk_bms_ble_select_start_result_t jk_bms_ble_select_start",
            "bool jk_bms_ble_select_take_validated_target",
        )
        self.assertIn("BLE_SCAN_OWNER_AUTO", selected)
        self.assertIn("ble_gap_disc_cancel()", selected)
        self.assertIn("connected || connecting", selected)
        self.assertIn("selection_active = true", selected)
        self.assertIn("fail_selection_locked", selected)
        self.assertIn("scan();", selected)
        self.assertNotIn("ble_gap_terminate(", selected)
        self.assertNotIn("target_address =", selected)

    def test_auto_advertisement_does_not_steal_manual_discovery_or_selection(self):
        gap = block("static int gap_event", "static void on_reset")
        self.assertIn("user_scan_state != JK_BMS_BLE_SCAN_RUNNING", gap)
        self.assertIn("!selection_active", gap)

    def test_snapshot_only_exposes_sorted_safe_fields(self):
        snapshot = block(
            "bool jk_bms_ble_scan_snapshot",
            "bool jk_bms_ble_has_target",
        )
        self.assertIn("candidate_id", snapshot)
        self.assertIn("name", snapshot)
        self.assertIn("rssi_dbm", snapshot)
        self.assertIn("address_hint", snapshot)
        self.assertNotIn("candidate->address =", snapshot)
        self.assertNotIn("candidate->address[", snapshot)


if __name__ == "__main__":
    unittest.main()
