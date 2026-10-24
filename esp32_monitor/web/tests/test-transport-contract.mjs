import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'js', 'transports', 'local-transport.js'),
  'utf8',
);
const API = fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const UI_MODULES = ['dashboard.js', 'history.js', 'settings.js', 'device-settings.js']
  .map(name => fs.readFileSync(path.join(ROOT, 'js', name), 'utf8'));

const CONTRACT_METHODS = [
  'getRuntimeContext',
  'getCapabilities',
  'fetchLive',
  'fetchHistoryPage',
  'fetchHistoryContext',
  'fetchSettings',
  'fetchDeviceStatus',
  'startWifiScan',
  'fetchWifiScan',
  'configureWifi',
  'reconnectWifi',
  'resetWifi',
  'startBmsScan',
  'fetchBmsScan',
  'selectBms',
  'reconnectBms',
  'forgetBms',
  'startCloudPairing',
  'disconnectCloud',
  'fetchOtaStatus',
  'setOtaAutomaticUpdates',
  'installOtaUpdate',
  'rebootDevice',
  'factoryResetDevice',
];

function loadTransport() {
  const context = { fetch: async () => ({ ok: true, json: async () => ({}) }) };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'local-transport.js' });
  return context;
}

test('LocalTransport implements the complete explicit public contract', () => {
  const context = loadTransport();
  const instance = new context.LocalTransport();
  const publicMethods = Object.getOwnPropertyNames(context.LocalTransport.prototype)
    .filter(name => name !== 'constructor')
    .sort();

  assert.deepEqual(publicMethods, [...CONTRACT_METHODS].sort());
  assert.deepEqual(JSON.parse(JSON.stringify(instance.getRuntimeContext())), {
    mode: 'local',
    cloudId: null,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(instance.getCapabilities())), {
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
  assert.equal('request' in instance, false);
  assert.equal('mutate' in instance, false);
  assert.equal('_mutate' in instance, false);
});

test('canonical HTML loads the runtime transport before the shared ApiClient', () => {
  const transportTag = '<script src="js/transport.js?v=__WATTPOST_WEB_VERSION__"></script>';
  const apiTag = '<script src="js/api.js?v=__WATTPOST_WEB_VERSION__"></script>';
  assert.ok(INDEX.includes(transportTag));
  assert.ok(INDEX.indexOf(transportTag) < INDEX.indexOf(apiTag));
});

test('ApiClient exposes LocalTransport capabilities and context', () => {
  const context = loadTransport();
  vm.runInContext(API, context, { filename: 'api.js' });
  const client = new context.ApiClientClass({ historyCache: null });

  assert.deepEqual(
    JSON.parse(JSON.stringify(client.getCapabilities())),
    JSON.parse(JSON.stringify(context.WattPostTransport.getCapabilities())),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(client.runtimeContext)), {
    mode: 'local',
    cloudId: null,
  });
});

test('shared coordinator and views contain no raw local API fetches', () => {
  assert.doesNotMatch(API, /\bfetch\s*\(/);
  assert.doesNotMatch(API, /['"]\/api\//);
  for (const source of UI_MODULES) assert.doesNotMatch(source, /\bfetch\s*\(/);
});

test('LocalTransport selects local mode without hostname detection', () => {
  assert.doesNotMatch(SOURCE, /location\.hostname|window\.location/);
});
