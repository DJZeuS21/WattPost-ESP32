import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = filename => fs.readFileSync(new URL('../js/' + filename, import.meta.url), 'utf8');
const source = read('device-settings.js');

function harness(language) {
  const ctx = {
    URL, URLSearchParams,
    navigator: { language: language + '-' + (language === 'en' ? 'US' : 'UA') },
    location: { search: '' },
    localStorage: { getItem: () => language, setItem() {} },
    module: { exports: {} },
  };
  vm.createContext(ctx);
  for (const filename of ['i18n.js', 'i18n-uk.js', 'i18n-en.js', 'device-settings.js']) {
    vm.runInContext(read(filename), ctx);
  }
  return { ctx, i18n: ctx.WattPostI18n, ...ctx.module.exports };
}

function element(tag) {
  const attrs = new Map();
  return {
    tag, attrs, children: [], style: {}, textContent: '',
    classList: { toggle() {} },
    setAttribute(key, value) { attrs.set(key, String(value)); },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(kind, listener) { this[kind] = listener; },
  };
}

test('Device Settings catalogs cover all static and dynamic keys with no legacy runtime strings', () => {
  const ua = harness('uk'), en = harness('en');
  const { DeviceSettingsView } = en;
  const view = new DeviceSettingsView();
  const ignored = [];
  view.container = {
    innerHTML: '',
    querySelector() { return { setAttribute: (name, value) => ignored.push([name, value]) }; },
  };
  view._buildLayout();
  assert.ok((view.container.innerHTML.match(/data-i18n="/g) || []).length >= 80);
  assert.match(view.container.innerHTML, /aria-label="Automatic updates"/);
  assert.match(view.container.innerHTML, /aria-label="Update progress"/);
  assert.match(view.container.innerHTML, /aria-label="Dismiss update result"/);
  assert.ok(ignored.length >= 8);
  const keys = Array.from(source.matchAll(/tr\('([a-z][a-z0-9_.]*)'/g), m => m[1]);
  for (const key of keys) {
    assert.notEqual(ua.i18n.t(key), key, 'Ukrainian key missing: ' + key);
    assert.notEqual(en.i18n.t(key), key, 'English key missing: ' + key);
  }
  for (const key of view.container.innerHTML.matchAll(/data-i18n="([^"]+)"/g)) {
    assert.notEqual(en.i18n.t(key[1]), key[1], 'HTML key missing: ' + key[1]);
  }
  const start = source.indexOf('    _buildLayout() {');
  const end = source.indexOf('    _bindEvents() {', start);
  assert.ok(start > 0 && end > start);
  for (const section of [source.slice(0, start), source.slice(end)]) {
    for (const line of section.split('\n')) {
      if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue;
      assert.doesNotMatch(line, /[А-Яа-яІіЇїЄєҐґ]/, 'unconverted UI runtime line');
    }
  }
});

test('Device Settings formats uptime and Wi-Fi/OTA progress for both languages', () => {
  const uk = harness('uk');
  const en = harness('en');
  assert.equal(uk.formatUptime(90120), '1 д 1 год');
  assert.equal(en.formatUptime(90120), '1 d 1 h');
  assert.equal(en.formatUptime(3900), '1 h 5 min');
  assert.equal(en.formatUptime(180), '3 min');
  assert.equal(en.formatUptime(-1), '—');

  assert.equal(en.i18n.t('device_settings.wifi_found', { count: 3 }), 'Networks found: 3');
  assert.equal(en.i18n.t('device_settings.ota_available_manual', { version: 'V20.0.3' }),
    'Version V20.0.3 is available. Select “Update now” to install it.');

  const { DeviceSettingsView } = en;
  const view = new DeviceSettingsView();
  const nodes = new Map();
  for (const id of ['device-ota-progress', 'device-ota-progress-dismiss',
    'device-ota-progress-stage', 'device-ota-progress-percent',
    'device-ota-progress-detail', 'device-ota-progress-track', 'device-ota-progress-fill']) {
    nodes.set(id, { hidden: false, textContent: '', dataset: {}, style: {}, querySelector: () => null });
  }
  view.container = { querySelector: selector => nodes.get(selector.slice(1)) || null };
  view._renderOtaProgress({ state: { state: 'downloading', downloaded_bytes: 1250000,
    total_bytes: 2000000, download_attempt: 2 } });
  assert.equal(nodes.get('device-ota-progress-stage').textContent, 'Downloading firmware');
  assert.equal(nodes.get('device-ota-progress-percent').textContent, '62%');
  assert.equal(nodes.get('device-ota-progress-detail').textContent,
    '1.25 of 2.00 MB received · attempt 2');
  assert.equal(nodes.get('device-ota-progress-fill').style.width, '62%');
});

test('Wi-Fi names and BMS identifiers remain literal in English scan results', () => {
  const { DeviceSettingsView, ctx } = harness('en');
  const previousDocument = ctx.document;
  ctx.document = { createElement: element };
  try {
    const view = new DeviceSettingsView();
    const wifiRoot = element('div');
    const bmsRoot = element('div');
    const messages = [];
    view.container = { querySelector: sel => {
      if (sel === '#device-wifi-candidates') return wifiRoot;
      if (sel === '#device-bms-candidates') return bmsRoot;
      return null;
    } };
    view._setWifiMessage = msg => messages.push(msg);
    view._setBmsMessage = msg => messages.push(msg);
    view._setBmsBusy = () => {};
    view._renderWifiCandidates([{ candidate_id: 1, ssid: 'Налаштування', channel: 6,
      auth: 'WPA2', rssi_dbm: -63 }]);
    const wifi = wifiRoot.children[0];
    const wifiTitle = wifi.children[0].children[0];
    assert.equal(wifiTitle.textContent, 'Налаштування');
    assert.equal(wifiTitle.attrs.get('data-i18n-ignore'), '');
    assert.equal(wifi.children[0].children[1].textContent, 'WPA2 · channel 6');
    wifi.click();
    assert.equal(messages.at(-1), 'Selected: Налаштування');

    view._renderBmsCandidates([{ candidate_id: 2, name: 'Налаштування',
      address_hint: 'Адреса прихована', rssi_dbm: -72 }]);
    const bms = bmsRoot.children[0];
    const bmsTitle = bms.children[0].children[0];
    assert.equal(bmsTitle.textContent, 'Налаштування');
    assert.equal(bmsTitle.attrs.get('data-i18n-ignore'), '');
    assert.equal(bms.children[0].children[1].textContent, 'Адреса прихована');
    bms.click();
    assert.equal(messages.at(-1), 'Selected: Налаштування Адреса прихована');
  } finally {
    ctx.document = previousDocument;
  }
});
