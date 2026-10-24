/* app.js — WattPost vanilla entry point.
 * Boots Dashboard + History views, manages hash router, tab switching, and centralized logo resolution. */

(function (global) {
  'use strict';

  /* =========================================================================
   * Centralized Logo Resolver
   * Probes candidate logo files in strict priority order (SVG -> PNG -> WebP -> JPG -> JPEG).
   * Caches result in runtime session and applies URL to both main UI logo and favicon.
   * ========================================================================= */
  const LOGO_CANDIDATES = [
    'assets/logo.svg',
    'assets/logo.png',
    'assets/logo.webp',
    'assets/logo.jpg',
    'assets/logo.jpeg'
  ];

  let _resolvedLogoPromise = null;

  function probeImage(src) {
    return new Promise((resolve) => {
      if (typeof Image === 'undefined') {
        resolve(false);
        return;
      }
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = src;
    });
  }

  async function resolveLogoUrl(candidates = LOGO_CANDIDATES, probeFn = probeImage) {
    if (_resolvedLogoPromise && candidates === LOGO_CANDIDATES && probeFn === probeImage) {
      return _resolvedLogoPromise;
    }

    const promise = (async () => {
      for (const candidate of candidates) {
        const exists = await probeFn(candidate);
        if (exists) {
          return candidate;
        }
      }
      return null;
    })();

    if (candidates === LOGO_CANDIDATES && probeFn === probeImage) {
      _resolvedLogoPromise = promise;
    }
    return promise;
  }

  async function applyBrandLogo(root = (typeof document !== 'undefined' ? document : null), logoUrlResolverFn = resolveLogoUrl) {
    if (!root) return null;
    const brandLogo = root.getElementById ? root.getElementById('brand-logo') : root.querySelector?.('#brand-logo');
    const canonicalLogoUrl = brandLogo && typeof brandLogo.getAttribute === 'function'
      ? brandLogo.getAttribute('data-logo-canonical')
      : null;
    const logoUrl = canonicalLogoUrl || await logoUrlResolverFn();
    let favicon = root.querySelector ? root.querySelector('link[rel~="icon"]') : null;

    if (logoUrl) {
      if (brandLogo) {
        brandLogo.src = logoUrl;
        brandLogo.style.display = '';
      }
      if (!favicon && root.head && root.createElement) {
        favicon = root.createElement('link');
        favicon.rel = 'icon';
        root.head.appendChild(favicon);
      }
      if (favicon) {
        favicon.href = logoUrl;
        if (logoUrl.endsWith('.svg')) {
          favicon.type = 'image/svg+xml';
        } else if (logoUrl.endsWith('.png')) {
          favicon.type = 'image/png';
        } else if (logoUrl.endsWith('.webp')) {
          favicon.type = 'image/webp';
        } else if (logoUrl.endsWith('.jpg') || logoUrl.endsWith('.jpeg')) {
          favicon.type = 'image/jpeg';
        }
      }
    } else {
      if (brandLogo) {
        brandLogo.style.display = 'none';
      }
      console.warn('WattPost: Logo asset (assets/logo.*) not found.');
    }
    return logoUrl;
  }

  global.WattLogo = {
    CANDIDATES: LOGO_CANDIDATES,
    probe: probeImage,
    resolve: resolveLogoUrl,
    apply: applyBrandLogo,
    _resetCache: () => { _resolvedLogoPromise = null; }
  };

  const VALID_TABS = new Set(['dashboard', 'history', 'settings', 'bms-settings']);

  function parseHash() {
    const hash = (window.location.hash || '').toLowerCase().replace(/^#/, '');
    return VALID_TABS.has(hash) ? hash : 'dashboard';
  }

  function consumeCloudConnectAction() {
    const url = new URL(window.location.href);
    const actions = url.searchParams.getAll('action');
    if (actions.length !== 1 || actions[0] !== 'cloud-connect') {
      return false;
    }

    url.searchParams.delete('action');
    window.history.replaceState(
      window.history.state,
      '',
      url.pathname + url.search + url.hash
    );
    return true;
  }

  class App {
    constructor() {
      this.tab = parseHash();
      this.dashboard = null;
      this.history = null;
      this.deviceSettings = null;
      this.bmsSettings = null;
      this._unavailableTabs = new Set();
      this._unsubscribeRuntimeLive = null;
    }

    init() {
      // Resolve and apply brand logo & favicon
      applyBrandLogo();
      this._initRuntimeContext();

      // Hide all views, show the active one
      this._setTab(this.tab, false);

      // Tab buttons
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          this._setTab(btn.dataset.tab, true);
        });
      });

      // Hash router
      window.addEventListener('hashchange', () => {
        const next = parseHash();
        if (next !== this.tab) {
          this._setTab(next, false);
        }
      });

      // Disable browser scroll restoration (matches page.tsx)
      if ('scrollRestoration' in window.history) {
        window.history.scrollRestoration = 'manual';
      }
      window.scrollTo(0, 0);

      // Start centralized API polling coordinator
      if (global.ApiClient) {
        this._unsubscribeRuntimeLive = global.ApiClient.onLive((data, state) => {
          this._renderBmsStatus(data, state);
          this._renderRuntimeStatus(data, state);
        });
        global.ApiClient.start();
      }
    }

    _initRuntimeContext() {
      const slot = document.getElementById('runtime-context-actions');
      const brandLink = document.getElementById('brand-home-link');
      const capabilities = global.ApiClient?.getCapabilities?.() || {};
      if (!slot || capabilities.accountControls !== true) return;

      if (brandLink) {
        brandLink.href = '/account?list=1';
        brandLink.title = 'До панелі WattPost';
        brandLink.setAttribute('aria-label', 'WattPost — до панелі пристроїв');
      }

      // Cloud-only context: the current device stays on screen while the user
      // selects another WattPost. Native details/summary supports keyboard.
      const switcher = document.createElement('details');
      switcher.className = 'runtime-device-switch';
      const toggle = document.createElement('summary');
      toggle.className = 'runtime-switch-trigger';
      toggle.title = 'Швидке перемикання WattPost';
      toggle.setAttribute('aria-label', 'Усі пристрої, відкрити список');
      toggle.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h10M7 13h7"/></svg><span class="tab-label">Усі пристрої</span>';
      const counter = document.createElement('span');
      counter.className = 'runtime-device-count';
      counter.textContent = '…';
      toggle.append(counter);
      const chevron = document.createElement('span');
      chevron.className = 'runtime-device-chevron';
      chevron.textContent = '⌄';
      chevron.setAttribute('aria-hidden', 'true');
      toggle.append(chevron);
      const popup = document.createElement('div');
      popup.className = 'runtime-device-menu';
      const menuTitle = document.createElement('p');
      menuTitle.className = 'runtime-device-menu-title';
      menuTitle.textContent = 'Завантажуємо пристрої…';
      const menuList = document.createElement('div');
      menuList.className = 'runtime-device-menu-list';
      const manageLink = document.createElement('a');
      manageLink.className = 'runtime-device-manage';
      manageLink.href = '/account?list=1';
      manageLink.textContent = 'Усі пристрої та назви →';
      popup.append(menuTitle, menuList, manageLink);
      switcher.append(toggle, popup);

      const currentCloudId = global.ApiClient?.runtimeContext?.cloudId;
      let loadedDevices = null;
      function renderDevices(devices) {
        loadedDevices = devices;
        const online = devices.filter(device => device.online === true).length;
        const active = devices.find(device => device.cloud_id === currentCloudId);
        const currentName = active?.name || 'Усі пристрої';
        toggle.querySelector('.tab-label').textContent = currentName;
        counter.textContent = `${online}/${devices.length}`;
        toggle.setAttribute('aria-label', `${currentName}: ${online} онлайн із ${devices.length}, відкрити список`);
        menuTitle.textContent = `${online} онлайн із ${devices.length}`;
        menuList.replaceChildren();
        devices.forEach(device => {
          const current = device.cloud_id === currentCloudId;
          const link = document.createElement('a');
          link.className = 'runtime-device-option' + (current ? ' is-current' : '');
          link.href = '/device/' + encodeURIComponent(device.cloud_id);
          if (current) link.setAttribute('aria-current', 'page');
          const label = document.createElement('span');
          label.className = 'runtime-device-option-name';
          label.textContent = device.name || 'WattPost';
          const statusText = document.createElement('span');
          statusText.className = device.online ? 'online' : 'offline';
          statusText.textContent = device.online ? 'Онлайн' : 'Не в мережі';
          link.append(label, statusText);
          menuList.append(link);
        });
        if (!devices.length) menuTitle.textContent = 'Немає прив’язаних пристроїв';
      }
      async function loadDevices() {
        try {
          const result = await global.ApiClient.fetchOwnedDevices();
          if (!Array.isArray(result?.devices)) throw new Error('invalid_device_list');
          renderDevices(result.devices);
        } catch (_error) {
          if (!loadedDevices) {
            counter.textContent = '—';
            menuTitle.textContent = 'Не вдалося завантажити пристрої';
          } else {
            menuTitle.textContent = 'Не вдалося оновити список · ' + menuTitle.textContent;
          }
        }
      }
      switcher.addEventListener('toggle', () => {
        if (switcher.open) loadDevices();
      });
      document.addEventListener('click', event => {
        if (switcher.open && !switcher.contains(event.target)) switcher.open = false;
      });
      document.addEventListener('keydown', event => {
        if (switcher.open && event.key === 'Escape') {
          switcher.open = false;
          toggle.focus();
        }
      });
      loadDevices();

      const logoutButton = document.createElement('button');
      logoutButton.className = 'runtime-logout-button';
      logoutButton.type = 'button';
      logoutButton.title = 'Вийти';
      logoutButton.setAttribute('aria-label', 'Вийти');
      logoutButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 17l5-5-5-5M15 12H3M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5"/></svg><span class="tab-label">Вийти</span>';
      logoutButton.addEventListener('click', async () => {
        logoutButton.disabled = true;
        try {
          await global.ApiClient.logoutAccount();
          window.location.assign('/login');
        } catch (error) {
          logoutButton.disabled = false;
          if (error?.code === 'auth_required') window.location.assign('/login');
        }
      });

      slot.replaceChildren(switcher, logoutButton);
      slot.hidden = false;

      global.ApiClient.fetchAccountContext().then(account => {
        if (account?.email) {
          toggle.title = `Усі пристрої · ${account.email}`;
        }
      }).catch(() => {});
    }

    _renderBmsStatus(data, state) {
      const badge = document.getElementById('bms-online');
      if (!badge) return;
      const stale = state === 'STALE' || data?.is_stale === true;
      const offline = !data || data.online !== true ||
        (data.remote === true && (data.device_online !== true || data.bms_connected === false));
      const colors = global.STATE_COLORS?.[data?.state] || global.STATE_COLORS?.idle;
      const color = offline ? '#f85149' : stale ? '#d29922' : colors?.primary || '#8b949e';
      badge.classList.toggle('is-stale', stale);
      badge.style.borderColor = color + '55';
      badge.style.color = color;
      badge.style.background = color + '1a';
      const dot = badge.querySelector('.bms-dot');
      if (dot) {
        dot.style.background = color;
        dot.style.boxShadow = stale ? 'none' : `0 0 8px ${color}73`;
      }
      const count = Number(data?.cells?.count);
      const model = (Number.isFinite(count) && count > 0 ? `${count}S · ` : '') + (data?.model || 'BMS');
      const cloud = data?.remote === true || global.ApiClient?.runtimeContext?.mode === 'cloud';
      const cloudUnavailable = cloud && ['STALE', 'PROLONGED_OFFLINE'].includes(state);
      const offlineLabel = cloud && data?.device_online === false ? 'WattPost не в мережі'
        : state === 'BMS_OFFLINE' || data?.bms_connected === false ? 'BMS не підключена' : 'Немає зв’язку';
      badge.lastChild.nodeValue = ' ' + (cloudUnavailable ? 'Немає зв’язку з Cloud'
        : offline ? offlineLabel : stale ? (cloud && !data.has_last_fresh_battery ? 'Очікуємо дані BMS' : 'Останні відомі дані') : model);
    }

    _renderRuntimeStatus(data, state) {
      const banner = document.getElementById('runtime-status-banner');
      const cloud = data?.remote === true || global.ApiClient?.runtimeContext?.mode === 'cloud';
      if (!banner || !cloud) return;

      let message = '';
      if (state === 'STALE' || state === 'PROLONGED_OFFLINE') {
        message = 'Немає зв’язку з WattPost Cloud. Поточний стан пристрою не підтверджено.';
      } else if (data.device_online !== true) {
        const receivedAt = data.has_last_fresh_battery
          ? data.last_fresh_battery_received_at
          : data.telemetry_received_at;
        if (data.has_last_fresh_battery && receivedAt) {
          const received = new Date(receivedAt);
          const timestamp = Number.isNaN(received.getTime())
            ? 'невідомого часу'
            : received.toLocaleString('uk-UA');
          message = `WattPost не в мережі. Показано останні відомі значення батареї від ${timestamp}.`;
        } else if (data.has_snapshot && data.telemetry_received_at) {
          message = 'WattPost не в мережі. Свіжих даних батареї для цього підключення ще немає.';
        } else {
          message = 'WattPost не в мережі. Телеметрія від пристрою ще не надходила.';
        }
      } else if (data.has_snapshot && (data.telemetry_fresh !== true || state === 'STALE')) {
        const date = data.last_fresh_battery_received_at || data.telemetry_received_at;
        const timestamp = date && !Number.isNaN(new Date(date).getTime())
          ? ` від ${new Date(date).toLocaleString('uk-UA')}` : '';
        message = `WattPost онлайн, але збережена телеметрія застаріла. Показано останні відомі значення${timestamp}.`;
      } else if (data.bms_connected === true && data.bms_data_fresh !== true) {
        if (data.has_last_fresh_battery && data.last_fresh_battery_received_at) {
          const received = new Date(data.last_fresh_battery_received_at);
          const timestamp = Number.isNaN(received.getTime())
            ? 'невідомого часу'
            : received.toLocaleString('uk-UA');
          message = `WattPost онлайн, але телеметрія BMS застаріла. Показано останні відомі значення батареї від ${timestamp}.`;
        } else {
          message = 'WattPost онлайн, але телеметрія BMS застаріла. Свіжих значень батареї ще немає.';
        }
      } else if (data.bms_connected === false) {
        message = 'WattPost онлайн, але BMS зараз не підключена.';
      } else if (!data.has_snapshot) {
        message = 'WattPost онлайн. Очікуємо першу телеметрію.';
      }

      banner.textContent = message;
      banner.hidden = !message;
    }

    _showUnavailable(view, title, description) {
      if (!view) return;
      const panel = document.createElement('section');
      panel.className = 'capability-unavailable';
      panel.setAttribute('role', 'status');
      const heading = document.createElement('h1');
      heading.textContent = title;
      const message = document.createElement('p');
      message.textContent = description;
      panel.append(heading, message);
      view.replaceChildren(panel);
    }

    startCloudConnectFlow() {
      this._setTab('settings', true);
      if (!this.deviceSettings) return Promise.resolve();
      return this.deviceSettings.startCloudConnectFlow();
    }

    _setTab(tab, updateHash) {
      this.tab = tab;
      global.ApiClient?.setHistoryView?.(tab);

      // Toggle view visibility
      const dashView = document.getElementById('view-dashboard');
      const histView = document.getElementById('view-history');
      const setView = document.getElementById('view-settings');
      const bmsSetView = document.getElementById('view-bms-settings');

      if (dashView) dashView.classList.toggle('is-active', tab === 'dashboard');
      if (histView) histView.classList.toggle('is-active', tab === 'history');
      if (setView) setView.classList.toggle('is-active', tab === 'settings');
      if (bmsSetView) bmsSetView.classList.toggle('is-active', tab === 'bms-settings');

      // Toggle tab buttons
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.tab === tab);
      });

      // Lazy-init views on first activation
      if (tab === 'dashboard') {
        if (!this.dashboard) {
          this.dashboard = new global.Dashboard();
          this.dashboard.init();
        }
      } else if (tab === 'history') {
        const capabilities = global.ApiClient?.getCapabilities?.() || {};
        if (capabilities.historyRead === false) {
          if (!this._unavailableTabs.has(tab)) {
            this._showUnavailable(histView, 'Історія', 'Віддалена історія стане доступною після синхронізації записів WattPost у Cloud.');
            this._unavailableTabs.add(tab);
          }
        } else if (!this.history) {
          this.history = new global.HistoryView();
          this.history.init();
        }
      } else if (tab === 'settings') {
        if (!this.deviceSettings) {
          this.deviceSettings = new global.DeviceSettingsView();
          this.deviceSettings.init();
        }
      } else if (tab === 'bms-settings') {
        const capabilities = global.ApiClient?.getCapabilities?.() || {};
        if (capabilities.bmsSettingsRead === false) {
          if (!this._unavailableTabs.has(tab)) {
            this._showUnavailable(bmsSetView, 'Налаштування BMS', 'Віддалене читання налаштувань BMS поки недоступне.');
            this._unavailableTabs.add(tab);
          }
        } else if (!this.bmsSettings) {
          this.bmsSettings = new global.SettingsView();
          this.bmsSettings.init();
        }
        if (capabilities.bmsSettingsRead !== false && global.ApiClient) {
          global.ApiClient.fetchSettings();
        }
      }

      // Update URL hash if requested
      if (updateHash) {
        const targetHash = '#' + tab;
        if (window.location.hash !== targetHash) {
          window.history.replaceState(
            null,
            '',
            window.location.pathname + window.location.search + targetHash
          );
        }
      }
    }
  }

  // Boot when DOM is ready
  function boot() {
    const shouldStartCloudConnect = consumeCloudConnectAction();
    const app = new App();
    global.app = app;
    app.init();
    if (shouldStartCloudConnect) {
      app.startCloudConnectFlow();
    }
    return app;
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => boot());
    } else {
      boot();
    }
  }
})(window);
