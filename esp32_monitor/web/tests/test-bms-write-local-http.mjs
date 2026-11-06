import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const transportSource = readFileSync(new URL(
  '../js/transports/local-transport.js', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../js/api.js', import.meta.url), 'utf8');

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status,
    json: async () => payload };
}

function harness(fetchFn) {
  const context = { fetch: fetchFn, setTimeout, clearTimeout, setInterval,
    clearInterval, Date, URLSearchParams, AbortController, console };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(transportSource, context);
  vm.runInContext(apiSource, context);
  return new context.ApiClientClass({ historyCache: null });
}

test('local editor fetches policy and status by GET, but writes one protected POST', async () => {
  const calls = [];
  const client = harness(async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/device/bms/settings/write-policy') return response(200, {
      ok: true, data: { local_write_available: true,
        connection_epoch: 13, model_supported: true, writable_keys: ['switches.charge'] }
    });
    if (url === '/api/device/bms/settings/write' && options.method !== 'POST') {
      return response(200, { ok: true,
        data: { operation: { generation: 31, state: 'verified' } } });
    }
    if (url === '/api/device/request-token') return response(200, {
      ok: true, data: { request_token: 'per-boot-token' }
    });
    if (url === '/api/device/bms/settings/write' && options.method === 'POST') {
      return response(202, { ok: true,
        data: { operation: { generation: 31, state: 'queued' } } });
    }
    throw new Error('Unexpected ' + url);
  });
  assert.equal(client.getCapabilities().bmsSettingsWrite, true);
  const policy = await client.fetchBmsWritePolicy();
  assert.equal(policy.connection_epoch, 13);
  assert.equal(policy.local_write_available, true);
  const change = { key: 'switches.charge', value: false, expected_before: true,
    connection_epoch: policy.connection_epoch };
  const started = await client.startBmsSettingWrite(change);
  assert.equal(started.operation.generation, 31);
  const result = await client.waitForBmsSettingWrite(31);
  assert.equal(result.state, 'verified');
  const policyRequest = calls.find(call => call.url.endsWith('/write-policy'));
  assert.equal(policyRequest.options.method, undefined);
  const poll = calls.find(call => call.url.endsWith('/write') && !call.options.method);
  assert.ok(poll);
  const writes = calls.filter(call => call.options.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, '/api/device/bms/settings/write');
  assert.equal(writes[0].options.headers['X-WattPost-Request-Token'], 'per-boot-token');
  assert.deepEqual(JSON.parse(writes[0].options.body), change);
});

test('definite HTTP rejection does not retry BMS mutation', async () => {
  let attempts = 0;
  const client = harness(async (url, options = {}) => {
    if (url === '/api/device/request-token') return response(200, {
      ok: true, data: { request_token: 'per-boot-token' }
    });
    if (url.endsWith('/write') && options.method === 'POST') {
      attempts++;
      return response(412, { ok: false, error: { code: 'stale_connection' } });
    }
    throw new Error('Unexpected request');
  });
  await assert.rejects(
    client.startBmsSettingWrite({
      key: 'switches.charge', value: false, expected_before: true,
      connection_epoch: 13
    }), error => error.code === 'stale_connection' && error.status === 412);
  assert.equal(attempts, 1);
});

test('ambiguous BMS write network failure does not trigger client retry', async () => {
  let attempts = 0;
  const client = harness(async (url, options = {}) => {
    if (url === '/api/device/request-token') return response(200, {
      ok: true, data: { request_token: 'per-boot-token' }
    });
    if (url.endsWith('/write') && options.method === 'POST') {
      attempts++;
      throw new Error('connection lost after dispatch');
    }
    throw new Error('Unexpected request');
  });
  await assert.rejects(
    client.startBmsSettingWrite({
      key: 'switches.charge', value: false, expected_before: true,
      connection_epoch: 13
    }), /connection lost after dispatch/);
  assert.equal(attempts, 1);
});


test('read-only BMS refresh uses protected start and GET status, never settings write POST', async () => {
  const calls = [];
  const client = harness(async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/device/request-token') return response(200, {
      ok: true, data: { request_token: 'one-boot-token' }
    });
    if (url === '/api/device/bms/settings/refresh' && options.method === 'POST') {
      return response(202, { ok: true,
        data: { operation: { generation: 9, state: 'queued' } } });
    }
    if (url === '/api/device/bms/settings/refresh') {
      return response(200, { ok: true,
        data: { operation: { generation: 9, state: 'received',
          connection_epoch: 18, received_count: 4, reason: 'none' } } });
    }
    throw new Error('Unexpected request to ' + url);
  });
  const result = await client.refreshBmsSettingsRead();
  assert.equal(result.received_count, 4);
  assert.equal(result.connection_epoch, 18);
  const callsToRefresh = calls.filter(x => x.url.endsWith('/refresh'));
  assert.equal(callsToRefresh.length, 2);
  assert.equal(callsToRefresh[0].options.method, 'POST');
  assert.equal(callsToRefresh[0].options.body, '{}');
  assert.equal(callsToRefresh[0].options.headers['X-WattPost-Request-Token'], 'one-boot-token');
  assert.equal(callsToRefresh[1].options.method, undefined);
  assert.equal(calls.filter(x => x.url.endsWith('/write')).length, 0);
});

test('failed fresh BLE read never falls back to a write', async () => {
  let writes = 0;
  const client = harness(async (url, options = {}) => {
    if (url === '/api/device/request-token') return response(200, {
      ok: true, data: { request_token: 'one-boot-token' }
    });
    if (url === '/api/device/bms/settings/refresh' && options.method === 'POST') {
      return response(202, { ok: true,
        data: { operation: { generation: 10, state: 'queued' } } });
    }
    if (url === '/api/device/bms/settings/refresh') return response(200, {
      ok: true, data: { operation: { generation: 10, state: 'unavailable',
        reason: 'read_timeout' } }
    });
    if (url.endsWith('/write')) writes++;
    throw new Error('Unexpected request');
  });
  await assert.rejects(client.refreshBmsSettingsRead(), error =>
    error.code === 'refresh_read_timeout');
  assert.equal(writes, 0);
});
