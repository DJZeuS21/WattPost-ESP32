import { createRequire } from 'module';
import assert from 'node:assert/strict';

const require = createRequire('/opt/node-v22/lib/node_modules/');
const { chromium } = require('playwright');
process.env.PLAYWRIGHT_BROWSERS_PATH = '/var/cache/ms-playwright';

const BASE_URL = 'http://127.0.0.1:8081/v16-alt/';

async function testHeroDirectionalEta() {
  console.log('🚀 Starting Hero Directional ETA Capsule & Amperage verification...');
  const browser = await chromium.launch({ headless: true });

  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.app?.dashboard?.liveData);

  // Stop background polling during deterministic state tests
  await page.evaluate(() => window.ApiClient?.stop());

  console.log('🧪 1. Testing IDLE state...');
  await page.evaluate(() => {
    const dash = window.app.dashboard;
    dash._renderLiveState({
      state: 'idle',
      abs_power_w: 0,
      power_w: 0,
      current_a: 0,
      voltage_v: 53.2,
      soc: 98,
      remaining_capacity_ah: 308.5,
      nominal_capacity_ah: 315.0,
      temperatures: { summary_c: 24.5, sensors: [] },
      cells: { count: 16, spread_mv: 8 }
    });
  });
  // Wait for collapse transition if needed
  await page.waitForTimeout(450);

  const idleState = await page.evaluate(() => {
    const root = document.getElementById('hero-directional-eta');
    const shape = document.getElementById('hero-eta-shape');
    const textEl = document.getElementById('hero-eta-text');
    const inCurr = document.getElementById('input-current');
    const outCurr = document.getElementById('output-current');
    return {
      color: root?.getAttribute('data-capsule-color'),
      phase: root?.getAttribute('data-capsule-phase'),
      isCollapsed: root?.classList.contains('collapsed'),
      isIdle: root?.classList.contains('is-idle'),
      text: textEl?.textContent?.trim(),
      shapeOpacity: shape ? window.getComputedStyle(shape).opacity : null,
      inCurrVisible: inCurr?.classList.contains('is-visible'),
      outCurrVisible: outCurr?.classList.contains('is-visible'),
      inCurrText: inCurr?.textContent?.trim(),
      outCurrText: outCurr?.textContent?.trim()
    };
  });

  assert.equal(idleState.color, 'neutral', 'Capsule color in IDLE must be neutral');
  assert.equal(idleState.phase, 'idle', 'Capsule phase in IDLE must be idle');
  assert.equal(idleState.isCollapsed, true, '#hero-directional-eta must have class .collapsed in IDLE');
  assert.equal(idleState.isIdle, true, '#hero-directional-eta must have class .is-idle in IDLE');
  assert.equal(idleState.shapeOpacity, '0', 'Shape opacity in IDLE must be 0 (completely invisible)');
  assert.equal(idleState.text, '', 'ETA text must be empty in IDLE');
  assert.equal(idleState.inCurrVisible, false, 'Input current must be hidden in IDLE');
  assert.equal(idleState.outCurrVisible, false, 'Output current must be hidden in IDLE');
  assert.equal(idleState.inCurrText, '', 'Input current text must be empty in IDLE');
  assert.equal(idleState.outCurrText, '', 'Output current text must be empty in IDLE');
  console.log('   ✅ IDLE state passed: completely invisible indicator (opacity 0), both currents hidden');

  console.log('🧪 2. Testing CHARGING state (unfold LEFT, green capsule, input amperage)...');
  await page.evaluate(() => {
    const dash = window.app.dashboard;
    dash._renderLiveState({
      state: 'charging',
      abs_power_w: 1064,
      power_w: 1064,
      current_a: 20.0,
      voltage_v: 53.2,
      soc: 63,
      remaining_capacity_ah: 200.0,
      nominal_capacity_ah: 315.0,
      temperatures: { summary_c: 24.5, sensors: [] },
      cells: { count: 16, spread_mv: 8 }
    });
  });
  await page.waitForFunction(() => document.getElementById('hero-directional-eta')?.getAttribute('data-capsule-phase') === 'open', { timeout: 3000 });
  await page.waitForTimeout(100);

  const chargeState = await page.evaluate(() => {
    const root = document.getElementById('hero-directional-eta');
    const textEl = document.getElementById('hero-eta-text');
    const inCurr = document.getElementById('input-current');
    const outCurr = document.getElementById('output-current');
    return {
      color: root?.getAttribute('data-capsule-color'),
      phase: root?.getAttribute('data-capsule-phase'),
      unfoldedLeft: root?.classList.contains('unfolded-left'),
      textVisible: root?.classList.contains('text-visible'),
      text: textEl?.textContent?.trim(),
      inCurrVisible: inCurr?.classList.contains('is-visible'),
      outCurrVisible: outCurr?.classList.contains('is-visible'),
      inCurrText: inCurr?.textContent?.trim(),
      outCurrText: outCurr?.textContent?.trim()
    };
  });

  assert.equal(chargeState.color, 'charge', 'Capsule color must be charge');
  assert.equal(chargeState.phase, 'open', 'Capsule phase must be open');
  assert.equal(chargeState.unfoldedLeft, true, '#hero-directional-eta must have class .unfolded-left');
  assert.equal(chargeState.textVisible, true, 'Text must be visible in unfolded capsule');
  assert.equal(chargeState.text, '≈ 5 год 45 хв', 'ETA text must show calculated charge ETA');
  assert.equal(chargeState.inCurrVisible, true, 'Input current must be visible during charging');
  assert.equal(chargeState.inCurrText, '20.0 A', 'Input current must show 20.0 A');
  assert.equal(chargeState.outCurrVisible, false, 'Output current must be hidden during charging');
  assert.equal(chargeState.outCurrText, '', 'Output current text must be empty during charging');
  console.log('   ✅ CHARGING state passed: green capsule unfolded left with ETA, input current visible');

  console.log('🧪 3. Testing DISCHARGING state (unfold RIGHT, purple capsule, output amperage)...');
  await page.evaluate(() => {
    const dash = window.app.dashboard;
    dash._renderLiveState({
      state: 'discharging',
      abs_power_w: 84.1,
      power_w: -84.1,
      current_a: -1.58,
      voltage_v: 53.2,
      soc: 98,
      remaining_capacity_ah: 308.5,
      nominal_capacity_ah: 315.0,
      temperatures: { summary_c: 24.5, sensors: [] },
      cells: { count: 16, spread_mv: 8 }
    });
  });
  // Reversal transition takes 280ms collapse + 140ms center + 280ms unfold = ~700ms (wait deterministically for open phase)
  await page.waitForFunction(() => document.getElementById('hero-directional-eta')?.getAttribute('data-capsule-phase') === 'open', { timeout: 3000 });

  const dischargeState = await page.evaluate(() => {
    const root = document.getElementById('hero-directional-eta');
    const textEl = document.getElementById('hero-eta-text');
    const inCurr = document.getElementById('input-current');
    const outCurr = document.getElementById('output-current');
    return {
      color: root?.getAttribute('data-capsule-color'),
      phase: root?.getAttribute('data-capsule-phase'),
      unfoldedRight: root?.classList.contains('unfolded-right'),
      textVisible: root?.classList.contains('text-visible'),
      text: textEl?.textContent?.trim(),
      inCurrVisible: inCurr?.classList.contains('is-visible'),
      outCurrVisible: outCurr?.classList.contains('is-visible'),
      inCurrText: inCurr?.textContent?.trim(),
      outCurrText: outCurr?.textContent?.trim()
    };
  });

  assert.equal(dischargeState.color, 'discharge', 'Capsule color must be discharge');
  assert.equal(dischargeState.phase, 'open', 'Capsule phase must be open');
  assert.equal(dischargeState.unfoldedRight, true, '#hero-directional-eta must have class .unfolded-right');
  assert.equal(dischargeState.textVisible, true, 'Text must be visible');
  assert.equal(dischargeState.text, '≈ 8 д 3 год', 'ETA text must show calculated discharge ETA');
  assert.equal(dischargeState.outCurrVisible, true, 'Output current must be visible during discharging');
  assert.equal(dischargeState.outCurrText, '1.6 A', 'Output current must show magnitude without sign: 1.6 A');
  assert.equal(dischargeState.inCurrVisible, false, 'Input current must be hidden during discharging');
  assert.equal(dischargeState.inCurrText, '', 'Input current text must be empty during discharging');
  console.log('   ✅ DISCHARGING state passed: purple capsule unfolded right with ETA, output current visible (magnitude)');

  console.log('🧪 4. Testing silent in-place ETA & amperage update (same active state)...');
  await page.evaluate(() => {
    const dash = window.app.dashboard;
    // Discharging continues with slightly different current/capacity
    dash._renderLiveState({
      state: 'discharging',
      abs_power_w: 120,
      power_w: -120,
      current_a: -2.25,
      voltage_v: 53.0,
      soc: 90,
      remaining_capacity_ah: 280.0,
      nominal_capacity_ah: 315.0,
      temperatures: { summary_c: 24.5, sensors: [] },
      cells: { count: 16, spread_mv: 8 }
    });
  });
  await page.waitForTimeout(50);

  const silentUpdateState = await page.evaluate(() => {
    const root = document.getElementById('hero-directional-eta');
    const textEl = document.getElementById('hero-eta-text');
    const outCurr = document.getElementById('output-current');
    return {
      phase: root?.getAttribute('data-capsule-phase'),
      unfoldedRight: root?.classList.contains('unfolded-right'),
      text: textEl?.textContent?.trim(),
      outCurrText: outCurr?.textContent?.trim()
    };
  });

  assert.equal(silentUpdateState.phase, 'open', 'Phase must remain open without collapsing');
  assert.equal(silentUpdateState.unfoldedRight, true, 'Capsule must remain unfolded right');
  assert.equal(silentUpdateState.outCurrText, '2.3 A', 'Amperage must update silently to 2.3 A');
  console.log('   ✅ Silent in-place update passed: text updated with zero animation restart');

  console.log('🧪 5. Testing ACTIVE -> IDLE color preservation during collapse...');
  await page.evaluate(() => {
    const dash = window.app.dashboard;
    dash._renderLiveState({
      state: 'idle',
      abs_power_w: 0,
      power_w: 0,
      current_a: 0,
      soc: 90
    });
  });
  // Check midway through collapse (~100ms)
  await page.waitForTimeout(100);
  const midCollapse = await page.evaluate(() => {
    const root = document.getElementById('hero-directional-eta');
    return {
      color: root?.getAttribute('data-capsule-color'),
      phase: root?.getAttribute('data-capsule-phase'),
      isCollapsed: root?.classList.contains('collapsed')
    };
  });
  assert.equal(midCollapse.color, 'discharge', 'Color must remain active during collapse');
  assert.equal(midCollapse.phase, 'collapsing', 'Phase must be collapsing');

  // After collapse and dispersion complete, wait deterministically for phase to settle to idle
  await page.waitForFunction(() => document.getElementById('hero-directional-eta')?.getAttribute('data-capsule-phase') === 'idle', { timeout: 3000 });
  const postCollapse = await page.evaluate(() => {
    const root = document.getElementById('hero-directional-eta');
    return {
      color: root?.getAttribute('data-capsule-color'),
      phase: root?.getAttribute('data-capsule-phase')
    };
  });
  assert.equal(postCollapse.color, 'neutral', 'Color must become neutral only after collapse completes');
  assert.equal(postCollapse.phase, 'idle', 'Phase must settle to idle');
  console.log('   ✅ Color handoff to IDLE passed: preserved color during collapse, neutral after finish');

  console.log('🧪 6. Testing fully charged state: replaces "≈ 0 хв" with "Заряджено" without "≈"...');
  await page.evaluate(() => {
    const dash = window.app.dashboard;
    dash._renderLiveState({
      state: 'charging',
      abs_power_w: 120,
      power_w: 120,
      current_a: 2.25,
      voltage_v: 54.0,
      soc: 100,
      remaining_capacity_ah: 315.0,
      nominal_capacity_ah: 315.0,
      temperatures: { summary_c: 24.5, sensors: [] },
      cells: { count: 16, spread_mv: 5 }
    });
  });
  await page.waitForFunction(() => document.getElementById('hero-directional-eta')?.getAttribute('data-capsule-phase') === 'open', { timeout: 3000 });

  const fullChargeState = await page.evaluate(() => {
    const root = document.getElementById('hero-directional-eta');
    const textEl = document.getElementById('hero-eta-text');
    return {
      color: root?.getAttribute('data-capsule-color'),
      phase: root?.getAttribute('data-capsule-phase'),
      textVisible: root?.classList.contains('text-visible'),
      text: textEl?.textContent?.trim()
    };
  });
  assert.equal(fullChargeState.color, 'charge');
  assert.equal(fullChargeState.phase, 'open');
  assert.equal(fullChargeState.textVisible, true);
  assert.equal(fullChargeState.text, 'Заряджено', 'Must display "Заряджено" instead of "≈ 0 хв"');
  assert.ok(!fullChargeState.text.includes('≈'), 'Must not contain "≈" symbol');
  console.log('   ✅ Fully charged direct state passed: displays "Заряджено" without "≈"');

  // Test silent live update to "Заряджено" from near-full charging
  await page.evaluate(() => {
    const dash = window.app.dashboard;
    dash._renderLiveState({
      state: 'charging',
      abs_power_w: 500,
      power_w: 500,
      current_a: 10.0,
      voltage_v: 53.5,
      soc: 98,
      remaining_capacity_ah: 310.0,
      nominal_capacity_ah: 315.0,
      temperatures: { summary_c: 24.5, sensors: [] },
      cells: { count: 16, spread_mv: 6 }
    });
  });
  await page.waitForTimeout(50);
  const midState = await page.evaluate(() => document.getElementById('hero-eta-text')?.textContent?.trim());
  assert.ok(midState.includes('хв'), `midState should show ETA in minutes, got "${midState}"`);

  // Now live update hits 100% full
  await page.evaluate(() => {
    const dash = window.app.dashboard;
    dash._renderLiveState({
      state: 'charging',
      abs_power_w: 50,
      power_w: 50,
      current_a: 1.0,
      voltage_v: 54.0,
      soc: 100,
      remaining_capacity_ah: 315.0,
      nominal_capacity_ah: 315.0,
      temperatures: { summary_c: 24.5, sensors: [] },
      cells: { count: 16, spread_mv: 5 }
    });
  });
  await page.waitForTimeout(50);

  const silentFullState = await page.evaluate(() => {
    const root = document.getElementById('hero-directional-eta');
    const textEl = document.getElementById('hero-eta-text');
    return {
      phase: root?.getAttribute('data-capsule-phase'),
      text: textEl?.textContent?.trim()
    };
  });
  assert.equal(silentFullState.phase, 'open', 'Phase must remain open without restarting animation');
  assert.equal(silentFullState.text, 'Заряджено', 'Text must silently update to "Заряджено"');
  console.log('   ✅ Silent in-place transition to "Заряджено" passed: zero animation restart');

  assert.equal(errors.length, 0, `Expected 0 console/runtime errors, got: ${errors.join('; ')}`);
  console.log('🎉 ALL test-hero-secondary-line tests PASSED cleanly!');
  await browser.close();
}

testHeroDirectionalEta().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
