import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = fs.readFileSync(path.resolve(ROOT, '..', 'VERSION'), 'utf8').trim();
const requests = [];

let setupState = 'wifi_required';
let setupDeferred = false;
let skipFails = false;
let wifiFailure = null;
let wifiGeneration = 0;
let wifiOperation = {
  generation: 0,
  state: 'idle',
  phase: 'none',
  error_code: null,
};
let wifiCandidates = [];
let bmsGeneration = 0;
let bmsOperation = {
  generation: 0,
  state: 'idle',
  phase: 'none',
  error_code: null,
};
let bmsCandidates = [];

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
      mode: setupState === 'configured' ? 'first_setup' : 'first_setup',
      setup_state: setupState,
      setup_completed_without_bms: setupDeferred,
      wifi: {
        configured: setupState !== 'wifi_required',
        state: setupState === 'wifi_required' ? 'disconnected' : 'connected',
        ssid: setupState === 'wifi_required' ? '' : 'Lab WiFi',
        rssi_dbm: setupState === 'wifi_required' ? null : -51,
        ip: setupState === 'configured' ? '192.168.1.77' : '192.168.1.77',
        internet_state: 'unknown',
        operation: wifiOperation,
      },
      bms: {
        configured: setupState === 'configured',
        state: setupState === 'configured' ? 'connected' : 'disconnected',
        name: setupState === 'configured' ? 'JK-BMS' : '',
        model: setupState === 'configured' ? 'JK_PB2A16S20P' : '',
        address_hint: setupState === 'configured' ? '...A7:C2' : '',
        rssi_dbm: null,
        operation: bmsOperation,
      },
      firmware: {
        version: VERSION,
        build_id: 'e2e-test',
        ota_state: 'valid',
        rollback_configured: true,
        validation_pending: false,
      },
      system: {
        uptime_s: 33,
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
          data: { request_token: 'e2e-token' },
        });
        return;
      }
      if (req.method === 'POST' && reqPath === '/api/device/wifi/scan') {
        wifiGeneration += 1;
        wifiOperation = {
          generation: wifiGeneration,
          state: 'success',
          phase: 'none',
          error_code: null,
        };
        wifiCandidates = Array.from({ length: 8 }, (_, index) => ({
          candidate_id: index + 4,
          ssid: index === 0 ? 'Lab WiFi' : `Test Network ${index + 1}`,
          rssi_dbm: -51 - index,
          channel: 1 + index,
          auth: 'wpa2',
        }));
        json(res, 202, { ok: true, operation: {
          generation: wifiGeneration,
          state: 'running',
          phase: 'scanning',
          error_code: null,
        }});
        return;
      }
      if (req.method === 'GET' && reqPath === '/api/device/wifi/scan') {
        json(res, 200, {
          ok: true,
          data: {
            scan_generation: wifiGeneration,
            operation: wifiOperation,
            candidates: wifiCandidates,
          },
        });
        return;
      }
      if (req.method === 'POST' && reqPath === '/api/device/wifi/configure') {
        const parsed = JSON.parse(text);
        assert.deepEqual(parsed, {
          scan_generation: wifiGeneration,
          candidate_id: 4,
          password: 'test-pass-123',
        });
        wifiGeneration += 1;
        wifiOperation = {
          generation: wifiGeneration,
          state: wifiFailure ? 'error' : 'success',
          phase: 'none',
          error_code: wifiFailure,
        };
        setupState = 'bms_required';
        json(res, 202, { ok: true, operation: {
          generation: wifiGeneration,
          state: 'running',
          phase: 'connecting',
          error_code: wifiFailure,
        }});
        return;
      }
      if (req.method === 'POST' && reqPath === '/api/device/setup/finish') {
        assert.equal(text, '{}');
        if (setupState === 'wifi_required' || skipFails) {
          json(res, 409, { ok: false, error: { code: 'not_ready' } });
          return;
        }
        setupDeferred = true;
        json(res, 200, { ok: true, data: { setup_completed_without_bms: true } });
        return;
      }
      if (req.method === 'POST' && reqPath === '/api/device/bms/scan') {
        bmsGeneration += 1;
        bmsOperation = {
          generation: bmsGeneration,
          state: 'success',
          phase: 'none',
          error_code: null,
        };
        bmsCandidates = [{
          candidate_id: 2,
          name: 'JK-BMS',
          address_hint: '...A7:C2',
          rssi_dbm: -44,
        }];
        json(res, 202, { ok: true, operation: {
          generation: bmsGeneration,
          state: 'running',
          phase: 'scanning',
          error_code: null,
        }});
        return;
      }
      if (req.method === 'GET' && reqPath === '/api/device/bms/scan') {
        json(res, 200, {
          ok: true,
          data: {
            scan_generation: bmsGeneration,
            operation: bmsOperation,
            candidates: bmsCandidates,
          },
        });
        return;
      }
      if (req.method === 'POST' && reqPath === '/api/device/bms/select') {
        const parsed = JSON.parse(text);
        assert.deepEqual(parsed, {
          scan_generation: bmsGeneration,
          candidate_id: 2,
        });
        bmsGeneration += 1;
        bmsOperation = {
          generation: bmsGeneration,
          state: 'success',
          phase: 'none',
          error_code: null,
        };
        setupState = 'configured';
        json(res, 202, { ok: true, operation: {
          generation: bmsGeneration,
          state: 'running',
          phase: 'connecting',
          error_code: null,
        }});
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

async function waitFor(send, expression, timeoutMs = 5000) {
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

test('First Setup browser flow reaches Success through real UI actions', async () => {
  setupState = 'wifi_required';
  setupDeferred = false;
  skipFails = false;
  wifiGeneration = 0;
  bmsGeneration = 0;
  requests.length = 0;

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const appPort = server.address().port;
  const debugPort = 9364;
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
      `document.querySelector('[data-step="welcome"]').classList.contains('is-active')`,
    );
    await send('Runtime.evaluate', {
      expression: `document.getElementById('welcome-start').click()`,
    });
    const idleWifi = await send('Runtime.evaluate', {
      expression: `(() => ({
        label: document.getElementById('wifi-scan').textContent.trim(),
        candidates: document.querySelectorAll('#wifi-candidates .setup-candidate').length,
      }))()`,
      returnByValue: true,
    });
    assert.equal(idleWifi.result.value.label, 'Знайти Wi-Fi мережі');
    assert.equal(idleWifi.result.value.candidates, 0);
    await send('Runtime.evaluate', {
      expression: `document.getElementById('wifi-scan').click()`,
    });
    await waitFor(
      send,
      `document.querySelectorAll('#wifi-candidates .setup-candidate').length === 8`,
    );
    const pickerResult = await send('Runtime.evaluate', {
      expression: `(() => {
        const list = document.getElementById('wifi-candidates');
        const progressTwo = document.querySelector('[data-progress="wifi"]');
        const touch = (type, y) => {
          const event = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'touches', { value: [{ clientY: y }] });
          list.dispatchEvent(event);
          return event.defaultPrevented;
        };
        list.scrollTop = list.scrollHeight;
        const bottomScrollTop = list.scrollTop;
        list.scrollTop = 0;
        touch('touchstart', 100);
        const pullRefreshBlocked = touch('touchmove', 140);
        touch('touchend', 140);
        touch('touchstart', 100);
        const normalDownwardScrollBlocked = touch('touchmove', 60);
        touch('touchend', 60);
        return {
          listScrollable: list.scrollHeight > list.clientHeight,
          bottomScrollTop,
          returnedToTop: list.scrollTop === 0,
          pullRefreshBlocked,
          normalDownwardScrollBlocked,
          progressTwoCurrent: progressTwo.classList.contains('is-current'),
        };
      })()`,
      returnByValue: true,
    });
    assert.equal(pickerResult.result.value.listScrollable, true);
    assert.ok(pickerResult.result.value.bottomScrollTop > 0);
    assert.equal(pickerResult.result.value.returnedToTop, true);
    assert.equal(pickerResult.result.value.pullRefreshBlocked, true);
    assert.equal(pickerResult.result.value.normalDownwardScrollBlocked, false);
    assert.equal(pickerResult.result.value.progressTwoCurrent, true);
    // Real mobile viewport: after selecting a network, the action is visible
    // in the *page* viewport, not at the end of a second scrollable list.
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 560, deviceScaleFactor: 1, mobile: true,
    });
    await send('Runtime.evaluate', {
      expression: `document.querySelector('#wifi-candidates .setup-candidate').click()`,
    });
    await waitFor(send, `(() => {
      const action = document.getElementById('wifi-connect');
      const bounds = action.getBoundingClientRect();
      return bounds.height >= 44 && bounds.top >= 0 && bounds.bottom <= window.innerHeight + 2;
    })()`);
    const phoneLayout = await send('Runtime.evaluate', {
      expression: `(() => {
        const action = document.getElementById('wifi-connect');
        const credentials = document.getElementById('wifi-credentials-panel');
        const list = document.getElementById('wifi-candidates');
        return {
          width: window.innerWidth,
          listScrollable: list.scrollHeight > list.clientHeight,
          formOutsideList: !list.contains(credentials) && credentials.parentElement.id === 'wifi-credentials-home',
          actionOutsideList: !list.contains(action),
          actionVisible: action.getBoundingClientRect().bottom <= window.innerHeight + 2,
          pageScrollable: document.documentElement.scrollHeight > window.innerHeight,
        };
      })()`, returnByValue: true,
    });
    assert.deepEqual(phoneLayout.result.value, {
      width: 390, listScrollable: true, formOutsideList: true,
      actionOutsideList: true, actionVisible: true, pageScrollable: true,
    });
    // Simulate the smaller visible area when a mobile software keyboard opens.
    // The form must stay in the page flow and permit reaching the button with
    // *page* scrolling, without having to scroll the Wi-Fi list.
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 430, deviceScaleFactor: 1, mobile: true,
    });
    const keyboardLayout = await send('Runtime.evaluate', {
      expression: `(() => {
        const action = document.getElementById('wifi-connect');
        const list = document.getElementById('wifi-candidates');
        const listOffset = list.scrollTop;
        action.scrollIntoView({ block: 'end' });
        const bounds = action.getBoundingClientRect();
        return {
          buttonInPageViewport: bounds.height >= 44 && bounds.top >= 0 && bounds.bottom <= window.innerHeight + 2,
          listUnchanged: list.scrollTop === listOffset,
        };
      })()`, returnByValue: true,
    });
    assert.deepEqual(keyboardLayout.result.value, { buttonInPageViewport: true, listUnchanged: true });
    await send('Runtime.evaluate', {
      expression: `(() => {
        const credentials = document.getElementById('wifi-credentials-panel');
        if (credentials.parentElement.id !== 'wifi-credentials-home') {
          throw new Error('credentials must be outside scrollable network list');
        }
        document.getElementById('wifi-password').value = 'test-pass-123';
        document.getElementById('wifi-password-toggle').click();
        if (document.getElementById('wifi-password').type !== 'text') throw new Error('password not revealed');
        document.getElementById('wifi-password-toggle').click();
        document.getElementById('wifi-connect').click();
      })()`,
    });

    await waitFor(
      send,
      `document.querySelector('[data-step="bms"]').classList.contains('is-active')`,
      7000,
    );
    const idleBms = await send('Runtime.evaluate', {
      expression: `(() => ({
        label: document.getElementById('bms-scan').textContent.trim(),
        candidates: document.querySelectorAll('#bms-candidates .setup-candidate').length,
      }))()`,
      returnByValue: true,
    });
    assert.equal(idleBms.result.value.label, 'Знайти JK BMS');
    assert.equal(idleBms.result.value.candidates, 0);
    // A saved Wi-Fi choice in unfinished setup can be changed from the BMS step.
    for (const failure of ['wifi_connect_failed', 'storage_error', null]) {
      wifiFailure = failure;
      await send('Runtime.evaluate', { expression: `document.getElementById('${failure === 'wifi_connect_failed' ? 'bms-change-wifi' : 'wifi-validation-retry'}').click()` });
      await waitFor(send, `document.querySelector('[data-step="wifi"]').classList.contains('is-active')`);
      await send('Runtime.evaluate', { expression: `document.getElementById('wifi-scan').click()` });
      await waitFor(send, `!document.getElementById('wifi-scan').disabled && document.querySelectorAll('#wifi-candidates .setup-candidate').length === 8`);
      await send('Runtime.evaluate', { expression: `(() => { document.querySelector('#wifi-candidates .setup-candidate').click(); document.getElementById('wifi-password').value = 'test-pass-123'; document.getElementById('wifi-connect').click(); })()` });
      if (failure) {
        await waitFor(send, `!document.getElementById('wifi-validation-error').classList.contains('is-hidden') && !document.getElementById('wifi-scan').disabled`);
        assert.equal(setupState, 'bms_required', 'saved setup remains available after failure');
      } else {
        await waitFor(send, `document.querySelector('[data-step="bms"]').classList.contains('is-active')`);
      }
    }
    await send('Runtime.evaluate', {
      expression: `document.getElementById('bms-scan').click()`,
    });
    await waitFor(
      send,
      `document.querySelectorAll('#bms-candidates .setup-candidate').length === 1`,
      7000,
    );
    const bmsPicker = await send('Runtime.evaluate', {
      expression: `(() => ({
        cards: document.querySelectorAll('#bms-candidates .setup-candidate-card').length,
        radio: document.querySelector('#bms-candidates .setup-candidate')?.getAttribute('role'),
        clickable: getComputedStyle(document.querySelector('#bms-candidates .setup-candidate')).cursor,
      }))()`,
      returnByValue: true,
    });
    assert.equal(bmsPicker.result.value.cards, 1);
    assert.equal(bmsPicker.result.value.radio, 'radio');
    assert.equal(bmsPicker.result.value.clickable, 'pointer');
    await send('Runtime.evaluate', {
      expression: `document.querySelector('#bms-candidates .setup-candidate').click()`,
    });
    await waitFor(
      send,
      `document.querySelector('[data-step="success"]').classList.contains('is-active')`,
      7000,
    );

    const result = await send('Runtime.evaluate', {
      expression: `(() => ({
        wifi: document.getElementById('success-wifi').textContent,
        bms: document.getElementById('success-bms').textContent,
        localHref: document.getElementById('success-local').href,
        fallbackHref: document.getElementById('success-ip').href,
        passwordValue: document.getElementById('wifi-password').value,
      }))()`,
      returnByValue: true,
    });
    const snapshot = result.result.value;
    assert.equal(snapshot.wifi, 'Lab WiFi');
    assert.match(snapshot.bms, /JK-BMS/);
    assert.equal(snapshot.localHref, 'http://bms.local/');
    assert.equal(snapshot.fallbackHref, 'http://192.168.1.77/');
    assert.equal(snapshot.passwordValue, '');

    const posts = requests.filter(request => request.method === 'POST');
    assert.equal(posts.length, 10);
    assert.ok(posts.every(request => request.token === 'e2e-token'));
    assert.ok(posts.every(request => !request.path.includes('test-pass-123')));
    assert.equal(
      posts.filter(request => request.path === '/api/device/wifi/configure').length,
      4,
    );
    assert.equal(
      posts.filter(request => request.path === '/api/device/bms/select').length,
      1,
    );
    await send('Runtime.evaluate', { expression: `document.getElementById('success-change-wifi').click()` });
    await waitFor(send, `document.querySelector('[data-step="wifi"]').classList.contains('is-active')`);
    ws.close();
  } finally {
    chrome.kill();
    await new Promise(resolve => server.close(resolve));
  }
});

test('First Setup can finish without BMS and survive a browser reload', async () => {
  setupState = 'bms_required';
  setupDeferred = false;
  skipFails = true;
  requests.length = 0;

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const appPort = server.address().port;
  const debugPort = 9365;
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
    const tabs = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
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

    await waitFor(send, `document.querySelector('[data-step="bms"]').classList.contains('is-active')`);
    await send('Runtime.evaluate', {
      expression: `document.getElementById('bms-skip').click()`,
    });
    await waitFor(send, `!document.getElementById('bms-scan-error').classList.contains('is-hidden')`);
    assert.equal(setupDeferred, false, 'failed finish cannot change setup state');
    await waitFor(send, `!document.getElementById('bms-skip').disabled`);

    skipFails = false;
    await send('Runtime.evaluate', {
      expression: `document.getElementById('bms-skip').click()`,
    });
    await waitFor(send, `document.querySelector('[data-step="success"]').classList.contains('is-active')`);
    const result = await send('Runtime.evaluate', {
      expression: `(() => ({
        bms: document.getElementById('success-bms').textContent,
        info: document.getElementById('success-description').textContent,
      }))()`,
      returnByValue: true,
    });
    assert.match(result.result.value.bms, /Не підключено/);
    assert.match(result.result.value.info, /Налаштуваннях пристрою/);
    assert.equal(setupDeferred, true);
    const finishPosts = requests.filter(req => req.path === '/api/device/setup/finish');
    assert.equal(finishPosts.length, 2);
    assert.ok(finishPosts.every(req => req.token === 'e2e-token'));

    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });
    await waitFor(send, `document.querySelector('[data-step="success"]').classList.contains('is-active')`);
    ws.close();
  } finally {
    chrome.kill();
    await new Promise(resolve => server.close(resolve));
  }
});
