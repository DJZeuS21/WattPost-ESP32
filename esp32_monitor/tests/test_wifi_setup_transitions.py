"""Execute production transition functions with a fake radio/NVS (no ESP flashing)."""
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'main/main.c').read_text()


def function(name):
    match = re.search(r'static [^\n]+\b' + name + r'\([^;]*?\) \{', SOURCE)
    if not match:
        raise AssertionError(name)
    start = match.start()
    position = SOURCE.index('{', start)
    depth = 1
    while depth:
        position += 1
        depth += (SOURCE[position] == '{') - (SOURCE[position] == '}')
    return SOURCE[start:position + 1]


PRELUDE = r'''
#include <assert.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include "device_config.h"
#define portENTER_CRITICAL(x) ((void)0)
#define portEXIT_CRITICAL(x) ((void)0)
#define ESP_LOGW(...) ((void)0)
#define ESP_LOGE(...) ((void)0)
#define ESP_OK 0
#define ESP_ERR_WIFI_NOT_CONNECT 1
#define ESP_ERR_WIFI_STATE 2
#define WIFI_IF_STA 0
#define WIFI_MODE_STA 1
#define WIFI_SCAN_TYPE_ACTIVE 0
typedef int esp_err_t;
typedef struct { struct { bool bssid_set; uint8_t bssid[6], channel, ssid[32]; } sta; } wifi_config_t;
typedef struct { uint8_t ssid[33], bssid[6]; } wifi_ap_record_t;
typedef struct { uint8_t ssid[32], ssid_len, bssid[6]; } wifi_event_sta_connected_t;
typedef struct { bool show_hidden; int scan_type; } wifi_scan_config_t;
typedef struct { struct { uint32_t addr; } ip; } esp_netif_ip_info_t;
typedef struct { void *esp_netif; esp_netif_ip_info_t ip_info; } ip_event_got_ip_t;
static void *wifi_netif = (void *) 1;
static uint32_t actual_ip = 1;
static bool netif_up = true;
static bool esp_netif_is_netif_up(void *netif) { assert(netif == wifi_netif); return netif_up; }
static int esp_netif_get_ip_info(void *netif, esp_netif_ip_info_t *info) { assert(netif == wifi_netif); info->ip.addr = actual_ip; return ESP_OK; }
enum { WIFI_OPERATION_IDLE, WIFI_OPERATION_RUNNING, WIFI_OPERATION_SUCCESS, WIFI_OPERATION_ERROR };
enum { WIFI_OPERATION_PHASE_NONE, WIFI_OPERATION_PHASE_CONNECTING, WIFI_OPERATION_PHASE_SAVING, WIFI_OPERATION_PHASE_SCANNING };
enum { WATTPOST_WIFI_BOOT_CONNECT_SAVED, WATTPOST_PROVISION_BOOT_NORMAL };
static bool wifi_has_ip, wifi_connecting, wifi_sta_started, wifi_runtime_error;
static bool device_wifi_configured, first_setup_ap_active, wifi_scan_running;
static bool wifi_rollback_preempt_requested, wifi_scan_start_pending;
static bool first_setup_wifi_retry_required;
static bool first_setup_bms_deferred;
static bool recovery_completion_pending, bms_configured;
static int64_t recovery_completed_us, first_setup_completed_us, now_us = 1000000;
static int wifi_operation_state, wifi_operation_phase, wifi_boot_action, provision_boot_action, device_config_status;
static const char *wifi_operation_error_code;
static char wifi_ssid_display[33];
static bool save_ok = true;
static wattpost_device_config_t saved_config;
static wifi_ap_record_t ap;
static int set_calls, connect_calls, disconnect_calls, scan_calls, save_calls, mode_calls, dns_calls;
static int disconnect_result = ESP_ERR_WIFI_NOT_CONNECT;
static int64_t esp_timer_get_time(void) { return now_us; }
static int64_t monotonic_age_seconds(int64_t start) { return (now_us - start) / 1000000; }
static bool wattpost_setup_ap_timeout_due(int64_t age) { return age >= 8; }
static const char *device_setup_state(void) { return device_wifi_configured && bms_configured ? "configured" : "bms_required"; }
static void wattpost_captive_dns_stop(void) { dns_calls++; }
static int esp_wifi_set_mode(int mode) { assert(mode == WIFI_MODE_STA); mode_calls++; return ESP_OK; }
static int esp_wifi_disconnect(void) { disconnect_calls++; return disconnect_result; }
static int esp_wifi_connect(void) { connect_calls++; return ESP_OK; }
static int esp_wifi_set_config(int iface, wifi_config_t *config) { assert(iface == WIFI_IF_STA); (void)config; set_calls++; return ESP_OK; }
static int esp_wifi_sta_get_ap_info(wifi_ap_record_t *out) { *out = ap; return ESP_OK; }
static int esp_wifi_scan_start(wifi_scan_config_t *config, bool wait) { (void)config; assert(!wait); scan_calls++; return ESP_OK; }
static void wifi_scan_mark_error(const char *code) { wifi_operation_state = WIFI_OPERATION_ERROR; wifi_operation_error_code = code; }
static const char *wifi_validation_error_for_disconnect_reason(uint8_t reason) { (void)reason; return "wifi_connect_failed"; }
static bool wifi_sta_config_from_device_config(const wattpost_device_config_t *device, wifi_config_t *sta) { memset(sta, 0, sizeof(*sta)); memcpy(sta->sta.ssid, device->wifi_ssid, device->wifi_ssid_len); return true; }
bool wattpost_device_config_save(const wattpost_device_config_t *value) { save_calls++; if (!save_ok) return false; saved_config = *value; return true; }
'''

SCENARIOS = r'''
static wattpost_device_config_t config(const char *ssid) {
    wattpost_device_config_t value = {0};
    value.wifi_configured = true; value.bms_configured = true;
    value.wifi_ssid_len = strlen(ssid); memcpy(value.wifi_ssid, ssid, value.wifi_ssid_len);
    return value;
}
static void begin(void) {
    memset(&wifi_validation, 0, sizeof(wifi_validation));
    memset(&wifi_rollback, 0, sizeof(wifi_rollback));
    memset(&ap, 0, sizeof(ap)); strcpy((char*) ap.ssid, "old");
    saved_config = config("old");
    wifi_validation.active = wifi_validation.installed_switch = wifi_validation.start_pending = true;
    wifi_validation.pending_config = config("new"); wifi_validation.rollback_config = saved_config;
    wifi_operation_state = WIFI_OPERATION_RUNNING; save_ok = true;
    first_setup_ap_active = device_wifi_configured = bms_configured = true;
    wifi_has_ip = true; wifi_scan_running = false; wifi_scan_start_pending = wifi_rollback_preempt_requested = false;
    first_setup_wifi_retry_required = false;
    first_setup_bms_deferred = false;
    first_setup_completed_us = 0; now_us = 1000000;
    actual_ip = 1;
    netif_up = true;
    set_calls = connect_calls = disconnect_calls = scan_calls = save_calls = mode_calls = dns_calls = 0;
    disconnect_result = ESP_ERR_WIFI_NOT_CONNECT;
}
static void associate_new(void) {
    wifi_event_sta_connected_t event = { .ssid_len = 3 };
    memcpy(event.ssid, "new", 3);
    wifi_validation_handle_connected(&event);
    strcpy((char*) ap.ssid, "new");
}
int main(void) {
    begin();
    assert(!wifi_validation_handle_got_ip()); assert(save_calls == 0);
    start_pending_installed_wifi_validation(); assert(set_calls == 0);
    /* Old connection can disappear before the HTTP reply; keep the new request. */
    assert(wifi_validation_handle_disconnect(0)); assert(wifi_validation.active && wifi_validation.start_pending);
    wifi_validation.start_armed = true;
    start_pending_installed_wifi_validation();
    assert(set_calls == 1 && !wifi_validation.start_pending && wifi_validation.pending_applied);
    assert(!wifi_validation_handle_got_ip()); assert(save_calls == 0);
    wifi_event_sta_connected_t wrong = { .ssid_len = 3 }; memcpy(wrong.ssid, "old", 3);
    wifi_validation_handle_connected(&wrong); assert(!wifi_validation.association_confirmed);
    associate_new(); assert(wifi_validation_handle_got_ip());
    assert(save_calls == 1 && memcmp(saved_config.wifi_ssid, "new", 3) == 0);
    assert(wifi_operation_state == WIFI_OPERATION_SUCCESS);

    /* Disconnect barrier consumes exactly one old event and applies once. */
    begin(); wifi_validation.start_armed = true; disconnect_result = ESP_OK;
    start_pending_installed_wifi_validation(); assert(set_calls == 0);
    assert(!wifi_validation_handle_got_ip());
    assert(wifi_validation_handle_disconnect(0)); assert(set_calls == 1);
    assert(!wifi_validation_apply_pending_config()); assert(set_calls == 1);

    /* Wrong password/new network error preserves NVS and rollback config. */
    begin(); wifi_validation.start_armed = true; start_pending_installed_wifi_validation();
    wifi_validation_handle_disconnect(0);
    assert(wifi_rollback.pending && wifi_rollback.config.bms_configured);
    assert(memcmp(wifi_rollback.config.wifi_ssid, "old", 3) == 0 && save_calls == 0);
    now_us += 20000000; maintain_first_setup_ap(); assert(first_setup_ap_active && mode_calls == 0);
    assert(!wifi_setup_operation_busy_locked() && wifi_operation_busy_locked());
    first_setup_ap_active = false; assert(wifi_setup_operation_busy_locked()); first_setup_ap_active = true;

    /* Storage failure must also preserve old configuration and captive AP. */
    begin(); wifi_validation.start_armed = true; start_pending_installed_wifi_validation(); associate_new();
    save_ok = false; assert(!wifi_validation_handle_got_ip());
    assert(wifi_rollback.pending && memcmp(saved_config.wifi_ssid, "old", 3) == 0);
    assert(strcmp(wifi_operation_error_code, "storage_error") == 0);
    maintain_first_setup_ap(); assert(first_setup_ap_active && dns_calls == 0);
    wifi_rollback.pending = false; wifi_has_ip = true; now_us += 20000000;
    maintain_first_setup_ap(); assert(first_setup_ap_active && mode_calls == 0);
    wifi_rollback.pending = true;

    /* Explicit retry cancels background rollback on its own worker. */
    wifi_scan_running = true; wifi_operation_state = WIFI_OPERATION_RUNNING;
    wifi_rollback_preempt_requested = wifi_scan_start_pending = true;
    maintain_wifi_setup_preemption(); assert(!wifi_rollback.pending && scan_calls == 0);
    const int old_set_calls = set_calls; maintain_wifi_rollback(); assert(set_calls == old_set_calls);
    maintain_wifi_setup_preemption(); assert(scan_calls == 1 && !wifi_scan_start_pending);
    assert(wifi_setup_operation_busy_locked());

    /* No AP shutdown without IP, or during rollback; grace restarts after loss. */
    begin(); memset(&wifi_validation, 0, sizeof(wifi_validation)); wifi_has_ip = false;
    first_setup_completed_us = now_us; now_us += 20000000;
    maintain_first_setup_ap(); assert(first_setup_ap_active && first_setup_completed_us == 0 && mode_calls == 0);
    wifi_has_ip = true; wifi_rollback.pending = true;
    maintain_first_setup_ap(); assert(first_setup_ap_active && mode_calls == 0);
    wifi_rollback.pending = false; maintain_first_setup_ap(); assert(first_setup_ap_active);
    actual_ip = 0; now_us += 9000000;
    maintain_first_setup_ap(); assert(first_setup_ap_active && first_setup_completed_us == 0);
    actual_ip = 2;
    netif_up = false;
    maintain_first_setup_ap(); assert(first_setup_ap_active && !wifi_station_ip_ready());
    netif_up = true;
    ip_event_got_ip_t old_ip = { .esp_netif = wifi_netif, .ip_info.ip.addr = 1 };
    assert(!wifi_got_ip_event_is_current(&old_ip));
    old_ip.ip_info.ip.addr = actual_ip;
    assert(wifi_got_ip_event_is_current(&old_ip));
    maintain_first_setup_ap();
    now_us += 9000000; maintain_first_setup_ap();
    assert(!first_setup_ap_active && mode_calls == 1 && dns_calls == 1);

    /* Wi-Fi-only setup must not close AP without an explicit user choice. */
    begin(); memset(&wifi_validation, 0, sizeof(wifi_validation));
    bms_configured = false;
    maintain_first_setup_ap(); now_us += 20000000;
    maintain_first_setup_ap();
    assert(first_setup_ap_active && first_setup_completed_us == 0 && mode_calls == 0);

    /* After explicit defer, loss of STA IP keeps the recovery path available. */
    first_setup_bms_deferred = true;
    wifi_has_ip = false;
    maintain_first_setup_ap();
    assert(first_setup_ap_active && first_setup_completed_us == 0);
    wifi_has_ip = true;
    maintain_first_setup_ap();
    assert(first_setup_completed_us == now_us);
    now_us += 9000000; maintain_first_setup_ap();
    assert(!first_setup_ap_active && mode_calls == 1 && dns_calls == 1);
    return 0;
}
'''


class WifiSetupTransitionTests(unittest.TestCase):
    def test_production_transitions_with_fake_radio_and_storage(self):
        types = '\n'.join(re.search(r'typedef struct \{[^}]+\} ' + name + ';', SOURCE).group()
                          for name in ['wifi_validation_state_t', 'wifi_rollback_state_t'])
        names = ['wifi_operation_busy_locked', 'wifi_setup_operation_busy_locked',
                 'wifi_validation_active_snapshot', 'wifi_rollback_pending_snapshot',
                 'wifi_validation_finish_error', 'wifi_validation_apply_pending_config',
                 'start_pending_installed_wifi_validation', 'wifi_validation_handle_disconnect',
                 'wifi_validation_handle_connected', 'wifi_validation_handle_got_ip',
                 'maintain_wifi_rollback', 'maintain_wifi_setup_preemption',
                 'wifi_station_ip_ready', 'wifi_got_ip_event_is_current', 'maintain_first_setup_ap']
        code = PRELUDE + types + '\nstatic wifi_validation_state_t wifi_validation;\nstatic wifi_rollback_state_t wifi_rollback;\n'
        code += '\n'.join(function(name) for name in names) + SCENARIOS
        with tempfile.TemporaryDirectory(prefix='wattpost-wifi-transitions-') as directory:
            source = Path(directory) / 'transitions.c'; source.write_text(code)
            binary = Path(directory) / 'transitions'
            built = subprocess.run(['gcc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', str(ROOT / 'main'), str(source), '-o', str(binary)], capture_output=True, text=True)
            self.assertEqual(built.returncode, 0, built.stderr)
            run = subprocess.run([str(binary)], capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
