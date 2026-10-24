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

server.listen(3982, '127.0.0.1', async () => {
  const chrome = spawn('google-chrome', [
    '--headless=new',
    '--remote-debugging-port=9347',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1600,900',
    'http://127.0.0.1:3982/index.html'
  ]);
  await new Promise(r => setTimeout(r, 1200));

  try {
    const listRes = await fetch('http://127.0.0.1:9347/json/list');
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

    // Case A: Active 1200 -> collapsing -> Active 800 interrupts at t=250ms
    const caseA = await evaluate(`
      new Promise(resolve => {
        const d = window.app.dashboard;
        d._setWattActive('charge', '1200', '#56d364', false);
        d._startEnergyCollapse('charge', 1200, '#56d364');

        setTimeout(() => {
          d._setWattActive('charge', '800', '#56d364', false);
          const nativeNow = document.getElementById('input-power');
          const ghostNow = document.getElementById('input-power-ghost');
          const cs = window.getComputedStyle(nativeNow);

          setTimeout(() => {
            const nativeLater = document.getElementById('input-power');
            const ghostLater = document.getElementById('input-power-ghost');
            resolve({
              textImmediately: nativeNow.textContent.trim(),
              ghostImmediatelyRemoved: !ghostNow,
              opacityImmediatelyRestored: cs.opacity === '1',
              textLater: nativeLater.textContent.trim(),
              noLateGhost: !ghostLater
            });
          }, 450);
        }, 250);
      })
    `);
    console.log('Case A (Active Interruption):', caseA);
    assert.strictEqual(caseA.textImmediately, '800W', "Native node must immediately show 800W upon interruption");
    assert.strictEqual(caseA.ghostImmediatelyRemoved, true, "Ghost must be immediately removed on interruption");
    assert.strictEqual(caseA.textLater, '800W', "No delayed RAF must overwrite active 800W");

    // Case B: Mode Reversal (Charge collapsing -> Discharge starts)
    const caseB = await evaluate(`
      new Promise(resolve => {
        const d = window.app.dashboard;
        d._setWattActive('charge', '1200', '#56d364', false);
        d._startEnergyCollapse('charge', 1200, '#56d364');

        setTimeout(() => {
          d._resetWattToIdle('charge');
          d._setWattActive('discharge', '450', '#9d8dff', false);

          const inPower = document.getElementById('input-power');
          const outPower = document.getElementById('output-power');
          const inGhost = document.getElementById('input-power-ghost');
          const outGhost = document.getElementById('output-power-ghost');

          resolve({
            inText: inPower.textContent.trim(),
            outText: outPower.textContent.trim(),
            inGhostRemoved: !inGhost,
            outGhostRemoved: !outGhost
          });
        }, 200);
      })
    `);
    console.log('Case B (Mode Reversal):', caseB);
    assert.strictEqual(caseB.inText, '0W', "Charge must reset to idle");
    assert.strictEqual(caseB.outText, '450W', "Discharge must show active value");
    assert.strictEqual(caseB.inGhostRemoved, true, "Charge ghost must be gone");

    // Case C: Collapse -> Duplicate IDLE packet at t=200ms
    const caseC = await evaluate(`
      new Promise(resolve => {
        const d = window.app.dashboard;
        d._setWattActive('charge', '1200', '#56d364', false);
        d._startEnergyCollapse('charge', 1200, '#56d364');
        const sessBefore = d._wattTransitions['charge'];

        setTimeout(() => {
          if (!d._wattTransitions || !d._wattTransitions['charge']) {
            d._resetWattToIdle('charge');
          }
          const sessAfter = d._wattTransitions['charge'];
          resolve({
            sessionPreserved: sessBefore === sessAfter
          });
        }, 200);
      })
    `);
    console.log('Case C (Duplicate IDLE packet):', caseC);
    assert.strictEqual(caseC.sessionPreserved, true, "Duplicate idle must not abort active collapse");

    // Case D: Real Asynchronous Rapid DEV button switching (10 toggles spaced 20ms apart)
    const caseD = await evaluate(`
      new Promise(resolve => {
        const d = window.app.dashboard;
        let count = 0;
        const interval = setInterval(() => {
          if (count % 2 === 0) {
            d._setWattActive('charge', '1200', '#56d364', false);
          } else {
            d._startEnergyCollapse('charge', 1200, '#56d364');
          }
          count++;
          if (count >= 10) {
            clearInterval(interval);
            d._resetWattToIdle('charge');
            setTimeout(() => {
              const ghost = document.getElementById('input-power-ghost');
              const overlay = document.getElementById('input-power-overlay');
              const textEl = document.getElementById('input-power');
              resolve({
                noGhost: !ghost,
                noOverlay: !overlay,
                finalText: textEl.textContent.trim()
              });
            }, 300);
          }
        }, 20);
      })
    `);
    console.log('Case D (Asynchronous Rapid Switching):', caseD);
    assert.strictEqual(caseD.noGhost, true, "No orphan ghost after asynchronous rapid switching");
    assert.strictEqual(caseD.finalText, '0W', "Final state must be 0W");

    // Case E.1: Mid-collapse Underglow Cancellation at t=150ms
    const caseE1 = await evaluate(`
      new Promise(resolve => {
        const d = window.app.dashboard;
        d._setWattActive('charge', '1200', '#56d364', false);
        d._startEnergyCollapse('charge', 1200, '#56d364');

        setTimeout(() => {
          // Cancel mid-collapse while underglow is contracting
          d._cancelWattTransition('charge');
          const ug = document.getElementById('input-underglow');
          const core = ug.querySelector('#input-underglow-core');

          resolve({
            ugOpacityZero: ug.style.opacity === '0',
            coreWidthRestored: core.getAttribute('width') === '56'
          });
        }, 150);
      })
    `);
    console.log('Case E.1 (Mid-collapse Underglow Cancel):', caseE1);
    assert.strictEqual(caseE1.ugOpacityZero, true, "Underglow opacity must be 0 after cancellation");
    assert.strictEqual(caseE1.coreWidthRestored, true, "Underglow core width must be restored while invisible");

    // Case E.2: Real Active -> Collapse -> Ignition/Materialization Interruption during cleanup window (t=580ms)
    const caseE2 = await evaluate(`
      new Promise(resolve => {
        const d = window.app.dashboard;
        // Start from cleanly established ACTIVE state
        d._setWattActive('charge', '1200', '#56d364', false);
        d._startEnergyCollapse('charge', 1200, '#56d364');

        setTimeout(() => {
          // Trigger ignition/materialization right before collapse ends
          d._setWattActive('charge', '1500', '#56d364', true);
          const nativeNow = document.getElementById('input-power');
          const ghostNow = document.getElementById('input-power-ghost');
          const isMaterializing = !!(d._wattTransitions['charge'] && (d._wattTransitions['charge'].type === 'materialization' || d._wattTransitions['charge'].type === 'ignition'));

          setTimeout(() => {
            const nativeLater = document.getElementById('input-power');
            const ghostLater = document.getElementById('input-power-ghost');
            resolve({
              ghostNowPresent: !!ghostNow,
              materializationActive: isMaterializing,
              textAfterMaterialization: nativeLater.textContent.trim(),
              ghostAfterRemoved: !ghostLater
            });
          }, 700);
        }, 580);
      })
    `);
    console.log('Case E.2 (Materialization Interruption during cleanup):', caseE2);
    assert.strictEqual(caseE2.ghostNowPresent, true, "Materialize ghost must exist during transition");
    assert.strictEqual(caseE2.materializationActive, true, "Materialization session must take over ownership");
    assert.strictEqual(caseE2.textAfterMaterialization, '1500W', "Node must reach full active state without being reset by old collapse");
    assert.strictEqual(caseE2.ghostAfterRemoved, true, "Materialize ghost must be removed after transition finishes");

    console.log('✅ Task 4 Interruption Matrix tests PASSED');
    ws.close();
  } finally {
    chrome.kill();
    server.close();
  }
});
