/* settings-schema.js — Centralized metadata schema & value formatting for JK BMS Settings. */

(function (global) {
  'use strict';

  const SETTINGS_SECTIONS = [
    {
      id: 'battery',
      titleUk: 'Акумулятор',
      titleEn: 'Battery Configuration',
      descriptionUk: 'Базові параметри конфігурації акумуляторної батареї'
    },
    {
      id: 'cellVoltage',
      titleUk: 'Напруга комірок',
      titleEn: 'Cell Voltage Thresholds',
      descriptionUk: 'Пороги захисту, відновлення та робочих рівнів напруги комірок'
    },
    {
      id: 'balancing',
      titleUk: 'Балансування',
      titleEn: 'Active Balancer',
      descriptionUk: 'Налаштування та умови активного перерозподілу енергії між комірками'
    },
    {
      id: 'currentLimits',
      titleUk: 'Струм і захист',
      titleEn: 'Current & Protection Limits',
      descriptionUk: 'Обмеження струмів заряду, розряду та захист від короткого замикання'
    },
    {
      id: 'temperature',
      titleUk: 'Температура',
      titleEn: 'Temperature Thresholds',
      descriptionUk: 'Температурні обмеження для заряду, розряду, MOSFET та підігріву',
      subgroups: [
        { id: 'charge', titleUk: 'Заряджання', titleEn: 'Charging Protection' },
        { id: 'discharge', titleUk: 'Розряджання', titleEn: 'Discharging Protection' },
        { id: 'mosfet', titleUk: 'Силові ключі (MOSFET)', titleEn: 'Power Tubes (MOSFET)' },
        { id: 'heating', titleUk: 'Підігрів', titleEn: 'Battery Heating' }
      ]
    },
    {
      id: 'switches',
      titleUk: 'Перемикачі та функції',
      titleEn: 'Function Switches',
      descriptionUk: 'Керування силовими ключами, портами та режимами роботи'
    },
    {
      id: 'sleep',
      titleUk: 'Сон та системні функції',
      titleEn: 'Sleep & Standby Modes',
      descriptionUk: 'Параметри переходу в енергозберігаючий режим'
    }
  ];

  const SETTINGS_SCHEMA = [
    // --- 1. BATTERY (3 keys) ---
    {
      key: 'battery.cell_count',
      section: 'battery',
      labelUk: 'Кількість комірок',
      labelEn: 'Cell count',
      type: 'integer',
      unit: ''
    },
    {
      key: 'battery.nominal_capacity_ah',
      section: 'battery',
      labelUk: 'Номінальна ємність',
      labelEn: 'Nominal battery capacity',
      type: 'number',
      maxDecimals: 1,
      unit: 'Ah'
    },
    {
      key: 'battery.device_address',
      section: 'battery',
      labelUk: 'Адреса пристрою',
      labelEn: 'Device RS485 / CAN address',
      type: 'integer',
      unit: ''
    },

    // --- 2. CELL VOLTAGE (11 keys) ---
    {
      key: 'cell_voltage.ovp_v',
      section: 'cellVoltage',
      labelUk: 'Захист від перенапруги',
      labelEn: 'Cell overvoltage protection (OVP)',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.ovpr_v',
      section: 'cellVoltage',
      labelUk: 'Відновлення після перенапруги',
      labelEn: 'Cell overvoltage recovery (OVPR)',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.request_charge_v',
      section: 'cellVoltage',
      labelUk: 'Запитувана напруга заряду',
      labelEn: 'Cell request charge voltage',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.request_float_v',
      section: 'cellVoltage',
      labelUk: 'Запитувана буферна напруга',
      labelEn: 'Cell request float charge voltage',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.soc_100_v',
      section: 'cellVoltage',
      labelUk: 'Напруга 100% заряду (SOC)',
      labelEn: 'Cell 100% SOC voltage',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.soc_0_v',
      section: 'cellVoltage',
      labelUk: 'Напруга 0% заряду (SOC)',
      labelEn: 'Cell 0% SOC voltage',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.start_balance_v',
      section: 'cellVoltage',
      labelUk: 'Початкова напруга балансування',
      labelEn: 'Cell start balance voltage',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.uvpr_v',
      section: 'cellVoltage',
      labelUk: 'Відновлення після низької напруги',
      labelEn: 'Cell undervoltage recovery (UVPR)',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.uvp_v',
      section: 'cellVoltage',
      labelUk: 'Захист від низької напруги',
      labelEn: 'Cell undervoltage protection (UVP)',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.power_off_v',
      section: 'cellVoltage',
      labelUk: 'Напруга вимкнення живлення',
      labelEn: 'Cell power off voltage',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'cell_voltage.smart_sleep_v',
      section: 'cellVoltage',
      labelUk: 'Напруга переходу в смарт-сон',
      labelEn: 'Smart sleep voltage threshold',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },

    // --- 3. BALANCING (4 keys) ---
    {
      key: 'balancing.enabled',
      section: 'balancing',
      labelUk: 'Активне балансування',
      labelEn: 'Active balancer enabled',
      type: 'boolean'
    },
    {
      key: 'balancing.trigger_delta_v',
      section: 'balancing',
      labelUk: 'Поріг різниці напруг (Delta)',
      labelEn: 'Balance trigger voltage delta',
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
      labelUk: 'Поріг початку балансування',
      labelEn: 'Balancer start voltage threshold',
      type: 'voltage',
      maxDecimals: 3,
      unit: 'V'
    },
    {
      key: 'balancing.max_current_a',
      section: 'balancing',
      labelUk: 'Максимальний струм балансування',
      labelEn: 'Max balancing current',
      type: 'number',
      maxDecimals: 1,
      unit: 'A'
    },

    // --- 4. CURRENT LIMITS (9 keys) ---
    {
      key: 'current_limits.max_charge_a',
      section: 'currentLimits',
      labelUk: 'Максимальний струм заряду (OCP)',
      labelEn: 'Continuous charge overcurrent limit',
      type: 'number',
      maxDecimals: 1,
      unit: 'A'
    },
    {
      key: 'current_limits.charge_ocp_delay_s',
      section: 'currentLimits',
      labelUk: 'Затримка захисту заряду',
      labelEn: 'Charge overcurrent protection delay',
      type: 'integer',
      unit: 's'
    },
    {
      key: 'current_limits.charge_ocpr_time_s',
      section: 'currentLimits',
      labelUk: 'Час відновлення заряду',
      labelEn: 'Charge overcurrent recovery time',
      type: 'integer',
      unit: 's'
    },
    {
      key: 'current_limits.max_discharge_a',
      section: 'currentLimits',
      labelUk: 'Максимальний струм розряду (OCP)',
      labelEn: 'Continuous discharge overcurrent limit',
      type: 'number',
      maxDecimals: 1,
      unit: 'A'
    },
    {
      key: 'current_limits.discharge_ocp_delay_s',
      section: 'currentLimits',
      labelUk: 'Затримка захисту розряду',
      labelEn: 'Discharge overcurrent protection delay',
      type: 'integer',
      unit: 's'
    },
    {
      key: 'current_limits.discharge_ocpr_time_s',
      section: 'currentLimits',
      labelUk: 'Час відновлення розряду',
      labelEn: 'Discharge overcurrent recovery time',
      type: 'integer',
      unit: 's'
    },
    {
      key: 'current_limits.scp_delay_us',
      section: 'currentLimits',
      labelUk: 'Затримка захисту від КЗ',
      labelEn: 'Short circuit protection delay',
      type: 'integer',
      unit: 'µs'
    },
    {
      key: 'current_limits.scpr_time_s',
      section: 'currentLimits',
      labelUk: 'Час відновлення після КЗ',
      labelEn: 'Short circuit recovery time',
      type: 'integer',
      unit: 's'
    },
    {
      key: 'current_limits.discharge_precharge_s',
      section: 'currentLimits',
      labelUk: 'Час попереднього заряду',
      labelEn: 'Discharge precharge time',
      type: 'integer',
      unit: 's'
    },

    // --- 5. TEMPERATURE (12 keys across 4 subgroups) ---
    // Subgroup: charge
    {
      key: 'temperature.charge_otp_c',
      section: 'temperature',
      subgroup: 'charge',
      labelUk: 'Перегрів при заряді (OTP)',
      labelEn: 'Charge overtemperature protection',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },
    {
      key: 'temperature.charge_otpr_c',
      section: 'temperature',
      subgroup: 'charge',
      labelUk: 'Відновлення після перегріву заряду',
      labelEn: 'Charge overtemperature recovery',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },
    {
      key: 'temperature.charge_utp_c',
      section: 'temperature',
      subgroup: 'charge',
      labelUk: 'Переохолодження при заряді (UTP)',
      labelEn: 'Charge undertemperature protection',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },
    {
      key: 'temperature.charge_utpr_c',
      section: 'temperature',
      subgroup: 'charge',
      labelUk: 'Відновлення після переохолодження заряду',
      labelEn: 'Charge undertemperature recovery',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },

    // Subgroup: discharge
    {
      key: 'temperature.discharge_otp_c',
      section: 'temperature',
      subgroup: 'discharge',
      labelUk: 'Перегрів при розряді (OTP)',
      labelEn: 'Discharge overtemperature protection',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },
    {
      key: 'temperature.discharge_otpr_c',
      section: 'temperature',
      subgroup: 'discharge',
      labelUk: 'Відновлення після перегріву розряду',
      labelEn: 'Discharge overtemperature recovery',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },
    {
      key: 'temperature.discharge_utp_c',
      section: 'temperature',
      subgroup: 'discharge',
      labelUk: 'Переохолодження при розряді (UTP)',
      labelEn: 'Discharge undertemperature protection',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },
    {
      key: 'temperature.discharge_utpr_c',
      section: 'temperature',
      subgroup: 'discharge',
      labelUk: 'Відновлення після переохолодження розряду',
      labelEn: 'Discharge undertemperature recovery',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },

    // Subgroup: mosfet
    {
      key: 'temperature.mosfet_otp_c',
      section: 'temperature',
      subgroup: 'mosfet',
      labelUk: 'Перегрів ключів MOSFET (OTP)',
      labelEn: 'MOSFET power tube overtemperature protection',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },
    {
      key: 'temperature.mosfet_otpr_c',
      section: 'temperature',
      subgroup: 'mosfet',
      labelUk: 'Відновлення MOSFET після перегріву',
      labelEn: 'MOSFET power tube overtemperature recovery',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },

    // Subgroup: heating
    {
      key: 'temperature.heating_start_c',
      section: 'temperature',
      subgroup: 'heating',
      labelUk: 'Увімкнення підігріву',
      labelEn: 'Heating start temperature',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },
    {
      key: 'temperature.heating_stop_c',
      section: 'temperature',
      subgroup: 'heating',
      labelUk: 'Вимкнення підігріву',
      labelEn: 'Heating stop temperature',
      type: 'temperature',
      maxDecimals: 1,
      unit: '°C'
    },

    // --- 6. SWITCHES (13 keys) ---
    {
      key: 'switches.charge',
      section: 'switches',
      labelUk: 'Ключ заряду (MOSFET)',
      labelEn: 'Charge MOS switch',
      type: 'boolean'
    },
    {
      key: 'switches.discharge',
      section: 'switches',
      labelUk: 'Ключ розряду (MOSFET)',
      labelEn: 'Discharge MOS switch',
      type: 'boolean'
    },
    {
      key: 'switches.balancer',
      section: 'switches',
      labelUk: 'Перемикач балансира',
      labelEn: 'Balancer function switch',
      type: 'boolean'
    },
    {
      key: 'switches.heating',
      section: 'switches',
      labelUk: 'Функція підігріву',
      labelEn: 'Heating function switch',
      type: 'boolean'
    },
    {
      key: 'switches.charging_float_mode',
      section: 'switches',
      labelUk: 'Режим буферного заряду (Float)',
      labelEn: 'Charging float mode switch',
      type: 'boolean'
    },
    {
      key: 'switches.disable_temperature_sensors',
      section: 'switches',
      labelUk: 'Вимкнення датчиків температури',
      labelEn: 'Disable temperature sensors',
      type: 'boolean'
    },
    {
      key: 'switches.display_always_on',
      section: 'switches',
      labelUk: 'Постійно увімкнений дисплей',
      labelEn: 'LCD display always on',
      type: 'boolean'
    },
    {
      key: 'switches.special_charger',
      section: 'switches',
      labelUk: 'Спеціальний зарядний пристрій',
      labelEn: 'Special charger switch',
      type: 'boolean'
    },
    {
      key: 'switches.port_is_rs485',
      section: 'switches',
      labelUk: 'Режим порту зв\'язку RS485',
      labelEn: 'Port communication mode is RS485',
      type: 'boolean'
    },
    {
      key: 'switches.gps_heartbeat',
      section: 'switches',
      labelUk: 'GPS Heartbeat',
      labelEn: 'GPS heartbeat switch',
      type: 'boolean'
    },
    {
      key: 'switches.disable_pcl_module',
      section: 'switches',
      labelUk: 'Вимкнення модуля PCL',
      labelEn: 'Disable PCL module',
      type: 'boolean'
    },
    {
      key: 'switches.timed_stored_data',
      section: 'switches',
      labelUk: 'Періодичний запис даних',
      labelEn: 'Timed stored data switch',
      type: 'boolean'
    },

    // --- 7. SLEEP (2 keys) ---
    {
      key: 'switches.smart_sleep',
      section: 'sleep',
      labelUk: 'Функція смарт-сну',
      labelEn: 'Smart sleep function switch',
      type: 'boolean'
    },
    {
      key: 'sleep.smart_sleep_time_hours',
      section: 'sleep',
      labelUk: 'Час очікування смарт-сну',
      labelEn: 'Smart sleep wait time',
      type: 'integer',
      unit: 'год'
    }
  ];

  function formatAdaptiveNumber(num, maxDecimals = 1) {
    if (maxDecimals === 0) return String(Math.round(num));
    const str = num.toFixed(maxDecimals);
    // Strip trailing zeros after decimal point
    return str.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  }

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
          text: isTrue ? 'Увімкнено' : 'Вимкнено',
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
          unit: spec.unit || '',
          status: 'value'
        };
      }

      return {
        text: String(rawValue),
        unit: spec.unit || '',
        status: 'value'
      };
    },

    formatUptime(seconds) {
      if (seconds === null || seconds === undefined || isNaN(seconds) || seconds < 0) return '—';
      if (seconds === 0) return '0 хв';
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      const parts = [];
      if (days > 0) parts.push(`${days} д`);
      if (hours > 0 || days > 0) parts.push(`${hours} год`);
      if (mins > 0 || (days === 0 && hours === 0)) parts.push(`${mins} хв`);
      return parts.join(' ');
    }
  };

  global.SETTINGS_SECTIONS = SETTINGS_SECTIONS;
  global.SETTINGS_SCHEMA = SETTINGS_SCHEMA;
  global.SettingsNormalizer = SettingsNormalizer;
})(typeof window !== 'undefined' ? window : global);
