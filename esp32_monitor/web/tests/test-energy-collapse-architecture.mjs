import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  if (reqPath === '/js/transport.js') reqPath = '/js/transports/local-transport.js';
  const filePath = path.join(ROOT_DIR, reqPath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  fs.createReadStream(filePath).pipe(res);
});

server.listen(3980, '127.0.0.1', async () => {
  const chrome = spawn('google-chrome', [
    '--headless=new',
    '--remote-debugging-port=9345',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1600,900',
    'http://127.0.0.1:3980/index.html'
  ]);
  await new Promise(r => setTimeout(r, 1200));

  try {
    const listRes = await fetch('http://127.0.0.1:9345/json/list');
    const tabs = await listRes.json();
    const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    let id = 1;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const msgId = id++;
      const handler = (evt) => {
        const data = JSON.parse(evt.data);
        if (data.id === msgId) {
          ws.removeEventListener('message', handler);
          if (data.error) reject(data.error); else resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
    await send('Runtime.enable');

    const evaluate = async (expr) => {
      const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
      return res.result ? res.result.value : null;
    };

    await evaluate(`window.ApiClient.stop()`);

    const domCheck = await evaluate(`
      new Promise(resolve => {
        const d = window.app.dashboard;
        d._setWattActive('charge', '1200', '#56d364', false);
        const nativeBefore = document.getElementById('input-power');
        const numBefore = nativeBefore.querySelector('.watt-number');
        const wBefore = nativeBefore.querySelector('.watt-unit');
        const canonicalDxBefore = wBefore.getAttribute('dx');

        d._startEnergyCollapse('charge', 1200, '#56d364');

        // Immediate check: Synchronous First Frame (BEFORE any RAF runs!)
        const nativeImmediate = document.getElementById('input-power');
        const numImmediate = nativeImmediate.querySelector('.watt-number');
        const wImmediate = nativeImmediate.querySelector('.watt-unit');
        const ghostImmediate = document.getElementById('input-power-ghost');
        const ghostW = ghostImmediate ? ghostImmediate.querySelector('.watt-unit') : null;
        
        // Verified by zero being hidden and W dx being modulated away from canonical idle dx
        const initialSyncFrameRendered = (numImmediate.style.opacity === '0' &&
          wImmediate.getAttribute('dx') !== canonicalDxBefore);

        const ghostWHidden = !ghostW || window.getComputedStyle(ghostW).opacity === '0';
        const nativeWVisible = wImmediate ? window.getComputedStyle(wImmediate).opacity === '1' : false;

        const nativeDuring = nativeImmediate;
        const numDuring = numImmediate;
        const wDuring = wImmediate;
        const overlayDuring = document.getElementById('input-power-overlay');

        setTimeout(() => {
          const nativeAfter = document.getElementById('input-power');
          const numAfter = nativeAfter.querySelector('.watt-number');
          const wAfter = nativeAfter.querySelector('.watt-unit');
          const ghostAfter = document.getElementById('input-power-ghost');
          const overlayAfter = document.getElementById('input-power-overlay');

          resolve({
            nativeIdentity: (nativeBefore === nativeDuring) && (nativeDuring === nativeAfter),
            numIdentity: (numBefore === numDuring) && (numDuring === numAfter),
            wIdentity: (wBefore === wDuring) && (wDuring === wAfter),
            initialSyncFrameRendered,
            ghostExistedDuring: !!ghostImmediate,
            ghostWHidden,
            nativeWVisible,
            ghostRemovedAfter: !ghostAfter,
            noOverlayDuring: !overlayDuring,
            noOverlayAfter: !overlayAfter,
            finalText: nativeAfter ? nativeAfter.textContent.trim() : ''
          });
        }, 750);
      })
    `);

    console.log('Triple Identity & Visibility Check:', domCheck);

    assert.strictEqual(domCheck.nativeIdentity, true, "Native root node identity must be preserved");
    assert.strictEqual(domCheck.numIdentity, true, "Number tspan identity must be preserved");
    assert.strictEqual(domCheck.wIdentity, true, "W tspan identity must be preserved");
    assert.strictEqual(domCheck.initialSyncFrameRendered, true, "First frame must be rendered synchronously in _startEnergyCollapse");
    assert.strictEqual(domCheck.ghostExistedDuring, true, "Outgoing ghost must exist during transition");
    assert.strictEqual(domCheck.ghostWHidden, true, "Ghost cloned W must be opacity:0 (invisible)");
    assert.strictEqual(domCheck.nativeWVisible, true, "Native W must remain opacity:1 (only visible W)");
    assert.strictEqual(domCheck.ghostRemovedAfter, true, "Ghost must be removed after transition");
    assert.strictEqual(domCheck.noOverlayDuring, true, "Old temporary overlay must NOT exist");
    assert.strictEqual(domCheck.finalText, '0W', "Final text must be '0W'");

    console.log('✅ Task 1 tests passed');
    ws.close();
  } finally {
    chrome.kill();
    server.close();
  }
});
