import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL('../js/' + name, import.meta.url), 'utf8');
const schemaSource = read('settings-schema.js');
const uiSource = read('settings.js');

function harness(language = 'uk') {
  const lang = language === 'en' ? 'en-US' : 'uk-UA';
  const context = {
    window: {
      navigator: { language: lang, languages: [lang] },
      location: { search: '' },
      localStorage: { getItem: () => language, setItem() {} },
    },
    URLSearchParams,
  };
  vm.createContext(context);
  for (const file of ['i18n.js', 'i18n-uk.js', 'i18n-en.js',
    'settings-schema.js', 'settings.js']) {
    vm.runInContext(read(file), context);
    if (file === 'i18n.js') context.WattPostI18n = context.window.WattPostI18n;
  }
  const html = { innerHTML: '' };
  const view = new context.window.SettingsView();
  view.container = { querySelector: selector => selector === '#settings-grid' ||
      selector === '#settings-summary-container' ? html : null };
  return { context, view, html };
}

test('the BMS schema has stable keys, complete bilingual catalogs and no inline localizations', () => {
  assert.doesNotMatch(schemaSource, /\b(labelUk|labelEn|titleUk|titleEn|descriptionUk)\b/);
  assert.doesNotMatch(schemaSource, /[А-Яа-яІіЇїЄєҐґ]/);
  const { context } = harness();
  const i18n = context.WattPostI18n;
  const specs = context.window.SETTINGS_SCHEMA;
  assert.equal(specs.length, 53);
  assert.equal(new Set(specs.map(s => s.key)).size, 53);
  for (const spec of specs) {
    assert.equal(spec.labelKey, 'bms.parameter.' + spec.key);
    assert.notEqual(i18n.tLocale('uk', spec.labelKey), spec.labelKey);
    assert.notEqual(i18n.tLocale('en', spec.labelKey), spec.labelKey);
  }
  for (const section of context.window.SETTINGS_SECTIONS) {
    assert.notEqual(i18n.tLocale('en', section.titleKey), section.titleKey);
    assert.notEqual(i18n.tLocale('en', section.descriptionKey), section.descriptionKey);
    for (const subgroup of section.subgroups || []) {
      assert.notEqual(i18n.tLocale('en', subgroup.titleKey), subgroup.titleKey);
    }
  }
});

test('English BMS Settings renders English only, preserving API key and names', () => {
  const { context, view, html } = harness('en');
  view._renderSections(null);
  assert.match(html.innerHTML, /Battery Configuration/);
  assert.match(html.innerHTML, /Cell count/);
  assert.match(html.innerHTML, /Charging Protection/);
  assert.match(html.innerHTML, /data-key="battery.cell_count"/);
  assert.match(html.innerHTML, /data-search="[^"]*кількість комірок/);
  assert.doesNotMatch(html.innerHTML, /class="setting-label-en"/);
  assert.doesNotMatch(html.innerHTML, /class="settings-subgroup-en"/);
  const key = context.window.SETTINGS_SCHEMA.find(s => s.key === 'switches.charge');
  assert.equal(context.window.SettingsNormalizer.formatValue(key, true).text, 'Enabled');
  assert.equal(context.window.SettingsNormalizer.formatValue(key, false).text, 'Disabled');
  assert.equal(context.window.SettingsNormalizer.formatUptime(90060), '1 d 1 h 1 min');
  const hoursSpec = context.window.SETTINGS_SCHEMA.find(s => s.key === 'sleep.smart_sleep_time_hours');
  assert.equal(context.window.SettingsNormalizer.formatValue(hoursSpec, 4).unit, 'h');

  view._renderSummary({ device: { device_name: 'Налаштування' }, battery: {} });
  assert.match(html.innerHTML, /class="settings-summary-title" data-i18n-ignore>Налаштування/);
  assert.match(html.innerHTML, /class="badge-label">Capacity/);
});

test('Ukrainian BMS Settings retains the English technical reference under each parameter', () => {
  const { context, view, html } = harness('uk');
  view._renderSections(null);
  assert.match(html.innerHTML, /class="setting-label-uk">Кількість комірок/);
  assert.match(html.innerHTML, /class="setting-label-en">Cell count/);
  assert.match(html.innerHTML, /class="settings-subgroup-en">Charging Protection/);
  const key = context.window.SETTINGS_SCHEMA.find(s => s.key === 'switches.charge');
  assert.equal(context.window.SettingsNormalizer.formatValue(key, true).text, 'Увімкнено');
  assert.equal(context.window.SettingsNormalizer.formatUptime(90060), '1 д 1 год 1 хв');
});

test('BMS search messages and reference labels are keyed, user search text stays safe', () => {
  const { context } = harness('en');
  const t = context.WattPostI18n.t;
  assert.equal(t('bms.parameters_count', { count: 53 }), '53 parameters');
  assert.equal(t('setup.found_count', { count: 7 }), 'Found: 7');
  assert.equal(t('bms.search_no_match', { query: 'Налаштування' }),
    'No settings match “Налаштування”. Check the spelling or try another key.');
  assert.match(uiSource, /emptyDesc.textContent = tr\('bms.search_no_match'/);
  assert.match(uiSource, /data-search="\$\{escapeHtml\(searchTerms\)\}"/);
  assert.match(uiSource, /data-i18n-ignore/);
});
