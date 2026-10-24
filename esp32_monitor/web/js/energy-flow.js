/* energy-flow.js — SVG path-based energy flow animation.
 * Direct port of page.tsx flow animation loop, using rAF + DOM API. */

(function (global) {
  'use strict';

  // Master Bézier curve — high crest left, deep trough right
  const FLOW_PATH = 'M 0 263 C 186 86, 336 95, 530 222 C 570 250, 630 195, 670 222 C 864 350, 1014 345, 1200 177';

  const MAX_VISUAL_POWER_W = 5000;

  function getVisualPowerRatio(powerW) {
    const ratio = Math.max(0, Math.min(1, Math.abs(powerW) / MAX_VISUAL_POWER_W));
    return Math.pow(ratio, 0.5);
  }

  // The state colors must match STATE_COLORS in dashboard.js exactly.
  const STATE_COLORS = {
    charging: {
      primary: '#56d364',
      glow: 'rgba(86,211,100,0.45)',
      bg: 'rgba(86,211,100,0.06)',
      label: 'Заряджання'
    },
    discharging: {
      primary: '#9d8dff',
      glow: 'rgba(157,141,255,0.45)',
      bg: 'rgba(157,141,255,0.06)',
      label: 'Розряджання'
    },
    idle: {
      primary: '#6e7681',
      glow: 'rgba(110,118,129,0.15)',
      bg: 'rgba(110,118,129,0.04)',
      label: 'Очікування'
    }
  };

  // Bubble data for charging state
  const BUBBLES = [
    { cx: 558, cy: 350, r: 2.2, dur: '2.5s', delay: '0s' },
    { cx: 582, cy: 352, r: 1.8, dur: '3.2s', delay: '0.8s' },
    { cx: 614, cy: 348, r: 2.4, dur: '2.7s', delay: '1.5s' },
    { cx: 642, cy: 354, r: 1.6, dur: '3.5s', delay: '0.4s' }
  ];

  /** @type {EnergyFlow} */
  let instance = null;

  class EnergyFlow {
    constructor(rootSvg) {
      this.svg = rootSvg;

      // Refs to animated SVG elements
      this.haloWide = rootSvg.querySelector('#halo-wide');
      this.haloNear = rootSvg.querySelector('#halo-near');
      this.glowFlow = rootSvg.querySelector('#flow-glow');
      this.mainFlow = rootSvg.querySelector('#flow-main');
      this.staticFlow = rootSvg.querySelector('#flow-static');
      this.haloGroup = rootSvg.querySelector('#halo-group');
      this.bubbleGroup = rootSvg.querySelector('#bubble-group');

      // Refs to dynamic mask stops for directional reveal
      this.maskStop0 = rootSvg.querySelector('#flow-mask-stop-0');
      this.maskStop1 = rootSvg.querySelector('#flow-mask-stop-1');
      this.maskStop2 = rootSvg.querySelector('#flow-mask-stop-2');
      this.maskStop3 = rootSvg.querySelector('#flow-mask-stop-3');
      this.maskStop4 = rootSvg.querySelector('#flow-mask-stop-4');

      // Directional reveal & spin-up state
      this.revealProgress = 1.0;
      this.revealState = 'idle';
      this.revealActive = false;
      this.revealDurationS = 2.40; // Intentional reveal pacing - author's preferred tempo (original design baseline: 0.80s)

      // Accessibility: OS-level "reduce motion" setting. Inert for normal users —
      // the authored reveal tempo above is untouched. See setState() and the loop.
      this.reducedMotion = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);

      // State used by the rAF loop (mutated by setState)
      this.animState = {
        phase: 0,
        smoothedRatio: 0,
        targetRatio: 0,
        isActive: false,
        isCharging: true,
        lastTime: 0
      };

      // Per-element opacity tracking for smooth cross-state transitions
      this.haloOpacity = 0;
      this.haloTargetOpacity = 0;
      this.glowOpacity = 0;
      this.glowTargetOpacity = 0;
      this.mainOpacity = 0;
      this.mainTargetOpacity = 0;
      this.staticOpacity = 0;
      this.staticTargetOpacity = 0;
      this._isVisualActive = false;

      // rAF loop lifecycle + last-written-value caches. The loop SLEEPS in the
      // terminal idle state instead of burning frames on unchanged DOM writes;
      // setState() wakes it. Caches skip redundant setAttribute/style writes.
      this._loopRunning = false;
      this._animate = null;
      this._lastMaskKey = null;
      this._lastGlowOpacityStr = null;
      this._lastMainOpacityStr = null;
      this._lastStaticOpacityStr = null;
      this._lastHaloWideWStr = null;
      this._lastHaloNearWStr = null;
      this._lastHaloWideOpacityStr = null;
      this._lastHaloNearOpacityStr = null;
      this._bubbleVisibleTarget = null;
      this._bubblePauseTimer = null;

      this._initBubbles();
      this._startLoop();
    }

    _initBubbles() {
      if (!this.bubbleGroup) return;
      this.bubbleGroup.innerHTML = BUBBLES.map(b =>
        `<circle cx="${b.cx}" cy="${b.cy}" r="${b.r}" fill="#ffffff" opacity="0"
          style="animation: bubble-rise ${b.dur} ease-in infinite; animation-delay: ${b.delay}; transform-origin: ${b.cx}px ${b.cy}px;"/>`
      ).join('');
    }

    _setBubbleVisibility(visible) {
      if (!this.bubbleGroup || this._bubbleVisibleTarget === visible) return;
      this._bubbleVisibleTarget = visible;

      if (this._bubblePauseTimer) {
        clearTimeout(this._bubblePauseTimer);
        this._bubblePauseTimer = null;
      }

      const bubbles = this.bubbleGroup.querySelectorAll('circle');
      this.bubbleGroup.style.display = '';
      if (visible) {
        bubbles.forEach(el => { el.style.animationPlayState = 'running'; });
        this.bubbleGroup.style.opacity = '1';
      } else {
        this.bubbleGroup.style.opacity = '0';
        this._bubblePauseTimer = setTimeout(() => {
          if (this._bubbleVisibleTarget === false) {
            bubbles.forEach(el => { el.style.animationPlayState = 'paused'; });
          }
          this._bubblePauseTimer = null;
        }, 450);
      }
    }

    setState(state, power, soc) {
      // Wake the rAF loop if it went to sleep in the terminal idle state.
      if (!this._loopRunning && this._animate) {
        this.animState.lastTime = 0; // no dt spike on the first frame after wake
        this._loopRunning = true;
        this._rafId = requestAnimationFrame(this._animate);
      }

      const isActive = state !== 'idle';
      const isCharging = state === 'charging';

      this.animState.targetRatio = getVisualPowerRatio(power);
      this.animState.isActive = isActive;
      if (isActive) {
        this.animState.isCharging = isCharging;
      }

      if (isActive) {
        this._isVisualActive = true;
        const colors = STATE_COLORS[state];
        if (state !== this.revealState) {
          // prefers-reduced-motion: skip the directional sweep, the mask opens
          // instantly. revealActive stays true so progress stays pinned at 1.0
          // (the loop's dissolve-reset branch is never re-entered while active).
          this.revealProgress = this.reducedMotion ? 1.0 : 0.0;
          this.revealState = state;
        }
        this.revealActive = true;

        // Active state: apply active color, halo gradient, clip-path and filter
        const haloGrad = isCharging ? 'url(#glow-grad-charge)' : 'url(#glow-grad-discharge)';
        const clipPath = isCharging ? 'url(#clip-charge-left)' : 'url(#clip-discharge-right)';
        // Single shared glow filter: glow-in/glow-out were byte-identical duplicate defs
        const filterId = 'url(#glow-in)';
        const color = colors.primary;

        if (this.haloWide) {
          this.haloWide.setAttribute('stroke', haloGrad);
        }
        if (this.haloNear) {
          this.haloNear.setAttribute('stroke', haloGrad);
        }
        if (this.glowFlow) {
          this.glowFlow.setAttribute('stroke', color);
          this.glowFlow.setAttribute('clip-path', clipPath);
        }
        if (this.mainFlow) {
          this.mainFlow.setAttribute('stroke', color);
          this.mainFlow.setAttribute('clip-path', clipPath);
          this.mainFlow.setAttribute('filter', filterId);
        }
        if (this.staticFlow) {
          this.staticFlow.setAttribute('stroke', color);
          this.staticFlow.setAttribute('clip-path', clipPath);
        }
      } else {
        // On idle: do not reverse reveal mask and DO NOT switch colors/clips/halo to gray or opposite side.
        // Retain last active luminescent color/halo/clip so it dissolves naturally in place.
        this.revealActive = false;
        this.revealState = 'idle';
      }

      // Toggle target opacities for fade transitions
      this.haloTargetOpacity = isActive ? 1 : 0;
      this.glowTargetOpacity = isActive ? 0.3 : 0;
      this.mainTargetOpacity = isActive ? 0.9 : 0;
      this.staticTargetOpacity = isActive ? 0.28 : 0;

      // Bubble visibility is owned here. Fade the group instead of toggling
      // display so the full-charge state does not visibly swap animation layers.
      const socNum = Number.isFinite(Number(soc)) ? Number(soc) : null;
      const belowDisplayedFull = socNum === null || Math.round(socNum) < 100;
      const showBubbles = isCharging && belowDisplayedFull && (socNum === null || socNum > 5);
      this._setBubbleVisibility(showBubbles);
    }

    _startLoop() {
      const animate = (now) => {
        const anim = this.animState;
        if (!anim.lastTime) anim.lastTime = now;
        const dt = Math.min(0.1, (now - anim.lastTime) / 1000);
        anim.lastTime = now;

        // 1. Directional reveal progress & soft spin-up (~480ms)
        if (this.revealActive) {
          if (this.revealProgress < 1.0) {
            this.revealProgress = Math.min(1.0, this.revealProgress + dt / this.revealDurationS);
          }
        } else if (this.mainOpacity < 0.01 && this.glowOpacity < 0.01 && this.haloOpacity < 0.01) {
          this.revealProgress = 0.0;
          if (!this.animState.isActive && this._isVisualActive) {
            this._isVisualActive = false;
            this.mainOpacity = 0;
            this.glowOpacity = 0;
            this.haloOpacity = 0;
            this.staticOpacity = 0;
            // Keep the write caches in sync with the direct DOM writes below.
            this._lastGlowOpacityStr = '0';
            this._lastMainOpacityStr = '0';
            this._lastStaticOpacityStr = '0';
            this._lastHaloWideOpacityStr = '0';
            this._lastHaloNearOpacityStr = '0';
            const idleColor = STATE_COLORS.idle.primary;
            if (this.glowFlow) {
              this.glowFlow.style.opacity = '0';
              this.glowFlow.setAttribute('stroke', idleColor);
            }
            if (this.mainFlow) {
              this.mainFlow.style.opacity = '0';
              this.mainFlow.setAttribute('stroke', idleColor);
            }
            if (this.staticFlow) {
              this.staticFlow.style.opacity = '0';
              this.staticFlow.setAttribute('stroke', idleColor);
            }
            if (this.haloWide) this.haloWide.style.opacity = '0';
            if (this.haloNear) this.haloNear.style.opacity = '0';
          }
        }

        const p = this.revealProgress;
        const p0 = 0.20;
        const vEnd = 1 / (1 - p0 / 2);
        const pWave = p <= p0 ? (vEnd / (2 * p0)) * p * p : vEnd * (p - p0 / 2);

        const isAct = anim.isActive;
        const spinUpSpeed = isAct ? Math.sin(Math.min(1.0, p) * Math.PI / 2) : 1.0;
        const spinUpGlow = isAct ? (0.25 + 0.75 * Math.sin(Math.min(1.0, p) * Math.PI / 2)) : 1.0;

        // 2. Exponential damping for power smoothing
        const damping = 4.5;
        anim.smoothedRatio += (anim.targetRatio - anim.smoothedRatio) * (1 - Math.exp(-damping * dt));

        const smoothedRatio = anim.smoothedRatio;

        // Steady-state speed follows smoothedRatio * 57.14, modulated by soft spin-up during activation
        const speed = smoothedRatio * 57.14 * spinUpSpeed;
        const activityFactor = isAct ? Math.min(1, smoothedRatio / 0.06) * spinUpGlow : 0;

        // Dash travel is the dominant continuous motion: under reduced motion it
        // is frozen and direction is conveyed by colors/clipping alone.
        const phaseAdvances = isAct && speed > 0.001 && !this.reducedMotion;
        if (phaseAdvances) {
          anim.phase = (anim.phase + speed * dt) % 100000;
        }

        const phase = anim.phase;

        // 3. Update directional reveal mask
        this._updateRevealMask(p, pWave);

        // 4. Update flow line dashes + opacity (responsive organic half-lives: 0.28s in, 0.25s out)
        if (this.glowFlow) {
          if (phaseAdvances) {
            this.glowFlow.style.strokeDashoffset = `${-phase}px`;
          }
          const targetGlow = this.glowTargetOpacity * activityFactor;
          const hl = targetGlow > this.glowOpacity ? 0.28 : 0.25;
          this.glowOpacity = this._lerp(this.glowOpacity, targetGlow, dt, hl);
          const s = this.glowOpacity.toFixed(3);
          if (s !== this._lastGlowOpacityStr) {
            this._lastGlowOpacityStr = s;
            this.glowFlow.style.opacity = s;
          }
        }
        if (this.mainFlow) {
          if (phaseAdvances) {
            this.mainFlow.style.strokeDashoffset = `${-phase}px`;
          }
          const targetMain = this.mainTargetOpacity * activityFactor;
          const hl = targetMain > this.mainOpacity ? 0.28 : 0.25;
          this.mainOpacity = this._lerp(this.mainOpacity, targetMain, dt, hl);
          const s = this.mainOpacity.toFixed(3);
          if (s !== this._lastMainOpacityStr) {
            this._lastMainOpacityStr = s;
            this.mainFlow.style.opacity = s;
          }
        }
        if (this.staticFlow) {
          const targetStatic = this.staticTargetOpacity * activityFactor;
          const hl = targetStatic > this.staticOpacity ? 0.28 : 0.25;
          this.staticOpacity = this._lerp(this.staticOpacity, targetStatic, dt, hl);
          const s = this.staticOpacity.toFixed(3);
          if (s !== this._lastStaticOpacityStr) {
            this._lastStaticOpacityStr = s;
            this.staticFlow.style.opacity = s;
          }
        }

        // 5. Halation glows
        if (this.haloWide) {
          const w = (48 + smoothedRatio * 24).toFixed(1);
          if (w !== this._lastHaloWideWStr) {
            this._lastHaloWideWStr = w;
            this.haloWide.setAttribute('stroke-width', w);
          }
          const targetHalo = this.haloTargetOpacity * activityFactor;
          const hl = targetHalo > this.haloOpacity ? 0.28 : 0.30;
          this.haloOpacity = this._lerp(this.haloOpacity, targetHalo, dt, hl);
          const s = (this.haloOpacity * (0.05 + smoothedRatio * 0.10)).toFixed(3);
          if (s !== this._lastHaloWideOpacityStr) {
            this._lastHaloWideOpacityStr = s;
            this.haloWide.style.opacity = s;
          }
        }
        if (this.haloNear) {
          const w = (18 + smoothedRatio * 12).toFixed(1);
          if (w !== this._lastHaloNearWStr) {
            this._lastHaloNearWStr = w;
            this.haloNear.setAttribute('stroke-width', w);
          }
          const s = (this.haloOpacity * (0.12 + smoothedRatio * 0.20)).toFixed(3);
          if (s !== this._lastHaloNearOpacityStr) {
            this._lastHaloNearOpacityStr = s;
            this.haloNear.style.opacity = s;
          }
        }

        // Terminal idle state (fully dissolved): SLEEP. Everything on screen is
        // stable; keeping a 60 fps loop here would only drain battery. The next
        // setState() restarts the loop.
        if (!anim.isActive && !this._isVisualActive) {
          this._loopRunning = false;
          this._rafId = null;
          return;
        }
        this._rafId = requestAnimationFrame(animate);
      };
      this._animate = animate;
      this._loopRunning = true;
      this._rafId = requestAnimationFrame(animate);
    }

    _updateRevealMask(p, pWave) {
      if (!this.maskStop0 || !this.maskStop1 || !this.maskStop2 || !this.maskStop3 || !this.maskStop4) return;

      // The stop values are fully determined by maskKey: skip redundant DOM
      // writes when nothing moved since the last frame (steady / dissolved).
      let maskKey;
      if (p >= 1.0 || (!this.animState.isActive && !this._isVisualActive)) {
        maskKey = 'steady';
      } else if (this.animState.isCharging) {
        maskKey = 'c:' + (pWave * 51.5).toFixed(2);
      } else {
        maskKey = 'd:' + (52.5 + pWave * 47.5).toFixed(2);
      }
      if (maskKey === this._lastMaskKey) return;
      this._lastMaskKey = maskKey;

      // Fully open mask if:
      // 1. Reveal completed 100% (p >= 1.0) in active steady state or completed fade-out
      // 2. Or idle state has fully dissolved and is no longer visually active (!this.animState.isActive && !this._isVisualActive)
      if (p >= 1.0 || (!this.animState.isActive && !this._isVisualActive)) {
        // Steady state or Idle dissolve: fully open with standard edge fades
        this.maskStop0.setAttribute('offset', '0%');
        this.maskStop0.setAttribute('stop-color', '#000000');
        this.maskStop1.setAttribute('offset', '3.5%');
        this.maskStop1.setAttribute('stop-color', '#ffffff');
        this.maskStop2.setAttribute('offset', '96.5%');
        this.maskStop2.setAttribute('stop-color', '#ffffff');
        this.maskStop3.setAttribute('offset', '96.5%');
        this.maskStop3.setAttribute('stop-color', '#ffffff');
        this.maskStop4.setAttribute('offset', '100%');
        this.maskStop4.setAttribute('stop-color', '#000000');
        return;
      }

      if (this.animState.isCharging) {
        // Charging: reveals continuously from Left (0%) into Battery (47.5%)
        const feather = 4.0;
        const xLead = pWave * (47.5 + feather);
        const xSolid = Math.max(0, xLead - feather);

        this.maskStop0.setAttribute('offset', '0%');
        this.maskStop0.setAttribute('stop-color', '#000000');
        this.maskStop1.setAttribute('offset', `${Math.min(3.5, xLead).toFixed(1)}%`);
        this.maskStop1.setAttribute('stop-color', '#ffffff');
        this.maskStop2.setAttribute('offset', `${Math.min(47.5, xSolid).toFixed(1)}%`);
        this.maskStop2.setAttribute('stop-color', '#ffffff');
        this.maskStop3.setAttribute('offset', `${Math.min(47.5, xLead).toFixed(1)}%`);
        this.maskStop3.setAttribute('stop-color', xLead >= 47.5 ? '#ffffff' : '#000000');
        this.maskStop4.setAttribute('offset', '100%');
        this.maskStop4.setAttribute('stop-color', '#000000');
      } else {
        // Discharging: reveals continuously from Battery (52.5%) all the way to Load end (100%)
        const feather = 4.0;
        const xLead = 52.5 + pWave * (100.0 - 52.5);
        const xSolid = Math.max(52.5, xLead - feather);

        this.maskStop0.setAttribute('offset', '0%');
        this.maskStop0.setAttribute('stop-color', '#000000');
        this.maskStop1.setAttribute('offset', '3.5%');
        this.maskStop1.setAttribute('stop-color', '#ffffff');
        this.maskStop2.setAttribute('offset', '52.5%');
        this.maskStop2.setAttribute('stop-color', '#ffffff');
        this.maskStop3.setAttribute('offset', `${Math.min(96.5, xSolid).toFixed(1)}%`);
        this.maskStop3.setAttribute('stop-color', '#ffffff');
        this.maskStop4.setAttribute('offset', `${Math.min(100.0, xLead).toFixed(1)}%`);
        this.maskStop4.setAttribute('stop-color', '#000000');
      }
    }

    _lerp(current, target, dt, halfLife) {
      // Exponential decay toward target
      const factor = 1 - Math.exp(-(Math.LN2 / halfLife) * dt);
      return current + (target - current) * factor;
    }

    destroy() {
      this._loopRunning = false;
      this._animate = null;
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = null;
      if (this._bubblePauseTimer) clearTimeout(this._bubblePauseTimer);
      this._bubblePauseTimer = null;
    }
  }

  global.EnergyFlow = EnergyFlow;
  global.STATE_COLORS = STATE_COLORS;
})(window);
