/* WattPost language runtime — shared by ESP32 offline UI and Cloud.
 * Translation is explicit: only stable locale-independent keys are resolved.
 * Device/user text and unbound DOM content are never interpreted as labels.
 */
(function (global) {
  'use strict';
  const STORAGE_KEY = 'wattpost.language';
  const SUPPORTED = ['uk', 'en'];
  const catalogs = Object.create(null);
  const translateAttrs = ['title', 'aria-label', 'placeholder'];

  const language = (function () {
    // First Setup and bms.local are separate browser origins: explicit links
    // carry ?lang= so the user's choice survives the network transition.
    const selected = global.location?.search
      ? new URLSearchParams(global.location.search).get('lang') : null;
    if (SUPPORTED.includes(selected)) {
      try { global.localStorage.setItem(STORAGE_KEY, selected); } catch (_error) { /* disabled */ }
      return selected;
    }
    let stored = null;
    try { stored = global.localStorage.getItem(STORAGE_KEY); } catch (_error) { /* disabled */ }
    if (SUPPORTED.includes(stored)) return stored;
    const preferred = global.navigator?.languages?.[0] || global.navigator?.language || '';
    const candidate = String(preferred).split('-')[0].toLowerCase();
    return SUPPORTED.includes(candidate) ? candidate : 'uk';
  })();

  function register(locale, entries) {
    if (!SUPPORTED.includes(locale) || !entries || typeof entries !== 'object') {
      throw new Error('Invalid WattPost locale catalog');
    }
    const catalog = catalogs[locale] || (catalogs[locale] = Object.create(null));
    for (const [key, value] of Object.entries(entries)) {
      if (!/^[a-z][a-z0-9_.]*$/.test(key) || typeof value !== 'string' || !value) {
        throw new Error('Invalid WattPost translation key: ' + key);
      }
      catalog[key] = value;
    }
    if (global.document?.body) apply(global.document.body);
  }

  // Explicit locale lookup for technical reference labels (e.g. English names
  // shown under Ukrainian BMS parameter labels); never used for user data.
  function tLocale(locale, key) {
    if (typeof key !== 'string') return key;
    const selected = catalogs[SUPPORTED.includes(locale) ? locale : language] || {};
    return selected[key] || catalogs.uk?.[key] || key;
  }

  function t(key, values) {
    if (typeof key !== 'string') return key;
    const template = (catalogs[language] || {})[key] ||
      (catalogs.uk || {})[key];
    if (!template) return key;
    if (!values || typeof values !== 'object') return template;
    return template.replace(/\{([a-z][a-z0-9_]*)\}/gi, (token, name) =>
      Object.hasOwn(values, name) ? String(values[name]) : token);
  }

  function translateElement(element) {
    if (element.closest('[data-i18n-ignore]')) return;
    const key = element.getAttribute('data-i18n');
    if (key) {
      const translated = t(key);
      if (translated !== key && element.textContent !== translated) {
        // data-i18n is only for text-only elements, never nested controls.
        element.textContent = translated;
      }
    }
    for (const attribute of translateAttrs) {
      const attrKey = element.getAttribute('data-i18n-' + attribute);
      if (!attrKey) continue;
      const translated = t(attrKey);
      if (translated !== attrKey && element.getAttribute(attribute) !== translated) {
        element.setAttribute(attribute, translated);
      }
    }
  }

  function apply(root) {
    if (!root || !global.document) return;
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.nodeType === 1) translateElement(root);
    const selector = '[data-i18n], [data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder]';
    for (const element of root.querySelectorAll?.(selector) || []) translateElement(element);
  }

  function init() {
    if (!global.document) return;
    global.document.documentElement.lang = language;
    apply(global.document.body);
    for (const switcher of global.document.querySelectorAll('[data-language-switch]')) {
      switcher.value = language;
      switcher.addEventListener('change', function () {
        if (!SUPPORTED.includes(this.value)) return;
        try { global.localStorage.setItem(STORAGE_KEY, this.value); } catch (_error) { /* disabled */ }
        global.location.reload();
      });
    }
  }

  global.WattPostI18n = Object.freeze({
    language, t, tLocale, register, apply, init, storageKey: STORAGE_KEY
  });
  if (global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', init, { once: true });
    } else init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
