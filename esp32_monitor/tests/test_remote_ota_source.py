import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REMOTE = (ROOT / "main" / "remote_ota.c").read_text(encoding="utf-8")
REMOTE_H = (ROOT / "main" / "remote_ota.h").read_text(encoding="utf-8")
CLOUD = (ROOT / "main" / "cloud_transport.c").read_text(encoding="utf-8")
CLOUD_H = (ROOT / "main" / "cloud_transport.h").read_text(encoding="utf-8")
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
CMAKE = (ROOT / "main" / "CMakeLists.txt").read_text(encoding="utf-8")
PUBLIC_KEY = (ROOT / "main" / "wattpost_firmware_public_key.pub").read_text(encoding="utf-8")


def block(source: str, start: str, end: str) -> str:
    begin = source.index(start)
    finish = source.index(end, begin)
    return source[begin:finish]


class RemoteOtaSourceTests(unittest.TestCase):
    def test_public_key_only_is_embedded(self):
        self.assertIn("BEGIN PUBLIC KEY", PUBLIC_KEY)
        self.assertNotIn("PRIVATE KEY", PUBLIC_KEY)
        self.assertIn('EMBED_TXTFILES "wattpost_firmware_public_key.pub"', CMAKE)
        self.assertNotIn("private", CMAKE.lower())

    def test_manifest_is_canonical_and_signed_with_sha256_p256(self):
        for literal in (
            "WATTPOST-FIRMWARE-MANIFEST-V1\\n",
            "version=%s\\n",
            "build_id=%s\\n",
            "size_bytes=%lu\\n",
            "sha256=%s\\n",
        ):
            self.assertIn(literal, REMOTE)
        self.assertIn("mbedtls_sha256", REMOTE)
        self.assertIn("mbedtls_pk_parse_public_key", REMOTE)
        self.assertIn("mbedtls_pk_verify", REMOTE)
        self.assertIn("MBEDTLS_MD_SHA256", REMOTE)

    def test_target_is_strictly_bounded_and_newer(self):
        self.assertIn("REMOTE_OTA_MAX_IMAGE_BYTES 0x1D0000u", REMOTE)
        self.assertIn("wattpost_remote_ota_version_is_newer", REMOTE)
        self.assertIn("valid_download_path", REMOTE)
        self.assertIn('"/api/v1/device/ota/firmware/%lu"', REMOTE)
        self.assertIn("WATTPOST_REMOTE_OTA_SIGNATURE_MAX_LEN 129u", REMOTE_H)

    def test_image_is_streamed_without_full_firmware_buffer(self):
        stream = block(CLOUD, "static bool stream_ota_image", "static bool install_ota_target")
        self.assertIn("esp_http_client_read", stream)
        self.assertIn("esp_ota_write", stream)
        self.assertIn("mbedtls_sha256_update", stream)
        self.assertIn("CLOUD_OTA_CHUNK_SIZE 1024u", CLOUD)
        self.assertIn("cloud_json_scratch.ota_chunk", stream)
        self.assertNotIn("malloc(", stream)
        self.assertNotIn("calloc(", stream)
        self.assertNotIn("realloc(", stream)
        self.assertNotIn("1500000", CLOUD)

    def test_partition_erase_finishes_before_firmware_http_response_is_opened(self):
        stream = block(CLOUD, "static bool stream_ota_image", "static bool ota_download_error_retryable")
        begin = stream.index("esp_ota_begin(partition, target->size_bytes, &update)")
        open_http = stream.index("esp_http_client_open(client, 0)")
        fetch_headers = stream.index("esp_http_client_fetch_headers(client)")
        self.assertLess(begin, open_http)
        self.assertLess(begin, fetch_headers)
        self.assertIn("synchronously erases the target", stream)

    def test_remote_ota_uses_bounded_range_segments_and_resumes_from_written_bytes(self):
        stream = block(CLOUD, "static bool stream_ota_image", "static bool ota_download_error_retryable")
        self.assertIn("CLOUD_OTA_RANGE_SIZE (64u * 1024u)", CLOUD)
        self.assertIn("CLOUD_OTA_MAX_RANGE_REQUESTS 128u", CLOUD)
        self.assertIn('esp_http_client_set_header(client, "Range", range_header)', stream)
        self.assertIn("http_status == 206", stream)
        self.assertIn("const uint32_t range_start = total", stream)
        self.assertIn("total += (uint32_t) received", stream)
        self.assertIn("Resume from exactly the bytes already written and hashed", stream)
        self.assertIn("esp_http_client_clear_response_buffer(client)", stream)
        self.assertNotIn("malloc(CLOUD_OTA_RANGE_SIZE", stream)

    def test_ota_read_timeout_is_retried_but_bounded(self):
        stream = block(CLOUD, "static bool stream_ota_image", "static bool install_ota_target")
        self.assertIn("CLOUD_OTA_MAX_CONSECUTIVE_READ_TIMEOUTS 3u", CLOUD)
        self.assertIn("received == -ESP_ERR_HTTP_EAGAIN", stream)
        self.assertIn("++consecutive_read_timeouts", stream)
        self.assertIn("<=\n                    CLOUD_OTA_MAX_CONSECUTIVE_READ_TIMEOUTS", stream)
        self.assertIn('"download_timeout"', stream)
        self.assertIn("consecutive_read_timeouts = 0u", stream)

    def test_transport_download_is_retried_from_zero_but_globally_bounded(self):
        install = block(CLOUD, "static bool install_ota_target", "static bool process_ota_boot_marker")
        self.assertIn("CLOUD_OTA_MAX_DOWNLOAD_ATTEMPTS 3u", CLOUD)
        self.assertIn("ota_download_error_retryable", CLOUD)
        self.assertIn('strcmp(error, "download_failed") == 0', CLOUD)
        self.assertIn('strcmp(error, "download_timeout") == 0', CLOUD)
        self.assertIn("attempt <= CLOUD_OTA_MAX_DOWNLOAD_ATTEMPTS", install)
        self.assertIn("client, target, attempt, &target_partition, &failure", install)
        self.assertIn("retrying from byte 0", install)
        self.assertEqual(install.count("esp_restart();"), 1)

    def test_ota_progress_is_reported_only_after_confirmed_flash_writes(self):
        stream = block(CLOUD, "static bool stream_ota_image", "static bool ota_download_error_retryable")
        self.assertIn("report_ota_download_progress", CLOUD)
        self.assertIn("total += (uint32_t) received;", stream)
        self.assertLess(stream.index("esp_ota_write("), stream.index("total += (uint32_t) received;"))
        self.assertLess(stream.index("esp_http_client_close(client);", stream.index("segment_received +=")),
                        stream.index("report_ota_download_progress(", stream.index("segment_received +=")))
        self.assertIn("report_step = target->size_bytes / 10u", stream)
        self.assertIn("if (report_ota_download_progress(", stream)
        self.assertIn("last_reported = total", stream)

    def test_terminal_old_release_is_not_presented_as_retryable_update(self):
        poll = block(CLOUD, "static bool run_ota_poll_attempt", "static esp_err_t perform_hello")
        self.assertIn("wattpost_remote_ota_version_is_newer", poll)
        self.assertIn("state_version, WATTPOST_FIRMWARE_VERSION", poll)
        self.assertIn("WATTPOST_CLOUD_OTA_IDLE, false, 0u, NULL, NULL, NULL", poll)

    def test_ota_uses_existing_cloud_task_and_single_http_client(self):
        self.assertEqual(CLOUD.count("xTaskCreate("), 1)
        self.assertIn("CLOUD_TASK_STACK_BYTES 10240", CLOUD)
        task = block(
            CLOUD,
            "static void cloud_transport_task",
            "void wattpost_cloud_transport_set_telemetry_provider",
        )
        self.assertIn("run_ota_poll_attempt(client)", task)
        self.assertIn("run_telemetry_attempt(client, &backoff_ms)", task)
        self.assertIn("run_history_attempt(client)", task)
        self.assertIn("run_settings_check(client)", task)

    def test_boot_marker_handles_valid_and_rollback_results(self):
        marker = block(REMOTE, "bool wattpost_remote_ota_marker_load", "bool wattpost_remote_ota_marker_clear")
        self.assertIn('REMOTE_OTA_NAMESPACE "remote_ota"', REMOTE)
        self.assertIn("nvs_get_u32", marker)
        self.assertIn("nvs_set_u32", marker)
        boot = block(CLOUD, "static bool process_ota_boot_marker", "static bool run_ota_poll_attempt")
        self.assertIn('"rolled_back"', boot)
        self.assertIn('"success"', boot)
        self.assertIn("ESP_OTA_IMG_PENDING_VERIFY", boot)
        self.assertIn("ESP_OTA_IMG_VALID", boot)
        self.assertIn("wattpost_remote_ota_marker_clear", boot)

    def test_automatic_update_preference_is_device_owned_and_persistent(self):
        self.assertIn('REMOTE_OTA_KEY_AUTOMATIC "auto_update"', REMOTE)
        self.assertIn("wattpost_remote_ota_automatic_updates_get", REMOTE_H)
        self.assertIn("wattpost_remote_ota_automatic_updates_set", REMOTE_H)
        getter = block(
            REMOTE,
            "bool wattpost_remote_ota_automatic_updates_get",
            "bool wattpost_remote_ota_automatic_updates_set",
        )
        self.assertIn("return true;", getter)
        self.assertIn("nvs_get_u8", getter)
        setter = REMOTE[REMOTE.index("bool wattpost_remote_ota_automatic_updates_set"): ]
        self.assertIn("nvs_set_u8", setter)
        self.assertIn("nvs_commit", setter)

    def test_marker_cleanup_preserves_automatic_update_preference(self):
        marker_clear = block(
            REMOTE,
            "bool wattpost_remote_ota_marker_clear",
            "bool wattpost_remote_ota_automatic_updates_get",
        )
        self.assertIn("nvs_erase_key", marker_clear)
        self.assertIn("REMOTE_OTA_KEY_RELEASE", marker_clear)
        self.assertIn("REMOTE_OTA_KEY_VERSION", marker_clear)
        self.assertIn("REMOTE_OTA_KEY_BUILD", marker_clear)
        self.assertNotIn("nvs_erase_all", marker_clear)
        self.assertNotIn("REMOTE_OTA_KEY_AUTOMATIC", marker_clear)

    def test_preference_off_blocks_legacy_auto_target_but_keeps_manual_install(self):
        poll = block(CLOUD, "static bool run_ota_poll_attempt", "static esp_err_t perform_hello")
        self.assertIn("manual_authorized", poll)
        self.assertIn("server_manual_trigger", poll)
        self.assertIn("wattpost_remote_ota_automatic_updates_get", poll)
        self.assertIn("if (!automatic_updates && !explicit_manual)", poll)
        gate = poll.index("if (!automatic_updates && !explicit_manual)")
        install = poll.index("install_ota_target(client, &target)")
        self.assertLess(gate, install)
        self.assertIn("return true;", poll[gate:install])

    def test_local_preference_endpoint_is_token_protected_and_factory_reset_clears_it(self):
        handler = block(
            MAIN,
            "static esp_err_t firmware_update_preferences_handler",
            "static esp_err_t firmware_update_install_handler",
        )
        self.assertIn("local_mutation_request_allowed", handler)
        self.assertIn("parse_automatic_updates_request", handler)
        self.assertIn("wattpost_remote_ota_automatic_updates_set", handler)
        self.assertIn("wattpost_cloud_transport_ota_preference_changed", handler)
        self.assertIn('"/api/device/ota/preferences"', MAIN)
        self.assertIn("HTTP_PUT", MAIN)
        factory = block(MAIN, "static bool perform_full_factory_reset", "static bool consume_deferred_restart")
        self.assertIn('erase_nvs_namespace("remote_ota")', factory)

    def test_cloud_preference_sync_uses_existing_task_and_exact_generation_ack(self):
        self.assertIn('CLOUD_OTA_PREFERENCES_URL', CLOUD)
        self.assertIn('CLOUD_OTA_PREFERENCE_INTERVAL_MS 60000u', CLOUD)
        self.assertEqual(CLOUD.count('xTaskCreate('), 1)
        report = block(CLOUD, 'static bool report_ota_preference', 'static bool request_manual_ota')
        self.assertIn('command_generation', report)
        self.assertIn('HTTP_METHOD_PUT', report)
        self.assertIn('CLOUD_OTA_PREFERENCES_URL', report)
        poll = block(CLOUD, 'static bool run_ota_poll_attempt', 'static esp_err_t perform_hello')
        self.assertIn('preference.pending_generation', poll)
        self.assertIn('wattpost_remote_ota_automatic_updates_set(desired)', poll)
        self.assertIn('report_ota_preference(', poll)
        self.assertIn('preference.pending_generation', poll)
        self.assertLess(
            poll.index('wattpost_remote_ota_automatic_updates_set(desired)'),
            poll.index('report_ota_preference('),
        )

    def test_local_preference_change_marks_cloud_report_dirty_without_new_task(self):
        changed = CLOUD[CLOUD.index('void wattpost_cloud_transport_ota_preference_changed'): ]
        self.assertIn('cloud_ota_preference_force_report = true', changed)
        self.assertIn('xTaskNotifyGive(task)', changed)
        self.assertEqual(CLOUD.count('xTaskCreate('), 1)

    def test_failed_release_does_not_create_restart_loop(self):
        install = block(CLOUD, "static bool install_ota_target", "static bool process_ota_boot_marker")
        self.assertEqual(install.count("esp_restart();"), 1)
        self.assertIn('"signature_invalid"', install)
        self.assertIn('"hash_mismatch"', CLOUD)
        self.assertIn('"failed"', install)

    def test_local_ui_path_reuses_remote_ota_state_machine(self):
        self.assertIn('"/api/device/ota"', MAIN)
        self.assertIn('"/api/device/ota/install"', MAIN)
        handler = block(
            MAIN,
            "static esp_err_t firmware_update_install_handler",
            "static esp_err_t cloud_disconnect_handler",
        )
        self.assertIn("local_mutation_request_allowed", handler)
        self.assertIn("wattpost_cloud_transport_ota_install_start", handler)
        self.assertNotIn("esp_ota_write", handler)
        self.assertIn("wattpost_cloud_transport_ota_install_start", CLOUD_H)


if __name__ == "__main__":
    unittest.main()
