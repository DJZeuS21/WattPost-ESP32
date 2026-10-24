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

server.listen(3984, '127.0.0.1', async () => {
  const chrome = spawn('google-chrome', [
    '--headless=new', '--remote-debugging-port=9349', '--disable-gpu',
    '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,900',
    'http://127.0.0.1:3984/index.html'
  ]);
  await new Promise(r => setTimeout(r, 1200));

  try {    const listRes = await fetch('http://127.0.0.1:9349/json/list');
    const tabs = await listRes.json();
    const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    let id = 1;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const msgId = id++;
      const handler = (evt) => {
        const data = JSON.parse(evt.data);
        if (data.id !== msgId) return;
        ws.removeEventListener('message', handler);
        if (data.error) reject(data.error); else resolve(data.result);
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
    await send('Runtime.enable');

    const evaluate = async (expr) => {
      const res = await send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true
      });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
      return res.result ? res.result.value : null;
    };

    await evaluate('window.ApiClient.stop()');
    const result = await evaluate(`
      (async () => {
        const d = window.app.dashboard;
        const base = {
          state: 'charging', abs_power_w: 120, current_a: 4.4,
          model: 'TEST', voltage_v: 27.0,
          remaining_capacity_ah: 100, nominal_capacity_ah: 100
        };
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const waitUntil = async (predicate, timeoutMs = 1500) => {
          const deadline = performance.now() + timeoutMs;
          while (!predicate()) {
            if (performance.now() >= deadline) {
              throw new Error('Timed out waiting for animation state');
            }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        };
        const waveIds = ['wave-layer-1','wave-layer-2','wave-layer-3'];
        const snapshot = () => {
          const waves = waveIds.map(id => {
            const el = document.getElementById(id);
            return { display: el.style.display, opacity: Number(getComputedStyle(el).opacity) };
          });
          const bubbles = document.getElementById('bubble-group');
          return {
            fillY: document.getElementById('liquid-fill').getAttribute('y'),
            fillHeight: document.getElementById('liquid-fill').getAttribute('height'),
            clipY: document.getElementById('liquid-level-clip-rect').getAttribute('y'),
            clipHeight: document.getElementById('liquid-level-clip-rect').getAttribute('height'),
            waves,
            bubbleDisplay: bubbles.style.display,
            bubbleOpacity: Number(getComputedStyle(bubbles).opacity),
            bubblePlayState: bubbles.firstElementChild?.style.animationPlayState || '',
            socText: document.getElementById('battery-soc').firstChild.nodeValue.trim()
          };
        };
        const captureOpacityTransition = async () => {
          const elements = [
            ...waveIds.map(id => document.getElementById(id)),
            document.getElementById('bubble-group'),
          ];

          // Force the style change to be resolved while the previous state is
          // still known. Then inspect the real CSS transitions instead of
          // guessing their progress from wall-clock sleep timing.
          void document.body.offsetWidth;
          const transitions = elements.map(el => {
            const transition = el.getAnimations().find(animation =>
              animation instanceof CSSTransition &&
              animation.transitionProperty === 'opacity'
            );
            if (!transition) {
              throw new Error('Missing opacity transition for #' + el.id);
            }
            const duration = Number(transition.effect.getTiming().duration);
            if (!(duration > 0)) {
              throw new Error('Invalid opacity transition duration for #' + el.id + ': ' + duration);
            }
            transition.pause();
            transition.currentTime = duration / 2;
            return transition;
          });

          await nextFrame();
          const mid = snapshot();

          for (const transition of transitions) transition.play();
          await Promise.all(transitions.map(transition => transition.finished));
          await nextFrame();
          return { mid, settled: snapshot() };
        };

        d._renderLiveState({ ...base, soc: 99 });
        await sleep(800);
        const partialBefore = snapshot();

        d._renderLiveState({ ...base, soc: 100 });
        const fullTransition = await captureOpacityTransition();
        await waitUntil(() =>
          document.getElementById('bubble-group').firstElementChild?.style.animationPlayState === 'paused'
        );
        fullTransition.settled = snapshot();

        d._renderLiveState({ ...base, soc: 99 });
        const partialTransition = await captureOpacityTransition();

        return {
          partialBefore,
          fullMid: fullTransition.mid,
          fullSettled: fullTransition.settled,
          partialMid: partialTransition.mid,
          partialSettled: partialTransition.settled,
        };
      })()
    `);

    assert.strictEqual(result.partialBefore.socText, '99');
    assert.ok(result.partialBefore.waves.every(w => w.display === '' && w.opacity > 0.99));
    assert.ok(result.partialBefore.bubbleOpacity > 0.99);

    // At 100% the same wave DOM remains mounted and fades while the flat fill
    // reaches the top. Mid-transition opacity proves this is not a discrete swap.
    assert.strictEqual(result.fullMid.fillY, '148');
    assert.strictEqual(result.fullMid.fillHeight, '210');
    assert.ok(result.fullMid.waves.every(w => w.display === '' && w.opacity > 0 && w.opacity < 1));
    assert.ok(result.fullMid.bubbleOpacity > 0 && result.fullMid.bubbleOpacity < 1);

    assert.strictEqual(result.fullSettled.clipY, '148');
    assert.strictEqual(result.fullSettled.clipHeight, '210');
    assert.ok(result.fullSettled.waves.every(w => w.display === '' && w.opacity < 0.01));
    assert.ok(result.fullSettled.bubbleOpacity < 0.01);
    assert.strictEqual(result.fullSettled.bubblePlayState, 'paused');
    assert.strictEqual(result.fullSettled.socText, '100');

    // Leaving 100% is symmetrical: waves/bubbles fade back in rather than pop.
    assert.ok(result.partialMid.waves.every(w => w.display === '' && w.opacity > 0 && w.opacity < 1));
    assert.ok(result.partialMid.bubbleOpacity > 0 && result.partialMid.bubbleOpacity < 1);
    assert.strictEqual(result.partialMid.bubblePlayState, 'running');
    assert.ok(result.partialSettled.waves.every(w => w.opacity > 0.99));
    assert.ok(result.partialSettled.bubbleOpacity > 0.99);
    assert.strictEqual(result.partialSettled.socText, '99');

    console.log('✅ Full battery liquid settles smoothly to flat fill and resumes without a visible swap');
    ws.close();
  } finally {
    chrome.kill();
    server.close();
  }
});
