/* settings.js — Read-only Settings View for JK BMS configuration. */

(function (global) {
  'use strict';
  const tr = (key, values) => global.WattPostI18n.t(key, values);
  const tEnglish = key => global.WattPostI18n.tLocale('en', key);

  // Text supplied by BMS/device JSON must never become executable markup.
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));

  class SettingsView {
    constructor() {
      this.container = null;
      this.currentData = null;
      this.currentState = 'INITIAL_LOADING';
      this.searchQuery = '';
      this._unsubscribeSettings = null;
    }

    init() {
      this.container = document.getElementById('view-bms-settings');
      if (!this.container) return;

      this._buildLayout();
      this._bindEvents();

      if (global.ApiClient) {
        this._unsubscribeSettings = global.ApiClient.onSettings((data, state) => {
          this.onData(data, state);
        });
      }
    }

    destroy() {
      if (this._unsubscribeSettings) {
        this._unsubscribeSettings();
        this._unsubscribeSettings = null;
      }
    }

    _buildLayout() {
      this.container.innerHTML = `
        <h1 class="visually-hidden" data-i18n="nav.bms_settings">Налаштування BMS</h1>

        <!-- Top Device Summary -->
        <div id="settings-summary-container"></div>

        <!-- Search Toolbar & Status -->
        <div class="settings-toolbar">
          <div class="settings-search-wrapper">
            <svg class="settings-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input type="search" id="settings-search-input" class="settings-search-input" placeholder="${tr('text.search_by_setting_name_or_api_key')}" autocomplete="off" />
            <button id="settings-search-clear" class="settings-search-clear" aria-label="${tr('text.clear_search')}" style="display:none;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <div class="settings-search-count" id="settings-search-count" data-i18n="text.53_parameters">53 параметри</div>
        </div>

        <!-- Connectivity / Warning Banner -->
        <div id="settings-alert-container"></div>

        <!-- Settings Section Cards Grid -->
        <div class="settings-grid" id="settings-grid"></div>

        <!-- Empty Search Fallback -->
        <div id="settings-empty-state" class="settings-empty-state" style="display:none;">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#8b949e" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <div class="settings-empty-title" data-i18n="text.no_results">Нічого не знайдено</div>
          <div class="settings-empty-desc" id="settings-empty-desc" data-i18n="text.no_settings_match_your_search">За вказаним запитом налаштувань не знайдено.</div>
        </div>
      `;
      global.WattPostI18n?.apply?.(this.container);
    }

    _bindEvents() {
      const searchInput = this.container.querySelector('#settings-search-input');
      const clearBtn = this.container.querySelector('#settings-search-clear');

      if (searchInput) {
        searchInput.addEventListener('input', (e) => {
          this.searchQuery = e.target.value.trim().toLowerCase();
          if (clearBtn) {
            clearBtn.style.display = this.searchQuery ? 'flex' : 'none';
          }
          this._filterRows();
        });
      }

      if (clearBtn) {
        clearBtn.addEventListener('click', () => {
          if (searchInput) {
            searchInput.value = '';
            searchInput.focus();
          }
          this.searchQuery = '';
          clearBtn.style.display = 'none';
          this._filterRows();
        });
      }
    }

    onData(data, state) {
      this.currentData = data;
      this.currentState = state;

      const alertContainer = this.container.querySelector('#settings-alert-container');
      const grid = this.container.querySelector('#settings-grid');
      const summaryContainer = this.container.querySelector('#settings-summary-container');

      if (state === 'INITIAL_LOADING' && !data) {
        if (alertContainer) alertContainer.innerHTML = '';
        if (summaryContainer) {
          summaryContainer.innerHTML = `
            <div class="settings-summary-card is-loading">
              <div class="settings-summary-skeleton">${tr('text.loading_bms_configuration')}</div>
            </div>
          `;
        }
        if (grid) {
          grid.innerHTML = `
            <div class="settings-loading-card">
              <span class="settings-spinner"></span>
              <span>${tr('text.fetching_settings_from_get_api_settings')}</span>
            </div>
          `;
        }
        return;
      }

      if (state === 'FAILED_NO_DATA') {
        if (summaryContainer) summaryContainer.innerHTML = '';
        if (alertContainer) {
          alertContainer.innerHTML = `
            <div class="settings-alert settings-alert-error">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <span>${tr('text.bms_settings_unavailable_waiting_for_the_first_response')}</span>
              <button class="settings-retry-btn" onclick="window.ApiClient && window.ApiClient.fetchSettings()">${tr('text.retry')}</button>
            </div>
          `;
        }
        if (grid) grid.innerHTML = '';
        return;
      }

      if (state === 'STALE') {
        if (alertContainer) {
          alertContainer.innerHTML = `
            <div class="settings-alert settings-alert-warning">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path>
                <line x1="12" y1="9" x2="12" y2="13"></line>
                <line x1="12" y1="17" x2="12.01" y2="17"></line>
              </svg>
              <span>${tr('text.showing_saved_settings_refresh_is_delayed_because_the_conn')}</span>
            </div>
          `;
        }
      } else {
        if (alertContainer) alertContainer.innerHTML = '';
      }

      this._renderSummary(data);
      this._renderSections(data);
      this._filterRows();
    }

    _renderSummary(data) {
      const summaryContainer = this.container.querySelector('#settings-summary-container');
      if (!summaryContainer) return;

      const device = (data && data.device) || {};
      const battery = (data && data.battery) || {};

      const normalizer = global.SettingsNormalizer;
      const model = device.model || 'JK BMS';
      const devName = device.device_name || 'Battery';
      const sn = device.device_sn || '—';
      const hw = device.hardware_version || '—';
      const sw = device.software_version || '—';
      const proto = data.protocol_family || device.protocol_family || 'JK02_32S';
      const powerOnCount = device.power_on_count !== undefined && device.power_on_count !== null ? device.power_on_count : '—';
      const uptimeStr = normalizer ? normalizer.formatUptime(device.uptime_seconds) : '—';

      // 1. Topology
      const cellCount = (battery.cell_count != null && Number.isFinite(Number(battery.cell_count)) && Number(battery.cell_count) > 0)
        ? `${battery.cell_count}S`
        : '—';

      // 2. Capacity
      const capacity = (battery.nominal_capacity_ah != null && Number.isFinite(Number(battery.nominal_capacity_ah)))
        ? `${Number(battery.nominal_capacity_ah).toFixed(0)} Ah`
        : '—';

      // 3. Battery Chemistry (LFP -> LiFePO₄, never show battery_type_id)
      let chemistryStr = '—';
      if (battery.chemistry && typeof battery.chemistry === 'string') {
        const trimmed = battery.chemistry.trim();
        if (trimmed.toUpperCase() === 'LFP') {
          chemistryStr = 'LiFePO₄';
        } else if (trimmed) {
          chemistryStr = trimmed;
        }
      }

      // 4. State of Health (SOH)
      const sohStr = (battery.state_of_health != null && Number.isFinite(Number(battery.state_of_health)))
        ? `${Number(battery.state_of_health)}%`
        : '—';

      summaryContainer.innerHTML = `
        <div class="settings-summary-card">
          <div class="settings-summary-header">
            <div class="settings-summary-title-group">
              <div class="settings-summary-title" data-i18n-ignore>${escapeHtml(devName)}</div>
              <div class="settings-summary-subtitle" data-i18n-ignore>${escapeHtml(model)} <span class="settings-summary-proto">${escapeHtml(proto)}</span></div>
            </div>
            <div class="settings-summary-badge-group">
              <div class="settings-summary-badge">
                <span class="badge-label">${tr('text.capacity')}</span>
                <span class="badge-val" data-i18n-ignore>${escapeHtml(capacity)}</span>
              </div>
              <div class="settings-summary-badge">
                <span class="badge-label">${tr('text.battery_type')}</span>
                <span class="badge-val" data-i18n-ignore>${escapeHtml(chemistryStr)}</span>
              </div>
              <div class="settings-summary-badge">
                <span class="badge-label">${tr('text.battery_status')}</span>
                <span class="badge-val" data-i18n-ignore>${escapeHtml(sohStr)}</span>
              </div>
            </div>
          </div>

          <div class="settings-summary-grid">
            <div class="summary-meta-item">
              <span class="meta-label">${tr('text.serial_number_s_n')}</span>
              <span class="meta-val font-mono" data-i18n-ignore>${escapeHtml(sn)}</span>
            </div>
            <div class="summary-meta-item">
              <span class="meta-label">${tr('text.hw_sw_version')}</span>
              <span class="meta-val font-mono" data-i18n-ignore>${escapeHtml(hw)} / ${escapeHtml(sw)}</span>
            </div>
            <div class="summary-meta-item">
              <span class="meta-label">${tr('text.topology')}</span>
              <span class="meta-val font-mono" data-i18n-ignore>${escapeHtml(cellCount)}</span>
            </div>
            <div class="summary-meta-item">
              <span class="meta-label">${tr('text.power_on_count')}</span>
              <span class="meta-val font-mono" data-i18n-ignore>${escapeHtml(powerOnCount)}</span>
            </div>
            <div class="summary-meta-item">
              <span class="meta-label">${tr('text.continuous_uptime')}</span>
              <span class="meta-val font-mono" data-i18n-ignore>${escapeHtml(uptimeStr)}</span>
            </div>
          </div>
        </div>
      `;
    }

    _renderSections(data) {
      const grid = this.container.querySelector('#settings-grid');
      if (!grid) return;

      const schema = global.SETTINGS_SCHEMA || [];
      const normalizer = global.SettingsNormalizer;

      const leftSectionIds = ['battery', 'balancing', 'temperature', 'sleep'];
      const rightSectionIds = ['cellVoltage', 'currentLimits', 'switches'];

      const sectionsById = new Map();
      (global.SETTINGS_SECTIONS || []).forEach(sec => sectionsById.set(sec.id, sec));

      const renderCard = (secId) => {
        const sec = sectionsById.get(secId);
        if (!sec) return '';

        const secSpecs = schema.filter(s => s.section === sec.id);
        if (!secSpecs.length) return '';

        let contentHtml = '';
        if (sec.subgroups && sec.subgroups.length) {
          for (const sub of sec.subgroups) {
            const subSpecs = secSpecs.filter(s => s.subgroup === sub.id);
            if (!subSpecs.length) continue;

            let subRowsHtml = '';
            for (const spec of subSpecs) {
              subRowsHtml += this._renderSettingRow(spec, data, normalizer);
            }

            contentHtml += `
              <div class="settings-subgroup" data-subgroup="${sub.id}">
                <div class="settings-subgroup-title">${escapeHtml(tr(sub.titleKey))}${global.WattPostI18n.language === 'uk'
                    ? ` <span class="settings-subgroup-en">${escapeHtml(tEnglish(sub.titleKey))}</span>`
                    : ''}</div>
                <div class="settings-subgroup-rows">
                  ${subRowsHtml}
                </div>
              </div>
            `;
          }
        } else {
          for (const spec of secSpecs) {
            contentHtml += this._renderSettingRow(spec, data, normalizer);
          }
        }

        return `
          <div class="settings-section-card" data-section="${sec.id}">
            <div class="settings-section-header">
              <div class="settings-section-title">${escapeHtml(tr(sec.titleKey))}</div>
              <div class="settings-section-desc">${escapeHtml(tr(sec.descriptionKey))}</div>
            </div>
            <div class="settings-section-body">
              ${contentHtml}
            </div>
          </div>
        `;
      };

      const leftHtml = leftSectionIds.map(renderCard).join('');
      const rightHtml = rightSectionIds.map(renderCard).join('');

      grid.innerHTML = `
        <div class="settings-column settings-column-left">
          ${leftHtml}
        </div>
        <div class="settings-column settings-column-right">
          ${rightHtml}
        </div>
      `;
    }

    _renderSettingRow(spec, data, normalizer) {
      const rawVal = normalizer ? normalizer.resolveValue(data, spec.key) : null;
      const formatted = normalizer ? normalizer.formatValue(spec, rawVal) : { text: String(rawVal), unit: '' };

      const label = tr(spec.labelKey);
      const englishReference = tEnglish(spec.labelKey);
      const ukrainianReference = global.WattPostI18n.tLocale('uk', spec.labelKey);
      // Search both localizations and the immutable API key in either language.
      const searchTerms = `${label} ${englishReference} ${ukrainianReference} ${spec.key}`.toLowerCase();

      let valueHtml = '';
      if (spec.type === 'boolean') {
        const isActive = formatted.status === 'active';
        valueHtml = `
          <div class="setting-badge ${isActive ? 'is-active' : 'is-inactive'}">
            <span class="setting-badge-dot"></span>
            <span class="setting-badge-text" data-i18n-ignore>${escapeHtml(formatted.text)}</span>
          </div>
        `;
      } else {
        const secText = formatted.secondaryText ? `<span class="setting-secondary-text" data-i18n-ignore>(${escapeHtml(formatted.secondaryText)})</span>` : '';
        const unitHtml = formatted.unit ? `<span class="setting-unit">${escapeHtml(formatted.unit)}</span>` : '';
        valueHtml = `
          <div class="setting-value-group">
            <span class="setting-value font-mono tabular-nums" data-i18n-ignore>${escapeHtml(formatted.text)}</span>
            ${unitHtml}
            ${secText}
          </div>
        `;
      }

      return `
        <div class="setting-row" data-key="${spec.key}" data-search="${escapeHtml(searchTerms)}">
          <div class="setting-info">
            <div class="setting-label-uk">${escapeHtml(label)}</div>
            <div class="setting-meta">
              ${global.WattPostI18n.language === 'uk'
                ? `<span class="setting-label-en">${escapeHtml(englishReference)}</span>`
                : ''}
              <span class="setting-key font-mono">${spec.key}</span>
            </div>
          </div>
          <div class="setting-value-container">
            ${valueHtml}
          </div>
        </div>
      `;
    }

    _filterRows() {
      const query = this.searchQuery;
      const allRows = this.container.querySelectorAll('.setting-row');
      const allSections = this.container.querySelectorAll('.settings-section-card');
      const allSubgroups = this.container.querySelectorAll('.settings-subgroup');
      const countEl = this.container.querySelector('#settings-search-count');
      const emptyState = this.container.querySelector('#settings-empty-state');
      const emptyDesc = this.container.querySelector('#settings-empty-desc');

      let visibleCount = 0;

      if (!query) {
        allRows.forEach(r => r.style.display = 'flex');
        allSubgroups.forEach(sg => sg.style.display = 'block');
        allSections.forEach(s => s.style.display = 'flex');
        if (emptyState) emptyState.style.display = 'none';
        if (countEl) countEl.textContent = tr('bms.parameters_count', { count: allRows.length });
        return;
      }

      allRows.forEach(row => {
        const search = row.dataset.search || '';
        const matches = search.includes(query);
        row.style.display = matches ? 'flex' : 'none';
        if (matches) visibleCount++;
      });

      allSubgroups.forEach(sg => {
        const visibleSubRows = sg.querySelectorAll('.setting-row:not([style*="display: none"])');
        sg.style.display = visibleSubRows.length > 0 ? 'block' : 'none';
      });

      allSections.forEach(sec => {
        const visibleSecRows = sec.querySelectorAll('.setting-row:not([style*="display: none"])');
        sec.style.display = visibleSecRows.length > 0 ? 'flex' : 'none';
      });

      if (countEl) {
        countEl.textContent = tr('setup.found_count', { count: visibleCount });
      }

      if (emptyState) {
        if (visibleCount === 0) {
          emptyState.style.display = 'flex';
          if (emptyDesc) {
            emptyDesc.textContent = tr('bms.search_no_match', { query });
          }
        } else {
          emptyState.style.display = 'none';
        }
      }
    }
  }

  global.SettingsView = SettingsView;
})(typeof window !== 'undefined' ? window : global);
