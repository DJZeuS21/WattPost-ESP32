import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// Extract formatEta from dashboard.js
const dashboardCode = readFileSync(new URL('../js/dashboard.js', import.meta.url), 'utf-8');
const sandbox = {
  window: {},
  document: {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
  },
  BatteryColors: { getSocColors: () => ({}), getCellRelativeColors: () => ({}) },
  EnergyFlow: class {},
  WattCharts: { updateChartPreservingZoom: () => {}, hideTooltip: () => {}, dismissPinnedChart: () => {} },
  STATE_COLORS: {
    charging: { label: 'Заряджання', primary: '#56d364', bg: 'rgba(86,211,100,0.06)', glow: 'rgba(86,211,100,0.45)' },
    discharging: { label: 'Розряджання', primary: '#9d8dff', bg: 'rgba(157,141,255,0.06)', glow: 'rgba(157,141,255,0.45)' },
    idle: { label: 'Очікування', primary: '#8b949e', bg: 'rgba(139,148,158,0.04)', glow: 'rgba(139,148,158,0.15)' }
  }
};
sandbox.window.BatteryColors = sandbox.BatteryColors;
sandbox.window.EnergyFlow = sandbox.EnergyFlow;
sandbox.window.WattCharts = sandbox.WattCharts;
sandbox.window.STATE_COLORS = sandbox.STATE_COLORS;
sandbox.global = sandbox.window;
createContext(sandbox);
runInContext(dashboardCode, sandbox);

const formatEta = sandbox.window.formatEta;
const computeDirectionalEta = sandbox.window.computeDirectionalEta;

test('formatEta handles sub-hour values correctly in minutes', () => {
  assert.equal(formatEta(0), '0 хв');
  assert.equal(formatEta(15 / 60), '15 хв');
  assert.equal(formatEta(47 / 60), '47 хв');
  assert.equal(formatEta(59 / 60), '59 хв');
});

test('formatEta handles sub-day values in hours and minutes', () => {
  assert.equal(formatEta(1.0), '1 год');
  assert.equal(formatEta(2.25), '2 год 15 хв');
  assert.equal(formatEta(5.75), '5 год 45 хв');
  assert.equal(formatEta(23.5), '23 год 30 хв');
});

test('formatEta handles multi-day values in days and hours', () => {
  assert.equal(formatEta(24.0), '1 д');
  assert.equal(formatEta(27.0), '1 д 3 год');
  assert.equal(formatEta(175.0), '7 д 7 год');
  assert.equal(formatEta(291.0), '12 д 3 год');
});

test('formatEta handles prompt sample: 308.5 Ah / 1.58 A discharge', () => {
  const hours = 308.5 / 1.58; // 195.253 h -> 8 days 3.25h -> 8 д 3 год
  assert.equal(formatEta(hours), '8 д 3 год');
});

test('formatEta rejects invalid or negative inputs', () => {
  assert.equal(formatEta(-1), null);
  assert.equal(formatEta(Infinity), null);
  assert.equal(formatEta(NaN), null);
  assert.equal(formatEta(null), null);
  assert.equal(formatEta(undefined), null);
});

test('computeDirectionalEta handles fully charged scenarios with "Заряджено"', () => {
  // 1. 100% SoC while charging
  assert.equal(
    computeDirectionalEta('charging', { soc: 100, remaining_capacity_ah: 315, nominal_capacity_ah: 315 }, 5.0),
    'Заряджено'
  );

  // 2. remaining_capacity_ah >= nominal_capacity_ah
  assert.equal(
    computeDirectionalEta('charging', { soc: 99.9, remaining_capacity_ah: 315, nominal_capacity_ah: 315 }, 10.0),
    'Заряджено'
  );

  // 3. neededAh calculates to 0 minutes remaining (< 0.5 min / 30s)
  assert.equal(
    computeDirectionalEta('charging', { soc: 99.8, remaining_capacity_ah: 314.98, nominal_capacity_ah: 315 }, 10.0),
    'Заряджено'
  );

  // 4. 100% SoC even if current has tapered down below 0.05 A
  assert.equal(
    computeDirectionalEta('charging', { soc: 100, remaining_capacity_ah: 315, nominal_capacity_ah: 315 }, 0.02),
    'Заряджено'
  );
});

test('computeDirectionalEta retains standard ETA formatting for normal charging', () => {
  // 63% SoC, 115 Ah needed at 20A -> 5.75 h -> "≈ 5 год 45 хв"
  assert.equal(
    computeDirectionalEta('charging', { soc: 63, remaining_capacity_ah: 200, nominal_capacity_ah: 315 }, 20.0),
    '≈ 5 год 45 хв'
  );

  // 15 mins remaining
  assert.equal(
    computeDirectionalEta('charging', { soc: 98, remaining_capacity_ah: 310, nominal_capacity_ah: 315 }, 20.0),
    '≈ 15 хв'
  );
});

test('computeDirectionalEta preserves discharging ETA untouched', () => {
  // Discharging 308.5 Ah at 1.58A -> "≈ 8 д 3 год"
  assert.equal(
    computeDirectionalEta('discharging', { soc: 98, remaining_capacity_ah: 308.5, nominal_capacity_ah: 315 }, 1.58),
    '≈ 8 д 3 год'
  );
});

test('computeDirectionalEta returns empty string for IDLE state', () => {
  assert.equal(
    computeDirectionalEta('idle', { soc: 100, remaining_capacity_ah: 315, nominal_capacity_ah: 315 }, 0),
    ''
  );
});
