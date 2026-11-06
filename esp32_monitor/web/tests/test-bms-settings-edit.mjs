import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = filename => readFileSync(new URL('../js/' + filename, import.meta.url), 'utf8');
const original = () => ({
  valid: true, received_count: 3,
  device: {
    model: 'JK_PB2A16S20P', device_sn: 'demo-sn',
    hardware_version: '15.0', software_version: '15.29'
  },
  battery: { cell_count: 16, nominal_capacity_ah: 100 },
  cell_voltage: { ovp_v: 3.650, uvp_v: 2.5, start_balance_v: 3.4 },
  balancing: { enabled: true, start_voltage_v: 3.4, trigger_delta_v: 0.012 },
  current_limits: { max_charge_a: 100, max_discharge_a: 100 },
  temperature: { charge_utp_c: -10, discharge_utp_c: -15, heating_start_c: -5 },
  switches: { charge: true, discharge: true, balancer: true },
  sleep: { smart_sleep_time_hours: 12 }
});

const writable = [
  'cell_voltage.ovp_v', 'cell_voltage.uvp_v',
  'switches.charge', 'temperature.charge_utp_c',
  'temperature.discharge_utp_c', 'temperature.heating_start_c',
  'battery.cell_count', 'current_limits.max_charge_a',
  'current_limits.max_discharge_a',
  'balancing.enabled', 'switches.balancer',
  'balancing.start_voltage_v', 'cell_voltage.start_balance_v',
  'balancing.trigger_delta_v'
];

function harness(api = null) {
  const browser = {
    WattPostI18n: { language: 'en', t: (key, vars) => vars?.count == null ? key : key + ':' + vars.count,
      tLocale: (_lang, key) => key }
  };
  if (api) browser.ApiClient = api;
  vm.runInNewContext(read('settings-schema.js'), { window: browser });
  vm.runInNewContext(read('settings.js'), { window: browser });
  const classList = () => {
    const names = new Set();
    return {
      toggle(name, enabled) {
        if (enabled) names.add(name);
        else names.delete(name);
      },
      contains: name => names.has(name)
    };
  };
  const controls = { innerHTML: '', classList: classList() };
  const grid = { innerHTML: '' };
  const count = { textContent: '' };
  const container = {
    classList: classList(),
    querySelector(selector) {
      if (selector === '#settings-editor-controls') return controls;
      if (selector === '#settings-grid') return grid;
      if (selector === '#settings-search-count') return count;
      return null;
    },
    querySelectorAll() { return []; }
  };
  const view = new browser.SettingsView();
  view.container = container;
  view.currentData = original();
  view.currentState = 'FRESH';
  return { browser, controls, grid, view };
}

function localApi({ resultStates = [], fresh = null, available = true } = {}) {
  let generation = 10;
  const submitted = [];
  return {
    runtimeContext: { mode: 'local' },
    getCapabilities: () => ({ bmsSettingsWrite: true }),
    fetchBmsWritePolicy: async () => ({
      local_write_available: available, model_supported: true,
      connection_epoch: 17, writable_keys: writable
    }),
    fetchSettings: async () => fresh ?? original(),
    refreshBmsSettingsRead: async () => ({ connection_epoch: 17, received_count: 3 }),
    startBmsSettingWrite: async change => {
      submitted.push(change);
      return { operation: { generation: ++generation } };
    },
    waitForBmsSettingWrite: async gen => ({
      generation: gen,
      state: resultStates[submitted.length - 1] ?? 'verified'
    }),
    submitted
  };
}

test('write draft keeps source data unchanged and stages only edited fields', () => {
  const { browser } = harness();
  const snap = original();
  const draft = new browser.BmsSettingsDraft(snap, browser.SETTINGS_SCHEMA, writable);
  assert.equal(draft.original.size, writable.length - 2); // 2 API aliases excluded
  assert.equal(draft.allowed.has('balancing.enabled'), false);
  assert.equal(draft.allowed.has('balancing.start_voltage_v'), false);
  assert.equal(draft.set('cell_voltage.ovp_v', '3.651'), 1);
  assert.equal(draft.set('switches.charge', false), 2);
  assert.equal(draft.set('temperature.charge_utp_c', '-12.3'), 3);
  assert.equal(snap.cell_voltage.ovp_v, 3.650);
  assert.equal(snap.switches.charge, true);
  assert.equal(draft.changes()[0].before, 3.650);
  assert.equal(draft.changes()[0].after, 3.651);
  assert.equal(draft.set('cell_voltage.ovp_v', '3.650'), 2);
  assert.equal(draft.changes().length, 2);
});

test('draft rejects unsupported values, precision loss, boolean coercion and overflow', () => {
  const { browser } = harness();
  const draft = new browser.BmsSettingsDraft(original(), browser.SETTINGS_SCHEMA, writable);
  for (const [key, value] of [
    ['battery.device_address', 1], ['cell_voltage.ovp_v', 3.6501],
    ['cell_voltage.ovp_v', ''], ['cell_voltage.ovp_v', 'not-a-number'],
    ['switches.charge', 'false'], ['temperature.discharge_utp_c', -129],
    ['temperature.heating_start_c', -5.5], ['battery.cell_count', 1.5],
    ['battery.cell_count', -1], ['battery.cell_count', 33],
    ['current_limits.max_charge_a', 4294968]
  ]) {
    assert.throws(() => draft.set(key, value), /bms_write_/);
  }
  assert.equal(draft.changes().length, 0);
  assert.equal(draft.set('temperature.discharge_utp_c', -18), 1);
});

test('draft detects changed BMS and stale original values', () => {
  const { browser } = harness();
  const draft = new browser.BmsSettingsDraft(original(), browser.SETTINGS_SCHEMA, writable);
  draft.set('cell_voltage.ovp_v', 3.7);
  assert.equal(draft.stillCurrent(original()), true);
  const another = original(); another.device.device_sn = 'other-bms';
  assert.equal(draft.stillCurrent(another), false);
  const changed = original(); changed.cell_voltage.ovp_v = 3.6;
  assert.equal(draft.stillCurrent(changed), false);
  assert.equal(draft.stillCurrent({ ...original(), valid: false }), false);
});

test('Cloud and local firmware with write capability disabled never expose editor controls', async () => {
  for (const mode of ['cloud', 'local']) {
    const api = localApi();
    api.runtimeContext.mode = mode;
    if (mode === 'local') api.getCapabilities = () => ({ bmsSettingsWrite: false });
    const { view, controls } = harness(api);
    view._renderEditorControls();
    assert.equal(controls.innerHTML, '');
    await view._enterEditor();
    assert.equal(view._draft, null);
    assert.equal(api.submitted.length, 0);
  }
});

test('BLE readiness policy blocks editing without contacting write operation', async () => {
  const api = localApi({ available: false });
  const { view, controls } = harness(api);
  await view._enterEditor();
  assert.equal(view._editPhase, 'view');
  assert.match(controls.innerHTML, /bms.edit.not_ready/);
  assert.equal(api.submitted.length, 0);
});

test('local LAN flow reviews exact changed values, writes in order and stops on mismatch', async () => {
  const api = localApi({ resultStates: ['verified', 'mismatch', 'verified'] });
  const { view, controls, grid } = harness(api);
  await view._enterEditor();
  assert.equal(view._editPhase, 'editing');
  assert.equal(controls.classList.contains('is-bms-edit-active'), true);
  assert.equal(view.container.classList.contains('is-bms-edit-active'), true);
  assert.match(controls.innerHTML, /bms-edit-button--quiet" data-bms-edit-action="cancel"/);
  assert.match(controls.innerHTML, /bms-edit-button--primary" data-bms-edit-action="review"/);
  assert.match(grid.innerHTML, /data-bms-edit-key="cell_voltage.ovp_v"/);
  assert.doesNotMatch(grid.innerHTML, /data-bms-edit-key="balancing.enabled"/);
  view._draft.set('cell_voltage.ovp_v', '3.660');
  view._draft.set('cell_voltage.uvp_v', '2.6');
  view._draft.set('switches.charge', false);
  view._reviewEditor();
  assert.equal(view._editPhase, 'review');
  assert.match(controls.innerHTML, /3.65 → 3.66 V/);
  assert.match(controls.innerHTML, /bms.edit.warning/);
  assert.match(controls.innerHTML, /bms-edit-button--commit" data-bms-edit-action="apply"/);
  assert.match(controls.innerHTML, /bms-edit-button--secondary" data-bms-edit-action="back"/);
  assert.equal(api.submitted.length, 0);
  await view._applyEditor();
  assert.equal(view._editPhase, 'result');
  assert.equal(api.submitted.length, 2);
  assert.equal(api.submitted[0].key, 'cell_voltage.ovp_v');
  assert.equal(api.submitted[0].expected_before, 3.65);
  assert.equal(api.submitted[0].connection_epoch, 17);
  assert.equal(api.submitted[1].key, 'cell_voltage.uvp_v');
  assert.match(controls.innerHTML, /bms.edit.state.skipped/);
  assert.match(controls.innerHTML, /bms.edit.partial/);
  assert.match(controls.innerHTML, /3.65 → 3.66 V/);
  assert.match(controls.innerHTML, /bms.edit.state.mismatch/);
  // Subsequent data refresh must retain results until user dismisses.
  view.currentData.cell_voltage.ovp_v = 3.66;
  view.onData(view.currentData, 'FRESH');
  assert.equal(view._editPhase, 'result');
});

test('live refresh preserves focused draft inputs until a stale snapshot invalidates editing', async () => {
  const api = localApi();
  const { view, grid } = harness(api);
  await view._enterEditor();
  assert.equal(view._editPhase, 'editing');
  grid.innerHTML = 'focused-input-sentinel';
  view.onData(original(), 'FRESH');
  assert.equal(grid.innerHTML, 'focused-input-sentinel');
  assert.equal(view._editPhase, 'editing');
  const newSnapshot = original(); newSnapshot.cell_voltage.ovp_v = 3.6;
  view._draft.set('cell_voltage.ovp_v', 3.7);
  view.onData(newSnapshot, 'FRESH');
  assert.equal(view._editPhase, 'view');
  assert.equal(view._draft, null);
  assert.notEqual(grid.innerHTML, 'focused-input-sentinel');
});

test('if fresh preflight differs from original, no BMS commands are sent', async () => {
  const fresh = original(); fresh.cell_voltage.ovp_v = 3.61;
  const api = localApi({ fresh });
  const { view, controls } = harness(api);
  await view._enterEditor();
  view._draft.set('cell_voltage.ovp_v', 3.68);
  view._reviewEditor();
  await view._applyEditor();
  assert.equal(api.submitted.length, 0);
  assert.equal(view._editPhase, 'review');
  assert.match(controls.innerHTML, /bms.edit.snapshot_changed/);
});

test('a write transport error is not retried and later changes are never submitted', async () => {
  const api = localApi();
  api.waitForBmsSettingWrite = async () => { throw new Error('link_lost'); };
  const { view } = harness(api);
  await view._enterEditor();
  view._draft.set('cell_voltage.ovp_v', 3.7);
  view._draft.set('cell_voltage.uvp_v', 2.6);
  view._reviewEditor();
  await view._applyEditor();
  assert.equal(api.submitted.length, 1);
  assert.equal(view._editResults[0].state, 'uncertain');
});

test('numeric input stages immediately without blur, including invalid-to-valid edits', async () => {
  const api = localApi();
  const { view, controls } = harness(api);
  await view._enterEditor();
  const listeners = new Map();
  view.container.addEventListener = (name, listener) => listeners.set(name, listener);
  view.container.contains = () => true;
  view._bindEvents();
  let popupCount = 0;
  const input = {
    type: 'number', value: '90', dataset: { bmsEditKey: 'current_limits.max_charge_a' },
    closest: () => input, setCustomValidity() {},
    reportValidity() { popupCount++; }
  };
  view.currentData.current_limits.max_charge_a = 85;
  // Re-enter to capture the newly received 85 A value as the source snapshot.
  view._closeEditor();
  await view._enterEditor();
  listeners.get('input')({ target: input });
  assert.equal(view._draft.pending.get('current_limits.max_charge_a'), 90);
  assert.match(controls.innerHTML, /bms.edit.changed_count:1/);
  assert.doesNotMatch(controls.innerHTML, /data-bms-edit-action="review" disabled/);
  assert.equal(popupCount, 0);
  view._reviewEditor();
  assert.equal(view._editPhase, 'review');
  assert.match(controls.innerHTML, /85 → 90 A/);

  view._editPhase = 'editing';
  input.value = '';
  listeners.get('input')({ target: input });
  assert.equal(view._invalidKeys.has('current_limits.max_charge_a'), true);
  assert.equal(popupCount, 0);
  assert.match(controls.innerHTML, /data-bms-edit-action="review" disabled/);
  input.value = '90';
  listeners.get('input')({ target: input });
  assert.equal(view._invalidKeys.size, 0);
  assert.equal(popupCount, 0);
  assert.doesNotMatch(controls.innerHTML, /data-bms-edit-action="review" disabled/);
});

test('single parameter write results distinguish unknown, not sent, mismatch and verified', async () => {
  for (const [state, expected] of [
    ['uncertain', 'bms.edit.result_uncertain'],
    ['not_sent', 'bms.edit.result_not_sent'],
    ['mismatch', 'bms.edit.result_mismatch'],
    ['verified', 'bms.edit.verified']
  ]) {
    const api = localApi({ resultStates: [state] });
    const { view, controls } = harness(api);
    view.currentData.current_limits.max_charge_a = 85;
    api.fetchSettings = async () => view.currentData;
    await view._enterEditor();
    view._draft.set('current_limits.max_charge_a', 90);
    view._reviewEditor();
    assert.match(controls.innerHTML, /85 → 90 A/);
    await view._applyEditor();
    assert.equal(api.submitted.length, 1);
    assert.equal(view._editStatusKey, expected);
    assert.match(controls.innerHTML, /85 → 90 A/);
    assert.match(controls.innerHTML, new RegExp(expected));
    assert.match(controls.innerHTML, new RegExp('bms.edit.state.' + state));
    view._closeEditor();
    assert.equal(controls.classList.contains('is-bms-edit-active'), false);
    assert.equal(view.container.classList.contains('is-bms-edit-active'), false);
  }
});

test('confirmed HTTP refusal is displayed as not sent without automatic retries', async () => {
  const api = localApi();
  api.startBmsSettingWrite = async () => {
    const error = new Error('stale_setting');
    error.status = 412;
    throw error;
  };
  const { view, controls } = harness(api);
  await view._enterEditor();
  view._draft.set('cell_voltage.ovp_v', 3.7);
  view._reviewEditor();
  await view._applyEditor();
  assert.equal(view._editResults[0].state, 'not_sent');
  assert.equal(view._editStatusKey, 'bms.edit.result_not_sent');
  assert.match(controls.innerHTML, /bms.edit.state.not_sent/);
});

test('after uncertain multi-edit, fresh BMS read excludes already applied values and asks for confirmation', async () => {
  const api = localApi({ resultStates: ['verified', 'uncertain', 'verified'] });
  const { view, controls } = harness(api);
  await view._enterEditor();
  view._draft.set('cell_voltage.ovp_v', 3.66);
  view._draft.set('cell_voltage.uvp_v', 2.6);
  view._reviewEditor();
  await view._applyEditor();
  assert.equal(view._editPhase, 'result');
  assert.equal(api.submitted.length, 2);
  assert.match(controls.innerHTML, /data-bms-edit-action="recheck"/);
  const fresh = original();
  fresh.cell_voltage.ovp_v = 3.66;
  api.fetchSettings = async () => fresh;
  await view._recheckEditor();
  assert.equal(view._editPhase, 'review');
  assert.equal(view._editStatusKey, 'bms.edit.recheck_ready');
  assert.equal(JSON.stringify(view._draft.changes().map(change => change.key)), JSON.stringify(['cell_voltage.uvp_v']));
  assert.equal(api.submitted.length, 2, 'fresh read must not write');
  assert.match(controls.innerHTML, /2.5 → 2.6 V/);
  assert.doesNotMatch(controls.innerHTML, /3.65 → 3.66 V/);
  await view._applyEditor();
  assert.equal(api.submitted.length, 3);
  assert.equal(api.submitted[2].key, 'cell_voltage.uvp_v');
  assert.equal(api.submitted[2].expected_before, 2.5);
  assert.equal(view._editStatusKey, 'bms.edit.verified');
});

test('batch continues after each uncertain write when a new BMS frame confirms it', async () => {
  const api = localApi();
  const values = original();
  let probes = 0;
  api.fetchSettings = async () => values;
  api.waitForBmsSettingWrite = async gen => ({ generation: gen,
    state: api.submitted.length <= 2 ? 'uncertain' : 'verified',
    reason: api.submitted.length <= 2 ? 'readback_timeout' : 'none' });
  api.refreshBmsSettingsRead = async () => {
    probes++;
    const latest = api.submitted.at(-1);
    const [section, key] = latest.key.split('.');
    values[section][key] = latest.value;
    values.received_count++;
    return { connection_epoch: 17, received_count: values.received_count };
  };
  const { view, controls } = harness(api);
  await view._enterEditor();
  view._draft.set('cell_voltage.ovp_v', 3.66);
  view._draft.set('current_limits.max_charge_a', 95);
  view._draft.set('current_limits.max_discharge_a', 105);
  view._reviewEditor();
  await view._applyEditor();
  assert.equal(view._editPhase, 'result');
  assert.equal(view._editStatusKey, 'bms.edit.verified');
  assert.equal(probes, 2);
  assert.equal(api.submitted.length, 3);
  assert.equal(new Set(api.submitted.map(change => change.key)).size, 3,
    'each approved change must be written once only');
  assert.equal(JSON.stringify(view._editResults.map(x => x.state)),
    JSON.stringify(['verified', 'verified', 'verified']));
  assert.match(controls.innerHTML, /bms.edit.reason.fresh_read/);
  assert.doesNotMatch(controls.innerHTML, /bms.edit.state.skipped/);
});

test('second explicit 0x96 read resolves an uncertain batch write and continues without resend', async () => {
  const api = localApi({ resultStates: ['uncertain', 'verified'] });
  const values = original();
  let probes = 0;
  api.fetchSettings = async () => values;
  api.refreshBmsSettingsRead = async () => {
    probes++;
    if (probes === 1) {
      const error = new Error('refresh_read_timeout');
      error.code = 'refresh_read_timeout';
      throw error;
    }
    values.cell_voltage.ovp_v = 3.66;
    values.received_count++;
    return { connection_epoch: 17, received_count: values.received_count };
  };
  const { view, controls } = harness(api);
  await view._enterEditor();
  view._draft.set('cell_voltage.ovp_v', 3.66);
  view._draft.set('current_limits.max_charge_a', 105);
  view._reviewEditor();
  await view._applyEditor();
  assert.equal(probes, 2);
  assert.equal(api.submitted.length, 2);
  assert.equal(api.submitted[0].key, 'cell_voltage.ovp_v');
  assert.equal(api.submitted[1].key, 'current_limits.max_charge_a');
  assert.equal(view._editStatusKey, 'bms.edit.verified');
  assert.equal(view._editResults[0].reason, 'fresh_read');
  assert.equal(view._editReadAttempt, 2);
  assert.match(controls.innerHTML, /bms.edit.reason.fresh_read/);
});

test('two missed explicit 0x96 replies stop a batch after exactly two reads and one write', async () => {
  const api = localApi({ resultStates: ['uncertain'] });
  let attempts = 0;
  api.refreshBmsSettingsRead = async () => {
    attempts++;
    const error = new Error('refresh_read_timeout');
    error.code = 'refresh_read_timeout';
    throw error;
  };
  const { view, controls } = harness(api);
  await view._enterEditor();
  view._draft.set('cell_voltage.ovp_v', 3.66);
  view._draft.set('current_limits.max_charge_a', 105);
  view._reviewEditor();
  await view._applyEditor();
  assert.equal(attempts, 2);
  assert.equal(api.submitted.length, 1);
  assert.equal(view._editResults[0].state, 'uncertain');
  assert.equal(view._editBatchNoticeKey, 'bms.edit.batch_read_failed');
  assert.match(controls.innerHTML, /bms.edit.state.skipped/);
  assert.match(controls.innerHTML, /data-bms-edit-action="recheck"/);
});

test('second read can follow a terminal BLE read transport error but not network ambiguity', async () => {
  for (const [code, expected] of [
    ['refresh_read_transport', 2],
    ['refresh_browser_timeout', 1],
    ['refresh_link_changed', 1],
    ['refresh_superseded', 1]
  ]) {
    const api = localApi({ resultStates: ['uncertain'] });
    let attempts = 0;
    const values = original();
    api.fetchSettings = async () => values;
    api.refreshBmsSettingsRead = async () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error(code), { code });
      values.cell_voltage.ovp_v = 3.66;
      values.received_count++;
      return { connection_epoch: 17, received_count: values.received_count };
    };
    const { view } = harness(api);
    await view._enterEditor();
    view._draft.set('cell_voltage.ovp_v', 3.66);
    view._reviewEditor();
    await view._applyEditor();
    assert.equal(attempts, expected, code);
    assert.equal(api.submitted.length, 1, code);
    assert.equal(view._editResults[0].state,
      expected === 2 ? 'verified' : 'uncertain', code);
  }
});

test('BLE epoch change after first timeout blocks a second automatic BMS read', async () => {
  const api = localApi({ resultStates: ['uncertain'] });
  let attempts = 0;
  api.refreshBmsSettingsRead = async () => {
    attempts++;
    throw Object.assign(new Error('refresh_read_timeout'), { code: 'refresh_read_timeout' });
  };
  api.fetchBmsWritePolicy = async () => ({
    local_write_available: true, model_supported: true,
    connection_epoch: attempts > 0 ? 18 : 17, writable_keys: writable
  });
  const { view } = harness(api);
  await view._enterEditor();
  view._draft.set('current_limits.max_charge_a', 105);
  view._reviewEditor();
  await view._applyEditor();
  assert.equal(attempts, 1);
  assert.equal(api.submitted.length, 1);
  assert.equal(view._editBatchNoticeKey, 'bms.edit.batch_read_failed');
});

test('manual recheck also retries one missed read, but never sends another write', async () => {
  const api = localApi({ resultStates: ['not_sent'] });
  let attempts = 0;
  const values = original();
  api.fetchSettings = async () => values;
  api.refreshBmsSettingsRead = async () => {
    attempts++;
    if (attempts === 1) {
      throw Object.assign(new Error('refresh_read_timeout'), { code: 'refresh_read_timeout' });
    }
    values.current_limits.max_charge_a = 105;
    values.received_count++;
    return { connection_epoch: 17, received_count: values.received_count };
  };
  const { view } = harness(api);
  await view._enterEditor();
  view._draft.set('current_limits.max_charge_a', 105);
  view._reviewEditor();
  await view._applyEditor();
  await view._recheckEditor();
  assert.equal(attempts, 2);
  assert.equal(api.submitted.length, 1);
  assert.equal(view._editReadAttempt, 2);
  assert.equal(view._editStatusKey, 'bms.edit.recheck_all_applied');
});

test('after uncertain write a fresh BMS frame cannot authorize automatic resend', async () => {
  const api = localApi({ resultStates: ['uncertain'] });
  const values = original();
  api.fetchSettings = async () => values;
  api.refreshBmsSettingsRead = async () => {
    values.received_count++;
    return { connection_epoch: 17, received_count: values.received_count };
  };
  const { view, controls } = harness(api);
  await view._enterEditor();
  view._draft.set('cell_voltage.ovp_v', 3.7);
  view._draft.set('current_limits.max_charge_a', 110);
  view._reviewEditor();
  await view._applyEditor();
  assert.equal(api.submitted.length, 1);
  assert.equal(view._editResults[0].state, 'uncertain');
  assert.equal(view._editStatusKey, 'bms.edit.result_uncertain');
  assert.equal(view._editBatchNoticeKey, 'bms.edit.batch_not_confirmed');
  assert.match(controls.innerHTML, /bms.edit.state.skipped/);
  assert.match(controls.innerHTML, /bms.edit.batch_not_confirmed/);
  assert.match(controls.innerHTML, /data-bms-edit-action="recheck"/);
});

test('if batch automatic read fails or changes BLE session later writes are blocked', async () => {
  for (const failure of ['read_timeout', 'epoch_changed', 'wrong_identity', 'old_cached_frame']) {
    const api = localApi({ resultStates: ['uncertain'] });
    const fresh = original();
    api.fetchSettings = async () => fresh;
    api.refreshBmsSettingsRead = async () => {
      if (failure === 'read_timeout') throw new Error('refresh_read_timeout');
      if (failure === 'epoch_changed') return {
        connection_epoch: 18, received_count: fresh.received_count + 1
      };
      if (failure === 'wrong_identity') fresh.device.device_sn = 'other-device';
      return { connection_epoch: 17,
        received_count: failure === 'old_cached_frame' ? 10 : fresh.received_count };
    };
    const { view, controls } = harness(api);
    await view._enterEditor();
    view._draft.set('cell_voltage.ovp_v', 3.66);
    view._draft.set('current_limits.max_discharge_a', 105);
    view._reviewEditor();
    await view._applyEditor();
    assert.equal(api.submitted.length, 1, failure);
    assert.equal(view._editStatusKey, 'bms.edit.result_uncertain', failure);
    assert.equal(view._editBatchNoticeKey, 'bms.edit.batch_read_failed', failure);
    assert.match(controls.innerHTML, /bms.edit.batch_read_failed/);
  }
});

test('one automatic fresh read can exclude a BMS-dependent setting already applied', async () => {
  const api = localApi({ resultStates: ['uncertain', 'verified'] });
  const settings = original();
  api.fetchSettings = async () => settings;
  api.refreshBmsSettingsRead = async () => {
    settings.cell_voltage.ovp_v = 3.66;
    settings.current_limits.max_charge_a = 110;
    settings.received_count++;
    return { connection_epoch: 17, received_count: settings.received_count };
  };
  const { view, controls } = harness(api);
  await view._enterEditor();
  view._draft.set('cell_voltage.ovp_v', 3.66);
  view._draft.set('current_limits.max_charge_a', 110);
  view._draft.set('current_limits.max_discharge_a', 105);
  view._reviewEditor();
  await view._applyEditor();
  assert.equal(api.submitted.length, 2);
  assert.equal(api.submitted[0].key, 'cell_voltage.ovp_v');
  assert.equal(api.submitted[1].key, 'current_limits.max_discharge_a');
  assert.equal(view._editResults[1].state, 'already_applied');
  assert.equal(view._editStatusKey, 'bms.edit.verified');
  assert.match(controls.innerHTML, /bms.edit.state.already_applied/);
});

test('unknown auto-changed future setting halts batch before writing it', async () => {
  const api = localApi({ resultStates: ['uncertain'] });
  const settings = original();
  api.fetchSettings = async () => settings;
  api.refreshBmsSettingsRead = async () => {
    settings.cell_voltage.ovp_v = 3.66;
    settings.current_limits.max_charge_a = 103;
    settings.received_count++;
    return { connection_epoch: 17, received_count: settings.received_count };
  };
  const { view } = harness(api);
  await view._enterEditor();
  view._draft.set('cell_voltage.ovp_v', 3.66);
  view._draft.set('current_limits.max_charge_a', 110);
  view._draft.set('current_limits.max_discharge_a', 105);
  view._reviewEditor();
  await view._applyEditor();
  assert.equal(api.submitted.length, 1);
  assert.equal(view._editResults[0].state, 'verified');
  assert.equal(view._editResults[1].state, 'changed');
  assert.equal(view._editBatchNoticeKey, 'bms.edit.batch_changed');
});

test('if fresh read contradicts a previously verified value, subsequent writes stop', async () => {
  const api = localApi({ resultStates: ['verified', 'uncertain'] });
  const snapshot = original();
  api.fetchSettings = async () => snapshot;
  api.refreshBmsSettingsRead = async () => {
    snapshot.cell_voltage.ovp_v = 3.67;
    snapshot.current_limits.max_charge_a = 110;
    snapshot.received_count++;
    return { connection_epoch: 17, received_count: snapshot.received_count };
  };
  const { view } = harness(api);
  await view._enterEditor();
  view._draft.set('cell_voltage.ovp_v', 3.66);
  view._draft.set('current_limits.max_charge_a', 110);
  view._draft.set('current_limits.max_discharge_a', 105);
  view._reviewEditor();
  await view._applyEditor();
  assert.equal(api.submitted.length, 2);
  assert.equal(view._editResults[0].state, 'changed');
  assert.equal(view._editResults[1].state, 'verified');
  assert.equal(view._editBatchNoticeKey, 'bms.edit.batch_changed');
  assert.equal(view._editStatusKey, 'bms.edit.partial');
});

test('manual recheck can restore a draft on a new BLE epoch, not auto-continue a batch', async () => {
  const api = localApi({ resultStates: ['not_sent'] });
  const snapshot = original();
  api.fetchSettings = async () => snapshot;
  api.fetchBmsWritePolicy = async () => ({
    local_write_available: true, model_supported: true,
    connection_epoch: api.reconnected ? 18 : 17, writable_keys: writable
  });
  api.refreshBmsSettingsRead = async () => {
    api.reconnected = true;
    snapshot.received_count++;
    return { connection_epoch: 18, received_count: snapshot.received_count };
  };
  const { view } = harness(api);
  await view._enterEditor();
  view._draft.set('current_limits.max_charge_a', 110);
  view._reviewEditor();
  await view._applyEditor();
  assert.equal(view._editResults[0].state, 'not_sent');
  await view._recheckEditor();
  assert.equal(view._editPhase, 'review');
  assert.equal(view._draft.connectionEpoch, 18);
  assert.equal(api.submitted.length, 1, 'no write issued by manual fresh read');
});

test('normal batch without uncertain results never issues a redundant refresh', async () => {
  const api = localApi({ resultStates: ['verified', 'verified', 'verified'] });
  let probes = 0;
  api.refreshBmsSettingsRead = async () => { probes++; throw Error('should not read'); };
  const { view } = harness(api);
  await view._enterEditor();
  view._draft.set('cell_voltage.ovp_v', 3.66);
  view._draft.set('current_limits.max_charge_a', 110);
  view._draft.set('current_limits.max_discharge_a', 105);
  view._reviewEditor();
  await view._applyEditor();
  assert.equal(api.submitted.length, 3);
  assert.equal(probes, 0);
  assert.equal(view._editStatusKey, 'bms.edit.verified');
});

test('if fresh BMS reading already matches intended value, no retry is offered', async () => {
  const api = localApi({ resultStates: ['uncertain'] });
  const { view, controls } = harness(api);
  await view._enterEditor();
  view._draft.set('current_limits.max_charge_a', 110);
  view._reviewEditor();
  await view._applyEditor();
  const fresh = original();
  fresh.current_limits.max_charge_a = 110;
  api.fetchSettings = async () => fresh;
  await view._recheckEditor();
  assert.equal(view._editPhase, 'result');
  assert.equal(view._editStatusKey, 'bms.edit.recheck_all_applied');
  assert.equal(api.submitted.length, 1);
  assert.match(controls.innerHTML, /bms.edit.state.already_applied/);
  assert.doesNotMatch(controls.innerHTML, /data-bms-edit-action="recheck"/);
});

test('unexpected fresh value and failed read never trigger another settings write', async () => {
  for (const condition of ['changed', 'read_error', 'stale_frame', 'wrong_epoch']) {
    const api = localApi({ resultStates: ['uncertain'] });
    const { view, controls } = harness(api);
    await view._enterEditor();
    view._draft.set('cell_voltage.ovp_v', 3.7);
    view._reviewEditor();
    await view._applyEditor();
    assert.equal(api.submitted.length, 1);
    const fresh = original();
    if (condition === 'changed') fresh.cell_voltage.ovp_v = 3.68;
    if (condition === 'read_error') api.refreshBmsSettingsRead = async () => {
      throw new Error('refresh_read_timeout');
    };
    if (condition === 'stale_frame') api.refreshBmsSettingsRead = async () => ({
      connection_epoch: 17, received_count: 4
    });
    if (condition === 'wrong_epoch') api.refreshBmsSettingsRead = async () => ({
      connection_epoch: 18, received_count: 3
    });
    api.fetchSettings = async () => fresh;
    await view._recheckEditor();
    assert.equal(api.submitted.length, 1, condition);
    assert.equal(view._editPhase, 'result', condition);
    assert.equal(view._editStatusKey,
      condition === 'changed' ? 'bms.edit.recheck_changed' : 'bms.edit.recheck_failed');
    if (condition === 'changed') assert.match(controls.innerHTML, /bms.edit.state.changed/);
  }
});

test('diagnostic reason explains uncertainty without claiming a failed write', async () => {
  const api = localApi({ resultStates: ['uncertain'] });
  api.waitForBmsSettingWrite = async gen => ({ generation: gen,
    state: 'uncertain', reason: 'readback_timeout' });
  const { view, controls } = harness(api);
  await view._enterEditor();
  view._draft.set('current_limits.max_charge_a', 105);
  view._reviewEditor();
  await view._applyEditor();
  assert.match(controls.innerHTML, /bms.edit.reason.readback_timeout/);
  assert.match(controls.innerHTML, /bms.edit.recheck_button/);
});

test('write result semantics distinguish verified, rejected and uncertain outcomes', async () => {
  for (const [state, reason, statusTone, outcomeClass] of [
    ['verified', 'none', 'success', 'verified'],
    ['mismatch', 'none', 'error', 'mismatch'],
    ['not_sent', 'stale_setting', 'error', 'not_sent'],
    ['uncertain', 'readback_timeout', 'warning', 'uncertain']
  ]) {
    const api = localApi({ resultStates: [state] });
    api.waitForBmsSettingWrite = async generation => ({ generation, state, reason });
    const { view, controls } = harness(api);
    await view._enterEditor();
    view._draft.set('current_limits.max_charge_a', 105);
    view._reviewEditor();
    await view._applyEditor();
    assert.match(controls.innerHTML, new RegExp(`bms-edit-status--${statusTone}`));
    assert.match(controls.innerHTML, new RegExp(`bms-edit-outcome--${outcomeClass}`));
    if (reason === 'stale_setting') {
      assert.match(controls.innerHTML, /bms.edit.reason.stale_setting/);
    }
  }
});

test('write results have state colors and spacing before action buttons', () => {
  const css = readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.bms-edit-review \.bms-edit-status\s*\{[^}]*margin:\s*16px 0 20px;/);
  assert.match(css, /\.bms-edit-review \.bms-edit-status--success\s*\{[^}]*color:\s*#73df8d/);
  assert.match(css, /\.bms-edit-review \.bms-edit-status--error\s*\{[^}]*color:\s*#ff9a91/);
  assert.match(css, /\.bms-edit-review \.bms-edit-status--warning\s*\{[^}]*color:\s*#f0bb70/);
  assert.match(css, /\.bms-edit-outcome--not_sent, \.bms-edit-outcome--mismatch,\s*\.bms-edit-outcome--changed\s*\{[^}]*color:\s*#ff9a91/);
  assert.match(css, /\.bms-edit-outcome--uncertain, \.bms-edit-outcome--pending_retry\s*\{[^}]*color:\s*#f0bb70/);
  assert.match(css, /\.bms-edit-review \.bms-edit-controls--actions\s*\{[^}]*margin-top:\s*14px/);
  assert.match(css, /\.bms-edit-reason\s*\{[^}]*flex-basis:\s*100%/);
});

test('BMS write result rows use stable value/status columns and responsive layout', () => {
  const css = readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.bms-edit-review \.bms-edit-result-item\s*\{[^}]*display:\s*grid;/);
  assert.match(css, /grid-template-columns:\s*minmax\(0, 1fr\) 150px minmax\(0, 220px\)/);
  assert.match(css, /\.bms-edit-result-item > code\s*\{[^}]*font-variant-numeric:\s*tabular-nums;[^}]*white-space:\s*nowrap;/);
  assert.match(css, /\.bms-edit-result-item > \.bms-edit-outcome\s*\{[^}]*text-align:\s*right;/);
  assert.match(css, /\.bms-edit-review \.bms-edit-result-item > \.bms-edit-reason\s*\{[^}]*grid-column:\s*1 \/ -1;/);
  assert.match(css, /@media \(max-width: 700px\)\s*\{[\s\S]*?\.bms-edit-result-item > span:first-child\s*\{ grid-column: 1 \/ -1; \}/);
});

test('editor action panel stays at bottom and differentiates primary and secondary buttons', () => {
  const css = readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  assert.match(css, /#settings-editor-controls\.is-bms-edit-active\s*\{[^}]*position:\s*fixed;[^}]*bottom:\s*calc\(/);
  assert.match(css, /\.bms-edit-button--primary\s*\{[^}]*background:\s*#266ec6/);
  assert.match(css, /\.bms-edit-button--commit\s*\{[^}]*background:\s*#238636/);
  assert.match(css, /\.bms-edit-button--quiet\s*\{[^}]*background:\s*transparent/);
  assert.match(css, /env\(safe-area-inset-bottom/);
});

test('when fresh read fails before starting, no write is attempted', async () => {
  const api = localApi();
  api.fetchSettings = async () => { throw new Error('offline'); };
  const { view } = harness(api);
  await view._enterEditor();
  view._draft.set('cell_voltage.ovp_v', 3.7);
  view._reviewEditor();
  await view._applyEditor();
  assert.equal(api.submitted.length, 0);
  assert.equal(view._editPhase, 'review');
  assert.equal(view._editStatusKey, 'bms.edit.verify_failed');
});
