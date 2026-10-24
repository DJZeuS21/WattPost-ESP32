import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'setup.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'js', 'setup.js'), 'utf8');
const API = fs.readFileSync(path.join(ROOT, 'js', 'setup-api.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'css', 'setup.css'), 'utf8');

test('Recovery is a distinct lightweight setup-shell mode', () => {
  assert.match(HTML, /data-step="recovery"/);
  assert.match(HTML, /id="recovery-wifi"/);
  assert.match(HTML, /id="recovery-bms-state"/);
  assert.match(HTML, /id="recovery-firmware"/);
  assert.match(HTML, /id="recovery-uptime"/);
  assert.match(APP, /status\.mode === 'recovery'/);
  assert.match(APP, /this\.showRecovery\(status\)/);
  assert.match(APP, /this\.\$\('setup-progress'\)\.classList\.toggle\('is-hidden', this\.recoveryMode\)/);
  assert.match(APP, /WattPost — Відновлення Wi-Fi/);
});

test('Recovery exposes saved-Wi-Fi reconnect and safe network replacement', () => {
  assert.match(HTML, /id="recovery-reconnect"/);
  assert.match(HTML, /id="recovery-change-wifi"/);
  assert.match(APP, /api\.reconnectWifi\(\)/);
  assert.match(APP, /this\.showStep\('wifi'\)/);
  assert.match(APP, /if \(recoveryFlow\) \{[\s\S]*?this\.showRecovery/);
  assert.match(APP, /Якщо BMS ще не вибрано, завершіть її налаштування там/);
  assert.match(API, /\/api\/device\/wifi\/reconnect/);
  assert.match(API, /\/api\/device\/wifi\/configure/);
});

test('Recovery system actions keep Stage 1 exact confirmations', () => {
  assert.match(HTML, /id="recovery-reboot"/);
  assert.match(HTML, /id="recovery-reset-wifi"/);
  assert.match(HTML, /id="recovery-factory-confirm"/);
  assert.match(HTML, /id="recovery-factory-reset"[^>]*disabled/);
  assert.match(API, /confirm: 'reboot'/);
  assert.match(API, /confirm: 'reset_wifi'/);
  assert.match(API, /confirm: 'factory_reset'/);
  assert.equal(API.includes("confirmation:"), false);
  assert.match(APP, /!this\.\$\('recovery-factory-confirm'\)\.checked/);
});

test('Recovery copy explains user outcome without implementation jargon', () => {
  assert.match(HTML, /Підключіть WattPost до домашнього Wi-Fi/);
  assert.match(HTML, /Налаштування BMS та історія не зміняться/);
  assert.match(HTML, /повне скидання видалить Wi-Fi, вибір BMS, налаштування датчиків, історію та прив’язку до поточного акаунта Cloud/);
  assert.match(HTML, /мережі WattPost-XXXX і відкрийте 192\.168\.4\.1/);
  assert.match(HTML, /повторно підключіть Cloud до потрібного акаунта/);
  for (const jargon of [
    'тайм-ауту бездіяльності',
    'temperature override',
    'diagnostics/coredump',
    'firmware і OTA partitions',
  ]) {
    assert.equal(HTML.includes(jargon), false, jargon);
  }
  assert.equal(HTML.toLowerCase().includes('збережений пароль'), false);
  assert.equal(APP.includes('.innerHTML'), false);
});

test('Recovery remains mobile-first and danger controls are visually distinct', () => {
  assert.match(CSS, /\.setup-button-danger/);
  assert.match(CSS, /\.setup-action-stack/);
  assert.match(CSS, /@media \(max-width: 480px\)/);
});
