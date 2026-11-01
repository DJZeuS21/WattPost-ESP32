(function (global) {
  'use strict';

  const api = global.WattPostSetupApi;
  const ApiError = global.WattPostSetupApiError;
  const POLL_MS = 600;
  const tr = (key, values) => global.WattPostI18n.t(key, values);
  if (global.document) global.document.title = tr('text.wattpost_first_setup');

  const ERROR_TEXT = {
    busy: tr('text.the_device_is_already_busy_try_again'),
    stale_scan: tr('text.scan_results_have_expired_scan_again'),
    candidate_not_found: tr('text.selected_device_is_no_longer_available_refresh_the_list_an'),
    wifi_auth_failed: tr('text.could_not_connect_to_wi_fi_check_the_password'),
    wifi_not_found: tr('text.wi_fi_network_not_found_check_its_name_or_rescan'),
    wifi_connect_failed: tr('text.could_not_connect_to_wi_fi_correct_the_details_and_try_aga'),
    bms_connect_failed: tr('text.could_not_connect_to_the_selected_jk_bms'),
    bms_invalid: tr('text.wattpost_connected_but_did_not_receive_data_from_this_jk_b'),
    storage_error: tr('text.could_not_save_settings_previous_settings_are_unchanged'),
    subsystem_unavailable: tr('text.this_feature_is_temporarily_unavailable_try_again'),
    not_configured: tr('text.initial_setup_is_required'),
    not_ready: tr('text.wi_fi_is_not_ready_check_the_connection_and_try_again'),
    forbidden_origin: tr('text.this_action_is_only_available_on_the_local_wattpost_page'),
    invalid_request: tr('text.invalid_request'),
    invalid_response: tr('text.wattpost_returned_an_invalid_response'),
    operation_timeout: tr('text.operation_timed_out_try_again'),
    operation_reset: tr('text.wattpost_restarted_during_the_operation_try_again'),
    request_failed: tr('text.could_not_contact_wattpost'),
  };

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function errorText(error) {
    const code = error?.code || error?.message || 'request_failed';
    return ERROR_TEXT[code] || tr('setup.error_code', { code });
  }

  function phaseText(phase) {
    return {
      scanning: tr('text.scanning'),
      connecting: tr('text.connecting'),
      validating: tr('text.validating'),
      saving: tr('text.saving'),
      reconnecting: tr('text.reconnecting'),
      resetting: tr('text.updating_status'),
      none: tr('text.waiting'),
    }[phase] || tr('text.working');
  }

  function wifiStateText(state) {
    return {
      connected: tr('text.connected'),
      connecting: tr('text.connecting'),
      disconnected: tr('text.disconnected'),
      error: tr('text.error'),
    }[state] || tr('text.unknown');
  }

  function internetStateText(state) {
    return {
      reachable: tr('text.reachable'),
      unreachable: tr('text.unavailable'),
      unknown: tr('text.not_checked'),
    }[state] || tr('text.not_checked');
  }

  function bmsStateText(state) {
    return {
      connected: tr('text.connected'),
      connecting: tr('text.connecting'),
      disconnected: tr('text.disconnected'),
      error: tr('text.error'),
    }[state] || tr('text.unknown');
  }

  function uptimeText(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value < 60) return tr('setup.uptime_seconds', { count: Math.floor(value) });
    if (value < 3600) return tr('setup.uptime_minutes', { count: Math.floor(value / 60) });
    if (value < 86400) return tr('setup.uptime_hours', { count: Math.floor(value / 3600) });
    return tr('setup.uptime_days', { count: Math.floor(value / 86400) });
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
        ? tr('setup.wifi_recovery')
        : (status?.mode === 'first_setup' ? tr('setup.title') : tr('text.local_mode'));
      this.$('setup-context').textContent = mode;
      this.$('setup-device-state').textContent = version ? `${mode} · ${version}` : mode;
      this.$('setup-progress').classList.toggle('is-hidden', this.recoveryMode);
      this.$('wifi-step-kicker').textContent = this.recoveryMode ? tr('setup.wifi_recovery') : tr('text.step_2_of_3');
      this.$('wifi-step-title').textContent = this.recoveryMode
        ? tr('text.select_another_wi_fi_network')
        : tr('setup.connect_wifi');

      if (typeof document !== 'undefined') {
        document.title = this.recoveryMode
          ? tr('text.wattpost_wi_fi_recovery')
          : tr('text.wattpost_first_setup');
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
      toggle.textContent = visible ? tr('text.hide') : tr('text.show');
      toggle.setAttribute('aria-label', visible ? tr('text.hide_password') : tr('text.show_password'));
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
      this.$('recovery-wifi').toggleAttribute('data-i18n-ignore', Boolean(wifi.ssid));
      this.$('recovery-wifi').textContent = wifi.ssid || tr('text.not_saved');
      this.$('recovery-wifi-state').textContent = wifiStateText(wifi.state);
      this.$('recovery-internet-state').textContent =
        internetStateText(wifi.internet_state);

      const bmsLabel = [
        bmsStateText(bms.state),
        bms.name,
        bms.model,
        bms.address_hint,
      ].filter(Boolean).join(' · ');
      this.$('recovery-bms-state').setAttribute('data-i18n-ignore', '');
      this.$('recovery-bms-state').textContent = bmsLabel || tr('text.no_data');

      const firmware = status?.firmware || {};
      this.$('recovery-firmware').textContent = firmware.version || '—';
      this.$('recovery-uptime').textContent = uptimeText(status?.system?.uptime_s);

      this.$('recovery-note').textContent = message || (
        wifi.state === 'connected'
          ? tr('text.wattpost_is_connected_to_wi_fi_retry_the_connection_or_cho')
          : tr('text.retry_the_saved_network_or_choose_another')
      );
    }

    async reconnectRecoveryWifi() {
      if (this.busy) return;
      this.clearError('recovery-error');
      this.setBusy(true);
      this.$('recovery-note').textContent = tr('text.reconnecting_to_saved_wi_fi');

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
          tr('text.wi_fi_restored_the_setup_network_will_close_shortly_connec'),
        );
      } catch (error) {
        this.showError('recovery-error', errorText(error));
        this.$('recovery-note').textContent =
          tr('text.saved_network_is_not_available_yet_retry_or_choose_another');
      } finally {
        this.setBusy(false);
      }
    }

    async runRecoveryAction(action) {
      if (this.busy) return;

      if (
        action === 'reset-wifi' &&
        typeof global.confirm === 'function' &&
        !global.confirm(tr('text.reset_saved_wi_fi_only_jk_bms_and_history_will_not_be_affe'))
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
          message: tr('text.restart_requested_connection_will_be_interrupted_temporari'),
        },
        'reset-wifi': {
          run: () => api.resetWifi(),
          message: tr('text.wi_fi_settings_erased_wattpost_will_restart_in_first_setup'),
        },
        'factory-reset': {
          run: () => api.factoryReset(),
          message: tr('text.factory_reset_started_wattpost_will_restart_in_first_setup'),
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
      this.$('wifi-scan').textContent = tr('text.scanning');
      this.$('wifi-scan').classList.add('is-loading');
      this.$('wifi-scan').setAttribute('aria-busy', 'true');
      this.$('wifi-scan-status').textContent = tr('text.searching_for_wi_fi_networks');
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
          ? tr('setup.found_count', { count: snapshot.candidates.length })
          : tr('text.no_networks_found');
      } catch (error) {
        this.$('wifi-scan-status').textContent = '';
        this.showError('wifi-form-error', errorText(error));
      } finally {
        this.$('wifi-scan').textContent = tr('text.refresh_networks');
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
        empty.textContent = tr('text.no_networks_found_scan_again_or_enter_a_hidden_network_nam');
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
        title.toggleAttribute('data-i18n-ignore', Boolean(candidate.ssid));
        title.textContent = candidate.ssid || tr('text.unnamed');
        const meta = document.createElement('div');
        meta.className = 'setup-candidate-meta';
        meta.textContent = candidate.auth === 'open'
          ? tr('setup.open_network_channel', { channel: candidate.channel })
          : tr('setup.network_channel', { security: candidate.auth || tr('text.secured'), channel: candidate.channel });
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
        selectedNetwork.textContent = tr('text.hidden_wi_fi_network');
        passwordField.classList.remove('is-hidden');
        credentials.classList.remove('is-hidden');
        return;
      }

      // Only the network choices scroll independently. Never put the password
      // field or the submit action inside that bounded scrolling area.
      this.$('wifi-credentials-home').appendChild(credentials);
      if (this.selectedWifi) {
        selectedNetwork.toggleAttribute('data-i18n-ignore', Boolean(this.selectedWifi.ssid));
        selectedNetwork.textContent = this.selectedWifi.ssid || tr('text.unnamed');
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
          this.showError('wifi-form-error', tr('text.enter_the_hidden_network_name'));
          return;
        }
        request = { hidden_ssid: hiddenSsid, password };
      } else {
        if (!this.wifiScan || !this.selectedWifi) {
          this.showError('wifi-form-error', tr('text.choose_a_network_from_the_list'));
          return;
        }
        if (this.selectedWifi.auth !== 'open' && !password) {
          this.showError('wifi-form-error', tr('text.enter_the_selected_network_password'));
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
            tr('setup.wifi_saved_recovery'),
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
          ? tr('setup.wifi_recovery_error_hint')
          : tr('setup.wifi_first_error_hint');
        this.$('wifi-validation-status').textContent = tr('text.verification_incomplete');
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
      this.$('bms-scan').textContent = tr('text.scanning');
      this.$('bms-scan').classList.add('is-loading');
      this.$('bms-scan').setAttribute('aria-busy', 'true');
      this.$('bms-scan-status').textContent = tr('text.searching_for_compatible_devices');
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
          ? tr('setup.found_count', { count: snapshot.candidates.length })
          : tr('text.jk_bms_not_found');
      } catch (error) {
        this.$('bms-scan-status').textContent = '';
        this.showError('bms-scan-error', errorText(error));
      } finally {
        this.$('bms-scan').textContent = tr('text.refresh_bms_list');
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
        empty.textContent = tr('text.no_compatible_jk_bms_found_make_sure_bms_bluetooth_is_avai');
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
        button.setAttribute('data-i18n-ignore', '');
        button.setAttribute('aria-checked', 'false');
        button.setAttribute(
          'aria-label',
          `${candidate.name || 'JK BMS'}${candidate.address_hint ? `, ${candidate.address_hint}` : ''}`,
        );

        const info = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'setup-candidate-title';
        title.setAttribute('data-i18n-ignore', '');
        title.textContent = candidate.name || 'JK BMS';
        const meta = document.createElement('div');
        meta.className = 'setup-candidate-meta';
        meta.setAttribute('data-i18n-ignore', '');
        meta.textContent = candidate.address_hint || tr('text.address_hidden');
        info.append(title, meta);

        const signal = document.createElement('div');
        signal.className = 'setup-candidate-signal';
        signal.textContent = Number.isFinite(candidate.rssi_dbm)
          ? `${candidate.rssi_dbm} dBm`
          : tr('text.select');

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
        this.$('bms-validation-status').textContent = tr('text.verification_incomplete');
        this.$('bms-validation-retry').classList.remove('is-hidden');
        this.$('bms-validation-skip').classList.remove('is-hidden');
      } finally {
        this.setBusy(false);
      }
    }

    showSuccess(status) {
      this.applyStatus(status);
      this.showStep('success');

      this.$('success-wifi').toggleAttribute('data-i18n-ignore', Boolean(status?.wifi?.ssid));
      this.$('success-wifi').textContent = status?.wifi?.ssid || tr('text.connected');
      const bmsLabel = [
        status?.bms?.name,
        status?.bms?.model,
        status?.bms?.address_hint,
      ].filter(Boolean).join(' · ');
      const deferred = status?.setup_completed_without_bms === true &&
        status?.bms?.configured !== true;
      this.$('success-bms').setAttribute('data-i18n-ignore', '');
      this.$('success-bms').textContent = deferred
        ? tr('text.not_connected_you_can_add_it_later')
        : (bmsLabel || 'JK BMS');
      this.$('success-description').textContent = deferred
        ? tr('text.wi_fi_configured_the_setup_network_will_close_shortly_open')
        : tr('text.the_setup_network_will_close_shortly_connect_to_your_home');

      const ip = status?.wifi?.ip || '';
      // Preserve the explicit UA/EN selection when leaving the setup AP
      // for another origin (bms.local or the assigned LAN IP).
      const lang = global.WattPostI18n?.language;
      const languageQuery = lang === 'en' || lang === 'uk' ? '?lang=' + lang : '';
      this.$('success-local').href = 'http://bms.local/' + languageQuery;
      const fallback = this.$('success-ip');
      if (ip) {
        fallback.href = `http://${ip}/` + languageQuery;
        fallback.textContent = tr('setup.open_ip', { url: `http://${ip}/` });
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
