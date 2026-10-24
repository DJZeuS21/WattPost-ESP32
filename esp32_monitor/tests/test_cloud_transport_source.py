import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
TRANSPORT = (ROOT / "main" / "cloud_transport.c").read_text(encoding="utf-8")
HEADER = (ROOT / "main" / "cloud_transport.h").read_text(encoding="utf-8")
POLICY = (ROOT / "main" / "cloud_transport_policy.h").read_text(encoding="utf-8")
CMAKE = (ROOT / "main" / "CMakeLists.txt").read_text(encoding="utf-8")
HISTORY_FORMAT = (ROOT / "main" / "cloud_history_format.c").read_text(encoding="utf-8")
HISTORY_FORMAT_HEADER = (ROOT / "main" / "cloud_history_format.h").read_text(encoding="utf-8")
SDK_DEFAULTS = (ROOT / "sdkconfig.defaults").read_text(encoding="utf-8")


def block(source: str, start_marker: str, end_marker: str) -> str:
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    return source[start:end]


class CloudTransportSourceTests(unittest.TestCase):
    def test_https_uses_only_public_wattpost_origin_and_ca_bundle(self):
        self.assertIn('#define CLOUD_BASE_URL "https://wattpost.pp.ua"', TRANSPORT)
        self.assertIn(
            '#define CLOUD_HELLO_URL CLOUD_BASE_URL "/api/v1/device/hello"',
            TRANSPORT,
        )
        self.assertIn(
            '#define CLOUD_PAIRINGS_URL CLOUD_BASE_URL "/api/v1/device/pairings"',
            TRANSPORT,
        )
        self.assertIn(
            '#define CLOUD_TELEMETRY_URL CLOUD_BASE_URL "/api/v1/device/telemetry"',
            TRANSPORT,
        )
        self.assertIn(
            '#define CLOUD_PAIR_URL_PREFIX CLOUD_BASE_URL "/pair#token="',
            TRANSPORT,
        )
        create_client = block(
            TRANSPORT,
            "static esp_http_client_handle_t create_client",
            "static void update_registration_state",
        )
        self.assertIn(".crt_bundle_attach = esp_crt_bundle_attach", create_client)
        self.assertIn(".keep_alive_enable = true", create_client)
        self.assertIn(".disable_auto_redirect = true", create_client)
        self.assertIn(".max_authorization_retries = -1", create_client)
        self.assertNotIn("skip_cert_common_name_check", TRANSPORT)
        self.assertNotIn("http://wattpost", TRANSPORT.lower())
        self.assertIn("CONFIG_MBEDTLS_CERTIFICATE_BUNDLE=y", SDK_DEFAULTS)
        self.assertIn("CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_DEFAULT_FULL=y", SDK_DEFAULTS)
        self.assertIn("CONFIG_MBEDTLS_DYNAMIC_BUFFER=y", SDK_DEFAULTS)
        self.assertIn("CONFIG_MBEDTLS_SSL_IN_CONTENT_LEN=8192", SDK_DEFAULTS)
        self.assertIn("CONFIG_MBEDTLS_SSL_OUT_CONTENT_LEN=4096", SDK_DEFAULTS)
        self.assertIn("esp_http_client", CMAKE)
        self.assertIn("mbedtls", CMAKE)

    def test_credentials_are_headers_only_and_scrubbed(self):
        request = block(
            TRANSPORT,
            "static bool configure_authenticated_request",
            "static void scrub_authenticated_request",
        )
        scrub = block(
            TRANSPORT,
            "static void scrub_authenticated_request",
            "static esp_err_t perform_authenticated_request",
        )
        self.assertIn('"Authorization"', request)
        self.assertIn('"X-WattPost-Ownership-Epoch"', request)
        self.assertNotIn("ESP_LOG", request)
        self.assertIn(
            'esp_http_client_delete_header(client, "Authorization")',
            scrub,
        )
        self.assertIn(
            'esp_http_client_delete_header(client, "X-WattPost-Ownership-Epoch")',
            scrub,
        )
        self.assertIn("esp_http_client_set_user_data(client, NULL)", scrub)
        self.assertIn("memset(identity, 0, sizeof(*identity))", scrub)
        self.assertIn("memset(authorization, 0", scrub)
        self.assertNotIn(".device_secret", MAIN)
        context_start = MAIN.index('static void history_context_string(')
        context_end = MAIN.index('static esp_err_t device_status_handler(', context_start)
        # Public history namespace is the sole allowed ID reader; no secret or
        # credential fields are added to HTTP payloads or diagnostics.
        self.assertNotIn('.device_id', MAIN[:context_start] + MAIN[context_end:])

    def test_bodyless_cloud_requests_accept_already_absent_content_type(self):
        clear_body = block(
            TRANSPORT,
            "static bool clear_request_body",
            "static bool configure_authenticated_request",
        )
        self.assertIn(
            "esp_http_client_set_post_field(client, NULL, 0)",
            clear_body,
        )
        self.assertIn("err == ESP_OK || err == ESP_ERR_NOT_FOUND", clear_body)

        request = block(
            TRANSPORT,
            "static bool configure_authenticated_request",
            "static void scrub_authenticated_request",
        )
        bodyless = request[request.index("} else if (!clear_request_body") :]
        self.assertNotIn(
            'esp_http_client_delete_header(client, "Content-Type")',
            bodyless,
        )

    def test_pairing_url_is_strictly_validated_before_local_exposure(self):
        validator = block(
            TRANSPORT,
            "static bool safe_pair_url",
            "static bool parse_success_data",
        )
        self.assertIn("CLOUD_PAIR_URL_PREFIX", validator)
        self.assertIn("CLOUD_PAIR_TOKEN_LENGTH", validator)
        self.assertIn("isalnum(c)", validator)
        self.assertIn("c == '-' || c == '_'", validator)

        status = block(
            MAIN,
            "static esp_err_t device_status_handler",
            "typedef struct {",
        )
        self.assertIn("cloud.pairing_url", status)
        self.assertIn("wattpost_json_escape", status)
        self.assertNotIn("device_secret", status)
        self.assertNotIn("device_id", status)

    def test_pair_and_disconnect_local_handlers_are_asynchronous(self):
        pair_handler = block(
            MAIN,
            "static esp_err_t cloud_pair_start_handler",
            "static esp_err_t cloud_disconnect_handler",
        )
        disconnect_handler = block(
            MAIN,
            "static esp_err_t cloud_disconnect_handler",
            "static bool device_operation_busy_for_factory_reset",
        )
        self.assertIn("wattpost_cloud_transport_pairing_start", pair_handler)
        self.assertIn('"202 Accepted"', pair_handler)
        self.assertNotIn("esp_http_client", pair_handler)
        self.assertIn("wattpost_cloud_transport_disconnect_start", disconnect_handler)
        self.assertIn('"disconnect_cloud"', disconnect_handler)
        self.assertIn('"202 Accepted"', disconnect_handler)
        self.assertNotIn("esp_http_client", disconnect_handler)

    def test_disconnect_persists_new_epoch_before_cloud_sync(self):
        disconnect = block(
            TRANSPORT,
            "wattpost_cloud_transport_disconnect_start",
            "bool wattpost_cloud_transport_snapshot",
        )
        self.assertIn(
            "wattpost_device_identity_advance_ownership_epoch",
            disconnect,
        )
        self.assertLess(
            disconnect.index("wattpost_device_identity_advance_ownership_epoch"),
            disconnect.index("cloud_disconnect_epoch_ready = true"),
        )
        self.assertIn("cloud_snapshot.disconnect_pending = true", disconnect)
        self.assertIn("xTaskNotifyGive(task)", disconnect)

    def test_transport_is_separate_best_effort_task(self):
        app = MAIN[MAIN.index("void app_main(void)") :]
        self.assertIn("wattpost_cloud_transport_start(wifi_has_ip)", app)
        self.assertIn(
            "Cloud transport task unavailable; local operation continues",
            app,
        )
        self.assertNotIn("ESP_ERROR_CHECK(wattpost_cloud_transport_start", app)
        self.assertIn('"cloud"', TRANSPORT)
        self.assertIn("xTaskCreate(", TRANSPORT)
        self.assertIn("CLOUD_TASK_STACK_BYTES 10240", TRANSPORT)
        self.assertIn("update_stack_high_water()", TRANSPORT)

    def test_wifi_ip_events_only_notify_cloud_transport(self):
        event = block(MAIN, "static void network_event", "static void history_task")
        self.assertIn("wattpost_cloud_transport_network_changed(false)", event)
        self.assertIn("wattpost_cloud_transport_network_changed(true)", event)
        self.assertNotIn("wattpost_cloud_transport_start", event)

        changed = block(
            TRANSPORT,
            "void wattpost_cloud_transport_network_changed",
            "wattpost_cloud_action_start_result_t",
        )
        self.assertIn("cloud_network_available = network_available", changed)
        self.assertIn("xTaskNotifyGive(task)", changed)
        self.assertNotIn("esp_restart", changed)
        self.assertNotIn("esp_wifi_", changed)

    def test_telemetry_is_paired_latest_only_and_has_no_backlog(self):
        self.assertIn("CLOUD_TELEMETRY_INTERVAL_MS 5000u", TRANSPORT)
        app = MAIN[MAIN.index("void app_main(void)") :]
        self.assertIn(
            "wattpost_cloud_transport_set_telemetry_provider",
            app,
        )
        self.assertLess(
            app.index("wattpost_cloud_transport_set_telemetry_provider"),
            app.index("wattpost_cloud_transport_start(wifi_has_ip)"),
        )

        provider = block(
            MAIN,
            "static bool cloud_telemetry_snapshot",
            "static wattpost_config_load_result_t load_device_config_snapshot",
        )
        self.assertIn("jk_bms_ble_get_data(&data)", provider)
        self.assertIn("telemetry->voltage_v = data.pack_voltage_v", provider)
        self.assertIn("telemetry->current_a = data.current_a", provider)
        self.assertIn("telemetry->power_w = data.power_w", provider)
        self.assertIn("telemetry->soc = data.state_of_charge", provider)
        self.assertIn(
            "(float) data.bms_cell_voltage_delta_mv * 0.001f",
            provider,
        )
        self.assertNotIn("telemetry->cell_spread_v = data.cell_spread_v", provider)
        self.assertIn("data.cell_active_mask", provider)
        self.assertIn("telemetry->cells_v[cell_count++] =", provider)
        self.assertIn("temperature_resolve_capabilities", provider)
        self.assertIn("channel->alias_of != NULL", provider)
        self.assertNotIn("wifi_ssid_display", provider)
        self.assertNotIn("bms_address_hint", provider)

        upload = block(
            TRANSPORT,
            "static bool run_telemetry_attempt",
            "static bool interval_due",
        )
        self.assertIn("provider(&telemetry)", upload)
        self.assertIn("wattpost_cloud_format_telemetry_json", upload)
        self.assertIn("HTTP_METHOD_PUT", upload)
        self.assertIn("CLOUD_TELEMETRY_URL", upload)
        self.assertIn("http_status == 204", upload)
        self.assertNotIn("malloc(", upload)
        self.assertNotIn("realloc(", upload)

        task = block(
            TRANSPORT,
            "static void cloud_transport_task",
            "void wattpost_cloud_transport_set_telemetry_provider",
        )
        self.assertIn("regular_snapshot.paired", task)
        self.assertIn("run_telemetry_attempt(client, &backoff_ms)", task)
        self.assertIn("CLOUD_TELEMETRY_INTERVAL_MS", task)
        self.assertNotIn("telemetry_queue", TRANSPORT.lower())
        self.assertNotIn("telemetry_backlog", TRANSPORT.lower())

    def test_history_sync_is_paired_bounded_low_priority_and_best_effort(self):
        self.assertIn('#define CLOUD_HISTORY_URL CLOUD_BASE_URL "/api/v1/device/history"', TRANSPORT)
        self.assertIn('#define CLOUD_HISTORY_STATUS_URL CLOUD_BASE_URL "/api/v1/device/history/status"', TRANSPORT)
        self.assertIn("#define CLOUD_HISTORY_INTERVAL_MS 15000u", TRANSPORT)
        self.assertIn("WATTPOST_CLOUD_HISTORY_MAX_RECORDS 12u", HISTORY_FORMAT_HEADER)
        self.assertIn("WATTPOST_CLOUD_HISTORY_JSON_MAX_LEN 4096u", HISTORY_FORMAT_HEADER)
        self.assertIn("char history[WATTPOST_CLOUD_HISTORY_JSON_MAX_LEN]", TRANSPORT)
        self.assertIn("static cloud_json_scratch_t cloud_json_scratch", TRANSPORT)
        self.assertIn('"cloud_history_format.c"', CMAKE)
        self.assertNotIn("wattpost_history_record_t records[", HISTORY_FORMAT)
        self.assertIn("wattpost_history_visit_window", TRANSPORT)
        self.assertNotIn("wattpost_history_record_t batch[", TRANSPORT)
        self.assertNotIn("wattpost_history_record_t records[", TRANSPORT)
        self.assertIn("_Static_assert(sizeof(wattpost_history_record_t) == 64u", (
            ROOT / "tests" / "test_cloud_history_format.c"
        ).read_text(encoding="utf-8"))

        attempt = block(
            TRANSPORT,
            "static bool run_history_attempt",
            "static bool create_pairing_attempt",
        )
        self.assertIn("CLOUD_HISTORY_STATUS_URL", attempt)
        self.assertIn("CLOUD_HISTORY_URL", attempt)
        self.assertIn("HTTP_METHOD_GET", attempt)
        self.assertIn("HTTP_METHOD_PUT", attempt)
        self.assertIn("wattpost_cloud_history_format_append", TRANSPORT)
        self.assertIn("http_status == 409", attempt)
        self.assertNotIn("wattpost_cloud_retry_after_failure", attempt)
        self.assertNotIn("backoff_ms", attempt)
        self.assertFalse(any(
            "ESP_LOG" in line and "cloud_json_scratch.history" in line
            for line in TRANSPORT.splitlines()
        ))

        task = block(
            TRANSPORT,
            "static void cloud_transport_task",
            "void wattpost_cloud_transport_set_telemetry_provider",
        )
        history_call = task.index("run_history_attempt(client)")
        self.assertLess(task.index("run_telemetry_attempt(client, &backoff_ms)"), history_call)
        self.assertLess(task.index("action_kind == WATTPOST_CLOUD_ACTION_DISCONNECT"), history_call)
        self.assertLess(task.index("action_kind == WATTPOST_CLOUD_ACTION_PAIR"), history_call)
        self.assertLess(task.index("pairing_state == WATTPOST_CLOUD_PAIRING_PENDING"), history_call)
        self.assertLess(task.index("if (!regular_snapshot.paired)"), history_call)
        self.assertIn("CLOUD_HISTORY_INTERVAL_MS", task)

        for counter in (
            "history_attempts",
            "history_successes",
            "history_failures",
            "history_records_sent",
        ):
            self.assertIn(counter, HEADER)
        self.assertNotIn("cloud_history_json", MAIN)
        self.assertNotIn("device_secret", MAIN)

    def test_settings_upload_is_paired_fingerprinted_rate_limited_and_best_effort(self):
        self.assertIn('#define CLOUD_SETTINGS_URL CLOUD_BASE_URL "/api/v1/device/settings"', TRANSPORT)
        self.assertIn("#define CLOUD_SETTINGS_CHECK_INTERVAL_MS 15000u", TRANSPORT)
        self.assertIn("#define CLOUD_SETTINGS_ATTEMPT_INTERVAL_MS 60000u", TRANSPORT)
        self.assertIn("char settings[CLOUD_SETTINGS_JSON_MAX_LEN]", TRANSPORT)
        self.assertIn("char telemetry[WATTPOST_CLOUD_TELEMETRY_JSON_MAX_LEN]", TRANSPORT)
        self.assertEqual(TRANSPORT.count("static cloud_json_scratch_t cloud_json_scratch"), 1)
        self.assertIn("static uint32_t settings_crc32", TRANSPORT)
        self.assertIn("wattpost_cloud_transport_set_settings_provider", TRANSPORT)
        self.assertIn("wattpost_settings_format_json", MAIN)
        self.assertIn("format_current_settings_json(output, output_capacity, true)", MAIN)
        self.assertNotIn("settings_response", MAIN)

        attempt = block(
            TRANSPORT,
            "static void run_settings_check",
            "static uint32_t interval_remaining_ms",
        )
        self.assertIn("CLOUD_SETTINGS_URL", attempt)
        self.assertIn("CLOUD_SETTINGS_ATTEMPT_INTERVAL_MS", attempt)
        self.assertIn("HTTP_METHOD_PUT", attempt)
        self.assertIn("settings_crc32", attempt)
        self.assertNotIn("wattpost_cloud_retry_after_failure", attempt)
        self.assertNotIn("backoff_ms", attempt)
        self.assertFalse(any(
            "ESP_LOG" in line and "cloud_json_scratch.settings" in line
            for line in TRANSPORT.splitlines()
        ))

        task = block(
            TRANSPORT,
            "static void cloud_transport_task",
            "void wattpost_cloud_transport_set_telemetry_provider",
        )
        history_call = task.index("run_history_attempt(client)")
        settings_call = task.index("run_settings_check(client)")
        self.assertLess(task.index("run_telemetry_attempt(client, &backoff_ms)"), history_call)
        self.assertLess(history_call, settings_call)
        self.assertLess(task.index("if (!regular_snapshot.paired)"), settings_call)
        self.assertIn("CLOUD_SETTINGS_CHECK_INTERVAL_MS", task)
        self.assertIn("cloud_settings_force_resend = true", task)

        for counter in (
            "settings_attempts",
            "settings_successes",
            "settings_failures",
            "settings_last_success_age_s",
        ):
            self.assertIn(counter, HEADER)
            self.assertIn(counter, MAIN)

    def test_cloud_failure_has_bounded_backoff_and_no_restart(self):
        self.assertIn("WATTPOST_CLOUD_RETRY_INITIAL_MS 5000u", POLICY)
        self.assertIn("WATTPOST_CLOUD_RETRY_MAX_MS 60000u", POLICY)
        self.assertIn("CLOUD_HTTP_TIMEOUT_MS 5000", TRANSPORT)
        self.assertIn("wattpost_cloud_retry_after_failure", TRANSPORT)
        self.assertEqual(TRANSPORT.count("esp_restart();"), 1)
        ota_install = block(
            TRANSPORT,
            "static bool install_ota_target",
            "static bool process_ota_boot_marker",
        )
        self.assertIn("esp_restart();", ota_install)
        self.assertNotIn("recovery_restart", TRANSPORT)
        self.assertNotIn("nvs_flash_erase", TRANSPORT)

    def test_keep_alive_client_is_reused_across_all_cloud_requests(self):
        task = block(
            TRANSPORT,
            "static void cloud_transport_task",
            "bool wattpost_cloud_transport_start",
        )
        self.assertIn("esp_http_client_handle_t client = NULL", task)
        self.assertEqual(task.count("client = create_client()"), 1)
        self.assertNotIn("esp_http_client_cleanup(client)", task)
        request = block(
            TRANSPORT,
            "static esp_err_t perform_authenticated_request",
            "static esp_err_t perform_hello",
        )
        self.assertIn("esp_http_client_perform(client)", request)
        self.assertIn("esp_http_client_close(client)", request)

    def test_diagnostics_expose_only_scrubbed_transport_metrics(self):
        diagnostics = block(
            MAIN,
            "static esp_err_t diagnostics_handler",
            "static esp_err_t coredump_download_handler",
        )
        self.assertIn('"\\\"cloud_transport\\\":{"', diagnostics)
        for key in (
            "task_started",
            "network_available",
            "attempts",
            "successes",
            "failures",
            "current_backoff_ms",
            "stack_free_min_bytes",
            "heap_free_before_last",
            "heap_free_after_last",
            "largest_free_before_last",
            "largest_free_after_last",
            "last_success_age_s",
            "telemetry_attempts",
            "telemetry_successes",
            "telemetry_failures",
            "telemetry_last_sample_seq",
            "telemetry_last_success_age_s",
            "history_attempts",
            "history_successes",
            "history_failures",
            "history_records_sent",
        ):
            self.assertIn(key, diagnostics)
        self.assertNotIn("device_secret", diagnostics)
        self.assertNotIn("device_id", diagnostics)
        self.assertNotIn("Authorization", diagnostics)


if __name__ == "__main__":
    unittest.main()
