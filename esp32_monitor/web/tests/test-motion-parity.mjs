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

server.listen(4018, '127.0.0.1', async () => {
  const chrome = spawn('google-chrome', [
    '--headless=new',
    '--remote-debugging-port=9382',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--force-device-scale-factor=1',
    '--run-all-compositor-stages-before-draw',
    '--window-size=1600,900',
    'http://127.0.0.1:4018/index.html'
  ]);

  try {
    let pageTarget = null;
    const targetDeadline = Date.now() + 10_000;
    while (!pageTarget && Date.now() < targetDeadline) {
      try {
        const listRes = await fetch('http://127.0.0.1:9382/json/list');
        const tabs = await listRes.json();
        pageTarget = tabs.find(t => t.type === 'page' && t.url.includes('127.0.0.1:4018')) || null;
      } catch (_error) {
        // The debugging endpoint is not ready until Chrome opens its page.
      }
      if (!pageTarget) await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(pageTarget, 'Chrome page target must become available before motion sampling');
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
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
    await send('Page.enable');
    const evaluate = async (expr) => {
      const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
      return res.result ? res.result.value : null;
    };
    await evaluate(`new Promise(resolve => {
      const check = () => {
        if (document.readyState === 'complete' && window.ApiClient && window.app?.dashboard?.energyFlow) {
          resolve(true);
        } else {
          setTimeout(check, 25);
        }
      };
      check();
    })`);
    await evaluate('window.ApiClient.stop()');
    await evaluate('document.fonts.ready.then(() => true)');
    await evaluate('Promise.all([...document.images].map(image => image.decode().catch(() => null))).then(() => true)');
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await evaluate("window.app.dashboard.energyFlow.setState('idle', 0, null)");
    await evaluate(`new Promise(resolve => {
      const check = () => window.app.dashboard.energyFlow._loopRunning
        ? setTimeout(check, 16)
        : resolve(true);
      check();
    })`);

    await evaluate(`
      (() => {
        const style = document.createElement('style');
        style.textContent = '* { animation-play-state: paused !important; transition: none !important; }';
        document.head.appendChild(style);

        const el = document.getElementById('input-power');
        el.style.transition = 'none';
        const ug = document.getElementById('input-underglow');
        if (ug) ug.style.transition = 'none';
        window.app.dashboard._setWattActive('charge', '1200', '#56d364', false);
        el.style.transition = 'none';
        if (ug) ug.style.transition = 'none';
      })()
    `);

    // 1. Initial 120ms Jitter Check (Centroid Monotonicity)
    console.log('=== Step 1: Initial 120ms Jitter & Hold Check ===');
    const targetMs = [0, 16.7, 33.3, 50, 66.7, 83.3, 100, 120];

    const clip = await evaluate(`
      (() => {
        const text = document.getElementById('input-power');
        const r = text.getBoundingClientRect();
        return {
          x: Math.floor(r.x - 10),
          y: Math.floor(r.y - 10),
          width: Math.ceil(r.width + 20),
          height: Math.ceil(r.height + 20),
          scale: 2
        };
      })()
    `);

    await evaluate(`
      (() => {
        const d = window.app.dashboard;
        d._startEnergyCollapse('charge', 1200, '#56d364');
        const sess = d._wattTransitions['charge'];
        if (sess && sess.timerId) cancelAnimationFrame(sess.timerId);
      })()
    `);

    const jitterSamples = [];
    for (const t of targetMs) {
      const metrics = await evaluate(`
        (() => {
          const d = window.app.dashboard;
          const sess = d._wattTransitions['charge'];
          // Hide native W during ghost digit capture
          sess.wTspan.style.opacity = '0';
          d._renderEnergyCollapseFrame(sess, ${t});
          sess.wTspan.style.opacity = '0';

          const g = sess.ghost;
          const transform = g.getAttribute('transform');
          const cs = window.getComputedStyle(g);
          const opacity = cs.opacity;
          const filter = cs.filter;
          const letterSpacing = cs.letterSpacing;
          if (sess.ugEl) sess.ugEl.style.visibility = 'hidden';

          // The previous brightness centroid mixed position with authored
          // opacity, color and blur changes. At 120ms those visual changes could
          // shift its thresholded center while the transform center stayed put.
          // Normalize only raster appearance, preserving transform and spacing,
          // so this assertion measures geometric jitter. The later checkpoints
          // still verify production opacity/filter/color values.
          g.removeAttribute('filter');
          g.style.setProperty('filter', 'none', 'important');
          g.style.setProperty('opacity', '1', 'important');
          g.style.setProperty('fill', 'rgb(255, 255, 255)', 'important');
          for (const child of g.querySelectorAll('*')) {
            child.style.setProperty('filter', 'none', 'important');
            child.style.setProperty('opacity', '1', 'important');
            child.style.setProperty('fill', 'rgb(255, 255, 255)', 'important');
          }
          g.getBBox();
          g.getComputedTextLength();
          return {
            t: ${t},
            transformAttr: transform,
            csTransform: cs.transform,
            opacity,
            filter,
            letterSpacing
          };
        })()
      `);

      const ss = await send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
        clip,
      });

      const raster = await evaluate(`
        (async () => {
          const d = window.app.dashboard;
          const sess = d._wattTransitions['charge'];
          if (sess.ghost && sess.hasActiveFilterAttr) {
            sess.ghost.setAttribute('filter', sess.activeFilterAttr);
          }
          if (sess.ugEl) sess.ugEl.style.visibility = '';

          const loadImg = (b64) => new Promise(r => {
            const img = new Image();
            img.onload = () => r(img);
            img.src = 'data:image/png;base64,' + b64;
          });
          const img = await loadImg('${ss.data}');
          const w = img.width, h = img.height;
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
          const imgData = ctx.getImageData(0, 0, w, h).data;
          const digitMaxX = Math.floor(w * 0.75);

          let sumX = 0, sumY = 0, totalWeight = 0;
          let pixelCount = 0;

          for (let y = 0; y < h; y++) {
            for (let x = 0; x < digitMaxX; x++) {
              const idx = (y * w + x) * 4;
              const brightness = Math.max(imgData[idx], imgData[idx + 1], imgData[idx + 2]);
              if (brightness > 35) {
                sumX += x * brightness;
                sumY += y * brightness;
                totalWeight += brightness;
                pixelCount++;
              }
            }
          }
          return {
            pixelCount,
            centroidX: totalWeight > 0 ? (sumX / totalWeight) : 0,
            centroidY: totalWeight > 0 ? (sumY / totalWeight) : 0
          };
        })()
      `);

      jitterSamples.push({ ...metrics, ...raster });
    }

    console.table(jitterSamples);

    // Assert strict hold window for t in [0, 66.7ms]
    for (let i = 0; i <= 4; i++) {
      assert.strictEqual(jitterSamples[i].transformAttr, null, `Frame t=${jitterSamples[i].t}ms must have NO transform attribute`);
      assert.strictEqual(jitterSamples[i].pixelCount, jitterSamples[0].pixelCount, `Frame t=${jitterSamples[i].t}ms pixelCount must be constant`);
      assert.ok(Math.abs(jitterSamples[i].centroidX - jitterSamples[0].centroidX) < 0.001, `Centroid X at t=${jitterSamples[i].t}ms must be rock-still`);
    }

    // Assert no violent centroid jumps: deltas between consecutive frames must not have rebound (< 1.0px)
    for (let i = 1; i < jitterSamples.length; i++) {
      const dX = jitterSamples[i].centroidX - jitterSamples[i - 1].centroidX;
      assert.ok(Math.abs(dX) < 1.0, `Consecutive deltaX at frame t=${jitterSamples[i].t}ms was ${dX.toFixed(3)}px (expected < 1.0px)`);
    }
    console.log('✅ Initial 120ms Jitter & Hold Check PASSED!');

    // 2. Motion Parity Checkpoints (u = 0, .12, .25, .42, .55, .68, .82, .90)
    console.log('\n=== Step 2: Motion Parity Checkpoints ===');
    const uList = [0, 0.12, 0.25, 0.42, 0.55, 0.68, 0.82, 0.90];
    const paritySamples = [];

    for (const u of uList) {
      const sample = await evaluate(`
        (() => {
          const d = window.app.dashboard;
          const sess = d._wattTransitions['charge'];
          d._renderEnergyCollapseFrame(sess, ${u} * 620);

          const g = sess.ghost;
          const gPresent = !!(g && g.parentElement);
          const csG = gPresent ? window.getComputedStyle(g) : null;
          const core = sess.core;
          const ugEl = sess.ugEl;

          return {
            u: ${u},
            ghostPresent: gPresent,
            opacity: csG ? parseFloat(csG.opacity) : 0,
            transform: gPresent ? (g.getAttribute('transform') || 'none') : 'none',
            letterSpacing: csG ? csG.letterSpacing : 'normal',
            filter: csG ? csG.filter : 'none',
            ugWidth: core ? parseFloat(core.getAttribute('width')) : 0,
            ugOpacity: ugEl ? parseFloat(ugEl.style.opacity) : 0
          };
        })()
      `);
      paritySamples.push(sample);
    }
    console.table(paritySamples);

    // Verify checkpoints match reference tolerances:
    // u=0.00: opacity 1.0, transform none, ugWidth 56
    assert.strictEqual(paritySamples[0].opacity, 1.0);
    assert.strictEqual(paritySamples[0].transform, 'none');
    assert.strictEqual(paritySamples[0].ugWidth, 56);

    // u=0.12: opacity 1.0, transform none, ugWidth ~48.1
    assert.strictEqual(paritySamples[1].opacity, 1.0);
    assert.strictEqual(paritySamples[1].transform, 'none');
    assert.ok(Math.abs(paritySamples[1].ugWidth - 48.1) < 1.0);

    // u=0.42: opacity ~0.82, scale ~0.985, ugWidth ~28.2
    assert.ok(Math.abs(paritySamples[3].opacity - 0.82) < 0.02);
    assert.ok(paritySamples[3].transform.includes('0.985'));
    assert.ok(Math.abs(paritySamples[3].ugWidth - 28.2) < 1.5);

    // u=0.68: opacity ~0.24, scale ~0.955, ugWidth ~9.6
    assert.ok(Math.abs(paritySamples[5].opacity - 0.24) < 0.02);
    assert.ok(paritySamples[5].transform.includes('0.955'));
    assert.ok(Math.abs(paritySamples[5].ugWidth - 9.6) < 1.5);

    // u=0.82: opacity ~0.14, scale ~0.948, ugWidth ~3.0
    assert.ok(Math.abs(paritySamples[6].opacity - 0.14) < 0.03);
    assert.ok(paritySamples[6].transform.includes('0.948'));
    assert.ok(Math.abs(paritySamples[6].ugWidth - 3.0) < 1.0);

    // u=0.90: ghost opacity <= 0.1, ugWidth 0
    assert.ok(paritySamples[7].opacity <= 0.1);
    assert.strictEqual(paritySamples[7].ugWidth, 0);
    console.log('✅ Motion Parity Checkpoints PASSED!');

    // 3. Color Choreography Verification (u = .35, .40, .50, .60, .68, .75, .85)
    console.log('\n=== Step 3: Color Choreography Verification ===');
    const colorUList = [0.35, 0.40, 0.50, 0.60, 0.68, 0.75, 0.85];
    const colorSamples = [];

    await evaluate(`
      (() => {
        const d = window.app.dashboard;
        d._setWattActive('charge', '1200', '#56d364', false);
        const textEl = document.getElementById('input-power');
        textEl.style.transition = 'none';
        d._startEnergyCollapse('charge', 1200, '#56d364');
        const sess = d._wattTransitions['charge'];
        if (sess && sess.timerId) cancelAnimationFrame(sess.timerId);
      })()
    `);

    for (const u of colorUList) {
      const sample = await evaluate(`
        (() => {
          const d = window.app.dashboard;
          const sess = d._wattTransitions['charge'];
          d._renderEnergyCollapseFrame(sess, ${u} * 620);

          const numTspan = sess.numTspan;
          const wTspan = sess.wTspan;
          const ghost = sess.ghost;

          const numCs = numTspan ? window.getComputedStyle(numTspan) : null;
          const wCs = wTspan ? window.getComputedStyle(wTspan) : null;
          const gCs = (ghost && ghost.parentElement) ? window.getComputedStyle(ghost) : null;

          return {
            u: ${u},
            zeroVisibility: numCs ? numCs.visibility : 'hidden',
            zeroOpacity: numCs ? parseFloat(numCs.opacity) : 0,
            zeroColor: numCs ? numCs.fill : 'none',
            wColor: wCs ? wCs.fill : 'none',
            wInlineFill: wTspan ? wTspan.style.fill : 'none',
            ghostPresent: !!(ghost && ghost.parentElement),
            ghostColor: gCs ? gCs.fill : 'none',
            ghostOpacity: gCs ? parseFloat(gCs.opacity) : 0
          };
        })()
      `);
      colorSamples.push(sample);
    }
    console.table(colorSamples);

    // Acceptance checks for color choreography:
    // 1. Zero is hidden at u=0.35 and u=0.40
    assert.strictEqual(colorSamples[0].zeroVisibility, 'hidden');
    assert.strictEqual(colorSamples[0].zeroOpacity, 0);
    assert.strictEqual(colorSamples[1].zeroVisibility, 'hidden');
    assert.strictEqual(colorSamples[1].zeroOpacity, 0);

    // 2. W reaches canonical idle neutral strictly at u=0.68!
    // Canonical idle neutral is rgb(72, 79, 88)
    const u68Sample = colorSamples.find(s => s.u === 0.68);
    assert.strictEqual(u68Sample.wColor, 'rgb(72, 79, 88)', 'Native W must be canonical neutral rgb(72, 79, 88) strictly at u=0.68');

    // 3. For all u >= 0.68, W color remains strictly canonical neutral!
    for (const s of colorSamples.filter(s => s.u >= 0.68)) {
      assert.strictEqual(s.wColor, 'rgb(72, 79, 88)', `Native W must remain canonical neutral at u=${s.u}`);
      assert.strictEqual(s.zeroColor, 'rgb(72, 79, 88)', `Zero must be canonical neutral at u=${s.u}`);
    }
    console.log('✅ Color Choreography Verification PASSED! No hybrid two-tone state after u=0.68!');

    ws.close();
  } finally {
    chrome.kill();
    server.close();
  }
});
