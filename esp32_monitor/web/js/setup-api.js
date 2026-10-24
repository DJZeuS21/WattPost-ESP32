(function (global) {
  'use strict';

  class SetupApiError extends Error {
    constructor(code, status, payload) {
      super(code || 'request_failed');
      this.name = 'SetupApiError';
      this.code = code || 'request_failed';
      this.status = Number(status) || 0;
      this.payload = payload || null;
    }
  }

  class SetupApi {
    constructor(options = {}) {
      this.fetchFn = options.fetchFn || global.fetch.bind(global);
      this.requestToken = null;
    }

    async _request(path, options = {}) {
      const response = await this.fetchFn(path, {
        cache: 'no-store',
        ...options,
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch (_error) {
        throw new SetupApiError('invalid_response', response.status, null);
      }

      if (!response.ok || !payload || payload.ok === false) {
        const code = payload?.error?.code || 'request_failed';
        throw new SetupApiError(code, response.status, payload);
      }
      return payload;
    }

    async getStatus() {
      const payload = await this._request('/api/device/status');
      return payload.data;
    }

    async getRequestToken(force = false) {
      if (this.requestToken && !force) {
        return this.requestToken;
      }
      const payload = await this._request('/api/device/request-token');
      const token = payload?.data?.request_token;
      if (typeof token !== 'string' || !token) {
        throw new SetupApiError('invalid_response', 0, payload);
      }
      this.requestToken = token;
      return token;
    }

    async _mutate(path, body = {}) {
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = await this.getRequestToken(attempt > 0);
        try {
          return await this._request(path, {
            method: 'POST',
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
            error instanceof SetupApiError &&
            (error.code === 'request_token_required' ||
             error.code === 'request_token_invalid')
          ) {
            this.requestToken = null;
            continue;
          }
          throw error;
        }
      }
      throw lastError || new SetupApiError('request_failed', 0, null);
    }

    async startWifiScan() {
      return this._mutate('/api/device/wifi/scan', {});
    }

    async getWifiScan() {
      const payload = await this._request('/api/device/wifi/scan');
      return payload.data;
    }

    async configureWifi(request) {
      return this._mutate('/api/device/wifi/configure', request);
    }

    async reconnectWifi() {
      return this._mutate('/api/device/wifi/reconnect', {});
    }

    async resetWifi() {
      return this._mutate('/api/device/wifi/reset', { confirm: 'reset_wifi' });
    }

    async reboot() {
      return this._mutate('/api/device/system/reboot', { confirm: 'reboot' });
    }

    async factoryReset() {
      return this._mutate('/api/device/system/factory-reset', {
        confirm: 'factory_reset',
      });
    }

    async finishWithoutBms() {
      return this._mutate('/api/device/setup/finish', {});
    }

    async startBmsScan() {
      return this._mutate('/api/device/bms/scan', {});
    }

    async getBmsScan() {
      const payload = await this._request('/api/device/bms/scan');
      return payload.data;
    }

    async selectBms(scanGeneration, candidateId) {
      return this._mutate('/api/device/bms/select', {
        scan_generation: scanGeneration,
        candidate_id: candidateId,
      });
    }
  }

  global.WattPostSetupApiError = SetupApiError;
  global.WattPostSetupApiClass = SetupApi;
  global.WattPostSetupApi = new SetupApi();
})(typeof window !== 'undefined' ? window : globalThis);
