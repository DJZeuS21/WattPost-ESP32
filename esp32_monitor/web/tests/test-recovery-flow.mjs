import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = 'V18.4.1';
const requests = [];

let wifiConnected = false;
let wifiGeneration = 0;
let wifiOperation = {
  generation: 0,
  state: 'idle',
  phase: 'none',
  error_code: null,
};

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function statusPayload() {
  return {
    ok: true,
    data: {
      api_version: 1,
      mode: 'recovery',
      setup_state: 'configured',
      wifi: {
        configured: true,
        state: wifiConnected ? 'connected' : 'connecting',
        ssid: 'Saved Home WiFi',
        rssi_dbm: wifiConnected ? -58 : null,
        ip: wifiConnected ? '192.168.1.88' : '',
        internet_state: wifiConnected ? 'reachable' : 'unknown',
        operation: wifiOperation,
      },
      bms: {
        configured: true,
        state: 'connected',
        name: 'JK-BMS',
        model: 'JK_PB2A16S20P',
        address_hint: '...A7:C2',
        rssi_dbm: null,
        operation: {
          generation: 0,
          state: 'idle',
          phase: 'none',
          error_code: null,
        },
      },
      firmware: {
        version: VERSION,
        build_id: 'recovery-e2e',
        ota_state: 'valid',
        rollback_configured: true,
        validation_pending: false,
      },
      system: {
        uptime_s: 321,
        last_restart_reason: 'power_on',
      },
    },
  };
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const reqPath = url.pathname;

  if (reqPath.startsWith('/api/')) {
    let body = Buffer.alloc(0);
    req.on('data', chunk => {
      body = Buffer.concat([body, chunk]);
    });
    req.on('end', () => {
      const text = body.toString('utf8');
      requests.push({
        method: req.method,
        path: reqPath,
        body: text,
        token: req.headers['x-wattpost-request-token'] || null,
      });

      if (req.method === 'GET' && reqPath === '/api/device/status') {
        json(res, 200, statusPayload());
        return;
      }
      if (req.method === 'GET' && reqPath === '/api/device/request-token') {
        json(res, 200, {
          ok: true,
          data: { request_token: 'recovery-e2e-token' },
        });
        return;
      }
      if (req.method === 'POST' && reqPath === '/api/device/wifi/reconnect') {
        assert.deepEqual(JSON.parse(text), {});
        wifiGeneration += 1;
        wifiOperation = {
          generation: wifiGeneration,
          state: 'success',
          phase: 'none',
          error_code: null,
        };
        wifiConnected = true;
        json(res, 202, {
          ok: true,
          operation: {
            generation: wifiGeneration,
            state: 'running',
            phase: 'reconnecting',
            error_code: null,
          },
        });
        return;
      }
      if (req.method === 'GET' && reqPath === '/api/device/wifi/scan') {
        json(res, 200, {
          ok: true,
          data: {
            scan_generation: 0,
            operation: wifiOperation,
            candidates: [],
          },
        });
        return;
      }

      json(res, 404, { ok: false, error: { code: 'not_found' } });
    });
    return;
  }

  const relative = reqPath === '/' ? 'setup.html' : reqPath.replace(/^\//, '');
  const filePath = path.resolve(ROOT, relative);
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  let body = fs.readFileSync(filePath);
  if (filePath.endsWith('.html')) {
    body = Buffer.from(
      body.toString('utf8').replaceAll('__WATTPOST_WEB_VERSION__', VERSION),
    );
  }
  res.writeHead(200, {
    'Content-Type': contentType(filePath),
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
});

async function waitFor(send, expression, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    if (result.result.value) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

test('Recovery browser shell reconnects saved Wi-Fi without losing recovery context', async () => {
  wifiConnected = false;
  wifiGeneration = 0;
  wifiOperation = {
    generation: 0,
    state: 'idle',
    phase: 'none',
    error_code: null,
  };
  requests.length = 0;

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const appPort = server.address().port;
  const debugPort = 9374;
  const chrome = spawn('google-chrome', [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    `http://127.0.0.1:${appPort}/`,
  ]);

  try {
    await new Promise(resolve => setTimeout(resolve, 900));
    const tabs = await (await fetch(
      `http://127.0.0.1:${debugPort}/json/list`,
    )).json();
    const page = tabs.find(tab => tab.type === 'page');
    assert.ok(page);

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(resolve => { ws.onopen = resolve; });
    let nextId = 1;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      const handler = event => {
        const payload = JSON.parse(event.data);
        if (payload.id !== id) return;
        ws.removeEventListener('message', handler);
        if (payload.error) reject(payload.error);
        else resolve(payload.result);
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });

    await waitFor(
      send,
      `document.querySelector('[data-step="recovery"]').classList.contains('is-active')`,
    );

    const initial = await send('Runtime.evaluate', {
      expression: `(() => ({
        context: document.getElementById('setup-context').textContent,
        progressHidden: document.getElementById('setup-progress').classList.contains('is-hidden'),
        wifi: document.getElementById('recovery-wifi').textContent,
        bms: document.getElementById('recovery-bms-state').textContent,
        factoryDisabled: document.getElementById('recovery-factory-reset').disabled,
      }))()`,
      returnByValue: true,
    });
    assert.equal(initial.result.value.context, 'Відновлення Wi-Fi');
    assert.equal(initial.result.value.progressHidden, true);
    assert.equal(initial.result.value.wifi, 'Saved Home WiFi');
    assert.match(initial.result.value.bms, /JK-BMS/);
    assert.equal(initial.result.value.factoryDisabled, true);

    await send('Runtime.evaluate', {
      expression: `document.getElementById('recovery-reconnect').click()`,
    });
    await waitFor(
      send,
      `document.getElementById('recovery-wifi-state').textContent === 'Підключено'`,
      7000,
    );

    const restored = await send('Runtime.evaluate', {
      expression: `(() => ({
        mode: document.getElementById('setup-context').textContent,
        wifiState: document.getElementById('recovery-wifi-state').textContent,
        internet: document.getElementById('recovery-internet-state').textContent,
        note: document.getElementById('recovery-note').textContent,
      }))()`,
      returnByValue: true,
    });
    assert.equal(restored.result.value.mode, 'Відновлення Wi-Fi');
    assert.equal(restored.result.value.wifiState, 'Підключено');
    assert.equal(restored.result.value.internet, 'Доступний');
    assert.match(restored.result.value.note, /WattPost закриє мережу налаштування/);

    const reconnect = requests.find(
      request => request.method === 'POST' &&
        request.path === '/api/device/wifi/reconnect',
    );
    assert.ok(reconnect);
    assert.equal(reconnect.token, 'recovery-e2e-token');
    assert.equal(reconnect.body, '{}');

    ws.close();
  } finally {
    chrome.kill();
    await new Promise(resolve => server.close(resolve));
  }
});
