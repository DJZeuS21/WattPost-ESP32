// esp32_monitor/web/tests/test-api-settings.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('ApiClient settings fetch, cache and connectivity state transitions', async () => {
  const code = await readFile(new URL('../js/api.js', import.meta.url), 'utf8');
  const transportCode = await readFile(
    new URL('../js/transports/local-transport.js', import.meta.url),
    'utf8',
  );
  
  let fetchOutcome = 'SUCCESS';
  const mockPayload = { valid: true, device: { model: 'JK_PB2A16S20P' } };

  const context = {
    fetch: async (url) => {
      if (fetchOutcome === 'SUCCESS') {
        return { ok: true, json: async () => mockPayload };
      }
      if (fetchOutcome === 'INVALID') {
        return { ok: true, json: async () => ({ valid: false }) };
      }
      throw new Error('Network error');
    },
    setTimeout: (fn) => setTimeout(fn, 10),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn) => setInterval(fn, 1000),
    clearInterval: (id) => clearInterval(id),
    AbortController: globalThis.AbortController,
    document: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(transportCode, context);
  vm.runInContext(code, context);

  const ApiClientClass = context.window.ApiClientClass || context.globalThis.ApiClientClass;
  assert.ok(ApiClientClass, 'ApiClientClass must be exported');

  const client = new ApiClientClass();
  assert.ok(typeof client.fetchSettings === 'function', 'fetchSettings must be a function');
  assert.ok(typeof client.onSettings === 'function', 'onSettings must be a function');

  // 1. Initial Loading state
  let currentSettingsState = null;
  let receivedData = null;
  const unsubscribe = client.onSettings((data, state) => {
    receivedData = data;
    currentSettingsState = state;
  });

  assert.strictEqual(currentSettingsState, 'INITIAL_LOADING');

  // 2. Successful fetch -> FRESH
  await client.fetchSettings();
  assert.strictEqual(currentSettingsState, 'FRESH');
  assert.strictEqual(receivedData.device.model, 'JK_PB2A16S20P');

  // 3. Transient error with cached data -> STALE
  fetchOutcome = 'ERROR';
  await client.fetchSettings();
  assert.strictEqual(currentSettingsState, 'STALE');
  assert.strictEqual(receivedData.device.model, 'JK_PB2A16S20P', 'Cached data must be retained during STALE state');

  // 4. Recovery after stale directly transitions STALE -> FRESH
  fetchOutcome = 'SUCCESS';
  await client.fetchSettings();
  assert.strictEqual(currentSettingsState, 'FRESH');

  // 5. Error without cached data -> FAILED_NO_DATA
  const cleanClient = new ApiClientClass();
  fetchOutcome = 'ERROR';
  await cleanClient.fetchSettings();
  assert.strictEqual(cleanClient.settingsState, 'FAILED_NO_DATA');

  unsubscribe();
});
