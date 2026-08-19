// 01-core.js — Basis: state, escaping, naam/plaats-helpers, navigatie, stap 1 (config).
// Laadvolgorde staat in lib/planner-files.js (manifest voor
// index.html, server-allowlist en tests). Klassieke scripts,
// geen modules: functies zijn globaal over de delen heen.
/* ============================================
   Running Dinner Planner - Main Application
   ============================================ */

'use strict';

// ---- HTML escaping (XSS prevention) ----
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- State ----
const state = {
  config: {
    courses: ['voorgerecht', 'hoofdgerecht', 'nagerecht'],
    optionalCourses: { voorborrel: false, naborrel: false },
    times: {
      voorborrel: { start: '17:00', duration: 45 },
      voorgerecht: { start: '18:00', duration: 45 },
      hoofdgerecht: { start: '19:00', duration: 60 },
      nagerecht: { start: '20:15', duration: 45 },
      naborrel: { start: '21:15', duration: 60 }
    },
    minTableSize: 4,
    maxTableSize: 6,
    eventName: 'Running Dinner 2026',
    eventDate: '2026-05-16',
    eventCity: '',
    transportMode: 'walking',     // walking | cycling | driving
    maxDistanceKm: 3              // drempel voor warnings in distance-check
  },
  participants: [],
  forcedCombos: [],
  planning: null,
  nextId: 1,
  // Hosts for social courses: { participantId } or { customAddress }
  socialHosts: { voorborrel: null, naborrel: null },
  manualChanges: []
};

// ---- Display + seat helpers (handelt name1 / name2 / optionele name3 af) ----
// Een deelnemer-entry kan 1 persoon, een koppel (name1+name2), of een koppel
// met een meereiziger zonder eigen vervoer (name1+name2+name3) bevatten.
function displayName(p) {
  if (!p) return '';
  let s = p.name1 || '';
  if (p.name2) s += ' & ' + p.name2;
  if (p.name3) s += ' & ' + p.name3;
  return s;
}
function displayNameSafe(p) {
  if (!p) return '';
  let s = escapeHtml(p.name1 || '');
  if (p.name2) s += ' &amp; ' + escapeHtml(p.name2);
  if (p.name3) s += ' &amp; ' + escapeHtml(p.name3);
  return s;
}
// Wie van een entry is bij deze gang aanwezig? Elk van de (max 3) personen
// heeft een eigen beschikbaarheid: persoon 1 kan het voorgerecht overslaan
// terwijl de partner er wel is, en omgekeerd. Ontbrekende availability
// (oude data) betekent "aanwezig".
function attendeesAt(p, course) {
  if (!p) return [];
  const av = p.availability?.[course];
  const present = [];
  if (av?.person1 !== false) present.push(p.name1);
  if (p.name2 && av?.person2 !== false) present.push(p.name2);
  if (p.name3 && av?.person3 !== false) present.push(p.name3);
  return present.filter(Boolean);
}

// Aantal bezette stoelen bij een gang: 0 (niemand komt), 1, 2 of 3.
function personSeatsAt(p, course) {
  return attendeesAt(p, course).length;
}

// Naam zoals getoond bij een specifieke gang — alleen wie er daadwerkelijk is.
// Cruciaal voor de gastheer: die moet weten of er één of twee mensen komen.
function displayNameAt(p, course) {
  const names = attendeesAt(p, course);
  return names.length ? names.join(' & ') : displayName(p);
}

// Initialen voor de avatar. Robuust tegen lege namen (voorheen gaf een lege
// name1 letterlijk "UNDEFINED" in de UI) en neemt de meereiziger mee.
function initialsOf(p) {
  const letters = [p?.name1, p?.name2, p?.name3]
    .filter(n => typeof n === 'string' && n.trim())
    .map(n => n.trim()[0].toUpperCase());
  return letters.join('') || '?';
}

// Alle dieetwensen/allergieën van een entry als één string. Eén bron van
// waarheid — voorkomt dat ergens een persoon (bv. de meereiziger) vergeten
// wordt en een allergie niet bij de gastheer terechtkomt.
function dietsOf(p) {
  return [p?.diet1, p?.diet2, p?.diet3].filter(Boolean).join(', ');
}

// Per-host capaciteit (override of globaal). Een host kan zelf aangeven dat
// zijn/haar tafel meer of minder gasten dan de standaard kan herbergen — bv.
// kleine eetkamer = 2 gasten max, ruime tuin = 10 gasten max.
function hostMaxGuests(host) {
  const v = host?.customMaxGuests;
  return (Number.isFinite(v) && v > 0) ? v : state.config.maxTableSize;
}
function hostMinGuests(host) {
  const v = host?.customMinGuests;
  return (Number.isFinite(v) && v > 0) ? v : state.config.minTableSize;
}

function getCourseLabel(key) {
  const labels = {
    voorborrel: I18n.t('app.courses.voorborrel', 'Voorborrel'),
    voorgerecht: I18n.t('app.courses.voorgerecht', 'Voorgerecht'),
    hoofdgerecht: I18n.t('app.courses.hoofdgerecht', 'Hoofdgerecht'),
    nagerecht: I18n.t('app.courses.nagerecht', 'Nagerecht'),
    naborrel: I18n.t('app.courses.naborrel', 'Naborrel'),
  };
  return labels[key] || key;
}
const COURSE_ICONS = {
  voorborrel: '🥂',
  voorgerecht: '🥗',
  hoofdgerecht: '🍖',
  nagerecht: '🍰',
  naborrel: '🎉'
};

function getActiveCourses() {
  const order = ['voorborrel', 'voorgerecht', 'hoofdgerecht', 'nagerecht', 'naborrel'];
  return order.filter(c => {
    if (c === 'voorgerecht' || c === 'hoofdgerecht' || c === 'nagerecht') return true;
    return state.config.optionalCourses[c];
  });
}

// ---- Navigation ----
function goToStep(n) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.step-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('step-' + n).classList.add('active');
  document.querySelector(`.step-btn[data-step="${n}"]`).classList.add('active');

  if (n === 2) renderParticipantsList();
  if (n === 3) renderSocialLocationConfig();
  if (n === 4) { renderOverview(); maybeShowRatingPrompt(); loadSharedPlanning(); }
}

document.querySelectorAll('.step-btn').forEach(btn => {
  btn.addEventListener('click', () => goToStep(parseInt(btn.dataset.step)));
});

// ---- Step 1: Config ----
function initStep1() {
  const voorborrelCb = document.getElementById('has-voorborrel');
  const naborrelCb = document.getElementById('has-naborrel');

  voorborrelCb.addEventListener('change', () => {
    state.config.optionalCourses.voorborrel = voorborrelCb.checked;
    document.getElementById('voorborrel-time-config').style.display = voorborrelCb.checked ? 'flex' : 'none';
    updateHostPreferenceOptions();
  });

  naborrelCb.addEventListener('change', () => {
    state.config.optionalCourses.naborrel = naborrelCb.checked;
    document.getElementById('naborrel-time-config').style.display = naborrelCb.checked ? 'flex' : 'none';
    updateHostPreferenceOptions();
  });

  // Sync time inputs to state
  const timeFields = ['voorborrel', 'voorgerecht', 'hoofdgerecht', 'nagerecht', 'naborrel'];
  timeFields.forEach(course => {
    const startEl = document.getElementById(course + '-start');
    const durEl = document.getElementById(course + '-duration');
    if (startEl) startEl.addEventListener('change', () => { state.config.times[course].start = startEl.value; });
    if (durEl) durEl.addEventListener('change', () => { state.config.times[course].duration = parseInt(durEl.value); });
  });

  const minEl = document.getElementById('min-table-size');
  const maxEl = document.getElementById('max-table-size');
  minEl.addEventListener('change', e => {
    let val = parseInt(e.target.value);
    if (val > state.config.maxTableSize) { val = state.config.maxTableSize; e.target.value = val; }
    state.config.minTableSize = val;
  });
  maxEl.addEventListener('change', e => {
    let val = parseInt(e.target.value);
    if (val < state.config.minTableSize) { val = state.config.minTableSize; e.target.value = val; }
    state.config.maxTableSize = val;
  });
  document.getElementById('event-name').addEventListener('input', e => { state.config.eventName = e.target.value; });
  document.getElementById('event-date').addEventListener('change', e => { state.config.eventDate = e.target.value; });
  document.getElementById('event-city').addEventListener('input', e => { state.config.eventCity = e.target.value; });

  const transportEl = document.getElementById('transport-mode');
  if (transportEl) transportEl.addEventListener('change', e => { state.config.transportMode = e.target.value; });
  const maxDistEl = document.getElementById('max-distance-km');
  if (maxDistEl) maxDistEl.addEventListener('change', e => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v) && v > 0) state.config.maxDistanceKm = v;
  });
}

