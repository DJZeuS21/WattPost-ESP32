import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'setup.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'js', 'setup.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'css', 'setup.css'), 'utf8');

test('First Setup shell contains the complete lightweight flow', () => {
  for (const step of [
    'loading',
    'welcome',
    'wifi',
    'wifi-validating',
    'bms',
    'bms-validating',
    'success',
    'config-error',
  ]) {
    assert.match(HTML, new RegExp(`data-step="${step}"`));
  }

  assert.match(HTML, /id="wifi-password"/);
  assert.match(HTML, /id="wifi-hidden-ssid"/);
  assert.match(HTML, /id="bms-candidates"/);
  assert.match(HTML, /id="bms-candidates" role="radiogroup"/);
  assert.match(HTML, /href="http:\/\/bms\.local\/"/);

  const lowered = HTML.toLowerCase();
  assert.equal(lowered.includes('vendor/chart'), false);
  assert.equal(lowered.includes('js/history'), false);
  assert.equal(lowered.includes('js/dashboard'), false);
  assert.equal(lowered.includes('src="js/api.js'), false);
  assert.equal(lowered.includes('css/styles.css'), false);
});

test('First Setup welcome is concise and leaves detail to the actual steps', () => {
  assert.match(HTML, /Новий WattPost/);
  assert.match(HTML, /Почнемо налаштування/);
  assert.match(HTML, /Підключимо Wi-Fi та знайдемо JK BMS через Bluetooth/);
  assert.equal(HTML.includes('Хмарний акаунт для локальної роботи не потрібен'), false);
  assert.equal(HTML.includes('Під час перевірки домашньої мережі'), false);
});

test('First Setup renders untrusted scan strings without innerHTML', () => {
  assert.match(APP, /title\.textContent = candidate\.ssid/);
  assert.match(APP, /title\.textContent = candidate\.name/);
  assert.match(APP, /meta\.textContent = candidate\.address_hint/);
  assert.equal(APP.includes('.innerHTML'), false);
});

test('First Setup BMS results use the same visible interactive cards as Wi-Fi', () => {
  const start = APP.indexOf('renderBmsCandidates(candidates)');
  const end = APP.indexOf('async selectBms(candidate)', start);
  const bmsRenderer = APP.slice(start, end);
  assert.match(bmsRenderer, /setup-candidate-card/);
  assert.match(bmsRenderer, /setAttribute\('role', 'radio'\)/);
  assert.match(bmsRenderer, /setAttribute\('aria-checked', 'false'\)/);
});

test('First Setup follows API operation generation and state', () => {
  assert.match(APP, /Number\(operation\.generation\)/);
  assert.match(APP, /operation\.state === 'success'/);
  assert.match(APP, /operation\.state === 'error'/);
  assert.match(APP, /operation_reset/);
  assert.match(APP, /phaseText\(phase\)/);
  assert.match(APP, /started\.operation\.generation/);
});

test('Wi-Fi password is cleared after configure attempt', () => {
  assert.ok((APP.match(/passwordInput\.value = ''/g) || []).length >= 2);
  assert.ok((APP.match(/request\.password = ''/g) || []).length >= 2);
});

test('Wi-Fi selection displays the complete form outside the scrolling network list', () => {
  assert.match(HTML, /id="wifi-credentials-panel"/);
  assert.match(HTML, /id="wifi-password-toggle"/);
  assert.doesNotMatch(APP, /card\.appendChild\(credentials\)/);
  assert.match(APP, /this\.\$\('wifi-credentials-home'\)\.appendChild\(credentials\)/);
  assert.match(APP, /scrollIntoView\(\{ block: 'end'/);
  assert.match(APP, /password\.type = visible \? 'text' : 'password'/);
  assert.match(APP, /aria-pressed/);
  assert.match(CSS, /\.setup-candidate-card\.is-expanded/);
  assert.match(CSS, /#wifi-credentials-home \.setup-network-credentials/);
  assert.match(CSS, /\.setup-password-toggle/);
});

test('First Setup scans only after an explicit user action', () => {
  const initStart = APP.indexOf('init()');
  const bootstrapStart = APP.indexOf('async bootstrap()');
  const applyStatusStart = APP.indexOf('applyStatus(status)');
  const initBlock = APP.slice(initStart, bootstrapStart);
  const bootstrapBlock = APP.slice(bootstrapStart, applyStatusStart);
  assert.doesNotMatch(initBlock, /showStep\('wifi'\);\s*this\.scanWifi\(\)/);
  assert.doesNotMatch(initBlock, /showStep\('bms'\);\s*this\.scanBms\(\)/);
  assert.doesNotMatch(bootstrapBlock, /await this\.scanBms\(\)/);

  const configureStart = APP.indexOf('async configureWifi()');
  const configureEnd = APP.indexOf('async scanBms()', configureStart);
  assert.doesNotMatch(APP.slice(configureStart, configureEnd), /await this\.scanBms\(\)/);
});

test('First Setup progress uses one continuous evenly spaced track', () => {
  assert.match(HTML, /data-progress="welcome"><span>1<\/span><b>Початок<\/b>/);
  assert.match(HTML, /data-progress="wifi"><span>2<\/span><b>Wi-Fi<\/b>/);
  assert.match(HTML, /data-progress="bms"><span>3<\/span><b>JK BMS<\/b>/);
  assert.match(HTML, /id="wifi-step-kicker">Етап 2 \/ 3/);
  assert.match(HTML, /data-step="bms">[\s\S]*?<p class="setup-kicker">Етап 3 \/ 3/);
  assert.match(CSS, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(CSS, /\.setup-progress::before/);
  assert.match(CSS, /left: 16\.6667%/);
  assert.match(CSS, /right: 16\.6667%/);
  assert.equal(CSS.includes('.setup-progress li::after'), false);
});

test('Scan controls are primary actions with clear idle states', () => {
  assert.match(HTML, /class="setup-button setup-button-scan" id="wifi-scan"/);
  assert.match(HTML, /class="setup-button setup-button-scan" id="bms-scan"/);
  assert.match(HTML, /Натисніть «Знайти Wi-Fi мережі»/);
  assert.match(HTML, /Натисніть «Знайти JK BMS»/);
  assert.match(CSS, /\.setup-button-scan \{/);
  assert.match(CSS, /\.setup-button-scan\.is-loading:disabled/);
});

test('First Setup prevents browser pull-to-refresh from stealing list scroll', () => {
  assert.match(CSS, /html \{[^}]*overscroll-behavior-y: none/s);
  assert.match(CSS, /body \{[^}]*overscroll-behavior-y: none/s);
  assert.match(CSS, /\.setup-list \{[^}]*overscroll-behavior: contain/s);
  assert.match(CSS, /\.setup-list \{[^}]*touch-action: pan-y/s);
  assert.match(APP, /installScrollBoundaryGuard\(this\.\$\('wifi-candidates'\)\)/);
  assert.match(APP, /touchmove/);
  assert.match(APP, /passive: false/);
  assert.match(APP, /event\.preventDefault\(\)/);
});

test('First Setup is mobile-first and honors reduced motion', () => {
  assert.match(
    HTML,
    /name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/,
  );
  assert.match(CSS, /@media \(max-width: 480px\)/);
  assert.match(CSS, /env\(safe-area-inset-top\)/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/);
});

test('JK BMS is optional after valid Wi-Fi and on failed BMS validation', () => {
  assert.match(HTML, /id="bms-skip"/);
  assert.match(HTML, /id="bms-validation-skip"/);
  assert.match(APP, /await api\.finishWithoutBms\(\)/);
  assert.match(APP, /status\.setup_completed_without_bms !== true/);
  assert.match(APP, /Не підключено — можна додати пізніше/);
  assert.match(APP, /showSuccess\(status\)/);
});
