/* device-settings.js — WattPost device settings.
 *
 * This view intentionally separates ESP32/WattPost settings from JK BMS
 * parameter settings. Wi-Fi/BMS management uses the centralized ApiClient;
 * remote access remains unavailable until the later Cloud stage.
 */

(function (global) {
  'use strict';

  const tr = (key, values) => global.WattPostI18n.t(key, values);

  function setText(root, id, value, fallback = '—') {
    const node = root.querySelector('#' + id);
    if (!node) return;
    const normalized = value === undefined || value === null || value === '' ? fallback : String(value);
    node.textContent = normalized;
  }

  function localOnlyActionMessage() {
    return tr('text.this_action_is_available_only_when_connected_locally_to_wa');
  }

  function localOnlyPageMessage() {
    return tr('text.wi_fi_and_system_actions_are_available_only_locally_connec');
  }

  const OTA_DISMISS_STORAGE_PREFIX = 'wattpost:ota-result-dismissed:v1:';
  const OTA_TERMINAL_STATES = ['success', 'failed', 'rolled_back'];
  const OTA_START_POLL_INTERVAL_MS = 500;
  const OTA_START_POLL_ATTEMPTS = 12;

  function otaRequestHasProgressed(status) {
    const state = status?.state?.state || null;
    if (['downloading', 'verifying', 'installing', 'success', 'failed', 'rolled_back'].includes(state)) {
      return true;
    }
    return status?.update_available === false;
  }

  function formatUptime(seconds) {
    const total = Number(seconds);
    if (!Number.isFinite(total) || total < 0) return '—';
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days > 0) return tr('device_settings.uptime_days_hours', { days, hours });
    if (hours > 0) return tr('device_settings.uptime_hours_minutes', { hours, minutes });
    return tr('device_settings.uptime_minutes', { minutes });
  }

  const WIFI_ERROR_TEXT = {
    busy: tr('text.wattpost_is_already_changing_wi_fi_wait_for_the_operation'),
    stale_scan: tr('text.scan_results_expired_scan_again'),
    candidate_not_found: tr('text.the_selected_network_is_no_longer_in_the_scan_results'),
    wifi_auth_failed: tr('text.wi_fi_rejected_the_password_the_previous_network_remains_s'),
    wifi_not_found: tr('text.network_not_found_the_previous_network_remains_saved'),
    wifi_connect_failed: tr('text.could_not_connect_wattpost_is_restoring_the_previous_saved'),
    storage_error: tr('text.could_not_save_the_new_network_the_previous_network_is_unc'),
    not_configured: tr('text.wi_fi_is_not_configured_yet'),
    invalid_state: tr('text.this_action_is_unavailable_in_the_current_device_state'),
    subsystem_unavailable: tr('text.wi_fi_is_temporarily_unavailable_try_again'),
    operation_timeout: tr('text.connection_timed_out_try_again'),
    request_failed: tr('text.could_not_contact_wattpost'),
    invalid_response: tr('text.wattpost_returned_an_invalid_response'),
  };

  function wifiErrorText(error) {
    const code = error && (error.code || error.message);
    return WIFI_ERROR_TEXT[code] || (code ? tr('setup.error_code', { code }) : WIFI_ERROR_TEXT.request_failed);
  }

  function wifiPhaseText(phase) {
    return {
      scanning: tr('text.scanning_networks'),
      validating: tr('text.checking_network_cc042e'),
      connecting: tr('text.connecting_to_network'),
      saving: tr('text.saving'),
      reconnecting: tr('text.reconnecting_wi_fi'),
      resetting: tr('text.resetting_wi_fi'),
      none: tr('text.waiting'),
    }[phase] || tr('text.working');
  }


  const BMS_ERROR_TEXT = {
    busy: tr('text.ble_is_busy_or_wattpost_is_already_connected_to_a_bms_scan'),
    stale_scan: tr('text.bms_list_expired_refresh_and_try_again'),
    candidate_not_found: tr('text.the_selected_bms_is_no_longer_available_refresh_and_try_ag'),
    bms_connect_failed: tr('text.could_not_connect_to_the_selected_jk_bms'),
    bms_invalid: tr('text.wattpost_connected_but_did_not_receive_data_from_this_jk_b'),
    storage_error: tr('text.bms_connected_but_wattpost_could_not_save_the_selection'),
    not_configured: tr('text.no_jk_bms_has_been_selected_yet'),
    device_offline: tr('text.wattpost_is_offline_wait_for_the_esp_to_reconnect_then_ret'),
    unsupported_firmware: tr('text.connecting_jk_bms_through_cloud_requires_newer_wattpost_fi'),
    operation_reset: tr('text.another_bms_operation_interrupted_this_action_scan_again'),
    subsystem_unavailable: tr('text.bms_connection_is_temporarily_unavailable'),
    operation_timeout: tr('text.bms_connection_timed_out_try_again'),
    request_failed: tr('text.could_not_contact_wattpost'),
    invalid_response: tr('text.wattpost_returned_an_invalid_response'),
  };

  function bmsErrorText(error) {
    const code = error && (error.code || error.message);
    return BMS_ERROR_TEXT[code] || (code ? tr('setup.error_code', { code }) : BMS_ERROR_TEXT.request_failed);
  }

  function bmsPhaseText(phase) {
    return {
      scanning: tr('text.scanning_for_bms'),
      connecting: tr('text.connecting_to_bms'),
      validating: tr('text.checking_bms_4239f5'),
      saving: tr('text.saving_selected_bms'),
      reconnecting: tr('text.reconnecting_to_bms'),
      resetting: tr('text.forgetting_selected_bms'),
      none: tr('text.waiting'),
    }[phase] || tr('text.working');
  }


  const SYSTEM_ERROR_TEXT = {
    busy: tr('text.another_system_action_is_already_scheduled'),
    storage_error: tr('text.could_not_save_changes_restart_was_not_triggered'),
    invalid_state: tr('text.factory_reset_is_unavailable_because_of_an_internal_settin'),
    request_failed: tr('text.could_not_perform_system_action'),
    invalid_response: tr('text.wattpost_returned_an_invalid_response'),
  };

  function systemErrorText(error) {
    const code = error && (error.code || error.message);
    return SYSTEM_ERROR_TEXT[code] || (code ? tr('setup.error_code', { code }) : SYSTEM_ERROR_TEXT.request_failed);
  }

  const CLOUD_ERROR_TEXT = {
    busy: tr('text.wattpost_is_already_performing_another_cloud_operation'),
    cloud_unavailable: tr('text.cloud_is_unavailable_local_wattpost_operation_continues'),
    already_paired: tr('text.wattpost_is_already_connected_to_an_account'),
    not_paired: tr('text.wattpost_is_not_yet_connected_to_an_account'),
    storage_error: tr('text.could_not_save_cloud_disconnect_state'),
    remote_rejected: tr('text.cloud_rejected_the_request_try_again'),
    invalid_response: tr('text.cloud_returned_an_invalid_response'),
    operation_timeout: tr('text.cloud_is_responding_slowly_the_status_will_update_automati'),
    request_failed: tr('text.cloud_request_failed'),
  };

  function cloudErrorText(error) {
    const code = error && (error.code || error.message);
    return CLOUD_ERROR_TEXT[code] || (code ? tr('setup.error_code', { code }) : CLOUD_ERROR_TEXT.request_failed);
  }

  function safePairUrl(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
      const url = new URL(value);
      if (
        url.protocol !== 'https:' ||
        url.origin !== 'https://wattpost.pp.ua' ||
        url.pathname !== '/pair' ||
        url.search ||
        !/^#token=[A-Za-z0-9_-]{43}$/.test(url.hash)
      ) {
        return null;
      }
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  function otaStateText(state) {
    return {
      new: tr('text.just_installed'),
      pending_verify: tr('text.verifying_93971d'),
      valid: tr('text.working_normally'),
      invalid: tr('text.error'),
      aborted: tr('text.rejected'),
      undefined: tr('text.unknown'),
    }[state] || (state ? tr('text.unknown') : '—');
  }

  function remoteOtaStateText(state) {
    return {
      offered: tr('text.update_available'),
      available: tr('text.update_available'),
      downloading: tr('text.downloading'),
      verifying: tr('text.verifying'),
      installing: tr('text.installing'),
      success: tr('text.updated'),
      failed: tr('text.update_failed'),
      rolled_back: tr('text.previous_version_restored'),
    }[state] || null;
  }

  function restartReasonText(reason) {
    return {
      power_on: tr('text.power_on'),
      manual: tr('text.restart'),
      bms_timeout: tr('text.bms_recovery_restart'),
      wifi_timeout: tr('text.wi_fi_recovery_restart'),
      panic: tr('text.system_error'),
      watchdog: tr('text.system_hang'),
      brownout: tr('text.power_brownout'),
      other: tr('text.other_cause'),
    }[reason] || (reason ? tr('text.other_cause') : '—');
  }

  class DeviceSettingsView {
    constructor() {
      this.container = null;
      this.capabilities = {};
      this._unsubscribeLive = null;
      this.deviceStatus = null;
      this.wifiScan = null;
      this.selectedWifi = null;
      this.wifiBusy = false;
      this.wifiConfigured = false;
      this.bmsScan = null;
      this.selectedBms = null;
      this.bmsBusy = false;
      this.bmsConfigured = false;
      this.cloudBusy = false;
      this.systemBusy = false;
      this.otaStatus = null;
      this.otaCheckConfirmed = false;
      this.otaCheckFailed = false;
      this.otaCheckedAt = 0;
      this.otaPreferences = { supported: null, confirmed: null, pending: null };
      this.otaPreferenceError = null;
      this.otaPreferenceDesired = null;
      this.otaBusy = false;
      this.otaRequestAccepted = false;
      this.otaDismissedResult = null;
      this.otaPreferenceBusy = false;
      this._initialStatusPromise = null;
      this._resolveInitialLive = null;
      this._statusRefreshTimer = null;
    }

    init() {
      this.container = document.getElementById('view-settings');
      if (!this.container) return;
      this.capabilities = global.ApiClient?.getCapabilities?.() || {};
      this._setInitialLoading(true);

      this._buildLayout();
      this._applyCapabilities();
      this._bindEvents();

      let initialLivePromise = Promise.resolve();
      if (global.ApiClient && typeof global.ApiClient.onLive === 'function') {
        initialLivePromise = new Promise(resolve => {
          this._resolveInitialLive = resolve;
        });
        this._unsubscribeLive = global.ApiClient.onLive((data, state) => {
          this.onLive(data, state);
          if (this._resolveInitialLive) {
            const resolve = this._resolveInitialLive;
            this._resolveInitialLive = null;
            resolve();
          }
        });
      }

      this._initialStatusPromise = this._refreshDeviceStatus();
      Promise.allSettled([initialLivePromise, this._initialStatusPromise]).then(() => {
        this._setInitialLoading(false);
      });
      this._statusRefreshTimer = setInterval(() => {
        this._refreshDeviceStatus();
      }, 5000);
    }

    destroy() {
      if (this._resolveInitialLive) {
        const resolve = this._resolveInitialLive;
        this._resolveInitialLive = null;
        resolve();
      }
      if (this._unsubscribeLive) {
        this._unsubscribeLive();
        this._unsubscribeLive = null;
      }
      if (this._statusRefreshTimer) {
        clearInterval(this._statusRefreshTimer);
        this._statusRefreshTimer = null;
      }
    }

    _setInitialLoading(value) {
      if (!this.container) return;
      const loading = Boolean(value);
      this.container.classList?.toggle('is-initial-loading', loading);
      if (loading) {
        this.container.setAttribute?.('aria-busy', 'true');
      } else {
        this.container.removeAttribute?.('aria-busy');
      }
    }

    _applyCapabilities() {
      const localActionCapabilities = [
        'wifiManage',
        'bmsForget',
        'cloudManage',
        'systemReboot',
        'systemFactoryReset',
      ];
      const unavailable = localActionCapabilities.some(name => this.capabilities[name] === false);
      if (!unavailable) return;

      const note = document.createElement('p');
      note.className = 'capability-note';
      note.id = 'device-local-only-note';
      note.textContent = localOnlyPageMessage();
      this.container.prepend(note);

      this.container.querySelectorAll('[data-capability]').forEach(target => {
        const capability = target.dataset.capability;
        if (!capability || this.capabilities[capability] !== false) return;
        const controls = target.matches('button, input, select, textarea')
          ? [target]
          : [...target.querySelectorAll('button, input, select, textarea')];
        controls.forEach(control => {
          control.disabled = true;
          control.setAttribute('aria-disabled', 'true');
          control.setAttribute('title', localOnlyActionMessage());
          const describedBy = new Set((control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
          describedBy.add(note.id);
          control.setAttribute('aria-describedby', [...describedBy].join(' '));
        });
      });
    }

    _buildLayout() {
      this.container.innerHTML = `
        <section class="device-settings-head">
          <div class="device-settings-heading">
            <div class="device-settings-eyebrow">WattPost</div>
            <h1 data-i18n="text.wattpost_settings">Налаштування WattPost</h1>
            <p data-i18n="text.wi_fi_jk_bms_connection_remote_access_firmware_and_system">Wi-Fi, підключення JK BMS, віддалений доступ, прошивка та системні дії.</p>
          </div>
          <div class="device-settings-live-chip" id="device-local-state" data-tone="muted">
            <span class="device-settings-live-dot"></span>
            <span id="device-local-state-text" data-i18n="text.waiting_for_wattpost">Очікуємо зв’язок з WattPost</span>
          </div>
        </section>

        <div class="device-settings-grid">
          <section class="device-settings-card">
            <div class="device-settings-card-head">
              <div class="device-settings-card-icon" aria-hidden="true">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                  <path d="M5 12.5a10 10 0 0 1 14 0"></path>
                  <path d="M8.5 16a5 5 0 0 1 7 0"></path>
                  <path d="M12 20h.01"></path>
                </svg>
              </div>
              <div class="device-settings-card-title">
                <h2>Wi-Fi</h2>
                <p data-i18n="text.home_network_and_internet_connection">Підключення до домашньої мережі та інтернету.</p>
              </div>
              <span class="device-settings-status" id="device-wifi-state" data-tone="muted" data-i18n="text.no_data">Немає даних</span>
            </div>
            <div class="device-settings-rows">
              <div class="device-settings-row">
                <span data-i18n="text.current_network">Поточна мережа</span>
                <strong id="device-wifi-ssid">—</strong>
              </div>
              <div class="device-settings-row">
                <span data-i18n="text.signal">Сигнал</span>
                <strong id="device-wifi-rssi">—</strong>
              </div>
              <div class="device-settings-row">
                <span data-i18n="text.internet">Інтернет</span>
                <strong id="device-wifi-internet" data-i18n="text.not_checked">Не перевірено</strong>
              </div>
              <div class="device-settings-row">
                <span data-i18n="setup.wifi_recovery">Відновлення Wi-Fi</span>
                <strong data-i18n="text.boot_hold_510_s_then_release">BOOT: 5–10 с, відпустіть</strong>
              </div>
            </div>
            <p class="device-system-message" data-tone="muted" data-i18n="text.for_wi_fi_recovery_hold_boot_for_510_seconds_then_release">Для відновлення Wi-Fi утримуйте BOOT 5–10 секунд і відпустіть. Утримання 15 секунд або довше з наступним відпусканням виконає повне скидання.</p>
            <div class="device-settings-actions device-settings-actions-split">
              <button class="device-settings-action device-settings-action-secondary" id="device-wifi-reconnect" data-capability="wifiManage" type="button" data-i18n="text.reconnect">Перепідключити</button>
              <button class="device-settings-action" id="device-wifi-manage" data-capability="wifiManage" type="button" data-i18n="text.manage_wi_fi">Керувати Wi-Fi</button>
            </div>
            <div class="device-wifi-panel" id="device-wifi-panel" data-capability="wifiManage" hidden>
              <div class="device-wifi-panel-head">
                <div>
                  <strong data-i18n="text.change_network">Зміна мережі</strong>
                  <p data-i18n="text.wattpost_saves_the_new_network_only_after_it_connects_succ">WattPost збереже нову мережу лише після успішного підключення. Якщо не вийде, попередня мережа залишиться без змін.</p>
                </div>
                <button class="device-settings-action device-settings-action-secondary" id="device-wifi-scan" type="button" data-i18n="text.scan">Сканувати</button>
              </div>
              <div class="device-wifi-message" id="device-wifi-message" data-tone="muted" data-i18n="text.choose_a_network_or_enter_a_hidden_network_name">Оберіть мережу або введіть назву прихованої мережі.</div>
              <div class="device-wifi-candidates" id="device-wifi-candidates"></div>
              <label class="device-wifi-check">
                <input id="device-wifi-hidden-toggle" type="checkbox">
                <span data-i18n="text.hidden_network">Прихована мережа</span>
              </label>
              <label class="device-wifi-field" id="device-wifi-hidden-field" hidden>
                <span data-i18n="text.network_name">Назва мережі</span>
                <input id="device-wifi-hidden-ssid" type="text" maxlength="32" autocomplete="off" spellcheck="false">
              </label>
              <label class="device-wifi-field">
                <span data-i18n="text.new_wi_fi_password">Новий пароль Wi-Fi</span>
                <input id="device-wifi-password" type="password" maxlength="64" autocomplete="new-password" autocapitalize="none" spellcheck="false">
                <small data-i18n="text.the_saved_password_is_never_shown_leave_blank_for_an_open">Збережений пароль ніколи не відображається. Для відкритої мережі залиште поле порожнім.</small>
              </label>
              <div class="device-wifi-panel-actions">
                <button class="device-settings-action" id="device-wifi-apply" type="button" data-i18n="text.verify_and_save">Перевірити й зберегти</button>
                <button class="device-settings-action device-settings-action-danger" id="device-wifi-reset" type="button" data-i18n="text.reset_wi_fi">Скинути Wi-Fi</button>
              </div>
            </div>
          </section>

          <section class="device-settings-card">
            <div class="device-settings-card-head">
              <div class="device-settings-card-icon" aria-hidden="true">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M7 7l10 10"></path>
                  <path d="M7 17L17 7"></path>
                  <path d="M12 2v20"></path>
                  <path d="M12 2l5 5-5 5"></path>
                  <path d="M12 12l5 5-5 5"></path>
                </svg>
              </div>
              <div class="device-settings-card-title">
                <h2>JK BMS</h2>
                <p data-i18n="text.jk_bms_selection_and_connection_status">Вибір JK BMS та стан підключення.</p>
              </div>
              <span class="device-settings-status" id="device-bms-state" data-tone="muted" data-i18n="text.no_data">Немає даних</span>
            </div>
            <div class="device-settings-rows">
              <div class="device-settings-row">
                <span data-i18n="text.selected_bms">Вибрана BMS</span>
                <strong id="device-bms-address">—</strong>
              </div>
              <div class="device-settings-row">
                <span data-i18n="text.model">Модель</span>
                <strong id="device-bms-model">—</strong>
              </div>
              <div class="device-settings-row">
                <span data-i18n="text.connection">Підключення</span>
                <strong id="device-bms-ble">—</strong>
              </div>
              <div class="device-settings-row">
                <span data-i18n="device_settings.ble_signal">Сигнал Bluetooth</span>
                <strong id="device-bms-rssi">—</strong>
              </div>
              <div class="device-settings-row">
                <span data-i18n="text.cells">Комірки</span>
                <strong id="device-bms-cells">—</strong>
              </div>
            </div>
            <div class="device-settings-actions device-settings-actions-split">
              <button class="device-settings-action device-settings-action-secondary" id="device-bms-reconnect" data-capability="bmsManage" type="button" data-i18n="text.reconnect">Перепідключити</button>
              <button class="device-settings-action" id="device-bms-manage" data-capability="bmsManage" type="button" data-i18n="text.bms_connection">Підключення BMS</button>
              <button class="device-settings-action device-settings-action-secondary" type="button" data-capability="bmsSettingsRead" data-open-bms-settings data-i18n="text.bms_parameters">Параметри BMS</button>
            </div>
            <div class="device-bms-panel" id="device-bms-panel" data-capability="bmsManage" hidden>
              <div class="device-bms-panel-head">
                <div>
                  <strong data-i18n="device_settings.bms_connection_title">Підключення JK BMS</strong>
                  <p data-i18n="text.scanning_does_not_change_settings_a_new_bms_is_saved_only">Пошук нічого не змінює автоматично. Нова BMS буде збережена лише після успішного підключення та отримання даних.</p>
                </div>
                <button class="device-settings-action device-settings-action-secondary" id="device-bms-scan" type="button" data-i18n="text.find_bms">Знайти BMS</button>
              </div>
              <div class="device-bms-message" id="device-bms-message" data-tone="muted" data-i18n="text.scan_and_select_a_jk_bms">Запустіть пошук і виберіть JK BMS.</div>
              <div class="device-bms-candidates" id="device-bms-candidates"></div>
              <div class="device-bms-panel-actions">
                <button class="device-settings-action" id="device-bms-apply" type="button" data-i18n="text.verify_and_select">Перевірити й вибрати</button>
                <button class="device-settings-action device-settings-action-danger" id="device-bms-forget" data-capability="bmsForget" type="button" data-i18n="text.forget_bms">Забути BMS</button>
              </div>
            </div>
          </section>

          <section class="device-settings-card">
            <div class="device-settings-card-head">
              <div class="device-settings-card-icon" aria-hidden="true">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M8 17H6a4 4 0 0 1 0-8 6 6 0 0 1 11.5-1.5A4.5 4.5 0 0 1 18 16h-2"></path>
                  <path d="M12 12v9"></path>
                  <path d="M9 15l3-3 3 3"></path>
                </svg>
              </div>
              <div class="device-settings-card-title">
                <h2 data-i18n="text.remote_access">Віддалений доступ</h2>
                <p data-i18n="text.connect_wattpost_to_your_account_for_remote_access_via_wat">Підключіть WattPost до свого облікового запису для доступу через wattpost.pp.ua. Локальна робота від Cloud не залежить.</p>
              </div>
              <span class="device-settings-status" id="device-remote-state" data-tone="muted" data-i18n="text.checking">Перевіряємо</span>
            </div>
            <div class="device-settings-rows">
              <div class="device-settings-row">
                <span>Cloud</span>
                <strong id="device-cloud-transport">—</strong>
              </div>
              <div class="device-settings-row">
                <span data-i18n="text.account">Обліковий запис</span>
                <strong id="device-cloud-account">—</strong>
              </div>
            </div>
            <div class="device-settings-actions device-settings-actions-split">
              <button class="device-settings-action" id="device-cloud-connect" data-capability="cloudManage" type="button" data-i18n="text.connect_to_account">Підключити до акаунта</button>
              <button class="device-settings-action device-settings-action-danger" id="device-cloud-disconnect" data-capability="cloudManage" type="button" hidden data-i18n="text.disconnect_cloud">Відключити Cloud</button>
            </div>
            <div class="device-system-message" id="device-cloud-message" data-tone="muted" data-i18n="text.cloud_does_not_affect_the_local_dashboard_history_or_bms">Cloud не впливає на локальний Dashboard, History або BMS.</div>
          </section>

          <section class="device-settings-card">
            <div class="device-settings-card-head">
              <div class="device-settings-card-icon" aria-hidden="true">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="5" y="5" width="14" height="14" rx="2"></rect>
                  <path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4"></path>
                </svg>
              </div>
              <div class="device-settings-card-title">
                <h2 data-i18n="text.firmware">Прошивка</h2>
                <p data-i18n="text.firmware_version_and_update_status">Версія прошивки та стан оновлення.</p>
              </div>
              <span class="device-settings-status" id="device-firmware-state" data-tone="muted" data-i18n="text.no_data">Немає даних</span>
            </div>
            <div class="device-settings-rows">
              <div class="device-settings-row">
                <span data-i18n="text.version">Версія</span>
                <strong id="device-firmware-version">—</strong>
              </div>
              <div class="device-settings-row">
                <span data-i18n="text.build">Збірка</span>
                <strong class="device-settings-mono" id="device-build-id">—</strong>
              </div>
              <div class="device-settings-row">
                <span data-i18n="text.firmware_status">Стан прошивки</span>
                <strong id="device-ota-state">—</strong>
              </div>
              <div class="device-settings-row">
                <span data-i18n="text.automatic_updates">Автоматичні оновлення</span>
                <div class="device-ota-preference">
                  <strong id="device-ota-automatic">—</strong>
                  <label class="device-toggle" data-capability="firmwareOtaPreference">
                    <input id="device-ota-automatic-toggle" type="checkbox" role="switch" aria-label="${tr('text.automatic_updates')}" disabled>
                    <span class="device-toggle-track" aria-hidden="true"><span class="device-toggle-thumb"></span></span>
                  </label>
                </div>
              </div>
              <div class="device-settings-row" id="device-ota-release-row" hidden>
                <span data-i18n="text.available_version">Доступна версія</span>
                <strong id="device-ota-release">—</strong>
              </div>
            </div>
            <div class="device-settings-actions">
              <button class="device-settings-action" id="device-ota-install" data-capability="firmwareOta" type="button" disabled data-i18n="text.update_now">Оновити зараз</button>
              <button class="device-settings-action device-settings-action-secondary" id="device-ota-disable-automatic" data-capability="firmwareOtaPreference" type="button" hidden data-i18n="text.disable_auto_updates">Вимкнути автооновлення</button>
            </div>
            <div class="device-ota-progress" id="device-ota-progress" role="status" aria-label="${tr('text.update_progress')}" hidden>
              <div class="device-ota-progress-heading">
                <strong id="device-ota-progress-stage" data-i18n="text.waiting_for_device">Очікуємо пристрій…</strong>
                <div class="device-ota-progress-controls">
                  <span id="device-ota-progress-percent"></span>
                  <button type="button" class="device-ota-progress-dismiss" id="device-ota-progress-dismiss" aria-label="${tr('text.dismiss_update_result')}" hidden data-i18n="text.close">Закрити</button>
                </div>
              </div>
              <div class="device-ota-progress-track" id="device-ota-progress-track">
                <div class="device-ota-progress-fill" id="device-ota-progress-fill"></div>
              </div>
              <p id="device-ota-progress-detail"></p>
            </div>
            <div class="device-system-message" id="device-ota-message" data-tone="muted" data-i18n="text.checking_firmware_and_automatic_update_settings">Перевіряємо прошивку та налаштування автооновлень.</div>
          </section>

          <section class="device-settings-card device-settings-card-wide">
            <div class="device-settings-card-head">
              <div class="device-settings-card-icon" aria-hidden="true">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="3"></circle>
                  <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.16.36.37.7.6 1 .28.3.66.48 1.1.5h.1v4h-.1c-.44.02-.82.2-1.1.5-.23.3-.44.64-.6 1z"></path>
                </svg>
              </div>
              <div class="device-settings-card-title">
                <h2 data-i18n="text.system">Система</h2>
                <p data-i18n="text.local_address_uptime_and_system_actions">Локальна адреса, час роботи та системні дії.</p>
              </div>
            </div>
            <div class="device-settings-rows device-settings-rows-wide">
              <div class="device-settings-row">
                <span data-i18n="text.local_address">Локальна адреса</span>
                <strong>bms.local</strong>
              </div>
              <div class="device-settings-row">
                <span data-i18n="text.uptime">Час роботи</span>
                <strong id="device-uptime">—</strong>
              </div>
              <div class="device-settings-row">
                <span data-i18n="text.last_boot">Останній запуск</span>
                <strong id="device-restart-reason">—</strong>
              </div>
            </div>
            <div class="device-settings-actions device-settings-actions-system">
              <button class="device-settings-action device-settings-action-secondary" id="device-system-reboot" data-capability="systemReboot" type="button" data-i18n="text.restart_be7c07">Перезавантажити</button>
              <button class="device-settings-action device-settings-action-danger" id="device-system-factory-toggle" data-capability="systemFactoryReset" type="button" data-i18n="text.factory_resetting">Повне скидання…</button>
            </div>
            <div class="device-system-message" id="device-system-message" data-tone="muted" data-i18n="text.system_actions_can_only_be_performed_locally">Системні дії виконуються тільки локально.</div>
            <div class="device-system-reset-panel" id="device-system-reset-panel" data-capability="systemFactoryReset" hidden>
              <div class="device-system-reset-head">
                <strong data-i18n="text.factory_reset_wattpost">Повне скидання WattPost</strong>
                <p data-i18n="text.wattpost_will_erase_local_settings_and_history_and_return">WattPost видалить локальні налаштування та історію й повернеться до початкового налаштування.</p>
              </div>
              <div class="device-system-reset-scope">
                <div>
                  <strong data-i18n="text.will_be_erased">Буде видалено</strong>
                  <ul>
                    <li data-i18n="text.saved_wi_fi_network_and_password">збережена Wi-Fi мережа та пароль;</li>
                    <li data-i18n="text.selected_jk_bms">вибрана JK BMS;</li>
                    <li data-i18n="text.local_temperature_sensor_settings">локальні налаштування температурних датчиків;</li>
                    <li data-i18n="text.measurement_history">історія вимірювань.</li>
                    <li data-i18n="text.current_wattpost_cloud_account_connection">прив’язка до поточного акаунта WattPost Cloud.</li>
                  </ul>
                </div>
                <div>
                  <strong data-i18n="text.after_reset">Після скидання</strong>
                  <ul>
                    <li data-i18n="text.wattpost_will_restart_connect_to_wattpost_xxxx_and_open_19">WattPost перезапуститься. Підключіться до його мережі WattPost-XXXX та відкрийте 192.168.4.1.</li>
                    <li data-i18n="text.configure_wi_fi_and_bms_then_connect_the_device_to_the_int">Налаштуйте Wi-Fi і BMS, потім повторно підключіть пристрій до потрібного акаунта Cloud.</li>
                    <li data-i18n="text.cloud_will_detect_the_reset_after_the_device_reconnects_to">Cloud дізнається про скидання після повернення пристрою в інтернет; старий доступ може зникнути не одразу.</li>
                  </ul>
                </div>
              </div>
              <label class="device-system-reset-confirm">
                <input id="device-system-factory-confirm" type="checkbox">
                <span data-i18n="text.i_understand_that_settings_history_and_the_cloud_account_c">Я розумію, що налаштування, історія та прив’язка до акаунта Cloud будуть скинуті.</span>
              </label>
              <div class="device-system-reset-actions">
                <button class="device-settings-action device-settings-action-secondary" id="device-system-factory-cancel" type="button" data-i18n="text.cancel">Скасувати</button>
                <button class="device-settings-action device-settings-action-danger" id="device-system-factory-run" type="button" disabled data-i18n="setup.factory_reset">Повністю скинути WattPost</button>
              </div>
            </div>
          </section>
        </div>
      `;
      global.WattPostI18n?.apply?.(this.container);
      // Dynamic API values and user-provided labels must never be retranslated.
      for (const id of [
        'device-wifi-ssid', 'device-bms-address', 'device-bms-model',
        'device-firmware-version', 'device-build-id', 'device-wifi-message',
        'device-bms-message', 'device-ota-message'
      ]) {
        this.container.querySelector('#' + id)?.setAttribute?.('data-i18n-ignore', '');
      }
    }

    _bindEvents() {
      const openBmsSettings = this.container.querySelector('[data-open-bms-settings]');
      if (openBmsSettings) {
        openBmsSettings.addEventListener('click', () => {
          window.location.hash = 'bms-settings';
        });
      }

      this.container.querySelector('#device-wifi-manage')?.addEventListener('click', () => {
        const panel = this.container.querySelector('#device-wifi-panel');
        if (!panel) return;
        panel.hidden = !panel.hidden;
        if (!panel.hidden && !this.wifiScan) this._scanWifi();
      });
      this.container.querySelector('#device-wifi-reconnect')?.addEventListener('click', () => {
        this._reconnectWifi();
      });
      this.container.querySelector('#device-wifi-scan')?.addEventListener('click', () => {
        this._scanWifi();
      });
      this.container.querySelector('#device-wifi-apply')?.addEventListener('click', () => {
        this._configureWifi();
      });
      this.container.querySelector('#device-wifi-reset')?.addEventListener('click', () => {
        this._resetWifi();
      });
      this.container.querySelector('#device-wifi-hidden-toggle')?.addEventListener('change', event => {
        const hidden = Boolean(event.target.checked);
        const field = this.container.querySelector('#device-wifi-hidden-field');
        if (field) field.hidden = !hidden;
        if (hidden) {
          this.selectedWifi = null;
          this._renderWifiCandidates(this.wifiScan?.candidates || []);
        }
      });

      this.container.querySelector('#device-bms-manage')?.addEventListener('click', () => {
        const panel = this.container.querySelector('#device-bms-panel');
        if (!panel) return;
        panel.hidden = !panel.hidden;
        if (!panel.hidden && !this.bmsScan) this._scanBms();
      });
      this.container.querySelector('#device-bms-reconnect')?.addEventListener('click', () => {
        this._reconnectBms();
      });
      this.container.querySelector('#device-bms-scan')?.addEventListener('click', () => {
        this._scanBms();
      });
      this.container.querySelector('#device-bms-apply')?.addEventListener('click', () => {
        this._selectBms();
      });
      this.container.querySelector('#device-bms-forget')?.addEventListener('click', () => {
        this._forgetBms();
      });

      this.container.querySelector('#device-cloud-connect')?.addEventListener('click', () => {
        this.startCloudConnectFlow();
      });
      this.container.querySelector('#device-cloud-disconnect')?.addEventListener('click', () => {
        this._disconnectCloud();
      });

      this.container.querySelector('#device-ota-automatic-toggle')?.addEventListener('change', event => {
        this._setOtaAutomaticUpdates(Boolean(event.target.checked));
      });
      this.container.querySelector('#device-ota-install')?.addEventListener('click', () => {
        this._installOtaUpdate();
      });
      this.container.querySelector('#device-ota-progress-dismiss')?.addEventListener('click', () => {
        this._dismissOtaResult();
      });
      this.container.querySelector('#device-ota-disable-automatic')?.addEventListener('click', () => {
        this._setOtaAutomaticUpdates(false);
      });

      this.container.querySelector('#device-system-reboot')?.addEventListener('click', () => {
        this._rebootDevice();
      });
      this.container.querySelector('#device-system-factory-toggle')?.addEventListener('click', () => {
        const panel = this.container.querySelector('#device-system-reset-panel');
        const confirm = this.container.querySelector('#device-system-factory-confirm');
        if (!panel) return;
        panel.hidden = !panel.hidden;
        if (!panel.hidden && confirm) confirm.checked = false;
        this._updateFactoryResetButton();
      });
      this.container.querySelector('#device-system-factory-cancel')?.addEventListener('click', () => {
        const panel = this.container.querySelector('#device-system-reset-panel');
        const confirm = this.container.querySelector('#device-system-factory-confirm');
        if (confirm) confirm.checked = false;
        if (panel) panel.hidden = true;
        this._updateFactoryResetButton();
      });
      this.container.querySelector('#device-system-factory-confirm')?.addEventListener('change', () => {
        this._updateFactoryResetButton();
      });
      this.container.querySelector('#device-system-factory-run')?.addEventListener('click', () => {
        this._factoryResetDevice();
      });
    }

    _setWifiBusy(value) {
      this.wifiBusy = Boolean(value);
      const reconnect = this.container.querySelector('#device-wifi-reconnect');
      const reset = this.container.querySelector('#device-wifi-reset');
      const scan = this.container.querySelector('#device-wifi-scan');
      const apply = this.container.querySelector('#device-wifi-apply');
      const unavailable = this.capabilities.wifiManage === false;
      if (reconnect) reconnect.disabled = unavailable || this.wifiBusy || !this.wifiConfigured;
      if (reset) reset.disabled = unavailable || this.wifiBusy || !this.wifiConfigured;
      if (scan) scan.disabled = unavailable || this.wifiBusy;
      if (apply) apply.disabled = unavailable || this.wifiBusy;
    }

    _setWifiMessage(text, tone = 'muted') {
      const node = this.container.querySelector('#device-wifi-message');
      if (!node) return;
      node.textContent = text;
      node.dataset.tone = tone;
    }

    async _refreshDeviceStatus() {
      if (!global.ApiClient || typeof global.ApiClient.fetchDeviceStatus !== 'function') {
        return null;
      }
      try {
        const status = await global.ApiClient.fetchDeviceStatus();
        this.deviceStatus = status;
        const internetLabels = {
          reachable: tr('text.reachable'),
          unreachable: tr('text.unavailable'),
          unknown: tr('text.not_checked'),
        };
        setText(
          this.container,
          'device-wifi-internet',
          internetLabels[status?.wifi?.internet_state] || tr('text.not_checked')
        );

        const bms = status?.bms;
        if (bms) {
          this.bmsConfigured = bms.configured === null || bms.configured === undefined
            ? null
            : Boolean(bms.configured);
          this._setBmsBusy(this.bmsBusy);
          const bmsLabels = {
            connected: [tr('text.connected'), 'success'],
            connecting: [tr('text.connection'), 'info'],
            disconnected: [
              this.bmsConfigured === false ? tr('text.not_selected') : this.bmsConfigured === null ? tr('text.no_data') : tr('text.no_connection'),
              'muted',
            ],
            error: [tr('text.settings_error'), 'warning'],
          };
          const bmsStatus =
            bmsLabels[bms.state] || [tr('text.no_data'), 'muted'];
          this._setStatus('device-bms-state', bmsStatus[0], bmsStatus[1]);

          const selectedLabel = this.bmsConfigured
            ? [bms.name, bms.address_hint].filter(Boolean).join(' · ')
            : null;
          setText(
            this.container,
            'device-bms-address',
            selectedLabel,
            this.bmsConfigured === true ? tr('text.selected') : this.bmsConfigured === false ? tr('text.not_selected') : '—'
          );
          setText(this.container, 'device-bms-model', bms.model);
          setText(this.container, 'device-bms-ble', bmsStatus[0]);
          const currentRssi = Number.isFinite(bms.rssi_dbm) ? bms.rssi_dbm : null;
          const lastRssi = Number.isFinite(bms.rssi_last_dbm) ? bms.rssi_last_dbm : null;
          const age = Number.isInteger(bms.rssi_last_age_s) && bms.rssi_last_age_s >= 0
            ? bms.rssi_last_age_s : null;
          const rssiText = currentRssi !== null
            ? `${currentRssi} dBm`
            : lastRssi !== null
              ? tr('device_settings.ble_last_signal', {
                  rssi: lastRssi,
                  seconds: age === null ? '?' : age,
                })
              : null;
          setText(this.container, 'device-bms-rssi', rssiText);
          // /api/device/status has no cell_count. The live telemetry handler
          // owns this field, so a status poll must not erase its value.
        }

        this._renderCloudStatus(status?.cloud || null);
        await this._refreshOtaStatus();
        return status;
      } catch (_error) {
        setText(this.container, 'device-wifi-internet', tr('text.not_checked'));
        this._renderCloudStatus(null);
        await this._refreshOtaStatus();
        return null;
      }
    }

    async _scanWifi() {
      if (this.wifiBusy || !global.ApiClient) return;
      const panel = this.container.querySelector('#device-wifi-panel');
      if (panel) panel.hidden = false;
      this._setWifiBusy(true);
      this._setWifiMessage(tr('text.scanning_networks'), 'info');
      try {
        const started = await global.ApiClient.startWifiScan();
        const snapshot = await global.ApiClient.waitForWifiOperation(
          started.operation.generation,
          {
            timeoutMs: 18000,
            onUpdate: operation => {
              this._setWifiMessage(wifiPhaseText(operation.phase), 'info');
            },
          }
        );
        this.wifiScan = snapshot;
        this.selectedWifi = null;
        this._renderWifiCandidates(snapshot?.candidates || []);
        const count = Array.isArray(snapshot?.candidates)
          ? snapshot.candidates.length
          : 0;
        this._setWifiMessage(
          count ? tr('device_settings.wifi_found', { count }) : tr('text.no_networks_found_you_can_enter_a_hidden_network_name'),
          count ? 'success' : 'muted'
        );
      } catch (error) {
        this._setWifiMessage(wifiErrorText(error), 'error');
      } finally {
        this._setWifiBusy(false);
      }
    }

    _renderWifiCandidates(candidates) {
      const root = this.container.querySelector('#device-wifi-candidates');
      if (!root) return;
      root.replaceChildren();

      for (const candidate of candidates) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'device-wifi-candidate';
        const selected =
          this.selectedWifi &&
          Number(this.selectedWifi.candidate_id) === Number(candidate.candidate_id);
        button.classList.toggle('is-selected', Boolean(selected));

        const info = document.createElement('span');
        info.className = 'device-wifi-candidate-info';
        const title = document.createElement('strong');
        title.setAttribute?.('data-i18n-ignore', '');
        title.textContent = candidate.ssid || tr('text.unnamed');
        const meta = document.createElement('small');
        meta.textContent = candidate.auth === 'open'
          ? tr('device_settings.wifi_open_channel', { channel: candidate.channel || '—' })
          : tr('device_settings.wifi_secure_channel', { security: candidate.auth || tr('text.secured'), channel: candidate.channel || '—' });
        info.append(title, meta);

        const signal = document.createElement('span');
        signal.className = 'device-wifi-candidate-signal';
        signal.textContent = Number.isFinite(Number(candidate.rssi_dbm))
          ? `${Number(candidate.rssi_dbm)} dBm`
          : '—';

        button.append(info, signal);
        button.addEventListener('click', () => {
          this.selectedWifi = candidate;
          const hiddenToggle = this.container.querySelector('#device-wifi-hidden-toggle');
          const hiddenField = this.container.querySelector('#device-wifi-hidden-field');
          if (hiddenToggle) hiddenToggle.checked = false;
          if (hiddenField) hiddenField.hidden = true;
          this._renderWifiCandidates(candidates);
          this._setWifiMessage(tr('device_settings.wifi_selected', { ssid: candidate.ssid || tr('text.network') }), 'info');
        });
        root.appendChild(button);
      }
    }

    async _configureWifi() {
      if (this.wifiBusy || !global.ApiClient) return;

      const hiddenToggle = this.container.querySelector('#device-wifi-hidden-toggle');
      const hiddenInput = this.container.querySelector('#device-wifi-hidden-ssid');
      const passwordInput = this.container.querySelector('#device-wifi-password');
      const hidden = Boolean(hiddenToggle?.checked);
      const password = passwordInput ? passwordInput.value : '';
      let request = null;

      if (hidden) {
        const hiddenSsid = hiddenInput ? hiddenInput.value.trim() : '';
        if (!hiddenSsid) {
          this._setWifiMessage(tr('text.enter_the_hidden_network_name'), 'error');
          return;
        }
        request = { hidden_ssid: hiddenSsid, password };
      } else {
        if (!this.wifiScan || !this.selectedWifi) {
          this._setWifiMessage(tr('text.select_a_network_after_scanning'), 'error');
          return;
        }
        if (this.selectedWifi.auth !== 'open' && !password) {
          this._setWifiMessage(tr('text.enter_the_selected_network_password'), 'error');
          return;
        }
        request = {
          scan_generation: this.wifiScan.scan_generation,
          candidate_id: this.selectedWifi.candidate_id,
          password,
        };
      }

      this._setWifiBusy(true);
      this._setWifiMessage(
        tr('text.checking_the_new_network_this_page_may_temporarily_lose_co'),
        'info'
      );
      try {
        const started = await global.ApiClient.configureWifi(request);
        request.password = '';
        if (passwordInput) passwordInput.value = '';

        await global.ApiClient.waitForWifiOperation(
          started.operation.generation,
          {
            timeoutMs: 42000,
            onUpdate: operation => {
              this._setWifiMessage(wifiPhaseText(operation.phase), 'info');
            },
          }
        );

        this.wifiScan = null;
        this.selectedWifi = null;
        this._renderWifiCandidates([]);
        await this._refreshDeviceStatus();
        if (typeof global.ApiClient.fetchLive === 'function') {
          global.ApiClient.fetchLive();
        }
        this._setWifiMessage(tr('text.new_wi_fi_network_verified_and_saved'), 'success');
      } catch (error) {
        request.password = '';
        if (passwordInput) passwordInput.value = '';
        this._setWifiMessage(wifiErrorText(error), 'error');
        await this._refreshDeviceStatus();
      } finally {
        this._setWifiBusy(false);
      }
    }

    async _reconnectWifi() {
      if (this.wifiBusy || !global.ApiClient) return;
      this._setWifiBusy(true);
      this._setWifiMessage(tr('text.reconnecting_to_saved_network'), 'info');
      try {
        const started = await global.ApiClient.reconnectWifi();
        await global.ApiClient.waitForWifiOperation(
          started.operation.generation,
          {
            timeoutMs: 36000,
            onUpdate: operation => {
              this._setWifiMessage(wifiPhaseText(operation.phase), 'info');
            },
          }
        );
        await this._refreshDeviceStatus();
        if (typeof global.ApiClient.fetchLive === 'function') {
          global.ApiClient.fetchLive();
        }
        this._setWifiMessage(tr('text.wi_fi_reconnected'), 'success');
      } catch (error) {
        this._setWifiMessage(wifiErrorText(error), 'error');
      } finally {
        this._setWifiBusy(false);
      }
    }

    async _resetWifi() {
      if (this.wifiBusy || !global.ApiClient) return;
      const confirmed = typeof global.confirm === 'function'
        ? global.confirm(
          tr('text.reset_wi_fi_settings_wattpost_will_forget_the_saved_networ')
        )
        : false;
      if (!confirmed) return;

      this._setWifiBusy(true);
      try {
        await global.ApiClient.resetWifi();
        const passwordInput = this.container.querySelector('#device-wifi-password');
        if (passwordInput) passwordInput.value = '';
        this._setWifiMessage(
          tr('text.wi_fi_settings_erased_wattpost_will_restart_in_first_setup'),
          'warning'
        );
      } catch (error) {
        this._setWifiMessage(wifiErrorText(error), 'error');
        this._setWifiBusy(false);
      }
    }


    _setBmsBusy(value) {
      this.bmsBusy = Boolean(value);
      const reconnect = this.container.querySelector('#device-bms-reconnect');
      const scan = this.container.querySelector('#device-bms-scan');
      const apply = this.container.querySelector('#device-bms-apply');
      const forget = this.container.querySelector('#device-bms-forget');
      const unavailable = this.capabilities.bmsManage === false;
      if (reconnect) reconnect.disabled = unavailable || this.bmsBusy || !this.bmsConfigured;
      if (scan) scan.disabled = unavailable || this.bmsBusy;
      if (apply) apply.disabled = unavailable || this.bmsBusy || !this.selectedBms;
      if (forget) forget.disabled = unavailable || this.capabilities.bmsForget === false || this.bmsBusy || !this.bmsConfigured;
    }

    _setBmsMessage(text, tone = 'muted') {
      const node = this.container.querySelector('#device-bms-message');
      if (!node) return;
      node.textContent = text;
      node.dataset.tone = tone;
    }

    async _scanBms() {
      if (this.bmsBusy || !global.ApiClient) return;
      const panel = this.container.querySelector('#device-bms-panel');
      if (panel) panel.hidden = false;
      this._setBmsBusy(true);
      this._setBmsMessage(tr('text.scanning_for_jk_bms'), 'info');
      try {
        const started = await global.ApiClient.startBmsScan();
        const snapshot = await global.ApiClient.waitForBmsOperation(
          started.operation.generation,
          {
            timeoutMs: this.capabilities.accountControls ? 35000 : 18000,
            onUpdate: operation => {
              this._setBmsMessage(bmsPhaseText(operation.phase), 'info');
            },
          }
        );
        this.bmsScan = snapshot;
        this.selectedBms = null;
        this._renderBmsCandidates(snapshot?.candidates || []);
        const count = Array.isArray(snapshot?.candidates)
          ? snapshot.candidates.length
          : 0;
        this._setBmsMessage(
          count
            ? tr('device_settings.bms_found', { count })
            : tr('text.no_jk_bms_found_check_power_and_distance_then_scan_again'),
          count ? 'success' : 'muted'
        );
      } catch (error) {
        this._setBmsMessage(bmsErrorText(error), 'error');
      } finally {
        this._setBmsBusy(false);
      }
    }

    _renderBmsCandidates(candidates) {
      const root = this.container.querySelector('#device-bms-candidates');
      if (!root) return;
      root.replaceChildren();

      for (const candidate of candidates) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'device-bms-candidate';
        const selected =
          this.selectedBms &&
          Number(this.selectedBms.candidate_id) === Number(candidate.candidate_id);
        button.classList.toggle('is-selected', Boolean(selected));

        const info = document.createElement('span');
        info.className = 'device-bms-candidate-info';
        const title = document.createElement('strong');
        title.setAttribute?.('data-i18n-ignore', '');
        title.textContent = candidate.name || 'JK BMS';
        const meta = document.createElement('small');
        meta.setAttribute?.('data-i18n-ignore', '');
        meta.textContent = candidate.address_hint || tr('text.address_hidden');
        info.append(title, meta);

        const signal = document.createElement('span');
        signal.className = 'device-bms-candidate-signal';
        signal.textContent = Number.isFinite(Number(candidate.rssi_dbm))
          ? `${Number(candidate.rssi_dbm)} dBm`
          : '—';

        button.append(info, signal);
        button.addEventListener('click', () => {
          this.selectedBms = candidate;
          this._renderBmsCandidates(candidates);
          this._setBmsMessage(
            tr('device_settings.bms_selected', { name: candidate.name || 'JK BMS', address: candidate.address_hint || '' }).trim(),
            'info'
          );
          this._setBmsBusy(this.bmsBusy);
        });
        root.appendChild(button);
      }
      this._setBmsBusy(this.bmsBusy);
    }

    async _selectBms() {
      if (this.bmsBusy || !global.ApiClient) return;
      if (!this.bmsScan || !this.selectedBms) {
        this._setBmsMessage(tr('text.scan_for_and_select_a_bms_first'), 'error');
        return;
      }

      if (this.bmsConfigured) {
        const confirmed = typeof global.confirm === 'function'
          ? global.confirm(
            tr('text.change_jk_bms_the_current_selection_will_be_replaced_only')
          )
          : false;
        if (!confirmed) return;
      }

      this._setBmsBusy(true);
      this._setBmsMessage(
        tr('text.connecting_to_jk_bms_and_checking_incoming_data'),
        'info'
      );
      try {
        const started = await global.ApiClient.selectBms({
          scan_generation: this.bmsScan.scan_generation,
          candidate_id: this.selectedBms.candidate_id,
        });
        await global.ApiClient.waitForBmsOperation(
          started.operation.generation,
          {
            timeoutMs: this.capabilities.accountControls ? 75000 : 45000,
            onUpdate: operation => {
              this._setBmsMessage(bmsPhaseText(operation.phase), 'info');
            },
          }
        );

        this.bmsScan = null;
        this.selectedBms = null;
        this._renderBmsCandidates([]);
        await this._refreshDeviceStatus();
        if (typeof global.ApiClient.fetchLive === 'function') {
          global.ApiClient.fetchLive();
        }
        this._setBmsMessage(tr('text.jk_bms_verified_and_saved'), 'success');
      } catch (error) {
        this._setBmsMessage(bmsErrorText(error), 'error');
        await this._refreshDeviceStatus();
      } finally {
        this._setBmsBusy(false);
      }
    }

    async _reconnectBms() {
      if (this.bmsBusy || !global.ApiClient) return;
      this._setBmsBusy(true);
      this._setBmsMessage(tr('text.reconnecting_to_saved_jk_bms'), 'info');
      try {
        const started = await global.ApiClient.reconnectBms();
        await global.ApiClient.waitForBmsOperation(
          started.operation.generation,
          {
            timeoutMs: this.capabilities.accountControls ? 55000 : 36000,
            onUpdate: operation => {
              this._setBmsMessage(bmsPhaseText(operation.phase), 'info');
            },
          }
        );
        await this._refreshDeviceStatus();
        if (typeof global.ApiClient.fetchLive === 'function') {
          global.ApiClient.fetchLive();
        }
        this._setBmsMessage(tr('text.jk_bms_reconnected'), 'success');
      } catch (error) {
        this._setBmsMessage(bmsErrorText(error), 'error');
      } finally {
        this._setBmsBusy(false);
      }
    }

    async _forgetBms() {
      if (this.capabilities.bmsForget === false || this.bmsBusy || !global.ApiClient || !this.bmsConfigured) return;
      const confirmed = typeof global.confirm === 'function'
        ? global.confirm(
          tr('text.forget_the_selected_jk_bms_wi_fi_and_history_will_be_prese')
        )
        : false;
      if (!confirmed) return;

      this._setBmsBusy(true);
      this._setBmsMessage(tr('text.forgetting_selected_bms'), 'warning');
      try {
        const started = await global.ApiClient.forgetBms();
        await global.ApiClient.waitForBmsOperation(
          started.operation.generation,
          {
            timeoutMs: 18000,
            onUpdate: operation => {
              this._setBmsMessage(bmsPhaseText(operation.phase), 'warning');
            },
          }
        );
        this.bmsScan = null;
        this.selectedBms = null;
        this._renderBmsCandidates([]);
        await this._refreshDeviceStatus();
        if (typeof global.ApiClient.fetchLive === 'function') {
          global.ApiClient.fetchLive();
        }
        this._setBmsMessage(
          tr('text.bms_selection_removed_wi_fi_and_history_are_preserved'),
          'success'
        );
      } catch (error) {
        this._setBmsMessage(bmsErrorText(error), 'error');
        await this._refreshDeviceStatus();
      } finally {
        this._setBmsBusy(false);
      }
    }



    _setCloudBusy(value) {
      this.cloudBusy = Boolean(value);
      this._renderCloudStatus(this.deviceStatus?.cloud || null);
    }

    _setCloudMessage(text, tone = 'muted') {
      const node = this.container.querySelector('#device-cloud-message');
      if (!node) return;
      node.textContent = text;
      node.dataset.tone = tone;
    }

    _renderCloudStatus(cloud) {
      const connect = this.container.querySelector('#device-cloud-connect');
      const disconnect = this.container.querySelector('#device-cloud-disconnect');

      if (!cloud) {
        this._setStatus('device-remote-state', tr('text.no_data'), 'muted');
        setText(this.container, 'device-cloud-transport', '—');
        setText(this.container, 'device-cloud-account', '—');
        this._setCloudMessage(
          tr('text.could_not_verify_cloud_connection_make_sure_wattpost_has_i'),
          'warning'
        );
        if (connect) {
          connect.hidden = false;
          connect.disabled = this.capabilities.cloudManage === false || this.cloudBusy;
          connect.textContent = this.cloudBusy ? tr('text.connecting') : tr('text.try_again');
        }
        if (disconnect) disconnect.hidden = true;
        return;
      }

      const transportLabels = {
        online: tr('text.reachable'),
        connecting: tr('text.connection'),
        backoff: tr('text.temporarily_unavailable'),
        waiting_network: tr('text.waiting_for_internet'),
        disabled: tr('text.unavailable'),
      };
      setText(
        this.container,
        'device-cloud-transport',
        transportLabels[cloud.transport_state] || tr('text.unknown')
      );

      const actionRunning = cloud?.operation?.state === 'running';
      const pairingState = cloud?.pairing?.state || 'none';
      const pairedKnown = cloud.paired_known === true;
      const paired = pairedKnown && cloud.paired === true;
      const disconnectPending = cloud.disconnect_pending === true;

      if (disconnectPending) {
        this._setStatus('device-remote-state', tr('text.disconnecting'), 'warning');
        setText(this.container, 'device-cloud-account', tr('text.waiting_for_synchronization'));
        this._setCloudMessage(
          cloud.network_available
            ? tr('text.wattpost_is_disconnecting_the_previous_cloud_account')
            : tr('text.disconnect_request_saved_it_will_finish_automatically_when'),
          'warning'
        );
      } else if (paired) {
        this._setStatus('device-remote-state', tr('text.connected'), 'success');
        setText(this.container, 'device-cloud-account', tr('text.connected'));
        this._setCloudMessage(
          tr('text.remote_access_connected_wattpost_continues_to_operate_inde'),
          'success'
        );
      } else if (pairingState === 'requesting') {
        this._setStatus('device-remote-state', tr('text.connection'), 'info');
        setText(this.container, 'device-cloud-account', tr('text.creating_link'));
        this._setCloudMessage(
          cloud.network_available
            ? tr('text.creating_a_one_time_link_for_wattpost_pp_ua')
            : tr('text.internet_is_required_to_create_a_link'),
          cloud.network_available ? 'info' : 'warning'
        );
      } else if (pairingState === 'pending') {
        this._setStatus('device-remote-state', tr('text.waiting_for_sign_in'), 'info');
        setText(this.container, 'device-cloud-account', tr('text.awaiting_verification'));
        this._setCloudMessage(
          tr('text.one_time_link_ready_sign_in_or_register_at_wattpost_pp_ua'),
          'info'
        );
      } else if (!pairedKnown) {
        this._setStatus(
          'device-remote-state',
          cloud.network_available ? tr('text.checking') : tr('text.cloud_unavailable_0eb4ed'),
          cloud.network_available ? 'info' : 'warning'
        );
        setText(this.container, 'device-cloud-account', tr('text.unknown_status'));
        this._setCloudMessage(
          cloud.network_available
            ? tr('text.wattpost_is_checking_remote_access_status')
            : tr('text.no_internet_connection_local_dashboard_history_and_bms_con'),
          cloud.network_available ? 'info' : 'warning'
        );
      } else {
        this._setStatus(
          'device-remote-state',
          cloud.network_available ? tr('text.not_connected') : tr('text.cloud_unavailable_0eb4ed'),
          cloud.network_available ? 'muted' : 'warning'
        );
        setText(this.container, 'device-cloud-account', tr('text.not_connected'));
        if (pairingState === 'expired') {
          this._setCloudMessage(
            tr('text.the_previous_link_expired_create_a_new_pairing'),
            'warning'
          );
        } else if (pairingState === 'cancelled') {
          this._setCloudMessage(
            tr('text.previous_pairing_cancelled_you_can_create_a_new_one'),
            'muted'
          );
        } else if (pairingState === 'error') {
          this._setCloudMessage(
            cloudErrorText({ code: cloud?.operation?.error_code || 'request_failed' }),
            'error'
          );
        } else {
          this._setCloudMessage(
            cloud.network_available
              ? tr('text.connect_wattpost_to_your_account_at_wattpost_pp_ua')
              : tr('text.cloud_pairing_requires_internet_local_operation_does_not_d'),
            cloud.network_available ? 'muted' : 'warning'
          );
        }
      }

      if (connect) {
        connect.hidden = paired || disconnectPending;
        connect.textContent = this.cloudBusy
          ? tr('text.connecting')
          : (pairingState === 'pending'
          ? tr('text.continue')
          : (pairingState === 'requesting'
            ? tr('text.connecting')
            : (pairingState === 'error' || cloud?.operation?.state === 'error'
              ? tr('text.try_again')
              : tr('text.connect_to_account'))));
        connect.disabled =
          this.capabilities.cloudManage === false ||
          this.cloudBusy ||
          actionRunning ||
          cloud.transport_state === 'disabled';
      }
      if (disconnect) {
        disconnect.hidden = !paired && !disconnectPending;
        disconnect.disabled = this.capabilities.cloudManage === false || this.cloudBusy || actionRunning || disconnectPending;
        disconnect.textContent = disconnectPending
          ? tr('text.disconnecting_25cad3')
          : tr('text.disconnect_cloud');
      }
    }

    async startCloudConnectFlow() {
      if (this.cloudBusy || !global.ApiClient) return;

      this._setCloudBusy(true);
      try {
        if (this._initialStatusPromise) {
          await this._initialStatusPromise;
          this._initialStatusPromise = null;
        }

        const existingPairUrl = safePairUrl(
          this.deviceStatus?.cloud?.pairing?.pair_url
        );
        if (
          this.deviceStatus?.cloud?.pairing?.state === 'pending' &&
          existingPairUrl
        ) {
          this._setCloudMessage(tr('text.opening_wattpost_cloud'), 'info');
          if (global.location && typeof global.location.assign === 'function') {
            global.location.assign(existingPairUrl);
            return;
          }
          throw { code: 'invalid_response' };
        }

        this._setCloudMessage(tr('text.connecting_wattpost_to_cloud'), 'info');
        const started = await global.ApiClient.startCloudPairing();
        const snapshot = await global.ApiClient.waitForCloudOperation(
          started.operation.generation,
          {
            timeoutMs: 20000,
            onUpdate: (_operation, current) => {
              this.deviceStatus = current;
              this._renderCloudStatus(current?.cloud || null);
            },
          }
        );
        this.deviceStatus = snapshot;
        this._renderCloudStatus(snapshot?.cloud || null);

        const pairUrl = safePairUrl(snapshot?.cloud?.pairing?.pair_url);
        if (!pairUrl) {
          throw { code: 'invalid_response' };
        }

        this._setCloudMessage(tr('text.opening_wattpost_cloud'), 'info');
        if (global.location && typeof global.location.assign === 'function') {
          global.location.assign(pairUrl);
        } else {
          throw { code: 'invalid_response' };
        }
      } catch (error) {
        await this._refreshDeviceStatus();
        this._setCloudMessage(cloudErrorText(error), error?.code === 'operation_timeout' ? 'warning' : 'error');
      } finally {
        this._setCloudBusy(false);
      }
    }

    async _disconnectCloud() {
      if (this.cloudBusy || !global.ApiClient) return;
      const confirmed = typeof global.confirm === 'function'
        ? global.confirm(
          tr('text.disconnect_wattpost_from_the_current_cloud_account_wi_fi_b')
        )
        : false;
      if (!confirmed) return;

      this._setCloudBusy(true);
      this._setCloudMessage(tr('text.saving_cloud_disconnection'), 'warning');
      try {
        const started = await global.ApiClient.disconnectCloud();
        try {
          const snapshot = await global.ApiClient.waitForCloudOperation(
            started.operation.generation,
            {
              timeoutMs: 8000,
              onUpdate: (_operation, current) => {
                this.deviceStatus = current;
                this._renderCloudStatus(current?.cloud || null);
              },
            }
          );
          this.deviceStatus = snapshot;
          this._renderCloudStatus(snapshot?.cloud || null);
          this._setCloudMessage(
            tr('text.cloud_account_disconnected_wi_fi_bms_and_local_history_are'),
            'success'
          );
        } catch (error) {
          await this._refreshDeviceStatus();
          if (
            error?.code === 'operation_timeout' &&
            this.deviceStatus?.cloud?.disconnect_pending
          ) {
            this._setCloudMessage(
              tr('text.disconnect_request_saved_it_will_finish_automatically_when'),
              'warning'
            );
          } else {
            throw error;
          }
        }
      } catch (error) {
        this._setCloudMessage(cloudErrorText(error), 'error');
        await this._refreshDeviceStatus();
      } finally {
        this._setCloudBusy(false);
      }
    }

    _setSystemBusy(value) {
      this.systemBusy = Boolean(value);
      const reboot = this.container.querySelector('#device-system-reboot');
      const toggle = this.container.querySelector('#device-system-factory-toggle');
      const cancel = this.container.querySelector('#device-system-factory-cancel');
      if (reboot) reboot.disabled = this.capabilities.systemReboot === false || this.systemBusy;
      if (toggle) toggle.disabled = this.capabilities.systemFactoryReset === false || this.systemBusy;
      if (cancel) cancel.disabled = this.capabilities.systemFactoryReset === false || this.systemBusy;
      this._updateFactoryResetButton();
    }

    _updateFactoryResetButton() {
      const confirm = this.container.querySelector('#device-system-factory-confirm');
      const run = this.container.querySelector('#device-system-factory-run');
      if (run) {
        run.disabled = this.capabilities.systemFactoryReset === false || this.systemBusy || !Boolean(confirm?.checked);
      }
    }

    _setSystemMessage(text, tone = 'muted') {
      const node = this.container.querySelector('#device-system-message');
      if (!node) return;
      node.textContent = text;
      node.dataset.tone = tone;
    }

    async _rebootDevice() {
      if (this.systemBusy || !global.ApiClient) return;
      const confirmed = typeof global.confirm === 'function'
        ? global.confirm(
          tr('text.restart_wattpost_settings_and_history_will_be_preserved')
        )
        : false;
      if (!confirmed) return;

      this._setSystemBusy(true);
      this._setSystemMessage(tr('text.wattpost_is_restarting'), 'warning');
      try {
        await global.ApiClient.rebootDevice();
      } catch (error) {
        this._setSystemMessage(systemErrorText(error), 'error');
        this._setSystemBusy(false);
      }
    }

    async _factoryResetDevice() {
      if (this.systemBusy || !global.ApiClient) return;
      const confirm = this.container.querySelector('#device-system-factory-confirm');
      if (!confirm?.checked) {
        this._setSystemMessage(tr('text.confirm_the_wattpost_factory_reset'), 'error');
        return;
      }

      this._setSystemBusy(true);
      this._setSystemMessage(
        tr('text.factory_reset_started_wattpost_will_erase_local_settings_a'),
        'warning'
      );
      try {
        await global.ApiClient.factoryResetDevice();
      } catch (error) {
        this._setSystemMessage(systemErrorText(error), 'error');
        this._setSystemBusy(false);
      }
    }

    _acceptOtaPreferences(payload, write = false) {
      const preference = payload?.data || payload;
      if (!preference || typeof preference !== 'object') return;
      if (typeof preference.automatic_updates_supported === 'boolean') {
        this.otaPreferences.supported = preference.automatic_updates_supported;
      } else if (write && typeof preference.automatic_updates === 'boolean') {
        this.otaPreferences.supported = true;
      }
      if (Object.hasOwn(preference, 'automatic_updates')) {
        this.otaPreferences.confirmed = typeof preference.automatic_updates === 'boolean'
          ? preference.automatic_updates : null;
      }
      if (Object.hasOwn(preference, 'automatic_updates_pending')) {
        this.otaPreferences.pending = preference.automatic_updates_pending || null;
      } else if (write) this.otaPreferences.pending = null;
    }

    _acceptOtaStatus(status) {
      this.otaStatus = status;
      this.otaCheckConfirmed = true;
      this.otaCheckFailed = false;
      this.otaCheckedAt = Date.now();
      this._acceptOtaPreferences(status);
      this._renderOtaStatus(status);
    }

    _otaCheckIsCurrent() {
      const age = Date.now() - this.otaCheckedAt;
      return this.otaCheckConfirmed && !this.otaCheckFailed && age >= 0 && age <= 30000;
    }

    _canInstallOta(status = this.otaStatus) {
      const release = status?.latest_release;
      const state = status?.state;
      const targetConfirmed = typeof release?.version === 'string' && Boolean(release.version.trim());
      const retry = ['failed', 'rolled_back'].includes(state?.state) &&
        state?.release_id != null && state.release_id === release?.release_id;
      return this.capabilities.firmwareOta !== false && this._otaCheckIsCurrent() &&
        targetConfirmed && (status?.update_available === true || retry) &&
        !this.otaBusy && !['downloading', 'verifying', 'installing'].includes(state?.state);
    }

    async _refreshOtaStatus() {
      if (!global.ApiClient ||
          this.capabilities.firmwareOta === false ||
          typeof global.ApiClient.fetchOtaStatus !== 'function') {
        this._renderOtaStatus(null);
        return null;
      }
      try {
        const status = await global.ApiClient.fetchOtaStatus();
        if (this.otaBusy && this.otaRequestAccepted && otaRequestHasProgressed(status)) {
          this.otaBusy = false;
          this.otaRequestAccepted = false;
        }
        this._acceptOtaStatus(status);
        return status;
      } catch (_error) {
        this.otaCheckFailed = true;
        this._renderOtaStatus(this.otaStatus, true);
        return null;
      }
    }

    _renderOtaStatus(status, requestFailed = false) {
      if (!this.container) return;
      if (requestFailed) this.otaCheckFailed = true;
      const automatic = this.container.querySelector('#device-ota-automatic');
      const automaticToggle = this.container.querySelector('#device-ota-automatic-toggle');
      const automaticSupported =
        this.capabilities.firmwareOtaPreference === true &&
        this.otaPreferences.supported === true;
      const automaticEnabled = this.otaPreferences.confirmed === true;
      const pendingPreference = this.otaPreferences.pending &&
        typeof this.otaPreferences.pending === 'object'
        ? this.otaPreferences.pending
        : null;
      const pendingDesired = typeof pendingPreference?.automatic_updates === 'boolean'
        ? pendingPreference.automatic_updates
        : null;
      if (automatic) {
        automatic.textContent = automaticSupported && this.otaPreferences.confirmed !== null
          ? (automaticEnabled ? tr('text.enabled') : tr('text.disabled'))
          : '—';
        if (pendingDesired !== null) automatic.textContent += pendingDesired
          ? tr('text.enable_request_pending') : tr('text.disable_request_pending');
      }

      const release = status?.latest_release && typeof status.latest_release === 'object'
        ? status.latest_release
        : null;
      const state = status?.state && typeof status.state === 'object' ? status.state : null;
      const stateName = state?.state || null;
      const available = Boolean(status?.update_available || stateName === 'failed' || stateName === 'rolled_back');
      const active = ['downloading', 'verifying', 'installing'].includes(stateName);
      if (automaticToggle) {
        const desired = this.otaPreferenceDesired ?? pendingDesired ?? automaticEnabled;
        automaticToggle.checked = desired;
        automaticToggle.disabled = !automaticSupported ||
          (this.otaPreferences.confirmed === null && pendingDesired === null) || this.otaPreferenceBusy;
        automaticToggle.setAttribute('aria-checked', desired ? 'true' : 'false');
      }
      const disableAutomatic = this.container.querySelector('#device-ota-disable-automatic');
      if (disableAutomatic) {
        disableAutomatic.hidden = this.capabilities.firmwareOtaPreference !== true ||
          this.otaPreferences.supported === false ||
          (automaticSupported && (this.otaPreferences.confirmed !== null || pendingDesired !== null));
        disableAutomatic.disabled = this.otaPreferenceBusy;
      }
      const row = this.container.querySelector('#device-ota-release-row');
      const targetVersion = release?.version || state?.version || null;
      if (row) row.hidden = !targetVersion || (!available && !active);
      setText(this.container, 'device-ota-release', targetVersion);

      const button = this.container.querySelector('#device-ota-install');
      if (button) {
        if (this.otaBusy) {
          button.textContent = this.otaRequestAccepted
            ? tr('text.waiting_for_device')
            : tr('text.sending');
        } else if (stateName === 'downloading') {
          button.textContent = tr('text.loading');
        } else if (stateName === 'verifying') {
          button.textContent = tr('text.checking_f47ed3');
        } else if (stateName === 'installing') {
          button.textContent = tr('text.installing_85769b');
        } else {
          button.textContent = stateName === 'failed' || stateName === 'rolled_back'
            ? tr('text.try_again')
            : tr('text.update_now');
        }
        button.disabled = !this._canInstallOta(status);
      }

      let badgeLabel = null;
      let badgeTone = 'info';
      if (this.otaCheckFailed || (this.otaCheckConfirmed && !this._otaCheckIsCurrent())) {
        badgeLabel = tr('text.verification_failed');
        badgeTone = 'warning';
      } else if (this.otaBusy) {
        badgeLabel = this.otaRequestAccepted ? tr('text.waiting_for_device_ac4aa3') : tr('text.starting_update');
      } else if (active || stateName === 'offered' || stateName === 'available' ||
          stateName === 'success' || stateName === 'failed' || stateName === 'rolled_back') {
        badgeLabel = remoteOtaStateText(stateName);
        badgeTone = stateName === 'success' ? 'success'
          : stateName === 'failed' ? 'error'
            : stateName === 'rolled_back' ? 'warning'
              : active ? 'warning' : 'info';
      } else if (available) {
        badgeLabel = tr('text.update_available');
      } else if (status) {
        badgeLabel = release ? tr('text.up_to_date') : tr('text.no_new_updates');
        badgeTone = release ? 'success' : 'info';
      }
      if (badgeLabel) this._setStatus('device-firmware-state', badgeLabel, badgeTone);

      this._renderOtaProgress(status);
      const message = this.container.querySelector('#device-ota-message');
      if (!message) return;
      let text = this.otaPreferences.confirmed === null
        ? tr('text.automatic_update_status_is_not_yet_confirmed_you_can_disab')
        : automaticEnabled
        ? tr('text.wattpost_automatically_checks_for_and_installs_published_u')
        : tr('text.automatic_updates_are_disabled_new_releases_remain_visible');
      let tone = 'muted';
      if (this.otaPreferenceBusy) {
        text = tr('text.sending_automatic_update_setting_to_the_device');
        tone = 'info';
      } else if (pendingDesired !== null) {
        text = tr('device_settings.ota_preference_pending', { state: pendingDesired ? tr('text.enabled') : tr('text.disabled') });
        tone = 'info';
      } else if (status && !automaticSupported &&
                 this.capabilities.firmwareOtaPreference === true) {
        text = tr('text.waiting_for_wattpost_to_confirm_the_local_automatic_update');
        tone = 'muted';
      } else if (this.otaBusy) {
        text = this.otaRequestAccepted
          ? tr('text.update_request_accepted_waiting_for_wattpost_to_begin_down')
          : tr('text.sending_update_request');
        tone = 'info';
      } else if (stateName === 'downloading') {
        text = tr('text.wattpost_is_downloading_signed_firmware_the_current_versio');
        tone = 'info';
      } else if (stateName === 'verifying') {
        text = tr('text.verifying_firmware_size_sha_256_and_digital_signature');
        tone = 'info';
      } else if (stateName === 'installing') {
        text = tr('text.update_installed_wattpost_is_restarting_and_validating_the');
        tone = 'warning';
      } else if (stateName === 'success') {
        text = tr('text.update_installed_and_confirmed_successfully');
        tone = 'success';
      } else if (stateName === 'rolled_back') {
        text = tr('text.new_version_did_not_pass_validation_wattpost_restored_the');
        tone = 'warning';
      } else if (stateName === 'failed') {
        text = tr('text.update_not_installed_the_current_firmware_continues_runnin');
        tone = 'error';
      } else if (available && targetVersion) {
        const changelog = typeof release?.changelog === 'string' ? release.changelog.trim() : '';
        text = changelog || (automaticEnabled
          ? tr('device_settings.ota_available_auto', { version: targetVersion })
          : tr('device_settings.ota_available_manual', { version: targetVersion }));
        tone = 'info';
      }
      if (OTA_TERMINAL_STATES.includes(stateName) && this._isOtaResultDismissed(state)) {
        text = automaticEnabled
          ? tr('text.wattpost_automatically_checks_for_and_installs_published_u')
          : tr('text.automatic_updates_are_disabled_new_versions_install_only_a');
        tone = 'muted';
      }
      if (this.otaCheckFailed) {
        text = tr('text.could_not_verify_the_new_firmware_installation_is_unavaila') +
          (active ? tr('text.last_known_status') : '') + text;
        tone = 'warning';
      } else if (this.otaCheckConfirmed && !this._otaCheckIsCurrent()) {
        text = tr('text.firmware_verification_is_stale_waiting_for_a_new_check') + text;
        tone = 'warning';
      }
      if (active && !automaticEnabled && this.otaPreferences.confirmed !== null) {
        text += tr('text.disabling_auto_updates_does_not_stop_an_installation_that');
      }
      if (this.otaPreferenceError) {
        text += ' ' + this.otaPreferenceError;
        tone = 'warning';
      }
      message.textContent = text;
      message.dataset.tone = tone;
    }

    _otaResultIdentity(state) {
      if (!state || !OTA_TERMINAL_STATES.includes(state.state)) return null;
      // The Cloud status includes a stable timestamp and attempt number.
      // Local firmware may omit them; the release and outcome still identify
      // a result, and a new manual attempt explicitly clears its dismissal.
      return JSON.stringify([
        state.release_id ?? state.version ?? null,
        state.attempt_count ?? null,
        state.state,
        state.updated_at ?? null,
      ]);
    }

    _otaDismissStorageKey() {
      // localStorage is already origin-scoped. Include the path so one Cloud
      // device's dismissed result cannot hide another device's OTA status.
      return OTA_DISMISS_STORAGE_PREFIX + (global.location?.pathname || '/');
    }

    _isOtaResultDismissed(state) {
      const resultId = this._otaResultIdentity(state);
      if (!resultId) return false;
      if (this.otaDismissedResult === resultId) return true;
      try {
        return global.localStorage?.getItem(this._otaDismissStorageKey()) === resultId;
      } catch (_error) {
        return false; // Restricted browser storage must not break OTA status.
      }
    }

    _dismissOtaResult() {
      const state = this.otaStatus?.state;
      const resultId = this._otaResultIdentity(state);
      if (!resultId) return; // Active downloads/installations are not dismissible.
      this.otaDismissedResult = resultId;
      try {
        global.localStorage?.setItem(this._otaDismissStorageKey(), resultId);
      } catch (_error) {
        // Still hide for this page when storage is unavailable.
      }
      this._renderOtaStatus(this.otaStatus);
    }

    _resetOtaDismissal() {
      this.otaDismissedResult = null;
      try {
        global.localStorage?.removeItem(this._otaDismissStorageKey());
      } catch (_error) {
        // No persistent storage; this page can still proceed normally.
      }
    }

    _renderOtaProgress(status) {
      const panel = this.container?.querySelector('#device-ota-progress');
      if (!panel) return;
      const state = status?.state || {};
      const phase = state.state;
      const isTerminal = OTA_TERMINAL_STATES.includes(phase);
      const dismissed = isTerminal && this._isOtaResultDismissed(state);
      const dismissButton = this.container.querySelector('#device-ota-progress-dismiss');
      if (dismissButton) dismissButton.hidden = !isTerminal || dismissed;
      const waiting = (this.otaBusy || (phase === 'offered' && state.trigger === 'manual')) &&
        !['downloading', 'installing', 'success', 'failed', 'rolled_back'].includes(phase);
      const visible = waiting || ['downloading', 'verifying', 'installing', 'success', 'failed', 'rolled_back'].includes(phase);
      panel.hidden = !visible || dismissed;
      if (panel.hidden) return;

      const stage = panel.querySelector?.('#device-ota-progress-stage') ||
        this.container.querySelector('#device-ota-progress-stage');
      const percent = this.container.querySelector('#device-ota-progress-percent');
      const detail = this.container.querySelector('#device-ota-progress-detail');
      const track = this.container.querySelector('#device-ota-progress-track');
      const fill = this.container.querySelector('#device-ota-progress-fill');
      const total = Number(state.total_bytes);
      const received = Number(state.downloaded_bytes);
      const hasProgress = state.downloaded_bytes !== null &&
        state.downloaded_bytes !== undefined && Number.isSafeInteger(received) &&
        Number.isSafeInteger(total) && total > 0 && received >= 0 && received <= total;
      const pct = hasProgress ? Math.floor(received * 100 / total) : null;
      const attempt = Number(state.download_attempt);
      let label = tr('text.waiting_for_device_confirmation');
      let description = this.otaBusy && !this.otaRequestAccepted
        ? tr('text.sending_update_request')
        : tr('text.request_accepted_wattpost_will_start_the_update_itself');
      let value = '';
      let progressWidth = '0%';
      let moving = true;

      if (phase === 'downloading') {
        label = tr('text.downloading_firmware');
        description = hasProgress
          ? tr('device_settings.ota_received_mb', { received: (received / 1000000).toFixed(2), total: (total / 1000000).toFixed(2) })
          : tr('text.device_is_downloading_firmware_waiting_for_transfer_size');
        if (hasProgress) {
          value = `${pct}%`;
          progressWidth = `${pct}%`;
          moving = false;
        }
        if (Number.isInteger(attempt) && attempt > 1) {
          description += tr('device_settings.ota_attempt', { attempt });
        }
      } else if (phase === 'verifying') {
        label = tr('text.verifying_firmware');
        description = tr('text.download_complete_checking_firmware_integrity');
      } else if (phase === 'installing') {
        label = tr('text.restart_and_verification');
        description = tr('text.download_complete_waiting_for_new_firmware_to_start_and_es');
      } else if (phase === 'success') {
        label = tr('text.update_complete');
        description = tr('text.device_confirmed_successful_boot_of_new_firmware');
        progressWidth = '100%';
        moving = false;
      } else if (phase === 'failed' || phase === 'rolled_back') {
        label = phase === 'rolled_back' ? tr('text.previous_firmware_restored') : tr('text.update_failed');
        description = tr('text.update_did_not_complete_current_firmware_continues_running');
        moving = false;
      }
      if (this.otaCheckFailed) {
        description += tr('text.status_could_not_be_refreshed_showing_last_confirmed_state');
      }
      if (stage) stage.textContent = label;
      if (percent) percent.textContent = value;
      if (detail) detail.textContent = description;
      if (track) track.dataset.mode = moving ? 'waiting' : 'known';
      if (fill) fill.style.width = progressWidth;
      panel.dataset.phase = phase || 'waiting';
    }

    async _setOtaAutomaticUpdates(enabled) {
      if (this.otaPreferenceBusy || !global.ApiClient ||
          this.capabilities.firmwareOtaPreference !== true ||
          typeof global.ApiClient.setOtaAutomaticUpdates !== 'function') {
        this._renderOtaStatus(this.otaStatus);
        return;
      }

      this.otaPreferenceBusy = true;
      this.otaPreferenceDesired = enabled;
      this.otaPreferenceError = null;
      this._renderOtaStatus(this.otaStatus);
      try {
        const result = await global.ApiClient.setOtaAutomaticUpdates(enabled);
        this._acceptOtaPreferences(result, true);
        await this._refreshOtaStatus();
      } catch (_error) {
        this.otaPreferenceError = _error?.code === 'ota_preferences_unsupported'
            ? tr('text.device_has_not_yet_confirmed_support_for_synchronizing_thi')
            : tr('text.could_not_save_automatic_update_settings');
      } finally {
        this.otaPreferenceBusy = false;
        this.otaPreferenceDesired = null;
        this._renderOtaStatus(this.otaStatus);
      }
    }

    async _waitForOtaStart() {
      for (let attempt = 0;
           attempt < OTA_START_POLL_ATTEMPTS && this.otaBusy && this.otaRequestAccepted;
           attempt += 1) {
        if (attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, OTA_START_POLL_INTERVAL_MS));
        }
        await this._refreshOtaStatus();
      }
    }

    async _installOtaUpdate() {
      if (!this._canInstallOta() || !global.ApiClient ||
          typeof global.ApiClient.installOtaUpdate !== 'function') return;
      this.otaBusy = true;
      this.otaRequestAccepted = false;
      this._renderOtaStatus(this.otaStatus);
      try {
        await global.ApiClient.installOtaUpdate();
        this._resetOtaDismissal();
        this.otaRequestAccepted = true;
        this._renderOtaStatus(this.otaStatus);
        await this._waitForOtaStart();
      } catch (error) {
        this.otaBusy = false;
        this.otaRequestAccepted = false;
        this._renderOtaStatus(this.otaStatus);
        const message = this.container.querySelector('#device-ota-message');
        if (message) {
          const code = error && (error.code || error.message);
          message.textContent = code === 'no_update'
            ? tr('text.no_new_version_is_available_right_now')
            : code === 'not_paired'
              ? tr('text.connect_wattpost_to_cloud_to_receive_updates')
              : code === 'busy'
                ? tr('text.wattpost_is_already_updating')
                : tr('text.could_not_start_update_try_again');
          message.dataset.tone = code === 'no_update' ? 'muted' : 'warning';
        }
      }
    }

    _setStatus(id, label, tone) {
      const badge = this.container.querySelector('#' + id);
      if (!badge) return;
      badge.textContent = label;
      badge.dataset.tone = tone;
    }

    onLive(data, state) {
      if (!this.container) return;

      const hasLive = Boolean(data);
      const localChip = this.container.querySelector('#device-local-state');
      setText(
        this.container,
        'device-local-state-text',
        hasLive ? tr('text.wattpost_is_online') : tr('text.waiting_for_wattpost')
      );
      if (localChip) localChip.dataset.tone = hasLive ? 'success' : 'muted';

      const wifiState = data && data.wifi_state;
      const wifiConfigured = data && data.remote === true
        ? null
        : Boolean(data && data.wifi_configured);
      this.wifiConfigured = wifiConfigured;
      this._setWifiBusy(this.wifiBusy);
      const wifiLabels = {
        connected: [tr('text.connected'), 'success'],
        connecting: [tr('text.connection'), 'info'],
        disconnected: [wifiConfigured === false ? tr('text.not_configured') : tr('text.no_connection'), 'muted'],
        error: [tr('text.settings_error'), 'warning'],
      };
      const wifiStatus = wifiLabels[wifiState] || [tr('text.no_data'), 'muted'];
      this._setStatus('device-wifi-state', wifiStatus[0], wifiStatus[1]);
      setText(
        this.container,
        'device-wifi-ssid',
        wifiConfigured === true && data && data.wifi_ssid ? data.wifi_ssid : null,
        wifiConfigured === null ? '—' : wifiConfigured ? tr('text.hidden_unnamed') : tr('text.not_configured')
      );
      const wifiRssi = data && Number.isFinite(Number(data.wifi_rssi_dbm))
        ? Number(data.wifi_rssi_dbm) + ' dBm'
        : null;
      setText(this.container, 'device-wifi-rssi', wifiRssi);

      // BMS identity and connection state belong to /api/device/status.
      // /api/live intentionally updates only volatile telemetry here; otherwise
      // the two asynchronous sources race and make the card visibly alternate
      // between the selected BMS label/status representations.
      const liveCellCount = Number.isInteger(data && data.cell_count) && data.cell_count > 0
        ? data.cell_count
        : null;
      const settingsCellCount = Number.isInteger(this.deviceStatus?.bms?.cell_count) && this.deviceStatus.bms.cell_count > 0
        ? this.deviceStatus.bms.cell_count
        : null;
      setText(this.container, 'device-bms-cells', liveCellCount || settingsCellCount);

      const firmwareVersion = data && data.firmware_version;
      const otaValidationPending = Boolean(data && data.ota_validation_pending);
      if (!this.otaStatus || otaValidationPending) {
        this._setStatus(
          'device-firmware-state',
          otaValidationPending ? tr('text.validating_after_update') : (firmwareVersion ? tr('text.installed') : tr('text.no_data')),
          otaValidationPending ? 'warning' : (firmwareVersion ? 'info' : 'muted')
        );
      } else {
        this._renderOtaStatus(this.otaStatus);
      }
      setText(this.container, 'device-firmware-version', firmwareVersion);
      setText(this.container, 'device-build-id', data && data.build_id);
      setText(this.container, 'device-ota-state', otaStateText(data && data.ota_state));
      setText(this.container, 'device-uptime', data && formatUptime(data.esp_uptime));
      setText(this.container, 'device-restart-reason', restartReasonText(data && data.last_restart_reason));

      void state;
    }
  }

  global.DeviceSettingsView = DeviceSettingsView;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DeviceSettingsView, formatUptime, safePairUrl };
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
