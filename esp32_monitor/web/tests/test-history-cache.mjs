import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';


class MemoryDatabase {
  constructor(existingStore = false, existingRecords = []) {
    this.records = new Map();
    existingRecords.forEach(record => this.records.set(Number(record.t), structuredClone(record)));
    this.hasHistoryStore = existingStore;
    this.hasMetadataStore = false;
    this.metadata = new Map();
    this.deleteCount = 0;
    this.transactionCount = 0;
    if (existingStore) this.keyPath = 't';
    this.objectStoreNames = { contains: name => (
      name === 'history-v2' ? this.hasHistoryStore
        : name === 'metadata' ? this.hasMetadataStore
          : false
    ) };
  }

  deleteObjectStore(name) {
    this.deleteCount += 1;
    if (name === 'history-v2') {
      this.hasHistoryStore = false;
      this.records.clear();
    }
    if (name === 'metadata') {
      this.hasMetadataStore = false;
      this.metadata.clear();
    }
  }

  createObjectStore(name, options) {
    if (name === 'history-v2') {
      this.hasHistoryStore = true;
      this.keyPath = options.keyPath;
    }
    if (name === 'metadata') this.hasMetadataStore = true;
  }

  transaction(names) {
    this.transactionCount += 1;
    const transaction = {
      objectStore: name => this._store(name || (Array.isArray(names) ? names[0] : names)),
      abort: () => {
        transaction.error = new Error('transaction aborted');
        queueMicrotask(() => transaction.onabort?.());
      },
    };
    setTimeout(() => transaction.oncomplete?.(), 0);
    return transaction;
  }

  _store(name) {
    if (name === 'metadata') {
      return {
        get: key => {
          const request = {};
          queueMicrotask(() => {
            request.result = this.metadata.get(key);
            request.onsuccess?.();
          });
          return request;
        },
        put: (value, key) => this.metadata.set(key, structuredClone(value)),
      };
    }
    return {
      put: record => this.records.set(Number(record.t), structuredClone(record)),
      clear: () => this.records.clear(),
      getAll: () => {
        const request = {};
        queueMicrotask(() => {
          request.result = Array.from(this.records.values(), record => structuredClone(record));
          request.onsuccess?.();
        });
        return request;
      },
      openCursor: () => {
        const request = {};
        const keys = Array.from(this.records.keys()).sort((a, b) => a - b);
        let index = 0;
        const emit = () => {
          const key = keys[index++];
          request.result = key === undefined ? null : {
            key,
            delete: () => this.records.delete(key),
            continue: () => queueMicrotask(emit),
          };
          request.onsuccess?.();
        };
        queueMicrotask(emit);
        return request;
      },
    };
  }
}

class MemoryIndexedDB {
  constructor(options = {}) {
    this.database = null;
    this.databases = new Map();
    this.openedNames = [];
    this.existingStore = options.existingStore;
    this.existingRecords = options.existingRecords;
    this.fail = options.fail;
  }

  open(name) {
    const request = {};
    queueMicrotask(() => {
      if (this.fail) {
        request.error = new Error('IndexedDB unavailable');
        request.onerror?.();
        return;
      }
      this.openedNames.push(name);
      let database = this.databases.get(name);
      const isNew = !database;
      if (isNew) {
        database = new MemoryDatabase(
          name === 'wattpost-mini' && this.existingStore,
          name === 'wattpost-mini' ? (this.existingRecords || []) : [],
        );
        this.databases.set(name, database);
        if (!this.database) this.database = database;
      }
      request.result = database;
      if (isNew) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  }
}

async function loadCacheClass(factory) {
  const code = await readFile(new URL('../js/history-cache.js', import.meta.url), 'utf8');
  const context = { indexedDB: factory, setTimeout, clearTimeout, console };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context.HistoryCache;
}

test('HistoryCache preserves existing schema during upgrade, upserts, sorts, prunes and clears records', async () => {
  const factory = new MemoryIndexedDB({
    existingStore: true,
    existingRecords: [{ t: 50, value: 'kept from schema v1' }],
  });
  const HistoryCache = await loadCacheClass(factory);
  const cache = new HistoryCache(factory);

  assert.deepEqual(Array.from(await cache.load(), row => row.t), [50]);
  await cache.clear();
  const beforePageTransaction = factory.database.transactionCount;
  await cache.put([{ t: 300, value: 'old' }, { t: 100 }, { t: 200 }]);
  assert.equal(factory.database.deleteCount, 0);
  assert.equal(factory.database.keyPath, 't');
  assert.equal(factory.database.transactionCount, beforePageTransaction + 1, 'one page uses one transaction');
  assert.deepEqual(Array.from(await cache.load(), row => row.t), [100, 200, 300]);

  await cache.put([{ t: 300, value: 'new' }, { t: 400 }]);
  assert.equal((await cache.load()).find(row => row.t === 300).value, 'new');

  await cache.prune(200);
  assert.deepEqual(Array.from(await cache.load(), row => row.t), [200, 300, 400]);

  await cache.clear();
  assert.deepEqual(await cache.load(), []);
});

test('HistoryCache rejects cleanly when IndexedDB is unavailable', async () => {
  const factory = new MemoryIndexedDB({ fail: true });
  const HistoryCache = await loadCacheClass(factory);
  await assert.rejects(new HistoryCache(factory).load(), /IndexedDB unavailable/);
});

test('verified context discards unmarked local records and atomically saves coverage', async () => {
  const factory = new MemoryIndexedDB({ existingStore: true, existingRecords: [{ t: 100, source: 'unknown' }] });
  const HistoryCache = await loadCacheClass(factory);
  const cache = new HistoryCache(factory);
  assert.equal(await cache.setContext('device-a:1'), true);
  assert.deepEqual((await cache.loadState('device-a:1')).records, []);
  const checkpoint = { intervals: [[100, 200]], nextBefore: 100, reachedStart: false };
  const transactions = factory.database.transactionCount;
  await cache.putPage('device-a:1', [{ t: 150 }], checkpoint);
  assert.equal(factory.database.transactionCount, transactions + 1);
  const restored = await cache.loadState('device-a:1');
  assert.deepEqual(Array.from(restored.records, r => r.t), [150]);
  assert.equal(restored.checkpoint.nextBefore, 100);
  assert.equal(await cache.setContext('device-b:1'), true);
  assert.deepEqual((await cache.loadState('device-b:1')).records, []);
});

test('another tab changing the epoch rejects stale page writes and restoration', async () => {
  const factory = new MemoryIndexedDB();
  const HistoryCache = await loadCacheClass(factory);
  const first = new HistoryCache(factory), second = new HistoryCache(factory);
  await first.setContext('device:7');
  await second.setContext('device:8');
  await assert.rejects(first.putPage('device:7', [{ t: 150 }], {}), /context changed/);
  await assert.rejects(first.loadState('device:7'), /context changed/);
  await assert.rejects(first.setContext('device:7'), /context changed/);
  assert.deepEqual((await second.loadState('device:8')).records, []);
});

test('HistoryCache keeps local storage stable and isolates Cloud device namespaces', async () => {
  const factory = new MemoryIndexedDB();
  const HistoryCache = await loadCacheClass(factory);
  const localCache = new HistoryCache(factory, { mode: 'local', cloudId: null });
  const cloudA = new HistoryCache(factory, { mode: 'cloud', cloudId: 'device-a' });
  const cloudB = new HistoryCache(factory, { mode: 'cloud', cloudId: 'device/b' });

  assert.equal(localCache.databaseName, 'wattpost-mini');
  assert.notEqual(cloudA.databaseName, cloudB.databaseName);
  assert.match(cloudA.databaseName, /^wattpost-mini-cloud-[a-f0-9-]+$/);

  await localCache.put([{ t: 100, source: 'local' }]);
  await cloudA.put([{ t: 100, source: 'cloud-a' }]);
  await cloudB.put([{ t: 100, source: 'cloud-b' }]);

  assert.equal((await localCache.load())[0].source, 'local');
  assert.equal((await cloudA.load())[0].source, 'cloud-a');
  assert.equal((await cloudB.load())[0].source, 'cloud-b');
  assert.deepEqual(
    new Set(factory.openedNames),
    new Set([localCache.databaseName, cloudA.databaseName, cloudB.databaseName]),
  );
});

test('HistoryCache requires a Cloud ID for a Cloud namespace', async () => {
  const HistoryCache = await loadCacheClass(new MemoryIndexedDB());
  assert.throws(
    () => new HistoryCache(undefined, { mode: 'cloud', cloudId: null }),
    /requires a cloudId/,
  );
});

test('Cloud HistoryCache clears records on an unknown or changed ownership epoch', async () => {
  const factory = new MemoryIndexedDB();
  const HistoryCache = await loadCacheClass(factory);
  const cache = new HistoryCache(factory, { mode: 'cloud', cloudId: 'shared-device' });

  assert.equal(await cache.setOwnershipEpoch(7), true, 'missing epoch metadata invalidates legacy cache');
  await cache.put([{ t: 1790247000, value: 'owner 7' }]);
  assert.equal(await cache.setOwnershipEpoch(7), false, 'same owner epoch keeps its cache');
  assert.deepEqual(Array.from(await cache.load(), row => row.value), ['owner 7']);

  assert.equal(await cache.setOwnershipEpoch(8), true, 'new owner epoch clears the previous owner cache');
  assert.deepEqual(await cache.load(), []);
  await cache.put([{ t: 1790247600, value: 'owner 8' }]);
  assert.deepEqual(Array.from(await cache.load(), row => row.value), ['owner 8']);
});
