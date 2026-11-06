/* settings.js — JK BMS settings view and staged local editor. */

(function (global) {
  'use strict';
  const tr = (key, values) => global.WattPostI18n.t(key, values);
  const tEnglish = key => global.WattPostI18n.tLocale('en', key);

  // Text supplied by BMS/device JSON must never become executable markup.
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));

  /*
   * An inert local edit draft. Firmware, not the browser, must decide whether
   * a model/key/value is safe to write; the browser only checks exact wire
   * representation and helps the user review explicit changes.
   */
  class BmsSettingsDraft {
    constructor(snapshot, schema, writableKeys) {
      if (!snapshot || snapshot.valid !== true || !Array.isArray(schema) ||
          !Array.isArray(writableKeys) || !snapshot.device) {
        throw new Error('bms_write_unavailable');
      }
      this.schema = schema;
      this.specs = new Map(schema.map(spec => [spec.key, spec]));
      // Same underlying JK register is exposed through two legacy API paths.
      // Never offer both aliases as independent changes.
      const aliasOf = {
        'balancing.enabled': 'switches.balancer',
        'balancing.start_voltage_v': 'cell_voltage.start_balance_v'
      };
      const allowed = writableKeys.filter(key => this.specs.has(key));
      this.allowed = new Set(allowed.filter(key =>
        !aliasOf[key] || !allowed.includes(aliasOf[key])));
      this.original = new Map();
      this.pending = new Map();
      this.identity = BmsSettingsDraft.identityOf(snapshot);

      for (const key of this.allowed) {
        const spec = this.specs.get(key);
        const raw = BmsSettingsDraft.read(snapshot, key);
        if (spec.type === 'boolean' && typeof raw === 'boolean') {
          this.original.set(key, raw);
        } else if (spec.type !== 'boolean' && typeof raw === 'number' && Number.isFinite(raw)) {
          this.original.set(key, raw);
        }
      }
    }

    static identityOf(snapshot) {
      const device = snapshot?.device || {};
      // These fields are stable across a single editing session, not secrets.
      return [device.model, device.device_sn, device.hardware_version,
        device.software_version].map(part => String(part ?? '')).join('|');
    }

    static read(data, key) {
      const [section, field] = key.split('.');
      if (!section || !field) return undefined;
      return data?.[section]?.[field];
    }

    static sameValue(left, right, spec) {
      if (spec.type === 'boolean') return typeof left === 'boolean' && left === right;
      return Number.isFinite(left) && Number.isFinite(right) &&
        Math.round(left * BmsSettingsDraft.scale(spec)) ===
        Math.round(right * BmsSettingsDraft.scale(spec));
    }

    static scale(spec) {
      if (spec.type === 'voltage' || spec.type === 'current') return 1000;
      if (spec.type === 'temperature') {
        return /temperature\.(?:discharge_utp_c|discharge_utpr_c|heating_start_c|heating_stop_c)$/.test(spec.key)
          ? 1 : 10;
      }
      if (/^(?:battery\.nominal_capacity_ah|balancing\.(?:trigger_delta_v|start_voltage_v|max_current_a)|current_limits\.(?:max_charge_a|max_discharge_a))$/.test(spec.key)) {
        return 1000;
      }
      return 1;
    }

    set(key, candidate) {
      if (!this.allowed.has(key) || !this.original.has(key)) {
        throw new Error('bms_write_unsupported');
      }
      const spec = this.specs.get(key);
      let value;
      if (spec.type === 'boolean') {
        if (candidate !== true && candidate !== false) throw new Error('bms_write_invalid');
        value = candidate;
      } else {
        if (typeof candidate !== 'string' && typeof candidate !== 'number') {
          throw new Error('bms_write_invalid');
        }
        if (String(candidate).trim() === '') throw new Error('bms_write_invalid');
        value = Number(candidate);
        const scale = BmsSettingsDraft.scale(spec);
        const integer = Math.round(value * scale);
        const signed = spec.type === 'temperature';
        const oneByte = /temperature\.(?:discharge_utp_c|discharge_utpr_c|heating_start_c|heating_stop_c)$/.test(key) ||
                        key === 'sleep.smart_sleep_time_hours';
        const lower = signed ? (oneByte ? -128 : -2147483648) : 0;
        const upper = signed ? (oneByte ? 127 : 2147483647) : (oneByte ? 255 : 4294967295);
        if (!Number.isFinite(value) || !Number.isSafeInteger(integer) ||
            integer < lower || integer > upper ||
            (key === 'battery.cell_count' && (value < 1 || value > 32)) ||
            Math.abs(value * scale - integer) > 0.000001) {
          throw new Error('bms_write_invalid');
        }
      }
      if (value === this.original.get(key)) this.pending.delete(key);
      else this.pending.set(key, value);
      return this.pending.size;
    }

    changes() {
      return this.schema.filter(spec => this.pending.has(spec.key)).map(spec => ({
        key: spec.key,
        spec,
        before: this.original.get(spec.key),
        after: this.pending.get(spec.key)
      }));
    }

    stillCurrent(snapshot) {
      if (!snapshot || snapshot.valid !== true ||
          BmsSettingsDraft.identityOf(snapshot) !== this.identity) return false;
      return this.changes().every(change => {
        const current = BmsSettingsDraft.read(snapshot, change.key);
        return BmsSettingsDraft.sameValue(current, change.before, change.spec);
      });
    }
  }

  class SettingsView {
    constructor() {
      this.container = null;
      this.currentData = null;
      this.currentState = 'INITIAL_LOADING';
      this.searchQuery = '';
      this._unsubscribeSettings = null;
      this._draft = null;
      this._editPhase = 'view';
      this._editBusy = false;
      this._editStatusKey = '';
      this._editBatchNoticeKey = '';
      this._editReadAttempt = 1;
      this._editResults = [];
      this._retryMatchedCount = 0;
      this._invalidKeys = new Set();
    }

    init() {
      this.container = document.getElementById('view-bms-settings');
      if (!this.container) return;

      this._buildLayout();
      this._bindEvents();

      if (global.ApiClient) {
        this._unsubscribeSettings = global.ApiClient.onSettings((data, state) => {
          this.onData(data, state);
        });
      }
    }

    destroy() {
      if (this._unsubscribeSettings) {
        this._unsubscribeSettings();
        this._unsubscribeSettings = null;
      }
    }

    _buildLayout() {
      this.container.innerHTML = `
        <h1 class="visually-hidden" data-i18n="nav.bms_settings">Налаштування BMS</h1>

        <!-- Top Device Summary -->
        <div id="settings-summary-container"></div>

        <!-- Search Toolbar & Status -->
        <div class="settings-toolbar">
          <div class="settings-search-wrapper">
            <svg class="settings-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input type="search" id="settings-search-input" class="settings-search-input" placeholder="${tr('text.search_by_setting_name_or_api_key')}" autocomplete="off" />
            <button id="settings-search-clear" class="settings-search-clear" aria-label="${tr('text.clear_search')}" style="display:none;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <div class="settings-search-count" id="settings-search-count" data-i18n="text.53_parameters">53 параметри</div>
        </div>

        <!-- Only shown for supported BLE models on normal local LAN -->
        <div id="settings-editor-controls" aria-live="polite"></div>

        <!-- Connectivity / Warning Banner -->
        <div id="settings-alert-container"></div>

        <!-- Settings Section Cards Grid -->
        <div class="settings-grid" id="settings-grid"></div>

        <!-- Empty Search Fallback -->
        <div id="settings-empty-state" class="settings-empty-state" style="display:none;">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#8b949e" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <div class="settings-empty-title" data-i18n="text.no_results">Нічого не знайдено</div>
          <div class="settings-empty-desc" id="settings-empty-desc" data-i18n="text.no_settings_match_your_search">За вказаним запитом налаштувань не знайдено.</div>
        </div>
      `;
      global.WattPostI18n?.apply?.(this.container);
    }

    _bindEvents() {
      const searchInput = this.container.querySelector('#settings-search-input');
      const clearBtn = this.container.querySelector('#settings-search-clear');

      if (searchInput) {
        searchInput.addEventListener('input', (e) => {
          this.searchQuery = e.target.value.trim().toLowerCase();
          if (clearBtn) {
            clearBtn.style.display = this.searchQuery ? 'flex' : 'none';
          }
          this._filterRows();
        });
      }

      if (clearBtn) {
        clearBtn.addEventListener('click', () => {
          if (searchInput) {
            searchInput.value = '';
            searchInput.focus();
          }
          this.searchQuery = '';
          clearBtn.style.display = 'none';
          this._filterRows();
        });
      }

      // Delegate to the permanent view container: section rows are re-rendered
      // after each settings refresh, so per-input listeners would be lost.
      this.container.addEventListener('click', event => {
        const button = event.target.closest?.('[data-bms-edit-action]');
        if (!button || !this.container.contains(button)) return;
        switch (button.dataset.bmsEditAction) {
          case 'enter': void this._enterEditor(); break;
          case 'cancel': this._closeEditor(); break;
          case 'review': this._reviewEditor(); break;
          case 'back': this._editPhase = 'editing'; this._renderEditor(); break;
          case 'apply': void this._applyEditor(); break;
          case 'dismiss': this._closeEditor(); break;
          case 'recheck': void this._recheckEditor(); break;
          default: break;
        }
      });
      const updateEditInput = (event, reportInvalid) => {
        const input = event.target.closest?.('[data-bms-edit-key]');
        if (!input || !this.container.contains(input) || !this._draft ||
            this._editPhase !== 'editing' || this._editBusy) return;
        const key = input.dataset.bmsEditKey;
        try {
          this._draft.set(key, input.type === 'checkbox' ? input.checked : input.value);
          this._invalidKeys.delete(key);
          input.setCustomValidity?.('');
          this._editStatusKey = '';
        } catch (_error) {
          this._invalidKeys.add(key);
          input.setCustomValidity?.(tr('bms.edit.invalid'));
          // During typing, intermediate values like an empty number field
          // are expected. Do not interrupt each keystroke with a popup.
          if (reportInvalid) input.reportValidity?.();
        }
        this._renderEditorControls();
      };
      // Browser "change" waits for blur on number inputs. Update the draft
      // on input so the review action becomes available immediately.
      this.container.addEventListener('input', event => {
        if (event.target.type !== 'checkbox') updateEditInput(event, false);
      });
      this.container.addEventListener('change', event => updateEditInput(event, true));
    }

    onData(data, state) {
      this.currentData = data;
      this.currentState = state;

      const alertContainer = this.container.querySelector('#settings-alert-container');
      const grid = this.container.querySelector('#settings-grid');
      const summaryContainer = this.container.querySelector('#settings-summary-container');

      if ((state === 'INITIAL_LOADING' || state === 'FAILED_NO_DATA') &&
          !data && this._draft && !this._editBusy && this._editPhase !== 'result') {
        this._draft = null;
        this._editPhase = 'view';
        this._editStatusKey = 'bms.edit.snapshot_changed';
        this._invalidKeys.clear();
        this._renderEditorControls();
      }

      if (state === 'INITIAL_LOADING' && !data) {
        if (alertContainer) alertContainer.innerHTML = '';
        if (summaryContainer) {
          summaryContainer.innerHTML = `
            <div class="settings-summary-card is-loading">
              <div class="settings-summary-skeleton">${tr('text.loading_bms_configuration')}</div>
            </div>
          `;
        }
        if (grid) {
          grid.innerHTML = `
            <div class="settings-loading-card">
              <span class="settings-spinner"></span>
              <span>${tr('text.fetching_settings_from_get_api_settings')}</span>
            </div>
          `;
        }
        return;
      }

      if (state === 'FAILED_NO_DATA') {
        if (summaryContainer) summaryContainer.innerHTML = '';
        if (alertContainer) {
          alertContainer.innerHTML = `
            <div class="settings-alert settings-alert-error">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <span>${tr('text.bms_settings_unavailable_waiting_for_the_first_response')}</span>
              <button class="settings-retry-btn" onclick="window.ApiClient && window.ApiClient.fetchSettings()">${tr('text.retry')}</button>
            </div>
          `;
        }
        if (grid) grid.innerHTML = '';
        return;
      }

      if (state === 'STALE') {
        if (alertContainer) {
          alertContainer.innerHTML = `
            <div class="settings-alert settings-alert-warning">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path>
                <line x1="12" y1="9" x2="12" y2="13"></line>
                <line x1="12" y1="17" x2="12.01" y2="17"></line>
              </svg>
              <span>${tr('text.showing_saved_settings_refresh_is_delayed_because_the_conn')}</span>
            </div>
          `;
        }
      } else {
        if (alertContainer) alertContainer.innerHTML = '';
      }

      if (this._draft && !this._editBusy &&
          this._editPhase !== 'result' &&
          (state !== 'FRESH' || !this._draft.stillCurrent(data))) {
        this._draft = null;
        this._editPhase = 'view';
        this._editStatusKey = 'bms.edit.snapshot_changed';
      }
      this._renderSummary(data);
      // A valid background refresh must not replace focused input nodes while
      // the user edits a draft. Re-render only when leaving edit mode.
      if (!(this._draft && this._editPhase === 'editing')) {
        this._renderSections(data);
      }
      this._renderEditorControls();
      this._filterRows();
    }

    _canOfferEditing() {
      const api = global.ApiClient;
      // Local writes are enabled by firmware, but actual BLE readiness and
      // current connection are checked by the policy and the server.
      return api?.runtimeContext?.mode === 'local' &&
        api.getCapabilities?.().bmsSettingsWrite === true &&
        typeof api.fetchBmsWritePolicy === 'function' &&
        typeof api.startBmsSettingWrite === 'function' &&
        typeof api.waitForBmsSettingWrite === 'function';
    }

    async _enterEditor() {
      if (!this._canOfferEditing() || this._editBusy ||
          this.currentState !== 'FRESH' || !this.currentData?.valid) return;
      this._editBusy = true;
      this._editStatusKey = '';
      this._editBatchNoticeKey = '';
      this._renderEditorControls();
      try {
        const policy = await global.ApiClient.fetchBmsWritePolicy();
        if (!policy || policy.local_write_available !== true ||
            policy.model_supported !== true ||
            !Number.isSafeInteger(policy.connection_epoch) ||
            policy.connection_epoch < 1 || policy.connection_epoch > 0xffffffff ||
            !Array.isArray(policy.writable_keys)) {
          throw new Error('bms_write_not_ready');
        }
        const draft = new BmsSettingsDraft(
          this.currentData, global.SETTINGS_SCHEMA || [], policy.writable_keys);
        if (draft.original.size === 0) throw new Error('bms_write_unavailable');
        draft.connectionEpoch = policy.connection_epoch;
        this._draft = draft;
        this._invalidKeys.clear();
        this._editResults = [];
        this._retryMatchedCount = 0;
        this._editPhase = 'editing';
      } catch (_error) {
        this._draft = null;
        this._editPhase = 'view';
        this._editStatusKey = 'bms.edit.not_ready';
      } finally {
        this._editBusy = false;
        this._renderEditor();
      }
    }

    _closeEditor() {
      if (this._editBusy) return;
      this._draft = null;
      this._editPhase = 'view';
      this._editResults = [];
      this._retryMatchedCount = 0;
      this._editBatchNoticeKey = '';
      this._editStatusKey = '';
      this._invalidKeys.clear();
      this._renderEditor();
    }

    _reviewEditor() {
      if (!this._draft || this._editBusy || this._editPhase !== 'editing' ||
          this._invalidKeys.size || this._draft.changes().length === 0) return;
      if (this.currentState !== 'FRESH' ||
          !this._draft.stillCurrent(this.currentData)) {
        this._editStatusKey = 'bms.edit.snapshot_changed';
        this._renderEditorControls();
        return;
      }
      this._editPhase = 'review';
      this._renderEditor();
    }

    async _applyEditor() {
      if (!this._canOfferEditing() || !this._draft || this._editBusy ||
          this._editPhase !== 'review' || this._invalidKeys.size) return;
      const changes = this._draft.changes();
      if (!changes.length) return;
      this._editBusy = true;
      this._editPhase = 'applying';
      this._editResults = [];
      this._editBatchNoticeKey = '';
      this._editStatusKey = '';
      this._renderEditor();
      try {
        // Validate the initial set before the first mutation. The firmware
        // repeats CAS atomically before each individual BLE command.
        const fresh = await global.ApiClient.fetchSettings();
        if (!this._draft.stillCurrent(fresh)) {
          this._editStatusKey = 'bms.edit.snapshot_changed';
          this._editPhase = 'review';
          return;
        }
        let inspected = null;
        for (const change of changes) {
          // A previous uncertain write may have been applied. Only a freshly
          // read BLE settings frame can justify skipping an already-set key.
          if (inspected) {
            const observed = BmsSettingsDraft.read(inspected, change.key);
            if (BmsSettingsDraft.sameValue(observed, change.after, change.spec)) {
              this._editResults.push({ key: change.key, state: 'already_applied' });
              this._renderEditorControls();
              continue;
            }
            if (!BmsSettingsDraft.sameValue(observed, change.before, change.spec)) {
              this._editResults.push({ key: change.key, state: 'changed' });
              this._editBatchNoticeKey = 'bms.edit.batch_changed';
              this._renderEditorControls();
              break;
            }
          }
          // A settings snapshot taken before another BLE write cannot justify
          // skipping later keys after that write changes BMS state.
          inspected = null;
          let resultState = 'uncertain';
          let reason = 'none';
          try {
            const started = await global.ApiClient.startBmsSettingWrite({
              key: change.key,
              value: change.after,
              expected_before: change.before,
              connection_epoch: this._draft.connectionEpoch
            });
            const generation = started?.operation?.generation;
            if (!Number.isSafeInteger(generation) || generation <= 0) {
              throw new Error('bms_write_invalid_operation');
            }
            // A status poll is read-only. Never automatically resend a write.
            const result = await global.ApiClient.waitForBmsSettingWrite(generation);
            resultState = result?.generation === generation
              ? result?.state : 'uncertain';
            reason = result?.generation === generation
              ? (result.reason || 'none') : 'operation_changed';
          } catch (error) {
            // A definite 4xx rejection happened before a BLE write was queued.
            // Network failure may hide an already-applied write: no resend.
            resultState = error?.status >= 400 && error.status < 500
              ? 'not_sent' : 'uncertain';
            reason = error?.status >= 400 && error.status < 500
              ? (error.code || 'server_refused') : 'network_error';
          }
          if (resultState === 'uncertain') {
            // The BMS may have applied this write without delivering the
            // normal 0x96 readback. Resolve it using ONE fresh read-only 0x96
            // (never another write), then continue the original approved
            // sequence only if previous and current values are confirmed.
            this._editReadAttempt = 1;
            this._editStatusKey = 'bms.edit.batch_checking';
            this._renderEditorControls();
            try {
              const checked = await this._readFreshEditorSettings({
                requireOriginalEpoch: true,
                onRetry: attempt => {
                  this._editReadAttempt = attempt;
                  this._renderEditorControls();
                }
              });
              const snapshot = checked.fresh;
              const changedPrior = this._editResults.find(previous => {
                const earlier = changes.find(item => item.key === previous.key);
                return earlier && !BmsSettingsDraft.sameValue(
                  BmsSettingsDraft.read(snapshot, earlier.key), earlier.after,
                  earlier.spec);
              });
              if (changedPrior) {
                changedPrior.state = 'changed';
                this._editBatchNoticeKey = 'bms.edit.batch_changed';
              }
              if (BmsSettingsDraft.sameValue(
                BmsSettingsDraft.read(snapshot, change.key), change.after,
                change.spec)) {
                resultState = 'verified';
                reason = 'fresh_read';
                inspected = snapshot;
              } else {
                this._editBatchNoticeKey = 'bms.edit.batch_not_confirmed';
              }
            } catch (_error) {
              this._editBatchNoticeKey = 'bms.edit.batch_read_failed';
            }
            this._editStatusKey = '';
          }
          this._editResults.push({ key: change.key, state: resultState, reason });
          this._renderEditorControls();
          if (resultState !== 'verified' || this._editBatchNoticeKey) break;
        }
        const complete = this._editResults.length === changes.length &&
          this._editResults.every(item =>
            item.state === 'verified' || item.state === 'already_applied');
        const lastState = this._editResults[this._editResults.length - 1]?.state;
        this._editStatusKey = complete ? 'bms.edit.verified'
          : this._editResults.some(item =>
            item.state === 'verified' || item.state === 'already_applied')
            ? 'bms.edit.partial'
            : lastState === 'not_sent' ? 'bms.edit.result_not_sent'
            : lastState === 'mismatch' ? 'bms.edit.result_mismatch'
            : 'bms.edit.result_uncertain';
        this._editPhase = 'result';
        void global.ApiClient.fetchSettings();
      } catch (_error) {
        this._editStatusKey = 'bms.edit.verify_failed';
        this._editPhase = 'review';
      } finally {
        this._editBusy = false;
        this._renderEditorControls();
      }
    }

    async _readFreshEditorSettings({ requireOriginalEpoch = false, onRetry = null } = {}) {
      // The write command is never resent here. If a 0x96 read terminates
      // with a definite timeout/transport error, issue ONE more sequential,
      // read-only probe. Other errors (lost BLE epoch, browser/network
      // timeout, superseded generation) must not cause overlapping probes.
      const maxReadAttempts = 2;
      let probe;
      for (let attempt = 1; attempt <= maxReadAttempts; attempt++) {
        try {
          probe = await global.ApiClient.refreshBmsSettingsRead();
          break;
        } catch (error) {
          const code = error?.code || error?.message;
          if (attempt >= maxReadAttempts ||
              (code !== 'refresh_read_timeout' && code !== 'refresh_read_transport')) {
            throw error;
          }
          // Readiness/epoch must still match before any automatic retry.
          const readiness = await global.ApiClient.fetchBmsWritePolicy();
          if (!readiness?.local_write_available || !readiness?.model_supported ||
              !Number.isSafeInteger(readiness.connection_epoch) ||
              !readiness.connection_epoch ||
              (requireOriginalEpoch &&
               readiness.connection_epoch !== this._draft?.connectionEpoch)) {
            throw new Error('stale_snapshot');
          }
          if (typeof onRetry === 'function') onRetry(attempt + 1);
        }
      }
      const fresh = await global.ApiClient.fetchSettings();
      const policy = await global.ApiClient.fetchBmsWritePolicy();
      // GET settings can return the firmware's cached last frame. Require an
      // explicit NEW read on this BLE epoch and the same BMS identity.
      if (!fresh?.valid || !this._draft ||
          BmsSettingsDraft.identityOf(fresh) !== this._draft.identity ||
          !policy?.local_write_available ||
          !Number.isSafeInteger(probe?.connection_epoch) ||
          !probe.connection_epoch ||
          !Number.isSafeInteger(probe?.received_count) ||
          probe.received_count <= 0 ||
          !Number.isSafeInteger(fresh.received_count) ||
          fresh.received_count < probe.received_count ||
          policy.connection_epoch !== probe.connection_epoch ||
          (requireOriginalEpoch &&
            policy.connection_epoch !== this._draft.connectionEpoch) ||
          !Array.isArray(policy.writable_keys) ||
          this._draft.changes().some(item => !policy.writable_keys.includes(item.key))) {
        throw new Error('stale_snapshot');
      }
      return { fresh, policy };
    }

    // Read BMS afresh before offering a repeat. The GET /api/settings alone
    // is cached firmware state, so a separate user-triggered BLE 0x96 frame
    // must complete before we accept it as proof of the current value.
    async _recheckEditor() {
      if (!this._draft || this._editPhase !== 'result' || this._editBusy ||
          !this._editResults.some(item => item.state !== 'verified' &&
            item.state !== 'already_applied')) return;
      this._editBusy = true;
      this._editBatchNoticeKey = '';
      this._editStatusKey = 'bms.edit.recheck_running';
      this._editReadAttempt = 1;
      this._renderEditorControls();
      try {
        const { fresh, policy } = await this._readFreshEditorSettings({
          onRetry: attempt => {
            this._editReadAttempt = attempt;
            this._renderEditorControls();
          }
        });

        const changes = this._draft.changes();
        const retry = new BmsSettingsDraft(
          fresh, global.SETTINGS_SCHEMA || [], policy.writable_keys);
        retry.connectionEpoch = policy.connection_epoch;
        const remaining = [];
        const readResults = [];
        let conflict = false;
        const same = BmsSettingsDraft.sameValue;
        for (const change of changes) {
          const current = BmsSettingsDraft.read(fresh, change.key);
          const previous = this._editResults.find(item => item.key === change.key);
          if (same(current, change.after, change.spec)) {
            readResults.push({ key: change.key, state: 'already_applied' });
          } else if (previous?.state === 'verified' ||
                     !same(current, change.before, change.spec)) {
            conflict = true;
            readResults.push({ key: change.key, state: 'changed' });
          } else {
            // Only parameters still at the old value need a new write.
            // Never preemptively send: the next screen requires confirmation.
            retry.set(change.key, change.after);
            remaining.push(change);
            readResults.push({ key: change.key, state: 'pending_retry' });
          }
        }
        if (conflict) {
          this._editResults = readResults;
          this._editStatusKey = 'bms.edit.recheck_changed';
        } else if (remaining.length === 0) {
          this._editResults = readResults;
          this._editStatusKey = 'bms.edit.recheck_all_applied';
        } else {
          this._draft = retry;
          this._editResults = [];
          this._editBatchNoticeKey = '';
          this._retryMatchedCount += readResults.filter(item =>
            item.state === 'already_applied').length;
          this._invalidKeys.clear();
          this._editPhase = 'review';
          this._editStatusKey = 'bms.edit.recheck_ready';
          this.currentData = fresh;
        }
      } catch (_error) {
        // Neither the error nor a cached settings snapshot authorizes writes.
        this._editStatusKey = 'bms.edit.recheck_failed';
      } finally {
        this._editBusy = false;
        this._renderEditorControls();
      }
    }

    _renderEditor() {
      this._renderSections(this.currentData);
      this._renderEditorControls();
      this._filterRows();
    }

    _renderEditorControls() {
      const area = this.container?.querySelector('#settings-editor-controls');
      if (!area) return;
      const visible = this._canOfferEditing() &&
        ((this._editPhase !== 'view' && this._editPhase !== 'editing') ||
         (this.currentState === 'FRESH' && this.currentData?.valid));
      // During editing, review, apply and results, keep actions within reach
      // even when the user is changing a field at the bottom of the page.
      const floating = visible && this._editPhase !== 'view';
      area.classList?.toggle('is-bms-edit-active', floating);
      this.container.classList?.toggle('is-bms-edit-active', floating);
      if (!visible) {
        area.innerHTML = '';
        return;
      }
      const successStatuses = new Set(['bms.edit.verified', 'bms.edit.recheck_all_applied']);
      const errorStatuses = new Set(['bms.edit.result_not_sent', 'bms.edit.result_mismatch',
        'bms.edit.recheck_changed']);
      const warningStatuses = new Set(['bms.edit.partial', 'bms.edit.result_uncertain',
        'bms.edit.recheck_failed']);
      const statusTone = successStatuses.has(this._editStatusKey) ? 'success'
        : errorStatuses.has(this._editStatusKey) ? 'error'
        : warningStatuses.has(this._editStatusKey) ? 'warning' : 'info';
      const batchNotice = this._editBatchNoticeKey
        ? `<p class="bms-edit-batch-notice">${escapeHtml(tr(this._editBatchNoticeKey))}</p>` : '';
      const status = this._editStatusKey
        ? `<p class="bms-edit-status bms-edit-status--${statusTone}" role="status">${escapeHtml(tr(this._editStatusKey, { attempt: this._editReadAttempt, total: 2 }))}</p>`
        : '';
      const button = (action, key, disabled = false, priority = 'secondary') =>
        `<button type="button" class="bms-edit-button bms-edit-button--${priority}" data-bms-edit-action="${action}"${disabled ? ' disabled' : ''}>${escapeHtml(tr(key))}</button>`;
      if (this._editPhase === 'view') {
        area.innerHTML = `<div class="bms-edit-controls">${button('enter', 'bms.edit.start', this._editBusy, 'primary')}</div>${status}`;
        return;
      }
      const pending = this._draft?.changes() || [];
      const results = pending.map(change => {
        const item = this._editResults.find(entry => entry.key === change.key);
        const state = item ? item.state : (this._editPhase === 'applying' ? 'pending' : 'skipped');
        const unit = change.key === 'balancing.trigger_delta_v' ? 'V' : (change.spec.unit || '');
        const reasons = new Set(['queue_timeout', 'link_changed', 'write_transport',
          'read_transport', 'readback_timeout', 'operation_timeout',
          'browser_timeout', 'operation_changed', 'network_error',
          'stale_setting', 'stale_connection', 'server_refused', 'busy', 'fresh_read']);
        const reason = reasons.has(item?.reason) ? item.reason : 'none';
        const reasonMessage = reason === 'stale_setting'
          ? tr('bms.edit.reason.stale_setting', { value: change.before, unit })
          : tr('bms.edit.reason.' + reason);
        return `<li class="bms-edit-result-item"><span>${escapeHtml(tr(change.spec.labelKey))}</span>
          <code>${escapeHtml(String(change.before))} → ${escapeHtml(String(change.after))} ${escapeHtml(unit)}</code>
          <span class="bms-edit-outcome bms-edit-outcome--${state}">${escapeHtml(tr('bms.edit.state.' + state))}</span>
          ${reason !== 'none' ? `<small class="bms-edit-reason">${escapeHtml(reasonMessage)}</small>` : ''}</li>`;
      }).join('');
      if (this._editPhase === 'result' || this._editPhase === 'applying') {
        area.innerHTML = `<div class="bms-edit-review" role="group" aria-label="${escapeHtml(tr('bms.edit.result'))}">
          <strong>${escapeHtml(tr(this._editPhase === 'result' ? 'bms.edit.result' : 'bms.edit.applying'))}</strong>
          <ol class="bms-edit-review-list">${results}</ol>${status}${batchNotice}
          ${this._editPhase === 'result' ? `<div class="bms-edit-controls bms-edit-controls--actions">
            ${button('dismiss', 'bms.edit.close')}
            ${this._editResults.some(item => !['verified', 'already_applied'].includes(item.state))
              ? button('recheck', 'bms.edit.recheck_button', this._editBusy, 'primary') : ''}
          </div>` : ''}</div>`;
        return;
      }
      if (this._editPhase === 'review') {
        const list = pending.map(item => {
          const unit = item.key === 'balancing.trigger_delta_v' ? 'V' : (item.spec.unit || '');
          return `<li><span>${escapeHtml(tr(item.spec.labelKey))}</span>
            <code>${escapeHtml(String(item.before))} → ${escapeHtml(String(item.after))} ${escapeHtml(unit)}</code></li>`;
        }).join('');
        area.innerHTML = `<div class="bms-edit-review" role="group" aria-label="${escapeHtml(tr('bms.edit.review'))}">
          <strong>${escapeHtml(tr('bms.edit.review'))}</strong>
          <p>${escapeHtml(tr('bms.edit.warning'))}</p>
          ${this._retryMatchedCount ? `<p class="bms-edit-matched-count">${escapeHtml(tr('bms.edit.recheck_matched', { count: this._retryMatchedCount }))}</p>` : ''}
          <ul class="bms-edit-review-list">${list}</ul><div class="bms-edit-controls bms-edit-controls--actions">
          ${button('back', 'bms.edit.back')}${button('apply', 'bms.edit.confirm', this._editBusy, 'commit')}
          </div>${status}</div>`;
        return;
      }
      area.innerHTML = `<div class="bms-edit-controls bms-edit-controls--actions">
        <span class="bms-edit-count">${escapeHtml(tr('bms.edit.changed_count', { count: pending.length }))}</span>
        ${button('cancel', 'bms.edit.cancel', false, 'quiet')}
        ${button('review', 'bms.edit.review_count', pending.length === 0 || this._invalidKeys.size > 0, 'primary')}
        </div>${status}`;
    }

    _renderSummary(data) {
      const summaryContainer = this.container.querySelector('#settings-summary-container');
      if (!summaryContainer) return;

      const device = (data && data.device) || {};
      const battery = (data && data.battery) || {};

      const normalizer = global.SettingsNormalizer;
      const model = device.model || 'JK BMS';
      const devName = device.device_name || 'Battery';
      const sn = device.device_sn || '—';
      const hw = device.hardware_version || '—';
      const sw = device.software_version || '—';
      const proto = data.protocol_family || device.protocol_family || 'JK02_32S';
      const powerOnCount = device.power_on_count !== undefined && device.power_on_count !== null ? device.power_on_count : '—';
      const uptimeStr = normalizer ? normalizer.formatUptime(device.uptime_seconds) : '—';

      // 1. Topology
      const cellCount = (battery.cell_count != null && Number.isFinite(Number(battery.cell_count)) && Number(battery.cell_count) > 0)
        ? `${battery.cell_count}S`
        : '—';

      // 2. Capacity
      const capacity = (battery.nominal_capacity_ah != null && Number.isFinite(Number(battery.nominal_capacity_ah)))
        ? `${Number(battery.nominal_capacity_ah).toFixed(0)} Ah`
        : '—';

      // 3. Battery Chemistry (LFP -> LiFePO₄, never show battery_type_id)
      let chemistryStr = '—';
      if (battery.chemistry && typeof battery.chemistry === 'string') {
        const trimmed = battery.chemistry.trim();
        if (trimmed.toUpperCase() === 'LFP') {
          chemistryStr = 'LiFePO₄';
        } else if (trimmed) {
          chemistryStr = trimmed;
        }
      }

      // 4. State of Health (SOH)
      const sohStr = (battery.state_of_health != null && Number.isFinite(Number(battery.state_of_health)))
        ? `${Number(battery.state_of_health)}%`
        : '—';

      summaryContainer.innerHTML = `
        <div class="settings-summary-card">
          <div class="settings-summary-header">
            <div class="settings-summary-title-group">
              <div class="settings-summary-title" data-i18n-ignore>${escapeHtml(devName)}</div>
              <div class="settings-summary-subtitle" data-i18n-ignore>${escapeHtml(model)} <span class="settings-summary-proto">${escapeHtml(proto)}</span></div>
            </div>
            <div class="settings-summary-badge-group">
              <div class="settings-summary-badge">
                <span class="badge-label">${tr('text.capacity')}</span>
                <span class="badge-val" data-i18n-ignore>${escapeHtml(capacity)}</span>
              </div>
              <div class="settings-summary-badge">
                <span class="badge-label">${tr('text.battery_type')}</span>
                <span class="badge-val" data-i18n-ignore>${escapeHtml(chemistryStr)}</span>
              </div>
              <div class="settings-summary-badge">
                <span class="badge-label">${tr('text.battery_status')}</span>
                <span class="badge-val" data-i18n-ignore>${escapeHtml(sohStr)}</span>
              </div>
            </div>
          </div>

          <div class="settings-summary-grid">
            <div class="summary-meta-item">
              <span class="meta-label">${tr('text.serial_number_s_n')}</span>
              <span class="meta-val font-mono" data-i18n-ignore>${escapeHtml(sn)}</span>
            </div>
            <div class="summary-meta-item">
              <span class="meta-label">${tr('text.hw_sw_version')}</span>
              <span class="meta-val font-mono" data-i18n-ignore>${escapeHtml(hw)} / ${escapeHtml(sw)}</span>
            </div>
            <div class="summary-meta-item">
              <span class="meta-label">${tr('text.topology')}</span>
              <span class="meta-val font-mono" data-i18n-ignore>${escapeHtml(cellCount)}</span>
            </div>
            <div class="summary-meta-item">
              <span class="meta-label">${tr('text.power_on_count')}</span>
              <span class="meta-val font-mono" data-i18n-ignore>${escapeHtml(powerOnCount)}</span>
            </div>
            <div class="summary-meta-item">
              <span class="meta-label">${tr('text.continuous_uptime')}</span>
              <span class="meta-val font-mono" data-i18n-ignore>${escapeHtml(uptimeStr)}</span>
            </div>
          </div>
        </div>
      `;
    }

    _renderSections(data) {
      const grid = this.container.querySelector('#settings-grid');
      if (!grid) return;

      const schema = global.SETTINGS_SCHEMA || [];
      const normalizer = global.SettingsNormalizer;

      const leftSectionIds = ['battery', 'balancing', 'temperature', 'sleep'];
      const rightSectionIds = ['cellVoltage', 'currentLimits', 'switches'];

      const sectionsById = new Map();
      (global.SETTINGS_SECTIONS || []).forEach(sec => sectionsById.set(sec.id, sec));

      const renderCard = (secId) => {
        const sec = sectionsById.get(secId);
        if (!sec) return '';

        const secSpecs = schema.filter(s => s.section === sec.id);
        if (!secSpecs.length) return '';

        let contentHtml = '';
        if (sec.subgroups && sec.subgroups.length) {
          for (const sub of sec.subgroups) {
            const subSpecs = secSpecs.filter(s => s.subgroup === sub.id);
            if (!subSpecs.length) continue;

            let subRowsHtml = '';
            for (const spec of subSpecs) {
              subRowsHtml += this._renderSettingRow(spec, data, normalizer);
            }

            contentHtml += `
              <div class="settings-subgroup" data-subgroup="${sub.id}">
                <div class="settings-subgroup-title">${escapeHtml(tr(sub.titleKey))}${global.WattPostI18n.language === 'uk'
                    ? ` <span class="settings-subgroup-en">${escapeHtml(tEnglish(sub.titleKey))}</span>`
                    : ''}</div>
                <div class="settings-subgroup-rows">
                  ${subRowsHtml}
                </div>
              </div>
            `;
          }
        } else {
          for (const spec of secSpecs) {
            contentHtml += this._renderSettingRow(spec, data, normalizer);
          }
        }

        return `
          <div class="settings-section-card" data-section="${sec.id}">
            <div class="settings-section-header">
              <div class="settings-section-title">${escapeHtml(tr(sec.titleKey))}</div>
              <div class="settings-section-desc">${escapeHtml(tr(sec.descriptionKey))}</div>
            </div>
            <div class="settings-section-body">
              ${contentHtml}
            </div>
          </div>
        `;
      };

      const leftHtml = leftSectionIds.map(renderCard).join('');
      const rightHtml = rightSectionIds.map(renderCard).join('');

      grid.innerHTML = `
        <div class="settings-column settings-column-left">
          ${leftHtml}
        </div>
        <div class="settings-column settings-column-right">
          ${rightHtml}
        </div>
      `;
    }

    _renderSettingRow(spec, data, normalizer) {
      const rawVal = normalizer ? normalizer.resolveValue(data, spec.key) : null;
      const formatted = normalizer ? normalizer.formatValue(spec, rawVal) : { text: String(rawVal), unit: '' };

      const label = tr(spec.labelKey);
      const englishReference = tEnglish(spec.labelKey);
      const ukrainianReference = global.WattPostI18n.tLocale('uk', spec.labelKey);
      // Search both localizations and the immutable API key in either language.
      const searchTerms = `${label} ${englishReference} ${ukrainianReference} ${spec.key}`.toLowerCase();

      let valueHtml = '';
      if (spec.type === 'boolean') {
        const isActive = formatted.status === 'active';
        valueHtml = `
          <div class="setting-badge ${isActive ? 'is-active' : 'is-inactive'}">
            <span class="setting-badge-dot"></span>
            <span class="setting-badge-text" data-i18n-ignore>${escapeHtml(formatted.text)}</span>
          </div>
        `;
      } else {
        const secText = formatted.secondaryText ? `<span class="setting-secondary-text" data-i18n-ignore>(${escapeHtml(formatted.secondaryText)})</span>` : '';
        const unitHtml = formatted.unit ? `<span class="setting-unit">${escapeHtml(formatted.unit)}</span>` : '';
        valueHtml = `
          <div class="setting-value-group">
            <span class="setting-value font-mono tabular-nums" data-i18n-ignore>${escapeHtml(formatted.text)}</span>
            ${unitHtml}
            ${secText}
          </div>
        `;
      }

      if (this._draft && this._editPhase === 'editing' &&
          this._draft.original.has(spec.key)) {
        const actual = this._draft.pending.has(spec.key)
          ? this._draft.pending.get(spec.key)
          : this._draft.original.get(spec.key);
        if (spec.type === 'boolean') {
          valueHtml = `<label class="bms-edit-switch">
            <input type="checkbox" data-bms-edit-key="${escapeHtml(spec.key)}" ${actual ? 'checked' : ''}>
            <span>${escapeHtml(tr(actual ? 'bms.edit.enabled' : 'bms.edit.disabled'))}</span>
          </label>`;
        } else {
          const scale = BmsSettingsDraft.scale(spec);
          const step = String(1 / scale);
          const unit = spec.key === 'balancing.trigger_delta_v' ? 'V' : (spec.unit || '');
          valueHtml = `<div class="bms-edit-field">
            <input type="number" inputmode="decimal" step="${step}"
              aria-label="${escapeHtml(label)}"
              data-bms-edit-key="${escapeHtml(spec.key)}"
              value="${escapeHtml(String(actual))}" required>
            <span class="setting-unit">${escapeHtml(unit)}</span>
          </div>`;
        }
      }

      return `
        <div class="setting-row" data-key="${spec.key}" data-search="${escapeHtml(searchTerms)}">
          <div class="setting-info">
            <div class="setting-label-uk">${escapeHtml(label)}</div>
            <div class="setting-meta">
              ${global.WattPostI18n.language === 'uk'
                ? `<span class="setting-label-en">${escapeHtml(englishReference)}</span>`
                : ''}
              <span class="setting-key font-mono">${spec.key}</span>
            </div>
          </div>
          <div class="setting-value-container">
            ${valueHtml}
          </div>
        </div>
      `;
    }

    _filterRows() {
      const query = this.searchQuery;
      const allRows = this.container.querySelectorAll('.setting-row');
      const allSections = this.container.querySelectorAll('.settings-section-card');
      const allSubgroups = this.container.querySelectorAll('.settings-subgroup');
      const countEl = this.container.querySelector('#settings-search-count');
      const emptyState = this.container.querySelector('#settings-empty-state');
      const emptyDesc = this.container.querySelector('#settings-empty-desc');

      let visibleCount = 0;

      if (!query) {
        allRows.forEach(r => r.style.display = 'flex');
        allSubgroups.forEach(sg => sg.style.display = 'block');
        allSections.forEach(s => s.style.display = 'flex');
        if (emptyState) emptyState.style.display = 'none';
        if (countEl) countEl.textContent = tr('bms.parameters_count', { count: allRows.length });
        return;
      }

      allRows.forEach(row => {
        const search = row.dataset.search || '';
        const matches = search.includes(query);
        row.style.display = matches ? 'flex' : 'none';
        if (matches) visibleCount++;
      });

      allSubgroups.forEach(sg => {
        const visibleSubRows = sg.querySelectorAll('.setting-row:not([style*="display: none"])');
        sg.style.display = visibleSubRows.length > 0 ? 'block' : 'none';
      });

      allSections.forEach(sec => {
        const visibleSecRows = sec.querySelectorAll('.setting-row:not([style*="display: none"])');
        sec.style.display = visibleSecRows.length > 0 ? 'flex' : 'none';
      });

      if (countEl) {
        countEl.textContent = tr('setup.found_count', { count: visibleCount });
      }

      if (emptyState) {
        if (visibleCount === 0) {
          emptyState.style.display = 'flex';
          if (emptyDesc) {
            emptyDesc.textContent = tr('bms.search_no_match', { query });
          }
        } else {
          emptyState.style.display = 'none';
        }
      }
    }
  }

  global.BmsSettingsDraft = BmsSettingsDraft;
  global.SettingsView = SettingsView;
})(typeof window !== 'undefined' ? window : global);
