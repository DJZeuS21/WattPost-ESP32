/* dashboard.js — Dashboard view logic for real JK BMS telemetry.
 * Connects to ApiClient / DataNormalizer. Renders hero, top KPI cards, dynamic cell balance and temperature sensors. */

(function (global) {
  'use strict';

  const { getSocColors, getCellRelativeColors } = global.BatteryColors;
  const EnergyFlow = global.EnergyFlow;
  const STATE_COLORS_LOOKUP = global.STATE_COLORS;
  // Shared zoom-preserving chart update (implemented in charts.js — single source;
  // local copies of this logic previously drifted between dashboard and history).
  const updateChartPreservingZoom = global.WattCharts.updateChartPreservingZoom;

  const SPREAD_WARN_STORAGE_KEY = 'wattpost_spread_warning_threshold_mv';
  const DEFAULT_SPREAD_WARN_MV = 15;
  const MIN_SPREAD_WARN_MV = 1;
  const MAX_SPREAD_WARN_MV = 29;

  // Single source of truth for the user-configured cell-spread warning threshold.
  // Dashboard owns the UI + persistence; other views (e.g. history.js) must read
  // through global.WattSpreadThreshold.read() instead of touching localStorage
  // directly with their own fallback values.
  function readSpreadWarnThresholdMv() {
    try {
      const saved = localStorage.getItem(SPREAD_WARN_STORAGE_KEY);
      if (saved !== null) {
        const val = parseInt(saved, 10);
        if (Number.isFinite(val) && val >= MIN_SPREAD_WARN_MV && val <= MAX_SPREAD_WARN_MV) {
          return val;
        }
      }
    } catch (e) {}
    return DEFAULT_SPREAD_WARN_MV;
  }
  global.WattSpreadThreshold = {
    read: readSpreadWarnThresholdMv,
    DEFAULT_MV: DEFAULT_SPREAD_WARN_MV
  };

  function formatEta(hours) {
    if (!Number.isFinite(hours) || hours < 0) return null;
    const totalMins = Math.round(hours * 60);
    if (totalMins < 60) {
      return `${totalMins} хв`;
    }
    if (totalMins < 24 * 60) {
      const h = Math.floor(totalMins / 60);
      const m = totalMins % 60;
      return m > 0 ? `${h} год ${m} хв` : `${h} год`;
    }
    const totalHours = Math.round(hours);
    const d = Math.floor(totalHours / 24);
    const remH = totalHours % 24;
    return remH > 0 ? `${d} д ${remH} год` : `${d} д`;
  }

  function computeDirectionalEta(state, data, smoothedCurrent) {
    const isCharging = state === 'charging';
    const isDischarging = state === 'discharging';
    if ((!isCharging && !isDischarging) || !data) return '';

    const remainingAh = data.remaining_capacity_ah != null ? Number(data.remaining_capacity_ah) : null;
    const nominalAh = data.nominal_capacity_ah != null ? Number(data.nominal_capacity_ah) : null;
    const displayedSoc = data.soc != null ? Math.round(Number(data.soc)) : null;
    const isFull = displayedSoc != null && displayedSoc >= 100;

    if (isCharging) {
      const hasCapacity = nominalAh != null && remainingAh != null && nominalAh > 0;
      const neededAh = hasCapacity ? Math.max(0, nominalAh - remainingAh) : null;
      const isFullyCharged = isFull || (hasCapacity && neededAh <= 0);

      if (isFullyCharged) {
        return 'Заряджено';
      }
      if (smoothedCurrent > 0.05 && hasCapacity) {
        const hoursToFull = neededAh / smoothedCurrent;
        const totalMins = Math.round(hoursToFull * 60);
        if (totalMins <= 0) {
          return 'Заряджено';
        }
        const etaText = formatEta(hoursToFull);
        return etaText ? `≈ ${etaText}` : '';
      }
      return '';
    }

    if (isDischarging && smoothedCurrent > 0.05) {
      if (remainingAh != null && remainingAh > 0) {
        const hoursToEmpty = remainingAh / smoothedCurrent;
        const etaText = formatEta(hoursToEmpty);
        return etaText ? `≈ ${etaText}` : '';
      }
    }

    return '';
  }

  class Dashboard {
    constructor() {
      this.liveData = null;
      this.historyRecords = [];
      this._history24h = [];
      this.historyState = 'INITIAL_LOADING';
      this._historyLoadingActive = false;
      this.connectivityState = 'INITIAL_LOADING';

      // Cell spread warning threshold (UI state)
      this.spreadWarningThresholdMv = readSpreadWarnThresholdMv();

      // Energy flow module
      this.energyFlow = null;

      // Chart instances
      this.chargeChart = null;
      this.dischargeChart = null;
      this.temperatureChart = null;
      this.trendChart = null;

      this._unsubscribeLive = null;
      this._unsubscribeHistory = null;

      // Liquid wave animation rate controller
      this._liquidPlaybackRate = 1.0;
      this._liquidTargetRate = null;
      this._liquidAnimRaf = null;

      // ETA calculation current smoothing
      this._etaCurrentHistory = [];
      this._lastEtaState = null;

      // Visual state tracking for Hero periphery transitions
      this._lastHeroState = 'idle';
      this._wattResetTimer = null;
      this._wattTransitions = { charge: null, discharge: null };
      // Last watt value WRITTEN to the DOM per side (charge/discharge). Maintained
      // by the watt transition lifecycle (_trackWattShown) so new transitions can
      // start from the displayed value without reading it back from the DOM.
      this._wattShown = { charge: 0, discharge: 0 };
      this._capsuleTargetState = 'idle';
      this._capsuleCurrentState = 'idle';
      this._capsulePhase = 'idle';
      this._capsuleSeqId = 0;
      this._capsuleTimers = [];

      // Responsive Hero layout observer. Layout transforms live on outer SVG
      // wrappers so the existing inner animation coordinates remain canonical.
      this._heroLayoutObserver = null;
      this._heroLayoutResizeHandler = null;
    }

    init() {
      const root = document.getElementById('view-dashboard');
      this.root = root;

      // Init threshold stepper UI and listeners
      this._initThresholdControls();
      this._updateThresholdUI();

      // Init energy flow
      const svg = document.getElementById('energy-flow-svg');
      if (svg) {
        this.energyFlow = new EnergyFlow(svg);
        this.energyFlow.setState('idle', 0);
      }
      this._initHeroResponsiveLayout();

      // Build charts
      this._buildCharts();

      // Subscribe to API Client
      if (global.ApiClient) {
        this._unsubscribeLive = global.ApiClient.onLive((data, state) => {
          this.updateLive(data, state);
        });

        this._unsubscribeHistory = global.ApiClient.onHistory((history, state) => {
          this.updateHistory(history, state);
        });

        if (typeof global.ApiClient.onHistoryLoading === 'function') {
          this._unsubscribeHistoryLoading = global.ApiClient.onHistoryLoading((state) => {
            this._historyLoadingActive = Boolean(state && state.active);
            this._updateHistoryAvailabilityLabel();
          });
        }
      }
    }

    _initHeroResponsiveLayout() {
      const card = document.getElementById('hero-card');
      const svg = document.getElementById('energy-flow-svg');
      const flowLayout = document.getElementById('flow-layout');
      const inputLayout = document.getElementById('input-layout');
      const outputLayout = document.getElementById('output-layout');
      const batteryLayout = document.getElementById('battery-layout');
      const etaLayout = document.getElementById('eta-layout');
      if (!card || !svg || !flowLayout || !inputLayout || !outputLayout || !batteryLayout || !etaLayout) return;
      if (this._heroLayoutObserver || this._heroLayoutResizeHandler) return;

      // Sample the original path once in its own coordinates. Wide layouts put
      // charge below its crest and discharge above its trough, including icons
      // and current, instead of lifting both sides across the charge curve.
      const track = document.getElementById('flow-base-track');
      const trackLength = track.getTotalLength();
      const trackPoints = Array.from({ length: 601 }, (_, i) =>
        track.getPointAtLength(trackLength * i / 600));
      let lastWidth = 0;

      const setScaledSlot = (slot, scale, anchorX, anchorY, targetX, targetY) => {
        const tx = targetX - scale * anchorX;
        const ty = targetY - scale * anchorY;
        slot.setAttribute(
          'transform',
          `matrix(${scale.toFixed(5)} 0 0 ${scale.toFixed(5)} ${tx.toFixed(3)} ${ty.toFixed(3)})`
        );
      };

      const applyLayout = () => {
        const width = card.clientWidth;
        if (!Number.isFinite(width) || width <= 0 || width === lastWidth) return;
        lastWidth = width;

        // Three explicit regimes:
        // - phone: stacked composition with independently placed blocks;
        // - tablet/desktop: canonical curve/battery geometry, with continuous
        //   text sizing and enough clearance on each side of the curve.
        // Breakpoints are based on the actual Hero content width, not viewport.
        const svgScale = width / 1200;
        const wideProgress = Math.min(1, Math.max(0, (width - 900) / 300));
        const metricScreenScale = width < 740 ? 0.875 : Math.max(0.875, svgScale);
        const labelPx = Math.max(14, 14 * svgScale);
        const unitPx = width < 1200 ? 14 + 10 * wideProgress : 24 * svgScale;
        card.style.setProperty('--hero-label-font', `${labelPx / metricScreenScale}px`);
        card.style.setProperty('--hero-unit-font', `${unitPx / metricScreenScale}px`);
        card.style.setProperty('--hero-soc-font', `${54 - 6 * wideProgress}px`);
        card.style.setProperty('--hero-soc-unit-font', `${24 - 2 * wideProgress}px`);

        // Canonical phone geometry. The same screen-space typography targets
        // are reused by tablet so the responsive switch does not resize values.
        const phoneHeightPx = Math.max(320, Math.min(340, width * 0.88));
        const phoneViewBoxHeight = phoneHeightPx / svgScale;
        const metricScale = metricScreenScale / svgScale;
        const phoneBatteryScale = 78 / (140 * svgScale);
        const etaScale = 15 / (18 * svgScale);
        const phoneBatteryCenterY = (phoneHeightPx * 0.25) / svgScale;
        // Keep 14px of air below the battery, including the taller ETA capsule.
        const phoneEtaCenterY = phoneBatteryCenterY + 110 * phoneBatteryScale +
          (14 + 28 * (15 / 18) / 2) / svgScale;
        const phoneMetricCenterY = (phoneHeightPx - 67) / svgScale;

        if (width >= 740) {
          card.setAttribute('data-hero-layout', width >= 900 ? 'desktop' : 'tablet');

          // Enter the wide composition only once there is enough horizontal room
          // for it to be valid. Below this point the phone composition is safer
          // and clearer than a half-transition where text intersects the curve.
          const tabletHeightPx = Math.max(340, width * 390 / 1200);
          const tabletViewBoxHeight = tabletHeightPx / svgScale;
          svg.setAttribute(
            'viewBox',
            `0 ${((440 - tabletViewBoxHeight) / 2).toFixed(3)} 1200 ${tabletViewBoxHeight.toFixed(3)}`
          );

          const curveYs = x => trackPoints
            .filter(point => Math.abs(point.x - x) <= 70 * metricScreenScale / svgScale)
            .map(point => point.y);
          const inputY = Math.max(230,
            Math.max(...curveYs(276)) + (72 * metricScreenScale + 8) / svgScale);
          const outputY = Math.min(230,
            Math.min(...curveYs(916)) - (64 * metricScreenScale + 4 + 8) / svgScale);
          setScaledSlot(inputLayout, metricScale, 276, 230, 276, inputY);
          setScaledSlot(outputLayout, metricScale, 916, 230, 916, outputY);

          flowLayout.removeAttribute('transform');
          batteryLayout.removeAttribute('transform');
          setScaledSlot(etaLayout, etaScale, 600, 386, 600, 386);
          return;
        }

        card.setAttribute('data-hero-layout', 'mobile');
        svg.setAttribute('viewBox', `0 0 1200 ${phoneViewBoxHeight.toFixed(3)}`);

        // The curve must meet the same part of the battery on a wide phone too.
        setScaledSlot(flowLayout, 1, 600, 222, 600, phoneBatteryCenterY);
        setScaledSlot(inputLayout, metricScale, 276, 230, 300, phoneMetricCenterY);
        setScaledSlot(outputLayout, metricScale, 916, 235, 900, phoneMetricCenterY);
        setScaledSlot(batteryLayout, phoneBatteryScale, 600, 250, 600, phoneBatteryCenterY);
        setScaledSlot(etaLayout, etaScale, 600, 386, 600, phoneEtaCenterY);
      };

      this._heroLayoutResizeHandler = applyLayout;
      if (typeof global.addEventListener === 'function') {
        global.addEventListener('resize', this._heroLayoutResizeHandler);
      }
      if (typeof global.ResizeObserver === 'function') {
        this._heroLayoutObserver = new global.ResizeObserver(() => applyLayout());
        this._heroLayoutObserver.observe(card);
      }

      applyLayout();
    }

    setSpreadWarningThreshold(val) {
      const clamped = Math.max(MIN_SPREAD_WARN_MV, Math.min(MAX_SPREAD_WARN_MV, Math.round(val)));
      this.spreadWarningThresholdMv = clamped;
      try {
        localStorage.setItem(SPREAD_WARN_STORAGE_KEY, String(clamped));
      } catch (e) {}

      this._updateThresholdUI();

      // Immediately re-evaluate live states if liveData is present
      if (this.liveData && this.liveData.online) {
        this._renderLiveState(this.liveData);
      }

      // Update trend chart domain and redraw reference lines
      if (this.trendChart) {
        if (this._history24h && this._history24h.length) {
          const trendData = this._history24h.map(r => r.spread_mv ?? null);
          global.WattCharts.applyYAxisDomain(this.trendChart, 'cell_spread', trendData, {
            unit: 'mV',
            decimals: 0,
            referenceValues: [this.spreadWarningThresholdMv]
          });
        }
        this.trendChart.update('none');
      }
    }

    _initThresholdControls() {
      const btnDec = document.getElementById('btn-spread-threshold-dec');
      const btnInc = document.getElementById('btn-spread-threshold-inc');
      if (btnDec) {
        btnDec.addEventListener('click', (e) => {
          e.preventDefault();
          this.setSpreadWarningThreshold(this.spreadWarningThresholdMv - 1);
        });
      }
      if (btnInc) {
        btnInc.addEventListener('click', (e) => {
          e.preventDefault();
          this.setSpreadWarningThreshold(this.spreadWarningThresholdMv + 1);
        });
      }
    }

    _updateThresholdUI() {
      const valEl = document.getElementById('spread-threshold-val');
      const btnDec = document.getElementById('btn-spread-threshold-dec');
      const btnInc = document.getElementById('btn-spread-threshold-inc');

      if (valEl) valEl.textContent = `${this.spreadWarningThresholdMv} mV`;
      if (btnDec) btnDec.disabled = (this.spreadWarningThresholdMv <= MIN_SPREAD_WARN_MV);
      if (btnInc) btnInc.disabled = (this.spreadWarningThresholdMv >= MAX_SPREAD_WARN_MV);
    }

    destroy() {
      if (this._heroLayoutObserver) {
        this._heroLayoutObserver.disconnect();
        this._heroLayoutObserver = null;
      }
      if (this._heroLayoutResizeHandler) {
        global.removeEventListener('resize', this._heroLayoutResizeHandler);
        this._heroLayoutResizeHandler = null;
      }
      if (this._liquidAnimRaf) {
        cancelAnimationFrame(this._liquidAnimRaf);
        this._liquidAnimRaf = null;
      }
      this._cancelWattTransition('charge');
      this._cancelWattTransition('discharge');
      if (this._unsubscribeLive) this._unsubscribeLive();
      if (this._unsubscribeHistory) this._unsubscribeHistory();
      if (this._unsubscribeHistoryLoading) this._unsubscribeHistoryLoading();
      [this.chargeChart, this.dischargeChart, this.temperatureChart, this.trendChart].forEach(c => c && c.destroy());
      if (this.energyFlow) this.energyFlow.destroy();
      if (global.WattCharts && global.WattCharts.dismissPinnedChart) {
        global.WattCharts.dismissPinnedChart();
      }
      if (global.WattCharts && global.WattCharts.hideTooltip) {
        global.WattCharts.hideTooltip();
      }
    }

    updateLive(data, connectivityState) {
      this.liveData = data;
      this.connectivityState = connectivityState || 'FRESH';

      // DEV override hook for Hero animation QA — checked BEFORE the offline branch so
      // animations can be tested on a bench without ESP32 (the offline render would
      // otherwise overwrite the QA state every poll cycle).
      if (this.heroDevOverride && this.heroDevOverride.active) {
        const devData = this.heroDevOverride.getOverriddenData(data);
        this._renderLiveState(devData);
        return;
      }

      if (!data || !data.online) {
        this._renderOfflineState(data ? data.message : 'Немає зв’язку з BMS');
        return;
      }

      if (data.is_stale === true) {
        this._renderStaleState(data);
        return;
      }

      this._renderLiveState(data);
    }

    _renderStaleState(data) {
      this._renderLiveState({ ...data, state: 'idle', is_stale: true });
    }

    applyHeroDevOverride() {
      if (!this.heroDevOverride || !this.heroDevOverride.active) {
        if (this.liveData && this.liveData.online) {
          this._renderLiveState(this.liveData);
        } else {
          this._renderOfflineState('Немає зв’язку з BMS');
        }
        return;
      }
      const devData = this.heroDevOverride.getOverriddenData(this.liveData || {});
      this._renderLiveState(devData);
    }

    updateHistory(historyRecords, historyState) {
      this.historyRecords = Array.isArray(historyRecords) ? historyRecords : [];
      this.historyState = historyState || this.historyState;
      this._updateHistoryAvailabilityLabel();
      this._refreshHistoryPanels();
    }

    _updateHistoryAvailabilityLabel() {
      const hasHistory = this.historyRecords.length > 0;
      let text = 'останні 24 год';
      if (hasHistory && this.historyState === 'STALE') text = 'збережена історія · дані можуть бути неповними';
      if (!hasHistory) {
        text = this._historyLoadingActive || this.historyState === 'INITIAL_LOADING'
          ? 'завантаження історії…'
          : 'історія недоступна';
      }

      ['charging-panel', 'discharging-panel', 'temperature-panel'].forEach(id => {
        const panel = document.getElementById(id);
        const label = panel && panel.querySelector('.panel-subtext');
        if (label) label.textContent = text;
      });
    }

    _renderOfflineState(message) {
      const colors = STATE_COLORS_LOOKUP['idle'];

      // Update ambient spot
      const bgSpot = document.getElementById('bg-spot-primary');
      if (bgSpot) bgSpot.style.background = 'radial-gradient(ellipse, rgba(48,54,61,0.12), transparent 70%)';

      const heroCard = document.getElementById('hero-card');
      if (heroCard) {
        heroCard.setAttribute('data-hero-state', 'idle');
      }

      // Hero
      this._updateDirectionalEta('idle', '');
      const inputCurr = document.getElementById('input-current');
      const outputCurr = document.getElementById('output-current');
      if (inputCurr) {
        inputCurr.classList.remove('is-visible');
        inputCurr.textContent = '';
        if (inputCurr.style.opacity !== '') inputCurr.style.opacity = '';
        if (inputCurr.style.transition !== '') inputCurr.style.transition = '';
      }
      if (outputCurr) {
        outputCurr.classList.remove('is-visible');
        outputCurr.textContent = '';
        if (outputCurr.style.opacity !== '') outputCurr.style.opacity = '';
        if (outputCurr.style.transition !== '') outputCurr.style.transition = '';
      }

      this._etaCurrentHistory = [];
      this._lastEtaState = null;

      const socText = document.getElementById('battery-soc');
      if (socText && socText.firstChild) socText.firstChild.nodeValue = '—';
      this._setLiquidAnimationPlayback(false);

      const batteryPulse = document.getElementById('battery-pulse');
      if (batteryPulse) {
        batteryPulse.style.opacity = '0.05';
        batteryPulse.style.animation = '';
      }

      // NOTE: circle/icon/label colors are NOT re-asserted here — data-hero-state
      // 'idle' (set below) drives them via styles.css (single source of truth).
      const inputPower = document.getElementById('input-power');
      if (inputPower) {
        const num = inputPower.querySelector('.watt-number');
        if (num) num.textContent = '0';
        else if (inputPower.firstChild && inputPower.firstChild.nodeType === Node.TEXT_NODE) inputPower.firstChild.nodeValue = '0';
        inputPower.removeAttribute('fill');
        inputPower.style.fill = '';
        this._trackWattShown('charge', 0);
      }
      const outputPower = document.getElementById('output-power');
      if (outputPower) {
        const num = outputPower.querySelector('.watt-number');
        if (num) num.textContent = '0';
        else if (outputPower.firstChild && outputPower.firstChild.nodeType === Node.TEXT_NODE) outputPower.firstChild.nodeValue = '0';
        outputPower.removeAttribute('fill');
        outputPower.style.fill = '';
        this._trackWattShown('discharge', 0);
      }

      if (this._wattResetTimer) {
        clearTimeout(this._wattResetTimer);
        this._wattResetTimer = null;
      }
      this._resetWattToIdle('charge');
      this._resetWattToIdle('discharge');
      // NOTE: do NOT call _clearCapsuleTimers() here. _updateDirectionalEta('idle', ...)
      // above schedules the collapse choreography and clears stale timers internally
      // before scheduling. Clearing again would kill the pending steps and freeze the
      // capsule in 'collapsing' forever (the idempotency guard blocks a restart).
      this._lastHeroState = 'idle';
      if (heroCard) heroCard.setAttribute('data-hero-state', 'idle');

      if (this.energyFlow) this.energyFlow.setState('idle', 0);

      // KPI cards
      this._updateMetricCard('voltage',     { value: '—', unit: 'V',  active: false });
      this._updateMetricCard('remaining',   { value: '—', unit: 'Ah', active: false });
      this._updateMetricCard('temperature', { value: '—', unit: '°C', active: false });
      this._updateMetricCard('spread',      { value: '—', unit: 'mV', active: false });

      // Keep the canonical empty cell and temperature panels visible when the
      // local API has no fresh BMS sample, matching the shared stale model.
      this._renderLiveCells({ valid: false, list: [] }, 0);
      this._renderLiveSensors([]);

      // Reset history/trend stats to unavailable placeholder if no valid history cache exists
      if (!this.historyRecords || !this.historyRecords.length) {
        const resetIds = [
          'charge-avg', 'charge-peak', 'charge-time', 'charge-yesterday',
          'discharge-avg', 'discharge-peak', 'discharge-time', 'discharge-yesterday',
          'trend-current', 'trend-max', 'trend-avg'
        ];
        resetIds.forEach(id => {
          const el = document.getElementById(id);
          if (el) el.textContent = '—';
        });
        const cEnergy = document.getElementById('charge-energy');
        if (cEnergy) cEnergy.textContent = '0.0';
        const dEnergy = document.getElementById('discharge-energy');
        if (dEnergy) dEnergy.textContent = '0.0';
        const spreadBadgeVal = document.querySelector('#spread-badge .spread-value');
        if (spreadBadgeVal) spreadBadgeVal.textContent = 'Δ —';
      }
    }

    _renderLiveState(data) {
      const isStale = data.is_stale === true;
      const state = isStale ? 'idle' : data.state;
      const colors = STATE_COLORS_LOOKUP[state] || STATE_COLORS_LOOKUP['idle'];
      const power = isStale ? 0 : (data.abs_power_w || 0);
      const hasSoc = data.soc != null && Number.isFinite(Number(data.soc));
      const soc = hasSoc ? Number(data.soc) : 0;
      const isCharging = state === 'charging';
      const isDischarging = state === 'discharging';
      const isActive = state !== 'idle';

      // Background spots & glow
      const bgPrimary = colors.bg.replace('0.06', '0.12').replace('0.04', '0.08');
      const heroGlow = colors.glow.replace('0.45', '0.15');

      const bgSpot = document.getElementById('bg-spot-primary');
      if (bgSpot) bgSpot.style.background = `radial-gradient(ellipse, ${bgPrimary}, transparent 70%)`;

      const prevHeroState = this._lastHeroState || 'idle';
      this._lastHeroState = state;

      // Handle Watt text value updates with smooth lifecycle coordination.
      // The currently displayed watt value is tracked in _wattShown by the watt
      // transition lifecycle itself (single writer) — no DOM read-back needed.

      if (isStale) {
        this._clearCapsuleTimers();
        this._cancelWattTransition('charge');
        this._cancelWattTransition('discharge');
      } else if (state === 'idle') {
        if (prevHeroState !== 'idle') {
          // ACTIVE -> IDLE: Trigger Energy Collapse on the outgoing active side
          if (prevHeroState === 'charging') {
            const curVal = this._getWattShown('charge');
            if (curVal > 0) {
              this._startEnergyCollapse('charge', curVal);
            } else {
              this._resetWattToIdle('charge');
            }
            this._resetWattToIdle('discharge');
          } else if (prevHeroState === 'discharging') {
            const curVal = this._getWattShown('discharge');
            if (curVal > 0) {
              this._startEnergyCollapse('discharge', curVal);
            } else {
              this._resetWattToIdle('discharge');
            }
            this._resetWattToIdle('charge');
          }
        } else {
          // Already settled in IDLE - only reset if no transition is actively running
          if (!this._wattTransitions || !this._wattTransitions['charge']) {
            this._resetWattToIdle('charge');
          }
          if (!this._wattTransitions || !this._wattTransitions['discharge']) {
            this._resetWattToIdle('discharge');
          }
        }
      } else {
        // Target: CHARGING or DISCHARGING
        const activeWattStr = String(Math.round(power));

        if (isCharging) {
          // Incoming: Charge side
          const wasChargeIdle = (prevHeroState !== 'charging');
          this._setWattActive('charge', activeWattStr, '#56d364', wasChargeIdle);

          // Outgoing: Discharge side (if previous was discharging and had nonzero power)
          if (prevHeroState === 'discharging') {
            const curOutVal = this._getWattShown('discharge');
            if (curOutVal > 0) {
              this._startEnergyCollapse('discharge', curOutVal);
            } else {
              this._resetWattToIdle('discharge');
            }
          } else {
            if (!this._wattTransitions || !this._wattTransitions['discharge']) {
              this._resetWattToIdle('discharge');
            }
          }
        } else if (isDischarging) {
          // Incoming: Discharge side
          const wasDischargeIdle = (prevHeroState !== 'discharging');
          this._setWattActive('discharge', activeWattStr, '#9d8dff', wasDischargeIdle);

          // Outgoing: Charge side (if previous was charging and had nonzero power)
          if (prevHeroState === 'charging') {
            const curInVal = this._getWattShown('charge');
            if (curInVal > 0) {
              this._startEnergyCollapse('charge', curInVal);
            } else {
              this._resetWattToIdle('charge');
            }
          } else {
            if (!this._wattTransitions || !this._wattTransitions['charge']) {
              this._resetWattToIdle('charge');
            }
          }
        }
      }

      const heroCard = document.getElementById('hero-card');
      if (heroCard) {
        heroCard.setAttribute('data-hero-state', state);
      }

      const heroAmbient = document.getElementById('hero-ambient-glow');
      if (heroAmbient) heroAmbient.style.background = `radial-gradient(circle, ${heroGlow}, transparent 70%)`;

      // Metric cards
      const vVal = data.voltage_v != null ? data.voltage_v.toFixed(2) : '—';
      const rVal = data.remaining_capacity_ah != null ? String(Math.round(data.remaining_capacity_ah)) : '—';
      const tVal = (data.temperatures && data.temperatures.summary_c != null) ? data.temperatures.summary_c.toFixed(1) : '—';
      const spreadMv = (data.cells && data.cells.spread_mv != null && Number.isFinite(data.cells.spread_mv))
        ? data.cells.spread_mv
        : null;
      const sVal = spreadMv != null ? String(spreadMv) : '—';
      const isSpreadWarn = spreadMv != null && spreadMv > this.spreadWarningThresholdMv;

      this._updateMetricCard('voltage',     { value: vVal, unit: 'V',  accent: colors.primary, glow: colors.glow, active: isActive });
      this._updateMetricCard('remaining',   { value: rVal, unit: 'Ah', accent: colors.primary, glow: colors.glow, active: isActive });
      this._updateMetricCard('temperature', { value: tVal, unit: '°C', accent: colors.primary, glow: colors.glow, active: isActive, warn: Number(tVal) > 40 });
      this._updateMetricCard('spread',      { value: sVal, unit: 'mV', accent: colors.primary, glow: colors.glow, active: isActive, warn: isSpreadWarn });

      // Battery liquid level & wave colors. When the displayed SoC reaches 100%,
      // switch to a dedicated static-full state instead of freezing a wave at an
      // arbitrary animation phase. The flat fill then covers the entire inner cell.
      const socColors = getSocColors(soc);
      const displayedSoc = hasSoc ? Math.round(soc) : '—';
      const isFull = displayedSoc >= 100;
      const liquidTop = 148 + 210 * (1 - soc / 100);
      const liquidFill = document.getElementById('liquid-fill');
      if (liquidFill) {
        if (soc <= 2) {
          liquidFill.style.display = 'none';
        } else {
          liquidFill.style.display = '';
          liquidFill.setAttribute('y', isFull ? 148 : liquidTop + 6);
          liquidFill.setAttribute('height', isFull ? 210 : 210 * (soc / 100) + 10);
        }
      }

      const liquidClip = document.getElementById('liquid-level-clip-rect');
      if (liquidClip) {
        liquidClip.setAttribute('y', isFull ? 148 : liquidTop - 2);
        liquidClip.setAttribute('height', isFull ? 210 : 210 * (soc / 100) + 15);
      }

      ['wave-layer-1', 'wave-layer-2', 'wave-layer-3'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          if (soc <= 0) {
            el.style.display = 'none';
            el.style.opacity = '0';
          } else {
            // Keep the same wave DOM alive at 100% so it can fade out while the
            // flat fill rises to the top. This avoids a visible state swap/flash.
            el.style.display = '';
            el.style.opacity = isFull ? '0' : '1';
            el.setAttribute('transform', `translate(536, ${liquidTop})`);
          }
        }
      });

      // NOTE: #bubble-group visibility is owned exclusively by EnergyFlow.setState(state, power, soc).
      // The old local write here was unconditionally overridden by setState later in this method,
      // which made the `soc > 5` condition dead code — do not reintroduce it.

      const stop0 = document.getElementById('grad-soc-stop-0');
      const stop50 = document.getElementById('grad-soc-stop-50');
      const stop100 = document.getElementById('grad-soc-stop-100');
      if (stop0) stop0.setAttribute('stop-color', socColors.deep);
      if (stop50) stop50.setAttribute('stop-color', socColors.mid);
      if (stop100) stop100.setAttribute('stop-color', socColors.top);

      const waveAStroke = document.getElementById('wave-a-stroke');
      if (waveAStroke) {
        waveAStroke.setAttribute('stroke', socColors.top);
        waveAStroke.style.filter = `drop-shadow(0 0 3px ${socColors.glow})`;
      }
      const waveAFill = document.getElementById('wave-a-fill');
      if (waveAFill) waveAFill.setAttribute('fill', 'url(#grad-soc-liquid)');
      const waveBPath = document.getElementById('wave-b-path');
      if (waveBPath) waveBPath.setAttribute('fill', socColors.top);
      const waveCPath = document.getElementById('wave-c-path');
      if (waveCPath) waveCPath.setAttribute('fill', socColors.top);

      // Hero SoC & labels
      const socText = document.getElementById('battery-soc');
      if (socText && socText.firstChild) socText.firstChild.nodeValue = displayedSoc;

      // Full charge (100% displayed SOC): waves are hidden above, while their
      // playback rate eases to zero in the background to avoid wasting motion work.
      this._setLiquidAnimationPlayback(isFull);

      // Current & ETA smoothing
      const currentA = !isStale && data.current_a != null ? Number(data.current_a) : 0;
      const absCurrent = Math.abs(currentA);

      if (state !== this._lastEtaState) {
        this._etaCurrentHistory = [];
        this._lastEtaState = state;
      }
      let smoothedCurrent = absCurrent;
      if (isActive && absCurrent > 0.05) {
        const now = Date.now();
        this._etaCurrentHistory.push({ t: now, current: absCurrent });
        this._etaCurrentHistory = this._etaCurrentHistory.filter(s => now - s.t <= 30000);
        if (this._etaCurrentHistory.length > 0) {
          smoothedCurrent = this._etaCurrentHistory.reduce((sum, s) => sum + s.current, 0) / this._etaCurrentHistory.length;
        }
      } else {
        this._etaCurrentHistory = [];
      }

      // Amperage display (exclusive to active side; magnitude without sign)
      const inputCurr = document.getElementById('input-current');
      const outputCurr = document.getElementById('output-current');
      const ampMagStr = `${absCurrent.toFixed(1)} A`;

      if (isCharging) {
        if (inputCurr) {
          inputCurr.textContent = ampMagStr;
          inputCurr.classList.add('is-visible');
        }
        if (outputCurr && outputCurr.classList.contains('is-visible')) {
          outputCurr.classList.remove('is-visible');
          setTimeout(() => {
            if (!outputCurr.classList.contains('is-visible')) outputCurr.textContent = '';
          }, 350);
        }
      } else if (isDischarging) {
        if (outputCurr) {
          outputCurr.textContent = ampMagStr;
          outputCurr.classList.add('is-visible');
        }
        if (inputCurr && inputCurr.classList.contains('is-visible')) {
          inputCurr.classList.remove('is-visible');
          setTimeout(() => {
            if (!inputCurr.classList.contains('is-visible')) inputCurr.textContent = '';
          }, 350);
        }
      } else {
        if (inputCurr && inputCurr.classList.contains('is-visible')) {
          inputCurr.classList.remove('is-visible');
          setTimeout(() => {
            if (!inputCurr.classList.contains('is-visible')) inputCurr.textContent = '';
          }, 350);
        }
        if (outputCurr && outputCurr.classList.contains('is-visible')) {
          outputCurr.classList.remove('is-visible');
          setTimeout(() => {
            if (!outputCurr.classList.contains('is-visible')) outputCurr.textContent = '';
          }, 350);
        }
      }

      // Directional ETA computation
      const etaDisplay = computeDirectionalEta(state, data, smoothedCurrent);
      this._updateDirectionalEta(state, etaDisplay);

      const batteryPulse = document.getElementById('battery-pulse');
      if (batteryPulse) {
        batteryPulse.setAttribute('stroke', socColors.top);
        batteryPulse.style.filter = `drop-shadow(0 0 20px ${socColors.glow})`;
        if (state === 'idle') {
          batteryPulse.style.opacity = '0.05';
          batteryPulse.style.animation = '';
        } else {
          batteryPulse.style.opacity = '';
          batteryPulse.style.animation = 'pulse-glow 3s ease-in-out infinite';
        }
      }

      // NOTE: input/output circle, icon, label and watt-text colors are intentionally
      // NOT set here. The .hero-card[data-hero-state] rules in styles.css are the
      // single source of truth for that periphery (JS-set presentation attributes
      // always lose to CSS rules, so the old imperative block was dead weight).

      // Energy flow particles animation
      if (this.energyFlow) {
        this.energyFlow.setState(state, power, soc);
      }

      // Render Dynamic Cell Balance
      if (data.cells) this._renderLiveCells(data.cells, soc);
      // Render Dynamic Temperature Sensors
      if (data.temperatures && data.temperatures.sensors) this._renderLiveSensors(data.temperatures.sensors);

      if (heroCard) heroCard.setAttribute('data-telemetry-state', isStale ? 'stale' : 'live');
      if (isStale) {
        const chargeW = Number(data.current_a) > 0 ? Math.round(data.abs_power_w || 0) : 0;
        const dischargeW = Number(data.current_a) < 0 ? Math.round(data.abs_power_w || 0) : 0;
        this._setStaleWattReading('charge', chargeW);
        this._setStaleWattReading('discharge', dischargeW);
      }
    }

    _setStaleWattReading(side, value) {
      const id = side === 'charge' ? 'input-power' : 'output-power';
      const power = document.getElementById(id);
      if (!power) return;
      const number = power.querySelector('.watt-number');
      if (number) number.textContent = String(value);
      else if (power.firstChild && power.firstChild.nodeType === Node.TEXT_NODE) {
        power.firstChild.nodeValue = String(value);
      }
      this._trackWattShown(side, value);
      power.style.transition = 'none';
      power.removeAttribute('filter');
      power.removeAttribute('fill');
      power.style.fill = '';
      power.style.transform = '';
      power.style.opacity = '1';
      power.style.visibility = 'visible';
      requestAnimationFrame(() => {
        power.style.transition = '';
      });
    }

    _parseCssColorToRgb(colStr) {
      if (!colStr || typeof colStr !== 'string') return null;
      const str = colStr.trim();
      if (str.startsWith('#')) {
        const hex = str.slice(1);
        if (hex.length === 3) {
          const r = parseInt(hex[0] + hex[0], 16);
          const g = parseInt(hex[1] + hex[1], 16);
          const b = parseInt(hex[2] + hex[2], 16);
          if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return [r, g, b];
        } else if (hex.length === 6) {
          const r = parseInt(hex.slice(0, 2), 16);
          const g = parseInt(hex.slice(2, 4), 16);
          const b = parseInt(hex.slice(4, 6), 16);
          if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return [r, g, b];
        }
        return null;
      }
      const m = str.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      if (m) {
        return [Number(m[1]), Number(m[2]), Number(m[3])];
      }
      return null;
    }

    _cancelWattTransition(side) {
      if (this._wattCleanupRafs && this._wattCleanupRafs[side]) {
        cancelAnimationFrame(this._wattCleanupRafs[side]);
        this._wattCleanupRafs[side] = null;
      }
      if (this._wattHandoffRafs && this._wattHandoffRafs[side]) {
        cancelAnimationFrame(this._wattHandoffRafs[side]);
        this._wattHandoffRafs[side] = null;
      }
      if (!this._wattTransitions) this._wattTransitions = {};
      const sess = this._wattTransitions[side];
      if (sess) {
        if (sess.timerId) {
          cancelAnimationFrame(sess.timerId);
          sess.timerId = null;
        }
        if (sess.ghost && sess.ghost.parentElement) sess.ghost.remove();
        if (sess.zeroGhost && sess.zeroGhost.parentElement) sess.zeroGhost.remove();
        if (sess.textEl) {
          const isCharge = (side === 'charge');
          const canonicalX = isCharge ? 276 : 916;
          sess.textEl.setAttribute('x', String(canonicalX));
          sess.textEl.setAttribute('text-anchor', 'middle');
          sess.textEl.setAttribute('dominant-baseline', 'middle');
          sess.textEl.removeAttribute('filter');
          sess.textEl.style.opacity = '';
          sess.textEl.style.filter = '';
          sess.textEl.style.transform = '';
          sess.textEl.style.transition = '';
        }
        if (sess.numTspan) {
          sess.numTspan.style.visibility = '';
          sess.numTspan.style.opacity = '';
          sess.numTspan.style.filter = '';
          sess.numTspan.style.letterSpacing = '';
          sess.numTspan.style.fontSize = '';
          sess.numTspan.style.fill = '';
        }
        if (sess.wTspan) {
          sess.wTspan.removeAttribute('x');
          sess.wTspan.removeAttribute('text-anchor');
          sess.wTspan.setAttribute('dx', '3');
          sess.wTspan.style.opacity = '';
          sess.wTspan.style.fill = '';
        }
        if (sess.ugEl) {
          sess.ugEl.style.transition = 'none';
          sess.ugEl.style.opacity = '0';
          if (sess.core) {
            sess.core.setAttribute('x', String(sess.ugCenterX - 28));
            sess.core.setAttribute('width', '56');
          }
          if (sess.halo) {
            sess.halo.setAttribute('x', String(sess.ugCenterX - 40));
            sess.halo.setAttribute('width', '80');
            sess.halo.setAttribute('opacity', '0.32');
          }
          sess.ugEl.style.transition = '';
        }
        if (sess.feBlur) sess.feBlur.setAttribute('stdDeviation', '0');
        if (sess.feShadow) sess.feShadow.setAttribute('flood-opacity', '0.25');
        if (sess.inputLabel) sess.inputLabel.style.opacity = '';
        if (sess.outputLabel) sess.outputLabel.style.opacity = '';
        if (sess.activeCurrentEl) {
          sess.activeCurrentEl.style.opacity = '';
          sess.activeCurrentEl.style.transition = '';
        }
        this._wattTransitions[side] = null;
      }
      const isCharge = (side === 'charge');
      const matFilterPrefix = isCharge ? 'watt-mat-glow-charge' : 'watt-mat-glow-discharge';
      const mBlur = document.getElementById(matFilterPrefix + '-blur');
      if (mBlur) mBlur.setAttribute('stdDeviation', '0');
      const mShadow = document.getElementById(matFilterPrefix + '-shadow');
      if (mShadow) mShadow.setAttribute('flood-opacity', '0.25');

      const textId = isCharge ? 'input-power' : 'output-power';
      const orphanGhost = document.getElementById(textId + '-ghost');
      if (orphanGhost) orphanGhost.remove();
      const orphanZeroGhost = document.getElementById(textId + '-zero-ghost');
      if (orphanZeroGhost) orphanZeroGhost.remove();

      const textEl = document.getElementById(textId);
      if (textEl) {
        const canonicalX = isCharge ? 276 : 916;
        textEl.setAttribute('x', String(canonicalX));
        textEl.setAttribute('text-anchor', 'middle');
        textEl.setAttribute('dominant-baseline', 'middle');
        const numT = textEl.querySelector('.watt-number');
        if (numT && numT.style.fill !== '') numT.style.fill = '';
        const wT = textEl.querySelector('.watt-unit') || textEl.querySelector('tspan:last-child');
        if (wT) {
          wT.removeAttribute('x');
          wT.removeAttribute('text-anchor');
          wT.setAttribute('dx', '3');
        }
      }

      const inLbl = document.getElementById('input-label');
      if (inLbl && inLbl.style.opacity !== '') inLbl.style.opacity = '';
      const outLbl = document.getElementById('output-label');
      if (outLbl && outLbl.style.opacity !== '') outLbl.style.opacity = '';
      const inCur = document.getElementById('input-current');
      if (inCur) {
        if (inCur.style.opacity !== '') inCur.style.opacity = '';
        if (inCur.style.transition !== '') inCur.style.transition = '';
      }
      const outCur = document.getElementById('output-current');
      if (outCur) {
        if (outCur.style.opacity !== '') outCur.style.opacity = '';
        if (outCur.style.transition !== '') outCur.style.transition = '';
      }
    }

    _applyWattIdleBaseState(side, textEl) {
      if (!textEl) return;
      const isCharge = (side === 'charge');
      const canonicalX = isCharge ? 276 : 916;
      textEl.setAttribute('x', String(canonicalX));
      textEl.setAttribute('text-anchor', 'middle');
      textEl.setAttribute('dominant-baseline', 'middle');
      const numTspan = textEl.querySelector('.watt-number');
      if (numTspan) {
        numTspan.textContent = '0';
        numTspan.style.opacity = '';
        numTspan.style.filter = '';
        numTspan.style.letterSpacing = '';
        numTspan.style.fontSize = '';
        numTspan.style.fill = '';
        numTspan.style.visibility = '';
      } else if (textEl.firstChild && textEl.firstChild.nodeType === Node.TEXT_NODE) {
        textEl.firstChild.nodeValue = '0';
      }
      this._trackWattShown(side, 0);
      const wTspan = textEl.querySelector('.watt-unit') || textEl.querySelector('tspan:last-child');
      if (wTspan) {
        wTspan.removeAttribute('x');
        wTspan.removeAttribute('text-anchor');
        wTspan.setAttribute('dx', '3');
        wTspan.style.opacity = '';
        wTspan.style.fill = '';
      }
      // Strip active overrides, letting styles.css be single source of truth
      textEl.style.fill = '';
      textEl.removeAttribute('fill');
      textEl.removeAttribute('filter');
      textEl.style.transform = '';
    }

    _resetWattToIdle(side) {
      if (this._wattCleanupRafs && this._wattCleanupRafs[side]) {
        cancelAnimationFrame(this._wattCleanupRafs[side]);
        this._wattCleanupRafs[side] = null;
      }
      if (this._wattHandoffRafs && this._wattHandoffRafs[side]) {
        cancelAnimationFrame(this._wattHandoffRafs[side]);
        this._wattHandoffRafs[side] = null;
      }

      const isCharge = (side === 'charge');
      const textId = isCharge ? 'input-power' : 'output-power';
      const textEl = document.getElementById(textId);
      const sess = (this._wattTransitions && this._wattTransitions[side]) ? this._wattTransitions[side] : null;

      if (sess && sess.timerId) {
        cancelAnimationFrame(sess.timerId);
        clearTimeout(sess.timerId);
        sess.timerId = null;
      }

      if (textEl) {
        // Stage 1: Prepare native node into final idle state under transition: none
        textEl.style.transition = 'none';
        const canonicalX = isCharge ? 276 : 916;
        textEl.setAttribute('x', String(canonicalX));
        textEl.setAttribute('text-anchor', 'middle');
        textEl.setAttribute('dominant-baseline', 'middle');
        const numTspan = textEl.querySelector('.watt-number');
        if (numTspan) {
          numTspan.textContent = '0';
          numTspan.style.opacity = '';
          numTspan.style.filter = '';
          numTspan.style.letterSpacing = '';
          numTspan.style.fontSize = '';
          numTspan.style.fill = '';
          numTspan.style.visibility = '';
        } else if (textEl.firstChild && textEl.firstChild.nodeType === Node.TEXT_NODE) {
          textEl.firstChild.nodeValue = '0';
        }
        this._trackWattShown(side, 0);
        const wTspan = textEl.querySelector('.watt-unit') || textEl.querySelector('tspan:last-child');
        if (wTspan) {
          wTspan.removeAttribute('x');
          wTspan.removeAttribute('text-anchor');
          wTspan.setAttribute('dx', '3');
          wTspan.style.opacity = '';
          wTspan.style.fill = '';
        }
        textEl.removeAttribute('fill');
        textEl.style.fill = '';
        textEl.removeAttribute('filter');
        textEl.style.transform = '';
        textEl.style.opacity = '1';
        textEl.style.visibility = 'visible';
      }

      // Remove temporary transition elements in the SAME JS turn (no double-bright frame)
      if (sess) {
        if (sess.ghost && sess.ghost.parentElement) sess.ghost.remove();
        if (sess.zeroGhost && sess.zeroGhost.parentElement) sess.zeroGhost.remove();
        if (sess.inputLabel) sess.inputLabel.style.opacity = '';
        if (sess.outputLabel) sess.outputLabel.style.opacity = '';
        if (sess.activeCurrentEl) {
          sess.activeCurrentEl.style.opacity = '';
          sess.activeCurrentEl.style.transition = '';
        }
        this._wattTransitions[side] = null;
      }
      const orphanGhost = document.getElementById(textId + '-ghost');
      if (orphanGhost) orphanGhost.remove();
      const orphanZeroGhost = document.getElementById(textId + '-zero-ghost');
      if (orphanZeroGhost) orphanZeroGhost.remove();

      const inLbl = document.getElementById('input-label');
      if (inLbl && inLbl.style.opacity !== '') inLbl.style.opacity = '';
      const outLbl = document.getElementById('output-label');
      if (outLbl && outLbl.style.opacity !== '') outLbl.style.opacity = '';
      const inCur = document.getElementById('input-current');
      if (inCur) {
        if (inCur.style.opacity !== '') inCur.style.opacity = '';
        if (inCur.style.transition !== '') inCur.style.transition = '';
      }
      const outCur = document.getElementById('output-current');
      if (outCur) {
        if (outCur.style.opacity !== '') outCur.style.opacity = '';
        if (outCur.style.transition !== '') outCur.style.transition = '';
      }

      const matFilterPrefix = isCharge ? 'watt-mat-glow-charge' : 'watt-mat-glow-discharge';
      const mBlur = document.getElementById(matFilterPrefix + '-blur');
      if (mBlur) mBlur.setAttribute('stdDeviation', '0');
      const mShadow = document.getElementById(matFilterPrefix + '-shadow');
      if (mShadow) mShadow.setAttribute('flood-opacity', '0.25');

      // FIX №2: Atomic invisible underglow reset
      const ugId = isCharge ? 'input-underglow' : 'output-underglow';
      const ugEl = document.getElementById(ugId);
      if (ugEl) {
        // 1. Instantly disable CSS transition
        ugEl.style.transition = 'none';
        // 2. Instantly force opacity 0
        ugEl.style.opacity = '0';
        // 3. Restore base geometry while 100% invisible
        const midX = isCharge ? 276 : 916;
        const core = ugEl.querySelector('#' + (isCharge ? 'input' : 'output') + '-underglow-core');
        if (core) {
          core.setAttribute('x', String(midX - 28));
          core.setAttribute('width', '56');
        }
        const halo = ugEl.querySelector('#' + (isCharge ? 'input' : 'output') + '-underglow-halo');
        if (halo) {
          halo.setAttribute('x', String(midX - 40));
          halo.setAttribute('width', '80');
          halo.setAttribute('opacity', '0.32');
        }
      }

      // Two-stage deferral to prevent CSS transition trigger on both text and underglow
      if (sess) {
        if (!this._wattHandoffRafs) this._wattHandoffRafs = {};
        const self = this;
        const raf1 = requestAnimationFrame(() => {
          if (self._wattTransitions && self._wattTransitions[side]) return;
          if (textEl) {
            textEl.style.opacity = '';
            textEl.style.visibility = '';
          }
          // Both textEl.style.transition and ugEl.style.transition remain 'none'

          const raf2 = requestAnimationFrame(() => {
            if (self._wattTransitions && self._wattTransitions[side]) return;
            if (textEl) {
              textEl.style.transition = '';
            }
            if (ugEl) {
              ugEl.style.transition = '';
            }
            if (self._wattHandoffRafs) self._wattHandoffRafs[side] = null;
          });
          if (self._wattHandoffRafs) self._wattHandoffRafs[side] = raf2;
        });
        this._wattHandoffRafs[side] = raf1;
      } else {
        if (textEl) {
          textEl.style.opacity = '';
          textEl.style.visibility = '';
          textEl.style.transition = '';
        }
        if (ugEl) {
          ugEl.style.transition = '';
        }
      }
    }

    // Track the watt value currently written to the DOM for a side. Called at
    // EVERY site that writes the displayed number (steady + transition writes),
    // so _getWattShown() mirrors what the user sees without DOM read-back.
    _trackWattShown(side, val) {
      if (!this._wattShown) this._wattShown = { charge: 0, discharge: 0 };
      const n = Math.round(Number(val));
      this._wattShown[side] = (Number.isFinite(n) && n > 0) ? n : 0;
    }

    _getWattShown(side) {
      return (this._wattShown && this._wattShown[side]) || 0;
    }

    _setWattActive(side, activeWattStr, color, isIgnition) {
      if (isIgnition) {
        this._startEnergyMaterialization(side, activeWattStr, color);
        return;
      }

      if (this._wattTransitions && this._wattTransitions[side]) {
        const curSess = this._wattTransitions[side];
        if (curSess.type === 'materialization' && curSess.activeWattText === String(Math.round(Number(activeWattStr) || 0))) {
          return;
        }
      }

      this._cancelWattTransition(side);
      const isCharge = (side === 'charge');
      const textId = isCharge ? 'input-power' : 'output-power';
      const textEl = document.getElementById(textId);
      if (!textEl) return;

      const canonicalX = isCharge ? 276 : 916;
      textEl.setAttribute('x', String(canonicalX));
      textEl.setAttribute('text-anchor', 'middle');
      textEl.setAttribute('dominant-baseline', 'middle');

      const numTspan = textEl.querySelector('.watt-number');
      if (numTspan) {
        numTspan.textContent = String(activeWattStr);
        numTspan.style.opacity = '';
        numTspan.style.filter = '';
        numTspan.style.letterSpacing = '';
        numTspan.style.fontSize = '';
        numTspan.style.fill = '';
        numTspan.style.visibility = '';
      } else if (textEl.firstChild && textEl.firstChild.nodeType === Node.TEXT_NODE) {
        textEl.firstChild.nodeValue = String(activeWattStr);
      }
      this._trackWattShown(side, activeWattStr);
      const wTspan = textEl.querySelector('.watt-unit') || textEl.querySelector('tspan:last-child');
      if (wTspan) {
        wTspan.removeAttribute('x');
        wTspan.removeAttribute('text-anchor');
        wTspan.setAttribute('dx', '3');
        wTspan.style.opacity = '';
        wTspan.style.fill = '';
      }
      textEl.setAttribute('fill', color);
      textEl.style.fill = color;
      textEl.setAttribute('filter', isCharge ? 'url(#watt-active-glow-charge)' : 'url(#watt-active-glow-discharge)');
      textEl.style.transform = '';
      textEl.style.visibility = 'visible';
      textEl.style.transition = '';

      const ugId = isCharge ? 'input-underglow' : 'output-underglow';
      const ugEl = document.getElementById(ugId);
      const midX = isCharge ? 276 : 916;
      const core = ugEl ? ugEl.querySelector('#' + (isCharge ? 'input' : 'output') + '-underglow-core') : null;
      const halo = ugEl ? ugEl.querySelector('#' + (isCharge ? 'input' : 'output') + '-underglow-halo') : null;

      // Steady active update (ACTIVE -> ACTIVE: NO animation)
      textEl.style.opacity = '';
      if (ugEl) ugEl.style.opacity = '1';
      if (core) {
        core.setAttribute('x', String(midX - 28));
        core.setAttribute('width', '56');
      }
      if (halo) {
        halo.setAttribute('x', String(midX - 40));
        halo.setAttribute('width', '80');
        halo.setAttribute('opacity', '0.32');
      }
    }

    _startEnergyCollapse(side, startValNum) {
      this._cancelWattTransition(side);
      const isCharge = (side === 'charge');
      const textId = isCharge ? 'input-power' : 'output-power';
      const textEl = document.getElementById(textId);
      if (!textEl) return;

      const startVal = Math.round(Number(startValNum) || 0);
      if (startVal <= 0) {
        this._resetWattToIdle(side);
        return;
      }

      // 1. Capture dynamic layout and verbatim attributes BEFORE mutation
      let pivotX = 0, pivotY = 0, ugCenterX = 0;
      let activeWPos = null;
      const baselineY = Number(textEl.getAttribute('y')) || 256;
      try {
        const numTspanPre = textEl.querySelector('.watt-number');
        if (numTspanPre) {
          const nb = numTspanPre.getBBox();
          pivotX = nb.x + nb.width / 2;
          pivotY = baselineY; // Baseline-preserving vertical pivot matching OLD approved motion
        } else {
          const bbox = textEl.getBBox();
          pivotX = bbox.x + bbox.width / 2;
          pivotY = baselineY;
        }
        activeWPos = textEl.getStartPositionOfChar(String(startVal).length);
      } catch (e) {
        this._resetWattToIdle(side);
        return;
      }

      const ugIdPre = isCharge ? 'input-underglow' : 'output-underglow';
      const ugElPre = document.getElementById(ugIdPre);
      const corePre = ugElPre ? ugElPre.querySelector('#' + (isCharge ? 'input' : 'output') + '-underglow-core') : null;
      if (corePre && corePre.hasAttribute('x')) {
        ugCenterX = Number(corePre.getAttribute('x')) + (Number(corePre.getAttribute('width')) || 56) / 2;
      } else {
        ugCenterX = Number(textEl.getAttribute('x')) || (isCharge ? 276 : 916);
      }

      const cs = window.getComputedStyle(textEl);
      const parentGroup = textEl.parentElement;

      // Authoritative computed active W color strictly from computed style
      const wTspanPre = textEl.querySelector('.watt-unit') || textEl.querySelector('tspan');
      const csWPre = wTspanPre ? window.getComputedStyle(wTspanPre) : cs;
      const activeWRgb = this._parseCssColorToRgb(csWPre.fill);

      // Dynamic capture of active filter attribute presence and value (no hardcoded IDs!)
      const hasActiveFilterAttr = textEl.hasAttribute('filter');
      const activeFilterAttr = textEl.getAttribute('filter');

      // 2. Clone active native node and strip unit tspan to create Numeric-Only Outgoing Ghost
      const ghost = textEl.cloneNode(true);
      ghost.setAttribute('id', textId + '-ghost');
      ghost.classList.add('hero-watt-collapse-ghost');
      ghost.setAttribute('x', pivotX.toFixed(3));
      ghost.setAttribute('y', String(pivotY));
      ghost.setAttribute('text-anchor', 'middle');
      ghost.setAttribute('dominant-baseline', 'middle');
      ghost.style.pointerEvents = 'none';
      ghost.style.transition = 'none';

      if (hasActiveFilterAttr) {
        ghost.setAttribute('filter', activeFilterAttr);
      }

      // Remove the unit tspan completely so ghost is strictly numeric digits
      const ghostW = ghost.querySelector('.watt-unit') || ghost.querySelector('tspan:last-child');
      if (ghostW) {
        ghostW.remove();
      }

      // Strip duplicate descendant IDs
      const descWithIds = ghost.querySelectorAll('[id]');
      descWithIds.forEach(el => el.removeAttribute('id'));

      parentGroup.insertBefore(ghost, textEl);

      // 3. Prepare Persistent Native Node
      this._applyWattIdleBaseState(side, textEl);
      const numTspan = textEl.querySelector('.watt-number');
      const wTspan = textEl.querySelector('.watt-unit') || textEl.querySelector('tspan');

      // Immutable canonical layout reference (single source of truth)
      const canonicalParentX = isCharge ? 276 : 916;
      const canonicalParentXAttr = String(canonicalParentX);
      const canonicalDx = 3;
      const canonicalDxAttr = '3';
      const hasCanonicalParentXAttr = true;
      const hasCanonicalDxAttr = true;

      // Measure idle resting W position to derive exact signed deltaDxMax
      let deltaDxMax = 0;
      try {
        const idleWPos = textEl.getStartPositionOfChar(1);
        if (activeWPos && idleWPos) {
          deltaDxMax = activeWPos.x - idleWPos.x;
        }
      } catch (e) {
        deltaDxMax = 0;
      }

      // Authoritative canonical idle W color from CSS stylesheet custom property (single source of truth)
      const idleToken = window.getComputedStyle(document.documentElement).getPropertyValue('--watt-idle-color').trim();
      const idleWRgb = this._parseCssColorToRgb(idleToken);

      if (!activeWRgb || !idleWRgb) {
        // Authoritative validation: if CSS color cannot be parsed, graceful fallback without magic arrays
        this._resetWattToIdle(side);
        return;
      }

      // Native root stays opacity 1! Zero reveal applies strictly to numTspan
      textEl.style.transition = 'none';
      textEl.style.opacity = '1';
      textEl.style.visibility = 'visible';

      // Active glow retained on root textEl at t=0 so native W has exact active glow; zero is hidden (opacity: 0)
      if (hasActiveFilterAttr) {
        textEl.setAttribute('filter', activeFilterAttr);
      }

      if (numTspan) {
        numTspan.style.visibility = 'hidden';
        numTspan.style.opacity = '0';
        numTspan.style.filter = 'blur(1.5px)';
      }
      if (wTspan) {
        wTspan.style.opacity = '1'; // ONLY VISIBLE W!
        wTspan.style.fill = 'rgb(' + activeWRgb.join(',') + ')';
      }

      // Underglow elements
      const ugId = isCharge ? 'input-underglow' : 'output-underglow';
      const ugEl = document.getElementById(ugId);
      const core = ugEl ? ugEl.querySelector('#' + (isCharge ? 'input' : 'output') + '-underglow-core') : null;
      const halo = ugEl ? ugEl.querySelector('#' + (isCharge ? 'input' : 'output') + '-underglow-halo') : null;
      if (ugEl) ugEl.style.transition = 'none';

      const activeRgb = isCharge ? [86, 211, 100] : [157, 141, 255];
      const coolRgb = isCharge ? [77, 131, 93] : [112, 104, 150];
      const neutralRgb = idleWRgb.slice();

      const totalDur = 620; // ms
      const startTime = performance.now();

      const sess = {
        type: 'collapse',
        side,
        textEl,
        numTspan,
        wTspan,
        hasCanonicalParentXAttr,
        canonicalParentXAttr,
        canonicalParentX,
        hasCanonicalDxAttr,
        canonicalDxAttr,
        canonicalDx,
        deltaDxMax,
        activeWRgb,
        idleWRgb,
        hasActiveFilterAttr,
        activeFilterAttr,
        ghost,
        pivotX,
        pivotY,
        ugCenterX,
        ugEl,
        core,
        halo,
        activeRgb,
        coolRgb,
        neutralRgb,
        totalDur,
        timerId: null
      };
      this._wattTransitions[side] = sess;

      // 4. SYNCHRONOUS FIRST FRAME: Render frame 0 immediately before scheduling RAF!
      this._renderEnergyCollapseFrame(sess, 0);

      const self = this;
      function step(now) {
        if (!self._wattTransitions || self._wattTransitions[side] !== sess) return;
        const elapsed = now - startTime;

        if (elapsed < totalDur) {
          self._renderEnergyCollapseFrame(sess, elapsed);
          sess.timerId = requestAnimationFrame(step);
        } else {
          self._renderEnergyCollapseFrame(sess, totalDur);
          self._finishEnergyCollapse(sess);
        }
      }
      sess.timerId = requestAnimationFrame(step);
    }

    _finishEnergyCollapse(sess) {
      if (!sess) return;
      const side = sess.side;
      if (sess.timerId) {
        cancelAnimationFrame(sess.timerId);
        sess.timerId = null;
      }
      // 1. Remove ghost if still in DOM
      if (sess.ghost && sess.ghost.parentElement) {
        sess.ghost.remove();
      }
      // 2. Restore exact original attribute presence & clear inline animation styles under transition: none
      if (sess.textEl) {
        sess.textEl.style.transition = 'none';
        sess.textEl.setAttribute('x', sess.canonicalParentXAttr);
        sess.textEl.setAttribute('text-anchor', 'middle');
        sess.textEl.setAttribute('dominant-baseline', 'middle');
        sess.textEl.removeAttribute('filter');
        sess.textEl.style.opacity = '';
        sess.textEl.style.filter = '';
      }
      if (sess.numTspan) {
        sess.numTspan.style.visibility = '';
        sess.numTspan.style.opacity = '';
        sess.numTspan.style.filter = '';
      }
      if (sess.wTspan) {
        sess.wTspan.removeAttribute('x');
        sess.wTspan.removeAttribute('text-anchor');
        sess.wTspan.setAttribute('dx', sess.canonicalDxAttr);
        sess.wTspan.style.opacity = '';
        sess.wTspan.style.fill = '';
      }
      // 3. Atomically reset invisible underglow geometry
      if (sess.ugEl) {
        sess.ugEl.style.transition = 'none';
        sess.ugEl.style.opacity = '0';
        if (sess.core) {
          sess.core.setAttribute('x', String(sess.ugCenterX - 28));
          sess.core.setAttribute('width', '56');
        }
        if (sess.halo) {
          sess.halo.setAttribute('x', String(sess.ugCenterX - 40));
          sess.halo.setAttribute('width', '80');
          sess.halo.setAttribute('opacity', '0.32');
        }
      }
      // 4. Release session
      if (this._wattTransitions && this._wattTransitions[side] === sess) {
        this._wattTransitions[side] = null;
      }
      // 5. Restore CSS transitions after paint (tracked per side to prevent race with newer session)
      if (!this._wattCleanupRafs) this._wattCleanupRafs = {};
      if (this._wattCleanupRafs[side]) {
        cancelAnimationFrame(this._wattCleanupRafs[side]);
        this._wattCleanupRafs[side] = null;
      }
      const self = this;
      const cleanupRaf = requestAnimationFrame(() => {
        if (self._wattCleanupRafs && self._wattCleanupRafs[side] === cleanupRaf) {
          self._wattCleanupRafs[side] = null;
        }
        if (self._wattTransitions && self._wattTransitions[side]) return;
        if (sess.textEl) sess.textEl.style.transition = '';
        if (sess.ugEl) sess.ugEl.style.transition = '';
      });
      this._wattCleanupRafs[side] = cleanupRaf;
    }

    _renderEnergyCollapseFrame(s, elapsed) {
      const u = Math.min(1, Math.max(0, elapsed / s.totalDur));

      // 1. Outgoing Ghost (Numeric digits only): Contraction, Cooling, Dissolve through u=1.00
      if (s.ghost && s.ghost.parentElement) {
        if (u >= 1.0) {
          s.ghost.style.opacity = '0';
        } else {
          let oldOp, oldScale, oldBlur, oldSpacing, oldColor;

          if (u <= 0.12) {
            oldOp = 1.0;
            oldScale = 1.0;
            oldBlur = 0;
            oldSpacing = 0;
            oldColor = s.activeRgb;
          } else if (u <= 0.42) {
            const segP = (u - 0.12) / (0.42 - 0.12);
            oldOp = 1.0 - 0.18 * segP;
            oldScale = 1.0 - 0.015 * segP;
            oldBlur = 0.25 * segP;
            oldSpacing = -0.8 * segP;
            oldColor = [
              Math.round(s.activeRgb[0] + segP * (s.coolRgb[0] - s.activeRgb[0])),
              Math.round(s.activeRgb[1] + segP * (s.coolRgb[1] - s.activeRgb[1])),
              Math.round(s.activeRgb[2] + segP * (s.coolRgb[2] - s.activeRgb[2]))
            ];
          } else if (u <= 0.68) {
            const segP = (u - 0.42) / (0.68 - 0.42);
            oldOp = 0.82 - 0.58 * segP;
            oldScale = 0.985 - 0.030 * segP;
            oldBlur = 0.25 + 1.55 * segP;
            oldSpacing = -0.8 - 1.2 * segP;
            oldColor = [
              Math.round(s.coolRgb[0] + segP * (s.neutralRgb[0] - s.coolRgb[0])),
              Math.round(s.coolRgb[1] + segP * (s.neutralRgb[1] - s.coolRgb[1])),
              Math.round(s.coolRgb[2] + segP * (s.neutralRgb[2] - s.coolRgb[2]))
            ];
          } else {
            const segP = (u - 0.68) / (1.00 - 0.68);
            oldOp = Math.max(0, 0.24 - 0.24 * segP);
            oldScale = 0.955 - 0.015 * segP;
            oldBlur = 1.8 + 1.2 * segP;
            oldSpacing = -2.0 - 0.6 * segP;
            oldColor = s.neutralRgb;
          }

          s.ghost.style.opacity = String(oldOp);
          s.ghost.style.fill = 'rgb(' + oldColor.join(',') + ')';
          s.ghost.style.letterSpacing = oldSpacing !== 0 ? oldSpacing.toFixed(2) + 'px' : '';

          // Filter: blur when active, smooth transition without CSS filter chaining jump
          if (oldBlur > 0.05) {
            s.ghost.style.filter = 'blur(' + oldBlur.toFixed(2) + 'px)';
          } else {
            s.ghost.style.filter = '';
          }

          // Strict Hold Window & Isotropic 2D scaling around numeric-only pivot
          if (oldScale === 1.0) {
            s.ghost.removeAttribute('transform');
          } else {
            s.ghost.setAttribute('transform',
              'matrix(' + oldScale + ',0,0,' + oldScale + ',' +
              (s.pivotX * (1 - oldScale)) + ',' + (s.pivotY * (1 - oldScale)) + ')'
            );
          }
        }
      }

      // 2. Controlled Active Glow Removal: Active glow removed from native root before zero emerges
      if (u >= 0.35 && s.textEl.hasAttribute('filter')) {
        s.textEl.removeAttribute('filter');
      }

      // 3. Persistent Zero Reveal (applied strictly to numTspan)
      if (s.numTspan) {
        let zeroOp, zeroBlur;
        if (u <= 0.40) {
          zeroOp = 0;
          zeroBlur = 2.0;
          s.numTspan.style.visibility = 'hidden';
        } else {
          s.numTspan.style.visibility = 'visible';
          if (u <= 0.68) {
            const segP = (u - 0.40) / (0.68 - 0.40);
            zeroOp = 0.45 * segP;
            zeroBlur = 2.0 - 1.4 * segP;
          } else if (u <= 0.90) {
            const segP = (u - 0.68) / (0.90 - 0.68);
            zeroOp = 0.45 + 0.55 * segP;
            zeroBlur = Math.max(0, 0.6 - 0.6 * segP);
          } else {
            zeroOp = 1.0;
            zeroBlur = 0;
          }
        }
        s.numTspan.style.opacity = String(zeroOp);
        s.numTspan.style.filter = zeroBlur > 0.05 ? 'blur(' + zeroBlur.toFixed(2) + 'px)' : 'none';
      }

      // 4. Compensated Native W Glide & Decoupled Color Transition (neutral strictly by u=0.68)
      let wProgress;
      if (u <= 0.12) {
        wProgress = 0;
      } else if (u < 0.90) {
        const pEff = (u - 0.12) / (0.90 - 0.12);
        wProgress = Math.min(1, Math.max(0, pEff * pEff * (3 - 2 * pEff)));
      } else {
        wProgress = 1.0;
      }

      const curDeltaDx = s.deltaDxMax * (1 - wProgress);
      const curDx = s.canonicalDx + curDeltaDx;
      const curParentX = s.canonicalParentX + curDeltaDx / 2;

      s.textEl.setAttribute('x', curParentX.toFixed(3));
      if (s.wTspan) {
        s.wTspan.setAttribute('dx', curDx.toFixed(3));
        // Pure computed color transition strictly complete (canonical idle neutral) by u=0.68
        const wColorP = Math.min(1, u / 0.68);
        const rW = Math.round(s.activeWRgb[0] + wColorP * (s.idleWRgb[0] - s.activeWRgb[0]));
        const gW = Math.round(s.activeWRgb[1] + wColorP * (s.idleWRgb[1] - s.activeWRgb[1]));
        const bW = Math.round(s.activeWRgb[2] + wColorP * (s.idleWRgb[2] - s.activeWRgb[2]));
        s.wTspan.style.fill = 'rgb(' + rW + ',' + gW + ',' + bW + ')';
      }

      // 5. Underglow: Synchronized Contraction and Energy Concentration
      if (s.ugEl && s.core && s.halo) {
        let ugScaleX, ugOp;
        if (u <= 0.44) {
          const segP = u / 0.44;
          ugScaleX = 1.0 - 0.52 * segP;
          ugOp = 1.0 - 0.05 * segP;
        } else if (u <= 0.72) {
          const segP = (u - 0.44) / (0.72 - 0.44);
          ugScaleX = 0.48 - 0.36 * segP;
          ugOp = 0.95 - 0.55 * segP;
        } else if (u <= 0.90) {
          const segP = (u - 0.72) / (0.90 - 0.72);
          ugScaleX = Math.max(0, 0.12 - 0.12 * segP);
          ugOp = Math.max(0, 0.40 - 0.40 * segP);
        } else {
          ugScaleX = 0;
          ugOp = 0;
        }

        const coreW = 56 * ugScaleX;
        s.core.setAttribute('x', (s.ugCenterX - coreW / 2).toFixed(2));
        s.core.setAttribute('width', coreW.toFixed(2));

        const haloW = 80 * Math.max(0.1, ugScaleX);
        s.halo.setAttribute('x', (s.ugCenterX - haloW / 2).toFixed(2));
        s.halo.setAttribute('width', haloW.toFixed(2));
        s.halo.setAttribute('opacity', (0.32 * ugOp).toFixed(2));

        s.ugEl.style.opacity = ugOp.toFixed(2);
      }
    }

    _ensureWattMaterializeFilter(side) {
      const isCharge = (side === 'charge');
      const filterId = isCharge ? 'watt-mat-glow-charge' : 'watt-mat-glow-discharge';
      let filter = document.getElementById(filterId);
      const color = isCharge ? '#56d364' : '#9d8dff';
      if (!filter) {
        const defs = document.querySelector('svg defs');
        if (defs) {
          filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
          filter.setAttribute('id', filterId);
          filter.setAttribute('x', '-20%');
          filter.setAttribute('y', '-20%');
          filter.setAttribute('width', '140%');
          filter.setAttribute('height', '140%');

          const blur = document.createElementNS('http://www.w3.org/2000/svg', 'feGaussianBlur');
          blur.setAttribute('id', filterId + '-blur');
          blur.setAttribute('stdDeviation', '0');
          filter.appendChild(blur);

          const shadow = document.createElementNS('http://www.w3.org/2000/svg', 'feDropShadow');
          shadow.setAttribute('id', filterId + '-shadow');
          shadow.setAttribute('dx', '0');
          shadow.setAttribute('dy', '0');
          shadow.setAttribute('stdDeviation', '3');
          shadow.setAttribute('flood-color', color);
          shadow.setAttribute('flood-opacity', '0.25');
          filter.appendChild(shadow);

          defs.appendChild(filter);
        }
      }
      const feBlur = document.getElementById(filterId + '-blur');
      const feShadow = document.getElementById(filterId + '-shadow');
      return {
        filterId,
        filterAttr: 'url(#' + filterId + ')',
        feBlur,
        feShadow
      };
    }

    _startEnergyMaterialization(side, activeWattStr, color) {
      this._cancelWattTransition(side);
      const isCharge = (side === 'charge');
      const textId = isCharge ? 'input-power' : 'output-power';
      const textEl = document.getElementById(textId);
      if (!textEl) return;

      const numVal = Math.round(Number(activeWattStr) || 0);
      if (numVal <= 0) {
        this._resetWattToIdle(side);
        return;
      }

      const activeWattText = String(numVal);
      const parentGroup = textEl.parentElement;
      const numTspan = textEl.querySelector('.watt-number');
      const wTspan = textEl.querySelector('.watt-unit') || textEl.querySelector('tspan:last-child');

      // 1. Immutable canonical layout reference (single source of truth)
      const canonicalParentX = isCharge ? 276 : 916;
      const canonicalParentXAttr = String(canonicalParentX);
      const canonicalDx = 3;
      const canonicalDxAttr = '3';
      const hasCanonicalParentXAttr = true;
      const hasCanonicalDxAttr = true;

      // Ensure clean idle state to measure exact idle W position
      this._applyWattIdleBaseState(side, textEl);
      textEl.setAttribute('x', String(canonicalParentX));
      if (wTspan) {
        wTspan.removeAttribute('x');
        wTspan.removeAttribute('text-anchor');
        wTspan.setAttribute('dx', String(canonicalDx));
      }

      let idleWPos = null;
      try {
        idleWPos = textEl.getStartPositionOfChar(1).x;
      } catch (e) {
        idleWPos = canonicalParentX + 3.91;
      }

      // Temporarily measure active W position and active digits pivotX
      if (numTspan) numTspan.textContent = activeWattText;
      let activeWPos = null;
      let pivotX = canonicalParentX;
      const baselineY = Number(textEl.getAttribute('y')) || 256;
      let pivotY = baselineY;
      try {
        if (numTspan) {
          const nb = numTspan.getBBox();
          pivotX = nb.x + nb.width / 2;
        }
        activeWPos = textEl.getStartPositionOfChar(activeWattText.length).x;
      } catch (e) {
        activeWPos = idleWPos + 28.89;
      }

      const deltaDxMax = activeWPos - idleWPos;

      const idleToken = window.getComputedStyle(document.documentElement).getPropertyValue('--watt-idle-color').trim();
      const idleWRgb = this._parseCssColorToRgb(idleToken) || [72, 79, 88];
      const activeRgb = isCharge ? [86, 211, 100] : [157, 141, 255];
      const coolRgb = isCharge ? [77, 131, 93] : [112, 104, 150];
      const neutralRgb = idleWRgb.slice();
      const activeWRgb = this._parseCssColorToRgb(color) || activeRgb;
      const activeFilterAttr = isCharge ? 'url(#watt-active-glow-charge)' : 'url(#watt-active-glow-discharge)';
      const idleColor = idleToken || ('rgb(' + neutralRgb.join(',') + ')');

      // Ensure native node has clean fill before cloning ghost
      if (numTspan) {
        numTspan.textContent = '0';
        numTspan.style.fill = '';
      }
      if (wTspan) wTspan.setAttribute('dx', String(canonicalDx));
      textEl.setAttribute('x', String(canonicalParentX));

      // Ensure smooth materialization bloom filter exists and is initialized
      const matFilter = this._ensureWattMaterializeFilter(side);
      if (matFilter.feBlur) matFilter.feBlur.setAttribute('stdDeviation', '3');
      if (matFilter.feShadow) matFilter.feShadow.setAttribute('flood-opacity', '0');

      // 2. Clone active ghost (Numeric-Only Active Ghost, exact identical container as Collapse ghost!)
      const ghost = textEl.cloneNode(true);
      ghost.setAttribute('id', textId + '-ghost');
      ghost.classList.add('hero-watt-materialize-ghost');
      ghost.setAttribute('x', pivotX.toFixed(3));
      ghost.setAttribute('y', String(pivotY));
      ghost.setAttribute('text-anchor', 'middle');
      ghost.setAttribute('dominant-baseline', 'middle');
      ghost.style.pointerEvents = 'none';
      ghost.style.transition = 'none';
      ghost.setAttribute('filter', matFilter.filterAttr);

      const ghostW = ghost.querySelector('.watt-unit') || ghost.querySelector('tspan:last-child');
      if (ghostW) ghostW.remove();

      const ghostNum = ghost.querySelector('.watt-number');
      if (ghostNum) {
        ghostNum.textContent = activeWattText;
        ghostNum.style.fill = '';
      }

      const descWithIds = ghost.querySelectorAll('[id]');
      descWithIds.forEach(el => el.removeAttribute('id'));

      parentGroup.insertBefore(ghost, textEl);

      // 3. Lock native outgoing zero in canonical idle-neutral fill
      if (numTspan) {
        numTspan.textContent = '0';
        numTspan.style.fill = idleColor;
      }

      // Underglow
      const ugId = isCharge ? 'input-underglow' : 'output-underglow';
      const ugEl = document.getElementById(ugId);
      const core = ugEl ? ugEl.querySelector('#' + (isCharge ? 'input' : 'output') + '-underglow-core') : null;
      const halo = ugEl ? ugEl.querySelector('#' + (isCharge ? 'input' : 'output') + '-underglow-halo') : null;
      if (ugEl) ugEl.style.transition = 'none';
      const ugCenterX = canonicalParentX;

      // Hero labels & current elements
      const inputLabel = document.getElementById('input-label');
      const outputLabel = document.getElementById('output-label');
      const activeCurrentEl = document.getElementById(isCharge ? 'input-current' : 'output-current');

      const totalDur = 620;
      const startTime = performance.now();

      const sess = {
        type: 'materialization',
        side,
        textEl,
        numTspan,
        wTspan,
        ghost,
        activeWattText,
        hasCanonicalParentXAttr,
        canonicalParentXAttr,
        canonicalParentX,
        hasCanonicalDxAttr,
        canonicalDxAttr,
        canonicalDx,
        deltaDxMax,
        pivotX,
        pivotY,
        idleColor,
        idleWRgb,
        activeWRgb,
        activeRgb,
        coolRgb,
        neutralRgb,
        activeFilterAttr,
        matFilterAttr: matFilter.filterAttr,
        feBlur: matFilter.feBlur,
        feShadow: matFilter.feShadow,
        ugCenterX,
        ugEl,
        core,
        halo,
        inputLabel,
        outputLabel,
        activeCurrentEl,
        totalDur,
        color,
        timerId: null,
        settledHoldApplied: false
      };
      this._wattTransitions[side] = sess;

      this._renderEnergyMaterializationFrame(sess, 0);

      const self = this;
      function step(now) {
        if (!self._wattTransitions || self._wattTransitions[side] !== sess) return;
        const elapsed = now - startTime;

        if (elapsed < totalDur) {
          self._renderEnergyMaterializationFrame(sess, elapsed);
          sess.timerId = requestAnimationFrame(step);
        } else {
          self._renderEnergyMaterializationFrame(sess, totalDur);
          self._finishEnergyMaterialization(sess);
        }
      }
      sess.timerId = requestAnimationFrame(step);
    }

    _renderEnergyMaterializationFrame(s, elapsed) {
      const v = Math.min(1, Math.max(0, elapsed / s.totalDur));
      const collapseU = 1 - v;

      // ── HOLD WINDOW (v >= 0.92 ~ 570ms to 620ms) ──
      // All visual components reach final settled state at v = 0.92.
      // Hold state is applied exactly once to avoid redundant DOM mutations during the ~50ms window.
      if (v >= 0.92) {
        if (s.settledHoldApplied) return;
        s.settledHoldApplied = true;

        // 1. Digits (Ghost): Canonical settled appearance
        if (s.ghost && s.ghost.parentElement) {
          s.ghost.style.opacity = '1';
          s.ghost.style.fill = 'rgb(' + s.activeRgb.join(',') + ')';
          s.ghost.style.letterSpacing = '';
          s.ghost.style.filter = '';
          s.ghost.removeAttribute('transform');
        }

        // 2. SVG filter primitives: zero blur, canonical flood-opacity 0.250
        if (s.feBlur) s.feBlur.setAttribute('stdDeviation', '0');
        if (s.feShadow) s.feShadow.setAttribute('flood-opacity', '0.250');
        if (!s.textEl.hasAttribute('filter')) s.textEl.setAttribute('filter', s.matFilterAttr);

        // 3. Native Zero dissolved
        if (s.numTspan) {
          s.numTspan.style.visibility = 'hidden';
          s.numTspan.style.opacity = '0';
          s.numTspan.style.filter = 'none';
          s.numTspan.style.fill = '';
        }

        // 4. Native W: canonical active position & color
        const finalDx = s.canonicalDx + s.deltaDxMax;
        const finalParentX = s.canonicalParentX + s.deltaDxMax / 2;
        s.textEl.setAttribute('x', finalParentX.toFixed(3));
        if (s.wTspan) {
          s.wTspan.setAttribute('dx', finalDx.toFixed(3));
          s.wTspan.style.fill = 'rgb(' + s.activeWRgb.join(',') + ')';
          s.wTspan.style.opacity = '1';
        }

        // 5. Underglow: canonical active geometry & opacity
        if (s.ugEl && s.core && s.halo) {
          s.core.setAttribute('x', String(s.ugCenterX - 28));
          s.core.setAttribute('width', '56');
          s.core.setAttribute('opacity', '0.85');
          s.halo.setAttribute('x', String(s.ugCenterX - 40));
          s.halo.setAttribute('width', '80');
          s.halo.setAttribute('opacity', '0.32');
          s.ugEl.style.opacity = '1';
        }

        // 6. Hero labels and Current: opacity 1
        if (s.inputLabel) s.inputLabel.style.opacity = '1';
        if (s.outputLabel) s.outputLabel.style.opacity = '1';
        if (s.activeCurrentEl) s.activeCurrentEl.style.opacity = '1';

        return;
      }

      // ── SHARED FINAL PHASE (v = 0.58 -> 0.92) or EARLIER PHASES (v < 0.58) ──
      let ease = 0;
      if (v >= 0.58) {
        const p = Math.min(1, Math.max(0, (v - 0.58) / 0.34));
        ease = 1 - Math.pow(1 - p, 3); // Smooth cubic ease-out
      }

      // 1. Active Digits (Ghost)
      if (s.ghost && s.ghost.parentElement) {
        let oldOp, oldScale, oldBlur, oldSpacing, oldColor;
        let glowOp = 0;

        if (v >= 0.58) {
          oldOp = 0.82 + 0.18 * ease;
          oldScale = 0.985 + 0.015 * ease;
          oldBlur = Math.max(0, 0.25 * (1 - ease));
          oldSpacing = -0.8 * (1 - ease);
          oldColor = [
            Math.round(s.coolRgb[0] + ease * (s.activeRgb[0] - s.coolRgb[0])),
            Math.round(s.coolRgb[1] + ease * (s.activeRgb[1] - s.coolRgb[1])),
            Math.round(s.coolRgb[2] + ease * (s.activeRgb[2] - s.coolRgb[2]))
          ];
          glowOp = 0.25 * ease;
        } else if (collapseU <= 0.68) {
          const segP = (collapseU - 0.42) / (0.68 - 0.42);
          oldOp = 0.82 - 0.58 * segP;
          oldScale = 0.985 - 0.030 * segP;
          oldBlur = 0.25 + 1.55 * segP;
          oldSpacing = -0.8 - 1.2 * segP;
          oldColor = [
            Math.round(s.coolRgb[0] + segP * (s.neutralRgb[0] - s.coolRgb[0])),
            Math.round(s.coolRgb[1] + segP * (s.neutralRgb[1] - s.coolRgb[1])),
            Math.round(s.coolRgb[2] + segP * (s.neutralRgb[2] - s.coolRgb[2]))
          ];
          glowOp = 0;
        } else {
          const segP = (collapseU - 0.68) / (1.00 - 0.68);
          oldOp = Math.max(0, 0.24 - 0.24 * segP);
          oldScale = 0.955 - 0.015 * segP;
          oldBlur = 1.8 + 1.2 * segP;
          oldSpacing = -2.0 - 0.6 * segP;
          oldColor = s.neutralRgb;
          glowOp = 0;
        }

        s.ghost.style.opacity = String(oldOp);
        s.ghost.style.fill = 'rgb(' + oldColor.join(',') + ')';
        s.ghost.style.letterSpacing = oldSpacing !== 0 ? oldSpacing.toFixed(2) + 'px' : '';
        s.ghost.style.filter = ''; // Managed dynamically via SVG filter pipeline

        // Update smooth SVG filter: feBlur and feShadow
        if (s.feBlur) {
          s.feBlur.setAttribute('stdDeviation', oldBlur.toFixed(2));
        }
        if (s.feShadow) {
          s.feShadow.setAttribute('flood-opacity', glowOp.toFixed(3));
        }

        if (oldScale === 1.0) {
          s.ghost.removeAttribute('transform');
        } else {
          s.ghost.setAttribute('transform',
            'matrix(' + oldScale + ',0,0,' + oldScale + ',' +
            (s.pivotX * (1 - oldScale)) + ',' + (s.pivotY * (1 - oldScale)) + ')'
          );
        }
      }

      // 2. Active Glow Filter on Native TextEl (synchronized with smooth bloom)
      if (v >= 0.58 && !s.textEl.hasAttribute('filter')) {
        s.textEl.setAttribute('filter', s.matFilterAttr);
      } else if (v < 0.58 && s.textEl.hasAttribute('filter')) {
        s.textEl.removeAttribute('filter');
      }

      // 3. Native Zero Reveal/Dissolve (numTspan holds '0')
      if (s.numTspan) {
        let zeroOp, zeroBlur;
        if (collapseU <= 0.40) {
          zeroOp = 0;
          zeroBlur = 2.0;
          s.numTspan.style.visibility = 'hidden';
          s.numTspan.style.fill = '';
        } else {
          s.numTspan.style.visibility = 'visible';
          s.numTspan.style.fill = s.idleColor;
          if (collapseU <= 0.68) {
            const segP = (collapseU - 0.40) / (0.68 - 0.40);
            zeroOp = 0.45 * segP;
            zeroBlur = 2.0 - 1.4 * segP;
          } else if (collapseU <= 0.90) {
            const segP = (collapseU - 0.68) / (0.90 - 0.68);
            zeroOp = 0.45 + 0.55 * segP;
            zeroBlur = Math.max(0, 0.6 - 0.6 * segP);
          } else {
            zeroOp = 1.0;
            zeroBlur = 0;
          }
        }
        s.numTspan.style.opacity = String(zeroOp);
        s.numTspan.style.filter = zeroBlur > 0.05 ? 'blur(' + zeroBlur.toFixed(2) + 'px)' : 'none';
      }

      // 4. Native W Glide: Exact same geometry as Collapse evaluated at collapseU
      let wProgress;
      if (collapseU <= 0.12) {
        wProgress = 0;
      } else if (collapseU < 0.90) {
        const pEff = (collapseU - 0.12) / (0.90 - 0.12);
        wProgress = Math.min(1, Math.max(0, pEff * pEff * (3 - 2 * pEff)));
      } else {
        wProgress = 1.0;
      }

      const curDeltaDx = s.deltaDxMax * (1 - wProgress);
      const curDx = s.canonicalDx + curDeltaDx;
      const curParentX = s.canonicalParentX + curDeltaDx / 2;

      s.textEl.setAttribute('x', curParentX.toFixed(3));
      if (s.wTspan) {
        s.wTspan.setAttribute('dx', curDx.toFixed(3));
        let wColorP;
        if (v >= 0.58) {
          const wColorP_start = 0.42 / 0.68;
          wColorP = wColorP_start * (1 - ease);
        } else {
          wColorP = Math.min(1, collapseU / 0.68);
        }
        const rW = Math.round(s.activeWRgb[0] + wColorP * (s.idleWRgb[0] - s.activeWRgb[0]));
        const gW = Math.round(s.activeWRgb[1] + wColorP * (s.idleWRgb[1] - s.activeWRgb[1]));
        const bW = Math.round(s.activeWRgb[2] + wColorP * (s.idleWRgb[2] - s.activeWRgb[2]));
        s.wTspan.style.fill = 'rgb(' + rW + ',' + gW + ',' + bW + ')';
        s.wTspan.style.opacity = '1';
      }

      // 5. Underglow Bloom with Shared Ease-Out
      if (s.ugEl && s.core && s.halo) {
        let ugScaleX, ugOp;
        if (v >= 0.58) {
          const ugScaleX_start = 1.0 - 0.52 * (0.42 / 0.44); // ~0.5036
          const ugOp_start = 1.0 - 0.05 * (0.42 / 0.44);     // ~0.9523
          ugScaleX = ugScaleX_start + (1.0 - ugScaleX_start) * ease;
          ugOp = ugOp_start + (1.0 - ugOp_start) * ease;
        } else if (collapseU <= 0.44) {
          const segP = collapseU / 0.44;
          ugScaleX = 1.0 - 0.52 * segP;
          ugOp = 1.0 - 0.05 * segP;
        } else if (collapseU <= 0.85) {
          const segP = (collapseU - 0.44) / (0.85 - 0.44);
          ugScaleX = 0.48 - 0.48 * segP;
          ugOp = 0.95 - 0.95 * segP;
        } else {
          ugScaleX = 0;
          ugOp = 0;
        }

        const coreW = 56 * Math.max(0.1, ugScaleX);
        s.core.setAttribute('x', (s.ugCenterX - coreW / 2).toFixed(2));
        s.core.setAttribute('width', coreW.toFixed(2));
        s.core.setAttribute('opacity', (0.85 * ugOp).toFixed(2));

        const haloW = 80 * Math.max(0.1, ugScaleX);
        s.halo.setAttribute('x', (s.ugCenterX - haloW / 2).toFixed(2));
        s.halo.setAttribute('width', haloW.toFixed(2));
        s.halo.setAttribute('opacity', (0.32 * ugOp).toFixed(2));

        s.ugEl.style.opacity = ugOp.toFixed(2);
      }

      // 6. Hero Labels and Current A: Start ~270 ms, finish at v=0.92 (~570 ms)
      const pLabel = (elapsed <= 270) ? 0 : Math.min(1, (elapsed - 270) / 300);
      const labelEase = pLabel * pLabel * (3 - 2 * pLabel);
      if (s.inputLabel) s.inputLabel.style.opacity = String(labelEase.toFixed(3));
      if (s.outputLabel) s.outputLabel.style.opacity = String(labelEase.toFixed(3));
      if (s.activeCurrentEl) s.activeCurrentEl.style.opacity = String(labelEase.toFixed(3));
    }

    _finishEnergyMaterialization(sess) {
      if (!sess) return;
      const side = sess.side;
      if (sess.timerId) {
        cancelAnimationFrame(sess.timerId);
        sess.timerId = null;
      }
      // 1. Remove ghost if still in DOM
      if (sess.ghost && sess.ghost.parentElement) {
        sess.ghost.remove();
      }
      // Reset mat filter to canonical ready state
      if (sess.feBlur) sess.feBlur.setAttribute('stdDeviation', '0');
      if (sess.feShadow) sess.feShadow.setAttribute('flood-opacity', '0.25');

      // 2. Prepare native node into final steady ACTIVE state under transition: none
      if (sess.textEl) {
        sess.textEl.style.transition = 'none';
        sess.textEl.setAttribute('x', sess.canonicalParentXAttr);
        sess.textEl.setAttribute('text-anchor', 'middle');
        sess.textEl.setAttribute('dominant-baseline', 'middle');
        sess.textEl.setAttribute('fill', sess.color);
        sess.textEl.style.fill = sess.color;
        sess.textEl.setAttribute('filter', sess.activeFilterAttr);
        sess.textEl.style.opacity = '';
        sess.textEl.style.filter = '';
        sess.textEl.style.visibility = 'visible';
      }
      if (sess.numTspan) {
        sess.numTspan.textContent = sess.activeWattText;
        sess.numTspan.style.visibility = '';
        sess.numTspan.style.opacity = '';
        sess.numTspan.style.filter = '';
        sess.numTspan.style.letterSpacing = '';
        sess.numTspan.style.fontSize = '';
        sess.numTspan.style.fill = '';
      }
      this._trackWattShown(sess.side, sess.activeWattText);
      if (sess.wTspan) {
        sess.wTspan.removeAttribute('x');
        sess.wTspan.removeAttribute('text-anchor');
        sess.wTspan.setAttribute('dx', sess.canonicalDxAttr);
        sess.wTspan.style.opacity = '';
        sess.wTspan.style.fill = '';
      }
      if (sess.ugEl) {
        sess.ugEl.style.transition = 'none';
        sess.ugEl.style.opacity = '1';
        if (sess.core) {
          sess.core.setAttribute('x', String(sess.ugCenterX - 28));
          sess.core.setAttribute('width', '56');
          sess.core.setAttribute('opacity', '0.85');
        }
        if (sess.halo) {
          sess.halo.setAttribute('x', String(sess.ugCenterX - 40));
          sess.halo.setAttribute('width', '80');
          sess.halo.setAttribute('opacity', '0.32');
        }
      }
      // Restore baseline styles for labels & current
      if (sess.inputLabel) sess.inputLabel.style.opacity = '';
      if (sess.outputLabel) sess.outputLabel.style.opacity = '';
      if (sess.activeCurrentEl) {
        sess.activeCurrentEl.style.opacity = '';
        sess.activeCurrentEl.style.transition = '';
      }

      if (this._wattTransitions && this._wattTransitions[side] === sess) {
        this._wattTransitions[side] = null;
      }
      if (!this._wattCleanupRafs) this._wattCleanupRafs = {};
      if (this._wattCleanupRafs[side]) {
        cancelAnimationFrame(this._wattCleanupRafs[side]);
        this._wattCleanupRafs[side] = null;
      }
      const self = this;
      const cleanupRaf = requestAnimationFrame(() => {
        if (self._wattCleanupRafs && self._wattCleanupRafs[side] === cleanupRaf) {
          self._wattCleanupRafs[side] = null;
        }
        if (self._wattTransitions && self._wattTransitions[side]) return;
        if (sess.textEl) sess.textEl.style.transition = '';
        if (sess.ugEl) sess.ugEl.style.transition = '';
      });
      this._wattCleanupRafs[side] = cleanupRaf;
    }

    _clearCapsuleTimers() {
      if (this._capsuleTimers && this._capsuleTimers.length) {
        this._capsuleTimers.forEach(t => clearTimeout(t));
        this._capsuleTimers = [];
      }
    }

    _formatHeroEta(raw) {
      if (!raw) return '';
      const trimmed = String(raw).trim();
      if (trimmed.startsWith('≈')) {
        const rest = trimmed.replace(/^≈\s*/, '');
        return `<tspan class="hero-eta-approx">≈ </tspan>${rest}`;
      }
      return trimmed;
    }

    _updateDirectionalEta(state, etaText) {
      const root = document.getElementById('hero-directional-eta');
      const textEl = document.getElementById('hero-eta-text');
      if (!root || !textEl) return;

      // 1. Idempotency Check: if this target state is already being fulfilled, do not restart
      if (state === this._capsuleTargetState) {
        // Silently update text if open or unfolding
        if (this._capsulePhase === 'open' || this._capsulePhase === 'unfolding') {
          textEl.innerHTML = this._formatHeroEta(etaText);
        }
        return;
      }

      // 2. New Semantic Target -> capture previous target state and increment generation token
      const prevTargetState = this._capsuleTargetState;
      this._capsuleTargetState = state;
      const seqId = ++this._capsuleSeqId;
      this._clearCapsuleTimers();

      const schedule = (fn, delayMs) => {
        const timer = setTimeout(() => {
          if (seqId !== this._capsuleSeqId) return;
          fn();
        }, delayMs);
        this._capsuleTimers.push(timer);
      };

      // 3. TARGET: IDLE
      if (state === 'idle') {
        if (this._capsuleCurrentState === 'idle' && this._capsulePhase === 'idle') return;

        // If interrupted during ignition / holding before unfolding into capsule,
        // Shape is already a circle, so disperse immediately without collapse delay.
        if (this._capsuleCurrentState === 'idle') {
          this._capsulePhase = 'dispersing';
          root.setAttribute('data-capsule-phase', 'dispersing');
          root.setAttribute('data-capsule-color', 'neutral');
          root.classList.remove('text-visible', 'unfolded', 'unfolded-left', 'unfolded-right', 'is-color-cooling');
          root.classList.add('collapsed', 'is-idle');
          schedule(() => {
            root.setAttribute('data-capsule-phase', 'idle');
            this._capsuleCurrentState = 'idle';
            this._capsulePhase = 'idle';
            textEl.textContent = '';
            textEl.setAttribute('x', '600');
          }, 210);
          return;
        }

        this._capsulePhase = 'collapsing';
        root.setAttribute('data-capsule-phase', 'collapsing');

        // Step 1 (t = 0): ETA text begins smooth fade/clip out while pill remains fully open
        root.classList.remove('text-visible', 'is-color-cooling');

        // Step 2 (t ≈ 75ms): Symmetric pill collapse begins (small overlap with text fade)
        schedule(() => {
          root.classList.remove('unfolded', 'unfolded-left', 'unfolded-right');
          root.classList.add('collapsed');
        }, 75);

        // Step 3 (t ≈ 255ms): Start color cooling as pill enters smaller diameter (~50-60px)
        // (From 255ms to 455ms: 200ms duration matches fill/stroke/filter transition ~0.20s)
        schedule(() => {
          root.classList.add('is-color-cooling');
        }, 255);

        // Step 4 (t ≈ 455ms): Symmetric collapse finishes at 75 + 380 = 455ms
        schedule(() => {
          // Material transition is now complete -> set semantic neutral color & remove cooling class
          root.setAttribute('data-capsule-color', 'neutral');
          root.classList.remove('is-color-cooling');

          // Step 5 (t ≈ 455-500ms): Neutral-core hold (45ms) as the full-sized neutral circle
          this._capsulePhase = 'holding';
          root.setAttribute('data-capsule-phase', 'holding');

          schedule(() => {
            // Step 6 (t ≈ 500-700ms): Neutral afterglow visible dispersion (200ms CSS transition)
            this._capsulePhase = 'dispersing';
            root.setAttribute('data-capsule-phase', 'dispersing');
            root.classList.add('is-idle');

            // Step 7 (t ≈ 710ms): Dispersion completes (210ms timeout > 200ms CSS) -> settle to clean IDLE
            schedule(() => {
              root.setAttribute('data-capsule-phase', 'idle');
              this._capsuleCurrentState = 'idle';
              this._capsulePhase = 'idle';
              textEl.textContent = '';
              textEl.setAttribute('x', '600');
            }, 210);
          }, 45);
        }, 455);
        return;
      }

      // 4. TARGET: CHARGING or DISCHARGING
      // Check if recovering from IDLE transition phases or if this is a genuine active-capsule reversal
      const wasInIdleTransition = prevTargetState === 'idle' ||
                                  this._capsuleCurrentState === 'idle' ||
                                  root.classList.contains('is-idle') ||
                                  root.classList.contains('is-color-cooling') ||
                                  root.getAttribute('data-capsule-phase') === 'dispersing' ||
                                  root.getAttribute('data-capsule-phase') === 'collapsing';

      const isReversal = !wasInIdleTransition &&
                         ((this._capsuleCurrentState === 'charging' && state === 'discharging') ||
                          (this._capsuleCurrentState === 'discharging' && state === 'charging'));

      if (isReversal) {
        // Step A: Symmetrically collapse old capsule to center circle in current active color (380ms)
        this._capsulePhase = 'collapsing';
        root.setAttribute('data-capsule-phase', 'collapsing');
        root.classList.remove('text-visible', 'is-idle', 'is-color-cooling');

        // Text fades at t=0; collapse starts at t=75ms with small overlap
        schedule(() => {
          root.classList.remove('unfolded', 'unfolded-left', 'unfolded-right');
          root.classList.add('collapsed');
        }, 75);

        schedule(() => {
          // Step B: Circle smoothly morphs color in center (168ms)
          const targetColor = state === 'charging' ? 'charge' : 'discharge';
          root.setAttribute('data-capsule-color', targetColor);
          textEl.innerHTML = this._formatHeroEta(etaText);
          textEl.setAttribute('x', '600');

          schedule(() => {
            // Step C: Symmetric unfold in new state
            this._startCapsuleUnfold(root, textEl, state, seqId, schedule);
          }, 168);
        }, 455);
        return;
      }

      // IDLE -> ACTIVE (or recovering from interrupted IDLE transition / collapse):
      // Step A: Core Ignition (250ms: luminous seed visible at ~95ms, reaches full size by 250ms)
      const targetColor = state === 'charging' ? 'charge' : 'discharge';
      this._capsulePhase = 'igniting';
      root.setAttribute('data-capsule-color', targetColor);
      root.setAttribute('data-capsule-phase', 'igniting');
      textEl.innerHTML = this._formatHeroEta(etaText);
      textEl.setAttribute('x', '600');
      root.classList.remove('unfolded', 'unfolded-left', 'unfolded-right', 'text-visible', 'is-idle', 'is-color-cooling');
      root.classList.add('collapsed');

      // Step B: Hold the fully formed circle in place for 75ms (250-325ms)
      schedule(() => {
        this._capsulePhase = 'holding';
        root.setAttribute('data-capsule-phase', 'holding');

        // Step C: Symmetric unfold starts from the settled 18px core
        schedule(() => {
          this._startCapsuleUnfold(root, textEl, state, seqId, schedule);
        }, 75);
      }, 250);
    }

    _startCapsuleUnfold(root, textEl, state, seqId, schedule) {
      this._capsuleCurrentState = state;
      this._capsulePhase = 'unfolding';
      root.setAttribute('data-capsule-phase', 'unfolding');
      textEl.setAttribute('x', '600');
      root.classList.remove('collapsed');
      root.classList.add('unfolded', state === 'charging' ? 'unfolded-left' : 'unfolded-right');

      // 1. Reveal text (center-out clip + opacity + blur) when capsule reaches ~40-50% width (~68-72px)
      schedule(() => {
        root.classList.add('text-visible');
      }, 44);

      // 2. Mark phase 'open' only once geometry transition has physically completed (~350ms)
      schedule(() => {
        this._capsulePhase = 'open';
        root.setAttribute('data-capsule-phase', 'open');
      }, 350);
    }

    _setLiquidAnimationPlayback(isFull) {
      const targetRate = isFull ? 0.0 : 1.0;
      if (this._liquidTargetRate === targetRate) return;
      this._liquidTargetRate = targetRate;

      if (this._liquidAnimRaf) {
        cancelAnimationFrame(this._liquidAnimRaf);
        this._liquidAnimRaf = null;
      }

      if (typeof performance === 'undefined' || typeof requestAnimationFrame === 'undefined') {
        this._liquidPlaybackRate = targetRate;
        this._applyLiquidPlaybackRate(targetRate);
        return;
      }

      const startRate = this._liquidPlaybackRate != null ? this._liquidPlaybackRate : 1.0;
      if (Math.abs(startRate - targetRate) < 0.001) {
        this._liquidPlaybackRate = targetRate;
        this._applyLiquidPlaybackRate(targetRate);
        return;
      }

      const durationMs = 1000;
      const startTime = performance.now();

      const step = (now) => {
        const elapsed = now - startTime;
        const progress = Math.min(1, Math.max(0, elapsed / durationMs));
        const ease = 1 - Math.pow(1 - progress, 3);
        const currentRate = startRate + (targetRate - startRate) * ease;

        this._liquidPlaybackRate = currentRate;
        this._applyLiquidPlaybackRate(currentRate);

        if (progress < 1) {
          this._liquidAnimRaf = requestAnimationFrame(step);
        } else {
          this._liquidPlaybackRate = targetRate;
          this._applyLiquidPlaybackRate(targetRate);
          this._liquidAnimRaf = null;
        }
      };

      this._liquidAnimRaf = requestAnimationFrame(step);
    }

    _applyLiquidPlaybackRate(rate) {
      if (typeof document === 'undefined') return;
      const waveLayers = document.querySelectorAll('#wave-layer-1, #wave-layer-2, #wave-layer-3');
      waveLayers.forEach(layer => {
        layer.querySelectorAll('*').forEach(el => {
          if (typeof el.getAnimations === 'function') {
            el.getAnimations().forEach(anim => {
              try {
                anim.playbackRate = rate;
              } catch (_) {}
            });
          }
        });
      });
    }

    _updateMetricCard(key, opts) {
      const card = document.querySelector(`.metric-card[data-metric="${key}"]`);
      if (!card) return;
      const numEl = card.querySelector('.metric-value-num');
      const unitEl = card.querySelector('.metric-value-unit');
      const accentLine = card.querySelector('.metric-accent-line');

      if (numEl) numEl.textContent = opts.value;
      if (unitEl && opts.unit) unitEl.textContent = opts.unit;

      const isWarn = !!opts.warn;
      const isCrit = !!opts.crit;
      const isActive = opts.active;

      if (numEl) {
        numEl.style.color = '';
        numEl.style.textShadow = '';
      }

      const iconEl = card.querySelector('.metric-icon');
      const labelEl = card.querySelector('.metric-label');
      if (iconEl) {
        iconEl.style.background = '';
        iconEl.style.color = '';
        iconEl.style.borderColor = '';
      }
      if (labelEl) labelEl.style.color = '';

      if (accentLine) {
        accentLine.style.background = '';
        if (isActive && !isWarn && !isCrit) {
          accentLine.style.animation = 'accent-line-shimmer 3s ease-in-out infinite';
          accentLine.style.opacity = '';
        } else if (!isWarn && !isCrit) {
          accentLine.style.animation = 'none';
          accentLine.style.opacity = '0.4';
        }
        if (isWarn || isCrit) {
          accentLine.style.animation = 'accent-line-shimmer 3s ease-in-out infinite';
          accentLine.style.opacity = '';
        }
      }

      card.classList.toggle('is-warn', isWarn);
      card.classList.toggle('is-crit', isCrit);
      card.classList.toggle('is-idle', !isActive);
    }

    _renderLiveCells(cellData, soc) {
      const grid = document.getElementById('cell-bars-grid');
      if (!grid) return;

      if (!cellData || !cellData.valid || !cellData.list.length) {
        grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#8b949e;padding:20px;">Немає валідних даних комірок</div>';
        grid.style.maxWidth = '';
        const spreadBadgeVal = document.querySelector('#spread-badge .spread-value');
        if (spreadBadgeVal) spreadBadgeVal.textContent = 'Δ —';
        const curEl = document.getElementById('trend-current');
        if (curEl && (!this.historyRecords || !this.historyRecords.length)) curEl.textContent = '—';
        return;
      }

      const cells = cellData.list;
      const count = cells.length;
      const minV = cellData.min_v;
      const maxV = cellData.max_v;
      const refV = cellData.median_v || (minV + maxV) / 2;
      const spreadMv = cellData.spread_mv;
      const minIdx = cellData.min_cell_index;
      const maxIdx = cellData.max_cell_index;

      // 1. Maintain in-place DOM nodes and generic data-driven layout
      const expectedClass = `cell-bars-grid cols-${count} count-${count}`;
      if (grid.className !== expectedClass) grid.className = expectedClass;
      grid.style.setProperty('--cell-count', count);
      if (count <= 4) {
        grid.style.maxWidth = `${count * 110}px`;
      } else if (count <= 8) {
        grid.style.maxWidth = `${count * 95}px`;
      } else {
        grid.style.maxWidth = '';
      }

      if (grid.children.length !== count) {
        grid.innerHTML = '';
        for (let i = 0; i < count; i++) {
          const item = document.createElement('div');
          item.className = 'cell-item';
          item.innerHTML = `
            <div class="cell-voltage">0.000</div>
            <div class="cell-bar-col">
              <div class="cell-bar-fill" style="height:0%;">
                <div class="cell-bar-fill-top"></div>
              </div>
            </div>
            <div class="cell-num">01</div>
          `;
          grid.appendChild(item);
        }
      }

      const deadbandMv = 2;
      const fullDeviationMv = 50;
      const maxCorrectionPercent = 15;

      cells.forEach((c, i) => {
        const item = grid.children[i];
        if (!item) return;

        const isMin = minIdx != null && i === minIdx && minIdx !== maxIdx;
        const isMax = maxIdx != null && i === maxIdx && minIdx !== maxIdx;

        const deltaMv = (c.voltage_v - refV) * 1000;
        const absDelta = Math.abs(deltaMv);

        let correction = 0;
        if (absDelta > deadbandMv) {
          const normalized = (absDelta - deadbandMv) / (fullDeviationMv - deadbandMv);
          correction = Math.sign(deltaMv) * Math.min(normalized * maxCorrectionPercent, maxCorrectionPercent);
        }

        const fillPercent = Math.max(0, Math.min(100, Math.round(soc + correction)));
        const cellColors = getCellRelativeColors(deltaMv);

        const voltageEl = item.querySelector('.cell-voltage');
        const colEl = item.querySelector('.cell-bar-col');
        const fillEl = item.querySelector('.cell-bar-fill');
        const topEl = item.querySelector('.cell-bar-fill-top');
        const numEl = item.querySelector('.cell-num');

        if (voltageEl) {
          voltageEl.textContent = c.voltage_v.toFixed(3);
          voltageEl.className = `cell-voltage ${isMax ? 'is-max' : isMin ? 'is-min' : ''}`;
        }
        if (colEl) colEl.className = `cell-bar-col ${isMax ? 'is-max' : isMin ? 'is-min' : ''}`;
        if (fillEl) {
          fillEl.style.height = `${fillPercent}%`;
          fillEl.style.background = cellColors.cssGradient;
        }
        if (topEl) topEl.style.color = cellColors.top;
        if (numEl) {
          const displayedNumber = c.physicalNumber ?? c.logicalNumber ?? (i + 1);
          numEl.textContent = String(displayedNumber).padStart(2, '0');
          numEl.className = `cell-num ${isMax ? 'is-max' : isMin ? 'is-min' : ''}`;
        }
      });

      // Spread status badge
      const isWarn = spreadMv != null && spreadMv > this.spreadWarningThresholdMv;
      const diagColor = isWarn ? '#d29922' : '#58a6ff';
      const statusLabel = isWarn ? 'Попередження' : 'Норма';

      const badge = document.getElementById('spread-badge');
      if (badge) {
        badge.style.color = diagColor;
        badge.style.borderColor = diagColor + '40';
        badge.style.background = diagColor + '12';
        const dot = badge.querySelector('.spread-dot');
        if (dot) {
          dot.style.background = diagColor;
          dot.style.boxShadow = `0 0 6px ${diagColor}`;
        }
        const val = badge.querySelector('.spread-value');
        if (val) val.textContent = spreadMv != null ? `Δ ${spreadMv} mV` : 'Δ —';
      }

      const trendStatus = document.getElementById('trend-status');
      if (trendStatus) {
        trendStatus.textContent = statusLabel;
        trendStatus.style.color = diagColor;
        trendStatus.style.background = diagColor + '14';
        trendStatus.style.borderColor = diagColor + '30';
      }

      const curEl = document.getElementById('trend-current');
      if (curEl) {
        curEl.textContent = spreadMv != null ? `${spreadMv} mV` : '—';
        curEl.style.color = diagColor;
      }
    }

    _renderLiveSensors(sensors) {
      const grid = document.getElementById('sensor-grid');
      if (!grid) return;

      if (!Array.isArray(sensors) || !sensors.length) {
        grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#8b949e;padding:14px;">Немає активних датчиків температури</div>';
        return;
      }

      // Reuse DOM nodes if same sensors
      const existingCards = Array.from(grid.querySelectorAll('.sensor-card'));
      const existingIds = existingCards.map(c => c.dataset.sensorId);
      const newIds = sensors.map(s => s.id);

      if (existingIds.join(',') !== newIds.join(',')) {
        grid.innerHTML = '';
        sensors.forEach(s => {
          const card = document.createElement('div');
          card.className = 'sensor-card';
          card.dataset.sensorId = s.id;
          card.innerHTML = `
            <div class="sensor-head">
              <span class="sensor-dot" style="background:${s.color}; color:${s.color};"></span>
              <span class="sensor-name">${s.name}</span>
            </div>
            <div class="sensor-value-row">
              <div class="sensor-value"><span class="sensor-current">${s.val_c.toFixed(1)}</span><small class="sensor-unit">°C</small></div>
              <div class="sensor-minmax">
                <div class="sensor-minmax-col">
                  <span class="sensor-minmax-label">мін</span>
                  <strong class="sensor-min">—</strong>
                </div>
                <div class="sensor-minmax-col">
                  <span class="sensor-minmax-label">макс</span>
                  <strong class="sensor-max">—</strong>
                </div>
              </div>
            </div>
          `;
          grid.appendChild(card);
        });
      } else {
        sensors.forEach((s, i) => {
          const card = existingCards[i];
          if (!card) return;
          const curEl = card.querySelector('.sensor-current');
          if (curEl) curEl.textContent = s.val_c.toFixed(1);
        });
      }
    }

    _buildCharts() {
      const { makeAreaChart } = global.WattCharts;

      const emptyLabels = [];
      const emptyData = [];

      this.chargeChart = makeAreaChart(document.getElementById('charge-chart'), {
        datasets: [{
          label: 'charge',
          color: '#56d364',
          data: emptyData,
          fillTop: 0.24,
          fillMid: 0.02
        }],
        labels: emptyLabels,
        yBeginAtZero: true,
        yTickCount: 4,
        marginTop: 8,
        marginRight: 0,
        minTickGap: 40,
        yTickFormatter: (v, idx, ticks) => global.WattCharts.formatAdaptiveValue(v, 'W', ticks, 0),
        xTickFormatter: (val) => global.WattCharts.formatTimeShort(val),
        tooltipHtml: (dataPoints) => {
          if (!dataPoints.length || !this._history24h) return '';
          const idx = dataPoints[0].dataIndex;
          const pt = this._history24h[idx];
          if (!pt) return '';
          return `
            <div class="chart-tooltip-time">${global.WattCharts.formatDateTimeShort(pt.t * 1000)}</div>
            <div class="chart-tooltip-row">
              <span class="chart-tooltip-dot" style="background:#56d364;"></span>
              <span><strong style="color:#e6edf3;">Потужність: ${(pt.chargePower || 0).toFixed(1)} W</strong></span>
            </div>
          `;
        }
      });

      this.dischargeChart = makeAreaChart(document.getElementById('discharge-chart'), {
        datasets: [{
          label: 'discharge',
          color: '#9d8dff',
          data: emptyData,
          fillTop: 0.24,
          fillMid: 0.02
        }],
        labels: emptyLabels,
        yBeginAtZero: true,
        yTickCount: 4,
        marginTop: 8,
        marginRight: 0,
        minTickGap: 40,
        yTickFormatter: (v, idx, ticks) => global.WattCharts.formatAdaptiveValue(v, 'W', ticks, 0),
        xTickFormatter: (val) => global.WattCharts.formatTimeShort(val),
        tooltipHtml: (dataPoints) => {
          if (!dataPoints.length || !this._history24h) return '';
          const idx = dataPoints[0].dataIndex;
          const pt = this._history24h[idx];
          if (!pt) return '';
          return `
            <div class="chart-tooltip-time">${global.WattCharts.formatDateTimeShort(pt.t * 1000)}</div>
            <div class="chart-tooltip-row">
              <span class="chart-tooltip-dot" style="background:#9d8dff;"></span>
              <span><strong style="color:#e6edf3;">Потужність: ${(pt.dischargePower || 0).toFixed(1)} W</strong></span>
            </div>
          `;
        }
      });

      this.temperatureChart = makeAreaChart(document.getElementById('temperature-chart'), {
        datasets: [],
        labels: emptyLabels,
        yBeginAtZero: false,
        yTickCount: 5,
        marginTop: 12,
        marginRight: 0,
        minTickGap: 45,
        yTickFormatter: (v, idx, ticks) => global.WattCharts.formatAdaptiveValue(v, '°C', ticks, 0),
        xTickFormatter: (val) => global.WattCharts.formatTimeShort(val),
        tooltipHtml: (dataPoints) => {
          if (!dataPoints.length || !this._history24h) return '';
          const idx = dataPoints[0].dataIndex;
          const pt = this._history24h[idx];
          if (!pt) return '';
          const sensors = (this.liveData && this.liveData.temperatures && this.liveData.temperatures.sensors) || [];
          const rows = sensors.map(s => {
            const val = pt.temps[s.id];
            const valStr = val != null ? `${val.toFixed(1)} °C` : '—';
            return `
              <div class="chart-tooltip-row">
                <span class="chart-tooltip-dot" style="background:${s.color};"></span>
                <span style="color:#8b949e;">${s.name}</span>
                <strong style="color:#e6edf3; margin-left: auto;">${valStr}</strong>
              </div>
            `;
          }).join('');
          return `
            <div class="chart-tooltip-time">${global.WattCharts.formatDateTimeShort(pt.t * 1000)}</div>
            ${rows}
          `;
        }
      });

      this.trendChart = makeAreaChart(document.getElementById('trend-chart'), {
        datasets: [{
          label: 'spread',
          color: '#58a6ff',
          data: emptyData,
          fillTop: 0.22,
          fillMid: 0.02
        }],
        labels: emptyLabels,
        yBeginAtZero: true,
        yTickCount: 5,
        marginTop: 10,
        marginRight: 0,
        minTickGap: 45,
        yTickFormatter: (v, idx, ticks) => global.WattCharts.formatAdaptiveValue(v, 'mV', ticks, 0),
        xTickFormatter: (val) => global.WattCharts.formatTimeShort(val),
        extraPlugins: [{
          id: 'referenceLinesInstance',
          afterDatasetsDraw: (chart) => {
            const opts = { lines: [
              { 
                y: this.spreadWarningThresholdMv, 
                color: 'rgba(210,153,34,0.45)', 
                dash: [4, 4], 
                label: `${this.spreadWarningThresholdMv} mV (Попередження)`, 
                borderColor: 'rgba(210,153,34,0.4)', 
                textColor: '#d29922' 
              }
            ] };
            global.WattCharts.referenceLinesPlugin.afterDatasetsDraw(chart, null, opts);
          }
        }],
        tooltipHtml: (dataPoints) => {
          if (!dataPoints.length || !this._history24h) return '';
          const idx = dataPoints[0].dataIndex;
          const pt = this._history24h[idx];
          if (!pt || pt.spread_mv == null) return '';
          const val = pt.spread_mv;
          const isWarn = val > this.spreadWarningThresholdMv;
          const statusText = isWarn 
            ? `Попередження (>${this.spreadWarningThresholdMv}mV)` 
            : `Норма (≤${this.spreadWarningThresholdMv}mV)`;
          const statusColor = isWarn ? '#d29922' : '#58a6ff';
          return `
            <div class="chart-tooltip-time">${global.WattCharts.formatDateTimeShort(pt.t * 1000)}</div>
            <div class="chart-tooltip-row">
              <strong style="color:#e6edf3;">Розкид: ${val} mV</strong>
              <span style="font-size:11px;font-weight:600;padding:1px 6px;border-radius:4px;color:${statusColor};background:${statusColor}18;">${statusText}</span>
            </div>
          `;
        }
      });

      // Bind reset buttons for all Dashboard charts
      global.WattCharts.bindChartResetButton(this.chargeChart);
      global.WattCharts.bindChartResetButton(this.dischargeChart);
      global.WattCharts.bindChartResetButton(this.temperatureChart);
      global.WattCharts.bindChartResetButton(this.trendChart);
    }

    _refreshHistoryPanels() {
      const records = this.historyRecords;
      const nowSec = Math.floor(Date.now() / 1000);
      const history24h = records.filter(r => r.t >= nowSec - 86400 && r.t <= nowSec);
      this._history24h = history24h;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
      const from = yesterday.getTime() / 1000, to = today.getTime() / 1000;
      const yesterdayRecords = records.filter(r => r.t >= from && r.t < to);
      const status = global.ApiClient?.getHistoryRangeStatus?.(from, to);
      const confirmedYesterday = status?.covered === true && status.limited !== true;
      for (const [prefix, direction] of [['charge', 'charging'], ['discharge', 'discharging']]) {
        const stats = global.DataNormalizer.energyStats(history24h, direction);
        const yStats = global.DataNormalizer.energyStats(yesterdayRecords, direction);
        const value = (id, text) => { const element = document.getElementById(id); if (element) element.textContent = text; };
        const measured = stats.validIntervals > 0;
        value(prefix + '-energy', measured ? (stats.wattHours / 1000).toFixed(1) : '—');
        value(prefix + '-avg', measured ? `${Math.round(stats.average)} W` : '—');
        value(prefix + '-peak', measured ? `${Math.round(stats.peak)} W` : '—');
        value(prefix + '-time', measured ? `${Math.floor(stats.seconds / 3600)}г ${Math.floor(stats.seconds % 3600 / 60)}хв` : '—');
        value(prefix + '-yesterday', confirmedYesterday && yStats.validIntervals
          ? `${(yStats.wattHours / 1000).toFixed(1)} kWh`
          : status?.limited ? 'Неповний день' : this._historyLoadingActive ? 'Завантаження…' : '—');
      }

      // Zoom-preserving chart updates go through the shared WattCharts helper
      // (aliased at module scope — single implementation for the whole app).

      const timestamps = history24h.map(r => r.t * 1000);

      // Charge Chart
      if (this.chargeChart) {
        const chargeData = history24h.map(r => r.chargePower ?? null);
        updateChartPreservingZoom(
          this.chargeChart,
          timestamps,
          () => { this.chargeChart.data.datasets[0].data = chargeData; },
          'power',
          chargeData,
          { unit: 'W', decimals: 0 }
        );
      }

      // Discharge Chart
      if (this.dischargeChart) {
        const dischargeData = history24h.map(r => r.dischargePower ?? null);
        updateChartPreservingZoom(
          this.dischargeChart,
          timestamps,
          () => { this.dischargeChart.data.datasets[0].data = dischargeData; },
          'power',
          dischargeData,
          { unit: 'W', decimals: 0 }
        );
      }

      // Temperature Chart
      const sensors = (this.liveData && this.liveData.temperatures && this.liveData.temperatures.sensors) || [];
      if (sensors.length && this.temperatureChart) {
        const allVals = history24h.flatMap(r => sensors.map(s => r.temps[s.id])).filter(v => v != null && Number.isFinite(v));
        updateChartPreservingZoom(
          this.temperatureChart,
          timestamps,
          () => {
            this.temperatureChart.data.datasets = sensors.map(s => ({
              label: s.id,
              data: history24h.map(r => r.temps[s.id] ?? null),
              borderColor: s.color,
              borderWidth: 1.8,
              backgroundColor: 'transparent',
              fill: false,
              tension: 0.4,
              pointRadius: 0,
              pointHoverRadius: 5,
              pointHoverBackgroundColor: s.color,
              pointHoverBorderColor: '#0d1117',
              pointHoverBorderWidth: 2,
              spanGaps: true
            }));
          },
          'temperature',
          allVals,
          { unit: '°C', decimals: 0 }
        );

        // Update MIN/MAX on sensor cards
        sensors.forEach(s => {
          const card = document.querySelector(`.sensor-card[data-sensor-id="${s.id}"]`);
          if (!card) return;
          const vals = history24h.map(r => r.temps[s.id]).filter(v => v != null && Number.isFinite(v));
          const minEl = card.querySelector('.sensor-min');
          const maxEl = card.querySelector('.sensor-max');
          if (vals.length) {
            if (minEl) minEl.textContent = `${Math.min(...vals).toFixed(1)}°`;
            if (maxEl) maxEl.textContent = `${Math.max(...vals).toFixed(1)}°`;
          } else {
            if (minEl) minEl.textContent = '—';
            if (maxEl) maxEl.textContent = '—';
          }
        });
      }

      // Trend Chart
      const spreadVals = history24h.map(r => r.spread_mv).filter(v => v != null);
      if (this.trendChart) {
        if (spreadVals.length) {
          const maxSpread24h = Math.max(...spreadVals);
          const avgSpread24h = (spreadVals.reduce((a, b) => a + b, 0) / spreadVals.length).toFixed(1);

          const maxEl = document.getElementById('trend-max');
          if (maxEl) maxEl.textContent = `${maxSpread24h} mV`;
          const avgEl = document.getElementById('trend-avg');
          if (avgEl) avgEl.textContent = `${avgSpread24h} mV`;
        }

        const trendData = history24h.map(r => r.spread_mv ?? null);
        updateChartPreservingZoom(
          this.trendChart,
          timestamps,
          () => { this.trendChart.data.datasets[0].data = trendData; },
          'cell_spread',
          trendData,
          {
            unit: 'mV',
            decimals: 0,
            referenceValues: [this.spreadWarningThresholdMv]
          }
        );
      }
    }
  }

  global.Dashboard = Dashboard;
  global.formatEta = formatEta;
  global.computeDirectionalEta = computeDirectionalEta;
})(window);
