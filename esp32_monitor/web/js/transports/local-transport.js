/* local-transport.js — Local ESP32 API adapter for the shared Device UI. */

(function (global) {
  'use strict';

  const LOCAL_CAPABILITIES = Object.freeze({
    liveRead: true,
    historyRead: true,
    bmsSettingsRead: true,
    deviceSettingsRead: true,
    wifiManage: true,
    bmsManage: true,
    bmsForget: true,
    cloudManage: true,
    systemReboot: true,
    systemFactoryReset: true,
    bmsSettingsWrite: false,
    firmwareOta: true,
    firmwareOtaPreference: true,
    accountControls: false,
  });

  class LocalTransportError extends Error {
    constructor(code, status, payload) {
      super(code || 'request_failed');
      this.name = 'LocalTransportError';
      this.code = code || 'request_failed';
      this.status = Number(status) || 0;
      this.payload = payload || null;
    }
  }

  class LocalTransport {
    constructor(options = {}) {
      this.fetchFn = options.fetchFn || global.fetch.bind(global);
      this._requestToken = null;
    }

    getRuntimeContext() {
      return { mode: 'local', cloudId: null };
    }

    getCapabilities() {
      return { ...LOCAL_CAPABILITIES };
    }

    async #request(path, options = {}) {
      const response = await this.fetchFn(path, {
        cache: 'no-store',
        ...options,
      });
      let payload;
      try {
        payload = await response.json();
      } catch (_error) {
        throw new LocalTransportError('invalid_response', response.status, null);
      }
      if (!response.ok || payload?.ok === false) {
        throw new LocalTransportError(
          payload?.error?.code || 'request_failed',
          response.status,
          payload,
        );
      }
      return payload;
    }

    async #deviceRequest(path, options = {}) {
      const payload = await this.#request(path, options);
      if (!payload) {
        throw new LocalTransportError(
          'request_failed',
          0,
          payload,
        );
      }
      return payload;
    }

    async #requestToken(force = false) {
      if (this._requestToken && !force) return this._requestToken;
      const payload = await this.#deviceRequest('/api/device/request-token');
      const token = payload?.data?.request_token;
      if (typeof token !== 'string' || !token) {
        throw new LocalTransportError('invalid_response', 0, payload);
      }
      this._requestToken = token;
      return token;
    }

    async #protectedMutation(path, body = {}, method = 'POST') {
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = await this.#requestToken(attempt > 0);
        try {
          return await this.#deviceRequest(path, {
            method,
            headers: {
              'Content-Type': 'application/json',
              'X-WattPost-Request-Token': token,
            },
            body: JSON.stringify(body),
          });
        } catch (error) {
          lastError = error;
          if (
            attempt === 0 &&
            error instanceof LocalTransportError &&
            (error.code === 'request_token_required' ||
             error.code === 'request_token_invalid')
          ) {
            this._requestToken = null;
            continue;
          }
          throw error;
        }
      }
      throw lastError || new LocalTransportError('request_failed', 0, null);
    }

    fetchLive(options = {}) {
      return this.#request('/api/live', options);
    }

    async fetchHistoryPage(query, options = {}) {
      const params = new URLSearchParams(query || '').toString();
      const path = params ? `/api/history?${params}` : '/api/history';
      const response = await this.fetchFn(path, { cache: 'no-store', ...options });
      const records = await response.json();
      if (!response.ok || !Array.isArray(records)) {
        throw new LocalTransportError('invalid_response', response.status, records);
      }
      return { records, context: response.headers?.get('X-WattPost-History-Context') || null };
    }

    async fetchHistoryContext(options = {}) {
      const status = await this.fetchDeviceStatus(options);
      return typeof status?.history_context === 'string' ? status.history_context : null;
    }

    fetchSettings(options = {}) {
      return this.#request('/api/settings', options);
    }

    async fetchDeviceStatus(options = {}) {
      const payload = await this.#deviceRequest('/api/device/status', options);
      return payload.data || null;
    }

    startWifiScan() {
      return this.#protectedMutation('/api/device/wifi/scan', {});
    }

    async fetchWifiScan() {
      const payload = await this.#deviceRequest('/api/device/wifi/scan');
      return payload.data || null;
    }

    configureWifi(body) {
      return this.#protectedMutation('/api/device/wifi/configure', body);
    }

    reconnectWifi() {
      return this.#protectedMutation('/api/device/wifi/reconnect', {});
    }

    resetWifi() {
      return this.#protectedMutation('/api/device/wifi/reset', {
        confirm: 'reset_wifi',
      });
    }

    startBmsScan() {
      return this.#protectedMutation('/api/device/bms/scan', {});
    }

    async fetchBmsScan() {
      const payload = await this.#deviceRequest('/api/device/bms/scan');
      return payload.data || null;
    }

    selectBms(body) {
      return this.#protectedMutation('/api/device/bms/select', body);
    }

    reconnectBms() {
      return this.#protectedMutation('/api/device/bms/reconnect', {});
    }

    forgetBms() {
      return this.#protectedMutation('/api/device/bms/forget', {
        confirm: 'forget_bms',
      });
    }

    startCloudPairing() {
      return this.#protectedMutation('/api/device/cloud/pair', {});
    }

    disconnectCloud() {
      return this.#protectedMutation('/api/device/cloud/disconnect', {
        confirm: 'disconnect_cloud',
      });
    }

    async fetchOtaStatus() {
      const payload = await this.#deviceRequest('/api/device/ota');
      return payload.data || null;
    }

    setOtaAutomaticUpdates(enabled) {
      return this.#protectedMutation(
        '/api/device/ota/preferences',
        { automatic_updates: Boolean(enabled) },
        'PUT',
      );
    }

    installOtaUpdate() {
      return this.#protectedMutation('/api/device/ota/install', {});
    }

    rebootDevice() {
      return this.#protectedMutation('/api/device/system/reboot', {
        confirm: 'reboot',
      });
    }

    factoryResetDevice() {
      return this.#protectedMutation('/api/device/system/factory-reset', {
        confirm: 'factory_reset',
      });
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LocalTransport, LocalTransportError };
  }
  global.LocalTransport = LocalTransport;
  global.LocalTransportError = LocalTransportError;
  global.WattPostTransport = new LocalTransport();
})(typeof globalThis !== 'undefined' ? globalThis : window);
