import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'js', 'device-settings.js'),
  'utf8',
);
const CSS = fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8');

test('Device Settings routes physical BMS actions through centralized ApiClient', () => {
  for (const method of [
    'startBmsScan',
    'waitForBmsOperation',
    'selectBms',
    'reconnectBms',
    'forgetBms',
    'fetchDeviceStatus',
  ]) {
    assert.match(SOURCE, new RegExp(`global\\.ApiClient\\.${method}`));
  }
  assert.equal(/\bfetch\s*\(/.test(SOURCE), false);
});

test('BMS candidates render only safe fields with textContent', () => {
  const start = SOURCE.indexOf('_renderBmsCandidates(candidates)');
  const end = SOURCE.indexOf('async _selectBms()', start);
  const render = SOURCE.slice(start, end);
  assert.match(render, /candidate\.name/);
  assert.match(render, /candidate\.address_hint/);
  assert.match(render, /candidate\.rssi_dbm/);
  assert.match(render, /title\.textContent/);
  assert.match(render, /meta\.textContent/);
  assert.equal(render.includes('.innerHTML'), false);
  assert.equal(/candidate\.mac/i.test(render), false);
  assert.equal(/candidate\.address(?!_hint)/.test(render), false);
});

test('changing a configured BMS requires explicit confirmation', () => {
  const start = SOURCE.indexOf('async _selectBms()');
  const end = SOURCE.indexOf('async _reconnectBms()', start);
  const select = SOURCE.slice(start, end);
  assert.match(select, /if \(this\.bmsConfigured\)/);
  assert.match(select, /global\.confirm/);
  assert.match(select, /замінено тільки після успішної перевірки/);
  assert.match(select, /Історія залишиться без змін/);
  assert.match(select, /scan_generation/);
  assert.match(select, /candidate_id/);
  assert.equal(/mac/i.test(select), false);
});

test('forget BMS confirmation explains narrow reset scope', () => {
  const start = SOURCE.indexOf('async _forgetBms()');
  const end = SOURCE.indexOf('_setStatus(', start);
  const forget = SOURCE.slice(start, end);
  assert.match(forget, /global\.confirm/);
  assert.match(forget, /Wi-Fi та історія залишаться без змін/);
  assert.match(forget, /global\.ApiClient\.forgetBms/);
});

test('existing JK BMS parameter settings remain a separate route', () => {
  assert.match(SOURCE, /data-open-bms-settings/);
  assert.match(SOURCE, /window\.location\.hash = 'bms-settings'/);
  assert.match(SOURCE, />Параметри BMS</);
  const physicalStart = SOURCE.indexOf('async _scanBms()');
  const physicalEnd = SOURCE.indexOf('_setStatus(', physicalStart);
  const physical = SOURCE.slice(physicalStart, physicalEnd);
  assert.equal(physical.includes('fetchSettings'), false);
  assert.equal(physical.includes('/api/settings'), false);
});

test('BMS management panel keeps mobile controls single-column', () => {
  assert.match(CSS, /\.device-bms-panel\s*{/);
  assert.match(CSS, /\.device-bms-candidate\s*{/);
  assert.match(CSS, /min-height: 44px/);
  assert.match(
    CSS,
    /\.device-wifi-panel-head,\s*\.device-wifi-panel-actions,\s*\.device-bms-panel-head,\s*\.device-bms-panel-actions,\s*\.device-system-reset-actions\s*{\s*flex-direction: column/,
  );
});
