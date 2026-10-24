import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
BLE = (ROOT / "main" / "jk_bms_ble.c").read_text(encoding="utf-8")
HEADER = (ROOT / "main" / "jk_bms_ble.h").read_text(encoding="utf-8")
CONFIG = (ROOT / "main" / "device_config.c").read_text(encoding="utf-8")


def main_block(start_marker, end_marker):
    start = MAIN.index(start_marker)
    end = MAIN.index(end_marker, start)
    return MAIN[start:end]


def ble_block(start_marker, end_marker):
    start = BLE.index(start_marker)
    end = BLE.index(end_marker, start)
    return BLE[start:end]


class BmsReconnectForgetSourceTests(unittest.TestCase):
    def test_reconnect_route_is_secured_async_operation(self):
        self.assertIn('"/api/device/bms/reconnect"', MAIN)
        handler = main_block(
            "static esp_err_t bms_reconnect_handler",
            "static esp_err_t bms_forget_handler",
        )
        self.assertIn("local_mutation_request_allowed(request)", handler)
        self.assertIn("jk_bms_ble_reconnect_start", handler)
        self.assertIn('"not_configured"', handler)
        self.assertIn('"busy"', handler)
        self.assertIn('"202 Accepted"', handler)
        self.assertIn('reconnecting', handler)
        self.assertNotIn("wattpost_device_config_save", handler)

    def test_reconnect_is_validated_by_new_cell_info_frame(self):
        reconnect = ble_block(
            "jk_bms_ble_reconnect_start_result_t jk_bms_ble_reconnect_start",
            "jk_bms_ble_forget_start_result_t jk_bms_ble_forget_start",
        )
        self.assertIn("JK_BMS_BLE_PHASE_RECONNECTING", reconnect)
        self.assertIn("reconnect_deadline_seconds = now_seconds + 30u", reconnect)

        gap = ble_block("static int gap_event", "static void on_reset")
        cell = gap[
            gap.index("if (decoded_type == JK_FRAME_TYPE_CELL_INFO)"):
            gap.index("} else if (decoded_type == JK_FRAME_TYPE_SETTINGS)")
        ]
        self.assertIn("if (reconnect_active)", cell)
        self.assertIn("JK_BMS_BLE_OPERATION_SUCCESS", cell)

    def test_reconnect_timeout_is_stable_error_and_does_not_change_target(self):
        poll = ble_block("static void poll_task", "bool jk_bms_ble_start")
        self.assertIn("now_seconds >= reconnect_deadline_seconds", poll)
        self.assertIn("JK_BMS_BLE_ERROR_CONNECT_FAILED", poll)
        reconnect = ble_block(
            "jk_bms_ble_reconnect_start_result_t jk_bms_ble_reconnect_start",
            "jk_bms_ble_forget_start_result_t jk_bms_ble_forget_start",
        )
        self.assertNotIn("configured = false", reconnect)
        self.assertNotIn("target_address =", reconnect)

    def test_manual_reconnect_suppresses_system_recovery_age(self):
        age = ble_block(
            "uint32_t jk_bms_ble_last_valid_frame_age",
            "uint32_t jk_bms_ble_down_time",
        )
        self.assertIn("reconnect_active", age)
        self.assertIn("forget_active", age)

    def test_forget_route_requires_exact_confirmation_and_is_async(self):
        self.assertIn('"/api/device/bms/forget"', MAIN)
        handler = main_block(
            "static esp_err_t bms_forget_handler",
            "static esp_err_t wifi_reconnect_handler",
        )
        self.assertIn("local_mutation_request_allowed(request)", handler)
        self.assertIn('"forget_bms"', handler)
        self.assertIn("parse_confirmation_request", handler)
        self.assertIn("jk_bms_ble_forget_start", handler)
        self.assertIn('"202 Accepted"', handler)
        self.assertIn("bms_operation_phase_str(operation.phase)", handler)

    def test_forget_reserves_runtime_operation_before_persistent_clear(self):
        handler = main_block(
            "static esp_err_t bms_forget_handler",
            "static esp_err_t wifi_reconnect_handler",
        )
        self.assertLess(
            handler.index("jk_bms_ble_forget_start"),
            handler.index("wattpost_device_config_clear_bms_persisted"),
        )
        self.assertLess(
            handler.index("wattpost_device_config_clear_bms_persisted"),
            handler.index("jk_bms_ble_forget_commit"),
        )

    def test_storage_failure_keeps_runtime_target(self):
        commit = ble_block(
            "bool jk_bms_ble_forget_commit",
            "bool jk_bms_ble_scan_snapshot",
        )
        fail_start = commit.index("if (!persisted)")
        clear_target = commit.index("configured = false")
        self.assertLess(fail_start, clear_target)
        fail_branch = commit[fail_start:clear_target]
        self.assertIn("JK_BMS_BLE_ERROR_STORAGE", fail_branch)
        self.assertNotIn("configured = false", fail_branch)
        self.assertNotIn("memset(&target_address", fail_branch)

    def test_successful_forget_clears_only_runtime_bms_state(self):
        commit = ble_block(
            "bool jk_bms_ble_forget_commit",
            "bool jk_bms_ble_scan_snapshot",
        )
        self.assertIn("configured = false", commit)
        self.assertIn("memset(&target_address", commit)
        self.assertIn('phase = "not_configured"', commit)
        self.assertNotIn("wifi", commit.lower())
        self.assertNotIn("history", commit.lower())

        handler = main_block(
            "static esp_err_t bms_forget_handler",
            "static esp_err_t wifi_reconnect_handler",
        )
        self.assertIn("temperature_config_reset()", handler)
        self.assertIn("wattpost_device_config_clear_bms_persisted", handler)
        self.assertLess(
            handler.index("temperature_config_reset()"),
            handler.index("wattpost_device_config_clear_bms_persisted"),
        )
        self.assertNotIn("wattpost_device_config_erase_store", handler)

        scoped = CONFIG[
            CONFIG.index("bool wattpost_device_config_clear_bms_persisted"):
            CONFIG.index("bool wattpost_device_config_erase_store")
        ]
        self.assertIn("wattpost_device_config_clear_bms(&config)", scoped)
        self.assertNotIn("clear_wifi", scoped)

    def test_forget_is_resetting_operation_until_transport_is_idle(self):
        self.assertIn("JK_BMS_BLE_PHASE_RESETTING", HEADER)
        start = ble_block(
            "jk_bms_ble_forget_start_result_t jk_bms_ble_forget_start",
            "bool jk_bms_ble_forget_commit",
        )
        self.assertIn("begin_bms_operation_locked(JK_BMS_BLE_PHASE_RESETTING)", start)

        poll = ble_block("static void poll_task", "bool jk_bms_ble_start")
        self.assertIn("forget_active && forget_persisted", poll)
        self.assertIn("!gap_discovery_active", poll)
        self.assertIn("!gap_connection_active", poll)
        self.assertIn("JK_BMS_BLE_OPERATION_SUCCESS", poll)

    def test_forget_without_active_transport_finishes_immediately_after_persist(self):
        commit = ble_block(
            "bool jk_bms_ble_forget_commit",
            "bool jk_bms_ble_scan_snapshot",
        )
        self.assertIn(
            "cancel_scan || cancel_connect || terminate_connected",
            commit,
        )
        self.assertIn("if (cleanup_required)", commit)
        immediate = commit[
            commit.index("if (cleanup_required)"):
            commit.index("portEXIT_CRITICAL(&data_lock)", commit.index("if (cleanup_required)"))
        ]
        self.assertIn("else {", immediate)
        self.assertIn("JK_BMS_BLE_OPERATION_SUCCESS", immediate)

    def test_forget_late_connect_and_notifications_are_rejected(self):
        gap = ble_block("static int gap_event", "static void on_reset")
        self.assertIn("accept_connection = configured || selection_active", gap)
        self.assertIn("Ігнорування BLE connection після forget", gap)
        self.assertIn("accept_notification = configured || selection_active", gap)

    def test_forget_blocks_other_user_operations(self):
        scan = ble_block(
            "jk_bms_ble_scan_start_result_t jk_bms_ble_scan_start",
            "jk_bms_ble_select_start_result_t jk_bms_ble_select_start",
        )
        select = ble_block(
            "jk_bms_ble_select_start_result_t jk_bms_ble_select_start",
            "bool jk_bms_ble_select_take_validated_target",
        )
        reconnect = ble_block(
            "jk_bms_ble_reconnect_start_result_t jk_bms_ble_reconnect_start",
            "jk_bms_ble_forget_start_result_t jk_bms_ble_forget_start",
        )
        self.assertIn("forget_active", scan)
        self.assertIn("forget_active", select)
        self.assertIn("forget_active", reconnect)

    def test_contract_error_name_is_canonical(self):
        mapper = main_block(
            "static const char *bms_operation_error_str",
            "typedef struct {",
        )
        self.assertIn('"bms_invalid"', mapper)
        self.assertNotIn('"invalid_bms"', mapper)


if __name__ == "__main__":
    unittest.main()
