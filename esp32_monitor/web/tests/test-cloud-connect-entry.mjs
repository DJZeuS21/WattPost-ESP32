import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const DEVICE_SOURCE = fs.readFileSync(
  path.join(ROOT, 'js', 'device-settings.js'),
  'utf8',
);

function actionHarness(href) {
  let current = new URL(href);
  const replacements = [];
  const location = {};
  for (const key of ['href', 'pathname', 'search', 'hash']) {
    Object.defineProperty(location, key, {
      get: () => current[key],
      set: key === 'href' ? value => { current = new URL(value, current); } : undefined,
    });
  }
  const window = {
    location,
    history: {
      state: { route: 'local' },
      replaceState(state, _title, target) {
        replacements.push(target);
        this.state = state;
        current = new URL(target, current);
      },
    },
  };
  const instrumentedSource = APP_SOURCE.replace(
    /\}\)\(window\);\s*$/,
    'window.consumeCloudConnectActionForTest = consumeCloudConnectAction;\n})(window);',
  );
  const context = { window, URL, URLSearchParams };
  vm.runInNewContext(
    instrumentedSource,
    context,
    { filename: 'app.js' },
  );
  return { window, location, replacements };
}

test('only the exact cloud-connect action is consumed and removed from the URL', () => {
  const { window, location, replacements } = actionHarness(
    'http://bms.local/?keep=1&action=cloud-connect#dashboard',
  );
  assert.equal(window.consumeCloudConnectActionForTest(), true);
  assert.equal(location.search, '?keep=1');
  assert.equal(location.hash, '#dashboard');
  assert.equal(replacements.length, 1);
  assert.equal(window.consumeCloudConnectActionForTest(), false);
  assert.equal(replacements.length, 1);
});

test('unknown, similar and repeated action values are ignored', () => {
  for (const href of [
    'http://bms.local/?action=other',
    'http://bms.local/?action=cloud-connect-extra',
    'http://bms.local/?Action=cloud-connect',
    'http://bms.local/?action=other&action=cloud-connect',
    'http://bms.local/?action=cloud-connect&action=cloud-connect',
  ]) {
    const { window, location, replacements } = actionHarness(href);
    assert.equal(window.consumeCloudConnectActionForTest(), false, href);
    assert.equal(location.search, new URL(href).search, href);
    assert.equal(replacements.length, 0, href);
  }
});

test('entry URL is cleaned before app initialization and uses the shared Device Settings flow', () => {
  const consume = APP_SOURCE.indexOf('const shouldStartCloudConnect = consumeCloudConnectAction();');
  const initialize = APP_SOURCE.indexOf('app.init();', consume);
  const start = APP_SOURCE.indexOf('app.startCloudConnectFlow();', initialize);
  assert.ok(consume >= 0 && initialize > consume && start > initialize);
  assert.match(APP_SOURCE, /startCloudConnectFlow\(\)\s*\{\s*this\._setTab\('settings', true\);[\s\S]*?this\.deviceSettings\.startCloudConnectFlow\(\)/);
  assert.match(DEVICE_SOURCE, /#device-cloud-connect[\s\S]*?this\.startCloudConnectFlow\(\)/);
  assert.match(DEVICE_SOURCE, /async startCloudConnectFlow\(\)/);
  assert.match(DEVICE_SOURCE, /_initialStatusPromise/);
  assert.equal(/\bfetch\s*\(/.test(DEVICE_SOURCE), false);
});
