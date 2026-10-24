import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const normalizer = createRequire(import.meta.url)('../js/data-normalizer.js');

function viewHarness() {
  const elements = new Map();
  const document = { getElementById: id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', style: {} });
    return elements.get(id);
  } };
  const window = { DataNormalizer: normalizer, WattCharts: {} };
  vm.runInNewContext(fs.readFileSync(new URL('../js/history.js', import.meta.url), 'utf8'), { window, document });
  return { view: new window.HistoryView(), elements };
}

test('empty and one-point summaries distinguish absent energy from measured SOC', () => {
  const { view, elements } = viewHarness();
  view.filteredHistory = []; view._refreshSummary(); view._refreshModeSplit();
  assert.equal(elements.get('summary-energy-in').textContent, '—');
  assert.equal(elements.get('summary-soc-range').textContent, '—');
  assert.ok(!elements.get('mode-list').innerHTML.includes('100%'));
  view.filteredHistory = [{ t: 100, v: 26, a: 0, s: 82 }]; view._refreshSummary();
  assert.equal(elements.get('summary-energy-in').textContent, '—');
  assert.equal(elements.get('summary-soc-range').textContent, '82 – 82');
});

test('two measured idle samples produce real zero energy and 100% idle', () => {
  const { view, elements } = viewHarness();
  view.filteredHistory = [{ t: 100, v: 26, a: 0, s: 82, mode: 'idle' }, { t: 700, v: 26, a: 0, s: 82, mode: 'idle' }];
  view._refreshSummary(); view._refreshModeSplit();
  assert.equal(elements.get('summary-energy-in').textContent, '0.0');
  assert.match(elements.get('mode-list').innerHTML, /100%/);
  assert.equal(normalizer.energyStats(view.filteredHistory, 'charging').validIntervals, 1);
  view.filteredHistory = [{ t: 100, v: 26, a: 0 }, { t: 2000, v: 26, a: 0 }];
  view._refreshSummary();
  assert.equal(elements.get('summary-energy-in').textContent, '—');
});
