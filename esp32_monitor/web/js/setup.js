(function (global) {
  'use strict';

  const api = global.WattPostSetupApi;
  const ApiError = global.WattPostSetupApiError;
  const POLL_MS = 600;

  const ERROR_TEXT = {
    busy: 'Пристрій уже виконує іншу операцію. Спробуйте ще раз.',
    stale_scan: 'Результати сканування застаріли. Запустіть нове сканування.',
    candidate_not_found: 'Вибраний пристрій більше не доступний. Оновіть список і спробуйте ще раз.',
    wifi_auth_failed: 'Не вдалося підключитися до Wi-Fi. Перевірте пароль.',
    wifi_not_found: 'Мережу Wi-Fi не знайдено. Перевірте назву або повторіть сканування.',
    wifi_connect_failed: 'Не вдалося підключитися до Wi-Fi. Виправте дані та спробуйте ще раз.',
    bms_connect_failed: 'Не вдалося підключитися до вибраної JK BMS.',
    bms_invalid: 'WattPost підключився, але не отримав дані від цієї JK BMS.',
    storage_error: 'Не вдалося зберегти налаштування. Попередні налаштування залишилися без змін.',
    subsystem_unavailable: 'Ця функція тимчасово недоступна. Спробуйте ще раз.',
    not_configured: 'Потрібне попереднє налаштування.',
    not_ready: 'Wi-Fi ще не готовий. Перевірте підключення та спробуйте ще раз.',
    forbidden_origin: 'Цю дію можна виконати лише з локальної сторінки WattPost.',
    invalid_request: 'Некоректний запит.',
    invalid_response: 'WattPost повернув некоректну відповідь.',
    operation_timeout: 'Операція не завершилася в очікуваний час. Спробуйте ще раз.',
    operation_reset: 'WattPost перезапустився під час операції. Спробуйте ще раз.',
    request_failed: 'Не вдалося виконати запит до WattPost.',
  };

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function errorText(error) {
    const code = error?.code || error?.message || 'request_failed';
    return ERROR_TEXT[code] || `Помилка: ${code}`;
  }

  function phaseText(phase) {
    return {
      scanning: 'Сканування…',
      connecting: 'Підключення…',
      validating: 'Перевірка даних…',
      saving: 'Збереження…',
      reconnecting: 'Перепідключення…',
      resetting: 'Оновлення стану…',
      none: 'Очікування…',
    }[phase] || 'Виконується…';
  }

  function wifiStateText(state) {
    return {
      connected: 'Підключено',
      connecting: 'Підключення…',
      disconnected: 'Немає з’єднання',
      error: 'Помилка',
    }[state] || 'Невідомо';
  }

  function internetStateText(state) {
    return {
      reachable: 'Доступний',
      unreachable: 'Недоступний',
      unknown: 'Не перевірено',
    }[state] || 'Не перевірено';
  }

  function bmsStateText(state) {
    return {
      connected: 'Підключено',
      connecting: 'Підключення…',
      disconnected: 'Немає з’єднання',
      error: 'Помилка',
    }[state] || 'Невідомо';
  }

  function uptimeText(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value < 60) return `${Math.floor(value)} с`;
    if (value < 3600) return `${Math.floor(value / 60)} хв`;
    if (value < 86400) return `${Math.floor(value / 3600)} год`;
    return `${Math.floor(value / 86400)} дн`;
  }

  class SetupApp {
    constructor() {
      this.status = null;
      this.wifiScan = null;
      this.bmsScan = null;
      this.selectedWifi = null;
      this.busy = false;
      this.recoveryMode = false;
      this.scrollTouchY = new WeakMap();
    }

    $(id) {
      return document.getElementById(id);
    }

    init() {
      this.$('welcome-start').addEventListener('click', () => {
        this.showStep('wifi');
      });
      this.$('wifi-scan').addEventListener('click', () => this.scanWifi());
      this.$('wifi-hidden-toggle').addEventListener('change', () => {
        const hidden = this.$('wifi-hidden-toggle').checked;
        this.$('wifi-hidden-field').classList.toggle('is-hidden', !hidden);
        if (hidden) {
          this.selectedWifi = null;
        }
        this.renderWifiCandidates(this.wifiScan?.candidates || []);
        this.clearError('wifi-form-error');
      });
      this.$('wifi-password-toggle').addEventListener('click', () => {
        const password = this.$('wifi-password');
        this.setPasswordVisible(password.type === 'password');
        password.focus({ preventScroll: true });
      });
      this.$('wifi-connect').addEventListener('click', () => this.configureWifi());
      this.$('wifi-validation-retry').addEventListener('click', () => {
        this.showStep('wifi');
      });
      this.$('bms-scan').addEventListener('click', () => this.scanBms());
      this.$('bms-skip').addEventListener('click', () => this.skipBms('bms-scan-error'));
      this.$('bms-validation-skip').addEventListener('click', () => this.skipBms('bms-validation-error'));
      this.$('bms-change-wifi').addEventListener('click', () => {
        if (!this.busy) this.showStep('wifi');
      });
      this.$('success-change-wifi').addEventListener('click', () => {
        if (!this.busy) this.showStep('wifi');
      });
      this.$('bms-validation-retry').addEventListener('click', () => {
        this.showStep('bms');
      });
      this.$('config-retry').addEventListener('click', () => this.bootstrap());
      this.$('recovery-reconnect').addEventListener('click', () => this.reconnectRecoveryWifi());
      this.$('recovery-change-wifi').addEventListener('click', () => {
        this.showStep('wifi');
      });
      this.$('recovery-reboot').addEventListener('click', () => this.runRecoveryAction('reboot'));
      this.$('recovery-reset-wifi').addEventListener('click', () => this.runRecoveryAction('reset-wifi'));
      this.$('recovery-factory-confirm').addEventListener('change', () => {
        this.$('recovery-factory-reset').disabled =
          !this.$('recovery-factory-confirm').checked || this.busy;
      });
      this.$('recovery-factory-reset').addEventListener('click', () => {
        this.runRecoveryAction('factory-reset');
      });

      this.installScrollBoundaryGuard(this.$('wifi-candidates'));
      this.installScrollBoundaryGuard(this.$('bms-candidates'));

      this.bootstrap();
    }

    async bootstrap() {
      this.showStep('loading');
      try {
        const status = await api.getStatus();
        this.applyStatus(status);
        if (status.mode === 'recovery') {
          this.showRecovery(status);
        } else if (status.setup_state === 'config_error') {
          this.showStep('config-error');
        } else if (status.setup_state === 'configured' ||
                   status.setup_completed_without_bms === true) {
          this.showSuccess(status);
        } else if (status.setup_state === 'bms_required') {
          this.showStep('bms');
        } else {
          this.showStep('welcome');
        }
      } catch (error) {
        this.showStep('config-error');
        this.$('setup-device-state').textContent = errorText(error);
      }
    }

    applyStatus(status) {
      this.status = status || null;
      this.recoveryMode = status?.mode === 'recovery';

      const version = status?.firmware?.version;
      if (version) {
        this.$('setup-version').textContent = version;
      }

      const mode = this.recoveryMode
        ? 'Відновлення Wi-Fi'
        : (status?.mode === 'first_setup' ? 'Перше налаштування' : 'Локальний режим');
      this.$('setup-context').textContent = mode;
      this.$('setup-device-state').textContent = version ? `${mode} · ${version}` : mode;
      this.$('setup-progress').classList.toggle('is-hidden', this.recoveryMode);
      this.$('wifi-step-kicker').textContent = this.recoveryMode ? 'Відновлення Wi-Fi' : 'Етап 2 / 3';
      this.$('wifi-step-title').textContent = this.recoveryMode
        ? 'Оберіть іншу Wi-Fi мережу'
        : 'Підключення до Wi-Fi';

      if (typeof document !== 'undefined') {
        document.title = this.recoveryMode
          ? 'WattPost — Відновлення Wi-Fi'
          : 'WattPost — Перше налаштування';
      }
    }

    showStep(step) {
      document.querySelectorAll('[data-step]').forEach(section => {
        section.classList.toggle('is-active', section.dataset.step === step);
      });

      const progress = {
        welcome: 'welcome',
        wifi: 'wifi',
        'wifi-validating': 'wifi',
        bms: 'bms',
        'bms-validating': 'bms',
        success: 'complete',
      }[step] || null;
      const order = ['welcome', 'wifi', 'bms'];
      const currentIndex = order.indexOf(progress);
      document.querySelectorAll('[data-progress]').forEach(item => {
        const index = order.indexOf(item.dataset.progress);
        item.classList.toggle('is-current', currentIndex >= 0 && index === currentIndex);
        item.classList.toggle(
          'is-complete',
          progress === 'complete' || (currentIndex >= 0 && index < currentIndex),
        );
      });
    }

    installScrollBoundaryGuard(element) {
      if (!element) return;

      element.addEventListener('touchstart', event => {
        const touch = event.touches?.[0];
        if (touch) this.scrollTouchY.set(element, touch.clientY);
      }, { passive: true });

      element.addEventListener('touchmove', event => {
        const touch = event.touches?.[0];
        const previousY = this.scrollTouchY.get(element);
        if (!touch || !Number.isFinite(previousY)) return;

        const deltaY = touch.clientY - previousY;
        this.scrollTouchY.set(element, touch.clientY);
        const scrollable = element.scrollHeight > element.clientHeight + 1;
        const atTop = element.scrollTop <= 0;
        const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
        if (scrollable && ((atTop && deltaY > 0) || (atBottom && deltaY < 0))) {
          event.preventDefault();
        }
      }, { passive: false });

      const clearTouch = () => this.scrollTouchY.delete(element);
      element.addEventListener('touchend', clearTouch, { passive: true });
      element.addEventListener('touchcancel', clearTouch, { passive: true });
    }

    setPasswordVisible(visible) {
      const password = this.$('wifi-password');
      const toggle = this.$('wifi-password-toggle');
      password.type = visible ? 'text' : 'password';
      toggle.textContent = visible ? 'Сховати' : 'Показати';
      toggle.setAttribute('aria-label', visible ? 'Сховати пароль' : 'Показати пароль');
      toggle.setAttribute('aria-pressed', visible ? 'true' : 'false');
    }

    setBusy(value) {
      this.busy = Boolean(value);
      for (const id of [
        'wifi-scan',
        'wifi-connect',
        'bms-scan',
        'bms-skip',
        'bms-validation-skip',
        'bms-change-wifi',
        'success-change-wifi',
        'recovery-reconnect',
        'recovery-change-wifi',
        'recovery-reboot',
        'recovery-reset-wifi',
      ]) {
        const element = this.$(id);
        if (element) element.disabled = this.busy;
      }
      const factory = this.$('recovery-factory-reset');
      if (factory) {
        factory.disabled =
          this.busy || !this.$('recovery-factory-confirm').checked;
      }
    }

    showError(id, message) {
      const element = this.$(id);
      element.textContent = message;
      element.classList.remove('is-hidden');
    }

    clearError(id) {
      const element = this.$(id);
      element.textContent = '';
      element.classList.add('is-hidden');
    }

    showRecovery(status, message = '') {
      this.applyStatus(status);
      this.showStep('recovery');
      this.clearError('recovery-error');

      const wifi = status?.wifi || {};
      const bms = status?.bms || {};
      this.$('recovery-wifi').textContent = wifi.ssid || 'Не збережено';
      this.$('recovery-wifi-state').textContent = wifiStateText(wifi.state);
      this.$('recovery-internet-state').textContent =
        internetStateText(wifi.internet_state);

      const bmsLabel = [
        bmsStateText(bms.state),
        bms.name,
        bms.model,
        bms.address_hint,
      ].filter(Boolean).join(' · ');
      this.$('recovery-bms-state').textContent = bmsLabel || 'Немає даних';

      const firmware = status?.firmware || {};
      this.$('recovery-firmware').textContent = firmware.version || '—';
      this.$('recovery-uptime').textContent = uptimeText(status?.system?.uptime_s);

      this.$('recovery-note').textContent = message || (
        wifi.state === 'connected'
          ? 'WattPost зараз підключений до Wi-Fi. Можна повторити підключення або вибрати іншу мережу.'
          : 'Можна повторити підключення до збереженої мережі або вибрати іншу.'
      );
    }

    async reconnectRecoveryWifi() {
      if (this.busy) return;
      this.clearError('recovery-error');
      this.setBusy(true);
      this.$('recovery-note').textContent = 'Повторне підключення до збереженої Wi-Fi мережі…';

      try {
        const started = await api.reconnectWifi();
        await this.waitForOperation(
          () => api.getWifiScan(),
          started.operation.generation,
          phase => {
            this.$('recovery-note').textContent = phaseText(phase);
          },
          36000,
        );

        const status = await api.getStatus();
        this.showRecovery(
          status,
          'Wi-Fi відновлено. За кілька секунд WattPost закриє мережу налаштування. Підключіться до домашнього Wi-Fi та відкрийте bms.local.',
        );
      } catch (error) {
        this.showError('recovery-error', errorText(error));
        this.$('recovery-note').textContent =
          'Збережена мережа поки недоступна. Можна повторити спробу або вибрати іншу.';
      } finally {
        this.setBusy(false);
      }
    }

    async runRecoveryAction(action) {
      if (this.busy) return;

      if (
        action === 'reset-wifi' &&
        typeof global.confirm === 'function' &&
        !global.confirm('Скинути тільки збережений Wi-Fi? JK BMS і History залишаться без змін.')
      ) {
        return;
      }

      if (
        action === 'factory-reset' &&
        !this.$('recovery-factory-confirm').checked
      ) {
        return;
      }

      const actions = {
        reboot: {
          run: () => api.reboot(),
          message: 'Перезавантаження прийнято. З’єднання тимчасово зникне.',
        },
        'reset-wifi': {
          run: () => api.resetWifi(),
          message: 'Налаштування Wi-Fi видалено. WattPost перезапуститься та відкриє початкове налаштування.',
        },
        'factory-reset': {
          run: () => api.factoryReset(),
          message: 'Повне скидання запущено. WattPost перезапуститься та відкриє початкове налаштування.',
        },
      };
      const selected = actions[action];
      if (!selected) return;

      this.clearError('recovery-error');
      this.setBusy(true);
      try {
        await selected.run();
        this.$('recovery-note').textContent = selected.message;
      } catch (error) {
        this.showError('recovery-error', errorText(error));
        this.setBusy(false);
      }
    }

    async waitForOperation(fetchSnapshot, generation, onPhase, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await fetchSnapshot();
        const operation = snapshot?.operation || {};
        if (Number(operation.generation) === Number(generation)) {
          if (onPhase) onPhase(operation.phase || 'none');
          if (operation.state === 'success') return snapshot;
          if (operation.state === 'error') {
            throw new ApiError(operation.error_code || 'request_failed', 0, snapshot);
          }
        } else if (Number(operation.generation) > Number(generation)) {
          throw new ApiError('busy', 409, snapshot);
        } else if (Number(operation.generation) < Number(generation)) {
          throw new ApiError('operation_reset', 0, snapshot);
        }
        await sleep(POLL_MS);
      }
      throw new ApiError('operation_timeout', 0, null);
    }

    async scanWifi() {
      if (this.busy) return;
      this.clearError('wifi-form-error');
      this.$('wifi-scan').textContent = 'Сканування…';
      this.$('wifi-scan').classList.add('is-loading');
      this.$('wifi-scan').setAttribute('aria-busy', 'true');
      this.$('wifi-scan-status').textContent = 'Шукаємо доступні мережі…';
      this.setBusy(true);
      try {
        const started = await api.startWifiScan();
        const generation = started.operation.generation;
        const snapshot = await this.waitForOperation(
          () => api.getWifiScan(),
          generation,
          phase => {
            this.$('wifi-scan-status').textContent = phaseText(phase);
          },
          15000,
        );
        this.wifiScan = snapshot;
        this.selectedWifi = null;
        this.$('wifi-password').value = '';
        this.setPasswordVisible(false);
        this.renderWifiCandidates(snapshot.candidates || []);
        this.$('wifi-scan-status').textContent = snapshot.candidates?.length
          ? `Знайдено: ${snapshot.candidates.length}`
          : 'Мереж не знайдено';
      } catch (error) {
        this.$('wifi-scan-status').textContent = '';
        this.showError('wifi-form-error', errorText(error));
      } finally {
        this.$('wifi-scan').textContent = 'Оновити список мереж';
        this.$('wifi-scan').classList.remove('is-loading');
        this.$('wifi-scan').removeAttribute('aria-busy');
        this.setBusy(false);
      }
    }

    renderWifiCandidates(candidates) {
      const root = this.$('wifi-candidates');
      const credentials = this.$('wifi-credentials-panel');
      credentials.remove();
      root.replaceChildren();
      if (!Array.isArray(candidates) || !candidates.length) {
        const empty = document.createElement('div');
        empty.className = 'setup-note';
        empty.textContent = 'Мереж не знайдено. Повторіть пошук або введіть назву прихованої мережі.';
        root.appendChild(empty);
        this.placeWifiCredentials(credentials);
        return;
      }

      for (const candidate of candidates) {
        const card = document.createElement('div');
        card.className = 'setup-candidate-card';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'setup-candidate';
        button.setAttribute('role', 'radio');
        const selected = this.selectedWifi?.candidate_id === candidate.candidate_id;
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-checked', selected ? 'true' : 'false');

        const info = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'setup-candidate-title';
        title.textContent = candidate.ssid || 'Без назви';
        const meta = document.createElement('div');
        meta.className = 'setup-candidate-meta';
        meta.textContent = candidate.auth === 'open'
          ? `Відкрита мережа · канал ${candidate.channel}`
          : `${candidate.auth || 'захищена'} · канал ${candidate.channel}`;
        info.append(title, meta);

        const signal = document.createElement('div');
        signal.className = 'setup-candidate-signal';
        signal.textContent = Number.isFinite(candidate.rssi_dbm)
          ? `${candidate.rssi_dbm} dBm`
          : '—';

        button.append(info, signal);
        button.addEventListener('click', () => {
          this.selectedWifi = candidate;
          this.$('wifi-hidden-toggle').checked = false;
          this.$('wifi-hidden-field').classList.add('is-hidden');
          this.clearError('wifi-form-error');
          this.renderWifiCandidates(candidates);
          // The credentials and action are outside the scrollable AP list.
          // Reveal the complete form in the page viewport after selection.
          requestAnimationFrame(() => {
            if (this.$('wifi-credentials-panel').classList.contains('is-hidden')) return;
            if (!this.$('wifi-credentials-panel').closest('.setup-card.is-active')) return;
            this.$('wifi-credentials-panel').scrollIntoView({ block: 'end', behavior: 'auto' });
          });
        });
        card.appendChild(button);
        if (selected && !this.$('wifi-hidden-toggle').checked) {
          card.classList.add('is-expanded');
        }
        root.appendChild(card);
      }
      this.placeWifiCredentials(credentials);
    }

    placeWifiCredentials(credentials) {
      const hidden = this.$('wifi-hidden-toggle').checked;
      const passwordField = credentials.querySelector('#wifi-password-field');
      const selectedNetwork = credentials.querySelector('#wifi-selected-network');
      if (hidden) {
        this.$('wifi-hidden-credentials-slot').appendChild(credentials);
        selectedNetwork.textContent = 'Прихована Wi-Fi мережа';
        passwordField.classList.remove('is-hidden');
        credentials.classList.remove('is-hidden');
        return;
      }

      // Only the network choices scroll independently. Never put the password
      // field or the submit action inside that bounded scrolling area.
      this.$('wifi-credentials-home').appendChild(credentials);
      if (this.selectedWifi) {
        selectedNetwork.textContent = this.selectedWifi.ssid || 'Без назви';
        passwordField.classList.toggle('is-hidden', this.selectedWifi.auth === 'open');
        credentials.classList.remove('is-hidden');
      } else {
        credentials.classList.add('is-hidden');
      }
    }

    async configureWifi() {
      if (this.busy) return;
      this.clearError('wifi-form-error');

      const hidden = this.$('wifi-hidden-toggle').checked;
      const passwordInput = this.$('wifi-password');
      const password = passwordInput.value;
      let request;

      if (hidden) {
        const hiddenSsid = this.$('wifi-hidden-ssid').value.trim();
        if (!hiddenSsid) {
          this.showError('wifi-form-error', 'Вкажіть назву прихованої мережі.');
          return;
        }
        request = { hidden_ssid: hiddenSsid, password };
      } else {
        if (!this.wifiScan || !this.selectedWifi) {
          this.showError('wifi-form-error', 'Оберіть мережу зі списку.');
          return;
        }
        if (this.selectedWifi.auth !== 'open' && !password) {
          this.showError('wifi-form-error', 'Введіть пароль вибраної мережі.');
          return;
        }
        request = {
          scan_generation: this.wifiScan.scan_generation,
          candidate_id: this.selectedWifi.candidate_id,
          password,
        };
      }

      this.setBusy(true);
      try {
        const started = await api.configureWifi(request);
        request.password = '';
        passwordInput.value = '';
        this.setPasswordVisible(false);
        this.showStep('wifi-validating');
        this.clearError('wifi-validation-error');
        this.$('wifi-validation-retry').classList.add('is-hidden');

        await this.waitForOperation(
          () => api.getWifiScan(),
          started.operation.generation,
          phase => {
            this.$('wifi-validation-status').textContent = phaseText(phase);
          },
          36000,
        );

        const status = await api.getStatus();
        const recoveryFlow = this.recoveryMode || status?.mode === 'recovery';
        this.applyStatus(status);
        if (recoveryFlow) {
          this.showRecovery(
            status,
            'Нову Wi-Fi мережу збережено. За кілька секунд WattPost закриє мережу налаштування. Підключіться до домашнього Wi-Fi та відкрийте bms.local. Якщо BMS ще не вибрано, завершіть її налаштування там.',
          );
        } else if (status.setup_state === 'bms_required') {
          this.showStep('bms');
        } else if (status.setup_state === 'configured' ||
                   status.setup_completed_without_bms === true) {
          this.showSuccess(status);
        } else {
          throw new ApiError('invalid_response', 0, status);
        }
      } catch (error) {
        request.password = '';
        passwordInput.value = '';
        this.setPasswordVisible(false);
        this.showStep('wifi-validating');
        this.showError('wifi-validation-error', errorText(error));
        this.$('wifi-validation-error').textContent += this.recoveryMode
          ? ' Якщо мережу вже збережено й точку налаштування закрито, підключіться до домашнього Wi-Fi та відкрийте bms.local. Для повторного відновлення утримуйте BOOT 5–10 секунд і відпустіть.'
          : ' Якщо сторінка втратила зв’язок, поверніться до Wi-Fi WattPost-XXXX і відкрийте 192.168.4.1, щоб виправити налаштування. Якщо налаштування вже завершено, відкрийте bms.local у домашній мережі.';
        this.$('wifi-validation-status').textContent = 'Перевірка не завершена';
        this.$('wifi-validation-retry').classList.remove('is-hidden');
      } finally {
        this.setBusy(false);
      }
    }

    async skipBms(errorId) {
      if (this.busy) return;
      this.clearError(errorId);
      this.setBusy(true);
      try {
        await api.finishWithoutBms();
        const status = await api.getStatus();
        if (status.setup_completed_without_bms !== true) {
          throw new ApiError('invalid_response', 0, status);
        }
        this.showSuccess(status);
      } catch (error) {
        this.showError(errorId, errorText(error));
      } finally {
        this.setBusy(false);
      }
    }

    async scanBms() {
      if (this.busy) return;
      this.clearError('bms-scan-error');
      this.$('bms-scan').textContent = 'Сканування…';
      this.$('bms-scan').classList.add('is-loading');
      this.$('bms-scan').setAttribute('aria-busy', 'true');
      this.$('bms-scan-status').textContent = 'Шукаємо сумісні пристрої…';
      this.setBusy(true);
      try {
        const started = await api.startBmsScan();
        const generation = started.operation.generation;
        const snapshot = await this.waitForOperation(
          () => api.getBmsScan(),
          generation,
          phase => {
            this.$('bms-scan-status').textContent = phaseText(phase);
          },
          15000,
        );
        this.bmsScan = snapshot;
        this.renderBmsCandidates(snapshot.candidates || []);
        this.$('bms-scan-status').textContent = snapshot.candidates?.length
          ? `Знайдено: ${snapshot.candidates.length}`
          : 'JK BMS не знайдено';
      } catch (error) {
        this.$('bms-scan-status').textContent = '';
        this.showError('bms-scan-error', errorText(error));
      } finally {
        this.$('bms-scan').textContent = 'Оновити список BMS';
        this.$('bms-scan').classList.remove('is-loading');
        this.$('bms-scan').removeAttribute('aria-busy');
        this.setBusy(false);
      }
    }

    renderBmsCandidates(candidates) {
      const root = this.$('bms-candidates');
      root.replaceChildren();
      if (!Array.isArray(candidates) || !candidates.length) {
        const empty = document.createElement('div');
        empty.className = 'setup-note';
        empty.textContent = 'Сумісну JK BMS не знайдено. Переконайтеся, що Bluetooth BMS доступний.';
        root.appendChild(empty);
        return;
      }

      for (const candidate of candidates) {
        const card = document.createElement('div');
        card.className = 'setup-candidate-card';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'setup-candidate';
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', 'false');
        button.setAttribute(
          'aria-label',
          `${candidate.name || 'JK BMS'}${candidate.address_hint ? `, ${candidate.address_hint}` : ''}`,
        );

        const info = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'setup-candidate-title';
        title.textContent = candidate.name || 'JK BMS';
        const meta = document.createElement('div');
        meta.className = 'setup-candidate-meta';
        meta.textContent = candidate.address_hint || 'Адреса прихована';
        info.append(title, meta);

        const signal = document.createElement('div');
        signal.className = 'setup-candidate-signal';
        signal.textContent = Number.isFinite(candidate.rssi_dbm)
          ? `${candidate.rssi_dbm} dBm`
          : 'Обрати';

        button.append(info, signal);
        button.addEventListener('click', () => this.selectBms(candidate));
        card.appendChild(button);
        root.appendChild(card);
      }
    }

    async selectBms(candidate) {
      if (this.busy || !this.bmsScan) return;
      this.setBusy(true);
      this.showStep('bms-validating');
      this.clearError('bms-validation-error');
      this.$('bms-validation-retry').classList.add('is-hidden');
      this.$('bms-validation-skip').classList.add('is-hidden');

      try {
        const started = await api.selectBms(
          this.bmsScan.scan_generation,
          candidate.candidate_id,
        );
        await this.waitForOperation(
          () => api.getBmsScan(),
          started.operation.generation,
          phase => {
            this.$('bms-validation-status').textContent = phaseText(phase);
          },
          36000,
        );

        const status = await api.getStatus();
        this.applyStatus(status);
        if (status.setup_state !== 'configured') {
          throw new ApiError('invalid_response', 0, status);
        }
        this.showSuccess(status);
      } catch (error) {
        this.showStep('bms-validating');
        this.showError('bms-validation-error', errorText(error));
        this.$('bms-validation-status').textContent = 'Перевірка не завершена';
        this.$('bms-validation-retry').classList.remove('is-hidden');
        this.$('bms-validation-skip').classList.remove('is-hidden');
      } finally {
        this.setBusy(false);
      }
    }

    showSuccess(status) {
      this.applyStatus(status);
      this.showStep('success');

      this.$('success-wifi').textContent = status?.wifi?.ssid || 'Підключено';
      const bmsLabel = [
        status?.bms?.name,
        status?.bms?.model,
        status?.bms?.address_hint,
      ].filter(Boolean).join(' · ');
      const deferred = status?.setup_completed_without_bms === true &&
        status?.bms?.configured !== true;
      this.$('success-bms').textContent = deferred
        ? 'Не підключено — можна додати пізніше'
        : (bmsLabel || 'JK BMS');
      this.$('success-description').textContent = deferred
        ? 'Wi-Fi налаштовано. Мережа налаштування закриється за кілька секунд. Відкрийте WattPost у домашній мережі: підключити BMS можна в «Налаштуваннях пристрою».'
        : 'Мережа налаштування закриється за кілька секунд. Підключіться до домашнього Wi-Fi та відкрийте панель WattPost.';

      const ip = status?.wifi?.ip || '';
      const fallback = this.$('success-ip');
      if (ip) {
        fallback.href = `http://${ip}/`;
        fallback.textContent = `Відкрити http://${ip}/`;
        fallback.classList.remove('is-hidden');
      } else {
        fallback.removeAttribute('href');
        fallback.classList.add('is-hidden');
      }
    }
  }

  function boot() {
    const app = new SetupApp();
    global.wattPostSetup = app;
    app.init();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }

  global.WattPostSetupApp = SetupApp;
})(typeof window !== 'undefined' ? window : globalThis);
