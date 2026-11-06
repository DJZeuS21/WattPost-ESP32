/**
 * test-hero-directional-reveal.mjs
 * Verification of Directional Reveal Mask (800ms) + Soft Spin-up + Static Base Rail Isolation in V16_alt
 */
import { chromium } from '/opt/node-v22/lib/node_modules/playwright/index.mjs';
import assert from 'node:assert';

const PORT = 8081;
const BASE_URL = `http://127.0.0.1:${PORT}/v16-alt/`;
const ARTIFACT_DIR = '/root/.gemini/antigravity-cli/brain/e8216e21-afec-44a6-a420-d4baf95f4073';

async function run() {
  console.log('🚀 Starting Hero Directional Reveal & Base Rail Isolation verification...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => window.ApiClient?.stop());

  // 0. Verify Static Base Rail Isolation
  console.log('🧪 0. Testing Static Gray Base Rail Isolation...');
  const baseTrack = await page.evaluate(() => {
    const el = document.getElementById('flow-base-track');
    const maskGroup = document.querySelector('g[mask="url(#flow-alpha-mask)"]');
    return {
      exists: !!el,
      isInsideMaskGroup: maskGroup ? maskGroup.contains(el) : false,
      stroke: el?.getAttribute('stroke'),
      strokeWidth: el?.getAttribute('stroke-width'),
      display: el ? window.getComputedStyle(el).display : null,
      visibility: el ? window.getComputedStyle(el).visibility : null,
      opacity: el ? window.getComputedStyle(el).opacity : null
    };
  });

  assert.ok(baseTrack.exists, 'Base track must exist with id="flow-base-track"');
  assert.strictEqual(baseTrack.isInsideMaskGroup, false, 'Base track must NOT be inside reveal mask group');
  assert.notStrictEqual(baseTrack.display, 'none', 'Base track must be displayed');
  assert.notStrictEqual(baseTrack.visibility, 'hidden', 'Base track must not be hidden');
  console.log('   ✅ Static gray base rail is fully separated from active reveal mask');

  // 1. Initial IDLE state check
  console.log('🧪 1. Testing IDLE state...');
  await page.evaluate(() => {
    window.app.dashboard._renderLiveState({
      state: 'idle',
      abs_power_w: 0,
      current_a: 0,
      voltage_v: 53.2,
      soc: 95,
      nominal_capacity_ah: 315,
      remaining_capacity_ah: 300,
      temperatures: { summary_c: 24, sensors: [] },
      cells: { count: 16, spread_mv: 8 }
    });
  });
  await page.waitForTimeout(1200);

  const idleState = await page.evaluate(() => {
    const ef = window.app.dashboard.energyFlow;
    const baseRail = document.getElementById('flow-base-track');
    return {
      revealActive: ef.revealActive,
      revealState: ef.revealState,
      mainOpacity: ef.mainOpacity,
      baseRailVisible: baseRail && window.getComputedStyle(baseRail).display !== 'none'
    };
  });

  assert.strictEqual(idleState.revealActive, false, 'Idle state must have revealActive=false');
  assert.strictEqual(idleState.revealState, 'idle', 'Idle state must have revealState="idle"');
  assert.ok(idleState.mainOpacity < 0.06, `Idle mainOpacity must be ~0 (got ${idleState.mainOpacity})`);
  assert.ok(idleState.baseRailVisible, 'Base rail must be visible in idle');
  console.log('   ✅ IDLE state verified (flow dissolved, base rail visible)');

  // 2. IDLE -> CHARGING: Directional Reveal (700-900ms pacing)
  console.log('🧪 2. Testing IDLE -> CHARGING directional reveal (~800ms pacing)...');
  await page.evaluate(() => {
    window.app.dashboard._renderLiveState({
      state: 'charging',
      abs_power_w: 1200,
      current_a: 22.5,
      voltage_v: 53.3,
      soc: 65,
      nominal_capacity_ah: 315,
      remaining_capacity_ah: 205,
      temperatures: { summary_c: 24.5, sensors: [] },
      cells: { count: 16, spread_mv: 8 }
    });
  });

  // Check mid-reveal (at ~350ms)
  await page.waitForTimeout(350);
  const midCharge = await page.evaluate(() => {
    const ef = window.app.dashboard.energyFlow;
    const stop3 = document.getElementById('flow-mask-stop-3');
    const stop4 = document.getElementById('flow-mask-stop-4');
    const baseRail = document.getElementById('flow-base-track');
    return {
      revealProgress: ef.revealProgress,
      revealActive: ef.revealActive,
      mainOpacity: ef.mainOpacity,
      stop3: stop3?.getAttribute('offset'),
      stop4Color: stop4?.getAttribute('stop-color'),
      baseRailVisible: baseRail && window.getComputedStyle(baseRail).display !== 'none'
    };
  });

  console.log(`   ℹ Mid-charge reveal at 350ms: progress=${midCharge.revealProgress.toFixed(2)}, mainOpacity=${midCharge.mainOpacity.toFixed(2)}, maskStop3=${midCharge.stop3}`);
  assert.ok(midCharge.revealProgress > 0.25 && midCharge.revealProgress < 0.85, 'Progress at 350ms reflects ~800ms reveal duration');
  assert.ok(parseFloat(midCharge.stop3) <= 47.5, 'Leading edge must be on charge side <= 47.5%');
  assert.strictEqual(midCharge.stop4Color, '#000000', 'Unrevealed region is masked');
  assert.ok(midCharge.baseRailVisible, 'Base rail remains visible during mid-charge reveal');

  // Wait for reveal completion (at 900ms total)
  await page.waitForTimeout(550);
  const fullCharge = await page.evaluate(() => {
    const ef = window.app.dashboard.energyFlow;
    return {
      revealProgress: ef.revealProgress,
      mainOpacity: ef.mainOpacity
    };
  });
  console.log(`   ℹ Full charge steady state: progress=${fullCharge.revealProgress.toFixed(2)}, mainOpacity=${fullCharge.mainOpacity.toFixed(2)}`);
  assert.strictEqual(fullCharge.revealProgress, 1.0, 'Reveal reaches 1.0 on completion');
  assert.ok(fullCharge.mainOpacity > 0.75, 'Steady-state active flow is fully bright');
  console.log('   ✅ CHARGING reveal & spin-up verified');

  // 3. CHARGING -> IDLE: Dissolves in place without reverse collapse
  console.log('🧪 3. Testing CHARGING -> IDLE in-place dissolve...');
  await page.evaluate(() => {
    window.app.dashboard._renderLiveState({ state: 'idle', abs_power_w: 0, current_a: 0, soc: 65 });
  });

  await page.waitForTimeout(250);
  const midFadeIdle = await page.evaluate(() => {
    const ef = window.app.dashboard.energyFlow;
    const stop2 = document.getElementById('flow-mask-stop-2');
    const baseRail = document.getElementById('flow-base-track');
    return {
      revealActive: ef.revealActive,
      revealState: ef.revealState,
      mainOpacity: ef.mainOpacity,
      stop2Offset: stop2?.getAttribute('offset'),
      baseRailVisible: baseRail && window.getComputedStyle(baseRail).display !== 'none'
    };
  });
  console.log(`   ℹ Mid-fade to idle at 250ms: mainOpacity=${midFadeIdle.mainOpacity.toFixed(2)}, maskStop2=${midFadeIdle.stop2Offset}`);
  assert.strictEqual(midFadeIdle.revealActive, false, 'revealActive is false on idle');
  assert.strictEqual(midFadeIdle.stop2Offset, '96.5%', 'Mask stays open during idle dissolve (no reverse retracting)');
  assert.ok(midFadeIdle.baseRailVisible, 'Base rail remains visible throughout dissolve');
  console.log('   ✅ CHARGING -> IDLE in-place dissolve verified');

  await page.waitForTimeout(600);

  // 4. IDLE -> DISCHARGING: Directional Reveal (~800ms)
  console.log('🧪 4. Testing IDLE -> DISCHARGING directional reveal (~800ms pacing)...');
  await page.evaluate(() => {
    window.app.dashboard._renderLiveState({
      state: 'discharging',
      abs_power_w: 84.1,
      current_a: -1.6,
      voltage_v: 53.2,
      soc: 98,
      nominal_capacity_ah: 315,
      remaining_capacity_ah: 308.7,
      temperatures: { summary_c: 24.5, sensors: [] },
      cells: { count: 16, spread_mv: 8 }
    });
  });

  // Check mid-reveal at 350ms
  await page.waitForTimeout(350);
  const midDischarge = await page.evaluate(() => {
    const ef = window.app.dashboard.energyFlow;
    const stop1 = document.getElementById('flow-mask-stop-1');
    const stop4 = document.getElementById('flow-mask-stop-4');
    const baseRail = document.getElementById('flow-base-track');
    return {
      revealProgress: ef.revealProgress,
      revealActive: ef.revealActive,
      mainOpacity: ef.mainOpacity,
      stop1: stop1?.getAttribute('offset'),
      stop4: stop4?.getAttribute('offset'),
      stop4Color: stop4?.getAttribute('stop-color'),
      baseRailVisible: baseRail && window.getComputedStyle(baseRail).display !== 'none'
    };
  });

  console.log(`   ℹ Mid-discharge reveal at 350ms: progress=${midDischarge.revealProgress.toFixed(2)}, mainOpacity=${midDischarge.mainOpacity.toFixed(2)}, maskStop4=${midDischarge.stop4}`);
  assert.ok(midDischarge.revealProgress > 0.25 && midDischarge.revealProgress < 0.85, 'Discharge progress reflects ~800ms pacing');
  assert.strictEqual(midDischarge.stop1, '52.5%', 'Starts from battery outlet at 52.5%');
  assert.ok(parseFloat(midDischarge.stop4) > 52.5, 'Wavefront progresses toward load');
  assert.ok(midDischarge.baseRailVisible, 'Base rail remains visible during discharge reveal');

  await page.waitForTimeout(550);
  const fullDischarge = await page.evaluate(() => {
    const ef = window.app.dashboard.energyFlow;
    return {
      revealProgress: ef.revealProgress,
      mainOpacity: ef.mainOpacity
    };
  });
  assert.strictEqual(fullDischarge.revealProgress, 1.0, 'Discharge reveal reaches 1.0');
  console.log('   ✅ DISCHARGING reveal & spin-up verified');

  // 5. Short Impulse Interruption: IDLE -> DISCHARGE -> IDLE -> DISCHARGE
  console.log('🧪 5. Testing short impulse interruptibility with base rail check...');
  await page.evaluate(() => {
    window.app.dashboard._renderLiveState({ state: 'idle', abs_power_w: 0, current_a: 0 });
  });
  await page.waitForTimeout(200);

  // Short pulse 1
  await page.evaluate(() => {
    window.app.dashboard._renderLiveState({ state: 'discharging', abs_power_w: 120, current_a: -2.3 });
  });
  await page.waitForTimeout(150);

  // Switch to Idle
  await page.evaluate(() => {
    window.app.dashboard._renderLiveState({ state: 'idle', abs_power_w: 0, current_a: 0 });
  });
  await page.waitForTimeout(100);

  // Re-activate Discharge
  await page.evaluate(() => {
    window.app.dashboard._renderLiveState({ state: 'discharging', abs_power_w: 150, current_a: -2.8 });
  });
  await page.waitForTimeout(700);

  const finalCheck = await page.evaluate(() => {
    const ef = window.app.dashboard.energyFlow;
    const baseRail = document.getElementById('flow-base-track');
    return {
      revealProgress: ef.revealProgress,
      mainOpacity: ef.mainOpacity,
      isAct: ef.animState.isActive,
      baseRailVisible: baseRail && window.getComputedStyle(baseRail).display !== 'none'
    };
  });
  assert.ok(finalCheck.mainOpacity > 0.7, 'Main opacity recovers smoothly without stalling');
  assert.ok(finalCheck.baseRailVisible, 'Base rail remains permanently visible throughout rapid pulses');
  console.log('   ✅ Short impulse transitions and base rail permanency verified');

  // 6. Capture Desktop Screenshot
  await page.screenshot({ path: `${ARTIFACT_DIR}/hero-directional-reveal.png`, fullPage: false });
  console.log('   📸 Screenshot saved: hero-directional-reveal.png');

  console.log('Errors logged:', errors);
  assert.strictEqual(errors.length, 0, 'Must have zero console errors');

  console.log('🎉 ALL Hero Directional Reveal & Base Rail tests PASSED!');
  await browser.close();
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
