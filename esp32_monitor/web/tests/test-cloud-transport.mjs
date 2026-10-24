import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { CloudTransport, CloudTransportError, cloudIdFromPath, CLOUD_CAPABILITIES } = require(
  path.join(root, 'js/transports/cloud-transport.js'),
);
const DataNormalizer = require(path.join(root, 'js/data-normalizer.js'));

const cloudId = '2b4e53d7-3a37-4d18-9d47-8b6a57a09a20';
const historyRecords = [{
  t: 1790247600,
  v: 26.4,
  a: -4.2,
  s: 82,
  cell_count: 2,
  cell_mask: 3,
  temp_mask: 5,
  cells: [3295, 3307],
  temps: [281, null, 310, null, null, null],
}];

const settingsSnapshot = {
  valid: true,
  received_count: 53,
  protocol_family: 'JK02_32S',
  device: { model: 'JK_PB2A16S20P', device_name: 'Cabin battery' },
  cell_voltage: {},
  balancing: {},
  current_limits: {},
  temperature: {},
  battery: { cell_count: 16, nominal_capacity_ah: 280 },
  switches: {},
  sleep: {},
};

assert.equal(cloudIdFromPath(`/device/${cloudId}`), cloudId);
for (const pathname of [
  '/device/browser-safe-id',
  `/device/${cloudId}/extra`,
  `/other/${cloudId}`,
  `/device/${cloudId.toUpperCase()}`,
]) {
  assert.throws(() => cloudIdFromPath(pathname), CloudTransportError);
}

assert.deepEqual(CLOUD_CAPABILITIES, {
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

const requests = [];
const fixture = {
  cloud_id: cloudId,
  ownership_epoch: 4,
  online: false,
  last_seen: '2026-09-24T11:00:00Z',
  firmware_version: 'V18.4.19-test',
  build_id: 'cloud-transport-test',
  bms_model: 'JK_PB2A16S20P',
  telemetry_received_at: '2026-09-24T10:59:00Z',
  telemetry_fresh: true,
  snapshot: {
    device_uptime_s: 3723,
    bms: { connected: true, data_fresh: true },
    network: { wifi_connected: true, internet_reachable: true },
    battery: {
      voltage_v: 26.4,
      current_a: -4.2,
      power_w: -110.88,
      soc: 82,
      remaining_capacity_ah: 230.1,
      nominal_capacity_ah: 280,
      charger_status: 'discharging',
      cell_count: 2,
      cells_v: [3.295, 3.307],
      min_cell_voltage_v: 3.295,
      max_cell_voltage_v: 3.307,
      // Deliberately different from max-min: this server value is authoritative.
      cell_spread_v: 0.003,
      temperatures_c: [25, 25, 50],
      temperature_ids: ['t1', 't2', 'mos'],
    },
  },
};
fixture.last_fresh_battery = {
  ownership_epoch: 4,
  received_at: '2026-09-24T10:58:30Z',
  battery: structuredClone(fixture.snapshot.battery),
};
const transport = new CloudTransport({
  pathname: `/device/${cloudId}`,
  fetchFn: async (url, options) => {
    requests.push({ url, options });
    if (url === '/api/v1/me') {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { email: 'owner@example.com' } }) };
    }
    if (url.endsWith('/live')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: fixture }) };
    }
    if (url === `/api/v1/me/devices/${cloudId}/history?after=1790247000&limit=144`) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { records: historyRecords, history_context: `cloud:${cloudId}:4` } }) };
    }
    if (url === `/api/v1/me/devices/${cloudId}/settings`) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {
        settings: settingsSnapshot,
        received_at: '2026-09-24T11:00:00Z',
      } }) };
    }
    if (url === `/api/v1/me/devices/${cloudId}/ota`) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {
        automatic_updates_supported: true,
        automatic_updates: false,
        automatic_updates_pending: { generation: 3, automatic_updates: true },
        current_version: 'V18.4.27',
        current_build_id: 'aaaaaaaaaaaa',
        device_online: true,
        update_available: true,
        latest_release: {
          release_id: 7,
          version: 'V18.4.28',
          build_id: 'bbbbbbbbbbbb',
          size_bytes: 1500000,
          changelog: 'Remote OTA',
          published_at: '2026-09-25T00:00:00Z',
        },
        state: { release_id: 7, version: 'V18.4.28', build_id: 'bbbbbbbbbbbb', trigger: 'auto', state: 'offered', error: null, attempt_count: 1 },
      } }) };
    }
    if (url === `/api/v1/me/devices/${cloudId}/ota/preferences`) {
      assert.equal(options.method, 'PUT');
      assert.deepEqual(JSON.parse(options.body), { automatic_updates: true });
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {
        automatic_updates_supported: true,
        automatic_updates: false,
        automatic_updates_pending: { generation: 4, automatic_updates: true },
      } }) };
    }
    if (url === `/api/v1/me/devices/${cloudId}/ota/install`) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {
        state: { release_id: 7, state: 'offered', trigger: 'manual', attempt_count: 1 },
      } }) };
    }
    if (url === '/api/v1/auth/logout') {
      return { ok: true, status: 204, json: async () => null };
    }
    throw new Error(`unexpected URL ${url}`);
  },
});

assert.deepEqual(transport.getRuntimeContext(), { mode: 'cloud', cloudId });
assert.equal(transport.getCapabilities().historyRead, true);
const raw = await transport.fetchLive();
assert.equal(raw.online, true, 'a successful owner API response means browser transport is online');
assert.equal(raw.device_online, false, 'ESP online state stays separate from browser transport');
assert.equal(raw.bms_connected, true);
assert.equal(raw.bms_data_fresh, true);
assert.equal(raw.last_fresh_battery_received_at, '2026-09-24T10:58:30Z');
assert.equal(raw.has_last_fresh_battery, true);
assert.equal(raw.bms_cell_delta_mv, 3);
assert.equal(raw.esp_uptime, 3723);
assert.equal(transport.getOwnershipEpoch(), 4);
const normalized = DataNormalizer.normalizeLive(raw);
assert.equal(normalized.online, true);
assert.equal(normalized.device_online, false);
assert.equal(normalized.bms_data_fresh, true);
assert.equal(normalized.last_fresh_battery_received_at, '2026-09-24T10:58:30Z');
assert.equal(normalized.esp_uptime, 3723);
assert.equal(normalized.model, 'JK_PB2A16S20P', 'Cloud dashboard uses the owner-only settings model instead of a generic label');
assert.equal(normalized.cells.spread_mv, 3);
assert.equal(normalized.cells.min_cell_index, 0, 'Cloud logical cells derive the lowest-cell highlight from cells_v');
assert.equal(normalized.cells.max_cell_index, 1, 'Cloud logical cells derive the highest-cell highlight from cells_v');
assert.deepEqual(normalized.cells.list.map(cell => cell.physicalNumber), [null, null]);
assert.deepEqual(normalized.cells.list.map(cell => cell.logicalNumber), [1, 2]);
// power_w / charger_status are validated and stored by Cloud, but the shared
// normalizer intentionally derives UI power/activity from V×I so Local and
// Cloud use one deadband and one rendering rule.
assert.equal(normalized.power_w, -110.9);
assert.equal(normalized.activity_state, 'unknown', 'offline/stale state suppresses live activity even when the retained battery current is non-zero');
assert.equal(normalized.temperatures.summary_c, 25);
assert.deepEqual(normalized.temperatures.sensors.map(sensor => sensor.name), [
  'Датчик T1', 'Датчик T2', 'MOSFET',
]);
assert.equal(normalized.temperatures.sensors.find(sensor => sensor.id === 'mos').role, 'mosfet');

const indexedTieFixture = structuredClone(fixture);
indexedTieFixture.online = true;
indexedTieFixture.snapshot.battery.cells_v = [3.330, 3.330];
indexedTieFixture.snapshot.battery.min_cell_voltage_v = 3.330;
indexedTieFixture.snapshot.battery.max_cell_voltage_v = 3.330;
indexedTieFixture.snapshot.battery.cell_spread_v = 0.001;
indexedTieFixture.snapshot.battery.max_cell_index = 0;
indexedTieFixture.snapshot.battery.min_cell_index = 1;
indexedTieFixture.last_fresh_battery.battery = structuredClone(indexedTieFixture.snapshot.battery);
const indexedTieTransport = new CloudTransport({
  pathname: '/device/' + cloudId,
  fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: indexedTieFixture }) }),
});
const indexedTie = DataNormalizer.normalizeLive(await indexedTieTransport.fetchLive());
assert.equal(indexedTie.cells.max_cell_index, 0, 'authoritative Cloud max index wins over all-equal displayed cell values');
assert.equal(indexedTie.cells.min_cell_index, 1, 'authoritative Cloud min index wins over all-equal displayed cell values');
assert.equal(indexedTie.cells.spread_mv, 1);

const mosOnlyFixture = structuredClone(fixture);
mosOnlyFixture.snapshot.battery.temperatures_c = [50];
mosOnlyFixture.snapshot.battery.temperature_ids = ['mos'];
const mosOnlyTransport = new CloudTransport({
  pathname: '/device/' + cloudId,
  fetchFn: async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data: mosOnlyFixture }),
  }),
});
const mosOnly = DataNormalizer.normalizeLive(await mosOnlyTransport.fetchLive());
assert.equal(mosOnly.temperatures.summary_c, null, 'MOSFET temperature is not battery temperature');

const legacyFixture = structuredClone(fixture);
delete legacyFixture.snapshot.battery.temperature_ids;
const legacyTransport = new CloudTransport({
  pathname: '/device/' + cloudId,
  fetchFn: async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data: legacyFixture }),
  }),
});
const legacy = DataNormalizer.normalizeLive(await legacyTransport.fetchLive());
assert.equal(legacy.online, true, 'legacy telemetry without channel IDs remains readable');
assert.equal(legacy.temperatures.summary_c, null, 'unknown legacy channels do not invent battery roles');
assert.equal(legacy.temperatures.sensors.length, 3);

const query = new URLSearchParams({ after: '1790247000', limit: '144' });
const historyPage = await transport.fetchHistoryPage(query);
assert.deepEqual(historyPage.records, historyRecords);
assert.equal(historyPage.context, `cloud:${cloudId}:4`);
assert.deepEqual(await transport.fetchSettings(), settingsSnapshot);
const otaStatus = await transport.fetchOtaStatus();
assert.equal(otaStatus.automatic_updates, false);
assert.equal(otaStatus.automatic_updates_supported, true);
assert.equal(otaStatus.automatic_updates_pending.generation, 3);
assert.equal(otaStatus.latest_release.version, 'V18.4.28');
const queuedPreference = await transport.setOtaAutomaticUpdates(true);
assert.equal(queuedPreference.automatic_updates, false);
assert.equal(queuedPreference.automatic_updates_pending.generation, 4);
assert.equal((await transport.installOtaUpdate()).state.trigger, 'manual');

assert.deepEqual(await transport.fetchAccountContext(), { email: 'owner@example.com' });
await transport.logoutAccount();
assert.equal(requests[0].url, `/api/v1/me/devices/${cloudId}/live`);
assert.equal(requests[0].options.credentials, 'same-origin');
assert.equal(requests[0].options.cache, 'no-store');
assert.equal(requests[1].url, `/api/v1/me/devices/${cloudId}/history?after=1790247000&limit=144`);
assert.equal(requests[2].url, `/api/v1/me/devices/${cloudId}/settings`);
assert.equal(requests[2].options.credentials, 'same-origin');
assert.equal(requests[2].options.cache, 'no-store');
assert.equal(requests[3].url, `/api/v1/me/devices/${cloudId}/ota`);
assert.equal(requests[4].url, `/api/v1/me/devices/${cloudId}/ota/preferences`);
assert.equal(requests[4].options.method, 'PUT');
assert.equal(requests[5].url, `/api/v1/me/devices/${cloudId}/ota/install`);
assert.equal(requests[5].options.method, 'POST');
assert.equal(requests[6].url, '/api/v1/me');
assert.equal(requests[7].options.method, 'POST');
assert.equal(requests[7].url, '/api/v1/auth/logout');

const noSettingsTransport = new CloudTransport({
  pathname: `/device/${cloudId}`,
  fetchFn: async url => {
    assert.equal(url, `/api/v1/me/devices/${cloudId}/settings`);
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {
      settings: null,
      received_at: null,
    } }) };
  },
});
assert.deepEqual(await noSettingsTransport.fetchSettings(), {
  valid: false,
  received_count: 0,
  message: 'Налаштування BMS ще не синхронізовано з Cloud.',
});

let lateSettingsRequests = 0;
const lateSettingsTransport = new CloudTransport({
  pathname: `/device/${cloudId}`,
  fetchFn: async url => {
    if (url === `/api/v1/me/devices/${cloudId}/live`) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: fixture }) };
    }
    if (url === `/api/v1/me/devices/${cloudId}/settings`) {
      lateSettingsRequests += 1;
      const settings = lateSettingsRequests === 1 ? null : settingsSnapshot;
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {
        settings,
        received_at: settings ? '2026-09-24T11:00:00Z' : null,
      } }) };
    }
    throw new Error(`unexpected URL ${url}`);
  },
});
const statusBeforeSettings = await lateSettingsTransport.fetchDeviceStatus();
assert.equal(statusBeforeSettings.bms.name, null);
assert.equal(statusBeforeSettings.bms.model, null);
const statusAfterSettings = await lateSettingsTransport.fetchDeviceStatus();
assert.equal(lateSettingsRequests, 2, 'missing settings are retried on the next existing status refresh');
assert.equal(statusAfterSettings.bms.name, 'Cabin battery');
assert.equal(statusAfterSettings.bms.model, 'JK_PB2A16S20P');

const statusFixture = structuredClone(fixture);
statusFixture.online = false;
statusFixture.snapshot.bms.connected = false;
statusFixture.snapshot.bms.data_fresh = false;
statusFixture.snapshot.battery.cell_count = 0;
statusFixture.snapshot.battery.cells_v = [];
statusFixture.snapshot.device_uptime_s = 120;
const statusTransportRequests = [];
const statusTransport = new CloudTransport({
  pathname: `/device/${cloudId}`,
  fetchFn: async url => {
    statusTransportRequests.push(url);
    if (url === `/api/v1/me/devices/${cloudId}/live`) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: statusFixture }) };
    }
    if (url === `/api/v1/me/devices/${cloudId}/settings`) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {
        settings: settingsSnapshot,
        received_at: '2026-09-24T11:00:00Z',
      } }) };
    }
    throw new Error(`unexpected URL ${url}`);
  },
});
const remoteStatus = await statusTransport.fetchDeviceStatus();
assert.deepEqual(statusTransportRequests, [
  `/api/v1/me/devices/${cloudId}/live`,
  `/api/v1/me/devices/${cloudId}/settings`,
]);
assert.deepEqual(remoteStatus.wifi, {
  connected: true,
  internet_state: 'reachable',
  ssid: null,
  rssi_dbm: null,
  configured: null,
});
assert.deepEqual(remoteStatus.bms, {
  state: 'disconnected',
  configured: true,
  name: 'Cabin battery',
  address_hint: null,
  model: 'JK_PB2A16S20P',
  cell_count: 2,
});
assert.deepEqual(remoteStatus.cloud, {
  state: 'paired_offline',
  transport_state: 'waiting_network',
  paired_known: true,
  paired: true,
  pairing: { state: 'none' },
  network_available: true,
});
assert.equal(statusTransport.getCapabilities().bmsSettingsRead, true);

const noFreshStaleFixture = structuredClone(fixture);
noFreshStaleFixture.online = true;
noFreshStaleFixture.snapshot.bms.data_fresh = false;
noFreshStaleFixture.snapshot.battery = {
  voltage_v: null,
  current_a: null,
  soc: null,
  remaining_capacity_ah: null,
  nominal_capacity_ah: null,
  cell_count: 0,
  cells_v: [],
  cell_spread_v: null,
  temperatures_c: [],
};
delete noFreshStaleFixture.last_fresh_battery;
const staleTransport = new CloudTransport({
  pathname: `/device/${cloudId}`,
  fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: noFreshStaleFixture }) }),
});
const stale = DataNormalizer.normalizeLive(await staleTransport.fetchLive());
assert.equal(stale.device_online, true);
assert.equal(stale.bms_connected, true);
assert.equal(stale.bms_data_fresh, false);
assert.equal(stale.voltage_v, null);
assert.equal(stale.cells.valid, false);
assert.equal(stale.state, 'idle');
assert.equal(stale.activity_state, 'unknown');
assert.equal(stale.is_stale, true);

const staleFixture = structuredClone(noFreshStaleFixture);
staleFixture.last_fresh_battery = structuredClone(fixture.last_fresh_battery);
let retainedCall = 0;
const retainedTransport = new CloudTransport({
  pathname: '/device/' + cloudId,
  fetchFn: async () => {
    retainedCall += 1;
    const data = retainedCall === 1 ? fixture : staleFixture;
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  },
});
await retainedTransport.fetchLive();
const retained = DataNormalizer.normalizeLive(await retainedTransport.fetchLive());
assert.equal(retained.is_stale, true);
assert.equal(retained.state, 'idle');
assert.equal(retained.voltage_v, 26.4, 'last-known voltage remains available while BMS is stale');
assert.equal(retained.current_a, -4.2, 'last-known current remains available while BMS is stale');
assert.equal(retained.temperatures.summary_c, 25);
assert.equal(retained.activity_state, 'unknown');
assert.equal(retained.last_fresh_battery_received_at, '2026-09-24T10:58:30Z');

const coldStaleTransport = new CloudTransport({
  pathname: '/device/' + cloudId,
  fetchFn: async () => {
    const offlineStale = structuredClone(staleFixture);
    offlineStale.online = false;
    return { ok: true, status: 200, json: async () => ({ ok: true, data: offlineStale }) };
  },
});
const coldStale = DataNormalizer.normalizeLive(await coldStaleTransport.fetchLive());
assert.equal(coldStale.device_online, false);
assert.equal(coldStale.bms_data_fresh, false);
assert.equal(coldStale.is_stale, true);
assert.equal(coldStale.voltage_v, 26.4, 'a new transport loads backend last-fresh values on its first request');
assert.equal(coldStale.current_a, -4.2);
assert.equal(coldStale.soc, 82);
assert.deepEqual(coldStale.cells.voltages, [3.295, 3.307]);
assert.equal(coldStale.temperatures.summary_c, 25);
assert.equal(coldStale.activity_state, 'unknown');

const recoveryFixture = structuredClone(fixture);
recoveryFixture.online = true;
const recoveryTransport = new CloudTransport({
  pathname: '/device/' + cloudId,
  fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: recoveryFixture }) }),
});
const freshRecovery = DataNormalizer.normalizeLive(await recoveryTransport.fetchLive());
assert.equal(freshRecovery.is_stale, false);
assert.equal(freshRecovery.activity_state, 'discharging');
assert.equal(freshRecovery.voltage_v, 26.4);

const wrongEpochFixture = structuredClone(staleFixture);
wrongEpochFixture.last_fresh_battery.ownership_epoch = 3;
const wrongEpochTransport = new CloudTransport({
  pathname: '/device/' + cloudId,
  fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: wrongEpochFixture }) }),
});
const wrongEpoch = DataNormalizer.normalizeLive(await wrongEpochTransport.fetchLive());
assert.equal(wrongEpoch.voltage_v, null, 'last-fresh data from another ownership epoch is ignored');

const invalidEpochTransport = new CloudTransport({
  pathname: `/device/${cloudId}`,
  fetchFn: async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data: { ...fixture, ownership_epoch: 0 } }),
  }),
});
await assert.rejects(invalidEpochTransport.fetchLive(), error => error.code === 'invalid_response');
assert.equal(invalidEpochTransport.getOwnershipEpoch(), null);

const mutationTransport = new CloudTransport({
  pathname: `/device/${cloudId}`,
  fetchFn: async () => { throw new Error('mutations must not call the network'); },
});
for (const mutation of [
  () => mutationTransport.startWifiScan(),
  () => mutationTransport.fetchWifiScan(),
  () => mutationTransport.configureWifi({ ssid: 'must-not-send' }),
  () => mutationTransport.reconnectWifi(),
  () => mutationTransport.resetWifi(),
  () => mutationTransport.forgetBms(),
  () => mutationTransport.startCloudPairing(),
  () => mutationTransport.disconnectCloud(),
  () => mutationTransport.rebootDevice(),
  () => mutationTransport.factoryResetDevice(),
]) {
  await assert.rejects(mutation(), error => error.code === 'capability_unavailable');
}

// A hello can keep ESP online while the accepted telemetry is hours old.
const oldTelemetry = { ...recoveryFixture, telemetry_fresh: false };
const oldTransport = new CloudTransport({ pathname: `/device/${cloudId}`,
  fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: oldTelemetry }) }) });
const oldLive = DataNormalizer.normalizeLive(await oldTransport.fetchLive());
assert.equal(oldLive.device_online, true);
assert.equal(oldLive.is_stale, true);
assert.equal(oldLive.soc, 82);
assert.equal(oldLive.activity_state, 'unknown');


test('Cloud BMS connection operations are owner-scoped and cannot forget settings', async () => {
  const calls = [];
  const transport = new CloudTransport({
    pathname: `/device/${cloudId}`,
    fetchFn: async (url, options) => {
      calls.push([url, options]);
      return { ok: true, status: 200, json: async () => ({
        ok: true,
        data: {
          scan_generation: 17,
          candidates: [{ candidate_id: 1, name: 'JK-BMS', rssi_dbm: -40, address_hint: '...AA:FF' }],
          operation: { generation: 7, state: 'success', phase: 'none', error_code: null },
        },
      }) };
    },
  });
  assert.equal(transport.getCapabilities().bmsManage, true);
  assert.equal(transport.getCapabilities().bmsForget, false);
  await transport.startBmsScan();
  await transport.fetchBmsScan();
  await transport.selectBms({ scan_generation: 17, candidate_id: 1 });
  await transport.reconnectBms();
  assert.deepEqual(calls.map(([url, options]) => [url, options.method || 'GET']),
    [ ['/' + 'api/v1/me/devices/' + cloudId + '/bms','POST'],
      ['/' + 'api/v1/me/devices/' + cloudId + '/bms','GET'],
      ['/' + 'api/v1/me/devices/' + cloudId + '/bms','POST'],
      ['/' + 'api/v1/me/devices/' + cloudId + '/bms','POST'] ]);
  assert.deepEqual(calls.filter(([,options]) => options.method === 'POST')
    .map(([,options]) => JSON.parse(options.body)),
    [{ kind: 'scan' }, { kind: 'select', scan_generation: 17, candidate_id: 1 }, { kind: 'reconnect' }]);
  await assert.rejects(transport.forgetBms(), e => e.code === 'capability_unavailable');
});
