"""Run the actual responder lifecycle with a fake mDNS library and Wi-Fi events."""
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "main/main.c").read_text()


def function(name):
    match = re.search(r"static [^\n]+\b" + name + r"\([^;]*?\) \{", SOURCE)
    if not match:
        raise AssertionError(name)
    pos = SOURCE.index("{", match.start())
    depth = 1
    end = pos
    while depth:
        end += 1
        depth += (SOURCE[end] == "{") - (SOURCE[end] == "}")
    return SOURCE[match.start():end + 1]


PRELUDE = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include "mdns_policy.h"
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGW(...) ((void)0)
#define ESP_LOGE(...) ((void)0)
#define ESP_OK 0
#define MDNS_EVENT_ANNOUNCE_IP4 1
#define portENTER_CRITICAL(x) ((void)0)
#define portEXIT_CRITICAL(x) ((void)0)
typedef int esp_err_t;
static bool mdns_started, mdns_recovery_pending, wifi_has_ip = true;
static void *wifi_netif = (void *)1;
static const char *mdns_pending_reason = "none", *mdns_last_recovery_reason = "none";
static uint32_t mdns_recovery_count, mdns_announce_count;
static int64_t mdns_last_start_us, mdns_last_announce_us, now_us = 1000000;
static int inits, frees, announces, services, init_result, announce_result;
static bool server, reconnect_during_start;
static void event_reconnect(void);
static int64_t esp_timer_get_time(void) { return now_us; }
static uint32_t monotonic_age_seconds(int64_t start) { return (now_us - start) / 1000000; }
static int mdns_init(void) { ++inits; if (init_result) return init_result; server = true; return ESP_OK; }
static void mdns_free(void) { ++frees; server = false; services = 0; }
static int mdns_hostname_set(const char *s) {
    (void)s; assert(server);
    if (reconnect_during_start) { reconnect_during_start = false; event_reconnect(); }
    return ESP_OK;
}
static int mdns_instance_name_set(const char *s) { (void)s; assert(server); return ESP_OK; }
static int mdns_service_add(void *i, const char *s, const char *p, int port, void *t, int n) {
    (void)i; (void)s; (void)p; (void)port; (void)t; (void)n;
    assert(server); if (services) return 1; ++services; return ESP_OK;
}
static int mdns_netif_action(void *netif, int action) {
    assert(netif == wifi_netif && action == MDNS_EVENT_ANNOUNCE_IP4);
    ++announces; return announce_result;
}
'''

SCENARIOS = r'''
int main(void) {
    /* Offline events must not allocate a responder. */
    wifi_has_ip = false; event_reconnect(); maintain_mdns(); assert(inits == 0);
    wifi_has_ip = true; maintain_mdns(); assert(mdns_started && server && services == 1);
    assert(!mdns_recovery_pending);

    /* A second GOT_IP arriving during a restart must survive that restart. */
    event_reconnect(); reconnect_during_start = true;
    maintain_mdns(); assert(mdns_started && server && mdns_recovery_pending);
    int previous = inits; maintain_mdns(); assert(inits == previous + 1);
    assert(!mdns_recovery_pending && services == 1);

    /* Failed init is retried on the existing worker, with its reason intact. */
    event_reconnect(); init_result = 1; maintain_mdns();
    assert(!mdns_started && mdns_recovery_pending);
    init_result = 0; maintain_mdns(); assert(mdns_started && !mdns_recovery_pending);
    assert(strcmp(mdns_last_recovery_reason, "wifi_reconnect") == 0);

    /* No work before due; announcement failure retains existing recovery. */
    previous = announces; maintain_mdns(); assert(announces == previous);
    now_us += 300000000; maintain_mdns(); assert(mdns_announce_count == 1);
    now_us += 300000000; announce_result = 1; maintain_mdns();
    assert(!mdns_started && mdns_recovery_pending);
    announce_result = 0; maintain_mdns(); assert(mdns_started);
    assert(strcmp(mdns_last_recovery_reason, "announce_failed") == 0);
    /* A healthy responder keeps its identity/queues across six hours and days.
     * Only the existing announcement is due; age must not cause teardown. */
    const int previous_inits = inits, previous_frees = frees;
    now_us += 21600000000LL; maintain_mdns(); assert(mdns_started);
    now_us += 30LL * 24 * 3600 * 1000000; maintain_mdns();
    assert(inits == previous_inits && frees == previous_frees);
    assert(strcmp(mdns_last_recovery_reason, "announce_failed") == 0);
    return 0;
}
'''


class MdnsLifecycleTests(unittest.TestCase):
    def test_event_handler_only_requests_work(self):
        event = function("network_event")
        for call in ("start_mdns(", "restart_mdns(", "mdns_free(", "mdns_init("):
            self.assertNotIn(call, event)

    def test_reconnect_during_restart_and_failures(self):
        helpers = ""
        if "static void request_mdns_recovery(" in SOURCE:
            helpers = function("request_mdns_recovery") + "\n" + function("take_mdns_recovery_reason")
            event = 'static void event_reconnect(void) { request_mdns_recovery("wifi_reconnect"); }'
        else:
            event = 'static void event_reconnect(void) { mdns_pending_reason = "wifi_reconnect"; mdns_recovery_pending = true; }'
        code = PRELUDE + helpers + event + "\n".join(function(n) for n in (
            "start_mdns", "restart_mdns", "maintain_mdns")) + SCENARIOS
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "mdns.c"
            binary = Path(tmp) / "mdns"
            source.write_text(code)
            subprocess.run(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
                            "-I", str(ROOT / "main"), str(source), "-o", str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    unittest.main()
