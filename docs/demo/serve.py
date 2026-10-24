"""Loopback-only documentation host: unmodified UI + synthetic read-only API."""
import argparse
import json
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from telemetry import END, generate, settings, validate

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / 'esp32_monitor/web'
VERSION = (ROOT / 'esp32_monitor/VERSION').read_text().strip()
ROWS, LIVE = generate()
LIVE.update(firmware_version=VERSION, web_version=VERSION)
validate(ROWS, LIVE)
CONTEXT = 'docs-synthetic-2026-10-24-v1'


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlsplit(self.path)
        if url.path.startswith('/api/'):
            if url.path == '/api/live':
                payload = LIVE
            elif url.path == '/api/settings':
                payload = settings()
            elif url.path == '/api/device/status':
                payload = dict(ok=True, data=dict(history_context=CONTEXT))
            elif url.path == '/api/history':
                query = parse_qs(url.query)
                limit = max(1, min(144, int(query.get('limit', ['144'])[0])))
                before = int(query.get('before', [str(END+1)])[0])
                after = int(query.get('after', ['0'])[0])
                matches = [r for r in ROWS if after < r['t'] < before]
                payload = matches[:limit] if 'after' in query else matches[-limit:]
            else:
                self.send_error(404, 'No demo fixture for this API')
                return
            self.respond(json.dumps(payload).encode(), 'application/json', context=True)
            return
        path = '/index.html' if url.path == '/' else url.path
        if path == '/js/transport.js':
            path = '/js/transports/local-transport.js'
        target = (WEB / path.lstrip('/')).resolve()
        if not target.is_relative_to(WEB) or not target.is_file():
            self.send_error(404)
            return
        body = target.read_bytes()
        if target.suffix == '.html':
            body = body.replace(b'__WATTPOST_WEB_VERSION__', VERSION.encode())
        self.respond(body, mimetypes.guess_type(target)[0] or 'application/octet-stream')

    def respond(self, body, mime, context=False):
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        if context:
            self.send_header('X-WattPost-History-Context', CONTEXT)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    print(f'DEMO ONLY: http://127.0.0.1:{args.port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
