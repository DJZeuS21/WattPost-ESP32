import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';


test('HistoryView loads older data only for 7d and 14d periods', async () => {
  const code = await readFile(new URL('../js/history.js', import.meta.url), 'utf8');
  const calls = [];
  const buttons = ['24h', '7d', '14d'].map(period => ({
    dataset: { period },
    classList: { toggle: () => {} },
  }));
  const context = {
    window: {
      WattCharts: {
        makeAreaChart: () => {},
        makePieChart: () => {},
        hideTooltip: () => {},
      },
      ApiClient: {
        loadHistoryPeriod: async days => { calls.push(days); },
      },
    },
    document: { querySelectorAll: () => buttons },
  };
  context.URLSearchParams = URLSearchParams;
  context.window.navigator = { language: 'uk-UA', languages: ['uk-UA'] };
  context.window.location = { search: '' };
  context.window.localStorage = { getItem: () => null, setItem() {} };
  vm.createContext(context);
  for (const filename of ['i18n.js', 'i18n-uk.js', 'i18n-en.js']) {
    vm.runInContext(await readFile(new URL('../js/' + filename, import.meta.url), 'utf8'), context);
    if (filename === 'i18n.js') context.WattPostI18n = context.window.WattPostI18n;
  }
  vm.runInContext(code, context);

  const view = new context.window.HistoryView();
  view._resetAllHistoryZoom = () => {};
  view._refresh = () => {};
  view.setPeriod('24h');
  view.setPeriod('7d');
  view.setPeriod('14d');
  await Promise.resolve();

  assert.deepEqual(calls, [7, 14]);
});
