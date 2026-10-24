/* charts.js — Chart.js v4 configuration helpers for WattPost.
 * Recharts-style theme (grid 3-3 dash, monospace ticks, gradient fills,
 * custom tooltips) on top of Chart.js v4. */

(function (global) {
  'use strict';

  if (!global.Chart) {
    console.error('[charts.js] Chart.js is not loaded.');
    return;
  }

  // Register ChartZoom plugin if present
  if (global.Chart && global.ChartZoom && typeof global.Chart.register === 'function') {
    try {
      global.Chart.register(global.ChartZoom);
    } catch (_) {}
  }

  // Register Chart.js components globally (we use UMD bundle which auto-registers
  // all controllers, scales, elements, plugins — so just defaults are fine).

  // ─── Common style fragments ───
  const FONT_MONO = 'ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Monaco, Consolas, monospace';
  const FONT_SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const GRID_COLOR = 'rgba(255,255,255,0.035)';
  const AXIS_LINE_COLOR = 'rgba(255,255,255,0.06)';
  const TICK_COLOR = '#8b949e';

  // Custom plugin that draws a dashed 3-3 Cartesian grid like Recharts (both X and Y)
  const rechartsGridPlugin = {
    id: 'rechartsGrid',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      ctx.save();
      ctx.strokeStyle = GRID_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);

      // Horizontal lines (from Y axis ticks)
      const yScale = scales.y;
      if (yScale && yScale.ticks) {
        const ticks = yScale.ticks;
        for (const t of ticks) {
          const y = yScale.getPixelForValue(t.value);
          if (y < chartArea.top - 0.5 || y > chartArea.bottom + 0.5) continue;
          ctx.beginPath();
          ctx.moveTo(chartArea.left, y);
          ctx.lineTo(chartArea.right, y);
          ctx.stroke();
        }
      }

      // Vertical lines (from X axis ticks)
      const xScale = scales.x;
      if (xScale && xScale.ticks) {
        for (const t of xScale.ticks) {
          const x = xScale.getPixelForValue(t.value);
          if (x < chartArea.left - 0.5 || x > chartArea.right + 0.5) continue;
          ctx.beginPath();
          ctx.moveTo(x, chartArea.top);
          ctx.lineTo(x, chartArea.bottom);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  };

  // Plugin that draws a vertical & horizontal dashed crosshair guide line at active hover position
  const rechartsCrosshairPlugin = {
    id: 'rechartsCrosshair',
    afterEvent(chart, args) {
      const event = args.event;
      if (event.type === 'mousemove' || event.type === 'pointermove') {
        const chartArea = chart.chartArea;
        if (chartArea && event.x >= chartArea.left && event.x <= chartArea.right &&
            event.y >= chartArea.top && event.y <= chartArea.bottom) {
          chart._crosshairCursor = { x: event.x, y: event.y };
          args.changed = true;
        } else {
          chart._crosshairCursor = null;
        }
      } else if (event.type === 'mouseout' || event.type === 'pointerleave' || event.type === 'mouseleave') {
        chart._crosshairCursor = null;
      }
    },
    afterDraw(chart) {
      const activeElements = (typeof chart.getActiveElements === 'function')
        ? chart.getActiveElements()
        : (chart.tooltip?._active || []);

      if (activeElements.length && chart.chartArea) {
        const activePoint = activeElements[0];
        const ctx = chart.ctx;
        const chartArea = chart.chartArea;

        // Vertical line at active X (stays bounded to chartArea.top -> chartArea.bottom)
        const x = activePoint.element.x;
        const topY = chartArea.top;
        const bottomY = chartArea.bottom;

        // Horizontal line at current cursor Y (stays bounded to chartArea.left -> chartArea.right)
        let cursorY = chart._crosshairCursor?.y;
        if (cursorY === undefined || cursorY === null) {
          cursorY = activePoint.element.y;
        }

        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
        ctx.setLineDash([3, 3]);

        // Draw vertical crosshair line
        ctx.beginPath();
        ctx.moveTo(x, topY);
        ctx.lineTo(x, bottomY);
        ctx.stroke();

        // Draw horizontal crosshair line
        if (cursorY >= chartArea.top && cursorY <= chartArea.bottom) {
          ctx.beginPath();
          ctx.moveTo(chartArea.left, cursorY);
          ctx.lineTo(chartArea.right, cursorY);
          ctx.stroke();
        }

        ctx.restore();
      }
    }
  };

  // Tooltip helper — produces HTML like Recharts custom tooltip
  function makeTooltipElement(html) {
    const el = document.createElement('div');
    el.className = 'chart-tooltip recharts-tooltip';
    el.innerHTML = html;
    return el;
  }

  function formatTimeShort(t) {
    const d = new Date(t);
    return d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  }

  function formatDateTimeShort(t) {
    const d = new Date(t);
    return d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) +
      ' • ' + d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
  }

  function formatDateShort(t) {
    const d = new Date(t);
    return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
  }

  function getAdaptiveDecimals(ticks, fallbackDecimals = 0) {
    if (!ticks || ticks.length < 2) return fallbackDecimals;
    let minDiff = Infinity;
    for (let i = 1; i < ticks.length; i++) {
      const diff = Math.abs(ticks[i].value - ticks[i - 1].value);
      if (diff > 1e-6 && diff < minDiff) minDiff = diff;
    }
    if (!Number.isFinite(minDiff) || minDiff >= 0.999) return fallbackDecimals;
    for (let d = 1; d <= 4; d++) {
      const factor = Math.pow(10, d);
      if (Math.abs(Math.round(minDiff * factor) - (minDiff * factor)) < 1e-4) {
        return Math.max(d, fallbackDecimals);
      }
    }
    return Math.max(2, fallbackDecimals);
  }

  function formatAdaptiveValue(val, unit, ticks, fallbackDecimals = 0) {
    if (val == null || !Number.isFinite(val)) return '';
    const decimals = getAdaptiveDecimals(ticks, fallbackDecimals);
    return `${Number(val).toFixed(decimals)}${unit || ''}`;
  }

  // Build a Chart.js Area chart (single or multi-dataset) that visually matches
  // Recharts AreaChart with gradient fill + grid + ticks + custom tooltip.
  function makeAreaChart(canvas, config) {
    const ctx = canvas.getContext('2d');
    // Build a vertical gradient for the fill, matching Recharts' linearGradient.
    // The gradient is sized to the canvas CSS height, which changes when the
    // container resizes — so it is rebuilt in onResize (see options below).
    const buildDatasetGradient = (ds) => {
      const grad = ctx.createLinearGradient(0, 0, 0, canvas.clientHeight || 200);
      const stop0 = (ds.fillTop !== undefined) ? ds.fillTop : 0.24;
      const stop85 = (ds.fillMid !== undefined) ? ds.fillMid : 0.02;
      grad.addColorStop(0, hexAlpha(ds.color, stop0));
      grad.addColorStop(0.85, hexAlpha(ds.color, stop85));
      grad.addColorStop(1, hexAlpha(ds.color, 0));
      return grad;
    };
    const datasets = config.datasets.map((ds) => {
      return {
        label: ds.label || '',
        data: ds.data,
        borderColor: ds.color,
        borderWidth: ds.borderWidth || 1.8,
        backgroundColor: (ds.fill === false) ? 'transparent' : buildDatasetGradient(ds),
        fill: ds.fill !== false,
        tension: 0.4,           // monotone-cubic-ish smoothness
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: ds.color,
        pointHoverBorderColor: '#0d1117',
        pointHoverBorderWidth: 2
      };
    });

    // Build plugin list: always include rechartsGrid and rechartsCrosshair; append any extraPlugins
    const plugins = [rechartsGridPlugin, rechartsCrosshairPlugin].concat(config.extraPlugins || []);

    // Recharts XAxis with dataKey="time" uses category semantics (no type="number"),
    // which means the first datapoint is at the left plot edge and last at the right.
    // Chart.js 'linear' scale adds nice() padding so data doesn't reach the edges.
    // We emulate Recharts category axis with type:'category' for the X axis.
    //
    // 'labels' in config are the raw values; Chart.js category scale maps index→label
    // and the first point is exactly at chartArea.left, last at chartArea.right.
    //
    // For hidden X axes (history-power-chart) config.xHidden=true → display:false.

    // Determine effective Y-axis width.
    // Recharts YAxis width={N} defines the tick label area box (not margin).
    // We need enough px to render the widest formatted tick label.
    // We approximate by measuring text with a temporary canvas context.
    const yAxisWidth = (() => {
      const configWidth = config.yAxisWidth;
      if (configWidth !== undefined) return configWidth;
      // Measure the widest tick label this chart will produce
      const testCtx = document.createElement('canvas').getContext('2d');
      testCtx.font = '11.5px ' + FONT_MONO;
      // Sample a few representative values using the formatter
      const sampleValues = [0, 100, 1000, 10000];
      let maxW = 32; // absolute minimum
      if (config.yTickFormatter) {
        sampleValues.forEach(v => {
          const lbl = config.yTickFormatter(v);
          if (lbl) maxW = Math.max(maxW, Math.ceil(testCtx.measureText(lbl).width) + 8);
        });
      }
      return Math.min(maxW, 60); // cap at 60px (prevents oversized axis)
    })();

    const chart = new Chart(ctx, {
      type: 'line',
      data: { datasets, labels: config.labels },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        onResize: (chart) => {
          // Rebuild area gradients for the new canvas height. Uses the dataset's
          // CURRENT borderColor (history detail-chart recolors datasets on metric
          // switch), with the static fill stops from the original config.
          chart.data.datasets.forEach((ds, idx) => {
            const src = config.datasets[idx] || {};
            if (src.fill === false || ds.fill === false) return;
            ds.backgroundColor = buildDatasetGradient({
              color: ds.borderColor || src.color,
              fillTop: src.fillTop,
              fillMid: src.fillMid
            });
          });
        },
        interaction: {
          mode: 'index',
          intersect: false,
          axis: 'x'
        },
        // Chart.js is deliberately input-deaf: events = [] detaches ALL of its
        // native interaction listeners (mouse AND touch). The pointer lifecycle
        // below owns hover/scrub/scroll classification, so no internal Chart.js
        // pipeline can pop the floating tooltip or latch the crosshair while
        // the page scrolls (mobile bug: values "chasing the finger"). Wheel
        // zoom / pinch / pan are unaffected — the zoom plugin attaches its own
        // wheel + hammer listeners, not gated by options.events.
        events: [],
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: false,
            external: (context) => {
              externalTooltipHandler(context, config.tooltipHtml);
            }
          },
          zoom: (config.zoom !== false) ? {
            pan: {
              enabled: true,
              mode: 'x',
              modifierKey: null,
              onPanStart: ({ chart }) => {
                if (!chart._wattZoomState?.isZoomed) {
                  return false;
                }
                const wrapper = chart.canvas?.closest('.chart-wrapper');
                if (wrapper) wrapper.classList.add('is-panning');
                hideTooltip();
              },
              onPan: ({ chart }) => {
                _syncZoomStateFromScale(chart, config);
              },
              onPanComplete: ({ chart }) => {
                const wrapper = chart.canvas?.closest('.chart-wrapper');
                if (wrapper) wrapper.classList.remove('is-panning');
                _syncZoomStateFromScale(chart, config);
              },
              onPanRejected: ({ chart }) => {
                const wrapper = chart.canvas?.closest('.chart-wrapper');
                if (wrapper) wrapper.classList.remove('is-panning');
              }
            },
            zoom: {
              wheel: {
                enabled: true,
                modifierKey: 'ctrl',
                speed: 0.08
              },
              pinch: {
                enabled: true
              },
              mode: 'x',
              onZoomStart: () => {
                hideTooltip();
              },
              onZoom: ({ chart }) => {
                _syncZoomStateFromScale(chart, config);
              },
              onZoomComplete: ({ chart }) => {
                _syncZoomStateFromScale(chart, config);
              }
            },
            limits: {
              x: { minRange: 4 }
            }
          } : false
        },
        layout: {
          padding: {
            left: 0,
            right: (config.marginRight !== undefined) ? config.marginRight : 0,
            top: (config.marginTop !== undefined) ? config.marginTop : 8,
            bottom: (config.marginBottom !== undefined) ? config.marginBottom : 0
          }
        },
        scales: {
          x: Object.assign({
            // 'category' scale: index 0 → left plot edge, index N-1 → right plot edge.
            // This matches Recharts default <XAxis> category semantics exactly.
            type: 'category',
            grid: { display: false, drawBorder: false },
            border: { color: AXIS_LINE_COLOR },
            display: config.xHidden ? false : true,
            offset: false, // no padding at edges — category scale default is true, override
            ticks: {
              color: TICK_COLOR,
              font: { size: 11.5, family: FONT_MONO },
              maxRotation: 0,
              autoSkip: true,
              // minTickGap equivalent: use maxTicksLimit based on chart width and label width
              // Recharts minTickGap={45} → skip ticks when gap < 45px
              autoSkipPadding: (config.minTickGap !== undefined) ? config.minTickGap : 45,
              maxTicksLimit: config.xMaxTicks || 12,
              callback: config.xTickFormatter
                ? function(val, idx) {
                    // Category value is the index in the full label array;
                    // idx is only the position among visible ticks after zoom.
                    const label = this.getLabelForValue(val);
                    return config.xTickFormatter(label, idx);
                  }
                : undefined
            }
          }, config.xScale || {}),
          y: Object.assign({
            beginAtZero: config.yBeginAtZero !== false,
            grid: { display: false, drawBorder: false },
            border: { display: false },
            afterFit: (axis) => {
              // Only force width if explicitly set; otherwise let Chart.js size it naturally.
              // This prevents clipping of longer labels (e.g. '2500W', '28°C').
              if (config.yAxisWidth !== undefined) {
                axis.width = config.yAxisWidth;
              }
            },
            ticks: {
              padding: 4,
              color: TICK_COLOR,
              font: { size: 11.5, family: FONT_MONO },
              count: config.yTickCount || 4,
              callback: config.yTickFormatter
            }
          }, config.yScale || {})
        }
      },
      plugins: plugins
    });
    // Readout/pin plumbing needs the per-chart HTML builder outside this
    // closure (re-pin after data updates — updateChartPreservingZoom).
    chart._wattTooltipHtml = config.tooltipHtml;

    // Continuous pointer tracking: mouse/pen hover updates the floating tooltip
    // on EVERY pointermove for fluid, non-stepped tracking.
    // Touch is FULLY owned here (Chart.js is deaf to touch — see options.events):
    // a vertical drag always belongs to page scrolling (CSS touch-action: pan-y),
    // only a clearly horizontal drag scrubs values, and even a latched scrub
    // hands over to scrolling once the drag turns predominantly vertical (real
    // scrolls wiggle horizontally at the start — the latch must not survive it).
    // pointercancel/pointerup/page-scroll always hide everything. The gate is
    // NEVER disarmed mid-gesture (blocked flag) — disarming it would re-arm
    // every other show-path.
    let touchGesture = null; // { id, x0, y0, scrub, blocked, multi } — mirrored to chart._touchGate
    const setTouchGesture = (g) => {
      touchGesture = g;
      chart._touchGate = g;
    };

    // Sync Chart.js active elements (crosshair) with the tooltip's shown index.
    // force=true re-renders even without an index change (desktop hover tracks
    // the pointer's Y live — parity with the former beforeEvent crosshair hook,
    // which is dead now that Chart.js sees no input events).
    const applyInteraction = (shown, force) => {
      if (shown) {
        if (force || shown.index !== chart._wattScrubIdx) {
          chart._wattScrubIdx = shown.index;
          try {
            chart.setActiveElements(shown.list);
            chart.update('none');
          } catch (_) {}
        }
      } else if (chart._wattScrubIdx !== undefined) {
        chart._wattScrubIdx = undefined;
        try {
          chart.setActiveElements([]);
          chart.update('none');
        } catch (_) {}
      }
    };

    // Cancel a pending press-to-inspect timer (helper)
    const clearPress = (g) => {
      if (g && g.pressTimer) {
        clearTimeout(g.pressTimer);
        g.pressTimer = null;
      }
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      // Second+ finger while a LIVE gesture is in progress (pinch zoom) — keep
      // the tooltip suppressed for the whole multi-touch sequence. A finished
      // gesture (blocked latch from a previous swipe) must NOT count as multi,
      // or every swipe after the first would be dead.
      const multi = !!(touchGesture && !touchGesture.blocked);
      setTouchGesture({ id: e.pointerId, x0: e.clientX, y0: e.clientY, scrub: false, blocked: false, multi, live: false, t0: performance.now() });
      if (multi) {
        // Pinch starts: a pinned readout would sit under two moving fingers.
        unpinChart(chart);
        deactivateChartInteraction(chart);
        return;
      }
      // Press-to-inspect — the touch read path. After a short hold the values
      // appear in the FIXED readout strip (never under the finger) and the
      // crosshair marks the read point; release PINS them so everything can
      // be read with the finger lifted. A page scroll through the chart never
      // shows them: any movement > 6px cancels the hold, and vertical intent /
      // pointercancel hide instantly and latch the gesture blocked.
      const g = touchGesture;
      g.pressTimer = setTimeout(() => {
        if (!touchGesture || touchGesture.id !== e.pointerId || touchGesture.blocked || touchGesture.scrub) return;
        const gg = touchGesture;
        gg.live = true;
        // Fixed readout strip + crosshair (applyInteraction) — the hold shows
        // live values; the pin itself happens on release.
        const shown = updateTooltipForChart(chart, e, config.tooltipHtml, { touch: true });
        if (shown) applyInteraction(shown, false);
      }, 120);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') {
        if (!e.isPrimary || !touchGesture || e.pointerId !== touchGesture.id) return;
        const g = touchGesture;
        // The finger started moving decisively — it is not a stationary press
        if (g.pressTimer && Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > 6) clearPress(g);
        if (g.multi || g.blocked) return; // pinch / page scroll own this gesture
        const wrapper = chart.canvas.closest('.chart-wrapper');
        if (wrapper && wrapper.classList.contains('is-panning')) {
          clearPress(g);
          unpinChart(chart);
          deactivateChartInteraction(chart); // pan owns the gesture
          return;
        }
        const dx = e.clientX - g.x0;
        const dy = e.clientY - g.y0;
        if (g.scrub) {
          // A latched scrub surrenders to scrolling once the drag turns
          // predominantly vertical.
          if (Math.abs(dy) > 24 && Math.abs(dy) > Math.abs(dx)) {
            g.blocked = true;
            g.live = false;
            unpinChart(chart);
            deactivateChartInteraction(chart);
            return;
          }
          g.live = true; // scrub is an inspect gesture → release will pin it
          const shown = updateTooltipForChart(chart, e, config.tooltipHtml, { touch: true });
          // Crosshair glued to the scrubbed index; re-render on index change only
          applyInteraction(shown, false);
          return;
        }
        // Intent phase — decide what this gesture is before showing anything.
        if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) {
          clearPress(g);
          g.blocked = true; // vertical intent — gesture belongs to page scrolling
          g.live = false;
          unpinChart(chart);
          deactivateChartInteraction(chart);
          return;
        }
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
          clearPress(g);
          g.scrub = true; // horizontal scrub — tooltip follows the finger
        }
        return; // ambiguous or first scrub move — apply on the next move
      }
      // A real mouse takes over: a touch pin has no meaning under hover.
      if (chart._wattPinned) unpinChart(chart);
      applyInteraction(updateTooltipForChart(chart, e, config.tooltipHtml), true);
    });

    canvas.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'touch' || !touchGesture || e.pointerId !== touchGesture.id) return;
      const g = touchGesture;
      const wasMulti = g.multi;
      const wasBlocked = g.blocked;
      const heldMs = performance.now() - g.t0;
      const movedPx = Math.hypot(e.clientX - g.x0, e.clientY - g.y0);
      // Latch the gate as blocked instead of removing it: browsers synthesize
      // mouse events (mousemove/click) right after a tap, and Chart.js must
      // never react to them. The object is replaced on the next pointerdown.
      clearPress(g);
      g.blocked = true;

      if (wasMulti) {
        unpinChart(chart);
        deactivateChartInteraction(chart);
        return;
      }
      if (wasBlocked) {
        // Scroll / pinch owned the gesture — nothing is on screen to pin.
        deactivateChartInteraction(chart);
        return;
      }
      if (g.live || g.scrub) {
        // Release after hold / scrub → PIN: crosshair + readout stay visible
        // with the finger lifted — values live at the bottom edge of the
        // chart, the read point is fully visible. That is the whole point.
        if (pinChart(chart)) return;
        unpinChart(chart);
        deactivateChartInteraction(chart);
        return;
      }
      if (heldMs < 120 && movedPx < 8) {
        // Quick tap → pin at the tapped point; read with the finger up.
        const shown = updateTooltipForChart(chart, e, config.tooltipHtml, { touch: true });
        if (shown) {
          applyInteraction(shown, false);
          if (pinChart(chart)) return;
        }
        // Tap in a dead zone: restore an already-pinned readout untouched,
        // otherwise stay quiet.
        if (chart._wattPinned) reapplyPinAfterDataUpdate(chart);
        else deactivateChartInteraction(chart);
        return;
      }
      // Micro-drift under the thresholds with no live readout — hide.
      unpinChart(chart);
      deactivateChartInteraction(chart);
    });

    canvas.addEventListener('pointercancel', (e) => {
      if (e.pointerType !== 'touch') return;
      if (touchGesture) {
        clearPress(touchGesture);
        touchGesture.blocked = true;
      }
      unpinChart(chart);
      deactivateChartInteraction(chart);
    });

    canvas.addEventListener('pointerleave', () => {
      deactivateChartInteraction(chart);
    });

    return chart;
  }

  // ─── Touch readout strip + tap-to-pin (V17.12) ───
  // The floating tooltip works for the mouse, but on a phone the finger
  // covers both the plate and the exact point being read. Touch inspection
  // therefore renders values into a FIXED strip (.watt-readout) at the bottom
  // edge of the chart wrapper and PINS the crosshair on release/quick tap, so
  // values and the read point are examined with the finger lifted.
  let pinnedChart = null;

  function getReadoutEl(chart, create) {
    const canvas = chart && chart.canvas;
    if (!canvas || !canvas.isConnected) return null;
    const wrapper = canvas.closest('.chart-wrapper');
    if (!wrapper) return null;
    let el = wrapper.querySelector(':scope > .watt-readout');
    if (!el && create) {
      el = document.createElement('div');
      el.className = 'watt-readout';
      wrapper.appendChild(el);
    }
    return el || null;
  }

  function showReadout(chart, html) {
    const el = getReadoutEl(chart, true);
    if (!el) return;
    el.innerHTML = html;
    // Bottom edge cut by the viewport → flip the strip to the top of the
    // wrapper so it can never appear off-screen under the finger.
    const r = el.parentElement.getBoundingClientRect();
    const bottomCut = r.bottom > window.innerHeight + 4;
    const topOk = r.top >= 8;
    el.classList.toggle('watt-readout--top', bottomCut && topOk);
    el.classList.add('is-on');
  }

  function hideReadout(chart) {
    const el = getReadoutEl(chart, false);
    if (el) el.classList.remove('is-on');
  }

  function elementsAtIndex(chart, index) {
    const out = [];
    for (let dsIdx = 0; dsIdx < chart.data.datasets.length; dsIdx++) {
      const meta = chart.getDatasetMeta(dsIdx);
      if (meta && meta.data && meta.data[index]) {
        out.push({ element: meta.data[index], datasetIndex: dsIdx, index: index });
      }
    }
    return out;
  }

  // Pin = crosshair + readout survive after the finger lifts. Anchored by
  // timestamp so a live data update can re-find the same point.
  function pinChart(chart) {
    const idx = chart._wattScrubIdx;
    if (idx === undefined || idx === null) return false;
    const labels = chart.data && chart.data.labels;
    if (!labels || !labels.length) return false;
    if (pinnedChart && pinnedChart !== chart) {
      const old = pinnedChart;
      unpinChart(old);
      deactivateChartInteraction(old);
    }
    pinnedChart = chart;
    chart._wattPinned = true;
    chart._wattPinTime = labels[idx] !== undefined ? labels[idx] : null;
    return true;
  }

  function unpinChart(chart) {
    if (!chart) return;
    if (pinnedChart === chart) pinnedChart = null;
    chart._wattPinned = false;
    chart._wattPinTime = undefined;
    hideReadout(chart);
  }

  // Dismiss whatever is pinned (tap outside the chart, view destroy).
  function dismissPinnedChart() {
    if (!pinnedChart) return;
    const c = pinnedChart;
    unpinChart(c);
    deactivateChartInteraction(c);
  }

  // Tap anywhere outside the pinned chart's canvas dismisses the pin
  // (capture: runs before another chart's own listeners, so tapping chart B
  // cleanly replaces a pin on chart A).
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('pointerdown', (e) => {
      if (!pinnedChart) return;
      const canvas = pinnedChart.canvas;
      if (canvas && canvas.contains(e.target)) return;
      dismissPinnedChart();
    }, true);
  }

  // After a data update the labels array may have shifted (the live view
  // slides its window) — re-anchor the pin by timestamp, drop it if the point
  // slid out of the window. Called from updateChartPreservingZoom only.
  function reapplyPinAfterDataUpdate(chart) {
    if (!chart || !chart._wattPinned) return;
    if (chart._wattPinTime == null) {
      unpinChart(chart);
      deactivateChartInteraction(chart);
      return;
    }
    const labels = chart.data && chart.data.labels;
    const idx = labels ? labels.indexOf(chart._wattPinTime) : -1;
    const list = (idx >= 0) ? elementsAtIndex(chart, idx) : [];
    if (idx < 0 || !list.length) {
      unpinChart(chart);
      deactivateChartInteraction(chart);
      return;
    }
    chart._wattScrubIdx = idx;
    try {
      chart.setActiveElements(list);
      chart.update('none');
    } catch (_) {}
    const builder = chart._wattTooltipHtml;
    if (builder) {
      const dataPoints = list.map((el) => {
        const ds = chart.data.datasets[el.datasetIndex];
        return {
          datasetIndex: el.datasetIndex,
          dataIndex: idx,
          dataset: ds,
          raw: ds.data[idx],
          label: labels[idx]
        };
      });
      const html = builder(dataPoints, chart);
      if (html) showReadout(chart, html);
      else {
        unpinChart(chart);
        deactivateChartInteraction(chart);
      }
    }
  }

  let activeChartId = null;
  let isTooltipActive = false;

  // Recharts 2.15.4 standard TooltipBoundingBox calculation
  // Computes translateX and translateY relative to chart viewBox (canvas container)
  function computeRechartsTooltipPosition({
    coordinate,
    tooltipDimension,
    viewBox,
    offset = 10,
    allowEscapeViewBox = { x: false, y: false },
    reverseDirection = { x: false, y: false }
  }) {
    function getAxisTranslate(key, dimKey) {
      const coord = coordinate[key];
      const dim = tooltipDimension[dimKey];
      const negative = coord - dim - offset;
      const positive = coord + offset;

      if (allowEscapeViewBox[key]) {
        return reverseDirection[key] ? negative : positive;
      }

      if (reverseDirection[key]) {
        const tooltipBoundary = negative;
        const viewBoxBoundary = viewBox[key];
        if (tooltipBoundary < viewBoxBoundary) {
          return Math.max(positive, viewBox[key]);
        }
        return Math.max(negative, viewBox[key]);
      }

      const tooltipBoundary = positive + dim;
      const viewBoxBoundary = viewBox[key] + viewBox[dimKey];
      if (tooltipBoundary > viewBoxBoundary) {
        return Math.max(negative, viewBox[key]);
      }
      return Math.max(positive, viewBox[key]);
    }

    return {
      x: getAxisTranslate('x', 'width'),
      y: getAxisTranslate('y', 'height')
    };
  }

  // Continuous pointer event tooltip updater — called on every pointermove.
  // opts.touch: values render into the fixed .watt-readout strip inside the
  // chart wrapper instead of the floating plate (on a phone the finger covers
  // both the plate and the point being read — see V17.12).
  function updateTooltipForChart(chart, e, htmlBuilder, opts) {
    const rect = chart.canvas.getBoundingClientRect();
    const ptrX = e.clientX - rect.left;
    const ptrY = e.clientY - rect.top;

    // Stale pointer: outside the canvas (page scrolled or layout shifted between
    // scheduling and dispatch). Never show values for a chart the pointer is
    // not over — stray events are what made values "fly around the screen".
    if (ptrX < -4 || ptrY < -4 || ptrX > rect.width + 4 || ptrY > rect.height + 4) {
      chart._lastPointerX = undefined;
      chart._lastPointerY = undefined;
      hideTooltip();
      return;
    }

    chart._lastPointerX = ptrX;
    chart._lastPointerY = ptrY;
    // Crosshair follows the pointer's Y (the former beforeEvent hook did this
    // while Chart.js still saw input events; afterDraw reads it on re-render)
    chart._crosshairCursor = { x: ptrX, y: ptrY };

    // Get active elements at pointer position
    let elements = chart.getElementsAtEventForMode(e, 'index', { intersect: false }, false);
    if (!elements || elements.length === 0) {
      const chartArea = chart.chartArea;
      if (chartArea && ptrX >= chartArea.left - 10 && ptrX <= chartArea.right + 10) {
        const meta = chart.getDatasetMeta(0);
        if (meta && meta.data && meta.data.length > 0) {
          let closestIdx = 0;
          let minDist = Infinity;
          meta.data.forEach((pt, idx) => {
            const dist = Math.abs(pt.x - ptrX);
            if (dist < minDist) {
              minDist = dist;
              closestIdx = idx;
            }
          });
          elements = chart.data.datasets.map((_, dsIdx) => {
            const m = chart.getDatasetMeta(dsIdx);
            return (m && m.data && m.data[closestIdx]) ? { element: m.data[closestIdx], datasetIndex: dsIdx, index: closestIdx } : null;
          }).filter(Boolean);
        }
      }
    }

    if (!elements || elements.length === 0) {
      hideTooltip();
      if (opts && opts.touch) hideReadout(chart);
      return;
    }

    const firstElement = elements[0];
    const index = firstElement.index;
    const dataPoints = elements.map(el => {
      const ds = chart.data.datasets[el.datasetIndex];
      return {
        datasetIndex: el.datasetIndex,
        dataIndex: index,
        dataset: ds,
        raw: ds.data[index],
        label: chart.data.labels ? chart.data.labels[index] : ''
      };
    });

    // Touch path (V17.12): the fixed readout strip replaces the floating
    // plate — values never sit under the finger. The crosshair (line +
    // highlighted dots) is applied by the caller via applyInteraction(); it
    // is what tells the user WHICH point is being read.
    if (opts && opts.touch) {
      hideTooltip();
      if (htmlBuilder) {
        const html = htmlBuilder(dataPoints, chart);
        if (html) showReadout(chart, html);
        else hideReadout(chart);
      }
      return { index: index, list: elements };
    }

    // Mouse path — the floating plate, unchanged.
    const tooltipEl = getOrCreateTooltipEl();
    if (htmlBuilder) {
      tooltipEl.innerHTML = htmlBuilder(dataPoints, chart);
    }

    const chartId = (chart.canvas && chart.canvas.id) ? chart.canvas.id : chart.id;
    // coordinate.x: snapped data tick X (matches Recharts coordinate.x)
    // coordinate.y: continuous pointer Y (matches Recharts validateChartY)
    const coordX = firstElement.element.x;
    const coordY = ptrY;

    const tooltipWidth = tooltipEl.offsetWidth || 160;
    const tooltipHeight = tooltipEl.offsetHeight || 60;

    const viewBox = {
      x: 0,
      y: 0,
      width: rect.width || chart.width,
      height: rect.height || chart.height
    };

    const relPos = computeRechartsTooltipPosition({
      coordinate: { x: coordX, y: coordY },
      tooltipDimension: { width: tooltipWidth, height: tooltipHeight },
      viewBox: viewBox,
      offset: 10
    });

    let targetX = rect.left + relPos.x;
    let targetY = rect.top + relPos.y;

    const pad = 8;
    targetX = Math.max(pad, Math.min(window.innerWidth - pad - tooltipWidth, targetX));
    targetY = Math.max(pad, Math.min(window.innerHeight - pad - tooltipHeight, targetY));

    targetX = Math.round(targetX);
    targetY = Math.round(targetY);

    const isNewChart = (activeChartId !== chartId);
    const wasHidden = !isTooltipActive;

    if (wasHidden || isNewChart) {
      tooltipEl.classList.add('no-transition');
      tooltipEl.style.transform = `translate3d(${targetX}px, ${targetY}px, 0)`;
      void tooltipEl.offsetHeight; // Force reflow
      tooltipEl.classList.remove('no-transition');
      tooltipEl.classList.add('is-visible');
      isTooltipActive = true;
      activeChartId = chartId;
    } else {
      tooltipEl.style.transform = `translate3d(${targetX}px, ${targetY}px, 0)`;
      if (!isTooltipActive) {
        tooltipEl.classList.add('is-visible');
        isTooltipActive = true;
      }
    }

    // Touch scrubber uses this to glue the crosshair to the shown index
    return { index: index, list: elements };
  }

  // Fallback for Chart.js external callback (e.g. keyboard / programmatic events).
  // Touch never reaches Chart.js (options.events is mouse-only) — this guard is
  // defence in depth for any future touch-related regression.
  function externalTooltipHandler(context, htmlBuilder) {
    const chart = context.chart;
    // While a touch gesture has not declared horizontal scrub intent, the
    // floating tooltip must not pop from Chart.js's internal pipeline.
    if (chart._touchGate && !chart._touchGate.scrub) {
      hideTooltip();
      return;
    }
    const tooltipModel = context.tooltip;
    if (!tooltipModel || tooltipModel.opacity === 0) {
      // Chart.js's internal model is empty — but the floating tooltip may be
      // pointer-driven by our own lifecycle (press-to-inspect, hover, scrub).
      // All hides are explicit in that lifecycle, so an empty model (data tick,
      // deactivate, resize) must never force-hide it.
      return;
    }
    // A viewport-pinned tooltip must not outlive its chart: if the canvas has
    // scrolled out of view, any position we compute is junk.
    const vpRect = chart.canvas.getBoundingClientRect();
    if (vpRect.width === 0 || vpRect.bottom < -4 || vpRect.top > window.innerHeight + 4) {
      hideTooltip();
      return;
    }
    if (chart._lastPointerX !== undefined && chart._lastPointerY !== undefined) {
      // Already handled continuously via pointermove
      return;
    }
    const tooltipEl = getOrCreateTooltipEl();
    if (tooltipModel.body && htmlBuilder) {
      const dataPoints = tooltipModel.dataPoints || [];
      tooltipEl.innerHTML = htmlBuilder(dataPoints, chart);
    }
    const rect = chart.canvas.getBoundingClientRect();
    const coordX = tooltipModel.caretX;
    const coordY = tooltipModel.caretY;
    const tooltipWidth = tooltipEl.offsetWidth || 160;
    const tooltipHeight = tooltipEl.offsetHeight || 60;
    const viewBox = { x: 0, y: 0, width: rect.width || chart.width, height: rect.height || chart.height };
    const relPos = computeRechartsTooltipPosition({
      coordinate: { x: coordX, y: coordY },
      tooltipDimension: { width: tooltipWidth, height: tooltipHeight },
      viewBox: viewBox,
      offset: 10
    });
    let targetX = Math.round(rect.left + relPos.x);
    let targetY = Math.round(rect.top + relPos.y);
    tooltipEl.style.transform = `translate3d(${targetX}px, ${targetY}px, 0)`;
    tooltipEl.classList.add('is-visible');
    isTooltipActive = true;
    activeChartId = (chart.canvas && chart.canvas.id) ? chart.canvas.id : chart.id;
  }

  function getOrCreateTooltipEl() {
    let el = document.getElementById('chart-tooltip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'chart-tooltip';
      el.className = 'chart-tooltip';
      document.body.appendChild(el);
    }
    return el;
  }

  function hideTooltip() {
    const el = document.getElementById('chart-tooltip');
    if (el) {
      el.classList.remove('is-visible');
    }
    isTooltipActive = false;
    activeChartId = null;
  }

  // Touch end/cancel: drop Chart.js active elements (crosshair) and hide the
  // floating tooltip. Chart.js alone keeps them latched — it never hears
  // pointercancel, and touchend leaves its internal tooltip active.
  function deactivateChartInteraction(chart) {
    // A pinned crosshair + readout survive generic deactivations (finger
    // lifted, mouse left the canvas). Only an explicit unpin — vertical
    // scroll intent, pointercancel, pinch, outside tap, data update — clears
    // them; every such path calls unpinChart() first, flipping the flag.
    if (chart && chart._wattPinned) {
      hideTooltip();
      return;
    }
    chart._lastPointerX = undefined;
    chart._lastPointerY = undefined;
    chart._wattScrubIdx = undefined;
    chart._crosshairCursor = null;
    try {
      chart.setActiveElements([]);
      if (chart.tooltip && typeof chart.tooltip.setActiveElements === 'function') {
        chart.tooltip.setActiveElements([], { x: 0, y: 0 });
      }
      chart.update('none');
    } catch (_) {}
    hideTooltip();
  }

  // Safety net: the tooltip is pinned to the viewport (body-level element with
  // a translate3d transform), so any page scroll — touch pan, wheel, programmatic
  // — would leave it stranded over unrelated content. Hide it the moment the
  // page scrolls (capture: true also catches scrolls of inner containers).
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('scroll', () => {
      if (isTooltipActive) hideTooltip();
    }, { passive: true, capture: true });
  }

  // ─── Utilities ───

  // Convert "#56d364" + alpha → "rgba(86,211,100,alpha)"
  function hexAlpha(hex, alpha) {
    if (hex.startsWith('rgba') || hex.startsWith('rgb(')) return hex;
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // "Nice" ticks helper: produce a y-axis domain like Recharts' ['auto','auto'].
  function niceDomain(values, padding = 0.05) {
    if (!values.length) return [0, 1];
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) { min -= 1; max += 1; }
    const range = max - min;
    const pad = range * padding;
    return [min - pad, max + pad];
  }

  // Build a Chart.js Pie chart with custom colors and a fixed center (used by history).
  function makePieChart(canvas, segments) {
    const ctx = canvas.getContext('2d');
    const nonZeroCount = segments.filter(s => s.value > 0).length;
    return new Chart(ctx, {
      type: 'doughnut',
      data: {
        datasets: [{
          data: segments.map(s => s.value),
          backgroundColor: segments.map(s => s.color),
          borderColor: 'transparent',
          borderWidth: 0,
          spacing: nonZeroCount > 1 ? 3 : 0,
          hoverOffset: 0
        }],
        labels: segments.map(s => s.name)
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        cutout: '64%',
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false }
        }
      }
    });
  }

  // Reference lines plugin (e.g. warning line on cell spread chart).
  // Each ref has {y, color, dash, label}.
  const referenceLinesPlugin = {
    id: 'referenceLines',
    afterDatasetsDraw(chart, args, opts) {
      if (!opts || !opts.lines) return;
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      const yScale = scales.y;
      if (!yScale) return;

      ctx.save();
      opts.lines.forEach(ref => {
        const y = yScale.getPixelForValue(ref.y);
        if (y < chartArea.top - 1 || y > chartArea.bottom + 1) return;
        ctx.strokeStyle = ref.color;
        ctx.lineWidth = 1;
        ctx.setLineDash(ref.dash || [4, 4]);
        ctx.beginPath();
        ctx.moveTo(chartArea.left, y);
        ctx.lineTo(chartArea.right, y);
        ctx.stroke();

        // Draw pill label
        if (ref.label) {
          const text = ref.label;
          ctx.font = '600 11px ' + FONT_MONO;
          const textWidth = ctx.measureText(text).width + 12;
          const rightInset = 10;
          const textX = chartArea.right - rightInset - 6;

          // Adaptive placement: if not enough room above the line (y - 20 < chartArea.top), place below line
          const placeBelow = (y - 20 < chartArea.top);
          const rectY = placeBelow ? (y + 4) : (y - 20);
          const textY = placeBelow ? (y + 16) : (y - 8);

          ctx.setLineDash([]);
          ctx.fillStyle = '#161b22';
          ctx.globalAlpha = 0.92;
          roundRect(ctx, textX - textWidth + 2, rectY, textWidth, 16, 4);
          ctx.fill();
          ctx.globalAlpha = 1;

          ctx.strokeStyle = ref.borderColor || ref.color;
          ctx.lineWidth = 0.8;
          roundRect(ctx, textX - textWidth + 2, rectY, textWidth, 16, 4);
          ctx.stroke();

          ctx.fillStyle = ref.textColor || ref.color;
          ctx.textAlign = 'end';
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(text, textX, textY);
        }
      });
      ctx.restore();
    }
  };

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // ─── Centralized Y-Axis Domain Engine ───
  function extractValidNumbers(input) {
    if (!input) return [];
    if (!Array.isArray(input)) return [];
    const out = [];
    function scan(item) {
      if (item == null) return;
      if (Array.isArray(item)) {
        for (let i = 0; i < item.length; i++) scan(item[i]);
      } else if (typeof item === 'number' && Number.isFinite(item)) {
        out.push(item);
      }
    }
    scan(input);
    return out;
  }

  function computeYAxisDomain(metricFamily, rawValues, options = {}) {
    const vals = extractValidNumbers(rawValues);
    const hasData = vals.length > 0;
    const dataMin = hasData ? Math.min(...vals) : null;
    const dataMax = hasData ? Math.max(...vals) : null;

    if (!hasData) {
      if (metricFamily === 'soc') {
        return {
          hasData: false,
          min: 0,
          max: 100,
          beginAtZero: true,
          stepSize: 25,
          span: 100,
          dataMin: null,
          dataMax: null
        };
      }
      return {
        hasData: false,
        min: undefined,
        max: undefined,
        beginAtZero: ['power', 'current', 'cell_spread'].includes(metricFamily),
        stepSize: undefined,
        span: 0,
        dataMin: null,
        dataMax: null
      };
    }

    switch (metricFamily) {
      case 'soc': {
        return {
          hasData: true,
          min: 0,
          max: 100,
          beginAtZero: true,
          stepSize: 25,
          span: 100,
          dataMin,
          dataMax
        };
      }

      case 'power': {
        const minSpan = options.minSpan !== undefined ? options.minSpan : 50;
        const effectiveMax = Math.max(0, dataMax);
        let quantum = 25;
        if (effectiveMax > 2000) quantum = 250;
        else if (effectiveMax > 500) quantum = 100;
        else if (effectiveMax > 100) quantum = 50;

        const targetMax = Math.max(minSpan, Math.ceil((effectiveMax * 1.15) / quantum) * quantum);
        return {
          hasData: true,
          min: 0,
          max: targetMax,
          beginAtZero: true,
          stepSize: undefined,
          span: targetMax,
          dataMin,
          dataMax
        };
      }

      case 'current': {
        const minSpan = options.minSpan !== undefined ? options.minSpan : 5.0;
        const effectiveMax = Math.max(0, dataMax);
        const quantum = effectiveMax > 10 ? 2.0 : 0.5;
        const targetMax = Math.max(minSpan, Math.ceil((effectiveMax * 1.15) / quantum) * quantum);
        return {
          hasData: true,
          min: 0,
          max: Number(targetMax.toFixed(2)),
          beginAtZero: true,
          stepSize: undefined,
          span: targetMax,
          dataMin,
          dataMax
        };
      }

      case 'cell_spread': {
        const minSpan = options.minSpan !== undefined ? options.minSpan : 15;
        const refMax = (Array.isArray(options.referenceValues) && options.referenceValues.length)
          ? Math.max(...options.referenceValues.filter(v => v != null && Number.isFinite(v)))
          : 0;
        const effectiveDataMax = Math.max(0, dataMax);
        const effectiveMax = Math.max(effectiveDataMax, refMax);
        const quantum = effectiveMax > 40 ? 10 : 5;
        const targetMax = Math.max(minSpan, refMax, Math.ceil((effectiveDataMax * 1.25) / quantum) * quantum);
        return {
          hasData: true,
          min: 0,
          max: targetMax,
          beginAtZero: true,
          stepSize: undefined,
          span: targetMax,
          dataMin,
          dataMax
        };
      }

      case 'pack_voltage': {
        const vMin = dataMin;
        const vMax = dataMax;
        const cellCount = options.cellCount;
        const defaultMinSpan = (cellCount && Number.isFinite(cellCount))
          ? Math.max(0.30, Math.round(cellCount * 0.060 * 10) / 10)
          : 0.50;
        const minSpan = options.minSpan !== undefined ? options.minSpan : defaultMinSpan;
        const quantum = minSpan <= 0.50 ? 0.05 : 0.10;
        const span = vMax - vMin;
        const pad = Math.max(minSpan * 0.20, span * 0.20);

        let rawMin = vMin - pad;
        let rawMax = vMax + pad;
        if ((rawMax - rawMin) < minSpan) {
          const center = (vMin + vMax) / 2;
          rawMin = Math.min(vMin - quantum, center - minSpan / 2);
          rawMax = Math.max(vMax + quantum, center + minSpan / 2);
        }

        const scaleMin = Number((Math.floor(rawMin / quantum) * quantum).toFixed(2));
        const scaleMax = Number((Math.ceil(rawMax / quantum) * quantum).toFixed(2));
        return {
          hasData: true,
          min: scaleMin,
          max: scaleMax,
          beginAtZero: false,
          stepSize: undefined,
          span: Number((scaleMax - scaleMin).toFixed(2)),
          dataMin,
          dataMax
        };
      }

      case 'cell_voltage': {
        const vMin = dataMin;
        const vMax = dataMax;
        const minSpan = options.minSpan !== undefined ? options.minSpan : 0.050;
        const quantum = 0.005;
        const span = vMax - vMin;
        const pad = Math.max(0.008, span * 0.25);

        let rawMin = vMin - pad;
        let rawMax = vMax + pad;
        if ((rawMax - rawMin) < minSpan) {
          const center = (vMin + vMax) / 2;
          rawMin = Math.min(vMin - 0.005, center - minSpan / 2);
          rawMax = Math.max(vMax + 0.005, center + minSpan / 2);
        }

        const scaleMin = Number((Math.floor(rawMin / quantum) * quantum).toFixed(3));
        const scaleMax = Number((Math.ceil(rawMax / quantum) * quantum).toFixed(3));
        return {
          hasData: true,
          min: scaleMin,
          max: scaleMax,
          beginAtZero: false,
          stepSize: undefined,
          span: Number((scaleMax - scaleMin).toFixed(3)),
          dataMin,
          dataMax
        };
      }

      case 'temperature': {
        const tMin = dataMin;
        const tMax = dataMax;
        const minSpan = options.minSpan !== undefined ? options.minSpan : 4.0;
        
        let rawMin = tMin - 1.5;
        let rawMax = tMax + 2.0;
        if ((rawMax - rawMin) < minSpan) {
          const center = (tMin + tMax) / 2;
          rawMin = Math.min(tMin - 1.5, center - minSpan / 2);
          rawMax = Math.max(tMax + 2.0, center + minSpan / 2);
        }

        const scaleMin = Math.floor(rawMin * 2) / 2;
        const scaleMax = Math.ceil(rawMax * 2) / 2;
        const scaleSpan = scaleMax - scaleMin;

        let stepSize = undefined;
        if (scaleSpan <= 4) stepSize = 1;
        else if (scaleSpan <= 10) stepSize = 2;

        return {
          hasData: true,
          min: scaleMin,
          max: scaleMax,
          beginAtZero: false,
          stepSize,
          span: scaleSpan,
          dataMin,
          dataMax
        };
      }

      default: {
        return {
          hasData: true,
          min: dataMin,
          max: dataMax,
          beginAtZero: false,
          stepSize: undefined,
          span: dataMax - dataMin,
          dataMin,
          dataMax
        };
      }
    }
  }

  function applyYAxisDomain(chart, metricFamily, rawValues, options = {}) {
    if (!chart || !chart.options || !chart.options.scales) return null;
    chart._wattDomainContext = { family: metricFamily, options: Object.assign({}, options) };
    const domain = computeYAxisDomain(metricFamily, rawValues, options);
    const yScale = chart.options.scales.y;
    if (!yScale) return domain;

    if (!domain.hasData) {
      yScale.min = undefined;
      yScale.max = undefined;
      yScale.beginAtZero = domain.beginAtZero;
      if (yScale.ticks) yScale.ticks.stepSize = undefined;
      return domain;
    }

    yScale.beginAtZero = domain.beginAtZero;
    yScale.min = domain.min;
    yScale.max = domain.max;
    if (!yScale.ticks) yScale.ticks = {};
    yScale.ticks.stepSize = domain.stepSize;

    if (options.unit !== undefined) {
      const decimals = options.decimals !== undefined ? options.decimals : 0;
      yScale.ticks.callback = (val, idx, ticks) => formatAdaptiveValue(val, options.unit, ticks, decimals);
    }
    return domain;
  }

  function getVisibleDataSlice(input, startIndex, endIndex) {
    if (!input) return [];
    const minIdx = Math.max(0, Math.floor(startIndex));
    const maxIdx = Math.ceil(endIndex);
    if (!Array.isArray(input)) return [];
    if (input.length === 0) return [];

    if (typeof input[0] === 'object' && input[0] !== null && Array.isArray(input[0].data)) {
      return input.flatMap(ds => (ds.data || []).slice(minIdx, maxIdx + 1));
    }
    return input.slice(minIdx, maxIdx + 1);
  }

  function remapZoomTimestampsToIndices(timestampsMs, startSec, endSec) {
    if (!Array.isArray(timestampsMs) || timestampsMs.length < 2) return { valid: false };
    const firstSec = timestampsMs[0] / 1000;
    const lastSec = timestampsMs[timestampsMs.length - 1] / 1000;
    if (startSec >= endSec || endSec < firstSec || startSec > lastSec) {
      return { valid: false };
    }
    let minIdx = -1;
    let maxIdx = -1;
    for (let i = 0; i < timestampsMs.length; i++) {
      const sec = timestampsMs[i] / 1000;
      if (minIdx === -1 && sec >= startSec) minIdx = i;
      if (sec <= endSec) maxIdx = i;
    }
    if (minIdx === -1 || maxIdx === -1 || minIdx >= maxIdx) {
      return { valid: false };
    }
    return { valid: true, minIdx, maxIdx };
  }

  function applyVisibleYAxisDomain(chart, customOptions) {
    if (!chart || !chart.options || !chart.options.scales) return null;
    const ctx = chart._wattDomainContext || {};
    const family = ctx.family || 'power';
    const opts = Object.assign({}, ctx.options, customOptions);
    const yScale = chart.options.scales.y;
    if (!yScale) return null;

    if (family === 'soc') {
      yScale.beginAtZero = true;
      yScale.min = 0;
      yScale.max = 100;
      if (!yScale.ticks) yScale.ticks = {};
      yScale.ticks.stepSize = 25;
      return { min: 0, max: 100, stepSize: 25, hasData: true, beginAtZero: true };
    }

    const xScale = chart.scales?.x || chart.options.scales.x;
    const labelsCount = (chart.data && chart.data.labels) ? chart.data.labels.length : 0;
    const rawMin = (xScale && xScale.min !== undefined) ? xScale.min : 0;
    const rawMax = (xScale && xScale.max !== undefined) ? xScale.max : (labelsCount - 1);

    const minIdx = Math.max(0, Math.floor(rawMin));
    const maxIdx = Math.min(labelsCount - 1, Math.ceil(rawMax));

    const allVisible = (chart.data?.datasets || []).flatMap(ds => 
      (ds.data || []).slice(minIdx, maxIdx + 1)
    );

    const domain = computeYAxisDomain(family, allVisible, opts);
    if (!domain.hasData) {
      yScale.min = undefined;
      yScale.max = undefined;
      yScale.beginAtZero = domain.beginAtZero;
      if (yScale.ticks) yScale.ticks.stepSize = undefined;
      return domain;
    }

    yScale.beginAtZero = domain.beginAtZero;
    yScale.min = domain.min;
    yScale.max = domain.max;
    if (!yScale.ticks) yScale.ticks = {};
    yScale.ticks.stepSize = domain.stepSize;

    if (opts.unit !== undefined) {
      const decimals = opts.decimals !== undefined ? opts.decimals : 0;
      yScale.ticks.callback = (val, idx, ticks) => formatAdaptiveValue(val, opts.unit, ticks, decimals);
    }
    return domain;
  }

  let _isResetting = false;

  function resetChartToAuto(chart, onResetCallback) {
    if (!chart || _isResetting) return;
    _isResetting = true;
    try {
      if (typeof chart.resetZoom === 'function') {
        try {
          chart.resetZoom('none');
        } catch (_) {}
      }
      if (chart.options?.scales?.x) {
        chart.options.scales.x.min = undefined;
        chart.options.scales.x.max = undefined;
      }
      if (chart.scales?.x) {
        chart.scales.x.min = undefined;
        chart.scales.x.max = undefined;
      }
      chart._wattZoomState = { isZoomed: false, startSec: null, endSec: null };
      const wrapper = chart.canvas?.closest('.chart-wrapper');
      if (wrapper) {
        wrapper.classList.remove('is-zoomed', 'is-panning');
      }
      if (chart._wattDomainContext) {
        const { family, options } = chart._wattDomainContext;
        const allVals = (chart.data?.datasets || []).flatMap(ds => ds.data || []);
        applyYAxisDomain(chart, family, allVals, options);
      }
      chart.update('none');
      if (typeof onResetCallback === 'function') onResetCallback(chart);
    } finally {
      _isResetting = false;
    }
  }

  function bindChartResetButton(chart, resetBtnElement, onResetCallback) {
    if (!chart) return;
    const btn = resetBtnElement || chart.canvas?.closest('.chart-wrapper')?.querySelector('.chart-reset-btn');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        resetChartToAuto(chart, onResetCallback);
      });
    }
  }

  // Single shared implementation of "update chart data while preserving the
  // time-anchored zoom viewport". Used by dashboard.js and history.js — do NOT
  // fork local copies of this logic (they drifted in the past).
  function updateChartPreservingZoom(chart, timestamps, updateDataFn, family, rawVals, options) {
    if (!chart) return;
    const zoomState = chart._wattZoomState;
    if (zoomState && zoomState.isZoomed && zoomState.startSec && zoomState.endSec) {
      updateDataFn();
      chart.data.labels = timestamps;
      const remap = remapZoomTimestampsToIndices(timestamps, zoomState.startSec, zoomState.endSec);
      if (remap.valid) {
        if (chart.options?.scales?.x) {
          chart.options.scales.x.min = remap.minIdx;
          chart.options.scales.x.max = remap.maxIdx;
        }
        if (chart.scales?.x) {
          chart.scales.x.min = remap.minIdx;
          chart.scales.x.max = remap.maxIdx;
        }
        zoomState.startSec = Math.floor(timestamps[remap.minIdx] / 1000);
        zoomState.endSec = Math.floor(timestamps[remap.maxIdx] / 1000);
        applyVisibleYAxisDomain(chart, options);
        chart.update('none');
        reapplyPinAfterDataUpdate(chart);
        return;
      }
      resetChartToAuto(chart);
      reapplyPinAfterDataUpdate(chart);
      return;
    }

    updateDataFn();
    chart.data.labels = timestamps;
    applyYAxisDomain(chart, family, rawVals, options);
    chart.update('none');
    reapplyPinAfterDataUpdate(chart);
  }

  function _syncZoomStateFromScale(chart, config) {
    if (!chart || _isResetting) return;
    const xScale = chart.scales?.x || chart.options?.scales?.x;
    const labels = chart.data?.labels || [];
    if (!xScale || !labels.length) return;

    const min = Math.max(0, Math.floor(xScale.min !== undefined ? xScale.min : 0));
    const max = Math.min(labels.length - 1, Math.ceil(xScale.max !== undefined ? xScale.max : labels.length - 1));

    const wrapper = chart.canvas?.closest('.chart-wrapper');

    if (min > 0 || max < labels.length - 1) {
      const startSec = Math.floor(labels[min] / 1000);
      const endSec = Math.floor(labels[max] / 1000);
      chart._wattZoomState = { isZoomed: true, startSec, endSec };
      if (wrapper) wrapper.classList.add('is-zoomed');
      applyVisibleYAxisDomain(chart);
      chart.update('none');
      if (typeof config?.onZoomChange === 'function') config.onZoomChange(chart);
    } else {
      resetChartToAuto(chart, config?.onReset);
    }
  }

  // Export
  global.WattCharts = {
    FONT_MONO,
    FONT_SANS,
    makeAreaChart,
    makePieChart,
    rechartsGridPlugin,
    referenceLinesPlugin,
    hideTooltip,
    dismissPinnedChart,
    hexAlpha,
    niceDomain,
    computeYAxisDomain,
    applyYAxisDomain,
    getVisibleDataSlice,
    remapZoomTimestampsToIndices,
    applyVisibleYAxisDomain,
    resetChartToAuto,
    bindChartResetButton,
    updateChartPreservingZoom,
    formatTimeShort,
    formatDateTimeShort,
    formatDateShort,
    getAdaptiveDecimals,
    formatAdaptiveValue
  };
})(window);
