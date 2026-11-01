import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const normalizer = createRequire(import.meta.url)('../js/data-normalizer.js');

function viewHarness(language = 'uk') {
  const elements = new Map();
  const document = { getElementById: id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', style: {} });
    return elements.get(id);
  } };
  const browserLanguage = language === 'en' ? 'en-US' : 'uk-UA';
  const window = { DataNormalizer: normalizer, WattCharts: {},
    navigator: { language: browserLanguage, languages: [browserLanguage] },
    location: { search: '' }, localStorage: { getItem: () => null, setItem() {} } };
  const context = vm.createContext({ window, document, URLSearchParams });
  for (const filename of ['i18n.js', 'i18n-uk.js', 'i18n-en.js', 'history.js']) {
    vm.runInContext(fs.readFileSync(new URL('../js/' + filename, import.meta.url), 'utf8'), context);
    if (filename === 'i18n.js') context.WattPostI18n = window.WattPostI18n;
  }
  return { view: new window.HistoryView(), elements };
}

test('empty and one-point summaries distinguish absent energy from measured SOC', () => {
  const { view, elements } = viewHarness();
  view.filteredHistory = []; view._refreshSummary(); view._refreshModeSplit();
  assert.equal(elements.get('summary-energy-in').textContent, '—');
  assert.equal(elements.get('summary-soc-range').textContent, '—');
  assert.ok(!elements.get('mode-list').innerHTML.includes('100%'));
  view.filteredHistory = [{ t: 100, v: 26, a: 0, s: 82 }]; view._refreshSummary();
  assert.equal(elements.get('summary-energy-in').textContent, '—');
  assert.equal(elements.get('summary-soc-range').textContent, '82 – 82');
});

test('two measured idle samples produce real zero energy and 100% idle', () => {
  const { view, elements } = viewHarness();
  view.filteredHistory = [{ t: 100, v: 26, a: 0, s: 82, mode: 'idle' }, { t: 700, v: 26, a: 0, s: 82, mode: 'idle' }];
  view._refreshSummary(); view._refreshModeSplit();
  assert.equal(elements.get('summary-energy-in').textContent, '0.0');
  assert.match(elements.get('mode-list').innerHTML, /100%/);
  assert.equal(normalizer.energyStats(view.filteredHistory, 'charging').validIntervals, 1);
  view.filteredHistory = [{ t: 100, v: 26, a: 0 }, { t: 2000, v: 26, a: 0 }];
  view._refreshSummary();
  assert.equal(elements.get('summary-energy-in').textContent, '—');
});


test('History labels and record plurals use the selected language', () => {
  const { view: ua } = viewHarness();
  const { view: en, elements } = viewHarness('en');
  assert.deepEqual([ua._recordPlural(1), ua._recordPlural(2), ua._recordPlural(5)],
    ['запис', 'записи', 'записів']);
  assert.deepEqual([en._recordPlural(1), en._recordPlural(2), en._recordPlural(5)],
    ['record', 'records', 'records']);
  assert.equal(en._getActiveMetrics()[0].label, 'Battery power');
  assert.equal(en._getActiveMetrics()[1].shortLabel, 'Voltage');
  en.filteredHistory = [];
  en._refreshModeSplit();
  const modeList = elements.get('mode-list').innerHTML;
  assert.match(modeList, /Charging/);
  assert.match(modeList, /Discharging/);
  assert.match(modeList, /Idle/);
  assert.doesNotMatch(modeList, /[А-Яа-яІіЇїЄєҐґ]/);
});
