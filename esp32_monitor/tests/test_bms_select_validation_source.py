import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
BLE = (ROOT / "main" / "jk_bms_ble.c").read_text(encoding="utf-8")
HEADER = (ROOT / "main" / "jk_bms_ble.h").read_text(encoding="utf-8")


def main_block(start_marker, end_marker):
    start = MAIN.index(start_marker)
    end = MAIN.index(end_marker, start)
    return MAIN[start:end]


def ble_block(start_marker, end_marker):
    start = BLE.index(start_marker)
    end = BLE.index(end_marker, start)
    return BLE[start:end]


class BmsSelectValidationSourceTests(unittest.TestCase):
    def test_select_route_is_registered_and_secured(self):
        self.assertIn('"/api/device/bms/select"', MAIN)
        self.assertIn(".handler = bms_select_start_handler", MAIN)
        handler = main_block(
            "static esp_err_t bms_select_start_handler",
            "static esp_err_t wifi_configure_start_handler",
        )
        self.assertIn("local_mutation_request_allowed(request)", handler)
        self.assertIn("jk_bms_ble_select_start(", handler)
        self.assertIn('"202 Accepted"', handler)

    def test_select_body_uses_generation_and_candidate_only(self):
        parser = main_block(
            "static bool parse_bms_select_request",
            "static esp_err_t bms_scan_start_handler",
        )
        self.assertIn('"scan_generation"', parser)
        self.assertIn('"candidate_id"', parser)
        self.assertIn("unknown_field", parser)
        self.assertNotIn('"address"', parser)
        self.assertNotIn('"mac"', parser.lower())

    def test_select_maps_stale_busy_and_not_found(self):
        handler = main_block(
            "static esp_err_t bms_select_start_handler",
            "static esp_err_t wifi_configure_start_handler",
        )
        self.assertIn("JK_BMS_BLE_SELECT_START_BUSY", handler)
        self.assertIn("JK_BMS_BLE_SELECT_START_STALE_SCAN", handler)
        self.assertIn("JK_BMS_BLE_SELECT_START_NOT_FOUND", handler)
        self.assertIn('"stale_scan"', handler)
        self.assertIn('"candidate_not_found"', handler)

    def test_transport_select_does_not_promote_target_before_commit(self):
        select_start = ble_block(
            "jk_bms_ble_select_start_result_t jk_bms_ble_select_start",
            "bool jk_bms_ble_select_take_validated_target",
        )
        self.assertIn("selection_address = selected_address", select_start)
        self.assertIn("JK_BMS_BLE_PHASE_CONNECTING", select_start)
        self.assertNotIn("configured = true", select_start)
        self.assertNotIn("target_address = selection_address", select_start)

    def test_valid_jk_cell_frame_is_the_validation_gate(self):
        gap = ble_block(
            "static int gap_event",
            "static void on_reset",
        )
        cell = gap[
            gap.index("if (decoded_type == JK_FRAME_TYPE_CELL_INFO)"):
            gap.index("} else if (decoded_type == JK_FRAME_TYPE_SETTINGS)")
        ]
        self.assertIn("selection_active && !selection_validated", cell)
        self.assertIn("selection_validated = true", cell)
        self.assertIn("JK_BMS_BLE_PHASE_SAVING", cell)

    def test_protocol_failure_marks_selection_invalid(self):
        end_connection = ble_block(
            "static void end_connection",
            "static bool configure_target",
        )
        self.assertIn("selection_active && !selection_validated", end_connection)
        self.assertIn("JK_BMS_BLE_ERROR_INVALID_BMS", end_connection)

    def test_disconnect_before_validation_fails_but_validated_target_survives_to_save(self):
        gap = ble_block(
            "static int gap_event",
            "static void on_reset",
        )
        disconnect = gap[
            gap.index("case BLE_GAP_EVENT_DISCONNECT"):
            gap.index("case BLE_GAP_EVENT_NOTIFY_RX")
        ]
        self.assertIn("selection_active && !selection_validated", disconnect)
        self.assertIn("fail_selection_locked(selection_disconnect_error)", disconnect)
        self.assertIn("selection_active && selection_validated", disconnect)
        self.assertIn("validated_selection_pending_save = true", disconnect)

    def test_ble_transport_never_writes_device_config(self):
        self.assertNotIn("wattpost_device_config_save", BLE)
        self.assertNotIn("nvs_", BLE)

    def test_main_persists_only_validated_target_then_commits(self):
        helper = main_block(
            "static void maintain_bms_selection_persist",
            "static void recovery_task",
        )
        self.assertIn("jk_bms_ble_select_take_validated_target", helper)
        self.assertIn("load_device_config_for_mutation", helper)
        self.assertIn("temperature_config_reset()", helper)
        self.assertIn("wattpost_device_config_clear_bms", helper)
        self.assertIn("wattpost_device_config_save", helper)
        self.assertIn("jk_bms_ble_select_commit", helper)
        self.assertIn("if (persisted)", helper)

    def test_transport_promotes_target_only_after_persist_success(self):
        commit = ble_block(
            "bool jk_bms_ble_select_commit",
            "bool jk_bms_ble_scan_snapshot",
        )
        persisted = commit[
            commit.index("if (persisted)"):
            commit.index("} else {", commit.index("if (persisted)"))
        ]
        self.assertIn("target_address = selection_address", persisted)
        self.assertIn("configured = true", persisted)
        self.assertIn("JK_BMS_BLE_OPERATION_SUCCESS", persisted)

    def test_storage_failure_marks_operation_error_and_drops_temporary_link(self):
        commit = ble_block(
            "bool jk_bms_ble_select_commit",
            "bool jk_bms_ble_scan_snapshot",
        )
        self.assertIn("JK_BMS_BLE_ERROR_STORAGE", commit)
        self.assertIn("ble_gap_terminate", commit)

    def test_operation_snapshot_supports_connect_validate_save_phases(self):
        self.assertIn("JK_BMS_BLE_PHASE_CONNECTING", HEADER)
        self.assertIn("JK_BMS_BLE_PHASE_VALIDATING", HEADER)
        self.assertIn("JK_BMS_BLE_PHASE_SAVING", HEADER)
        scan_get = main_block(
            "static esp_err_t bms_scan_get_handler",
            "static esp_err_t bms_select_start_handler",
        )
        self.assertIn("snapshot.operation.generation", scan_get)
        self.assertIn("bms_operation_state_str(snapshot.operation.state)", scan_get)
        self.assertIn("bms_operation_phase_str(snapshot.operation.phase)", scan_get)

    def test_recovery_task_has_headroom_for_bms_persistence(self):
        self.assertIn(
            'recovery_task,\n        "recovery",\n        4096,',
            MAIN,
        )


if __name__ == "__main__":
    unittest.main()
