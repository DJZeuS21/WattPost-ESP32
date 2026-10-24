import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'setup-api.js'), 'utf8');

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function loadClient(fetchFn) {
  const context = {
    fetch: fetchFn,
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'setup-api.js' });
  return {
    client: context.WattPostSetupApi,
    ApiError: context.WattPostSetupApiError,
  };
}

test('setup API status is lightweight local read', async () => {
  const calls = [];
  const { client } = loadClient(async (url, options) => {
    calls.push({ url, options });
    return response(200, {
      ok: true,
      data: { setup_state: 'wifi_required' },
    });
  });

  const status = await client.getStatus();
  assert.equal(status.setup_state, 'wifi_required');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/device/status');
  assert.equal(calls[0].options.method, undefined);
  assert.equal(calls[0].options.cache, 'no-store');
});

test('setup mutations use JSON and RAM request token header', async () => {
  const calls = [];
  const { client } = loadClient(async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/device/request-token') {
      return response(200, {
        ok: true,
        data: { request_token: 'token-one' },
      });
    }
    return response(202, {
      ok: true,
      operation: {
        generation: 4,
        state: 'running',
        phase: 'scanning',
        error_code: null,
      },
    });
  });

  const result = await client.startWifiScan();
  assert.equal(result.operation.generation, 4);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/api/device/wifi/scan');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
  assert.equal(
    calls[1].options.headers['X-WattPost-Request-Token'],
    'token-one',
  );
  assert.deepEqual(JSON.parse(calls[1].options.body), {});
});

test('setup mutation refreshes token once after token rejection', async () => {
  const calls = [];
  let tokenRequest = 0;
  let mutationRequest = 0;
  const { client } = loadClient(async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/device/request-token') {
      tokenRequest += 1;
      return response(200, {
        ok: true,
        data: {
          request_token: tokenRequest === 1 ? 'expired' : 'fresh',
        },
      });
    }

    mutationRequest += 1;
    if (mutationRequest === 1) {
      return response(403, {
        ok: false,
        error: { code: 'request_token_invalid' },
      });
    }
    return response(202, {
      ok: true,
      operation: {
        generation: 9,
        state: 'running',
        phase: 'connecting',
        error_code: null,
      },
    });
  });

  const result = await client.selectBms(7, 2);
  assert.equal(result.operation.generation, 9);
  assert.equal(tokenRequest, 2);
  assert.equal(mutationRequest, 2);

  const mutationCalls = calls.filter(
    call => call.url === '/api/device/bms/select',
  );
  assert.equal(
    mutationCalls[0].options.headers['X-WattPost-Request-Token'],
    'expired',
  );
  assert.equal(
    mutationCalls[1].options.headers['X-WattPost-Request-Token'],
    'fresh',
  );
  assert.deepEqual(JSON.parse(mutationCalls[1].options.body), {
    scan_generation: 7,
    candidate_id: 2,
  });
});

test('Wi-Fi configure keeps password in request body only', async () => {
  const calls = [];
  const { client } = loadClient(async (url, options) => {
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
        generation: 11,
        state: 'running',
        phase: 'connecting',
        error_code: null,
      },
    });
  });

  await client.configureWifi({
    scan_generation: 5,
    candidate_id: 1,
    password: 'secret-value',
  });

  const mutation = calls.at(-1);
  assert.equal(mutation.url, '/api/device/wifi/configure');
  assert.equal(mutation.url.includes('secret-value'), false);
  assert.equal(
    mutation.options.headers['X-WattPost-Request-Token'],
    'token',
  );
  assert.equal(
    JSON.parse(mutation.options.body).password,
    'secret-value',
  );
});


test('Recovery actions reuse tokenized Stage 1 device endpoints with exact confirmations', async () => {
  const calls = [];
  const { client } = loadClient(async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/device/request-token') {
      return response(200, {
        ok: true,
        data: { request_token: 'recovery-token' },
      });
    }
    return response(202, {
      ok: true,
      operation: {
        generation: 22,
        state: 'running',
        phase: 'restarting',
        error_code: null,
      },
    });
  });

  await client.reconnectWifi();
  await client.resetWifi();
  await client.reboot();
  await client.factoryReset();

  const mutations = calls.filter(call => call.options.method === 'POST');
  assert.deepEqual(
    mutations.map(call => call.url),
    [
      '/api/device/wifi/reconnect',
      '/api/device/wifi/reset',
      '/api/device/system/reboot',
      '/api/device/system/factory-reset',
    ],
  );
  assert.ok(
    mutations.every(
      call => call.options.headers['X-WattPost-Request-Token'] === 'recovery-token',
    ),
  );
  assert.deepEqual(JSON.parse(mutations[0].options.body), {});
  assert.deepEqual(JSON.parse(mutations[1].options.body), {
    confirm: 'reset_wifi',
  });
  assert.deepEqual(JSON.parse(mutations[2].options.body), {
    confirm: 'reboot',
  });
  assert.deepEqual(JSON.parse(mutations[3].options.body), {
    confirm: 'factory_reset',
  });
});

test('Wi-Fi-only setup completion uses the same protected local mutation', async () => {
  const calls = [];
  const { client } = loadClient(async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/device/request-token') {
      return response(200, { ok: true, data: { request_token: 'finish-token' } });
    }
    return response(200, {
      ok: true,
      data: { setup_completed_without_bms: true },
    });
  });

  const result = await client.finishWithoutBms();
  assert.equal(result.data.setup_completed_without_bms, true);
  assert.equal(calls[1].url, '/api/device/setup/finish');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.headers['X-WattPost-Request-Token'], 'finish-token');
  assert.deepEqual(JSON.parse(calls[1].options.body), {});
});
