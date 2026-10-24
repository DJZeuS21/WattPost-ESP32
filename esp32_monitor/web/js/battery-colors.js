/* battery-colors.js — color interpolation for LiFePO4 / SOC / cells.
 * Direct port of src/lib/batteryColors.ts (vanilla version). */

(function (global) {
  'use strict';

  /** @typedef {{top:[number,number,number],mid:[number,number,number],deep:[number,number,number],val:number}} ColorStop */
  /** @typedef {{top:string,mid:string,deep:string,glow:string,cssGradient:string}} BatteryGradientColors */

  // 1. SOC stops for main battery (100% -> 0%)
  /** @type {ColorStop[]} */
  const SOC_COLOR_STOPS = [
    { val: 100, top: [86, 211, 100],  mid: [46, 160, 67],  deep: [26, 127, 55] },
    { val: 75,  top: [136, 218, 75],  mid: [82, 172, 45],  deep: [42, 110, 28] },
    { val: 50,  top: [205, 205, 52],  mid: [160, 154, 25], deep: [95, 88, 15] },
    { val: 35,  top: [228, 175, 50],  mid: [180, 122, 22], deep: [110, 68, 12] },
    { val: 20,  top: [242, 128, 55],  mid: [195, 78, 25],  deep: [125, 38, 12] },
    { val: 10,  top: [248, 85, 75],   mid: [205, 32, 42],  deep: [128, 8, 26] },
    { val: 0,   top: [215, 50, 50],   mid: [160, 12, 32],  deep: [85, 3, 16] }
  ];

  // 2. LiFePO4 Voltage stops for individual cell bars
  /** @type {ColorStop[]} */
  const LIFEPO4_VOLTAGE_STOPS = [
    { val: 3.40, top: [86, 211, 100],  mid: [46, 160, 67],  deep: [26, 127, 55] },
    { val: 3.20, top: [88, 211, 98],   mid: [48, 161, 65],  deep: [27, 127, 54] },
    { val: 3.15, top: [136, 218, 75],  mid: [82, 172, 45],  deep: [42, 110, 28] },
    { val: 3.14, top: [175, 212, 58],  mid: [122, 160, 32], deep: [66, 96, 18] },
    { val: 3.10, top: [228, 175, 50],  mid: [180, 122, 22], deep: [110, 68, 12] },
    { val: 3.05, top: [240, 138, 50],  mid: [192, 88, 22],  deep: [120, 45, 12] },
    { val: 3.00, top: [244, 98, 56],   mid: [198, 52, 26],  deep: [125, 22, 14] },
    { val: 2.90, top: [215, 50, 50],   mid: [160, 12, 32],  deep: [85, 3, 16] }
  ];

  /**
   * Universal continuous color stop interpolator.
   * @param {number} value
   * @param {ColorStop[]} stops
   * @returns {BatteryGradientColors}
   */
  function interpolateColorStops(value, stops) {
    const minVal = stops[stops.length - 1].val;
    const maxVal = stops[0].val;
    const clamped = Math.max(minVal, Math.min(maxVal, value));

    let s1 = stops[0];
    let s2 = stops[stops.length - 1];

    for (let i = 0; i < stops.length - 1; i++) {
      if (clamped <= stops[i].val && clamped >= stops[i + 1].val) {
        s1 = stops[i];
        s2 = stops[i + 1];
        break;
      }
    }

    const range = s1.val - s2.val;
    const t = range === 0 ? 0 : (clamped - s2.val) / range;

    const interp = (c1, c2) => {
      const r = Math.round(c2[0] + t * (c1[0] - c2[0]));
      const g = Math.round(c2[1] + t * (c1[1] - c2[1]));
      const b = Math.round(c2[2] + t * (c1[2] - c2[2]));
      return `rgb(${r},${g},${b})`;
    };

    const top = interp(s1.top, s2.top);
    const mid = interp(s1.mid, s2.mid);
    const deep = interp(s1.deep, s2.deep);

    const r = Math.round(s2.top[0] + t * (s1.top[0] - s2.top[0]));
    const g = Math.round(s2.top[1] + t * (s1.top[1] - s2.top[1]));
    const b = Math.round(s2.top[2] + t * (s1.top[2] - s2.top[2]));
    const glow = `rgba(${r},${g},${b},0.45)`;

    const cssGradient = `linear-gradient(to bottom, ${top} 0%, ${mid} 50%, ${deep} 100%)`;

    return { top, mid, deep, glow, cssGradient };
  }

  function getSocColors(soc) { return interpolateColorStops(soc, SOC_COLOR_STOPS); }
  function getCellVoltageColors(voltage) { return interpolateColorStops(voltage, LIFEPO4_VOLTAGE_STOPS); }

  /**
   * Continuous 3-stop relative gradient interpolator based on deltaMv from median.
   * Direct port of CellBalance.tsx getCellRelativeColors.
   */
  function getCellRelativeColors(deltaMv) {
    const absDelta = Math.abs(deltaMv);
    const deadband = 2;
    const fullDev = 50;

    const gTop = [86, 211, 100];
    const gMid = [46, 160, 67];
    const gDeep = [26, 127, 55];

    const wTop = [248, 81, 73];
    const wMid = [195, 50, 45];
    const wDeep = [120, 15, 20];

    const cTop = [88, 166, 255];
    const cMid = [31, 111, 235];
    const cDeep = [17, 60, 130];

    if (absDelta <= deadband) {
      const top = `rgb(${gTop.join(',')})`;
      const mid = `rgb(${gMid.join(',')})`;
      const deep = `rgb(${gDeep.join(',')})`;
      return {
        top, mid, deep,
        glow: 'rgba(86,211,100,0.45)',
        cssGradient: `linear-gradient(to bottom, ${top} 0%, ${mid} 50%, ${deep} 100%)`
      };
    }

    const t = Math.min(1, (absDelta - deadband) / (fullDev - deadband));
    const targetTop = deltaMv < 0 ? wTop : cTop;
    const targetMid = deltaMv < 0 ? wMid : cMid;
    const targetDeep = deltaMv < 0 ? wDeep : cDeep;

    const interp = (g, target) => [
      Math.round(g[0] + t * (target[0] - g[0])),
      Math.round(g[1] + t * (target[1] - g[1])),
      Math.round(g[2] + t * (target[2] - g[2]))
    ];

    const topArr = interp(gTop, targetTop);
    const midArr = interp(gMid, targetMid);
    const deepArr = interp(gDeep, targetDeep);

    const top = `rgb(${topArr.join(',')})`;
    const mid = `rgb(${midArr.join(',')})`;
    const deep = `rgb(${deepArr.join(',')})`;
    const glow = `rgba(${topArr.join(',')},0.45)`;

    return {
      top, mid, deep, glow,
      cssGradient: `linear-gradient(to bottom, ${top} 0%, ${mid} 50%, ${deep} 100%)`
    };
  }

  global.BatteryColors = {
    SOC_COLOR_STOPS,
    LIFEPO4_VOLTAGE_STOPS,
    interpolateColorStops,
    getSocColors,
    getCellVoltageColors,
    getCellRelativeColors
  };
})(window);
