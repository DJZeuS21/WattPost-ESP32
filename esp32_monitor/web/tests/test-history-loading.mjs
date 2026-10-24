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
  vm.createContext(context);
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
