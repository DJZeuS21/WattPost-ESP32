// esp32_monitor/web/tests/test-settings-schema.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('SettingsSchema and SettingsNormalizer integrity and 100% key coverage', async () => {
  const code = await readFile(new URL('../js/settings-schema.js', import.meta.url), 'utf8');
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(code, context);

  const { SETTINGS_SECTIONS, SETTINGS_SCHEMA, SettingsNormalizer } = context.window;

  assert.ok(SETTINGS_SECTIONS && Array.isArray(SETTINGS_SECTIONS), 'SETTINGS_SECTIONS must be an array');
  assert.ok(SETTINGS_SCHEMA && Array.isArray(SETTINGS_SCHEMA), 'SETTINGS_SCHEMA must be an array');
  assert.ok(SettingsNormalizer, 'SettingsNormalizer must exist');

  // Verify all sections exist
  const expectedSections = [
    'battery',
    'cellVoltage',
    'balancing',
    'currentLimits',
    'temperature',
    'switches',
    'sleep'
  ];
  const sectionIds = SETTINGS_SECTIONS.map(s => s.id);
  expectedSections.forEach(id => {
    assert.ok(sectionIds.includes(id), `Section ${id} must exist`);
  });

  // Verify 100% coverage of all 53 configuration keys in /api/settings
  const realApiKeys = [
    // battery (3)
    'battery.cell_count', 'battery.nominal_capacity_ah', 'battery.device_address',
    // cell_voltage (11)
    'cell_voltage.smart_sleep_v', 'cell_voltage.uvp_v', 'cell_voltage.uvpr_v',
    'cell_voltage.ovp_v', 'cell_voltage.ovpr_v', 'cell_voltage.soc_100_v',
    'cell_voltage.soc_0_v', 'cell_voltage.request_charge_v', 'cell_voltage.request_float_v',
    'cell_voltage.power_off_v', 'cell_voltage.start_balance_v',
    // balancing (4)
    'balancing.enabled', 'balancing.trigger_delta_v', 'balancing.start_voltage_v', 'balancing.max_current_a',
    // current_limits (9)
    'current_limits.max_charge_a', 'current_limits.charge_ocp_delay_s', 'current_limits.charge_ocpr_time_s',
    'current_limits.max_discharge_a', 'current_limits.discharge_ocp_delay_s', 'current_limits.discharge_ocpr_time_s',
    'current_limits.scpr_time_s', 'current_limits.scp_delay_us', 'current_limits.discharge_precharge_s',
    // temperature (12)
    'temperature.charge_otp_c', 'temperature.charge_otpr_c', 'temperature.charge_utp_c', 'temperature.charge_utpr_c',
    'temperature.discharge_otp_c', 'temperature.discharge_otpr_c', 'temperature.discharge_utp_c', 'temperature.discharge_utpr_c',
    'temperature.mosfet_otp_c', 'temperature.mosfet_otpr_c', 'temperature.heating_start_c', 'temperature.heating_stop_c',
    // switches (13)
    'switches.charge', 'switches.discharge', 'switches.balancer', 'switches.heating',
    'switches.disable_temperature_sensors', 'switches.gps_heartbeat', 'switches.port_is_rs485',
    'switches.display_always_on', 'switches.special_charger', 'switches.smart_sleep',
    'switches.disable_pcl_module', 'switches.timed_stored_data', 'switches.charging_float_mode',
    // sleep (1)
    'sleep.smart_sleep_time_hours'
  ];

  assert.strictEqual(realApiKeys.length, 53, 'Must test exactly 53 configuration keys');
  for (const key of realApiKeys) {
    const spec = SETTINGS_SCHEMA.find(s => s.key === key);
    assert.ok(spec, `Schema must contain specification for key: ${key}`);
    assert.ok(spec.labelUk, `Key ${key} must have Ukrainian label`);
    assert.ok(spec.labelEn, `Key ${key} must have English reference`);
  }

  // Verify temperature sub-groups
  const tempSpecs = SETTINGS_SCHEMA.filter(s => s.section === 'temperature');
  assert.strictEqual(tempSpecs.length, 12, 'Must have 12 temperature specifications');
  const tempSubgroups = new Set(tempSpecs.map(s => s.subgroup));
  assert.ok(tempSubgroups.has('charge'), 'Must contain charge subgroup');
  assert.ok(tempSubgroups.has('discharge'), 'Must contain discharge subgroup');
  assert.ok(tempSubgroups.has('mosfet'), 'Must contain mosfet subgroup');
  assert.ok(tempSubgroups.has('heating'), 'Must contain heating subgroup');

  // Verify numeric precision without trailing zeros
  const uvpSpec = SETTINGS_SCHEMA.find(s => s.key === 'cell_voltage.uvp_v');
  assert.strictEqual(SettingsNormalizer.formatValue(uvpSpec, 2.750).text, '2.75');
  assert.strictEqual(SettingsNormalizer.formatValue(uvpSpec, 3.100).text, '3.1');
  assert.strictEqual(SettingsNormalizer.formatValue(uvpSpec, 3.415).text, '3.415');

  const maxChargeSpec = SETTINGS_SCHEMA.find(s => s.key === 'current_limits.max_charge_a');
  assert.strictEqual(SettingsNormalizer.formatValue(maxChargeSpec, 110.0).text, '110');
  assert.strictEqual(SettingsNormalizer.formatValue(maxChargeSpec, 110.5).text, '110.5');

  // Verify millivolt delta formatting
  const deltaSpec = SETTINGS_SCHEMA.find(s => s.key === 'balancing.trigger_delta_v');
  const formattedDelta = SettingsNormalizer.formatValue(deltaSpec, 0.003);
  assert.strictEqual(formattedDelta.text, '3');
  assert.strictEqual(formattedDelta.unit, 'mV');
  assert.strictEqual(formattedDelta.secondaryText, '0.003 V');

  // Verify booleans
  const switchSpec = SETTINGS_SCHEMA.find(s => s.key === 'switches.charge');
  assert.strictEqual(SettingsNormalizer.formatValue(switchSpec, true).text, 'Увімкнено');
  assert.strictEqual(SettingsNormalizer.formatValue(switchSpec, false).text, 'Вимкнено');

  // Verify uptime formatting (0 is valid)
  assert.strictEqual(SettingsNormalizer.formatUptime(0), '0 хв');
  assert.strictEqual(SettingsNormalizer.formatUptime(120), '2 хв');
  assert.strictEqual(SettingsNormalizer.formatUptime(3660), '1 год 1 хв');
  assert.strictEqual(SettingsNormalizer.formatUptime(90060), '1 д 1 год 1 хв');
  assert.strictEqual(SettingsNormalizer.formatUptime(null), '—');
  assert.strictEqual(SettingsNormalizer.formatUptime(undefined), '—');
});
