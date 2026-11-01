/* settings-schema.js — Centralized metadata schema & value formatting for JK BMS Settings. */

(function (global) {
  'use strict';

  const SETTINGS_SECTIONS = [
    {
      id: 'battery',
      titleKey: 'bms.section.battery.title',
      descriptionKey: 'bms.section.battery.description'
    },
    {
      id: 'cellVoltage',
      titleKey: 'bms.section.cell_voltage.title',
      descriptionKey: 'bms.section.cell_voltage.description'
    },
    {
      id: 'balancing',
      titleKey: 'bms.section.balancing.title',
      descriptionKey: 'bms.section.balancing.description'
    },
    {
      id: 'currentLimits',
      titleKey: 'bms.section.current_limits.title',
      descriptionKey: 'bms.section.current_limits.description'
    },
    {
      id: 'temperature',
      titleKey: 'bms.section.temperature.title',
      descriptionKey: 'bms.section.temperature.description',
      subgroups: [
        { id: 'charge', titleKey: 'bms.subgroup.temperature.charge' },
        { id: 'discharge', titleKey: 'bms.subgroup.temperature.discharge' },
        { id: 'mosfet', titleKey: 'bms.subgroup.temperature.mosfet' },
        { id: 'heating', titleKey: 'bms.subgroup.temperature.heating' }
      ]
    },
    {
      id: 'switches',
      titleKey: 'bms.section.switches.title',
      descriptionKey: 'bms.section.switches.description'
    },
    {
      id: 'sleep',
      titleKey: 'bms.section.sleep.title',
      descriptionKey: 'bms.section.sleep.description'
    }
  ];

  const SETTINGS_SCHEMA = [
    // --- 1. BATTERY (3 keys) ---
    {
      key: 'battery.cell_count',
      section: 'battery',
      labelKey: 'bms.parameter.battery.cell_count',
      type: 'integer',
      unit: ''
    },
    {
      key: 'battery.nominal_capacity_ah',
      section: 'battery',
      labelKey: 'bms.parameter.battery.nominal_capacity_ah',
      type: 'number',
      maxDecimals: 1,
      unit: 'Ah'
    },
    {
      key: 'battery.device_address',
      section: 'battery',
      labelKey: 'bms.parameter.battery.device_address',
      type: 'integer',
      unit: ''
    },

    // --- 2. CELL VOLTAGE (11 keys) ---
    {
      key: 'cell_voltage.ovp_v',
      section: 'cellVoltage',
      labelKey: 'bms.parameter.cell_voltage.ovp_v',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.ovpr_v',
      section: 'cellVoltage',
      labelKey: 'bms.parameter.cell_voltage.ovpr_v',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.request_charge_v',
      section: 'cellVoltage',
      labelKey: 'bms.parameter.cell_voltage.request_charge_v',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.request_float_v',
      section: 'cellVoltage',
      labelKey: 'bms.parameter.cell_voltage.request_float_v',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.soc_100_v',
      section: 'cellVoltage',
      labelKey: 'bms.parameter.cell_voltage.soc_100_v',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.soc_0_v',
      section: 'cellVoltage',
      labelKey: 'bms.parameter.cell_voltage.soc_0_v',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.start_balance_v',
      section: 'cellVoltage',
      labelKey: 'bms.parameter.cell_voltage.start_balance_v',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.uvpr_v',
      section: 'cellVoltage',
      labelKey: 'bms.parameter.cell_voltage.uvpr_v',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.uvp_v',
      section: 'cellVoltage',
      labelKey: 'bms.parameter.cell_voltage.uvp_v',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.power_off_v',
      section: 'cellVoltage',
      labelKey: 'bms.parameter.cell_voltage.power_off_v',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.smart_sleep_v',
      section: 'cellVoltage',
      labelKey: 'bms.parameter.cell_voltage.smart_sleep_v',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },

    // --- 3. BALANCING (4 keys) ---
    {
      key: 'balancing.enabled',
      section: 'balancing',
      labelKey: 'bms.parameter.balancing.enabled',
      type: 'boolean'
    },
    {
      key: 'balancing.trigger_delta_v',
      section: 'balancing',
      labelKey: 'bms.parameter.balancing.trigger_delta_v',
      type: 'delta_voltage',
      unit: 'mV',
      format: (val) => {
        if (val === null || val === undefined || isNaN(val)) return { text: '—', unit: '', status: 'empty' };
        const mv = Math.round(val * 1000);
        const rawSec = Number(val).toFixed(3);
        return {
          text: String(mv),
          unit: 'mV',
          secondaryText: `${rawSec} V`,
          status: 'value'
        };
      }
    },
    {
      key: 'balancing.start_voltage_v',
      section: 'balancing',
      labelKey: 'bms.parameter.balancing.start_voltage_v',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'balancing.max_current_a',
      section: 'balancing',
      labelKey: 'bms.parameter.balancing.max_current_a',
      type: 'number',
      maxDecimals: 1,
      unit: 'A'
    },

    // --- 4. CURRENT LIMITS (9 keys) ---
    {
      key: 'current_limits.max_charge_a',
      section: 'currentLimits',
      labelKey: 'bms.parameter.current_limits.max_charge_a',
      type: 'number',
      maxDecimals: 1,
      unit: 'A'
    },
    {
      key: 'current_limits.charge_ocp_delay_s',
      section: 'currentLimits',
      labelKey: 'bms.parameter.current_limits.charge_ocp_delay_s',
      type: 'integer',
      unit: 's'
    },
    {
      key: 'current_limits.charge_ocpr_time_s',
      section: 'currentLimits',
      labelKey: 'bms.parameter.current_limits.charge_ocpr_time_s',
      type: 'integer',
      unit: 's'
    },
    {
      key: 'current_limits.max_discharge_a',
      section: 'currentLimits',
      labelKey: 'bms.parameter.current_limits.max_discharge_a',
      type: 'number',
      maxDecimals: 1,
      unit: 'A'
    },
    {
      key: 'current_limits.discharge_ocp_delay_s',
      section: 'currentLimits',
      labelKey: 'bms.parameter.current_limits.discharge_ocp_delay_s',
      type: 'integer',
      unit: 's'
    },
    {
      key: 'current_limits.discharge_ocpr_time_s',
      section: 'currentLimits',
      labelKey: 'bms.parameter.current_limits.discharge_ocpr_time_s',
      type: 'integer',
      unit: 's'
    },
    {
      key: 'current_limits.scp_delay_us',
      section: 'currentLimits',
      labelKey: 'bms.parameter.current_limits.scp_delay_us',
      type: 'integer',
      unit: 'µs'
    },
    {
      key: 'current_limits.scpr_time_s',
      section: 'currentLimits',
      labelKey: 'bms.parameter.current_limits.scpr_time_s',
      type: 'integer',
      unit: 's'
    },
    {
      key: 'current_limits.discharge_precharge_s',
      section: 'currentLimits',
      labelKey: 'bms.parameter.current_limits.discharge_precharge_s',
      type: 'integer',
      unit: 's'
    },

    // --- 5. TEMPERATURE (12 keys across 4 subgroups) ---
    // Subgroup: charge
    {
      key: 'temperature.charge_otp_c',
      section: 'temperature',
      subgroup: 'charge',
      labelKey: 'bms.parameter.temperature.charge_otp_c',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },
    {
      key: 'temperature.charge_otpr_c',
      section: 'temperature',
      subgroup: 'charge',
      labelKey: 'bms.parameter.temperature.charge_otpr_c',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },
    {
      key: 'temperature.charge_utp_c',
      section: 'temperature',
      subgroup: 'charge',
      labelKey: 'bms.parameter.temperature.charge_utp_c',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },
    {
      key: 'temperature.charge_utpr_c',
      section: 'temperature',
      subgroup: 'charge',
      labelKey: 'bms.parameter.temperature.charge_utpr_c',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },

    // Subgroup: discharge
    {
      key: 'temperature.discharge_otp_c',
      section: 'temperature',
      subgroup: 'discharge',
      labelKey: 'bms.parameter.temperature.discharge_otp_c',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },
    {
      key: 'temperature.discharge_otpr_c',
      section: 'temperature',
      subgroup: 'discharge',
      labelKey: 'bms.parameter.temperature.discharge_otpr_c',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },
    {
      key: 'temperature.discharge_utp_c',
      section: 'temperature',
      subgroup: 'discharge',
      labelKey: 'bms.parameter.temperature.discharge_utp_c',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },
    {
      key: 'temperature.discharge_utpr_c',
      section: 'temperature',
      subgroup: 'discharge',
      labelKey: 'bms.parameter.temperature.discharge_utpr_c',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },

    // Subgroup: mosfet
    {
      key: 'temperature.mosfet_otp_c',
      section: 'temperature',
      subgroup: 'mosfet',
      labelKey: 'bms.parameter.temperature.mosfet_otp_c',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },
    {
      key: 'temperature.mosfet_otpr_c',
      section: 'temperature',
      subgroup: 'mosfet',
      labelKey: 'bms.parameter.temperature.mosfet_otpr_c',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },

    // Subgroup: heating
    {
      key: 'temperature.heating_start_c',
      section: 'temperature',
      subgroup: 'heating',
      labelKey: 'bms.parameter.temperature.heating_start_c',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },
    {
      key: 'temperature.heating_stop_c',
      section: 'temperature',
      subgroup: 'heating',
      labelKey: 'bms.parameter.temperature.heating_stop_c',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },

    // --- 6. SWITCHES (13 keys) ---
    {
      key: 'switches.charge',
      section: 'switches',
      labelKey: 'bms.parameter.switches.charge',
      type: 'boolean'
    },
    {
      key: 'switches.discharge',
      section: 'switches',
      labelKey: 'bms.parameter.switches.discharge',
      type: 'boolean'
    },
    {
      key: 'switches.balancer',
      section: 'switches',
      labelKey: 'bms.parameter.switches.balancer',
      type: 'boolean'
    },
    {
      key: 'switches.heating',
      section: 'switches',
      labelKey: 'bms.parameter.switches.heating',
      type: 'boolean'
    },
    {
      key: 'switches.charging_float_mode',
      section: 'switches',
      labelKey: 'bms.parameter.switches.charging_float_mode',
      type: 'boolean'
    },
    {
      key: 'switches.disable_temperature_sensors',
      section: 'switches',
      labelKey: 'bms.parameter.switches.disable_temperature_sensors',
      type: 'boolean'
    },
    {
      key: 'switches.display_always_on',
      section: 'switches',
      labelKey: 'bms.parameter.switches.display_always_on',
      type: 'boolean'
    },
    {
      key: 'switches.special_charger',
      section: 'switches',
      labelKey: 'bms.parameter.switches.special_charger',
      type: 'boolean'
    },
    {
      key: 'switches.port_is_rs485',
      section: 'switches',
      labelKey: 'bms.parameter.switches.port_is_rs485',
      type: 'boolean'
    },
    {
      key: 'switches.gps_heartbeat',
      section: 'switches',
      labelKey: 'bms.parameter.switches.gps_heartbeat',
      type: 'boolean'
    },
    {
      key: 'switches.disable_pcl_module',
      section: 'switches',
      labelKey: 'bms.parameter.switches.disable_pcl_module',
      type: 'boolean'
    },
    {
      key: 'switches.timed_stored_data',
      section: 'switches',
      labelKey: 'bms.parameter.switches.timed_stored_data',
      type: 'boolean'
    },

    // --- 7. SLEEP (2 keys) ---
    {
      key: 'switches.smart_sleep',
      section: 'sleep',
      labelKey: 'bms.parameter.switches.smart_sleep',
      type: 'boolean'
    },
    {
      key: 'sleep.smart_sleep_time_hours',
      section: 'sleep',
      labelKey: 'bms.parameter.sleep.smart_sleep_time_hours',
      type: 'integer',
      unitKey: 'bms.unit_hours'
    }
  ];

  function formatAdaptiveNumber(num, maxDecimals = 1) {
    if (maxDecimals === 0) return String(Math.round(num));
    const str = num.toFixed(maxDecimals);
    // Strip trailing zeros after decimal point
    return str.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  }

  const tr = (key, values) => global.WattPostI18n.t(key, values);

  const SettingsNormalizer = {
    resolveValue(data, keyPath) {
      if (!data || typeof data !== 'object' || !keyPath) return null;
      const parts = keyPath.split('.');
      let current = data;
      for (const part of parts) {
        if (current === null || current === undefined || typeof current !== 'object') {
          return null;
        }
        current = current[part];
      }
      return current !== undefined ? current : null;
    },

    formatValue(spec, rawValue) {
      if (rawValue === null || rawValue === undefined) {
        return { text: '—', unit: '', status: 'empty' };
      }

      if (typeof spec.format === 'function') {
        return spec.format(rawValue);
      }

      if (spec.type === 'boolean') {
        const isTrue = Boolean(rawValue);
        return {
          text: isTrue ? tr('text.enabled') : tr('text.disabled'),
          unit: '',
          status: isTrue ? 'active' : 'inactive',
          booleanValue: isTrue
        };
      }

      if (typeof rawValue === 'number' || !isNaN(Number(rawValue))) {
        const num = Number(rawValue);
        const maxDec = spec.maxDecimals !== undefined ? spec.maxDecimals : (spec.type === 'voltage' ? 3 : (spec.type === 'integer' ? 0 : 1));
        return {
          text: formatAdaptiveNumber(num, maxDec),
          unit: spec.unitKey ? tr(spec.unitKey) : spec.unit || '',
          status: 'value'
        };
      }

      return {
        text: String(rawValue),
        unit: spec.unitKey ? tr(spec.unitKey) : spec.unit || '',
        status: 'value'
      };
    },

    formatUptime(seconds) {
      if (seconds === null || seconds === undefined || isNaN(seconds) || seconds < 0) return '—';
      if (seconds === 0) return tr('device_settings.uptime_minutes', { minutes: 0 });
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      const parts = [];
      if (days > 0) parts.push(tr('bms.uptime_days', { days }));
      if (hours > 0 || days > 0) parts.push(tr('bms.uptime_hours', { hours }));
      if (mins > 0 || (days === 0 && hours === 0)) parts.push(tr('device_settings.uptime_minutes', { minutes: mins }));
      return parts.join(' ');
    }
  };

  global.SETTINGS_SECTIONS = SETTINGS_SECTIONS;
  global.SETTINGS_SCHEMA = SETTINGS_SCHEMA;
  global.SettingsNormalizer = SettingsNormalizer;
})(typeof window !== 'undefined' ? window : global);
