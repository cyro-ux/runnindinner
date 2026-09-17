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
    optionalCourses: { voorborrel: false, naborrel: false, extra1: false, extra2: false },
    // Zaal-modus: borrel- en extra slots kunnen als tafelronde meedraaien
    // (i.p.v. plenair) — zo zijn tot 7 roterende "gangen" mogelijk. Extra
    // slots zijn "extra gangen" en roteren daar standaard wél.
    venueSocialRotate: { voorborrel: false, naborrel: false, extra1: true, extra2: true },
    times: {
      voorborrel: { start: '17:00', duration: 45 },
      voorgerecht: { start: '18:00', duration: 45 },
      hoofdgerecht: { start: '19:00', duration: 60 },
      nagerecht: { start: '20:15', duration: 45 },
      extra1: { start: '21:15', duration: 30 },
      extra2: { start: '21:45', duration: 30 },
      naborrel: { start: '22:15', duration: 60 }
    },
    minTableSize: 4,
    maxTableSize: 6,
    eventName: 'Running Dinner 2026',
    eventDate: '2026-05-16',
    eventCity: '',
    // Eigen ganglabels (bv. naborrel -> "Quiz"); leeg = standaardnaam
    courseLabels: {},
    // Zaal-modus: alle gangen op één locatie, deelnemers rouleren van
    // tafel per gang (bv. clubdiner in een zaal). Geen adressen/routes.
    venueMode: false,
    venueName: '',
    venueTables: null,   // null = automatisch (stoelen / max tafelgrootte)
    transportMode: 'walking',     // walking | cycling | driving
    maxDistanceKm: 3              // drempel voor warnings in distance-check
  },
  participants: [],
  forcedCombos: [],
  planning: null,
  nextId: 1,
  // Hosts for social courses: { participantId } or { customAddress }
  socialHosts: { voorborrel: null, naborrel: null, extra1: null, extra2: null },
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
  // Eigen label van de organisator wint van de standaard-/vertaalde naam
  const custom = state.config.courseLabels && state.config.courseLabels[key];
  if (custom) return custom;
  const labels = {
    voorborrel: I18n.t('app.courses.voorborrel', 'Voorborrel'),
    voorgerecht: I18n.t('app.courses.voorgerecht', 'Voorgerecht'),
    hoofdgerecht: I18n.t('app.courses.hoofdgerecht', 'Hoofdgerecht'),
    nagerecht: I18n.t('app.courses.nagerecht', 'Nagerecht'),
    naborrel: I18n.t('app.courses.naborrel', 'Naborrel'),
    extra1: I18n.t('app.courses.extra1', 'Extra gang 1'),
    extra2: I18n.t('app.courses.extra2', 'Extra gang 2'),
  };
  return labels[key] || key;
}
function renameCourse(course) {
  const current = getCourseLabel(course);
  const answer = prompt(I18n.t('app.config.rename_prompt', 'Nieuwe naam voor deze gang (leeg laten = standaardnaam):'), current);
  if (answer === null) return; // geannuleerd
  const label = answer.trim().slice(0, 40);
  if (!state.config.courseLabels) state.config.courseLabels = {};
  if (label) state.config.courseLabels[course] = label;
  else delete state.config.courseLabels[course];
  applyCourseLabelsToUI();
}

// Zet eigen labels in de stap-1-rijen. Bij een eigen label verwijderen we
// data-i18n zodat de taalwissel het niet meer overschrijft; bij reset komt
// het attribuut (en de vertaalde naam) terug.
function applyCourseLabelsToUI() {
  document.querySelectorAll('.course-name[data-course]').forEach(el => {
    const course = el.dataset.course;
    const custom = state.config.courseLabels && state.config.courseLabels[course];
    if (custom) {
      el.removeAttribute('data-i18n');
      el.textContent = custom;
    } else {
      el.setAttribute('data-i18n', 'app.courses.' + course);
      el.textContent = getCourseLabel(course);
    }
  });
}

function isVenueMode() {
  return Boolean(state.config.venueMode);
}

function setVenueMode(mode) {
  state.config.venueMode = (mode === 'venue');
  applyVenueModeToUI();
}

// Verbergt/toont alles wat alleen bij thuis-hosting hoort (adres, gastrol,
// afstandscheck, borrellocaties) en versoepelt de adres-verplichting.
function applyVenueModeToUI() {
  const venue = isVenueMode();
  const setShown = (id, shown) => { const el = document.getElementById(id); if (el) el.style.display = shown ? '' : 'none'; };
  setShown('venue-config-fields', venue);
  setShown('modal-address-section', !venue);
  setShown('modal-host-section', !venue);
  setShown('modal-venue-host-section', venue);
  setShown('distance-check-card', !venue);
  if (venue) setShown('social-locations-card', false);
  ['p-postcode', 'p-housenumber', 'p-street', 'p-city'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.required = !venue;
  });
  const radioHome = document.querySelector('input[name="event-type"][value="home"]');
  const radioVenue = document.querySelector('input[name="event-type"][value="venue"]');
  if (radioHome) radioHome.checked = !venue;
  if (radioVenue) radioVenue.checked = venue;
}

const COURSE_ICONS = {
  voorborrel: '🥂',
  voorgerecht: '🥗',
  hoofdgerecht: '🍖',
  nagerecht: '🍰',
  extra1: '🧀',
  extra2: '🍸',
  naborrel: '🎉'
};

function getActiveCourses() {
  const order = ['voorborrel', 'voorgerecht', 'hoofdgerecht', 'nagerecht', 'extra1', 'extra2', 'naborrel'];
  const active = order.filter(c => {
    if (c === 'voorgerecht' || c === 'hoofdgerecht' || c === 'nagerecht') return true;
    return state.config.optionalCourses[c];
  });
  // Volgorde = ingestelde starttijd, zodat een hernoemd borrel-slot vrij in
  // de avond geplaatst kan worden (bv. voorborrel -> "Cheese & Biscuits" ná
  // het dessert). Zonder geldige tijd of bij gelijke tijden geldt de
  // klassieke volgorde.
  const toMinutes = (c) => {
    const t = state.config.times && state.config.times[c] && state.config.times[c].start;
    if (!/^\d{1,2}:\d{2}$/.test(t || '')) return null;
    const parts = t.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  };
  return active
    .map((c, i) => ({ c, i, m: toMinutes(c) }))
    .sort((a, b) => (a.m !== null && b.m !== null && a.m !== b.m) ? a.m - b.m : a.i - b.i)
    .map(x => x.c);
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
  // Optionele slots (borrels + extra gangen): checkbox toont/verbergt de
  // bijbehorende tijdinstelling en werkt de gastheer-voorkeurslijst bij.
  ['voorborrel', 'naborrel', 'extra1', 'extra2'].forEach(course => {
    const cb = document.getElementById('has-' + course);
    if (!cb) return;
    cb.addEventListener('change', () => {
      state.config.optionalCourses[course] = cb.checked;
      const cfg = document.getElementById(course + '-time-config');
      if (cfg) cfg.style.display = cb.checked ? 'flex' : 'none';
      updateHostPreferenceOptions();
    });
  });

  // Sync time inputs to state
  const timeFields = ['voorborrel', 'voorgerecht', 'hoofdgerecht', 'nagerecht', 'extra1', 'extra2', 'naborrel'];
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

