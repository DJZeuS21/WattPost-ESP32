import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function harness(language = 'uk') {
  const dot = { style: {} };
  const badge = { style: {}, classList: { toggle() {} }, lastChild: {}, querySelector: () => dot, setAttribute() {} };
  const banner = { hidden: true, textContent: '', setAttribute() {} };
  const browserLanguage = language === 'en' ? 'en-US' : 'uk-UA';
  const window = { location: { hash: '#history', search: '' }, navigator: { language: browserLanguage, languages: [browserLanguage] }, localStorage: { getItem: () => null, setItem() {} } };
  const document = { getElementById: id => id === 'bms-online' ? badge : id === 'runtime-status-banner' ? banner : null };
  const source = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8')
    .replace("  if (typeof document !== 'undefined') {", "  global.TestApp = App;\n  if (false) {");
  const context = vm.createContext({ window, document, URLSearchParams });
  for (const filename of ['i18n.js', 'i18n-uk.js', 'i18n-en.js']) {
    vm.runInContext(fs.readFileSync(new URL('../js/' + filename, import.meta.url), 'utf8'), context);
    if (filename === 'i18n.js') context.WattPostI18n = window.WattPostI18n;
  }
  vm.runInContext(source, context);
  return { app: new window.TestApp(), badge, banner, window };
}

test('header works independently of Dashboard and survives tab changes', () => {
  const { app, badge } = harness();
  app.tab = 'history';
  app._renderBmsStatus({ online: false }, 'BMS_OFFLINE');
  assert.match(badge.lastChild.nodeValue, /не підключена/);
  app.tab = 'settings';
  app._renderBmsStatus({ online: true, state: 'charging', model: 'JK', cells: { count: 8 } }, 'FRESH');
  assert.equal(badge.lastChild.nodeValue, ' 8S · JK');
  app._renderBmsStatus({ online: true, state: 'charging' }, 'STALE');
  assert.match(badge.lastChild.nodeValue, /Останні відомі/);
});

test('online ESP with old telemetry shows stale global status and its timestamp', () => {
  const { app, badge, banner } = harness();
  const data = { remote: true, online: true, device_online: true, has_snapshot: true,
    bms_connected: true, bms_data_fresh: true, telemetry_fresh: false, is_stale: true,
    telemetry_received_at: '2026-10-13T06:00:00Z', has_last_fresh_battery: true };
  app._renderBmsStatus(data, 'FRESH');
  app._renderRuntimeStatus(data, 'FRESH');
  assert.match(badge.lastChild.nodeValue, /Останні відомі/);
  assert.match(banner.textContent, /застаріла/);
  assert.equal(banner.hidden, false);
  data.telemetry_fresh = true;
  data.is_stale = false;
  app._renderRuntimeStatus(data, 'FRESH');
  assert.equal(banner.hidden, true);
});

test('Cloud request failure does not claim that the device or BMS is offline', () => {
  const { app, badge, banner, window } = harness();
  window.ApiClient = { runtimeContext: { mode: 'cloud' } };
  const unavailable = { online: false };
  app._renderBmsStatus(unavailable, 'PROLONGED_OFFLINE');
  app._renderRuntimeStatus(unavailable, 'PROLONGED_OFFLINE');
  assert.match(badge.lastChild.nodeValue, /Немає зв’язку з Cloud/);
  assert.match(banner.textContent, /стан пристрою не підтверджено/);
});


test('English Cloud/BMS statuses translate while device model values remain untouched', () => {
  const { app, badge, banner, window } = harness('en');
  window.ApiClient = { runtimeContext: { mode: 'cloud' } };
  app._renderBmsStatus({ online: false, remote: true, device_online: false }, 'BMS_OFFLINE');
  assert.equal(badge.lastChild.nodeValue, ' WattPost is offline');
  app._renderBmsStatus({ online: true, remote: true, device_online: true, bms_connected: true,
    state: 'charging', cells: { count: 8 }, model: 'Налаштування' }, 'FRESH');
  assert.equal(badge.lastChild.nodeValue, ' 8S · Налаштування');
  app._renderRuntimeStatus({ remote: true }, 'PROLONGED_OFFLINE');
  assert.match(banner.textContent, /Cannot reach WattPost Cloud/);
  assert.doesNotMatch(banner.textContent, /[А-Яа-яІіЇїЄєҐґ]/);
  app._renderRuntimeStatus({ remote: true, device_online: true, has_snapshot: true,
    bms_connected: true, bms_data_fresh: true, telemetry_fresh: false,
    telemetry_received_at: '2026-10-13T06:00:00Z' }, 'FRESH');
  assert.match(banner.textContent, /saved telemetry is stale/);
  assert.doesNotMatch(banner.textContent, /[А-Яа-яІіЇїЄєҐґ]/);
});

test('English Cloud status carries timestamps and avoids inventing fresh telemetry', () => {
  const { app, banner } = harness('en');
  app._renderRuntimeStatus({ remote: true, online: true, device_online: false,
    has_last_fresh_battery: true, last_fresh_battery_received_at: '2026-10-13T06:00:00Z' }, 'FRESH');
  assert.match(banner.textContent, /Last known battery readings/);
  assert.match(banner.textContent, /2026/);
  app._renderRuntimeStatus({ remote: true, online: true, device_online: true,
    has_snapshot: false, bms_connected: false }, 'FRESH');
  assert.equal(banner.textContent, 'WattPost is online, but BMS is not connected.');
});
