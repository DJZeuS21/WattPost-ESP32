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

test('Device Settings routes system actions through centralized ApiClient', () => {
  assert.match(SOURCE, /global\.ApiClient\.rebootDevice\(\)/);
  assert.match(SOURCE, /global\.ApiClient\.factoryResetDevice\(\)/);
  assert.equal(/\bfetch\s*\(/.test(SOURCE), false);
});

test('reboot requires explicit confirmation and describes preserved data', () => {
  const start = SOURCE.indexOf('async _rebootDevice()');
  const end = SOURCE.indexOf('async _factoryResetDevice()', start);
  const reboot = SOURCE.slice(start, end);
  assert.match(reboot, /global\.confirm/);
  assert.match(reboot, /Налаштування та історія збережуться/);
});

test('full reset explains user-visible data loss and next step', () => {
  for (const marker of [
    'збережена Wi-Fi мережа та пароль',
    'вибрана JK BMS',
    'локальні налаштування температурних датчиків',
    'історія вимірювань',
    'прив’язка до поточного акаунта WattPost Cloud',
    'повторно підключіть пристрій',
    'старий доступ може зникнути не одразу',
    '192.168.4.1',
    'BOOT 5–10 секунд і відпустіть',
    '15 секунд або довше',
  ]) {
    assert.equal(SOURCE.includes(marker), true, marker);
  }
  for (const jargon of [
    'erase_flash',
    'manual override',
    'diagnostics і coredump',
    'firmware / OTA partitions',
    'Я розумію scope',
  ]) {
    assert.equal(SOURCE.includes(jargon), false, jargon);
  }
});

test('Factory Reset uses separate checkbox confirmation before enabled action', () => {
  assert.match(
    SOURCE,
    /id="device-system-factory-confirm" type="checkbox"/,
  );
  assert.match(
    SOURCE,
    /id="device-system-factory-run" type="button" disabled/,
  );
  const start = SOURCE.indexOf('async _factoryResetDevice()');
  const end = SOURCE.indexOf('_setStatus(', start);
  const factory = SOURCE.slice(start, end);
  assert.match(factory, /if \(!confirm\?\.checked\)/);
  assert.match(factory, /global\.ApiClient\.factoryResetDevice\(\)/);
});

test('system busy state prevents repeated UI actions until reboot or error', () => {
  const start = SOURCE.indexOf('_setSystemBusy(value)');
  const end = SOURCE.indexOf('_setStatus(', start);
  const system = SOURCE.slice(start, end);
  assert.match(system, /this\.systemBusy = Boolean\(value\)/);
  assert.match(system, /reboot\.disabled = this\.capabilities\.systemReboot === false \|\| this\.systemBusy/);
  assert.match(system, /toggle\.disabled = this\.capabilities\.systemFactoryReset === false \|\| this\.systemBusy/);
  assert.match(system, /run\.disabled = this\.capabilities\.systemFactoryReset === false \|\| this\.systemBusy \|\| !Boolean\(confirm\?\.checked\)/);
  assert.match(system, /if \(this\.systemBusy \|\| !global\.ApiClient\) return/);
});

test('Factory Reset panel remains mobile readable', () => {
  assert.match(CSS, /\.device-system-reset-panel\s*{/);
  assert.match(CSS, /\.device-system-reset-scope\s*{/);
  assert.match(
    CSS,
    /\.device-system-reset-scope\s*{\s*grid-template-columns: 1fr/,
  );
  assert.match(
    CSS,
    /\.device-wifi-panel-head,\s*\.device-wifi-panel-actions,\s*\.device-bms-panel-head,\s*\.device-bms-panel-actions,\s*\.device-system-reset-actions\s*{\s*flex-direction: column/,
  );
});
