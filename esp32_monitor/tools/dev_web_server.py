#!/usr/bin/env python3
"""Development host for the ESP32 interface, backed by the real test BMS."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
import os


WEB_ROOT = Path(__file__).resolve().parents[1] / "web"
WEB_VERSION = (Path(__file__).resolve().parents[1] / "VERSION").read_text().strip()
WEB_VERSION_TOKEN = b"__WATTPOST_WEB_VERSION__"
UPSTREAM = os.environ.get("WATTPOST_MINI_UPSTREAM", "http://BMS.local").rstrip("/")


def upstream_origin() -> str:
    parts = urlsplit(UPSTREAM)
    return f"{parts.scheme}://{parts.netloc}"


def proxy_timeout(path: str) -> int:
    return 15 if path.split("?", 1)[0] == "/api/history" else 5


class Handler(BaseHTTPRequestHandler):
    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/"):
            self.proxy(self.path, method="GET")
            return

        self.serve_dir(path, "/", WEB_ROOT)

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if not path.startswith("/api/"):
            self.send_error(405)
            return

        content_length = self.headers.get("Content-Length", "")
        try:
            body_length = int(content_length)
        except ValueError:
            self.send_error(400)
            return
        if body_length < 0 or body_length > 16 * 1024:
            self.send_error(413)
            return

        body = self.rfile.read(body_length) if body_length else b""
        self.proxy(self.path, method="POST", body=body)

    def serve_dir(self, path: str, prefix: str, root: Path) -> None:
        if path == "/js/transport.js":
            path = "/js/transports/local-transport.js"
        if path == prefix:
            target = root / "index.html"
        else:
            rel = path[len(prefix):].lstrip("/")
            target = (root / rel).resolve()
            if not str(target).startswith(str(root.resolve())):
                self.send_error(403)
                return

        if not target.is_file():
            self.send_error(404)
            return

        content_types = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
            ".woff2": "font/woff2",
            ".woff": "font/woff",
            ".ttf": "font/ttf",
            ".txt": "text/plain; charset=utf-8",
        }
        content_type = content_types.get(target.suffix.lower(), "application/octet-stream")

        body = target.read_bytes()
        if target.suffix.lower() == ".html":
            body = body.replace(WEB_VERSION_TOKEN, WEB_VERSION.encode("ascii"))
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def proxy(
        self,
        path: str,
        *,
        method: str,
        body: bytes | None = None,
    ) -> None:
        headers = {"Cache-Control": "no-store"}
        if method == "POST":
            headers["Content-Type"] = self.headers.get(
                "Content-Type", "application/json"
            )
            headers["Origin"] = upstream_origin()
            request_token = self.headers.get("X-WattPost-Request-Token")
            if request_token:
                headers["X-WattPost-Request-Token"] = request_token

        request = Request(
            UPSTREAM + path,
            data=body if method == "POST" else None,
            headers=headers,
            method=method,
        )
        content_type = "application/json"
        try:
            with urlopen(request, timeout=proxy_timeout(path)) as response:
                response_body = response.read()
                status = response.status
                content_type = response.headers.get_content_type()
                if content_type == "application/json":
                    content_type = "application/json"
        except HTTPError as error:
            response_body = error.read()
            status = error.code
            content_type = error.headers.get_content_type()
        except (URLError, TimeoutError):
            response_body = b'{"online":false,"message":"ESP32 unavailable"}'
            status = 502

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(response_body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(response_body)
        except BrokenPipeError:
            pass

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} {format % args}")


if __name__ == "__main__":
    host = os.environ.get("WATTPOST_MINI_HOST", "0.0.0.0")
    port = int(os.environ.get("WATTPOST_MINI_PORT", "8081"))
    print(f"WattPost Mini dev web: http://{host}:{port} -> {UPSTREAM}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
