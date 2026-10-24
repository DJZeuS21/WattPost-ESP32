import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const settingsSource = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
const payload = '<img src=x onerror=alert(1)>';
const expected = '&lt;img src=x onerror=alert(1)&gt;';

function view() {
  const browser = {
    SettingsNormalizer: {
      formatUptime() { return payload; },
      formatValue() { return {text: payload, unit: payload, secondaryText: payload}; },
      resolveValue() { return payload; }
    },
  };
  vm.runInNewContext(settingsSource, { window: browser });
  const instance = new browser.SettingsView();
  const summary = { innerHTML: '' };
  instance.container = { querySelector(selector) {
    if (selector === '#settings-summary-container') return summary;
    return null;
  }};
  return {instance, summary};
}

test('BMS text in settings summary is encoded, never rendered as HTML', () => {
  const {instance, summary} = view();
  instance._renderSummary({
    device: {
      model: payload, device_name: payload, device_sn: payload,
      hardware_version: payload, software_version: payload,
      protocol_family: payload, power_on_count: payload, uptime_seconds: 15
    },
    battery: { chemistry: payload }
  });
  assert.ok(summary.innerHTML.includes(expected));
  assert.ok(!summary.innerHTML.includes(payload));
  assert.ok(summary.innerHTML.includes('settings-summary-card'));
});

test('formatted BMS setting strings are encoded in rows', () => {
  const {instance} = view();
  const spec = {section:'battery', key:'capacity', labelUk:'Ємність', labelEn:'Capacity', type:'text'};
  const html = instance._renderSettingRow(spec, {}, {
    resolveValue() { return payload; },
    formatValue() { return {text:payload, secondaryText:payload, unit:payload}; }
  });
  assert.equal(html.includes(payload), false);
  assert.equal((html.match(/&lt;img/g) || []).length, 3);
  assert.ok(html.includes('setting-value'));
});
