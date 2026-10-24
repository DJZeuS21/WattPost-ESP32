#!/usr/bin/env python3

import importlib.util
import re
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen


SERVER_PATH = Path(__file__).parents[1] / "tools" / "dev_web_server.py"
SPEC = importlib.util.spec_from_file_location("wattpost_dev_web_server", SERVER_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class UpstreamHandler(BaseHTTPRequestHandler):
    received_path = None
    received_method = None
    received_body = None
    received_origin = None
    received_content_type = None
    received_token = None

    def do_GET(self):
        type(self).received_path = self.path
        type(self).received_method = "GET"
        body = b"[]"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        type(self).received_path = self.path
        type(self).received_method = "POST"
        type(self).received_origin = self.headers.get("Origin")
        type(self).received_content_type = self.headers.get("Content-Type")
        type(self).received_token = self.headers.get(
            "X-WattPost-Request-Token"
        )
        length = int(self.headers.get("Content-Length", "0"))
        type(self).received_body = self.rfile.read(length)
        body = b'{"ok":true}'
        self.send_response(202)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class ProxyQueryTest(unittest.TestCase):
    def test_history_has_a_longer_upstream_timeout(self):
        self.assertEqual(SERVER.proxy_timeout("/api/history?limit=144"), 15)
        self.assertEqual(SERVER.proxy_timeout("/api/live"), 5)

    def test_index_stamps_one_web_version_for_all_assets(self):
        proxy = ThreadingHTTPServer(("127.0.0.1", 0), SERVER.Handler)
        thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        thread.start()
        try:
            with urlopen(f"http://127.0.0.1:{proxy.server_port}/") as response:
                html = response.read().decode("utf-8")
            self.assertNotIn("__WATTPOST_WEB_VERSION__", html)
            self.assertIn(f'<meta name="app-version" content="{SERVER.WEB_VERSION}"', html)
            self.assertEqual(set(re.findall(r'(?:src|href)="[^"]*[?&]v=([^"&]+)', html)), {SERVER.WEB_VERSION})
        finally:
            proxy.shutdown()
            proxy.server_close()

    def test_runtime_transport_alias_serves_the_local_transport_source(self):
        proxy = ThreadingHTTPServer(("127.0.0.1", 0), SERVER.Handler)
        thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        thread.start()
        try:
            with urlopen(
                f"http://127.0.0.1:{proxy.server_port}/js/transport.js"
            ) as response:
                runtime_source = response.read()
            source = (SERVER.WEB_ROOT / "js/transports/local-transport.js").read_bytes()
            self.assertEqual(runtime_source, source)
        finally:
            proxy.shutdown()
            proxy.server_close()

    def test_setup_html_stamps_same_web_version(self):
        proxy = ThreadingHTTPServer(("127.0.0.1", 0), SERVER.Handler)
        thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        thread.start()
        try:
            with urlopen(
                f"http://127.0.0.1:{proxy.server_port}/setup.html"
            ) as response:
                html = response.read().decode("utf-8")
            self.assertNotIn("__WATTPOST_WEB_VERSION__", html)
            self.assertIn(
                f'<meta name="app-version" content="{SERVER.WEB_VERSION}"',
                html,
            )
            self.assertEqual(
                set(
                    re.findall(
                        r'(?:src|href)="[^"]*[?&]v=([^"&]+)',
                        html,
                    )
                ),
                {SERVER.WEB_VERSION},
            )
        finally:
            proxy.shutdown()
            proxy.server_close()

    def test_history_query_reaches_upstream_unchanged(self):
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        proxy = ThreadingHTTPServer(("127.0.0.1", 0), SERVER.Handler)
        original_upstream = SERVER.UPSTREAM
        SERVER.UPSTREAM = f"http://127.0.0.1:{upstream.server_port}"
        threads = [threading.Thread(target=server.serve_forever, daemon=True)
                   for server in (upstream, proxy)]
        for thread in threads:
            thread.start()
        try:
            path = "/api/history?limit=144&before=1800000000"
            with urlopen(f"http://127.0.0.1:{proxy.server_port}{path}") as response:
                self.assertEqual(response.read(), b"[]")
            self.assertEqual(UpstreamHandler.received_path, path)
        finally:
            SERVER.UPSTREAM = original_upstream
            proxy.shutdown()
            upstream.shutdown()
            proxy.server_close()
            upstream.server_close()

    def test_post_rewrites_origin_and_forwards_json_and_request_token(self):
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        proxy = ThreadingHTTPServer(("127.0.0.1", 0), SERVER.Handler)
        original_upstream = SERVER.UPSTREAM
        SERVER.UPSTREAM = f"http://127.0.0.1:{upstream.server_port}"
        threads = [
            threading.Thread(target=server.serve_forever, daemon=True)
            for server in (upstream, proxy)
        ]
        for thread in threads:
            thread.start()
        try:
            body = b'{"scan_generation":7,"candidate_id":2}'
            request = Request(
                f"http://127.0.0.1:{proxy.server_port}/api/device/bms/select",
                data=body,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Origin": f"http://127.0.0.1:{proxy.server_port}",
                    "X-WattPost-Request-Token": "test-token",
                },
            )
            with urlopen(request) as response:
                self.assertEqual(response.status, 202)
                self.assertEqual(response.read(), b'{"ok":true}')

            self.assertEqual(UpstreamHandler.received_method, "POST")
            self.assertEqual(
                UpstreamHandler.received_path,
                "/api/device/bms/select",
            )
            self.assertEqual(UpstreamHandler.received_body, body)
            self.assertEqual(
                UpstreamHandler.received_origin,
                f"http://127.0.0.1:{upstream.server_port}",
            )
            self.assertEqual(
                UpstreamHandler.received_content_type,
                "application/json",
            )
            self.assertEqual(
                UpstreamHandler.received_token,
                "test-token",
            )
        finally:
            SERVER.UPSTREAM = original_upstream
            proxy.shutdown()
            upstream.shutdown()
            proxy.server_close()
            upstream.server_close()


if __name__ == "__main__":
    unittest.main()
