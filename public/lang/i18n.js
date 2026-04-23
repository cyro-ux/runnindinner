/**
 * i18n – Lightweight client-side translation loader
 *
 * How it works:
 * - Dutch (NL) is the default language, hardcoded in HTML
 * - English (EN) is loaded as an overlay from /lang/en.json
 * - Language is detected from: URL path (/en/) > cookie (lang) > <html lang>
 * - All elements with [data-i18n] get their textContent replaced
 * - Elements with [data-i18n-placeholder] get their placeholder replaced
 * - Elements with [data-i18n-html] get their innerHTML replaced
 *
 * Usage in JS:  I18n.t('auth.login.title', 'Inloggen')
 */
'use strict';

const I18n = (() => {
  let _lang = 'nl';
  let _translations = {};
  let _ready = false;
  const _callbacks = [];

  const SUPPORTED = ['nl', 'en', 'es', 'de'];

  // Detect language from URL path, cookie, or <html lang>
  function detectLang() {
    // 1. URL path: /en/, /es/, etc.
    for (const lang of SUPPORTED) {
      if (lang === 'nl') continue;
      if (location.pathname.startsWith(`/${lang}/`) || location.pathname === `/${lang}`) {
        return lang;
      }
    }
    // 2. Cookie
    const m = document.cookie.match(/(?:^|;\s*)lang=(\w+)/);
    if (m && SUPPORTED.includes(m[1])) {
      return m[1];
    }
    // 3. <html lang> (set by server)
    const htmlLang = document.documentElement.lang;
    if (htmlLang && SUPPORTED.includes(htmlLang)) {
      return htmlLang;
    }
    return 'nl';
  }

  // Resolve a dotted key like "nav.features" from nested object
  function resolve(obj, key) {
    return key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
  }

  // Translate a key, with optional fallback (defaults to key itself)
  function t(key, fallback) {
    const val = resolve(_translations, key);
    return val !== undefined ? val : (fallback !== undefined ? fallback : key);
  }

  // Apply translations to all [data-i18n] elements in the DOM
  function applyToDOM(root) {
    const container = root || document;

    // data-i18n → textContent
    container.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const val = resolve(_translations, key);
      if (val !== undefined) el.textContent = val;
    });

    // data-i18n-html → innerHTML
    container.querySelectorAll('[data-i18n-html]').forEach(el => {
      const key = el.getAttribute('data-i18n-html');
      const val = resolve(_translations, key);
      if (val !== undefined) el.innerHTML = val;
    });

    // data-i18n-placeholder → placeholder attribute
    container.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const val = resolve(_translations, key);
      if (val !== undefined) el.placeholder = val;
    });

    // data-i18n-title → title attribute
    container.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      const val = resolve(_translations, key);
      if (val !== undefined) el.title = val;
    });

    // data-i18n-value → value attribute (for buttons/inputs)
    container.querySelectorAll('[data-i18n-value]').forEach(el => {
      const key = el.getAttribute('data-i18n-value');
      const val = resolve(_translations, key);
      if (val !== undefined) el.value = val;
    });
  }

  // Set cookie
  function setCookie(name, value, days) {
    const d = new Date();
    d.setTime(d.getTime() + days * 86400000);
    document.cookie = `${name}=${value};expires=${d.toUTCString()};path=/;SameSite=Lax`;
  }

  // Initialize: detect language, load translations if needed
  async function init() {
    _lang = detectLang();
    document.documentElement.lang = _lang;

    if (_lang === 'nl') {
      // Dutch is the default in HTML, no loading needed
      _ready = true;
      _callbacks.forEach(cb => cb());
      return _lang;
    }

    // Load translations for non-default language (en, es, ...)
    try {
      const resp = await fetch(`/lang/${_lang}.json`);
      if (resp.ok) {
        _translations = await resp.json();
        applyToDOM();
      }
    } catch (e) {
      console.warn('[i18n] Failed to load translations:', e);
    }

    _ready = true;
    _callbacks.forEach(cb => cb());
    return _lang;
  }

  // Register a callback for when translations are ready
  function onReady(cb) {
    if (_ready) cb();
    else _callbacks.push(cb);
  }

  // Get current language
  function getLang() {
    return _lang;
  }

  // Strip any supported language prefix (/en/, /es/, etc.) from a path
  function stripLangPrefix(path) {
    for (const lang of SUPPORTED) {
      if (lang === 'nl') continue;
      if (path.startsWith(`/${lang}/`) || path === `/${lang}`) {
        return path.replace(new RegExp(`^/${lang}/?`), '/') || '/';
      }
    }
    return path;
  }

  // Switch language and navigate
  function switchTo(lang) {
    if (!SUPPORTED.includes(lang)) return;
    setCookie('lang', lang, 365);
    const basePath = stripLangPrefix(location.pathname);

    if (lang === 'nl') {
      // Remove prefix entirely
      if (basePath !== location.pathname) {
        location.href = basePath + location.search + location.hash;
        return;
      }
    } else {
      // Apply /lang/ prefix
      const newPath = `/${lang}` + (basePath === '/' ? '/' : basePath);
      if (newPath !== location.pathname) {
        location.href = newPath + location.search + location.hash;
        return;
      }
    }
    // If no URL change needed (already on correct prefix), just reload
    location.reload();
  }

  // Language display labels (used in toggle)
  const LANG_LABELS = { nl: 'NL', en: 'EN', es: 'ES', de: 'DE' };

  // Build a language toggle element (NL | EN | ES)
  function createToggle() {
    const container = document.createElement('div');
    container.className = 'lang-toggle';
    const parts = [];
    SUPPORTED.forEach((lang, idx) => {
      if (idx > 0) parts.push('<span class="lang-sep">|</span>');
      parts.push(`<button class="lang-btn${_lang === lang ? ' active' : ''}" data-lang="${lang}">${LANG_LABELS[lang] || lang.toUpperCase()}</button>`);
    });
    container.innerHTML = parts.join('');
    container.querySelectorAll('.lang-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTo(btn.dataset.lang));
    });
    return container;
  }

  return { init, t, getLang, switchTo, createToggle, applyToDOM, onReady };
})();

// Auto-initialize on DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => I18n.init());
} else {
  I18n.init();
}
