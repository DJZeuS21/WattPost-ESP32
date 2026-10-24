import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

for (const mode of ['first_setup', 'recovery']) {
  test(`${mode}: successful Wi-Fi with missing BMS uses the correct handoff`, async () => {
    const status = { mode, setup_state: 'bms_required' };
    const window = { WattPostSetupApi: {
      configureWifi: async () => ({ operation: { generation: 1 } }),
      getStatus: async () => status,
    } };
    vm.runInNewContext(fs.readFileSync(new URL('../js/setup.js', import.meta.url), 'utf8'), { window });
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
      assert.match(handoff, /домашнього Wi-Fi/);
      assert.match(handoff, /Якщо BMS ще не вибрано/);
    } else {
      assert.equal(steps.at(-1), 'bms');
      assert.equal(handoff, undefined);
    }
    assert.equal(app.busy, false);
  });
}
