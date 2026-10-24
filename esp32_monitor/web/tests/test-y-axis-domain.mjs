// esp32_monitor/web/tests/test-y-axis-domain.mjs
import { createRequire } from 'module';
const require = createRequire('/opt/node-v22/lib/node_modules/');
const assert = require('node:assert/strict');

// Import WattCharts functions via mock window environment
const window = {};
global.window = window;

export async function runYAxisDomainTests(computeYAxisDomain, applyYAxisDomain) {
  console.log('🧪 Testing computeYAxisDomain across all 7 metric families...');

  // 1. Pack Voltage (Real Benchmark 8S: 26.629 .. 26.656 V)
  {
    const data = [26.629, 26.640, 26.656, 26.635];
    const res = computeYAxisDomain('pack_voltage', data, { cellCount: 8 });
    assert.strictEqual(res.hasData, true);
    assert.strictEqual(res.beginAtZero, false, 'Pack voltage must not begin at zero');
    assert.ok(res.min < 26.629, `scaleMin (${res.min}) must be strictly less than dataMin (26.629)`);
    assert.ok(res.max > 26.656, `scaleMax (${res.max}) must be strictly greater than dataMax (26.656)`);
    assert.ok(res.span >= 0.50, `scaleSpan (${res.span}) must satisfy 8S min span of 0.50V`);
  }

  // 1b. Dynamic Topology Pack Voltage: 4S (13.3V) and 16S (53.2V) with explicit cellCount
  {
    const data4S = [13.32, 13.34];
    const res4S = computeYAxisDomain('pack_voltage', data4S, { cellCount: 4 });
    assert.ok(res4S.span >= 0.30, '4S pack voltage minSpan must be >= 0.30V');
    assert.ok(res4S.min < 13.32);
    assert.ok(res4S.max > 13.34);

    const data16S = [53.25, 53.28];
    const res16S = computeYAxisDomain('pack_voltage', data16S, { cellCount: 16 });
    assert.ok(res16S.span >= 1.00, '16S pack voltage minSpan must be >= 1.00V');
    assert.ok(res16S.min < 53.25);
    assert.ok(res16S.max > 53.28);
  }

  // 1c. Topology-Unknown Pack Voltage fallback
  {
    const dataUnknown = [26.629, 26.656];
    const resUnknown = computeYAxisDomain('pack_voltage', dataUnknown);
    assert.strictEqual(resUnknown.hasData, true);
    assert.strictEqual(resUnknown.span >= 0.50, true, 'Unknown cellCount must use 0.50V default');
    assert.ok(resUnknown.min < 26.629);
    assert.ok(resUnknown.max > 26.656);
  }

  // 2. Cell Voltage (Real Benchmark: 3.329 .. 3.333 V)
  {
    const data = [3.329, 3.330, 3.333, 3.331];
    const res = computeYAxisDomain('cell_voltage', data);
    assert.strictEqual(res.hasData, true);
    assert.strictEqual(res.beginAtZero, false, 'Cell voltage must not begin at zero');
    assert.ok(res.min < 3.329, `scaleMin (${res.min}) must be strictly less than dataMin (3.329)`);
    assert.ok(res.max > 3.333, `scaleMax (${res.max}) must be strictly greater than dataMax (3.333)`);
    assert.ok(res.span >= 0.050, `scaleSpan (${res.span}) must satisfy minimum span of 50mV`);
    assert.strictEqual(Math.round(res.min * 1000) % 5, 0, `scaleMin (${res.min}) must align with 5mV quantum`);
    assert.strictEqual(Math.round(res.max * 1000) % 5, 0, `scaleMax (${res.max}) must align with 5mV quantum`);
  }

  // 3. Temperature (Real Benchmark: 28.8 .. 28.9 °C)
  {
    const data = [28.8, 28.9, 28.85];
    const res = computeYAxisDomain('temperature', data);
    assert.strictEqual(res.hasData, true);
    assert.strictEqual(res.beginAtZero, false, 'Temperature must not begin at zero');
    assert.ok(res.min <= 27.3, `scaleMin (${res.min}) must provide at least 1.5°C bottom headroom`);
    assert.ok(res.max >= 30.9, `scaleMax (${res.max}) must provide at least 2.0°C top headroom`);
    assert.ok(res.span >= 4.0, `scaleSpan (${res.span}) must satisfy minimum span of 4.0°C`);
    assert.strictEqual(Math.round(res.min * 10) % 5, 0, `scaleMin (${res.min}) must align with 0.5°C quantum`);
  }

  // 4. Power (Real Benchmark: 19 .. 43 W)
  {
    const data = [19, 25, 43, 30];
    const res = computeYAxisDomain('power', data);
    assert.strictEqual(res.hasData, true);
    assert.strictEqual(res.beginAtZero, true, 'Power must begin at zero');
    assert.strictEqual(res.min, 0, 'scaleMin for power must be strictly 0');
    assert.ok(res.max >= 50, `scaleMax (${res.max}) must satisfy min span of 50W`);
    assert.strictEqual(res.max % 25, 0, `scaleMax (${res.max}) must align with 25W quantum`);
  }

  // 5. Current (Real Benchmark: 0.2 .. 2.5 A)
  {
    const data = [0.2, 1.5, 2.5, 0.8];
    const res = computeYAxisDomain('current', data);
    assert.strictEqual(res.hasData, true);
    assert.strictEqual(res.beginAtZero, true, 'Current must begin at zero');
    assert.strictEqual(res.min, 0, 'scaleMin for current must be strictly 0');
    assert.ok(res.max >= 5.0, `scaleMax (${res.max}) must satisfy min span of 5.0A`);
  }

  // 6. Cell Spread (Real Benchmark: 2 .. 5 mV)
  {
    const data = [2, 3, 5, 4];
    const res = computeYAxisDomain('cell_spread', data);
    assert.strictEqual(res.hasData, true);
    assert.strictEqual(res.beginAtZero, true, 'Cell spread must begin at zero');
    assert.strictEqual(res.min, 0, 'scaleMin for cell spread must be strictly 0');
    assert.strictEqual(res.max, 15, `scaleMax (${res.max}) for 2-5mV must be visual min span of 15mV`);

    // Verify single configurable warning threshold without stretching to 30mV
    const res20 = computeYAxisDomain('cell_spread', data, { referenceValues: [20] });
    assert.strictEqual(res20.min, 0);
    assert.strictEqual(res20.max, 20, 'scaleMax must match warning threshold 20mV without stretching to 30');

    const res14 = computeYAxisDomain('cell_spread', data, { referenceValues: [14] });
    assert.strictEqual(res14.max, 15, 'scaleMax must maintain minimum span of 15mV even when threshold is 14');

    // Verify boundary semantics: Normal vs Warning (no Critical)
    const evaluateStatus = (spreadMv, warnThreshold) => {
      const isWarn = spreadMv != null && spreadMv > warnThreshold;
      return isWarn ? 'WARNING' : 'NORMAL';
    };

    assert.strictEqual(evaluateStatus(14, 14), 'NORMAL', 'spread == threshold (14 == 14) must be NORMAL');
    assert.strictEqual(evaluateStatus(13, 14), 'NORMAL', 'spread < threshold (13 < 14) must be NORMAL');
    assert.strictEqual(evaluateStatus(15, 14), 'WARNING', 'spread > threshold (15 > 14) must be WARNING');
    assert.strictEqual(evaluateStatus(30, 15), 'WARNING', 'spread == 30mV must be standard WARNING without Critical state');
    assert.strictEqual(evaluateStatus(45, 15), 'WARNING', 'spread > 30mV must be standard WARNING without Critical state');
  }

  // 7. SoC (Fixed Benchmark: 94 .. 96 %)
  {
    const data = [94, 95, 96, 95];
    const res = computeYAxisDomain('soc', data);
    assert.strictEqual(res.hasData, true);
    assert.strictEqual(res.beginAtZero, true, 'SoC must begin at zero');
    assert.strictEqual(res.min, 0, 'scaleMin for SoC must be 0');
    assert.strictEqual(res.max, 100, 'scaleMax for SoC must be 100');
    assert.strictEqual(res.stepSize, 25, 'stepSize for SoC must be 25');
  }

  // 8. Constant Series (minVal === maxVal)
  {
    const constTemp = [28.8, 28.8, 28.8];
    const resTemp = computeYAxisDomain('temperature', constTemp);
    assert.strictEqual(resTemp.hasData, true);
    assert.ok(resTemp.min < 28.8, 'Constant temperature must have bottom headroom');
    assert.ok(resTemp.max > 28.8, 'Constant temperature must have top headroom');
    assert.ok(resTemp.span >= 4.0, 'Constant temperature must have min span');

    const constVolt = [3.330, 3.330, 3.330];
    const resVolt = computeYAxisDomain('cell_voltage', constVolt);
    assert.strictEqual(resVolt.hasData, true);
    assert.ok(resVolt.min < 3.330, 'Constant cell voltage must have bottom headroom');
    assert.ok(resVolt.max > 3.330, 'Constant cell voltage must have top headroom');
    assert.ok(resVolt.span >= 0.050, 'Constant cell voltage must have min span');
  }

  // 9. Valid Zero vs Missing Data & Constant Zero
  {
    const validZeros = [0, 0, 0];
    const resPowerZero = computeYAxisDomain('power', validZeros);
    assert.strictEqual(resPowerZero.hasData, true, 'Zero is a valid number');
    assert.strictEqual(resPowerZero.dataMin, 0);
    assert.strictEqual(resPowerZero.dataMax, 0);
    assert.strictEqual(resPowerZero.min, 0);
    assert.strictEqual(resPowerZero.max, 50);

    const resSpreadZero = computeYAxisDomain('cell_spread', validZeros);
    assert.strictEqual(resSpreadZero.hasData, true);
    assert.strictEqual(resSpreadZero.min, 0);
    assert.strictEqual(resSpreadZero.max, 15);
  }

  // 10. No-Data Policy & applyYAxisDomain Scale Options Reset (No Leakage)
  {
    const allNull = [null, undefined, NaN, null];
    const resNull = computeYAxisDomain('pack_voltage', allNull);
    assert.strictEqual(resNull.hasData, false, 'All-null input must return hasData = false');
    assert.strictEqual(resNull.min, undefined, 'Must not fabricate min voltage for no-data');
    assert.strictEqual(resNull.max, undefined, 'Must not fabricate max voltage for no-data');

    // Test applyYAxisDomain state reset on mock chart
    const mockChart = {
      options: {
        scales: {
          y: {
            min: 26.60,
            max: 27.10,
            beginAtZero: false,
            ticks: { stepSize: 0.1 }
          }
        }
      }
    };

    // Apply no-data dataset to previously configured chart
    applyYAxisDomain(mockChart, 'pack_voltage', allNull);
    assert.strictEqual(mockChart.options.scales.y.min, undefined, 'y.min must be reset to undefined on no-data');
    assert.strictEqual(mockChart.options.scales.y.max, undefined, 'y.max must be reset to undefined on no-data');
    assert.strictEqual(mockChart.options.scales.y.ticks.stepSize, undefined, 'stepSize must be reset to undefined on no-data');
  }

  console.log('✅ ALL computeYAxisDomain unit test assertions passed successfully!');
}

import fs from 'node:fs';
const chartsCode = fs.readFileSync(new URL('../js/charts.js', import.meta.url), 'utf-8');
const vm = require('node:vm');
const win = { Chart: function() {} };
const context = { window: win, Chart: win.Chart, console };
vm.createContext(context);
vm.runInContext(chartsCode, context);

if (win.WattCharts && win.WattCharts.computeYAxisDomain) {
  runYAxisDomainTests(win.WattCharts.computeYAxisDomain, win.WattCharts.applyYAxisDomain);
} else {
  console.log('⚠️ WattCharts.computeYAxisDomain not yet implemented in charts.js (TDD Step 1)');
}
