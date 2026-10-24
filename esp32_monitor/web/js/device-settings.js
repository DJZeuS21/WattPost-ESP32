/* device-settings.js — WattPost device settings.
 *
 * This view intentionally separates ESP32/WattPost settings from JK BMS
 * parameter settings. Wi-Fi/BMS management uses the centralized ApiClient;
 * remote access remains unavailable until the later Cloud stage.
 */

(function (global) {
  'use strict';

  function setText(root, id, value, fallback = '—') {
    const node = root.querySelector('#' + id);
    if (!node) return;
    const normalized = value === undefined || value === null || value === '' ? fallback : String(value);
    node.textContent = normalized;
  }

  function localOnlyActionMessage() {
    return 'Ця дія доступна лише при локальному підключенні до WattPost.';
  }

  function localOnlyPageMessage() {
    return 'Wi-Fi та системні дії доступні лише локально. Підключення JK BMS та оновлення прошивки доступні також через WattPost Cloud; параметри BMS через Cloud не змінюються.';
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
    if (days > 0) return `${days} д ${hours} год`;
    if (hours > 0) return `${hours} год ${minutes} хв`;
    return `${minutes} хв`;
  }

  const WIFI_ERROR_TEXT = {
    busy: 'WattPost уже змінює Wi-Fi. Дочекайтеся завершення.',
    stale_scan: 'Результати сканування застаріли. Запустіть сканування ще раз.',
    candidate_not_found: 'Вибрана мережа більше не доступна у результатах сканування.',
    wifi_auth_failed: 'Wi-Fi відхилив пароль. Попередня мережа залишається збереженою.',
    wifi_not_found: 'Мережу не знайдено. Попередня мережа залишається збереженою.',
    wifi_connect_failed: 'Не вдалося підключитися. WattPost відновлює попередню збережену мережу.',
    storage_error: 'Не вдалося зберегти нову мережу. Попередня мережа залишилася без змін.',
    not_configured: 'Wi-Fi ще не налаштовано.',
    invalid_state: 'Дія зараз недоступна у поточному стані пристрою.',
    subsystem_unavailable: 'Wi-Fi тимчасово недоступний. Спробуйте ще раз.',
    operation_timeout: 'Підключення не завершилося вчасно. Спробуйте ще раз.',
    request_failed: 'Не вдалося виконати запит до WattPost.',
    invalid_response: 'WattPost повернув некоректну відповідь.',
  };

  function wifiErrorText(error) {
    const code = error && (error.code || error.message);
    return WIFI_ERROR_TEXT[code] || (code ? `Помилка: ${code}` : WIFI_ERROR_TEXT.request_failed);
  }

  function wifiPhaseText(phase) {
    return {
      scanning: 'Сканування мереж…',
      validating: 'Перевірка мережі…',
      connecting: 'Підключення до мережі…',
      saving: 'Збереження…',
      reconnecting: 'Перепідключення Wi-Fi…',
      resetting: 'Скидання Wi-Fi…',
      none: 'Очікування…',
    }[phase] || 'Виконується…';
  }


  const BMS_ERROR_TEXT = {
    busy: 'BLE зайнятий або WattPost уже підключений до BMS. Сканування активної BMS без відключення наразі недоступне.',
    stale_scan: 'Список BMS застарів. Оновіть його та спробуйте ще раз.',
    candidate_not_found: 'Вибрана BMS більше не доступна. Оновіть список і спробуйте ще раз.',
    bms_connect_failed: 'Не вдалося підключитися до вибраної JK BMS.',
    bms_invalid: 'WattPost підключився, але не отримав дані від цієї JK BMS.',
    storage_error: 'BMS підключена, але WattPost не зміг зберегти вибір.',
    not_configured: 'JK BMS ще не вибрано.',
    device_offline: 'WattPost зараз не в мережі. Зачекайте на підключення ESP і повторіть дію.',
    unsupported_firmware: 'Для підключення JK BMS через Cloud потрібна новіша прошивка WattPost. Оновіть ESP у розділі «Прошивка».',
    operation_reset: 'Інша операція BMS перервала виконання. Повторіть пошук.',
    subsystem_unavailable: 'Підключення до BMS тимчасово недоступне.',
    operation_timeout: 'Підключення до BMS не завершилося вчасно. Спробуйте ще раз.',
    request_failed: 'Не вдалося виконати запит до WattPost.',
    invalid_response: 'WattPost повернув некоректну відповідь.',
  };

  function bmsErrorText(error) {
    const code = error && (error.code || error.message);
    return BMS_ERROR_TEXT[code] || (code ? `Помилка: ${code}` : BMS_ERROR_TEXT.request_failed);
  }

  function bmsPhaseText(phase) {
    return {
      scanning: 'Пошук BMS…',
      connecting: 'Підключення до BMS…',
      validating: 'Перевірка BMS…',
      saving: 'Збереження вибраної BMS…',
      reconnecting: 'Перепідключення до BMS…',
      resetting: 'Видалення вибраної BMS…',
      none: 'Очікування…',
    }[phase] || 'Виконується…';
  }


  const SYSTEM_ERROR_TEXT = {
    busy: 'Інша системна дія вже запланована.',
    storage_error: 'Не вдалося зберегти зміни. Перезавантаження не запущено.',
    invalid_state: 'Повне скидання зараз недоступне через помилку внутрішніх налаштувань.',
    request_failed: 'Не вдалося виконати системну дію.',
    invalid_response: 'WattPost повернув некоректну відповідь.',
  };

  function systemErrorText(error) {
    const code = error && (error.code || error.message);
    return SYSTEM_ERROR_TEXT[code] || (code ? `Помилка: ${code}` : SYSTEM_ERROR_TEXT.request_failed);
  }

  const CLOUD_ERROR_TEXT = {
    busy: 'WattPost уже виконує іншу Cloud-дію.',
    cloud_unavailable: 'Cloud зараз недоступний. Локальна робота WattPost продовжується.',
    already_paired: 'WattPost уже підключений до облікового запису.',
    not_paired: 'WattPost ще не підключений до облікового запису.',
    storage_error: 'Не вдалося зберегти стан відключення Cloud.',
    remote_rejected: 'Cloud відхилив запит. Спробуйте ще раз.',
    invalid_response: 'Cloud повернув некоректну відповідь.',
    operation_timeout: 'Cloud відповідає повільно. Стан оновиться автоматично.',
    request_failed: 'Не вдалося виконати Cloud-запит.',
  };

  function cloudErrorText(error) {
    const code = error && (error.code || error.message);
    return CLOUD_ERROR_TEXT[code] || (code ? `Помилка: ${code}` : CLOUD_ERROR_TEXT.request_failed);
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
      new: 'Щойно встановлена',
      pending_verify: 'Перевіряється',
      valid: 'Працює нормально',
      invalid: 'Помилка',
      aborted: 'Відхилена',
      undefined: 'Невідомо',
    }[state] || (state ? 'Невідомо' : '—');
  }

  function remoteOtaStateText(state) {
    return {
      offered: 'Доступне оновлення',
      available: 'Доступне оновлення',
      downloading: 'Завантаження',
      verifying: 'Перевірка',
      installing: 'Встановлення',
      success: 'Оновлено',
      failed: 'Помилка оновлення',
      rolled_back: 'Відновлено попередню версію',
    }[state] || null;
  }

  function restartReasonText(reason) {
    return {
      power_on: 'Увімкнення живлення',
      manual: 'Перезавантаження',
      bms_timeout: 'Перезапуск для відновлення BMS',
      wifi_timeout: 'Перезапуск для відновлення Wi-Fi',
      panic: 'Помилка системи',
      watchdog: 'Зависання системи',
      brownout: 'Просідання живлення',
      other: 'Інша причина',
    }[reason] || (reason ? 'Інша причина' : '—');
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
            <h1>Налаштування WattPost</h1>
            <p>Wi-Fi, підключення JK BMS, віддалений доступ, прошивка та системні дії.</p>
          </div>
          <div class="device-settings-live-chip" id="device-local-state" data-tone="muted">
            <span class="device-settings-live-dot"></span>
            <span id="device-local-state-text">Очікуємо зв’язок з WattPost</span>
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
                <p>Підключення до домашньої мережі та інтернету.</p>
              </div>
              <span class="device-settings-status" id="device-wifi-state" data-tone="muted">Немає даних</span>
            </div>
            <div class="device-settings-rows">
              <div class="device-settings-row">
                <span>Поточна мережа</span>
                <strong id="device-wifi-ssid">—</strong>
              </div>
              <div class="device-settings-row">
                <span>Сигнал</span>
                <strong id="device-wifi-rssi">—</strong>
              </div>
              <div class="device-settings-row">
                <span>Інтернет</span>
                <strong id="device-wifi-internet">Не перевірено</strong>
              </div>
              <div class="device-settings-row">
                <span>Відновлення Wi-Fi</span>
                <strong>BOOT: 5–10 с, відпустіть</strong>
              </div>
            </div>
            <p class="device-system-message" data-tone="muted">Для відновлення Wi-Fi утримуйте BOOT 5–10 секунд і відпустіть. Утримання 15 секунд або довше з наступним відпусканням виконає повне скидання.</p>
            <div class="device-settings-actions device-settings-actions-split">
              <button class="device-settings-action device-settings-action-secondary" id="device-wifi-reconnect" data-capability="wifiManage" type="button">Перепідключити</button>
              <button class="device-settings-action" id="device-wifi-manage" data-capability="wifiManage" type="button">Керувати Wi-Fi</button>
            </div>
            <div class="device-wifi-panel" id="device-wifi-panel" data-capability="wifiManage" hidden>
              <div class="device-wifi-panel-head">
                <div>
                  <strong>Зміна мережі</strong>
                  <p>WattPost збереже нову мережу лише після успішного підключення. Якщо не вийде, попередня мережа залишиться без змін.</p>
                </div>
                <button class="device-settings-action device-settings-action-secondary" id="device-wifi-scan" type="button">Сканувати</button>
              </div>
              <div class="device-wifi-message" id="device-wifi-message" data-tone="muted">Оберіть мережу або введіть назву прихованої мережі.</div>
              <div class="device-wifi-candidates" id="device-wifi-candidates"></div>
              <label class="device-wifi-check">
                <input id="device-wifi-hidden-toggle" type="checkbox">
                <span>Прихована мережа</span>
              </label>
              <label class="device-wifi-field" id="device-wifi-hidden-field" hidden>
                <span>Назва мережі</span>
                <input id="device-wifi-hidden-ssid" type="text" maxlength="32" autocomplete="off" spellcheck="false">
              </label>
              <label class="device-wifi-field">
                <span>Новий пароль Wi-Fi</span>
                <input id="device-wifi-password" type="password" maxlength="64" autocomplete="new-password" autocapitalize="none" spellcheck="false">
                <small>Збережений пароль ніколи не відображається. Для відкритої мережі залиште поле порожнім.</small>
              </label>
              <div class="device-wifi-panel-actions">
                <button class="device-settings-action" id="device-wifi-apply" type="button">Перевірити й зберегти</button>
                <button class="device-settings-action device-settings-action-danger" id="device-wifi-reset" type="button">Скинути Wi-Fi</button>
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
                <p>Вибір JK BMS та стан підключення.</p>
              </div>
              <span class="device-settings-status" id="device-bms-state" data-tone="muted">Немає даних</span>
            </div>
            <div class="device-settings-rows">
              <div class="device-settings-row">
                <span>Вибрана BMS</span>
                <strong id="device-bms-address">—</strong>
              </div>
              <div class="device-settings-row">
                <span>Модель</span>
                <strong id="device-bms-model">—</strong>
              </div>
              <div class="device-settings-row">
                <span>Підключення</span>
                <strong id="device-bms-ble">—</strong>
              </div>
              <div class="device-settings-row">
                <span>Комірки</span>
                <strong id="device-bms-cells">—</strong>
              </div>
            </div>
            <div class="device-settings-actions device-settings-actions-split">
              <button class="device-settings-action device-settings-action-secondary" id="device-bms-reconnect" data-capability="bmsManage" type="button">Перепідключити</button>
              <button class="device-settings-action" id="device-bms-manage" data-capability="bmsManage" type="button">Підключення BMS</button>
              <button class="device-settings-action device-settings-action-secondary" type="button" data-capability="bmsSettingsRead" data-open-bms-settings>Параметри BMS</button>
            </div>
            <div class="device-bms-panel" id="device-bms-panel" data-capability="bmsManage" hidden>
              <div class="device-bms-panel-head">
                <div>
                  <strong>Підключення JK BMS</strong>
                  <p>Пошук нічого не змінює автоматично. Нова BMS буде збережена лише після успішного підключення та отримання даних.</p>
                </div>
                <button class="device-settings-action device-settings-action-secondary" id="device-bms-scan" type="button">Знайти BMS</button>
              </div>
              <div class="device-bms-message" id="device-bms-message" data-tone="muted">Запустіть пошук і виберіть JK BMS.</div>
              <div class="device-bms-candidates" id="device-bms-candidates"></div>
              <div class="device-bms-panel-actions">
                <button class="device-settings-action" id="device-bms-apply" type="button">Перевірити й вибрати</button>
                <button class="device-settings-action device-settings-action-danger" id="device-bms-forget" data-capability="bmsForget" type="button">Забути BMS</button>
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
                <h2>Віддалений доступ</h2>
                <p>Підключіть WattPost до свого облікового запису для доступу через wattpost.pp.ua. Локальна робота від Cloud не залежить.</p>
              </div>
              <span class="device-settings-status" id="device-remote-state" data-tone="muted">Перевіряємо</span>
            </div>
            <div class="device-settings-rows">
              <div class="device-settings-row">
                <span>Cloud</span>
                <strong id="device-cloud-transport">—</strong>
              </div>
              <div class="device-settings-row">
                <span>Обліковий запис</span>
                <strong id="device-cloud-account">—</strong>
              </div>
            </div>
            <div class="device-settings-actions device-settings-actions-split">
              <button class="device-settings-action" id="device-cloud-connect" data-capability="cloudManage" type="button">Підключити до акаунта</button>
              <button class="device-settings-action device-settings-action-danger" id="device-cloud-disconnect" data-capability="cloudManage" type="button" hidden>Відключити Cloud</button>
            </div>
            <div class="device-system-message" id="device-cloud-message" data-tone="muted">Cloud не впливає на локальний Dashboard, History або BMS.</div>
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
                <h2>Прошивка</h2>
                <p>Версія прошивки та стан оновлення.</p>
              </div>
              <span class="device-settings-status" id="device-firmware-state" data-tone="muted">Немає даних</span>
            </div>
            <div class="device-settings-rows">
              <div class="device-settings-row">
                <span>Версія</span>
                <strong id="device-firmware-version">—</strong>
              </div>
              <div class="device-settings-row">
                <span>Збірка</span>
                <strong class="device-settings-mono" id="device-build-id">—</strong>
              </div>
              <div class="device-settings-row">
                <span>Стан прошивки</span>
                <strong id="device-ota-state">—</strong>
              </div>
              <div class="device-settings-row">
                <span>Автоматичні оновлення</span>
                <div class="device-ota-preference">
                  <strong id="device-ota-automatic">—</strong>
                  <label class="device-toggle" data-capability="firmwareOtaPreference">
                    <input id="device-ota-automatic-toggle" type="checkbox" role="switch" aria-label="Автоматичні оновлення" disabled>
                    <span class="device-toggle-track" aria-hidden="true"><span class="device-toggle-thumb"></span></span>
                  </label>
                </div>
              </div>
              <div class="device-settings-row" id="device-ota-release-row" hidden>
                <span>Доступна версія</span>
                <strong id="device-ota-release">—</strong>
              </div>
            </div>
            <div class="device-settings-actions">
              <button class="device-settings-action" id="device-ota-install" data-capability="firmwareOta" type="button" disabled>Оновити зараз</button>
              <button class="device-settings-action device-settings-action-secondary" id="device-ota-disable-automatic" data-capability="firmwareOtaPreference" type="button" hidden>Вимкнути автооновлення</button>
            </div>
            <div class="device-ota-progress" id="device-ota-progress" role="status" aria-label="Перебіг оновлення" hidden>
              <div class="device-ota-progress-heading">
                <strong id="device-ota-progress-stage">Очікуємо пристрій…</strong>
                <div class="device-ota-progress-controls">
                  <span id="device-ota-progress-percent"></span>
                  <button type="button" class="device-ota-progress-dismiss" id="device-ota-progress-dismiss" aria-label="Закрити результат оновлення" hidden>Закрити</button>
                </div>
              </div>
              <div class="device-ota-progress-track" id="device-ota-progress-track">
                <div class="device-ota-progress-fill" id="device-ota-progress-fill"></div>
              </div>
              <p id="device-ota-progress-detail"></p>
            </div>
            <div class="device-system-message" id="device-ota-message" data-tone="muted">Перевіряємо прошивку та налаштування автооновлень.</div>
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
                <h2>Система</h2>
                <p>Локальна адреса, час роботи та системні дії.</p>
              </div>
            </div>
            <div class="device-settings-rows device-settings-rows-wide">
              <div class="device-settings-row">
                <span>Локальна адреса</span>
                <strong>bms.local</strong>
              </div>
              <div class="device-settings-row">
                <span>Час роботи</span>
                <strong id="device-uptime">—</strong>
              </div>
              <div class="device-settings-row">
                <span>Останній запуск</span>
                <strong id="device-restart-reason">—</strong>
              </div>
            </div>
            <div class="device-settings-actions device-settings-actions-system">
              <button class="device-settings-action device-settings-action-secondary" id="device-system-reboot" data-capability="systemReboot" type="button">Перезавантажити</button>
              <button class="device-settings-action device-settings-action-danger" id="device-system-factory-toggle" data-capability="systemFactoryReset" type="button">Повне скидання…</button>
            </div>
            <div class="device-system-message" id="device-system-message" data-tone="muted">Системні дії виконуються тільки локально.</div>
            <div class="device-system-reset-panel" id="device-system-reset-panel" data-capability="systemFactoryReset" hidden>
              <div class="device-system-reset-head">
                <strong>Повне скидання WattPost</strong>
                <p>WattPost видалить локальні налаштування та історію й повернеться до початкового налаштування.</p>
              </div>
              <div class="device-system-reset-scope">
                <div>
                  <strong>Буде видалено</strong>
                  <ul>
                    <li>збережена Wi-Fi мережа та пароль;</li>
                    <li>вибрана JK BMS;</li>
                    <li>локальні налаштування температурних датчиків;</li>
                    <li>історія вимірювань.</li>
                    <li>прив’язка до поточного акаунта WattPost Cloud.</li>
                  </ul>
                </div>
                <div>
                  <strong>Після скидання</strong>
                  <ul>
                    <li>WattPost перезапуститься. Підключіться до його мережі WattPost-XXXX та відкрийте 192.168.4.1.</li>
                    <li>Налаштуйте Wi-Fi і BMS, потім повторно підключіть пристрій до потрібного акаунта Cloud.</li>
                    <li>Cloud дізнається про скидання після повернення пристрою в інтернет; старий доступ може зникнути не одразу.</li>
                  </ul>
                </div>
              </div>
              <label class="device-system-reset-confirm">
                <input id="device-system-factory-confirm" type="checkbox">
                <span>Я розумію, що налаштування, історія та прив’язка до акаунта Cloud будуть скинуті.</span>
              </label>
              <div class="device-system-reset-actions">
                <button class="device-settings-action device-settings-action-secondary" id="device-system-factory-cancel" type="button">Скасувати</button>
                <button class="device-settings-action device-settings-action-danger" id="device-system-factory-run" type="button" disabled>Повністю скинути WattPost</button>
              </div>
            </div>
          </section>
        </div>
      `;
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
          reachable: 'Доступний',
          unreachable: 'Недоступний',
          unknown: 'Не перевірено',
        };
        setText(
          this.container,
          'device-wifi-internet',
          internetLabels[status?.wifi?.internet_state] || 'Не перевірено'
        );

        const bms = status?.bms;
        if (bms) {
          this.bmsConfigured = bms.configured === null || bms.configured === undefined
            ? null
            : Boolean(bms.configured);
          this._setBmsBusy(this.bmsBusy);
          const bmsLabels = {
            connected: ['Підключено', 'success'],
            connecting: ['Підключення', 'info'],
            disconnected: [
              this.bmsConfigured === false ? 'Не вибрано' : this.bmsConfigured === null ? 'Немає даних' : 'Немає зв’язку',
              'muted',
            ],
            error: ['Помилка налаштувань', 'warning'],
          };
          const bmsStatus =
            bmsLabels[bms.state] || ['Немає даних', 'muted'];
          this._setStatus('device-bms-state', bmsStatus[0], bmsStatus[1]);

          const selectedLabel = this.bmsConfigured
            ? [bms.name, bms.address_hint].filter(Boolean).join(' · ')
            : null;
          setText(
            this.container,
            'device-bms-address',
            selectedLabel,
            this.bmsConfigured === true ? 'Вибрано' : this.bmsConfigured === false ? 'Не вибрано' : '—'
          );
          setText(this.container, 'device-bms-model', bms.model);
          setText(this.container, 'device-bms-ble', bmsStatus[0]);
          // /api/device/status has no cell_count. The live telemetry handler
          // owns this field, so a status poll must not erase its value.
        }

        this._renderCloudStatus(status?.cloud || null);
        await this._refreshOtaStatus();
        return status;
      } catch (_error) {
        setText(this.container, 'device-wifi-internet', 'Не перевірено');
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
      this._setWifiMessage('Сканування мереж…', 'info');
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
          count ? `Знайдено мереж: ${count}` : 'Мереж не знайдено. Можна ввести назву прихованої мережі.',
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
        title.textContent = candidate.ssid || 'Без назви';
        const meta = document.createElement('small');
        meta.textContent = candidate.auth === 'open'
          ? `Відкрита · канал ${candidate.channel || '—'}`
          : `${candidate.auth || 'захищена'} · канал ${candidate.channel || '—'}`;
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
          this._setWifiMessage(`Вибрано: ${candidate.ssid || 'мережа'}`, 'info');
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
          this._setWifiMessage('Вкажіть назву прихованої мережі.', 'error');
          return;
        }
        request = { hidden_ssid: hiddenSsid, password };
      } else {
        if (!this.wifiScan || !this.selectedWifi) {
          this._setWifiMessage('Оберіть мережу після сканування.', 'error');
          return;
        }
        if (this.selectedWifi.auth !== 'open' && !password) {
          this._setWifiMessage('Введіть пароль вибраної мережі.', 'error');
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
        'Перевіряємо нову мережу. Зв’язок з цією сторінкою може тимчасово перерватися.',
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
        this._setWifiMessage('Нова Wi-Fi мережа перевірена та збережена.', 'success');
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
      this._setWifiMessage('Перепідключення до збереженої мережі…', 'info');
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
        this._setWifiMessage('Wi-Fi перепідключено.', 'success');
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
          'Скинути налаштування Wi-Fi? WattPost забуде збережену мережу та перезапуститься для нового налаштування. Вибір BMS і історія залишаться.'
        )
        : false;
      if (!confirmed) return;

      this._setWifiBusy(true);
      try {
        await global.ApiClient.resetWifi();
        const passwordInput = this.container.querySelector('#device-wifi-password');
        if (passwordInput) passwordInput.value = '';
        this._setWifiMessage(
          'Налаштування Wi-Fi видалено. WattPost перезапуститься та відкриє початкове налаштування.',
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
      this._setBmsMessage('Пошук JK BMS…', 'info');
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
            ? `Знайдено JK BMS: ${count}`
            : 'JK BMS не знайдено. Перевірте живлення та відстань і повторіть сканування.',
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
        title.textContent = candidate.name || 'JK BMS';
        const meta = document.createElement('small');
        meta.textContent = candidate.address_hint || 'Адреса прихована';
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
            `Вибрано: ${candidate.name || 'JK BMS'} ${candidate.address_hint || ''}`.trim(),
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
        this._setBmsMessage('Спочатку знайдіть і виберіть BMS.', 'error');
        return;
      }

      if (this.bmsConfigured) {
        const confirmed = typeof global.confirm === 'function'
          ? global.confirm(
            'Змінити JK BMS? Поточний вибір буде замінено тільки після успішної перевірки нової BMS. Історія залишиться без змін і може містити записи попереднього акумулятора.'
          )
          : false;
        if (!confirmed) return;
      }

      this._setBmsBusy(true);
      this._setBmsMessage(
        'Підключаємось до JK BMS і перевіряємо, що вона передає дані.',
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
        this._setBmsMessage('JK BMS перевірена та збережена.', 'success');
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
      this._setBmsMessage('Перепідключення до збереженої JK BMS…', 'info');
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
        this._setBmsMessage('JK BMS перепідключено.', 'success');
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
          'Забути вибрану JK BMS? Wi-Fi та історія залишаться без змін.'
        )
        : false;
      if (!confirmed) return;

      this._setBmsBusy(true);
      this._setBmsMessage('Видалення вибраної BMS…', 'warning');
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
          'Вибір BMS видалено. Wi-Fi та історія збережені.',
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
        this._setStatus('device-remote-state', 'Немає даних', 'muted');
        setText(this.container, 'device-cloud-transport', '—');
        setText(this.container, 'device-cloud-account', '—');
        this._setCloudMessage(
          'Не вдалося перевірити підключення Cloud. Переконайтеся, що WattPost має інтернет, і спробуйте ще раз.',
          'warning'
        );
        if (connect) {
          connect.hidden = false;
          connect.disabled = this.capabilities.cloudManage === false || this.cloudBusy;
          connect.textContent = this.cloudBusy ? 'Підключення…' : 'Спробувати ще раз';
        }
        if (disconnect) disconnect.hidden = true;
        return;
      }

      const transportLabels = {
        online: 'Доступний',
        connecting: 'Підключення',
        backoff: 'Тимчасово недоступний',
        waiting_network: 'Очікує інтернет',
        disabled: 'Недоступний',
      };
      setText(
        this.container,
        'device-cloud-transport',
        transportLabels[cloud.transport_state] || 'Невідомо'
      );

      const actionRunning = cloud?.operation?.state === 'running';
      const pairingState = cloud?.pairing?.state || 'none';
      const pairedKnown = cloud.paired_known === true;
      const paired = pairedKnown && cloud.paired === true;
      const disconnectPending = cloud.disconnect_pending === true;

      if (disconnectPending) {
        this._setStatus('device-remote-state', 'Відключення', 'warning');
        setText(this.container, 'device-cloud-account', 'Очікує синхронізацію');
        this._setCloudMessage(
          cloud.network_available
            ? 'WattPost відключає попередній обліковий запис у Cloud…'
            : 'Відключення збережено. Воно завершиться автоматично після появи інтернету.',
          'warning'
        );
      } else if (paired) {
        this._setStatus('device-remote-state', 'Підключено', 'success');
        setText(this.container, 'device-cloud-account', 'Підключено');
        this._setCloudMessage(
          'Віддалений доступ підключено. Локальна робота WattPost залишається автономною.',
          'success'
        );
      } else if (pairingState === 'requesting') {
        this._setStatus('device-remote-state', 'Підключення', 'info');
        setText(this.container, 'device-cloud-account', 'Створюємо посилання');
        this._setCloudMessage(
          cloud.network_available
            ? 'Створюємо одноразове посилання для wattpost.pp.ua…'
            : 'Для створення посилання потрібен інтернет.',
          cloud.network_available ? 'info' : 'warning'
        );
      } else if (pairingState === 'pending') {
        this._setStatus('device-remote-state', 'Очікує входу', 'info');
        setText(this.container, 'device-cloud-account', 'Очікує підтвердження');
        this._setCloudMessage(
          'Одноразове посилання готове. Завершіть вхід або реєстрацію на wattpost.pp.ua.',
          'info'
        );
      } else if (!pairedKnown) {
        this._setStatus(
          'device-remote-state',
          cloud.network_available ? 'Перевіряємо' : 'Cloud недоступний',
          cloud.network_available ? 'info' : 'warning'
        );
        setText(this.container, 'device-cloud-account', 'Стан невідомий');
        this._setCloudMessage(
          cloud.network_available
            ? 'WattPost перевіряє стан віддаленого доступу.'
            : 'Немає інтернету. Локальний Dashboard, History і BMS продовжують працювати.',
          cloud.network_available ? 'info' : 'warning'
        );
      } else {
        this._setStatus(
          'device-remote-state',
          cloud.network_available ? 'Не підключено' : 'Cloud недоступний',
          cloud.network_available ? 'muted' : 'warning'
        );
        setText(this.container, 'device-cloud-account', 'Не підключено');
        if (pairingState === 'expired') {
          this._setCloudMessage(
            'Попереднє посилання завершилося. Створіть нове підключення.',
            'warning'
          );
        } else if (pairingState === 'cancelled') {
          this._setCloudMessage(
            'Попереднє підключення скасовано. Можна створити нове.',
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
              ? 'Підключіть WattPost до свого акаунта на wattpost.pp.ua.'
              : 'Для підключення Cloud потрібен інтернет. Локальна робота не залежить від нього.',
            cloud.network_available ? 'muted' : 'warning'
          );
        }
      }

      if (connect) {
        connect.hidden = paired || disconnectPending;
        connect.textContent = this.cloudBusy
          ? 'Підключення…'
          : (pairingState === 'pending'
          ? 'Продовжити'
          : (pairingState === 'requesting'
            ? 'Підключення…'
            : (pairingState === 'error' || cloud?.operation?.state === 'error'
              ? 'Спробувати ще раз'
              : 'Підключити до акаунта')));
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
          ? 'Відключення…'
          : 'Відключити Cloud';
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
          this._setCloudMessage('Відкриваємо WattPost Cloud…', 'info');
          if (global.location && typeof global.location.assign === 'function') {
            global.location.assign(existingPairUrl);
            return;
          }
          throw { code: 'invalid_response' };
        }

        this._setCloudMessage('Підключаємо WattPost до Cloud…', 'info');
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

        this._setCloudMessage('Відкриваємо WattPost Cloud…', 'info');
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
          'Відключити WattPost від поточного Cloud-акаунта? Wi-Fi, BMS та локальна історія залишаться без змін.'
        )
        : false;
      if (!confirmed) return;

      this._setCloudBusy(true);
      this._setCloudMessage('Зберігаємо відключення Cloud…', 'warning');
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
            'Cloud-акаунт відключено. Wi-Fi, BMS та локальна історія збережені.',
            'success'
          );
        } catch (error) {
          await this._refreshDeviceStatus();
          if (
            error?.code === 'operation_timeout' &&
            this.deviceStatus?.cloud?.disconnect_pending
          ) {
            this._setCloudMessage(
              'Відключення збережено. Воно завершиться автоматично після появи інтернету.',
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
          'Перезавантажити WattPost? Налаштування та історія збережуться.'
        )
        : false;
      if (!confirmed) return;

      this._setSystemBusy(true);
      this._setSystemMessage('WattPost перезавантажується…', 'warning');
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
        this._setSystemMessage('Підтвердьте повне скидання WattPost.', 'error');
        return;
      }

      this._setSystemBusy(true);
      this._setSystemMessage(
        'Повне скидання запущено. WattPost видалить локальні налаштування та історію й відкриє початкове налаштування…',
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
          ? (automaticEnabled ? 'Увімкнено' : 'Вимкнено')
          : '—';
        if (pendingDesired !== null) automatic.textContent += pendingDesired
          ? ' · запит на увімкнення' : ' · запит на вимкнення';
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
            ? 'Очікуємо пристрій…'
            : 'Надсилаємо…';
        } else if (stateName === 'downloading') {
          button.textContent = 'Завантаження…';
        } else if (stateName === 'verifying') {
          button.textContent = 'Перевірка…';
        } else if (stateName === 'installing') {
          button.textContent = 'Встановлення…';
        } else {
          button.textContent = stateName === 'failed' || stateName === 'rolled_back'
            ? 'Спробувати ще раз'
            : 'Оновити зараз';
        }
        button.disabled = !this._canInstallOta(status);
      }

      let badgeLabel = null;
      let badgeTone = 'info';
      if (this.otaCheckFailed || (this.otaCheckConfirmed && !this._otaCheckIsCurrent())) {
        badgeLabel = 'Не вдалося перевірити';
        badgeTone = 'warning';
      } else if (this.otaBusy) {
        badgeLabel = this.otaRequestAccepted ? 'Очікуємо пристрій' : 'Запуск оновлення';
      } else if (active || stateName === 'offered' || stateName === 'available' ||
          stateName === 'success' || stateName === 'failed' || stateName === 'rolled_back') {
        badgeLabel = remoteOtaStateText(stateName);
        badgeTone = stateName === 'success' ? 'success'
          : stateName === 'failed' ? 'error'
            : stateName === 'rolled_back' ? 'warning'
              : active ? 'warning' : 'info';
      } else if (available) {
        badgeLabel = 'Доступне оновлення';
      } else if (status) {
        badgeLabel = release ? 'Актуальна' : 'Нових оновлень немає';
        badgeTone = release ? 'success' : 'info';
      }
      if (badgeLabel) this._setStatus('device-firmware-state', badgeLabel, badgeTone);

      this._renderOtaProgress(status);
      const message = this.container.querySelector('#device-ota-message');
      if (!message) return;
      let text = this.otaPreferences.confirmed === null
        ? 'Стан автооновлень ще не підтверджено. Їх можна вимкнути окремим запитом.'
        : automaticEnabled
        ? 'WattPost автоматично перевіряє та встановлює опубліковані оновлення.'
        : 'Автоматичні оновлення вимкнено. Нові версії залишаються видимими й встановлюються лише після «Оновити зараз».';
      let tone = 'muted';
      if (this.otaPreferenceBusy) {
        text = 'Передаємо зміну автоматичних оновлень пристрою…';
        tone = 'info';
      } else if (pendingDesired !== null) {
        text = `Зміна на «${pendingDesired ? 'Увімкнено' : 'Вимкнено'}» очікує підтвердження пристроєм.`;
        tone = 'info';
      } else if (status && !automaticSupported &&
                 this.capabilities.firmwareOtaPreference === true) {
        text = 'Очікуємо, поки WattPost підтвердить локальне налаштування автоматичних оновлень.';
        tone = 'muted';
      } else if (this.otaBusy) {
        text = this.otaRequestAccepted
          ? 'Запит на оновлення прийнято. Очікуємо, поки WattPost почне завантаження.'
          : 'Надсилаємо запит на оновлення…';
        tone = 'info';
      } else if (stateName === 'downloading') {
        text = 'WattPost завантажує підписану прошивку. Поточна версія продовжує працювати.';
        tone = 'info';
      } else if (stateName === 'verifying') {
        text = 'Перевіряємо розмір, SHA-256 та цифровий підпис прошивки.';
        tone = 'info';
      } else if (stateName === 'installing') {
        text = 'Оновлення встановлено. WattPost перезапускається та перевіряє нову версію.';
        tone = 'warning';
      } else if (stateName === 'success') {
        text = 'Оновлення успішно встановлено та підтверджено.';
        tone = 'success';
      } else if (stateName === 'rolled_back') {
        text = 'Нова версія не пройшла перевірку. WattPost відновив попередню прошивку.';
        tone = 'warning';
      } else if (stateName === 'failed') {
        text = 'Оновлення не встановлено. Поточна прошивка продовжує працювати.';
        tone = 'error';
      } else if (available && targetVersion) {
        const changelog = typeof release?.changelog === 'string' ? release.changelog.trim() : '';
        text = changelog || (automaticEnabled
          ? `Версія ${targetVersion} доступна. WattPost встановить її автоматично.`
          : `Версія ${targetVersion} доступна. Натисніть «Оновити зараз», щоб встановити її.`);
        tone = 'info';
      }
      if (OTA_TERMINAL_STATES.includes(stateName) && this._isOtaResultDismissed(state)) {
        text = automaticEnabled
          ? 'WattPost автоматично перевіряє та встановлює опубліковані оновлення.'
          : 'Автоматичні оновлення вимкнено. Нові версії встановлюються лише після «Оновити зараз».';
        tone = 'muted';
      }
      if (this.otaCheckFailed) {
        text = 'Не вдалося перевірити нову прошивку. Встановлення недоступне до успішної перевірки. ' +
          (active ? 'Останній відомий стан: ' : '') + text;
        tone = 'warning';
      } else if (this.otaCheckConfirmed && !this._otaCheckIsCurrent()) {
        text = 'Перевірка прошивки застаріла. Очікуємо нової перевірки. ' + text;
        tone = 'warning';
      }
      if (active && !automaticEnabled && this.otaPreferences.confirmed !== null) {
        text += ' Вимкнення автооновлень не зупиняє вже розпочате встановлення.';
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
      let label = 'Очікуємо підтвердження пристрою';
      let description = this.otaBusy && !this.otaRequestAccepted
        ? 'Надсилаємо запит на оновлення…'
        : 'Запит прийнято. WattPost розпочне оновлення самостійно.';
      let value = '';
      let progressWidth = '0%';
      let moving = true;

      if (phase === 'downloading') {
        label = 'Завантаження прошивки';
        description = hasProgress
          ? `${(received / 1000000).toFixed(2)} з ${(total / 1000000).toFixed(2)} МБ отримано`
          : 'Пристрій завантажує прошивку. Чекаємо дані про обсяг.';
        if (hasProgress) {
          value = `${pct}%`;
          progressWidth = `${pct}%`;
          moving = false;
        }
        if (Number.isInteger(attempt) && attempt > 1) {
          description += ` · спроба ${attempt}`;
        }
      } else if (phase === 'verifying') {
        label = 'Перевірка прошивки';
        description = 'Дані отримано. Перевіряємо цілісність прошивки.';
      } else if (phase === 'installing') {
        label = 'Перезапуск та перевірка';
        description = 'Завантаження завершено. Очікуємо запуск нової версії та підтвердження ESP.';
      } else if (phase === 'success') {
        label = '✓ Оновлення завершено';
        description = 'Пристрій підтвердив успішний запуск нової прошивки.';
        progressWidth = '100%';
        moving = false;
      } else if (phase === 'failed' || phase === 'rolled_back') {
        label = phase === 'rolled_back' ? 'Попередню прошивку відновлено' : 'Помилка оновлення';
        description = 'Оновлення не завершено. Поточна прошивка продовжує працювати.';
        moving = false;
      }
      if (this.otaCheckFailed) {
        description += ' Стан не вдалося оновити; показано останнє підтвердження.';
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
            ? 'Пристрій ще не підтвердив підтримку синхронізації цієї настройки.'
            : 'Не вдалося зберегти налаштування автоматичних оновлень.';
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
            ? 'Нова версія зараз недоступна.'
            : code === 'not_paired'
              ? 'Підключіть WattPost до Cloud, щоб отримувати оновлення.'
              : code === 'busy'
                ? 'WattPost уже виконує оновлення.'
                : 'Не вдалося запустити оновлення. Спробуйте ще раз.';
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
        hasLive ? 'WattPost на зв’язку' : 'Очікуємо зв’язок з WattPost'
      );
      if (localChip) localChip.dataset.tone = hasLive ? 'success' : 'muted';

      const wifiState = data && data.wifi_state;
      const wifiConfigured = data && data.remote === true
        ? null
        : Boolean(data && data.wifi_configured);
      this.wifiConfigured = wifiConfigured;
      this._setWifiBusy(this.wifiBusy);
      const wifiLabels = {
        connected: ['Підключено', 'success'],
        connecting: ['Підключення', 'info'],
        disconnected: [wifiConfigured === false ? 'Не налаштовано' : 'Немає зв’язку', 'muted'],
        error: ['Помилка налаштувань', 'warning'],
      };
      const wifiStatus = wifiLabels[wifiState] || ['Немає даних', 'muted'];
      this._setStatus('device-wifi-state', wifiStatus[0], wifiStatus[1]);
      setText(
        this.container,
        'device-wifi-ssid',
        wifiConfigured === true && data && data.wifi_ssid ? data.wifi_ssid : null,
        wifiConfigured === null ? '—' : wifiConfigured ? 'Прихована / без назви' : 'Не налаштовано'
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
          otaValidationPending ? 'Перевіряється після оновлення' : (firmwareVersion ? 'Встановлено' : 'Немає даних'),
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
