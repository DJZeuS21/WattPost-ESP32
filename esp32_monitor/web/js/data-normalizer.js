/* data-normalizer.js — Pure data coercion, topology validation, physical cell mapping & time-weighted aggregation.
 * Universal UMD / ES / CommonJS export. Zero DOM / network dependencies. */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DataNormalizer = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const SENSOR_ROLE_MAP = {
    mos: 'mosfet',
    t1: 'battery',
    t2: 'battery',
    ext254: 'other',
    ext256: 'battery',
    ext258: 'battery',
  };

  const SENSOR_COLOR_MAP = {
    mos: '#A78BFA',
    t1: '#58A6FF',
    t2: '#56D4C8',
    ext254: '#C084FC',
    ext256: '#F0883E',
    ext258: '#F43F5E',
  };

  const SENSOR_NAME_MAP = {
    mos: 'MOSFET',
    t1: 'Датчик T1',
    t2: 'Датчик T2',
    ext254: 'EXT254',
    ext256: 'Датчик T3',
    ext258: 'Датчик T4',
  };

  const HISTORY_TEMP_SLOT_MAP = {
    mos: 0,
    t1: 1,
    t2: 2,
    ext254: 3,
    ext256: 4,
    ext258: 5,
  };

  function countSetBits(n) {
    let count = 0;
    let val = Number(n) || 0;
    while (val > 0) {
      count += (val & 1);
      val >>= 1;
    }
    return count;
  }

  function validateCellTopology(mask, cellCount, arrayLength) {
    const maskNum = Number(mask) || 0;
    if (maskNum <= 0) return { valid: false, error: 'INVALID_MASK' };
    const popcount = countSetBits(maskNum);
    if (cellCount != null && Number(cellCount) !== popcount) {
      return { valid: false, error: 'CELL_TOPOLOGY_MISMATCH', details: `popcount(${maskNum})=${popcount} !== cell_count(${cellCount})` };
    }
    if (arrayLength != null && Number(arrayLength) !== popcount) {
      return { valid: false, error: 'CELL_TOPOLOGY_MISMATCH', details: `popcount(${maskNum})=${popcount} !== array_length(${arrayLength})` };
    }
    if (popcount < 1 || popcount > 16) {
      return { valid: false, error: 'CELL_COUNT_OUT_OF_RANGE', details: `popcount=${popcount}` };
    }
    return { valid: true };
  }

  function parseRemainingCapacity(val) {
    if (val == null || val === 'null' || val === '') return null;
    const num = Number(val);
    return Number.isFinite(num) && num >= 0 ? num : null;
  }

  function parseNominalCapacity(val) {
    if (val == null || val === 'null' || val === '') return null;
    const num = Number(val);
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  function mapPackedCells(mask, packedCells, isMilliVolts = false) {
    if (!Array.isArray(packedCells)) return [];
    const mapped = [];
    let packedIdx = 0;
    const maskNum = Number(mask) || 0;

    for (let bit = 0; bit < 16; bit++) {
      if ((maskNum & (1 << bit)) !== 0) {
        if (packedIdx >= packedCells.length) break;
        const raw = Number(packedCells[packedIdx++]);
        if (!Number.isFinite(raw)) continue;
        const voltage_v = isMilliVolts ? raw * 0.001 : raw;
        const voltage_mv = isMilliVolts ? raw : Math.round(raw * 1000);
        mapped.push({
          physicalNumber: bit + 1,
          voltage_v: Number(voltage_v.toFixed(3)),
          voltage_mv: Math.round(voltage_mv),
        });
      }
    }
    return mapped;
  }

  function mapLogicalCells(cells) {
    if (!Array.isArray(cells)) return [];
    return cells.flatMap((raw, index) => {
      const voltage = Number(raw);
      if (!Number.isFinite(voltage)) return [];
      return [{
        physicalNumber: null,
        logicalNumber: index + 1,
        voltage_v: Number(voltage.toFixed(3)),
        voltage_mv: Math.round(voltage * 1000),
      }];
    });
  }

  function filterValidSensors(rawSensors) {
    if (!Array.isArray(rawSensors)) return [];
    return rawSensors
      .filter(ch => (
        ch &&
        ch.supported === true &&
        ch.present === true &&
        ch.enabled === true &&
        ch.value_valid === true &&
        ch.alias_of === null &&
        ch.val_c != null &&
        Number.isFinite(Number(ch.val_c))
      ))
      .map(ch => ({
        id: ch.id,
        name: SENSOR_NAME_MAP[ch.id] || ch.name || ch.id,
        role: SENSOR_ROLE_MAP[ch.id] || 'other',
        val_c: Number(Number(ch.val_c).toFixed(1)),
        color: SENSOR_COLOR_MAP[ch.id] || '#58A6FF',
        isBattery: SENSOR_ROLE_MAP[ch.id] === 'battery',
      }));
  }

  function computeBatterySummaryTemp(validSensors) {
    if (!Array.isArray(validSensors)) return null;
    const batterySensors = validSensors.filter(s => s.role === 'battery' && Number.isFinite(s.val_c));
    if (!batterySensors.length) return null;
    const sum = batterySensors.reduce((acc, s) => acc + s.val_c, 0);
    return Number((sum / batterySensors.length).toFixed(1));
  }

  function getMedian(arr) {
    if (!arr || !arr.length) return null;
    const sorted = [...arr].filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function energyStats(points, direction) {
    if (!Array.isArray(points) || points.length < 2) {
      return { wattHours: 0, seconds: 0, average: 0, peak: 0, validIntervals: 0 };
    }
    const directed = power => direction === 'charging' ? Math.max(power, 0) : Math.max(-power, 0);
    let totalWattSeconds = 0;
    let activeWattSeconds = 0;
    let validActiveSeconds = 0;
    let peakPower = 0;
    let validIntervals = 0;

    for (let i = 1; i < points.length; i++) {
      const pPrev = points[i - 1];
      const pCurr = points[i];
      if (pPrev.v == null || pPrev.a == null || pCurr.v == null || pCurr.a == null) continue;
      const dt = Number(pCurr.t) - Number(pPrev.t);
      if (dt <= 0 || dt > 1200) continue; // Gap protection (max 20 min)
      validIntervals++;

      const powPrev = directed(Number(pPrev.v) * Number(pPrev.a));
      const powCurr = directed(Number(pCurr.v) * Number(pCurr.a));
      const avgPower = (powPrev + powCurr) / 2;

      totalWattSeconds += avgPower * dt;
      if (avgPower >= 5) {
        activeWattSeconds += avgPower * dt;
        validActiveSeconds += dt;
        if (powPrev > peakPower) peakPower = powPrev;
        if (powCurr > peakPower) peakPower = powCurr;
      }
    }

    const wattHours = totalWattSeconds / 3600;
    const average = validActiveSeconds > 0 ? (activeWattSeconds / validActiveSeconds) : 0;
    return { wattHours, seconds: validActiveSeconds, average, peak: peakPower, validIntervals };
  }

  function normalizeLive(raw) {
    if (!raw || typeof raw !== 'object') {
      return { online: false, state: 'offline', message: 'Немає даних' };
    }

    const wifiRssi = raw.wifi_rssi_dbm != null && Number.isFinite(Number(raw.wifi_rssi_dbm))
      ? Number(raw.wifi_rssi_dbm)
      : null;
    const deviceFields = {
      device_config_status: raw.device_config_status || null,
      setup_state: raw.setup_state || null,
      wifi_configured: raw.wifi_configured === true,
      wifi_state: raw.wifi_state || null,
      wifi_ssid: typeof raw.wifi_ssid === 'string' ? raw.wifi_ssid : '',
      wifi_rssi_dbm: wifiRssi,
      bms_configured: raw.bms_configured === true,
      bms_address_hint: typeof raw.bms_address_hint === 'string' ? raw.bms_address_hint : '',
      ble_state: raw.ble_state || null,
      ble_connected: raw.ble_connected === true,
      firmware_version: raw.firmware_version || null,
      web_version: raw.web_version || null,
      build_id: raw.build_id || null,
      ota_state: raw.ota_state || null,
      ota_rollback_configured: raw.ota_rollback_configured === true,
      ota_validation_pending: raw.ota_validation_pending === true,
      esp_uptime: raw.esp_uptime != null && Number.isFinite(Number(raw.esp_uptime)) ? Number(raw.esp_uptime) : null,
      last_restart_reason: raw.last_restart_reason || null,
      remote: raw.remote === true,
      device_online: raw.device_online == null ? null : raw.device_online === true,
      has_snapshot: raw.has_snapshot === true,
      last_seen: raw.last_seen || null,
      telemetry_received_at: raw.telemetry_received_at || null,
      telemetry_fresh: raw.telemetry_fresh === true,
      last_fresh_battery_received_at: raw.last_fresh_battery_received_at || null,
      has_last_fresh_battery: raw.has_last_fresh_battery === true,
      bms_connected: raw.bms_connected == null ? null : raw.bms_connected === true,
      bms_data_fresh: raw.bms_data_fresh == null ? null : raw.bms_data_fresh === true,
      is_stale: raw.remote === true && (
        raw.is_stale === true ||
        raw.device_online !== true ||
        raw.bms_connected !== true ||
        raw.bms_data_fresh !== true
      ),
    };

    const online = Boolean(raw.online);
    if (!online) {
      return {
        online: false,
        state: 'offline',
        message: raw.message || 'Немає зв’язку з BMS',
        ...deviceFields,
      };
    }

    const voltage_v = raw.voltage_v != null && Number.isFinite(Number(raw.voltage_v)) ? Number(raw.voltage_v) : null;
    const current_a = raw.current_a != null && Number.isFinite(Number(raw.current_a)) ? Number(raw.current_a) : null;
    const power_w = (voltage_v != null && current_a != null) ? (voltage_v * current_a) : null;
    const abs_power_w = power_w != null ? Math.abs(power_w) : null;

    let state = 'idle';
    if (abs_power_w != null && abs_power_w >= 5) {
      state = current_a > 0 ? 'charging' : 'discharging';
    }

    const soc = raw.soc != null && Number.isFinite(Number(raw.soc)) ? Math.max(0, Math.min(100, Math.round(Number(raw.soc)))) : null;
    const remaining_ah = parseRemainingCapacity(raw.remaining_capacity_ah);
    const nominal_ah = parseNominalCapacity(raw.nominal_capacity_ah);

    let effective_remaining_ah = remaining_ah;
    if (effective_remaining_ah == null && nominal_ah != null && soc != null) {
      effective_remaining_ah = Number(((nominal_ah * soc) / 100).toFixed(1));
    }

    const mask = raw.cell_active_mask != null ? Number(raw.cell_active_mask) : null;
    const rawCells = Array.isArray(raw.cells) ? raw.cells : [];
    const logicalCells = raw.cells_are_logical === true;
    const logicalCount = Number(raw.cell_count);
    const topology = logicalCells
      ? (Number.isInteger(logicalCount) && logicalCount >= 1 && logicalCount <= 16 && rawCells.length === logicalCount
        ? { valid: true }
        : { valid: false, error: 'INVALID_LOGICAL_CELL_COUNT' })
      : mask != null
        ? validateCellTopology(mask, raw.cell_count, rawCells.length)
        : { valid: false, error: 'MISSING_MASK' };

    let mappedCells = [];
    let cellVoltages = [];
    let min_cell_v = null;
    let max_cell_v = null;
    let spread_mv = null;
    let median_v = null;

    if (topology.valid) {
      mappedCells = logicalCells
        ? mapLogicalCells(rawCells)
        : mapPackedCells(mask, rawCells, false);
      cellVoltages = mappedCells.map(c => c.voltage_v);
      if (cellVoltages.length) {
        min_cell_v = Math.min(...cellVoltages);
        max_cell_v = Math.max(...cellVoltages);
        spread_mv = Math.round((max_cell_v - min_cell_v) * 1000);
        median_v = getMedian(cellVoltages);
      }
    }

    const activeCount = topology.valid ? mappedCells.length : (raw.cell_count != null ? Number(raw.cell_count) : null);
    let max_cell_index = parseCellIndex(raw.bms_max_cell_index, activeCount);
    let min_cell_index = parseCellIndex(raw.bms_min_cell_index, activeCount);

    // Local JK telemetry carries authoritative BMS min/max indices and those
    // remain the source of truth whenever they are present. Cloud telemetry
    // intentionally transports only the logical active-cell voltage vector, so
    // there is no BMS index to preserve there. Derive a deterministic fallback
    // only for that logical representation; this restores the same MAX/MIN UI
    // semantics without changing local authoritative behavior.
    if (logicalCells && cellVoltages.length) {
      if (max_cell_index == null) {
        const maxVoltage = Math.max(...cellVoltages);
        max_cell_index = cellVoltages.indexOf(maxVoltage);
      }
      if (min_cell_index == null) {
        const minVoltage = Math.min(...cellVoltages);
        min_cell_index = cellVoltages.indexOf(minVoltage);
      }
    }

    const bms_delta_mv = parseDeltaMv(raw.bms_cell_delta_mv);
    const bms_average_mv = parseAverageMv(raw.bms_cell_average_mv);
    const live_spread_mv = bms_delta_mv;

    const validSensors = filterValidSensors(raw.temperatures);
    const summary_temp_c = raw.temperature_summary_c != null && Number.isFinite(Number(raw.temperature_summary_c))
      ? Number(Number(raw.temperature_summary_c).toFixed(1))
      : computeBatterySummaryTemp(validSensors);

    return {
      online: true,
      state: deviceFields.is_stale ? 'idle' : state,
      activity_state: deviceFields.is_stale ? 'unknown' : state,
      message: raw.message || 'Дані BMS отримано',
      ...deviceFields,
      model: raw.model || 'JK BMS',
      profile: raw.semantic_profile || 'GENERIC',
      cell_count: activeCount,
      voltage_v: voltage_v != null ? Number(voltage_v.toFixed(2)) : null,
      current_a: current_a != null ? Number(current_a.toFixed(2)) : null,
      power_w: power_w != null ? Number(power_w.toFixed(1)) : null,
      abs_power_w: abs_power_w != null ? Number(abs_power_w.toFixed(1)) : null,
      soc: soc != null ? Math.round(soc) : null,
      remaining_capacity_ah: effective_remaining_ah,
      nominal_capacity_ah: nominal_ah,
      cells: {
        valid: topology.valid,
        error: topology.error || null,
        count: mappedCells.length,
        mask,
        list: mappedCells,
        voltages: cellVoltages,
        min_v: min_cell_v,
        max_v: max_cell_v,
        spread_mv: live_spread_mv,
        median_v,
        max_cell_index,
        min_cell_index,
        bms_delta_mv,
        bms_average_mv,
      },
      temperatures: {
        summary_c: summary_temp_c,
        sensors: validSensors,
      },
    };
  }

  function parseCellIndex(val, count) {
    if (val == null || val === '' || val === 'null') return null;
    const num = Number(val);
    if (!Number.isInteger(num)) return null;
    if (num < 0) return null;
    if (count != null && Number.isInteger(Number(count)) && num >= Number(count)) return null;
    return num;
  }

  function parseDeltaMv(val) {
    if (val == null || val === '' || val === 'null') return null;
    const num = Number(val);
    if (!Number.isFinite(num) || num < 0) return null;
    return Math.round(num);
  }

  function parseAverageMv(val) {
    if (val == null || val === '' || val === 'null') return null;
    const num = Number(val);
    if (!Number.isFinite(num) || num <= 0) return null;
    return Math.round(num);
  }

  function normalizeHistory(rawArray) {
    if (!Array.isArray(rawArray)) return [];
    return rawArray
      .filter(r => r && Number.isFinite(Number(r.t)))
      .sort((a, b) => Number(a.t) - Number(b.t))
      .map(r => {
        const t = Number(r.t);
        const v = (r.v != null && Number.isFinite(Number(r.v))) ? Number(Number(r.v).toFixed(3)) : null;
        const a = (r.a != null && Number.isFinite(Number(r.a))) ? Number(Number(r.a).toFixed(1)) : null;
        const s = (r.s != null && Number.isFinite(Number(r.s))) ? Math.max(0, Math.min(100, Math.round(Number(r.s)))) : null;

        const netPower = (v != null && a != null) ? (v * a) : null;
        const chargePower = netPower != null ? Math.max(0, netPower) : null;
        const dischargePower = netPower != null ? Math.max(0, -netPower) : null;

        const cellMask = (r.cell_mask != null && Number(r.cell_mask) > 0) ? Number(r.cell_mask) : null;
        const rawCells = Array.isArray(r.cells) ? r.cells : [];
        const topology = cellMask != null ? validateCellTopology(cellMask, r.cell_count, rawCells.length) : { valid: false, error: 'MISSING_MASK' };

        let mappedCells = [];
        let min_cell_v = null;
        let max_cell_v = null;
        let spread_mv = null;

        if (topology.valid) {
          mappedCells = mapPackedCells(cellMask, rawCells, true);
          const cellVoltages = mappedCells.map(c => c.voltage_v);
          if (cellVoltages.length) {
            min_cell_v = Number(Math.min(...cellVoltages).toFixed(3));
            max_cell_v = Number(Math.max(...cellVoltages).toFixed(3));
            spread_mv = Math.round((max_cell_v - min_cell_v) * 1000);
          }
        }

        const tempMask = Number(r.temp_mask) || 0;
        const tempsBySlot = Array.isArray(r.temps) ? r.temps : [];
        const sensorTemps = {};
        const batteryTemps = [];

        Object.entries(HISTORY_TEMP_SLOT_MAP).forEach(([id, slot]) => {
          if ((tempMask & (1 << slot)) !== 0 && tempsBySlot[slot] != null) {
            const tempVal = Number((Number(tempsBySlot[slot]) * 0.1).toFixed(1));
            sensorTemps[id] = tempVal;
            if (SENSOR_ROLE_MAP[id] === 'battery') {
              batteryTemps.push(tempVal);
            }
          } else {
            sensorTemps[id] = null;
          }
        });

        // Summary temperature strictly calculated from present battery slots in this record
        const summaryBatteryTemp = batteryTemps.length
          ? Number((batteryTemps.reduce((acc, val) => acc + val, 0) / batteryTemps.length).toFixed(1))
          : null;

        let mode = 'idle';
        if (netPower != null && Math.abs(netPower) >= 5) {
          mode = a > 0 ? 'charging' : 'discharging';
        }

        return {
          t,
          v,
          a,
          s,
          power: netPower != null ? Math.round(Math.abs(netPower)) : null,
          chargePower: chargePower != null ? Math.round(chargePower) : null,
          dischargePower: dischargePower != null ? Math.round(dischargePower) : null,
          mode,
          cells: mappedCells,
          min_cell_v,
          max_cell_v,
          spread_mv,
          temps: sensorTemps,
          summary_battery_temp_c: summaryBatteryTemp,
        };
      });
  }

  function getSensorHistory(normalizedHistory, sensorId) {
    if (!Array.isArray(normalizedHistory)) return [];
    return normalizedHistory.map(r => ({
      t: r.t,
      val: r.temps[sensorId] != null ? r.temps[sensorId] : null,
    }));
  }

  return {
    validateCellTopology,
    parseRemainingCapacity,
    parseNominalCapacity,
    mapPackedCells,
    filterValidSensors,
    computeBatterySummaryTemp,
    getMedian,
    energyStats,
    normalizeLive,
    normalizeHistory,
    getSensorHistory,
    parseCellIndex,
    parseDeltaMv,
    parseAverageMv,
    SENSOR_ROLE_MAP,
    SENSOR_COLOR_MAP,
    SENSOR_NAME_MAP,
    HISTORY_TEMP_SLOT_MAP,
  };
});
