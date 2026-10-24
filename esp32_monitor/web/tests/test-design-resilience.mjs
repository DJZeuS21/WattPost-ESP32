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

server.listen(3983, '127.0.0.1', async () => {
  const chrome = spawn('google-chrome', [
    '--headless=new',
    '--remote-debugging-port=9348',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1600,900',
    'http://127.0.0.1:3983/index.html'
  ]);
  await new Promise(r => setTimeout(r, 1200));

  try {
    const listRes = await fetch('http://127.0.0.1:9348/json/list');
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
    await send('Page.enable');

    const evaluate = async (expr) => {
      const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
      return res.result ? res.result.value : null;
    };

    await evaluate(`window.ApiClient.stop()`);

    const measureHeader = async (width, height) => {
      await send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false
      });
      return evaluate(`
        (() => {
          const tabs = document.querySelector('.tabs');
          const badge = document.getElementById('bms-online');
          const actions = document.querySelector('.header-actions');
          const headerRect = document.querySelector('.header').getBoundingClientRect();
          const text = badge.lastChild;
          const original = text.nodeValue;
          const measure = value => {
            text.nodeValue = ' ' + value;
            const tabsRect = tabs.getBoundingClientRect();
            const actionsRect = actions.getBoundingClientRect();
            return {
              tabsCenter: tabsRect.left + tabsRect.width / 2,
              overlaps: tabsRect.right > actionsRect.left,
              horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
            };
          };
          const short = measure('8S · JK_PB2A16S20P');
          const long = measure('Втрачено зв’язок з BMS');
          text.nodeValue = original;
          return { short, long, viewportCenter: headerRect.left + headerRect.width / 2 };
        })()
      `);
    };

    const desktopHeader = await measureHeader(1600, 900);
    const mobileHeader = await measureHeader(390, 844);

    const measurePolish = async (width, height) => {
      await send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false
      });
      await evaluate(`window.dispatchEvent(new Event('resize')); true`);
      await new Promise(resolve => setTimeout(resolve, 30));
      return evaluate(`
        (() => {
          const heroElement = document.getElementById('hero-card');
          const hero = heroElement.getBoundingClientRect();
          const svgElement = document.getElementById('energy-flow-svg');
          const svg = svgElement.getBoundingClientRect();
          const metricLabel = document.querySelector('.metric-label');
          const screenFontPx = element => {
            const matrix = element.getScreenCTM();
            const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 0;
            return parseFloat(getComputedStyle(element).fontSize) * scale;
          };
          const screenPoint = (element, x, y) => {
            const matrix = element.getScreenCTM();
            return {
              x: matrix.a * x + matrix.c * y + matrix.e,
              y: matrix.b * x + matrix.d * y + matrix.f
            };
          };
          const anchorOffset = (element, x, y) => {
            const own = screenPoint(element, x, y);
            const canonical = screenPoint(svgElement, x, y);
            return { dx: own.x - canonical.x, dy: own.y - canonical.y };
          };
          const measureCurveClearance = side => {
            const current = document.getElementById(side + '-current');
            const originalCurrent = current.textContent;
            const hadVisibleCurrent = current.classList.contains('is-visible');
            current.textContent = '0.8 A';
            current.classList.add('is-visible');

            const sourceRects = [
              document.getElementById(side + '-circle').getBoundingClientRect(),
              document.getElementById(side + '-label').getBoundingClientRect(),
              document.getElementById(side + '-power').getBoundingClientRect(),
              current.getBoundingClientRect()
            ].filter(rect => rect.width > 0 && rect.height > 0);
            const sourceLeft = Math.min(...sourceRects.map(rect => rect.left));
            const sourceRight = Math.max(...sourceRects.map(rect => rect.right));
            const sourceTop = Math.min(...sourceRects.map(rect => rect.top));
            const sourceBottom = Math.max(...sourceRects.map(rect => rect.bottom));

            const path = document.getElementById('flow-base-track');
            const pathMatrix = path.getScreenCTM();
            const pathLength = path.getTotalLength();
            const curveY = [];
            for (let i = 0; i <= 600; i += 1) {
              const point = path.getPointAtLength(pathLength * i / 600);
              const x = pathMatrix.a * point.x + pathMatrix.c * point.y + pathMatrix.e;
              if (x < sourceLeft || x > sourceRight) continue;
              curveY.push(pathMatrix.b * point.x + pathMatrix.d * point.y + pathMatrix.f);
            }

            current.textContent = originalCurrent;
            if (!hadVisibleCurrent) current.classList.remove('is-visible');

            const curveMin = Math.min(...curveY);
            const curveMax = Math.max(...curveY);
            return {
              gapAbove: curveMin - sourceBottom,
              gapBelow: sourceTop - curveMax
            };
          };
          const inputAnchor = anchorOffset(document.getElementById('input-layout'), 276, 230);
          const outputAnchor = anchorOffset(document.getElementById('output-layout'), 916, 230);
          const etaAnchor = anchorOffset(document.getElementById('eta-layout'), 600, 386);
          const inputCurve = measureCurveClearance('input');
          const outputCurve = measureCurveClearance('output');
          return {
            layout: heroElement.getAttribute('data-hero-layout'),
            viewBox: svgElement.getAttribute('viewBox'),
            heroWidth: hero.width,
            heroContentWidth: heroElement.clientWidth,
            heroHeight: hero.height,
            svgToHeroWidth: svg.width / heroElement.clientWidth,
            inputLabelPx: screenFontPx(document.getElementById('input-label')),
            outputPowerPx: screenFontPx(document.getElementById('output-power')),
            outputUnitPx: screenFontPx(document.querySelector('#output-power .watt-unit')),
            outputCurrentPx: screenFontPx(document.getElementById('output-current')),
            batterySocPx: screenFontPx(document.getElementById('battery-soc')),
            etaPx: screenFontPx(document.getElementById('hero-eta-text')),
            inputAnchorDx: inputAnchor.dx,
            inputAnchorDy: inputAnchor.dy,
            outputAnchorDx: outputAnchor.dx,
            outputAnchorDy: outputAnchor.dy,
            etaAnchorDelta: Math.hypot(etaAnchor.dx, etaAnchor.dy),
            outputCurveGapAbove: outputCurve.gapAbove,
            outputCurveGapBelow: outputCurve.gapBelow,
            inputCurveGapBelow: inputCurve.gapBelow,
            columnLabelDelta: Math.abs(
              document.getElementById('input-label').getBoundingClientRect().top -
              document.getElementById('output-label').getBoundingClientRect().top),
            batteryTransform: document.getElementById('battery-layout').getAttribute('transform') || '',
            horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            labelColor: getComputedStyle(metricLabel).color
          };
        })()
      `);
    };

    const desktopPolish = await measurePolish(1600, 900);
    const mobileWidths = [320, 360, 390, 430];
    const mobilePolish = [];
    for (const width of mobileWidths) {
      mobilePolish.push([width, await measurePolish(width, 844)]);
    }
    const widePhoneWidths = [658, 768];
    const widePhonePolish = [];
    for (const width of widePhoneWidths) {
      widePhonePolish.push([width, await measurePolish(width, 1060)]);
    }
    const beforeOldBreakpoint = await measurePolish(639, 844);
    const afterOldBreakpoint = await measurePolish(640, 844);
    const tabletWidths = [830, 844, 908, 950, 965];
    const tabletPolish = [];
    for (const width of tabletWidths) {
      tabletPolish.push([width, await measurePolish(width, 1060)]);
    }

    let boundaryLow = 760;
    let boundaryHigh = 860;
    let beforeTablet = null;
    let afterTablet = null;
    while (boundaryHigh - boundaryLow > 1) {
      const mid = Math.floor((boundaryLow + boundaryHigh) / 2);
      const metrics = await measurePolish(mid, 1060);
      if (metrics.heroContentWidth < 740) {
        boundaryLow = mid;
        beforeTablet = metrics;
      } else {
        boundaryHigh = mid;
        afterTablet = metrics;
      }
    }
    beforeTablet = beforeTablet || await measurePolish(boundaryLow, 1060);
    afterTablet = afterTablet || await measurePolish(boundaryHigh, 1060);

    assert.ok(Math.abs((desktopPolish.heroWidth / desktopPolish.heroHeight) - (1200 / 390)) < 0.03,
      'desktop Hero must retain the canonical 1200:390 crop');
    assert.strictEqual(desktopPolish.layout, 'desktop',
      'wide Hero must use the canonical desktop layout');
    assert.ok(Math.abs(desktopPolish.svgToHeroWidth - 1) < 0.01,
      'desktop Hero SVG must retain the original full-width composition');

    const assertMobileHero = (metrics, viewport) => {
      assert.strictEqual(metrics.layout, 'mobile',
        `${viewport}: Hero must use the mobile composition`);
      assert.ok(metrics.heroHeight >= 280 && metrics.heroHeight <= 342,
        `${viewport}: mobile Hero height must remain content-sized`);
      assert.ok(metrics.inputLabelPx >= 13 && metrics.inputLabelPx <= 15,
        `${viewport}: labels must render near 14px (got ${metrics.inputLabelPx}px)`);
      assert.ok(metrics.outputPowerPx >= 26 && metrics.outputPowerPx <= 30,
        `${viewport}: power must render near 28px (got ${metrics.outputPowerPx}px)`);
      assert.ok(metrics.outputUnitPx >= 13 && metrics.outputUnitPx <= 15,
        `${viewport}: watt unit must render near 14px (got ${metrics.outputUnitPx}px)`);
      assert.ok(metrics.outputCurrentPx >= 13 && metrics.outputCurrentPx <= 15,
        `${viewport}: current must render near 14px (got ${metrics.outputCurrentPx}px)`);
      assert.ok(metrics.batterySocPx >= 29 && metrics.batterySocPx <= 32,
        `${viewport}: SOC must stay prominent around 30px (got ${metrics.batterySocPx}px)`);
      assert.ok(metrics.etaPx >= 14 && metrics.etaPx <= 16,
        `${viewport}: ETA must render near 15px (got ${metrics.etaPx}px)`);
      assert.ok(metrics.outputCurveGapBelow >= 8,
        `${viewport}: phone load block must stay below the flow curve (gap ${metrics.outputCurveGapBelow}px)`);
      assert.ok(metrics.inputCurveGapBelow >= 8,
        `${viewport}: phone charge block must stay below the flow curve`);
      assert.ok(metrics.columnLabelDelta < 0.5,
        `${viewport}: the two phone columns must align on the same baseline`);
      assert.strictEqual(metrics.horizontalOverflow, false,
        `${viewport}: mobile Hero must not create page overflow`);
    };
    for (const [width, metrics] of [...mobilePolish, ...widePhonePolish]) {
      assertMobileHero(metrics, `${width}px`);
    }

    assert.strictEqual(beforeOldBreakpoint.layout, 'mobile',
      '639px must remain in the same responsive Hero composition');
    assert.strictEqual(afterOldBreakpoint.layout, 'mobile',
      '640px must not fall back to the old tiny-text desktop composition');
    assert.ok(Math.abs(beforeOldBreakpoint.outputPowerPx - afterOldBreakpoint.outputPowerPx) < 0.5,
      '639/640px must not introduce a visible power-size cliff');

    const assertTabletHero = (metrics, viewport) => {
      const viewBox = metrics.viewBox.split(/\s+/).map(Number);
      assert.strictEqual(metrics.layout, 'tablet',
        `${viewport}: Hero must use the tablet composition`);
      assert.ok(metrics.heroHeight >= 328 && metrics.heroHeight <= 342,
        `${viewport}: tablet Hero height must stay continuous with phone/desktop layouts`);
      assert.strictEqual(viewBox[0], 0,
        `${viewport}: tablet viewBox must keep canonical horizontal origin`);
      assert.ok(viewBox[1] <= 0,
        `${viewport}: tablet may add only symmetric vertical breathing room`);
      assert.strictEqual(viewBox[2], 1200,
        `${viewport}: tablet must keep canonical horizontal SVG geometry`);
      assert.ok(viewBox[3] >= 440,
        `${viewport}: tablet must not vertically crop or distort the canonical curve`);
      assert.strictEqual(metrics.batteryTransform, '',
        `${viewport}: battery must remain canonical relative to the curve`);
      assert.ok(Math.abs(metrics.inputAnchorDx) < 0.5,
        `${viewport}: charge block must preserve canonical X anchor 276`);
      assert.ok(Math.abs(metrics.outputAnchorDx) < 0.5,
        `${viewport}: load block must preserve canonical X anchor 916`);
      assert.ok(metrics.inputCurveGapBelow >= 8,
        `${viewport}: the charge icon and text must fit BELOW the left crest (gap ${metrics.inputCurveGapBelow}px)`);
      assert.ok(metrics.etaAnchorDelta < 0.5,
        `${viewport}: ETA scaling must preserve canonical center 600/386`);
      assert.ok(metrics.inputLabelPx >= 13 && metrics.inputLabelPx <= 15,
        `${viewport}: tablet labels must remain readable (got ${metrics.inputLabelPx}px)`);
      assert.ok(metrics.outputPowerPx >= 27 && metrics.outputPowerPx <= 29,
        `${viewport}: tablet power must stay near 28px (got ${metrics.outputPowerPx}px)`);
      assert.ok(metrics.outputUnitPx >= 13 && metrics.outputUnitPx <= 15,
        `${viewport}: tablet watt unit must remain readable (got ${metrics.outputUnitPx}px)`);
      assert.ok(metrics.outputCurrentPx >= 13 && metrics.outputCurrentPx <= 15,
        `${viewport}: tablet current must remain readable (got ${metrics.outputCurrentPx}px)`);
      assert.ok(metrics.etaPx >= 14 && metrics.etaPx <= 16,
        `${viewport}: tablet ETA must stay near 15px (got ${metrics.etaPx}px)`);
      assert.ok(metrics.outputCurveGapAbove >= 8,
        `${viewport}: tablet load block must stay above the flow curve (gap ${metrics.outputCurveGapAbove}px)`);
      assert.strictEqual(metrics.horizontalOverflow, false,
        `${viewport}: tablet Hero must not create page overflow`);
    };
    for (const [width, metrics] of tabletPolish) {
      assertTabletHero(metrics, `${width}px`);
    }

    assert.ok(beforeTablet.heroContentWidth < 740,
      'boundary search must end below the 740px Hero content breakpoint');
    assert.ok(afterTablet.heroContentWidth >= 740,
      'boundary search must enter the 740px Hero content breakpoint');
    assert.strictEqual(beforeTablet.layout, 'mobile',
      'Hero must remain in phone composition immediately before its 740px content breakpoint');
    assert.strictEqual(afterTablet.layout, 'tablet',
      'Hero must enter tablet composition when its actual content width reaches 740px');
    assert.ok(Math.abs(beforeTablet.heroHeight - afterTablet.heroHeight) < 1,
      'phone/tablet transition must not jump in card height');
    assert.ok(Math.abs(beforeTablet.outputPowerPx - afterTablet.outputPowerPx) < 0.5,
      'phone/tablet transition must preserve primary power size');
    assert.ok(beforeTablet.outputCurveGapBelow >= 8,
      'last phone width must keep the load block safely below the curve');
    assert.ok(afterTablet.outputCurveGapAbove >= 8,
      'first tablet width must keep the load block safely above the curve');

    // Check both newly reported cliffs, not just the obsolete 639/640 rule.
    const boundaryReference = await measurePolish(1000, 900);
    const viewportInset = 1000 - boundaryReference.heroContentWidth;
    for (const [low, high] of [
      [899 + viewportInset, 900 + viewportInset],
      [1023, 1024],
      [1199 + viewportInset, 1200 + viewportInset]
    ]) {
      const before = await measurePolish(low, 900);
      const after = await measurePolish(high, 900);
      for (const key of ['inputLabelPx', 'outputPowerPx', 'outputCurrentPx', 'batterySocPx', 'etaPx']) {
        assert.ok(Math.abs(before[key] - after[key]) < 0.5,
          `${low}/${high}px: ${key} must not jump at a layout boundary`);
      }
      assert.ok(Math.abs(before.heroHeight - after.heroHeight) < 1,
        `${low}/${high}px: card height must not jump at a viewport media query`);
      assert.ok(after.inputLabelPx >= 13.9 && after.outputCurrentPx >= 13.9 && after.etaPx >= 14.9,
        `${high}px: wide layouts must not shrink secondary text below readable sizes`);
      assert.ok(after.inputCurveGapBelow >= 8 && after.outputCurveGapAbove >= 8,
        `${high}px: both source blocks must stay clear of the curve`);
    }

    // The old 18-unit pill was smaller than the enlarged text even though
    // font-size checks passed. Exercise the real unfold before measuring it.
    await measurePolish(320, 844);
    await evaluate(`window.app.dashboard._updateDirectionalEta('discharging', '≈ 12 д 23 год'); true`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const capsule = await evaluate(`(() => {
      const shape = document.getElementById('hero-eta-shape').getBoundingClientRect();
      const text = document.getElementById('hero-eta-text').getBoundingClientRect();
      const battery = document.getElementById('battery-pulse').getBoundingClientRect();
      return {
        phase: document.getElementById('hero-directional-eta').dataset.capsulePhase,
        top: text.top - shape.top, bottom: shape.bottom - text.bottom,
        left: text.left - shape.left, right: shape.right - text.right,
        batteryGap: shape.top - battery.bottom
      };
    })()`);
    assert.strictEqual(capsule.phase, 'open', 'ETA must finish its original unfold lifecycle');
    for (const edge of ['top', 'bottom', 'left', 'right']) {
      assert.ok(capsule[edge] >= 2, `ETA must have inner padding at ${edge}: ${capsule[edge]}px`);
    }
    assert.ok(capsule.batteryGap >= 12, 'the enlarged ETA must not touch the battery');

    assert.strictEqual(desktopPolish.labelColor, 'rgb(110, 118, 129)',
      'metric labels must use the improved muted contrast');
    assert.strictEqual(mobilePolish[2][1].labelColor, 'rgb(110, 118, 129)',
      'metric-label contrast must remain consistent on mobile');

    await send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 900, deviceScaleFactor: 1, mobile: false
    });

    for (const [viewport, header] of [['desktop', desktopHeader], ['mobile', mobileHeader]]) {
      assert.ok(Math.abs(header.short.tabsCenter - header.viewportCenter) < 0.5,
        `${viewport}: tabs must be centered with short status text`);
      assert.ok(Math.abs(header.long.tabsCenter - header.viewportCenter) < 0.5,
        `${viewport}: tabs must stay centered with long status text`);
      assert.strictEqual(header.long.overlaps, false,
        `${viewport}: long status text must not overlap tabs`);
      assert.strictEqual(header.long.horizontalOverflow, false,
        `${viewport}: long status text must not cause horizontal overflow`);
    }

    const productionShell = await evaluate(`
      (async () => {
        const headingState = (selector) => {
          const heading = document.querySelector(selector);
          if (!heading) return null;
          const style = getComputedStyle(heading);
          const rect = heading.getBoundingClientRect();
          return {
            text: heading.textContent.trim(),
            visuallyHidden: style.display !== 'none' && style.visibility !== 'hidden' && rect.width <= 1 && rect.height <= 1
          };
        };

        const dashboardHeading = headingState('#view-dashboard h1');
        window.app._setTab('settings', false);
        const settingsHeading = headingState('#view-settings h1');
        window.app._setTab('bms-settings', false);
        const bmsSettingsHeading = headingState('#view-bms-settings h1');
        window.app._setTab('dashboard', false);

        const rawUrl = getComputedStyle(document.documentElement).getPropertyValue('--hero-glow-dither').trim();
        const imageUrl = rawUrl.replace(/^url\\(["']?/, '').replace(/["']?\\)$/, '');
        const ditherLoaded = await new Promise(resolve => {
          const image = new Image();
          image.onload = () => resolve(image.width === 32 && image.height === 32);
          image.onerror = () => resolve(false);
          image.src = imageUrl;
        });

        return { dashboardHeading, settingsHeading, bmsSettingsHeading, ditherLoaded };
      })()
    `);

    assert.deepStrictEqual(productionShell.dashboardHeading, {
      text: 'Моніторинг батареї', visuallyHidden: true
    }, 'Dashboard must expose a visually hidden page heading');
    assert.deepStrictEqual(productionShell.settingsHeading, {
      text: 'Налаштування WattPost', visuallyHidden: false
    }, 'Device Settings must expose a visible page heading');
    assert.deepStrictEqual(productionShell.bmsSettingsHeading, {
      text: 'Налаштування BMS', visuallyHidden: true
    }, 'BMS Settings must preserve its accessible page heading');
    assert.strictEqual(productionShell.ditherLoaded, true, 'Hero dither texture must load as a valid 32×32 image');

    // Pause CSS animations and hide underglow for deterministic pixel diffs
    await evaluate(`
      (() => {
        const style = document.createElement('style');
        style.textContent = '* { animation-play-state: paused !important; }';
        document.head.appendChild(style);
        const u1 = document.getElementById('input-underglow');
        if (u1) u1.style.opacity = '0';
        const u2 = document.getElementById('output-underglow');
        if (u2) u2.style.opacity = '0';
      })()
    `);

    const computePixelDiff = async (b64A, b64B) => {
      return await evaluate(`
        (async () => {
          const loadImg = (b64) => new Promise(r => {
            const img = new Image();
            img.onload = () => r(img);
            img.src = 'data:image/png;base64,' + b64;
          });
          const img1 = await loadImg('${b64A}');
          const img2 = await loadImg('${b64B}');
          const w = img1.width, h = img1.height;
          const c1 = document.createElement('canvas'); c1.width = w; c1.height = h;
          const ctx1 = c1.getContext('2d'); ctx1.drawImage(img1, 0, 0);
          const d1 = ctx1.getImageData(0, 0, w, h).data;
          const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
          const ctx2 = c2.getContext('2d'); ctx2.drawImage(img2, 0, 0);
          const d2 = ctx2.getImageData(0, 0, w, h).data;

          let diffCount = 0;
          let maxDelta = 0;
          for (let i = 0; i < d1.length; i += 4) {
            const dr = Math.abs(d1[i] - d2[i]);
            const dg = Math.abs(d1[i+1] - d2[i+1]);
            const db = Math.abs(d1[i+2] - d2[i+2]);
            const d = Math.max(dr, dg, db);
            if (d > maxDelta) maxDelta = d;
            if (d > 8) {
              diffCount++;
            }
          }
          return { diffCount, maxDelta };
        })()
      `);
    };

    const runSideMutationTests = async (side) => {
      const textId = (side === 'charge') ? 'input-power' : 'output-power';
      const activeVal = (side === 'charge') ? 1200 : 450;
      const activeColor = (side === 'charge') ? '#56d364' : '#9d8dff';

      const runMutation = async (name, mutateFn) => {
        console.log(`=== Testing Side: [${side}] | Mutation: ${name} ===`);

        // Capture original attributes before mutation dynamically
        const origState = await evaluate(`
          (() => {
            const el = document.getElementById('${textId}');
            return {
              hasX: el.hasAttribute('x'),
              x: el.getAttribute('x'),
              hasY: el.hasAttribute('y'),
              y: el.getAttribute('y'),
              fontSize: el.style.fontSize,
              fontWeight: el.style.fontWeight
            };
          })()
        `);

        await evaluate(`(${mutateFn})('${textId}')`);

        // 1. Establish ACTIVE first, THEN compute union clip
        await evaluate(`
          (() => {
            const el = document.getElementById('${textId}');
            el.style.transition = 'none';
            const ug = document.getElementById('${side === "charge" ? "input" : "output"}-underglow');
            if (ug) ug.style.transition = 'none';
            window.app.dashboard._setWattActive('${side}', '${activeVal}', '${activeColor}', false);
            el.style.transition = 'none';
            if (ug) ug.style.transition = 'none';
          })()
        `);

        const clip = await evaluate(`
          (() => {
            const text = document.getElementById('${textId}');
            const r = text.getBoundingClientRect();
            return {
              x: Math.floor(r.x - 2),
              y: Math.floor(r.y - 2),
              width: Math.ceil(r.width + 4),
              height: Math.ceil(r.height + 4),
              scale: 2
            };
          })()
        `);

        await new Promise(r => setTimeout(r, 80));
        const ssActiveNative = await send('Page.captureScreenshot', { format: 'png', clip });

        // 2. Start collapse and check initial composite frame (rendered synchronously in _startEnergyCollapse!)
        await evaluate(`
          (() => {
            const d = window.app.dashboard;
            d._startEnergyCollapse('${side}', ${activeVal}, '${activeColor}');
            const sess = d._wattTransitions['${side}'];
            if (sess && sess.timerId) cancelAnimationFrame(sess.timerId);
          })()
        `);
        await new Promise(r => setTimeout(r, 80));
        const ssInitialGhost = await send('Page.captureScreenshot', { format: 'png', clip });
        const initialDiff = await computePixelDiff(ssActiveNative.data, ssInitialGhost.data);
        console.log(`Initial Composite Pixel Diff [${side}]:`, initialDiff);

        // 3. Multi-frame Zero-Stationarity and Signed Monotonic W Trajectory Check
        const frameCheck = await evaluate(`
          (() => {
            const d = window.app.dashboard;
            const sess = d._wattTransitions['${side}'];
            const textEl = document.getElementById('${textId}');

            // Measure canonical idle zero position
            const idleZeroX = textEl.getStartPositionOfChar(0).x;
            const idleZeroY = textEl.getStartPositionOfChar(0).y;

            const uChecks = [0.2, 0.4, 0.6, 0.8, 0.85];
            const zeroDeltas = [];
            const wPositions = [];
            let ghostWHiddenAll = true;

            for (const u of uChecks) {
              d._renderEnergyCollapseFrame(sess, u * 620);
              const curZero = textEl.getStartPositionOfChar(0);
              const curW = textEl.getStartPositionOfChar(1);
              zeroDeltas.push(Math.abs(curZero.x - idleZeroX) + Math.abs(curZero.y - idleZeroY));
              wPositions.push(curW.x);

              if (sess.ghost) {
                const gw = sess.ghost.querySelector('.watt-unit');
                if (gw && gw.style.opacity !== '0') ghostWHiddenAll = false;
              }
            }

            // Check underglow center follows
            const core = sess.core;
            const coreCenterX = Number(core.getAttribute('x')) + Number(core.getAttribute('width')) / 2;
            const ugFollows = Math.abs(coreCenterX - sess.ugCenterX) < 0.1;

            // Signed trajectory check based on deltaDxMax
            let trajectoryValid = false;
            if (sess.deltaDxMax > 0.1) {
              // Inward from right to left: monotonically non-increasing
              trajectoryValid = wPositions.every((val, i) => i === 0 || val <= wPositions[i - 1] + 0.05);
            } else if (sess.deltaDxMax < -0.1) {
              // Inward from left to right: monotonically non-decreasing
              trajectoryValid = wPositions.every((val, i) => i === 0 || val >= wPositions[i - 1] - 0.05);
            } else {
              trajectoryValid = wPositions.every(val => Math.abs(val - wPositions[0]) < 0.1);
            }

            return {
              maxZeroDelta: Math.max(...zeroDeltas),
              trajectoryValid,
              ghostWHiddenAll,
              ugFollows
            };
          })()
        `);
        console.log(`Multi-frame Check [${side}]:`, frameCheck);

        // 4. Pre-finish vs Post-finish Frame
        await evaluate(`
          (() => {
            const d = window.app.dashboard;
            const sess = d._wattTransitions['${side}'];
            d._renderEnergyCollapseFrame(sess, 620);
          })()
        `);
        const ssPreFinish = await send('Page.captureScreenshot', { format: 'png', clip });

        await evaluate(`
          (() => {
            const d = window.app.dashboard;
            const sess = d._wattTransitions['${side}'];
            d._finishEnergyCollapse(sess);
          })()
        `);
        const ssPostFinish = await send('Page.captureScreenshot', { format: 'png', clip });
        const finishDiff = await computePixelDiff(ssPreFinish.data, ssPostFinish.data);
        console.log(`Cleanup Pixel Diff [${side}]:`, finishDiff);

        // Revert dynamically to exact captured attributes
        await evaluate(`
          (() => {
            const el = document.getElementById('${textId}');
            if (${origState.hasX}) el.setAttribute('x', '${origState.x}'); else el.removeAttribute('x');
            if (${origState.hasY}) el.setAttribute('y', '${origState.y}'); else el.removeAttribute('y');
            el.style.fontSize = '${origState.fontSize}';
            el.style.fontWeight = '${origState.fontWeight}';
          })()
        `);

        assert.strictEqual(initialDiff.diffCount, 0, `Initial frame must have 0 pixel diff for ${name} on ${side}`);
        assert.ok(frameCheck.maxZeroDelta < 0.05, `Zero must remain stationary (delta < 0.05) for ${name} on ${side}`);
        assert.strictEqual(frameCheck.trajectoryValid, true, `W trajectory must match signed direction for ${name} on ${side}`);
        assert.strictEqual(frameCheck.ghostWHiddenAll, true, `Ghost W must remain opacity 0 for ${name} on ${side}`);
        assert.strictEqual(frameCheck.ugFollows, true, `Underglow center must follow design for ${name} on ${side}`);
        assert.strictEqual(finishDiff.diffCount, 0, `Cleanup must have 0 pixel diff for ${name} on ${side}`);
      };

      await runMutation('Font-size 36px', (id) => { document.getElementById(id).style.fontSize = '36px'; });
      await runMutation('Y +7px', (id) => {
        const el = document.getElementById(id);
        el.setAttribute('y', String(Number(el.getAttribute('y')) + 7));
      });
      await runMutation('X +10px', (id) => {
        const el = document.getElementById(id);
        el.setAttribute('x', String(Number(el.getAttribute('x')) + 10));
      });
      await runMutation('Font-weight 700', (id) => { document.getElementById(id).style.fontWeight = '700'; });
    };

    // Run full test suite for Charge (input-power)
    await runSideMutationTests('charge');
    // Run full test suite for Discharge (output-power)
    await runSideMutationTests('discharge');

    console.log('✅ All mutations PASSED for both Charge and Discharge with 0 pixel diff!');
    ws.close();
  } finally {
    chrome.kill();
    server.close();
  }
});
