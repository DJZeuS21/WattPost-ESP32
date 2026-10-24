import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = 'V18.4.1';
const requested = [];

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  const reqPath = req.url.split('?')[0];
  requested.push(reqPath);

  if (reqPath === '/api/device/status') {
    const body = Buffer.from(JSON.stringify({
      ok: true,
      data: {
        api_version: 1,
        mode: 'first_setup',
        setup_state: 'wifi_required',
        wifi: {
          configured: false,
          state: 'disconnected',
          ssid: '',
          rssi_dbm: null,
          ip: '',
          internet_state: 'unknown',
          operation: {
            generation: 0,
            state: 'idle',
            phase: 'none',
            error_code: null,
          },
        },
        bms: {
          configured: false,
          state: 'disconnected',
          name: '',
          model: '',
          address_hint: '',
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
          build_id: 'test',
          ota_state: 'valid',
          rollback_configured: true,
          validation_pending: false,
        },
        system: {
          uptime_s: 10,
          last_restart_reason: 'power_on',
        },
      },
    }));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  let relative = reqPath === '/' ? 'setup.html' : reqPath.replace(/^\//, '');
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

test('First Setup shell fits a 390px mobile viewport without loading dashboard stack', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const appPort = server.address().port;
  const debugPort = 9363;

  const chrome = spawn('google-chrome', [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=390,844',
    `http://127.0.0.1:${appPort}/`,
  ]);

  try {
    await new Promise(resolve => setTimeout(resolve, 1100));
    const listResponse = await fetch(
      `http://127.0.0.1:${debugPort}/json/list`,
    );
    const tabs = await listResponse.json();
    const page = tabs.find(tab => tab.type === 'page');
    assert.ok(page, 'Chrome page target not found');

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

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await send('Page.reload', { ignoreCache: true });
    await new Promise(resolve => setTimeout(resolve, 450));

    const result = await send('Runtime.evaluate', {
      expression: `(() => {
        const welcome = document.querySelector('[data-step="welcome"]');
        const start = document.getElementById('welcome-start');
        const rect = start.getBoundingClientRect();
        return {
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          welcomeActive: welcome.classList.contains('is-active'),
          startVisible: rect.width > 0 && rect.height >= 44,
          scripts: [...document.scripts].map(node => node.getAttribute('src') || ''),
          styles: [...document.querySelectorAll('link[rel="stylesheet"]')]
            .map(node => node.getAttribute('href') || ''),
        };
      })()`,
      returnByValue: true,
    });

    const snapshot = result.result.value;
    assert.equal(snapshot.innerWidth, 390);
    assert.ok(snapshot.scrollWidth <= snapshot.innerWidth);
    assert.ok(snapshot.bodyScrollWidth <= snapshot.innerWidth);
    assert.equal(snapshot.welcomeActive, true);
    assert.equal(snapshot.startVisible, true);
    assert.ok(snapshot.scripts.some(src => src.includes('setup-api.js')));
    assert.ok(snapshot.scripts.some(src => src.includes('setup.js')));
    assert.deepEqual(
      snapshot.scripts.filter(src =>
        /chart|dashboard|history|\/js\/api\.js/i.test(src)
      ),
      [],
    );
    assert.deepEqual(
      snapshot.styles.filter(src => /styles\.css/i.test(src)),
      [],
    );

    const heavyRequests = requested.filter(reqPath =>
      /chart|dashboard|history|\/js\/api\.js|\/css\/styles\.css/i.test(reqPath)
    );
    assert.deepEqual(heavyRequests, []);
    ws.close();
  } finally {
    chrome.kill();
    await new Promise(resolve => server.close(resolve));
  }
});
