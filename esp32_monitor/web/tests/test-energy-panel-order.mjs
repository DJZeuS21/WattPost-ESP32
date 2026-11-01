import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// Order of complete sibling sections is shared by ESP32 and Cloud Device UI.
test('Dashboard shows Discharging before Charging without changing panel bindings', () => {
  const panels = [...html.matchAll(/<section class="energy-panel ([a-z-]+)" id="([a-z-]+)">([\s\S]*?)<\/section>/g)];
  assert.deepEqual(panels.slice(0, 2).map(p => p[2]), ['discharging-panel', 'charging-panel']);
  const [discharge, charge] = panels.map(p => p[3]);
  for (const id of ['discharge-energy', 'discharge-avg', 'discharge-peak', 'discharge-time', 'discharge-yesterday', 'discharge-chart']) {
    assert.match(discharge, new RegExp(`id="${id}"`));
    assert.doesNotMatch(charge, new RegExp(`id="${id}"`));
  }
  for (const id of ['charge-energy', 'charge-avg', 'charge-peak', 'charge-time', 'charge-yesterday', 'charge-chart']) {
    assert.match(charge, new RegExp(`id="${id}"`));
    assert.doesNotMatch(discharge, new RegExp(`id="${id}"`));
  }
  assert.match(discharge, /data-chart="discharge"/);
  assert.match(charge, /data-chart="charge"/);
  assert.match(discharge, /data-i18n="battery\.discharging"/);
  assert.match(charge, /data-i18n="battery\.charging"/);
});
