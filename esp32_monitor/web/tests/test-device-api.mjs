import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8');
const TRANSPORT = fs.readFileSync(
  path.join(ROOT, 'js', 'transports', 'local-transport.js'),
  'utf8',
);

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function createClient(fetchFn) {
  const context = {
    fetch: fetchFn,
    DataNormalizer: {
      normalizeLive: value => value,
      normalizeHistory: value => value,
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    URLSearchParams,
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(TRANSPORT, context, { filename: 'local-transport.js' });
  vm.runInContext(SOURCE, context, { filename: 'api.js' });
  return {
    client: new context.ApiClientClass({ historyCache: null }),
    DeviceApiError: context.DeviceApiError,
  };
}

test('device status uses the central API layer', async () => {
  const calls = [];
  const { client } = createClient(async (url, options) => {
    calls.push({ url, options });
    return response(200, {
      ok: true,
      data: { setup_state: 'configured', wifi: { state: 'connected' } },
    });
  });

  const status = await client.fetchDeviceStatus();
  assert.equal(status.setup_state, 'configured');
  assert.equal(calls[0].url, '/api/device/status');
  assert.equal(calls[0].options.cache, 'no-store');
});

test('Wi-Fi mutation obtains token and keeps password in JSON body only', async () => {
  const calls = [];
  const { client } = createClient(async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/device/request-token') {
      return response(200, {
        ok: true,
        data: { request_token: 'device-token' },
      });
    }
    return response(202, {
      ok: true,
      operation: {
        generation: 8,
        state: 'running',
        phase: 'connecting',
        error_code: null,
      },
    });
  });

  await client.configureWifi({
    scan_generation: 4,
    candidate_id: 2,
    password: 'new-secret',
  });

  const mutation = calls.at(-1);
  assert.equal(mutation.url, '/api/device/wifi/configure');
  assert.equal(mutation.url.includes('new-secret'), false);
  assert.equal(
    mutation.options.headers['X-WattPost-Request-Token'],
    'device-token',
  );
  assert.equal(JSON.parse(mutation.options.body).password, 'new-secret');
});

test('device mutation refreshes rejected token once', async () => {
  let tokenCalls = 0;
  let mutationCalls = 0;
  const headers = [];
  const { client } = createClient(async (url, options) => {
    if (url === '/api/device/request-token') {
      tokenCalls += 1;
      return response(200, {
        ok: true,
        data: {
          request_token: tokenCalls === 1 ? 'old-token' : 'new-token',
        },
      });
    }
    mutationCalls += 1;
    headers.push(options.headers['X-WattPost-Request-Token']);
    if (mutationCalls === 1) {
      return response(403, {
        ok: false,
        error: { code: 'request_token_invalid' },
      });
    }
    return response(202, {
      ok: true,
      operation: {
        generation: 5,
        state: 'running',
        phase: 'reconnecting',
        error_code: null,
      },
    });
  });

  const result = await client.reconnectWifi();
  assert.equal(result.operation.generation, 5);
  assert.equal(tokenCalls, 2);
  assert.equal(mutationCalls, 2);
  assert.deepEqual(headers, ['old-token', 'new-token']);
});

test('reset Wi-Fi sends only the stable confirmation value', async () => {
  const calls = [];
  const { client } = createClient(async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/device/request-token') {
      return response(200, {
        ok: true,
        data: { request_token: 'token' },
      });
    }
    return response(202, {
      ok: true,
      operation: {
        generation: 10,
        state: 'running',
        phase: 'resetting',
        error_code: null,
      },
    });
  });

  await client.resetWifi();
  const mutation = calls.at(-1);
  assert.equal(mutation.url, '/api/device/wifi/reset');
  assert.deepEqual(JSON.parse(mutation.options.body), {
    confirm: 'reset_wifi',
  });
});

test('automatic OTA preference uses protected PUT and strict boolean body', async () => {
  const calls = [];
  const { client } = createClient(async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/device/request-token') {
      return response(200, { ok: true, data: { request_token: 'ota-token' } });
    }
    return response(200, { ok: true, data: { automatic_updates: false } });
  });

  const result = await client.setOtaAutomaticUpdates(false);
  assert.equal(result.data.automatic_updates, false);
  const mutation = calls.at(-1);
  assert.equal(mutation.url, '/api/device/ota/preferences');
  assert.equal(mutation.options.method, 'PUT');
  assert.equal(mutation.options.headers['X-WattPost-Request-Token'], 'ota-token');
  assert.deepEqual(JSON.parse(mutation.options.body), { automatic_updates: false });
});

test('Wi-Fi operation polling returns success for matching generation', async () => {
  let polls = 0;
  const { client } = createClient(async (url) => {
    assert.equal(url, '/api/device/wifi/scan');
    polls += 1;
    return response(200, {
      ok: true,
      data: {
        scan_generation: 4,
        candidates: [],
        operation: {
          generation: 12,
          state: polls < 2 ? 'running' : 'success',
          phase: polls < 2 ? 'reconnecting' : 'none',
          error_code: null,
        },
      },
    });
  });

  const updates = [];
  const result = await client.waitForWifiOperation(12, {
    timeoutMs: 2000,
    intervalMs: 1,
    onUpdate: operation => updates.push(operation.state),
  });

  assert.equal(result.operation.state, 'success');
  assert.deepEqual(updates, ['running', 'success']);
});

test('Wi-Fi operation polling surfaces firmware error code', async () => {
  const { client, DeviceApiError } = createClient(async () => response(200, {
    ok: true,
    data: {
      scan_generation: 3,
      candidates: [],
      operation: {
        generation: 15,
        state: 'error',
        phase: 'none',
        error_code: 'wifi_auth_failed',
      },
    },
  }));

  await assert.rejects(
    client.waitForWifiOperation(15, {
      timeoutMs: 1000,
      intervalMs: 1,
    }),
    error =>
      error instanceof DeviceApiError &&
      error.code === 'wifi_auth_failed',
  );
});

test('BMS mutations use tokenized Device API paths and safe selection body', async () => {
  const calls = [];
  const { client } = createClient(async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/device/request-token') {
      return response(200, {
        ok: true,
        data: { request_token: 'bms-token' },
      });
    }
    return response(202, {
      ok: true,
      operation: {
        generation: 22,
        state: 'running',
        phase: 'connecting',
        error_code: null,
      },
    });
  });

  await client.selectBms({ scan_generation: 8, candidate_id: 2 });
  const mutation = calls.at(-1);
  assert.equal(mutation.url, '/api/device/bms/select');
  assert.equal(
    mutation.options.headers['X-WattPost-Request-Token'],
    'bms-token',
  );
  assert.deepEqual(JSON.parse(mutation.options.body), {
    scan_generation: 8,
    candidate_id: 2,
  });
  assert.equal(mutation.options.body.includes('address'), false);
  assert.equal(mutation.options.body.toLowerCase().includes('mac'), false);
});

test('forget BMS sends only the stable confirmation value', async () => {
  const calls = [];
  const { client } = createClient(async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/device/request-token') {
      return response(200, {
        ok: true,
        data: { request_token: 'token' },
      });
    }
    return response(202, {
      ok: true,
      operation: {
        generation: 23,
        state: 'running',
        phase: 'resetting',
        error_code: null,
      },
    });
  });

  await client.forgetBms();
  const mutation = calls.at(-1);
  assert.equal(mutation.url, '/api/device/bms/forget');
  assert.deepEqual(JSON.parse(mutation.options.body), {
    confirm: 'forget_bms',
  });
});

test('BMS operation polling follows scan snapshot generation', async () => {
  let polls = 0;
  const { client } = createClient(async (url) => {
    assert.equal(url, '/api/device/bms/scan');
    polls += 1;
    return response(200, {
      ok: true,
      data: {
        scan_generation: 8,
        candidates: [],
        operation: {
          generation: 31,
          state: polls < 2 ? 'running' : 'success',
          phase: polls < 2 ? 'validating' : 'none',
          error_code: null,
        },
      },
    });
  });

  const updates = [];
  const result = await client.waitForBmsOperation(31, {
    timeoutMs: 2000,
    intervalMs: 1,
    onUpdate: operation => updates.push(operation.phase),
  });
  assert.equal(result.operation.state, 'success');
  assert.deepEqual(updates, ['validating', 'none']);
});

test('Cloud pairing and disconnect use tokenized local Device API', async () => {
  const calls = [];
  const { client } = createClient(async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/device/request-token') {
      return response(200, {
        ok: true,
        data: { request_token: 'cloud-token' },
      });
    }
    return response(202, {
      ok: true,
      operation: {
        generation: 35,
        state: 'running',
        phase: 'pairing',
        error_code: null,
      },
    });
  });

  await client.startCloudPairing();
  let mutation = calls.at(-1);
  assert.equal(mutation.url, '/api/device/cloud/pair');
  assert.deepEqual(JSON.parse(mutation.options.body), {});
  assert.equal(
    mutation.options.headers['X-WattPost-Request-Token'],
    'cloud-token',
  );

  await client.disconnectCloud();
  mutation = calls.at(-1);
  assert.equal(mutation.url, '/api/device/cloud/disconnect');
  assert.deepEqual(JSON.parse(mutation.options.body), {
    confirm: 'disconnect_cloud',
  });
});

test('Cloud operation polling reads only scrubbed device status', async () => {
  let polls = 0;
  const { client } = createClient(async (url) => {
    assert.equal(url, '/api/device/status');
    polls += 1;
    return response(200, {
      ok: true,
      data: {
        cloud: {
          operation: {
            generation: 36,
            state: polls < 2 ? 'running' : 'success',
            kind: 'pair',
            error_code: null,
          },
          pairing: {
            state: polls < 2 ? 'requesting' : 'pending',
            pair_url: polls < 2
              ? null
              : 'https://wattpost.pp.ua/pair#token=' + 'A'.repeat(43),
          },
        },
      },
    });
  });

  const result = await client.waitForCloudOperation(36, {
    timeoutMs: 2000,
    intervalMs: 1,
  });
  assert.equal(result.cloud.operation.state, 'success');
  assert.equal(result.cloud.pairing.state, 'pending');
  assert.equal(JSON.stringify(result).includes('device_secret'), false);
});

test('system reboot sends only the stable reboot confirmation', async () => {
  const calls = [];
  const { client } = createClient(async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/device/request-token') {
      return response(200, {
        ok: true,
        data: { request_token: 'system-token' },
      });
    }
    return response(202, {
      ok: true,
      operation: {
        generation: 40,
        state: 'running',
        phase: 'restarting',
        error_code: null,
      },
    });
  });

  await client.rebootDevice();
  const mutation = calls.at(-1);
  assert.equal(mutation.url, '/api/device/system/reboot');
  assert.equal(
    mutation.options.headers['X-WattPost-Request-Token'],
    'system-token',
  );
  assert.deepEqual(JSON.parse(mutation.options.body), {
    confirm: 'reboot',
  });
});

test('factory reset sends only the stable destructive confirmation', async () => {
  const calls = [];
  const { client } = createClient(async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/device/request-token') {
      return response(200, {
        ok: true,
        data: { request_token: 'system-token' },
      });
    }
    return response(202, {
      ok: true,
      operation: {
        generation: 41,
        state: 'running',
        phase: 'resetting',
        error_code: null,
      },
    });
  });

  await client.factoryResetDevice();
  const mutation = calls.at(-1);
  assert.equal(mutation.url, '/api/device/system/factory-reset');
  assert.deepEqual(JSON.parse(mutation.options.body), {
    confirm: 'factory_reset',
  });
});
