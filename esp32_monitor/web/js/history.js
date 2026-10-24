/* history.js — History view logic for real JK BMS telemetry.
 * Connects to ApiClient / DataNormalizer. Renders periods, summary cards,
 * power+SoC charts, mode split donut, detailed metrics, daily table & 14-day heatmap. */

(function (global) {
  'use strict';

  const { makeAreaChart, makePieChart, hideTooltip, dismissPinnedChart, updateChartPreservingZoom } = global.WattCharts;

  const METRIC_GROUPS = [
    { key: 'electric',    label: 'Електрика',   icon: '⚡' },
    { key: 'cells',       label: 'Комірки',     icon: '🔋' },
    { key: 'temperature', label: 'Температури', icon: '🌡️' }
  ];

  class HistoryView {
    constructor() {
      this.period = '24h';
      this.selectedGroup = 'electric';
      this.selectedMetric = 'power';
      this.rawHistory = [];
      this.filteredHistory = [];

      this.powerChart = null;
      this.socChart = null;
      this.modeChart = null;
      this.detailChart = null;

      this._unsubscribeHistory = null;
      this._unsubscribeHistoryLoading = null;
      this._loadingState = { active: false, phase: null, days: 0, pages: 0, records: 0 };
    }

    init() {
      const root = document.getElementById('view-history');
      this.root = root;

      // Period selector
      root.querySelectorAll('.period-btn').forEach(btn => {
        btn.addEventListener('click', () => this.setPeriod(btn.dataset.period));
      });

      // Metric group tabs
      root.querySelectorAll('.group-tab').forEach(btn => {
        btn.addEventListener('click', () => this.setGroup(btn.dataset.group));
      });

      this._buildCharts();

      // Subscribe to API Client
      if (global.ApiClient) {
        this._unsubscribeHistory = global.ApiClient.onHistory((history, state) => {
          this.updateHistory(history, state);
        });
        if (typeof global.ApiClient.onHistoryLoading === 'function') {
          this._unsubscribeHistoryLoading = global.ApiClient.onHistoryLoading((state) => {
            this._setLoadingState(state);
          });
        }
      }

      this._renderMetricPills();
      this._refresh();
    }

    destroy() {
      if (this._unsubscribeHistory) this._unsubscribeHistory();
      if (this._unsubscribeHistoryLoading) this._unsubscribeHistoryLoading();
      [this.powerChart, this.socChart, this.modeChart, this.detailChart].forEach(c => c && c.destroy());
      dismissPinnedChart();
      hideTooltip();
    }

    /** Loading indicator state → slim top bar + status chip in the header.
     *  Period loading is DETERMINATE: total pages ≈ days (1 page ≈ 1 day of
     *  144 records), so the chip shows «стор. X з Y» with a filling bar.
     *  Everything transitions softly: the label swap FLIP-animates the chip
     *  width (stretch/squeeze instead of jumping), completion flashes a
     *  «Готово» state with a popped checkmark, and the chip then collapses
     *  to a point instead of vanishing abruptly.
     *  Also swaps the daily-list "no data" placeholder for a loading hint. */
    _setLoadingState(state) {
      if (state) this._loadingState = state;
      const s = this._loadingState || { active: false };
      const chip = document.getElementById('history-load-chip');
      const bar = document.getElementById('history-load-bar');
      const text = document.getElementById('history-load-text');
      const fill = document.getElementById('history-load-fill');
      if (this._loadDoneTimer) { clearTimeout(this._loadDoneTimer); this._loadDoneTimer = null; }

      if (s.active) {
        if (chip) { chip.classList.remove('history-load-chip--notice'); chip.title = ''; }
        const total = s.phase === 'period' && s.days > 0 ? s.days : 0;
        let fillPct = 0;
        let label;
        if (s.phase === 'period') {
          if (total > 0 && s.pages > 0 && s.pages <= total) {
            label = `Дозавантаження ${s.days} днів · стор. ${s.pages} з ${total}`;
            fillPct = Math.max(4, Math.min(95, Math.round((s.pages / total) * 100)));
          } else if (s.pages > 0) {
            // Data is sparser than the 1-page-per-day estimate — keep going
            label = `Дозавантаження ${s.days} днів · стор. ${s.pages}`;
            fillPct = 95;
          } else {
            label = `Дозавантаження ${s.days} днів…`;
            fillPct = 4;
          }
        } else if (s.phase === 'initial') {
          label = 'Завантаження історії…';
        } else {
          label = 'Оновлення історії…';
        }
        if (chip) {
          const wasHidden = chip.hidden;
          // A collapse may still be in flight (out-anim or its fallback) —
          // disarm it, otherwise its finish() would hide an active chip.
          this._disarmChipCollapse(chip);
          chip.hidden = false;
          chip.classList.remove('history-load-chip--out', 'history-load-chip--done');
          // wasHidden → fresh appearance: entry keyframe covers it, no FLIP.
          this._swapChipText(chip, text, label, wasHidden);
        }
        if (bar) bar.classList.add('is-active');
        if (fill) {
          fill.hidden = s.phase !== 'period';
          fill.style.width = fillPct + '%';
        }
      } else {
        const prev = this._lastActiveLoadingState;
        const issue = s.outcome === 'failed' || this.historyState === 'STALE'
          ? (this.rawHistory?.length ? 'Збережені дані · неповна історія' : 'Історія недоступна')
          : s.outcome === 'paused' ? 'Завантаження призупинено'
          : s.outcome === 'limited' ? (this.rawHistory?.length ? 'Доступна лише частина періоду' : 'Записів ще немає') : '';
        if (issue && chip) {
          chip.hidden = false;
          chip.classList.add('history-load-chip--notice');
          chip.title = s.outcome === 'failed' ? 'Догрузка не завершена. Підтверджені дані збережено; повторимо спробу після відновлення зв’язку.' : issue;
          chip.classList.remove('history-load-chip--done', 'history-load-chip--out');
          this._swapChipText(chip, text, issue, false);
          if (bar) bar.classList.remove('is-active');
          if (fill) fill.hidden = true;
        } else if (s.outcome === 'complete' && prev && prev.phase === 'period' && prev.pages > 0 && chip && !chip.hidden) {
          // Brief completion flash: popped checkmark + full bar + record
          // count, then the chip gracefully collapses away.
          this._swapChipText(chip, text, `Готово · ${prev.records} ${this._recordPlural(prev.records)}`, false);
          if (fill) { fill.hidden = false; fill.style.width = '100%'; }
          chip.classList.add('history-load-chip--done');
          if (bar) bar.classList.remove('is-active');
          this._loadDoneTimer = setTimeout(() => {
            this._loadDoneTimer = null;
            this._collapseLoadChip();
          }, 1250);
        } else {
          this._collapseLoadChip();
        }
      }
      this._lastActiveLoadingState = s.active ? { ...s } : this._lastActiveLoadingState;
      // While the dataset is still empty, keep the daily list in sync
      // (loading hint ↔ no-data message) without a full chart re-render.
      if (!this.rawHistory || !this.rawHistory.length) this._refreshDailyList();
    }

    /** Swap the chip label and FLIP the pill between the old and new width,
     *  so it stretches/squeezes smoothly instead of jumping.
     *  ORDER IS ESSENTIAL: the old width MUST be measured BEFORE the text
     *  swap — measuring after would see the new label on both sides and the
     *  animation would silently become a no-op (V17.4 regression).
     *  TEXT NEVER FADES (V17.6, user request): the value simply changes in
     *  place — blinking text on every page tick read as "the chip flashes".
     *  All motion belongs to the PILL BOX: the chip is right-anchored, so a
     *  width ramp stretches it LEFTWARD over the free header space (same
     *  visual grammar as the hero ETA capsule), revealing/hiding the label
     *  tail through overflow clipping. Small (<2px) page-number ticks skip
     *  the ramp entirely — digits just flip like on a counter.
     *  skipAnim = fresh appearance: the entry keyframe covers the reveal,
     *  the text swaps without width animation (chip is at natural width). */
    _swapChipText(chip, text, label, skipAnim) {
      if (!text || text.textContent === label) return;
      const reduced = this._prefersReducedMotion();
      if (!chip || chip.hidden || reduced || skipAnim) {
        text.textContent = label;
        return;
      }
      if (this._chipWidthCleanup) { this._chipWidthCleanup(); this._chipWidthCleanup = null; }
      const from = chip.offsetWidth;          // OLD label width (current box)
      text.textContent = label;               // swap in place — no fade, the value just changes
      chip.style.transition = 'none';         // measure natural width instantly
      chip.style.width = 'auto';
      const to = chip.offsetWidth;
      if (!from || !to || Math.abs(to - from) < 2) {
        chip.style.width = '';
        chip.style.transition = '';
        return;
      }
      chip.style.width = from + 'px';
      void chip.offsetWidth;                  // pin the old width
      chip.style.transition = '';             // restore CSS transitions
      chip.style.width = to + 'px';           // → smooth stretch/squeeze
      const onEnd = (e) => {
        if (e.target !== chip || e.propertyName !== 'width') return;
        chip.style.width = '';
        chip.removeEventListener('transitionend', onEnd);
        this._chipWidthCleanup = null;
      };
      chip.addEventListener('transitionend', onEnd);
      this._chipWidthCleanup = () => chip.removeEventListener('transitionend', onEnd);
    }

    /** Cancel any pending collapse (fallback timer + transitionend hook). */
    _disarmChipCollapse(chip) {
      if (this._chipOutFallback) { clearTimeout(this._chipOutFallback); this._chipOutFallback = null; }
      if (this._chipCollapseEnd && chip) {
        chip.removeEventListener('transitionend', this._chipCollapseEnd);
      }
      this._chipCollapseEnd = null;
    }

    /** Hide the chip by collapsing it to a point (width + horizontal padding
     *  → 0, fade + slight lift), then restore the pristine hidden state.
     *  Falls back to an instant hide for reduced-motion users. */
    _collapseLoadChip() {
      const chip = document.getElementById('history-load-chip');
      const bar = document.getElementById('history-load-bar');
      const fill = document.getElementById('history-load-fill');
      if (bar) bar.classList.remove('is-active');
      if (this._loadDoneTimer) { clearTimeout(this._loadDoneTimer); this._loadDoneTimer = null; }
      this._disarmChipCollapse(chip);
      if (!chip || chip.hidden) {
        if (fill) fill.hidden = true;
        return;
      }
      const finish = () => {
        chip.hidden = true;
        chip.classList.remove('history-load-chip--out', 'history-load-chip--done');
        chip.style.width = '';
        chip.removeEventListener('transitionend', onEnd);
        if (this._chipOutFallback) { clearTimeout(this._chipOutFallback); this._chipOutFallback = null; }
        this._chipCollapseEnd = null;
        if (fill) fill.hidden = true;
      };
      const onEnd = (e) => { if (e.target === chip && e.propertyName === 'width') finish(); };
      this._chipCollapseEnd = onEnd;
      if (this._prefersReducedMotion()) { finish(); return; }
      if (this._chipWidthCleanup) { this._chipWidthCleanup(); this._chipWidthCleanup = null; }
      chip.style.transition = 'none';
      chip.style.width = chip.offsetWidth + 'px';
      void chip.offsetWidth;
      chip.style.transition = '';
      chip.classList.add('history-load-chip--out');
      chip.style.width = '0px';
      chip.addEventListener('transitionend', onEnd);
      // transitionend can be swallowed (e.g. tab hidden) — bound the wait.
      this._chipOutFallback = setTimeout(finish, 650);
    }

    _prefersReducedMotion() {
      return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    /** Ukrainian plural: 1 запис / 2-4 записи / 5+ записів */
    _recordPlural(n) {
      const n10 = n % 10, n100 = n % 100;
      if (n10 === 1 && n100 !== 11) return 'запис';
      if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return 'записи';
      return 'записів';
    }

    updateHistory(historyRecords, state) {
      this.historyState = state || this.historyState;
      this.rawHistory = Array.isArray(historyRecords) ? historyRecords : [];
      this._refresh();
      if (this._loadingState) this._setLoadingState(this._loadingState);
    }

    setPeriod(period) {
      this._resetAllHistoryZoom();
      this.period = period;
      document.querySelectorAll('.period-btn').forEach(b => {
        b.classList.toggle('is-active', b.dataset.period === period);
      });
      const days = period === '7d' ? 7 : period === '14d' ? 14 : 0;
      if (days && global.ApiClient && typeof global.ApiClient.loadHistoryPeriod === 'function') {
        global.ApiClient.loadHistoryPeriod(days).catch(() => {});
      }
      this._refresh();
    }

    setGroup(group) {
      this._resetDetailChartZoom();
      this.selectedGroup = group;
      document.querySelectorAll('.group-tab').forEach(b => {
        b.classList.toggle('is-active', b.dataset.group === group);
      });
      this._renderMetricPills();
      const validKeys = this._getActiveMetricKeys();
      if (!validKeys.includes(this.selectedMetric)) {
        this.selectedMetric = validKeys[0] || 'power';
      }
      this._renderMetricPills();
      this._refreshDetailChart();
      this._refreshMetricStats();
    }

    setMetric(key) {
      this._resetDetailChartZoom();
      this.selectedMetric = key;
      this._renderMetricPills();
      this._refreshDetailChart();
      this._refreshMetricStats();
    }

    _resetAllHistoryZoom() {
      if (this.powerChart) global.WattCharts.resetChartToAuto(this.powerChart);
      if (this.socChart) global.WattCharts.resetChartToAuto(this.socChart);
      if (this.detailChart) global.WattCharts.resetChartToAuto(this.detailChart);
    }

    _resetDetailChartZoom() {
      if (this.detailChart) global.WattCharts.resetChartToAuto(this.detailChart);
    }

    _getActiveMetrics() {
      let sensors = (global.ApiClient && global.ApiClient.liveData && global.ApiClient.liveData.temperatures && global.ApiClient.liveData.temperatures.sensors) || [];
      if (!sensors.length && this.rawHistory.length) {
        const foundSensorIds = new Set();
        this.rawHistory.forEach(r => {
          if (r.temps) {
            Object.entries(r.temps).forEach(([k, v]) => {
              if (v != null) foundSensorIds.add(k);
            });
          }
        });
        // Canonical sensor identity from data-normalizer.js (same maps that name and
        // color the live sensor cards on the dashboard). Unknown ids fall back to a
        // local palette. Do NOT fork local copies of these maps.
        const CANON_NAMES = (global.DataNormalizer && global.DataNormalizer.SENSOR_NAME_MAP) || {};
        const CANON_COLORS = (global.DataNormalizer && global.DataNormalizer.SENSOR_COLOR_MAP) || {};
        const FALLBACK_PALETTE = ['#38bdf8', '#2dd4bf', '#c084fc', '#f59e0b', '#ec4899', '#10b981'];
        let colorIdx = 0;
        sensors = Array.from(foundSensorIds).map(id => ({
          id,
          name: CANON_NAMES[id] || id.toUpperCase(),
          color: CANON_COLORS[id] || FALLBACK_PALETTE[colorIdx++ % FALLBACK_PALETTE.length]
        }));
      }

      const metrics = [
        { key: 'power',       family: 'power',        group: 'electric',    label: 'Потужність батареї',   shortLabel: 'Потужність', unit: 'W',  color: '#56d364', decimals: 0 },
        { key: 'voltage',     family: 'pack_voltage', group: 'electric',    label: 'Загальна напруга',     shortLabel: 'Напруга',    unit: 'V',  color: '#79c0ff', decimals: 2 },
        { key: 'current',     family: 'current',      group: 'electric',    label: 'Струм батареї',        shortLabel: 'Струм',      unit: 'A',  color: '#9d8dff', decimals: 1 },
        { key: 'soc',         family: 'soc',          group: 'electric',    label: 'Рівень заряду (SoC)',  shortLabel: 'SoC',        unit: '%',  color: '#58a6ff', decimals: 1 },
        { key: 'cellSpread',  family: 'cell_spread',  group: 'cells',       label: 'Розкид комірок',       shortLabel: 'Розкид',      unit: 'mV', color: '#d29922', decimals: 0 },
        { key: 'minCell',     family: 'cell_voltage', group: 'cells',       label: 'Мін. напруга комірки', shortLabel: 'Мін. V',      unit: 'V',  color: '#f85149', decimals: 3 },
        { key: 'maxCell',     family: 'cell_voltage', group: 'cells',       label: 'Макс. напруга комірки',shortLabel: 'Макс. V',     unit: 'V',  color: '#58a6ff', decimals: 3 },
        { key: 'summaryTemp', family: 'temperature',  group: 'temperature', label: 'Температура батареї (сер.)', shortLabel: 'Батарея (сер.)', unit: '°C', color: '#58A6FF', decimals: 1 }
      ];

      sensors.forEach(s => {
        metrics.push({
          key: `sensor_${s.id}`,
          family: 'temperature',
          group: 'temperature',
          label: s.name,
          shortLabel: s.name,
          unit: '°C',
          color: s.color,
          decimals: 1,
          sensorId: s.id
        });
      });

      return metrics;
    }

    _getActiveMetricKeys() {
      return this._getActiveMetrics().filter(m => m.group === this.selectedGroup).map(m => m.key);
    }

    _renderMetricPills() {
      const container = document.getElementById('metric-pills');
      if (!container) return;
      const groupMetrics = this._getActiveMetrics().filter(m => m.group === this.selectedGroup);
      container.innerHTML = '';
      for (const m of groupMetrics) {
        const btn = document.createElement('button');
        btn.className = 'metric-pill' + (this.selectedMetric === m.key ? ' is-active' : '');
        btn.textContent = m.shortLabel;
        if (this.selectedMetric === m.key) {
          btn.style.color = m.color;
        }
        btn.addEventListener('click', () => this.setMetric(m.key));
        container.appendChild(btn);
      }
    }

    _filterHistory() {
      const records = this.rawHistory;
      if (!records.length) return [];
      const nowSec = Math.floor(Date.now() / 1000);

      let cutoff = nowSec - 86400;
      if (this.period === 'today') {
        cutoff = new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000;
      } else if (this.period === '24h') {
        cutoff = nowSec - 86400;
      } else if (this.period === '7d') {
        cutoff = nowSec - (7 * 86400);
      } else if (this.period === '14d') {
        cutoff = nowSec - (14 * 86400);
      }

      return records.filter(r => r.t >= cutoff);
    }

    _refresh() {
      this.filteredHistory = this._filterHistory();

      this._refreshSummary();
      this._refreshPowerCharts();
      this._refreshModeSplit();
      this._refreshDailyList();
      this._renderHeatmap();
      this._refreshDetailChart();
      this._refreshMetricStats();
      this._updatePeriodLabel();
    }

    _updatePeriodLabel() {
      const labels = { today: 'Сьогодні', '24h': '24 год', '7d': '7 днів', '14d': '14 днів' };
      const el = document.getElementById('mode-period-label');
      if (el) el.textContent = labels[this.period];
    }

    _refreshSummary() {
      const data = this.filteredHistory;
      if (!data.length) {
        const eIn = document.getElementById('summary-energy-in');
        if (eIn) eIn.textContent = '—';
        const eOut = document.getElementById('summary-energy-out');
        if (eOut) eOut.textContent = '—';
        const sRange = document.getElementById('summary-soc-range');
        if (sRange) sRange.textContent = '—';
        const pCharge = document.getElementById('summary-peak-charge');
        if (pCharge) pCharge.textContent = '—';
        const pDischarge = document.getElementById('summary-peak-discharge');
        if (pDischarge) pDischarge.textContent = '—';
        const spacer = document.getElementById('soc-range-spacer');
        if (spacer) spacer.style.width = '0%';
        const fill = document.getElementById('soc-range-fill');
        if (fill) fill.style.width = '0%';
        return;
      }

      const normalizer = global.DataNormalizer;
      const chargeStats = normalizer.energyStats(data, 'charging');
      const dischargeStats = normalizer.energyStats(data, 'discharging');

      const energyIn = chargeStats.validIntervals ? (chargeStats.wattHours / 1000).toFixed(1) : '—';
      const energyOut = dischargeStats.validIntervals ? (dischargeStats.wattHours / 1000).toFixed(1) : '—';

      const socVals = data.map(p => p.s).filter(s => s != null);
      const minSoc = socVals.length ? Math.round(Math.min(...socVals)) : 0;
      const maxSoc = socVals.length ? Math.round(Math.max(...socVals)) : 0;

      const eIn = document.getElementById('summary-energy-in');
      if (eIn) eIn.textContent = energyIn;
      const eOut = document.getElementById('summary-energy-out');
      if (eOut) eOut.textContent = energyOut;

      const sRange = document.getElementById('summary-soc-range');
      if (sRange) sRange.textContent = socVals.length ? `${minSoc} – ${maxSoc}` : '—';

      const pCharge = document.getElementById('summary-peak-charge');
      if (pCharge) pCharge.textContent = chargeStats.validIntervals ? Math.round(chargeStats.peak) : '—';
      const pDischarge = document.getElementById('summary-peak-discharge');
      if (pDischarge) pDischarge.textContent = dischargeStats.validIntervals ? Math.round(dischargeStats.peak) : '—';

      const spacer = document.getElementById('soc-range-spacer');
      if (spacer) spacer.style.width = `${minSoc}%`;
      const fill = document.getElementById('soc-range-fill');
      if (fill) fill.style.width = `${Math.max(4, maxSoc - minSoc)}%`;
    }

    _formatHistoryTime(val) {
      const isShort = this.period === 'today' || this.period === '24h';
      return isShort
        ? global.WattCharts.formatTimeShort(val)
        : global.WattCharts.formatDateShort(val);
    }

    _buildCharts() {
      const { makeAreaChart, makePieChart } = global.WattCharts;

      // Power chart
      this.powerChart = makeAreaChart(document.getElementById('history-power-chart'), {
        datasets: [
          { label: 'charge',    color: '#56d364', data: [], fillTop: 0.22, fillMid: 0.02 },
          { label: 'discharge', color: '#9d8dff', data: [], fillTop: 0.22, fillMid: 0.02 }
        ],
        labels: [],
        yBeginAtZero: true,
        yTickCount: 4,
        marginTop: 10,
        marginRight: 0,
        minTickGap: 50,
        yTickFormatter: (v, idx, ticks) => global.WattCharts.formatAdaptiveValue(v, 'W', ticks, 0),
        xTickFormatter: (val) => this._formatHistoryTime(val),
        tooltipHtml: (dataPoints) => {
          if (!dataPoints.length || !this.filteredHistory) return '';
          const idx = dataPoints[0].dataIndex;
          const pt = this.filteredHistory[idx];
          if (!pt) return '';
          return `
            <div class="chart-tooltip-time">${global.WattCharts.formatDateTimeShort(pt.t * 1000)}</div>
            <div class="chart-tooltip-row"><span class="chart-tooltip-dot" style="background:#56d364;"></span><span>Заряджання: <strong style="color:#e6edf3;">${(pt.chargePower || 0)} W</strong></span></div>
            <div class="chart-tooltip-row"><span class="chart-tooltip-dot" style="background:#9d8dff;"></span><span>Розряджання: <strong style="color:#e6edf3;">${(pt.dischargePower || 0)} W</strong></span></div>
          `;
        }
      });

      // SoC chart
      this.socChart = makeAreaChart(document.getElementById('history-soc-chart'), {
        datasets: [
          { label: 'soc', color: '#58a6ff', data: [], fillTop: 0.22, fillMid: 0.02 }
        ],
        labels: [],
        yBeginAtZero: true,
        yTickCount: 4,
        yScale: { min: 0, max: 100 },
        marginTop: 10,
        marginRight: 0,
        minTickGap: 50,
        yTickFormatter: (v) => `${Math.round(v)}%`,
        xTickFormatter: (val) => this._formatHistoryTime(val),
        tooltipHtml: (dataPoints) => {
          if (!dataPoints.length || !this.filteredHistory) return '';
          const idx = dataPoints[0].dataIndex;
          const pt = this.filteredHistory[idx];
          if (!pt) return '';
          return `
            <div class="chart-tooltip-time">${global.WattCharts.formatDateTimeShort(pt.t * 1000)}</div>
            <div class="chart-tooltip-row"><span class="chart-tooltip-dot" style="background:#58a6ff;"></span><span>Рівень заряду: <strong style="color:#e6edf3;">${(pt.s != null ? pt.s : 0)}%</strong></span></div>
          `;
        }
      });

      // Mode split donut
      this.modeChart = makePieChart(document.getElementById('history-mode-chart'), [
        { name: 'Заряджання', value: 0, color: '#56d364' },
        { name: 'Розряджання', value: 0, color: '#9d8dff' },
        { name: 'Очікування', value: 0, color: '#30363d' }
      ]);

      // Detail chart
      this.detailChart = makeAreaChart(document.getElementById('history-detail-chart'), {
        datasets: [
          { label: 'metric', color: '#56d364', data: [], fillTop: 0.22, fillMid: 0.02 }
        ],
        labels: [],
        yBeginAtZero: false,
        yTickCount: 5,
        marginTop: 10,
        marginRight: 0,
        minTickGap: 50,
        yTickFormatter: (v) => `${v}`,
        xTickFormatter: (val) => this._formatHistoryTime(val),
        tooltipHtml: (dataPoints) => {
          if (!dataPoints.length || !this.filteredHistory) return '';
          const idx = dataPoints[0].dataIndex;
          const pt = this.filteredHistory[idx];
          if (!pt) return '';
          const m = this._getActiveMetrics().find(item => item.key === this.selectedMetric);
          if (!m) return '';
          const val = this._extractPointMetricValue(pt, m);
          const valStr = val != null ? `${val.toFixed(m.decimals)} ${m.unit}` : '—';
          return `
            <div class="chart-tooltip-time">${global.WattCharts.formatDateTimeShort(pt.t * 1000)}</div>
            <div class="chart-tooltip-row">
              <span class="chart-tooltip-dot" style="background:${m.color};"></span>
              <span style="color:#8b949e;">${m.label}:</span>
              <strong style="color:#e6edf3; margin-left: auto;">${valStr}</strong>
            </div>
          `;
        }
      });

      // Bind reset buttons for History charts
      global.WattCharts.bindChartResetButton(this.powerChart);
      global.WattCharts.bindChartResetButton(this.socChart);
      global.WattCharts.bindChartResetButton(this.detailChart);
    }

    _refreshPowerCharts() {
      const data = this.filteredHistory;
      const timestamps = data.map(p => p.t * 1000);

      // updateChartPreservingZoom comes from WattCharts (module-level import above;
      // single shared implementation for the whole app).

      if (this.powerChart) {
        const chargeData = data.map(p => p.chargePower ?? null);
        const dischargeData = data.map(p => p.dischargePower ?? null);
        const powerVals = [...chargeData, ...dischargeData];
        updateChartPreservingZoom(
          this.powerChart,
          timestamps,
          () => {
            this.powerChart.data.datasets[0].data = chargeData;
            this.powerChart.data.datasets[1].data = dischargeData;
          },
          'power',
          powerVals,
          { unit: 'W', decimals: 0 }
        );
      }

      if (this.socChart) {
        const socData = data.map(p => p.s != null ? p.s : null);
        updateChartPreservingZoom(
          this.socChart,
          timestamps,
          () => {
            this.socChart.data.datasets[0].data = socData;
          },
          'soc',
          socData,
          { unit: '%', decimals: 0 }
        );
      }
    }

    _refreshModeSplit() {
      const data = this.filteredHistory;
      const listContainer = document.getElementById('mode-list');
      const periodLabel = document.getElementById('mode-period-label');
      if (periodLabel) {
        periodLabel.textContent = this.period === 'today' ? 'Сьогодні' : this.period === '24h' ? '24 год' : this.period === '7d' ? '7 днів' : '14 днів';
      }

      if (!data || !global.DataNormalizer.energyStats(data, 'charging').validIntervals) {
        if (listContainer) {
          const emptyModes = [
            { name: 'Заряджання', pct: null, hours: '—', color: '#56d364' },
            { name: 'Розряджання', pct: null, hours: '—', color: '#9d8dff' },
            { name: 'Очікування', pct: null, hours: '—', color: '#484f58' }
          ];
          listContainer.innerHTML = emptyModes.map(m => `
            <div class="mode-list-item">
              <div class="mode-item-head">
                <div class="mode-item-name-row">
                  <span class="mode-item-dot" style="background-color: ${m.color};"></span>
                  <span class="mode-item-name">${m.name}</span>
                </div>
                <div class="mode-item-num">
                  <strong>${m.pct == null ? '—' : m.pct + '%'}</strong> <span class="mode-item-hours">(${m.hours} год)</span>
                </div>
              </div>
              <div class="mode-item-progress">
                <div class="mode-item-progress-fill" style="width: ${m.pct || 0}%; background-color: ${m.color};"></div>
              </div>
            </div>
          `).join('');
        }
        if (this.modeChart) {
          this.modeChart.data.datasets[0].data = [0, 0, 0];
          this.modeChart.update('none');
        }
        return;
      }

      let chargeSec = 0, dischargeSec = 0, idleSec = 0;
      for (let i = 1; i < data.length; i++) {
        const dt = data[i].t - data[i - 1].t;
        if (dt <= 0 || dt > 1200) continue;
        if ([data[i - 1].v, data[i - 1].a, data[i].v, data[i].a].some(v => v == null)) continue;
        const m = data[i].mode;
        if (m === 'charging') chargeSec += dt;
        else if (m === 'discharging') dischargeSec += dt;
        else idleSec += dt;
      }

      const totalSec = chargeSec + dischargeSec + idleSec;
      const chargePct = totalSec > 0 ? Math.round((chargeSec / totalSec) * 100) : 0;
      const dischargePct = totalSec > 0 ? Math.round((dischargeSec / totalSec) * 100) : 0;
      const idlePct = totalSec > 0 ? Math.max(0, 100 - chargePct - dischargePct) : 100;

      const chargeHours = (chargeSec / 3600).toFixed(1);
      const dischargeHours = (dischargeSec / 3600).toFixed(1);
      const idleHours = (idleSec / 3600).toFixed(1);

      const modes = [
        { name: 'Заряджання', pct: chargePct, hours: chargeHours, color: '#56d364' },
        { name: 'Розряджання', pct: dischargePct, hours: dischargeHours, color: '#9d8dff' },
        { name: 'Очікування', pct: idlePct, hours: idleHours, color: '#484f58' }
      ];

      if (listContainer) {
        listContainer.innerHTML = modes.map(m => `
          <div class="mode-list-item">
            <div class="mode-item-head">
              <div class="mode-item-name-row">
                <span class="mode-item-dot" style="background-color: ${m.color};"></span>
                <span class="mode-item-name">${m.name}</span>
              </div>
              <div class="mode-item-num">
                <strong>${m.pct == null ? '—' : m.pct + '%'}</strong> <span class="mode-item-hours">(${m.hours} год)</span>
              </div>
            </div>
            <div class="mode-item-progress">
              <div class="mode-item-progress-fill" style="width: ${m.pct || 0}%; background-color: ${m.color};"></div>
            </div>
          </div>
        `).join('');
      }

      if (this.modeChart) {
        const modeData = [chargePct, dischargePct, idlePct];
        const activeCount = modeData.filter(v => v > 0).length;
        this.modeChart.data.datasets[0].data = modeData;
        this.modeChart.data.datasets[0].spacing = activeCount > 1 ? 3 : 0;
        this.modeChart.update('none');
      }
    }

    _extractPointMetricValue(pt, metricDef) {
      if (!pt || !metricDef) return null;
      switch (metricDef.key) {
        case 'power': return pt.power;
        case 'voltage': return pt.v;
        case 'current': return pt.a != null ? Math.abs(pt.a) : null;
        case 'soc': return pt.s;
        case 'cellSpread': return pt.spread_mv;
        case 'minCell': return pt.min_cell_v;
        case 'maxCell': return pt.max_cell_v;
        case 'summaryTemp': return pt.summary_battery_temp_c;
        default:
          if (metricDef.sensorId) {
            return pt.temps[metricDef.sensorId];
          }
          return null;
      }
    }

    _refreshDetailChart() {
      const data = this.filteredHistory;
      const m = this._getActiveMetrics().find(item => item.key === this.selectedMetric);
      if (!m || !this.detailChart) return;

      const timestamps = data.map(p => p.t * 1000);
      const values = data.map(p => this._extractPointMetricValue(p, m));

      const updateDataFn = () => {
        this.detailChart.data.datasets[0].data = values;
        this.detailChart.data.datasets[0].label = m.label;
        this.detailChart.data.datasets[0].borderColor = m.color;

        // Dynamically recreate gradient fill matching makeAreaChart style for the active metric
        const canvas = this.detailChart.canvas;
        const ctx = this.detailChart.ctx;
        if (ctx && canvas) {
          const grad = ctx.createLinearGradient(0, 0, 0, canvas.clientHeight || 200);
          grad.addColorStop(0, global.WattCharts.hexAlpha(m.color, 0.22));
          grad.addColorStop(0.85, global.WattCharts.hexAlpha(m.color, 0.02));
          grad.addColorStop(1, global.WattCharts.hexAlpha(m.color, 0));
          this.detailChart.data.datasets[0].backgroundColor = grad;
          this.detailChart.data.datasets[0].pointHoverBackgroundColor = m.color;
        }
      };

      // Centralized Y-axis domain calculation using authoritative cell count & UI spread threshold.
      // Contract of data-normalizer.js: topology lives at liveData.cells.* (cells.count + cells.valid).
      // Top-level liveData.cell_count does not exist in normalized data — guard the read.
      const cells = (global.ApiClient && global.ApiClient.liveData && global.ApiClient.liveData.cells) || null;
      const cellCount = (cells && cells.valid && Number.isFinite(cells.count) && cells.count > 0) ? cells.count : undefined;
      // Canonical threshold: dashboard-owned accessor (validated, 1..29 mV, default 15).
      // Do NOT read localStorage directly here — the key and defaults live in dashboard.js.
      const spreadWarn = global.WattSpreadThreshold ? global.WattSpreadThreshold.read() : 15;
      const options = {
        unit: m.unit,
        decimals: m.decimals,
        cellCount,
        referenceValues: (m.family === 'cell_spread') ? [spreadWarn] : undefined
      };

      // Shared zoom-preserving update (same helper the power/SoC charts use).
      updateChartPreservingZoom(this.detailChart, timestamps, updateDataFn, m.family, values, options);
    }

    _refreshMetricStats() {
      const data = this.filteredHistory;
      const m = this._getActiveMetrics().find(item => item.key === this.selectedMetric);
      if (!m) return;

      const values = data.map(p => this._extractPointMetricValue(p, m)).filter(v => v != null && Number.isFinite(v));
      const minVal = values.length ? Math.min(...values) : null;
      const maxVal = values.length ? Math.max(...values) : null;
      const avgVal = values.length ? (values.reduce((s, v) => s + v, 0) / values.length) : null;

      const formatVal = (v) => v != null ? `${v.toFixed(m.decimals)} ${m.unit}` : '—';

      const minEl = document.getElementById('detail-min');
      if (minEl) minEl.textContent = formatVal(minVal);
      const avgEl = document.getElementById('detail-avg');
      if (avgEl) avgEl.textContent = formatVal(avgVal);
      const maxEl = document.getElementById('detail-max');
      if (maxEl) maxEl.textContent = formatVal(maxVal);
    }

    _refreshDailyList() {
      const container = document.getElementById('daily-list');
      if (!container) return;

      const countEl = document.getElementById('daily-count');
      const footerTextEl = document.getElementById('daily-footer-text');
      const records = this.rawHistory;

      if (!records || !records.length) {
        const loading = this._loadingState && this._loadingState.active;
        container.innerHTML = `<div style="text-align:center;color:#8b949e;padding:16px;font-size:13px;">${loading ? 'Завантаження даних…' : 'Немає історичних даних'}</div>`;
        if (countEl) countEl.textContent = '0';
        if (footerTextEl) footerTextEl.textContent = 'Записів немає';
        return;
      }

      // Group records by calendar day (local midnight)
      const dayGroups = new Map();
      records.forEach(r => {
        const d = new Date(r.t * 1000);
        const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (!dayGroups.has(dayKey)) dayGroups.set(dayKey, []);
        dayGroups.get(dayKey).push(r);
      });

      const dayNamesShort = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const yDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      const yesterdayKey = `${yDate.getFullYear()}-${String(yDate.getMonth() + 1).padStart(2, '0')}-${String(yDate.getDate()).padStart(2, '0')}`;

      const sortedDayKeys = Array.from(dayGroups.keys()).sort().reverse().slice(0, 14);
      container.innerHTML = '';

      sortedDayKeys.forEach(key => {
        const dayRecords = dayGroups.get(key);
        const normalizer = global.DataNormalizer;
        const cStats = normalizer ? normalizer.energyStats(dayRecords, 'charging') : { wattHours: 0 };
        const dStats = normalizer ? normalizer.energyStats(dayRecords, 'discharging') : { wattHours: 0 };

        const socVals = dayRecords.map(r => r.s).filter(s => s != null && Number.isFinite(s));
        const minSoc = socVals.length ? Math.min(...socVals) + '%' : '—';

        const spreadVals = dayRecords.map(r => r.spread_mv).filter(s => s != null && Number.isFinite(s));
        const maxSpread = spreadVals.length ? Math.max(...spreadVals) : '—';

        const d = new Date(dayRecords[0].t * 1000);
        let dayLabel = '';
        if (key === todayKey) {
          dayLabel = 'Сьогодні';
        } else if (key === yesterdayKey) {
          dayLabel = 'Вчора';
        } else {
          dayLabel = dayNamesShort[d.getDay()];
        }
        const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
        const range = global.ApiClient?.getHistoryRangeStatus?.(dayStart.getTime() / 1000, dayEnd.getTime() / 1000 - 1);
        const partial = range && (!range.covered || range.limited);
        const dateStr = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;

        const inKwh = cStats.validIntervals ? (cStats.wattHours / 1000).toFixed(1) : '—';
        const outKwh = dStats.validIntervals ? (dStats.wattHours / 1000).toFixed(1) : '—';

        const row = document.createElement('div');
        row.className = 'daily-row';
        row.innerHTML = `
          <div class="daily-row-day">
            <span class="daily-day-label">${dayLabel}</span>
            <span class="daily-row-date">${dateStr}${partial ? " · частина" : ""}</span>
          </div>
          <div class="daily-row-inout">
            <span class="daily-row-in">${inKwh}</span>
            <span class="daily-row-sep"> / </span>
            <span class="daily-row-out">${outKwh}</span>
          </div>
          <div class="daily-row-minsoc">${minSoc}</div>
          <div class="daily-row-spread">${maxSpread} <small class="daily-spread-unit">mV</small></div>
        `;
        container.appendChild(row);
      });

      if (countEl) countEl.textContent = String(sortedDayKeys.length);
      if (footerTextEl) {
        footerTextEl.textContent = ['failed', 'paused'].includes(this._loadingState?.outcome)
          ? 'Догрузка не завершена' : sortedDayKeys.length > 5 ? '↓ Прокрутіть для перегляду' : 'Доступні дні показано';
      }
    }

    _renderHeatmap() {
      const body = document.getElementById('heatmap-body');
      if (!body) return;

      const records = this.rawHistory;
      const dayNames = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
      const now = new Date();
      const rows = [];

      for (let d = 0; d < 14; d++) {
        const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
        const startSec = targetDate.getTime() / 1000;
        const endSec = startSec + 86400;

        const dayRecords = records.filter(r => r.t >= startSec && r.t < endSec);
        const weekdayLabel = dayNames[targetDate.getDay()];
        const dateLabel = `${String(targetDate.getDate()).padStart(2, '0')}.${String(targetDate.getMonth() + 1).padStart(2, '0')}`;

        const cells = [];
        for (let h = 0; h < 24; h++) {
          const hStart = startSec + (h * 3600);
          const hEnd = hStart + 3600;
          const hRecords = dayRecords.filter(r => r.t >= hStart && r.t < hEnd);

          let powerW = 0;
          let activeSeconds = 0;
          let totalWattSeconds = 0;

          for (let i = 1; i < hRecords.length; i++) {
            const dt = hRecords[i].t - hRecords[i - 1].t;
            if (dt <= 0 || dt > 1200) continue;
            if (hRecords[i - 1].dischargePower == null || hRecords[i].dischargePower == null) continue;
            const pPrev = hRecords[i - 1].dischargePower;
            const pCurr = hRecords[i].dischargePower;
            const avgP = (pPrev + pCurr) / 2;
            totalWattSeconds += avgP * dt;
            activeSeconds += dt;
          }

          if (activeSeconds > 0) {
            powerW = Math.round(totalWattSeconds / activeSeconds);
          }

          const hasData = activeSeconds > 0;
          cells.push({ hour: h, powerW, hasData });
        }

        rows.push({ dayIndex: d, weekdayLabel, dateLabel, cells });
      }

      const HEATMAP_STOPS = [
        { t: 0.00, r: 22, g: 27, b: 34 },  // #161b22
        { t: 0.15, r: 21, g: 39, b: 61 },  // #15273d
        { t: 0.35, r: 26, g: 59, b: 97 },  // #1a3b61
        { t: 0.55, r: 34, g: 83, b: 138 }, // #22538a
        { t: 0.75, r: 45, g: 111, b: 184 },// #2d6fb8
        { t: 0.90, r: 58, g: 135, b: 219 },// #3a87db
        { t: 1.00, r: 88, g: 166, b: 255 } // #58a6ff
      ];

      function getHeatmapColor(powerW, hasData) {
        if (!hasData) return '#161b22';
        if (powerW <= 0) return '#1c2128';

        const rawRatio = Math.max(0, Math.min(1, powerW / 5000));
        const visualRatio = Math.pow(rawRatio, 0.4);

        for (let i = 0; i < HEATMAP_STOPS.length - 1; i++) {
          const s1 = HEATMAP_STOPS[i];
          const s2 = HEATMAP_STOPS[i + 1];
          if (visualRatio >= s1.t && visualRatio <= s2.t) {
            const span = s2.t - s1.t;
            const factor = span === 0 ? 0 : (visualRatio - s1.t) / span;
            const r = Math.round(s1.r + (s2.r - s1.r) * factor);
            const g = Math.round(s1.g + (s2.g - s1.g) * factor);
            const b = Math.round(s1.b + (s2.b - s1.b) * factor);
            return `rgb(${r}, ${g}, ${b})`;
          }
        }
        return '#58a6ff';
      }

      body.innerHTML = '';
      rows.forEach(r => {
        const rowEl = document.createElement('div');
        rowEl.className = 'heatmap-row';

        const dayLabelEl = document.createElement('div');
        dayLabelEl.className = 'heatmap-row-label';
        dayLabelEl.innerHTML = `<span class="heatmap-row-weekday${r.dayIndex === 0 ? ' is-today' : ''}">${r.weekdayLabel}</span><span class="heatmap-row-date">${r.dateLabel}</span>`;
        rowEl.appendChild(dayLabelEl);

        r.cells.forEach(c => {
          const cellEl = document.createElement('div');
          cellEl.className = 'heatmap-cell';
          cellEl.style.background = getHeatmapColor(c.powerW, c.hasData);
          cellEl.title = `${r.dateLabel} ${String(c.hour).padStart(2, '0')}:00 — ${c.hasData ? "Навантаження: " + c.powerW + " W" : "немає достатніх вимірювань"}`;
          rowEl.appendChild(cellEl);
        });

        body.appendChild(rowEl);
      });
    }
  }

  global.HistoryView = HistoryView;
})(window);
