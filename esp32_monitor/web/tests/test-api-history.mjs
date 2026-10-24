import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';


const code = await readFile(new URL('../js/api.js', import.meta.url), 'utf8');
const transportCode = await readFile(
  new URL('../js/transports/local-transport.js', import.meta.url),
  'utf8',
);

function createClient(fetchImpl, options = {}) {
  const context = {
    window: {},
    Date: class extends Date { static now() { return 2000000000000; } },
    fetch: fetchImpl,
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
  vm.createContext(context);
  vm.runInContext(transportCode, context);
  vm.runInContext(code, context);
  const identity = '0123456789abcdef0123456789abcdef:1';
  context.WattPostTransport.fetchHistoryContext = async () => identity;
  const page = context.WattPostTransport.fetchHistoryPage.bind(context.WattPostTransport);
  context.WattPostTransport.fetchHistoryPage = async (...args) => ({ ...(await page(...args)), context: identity });
  if (options.historyCache) {
    const cache = options.historyCache;
    cache.setContext = async () => false;
    cache.loadState = async () => ({ records: await cache.load(), checkpoint: null });
    cache.putPage = async (_ctx, records, _checkpoint, { cutoff }) => { await cache.put(records); await cache.prune(cutoff); };
  }
  return new context.ApiClientClass(options);
}

function deferredResponse(payload) {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {
    promise,
    resolve: () => resolve({ ok: true, json: async () => payload }),
  };
}

test('concurrent live requests share one network request', async () => {
  const deferred = deferredResponse({ online: true });
  let calls = 0;
  const client = createClient(() => {
    calls += 1;
    return deferred.promise;
  });

  const first = client.fetchLive();
  const second = client.fetchLive();
  assert.equal(calls, 1);
  deferred.resolve();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('concurrent history requests share one network request', async () => {
  const deferred = deferredResponse([]);
  let calls = 0;
  const client = createClient(() => {
    calls += 1;
    return deferred.promise;
  });

  const first = client.fetchHistory();
  const second = client.fetchHistory();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  deferred.resolve();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('history starts with 144 points, then fetches only newer records', async () => {
  const pages = [
    [{ t: 1200, value: 'old' }, { t: 600 }],
    [{ t: 1800 }, { t: 1200, value: 'new' }],
  ];
  const urls = [];
  const client = createClient(async url => {
    urls.push(url);
    return { ok: true, json: async () => pages.shift() };
  });

  await client.fetchHistory();
  assert.equal(urls[0], '/api/history?limit=144');
  assert.deepEqual(Array.from(client.historyData, row => row.t), [600, 1200]);
  assert.equal(client.historyState, 'FRESH');

  await client.fetchHistory();
  assert.equal(urls[1], '/api/history?after=1200&limit=144');
  assert.deepEqual(Array.from(client.historyData, row => row.t), [600, 1200, 1800]);
  assert.equal(client.historyData[1].value, 'new');
});

test('history failure keeps cached records and does not change BMS state', async () => {
  let fails = false;
  const client = createClient(async () => {
    if (fails) throw new Error('history unavailable');
    return { ok: true, json: async () => [{ t: 600 }] };
  });

  await client.fetchHistory();
  client.connectivityState = 'FRESH';
  fails = true;
  await client.fetchHistory();

  assert.deepEqual(Array.from(client.historyData, row => row.t), [600]);
  assert.equal(client.historyState, 'STALE');
  assert.equal(client.connectivityState, 'FRESH');
});

function recordsBefore(before, count) {
  return Array.from({ length: count }, (_, index) => ({
    t: before - (count - index) * 600,
  }));
}

test('loadHistoryPeriod fetches sequential older pages only until range is covered', async () => {
  const newest = 2000000000;
  const urls = [];
  let active = 0;
  let maxActive = 0;
  const client = createClient(async url => {
    urls.push(url);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    const before = Number(new URL(url, 'http://test').searchParams.get('before'));
    active -= 1;
    return { ok: true, json: async () => recordsBefore(before, 144) };
  });
  await client._verifyHistoryContext();
  client.historyData = recordsBefore(newest + 600, 144);
  client._headVerified = true;
  client._coverage = [[client.historyData[0].t, newest]];

  await client.loadHistoryPeriod(7);

  assert.equal(urls.length, 7);
  assert.equal(maxActive, 1);
  assert.ok(client.historyData[0].t <= newest - 7 * 86400);
  urls.forEach(url => assert.equal(new URL(url, 'http://test').searchParams.get('limit'), '144'));

  await client.loadHistoryPeriod(7);
  assert.equal(urls.length, 7, 'an already covered period must not load again');
});

test('loadHistoryPeriod remembers a short page as the start of stored history', async () => {
  const newest = 2000000000;
  let calls = 0;
  const client = createClient(async url => {
    calls += 1;
    const before = Number(new URL(url, 'http://test').searchParams.get('before'));
    return { ok: true, json: async () => recordsBefore(before, 20) };
  });
  await client._verifyHistoryContext();
  client.historyData = recordsBefore(newest + 600, 144);
  client._headVerified = true;
  client._coverage = [[client.historyData[0].t, newest]];

  await client.loadHistoryPeriod(14);
  await client.loadHistoryPeriod(14);

  assert.equal(calls, 1);
});

test('verified cached history is shown before the mandatory authoritative head refresh', async () => {
  const newest = 2000000000;
  const events = [];
  const putPages = [];
  const prunedBefore = [];
  let requestedUrl = null;
  const cache = {
    load: async () => [{ t: newest }],
    put: async records => putPages.push(records),
    prune: async timestamp => prunedBefore.push(timestamp),
  };
  const client = createClient(async url => {
    requestedUrl = url;
    return { ok: true, json: async () => [{ t: newest + 600 }] };
  }, { historyCache: cache });
  client.onHistory((records, state) => events.push({ count: records.length, state }));

  await client._startHistory();

  const deadline = Date.now() + 1200;
  while (!events.some(event => event.count === 1 && event.state === 'FRESH') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.deepEqual(events, [
    { count: 0, state: 'INITIAL_LOADING' },
    { count: 1, state: 'STALE' },
    { count: 1, state: 'FRESH' },
  ]);
  assert.equal(requestedUrl, '/api/history?limit=144');
  assert.deepEqual(putPages, [[{ t: newest + 600 }]]);
  assert.equal(prunedBefore.at(-1), newest - 14 * 86400);
});

test('IndexedDB failure falls back to network history without affecting BMS state', async () => {
  const cache = {
    load: async () => { throw new Error('cache unavailable'); },
    put: async () => { throw new Error('cache unavailable'); },
    prune: async () => { throw new Error('cache unavailable'); },
  };
  const client = createClient(async () => ({
    ok: true,
    json: async () => [{ t: 2000000000 }],
  }), { historyCache: cache });
  client.connectivityState = 'FRESH';

  await client._startHistory();

  assert.deepEqual(Array.from(client.historyData, row => row.t), [2000000000]);
  assert.equal(client.historyState, 'FRESH');
  assert.equal(client.connectivityState, 'FRESH');
});

test('stop prevents deferred cache restoration from starting a History request', async () => {
  let resolveCache;
  const cacheReady = new Promise(resolve => { resolveCache = resolve; });
  let historyCalls = 0;
  const client = createClient(async url => {
    if (url.startsWith('/api/history')) historyCalls += 1;
    return { ok: true, json: async () => url === '/api/live' ? { online: true } : [] };
  }, {
    historyCache: {
      load: async () => cacheReady,
      put: async () => {},
      prune: async () => {},
    },
  });

  client.start();
  client.stop();
  resolveCache([]);
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(historyCalls, 0);
});


test('initial history automatically retries transient failures without waiting for the 60s poll', async () => {
  let calls = 0;
  const loadingStates = [];
  const client = createClient(async () => {
    calls += 1;
    if (calls < 3) throw new Error('ESP still settling after reboot');
    return { ok: true, json: async () => [{ t: 2000000000 }] };
  }, { historyRetryDelaysMs: [0, 0, 0] });
  client.onHistoryLoading(state => loadingStates.push(state.active));

  await client._startHistory();

  assert.equal(calls, 3);
  assert.deepEqual(Array.from(client.historyData, row => row.t), [2000000000]);
  assert.equal(client.historyState, 'FRESH');
  assert.deepEqual(loadingStates, [false, true, false]);
});


test('stop cancels pending initial-history retries before another request starts', async () => {
  let calls = 0;
  const client = createClient(async () => {
    calls += 1;
    throw new Error('history unavailable');
  }, { historyRetryDelaysMs: [40, 40, 40] });

  const work = client._startHistory();
  await new Promise(resolve => setTimeout(resolve, 5));
  client.stop();
  await work;

  assert.equal(calls, 1);
  assert.equal(client.historyState, 'FAILED_NO_DATA');
});

test('Cloud history waits for ownership epoch validation before reading cached records', async () => {
  const events = [];
  let releaseEpochValidation;
  const transport = {
    getRuntimeContext: () => ({ mode: 'cloud', cloudId: 'shared-device' }),
    getCapabilities: () => ({ liveRead: true, historyRead: true }),
    getOwnershipEpoch: () => 8,
    fetchHistoryContext: async () => "cloud:shared-device:8",
    fetchLive: async () => ({ online: true, remote: true }),
    fetchHistoryPage: async () => {
      events.push('history');
      return [{ t: 1790247600, source: 'current owner' }];
    },
  };
  const historyCache = {
    setContext: async context => {
      events.push(`context:${context}`);
      await new Promise(resolve => { releaseEpochValidation = resolve; });
      return true;
    },
    loadState: async () => {
      events.push('cache');
      return { records: [], checkpoint: null };
    },
    put: async () => {},
    prune: async () => {},
  };
  const context = {
    window: {},
    WattPostTransport: transport,
    DataNormalizer: { normalizeLive: value => value, normalizeHistory: value => value },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    URLSearchParams,
    console,
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  const client = new context.ApiClientClass({ transport, historyCache });

  client.start();
  for (let attempt = 0; attempt < 20 && !releaseEpochValidation; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.deepEqual(events, ['context:cloud:shared-device:8']);

  releaseEpochValidation();
  const deadline = Date.now() + 1000;
  while (!events.includes('history') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  client.stop();

  assert.deepEqual(events, ['context:cloud:shared-device:8', 'cache', 'history']);
  assert.deepEqual(Array.from(client.historyData, record => record.source), ['current owner']);
});

test('Cloud history skips an unverified cache and does not write into its namespace', async () => {
  let cacheReads = 0;
  let cacheWrites = 0;
  const transport = {
    getRuntimeContext: () => ({ mode: 'cloud', cloudId: 'shared-device' }),
    getCapabilities: () => ({ liveRead: true, historyRead: true }),
    getOwnershipEpoch: () => null,
    fetchLive: async () => { throw new Error('Cloud owner epoch is unavailable'); },
    fetchHistoryPage: async () => [{ t: 1790247600, source: 'owner endpoint' }],
  };
  const historyCache = {
    setOwnershipEpoch: async () => { throw new Error('must not validate a missing epoch'); },
    load: async () => { cacheReads += 1; return [{ t: 1700000000, source: 'previous owner' }]; },
    put: async () => { cacheWrites += 1; },
    prune: async () => {},
  };
  const context = {
    window: {},
    WattPostTransport: transport,
    DataNormalizer: { normalizeLive: value => value, normalizeHistory: value => value },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    URLSearchParams,
    console,
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  const client = new context.ApiClientClass({ transport, historyCache });

  client.start();
  const deadline = Date.now() + 1000;
  while (client.historyState !== 'FRESH' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  client.stop();

  assert.equal(cacheReads, 0);
  assert.equal(cacheWrites, 0);
  assert.deepEqual(Array.from(client.historyData, record => record.source), ['owner endpoint']);
});
