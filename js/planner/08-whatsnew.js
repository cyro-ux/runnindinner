// 08-whatsnew.js — "wat is er nieuw"-banner voor ingelogde gebruikers.
// Laadvolgorde staat in lib/planner-files.js (manifest voor index.html,
// server-allowlist en tests). Klassieke scripts, geen modules.
//
// Haalt ongeziene release-aankondigingen op (per account bijgehouden, dus
// over apparaten heen) en toont ze in de taal van de gebruiker. Eén klik op
// "Begrepen" markeert alles als gezien.
(function () {
  'use strict';
  // vm-testsandbox en file:-gebruik: overslaan (zelfde guard als 07-sync)
  if (typeof location === 'undefined') return;
  if (location.protocol === 'file:') return;
  if (window.RDA_DEMO && window.RDA_DEMO.isActive && window.RDA_DEMO.isActive()) return;

  function pickLang(item) {
    var lang = (window.I18n && I18n.getLang && I18n.getLang()) || 'nl';
    return item[lang] || item.nl || item.en;
  }

  function showBanner(items) {
    if (document.getElementById('whatsnew-bar')) return;
    var bar = document.createElement('div');
    bar.id = 'whatsnew-bar';
    bar.style.cssText = 'background:#EFF8F1;border-bottom:1px solid #BFE3C6;padding:12px 20px;font-size:.88rem;display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;font-family:inherit';

    var body = document.createElement('div');
    body.style.cssText = 'flex:1;min-width:240px';
    items.forEach(function (item) {
      var t = pickLang(item);
      if (!t) return;
      var title = document.createElement('div');
      title.style.cssText = 'font-weight:700;margin-bottom:2px';
      title.textContent = '🎉 ' + t.title;
      var text = document.createElement('div');
      text.style.cssText = 'opacity:.85';
      text.textContent = t.text;
      body.appendChild(title);
      body.appendChild(text);
    });

    var btn = document.createElement('button');
    btn.textContent = I18n.t('app.whatsnew.dismiss', 'Begrepen');
    btn.style.cssText = 'background:#2F9E44;color:#fff;border:0;border-radius:8px;padding:6px 14px;font-weight:700;cursor:pointer;align-self:center';
    btn.addEventListener('click', function () {
      bar.remove();
      fetch('/api/announcements/seen', { method: 'POST' }).catch(function () {});
    });

    bar.appendChild(body);
    bar.appendChild(btn);
    document.body.insertBefore(bar, document.body.firstChild);
  }

  fetch('/api/announcements')
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (data && data.ok && Array.isArray(data.items) && data.items.length) {
        showBanner(data.items);
      }
    })
    .catch(function () { /* niet ingelogd of offline: stil overslaan */ });

  // Eenmalige review-herinnering: gebruikers die de planner gebruikten maar
  // nog geen review gaven, krijgen na inloggen nog precies één keer de
  // bestaande review-modal te zien (server registreert het tonen, dus ook
  // wegklikken telt en de vraag komt op geen enkel apparaat terug).
  fetch('/api/ratings/reprompt')
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data || !data.ok || !data.show) return;
      if (typeof showRatingModal !== 'function') return;
      fetch('/api/ratings/reprompt/seen', { method: 'POST' }).catch(function () {});
      // Ruim na de eventuele "wat is er nieuw"-banner, zodat die eerst landt
      setTimeout(function () { showRatingModal(); }, 6000);
    })
    .catch(function () { /* stil overslaan */ });
})();
