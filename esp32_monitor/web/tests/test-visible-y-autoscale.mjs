import test from 'node:test';
import assert from 'node:assert/strict';

// Mock minimal browser environment
global.window = global;
global.Chart = { register: () => {} };

await import('../js/charts.js');

test('getVisibleDataSlice extracts correct subarray within bounds', () => {
  const { getVisibleDataSlice } = global.WattCharts;
  const data = [10, 20, 30, 40, 50, 60];
  assert.deepEqual(getVisibleDataSlice(data, 1.2, 3.8), [20, 30, 40, 50]);
  assert.deepEqual(getVisibleDataSlice(data, -5, 1), [10, 20]);
  assert.deepEqual(getVisibleDataSlice(data, 4, 10), [50, 60]);
});

test('remapZoomTimestampsToIndices finds nearest indices with first >= start / last <= end or signals full reset', () => {
  const { remapZoomTimestampsToIndices } = global.WattCharts;
  // Timestamps in milliseconds (seconds: 100, 200, 300, 400, 500)
  const timestamps = [100000, 200000, 300000, 400000, 500000];

  // 1. Valid overlapping window (250s -> 450s):
  // First timestamp >= 250s is 300s (index 2); last timestamp <= 450s is 400s (index 3).
  const res1 = remapZoomTimestampsToIndices(timestamps, 250, 450);
  assert.equal(res1.valid, true);
  assert.equal(res1.minIdx, 2);
  assert.equal(res1.maxIdx, 3);

  // 2. Window completely outside dataset -> valid: false (trigger AUTO fallback)
  const res2 = remapZoomTimestampsToIndices(timestamps, 10, 50);
  assert.equal(res2.valid, false);

  // 3. Window after dataset -> valid: false
  const res3 = remapZoomTimestampsToIndices(timestamps, 600, 700);
  assert.equal(res3.valid, false);
});

test('applyVisibleYAxisDomain uses stored _wattDomainContext and autoscale temperature', () => {
  const { computeYAxisDomain, getVisibleDataSlice } = global.WattCharts;
  const temps = [22.0, 22.1, 22.2, 28.5, 29.0, 28.8, 22.0, 22.1];
  const visible = getVisibleDataSlice(temps, 3, 5);
  const domain = computeYAxisDomain('temperature', visible, { minSpan: 4.0 });

  assert.equal(domain.hasData, true);
  assert.ok(domain.min >= 26.5 && domain.min <= 27.5);
  assert.ok(domain.max >= 30.5 && domain.max <= 31.5);
  assert.equal(domain.beginAtZero, false);
});

test('applyVisibleYAxisDomain preserves reference warning threshold for cell_spread', () => {
  const { computeYAxisDomain, getVisibleDataSlice } = global.WattCharts;
  const spreadData = [4, 6, 8, 9, 7];
  const visible = getVisibleDataSlice(spreadData, 1, 3);
  // Single warning threshold (e.g. 20mV) must be respected without stretching to 30mV
  const domain20 = computeYAxisDomain('cell_spread', visible, { referenceValues: [20] });
  assert.equal(domain20.min, 0);
  assert.equal(domain20.max, 20);
  assert.equal(domain20.beginAtZero, true);

  // Default warning threshold (15mV) with lower data [6, 8, 9] (max=9, 9*1.25=11.25 -> 15 minSpan)
  const domain15 = computeYAxisDomain('cell_spread', visible, { referenceValues: [15] });
  assert.equal(domain15.min, 0);
  assert.equal(domain15.max, 15);
  assert.equal(domain15.beginAtZero, true);
});

test('applyVisibleYAxisDomain keeps SOC fixed at 0..100 with stepSize 25', () => {
  const { computeYAxisDomain, getVisibleDataSlice } = global.WattCharts;
  const socData = [45, 50, 55];
  const visible = getVisibleDataSlice(socData, 0, 2);
  const domain = computeYAxisDomain('soc', visible);

  assert.equal(domain.min, 0);
  assert.equal(domain.max, 100);
  assert.equal(domain.stepSize, 25);
  assert.equal(domain.beginAtZero, true);
});
