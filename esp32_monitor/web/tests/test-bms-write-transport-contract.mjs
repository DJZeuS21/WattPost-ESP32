import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../js/api.js', import.meta.url), 'utf8');

function harness(mode, enabled) {
  const calls = [];
  const transport = {
    getRuntimeContext: () => ({ mode }),
    getCapabilities: () => ({ bmsSettingsWrite: enabled, bmsSettingsRead: true }),
    fetchBmsWritePolicy: async () => {
      calls.push('policy');
      return { local_write_available: true, model_supported: true,
        connection_epoch: 17, writable_keys: [] };
    },
    startBmsSettingWrite: async change => {
      calls.push(['write', change.key]);
      return { operation: { generation: 4 } };
    },
    startBmsSettingsRefresh: async () => {
      calls.push('refresh_start');
      return { operation: { generation: 5, state: 'queued' } };
    },
    fetchBmsSettingsRefresh: async () => {
      calls.push('refresh_poll');
      return { operation: { generation: 5, state: 'received',
        connection_epoch: 17, received_count: 4 } };
    },
    fetchBmsWriteOperation: async () => {
      calls.push('poll');
      return { operation: { generation: 4, state: 'verified' } };
    },
    fetchSettings: async () => ({ valid: true })
  };
  const context = { WattPostTransport: transport, setTimeout, clearTimeout, setInterval,
    clearInterval, Date, console };
  vm.runInNewContext(source, context);
  return { client: context.ApiClient, calls, transport };
}

test('local BMS write contract remains capability-gated', async () => {
  const { client, calls } = harness('local', false);
  await assert.rejects(client.fetchBmsWritePolicy(), /capability_unavailable/);
  await assert.rejects(client.startBmsSettingWrite({ key: 'switches.charge', value: false }),
    /capability_unavailable/);
  await assert.rejects(client.waitForBmsSettingWrite(4), /capability_unavailable/);
  await assert.rejects(client.refreshBmsSettingsRead(), /capability_unavailable/);
  assert.deepEqual(calls, []);
});

test('Cloud refuses BMS mutations even if a misleading capability is present', async () => {
  const { client, calls } = harness('cloud', true);
  await assert.rejects(client.fetchBmsWritePolicy(), /capability_unavailable/);
  await assert.rejects(client.startBmsSettingWrite({ key: 'switches.charge', value: false }),
    /capability_unavailable/);
  await assert.rejects(client.waitForBmsSettingWrite(4), /capability_unavailable/);
  await assert.rejects(client.refreshBmsSettingsRead(), /capability_unavailable/);
  assert.deepEqual(calls, []);
});

test('supported local transport starts one write and polls read-only until verified', async () => {
  const { client, calls } = harness('local', true);
  const policy = await client.fetchBmsWritePolicy();
  assert.equal(policy.local_write_available, true);
  const start = await client.startBmsSettingWrite({ key: 'switches.charge', value: false });
  const op = await client.waitForBmsSettingWrite(start.operation.generation);
  assert.equal(op.state, 'verified');
  assert.deepEqual(calls, ['policy', ['write', 'switches.charge'], 'poll']);
});

test('operation generation mismatch fails closed with uncertain status', async () => {
  const { client, transport, calls } = harness('local', true);
  transport.fetchBmsWriteOperation = async () => {
    calls.push('poll');
    return { operation: { generation: 7, state: 'verified' } };
  };
  const op = await client.waitForBmsSettingWrite(4);
  assert.equal(op.state, 'uncertain');
  assert.deepEqual(calls, ['poll']);
});

test('invalid transaction generation is rejected before any network call', async () => {
  const { client, calls } = harness('local', true);
  for (const value of [0, -2, 1.1, NaN, null]) {
    await assert.rejects(client.waitForBmsSettingWrite(value), /invalid_request/);
  }
  assert.deepEqual(calls, []);
});


test('local explicit settings refresh only invokes read-only transaction', async () => {
  const { client, calls } = harness('local', true);
  const refreshed = await client.refreshBmsSettingsRead();
  assert.equal(refreshed.received_count, 4);
  assert.deepEqual(calls, ['refresh_start', 'refresh_poll']);
});
