// 07-sync.js — serverside opslag van de planner-state (autosave + herstel).
// Laadvolgorde staat in lib/planner-files.js (manifest voor index.html,
// server-allowlist en tests). Klassieke scripts, geen modules.
//
// Voor ingelogde gebruikers wordt de complete werk-state automatisch naar
// /api/planner/state gepusht en bij het openen van de planner hersteld —
// op elk apparaat verder werken dus. Demo-modus en niet-ingelogde
// bezoekers blijven puur client-side (zoals voorheen).
(function () {
  'use strict';
  // In de vm-testsandbox bestaat `location` niet: sync volledig overslaan
  // (anders zou de autosave-interval de testrunner open houden).
  if (typeof location === 'undefined') return;
  if (location.protocol === 'file:') return;
  if (window.RDA_DEMO && window.RDA_DEMO.isActive && window.RDA_DEMO.isActive()) return;

  var SYNC_FIELDS = ['config', 'participants', 'forcedCombos', 'socialHosts', 'planning', 'nextId'];
  var lastPushed = null;   // JSON van de laatst succesvol gepushte state
  var enabled = false;     // pas na een geslaagde GET (dus: ingelogd)
  var pushBusy = false;

  function snapshotState() {
    var o = {};
    SYNC_FIELDS.forEach(function (k) { o[k] = state[k]; });
    return JSON.stringify(o);
  }

  function isPristine() {
    return state.participants.length === 0 && state.forcedCombos.length === 0 && !state.planning;
  }

  // Config-waarden terug de formuliervelden in (het omgekeerde van de
  // change-listeners in 01-core; snapshot-laden deed dit nooit omdat het
  // direct naar stap 4 springt).
  function applyConfigToUI() {
    var c = state.config;
    var setVal = function (id, v) { var el = document.getElementById(id); if (el && v !== undefined && v !== null) el.value = v; };
    setVal('event-name', c.eventName);
    setVal('event-date', c.eventDate);
    setVal('event-city', c.eventCity);
    setVal('min-table-size', c.minTableSize);
    setVal('max-table-size', c.maxTableSize);
    setVal('transport-mode', c.transportMode);
    setVal('max-distance-km', c.maxDistanceKm);
    ['voorborrel', 'voorgerecht', 'hoofdgerecht', 'nagerecht', 'naborrel'].forEach(function (course) {
      var tm = c.times && c.times[course];
      if (!tm) return;
      setVal(course + '-start', tm.start);
      setVal(course + '-duration', tm.duration);
    });
    ['voorborrel', 'naborrel'].forEach(function (course) {
      var cb = document.getElementById('has-' + course);
      if (!cb) return;
      cb.checked = Boolean(c.optionalCourses && c.optionalCourses[course]);
      // change-event laat de bestaande listener de tijd-config tonen/verbergen
      cb.dispatchEvent(new Event('change'));
    });
  }

  function applyServerState(s) {
    state.config = Object.assign({}, state.config, s.config || {});
    state.participants = Array.isArray(s.participants) ? s.participants : [];
    state.forcedCombos = Array.isArray(s.forcedCombos) ? s.forcedCombos : [];
    state.socialHosts = s.socialHosts || { voorborrel: null, naborrel: null };
    state.planning = s.planning || null;
    var maxId = 0;
    state.participants.forEach(function (p) { if (p.id > maxId) maxId = p.id; });
    state.nextId = s.nextId || maxId + 1;
    applyConfigToUI();
    if (typeof applyCourseLabelsToUI === 'function') applyCourseLabelsToUI();
    var vn = document.getElementById('venue-name'); if (vn) vn.value = state.config.venueName || '';
    var vt = document.getElementById('venue-tables'); if (vt) vt.value = state.config.venueTables || '';
    if (typeof applyVenueModeToUI === 'function') applyVenueModeToUI();
    lastPushed = snapshotState();
    // Toon de gebruiker zijn data: planning aanwezig → overzicht, anders deelnemers
    if (state.planning) goToStep(4);
    else if (state.participants.length) goToStep(2);
  }

  function setStatus(text) {
    var bar = document.getElementById('auth-bar');
    if (!bar) return;
    var el = document.getElementById('sync-status');
    if (!el) {
      el = document.createElement('span');
      el.id = 'sync-status';
      el.style.cssText = 'opacity:.65;font-size:.78rem';
      var anchor = document.getElementById('auth-license-info');
      (anchor && anchor.parentNode === bar ? bar.insertBefore(el, anchor.nextSibling) : bar.appendChild(el));
    }
    el.textContent = text;
  }

  function timeNow() {
    try { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }

  function push(useBeacon) {
    if (!enabled || pushBusy) return;
    var snap = snapshotState();
    if (snap === lastPushed) return;
    if (isPristine() && lastPushed === null) return; // geen lege eerste save
    var body = JSON.stringify({ state: JSON.parse(snap) });
    if (useBeacon && navigator.sendBeacon) {
      // Bij het sluiten van de pagina: fetch met keepalive is betrouwbaarder
      // dan een gewone fetch, sendBeacon kan geen PUT — dus keepalive.
      fetch('/api/planner/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
      lastPushed = snap;
      return;
    }
    pushBusy = true;
    fetch('/api/planner/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: body })
      .then(function (res) {
        if (res.status === 401) { enabled = false; return; }
        if (res.ok) {
          lastPushed = snap;
          setStatus(I18n.t('app.sync.saved', 'Automatisch opgeslagen') + ' ' + timeNow());
        }
      })
      .catch(function () { /* offline: volgende poging pakt het op */ })
      .finally(function () { pushBusy = false; });
  }

  function showRestoreBanner(serverState, updatedAt) {
    var when = '';
    try { when = new Date(updatedAt).toLocaleString(); } catch (e) {}
    var bar = document.createElement('div');
    bar.id = 'sync-restore-bar';
    bar.style.cssText = 'background:#FFF4ED;border-bottom:1px solid #FBD5C4;padding:10px 20px;font-size:.88rem;display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-family:inherit';
    var msg = document.createElement('span');
    msg.textContent = I18n.t('app.sync.restore_found', 'Er staat een opgeslagen event in je account') + (when ? ' (' + when + ')' : '') + '. ';
    var btnYes = document.createElement('button');
    btnYes.textContent = I18n.t('app.sync.restore_btn', 'Opgeslagen event laden');
    btnYes.style.cssText = 'background:#E85D3A;color:#fff;border:0;border-radius:8px;padding:6px 14px;font-weight:700;cursor:pointer';
    var btnNo = document.createElement('button');
    btnNo.textContent = I18n.t('app.sync.restore_dismiss', 'Hier verder werken');
    btnNo.style.cssText = 'background:none;border:1px solid #E2E8F0;border-radius:8px;padding:6px 14px;cursor:pointer';
    btnYes.addEventListener('click', function () { applyServerState(serverState); bar.remove(); });
    btnNo.addEventListener('click', function () { bar.remove(); });
    bar.appendChild(msg); bar.appendChild(btnYes); bar.appendChild(btnNo);
    document.body.insertBefore(bar, document.body.firstChild);
  }

  function init() {
    fetch('/api/planner/state')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.ok) return; // niet ingelogd of geen backend
        enabled = true;
        setStatus(I18n.t('app.sync.on', 'Opslaan in account: aan'));
        if (data.state) {
          if (isPristine()) applyServerState(data.state);
          else if (snapshotState() !== JSON.stringify((function () { var o = {}; SYNC_FIELDS.forEach(function (k) { o[k] = data.state[k]; }); return o; })())) {
            showRestoreBanner(data.state, data.updatedAt);
          }
        }
        // Autosave: elke 15s als er iets veranderde, plus bij verlaten pagina
        setInterval(function () { push(false); }, 15000);
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'hidden') push(true);
        });
        window.addEventListener('beforeunload', function () { push(true); });
      })
      .catch(function () { /* geen netwerk of geen server: stil overslaan */ });
  }

  init();
})();
