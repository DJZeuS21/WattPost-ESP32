/* cloud-transport.js — Owner-only WattPost Cloud adapter for the shared Device UI. */

(function (global) {
  'use strict';

  const CLOUD_CAPABILITIES = Object.freeze({
    liveRead: true,
    historyRead: true,
    bmsSettingsRead: true,
    deviceSettingsRead: true,
    wifiManage: false,
    bmsManage: true,
    bmsForget: false,
    cloudManage: false,
    systemReboot: false,
    systemFactoryReset: false,
    bmsSettingsWrite: false,
    firmwareOta: true,
    firmwareOtaPreference: true,
    accountControls: true,
  });

  const CLOUD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const TEMPERATURE_IDS = new Set(['mos', 't1', 't2', 'ext254', 'ext256', 'ext258']);

  class CloudTransportError extends Error {
    constructor(code, status, payload) {
      super(code || 'request_failed');
      this.name = 'CloudTransportError';
      this.code = code || 'request_failed';
      this.status = Number(status) || 0;
      this.payload = payload || null;
    }
  }

  function cloudIdFromPath(pathname) {
    const match = /^\/device\/([^/]+)$/.exec(pathname || '');
    if (!match || !CLOUD_ID_PATTERN.test(match[1])) {
      throw new CloudTransportError('invalid_cloud_device_path', 0, null);
    }
    return match[1];
  }

  function finiteOrNull(value) {
    return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
  }

  class CloudTransport {
    constructor(options = {}) {
      const pathname = options.pathname || global.location?.pathname || '';
      this.cloudId = cloudIdFromPath(pathname);
      this.fetchFn = options.fetchFn || global.fetch.bind(global);
      this._latestLivePayload = null;
      this._ownershipEpoch = null;
      this._settingsSnapshot = null;
      this._settingsReceivedAt = null;
      this._settingsStatusAttempted = false;
    }

    getRuntimeContext() {
      return { mode: 'cloud', cloudId: this.cloudId };
    }

    getCapabilities() {
      return { ...CLOUD_CAPABILITIES };
    }

    getOwnershipEpoch() {
      return this._ownershipEpoch;
    }

    async #request(path, options = {}) {
      let response;
      try {
        response = await this.fetchFn(path, {
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          ...options,
        });
      } catch (error) {
        throw new CloudTransportError('service_unavailable', 0, error);
      }

      if (response.status === 204) return null;
      let payload;
      try {
        payload = await response.json();
      } catch (_error) {
        throw new CloudTransportError('invalid_response', response.status, null);
      }
      if (!response.ok || payload?.ok !== true) {
        const code = payload?.error?.code || 'request_failed';
        if (code === 'auth_required' && global.location?.assign) {
          global.location.assign('/login');
        }
        throw new CloudTransportError(code, response.status, payload);
      }
      return payload.data;
    }

    #unavailable(capability) {
      return Promise.reject(new CloudTransportError('capability_unavailable', 0, { capability }));
    }

    #mapLive(payload) {
      if (!payload || payload.cloud_id !== this.cloudId) {
        throw new CloudTransportError('invalid_response', 0, payload);
      }
      if (!Number.isInteger(payload.ownership_epoch) ||
          payload.ownership_epoch < 1 || payload.ownership_epoch > 0xffffffff) {
        throw new CloudTransportError('invalid_response', 0, payload);
      }
      this._ownershipEpoch = payload.ownership_epoch;

      const snapshot = payload.snapshot && typeof payload.snapshot === 'object'
        ? payload.snapshot
        : null;
      const bms = snapshot?.bms && typeof snapshot.bms === 'object' ? snapshot.bms : null;
      const network = snapshot?.network && typeof snapshot.network === 'object' ? snapshot.network : null;
      const battery = snapshot?.battery && typeof snapshot.battery === 'object' ? snapshot.battery : null;
      const hasFreshBattery = bms?.connected === true &&
        bms?.data_fresh === true && battery !== null;
      const lastFresh = payload.last_fresh_battery &&
        typeof payload.last_fresh_battery === 'object' &&
        payload.last_fresh_battery.ownership_epoch === payload.ownership_epoch &&
        typeof payload.last_fresh_battery.received_at === 'string' &&
        payload.last_fresh_battery.battery &&
        typeof payload.last_fresh_battery.battery === 'object'
        ? payload.last_fresh_battery
        : null;
      const displayBattery = hasFreshBattery ? battery : lastFresh?.battery || null;
      const temperatures = Array.isArray(displayBattery?.temperatures_c)
        ? displayBattery.temperatures_c
        : [];
      const rawTemperatureIds = displayBattery?.temperature_ids;
      const idsAreUsable = Array.isArray(rawTemperatureIds) &&
        rawTemperatureIds.length === temperatures.length &&
        rawTemperatureIds.every((id, index) =>
          TEMPERATURE_IDS.has(id) &&
          rawTemperatureIds.indexOf(id) === index);
      const validTemperatures = temperatures
        .map((value, index) => ({ value: finiteOrNull(value), index }))
        .filter(entry => entry.value !== null);
      const spreadMv = finiteOrNull(displayBattery?.cell_spread_v);

      return {
        // Browser-to-Cloud is live even when the ESP32's last_seen has expired.
        online: true,
        remote: true,
        device_online: payload.online === true,
        has_snapshot: Boolean(snapshot),
        last_seen: payload.last_seen || null,
        telemetry_received_at: payload.telemetry_received_at || null,
        telemetry_fresh: payload.telemetry_fresh === true,
        last_fresh_battery_received_at: lastFresh?.received_at ||
          (hasFreshBattery ? payload.telemetry_received_at || null : null),
        has_last_fresh_battery: displayBattery !== null,
        bms_connected: bms ? bms.connected === true : null,
        bms_data_fresh: bms ? bms.data_fresh === true : null,
        cloud_network: network,
        cloud_bms: bms,
        firmware_version: payload.firmware_version || null,
        build_id: payload.build_id || null,
        esp_uptime: Number.isInteger(snapshot?.device_uptime_s) && snapshot.device_uptime_s >= 0
          ? snapshot.device_uptime_s
          : null,
        model: typeof payload.bms_model === 'string' && payload.bms_model.trim()
          ? payload.bms_model.trim()
          : 'JK BMS',
        voltage_v: displayBattery?.voltage_v ?? null,
        current_a: displayBattery?.current_a ?? null,
        soc: displayBattery?.soc ?? null,
        remaining_capacity_ah: displayBattery?.remaining_capacity_ah ?? null,
        nominal_capacity_ah: displayBattery?.nominal_capacity_ah ?? null,
        cell_count: displayBattery?.cell_count ?? 0,
        cells_are_logical: true,
        cells: Array.isArray(displayBattery?.cells_v) ? displayBattery.cells_v : [],
        // Keep the backend's authoritative spread; the normalizer rounds this
        // direct V-to-mV conversion and never derives it from min/max cells.
        bms_cell_delta_mv: spreadMv == null ? null : spreadMv * 1000,
        bms_max_cell_index: Number.isInteger(displayBattery?.max_cell_index)
          ? displayBattery.max_cell_index
          : null,
        bms_min_cell_index: Number.isInteger(displayBattery?.min_cell_index)
          ? displayBattery.min_cell_index
          : null,
        temperatures: validTemperatures.map(({ value, index }) => {
          const id = idsAreUsable
            ? rawTemperatureIds[index]
            : 'cloud-temp-' + (index + 1);
          return {
            id,
            name: idsAreUsable ? id : 'Датчик ' + (index + 1),
            supported: true,
            present: true,
            enabled: true,
            value_valid: true,
            alias_of: null,
            val_c: value,
          };
        }),
        temperature_summary_c: null,
        is_stale: !(
          payload.online === true &&
          payload.telemetry_fresh === true &&
          bms?.connected === true &&
          bms?.data_fresh === true
        ),
        wifi_state: network?.wifi_connected === true
          ? 'connected'
          : network?.wifi_connected === false ? 'disconnected' : null,
      };
    }

    async fetchLive(options = {}) {
      const payload = await this.#request(
        `/api/v1/me/devices/${encodeURIComponent(this.cloudId)}/live`,
        options,
      );
      const mapped = this.#mapLive(payload);
      this._latestLivePayload = mapped;
      return mapped;
    }

    async fetchHistoryPage(query = new URLSearchParams(), options = {}) {
      const search = query instanceof URLSearchParams
        ? query.toString()
        : String(query || '').replace(/^\?/, '');
      const suffix = search ? `?${search}` : '';
      const payload = await this.#request(
        `/api/v1/me/devices/${encodeURIComponent(this.cloudId)}/history${suffix}`,
        options,
      );
      if (!payload || !Array.isArray(payload.records)) {
        throw new CloudTransportError('invalid_response', 0, payload);
      }
      return { records: payload.records, context: payload.history_context || null };
    }

    async fetchHistoryContext() {
      return this._ownershipEpoch ? `cloud:${this.cloudId}:${this._ownershipEpoch}` : null;
    }

    async fetchSettings(options = {}) {
      const payload = await this.#request(
        `/api/v1/me/devices/${encodeURIComponent(this.cloudId)}/settings`,
        options,
      );
      if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'settings')) {
        throw new CloudTransportError('invalid_response', 0, payload);
      }
      if (payload.settings === null) {
        if (payload.received_at !== null) {
          throw new CloudTransportError('invalid_response', 0, payload);
        }
        this._settingsSnapshot = null;
        this._settingsReceivedAt = null;
        this._settingsStatusAttempted = false;
        return {
          valid: false,
          received_count: 0,
          message: 'Налаштування BMS ще не синхронізовано з Cloud.',
        };
      }
      if (!payload.settings || typeof payload.settings !== 'object' ||
          payload.settings.valid !== true ||
          !payload.settings.device || typeof payload.settings.device !== 'object') {
        throw new CloudTransportError('invalid_response', 0, payload);
      }
      this._settingsSnapshot = payload.settings;
      this._settingsReceivedAt = typeof payload.received_at === 'string'
        ? payload.received_at
        : null;
      this._settingsStatusAttempted = true;
      return payload.settings;
    }

    async fetchDeviceStatus() {
      const live = this._latestLivePayload || await this.fetchLive();
      if (!this._settingsStatusAttempted) {
        try {
          await this.fetchSettings();
        } catch (_error) {
          // Keep retrying on the existing Device Settings refresh cadence.
        }
      }
      const network = live.cloud_network;
      const bms = live.cloud_bms;
      const settingsDevice = this._settingsSnapshot?.device || null;
      const settingsBattery = this._settingsSnapshot?.battery || null;
      const liveCellCount = Number.isInteger(live.cell_count) && live.cell_count > 0
        ? live.cell_count
        : null;
      const settingsCellCount = Number.isInteger(settingsBattery?.cell_count) && settingsBattery.cell_count > 0
        ? settingsBattery.cell_count
        : null;
      return {
        wifi: {
          connected: network?.wifi_connected ?? null,
          internet_state: network?.internet_reachable === true
            ? 'reachable'
            : network?.internet_reachable === false ? 'unreachable' : 'unknown',
          ssid: null,
          rssi_dbm: null,
          configured: null,
        },
        bms: {
          state: bms?.connected === true ? 'connected' : bms?.connected === false ? 'disconnected' : 'unknown',
          configured: this._settingsSnapshot || bms?.connected === true ? true : null,
          name: settingsDevice?.device_name || null,
          address_hint: null,
          model: settingsDevice?.model || null,
          cell_count: liveCellCount || settingsCellCount,
        },
        cloud: {
          state: live.device_online ? 'paired_online' : 'paired_offline',
          transport_state: live.device_online ? 'online' : 'waiting_network',
          paired_known: true,
          paired: true,
          pairing: { state: 'none' },
          network_available: network?.internet_reachable === true,
        },
      };
    }

    async fetchOtaStatus() {
      const payload = await this.#request(
        `/api/v1/me/devices/${encodeURIComponent(this.cloudId)}/ota`,
      );
      const supported = payload?.automatic_updates_supported;
      const confirmed = payload?.automatic_updates;
      const pending = payload?.automatic_updates_pending;
      const pendingValid = pending === null || (
        pending && typeof pending === 'object' &&
        Number.isInteger(pending.generation) && pending.generation >= 0 &&
        pending.generation <= 0xffffffff &&
        typeof pending.automatic_updates === 'boolean'
      );
      if (!payload || typeof payload !== 'object' ||
          typeof supported !== 'boolean' ||
          !(confirmed === null || typeof confirmed === 'boolean') ||
          !pendingValid ||
          typeof payload.current_version !== 'string' ||
          typeof payload.current_build_id !== 'string') {
        throw new CloudTransportError('invalid_response', 0, payload);
      }
      if (supported && typeof confirmed !== 'boolean') {
        throw new CloudTransportError('invalid_response', 0, payload);
      }
      return payload;
    }

    setOtaAutomaticUpdates(enabled) {
      return this.#request(
        `/api/v1/me/devices/${encodeURIComponent(this.cloudId)}/ota/preferences`,
        {
          method: 'PUT',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ automatic_updates: Boolean(enabled) }),
        },
      );
    }

    installOtaUpdate() {
      return this.#request(
        `/api/v1/me/devices/${encodeURIComponent(this.cloudId)}/ota/install`,
        { method: 'POST' },
      );
    }

    fetchAccountContext() {
      return this.#request('/api/v1/me');
    }

    fetchOwnedDevices() {
      return this.#request('/api/v1/me/devices');
    }

    logoutAccount() {
      return this.#request('/api/v1/auth/logout', { method: 'POST' });
    }

    startWifiScan() { return this.#unavailable('wifiManage'); }
    fetchWifiScan() { return this.#unavailable('wifiManage'); }
    configureWifi() { return this.#unavailable('wifiManage'); }
    reconnectWifi() { return this.#unavailable('wifiManage'); }
    resetWifi() { return this.#unavailable('wifiManage'); }
    startBmsScan() { return this.#bmsCommand({ kind: 'scan' }); }
    fetchBmsScan() {
      return this.#request(`/api/v1/me/devices/${encodeURIComponent(this.cloudId)}/bms`);
    }
    selectBms(selection) {
      return this.#bmsCommand({
        kind: 'select',
        scan_generation: selection.scan_generation,
        candidate_id: selection.candidate_id,
      });
    }
    reconnectBms() { return this.#bmsCommand({ kind: 'reconnect' }); }
    #bmsCommand(command) {
      return this.#request(
        `/api/v1/me/devices/${encodeURIComponent(this.cloudId)}/bms`,
        {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(command),
        },
      );
    }
    forgetBms() { return this.#unavailable('bmsForget'); }
    startCloudPairing() { return this.#unavailable('cloudManage'); }
    disconnectCloud() { return this.#unavailable('cloudManage'); }
    rebootDevice() { return this.#unavailable('systemReboot'); }
    factoryResetDevice() { return this.#unavailable('systemFactoryReset'); }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CloudTransport, CloudTransportError, cloudIdFromPath, CLOUD_CAPABILITIES };
  }
  global.CloudTransport = CloudTransport;
  global.CloudTransportError = CloudTransportError;
  if (global.location?.pathname) {
    global.WattPostTransport = new CloudTransport();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
