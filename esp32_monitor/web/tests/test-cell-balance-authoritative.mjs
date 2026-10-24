import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const normalizerPath = resolve(__dirname, '../js/data-normalizer.js');
const colorsPath = resolve(__dirname, '../js/battery-colors.js');

// Mock window / global environment for battery-colors and data-normalizer
globalThis.window = globalThis;
await import(pathToFileURL(colorsPath).href);
const Normalizer = (await import(pathToFileURL(normalizerPath).href)).default;

console.log('🧪 Running Targeted Tests for Cell Balance Authoritative BMS fields...\n');

// ==========================================
// TEST A: DataNormalizer Index & Value Parsing
// ==========================================
console.log('--- TEST A: DataNormalizer Zero-Index & Field Validation ---');
assert.strictEqual(Normalizer.parseCellIndex(0, 8), 0, 'Zero-based index 0 must be preserved as 0');
assert.strictEqual(Normalizer.parseCellIndex('0', 8), 0, 'String "0" must be converted to integer 0');
assert.strictEqual(Normalizer.parseCellIndex(7, 8), 7, 'Valid index 7 for 8S must be accepted');
assert.strictEqual(Normalizer.parseCellIndex(8, 8), null, 'Index 8 for 8S must be rejected as null');
assert.strictEqual(Normalizer.parseCellIndex(255, 8), null, 'Out-of-range index 255 must be rejected as null');
assert.strictEqual(Normalizer.parseCellIndex(-1, 8), null, 'Negative index must be rejected as null');
assert.strictEqual(Normalizer.parseCellIndex(null, 8), null, 'null must return null');
assert.strictEqual(Normalizer.parseCellIndex(undefined, 8), null, 'undefined must return null');
assert.strictEqual(Normalizer.parseCellIndex('null', 8), null, '"null" string must return null');
assert.strictEqual(Normalizer.parseCellIndex(1.5, 8), null, 'Fractional index must return null');
assert.strictEqual(Normalizer.parseCellIndex(NaN, 8), null, 'NaN must return null');

assert.strictEqual(Normalizer.parseDeltaMv(0), 0, 'Delta 0 must be preserved as 0');
assert.strictEqual(Normalizer.parseDeltaMv(1), 1);
assert.strictEqual(Normalizer.parseDeltaMv('3'), 3);
assert.strictEqual(Normalizer.parseDeltaMv(null), null);
assert.strictEqual(Normalizer.parseDeltaMv(-1), null);

assert.strictEqual(Normalizer.parseAverageMv(3335), 3335);
assert.strictEqual(Normalizer.parseAverageMv('3426'), 3426);
assert.strictEqual(Normalizer.parseAverageMv(0), null);
assert.strictEqual(Normalizer.parseAverageMv(null), null);
console.log('  ✅ TEST A passed!\n');

// ==========================================
// TEST B: Production Tie-Case Walkthrough
// ==========================================
console.log('--- TEST B: Production Tie-Case [3.426V x 8, delta=1mV, max=0, min=1] ---');
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
  temperatures: []
};

const normB = Normalizer.normalizeLive(tieCaseRaw);
assert.strictEqual(normB.cells.spread_mv, 1, 'Live spread must be authoritative 1 mV, not calculated 0 mV');
assert.strictEqual(normB.cells.max_cell_index, 0);
assert.strictEqual(normB.cells.min_cell_index, 1);
assert.strictEqual(normB.cells.bms_delta_mv, 1);
assert.strictEqual(normB.cells.bms_average_mv, 3426);

// Simulate cell rendering logic
const maxIdxB = normB.cells.max_cell_index;
const minIdxB = normB.cells.min_cell_index;
const cellStatesB = normB.cells.list.map((c, i) => ({
  cellNum: c.physicalNumber,
  voltage: c.voltage_v,
  isMin: minIdxB != null && i === minIdxB && minIdxB !== maxIdxB,
  isMax: maxIdxB != null && i === maxIdxB && minIdxB !== maxIdxB,
}));

assert.strictEqual(cellStatesB[0].isMax, true, 'Cell 01 (index 0) must be MAX');
assert.strictEqual(cellStatesB[0].isMin, false);
assert.strictEqual(cellStatesB[1].isMin, true, 'Cell 02 (index 1) must be MIN');
assert.strictEqual(cellStatesB[1].isMax, false);
for (let i = 2; i < 8; i++) {
  assert.strictEqual(cellStatesB[i].isMax, false, `Cell ${i + 1} must NOT be MAX`);
  assert.strictEqual(cellStatesB[i].isMin, false, `Cell ${i + 1} must NOT be MIN`);
}
console.log('  ✅ TEST B passed!\n');

// ==========================================
// TEST C: Multi-Value Tie (No "Garland" of MAX cells)
// ==========================================
console.log('--- TEST C: Multi-Value Tie [3.336 x 7 + 3.333 x 1, max=0, min=4] ---');
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

const normC = Normalizer.normalizeLive(multiTieRaw);
assert.strictEqual(normC.cells.max_cell_index, 0);
assert.strictEqual(normC.cells.min_cell_index, 4);
assert.strictEqual(normC.cells.spread_mv, 3);

const maxIdxC = normC.cells.max_cell_index;
const minIdxC = normC.cells.min_cell_index;
const cellStatesC = normC.cells.list.map((c, i) => ({
  cellNum: c.physicalNumber,
  isMin: minIdxC != null && i === minIdxC && minIdxC !== maxIdxC,
  isMax: maxIdxC != null && i === maxIdxC && minIdxC !== maxIdxC,
}));

assert.strictEqual(cellStatesC[0].isMax, true, 'Only Cell 01 (index 0) must be MAX');
assert.strictEqual(cellStatesC[4].isMin, true, 'Only Cell 05 (index 4) must be MIN');

// Ensure other 3.336 cells (indices 1, 2, 5, 6, 7) are neutral
[1, 2, 5, 6, 7].forEach(idx => {
  assert.strictEqual(cellStatesC[idx].isMax, false, `Cell ${idx + 1} (3.336V) must NOT get MAX styling`);
  assert.strictEqual(cellStatesC[idx].isMin, false);
});
console.log('  ✅ TEST C passed!\n');

// ==========================================
// TEST D: Null Indices & Null Spread (Strict No Fallback)
// ==========================================
console.log('--- TEST D: Null Indices & Null Spread [max=null, min=null, delta=null] ---');
const nullRaw = {
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

const normD = Normalizer.normalizeLive(nullRaw);
assert.strictEqual(normD.cells.max_cell_index, null);
assert.strictEqual(normD.cells.min_cell_index, null);
assert.strictEqual(normD.cells.spread_mv, null, 'LIVE spread must be strictly null when bms_cell_delta_mv is null (no calculated fallback)');

const maxIdxD = normD.cells.max_cell_index;
const minIdxD = normD.cells.min_cell_index;
const cellStatesD = normD.cells.list.map((c, i) => ({
  cellNum: c.physicalNumber,
  isMin: minIdxD != null && i === minIdxD && minIdxD !== maxIdxD,
  isMax: maxIdxD != null && i === maxIdxD && minIdxD !== maxIdxD,
}));

cellStatesD.forEach((c, idx) => {
  assert.strictEqual(c.isMax, false, `Cell ${idx + 1} must NOT be MAX when maxIdx is null`);
  assert.strictEqual(c.isMin, false, `Cell ${idx + 1} must NOT be MIN when minIdx is null`);
});

// UI null presentation formatting verification
const spreadMvD = normD.cells.spread_mv;
const kpiValD = spreadMvD != null ? String(spreadMvD) : '—';
const isSpreadWarnD = spreadMvD != null && spreadMvD > 15;
const badgeTextD = spreadMvD != null ? `Δ ${spreadMvD} mV` : 'Δ —';
const trendCurrentD = spreadMvD != null ? `${spreadMvD} mV` : '—';

assert.strictEqual(kpiValD, '—', 'KPI value must be "—" when spread is null');
assert.strictEqual(isSpreadWarnD, false, 'Warning must be false when spread is null');
assert.strictEqual(badgeTextD, 'Δ —', 'Badge text must be "Δ —" when spread is null');
assert.strictEqual(trendCurrentD, '—', 'Trend current text must be "—" when spread is null');
console.log('  ✅ TEST D passed!\n');

// ==========================================
// TEST E: Same Index Edge Case (minIdx === maxIdx) & 0 mV Spread
// ==========================================
console.log('--- TEST E: Same Index Edge Case [max=0, min=0] & 0 mV Spread ---');
const sameIdxRaw = {
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

const normE = Normalizer.normalizeLive(sameIdxRaw);
const maxIdxE = normE.cells.max_cell_index;
const minIdxE = normE.cells.min_cell_index;
const cellStatesE = normE.cells.list.map((c, i) => ({
  isMin: minIdxE != null && i === minIdxE && minIdxE !== maxIdxE,
  isMax: maxIdxE != null && i === maxIdxE && minIdxE !== maxIdxE,
}));

cellStatesE.forEach((c, idx) => {
  assert.strictEqual(c.isMax, false, `Cell ${idx + 1} must NOT have conflicting MAX style`);
  assert.strictEqual(c.isMin, false, `Cell ${idx + 1} must NOT have conflicting MIN style`);
});
console.log('  ✅ TEST E passed!\n');

console.log('🎉 ALL Targeted Tests for Authoritative Cell Balance PASSED SUCCESSFULLY!');
