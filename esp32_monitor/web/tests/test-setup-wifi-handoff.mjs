import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

for (const mode of ['first_setup', 'recovery']) for (const language of ['uk', 'en']) {
  test(`${mode}/${language}: successful Wi-Fi with missing BMS uses the correct handoff`, async () => {
    const status = { mode, setup_state: 'bms_required' };
    const window = { WattPostSetupApi: {
      configureWifi: async () => ({ operation: { generation: 1 } }),
      getStatus: async () => status,
    } };
    // First Setup depends on the real offline locale runtime/catalogs.
    window.navigator = { language: language + '-' + (language === 'en' ? 'US' : 'UA'), languages: [language + '-' + (language === 'en' ? 'US' : 'UA')] };
    window.location = { search: '' };
    window.localStorage = { getItem: () => null, setItem: () => {} };
    const context = vm.createContext({ window, URLSearchParams });
    for (const file of ['i18n.js', 'i18n-uk.js', 'i18n-en.js', 'setup.js']) {
      vm.runInContext(fs.readFileSync(new URL('../js/' + file, import.meta.url), 'utf8'), context);
      if (file === 'i18n.js') context.WattPostI18n = window.WattPostI18n;
    }
    const app = new window.WattPostSetupApp();
    const nodes = new Map();
    app.$ = id => {
      if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, classList: { add() {}, remove() {} } });
      return nodes.get(id);
    };
    const steps = []; let handoff;
    app.recoveryMode = mode === 'recovery';
    app.selectedWifi = { candidate_id: 1, auth: 'open' }; app.wifiScan = { scan_generation: 1 };
    app.setBusy = value => { app.busy = value; };
    app.clearError = () => {}; app.setPasswordVisible = () => {};
    app.waitForOperation = async () => {}; app.applyStatus = () => {};
    app.showStep = step => steps.push(step);
    app.showRecovery = (_status, message) => { handoff = message; };
    await app.configureWifi();
    if (mode === 'recovery') {
      assert.ok(!steps.includes('bms'), 'Recovery AP may close; do not send the user into a BMS wizard there');
      if (language === 'en') {
        assert.match(handoff, /home Wi-Fi/);
        assert.match(handoff, /If BMS has not been selected yet/);
        assert.doesNotMatch(handoff, /[А-Яа-яІіЇїЄєҐґ]/);
      } else {
        assert.match(handoff, /домашнього Wi-Fi/);
        assert.match(handoff, /Якщо BMS ще не вибрано/);
      }
    } else {
      assert.equal(steps.at(-1), 'bms');
      assert.equal(handoff, undefined);
    }
    assert.equal(app.busy, false);
  });
}
