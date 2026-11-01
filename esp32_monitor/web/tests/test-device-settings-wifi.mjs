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

test('Device Settings routes Wi-Fi mutations through centralized ApiClient', () => {
  for (const method of [
    'startWifiScan',
    'waitForWifiOperation',
    'configureWifi',
    'reconnectWifi',
    'resetWifi',
    'fetchDeviceStatus',
  ]) {
    assert.match(SOURCE, new RegExp(`global\\.ApiClient\\.${method}`));
  }
  assert.equal(/\bfetch\s*\(/.test(SOURCE), false);
});

test('Wi-Fi scan candidate strings are rendered with textContent', () => {
  assert.match(SOURCE, /title\.textContent = candidate\.ssid/);
  assert.match(SOURCE, /meta\.textContent = candidate\.auth/);
  assert.equal(SOURCE.includes('.innerHTML'), true, 'layout template is expected');
  const renderStart = SOURCE.indexOf('_renderWifiCandidates(candidates)');
  const renderEnd = SOURCE.indexOf('async _configureWifi()', renderStart);
  const render = SOURCE.slice(renderStart, renderEnd);
  assert.equal(render.includes('.innerHTML'), false);
});

test('saved Wi-Fi password is never rendered or prefilled', () => {
  assert.match(SOURCE, /autocomplete="new-password"/);
  assert.match(SOURCE, /Збережений пароль ніколи не відображається/);
  assert.doesNotMatch(SOURCE, /\b(?:wifi_password|saved_password)\s*[:=]/);
  assert.match(SOURCE, /data-i18n=\"text\.the_saved_password_is_never_shown/);
});

test('password is scrubbed from UI request state after configure attempt', () => {
  assert.ok((SOURCE.match(/request\.password = ''/g) || []).length >= 2);
  assert.ok((SOURCE.match(/passwordInput\.value = ''/g) || []).length >= 2);
});

test('reset Wi-Fi requires explicit user confirmation and describes scope', () => {
  assert.match(SOURCE, /global\.confirm/);
  assert.match(SOURCE, /tr\('text\.reset_wi_fi_settings_wattpost_will_forget_the_saved_networ'\)/);
  assert.match(SOURCE, /tr\('text\.reset_wi_fi_settings_wattpost_will_forget_the_saved_networ'\)/);
});

test('internet state remains separate and does not infer from Wi-Fi association', () => {
  assert.match(SOURCE, /internet_state/);
  assert.match(SOURCE, /unknown: tr\('text\.not_checked'\)/);
  const liveStart = SOURCE.indexOf('onLive(data, state)');
  const live = SOURCE.slice(liveStart);
  assert.equal(
    live.includes("device-wifi-internet', wifiState"),
    false,
  );
});

test('mobile CSS keeps Wi-Fi management panel single-column', () => {
  assert.match(
    CSS,
    /\.device-wifi-panel-head,\s*\.device-wifi-panel-actions,\s*\.device-bms-panel-head,\s*\.device-bms-panel-actions,\s*\.device-system-reset-actions\s*{\s*flex-direction: column/,
  );
  assert.match(CSS, /\.device-wifi-candidate\s*{/);
  assert.match(CSS, /min-height: 44px/);
});
