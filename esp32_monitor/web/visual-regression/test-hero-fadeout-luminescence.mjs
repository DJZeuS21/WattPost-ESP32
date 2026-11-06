/**
 * test-hero-fadeout-luminescence.mjs
 * Verification of Natural Luminescence Fade-Out for Hero energy flow:
 * - DISCHARGING -> IDLE retains purple stroke, discharge clip/filter/halo until dissolved
 * - CHARGING -> IDLE retains green stroke, charge clip/filter/halo until dissolved (no switch to discharge side!)
 * - Opacity fades smoothly to zero while retaining active hue
 * - Rapid active -> idle -> active transitions execute cleanly
 */
import { chromium } from '/opt/node-v22/lib/node_modules/playwright/index.mjs';
import assert from 'node:assert';

const PORT = 8081;
const BASE_URL = `http://127.0.0.1:${PORT}/v16-alt/`;

async function run() {
  console.log('🚀 Starting Natural Luminescence Fade-Out Verification...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.app?.dashboard);
  await page.evaluate(() => window.ApiClient?.stop());

  // Helper to read visual attributes
  const readFlow = () => page.evaluate(() => {
    const ef = window.app.dashboard.energyFlow;
    const main = document.getElementById('flow-main');
    const glow = document.getElementById('flow-glow');
    const halo = document.getElementById('halo-wide');
    const baseRail = document.getElementById('flow-base-track');
    return {
      mainStroke: main?.getAttribute('stroke'),
      mainClip: main?.getAttribute('clip-path'),
      mainFilter: main?.getAttribute('filter'),
      glowStroke: glow?.getAttribute('stroke'),
      haloStroke: halo?.getAttribute('stroke'),
      mainOpacity: ef.mainOpacity,
      glowOpacity: ef.glowOpacity,
      baseRailVisible: baseRail && window.getComputedStyle(baseRail).display !== 'none'
    };
  });

  // =========================================================================
  // 1. DISCHARGING -> IDLE
  // =========================================================================
  console.log('🧪 1. Testing DISCHARGING -> IDLE natural luminescent fade-out...');
  await page.evaluate(() => {
    window.app.dashboard._renderLiveState({
      state: 'discharging',
      abs_power_w: 350,
      current_a: -6.5,
      voltage_v: 52.8,
      soc: 90
    });
  });
  await page.waitForTimeout(600); // let it spin up and achieve opacity

  const activeDischarge = await readFlow();
  console.log(`   ℹ Active discharge: stroke=${activeDischarge.mainStroke}, opacity=${activeDischarge.mainOpacity.toFixed(2)}, clip=${activeDischarge.mainClip}`);
  assert.strictEqual(activeDischarge.mainStroke, '#9d8dff', 'Active discharge stroke is purple #9d8dff');
  assert.strictEqual(activeDischarge.mainClip, 'url(#clip-discharge-right)', 'Active discharge clip is right side');
  assert.strictEqual(activeDischarge.haloStroke, 'url(#glow-grad-discharge)', 'Halo is discharge gradient');

  // Trigger IDLE
  await page.evaluate(() => {
    window.app.dashboard._renderLiveState({ state: 'idle', abs_power_w: 0, current_a: 0, soc: 90 });
  });

  // Check immediately (frame 1) - must NOT be hard-switched to gray!
  await page.waitForTimeout(20);
  const midFadeDischarge1 = await readFlow();
  console.log(`   ℹ 20ms into IDLE: stroke=${midFadeDischarge1.mainStroke}, opacity=${midFadeDischarge1.mainOpacity.toFixed(2)}, clip=${midFadeDischarge1.mainClip}`);
  assert.strictEqual(midFadeDischarge1.mainStroke, '#9d8dff', 'Must retain purple stroke immediately upon entering IDLE');
  assert.strictEqual(midFadeDischarge1.mainClip, 'url(#clip-discharge-right)', 'Must retain discharge clip');
  assert.strictEqual(midFadeDischarge1.haloStroke, 'url(#glow-grad-discharge)', 'Must retain discharge halo');

  // Check at mid-fade (200ms)
  await page.waitForTimeout(200);
  const midFadeDischarge2 = await readFlow();
  console.log(`   ℹ 220ms into IDLE: stroke=${midFadeDischarge2.mainStroke}, opacity=${midFadeDischarge2.mainOpacity.toFixed(2)}`);
  assert.strictEqual(midFadeDischarge2.mainStroke, '#9d8dff', 'Must remain purple during mid-fade');
  assert.ok(midFadeDischarge2.mainOpacity < midFadeDischarge1.mainOpacity, 'Opacity must be actively decaying');
  assert.ok(midFadeDischarge2.baseRailVisible, 'Base rail remains visible throughout fade');

  // Check after full dissolve (900ms)
  await page.waitForTimeout(900);
  const dissolvedDischarge = await readFlow();
  console.log(`   ℹ 1120ms into IDLE: opacity=${dissolvedDischarge.mainOpacity.toFixed(3)}`);
  assert.ok(dissolvedDischarge.mainOpacity < 0.02, 'Opacity reached near-zero (< 0.02)');
  console.log('   ✅ DISCHARGING -> IDLE luminescent fade-out verified');

  // =========================================================================
  // 2. CHARGING -> IDLE
  // =========================================================================
  console.log('🧪 2. Testing CHARGING -> IDLE natural luminescent fade-out...');
  await page.evaluate(() => {
    window.app.dashboard._renderLiveState({
      state: 'charging',
      abs_power_w: 1500,
      current_a: 28.0,
      voltage_v: 53.6,
      soc: 60
    });
  });
  await page.waitForTimeout(600);

  const activeCharge = await readFlow();
  console.log(`   ℹ Active charge: stroke=${activeCharge.mainStroke}, opacity=${activeCharge.mainOpacity.toFixed(2)}, clip=${activeCharge.mainClip}`);
  assert.strictEqual(activeCharge.mainStroke, '#56d364', 'Active charge stroke is green #56d364');
  assert.strictEqual(activeCharge.mainClip, 'url(#clip-charge-left)', 'Active charge clip is left side');
  assert.strictEqual(activeCharge.haloStroke, 'url(#glow-grad-charge)', 'Halo is charge gradient');

  // Trigger IDLE
  await page.evaluate(() => {
    window.app.dashboard._renderLiveState({ state: 'idle', abs_power_w: 0, current_a: 0, soc: 60 });
  });

  // Check immediately (frame 1)
  await page.waitForTimeout(20);
  const midFadeCharge1 = await readFlow();
  console.log(`   ℹ 20ms into IDLE: stroke=${midFadeCharge1.mainStroke}, clip=${midFadeCharge1.mainClip}, halo=${midFadeCharge1.haloStroke}`);
  assert.strictEqual(midFadeCharge1.mainStroke, '#56d364', 'Must retain green stroke immediately upon entering IDLE');
  assert.strictEqual(midFadeCharge1.mainClip, 'url(#clip-charge-left)', 'Must NOT flip to discharge clip!');
  assert.strictEqual(midFadeCharge1.haloStroke, 'url(#glow-grad-charge)', 'Must NOT flip to discharge purple halo!');

  // Check at mid-fade (200ms)
  await page.waitForTimeout(200);
  const midFadeCharge2 = await readFlow();
  console.log(`   ℹ 220ms into IDLE: stroke=${midFadeCharge2.mainStroke}, opacity=${midFadeCharge2.mainOpacity.toFixed(2)}`);
  assert.strictEqual(midFadeCharge2.mainStroke, '#56d364', 'Must remain green during mid-fade');
  assert.strictEqual(midFadeCharge2.mainClip, 'url(#clip-charge-left)', 'Clip remains left');
  assert.ok(midFadeCharge2.mainOpacity < midFadeCharge1.mainOpacity, 'Opacity is actively decaying');

  // Check after full dissolve
  await page.waitForTimeout(900);
  const dissolvedCharge = await readFlow();
  console.log(`   ℹ 1120ms into IDLE: opacity=${dissolvedCharge.mainOpacity.toFixed(3)}`);
  assert.ok(dissolvedCharge.mainOpacity < 0.02, 'Opacity reached near-zero (< 0.02)');
  console.log('   ✅ CHARGING -> IDLE luminescent fade-out verified');

  // =========================================================================
  // 3. Rapid Active -> IDLE -> Active transitions
  // =========================================================================
  console.log('🧪 3. Testing rapid Active -> IDLE -> Active transitions...');
  await page.evaluate(() => {
    window.app.dashboard._renderLiveState({ state: 'charging', abs_power_w: 500, current_a: 10, soc: 60 });
  });
  await page.waitForTimeout(300);

  // Switch to IDLE for 100ms
  await page.evaluate(() => {
    window.app.dashboard._renderLiveState({ state: 'idle', abs_power_w: 0, current_a: 0, soc: 60 });
  });
  await page.waitForTimeout(100);

  // Switch back to CHARGING
  await page.evaluate(() => {
    window.app.dashboard._renderLiveState({ state: 'charging', abs_power_w: 800, current_a: 15, soc: 60 });
  });
  await page.waitForTimeout(200);
  const recoveredCharge = await readFlow();
  console.log(`   ℹ Recovered charge: stroke=${recoveredCharge.mainStroke}, opacity=${recoveredCharge.mainOpacity.toFixed(2)}`);
  assert.strictEqual(recoveredCharge.mainStroke, '#56d364', 'Recovered cleanly to green');
  assert.ok(recoveredCharge.mainOpacity > 0.1, 'Opacity recovering smoothly');

  assert.strictEqual(errors.length, 0, 'Must have zero console errors');
  console.log('🎉 ALL Natural Luminescence Fade-Out tests PASSED!');
  await browser.close();
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
