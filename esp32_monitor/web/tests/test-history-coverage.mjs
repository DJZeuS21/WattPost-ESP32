import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code = fs.readFileSync(new URL('../js/api.js', import.meta.url), 'utf8');
const NOW = Math.floor(Date.now() / 1000);
const ID = '0123456789abcdef0123456789abcdef:1';

function makeCache() {
  let identity, rows = [], saved = null;
  return {
    setContext: async value => { if (value !== identity) { rows = []; saved = null; } identity = value; },
    loadState: async value => { assert.equal(value, identity); return { records: structuredClone(rows), checkpoint: structuredClone(saved) }; },
    putPage: async (value, records, checkpoint, { replace }) => {
      assert.equal(value, identity);
      const merged = new Map((replace ? [] : rows).map(r => [r.t, r]));
      records.forEach(r => merged.set(r.t, r));
      rows = [...merged.values()]; saved = structuredClone(checkpoint);
    },
    clear: async () => { rows = []; saved = null; },
  };
}

function makeClient(options = {}) {
  const requests = [];
  const records = options.records || Array.from({ length: 1988 }, (_, i) => ({ t: NOW - (1987 - i) * 600, v: 26, a: -2, s: 80 }));
  let currentContext = ID, failAt = 0;
  const transport = {
    getRuntimeContext: () => ({ mode: 'local' }), getCapabilities: () => ({ historyRead: true, liveRead: true }),
    fetchHistoryContext: async () => currentContext,
    fetchLive: async () => ({ online: true }),
    factoryResetDevice: async () => { currentContext = ID.replace(':1', ':2'); return { ok: true }; },
    fetchHistoryPage: async (query, request) => {
      requests.push(query.toString());
      if (failAt && requests.length === failAt) throw new Error('interrupted');
      const before = Number(query.get('before') || Infinity), after = Number(query.get('after') || 0);
      let page = records.filter(r => r.t < before && r.t > after);
      page = query.has('after') ? page.slice(0, 144) : page.slice(-144);
      if (options.page) return options.page(query, request, page, currentContext);
      return { records: page, context: currentContext };
    },
  };
  const document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const ctx = { window: {}, document, WattPostTransport: transport,
    DataNormalizer: { normalizeHistory: x => x, normalizeLive: x => x },
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController, URLSearchParams, console,
    Date: class extends Date { static now() { return NOW * 1000; } } };
  vm.runInNewContext(code, ctx);
  const client = new ctx.ApiClientClass({ transport, historyCache: options.cache ?? makeCache() });
  return { client, requests, records, document, fail: index => { failAt = index; }, context: value => { currentContext = value; } };
}

async function until(check) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(check(), 'condition did not settle');
}

test('empty authoritative head clears verified cache; empty incremental page preserves data', async () => {
  const cache = makeCache();
  await cache.setContext(ID);
  await cache.putPage(ID, [{ t: NOW - 600 }], { intervals: [[NOW - 600, NOW]] }, { replace: true });
  const { client } = makeClient({ cache, records: [] });
  await client._startHistory();
  assert.equal(client.historyData.length, 0);
  assert.equal((await cache.loadState(ID)).records.length, 0);
  const populated = makeClient({ records: [{ t: NOW - 600 }] }).client;
  await populated.fetchHistory(); await populated.fetchHistory();
  assert.equal(populated.historyData.length, 1);
});

test('a new full head rechecks previously empty history without trusting its old exhaustion', async () => {
  const { client, records } = makeClient();
  await client._verifyHistoryContext();
  client._headVerified = false;
  client._historyReachedStart = true;
  client._sourceStart = null;
  client._coverage = [[0, NOW]];
  await client.fetchHistory();
  assert.equal(client.getHistoryRangeStatus(NOW - 14 * 86400, NOW).covered, false);
  await client.ensureHistoryRange(NOW - 14 * 86400, NOW);
  assert.equal(client.historyData.length, records.length);
});

test('legacy firmware never restores unverified persistent records', async () => {
  const { client } = makeClient({ records: [{ t: NOW }], cache: {
    loadState: async () => assert.fail('unverified cache was read'),
    putPage: async () => assert.fail('unverified cache was written'),
  }, page: async (_query, _request, rows) => ({ records: rows, context: null }) });
  client.transport.fetchHistoryContext = async () => null;
  await client._startHistory();
  assert.equal(client.historyData.length, 1);
  assert.equal(client.historyState, 'FRESH');
});

test('partial failure persists coverage and a restart resumes before the confirmed cursor', async () => {
  const cache = makeCache();
  const first = makeClient({ cache }); first.fail(3);
  await first.client.ensureHistoryRange(NOW - 14 * 86400, NOW);
  assert.equal(first.client.historyData.length, 288);
  assert.equal(first.client._historyLoadingState.outcome, 'failed');
  assert.equal(first.client.getHistoryRangeStatus(NOW - 14 * 86400, NOW).covered, false);
  const saved = await cache.loadState(ID);
  const cursor = saved.checkpoint.nextBefore;
  const resumed = makeClient({ cache });
  await resumed.client._startHistory(); // Only the tail is refreshed on entry.
  await resumed.client.ensureHistoryRange(NOW - 14 * 86400, NOW);
  assert.equal(new URLSearchParams(resumed.requests[1]).get('before'), String(cursor));
  assert.equal(resumed.client.historyData.length, 1988);
  assert.equal(resumed.client._historyLoadingState.outcome, 'limited');
});

test('coverage holes are loaded even when the first and last cached records span the range', async () => {
  const { client, requests, records } = makeClient();
  await client._verifyHistoryContext();
  client._headVerified = true;
  client.historyData = [records[100], records.at(-1)];
  client._coverage = [[records[100].t, records[100].t], [records.at(-1).t, NOW]];
  await client.ensureHistoryRange(records[100].t, NOW);
  assert.ok(requests.length > 0);
  assert.equal(client.getHistoryRangeStatus(records[100].t, NOW).covered, true);
});

test('different simultaneous cursors get distinct responses', async () => {
  const { client, requests } = makeClient();
  await client._verifyHistoryContext();
  const first = client._fetchHistoryPage(new URLSearchParams({ before: String(NOW), limit: '144' }));
  const second = client._fetchHistoryPage(new URLSearchParams({ before: String(NOW - 86400), limit: '144' }));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(requests.length, 2);
  assert.ok(a.at(-1).t > b.at(-1).t);
});

test('background loading waits for live cycles and pauses without losing confirmed coverage', async () => {
  const { client, requests, document } = makeClient();
  client._running = true; client._liveCycle = 1; client.connectivityState = 'FRESH';
  const work = client.ensureHistoryRange(NOW - 14 * 86400, NOW);
  await until(() => requests.length === 1 && client._headVerified);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(requests.length, 1, 'no second page before live gets its turn');
  await client.fetchLive();
  await until(() => requests.length === 2 && client.historyData.length === 288);
  document.hidden = true; client._handleVisibilityChange();
  await work;
  assert.equal(client._historyLoadingState.outcome, 'paused');
  assert.equal(client.historyData.length, 288);
  assert.equal(requests.length, 2);
  client.stop();
});

test('successful factory reset and context change clear records and coverage', async () => {
  const { client, context } = makeClient({ records: [{ t: NOW }] });
  await client.fetchHistory();
  assert.equal(client.historyData.length, 1);
  context('fedcba9876543210fedcba9876543210:1');
  await client._verifyHistoryContext();
  assert.equal(client.historyData.length, 0);
  assert.equal(client._coverage.length, 0);
  await client.fetchHistory();
  await client.factoryResetDevice();
  assert.equal(client.historyData.length, 0);
  assert.equal(client._coverage.length, 0);
});

test('deferred cache restoration cannot restore the previous device after context changes', async () => {
  let release;
  const cache = makeCache();
  cache.loadState = async () => new Promise(resolve => { release = resolve; });
  const { client } = makeClient({ cache });
  await client._verifyHistoryContext();
  const restore = client._restoreHistoryCache();
  await until(() => Boolean(release));
  await client._adoptHistoryContext('fedcba9876543210fedcba9876543210:2');
  release({ records: [{ t: NOW, source: 'previous device' }], checkpoint: { intervals: [[0, NOW]] } });
  await restore;
  assert.equal(client.historyData.length, 0);
  assert.equal(client._coverage.length, 0);
});

test('stop cancels context verification without starting a history request', async () => {
  const { client, requests } = makeClient();
  let aborted = false;
  client.transport.fetchHistoryContext = async ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); });
  });
  const work = client.fetchHistory();
  client.stop(); await work;
  assert.equal(aborted, true);
  assert.equal(requests.length, 0);
});

test('a stamped head can verify and resume its cache when device status is unavailable', async () => {
  const cache = makeCache();
  const first = makeClient({ cache }); first.fail(3);
  await first.client.ensureHistoryRange(NOW - 14 * 86400, NOW);
  const cursor = (await cache.loadState(ID)).checkpoint.nextBefore;
  const resumed = makeClient({ cache });
  resumed.client.transport.fetchHistoryContext = async () => { throw new Error('status unavailable'); };
  await resumed.client._startHistory();
  assert.equal(resumed.client.historyData.length, 288);
  await resumed.client.ensureHistoryRange(NOW - 14 * 86400, NOW);
  assert.equal(new URLSearchParams(resumed.requests[1]).get('before'), String(cursor));
});

test('live polls do not restart the loading indicator for confirmed coverage', async () => {
  const { client } = makeClient({ records: [{ t: NOW }] });
  await client.fetchHistory();
  client._historyDemand = { from: NOW - 86400, to: NOW, days: 1 };
  client._running = true; client.connectivityState = 'FRESH';
  const events = [];
  client.onHistoryLoading(state => events.push(state)); events.length = 0;
  await client.fetchLive(); await client.fetchLive();
  assert.equal(events.length, 0);
  assert.equal(client._rangePromise, null);
  client.stop();
});

test('successful tail refresh cannot hide an overlapping failed range load', async () => {
  let beforeCount = 0, rejectPage;
  const { client } = makeClient({ page: async (query, _request, rows, context) => {
    if (query.has('before') && ++beforeCount === 2) {
      return new Promise((_resolve, reject) => { rejectPage = reject; });
    }
    return { records: rows, context };
  } });
  await client.fetchHistory();
  const period = client.ensureHistoryRange(NOW - 14 * 86400, NOW);
  await until(() => Boolean(rejectPage));
  const refresh = client.fetchHistory();
  await until(() => client._historyLoadingOps === 2);
  rejectPage(new Error('older page unavailable'));
  await Promise.all([period, refresh]);
  assert.equal(client.historyState, 'FRESH', 'tail is fresh while the older range is incomplete');
  assert.equal(client._historyLoadingState.outcome, 'failed');
  assert.equal(client.getHistoryRangeStatus(NOW - 14 * 86400, NOW).covered, false);
});

test('factory reset cancels a delayed context response from the previous epoch', async () => {
  const { client } = makeClient({ records: [{ t: NOW }] });
  await client.fetchHistory();
  let release;
  client.transport.fetchHistoryContext = async () => new Promise(resolve => { release = resolve; });
  const verification = client._verifyHistoryContext();
  await until(() => Boolean(release));
  await client.factoryResetDevice();
  release(ID); await verification;
  assert.equal(client._historyContextReady, false);
  assert.equal(client.historyData.length, 0);
});
