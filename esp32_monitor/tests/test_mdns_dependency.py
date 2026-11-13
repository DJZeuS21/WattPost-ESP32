"""Exercise TX cleanup in the resolved Espressif source, not a copied fix."""
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPONENT = ROOT / "managed_components/espressif__mdns"


def function(source, name):
    match = re.search(r"void " + name + r"\([^;]*?\)\s*\{", source)
    if not match:
        raise AssertionError(name)
    end = source.index("{", match.start())
    depth = 1
    while depth:
        end += 1
        depth += (source[end] == "{") - (source[end] == "}")
    return source[match.start():end + 1]


class MdnsDependencyTests(unittest.TestCase):
    def test_dependency_is_pinned_and_locked(self):
        self.assertIn('espressif/mdns: "1.15.1"', (ROOT / "main/idf_component.yml").read_text())
        lock = (ROOT / "dependencies.lock").read_text()
        self.assertIn("version: 1.15.1", lock)
        self.assertIn("2fa43caa78cc170842255bc7bf71f306bc815cae12e9496bfb12372423019ac7", lock)

    def test_pending_tx_cleanup_has_one_owner(self):
        path = COMPONENT / "mdns_send.c"
        if not path.exists():
            self.skipTest("Fetch managed dependencies with ESP-IDF before this test")
        source = path.read_text()
        code = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdlib.h>
typedef struct packet { struct packet *next; bool queued; } mdns_tx_packet_t;
typedef struct { int type; struct { struct { mdns_tx_packet_t *packet; } tx_handle; } data; } mdns_action_t;
typedef int mdns_action_subtype_t;
enum { ACTION_TX_HANDLE, ACTION_RUN, ACTION_CLEANUP };
static mdns_tx_packet_t *s_tx_queue_head;
static unsigned frees, runs;
static void mdns_priv_free_tx_packet(mdns_tx_packet_t *p) { ++frees; free(p); }
static void send_packet(mdns_tx_packet_t *p) { (void)p; ++runs; }
''' + function(source, "mdns_priv_send_action") + function(source, "mdns_priv_clear_tx_queue") + r'''
static mdns_tx_packet_t *packet(void) {
    mdns_tx_packet_t *p = calloc(1, sizeof(*p)); assert(p);
    p->queued = true; p->next = s_tx_queue_head; s_tx_queue_head = p; return p;
}
int main(void) {
    mdns_action_t a = { .type = ACTION_TX_HANDLE };
    a.data.tx_handle.packet = packet();
    mdns_priv_send_action(&a, ACTION_CLEANUP);
    assert(frees == 0); mdns_priv_clear_tx_queue(); assert(frees == 1);

    /* An interface may have already cleared the list before action cleanup. */
    a.data.tx_handle.packet = packet();
    mdns_priv_clear_tx_queue(); assert(frees == 2);
    mdns_priv_send_action(&a, ACTION_CLEANUP); assert(frees == 2);

    a.data.tx_handle.packet = packet(); packet();
    mdns_priv_send_action(&a, ACTION_CLEANUP);
    assert(frees == 2); mdns_priv_clear_tx_queue(); assert(frees == 4);
    a.data.tx_handle.packet = NULL;
    mdns_priv_send_action(&a, ACTION_RUN); assert(runs == 1);
    mdns_priv_clear_tx_queue(); assert(frees == 4);
    return 0;
}
'''
        with tempfile.TemporaryDirectory() as tmp:
            c = Path(tmp) / "cleanup.c"
            binary = Path(tmp) / "cleanup"
            c.write_text(code)
            subprocess.run(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
                            "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
                            str(c), "-o", str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    unittest.main()
