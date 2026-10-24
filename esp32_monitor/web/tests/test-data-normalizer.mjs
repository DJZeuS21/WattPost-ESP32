import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(__dirname, '../js/data-normalizer.js');
const moduleUrl = pathToFileURL(modulePath).href;

const imported = await import(moduleUrl);
const Normalizer = imported.default || imported.DataNormalizer || globalThis.DataNormalizer;

console.log('🧪 Testing DataNormalizer module...');

// 1. Capacity coercion (0 is valid for remaining, > 0 for nominal)
assert.strictEqual(Normalizer.parseRemainingCapacity(0), 0);
assert.strictEqual(Normalizer.parseRemainingCapacity('0.000'), 0);
assert.strictEqual(Normalizer.parseRemainingCapacity('299.864'), 299.864);
assert.strictEqual(Normalizer.parseRemainingCapacity('null'), null);
assert.strictEqual(Normalizer.parseRemainingCapacity(null), null);
assert.strictEqual(Normalizer.parseRemainingCapacity(undefined), null);
assert.strictEqual(Normalizer.parseRemainingCapacity(-5), null);

assert.strictEqual(Normalizer.parseNominalCapacity(315), 315);
assert.strictEqual(Normalizer.parseNominalCapacity('315.000'), 315);
assert.strictEqual(Normalizer.parseNominalCapacity(0), null);
assert.strictEqual(Normalizer.parseNominalCapacity('null'), null);
console.log('   ✅ Capacity parsing (remaining >= 0, nominal > 0) passed');

// 2. Topology validation
assert.deepStrictEqual(Normalizer.validateCellTopology(0xFF, 8, 8), { valid: true });
assert.deepStrictEqual(Normalizer.validateCellTopology(0x0F0F, 8, 8), { valid: true });
const invalidPopcount = Normalizer.validateCellTopology(0xFF, 6, 6);
assert.strictEqual(invalidPopcount.valid, false);
assert.strictEqual(invalidPopcount.error, 'CELL_TOPOLOGY_MISMATCH');
const invalidLength = Normalizer.validateCellTopology(0xFF, 8, 7);
assert.strictEqual(invalidLength.valid, false);
assert.strictEqual(invalidLength.error, 'CELL_TOPOLOGY_MISMATCH');
const invalidEmpty = Normalizer.validateCellTopology(0, 0, 0);
assert.strictEqual(invalidEmpty.valid, false);
console.log('   ✅ validateCellTopology passed');

// 3. Cell mapping: Contiguous 8S & Non-contiguous mask (cells 1..4 and 9..12)
const maskSplit = 0x0F0F;
const packedSplit = [3.30, 3.31, 3.32, 3.33, 3.40, 3.41, 3.42, 3.43];
const mappedSplit = Normalizer.mapPackedCells(maskSplit, packedSplit, false);
assert.strictEqual(mappedSplit.length, 8);
assert.strictEqual(mappedSplit[0].physicalNumber, 1);
assert.strictEqual(mappedSplit[3].physicalNumber, 4);
assert.strictEqual(mappedSplit[4].physicalNumber, 9);
assert.strictEqual(mappedSplit[7].physicalNumber, 12);

const mappedMv = Normalizer.mapPackedCells(0x0F, [3330, 3331, 3328, 3332], true);
assert.strictEqual(mappedMv[0].voltage_v, 3.330);
assert.strictEqual(mappedMv[0].voltage_mv, 3330);
console.log('   ✅ mapPackedCells (contiguous and non-contiguous) passed');

// 4. Median without invented fallbacks
assert.strictEqual(Normalizer.getMedian([]), null);
assert.strictEqual(Normalizer.getMedian([3.30, 3.32, 3.34]), 3.32);
assert.strictEqual(Normalizer.getMedian([3.30, 3.32, 3.34, 3.36]), 3.33);
console.log('   ✅ getMedian without fake fallbacks passed');

// 5. Parameterized Temperature sensor testing for N = 1, 2, 3, 4, 5
const candidateSensors = [
  { id: 'mos', name: 'MOSFET', supported: true, present: true, enabled: true, value_valid: true, val_c: 28.9, alias_of: null },
  { id: 't1', name: 'T1', supported: true, present: true, enabled: true, value_valid: true, val_c: 28.8, alias_of: null },
  { id: 't2', name: 'T2', supported: true, present: true, enabled: true, value_valid: true, val_c: 28.4, alias_of: null },
  { id: 'ext256', name: 'EXT256', supported: true, present: true, enabled: true, value_valid: true, val_c: 29.2, alias_of: null },
  { id: 'ext258', name: 'EXT258', supported: true, present: true, enabled: true, value_valid: true, val_c: 28.9, alias_of: null },
];

for (let n = 1; n <= 5; n++) {
  const subset = candidateSensors.slice(0, n);
  const filtered = Normalizer.filterValidSensors(subset);
  assert.strictEqual(filtered.length, n);
  const summary = Normalizer.computeBatterySummaryTemp(filtered);
  const batterySensors = filtered.filter(s => s.role === 'battery');
  if (batterySensors.length === 0) {
    assert.strictEqual(summary, null);
  } else {
    assert.strictEqual(typeof summary, 'number');
  }
}
console.log('   ✅ Parameterized temperature capability tests (N=1..5) passed');

// 6. Time-weighted Energy Integration: activeWattSeconds vs totalWattSeconds & < 5W isolation
const pointsWithIdle = [
  { t: 1000, v: 50.0, a: 2.0 }, // 100W
  { t: 1100, v: 50.0, a: 2.0 }, // dt = 100s, 100W
  { t: 1101, v: 50.0, a: 0.0 }, // step to 0W in 1s
  { t: 2101, v: 50.0, a: 0.0 }, // dt = 1000s, 0W (idle)
  { t: 2102, v: 50.0, a: 10.0 }, // step to 500W in 1s
  { t: 2602, v: 50.0, a: 10.0 }, // dt = 500s, 500W
];
const stats = Normalizer.energyStats(pointsWithIdle, 'charging');
assert.strictEqual(Math.round(stats.wattHours), 72);
assert.strictEqual(stats.seconds, 602);
assert.strictEqual(Math.round(stats.average), 432);
console.log('   ✅ energyStats active power isolation from idle intervals passed');

// 7. History normalization: strict null for missing values and topology validation
const historyRecordMissing = [
  { t: 1000, v: null, a: null, s: null, cell_count: 8, cell_mask: 255, cells: [3300, 3300] }
];
const normalizedBadHist = Normalizer.normalizeHistory(historyRecordMissing);
assert.strictEqual(normalizedBadHist[0].v, null);
assert.strictEqual(normalizedBadHist[0].a, null);
assert.strictEqual(normalizedBadHist[0].power, null);
assert.strictEqual(normalizedBadHist[0].cells.length, 0);
assert.strictEqual(normalizedBadHist[0].min_cell_v, null);
assert.strictEqual(normalizedBadHist[0].spread_mv, null);
console.log('   ✅ normalizeHistory strict nulls and topology mismatch protection passed');

// 8. BMS Cell Index, Delta & Average parsing
assert.strictEqual(Normalizer.parseCellIndex(0, 8), 0, 'zero-based index 0 must be preserved as 0');
assert.strictEqual(Normalizer.parseCellIndex('0', 8), 0, 'string "0" must parse to number 0');
assert.strictEqual(Normalizer.parseCellIndex(7, 8), 7);
assert.strictEqual(Normalizer.parseCellIndex(8, 8), null, 'index >= count must be rejected as null');
assert.strictEqual(Normalizer.parseCellIndex(255, 8), null, 'out-of-range index 255 must be rejected');
assert.strictEqual(Normalizer.parseCellIndex(-1, 8), null, 'negative index must be rejected');
assert.strictEqual(Normalizer.parseCellIndex(null, 8), null, 'null must return null');
assert.strictEqual(Normalizer.parseCellIndex(undefined, 8), null, 'undefined must return null');
assert.strictEqual(Normalizer.parseCellIndex('null', 8), null, 'string "null" must return null');
assert.strictEqual(Normalizer.parseCellIndex(1.5, 8), null, 'fractional index must be rejected');
assert.strictEqual(Normalizer.parseCellIndex(NaN, 8), null, 'NaN must return null');

assert.strictEqual(Normalizer.parseDeltaMv(0), 0);
assert.strictEqual(Normalizer.parseDeltaMv(3), 3);
assert.strictEqual(Normalizer.parseDeltaMv('5'), 5);
assert.strictEqual(Normalizer.parseDeltaMv(null), null);
assert.strictEqual(Normalizer.parseDeltaMv('null'), null);
assert.strictEqual(Normalizer.parseDeltaMv(-2), null);

assert.strictEqual(Normalizer.parseAverageMv(3335), 3335);
assert.strictEqual(Normalizer.parseAverageMv('3335'), 3335);
assert.strictEqual(Normalizer.parseAverageMv(0), null);
assert.strictEqual(Normalizer.parseAverageMv(null), null);
console.log('   ✅ parseCellIndex, parseDeltaMv, and parseAverageMv unit tests passed');

// 9. normalizeLive with authoritative BMS fields (Tie-case & Multi-value tie)
const tieCaseRaw = {
  online: true,
  voltage_v: 27.408,
  current_a: 0.0,
  soc: 100,
  cell_active_mask: 255,
  cell_count: 8,
  cells: [3.426, 3.426, 3.426, 3.426, 3.426, 3.426, 3.426, 3.426],
  bms_cell_delta_mv: 1,
  bms_max_cell_index: 0,
  bms_min_cell_index: 1,
  bms_cell_average_mv: 3426,
  model: 'JK_PB2A16S20P',
  ble_state: 'connected',
  ble_connected: true,
  firmware_version: 'V18.4.1',
  web_version: 'V18.4.1',
  build_id: 'd9255e52a42f',
  ota_state: 'valid',
  ota_rollback_configured: true,
  ota_validation_pending: false,
  esp_uptime: 12345,
  last_restart_reason: 'power_on',
  temperatures: []
};
const normTie = Normalizer.normalizeLive(tieCaseRaw);
assert.strictEqual(normTie.cells.spread_mv, 1, 'Authoritative live spread must be 1 mV from bms_cell_delta_mv, not 0 mV');
assert.strictEqual(normTie.cells.max_cell_index, 0, 'max_cell_index 0 must be preserved');
assert.strictEqual(normTie.cells.min_cell_index, 1, 'min_cell_index 1 must be preserved');
assert.strictEqual(normTie.cells.bms_delta_mv, 1);
assert.strictEqual(normTie.cells.bms_average_mv, 3426);
assert.strictEqual(normTie.cell_count, 8);
assert.strictEqual(normTie.ble_state, 'connected');
assert.strictEqual(normTie.ble_connected, true);
assert.strictEqual(normTie.firmware_version, 'V18.4.1');
assert.strictEqual(normTie.web_version, 'V18.4.1');
assert.strictEqual(normTie.build_id, 'd9255e52a42f');
assert.strictEqual(normTie.ota_state, 'valid');
assert.strictEqual(normTie.ota_rollback_configured, true);
assert.strictEqual(normTie.ota_validation_pending, false);
assert.strictEqual(normTie.esp_uptime, 12345);
assert.strictEqual(normTie.last_restart_reason, 'power_on');

const bmsOfflineDeviceRaw = {
  online: false,
  message: 'Очікування BMS',
  device_config_status: 'ok',
  setup_state: 'configured',
  wifi_configured: true,
  wifi_state: 'connected',
  wifi_ssid: 'Home',
  wifi_rssi_dbm: -57,
  bms_configured: true,
  bms_address_hint: '...A7:C2',
  ble_state: 'disconnected',
  ble_connected: false,
  firmware_version: 'V18.4.1',
  web_version: 'V18.4.1',
  build_id: 'stage1-test',
  ota_state: 'valid',
  ota_rollback_configured: true,
  ota_validation_pending: false,
  esp_uptime: 42,
  last_restart_reason: 'power_on',
};
const normBmsOffline = Normalizer.normalizeLive(bmsOfflineDeviceRaw);
assert.strictEqual(normBmsOffline.online, false);
assert.strictEqual(normBmsOffline.device_config_status, 'ok');
assert.strictEqual(normBmsOffline.setup_state, 'configured');
assert.strictEqual(normBmsOffline.wifi_configured, true);
assert.strictEqual(normBmsOffline.wifi_state, 'connected');
assert.strictEqual(normBmsOffline.wifi_ssid, 'Home');
assert.strictEqual(normBmsOffline.wifi_rssi_dbm, -57);
assert.strictEqual(normBmsOffline.bms_configured, true);
assert.strictEqual(normBmsOffline.bms_address_hint, '...A7:C2');
assert.strictEqual(normBmsOffline.firmware_version, 'V18.4.1');
assert.strictEqual(normBmsOffline.esp_uptime, 42);

const multiTieRaw = {
  online: true,
  voltage_v: 26.683,
  current_a: -1.58,
  soc: 98,
  cell_active_mask: 255,
  cell_count: 8,
  cells: [3.336, 3.336, 3.336, 3.335, 3.333, 3.336, 3.336, 3.336],
  bms_cell_delta_mv: 3,
  bms_max_cell_index: 0,
  bms_min_cell_index: 4,
  bms_cell_average_mv: 3335,
  temperatures: []
};
const normMulti = Normalizer.normalizeLive(multiTieRaw);
assert.strictEqual(normMulti.cells.max_cell_index, 0);
assert.strictEqual(normMulti.cells.min_cell_index, 4);
assert.strictEqual(normMulti.cells.spread_mv, 3);

const nullIndicesRaw = {
  online: true,
  voltage_v: 26.683,
  current_a: 0.0,
  soc: 98,
  cell_active_mask: 255,
  cell_count: 8,
  cells: [3.336, 3.336, 3.336, 3.335, 3.333, 3.336, 3.336, 3.336],
  bms_cell_delta_mv: null,
  bms_max_cell_index: null,
  bms_min_cell_index: null,
  temperatures: []
};
const normNull = Normalizer.normalizeLive(nullIndicesRaw);
assert.strictEqual(normNull.cells.max_cell_index, null);
assert.strictEqual(normNull.cells.min_cell_index, null);
assert.strictEqual(normNull.cells.bms_delta_mv, null);
assert.strictEqual(normNull.cells.spread_mv, null, 'LIVE spread_mv must be strictly null when bms_cell_delta_mv is null (no calculated fallback)');

// Cloud logical cells do not carry JK BMS min/max indices. The normalizer must
// derive deterministic extreme indices from the logical voltage vector while
// keeping the authoritative local path above unchanged.
const logicalCellsRaw = {
  online: true,
  remote: true,
  device_online: true,
  bms_connected: true,
  bms_data_fresh: true,
  voltage_v: 26.64,
  current_a: -1.2,
  soc: 96,
  cells_are_logical: true,
  cell_count: 8,
  cells: [3.331, 3.330, 3.331, 3.327, 3.330, 3.330, 3.330, 3.330],
  bms_cell_delta_mv: 4,
  temperatures: [],
};
const normLogicalCells = Normalizer.normalizeLive(logicalCellsRaw);
assert.strictEqual(normLogicalCells.cells.max_cell_index, 0, 'logical Cloud cells derive the first highest cell');
assert.strictEqual(normLogicalCells.cells.min_cell_index, 3, 'logical Cloud cells derive the lowest cell');
assert.strictEqual(normLogicalCells.cells.spread_mv, 4, 'authoritative Cloud/BMS spread remains unchanged');

const logicalTieRaw = {
  ...logicalCellsRaw,
  cells: [3.330, 3.330, 3.330, 3.330, 3.330, 3.330, 3.330, 3.330],
  bms_cell_delta_mv: 0,
};
const normLogicalTie = Normalizer.normalizeLive(logicalTieRaw);
assert.strictEqual(normLogicalTie.cells.max_cell_index, 0);
assert.strictEqual(normLogicalTie.cells.min_cell_index, 0, 'all-equal cells resolve to the same index so UI applies no conflicting highlight');

const zeroDeltaRaw = {
  online: true,
  voltage_v: 27.0,
  current_a: 0.0,
  soc: 100,
  cell_active_mask: 255,
  cell_count: 8,
  cells: [3.375, 3.375, 3.375, 3.375, 3.375, 3.375, 3.375, 3.375],
  bms_cell_delta_mv: 0,
  bms_max_cell_index: 0,
  bms_min_cell_index: 0,
  temperatures: []
};
const normZero = Normalizer.normalizeLive(zeroDeltaRaw);
assert.strictEqual(normZero.cells.bms_delta_mv, 0, 'bms_cell_delta_mv = 0 is a valid 0 mV spread');
assert.strictEqual(normZero.cells.spread_mv, 0, 'spread_mv must be 0 mV');

const invalidDeltaRaw = {
  online: true,
  voltage_v: 27.0,
  current_a: 0.0,
  soc: 100,
  cell_active_mask: 255,
  cell_count: 8,
  cells: [3.375, 3.375, 3.375, 3.375, 3.375, 3.375, 3.375, 3.375],
  bms_cell_delta_mv: -5,
  temperatures: []
};
const normInvalid = Normalizer.normalizeLive(invalidDeltaRaw);
assert.strictEqual(normInvalid.cells.bms_delta_mv, null);
assert.strictEqual(normInvalid.cells.spread_mv, null, 'Negative or invalid delta must result in null spread_mv');
console.log('   ✅ normalizeLive authoritative BMS fields and strict null spread semantics passed');

console.log('🎉 ALL DataNormalizer unit tests passed successfully!');
