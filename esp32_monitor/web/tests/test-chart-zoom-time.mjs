import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('zoom, pan and reset format the full category value, not the visible tick position', () => {
  const canvas = { getContext: () => ({}), addEventListener() {}, closest: () => null };
  class Chart {
    constructor(_ctx, config) { this.data = config.data; this.options = config.options; this.canvas = canvas; }
  }
  const window = { Chart };
  const context = { window, Chart };
  vm.runInNewContext(fs.readFileSync(new URL('../js/charts.js', import.meta.url), 'utf8'), context);
  const labels = Array.from({ length: 96 }, (_, i) => 1791800000000 + i * 600000);
  const chart = window.WattCharts.makeAreaChart(canvas, {
    datasets: [], labels, yAxisWidth: 40, xTickFormatter: value => new Date(value).toISOString(),
  });
  const callback = chart.options.scales.x.ticks.callback;
  const scale = { getLabelForValue: value => chart.data.labels[value] };
  for (const [from, to] of [[36, 55], [42, 61], [0, 95]]) {
    const visibleTicks = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    visibleTicks.forEach((value, visibleIndex) => {
      assert.equal(callback.call(scale, value, visibleIndex), new Date(labels[value]).toISOString());
    });
  }
});
