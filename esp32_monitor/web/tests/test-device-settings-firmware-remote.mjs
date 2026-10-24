import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'js', 'device-settings.js'),
  'utf8',
);
const CSS = fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8');
const require = createRequire(import.meta.url);
const {
  DeviceSettingsView,
  safePairUrl,
} = require('../js/device-settings.js');

function node(extra = {}) {
  return {
    textContent: '',
    dataset: {},
    hidden: false,
    disabled: false,
    checked: false,
    attributes: {},
    style: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    ...extra,
  };
}

function createViewHarness() {
  const ids = [
    'device-firmware-state',
    'device-firmware-version',
    'device-build-id',
    'device-ota-state',
    'device-ota-automatic',
    'device-ota-automatic-toggle',
    'device-ota-release-row',
    'device-ota-release',
    'device-ota-install',
    'device-ota-disable-automatic',
    'device-ota-progress',
    'device-ota-progress-dismiss',
    'device-ota-progress-stage',
    'device-ota-progress-percent',
    'device-ota-progress-track',
    'device-ota-progress-fill',
    'device-ota-progress-detail',
    'device-ota-message',
    'device-restart-reason',
    'device-remote-state',
    'device-cloud-transport',
    'device-cloud-account',
    'device-cloud-connect',
    'device-cloud-disconnect',
    'device-cloud-message',
    'device-bms-state',
    'device-bms-address',
    'device-bms-model',
    'device-bms-ble',
    'device-bms-cells',
  ];
  const nodes = Object.fromEntries(ids.map(id => [id, node()]));
  nodes['device-cloud-disconnect'].hidden = true;

  const view = new DeviceSettingsView();
  view.container = {
    querySelector(selector) {
      if (!selector.startsWith('#')) return null;
      return nodes[selector.slice(1)] || null;
    },
  };
  return { view, nodes };
}

test('Device Settings hides false first-frame values until live and status snapshots settle', () => {
  assert.match(
    SOURCE,
    /this\._setInitialLoading\(true\);[\s\S]*?Promise\.allSettled\(\[initialLivePromise, this\._initialStatusPromise\]\)[\s\S]*?this\._setInitialLoading\(false\)/,
  );
  assert.match(
    CSS,
    /\.view-settings\.is-initial-loading\s+\.device-settings-grid,[\s\S]*?visibility:\s*hidden/,
  );
  assert.match(SOURCE, /id="device-ota-automatic">—<\/strong>/);
  assert.doesNotMatch(SOURCE, /id="device-ota-automatic">Увімкнено<\/strong>/);
});

test('initial Settings busy state preserves layout and clears aria-busy when ready', () => {
  const view = new DeviceSettingsView();
  const classes = new Set();
  const attributes = {};
  view.container = {
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
    setAttribute(name, value) {
      attributes[name] = String(value);
    },
    removeAttribute(name) {
      delete attributes[name];
    },
  };

  view._setInitialLoading(true);
  assert.equal(classes.has('is-initial-loading'), true);
  assert.equal(attributes['aria-busy'], 'true');

  view._setInitialLoading(false);
  assert.equal(classes.has('is-initial-loading'), false);
  assert.equal(Object.hasOwn(attributes, 'aria-busy'), false);
});

test('Cloud local-only notice does not mislabel firmware OTA as local-only', () => {
  const view = new DeviceSettingsView();
  const note = node();
  let prepended = null;
  const makeControl = capability => ({
    dataset: { capability },
    disabled: false,
    attributes: {},
    matches() { return true; },
    querySelectorAll() { return []; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] || ''; },
  });
  const wifi = makeControl('wifiManage');
  const ota = makeControl('firmwareOta');
  view.capabilities = {
    wifiManage: false, bmsManage: false, cloudManage: false,
    systemReboot: false, systemFactoryReset: false,
    firmwareOta: true, firmwareOtaPreference: true,
  };
  view.container = {
    prepend(value) { prepended = value; },
    querySelectorAll() { return [wifi, ota]; },
  };
  const previousDocument = globalThis.document;
  globalThis.document = { createElement() { return note; } };
  try {
    view._applyCapabilities();
  } finally {
    globalThis.document = previousDocument;
  }

  assert.equal(wifi.disabled, true);
  assert.equal(ota.disabled, false);
  assert.equal(prepended, note);
  assert.match(note.textContent, /Wi-Fi та системні дії доступні лише локально/);
  assert.match(note.textContent, /Підключення JK BMS.*WattPost Cloud/);
  assert.equal(ota.attributes.title, undefined);
});

test('OTA request renders immediate sending and accepted waiting feedback', async () => {
  const { view, nodes } = createViewHarness();
  view.capabilities = { firmwareOta: true, firmwareOtaPreference: true };
  const offered = {
    automatic_updates_supported: true, automatic_updates: false,
    update_available: true,
    latest_release: { version: 'V18.4.41', build_id: 'dddddddddddd', changelog: '' },
    state: { version: 'V18.4.41', build_id: 'dddddddddddd', state: 'offered', error: null },
  };
  view.otaStatus = offered;
  view._acceptOtaStatus(offered);

  let resolveInstall;
  let resolveStatus;
  const installPromise = new Promise(resolve => { resolveInstall = resolve; });
  const statusPromise = new Promise(resolve => { resolveStatus = resolve; });
  const previousApiClient = globalThis.ApiClient;
  globalThis.ApiClient = {
    installOtaUpdate() { return installPromise; },
    fetchOtaStatus() { return statusPromise; },
  };
  try {
    const action = view._installOtaUpdate();
    assert.equal(nodes['device-ota-install'].disabled, true);
    assert.equal(nodes['device-ota-install'].textContent, 'Надсилаємо…');
    assert.match(nodes['device-ota-message'].textContent, /Надсилаємо запит/);

    resolveInstall({});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nodes['device-ota-install'].disabled, true);
    assert.equal(nodes['device-ota-install'].textContent, 'Очікуємо пристрій…');
    assert.equal(nodes['device-firmware-state'].textContent, 'Очікуємо пристрій');
    assert.match(nodes['device-ota-message'].textContent, /Запит на оновлення прийнято/);

    resolveStatus({
      ...offered,
      state: { ...offered.state, state: 'downloading' },
    });
    await action;
    assert.equal(view.otaBusy, false);
    assert.equal(view.otaRequestAccepted, false);
    assert.equal(nodes['device-ota-install'].disabled, true);
    assert.equal(nodes['device-ota-install'].textContent, 'Завантаження…');
    assert.equal(nodes['device-firmware-state'].textContent, 'Завантаження');
  } finally {
    globalThis.ApiClient = previousApiClient;
  }
});

test('Accepted OTA request stays pending while authoritative state is still offered', () => {
  const { view, nodes } = createViewHarness();
  view.capabilities = { firmwareOta: true, firmwareOtaPreference: true };
  view.otaBusy = true;
  view.otaRequestAccepted = true;
  const status = {
    automatic_updates_supported: true, automatic_updates: false, update_available: true,
    latest_release: { version: 'V18.4.41', build_id: 'eeeeeeeeeeee', changelog: '' },
    state: { version: 'V18.4.41', build_id: 'eeeeeeeeeeee', state: 'offered', error: null },
  };
  view._acceptOtaStatus(status);
  assert.equal(nodes['device-ota-install'].disabled, true);
  assert.equal(nodes['device-ota-install'].textContent, 'Очікуємо пристрій…');
  assert.equal(nodes['device-firmware-state'].textContent, 'Очікуємо пристрій');
});

test('Failed OTA action clears pending UI and keeps the failure message visible', async () => {
  const { view, nodes } = createViewHarness();
  view.capabilities = { firmwareOta: true, firmwareOtaPreference: true };
  view.otaStatus = {
    automatic_updates_supported: true, automatic_updates: false, update_available: true,
    latest_release: { version: 'V18.4.41', build_id: 'ffffffffffff', changelog: '' },
    state: { version: 'V18.4.41', build_id: 'ffffffffffff', state: 'offered', error: null },
  };
  view._acceptOtaStatus(view.otaStatus);
  const previousApiClient = globalThis.ApiClient;
  globalThis.ApiClient = {
    async installOtaUpdate() { throw Object.assign(new Error('request_failed'), { code: 'request_failed' }); },
  };
  try {
    await view._installOtaUpdate();
    assert.equal(view.otaBusy, false);
    assert.equal(view.otaRequestAccepted, false);
    assert.equal(nodes['device-ota-install'].disabled, false);
    assert.match(nodes['device-ota-message'].textContent, /Не вдалося запустити оновлення/);
  } finally {
    globalThis.ApiClient = previousApiClient;
  }
});

test('Firmware card renders version, exact build and user-facing status', () => {
  const { view, nodes } = createViewHarness();
  view.onLive({
    firmware_version: 'V18.4.15',
    build_id: 'deadbeef1234',
    ota_state: 'valid',
    ota_rollback_configured: true,
    ota_validation_pending: false,
    last_restart_reason: 'bms_timeout',
  });

  assert.equal(nodes['device-firmware-version'].textContent, 'V18.4.15');
  assert.equal(nodes['device-build-id'].textContent, 'deadbeef1234');
  assert.equal(nodes['device-ota-state'].textContent, 'Працює нормально');
  assert.equal(nodes['device-firmware-state'].textContent, 'Встановлено');
  assert.equal(nodes['device-firmware-state'].dataset.tone, 'info');
  assert.equal(
    nodes['device-restart-reason'].textContent,
    'Перезапуск для відновлення BMS',
  );
});

test('Firmware card surfaces pending OTA validation without inventing update availability', () => {
  const { view, nodes } = createViewHarness();
  view.onLive({
    firmware_version: 'V18.4.15',
    build_id: 'pending-build',
    ota_state: 'pending_verify',
    ota_rollback_configured: true,
    ota_validation_pending: true,
  });

  assert.equal(
    nodes['device-firmware-state'].textContent,
    'Перевіряється після оновлення',
  );
  assert.equal(nodes['device-firmware-state'].dataset.tone, 'warning');
  assert.equal(nodes['device-ota-state'].textContent, 'Перевіряється');
  assert.equal(SOURCE.includes('Доступне оновлення'), true);
});

test('Firmware card renders automatic signed OTA availability and retry states', () => {
  const { view, nodes } = createViewHarness();
  view.capabilities = { firmwareOta: true, firmwareOtaPreference: true };
  const status = {
    automatic_updates_supported: true,
    automatic_updates: true,
    update_available: true,
    latest_release: {
      release_id: 7,
      version: 'V18.4.28',
      build_id: 'bbbbbbbbbbbb',
      changelog: 'Signed Remote OTA',
    },
    state: {
      release_id: 7,
      version: 'V18.4.28',
      build_id: 'bbbbbbbbbbbb',
      state: 'offered',
      error: null,
    },
  };
  view.otaStatus = status;
  view._acceptOtaStatus(status);

  assert.equal(nodes['device-ota-automatic'].textContent, 'Увімкнено');
  assert.equal(nodes['device-ota-automatic-toggle'].checked, true);
  assert.equal(nodes['device-ota-automatic-toggle'].disabled, false);
  assert.equal(nodes['device-ota-release-row'].hidden, false);
  assert.equal(nodes['device-ota-release'].textContent, 'V18.4.28');
  assert.equal(nodes['device-ota-install'].disabled, false);
  assert.equal(nodes['device-firmware-state'].textContent, 'Доступне оновлення');
  assert.equal(nodes['device-ota-message'].textContent, 'Signed Remote OTA');

  const failed = structuredClone(status);
  failed.state.state = 'rolled_back';
  view.otaStatus = failed;
  view._acceptOtaStatus(failed);
  assert.equal(nodes['device-ota-install'].textContent, 'Спробувати ще раз');
  assert.equal(nodes['device-ota-install'].disabled, false);
  assert.equal(nodes['device-firmware-state'].textContent, 'Відновлено попередню версію');
  assert.equal(nodes['device-firmware-state'].dataset.tone, 'warning');
});

test('Firmware card keeps manual update available when automatic updates are off', () => {
  const { view, nodes } = createViewHarness();
  view.capabilities = { firmwareOta: true, firmwareOtaPreference: true };
  const status = {
    automatic_updates_supported: true,
    automatic_updates: false,
    update_available: true,
    latest_release: { version: 'V18.4.39', build_id: 'cccccccccccc', changelog: '' },
    state: { version: 'V18.4.39', build_id: 'cccccccccccc', state: 'offered', error: null },
  };
  view.otaStatus = status;
  view._acceptOtaStatus(status);

  assert.equal(nodes['device-ota-automatic'].textContent, 'Вимкнено');
  assert.equal(nodes['device-ota-automatic-toggle'].checked, false);
  assert.equal(nodes['device-ota-automatic-toggle'].disabled, false);
  assert.equal(nodes['device-ota-install'].disabled, false);
  assert.match(nodes['device-ota-message'].textContent, /Оновити зараз/);
});

test('Firmware preference switch persists through ApiClient and refreshes confirmed state', async () => {
  const { view } = createViewHarness();
  view.capabilities = { firmwareOta: true, firmwareOtaPreference: true };
  view.otaStatus = { automatic_updates_supported: true, automatic_updates: true, update_available: false, latest_release: null, state: null };
  const previousApiClient = globalThis.ApiClient;
  const calls = [];
  globalThis.ApiClient = {
    async setOtaAutomaticUpdates(enabled) { calls.push(enabled); return { data: { automatic_updates: enabled } }; },
    async fetchOtaStatus() { return { automatic_updates_supported: true, automatic_updates: false, update_available: false, latest_release: null, state: null }; },
  };
  try {
    await view._setOtaAutomaticUpdates(false);
    assert.deepEqual(calls, [false]);
    assert.equal(view.otaStatus.automatic_updates, false);
  } finally {
    globalThis.ApiClient = previousApiClient;
  }
});

test('Cloud pending automatic-update preference keeps confirmed state visible', () => {
  const { view, nodes } = createViewHarness();
  view.capabilities = { firmwareOta: true, firmwareOtaPreference: true };
  const status = {
    automatic_updates_supported: true,
    automatic_updates: false,
    automatic_updates_pending: { generation: 7, automatic_updates: true },
    update_available: false, latest_release: null, state: null,
  };
  view._acceptOtaStatus(status);
  assert.equal(nodes['device-ota-automatic'].textContent, 'Вимкнено · запит на увімкнення');
  assert.equal(nodes['device-ota-automatic-toggle'].checked, true);
  assert.equal(nodes['device-ota-automatic-toggle'].disabled, false);
  assert.match(nodes['device-ota-message'].textContent, /очікує підтвердження пристроєм/);
  assert.match(nodes['device-ota-message'].textContent, /Увімкнено/);
});

test('Cloud unconfirmed preference is disabled instead of inventing ON or OFF', () => {
  const { view, nodes } = createViewHarness();
  view.capabilities = { firmwareOta: true, firmwareOtaPreference: true };
  view._acceptOtaStatus({
    automatic_updates_supported: false,
    automatic_updates: null,
    automatic_updates_pending: null,
    update_available: false, latest_release: null, state: null,
  });
  assert.equal(nodes['device-ota-automatic'].textContent, '—');
  assert.equal(nodes['device-ota-automatic-toggle'].disabled, true);
  assert.match(nodes['device-ota-message'].textContent, /підтвердить локальне налаштування/);
});

test('BMS card keeps canonical status data when live telemetry arrives', async () => {
  const { view, nodes } = createViewHarness();
  const previousApiClient = globalThis.ApiClient;
  globalThis.ApiClient = {
    async fetchDeviceStatus() {
      return {
        wifi: { internet_state: 'reachable' },
        bms: {
          configured: true,
          state: 'connected',
          name: 'Battery 315A',
          model: 'JK_PB2A16S20P',
          address_hint: '...36:89',
        },
        cloud: null,
      };
    },
  };

  try {
    await view._refreshDeviceStatus();
    assert.equal(nodes['device-bms-state'].textContent, 'Підключено');
    assert.equal(
      nodes['device-bms-address'].textContent,
      'Battery 315A · ...36:89',
    );
    assert.equal(nodes['device-bms-model'].textContent, 'JK_PB2A16S20P');
    assert.equal(nodes['device-bms-ble'].textContent, 'Підключено');

    view.onLive({
      bms_configured: true,
      bms_address_hint: '...36:89',
      model: 'JK_PB2A16S20P',
      ble_connected: true,
      ble_state: 'connected',
      cell_count: 8,
    });

    assert.equal(nodes['device-bms-state'].textContent, 'Підключено');
    assert.equal(
      nodes['device-bms-address'].textContent,
      'Battery 315A · ...36:89',
    );
    assert.equal(nodes['device-bms-model'].textContent, 'JK_PB2A16S20P');
    assert.equal(nodes['device-bms-ble'].textContent, 'Підключено');
    assert.equal(nodes['device-bms-cells'].textContent, '8');

    // Real local /api/device/status deliberately has no cell_count. A 5s
    // refresh must not overwrite the 2s live telemetry value with an em dash.
    await view._refreshDeviceStatus();
    assert.equal(nodes['device-bms-cells'].textContent, '8');
    await view._refreshDeviceStatus();
    assert.equal(nodes['device-bms-cells'].textContent, '8');

    // Only live telemetry should own this field, including real changes.
    view.onLive({ cell_count: 7 });
    assert.equal(nodes['device-bms-cells'].textContent, '7');
    await view._refreshDeviceStatus();
    assert.equal(nodes['device-bms-cells'].textContent, '7');
    view.onLive({ online: false });
    assert.equal(nodes['device-bms-cells'].textContent, '—');
  } finally {
    globalThis.ApiClient = previousApiClient;
  }
});

test('Remote Access card exposes real Cloud actions without technical identity', () => {
  assert.match(SOURCE, /id="device-cloud-connect"[^>]*>Підключити до акаунта</);
  assert.match(SOURCE, /id="device-cloud-disconnect"[^>]*hidden>Відключити Cloud</);
  assert.match(SOURCE, /id="device-cloud-transport"/);
  assert.match(SOURCE, /id="device-cloud-account"/);
  assert.equal(SOURCE.includes('Device ID'), false);
  assert.equal(SOURCE.includes('device_id'), false);
  assert.equal(SOURCE.includes('device_secret'), false);
  assert.match(
    CSS,
    /\.device-settings-action\[hidden\]\s*\{\s*display:\s*none\s*!important;/,
  );
});

test('pairing navigation only accepts exact WattPost HTTPS fragment URL', () => {
  const validToken = 'A'.repeat(43);
  const validUrl = 'https://wattpost.pp.ua/pair#token=' + validToken;
  assert.equal(safePairUrl(validUrl), validUrl);

  for (const value of [
    'http://wattpost.pp.ua/pair#token=' + validToken,
    'https://evil.example/pair#token=' + validToken,
    'https://wattpost.pp.ua/pair?token=' + validToken,
    'https://wattpost.pp.ua/other#token=' + validToken,
    'https://wattpost.pp.ua/pair#token=short',
    'https://wattpost.pp.ua/pair#token=' + '!'.repeat(43),
    'javascript:alert(1)',
    null,
  ]) {
    assert.equal(safePairUrl(value), null, String(value));
  }
});

test('Remote Access renders unpaired, paired and unavailable states predictably', () => {
  const { view, nodes } = createViewHarness();

  view.deviceStatus = {
    cloud: {
      transport_state: 'online',
      network_available: true,
      paired_known: true,
      paired: false,
      disconnect_pending: false,
      pairing: { state: 'none', pair_url: null },
      operation: { state: 'idle', error_code: null },
    },
  };
  view._renderCloudStatus(view.deviceStatus.cloud);
  assert.equal(nodes['device-remote-state'].textContent, 'Не підключено');
  assert.equal(nodes['device-cloud-connect'].hidden, false);
  assert.equal(nodes['device-cloud-connect'].disabled, false);
  assert.equal(nodes['device-cloud-disconnect'].hidden, true);

  view.deviceStatus.cloud.paired = true;
  view._renderCloudStatus(view.deviceStatus.cloud);
  assert.equal(nodes['device-remote-state'].textContent, 'Підключено');
  assert.equal(nodes['device-remote-state'].dataset.tone, 'success');
  assert.equal(nodes['device-cloud-connect'].hidden, true);
  assert.equal(nodes['device-cloud-disconnect'].hidden, false);

  view.deviceStatus.cloud = {
    transport_state: 'waiting_network',
    network_available: false,
    paired_known: false,
    paired: false,
    disconnect_pending: false,
    pairing: { state: 'none', pair_url: null },
    operation: { state: 'idle', error_code: null },
  };
  view._renderCloudStatus(view.deviceStatus.cloud);
  assert.equal(nodes['device-remote-state'].textContent, 'Cloud недоступний');
  assert.equal(nodes['device-cloud-connect'].disabled, false);
  assert.match(nodes['device-cloud-message'].textContent, /Локальний Dashboard/);

  view.deviceStatus.cloud.operation = { state: 'error', error_code: 'cloud_unavailable' };
  view._renderCloudStatus(view.deviceStatus.cloud);
  assert.equal(nodes['device-cloud-connect'].textContent, 'Спробувати ще раз');
});

test('one shared connect flow reuses pending pairing and opens only the safe URL', async () => {
  const { view } = createViewHarness();
  const previousApiClient = globalThis.ApiClient;
  const previousLocation = globalThis.location;
  const opened = [];
  let created = 0;
  globalThis.location = { assign: url => opened.push(url) };
  globalThis.ApiClient = {
    async startCloudPairing() {
      created += 1;
      throw new Error('must reuse the pending pairing');
    },
  };
  view.deviceStatus = {
    cloud: {
      transport_state: 'online',
      network_available: true,
      pairing: {
        state: 'pending',
        pair_url: 'https://wattpost.pp.ua/pair#token=' + 'A'.repeat(43),
      },
    },
  };

  try {
    await view.startCloudConnectFlow();
    assert.equal(created, 0);
    assert.deepEqual(opened, [view.deviceStatus.cloud.pairing.pair_url]);
  } finally {
    globalThis.ApiClient = previousApiClient;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
});

test('duplicate connect requests wait for initial status and start at most one pairing', async () => {
  const { view } = createViewHarness();
  const previousApiClient = globalThis.ApiClient;
  const previousLocation = globalThis.location;
  const opened = [];
  let startCount = 0;
  let releaseStatus;
  const initialStatus = new Promise(resolve => { releaseStatus = resolve; });
  globalThis.location = { assign: url => opened.push(url) };
  globalThis.ApiClient = {
    async startCloudPairing() {
      startCount += 1;
      return { operation: { generation: 7 } };
    },
    async waitForCloudOperation() {
      return {
        cloud: {
          transport_state: 'online',
          network_available: true,
          pairing: {
            state: 'pending',
            pair_url: 'https://wattpost.pp.ua/pair#token=' + 'B'.repeat(43),
          },
        },
      };
    },
  };
  view._initialStatusPromise = initialStatus.then(status => {
    view.deviceStatus = status;
    return status;
  });

  try {
    const first = view.startCloudConnectFlow();
    const second = view.startCloudConnectFlow();
    assert.equal(startCount, 0);
    releaseStatus({
      cloud: {
        transport_state: 'online',
        network_available: true,
        paired_known: true,
        paired: false,
        pairing: { state: 'none', pair_url: null },
        operation: { state: 'idle', error_code: null },
      },
    });
    await Promise.all([first, second]);
    assert.equal(startCount, 1);
    assert.deepEqual(opened, ['https://wattpost.pp.ua/pair#token=' + 'B'.repeat(43)]);
  } finally {
    globalThis.ApiClient = previousApiClient;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
});

test('disconnect pending tells the user it will finish after Internet returns', () => {
  const { view, nodes } = createViewHarness();
  view.deviceStatus = {
    cloud: {
      transport_state: 'waiting_network',
      network_available: false,
      paired_known: true,
      paired: true,
      disconnect_pending: true,
      pairing: { state: 'none', pair_url: null },
      operation: {
        state: 'running',
        kind: 'disconnect',
        error_code: null,
      },
    },
  };
  view._renderCloudStatus(view.deviceStatus.cloud);
  assert.equal(nodes['device-remote-state'].textContent, 'Відключення');
  assert.equal(nodes['device-cloud-disconnect'].hidden, false);
  assert.equal(nodes['device-cloud-disconnect'].disabled, true);
  assert.match(nodes['device-cloud-message'].textContent, /після появи інтернету/);
});

test('Cloud UI uses centralized ApiClient and never raw fetch', () => {
  assert.match(SOURCE, /ApiClient\.startCloudPairing/);
  assert.match(SOURCE, /ApiClient\.disconnectCloud/);
  assert.match(SOURCE, /ApiClient\.waitForCloudOperation/);
  assert.equal(/\bfetch\s*\(/.test(SOURCE), false);
  assert.equal(/<input[^>]+type="file"/i.test(SOURCE), false);
});

test('pending OTA state has a visible warning badge style', () => {
  assert.match(
    CSS,
    /\.device-settings-status\[data-tone="warning"\][\s\S]*?color: #d29922/,
  );
});

function availableOta(overrides = {}) {
  return { automatic_updates_supported: true, automatic_updates: true, automatic_updates_pending: null,
    update_available: true, latest_release: { release_id: 7, version: 'V18.4.44' }, state: null, ...overrides };
}

test('failed catalog check cannot prevent confirmed local OFF or be erased by live rerender', async () => {
  const { view, nodes } = createViewHarness();
  view.capabilities = { firmwareOta: true, firmwareOtaPreference: true };
  view._acceptOtaStatus(availableOta());
  const previous = globalThis.ApiClient;
  const writes = [];
  globalThis.ApiClient = {
    fetchOtaStatus: async () => { throw new Error('catalog unavailable'); },
    setOtaAutomaticUpdates: async enabled => { writes.push(enabled); return { data: { automatic_updates: enabled } }; },
  };
  try {
    await view._refreshOtaStatus();
    assert.equal(nodes['device-ota-install'].disabled, true);
    assert.equal(nodes['device-ota-automatic-toggle'].disabled, false);
    await view._setOtaAutomaticUpdates(false);
    view.onLive({ firmware_version: 'V18.4.43', ota_state: 'valid' });
    assert.deepEqual(writes, [false]);
    assert.equal(nodes['device-ota-automatic-toggle'].checked, false);
    assert.equal(nodes['device-ota-automatic'].textContent, 'Вимкнено');
    assert.equal(nodes['device-ota-install'].disabled, true);
    assert.match(nodes['device-ota-message'].textContent, /Не вдалося перевірити нову прошивку/);
    assert.notEqual(nodes['device-firmware-state'].textContent, 'Актуальна');
  } finally { globalThis.ApiClient = previous; }
});

test('unknown preferences offer explicit OFF without inventing their current state', async () => {
  const { view, nodes } = createViewHarness();
  view.capabilities = { firmwareOta: true, firmwareOtaPreference: true };
  const previous = globalThis.ApiClient;
  globalThis.ApiClient = {
    fetchOtaStatus: async () => { throw new Error('catalog unavailable'); },
    setOtaAutomaticUpdates: async enabled => { assert.equal(enabled, false); return { data: { automatic_updates: false } }; },
  };
  try {
    await view._refreshOtaStatus();
    assert.equal(nodes['device-ota-automatic'].textContent, '—');
    assert.equal(nodes['device-ota-disable-automatic'].hidden, false);
    assert.equal(nodes['device-ota-disable-automatic'].disabled, false);
    await view._setOtaAutomaticUpdates(false);
    assert.equal(nodes['device-ota-automatic'].textContent, 'Вимкнено');
    assert.equal(nodes['device-ota-install'].disabled, true);
  } finally { globalThis.ApiClient = previous; }
});

test('pending Cloud ON can be replaced by OFF and remains pending until device acknowledgement', async () => {
  const { view, nodes } = createViewHarness();
  view.capabilities = { firmwareOta: true, firmwareOtaPreference: true };
  view._acceptOtaStatus(availableOta({ automatic_updates: false, automatic_updates_pending: { generation: 1, automatic_updates: true } }));
  assert.equal(nodes['device-ota-automatic-toggle'].checked, true);
  const previous = globalThis.ApiClient;
  globalThis.ApiClient = {
    fetchOtaStatus: async () => { throw new Error('catalog unavailable'); },
    setOtaAutomaticUpdates: async enabled => { assert.equal(enabled, false); return {
      automatic_updates_supported: true, automatic_updates: false,
      automatic_updates_pending: { generation: 2, automatic_updates: false },
    }; },
  };
  try {
    await view._setOtaAutomaticUpdates(false);
    assert.equal(nodes['device-ota-automatic-toggle'].checked, false);
    assert.match(nodes['device-ota-automatic'].textContent, /запит на вимкнення/);
    assert.match(nodes['device-ota-message'].textContent, /очікує підтвердження/);
  } finally { globalThis.ApiClient = previous; }
});

test('preference write failure survives later live renders and does not claim OFF', async () => {
  const { view, nodes } = createViewHarness();
  view.capabilities = { firmwareOta: true, firmwareOtaPreference: true };
  view._acceptOtaStatus(availableOta());
  const previous = globalThis.ApiClient;
  globalThis.ApiClient = { setOtaAutomaticUpdates: async () => { throw new Error('storage error'); } };
  try {
    await view._setOtaAutomaticUpdates(false);
    view.onLive({ firmware_version: 'V18.4.43', ota_state: 'valid' });
    assert.match(nodes['device-ota-message'].textContent, /Не вдалося зберегти/);
    assert.equal(nodes['device-ota-automatic-toggle'].checked, true);
  } finally { globalThis.ApiClient = previous; }
});

test('active installation permits OFF and catalog-less or expired checks never enable installation', () => {
  const { view, nodes } = createViewHarness();
  view.capabilities = { firmwareOta: true, firmwareOtaPreference: true };
  view._acceptOtaStatus(availableOta({ state: { state: 'downloading' } }));
  assert.equal(nodes['device-ota-automatic-toggle'].disabled, false);
  assert.equal(nodes['device-ota-install'].disabled, true);
  view._acceptOtaStatus(availableOta({ update_available: false, latest_release: null }));
  assert.equal(nodes['device-firmware-state'].textContent, 'Нових оновлень немає');
  view._acceptOtaStatus(availableOta());
  view.otaCheckedAt -= 31000; view._renderOtaStatus(view.otaStatus);
  assert.equal(nodes['device-ota-install'].disabled, true);
});

test('OTA shows device-confirmed bytes and stages, not fabricated transfer percentages', () => {
  const { view, nodes } = createViewHarness();
  const base = {
    latest_release: { release_id: 12, version: 'V18.4.45' },
    automatic_updates: false,
    automatic_updates_supported: true,
  };
  view._acceptOtaStatus({ ...base, update_available: true,
    state: { release_id: 12, state: 'downloading', downloaded_bytes: 680000, total_bytes: 1530000, download_attempt: 1 },
  });
  assert.equal(nodes['device-ota-progress'].hidden, false);
  assert.equal(nodes['device-ota-progress-percent'].textContent, '44%');
  assert.equal(nodes['device-ota-progress-fill'].style.width, '44%');
  assert.match(nodes['device-ota-progress-detail'].textContent, /0\.68 з 1\.53 МБ/);

  view._acceptOtaStatus({ ...base, state: { state: 'downloading' } });
  assert.equal(nodes['device-ota-progress-percent'].textContent, '');
  assert.equal(nodes['device-ota-progress-track'].dataset.mode, 'waiting');

  view._acceptOtaStatus({ ...base, state: { state: 'downloading', downloaded_bytes: 0, total_bytes: 1530000, download_attempt: 2 } });
  assert.equal(nodes['device-ota-progress-percent'].textContent, '0%');
  assert.match(nodes['device-ota-progress-detail'].textContent, /спроба 2/);

  view._acceptOtaStatus({ ...base, state: { state: 'installing' } });
  assert.equal(nodes['device-ota-progress-percent'].textContent, '');
  assert.match(nodes['device-ota-progress-stage'].textContent, /Перезапуск/);

  view._acceptOtaStatus({ ...base, state: { state: 'success' } });
  assert.equal(nodes['device-ota-progress-fill'].style.width, '100%');
  assert.match(nodes['device-ota-progress-stage'].textContent, /завершено/);
});

test('OTA request visibly waits for device and a failed refresh preserves last-known stage', () => {
  const { view, nodes } = createViewHarness();
  view.otaBusy = true;
  view.otaRequestAccepted = true;
  view._renderOtaStatus(null);
  assert.equal(nodes['device-ota-progress'].hidden, false);
  assert.match(nodes['device-ota-progress-stage'].textContent, /Очікуємо/);

  view.otaBusy = false;
  view._acceptOtaStatus({ state: { state: 'downloading', downloaded_bytes: 400, total_bytes: 1000, download_attempt: 1 } });
  view.otaCheckFailed = true;
  view._renderOtaStatus(view.otaStatus);
  assert.equal(nodes['device-ota-progress-percent'].textContent, '40%');
  assert.match(nodes['device-ota-progress-detail'].textContent, /останнє підтвердження/);
});

test('accepted manual OTA remains visibly queued after refreshing the Settings page', () => {
  const { view, nodes } = createViewHarness();
  view.otaBusy = false;
  view._acceptOtaStatus({ state: { state: 'offered', trigger: 'manual' } });
  assert.equal(nodes['device-ota-progress'].hidden, false);
  assert.match(nodes['device-ota-progress-stage'].textContent, /Очікуємо/);
  assert.equal(nodes['device-ota-progress-percent'].textContent, '');
  view._acceptOtaStatus({ state: { state: 'verifying' } });
  assert.match(nodes['device-ota-progress-stage'].textContent, /Перевірка/);
});


test('successful OTA result stays visible until dismissed, including after navigation and reload', () => {
  const originalStorage = globalThis.localStorage;
  const originalLocation = globalThis.location;
  const items = new Map();
  globalThis.localStorage = {
    getItem(key) { return items.get(key) ?? null; },
    setItem(key, value) { items.set(key, value); },
    removeItem(key) { items.delete(key); },
  };
  globalThis.location = { pathname: '/device/aaa-device' };
  try {
    const status = {
      automatic_updates: false,
      automatic_updates_supported: true,
      latest_release: { release_id: 10, version: 'V18.4.45' },
      state: { state: 'success', release_id: 10, attempt_count: 1,
        updated_at: '2026-10-13T21:50:00Z' },
    };
    const { view, nodes } = createViewHarness();
    view._acceptOtaStatus(status);
    assert.equal(nodes['device-ota-progress'].hidden, false);
    assert.equal(nodes['device-ota-progress-dismiss'].hidden, false);
    view._dismissOtaResult();
    assert.equal(nodes['device-ota-progress'].hidden, true);
    assert.equal(nodes['device-ota-progress-dismiss'].hidden, true);
    assert.match(nodes['device-ota-message'].textContent, /Автоматичні оновлення вимкнено/);
    view._acceptOtaStatus(status); // Background polling must not re-open it.
    assert.equal(nodes['device-ota-progress'].hidden, true);

    const reopened = createViewHarness();
    reopened.view._acceptOtaStatus(status); // A new view / page load.
    assert.equal(reopened.nodes['device-ota-progress'].hidden, true);
    assert.equal(reopened.nodes['device-firmware-state'].textContent, 'Оновлено');

    globalThis.location = { pathname: '/device/another-device' };
    const otherDevice = createViewHarness();
    otherDevice.view._acceptOtaStatus(status);
    assert.equal(otherDevice.nodes['device-ota-progress'].hidden, false);
  } finally {
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

test('only terminal OTA results can be dismissed, and a new attempt shows again', () => {
  const originalStorage = globalThis.localStorage;
  const originalLocation = globalThis.location;
  const items = new Map();
  globalThis.localStorage = {
    getItem(key) { return items.get(key) ?? null; },
    setItem(key, value) { items.set(key, value); },
    removeItem(key) { items.delete(key); },
  };
  globalThis.location = { pathname: '/device/demo' };
  try {
    const { view, nodes } = createViewHarness();
    const base = { latest_release: { version: 'V18.4.46', release_id: 11 } };
    view._acceptOtaStatus({ ...base, state: {
      state: 'downloading', release_id: 11, downloaded_bytes: 32, total_bytes: 100,
    } });
    assert.equal(nodes['device-ota-progress'].hidden, false);
    assert.equal(nodes['device-ota-progress-dismiss'].hidden, true);
    view._dismissOtaResult(); // No-op during active transfer.
    assert.equal(nodes['device-ota-progress'].hidden, false);
    view._acceptOtaStatus({ ...base, state: {
      state: 'failed', release_id: 11, attempt_count: 1, updated_at: 't1',
    } });
    assert.equal(nodes['device-ota-progress-dismiss'].hidden, false);
    view._dismissOtaResult();
    assert.equal(nodes['device-ota-progress'].hidden, true);
    view._acceptOtaStatus({ ...base, state: {
      state: 'offered', trigger: 'manual', release_id: 11, attempt_count: 2,
    } });
    assert.equal(nodes['device-ota-progress'].hidden, false); // New attempt.
    assert.equal(nodes['device-ota-progress-dismiss'].hidden, true);
    view._acceptOtaStatus({ ...base, state: {
      state: 'failed', release_id: 11, attempt_count: 2, updated_at: 't2',
    } });
    assert.equal(nodes['device-ota-progress'].hidden, false);
    view._dismissOtaResult();
    assert.equal(nodes['device-ota-progress'].hidden, true);
    view._acceptOtaStatus({ ...base, state: {
      state: 'rolled_back', release_id: 11, attempt_count: 3, updated_at: 't3',
    } });
    assert.equal(nodes['device-ota-progress'].hidden, false);
    assert.equal(nodes['device-ota-progress-dismiss'].hidden, false);
  } finally {
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

test('dismiss button does not break OTA status if browser storage is blocked', () => {
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  try {
    const { view, nodes } = createViewHarness();
    view._acceptOtaStatus({ state: { state: 'success', release_id: 2 } });
    assert.equal(nodes['device-ota-progress'].hidden, false);
    assert.doesNotThrow(() => view._dismissOtaResult());
    assert.equal(nodes['device-ota-progress'].hidden, true);
  } finally {
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
  }
});
