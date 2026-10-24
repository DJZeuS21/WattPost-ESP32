/* api.js — Centralized polling coordinator & 7-state connectivity machine.
 * Universal polling manager for live BMS telemetry and 14-day history. */

(function (global) {
  'use strict';

  const CONNECTIVITY_STATES = {
    INITIAL_LOADING: 'INITIAL_LOADING',
    FRESH: 'FRESH',
    TRANSIENT_FAILURE: 'TRANSIENT_FAILURE',
    STALE: 'STALE',
    PROLONGED_OFFLINE: 'PROLONGED_OFFLINE',
    BMS_OFFLINE: 'BMS_OFFLINE',
    RECOVERY: 'RECOVERY',
  };

  const LIVE_INTERVAL_MS = 2000;
  const HISTORY_INTERVAL_MS = 60000;
  const LIVE_TIMEOUT_MS = 3500;
  const HISTORY_TIMEOUT_MS = 8000;
  const INITIAL_HISTORY_RETRY_DELAYS_MS = [2000, 5000, 10000];
  const STALE_THRESHOLD_MS = 8000;
  const OFFLINE_THRESHOLD_MS = 16000;

  class DeviceApiError extends Error {
    constructor(code, status, payload) {
      super(code || 'request_failed');
      this.name = 'DeviceApiError';
      this.code = code || 'request_failed';
      this.status = Number(status) || 0;
      this.payload = payload || null;
    }
  }

  class ApiClient {
    constructor(options = {}) {
      this.transport = options.transport || global.WattPostTransport;
      if (!this.transport) throw new Error('WattPost transport is required');
      this.runtimeContext = this.transport.getRuntimeContext();
      this.capabilities = Object.freeze({ ...this.transport.getCapabilities() });
      this.historyCache = options.historyCache !== undefined
        ? options.historyCache
        : (global.HistoryCache
          ? new global.HistoryCache(undefined, this.runtimeContext)
          : null);
      this.historyRetryDelaysMs = Array.isArray(options.historyRetryDelaysMs)
        ? options.historyRetryDelaysMs
        : INITIAL_HISTORY_RETRY_DELAYS_MS;

      this.connectivityState = CONNECTIVITY_STATES.INITIAL_LOADING;
      this.historyState = CONNECTIVITY_STATES.INITIAL_LOADING;
      this.liveData = null;
      this.historyData = [];

      this.settingsData = null;
      this.settingsState = CONNECTIVITY_STATES.INITIAL_LOADING;

      this._liveGeneration = 0;
      this._historyGeneration = 0;
      this._lifecycleGeneration = 0;

      this._lastLiveSuccessTimestamp = 0;
      this._lastHistorySuccessTimestamp = 0;
      this._historyReachedStart = false;
      this._historyCacheLoadPromise = null;
      this._historyContext = null;
      this._historyContextReady = false;
      this._historyContextPromise = null;
      this._historyContextAbortController = null;
      this._headVerified = false;
      this._coverage = [];
      this._sourceStart = null;
      this._historyDemand = null;
      this._rangePromise = null;
      this._historyView = 'dashboard';
      this._running = false;
      this._liveCycle = 0;
      this._historyLiveCycle = -1;
      this._liveTurnWaiters = new Set();
      this._historyPauseGeneration = 0;

      this._liveTimer = null;
      this._historyTimer = null;

      this._isFetchingLive = false;
      this._activeLivePromise = null;
      this._isFetchingHistory = false;
      this._activeHistoryPromise = null;
      this._isFetchingSettings = false;
      this._activeSettingsPromise = null;

      this._liveAbortController = null;
      this._historyAbortController = null;
      this._settingsAbortController = null;

      this._liveListeners = new Set();
      this._historyListeners = new Set();
      this._historyLoadingListeners = new Set();
      this._settingsListeners = new Set();
      this._stateListeners = new Set();

      // Loading indicator state for the history view (portioned/page loading).
      // ops is a counter: fetchHistory (interval) and loadHistoryPeriod (user
      // picking a longer range) may legitimately overlap.
      this._historyLoadingOps = 0;
      this._historyLoadingState = { active: false, phase: null, days: 0, pages: 0, records: 0 };
      // Coalescing of history-driven UI refreshes while a page-by-page load
      // is running (see _notifyHistory) — without it every page re-renders
      // the views and the whole interface visibly flickers.
      this._historyUiDirty = false;
      this._historyUiThrottleTimer = null;

      this._boundVisibilityHandler = this._handleVisibilityChange.bind(this);
    }

    onLive(callback) {
      this._liveListeners.add(callback);
      if (this.liveData) callback(this.liveData, this.connectivityState);
      return () => this._liveListeners.delete(callback);
    }

    onHistory(callback) {
      this._historyListeners.add(callback);
      callback(this.historyData, this.historyState);
      return () => this._historyListeners.delete(callback);
    }

    /** Subscribe to history loading progress. Fires immediately with the
     *  current state and on every change:
     *  { active, phase: 'initial'|'incremental'|'period', days, pages, records } */
    onHistoryLoading(callback) {
      this._historyLoadingListeners.add(callback);
      callback({ ...this._historyLoadingState });
      return () => this._historyLoadingListeners.delete(callback);
    }

    _beginHistoryLoading(phase, days = 0) {
      if (this._historyLoadingOps === 0) this._historyLoadingOutcome = 'complete';
      this._historyLoadingOps++;
      // Nested operations must not clobber the outer operation's progress:
      // loadHistoryPeriod() awaits fetchHistory() when the dataset is still
      // empty, and that inner 'initial' begin() used to reset phase/pages,
      // leaving the chip stuck on «Завантаження історії…» with no progress
      // and no completion flash. Keep the running 'period' state alive.
      const keepOuterState =
        this._historyLoadingOps > 1 &&
        this._historyLoadingState.phase === 'period' &&
        phase !== 'period';
      if (!keepOuterState) {
        this._historyLoadingState = {
          active: true,
          phase,
          days: Number(days) || 0,
          pages: 0,
          records: this.historyData.length,
        };
      }
      this._notifyHistoryLoading();
    }

    _endHistoryLoading(outcome = 'complete') {
      const priority = { complete: 0, limited: 1, paused: 2, failed: 3 };
      if ((priority[outcome] || 0) > (priority[this._historyLoadingOutcome] || 0)) {
        this._historyLoadingOutcome = outcome;
      }
      this._historyLoadingOps = Math.max(0, this._historyLoadingOps - 1);
      if (this._historyLoadingOps === 0) {
        this._historyLoadingState = {
          ...this._historyLoadingState, active: false, outcome: this._historyLoadingOutcome || outcome,
          records: this.historyData.length,
        };
        this._notifyHistoryLoading();
      }
    }

    _notifyHistoryLoading() {
      const snapshot = { ...this._historyLoadingState };
      this._historyLoadingListeners.forEach(cb => {
        try { cb(snapshot); } catch (e) { console.error('Error in history-loading listener:', e); }
      });
    }

    onSettings(callback) {
      this._settingsListeners.add(callback);
      try {
        callback(this.settingsData, this.settingsState);
      } catch (e) {
        console.error('Error in settings listener:', e);
      }
      return () => this._settingsListeners.delete(callback);
    }

    onStateChange(callback) {
      this._stateListeners.add(callback);
      callback(this.connectivityState);
      return () => this._stateListeners.delete(callback);
    }

    getCapabilities() {
      return { ...this.capabilities };
    }

    fetchAccountContext() {
      if (typeof this.transport.fetchAccountContext !== 'function') {
        return Promise.resolve(null);
      }
      return this.transport.fetchAccountContext();
    }

    fetchOwnedDevices() {
      if (typeof this.transport.fetchOwnedDevices !== 'function') {
        return Promise.reject(new DeviceApiError('capability_unavailable', 0, null));
      }
      return this.transport.fetchOwnedDevices();
    }

    logoutAccount() {
      if (typeof this.transport.logoutAccount !== 'function') {
        return Promise.reject(new DeviceApiError('capability_unavailable', 0, null));
      }
      return this.transport.logoutAccount();
    }

    start() {
      this._running = true;
      const lifecycleGeneration = ++this._lifecycleGeneration;
      const initialLive = this.fetchLive();
      if (this.capabilities.historyRead) {
        initialLive.then(() => this._startHistory(lifecycleGeneration)).then(() => this._resumeHistoryDemand());
      }

      if (this._liveTimer) clearInterval(this._liveTimer);
      if (this._historyTimer) clearInterval(this._historyTimer);

      this._liveTimer = setInterval(() => {
        if (typeof document === 'undefined' || !document.hidden) this.fetchLive();
      }, LIVE_INTERVAL_MS);

      this._historyTimer = this.capabilities.historyRead
        ? setInterval(() => {
          if (typeof document === 'undefined' || !document.hidden) this.fetchHistory();
        }, HISTORY_INTERVAL_MS)
        : null;

      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', this._boundVisibilityHandler);
      }
    }

    stop() {
      this._running = false;
      this._historyDemand = null;
      ++this._historyGeneration;
      this._wakeLiveTurn();
      this._historyContextAbortController?.abort();
      ++this._lifecycleGeneration;
      if (this._liveTimer) clearInterval(this._liveTimer);
      if (this._historyTimer) clearInterval(this._historyTimer);
      this._liveTimer = null;
      this._historyTimer = null;

      if (this._liveAbortController) {
        this._liveAbortController.abort();
        this._liveAbortController = null;
      }
      if (this._historyAbortController) {
        this._historyAbortController.abort();
        this._historyAbortController = null;
      }
      if (this._settingsAbortController) {
        this._settingsAbortController.abort();
        this._settingsAbortController = null;
      }

      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this._boundVisibilityHandler);
      }
    }

    _handleVisibilityChange() {
      if (typeof document !== 'undefined' && document.hidden) {
        this._pauseHistoryRange();
        return;
      }
      if (typeof document !== 'undefined' && !document.hidden) {
        this.fetchLive();
        if (this.capabilities.historyRead && Date.now() - this._lastHistorySuccessTimestamp > HISTORY_INTERVAL_MS) {
          this.fetchHistory();
        }
        this.setHistoryView(this._historyView);
      }
    }

    async _startHistory(lifecycleGeneration = this._lifecycleGeneration, options = {}) {
      if (lifecycleGeneration !== this._lifecycleGeneration) return null;
      await this._verifyHistoryContext();
      if (options.restoreCache !== false && this._historyContextReady) await this._restoreHistoryCache();
      if (lifecycleGeneration !== this._lifecycleGeneration) return null;

      // Cached data can be shown immediately; its tail refresh follows the normal
      // incremental path. With an empty cache, keep one continuous initial-loading
      // state across short retries so a transient post-reboot miss does not leave
      // history-driven charts blank until the 60 s background interval.
      if (this.historyData.length) return this.fetchHistory({ skipContext: true });

      this._beginHistoryLoading('initial');
      try {
        let result = await this.fetchHistory({ manageLoading: false, skipContext: true });
        if (result !== null || lifecycleGeneration !== this._lifecycleGeneration) return result;

        for (const delayMs of this.historyRetryDelaysMs) {
          await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(delayMs) || 0)));
          if (lifecycleGeneration !== this._lifecycleGeneration) return null;

          result = await this.fetchHistory({ manageLoading: false, skipContext: true });
          if (result !== null) return result;
        }
        return null;
      } finally {
        this._endHistoryLoading(this.historyState === 'FRESH' ? 'complete' : 'failed');
      }
    }

    _restoreHistoryCache() {
      if (this._historyCacheLoadPromise) return this._historyCacheLoadPromise;
      this._historyCacheLoadPromise = (async () => {
        if (!this.historyCache || !this._historyContextReady || !this.historyCache.loadState) return;
        try {
          const context = this._historyContext, generation = this._historyGeneration;
          const { records: cached, checkpoint } = await this.historyCache.loadState(context);
          if (context !== this._historyContext || generation !== this._historyGeneration) return;
          if (checkpoint) {
            this._coverage = this._mergeCoverage(checkpoint.intervals || []);
            this._historyReachedStart = checkpoint.reachedStart === true;
            this._sourceStart = checkpoint.sourceStart ?? null;
          }
          if (!cached.length) return;
          this.historyData = this._mergeHistory(cached);
          const cutoff = Math.floor(Date.now() / 1000) - 14 * 86400;
          this.historyData = this.historyData.filter(record => Number(record.t) >= cutoff);
          this._setHistoryState(CONNECTIVITY_STATES.STALE);
          this._notifyHistory(this.historyData);
        } catch (_error) {}
      })();
      return this._historyCacheLoadPromise;
    }

    _setConnectivityState(newState) {
      if (this.connectivityState !== newState) {
        this.connectivityState = newState;
        this._stateListeners.forEach(cb => {
          try { cb(newState); } catch (e) { console.error('Error in state listener:', e); }
        });
        if (this.liveData) {
          this._notifyLive(this.liveData);
        }
      }
    }

    async fetchLive() {
      if (this._isFetchingLive && this._activeLivePromise) {
        return this._activeLivePromise;
      }
      this._isFetchingLive = true;
      const generation = ++this._liveGeneration;
      this._activeLivePromise = this._doFetchLive(generation);
      try {
        return await this._activeLivePromise;
      } finally {
        this._isFetchingLive = false;
        this._activeLivePromise = null;
        ++this._liveCycle;
        this._wakeLiveTurn();
        if (this._running && this._historyReloadNeeded) {
          this._historyReloadNeeded = false;
          this._startHistory().then(() => this._resumeHistoryDemand());
        }
        this._resumeHistoryDemand();
      }
    }

    async _doFetchLive(generation) {
      this._liveAbortController = new AbortController();
      const timeoutId = setTimeout(() => {
        if (this._liveAbortController) this._liveAbortController.abort();
      }, LIVE_TIMEOUT_MS);

      try {
        const raw = await this.transport.fetchLive({
          signal: this._liveAbortController.signal,
        });
        clearTimeout(timeoutId);

        if (generation !== this._liveGeneration) return;
        const normalizer = DataNormalizer || (typeof globalThis !== 'undefined' ? globalThis.DataNormalizer : null);
        const normalized = normalizer.normalizeLive(raw);
        if (normalized.remote === true && this._historyContext !== null) {
          const epoch = this.transport.getOwnershipEpoch?.();
          if (Number.isInteger(epoch) && this._historyContext !== `cloud:${this.runtimeContext.cloudId}:${epoch}`) {
            this._invalidateHistory();
            this._historyContext = null;
            this._historyReloadNeeded = true;
          }
        }

        if (!normalized.online) {
          this._setConnectivityState(CONNECTIVITY_STATES.BMS_OFFLINE);
          this.liveData = normalized;
          this._notifyLive(normalized);
          return normalized;
        }

        const wasOffline = this.connectivityState === CONNECTIVITY_STATES.PROLONGED_OFFLINE ||
                            this.connectivityState === CONNECTIVITY_STATES.BMS_OFFLINE ||
                            this.connectivityState === CONNECTIVITY_STATES.STALE;

        this._lastLiveSuccessTimestamp = Date.now();
        this._setConnectivityState(wasOffline ? CONNECTIVITY_STATES.RECOVERY : CONNECTIVITY_STATES.FRESH);
        if (wasOffline) {
          setTimeout(() => {
            if (this.connectivityState === CONNECTIVITY_STATES.RECOVERY) {
              this._setConnectivityState(CONNECTIVITY_STATES.FRESH);
            }
          }, 1000);
        }

        this.liveData = normalized;
        this._notifyLive(normalized);
        return normalized;
      } catch (err) {
        this._pauseHistoryRange();
        if (err?.status === 401 || err?.status === 404) this._invalidateHistory();
        clearTimeout(timeoutId);
        if (generation !== this._liveGeneration) return null;

        const timeSinceSuccess = Date.now() - this._lastLiveSuccessTimestamp;
        if (this._lastLiveSuccessTimestamp === 0) {
          this._setConnectivityState(CONNECTIVITY_STATES.PROLONGED_OFFLINE);
          const offlineState = { online: false, state: 'offline', message: 'Немає зв’язку з сервером' };
          this.liveData = offlineState;
          this._notifyLive(offlineState);
        } else if (timeSinceSuccess > OFFLINE_THRESHOLD_MS) {
          this._setConnectivityState(CONNECTIVITY_STATES.PROLONGED_OFFLINE);
          const offlineState = { online: false, state: 'offline', message: 'Втрачено зв’язок з BMS' };
          this.liveData = offlineState;
          this._notifyLive(offlineState);
        } else if (timeSinceSuccess > STALE_THRESHOLD_MS) {
          this._setConnectivityState(CONNECTIVITY_STATES.STALE);
        } else {
          this._setConnectivityState(CONNECTIVITY_STATES.TRANSIENT_FAILURE);
        }
        return null;
      } finally {
        this._liveAbortController = null;
      }
    }

    async _verifyHistoryContext() {
      if (this._historyContextPromise) return this._historyContextPromise;
      const controller = new AbortController();
      const lifecycle = this._lifecycleGeneration;
      this._historyContextAbortController = controller;
      const timer = setTimeout(() => controller.abort(), HISTORY_TIMEOUT_MS);
      this._historyContextPromise = (async () => {
        try {
          const context = await this.transport.fetchHistoryContext?.({ signal: controller.signal });
          if (lifecycle !== this._lifecycleGeneration || controller.signal.aborted) return;
          if (typeof context === 'string' && context) await this._adoptHistoryContext(context);
          else {
            if (this._historyContext !== null) { this._invalidateHistory(); this._historyContext = null; }
            this._historyContextReady = false;
          }
        } catch (_error) { this._historyContextReady = false; }
      })();
      try { await this._historyContextPromise; } finally {
        clearTimeout(timer);
        this._historyContextPromise = null;
        if (this._historyContextAbortController === controller) this._historyContextAbortController = null;
      }
    }

    async _adoptHistoryContext(context) {
      if (context === this._historyContext && this._historyContextReady) return;
      const changed = context !== this._historyContext;
      if (changed) {
        const hadData = this.historyData.length > 0 || this._historyContext !== null;
        ++this._historyGeneration;
        this.historyData = [];
        this._coverage = [];
        this._historyReachedStart = false;
        this._sourceStart = null;
        this._headVerified = false;
        this._historyCacheLoadPromise = null;
        this._historyContext = context;
        this._setHistoryState(CONNECTIVITY_STATES.INITIAL_LOADING);
        if (hadData) this._notifyHistory(this.historyData);
      }
      this._historyContextReady = false;
      try {
        if (this.historyCache?.setContext) await this.historyCache.setContext(context);
        if (this._historyContext === context) this._historyContextReady = true;
      } catch (error) {
        if (error.message === 'History context changed') {
          this._invalidateHistory();
          this._historyContext = null;
        }
        /* Verified network data still works without unavailable storage. */
      }
    }

    _mergeCoverage(intervals) {
      const sorted = intervals.filter(pair => Array.isArray(pair) && pair.length === 2 &&
        Number.isFinite(pair[0]) && Number.isFinite(pair[1]) && pair[0] <= pair[1])
        .map(pair => [...pair]).sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const pair of sorted) {
        const last = merged[merged.length - 1];
        if (last && pair[0] <= last[1] + 1) last[1] = Math.max(last[1], pair[1]);
        else merged.push(pair);
      }
      return merged;
    }

    getHistoryRangeStatus(from, to) {
      const covered = this._coverage.some(([a, b]) => a <= from && b >= to);
      return { covered, limited: covered && this._historyReachedStart &&
        (this._sourceStart === null || from < this._sourceStart), state: this.historyState };
    }

    setHistoryView(view) {
      this._historyView = view;
      this._pauseHistoryRange();
      if (view !== 'dashboard' && view !== 'history') { this._historyDemand = null; return; }
      const now = Math.floor(Date.now() / 1000);
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
      const fromDate = new Date(midnight);
      fromDate.setDate(fromDate.getDate() - (view === 'history' ? 13 : 1));
      const from = Math.min(fromDate.getTime() / 1000, now - 86400);
      this._historyDemand = { from, to: now, days: view === 'history' ? 14 : 2 };
      this._resumeHistoryDemand();
    }

    _pauseHistoryRange() {
      ++this._historyPauseGeneration;
      if (this._activeHistoryKind === 'range' && this._historyAbortController) {
        this._historyAbortController.intentional = true;
        this._historyAbortController.abort();
      }
      this._wakeLiveTurn();
    }

    _wakeLiveTurn() {
      const waiters = [...this._liveTurnWaiters];
      this._liveTurnWaiters.clear();
      waiters.forEach(resolve => resolve());
    }

    _canLoadHistoryRange() {
      return (!this._running || this._liveCycle > 0) &&
        !(typeof document !== 'undefined' && document.hidden) &&
        ['dashboard', 'history'].includes(this._historyView) &&
        !['PROLONGED_OFFLINE', 'TRANSIENT_FAILURE', 'STALE'].includes(this.connectivityState);
    }

    async _waitForHistoryTurn() {
      if (!this._running) return true;
      while (this._running && this._canLoadHistoryRange()) {
        if (!this._isFetchingLive && this._liveCycle > this._historyLiveCycle) {
          this._historyLiveCycle = this._liveCycle;
          return true;
        }
        await new Promise(resolve => this._liveTurnWaiters.add(resolve));
      }
      return false;
    }

    _resumeHistoryDemand() {
      if (!this._running || !this._historyDemand || !this._headVerified || !this._canLoadHistoryRange()) return;
      if (!this._missingHistoryInterval(this._historyDemand.from, this._historyDemand.to)) return;
      if (!this._rangePromise) {
        const pause = this._historyPauseGeneration;
        this._rangePromise = this._loadHistoryDemand().finally(() => {
          this._rangePromise = null;
          if (pause !== this._historyPauseGeneration) this._resumeHistoryDemand();
        });
      }
    }

    async fetchHistory(options = {}) {
      if (!this.capabilities.historyRead) return null;
      const lifecycle = this._lifecycleGeneration;
      if (!options.skipContext) await this._verifyHistoryContext();
      if (lifecycle !== this._lifecycleGeneration) return null;
      const initiallyEmpty = !this.historyData.length;
      const manageLoading = options.manageLoading !== false;
      if (manageLoading) this._beginHistoryLoading(initiallyEmpty ? 'initial' : 'incremental');
      let outcome = 'failed';
      try {
        const params = new URLSearchParams();
        if (this._headVerified && !initiallyEmpty) params.set('after', String(this.historyData.at(-1).t));
        params.set('limit', '144');
        const page = await this._fetchHistoryPage(params, 'refresh');
        if (page !== null) { outcome = 'complete'; this._resumeHistoryDemand(); }
        return page === null ? null : this.historyData;
      } finally { if (manageLoading) this._endHistoryLoading(outcome); }
    }

    async loadHistoryPeriod(days) {
      const now = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(days) || days <= 0) return this.historyData;
      return this.ensureHistoryRange(now - days * 86400, now, { days });
    }

    async ensureHistoryRange(from, to, { days = Math.ceil((to - from) / 86400) } = {}) {
      if (!this.capabilities.historyRead || !Number.isFinite(from) || !Number.isFinite(to) || from > to) return this.historyData;
      const demand = this._historyDemand;
      this._historyDemand = demand
        ? { from: Math.min(demand.from, from), to: Math.max(demand.to, to), days: Math.max(demand.days, days) }
        : { from, to, days };
      if (!this._rangePromise) this._rangePromise = this._loadHistoryDemand().finally(() => { this._rangePromise = null; });
      return this._rangePromise;
    }

    _missingHistoryInterval(from, to) {
      let upper = to;
      for (const [a, b] of [...this._coverage].reverse()) {
        if (b < from || a > upper) continue;
        if (b < upper) return [Math.max(from, b + 1), upper];
        upper = a - 1;
        if (upper < from) return null;
      }
      return upper >= from ? [from, upper] : null;
    }

    async _loadHistoryDemand() {
      this._beginHistoryLoading('period', this._historyDemand?.days || 0);
      let outcome = 'paused';
      try {
        if (!this._headVerified) {
          if (!await this._waitForHistoryTurn()) return this.historyData;
          if (await this.fetchHistory() === null) { outcome = 'failed'; return this.historyData; }
        }
        while (this._historyDemand) {
          const { from, to } = this._historyDemand;
          const missing = this._missingHistoryInterval(from, to);
          if (!missing) {
            outcome = this.getHistoryRangeStatus(from, to).limited ? 'limited' : 'complete';
            break;
          }
          if (!this._canLoadHistoryRange() || !await this._waitForHistoryTurn()) break;
          const query = new URLSearchParams({ before: String(missing[1] + 1), limit: '144' });
          const pause = this._historyPauseGeneration;
          const page = await this._fetchHistoryPage(query, 'range');
          if (page === null) { outcome = pause === this._historyPauseGeneration && this._canLoadHistoryRange() ? 'failed' : 'paused'; break; }
          this._historyLoadingState.pages++;
          this._historyLoadingState.records = this.historyData.length;
          this._notifyHistoryLoading();
        }
        return this.historyData;
      } finally { this._endHistoryLoading(outcome); }
    }

    async _fetchHistoryPage(query, kind = 'refresh') {
      const key = query.toString();
      while (this._activeHistoryPromise) {
        const active = this._activeHistoryPromise;
        if (this._activeHistoryQuery === key) return active;
        await active; // A different cursor must get its own page.
      }
      this._isFetchingHistory = true;
      this._activeHistoryKind = kind;
      this._activeHistoryQuery = key;
      const generation = ++this._historyGeneration;
      this._activeHistoryPromise = this._doFetchHistory(generation, query);
      try { return await this._activeHistoryPromise; }
      finally {
        this._isFetchingHistory = false;
        this._activeHistoryPromise = null;
        this._activeHistoryKind = null;
      }
    }

    async _doFetchHistory(generation, query) {
      const controller = new AbortController();
      this._historyAbortController = controller;
      const timeoutId = setTimeout(() => controller.abort(), HISTORY_TIMEOUT_MS);
      const requestedAt = Math.floor(Date.now() / 1000);
      try {
        const raw = await this.transport.fetchHistoryPage(query, { signal: controller.signal });
        if (generation !== this._historyGeneration || controller.signal.aborted) return null;
        const context = Array.isArray(raw) ? null : raw.context;
        const contextChanged = context && context !== this._historyContext;
        if (context && (contextChanged || !this._historyContextReady)) {
          await this._adoptHistoryContext(context);
          if (context !== this._historyContext || controller.signal.aborted) return null;
          generation = this._historyGeneration;
          if (contextChanged && (query.has('after') || query.has('before'))) return null;
        }
        if (context && this._historyContextReady && !this._historyCacheLoadPromise &&
            !query.has('before') && !query.has('after')) await this._restoreHistoryCache();
        if (generation !== this._historyGeneration || controller.signal.aborted ||
            (context && context !== this._historyContext)) return null;
        const normalizer = global.DataNormalizer || DataNormalizer;
        const records = Array.isArray(raw) ? raw : raw.records;
        const normalized = normalizer.normalizeHistory(records);
        if (records.length && !normalized.length) throw new Error('Invalid history page');
        const isHead = !query.has('before') && !query.has('after');
        const short = records.length < Number(query.get('limit') || 144);
        const replace = isHead && short;
        if (replace) { this.historyData = []; this._coverage = []; }
        if (isHead && !short && this._historyReachedStart) {
          // A new tail can appear after Cloud backfills previously empty history.
          // Recheck source exhaustion once; retain coverage of downloaded rows.
          this._coverage = this._sourceStart === null ? [] : this._coverage
            .map(([a, b]) => [Math.max(a, this._sourceStart), b]).filter(([a, b]) => a <= b);
          this._historyReachedStart = false;
          this._sourceStart = null;
        }
        if (isHead) this._headVerified = true;
        const upper = query.has('before') ? Number(query.get('before')) - 1 :
          query.has('after') && !short ? Number(normalized.at(-1).t) : requestedAt;
        const lower = query.has('after') ? Number(query.get('after')) :
          short ? 0 : Number(normalized[0].t);
        if (short && !query.has('after')) {
          this._historyReachedStart = true;
          this._sourceStart = normalized.length ? Number(normalized[0].t) : this.historyData[0]?.t ?? null;
        }
        this._coverage = this._mergeCoverage([...this._coverage, [lower, upper]]);
        this.historyData = this._mergeHistory(normalized);
        const checkpoint = { intervals: this._coverage, reachedStart: this._historyReachedStart,
          sourceStart: this._sourceStart, nextBefore: normalized[0]?.t ?? null };
        if (this._historyContextReady && context === this._historyContext && this.historyCache?.putPage) {
          try {
            await this.historyCache.putPage(context, normalized, checkpoint,
              { replace, cutoff: requestedAt - 14 * 86400 });
          } catch (error) {
            if (error.message === 'History context changed') {
              this._invalidateHistory();
              return null;
            }
          }
        }
        if (generation !== this._historyGeneration) return null;
        this._lastHistorySuccessTimestamp = Date.now();
        this._setHistoryState(CONNECTIVITY_STATES.FRESH);
        this._notifyHistory(this.historyData);
        return normalized;
      } catch (error) {
        if (error?.status === 401 || error?.status === 404) this._invalidateHistory();
        if (generation === this._historyGeneration && !controller.intentional) {
          this._setHistoryState(this.historyData.length ? CONNECTIVITY_STATES.STALE : 'FAILED_NO_DATA');
          this._notifyHistory(this.historyData);
        }
        return null;
      } finally {
        clearTimeout(timeoutId);
        if (this._historyAbortController === controller) this._historyAbortController = null;
      }
    }

    _invalidateHistory() {
      ++this._historyGeneration;
      this._historyContextAbortController?.abort();
      this._historyAbortController?.abort();
      this.historyData = [];
      this._coverage = [];
      this._headVerified = false;
      this._historyContextReady = false;
      this._historyCacheLoadPromise = null;
      this._historyReachedStart = false;
      this._sourceStart = null;
      this._setHistoryState('FAILED_NO_DATA');
      this._notifyHistory(this.historyData);
    }

    _mergeHistory(records) {
      const byTimestamp = new Map(this.historyData.map(record => [Number(record.t), record]));
      records.forEach(record => byTimestamp.set(Number(record.t), record));
      return Array.from(byTimestamp.values()).sort((a, b) => Number(a.t) - Number(b.t));
    }

    _setHistoryState(newState) {
      this.historyState = newState;
    }

    async fetchDeviceStatus() {
      return this.transport.fetchDeviceStatus();
    }

    async startWifiScan() {
      return this.transport.startWifiScan();
    }

    async fetchWifiScan() {
      return this.transport.fetchWifiScan();
    }

    async configureWifi(request) {
      return this.transport.configureWifi(request);
    }

    async reconnectWifi() {
      return this.transport.reconnectWifi();
    }

    async resetWifi() {
      return this.transport.resetWifi();
    }

    async waitForWifiOperation(
      generation,
      { timeoutMs = 36000, intervalMs = 700, onUpdate = null } = {},
    ) {
      const targetGeneration = Number(generation);
      if (!Number.isFinite(targetGeneration) || targetGeneration <= 0) {
        throw new DeviceApiError('invalid_request', 0, null);
      }

      const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 36000);
      while (Date.now() < deadline) {
        let snapshot = null;
        try {
          snapshot = await this.fetchWifiScan();
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, intervalMs));
          continue;
        }

        const operation = snapshot?.operation || {};
        const currentGeneration = Number(operation.generation);
        if (currentGeneration === targetGeneration) {
          if (typeof onUpdate === 'function') onUpdate(operation, snapshot);
          if (operation.state === 'success') return snapshot;
          if (operation.state === 'error') {
            throw new DeviceApiError(
              operation.error_code || 'request_failed',
              0,
              snapshot,
            );
          }
        } else if (
          Number.isFinite(currentGeneration) &&
          currentGeneration > targetGeneration
        ) {
          throw new DeviceApiError('busy', 409, snapshot);
        }

        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }

      throw new DeviceApiError('operation_timeout', 0, null);
    }


    async startBmsScan() {
      return this.transport.startBmsScan();
    }

    async fetchBmsScan() {
      return this.transport.fetchBmsScan();
    }

    async selectBms(request) {
      return this.transport.selectBms(request);
    }

    async reconnectBms() {
      return this.transport.reconnectBms();
    }

    async forgetBms() {
      return this.transport.forgetBms();
    }

    async startCloudPairing() {
      return this.transport.startCloudPairing();
    }

    async disconnectCloud() {
      return this.transport.disconnectCloud();
    }

    async waitForCloudOperation(
      generation,
      { timeoutMs = 20000, intervalMs = 700, onUpdate = null } = {},
    ) {
      const targetGeneration = Number(generation);
      if (!Number.isFinite(targetGeneration) || targetGeneration <= 0) {
        throw new DeviceApiError('invalid_request', 0, null);
      }

      const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 20000);
      while (Date.now() < deadline) {
        const snapshot = await this.fetchDeviceStatus();
        const operation = snapshot?.cloud?.operation || {};
        const currentGeneration = Number(operation.generation);
        if (currentGeneration === targetGeneration) {
          if (typeof onUpdate === 'function') onUpdate(operation, snapshot);
          if (operation.state === 'success') return snapshot;
          if (operation.state === 'error') {
            throw new DeviceApiError(
              operation.error_code || 'request_failed',
              0,
              snapshot,
            );
          }
        } else if (
          Number.isFinite(currentGeneration) &&
          currentGeneration > targetGeneration
        ) {
          throw new DeviceApiError('busy', 409, snapshot);
        }

        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }

      throw new DeviceApiError('operation_timeout', 0, null);
    }

    async waitForBmsOperation(
      generation,
      { timeoutMs = 45000, intervalMs = 700, onUpdate = null } = {},
    ) {
      const targetGeneration = Number(generation);
      if (!Number.isFinite(targetGeneration) || targetGeneration <= 0) {
        throw new DeviceApiError('invalid_request', 0, null);
      }

      const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 45000);
      while (Date.now() < deadline) {
        let snapshot = null;
        try {
          snapshot = await this.fetchBmsScan();
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, intervalMs));
          continue;
        }

        const operation = snapshot?.operation || {};
        const currentGeneration = Number(operation.generation);
        if (currentGeneration === targetGeneration) {
          if (typeof onUpdate === 'function') onUpdate(operation, snapshot);
          if (operation.state === 'success') return snapshot;
          if (operation.state === 'error') {
            throw new DeviceApiError(
              operation.error_code || 'request_failed',
              0,
              snapshot,
            );
          }
        } else if (
          Number.isFinite(currentGeneration) &&
          currentGeneration > targetGeneration
        ) {
          throw new DeviceApiError('busy', 409, snapshot);
        }

        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }

      throw new DeviceApiError('operation_timeout', 0, null);
    }

    async fetchOtaStatus() {
      if (!this.capabilities.firmwareOta ||
          typeof this.transport.fetchOtaStatus !== 'function') return null;
      return this.transport.fetchOtaStatus();
    }

    async setOtaAutomaticUpdates(enabled) {
      if (!this.capabilities.firmwareOtaPreference ||
          typeof this.transport.setOtaAutomaticUpdates !== 'function') {
        throw new DeviceApiError('capability_unavailable', 0, null);
      }
      return this.transport.setOtaAutomaticUpdates(Boolean(enabled));
    }

    async installOtaUpdate() {
      if (!this.capabilities.firmwareOta ||
          typeof this.transport.installOtaUpdate !== 'function') {
        throw new DeviceApiError('capability_unavailable', 0, null);
      }
      return this.transport.installOtaUpdate();
    }

    async rebootDevice() {
      return this.transport.rebootDevice();
    }

    async factoryResetDevice() {
      const result = await this.transport.factoryResetDevice();
      this._invalidateHistory();
      try { await this.historyCache?.clear(); } catch (_error) {}
      return result;
    }

    async fetchSettings() {
      if (!this.capabilities.bmsSettingsRead) return null;
      if (this._isFetchingSettings && this._activeSettingsPromise) {
        return await this._activeSettingsPromise;
      }
      this._isFetchingSettings = true;
      this._activeSettingsPromise = this._doFetchSettings();
      try {
        return await this._activeSettingsPromise;
      } finally {
        this._isFetchingSettings = false;
        this._activeSettingsPromise = null;
      }
    }

    async _doFetchSettings() {
      this._settingsAbortController = new AbortController();
      const timeoutId = setTimeout(() => {
        if (this._settingsAbortController) this._settingsAbortController.abort();
      }, 8000);

      try {
        const data = await this.transport.fetchSettings({
          signal: this._settingsAbortController.signal
        });
        clearTimeout(timeoutId);

        if (data && data.valid) {
          this._notifySettings(data, CONNECTIVITY_STATES.FRESH);
        } else if (this.settingsData) {
          this._notifySettings(this.settingsData, CONNECTIVITY_STATES.STALE);
        } else {
          this._notifySettings(data || null, 'FAILED_NO_DATA');
        }
        return data;
      } catch (err) {
        clearTimeout(timeoutId);
        console.warn('Failed to fetch settings:', err);
        if (this.settingsData) {
          this._notifySettings(this.settingsData, CONNECTIVITY_STATES.STALE);
        } else {
          this._notifySettings(null, 'FAILED_NO_DATA');
        }
        return null;
      } finally {
        this._settingsAbortController = null;
      }
    }

    _notifyLive(data) {
      this._liveListeners.forEach(cb => {
        try { cb(data, this.connectivityState); } catch (e) { console.error('Error in live listener:', e); }
      });
    }

    /** Full-dataset notification. While a page-by-page load is running the
     *  dataset changes on EVERY page — re-rendering the views that often
     *  makes charts/cards churn and the whole interface flicker (user-visible
     *  regression). Coalesce: at most one refresh per HISTORY_UI_THROTTLE_MS
     *  while loading, plus a trailing refresh so the final page is never
     *  dropped. Outside of loading, notify immediately as before. */
    _notifyHistory() {
      if (this._historyLoadingOps > 0) {
        this._historyUiDirty = true;
        if (this._historyUiThrottleTimer) return;
        this._historyUiThrottleTimer = setTimeout(() => {
          this._historyUiThrottleTimer = null;
          if (this._historyUiDirty) {
            this._historyUiDirty = false;
            this._notifyHistoryListeners();
          }
        }, 800);
        return;
      }
      this._notifyHistoryListeners();
    }

    _notifyHistoryListeners() {
      this._historyListeners.forEach(cb => {
        try { cb(this.historyData, this.historyState); } catch (e) { console.error('Error in history listener:', e); }
      });
    }

    _notifySettings(data, state) {
      this.settingsData = data;
      this.settingsState = state;
      this._settingsListeners.forEach(cb => {
        try { cb(data, state); } catch (e) { console.error('Error in settings listener:', e); }
      });
    }
  }

  const defaultApiClient = new ApiClient();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      ApiClient,
      DeviceApiError,
      defaultApiClient,
      CONNECTIVITY_STATES,
    };
  }
  global.DeviceApiError = DeviceApiError;
  global.CONNECTIVITY_STATES = CONNECTIVITY_STATES;
  global.ApiClient = defaultApiClient;
  global.ApiClientClass = ApiClient;
})(typeof globalThis !== 'undefined' ? globalThis : window);
