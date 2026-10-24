/* history-cache.js — Small native IndexedDB cache for normalized History v2 records. */

(function (global) {
  'use strict';

  const LOCAL_DATABASE_NAME = 'wattpost-mini';
  const STORE_NAME = 'history-v2';
  const META_STORE_NAME = 'metadata';
  // v3 closes old v2 handles via versionchange before context-protected writes.
  // The record store/format is preserved; old unguarded writers cannot pollute it.
  const DATABASE_VERSION = 3;
  const OWNERSHIP_EPOCH_KEY = 'ownership_epoch';
  const CONTEXT_KEY = 'history_context';
  const CHECKPOINT_KEY = 'coverage';

  function databaseNameFor(runtimeContext) {
    if (!runtimeContext || runtimeContext.mode === 'local') {
      return LOCAL_DATABASE_NAME;
    }
    if (runtimeContext.mode !== 'cloud' || typeof runtimeContext.cloudId !== 'string' || !runtimeContext.cloudId) {
      throw new TypeError('Cloud HistoryCache requires a cloudId');
    }
    const encodedId = Array.from(runtimeContext.cloudId, character =>
      character.codePointAt(0).toString(16),
    ).join('-');
    return `${LOCAL_DATABASE_NAME}-cloud-${encodedId}`;
  }

  class HistoryCache {
    constructor(factory = global.indexedDB, runtimeContext = { mode: 'local', cloudId: null }) {
      this.factory = factory;
      this.mode = runtimeContext?.mode || 'local';
      this.databaseName = databaseNameFor(runtimeContext);
      this._databasePromise = null;
    }

    _open() {
      if (!this.factory) return Promise.reject(new Error('IndexedDB unavailable'));
      if (this._databasePromise) return this._databasePromise;

      this._databasePromise = new Promise((resolve, reject) => {
        const request = this.factory.open(this.databaseName, DATABASE_VERSION);
        let blocked = false;
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            database.createObjectStore(STORE_NAME, { keyPath: 't' });
          }
          if (!database.objectStoreNames.contains(META_STORE_NAME)) {
            database.createObjectStore(META_STORE_NAME);
          }
        };
        request.onsuccess = () => {
          if (blocked) { request.result.close(); return; }
          request.result.onversionchange = () => request.result.close();
          resolve(request.result);
        };
        request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
        request.onblocked = () => {
          blocked = true;
          reject(new Error('IndexedDB upgrade blocked by another tab'));
        };
      });
      return this._databasePromise;
    }

    async load() {
      const database = await this._open();
      return new Promise((resolve, reject) => {
        const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
        request.onsuccess = () => resolve(request.result
          .filter(record => record && Number.isFinite(Number(record.t)))
          .sort((a, b) => Number(a.t) - Number(b.t)));
        request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
      });
    }

    async put(records) {
      const validRecords = Array.isArray(records)
        ? records.filter(record => record && Number.isFinite(Number(record.t)))
        : [];
      if (!validRecords.length) return;
      const database = await this._open();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        validRecords.forEach(record => store.put({ ...record, t: Number(record.t) }));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB write failed'));
        transaction.onabort = transaction.onerror;
      });
    }

    async prune(beforeTimestamp) {
      if (!Number.isFinite(Number(beforeTimestamp))) return;
      const database = await this._open();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const request = transaction.objectStore(STORE_NAME).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if (Number(cursor.key) < Number(beforeTimestamp)) cursor.delete();
          cursor.continue();
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB prune failed'));
        transaction.onabort = transaction.onerror;
      });
    }

    async clear() {
      const database = await this._open();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_NAME, META_STORE_NAME], 'readwrite');
        transaction.objectStore(STORE_NAME).clear();
        transaction.objectStore(META_STORE_NAME).put(null, CHECKPOINT_KEY);
        transaction.objectStore(META_STORE_NAME).put(null, CONTEXT_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB clear failed'));
        transaction.onabort = transaction.onerror;
      });
    }

    async setContext(context) {
      if (typeof context !== 'string' || !context) throw new TypeError('Invalid history context');
      const database = await this._open();
      return new Promise((resolve, reject) => {
        const tx = database.transaction([STORE_NAME, META_STORE_NAME], 'readwrite');
        const meta = tx.objectStore(META_STORE_NAME);
        const request = meta.get(CONTEXT_KEY);
        let changed = false;
        let conflict = false;
        request.onsuccess = () => {
          const old = request.result;
          const split = value => { const i = value.lastIndexOf(':'); return [value.slice(0, i), Number(value.slice(i + 1))]; };
          if (typeof old === 'string') {
            const [oldId, oldEpoch] = split(old);
            const [id, epoch] = split(context);
            if (id === oldId && epoch < oldEpoch) { conflict = true; tx.abort(); return; }
          }
          changed = old !== context;
          if (changed) {
            // Preserve an existing Cloud epoch cache only if that epoch was
            // already verified. Unmarked local data cannot be attributed.
            const legacy = meta.get(OWNERSHIP_EPOCH_KEY);
            legacy.onsuccess = () => {
              const knownCloud = !old && this.mode === 'cloud' &&
                legacy.result === Number(context.slice(context.lastIndexOf(':') + 1));
              if (!knownCloud) tx.objectStore(STORE_NAME).clear();
              meta.put(context, CONTEXT_KEY);
              meta.put(null, CHECKPOINT_KEY);
            };
            legacy.onerror = () => tx.abort();
          }
        };
        request.onerror = () => tx.abort();
        tx.oncomplete = () => resolve(changed);
        tx.onerror = tx.onabort = () => reject(new Error(conflict ? 'History context changed' : 'IndexedDB context failed'));
      });
    }

    async loadState(context) {
      const database = await this._open();
      return new Promise((resolve, reject) => {
        const tx = database.transaction([STORE_NAME, META_STORE_NAME], 'readonly');
        const meta = tx.objectStore(META_STORE_NAME);
        const identity = meta.get(CONTEXT_KEY);
        const checkpoint = meta.get(CHECKPOINT_KEY);
        const rows = tx.objectStore(STORE_NAME).getAll();
        tx.oncomplete = () => identity.result === context
          ? resolve({ records: rows.result || [], checkpoint: checkpoint.result || null })
          : reject(new Error('History context changed'));
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('IndexedDB read failed'));
      });
    }

    async putPage(context, records, checkpoint, { replace = false, cutoff = 0 } = {}) {
      const database = await this._open();
      return new Promise((resolve, reject) => {
        const tx = database.transaction([STORE_NAME, META_STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const meta = tx.objectStore(META_STORE_NAME);
        const request = meta.get(CONTEXT_KEY);
        let conflict = false;
        request.onsuccess = () => {
          if (request.result !== context) { conflict = true; tx.abort(); return; }
          if (replace) store.clear();
          records.forEach(record => store.put({ ...record, t: Number(record.t) }));
          meta.put(checkpoint, CHECKPOINT_KEY);
          if (cutoff > 0) {
            const cursorRequest = store.openCursor();
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor) return;
              if (Number(cursor.key) < cutoff) cursor.delete();
              cursor.continue();
            };
          }
        };
        request.onerror = () => tx.abort();
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(new Error(conflict ? 'History context changed' : 'IndexedDB page failed'));
      });
    }

    async setOwnershipEpoch(epoch) {
      if (this.mode !== 'cloud') throw new TypeError('Ownership epoch is only valid for Cloud HistoryCache');
      if (!Number.isInteger(epoch) || epoch < 1 || epoch > 0xffffffff) {
        throw new TypeError('Invalid Cloud ownership epoch');
      }
      const database = await this._open();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_NAME, META_STORE_NAME], 'readwrite');
        const records = transaction.objectStore(STORE_NAME);
        const metadata = transaction.objectStore(META_STORE_NAME);
        const request = metadata.get(OWNERSHIP_EPOCH_KEY);
        let changed = false;
        request.onsuccess = () => {
          changed = request.result !== epoch;
          if (changed) {
            records.clear();
            metadata.put(epoch, OWNERSHIP_EPOCH_KEY);
          }
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve(changed);
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB epoch validation failed'));
        transaction.onabort = () => reject(transaction.error || request.error || new Error('IndexedDB epoch validation aborted'));
      });
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { HistoryCache };
  global.HistoryCache = HistoryCache;
})(typeof globalThis !== 'undefined' ? globalThis : window);
