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
  if (n === 4) { renderOverview(); maybeShowRatingPrompt(); }
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

// ---- Step 2: Participants ----
function updateHostPreferenceOptions() {
  const sel = document.getElementById('p-host-preference');
  if (!sel) return;
  const courses = getActiveCourses();
  const cur = sel.value;
  sel.innerHTML = `<option value="">${I18n.t('app.modal.no_preference', 'Geen voorkeur')}</option>`;
  courses.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = COURSE_ICONS[c] + ' ' + getCourseLabel(c);
    sel.appendChild(opt);
  });
  if (cur) sel.value = cur;
}

function buildAvailabilityGrid(participant) {
  const courses = getActiveCourses();
  const grid = document.getElementById('availability-grid');
  grid.innerHTML = '';

  courses.forEach(course => {
    const row = document.createElement('div');
    row.className = 'availability-row';

    const hasPartner = document.getElementById('p-name2') && document.getElementById('p-name2').value.trim();
    const p1avail = participant ? participant.availability[course]?.person1 !== false : true;
    const p2avail = participant ? participant.availability[course]?.person2 !== false : true;

    row.innerHTML = `
      <span class="availability-course-name">${COURSE_ICONS[course]} ${getCourseLabel(course)}</span>
      <div class="availability-checks">
        <label class="availability-check">
          <input type="checkbox" name="avail-${course}-p1" ${p1avail ? 'checked' : ''}> ${I18n.t('app.modal.person1', 'Persoon 1')}
        </label>
        <label class="availability-check" id="avail-partner-${course}">
          <input type="checkbox" name="avail-${course}-p2" ${p2avail ? 'checked' : ''}> ${I18n.t('app.modal.partner', 'Partner')}
        </label>
      </div>`;
    grid.appendChild(row);
  });

  // Hide partner rows if no partner
  togglePartnerAvailability();
}

function togglePartnerAvailability() {
  const name2 = document.getElementById('p-name2');
  const hasPartner = name2 && name2.value.trim();
  const courses = getActiveCourses();
  courses.forEach(course => {
    const el = document.getElementById('avail-partner-' + course);
    if (el) el.style.display = hasPartner ? 'flex' : 'none';
  });
  const diet2 = document.getElementById('diet2-group');
  if (diet2) diet2.style.display = hasPartner ? 'flex' : 'none';
}

function openAddParticipant(id) {
  const modal = document.getElementById('participant-modal');
  const form = document.getElementById('participant-form');
  form.reset();

  let participant = null;
  if (id !== undefined) {
    participant = state.participants.find(p => p.id === id);
    document.getElementById('modal-title').textContent = I18n.t('app.modal.edit_participant', 'Deelnemer bewerken');
    document.getElementById('participant-id').value = id;
    document.getElementById('p-name1').value = participant.name1;
    document.getElementById('p-name2').value = participant.name2 || '';
    document.getElementById('p-street').value = participant.address.street;
    document.getElementById('p-housenumber').value = participant.address.housenumber || '';
    document.getElementById('p-postcode').value = participant.address.postcode;
    document.getElementById('p-city').value = participant.address.city;
    document.getElementById('p-host-preference').value = participant.hostPreference || '';
    document.getElementById('p-diet1').value = participant.diet1 || '';
    document.getElementById('p-diet2').value = participant.diet2 || '';
    document.getElementById('p-prefer-with').value = (participant.preferWith || []).join(', ');
    document.getElementById('p-avoid').value = (participant.avoid || []).join(', ');
  } else {
    document.getElementById('modal-title').textContent = I18n.t('app.modal.add_participant', 'Deelnemer toevoegen');
    document.getElementById('participant-id').value = '';
  }

  updateHostPreferenceOptions();
  buildAvailabilityGrid(participant);

  // Rebuild availability when partner name changes (remove old listener to prevent leak)
  const name2El = document.getElementById('p-name2');
  name2El.removeEventListener('input', togglePartnerAvailability);
  name2El.addEventListener('input', togglePartnerAvailability);

  modal.style.display = 'flex';
  document.getElementById('p-name1').focus();
}

function closeParticipantModal() {
  document.getElementById('participant-modal').style.display = 'none';
}

function saveParticipant(event) {
  event.preventDefault();

  const courses = getActiveCourses();
  const availability = {};
  courses.forEach(course => {
    const p1El = document.querySelector(`input[name="avail-${course}-p1"]`);
    const p2El = document.querySelector(`input[name="avail-${course}-p2"]`);
    availability[course] = {
      person1: p1El ? p1El.checked : true,
      person2: p2El ? p2El.checked : true
    };
  });

  const idVal = document.getElementById('participant-id').value;
  const street = document.getElementById('p-street').value.trim();
  const housenumber = document.getElementById('p-housenumber').value.trim();
  const postcode = document.getElementById('p-postcode').value.trim();
  const city = document.getElementById('p-city').value.trim();

  const data = {
    name1: document.getElementById('p-name1').value.trim(),
    name2: document.getElementById('p-name2').value.trim() || null,
    address: {
      street,
      housenumber,
      postcode,
      city,
      full: `${street} ${housenumber}, ${postcode} ${city}`
    },
    availability,
    hostPreference: document.getElementById('p-host-preference').value || null,
    diet1: document.getElementById('p-diet1').value.trim() || null,
    diet2: document.getElementById('p-diet2').value.trim() || null,
    preferWith: document.getElementById('p-prefer-with').value.split(',').map(s => s.trim()).filter(Boolean),
    avoid: document.getElementById('p-avoid').value.split(',').map(s => s.trim()).filter(Boolean)
  };

  if (idVal) {
    const idx = state.participants.findIndex(p => p.id === parseInt(idVal));
    state.participants[idx] = { ...state.participants[idx], ...data };
  } else {
    data.id = state.nextId++;
    state.participants.push(data);
  }

  closeParticipantModal();
  renderParticipantsList();
  state.planning = null; // invalidate planning
}

function deleteParticipant(id) {
  if (!confirm(I18n.t('app.confirm.delete_participant', 'Deelnemer verwijderen?'))) return;
  state.participants = state.participants.filter(p => p.id !== id);
  renderParticipantsList();
  state.planning = null;
}

function renderParticipantsList() {
  const list = document.getElementById('participants-list');
  const count = document.getElementById('participant-count');
  count.textContent = state.participants.length;

  if (state.participants.length === 0) {
    list.innerHTML = `<p class="empty-state">${I18n.t('app.participants.empty_state', 'Nog geen deelnemers toegevoegd. Klik op "+ Deelnemer toevoegen" om te beginnen.')}</p>`;
    return;
  }

  list.innerHTML = state.participants.map(p => {
    const initials = escapeHtml((p.name1[0] + (p.name2 ? p.name2[0] : '')).toUpperCase());
    const fullName = p.name2 ? `${escapeHtml(p.name1)} &amp; ${escapeHtml(p.name2)}` : escapeHtml(p.name1);
    const tags = [];
    if (p.hostPreference) tags.push(`<span class="tag tag-host">${COURSE_ICONS[p.hostPreference]} ${I18n.t('app.participants.host_label', 'Host')}: ${getCourseLabel(p.hostPreference)}</span>`);
    if (p.diet1) tags.push(`<span class="tag tag-diet">🥦 ${escapeHtml(p.diet1)}${p.diet2 ? ' / ' + escapeHtml(p.diet2) : ''}</span>`);

    const courses = getActiveCourses();
    const unavailable = courses.filter(c => {
      const av = p.availability[c];
      if (!av) return false;
      return !av.person1 || (p.name2 && !av.person2);
    });
    if (unavailable.length) tags.push(`<span class="tag tag-unavailable">⚠ ${I18n.t('app.participants.unavailable', 'Niet')}: ${unavailable.map(c => getCourseLabel(c)).join(', ')}</span>`);

    return `
      <div class="participant-card">
        <div class="participant-avatar">${initials}</div>
        <div class="participant-info">
          <div class="participant-name">${fullName}</div>
          <div class="participant-address">📍 ${escapeHtml(p.address.full)}</div>
          <div class="participant-meta">${tags.join('')}</div>
        </div>
        <div class="participant-actions">
          <button class="btn-secondary btn-small" onclick="openAddParticipant(${p.id})">✏️ ${I18n.t('app.participants.edit_btn', 'Bewerken')}</button>
          <button class="btn-danger btn-small" onclick="deleteParticipant(${p.id})">🗑️</button>
        </div>
      </div>`;
  }).join('');
}

// ---- Forced Combos ----
function addForcedCombo() {
  const id = Date.now();
  state.forcedCombos.push({ id, person1: '', person2: '' });
  renderForcedCombos();
}

function removeForcedCombo(id) {
  state.forcedCombos = state.forcedCombos.filter(fc => fc.id !== id);
  renderForcedCombos();
}

function renderForcedCombos() {
  const list = document.getElementById('forced-combos-list');
  if (state.forcedCombos.length === 0) {
    list.innerHTML = '';
    return;
  }

  const names = state.participants.map(p => p.name2 ? [p.name1, p.name2] : [p.name1]).flat();

  list.innerHTML = state.forcedCombos.map(fc => `
    <div class="forced-combo-item">
      <select onchange="updateForcedCombo(${fc.id}, 'person1', this.value)">
        <option value="">${I18n.t('app.participants.select_person1', 'Selecteer persoon 1...')}</option>
        ${names.map(n => `<option value="${escapeHtml(n)}" ${fc.person1 === n ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}
      </select>
      <span>${I18n.t('app.participants.always_together', 'altijd samen met')}</span>
      <select onchange="updateForcedCombo(${fc.id}, 'person2', this.value)">
        <option value="">${I18n.t('app.participants.select_person2', 'Selecteer persoon 2...')}</option>
        ${names.map(n => `<option value="${escapeHtml(n)}" ${fc.person2 === n ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}
      </select>
      <button class="btn-danger btn-small" onclick="removeForcedCombo(${fc.id})">✕</button>
    </div>`).join('');
}

function updateForcedCombo(id, field, value) {
  const fc = state.forcedCombos.find(f => f.id === id);
  if (fc) fc[field] = value;
}

// ---- Step 3: Planning Algorithm ----

/**
 * Main planning algorithm.
 * For each hosting course, assigns a host and fills their table with guests
 * maximizing unique tablemate encounters across all courses.
 */
function generatePlanning() {
  const courses = getActiveCourses();
  const hostCourses = ['voorgerecht', 'hoofdgerecht', 'nagerecht']; // only these have home hosts
  const participants = state.participants;

  if (participants.length < 3) {
    alert(I18n.t('app.alert.min_participants', 'Voeg minimaal 3 deelnemers toe om een planning te maken.'));
    return;
  }

  const warnings = [];
  const planning = {};

  // Step 1: Determine hosts for each hosting course
  const hostAssignments = assignHosts(participants, hostCourses, warnings);

  // Step 2: For each course, fill tables
  const tableMateHistory = {}; // track who has eaten with whom
  participants.forEach(p => { tableMateHistory[p.id] = new Set(); });

  const allCourses = courses;
  allCourses.forEach(course => {
    if (course === 'voorborrel' || course === 'naborrel') {
      // Everyone gathers at one location (or defined location)
      planning[course] = createSocialCourse(course, participants);
      return;
    }

    const hosts = hostAssignments[course] || [];
    const tables = fillTables(course, hosts, participants, tableMateHistory, warnings);
    planning[course] = tables;

    // Update tablemate history
    tables.forEach(table => {
      const allAtTable = [table.hostId, ...table.guestIds];
      allAtTable.forEach(id1 => {
        allAtTable.forEach(id2 => {
          if (id1 !== id2) tableMateHistory[id1].add(id2);
        });
      });
    });
  });

  // Calculate diversity score
  const avgUnique = calcDiversityScore(tableMateHistory, participants);

  state.planning = { courses: allCourses, tables: planning, warnings, diversityScore: avgUnique };
  state.manualChanges = [];

  renderPlanningResult();
  document.getElementById('btn-regenerate').style.display = 'inline-block';
  document.getElementById('btn-to-overview').style.display = 'inline-block';

  // Track planning + participants count on server (fire & forget)
  fetch('/api/planning-count/increment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ participantCount: participants.length }),
  }).catch(() => {});
}

function regeneratePlanning() {
  // Shuffle participants to get different result
  for (let i = state.participants.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [state.participants[i], state.participants[j]] = [state.participants[j], state.participants[i]];
  }
  generatePlanning();
}

function assignHosts(participants, hostCourses, warnings) {
  const assignments = {};
  const alreadyHost = new Set(); // each participant can only host once

  hostCourses.forEach(course => {
    const available = participants.filter(p => {
      const av = p.availability[course];
      return av && av.person1 && !alreadyHost.has(p.id);
    });

    const preferred = available.filter(p => p.hostPreference === course);
    const others    = available.filter(p => p.hostPreference !== course);

    // Total person-slots attending this course
    const totalSlots = participants
      .filter(p => p.availability[course]?.person1)
      .reduce((sum, p) => sum + (p.name2 && p.availability[course]?.person2 ? 2 : 1), 0);

    // maxTableSize = max GUESTS (not counting host).
    // Each table seats: 1 host-slot + maxGuests guest-slots → maxGuests+1 slots total.
    // So numTables ≈ ceil(totalSlots / (maxGuests + 1)).
    const maxGuests = state.config.maxTableSize;
    const numTables = Math.max(1, Math.ceil(totalSlots / (maxGuests + 1)));

    const pool = [...preferred, ...others];
    const hosts = [];
    for (let i = 0; i < numTables && pool.length > 0; i++) {
      const host = pool.shift();
      hosts.push(host);
      alreadyHost.add(host.id);
    }

    if (hosts.length < numTables) {
      warnings.push(I18n.t('app.warning.not_enough_hosts', 'Te weinig beschikbare gastheren voor') + ` ${getCourseLabel(course)}. ` + I18n.t('app.warning.consider_more_participants', 'Overweeg meer deelnemers toe te voegen.'));
    }

    assignments[course] = hosts;
  });

  return assignments;
}

function fillTables(course, hosts, participants, tableMateHistory, warnings) {
  const pMap = new Map(participants.map(p => [p.id, p]));

  const tables = hosts.map((host, i) => ({
    id: `${course}-${i}`,
    course,
    hostId: host.id,
    hostName: host.name2 ? `${host.name1} & ${host.name2}` : host.name1,
    address: host.address,
    guestIds: [],
    guestNames: []
  }));

  const hostIds = new Set(hosts.map(h => h.id));
  const guests = participants.filter(p => !hostIds.has(p.id) && p.availability[course]?.person1);

  const maxGuests = state.config.maxTableSize; // max GUESTS per table (host not counted)
  const minGuests = state.config.minTableSize;

  // Count occupied guest-seats at a table (couples count as 2, host excluded)
  const guestSeats = (t) => t.guestIds.reduce((sum, gid) => {
    const g = pMap.get(gid);
    return sum + (g?.name2 && g.availability[course]?.person2 ? 2 : 1);
  }, 0);

  // Seats a participant occupies
  const personSeats = (p) => (p.name2 && p.availability[course]?.person2) ? 2 : 1;

  // Sort guests by total unique tablemates seen so far (fewest = most variety to gain)
  const sortedGuests = [...guests].sort((a, b) =>
    (tableMateHistory[a.id]?.size ?? 0) - (tableMateHistory[b.id]?.size ?? 0)
  );

  const forcedGroups = buildForcedGroups(state.forcedCombos, participants);

  sortedGuests.forEach(guest => {
    const forcedTable = findForcedTable(guest.id, forcedGroups, tables, participants);
    let targetTable;

    if (forcedTable !== null) {
      targetTable = forcedTable;
    } else {
      const seats = personSeats(guest);
      // Only consider tables that still have room
      const candidates = tables.filter(t => guestSeats(t) + seats <= maxGuests);

      if (candidates.length === 0) {
        warnings.push(I18n.t('app.warning.table_full', 'Tafel vol bij') + ` ${getCourseLabel(course)}. ` + I18n.t('app.warning.increase_max', 'Vergroot het maximum aantal gasten per tafel of voeg een extra gastheer toe.'));
        // Fallback: least-full table
        targetTable = tables.reduce((a, b) => guestSeats(a) <= guestSeats(b) ? a : b);
      } else {
        // Score: BALANCE is primary (weight 3×), diversity tiebreaker, avoid/prefer adjustments
        const minFill = Math.min(...candidates.map(t => guestSeats(t)));

        targetTable = candidates.reduce((best, t) => {
          const fillT    = (guestSeats(t)    - minFill) * 3;
          const fillBest = (guestSeats(best) - minFill) * 3;
          const overlapT    = countOverlap(guest.id, t,    tableMateHistory);
          const overlapBest = countOverlap(guest.id, best, tableMateHistory);

          const avoidPenalty = (tbl) => (guest.avoid || []).some(name => {
            const p = participants.find(x => x.name1 === name || x.name2 === name);
            return p && (tbl.hostId === p.id || tbl.guestIds.includes(p.id));
          }) ? 100 : 0;
          const preferBonus = (tbl) => (guest.preferWith || []).some(name => {
            const p = participants.find(x => x.name1 === name || x.name2 === name);
            return p && (tbl.hostId === p.id || tbl.guestIds.includes(p.id));
          }) ? -5 : 0;

          const scoreT    = fillT    + overlapT    + avoidPenalty(t)    + preferBonus(t);
          const scoreBest = fillBest + overlapBest + avoidPenalty(best) + preferBonus(best);
          return scoreT <= scoreBest ? t : best;
        }, candidates[0]);
      }
    }

    targetTable.guestIds.push(guest.id);
    targetTable.guestNames.push(guest.name2 ? `${guest.name1} & ${guest.name2}` : guest.name1);
  });

  // Warn on underfilled tables
  tables.forEach(t => {
    const count = guestSeats(t);
    if (count < minGuests) {
      warnings.push(I18n.t('app.warning.table_underfilled_prefix', 'Tafel van') + ` ${t.hostName} ` + I18n.t('app.warning.table_underfilled_at', 'bij') + ` ${getCourseLabel(course)} ` + I18n.t('app.warning.table_underfilled_suffix', 'heeft slechts') + ` ${count} ` + I18n.t('app.warning.guests', 'gast(en)') + ` (${I18n.t('app.warning.guideline_min', 'richtlijn minimum')}: ${minGuests}).`);
    }
  });

  return tables;
}

function countSeats(table, participants) {
  // Counts ALL persons including host (used for display)
  let n = 0;
  const host = participants.find(p => p.id === table.hostId);
  n += host?.name2 ? 2 : 1;
  table.guestIds.forEach(gid => {
    const g = participants.find(p => p.id === gid);
    n += g?.name2 ? 2 : 1;
  });
  return n;
}

function countOverlap(guestId, table, history) {
  let count = 0;
  if (history[guestId]?.has(table.hostId)) count++;
  table.guestIds.forEach(id => { if (history[guestId]?.has(id)) count++; });
  return count;
}

function buildForcedGroups(combos, participants) {
  return combos.map(fc => {
    const p1 = participants.find(p => p.name1 === fc.person1 || p.name2 === fc.person1);
    const p2 = participants.find(p => p.name1 === fc.person2 || p.name2 === fc.person2);
    if (p1 && p2) return [p1.id, p2.id];
    return null;
  }).filter(Boolean);
}

function findForcedTable(guestId, forcedGroups, tables, participants) {
  // Find if this guest has a forced partner already placed somewhere
  for (const group of forcedGroups) {
    if (!group.includes(guestId)) continue;
    const partner = group.find(id => id !== guestId);
    // Find if partner is already at a table
    for (const table of tables) {
      if (table.hostId === partner || table.guestIds.includes(partner)) return table;
    }
  }
  return null;
}

function createSocialCourse(course, participants) {
  const hostConfig = state.socialHosts[course];
  let hostId = null, hostName = null, address = null;

  if (hostConfig?.participantId) {
    const host = participants.find(p => p.id === hostConfig.participantId);
    if (host) {
      hostId = host.id;
      hostName = host.name2 ? `${host.name1} & ${host.name2}` : host.name1;
      address = host.address;
    }
  } else if (hostConfig?.customName) {
    hostName = hostConfig.customName;
    address = hostConfig.customAddress;
  }

  return [{
    id: course + '-0',
    course,
    hostId,
    hostName,
    address,
    isSocial: true,
    guestIds: participants.map(p => p.id),
    guestNames: participants.map(p => p.name2 ? `${p.name1} & ${p.name2}` : p.name1)
  }];
}

function calcDiversityScore(history, participants) {
  if (participants.length === 0) return 0;
  const total = participants.reduce((sum, p) => sum + history[p.id].size, 0);
  return Math.round(total / participants.length);
}

function renderPlanningResult() {
  const { tables, warnings, diversityScore } = state.planning;
  const courses = state.planning.courses;
  const participants = state.participants;

  // Stats
  const statsEl = document.getElementById('planning-stats');
  statsEl.style.display = 'flex';
  statsEl.innerHTML = `
    <div class="stat-box"><div class="stat-number">${participants.length}</div><div class="stat-label">${I18n.t('app.stats.participants', 'Deelnemers')}</div></div>
    <div class="stat-box"><div class="stat-number">${participants.filter(p => p.name2).length}</div><div class="stat-label">${I18n.t('app.stats.couples', 'Koppels')}</div></div>
    <div class="stat-box"><div class="stat-number">${diversityScore}</div><div class="stat-label">${I18n.t('app.stats.avg_new_tablemates', 'Gem. nieuwe tafelgenoten')}</div></div>
    <div class="stat-box"><div class="stat-number">${courses.length}</div><div class="stat-label">${I18n.t('app.stats.courses', 'Gangen')}</div></div>`;

  // Warnings
  const warnEl = document.getElementById('planning-warnings');
  if (warnings.length) {
    warnEl.style.display = 'block';
    warnEl.innerHTML = `<h4>⚠️ ${I18n.t('app.planning.attention_points', 'Aandachtspunten')}</h4><ul>${warnings.map(w => `<li>${w}</li>`).join('')}</ul>`;
  } else {
    warnEl.style.display = 'none';
  }

  renderDraggablePlanning();
  renderChangeLog();
  document.getElementById('planning-result').style.display = 'block';
}

// ---- Drag-and-drop planning ----
let _dragData = null;

function renderDraggablePlanning() {
  const { courses, tables } = state.planning;
  const participants = state.participants;
  const overview = document.getElementById('courses-overview');

  overview.innerHTML = courses.map(course => {
    const courseTables = tables[course] || [];
    const timeInfo = state.config.times[course];
    const endTime = addMinutes(timeInfo.start, timeInfo.duration);
    return `
      <div class="course-block">
        <div class="course-block-header">
          <span>${COURSE_ICONS[course]}</span>
          <h4>${getCourseLabel(course)}</h4>
          <span class="course-block-time">${timeInfo.start} – ${endTime}</span>
        </div>
        <div class="tables-grid">
          ${courseTables.map((table, i) => renderDraggableTableCard(table, i, participants, course)).join('')}
        </div>
      </div>`;
  }).join('');
}

function renderDraggableTableCard(table, i, participants, course) {
  if (table.isSocial) {
    return `
      <div class="table-card">
        <div class="table-card-header">${I18n.t('app.planning.everyone_together', 'Iedereen bijeen')} <span>👥 ${table.guestIds.length}</span></div>
        <div class="table-card-body">
          ${table.guestNames.map(n => `<div class="table-guest">👤 ${escapeHtml(n)}</div>`).join('')}
        </div>
      </div>`;
  }

  const host = participants.find(p => p.id === table.hostId);
  const hostDiet = [host?.diet1, host?.diet2].filter(Boolean).join(', ');
  const seats = countSeats(table, participants);
  const addr = table.address
    ? `${escapeHtml(table.address.street)} ${escapeHtml(table.address.housenumber || '')}, ${escapeHtml(table.address.postcode)} ${escapeHtml(table.address.city)}`
    : '';

  return `
    <div class="table-card dnd-table" id="dnd-${table.id}"
         ondragover="onDragOver(event)"
         ondragleave="onDragLeave(event)"
         ondrop="onDrop(event,'${table.id}','${course}')">
      <div class="table-card-header">
        ${I18n.t('app.planning.table', 'Tafel')} ${i + 1} – ${escapeHtml(table.address?.city || '')}
        <span>🪑 ${seats}</span>
      </div>
      <div class="table-card-body">
        <div class="table-host">
          <span class="host-badge">HOST</span>
          <strong>${escapeHtml(table.hostName)}</strong>
          ${hostDiet ? `<span class="diet-icon" title="${escapeHtml(hostDiet)}">🥦</span>` : ''}
        </div>
        ${table.guestIds.map((gid, gi) => {
          const g = participants.find(p => p.id === gid);
          const diet = [g?.diet1, g?.diet2].filter(Boolean).join(', ');
          return `
            <div class="table-guest guest-chip"
                 draggable="true"
                 ondragstart="onDragStart(event,${gid},'${table.id}','${course}')"
                 ondragend="onDragEnd(event)">
              <span class="drag-handle" title="${I18n.t('app.planning.drag_to_move', 'Sleep om te verplaatsen')}">⠿</span>
              👤 ${escapeHtml(table.guestNames[gi])}
              ${diet ? `<span class="diet-icon" title="${escapeHtml(diet)}">🥦</span>` : ''}
            </div>`;
        }).join('')}
        ${table.guestIds.length === 0
          ? `<div class="dnd-empty-slot">${I18n.t('app.planning.drag_guest_here', 'Sleep een gast hierheen')}</div>` : ''}
        ${addr ? `<div class="dnd-addr">📍 ${addr}</div>` : ''}
      </div>
    </div>`;
}

function onDragStart(event, personId, fromTableId, course) {
  _dragData = { personId, fromTableId, course };
  event.dataTransfer.effectAllowed = 'move';
  setTimeout(() => event.target.classList.add('dragging'), 0);
}

function onDragEnd(event) {
  event.target.classList.remove('dragging');
}

function onDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  event.currentTarget.classList.add('drag-over');
}

function onDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) {
    event.currentTarget.classList.remove('drag-over');
  }
}

function onDrop(event, targetTableId, targetCourse) {
  event.preventDefault();
  event.currentTarget.classList.remove('drag-over');
  if (!_dragData) return;

  const { personId, fromTableId, course } = _dragData;
  _dragData = null;

  if (fromTableId === targetTableId) return;
  if (course !== targetCourse) {
    alert(I18n.t('app.alert.same_course_only', 'Gasten kunnen alleen worden verplaatst binnen dezelfde gang.'));
    return;
  }

  const tables = state.planning.tables[course];
  const fromTable = tables.find(t => t.id === fromTableId);
  const toTable   = tables.find(t => t.id === targetTableId);
  if (!fromTable || !toTable) return;

  const idx = fromTable.guestIds.indexOf(personId);
  if (idx === -1) return; // was a host, skip

  const personName = fromTable.guestNames[idx];
  fromTable.guestIds.splice(idx, 1);
  fromTable.guestNames.splice(idx, 1);
  toTable.guestIds.push(personId);
  toTable.guestNames.push(personName);

  state.manualChanges.push({
    id: Date.now(),
    course, personId, personName,
    fromTableId, fromHostName: fromTable.hostName,
    toTableId: targetTableId, toHostName: toTable.hostName
  });

  renderDraggablePlanning();
  renderChangeLog();
}

function undoChange(changeId) {
  const idx = state.manualChanges.findIndex(c => c.id === changeId);
  if (idx === -1) return;
  const { course, personId, personName, fromTableId, toTableId } = state.manualChanges[idx];

  const tables = state.planning.tables[course];
  const currentTable  = tables.find(t => t.id === toTableId);
  const originalTable = tables.find(t => t.id === fromTableId);
  if (!currentTable || !originalTable) return;

  const pidx = currentTable.guestIds.indexOf(personId);
  if (pidx === -1) return;
  currentTable.guestIds.splice(pidx, 1);
  currentTable.guestNames.splice(pidx, 1);
  originalTable.guestIds.push(personId);
  originalTable.guestNames.push(personName);

  state.manualChanges.splice(idx, 1);
  renderDraggablePlanning();
  renderChangeLog();
}

function undoAllChanges() {
  if (!confirm(I18n.t('app.confirm.undo_all', 'Alle handmatige wijzigingen ongedaan maken?'))) return;
  // Undo in reverse order so earlier moves are reversed correctly
  while (state.manualChanges.length > 0) {
    const last = state.manualChanges[state.manualChanges.length - 1];
    undoChange(last.id);
  }
}

function renderChangeLog() {
  const el = document.getElementById('manual-adjustment-area');
  if (!el) return;
  if (state.manualChanges.length === 0) {
    el.innerHTML = `<p class="hint">${I18n.t('app.planning.no_changes', 'Nog geen handmatige wijzigingen. Sleep gasten (⠿) tussen tafels om te wisselen.')}</p>`;
    return;
  }
  el.innerHTML = `
    <div class="change-log">
      <div class="change-log-header">
        <span>${state.manualChanges.length} ${I18n.t('app.planning.changes', 'wijziging(en)')}</span>
        <button class="btn-danger btn-small" onclick="undoAllChanges()">↩ ${I18n.t('app.planning.undo_all', 'Alle ongedaan maken')}</button>
      </div>
      ${state.manualChanges.map((c, i) => `
        <div class="change-item">
          <div class="change-info">
            <span class="change-num">${i + 1}</span>
            <div class="change-desc">
              <strong>${escapeHtml(c.personName)}</strong> ${I18n.t('app.planning.moved_from', 'verplaatst van')}
              <em>${escapeHtml(c.fromHostName)}</em> → <em>${escapeHtml(c.toHostName)}</em>
              <span class="change-course">${COURSE_ICONS[c.course]} ${getCourseLabel(c.course)}</span>
            </div>
          </div>
          <button class="btn-secondary btn-small" onclick="undoChange(${c.id})">↩ ${I18n.t('app.planning.undo', 'Ongedaan')}</button>
        </div>`).join('')}
    </div>`;
}

// ---- Distance check (geographic) ----
function _addrToString(addr) {
  if (!addr) return '';
  const parts = [
    addr.street,
    addr.housenumber,
    addr.postcode,
    addr.city,
  ].filter(Boolean);
  return parts.join(' ').trim();
}

async function checkDistances() {
  if (!state.planning) {
    alert(I18n.t('app.alert.generate_first', 'Genereer eerst een planning in stap 3.'));
    return;
  }

  const courses = state.planning.courses;
  const tablesByCourse = state.planning.tables;

  // Verzamel host-info per gang. Sociale gangen hebben geen host-tafels en
  // worden overgeslagen — daar reist iedereen samen naar één locatie.
  const hostsByCourse = {};
  for (const course of courses) {
    const tbls = tablesByCourse[course] || [];
    hostsByCourse[course] = tbls
      .filter(t => !t.isSocial && t.address)
      .map(t => ({ hostName: t.hostName || '', address: _addrToString(t.address) }))
      .filter(h => h.address);
  }

  // Genereer alle unieke (host-A, host-B) paren tussen opeenvolgende gangen
  // — dat zijn de echte routes die deelnemers afleggen.
  const pairs = [];
  const pairKeys = new Set();
  for (let i = 0; i < courses.length - 1; i++) {
    const c1 = courses[i], c2 = courses[i + 1];
    for (const a of (hostsByCourse[c1] || [])) {
      for (const b of (hostsByCourse[c2] || [])) {
        if (a.address === b.address) continue; // zelfde host = 0m, skippen
        const key = `${a.address}||${b.address}`;
        if (pairKeys.has(key)) continue;
        pairKeys.add(key);
        pairs.push({
          fromCourse: c1, fromName: a.hostName, from: a.address,
          toCourse:   c2, toName:   b.hostName, to:   b.address,
        });
      }
    }
  }

  const btn = document.getElementById('btn-check-distances');
  const resultsEl = document.getElementById('distance-results');

  if (pairs.length === 0) {
    resultsEl.style.display = 'block';
    resultsEl.innerHTML = `<p class="hint">${I18n.t('app.distance.none', 'Geen routes om te checken (geen hostende gangen of geen adressen ingevuld).')}</p>`;
    return;
  }

  btn.disabled = true;
  const oldLabel = btn.textContent;
  btn.textContent = '⏳ ' + I18n.t('app.distance.loading', 'Bezig met checken...');
  resultsEl.style.display = 'block';
  resultsEl.innerHTML = `<p class="hint">${I18n.t('app.distance.in_progress', 'Adressen worden geocodeerd via OpenStreetMap. Eerste keer kan dit ~30 sec duren.')}</p>`;

  try {
    const apiPairs = pairs.map(p => ({ from: p.from, to: p.to }));
    const resp = await fetch('/api/distance-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairs:   apiPairs,
        profile: state.config.transportMode || 'walking',
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'request failed');
    const enriched = pairs.map((p, idx) => ({ ...p, ...(data.pairs[idx] || {}) }));
    renderDistanceResults(enriched);
  } catch (err) {
    resultsEl.innerHTML = `<p style="color:#c62828">${I18n.t('app.distance.error', 'Fout bij afstand-check')}: ${escapeHtml(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = oldLabel;
  }
}

function renderDistanceResults(enriched) {
  const resultsEl = document.getElementById('distance-results');
  const maxKm = state.config.maxDistanceKm || 3;
  const maxM = maxKm * 1000;

  let warnCount = 0, errCount = 0;

  // Sorteer op afstand desc — problemen bovenaan
  enriched.sort((a, b) => (b.distanceMeters || 0) - (a.distanceMeters || 0));

  const rows = enriched.map(r => {
    if (r.error) {
      errCount++;
      return `<tr class="dist-error"><td>${escapeHtml(r.fromName || '?')} → ${escapeHtml(r.toName || '?')}</td><td>${getCourseLabel(r.fromCourse)} → ${getCourseLabel(r.toCourse)}</td><td colspan="2">⚠️ ${escapeHtml(r.error)}</td></tr>`;
    }
    const km = (r.distanceMeters / 1000).toFixed(1);
    const min = Math.max(1, Math.round(r.durationSeconds / 60));
    let icon = '🟢';
    if (r.distanceMeters > maxM) { icon = '🔴'; warnCount++; }
    else if (r.distanceMeters > maxM * 0.7) { icon = '🟡'; }
    return `<tr><td>${icon} ${escapeHtml(r.fromName || '?')} → ${escapeHtml(r.toName || '?')}</td><td>${getCourseLabel(r.fromCourse)} → ${getCourseLabel(r.toCourse)}</td><td>${km} km</td><td>${min} min</td></tr>`;
  });

  let summary = '';
  if (warnCount > 0) {
    summary = `<p style="color:#c62828;font-weight:600">⚠️ ${warnCount} ${I18n.t('app.distance.routes_too_long', 'route(s) overschrijden de drempel van')} ${maxKm} km</p>`;
  } else if (errCount > 0) {
    summary = `<p style="color:#92400e;font-weight:600">${errCount} ${I18n.t('app.distance.geocode_errors', 'adressen konden niet worden gevonden — controleer of straat/plaats correct ingevuld zijn')}</p>
      <p class="hint" style="margin:4px 0 0;color:#64748b;font-size:.82rem">${I18n.t('app.distance.threshold_hint', 'Drempel ingesteld op')} ${maxKm} km · ${I18n.t('app.distance.threshold_change_hint', 'aan te passen in stap 1 → Routes en afstanden')}</p>`;
  } else {
    summary = `<p style="color:#15803d;font-weight:600">✅ ${I18n.t('app.distance.all_ok', 'Alle routes binnen drempel')} (${maxKm} km)</p>`;
  }

  resultsEl.innerHTML = `
    ${summary}
    <table class="distance-table" style="width:100%;border-collapse:collapse;font-size:0.9rem;margin-top:8px">
      <thead>
        <tr style="background:#f8fafc;text-align:left">
          <th style="padding:8px;border-bottom:1px solid #e2e8f0">${I18n.t('app.distance.col_route', 'Route')}</th>
          <th style="padding:8px;border-bottom:1px solid #e2e8f0">${I18n.t('app.distance.col_courses', 'Gangen')}</th>
          <th style="padding:8px;border-bottom:1px solid #e2e8f0">${I18n.t('app.distance.col_distance', 'Afstand')}</th>
          <th style="padding:8px;border-bottom:1px solid #e2e8f0">${I18n.t('app.distance.col_duration', 'Tijd')}</th>
        </tr>
      </thead>
      <tbody>${rows.join('')}</tbody>
    </table>
    <p class="hint" style="margin-top:8px;font-size:0.78rem">${I18n.t('app.distance.legend', '🟢 binnen 70% van drempel · 🟡 dichtbij drempel · 🔴 overschrijdt drempel')}</p>
  `;
}

// ---- Step 4: Overview ----
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab-btn[onclick="switchTab('${name}')"]`).classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}

function renderOverview() {
  if (!state.planning) {
    document.getElementById('per-person-content').innerHTML = `<p class="hint">${I18n.t('app.overview.no_planning', 'Ga eerst naar stap 3 en genereer een planning.')}</p>`;
    return;
  }

  renderPerPerson();
  renderPerLocation();
  renderEnvelopes();
}

function getPersonRoute(participant) {
  const { courses, tables } = state.planning;
  const route = [];
  const participants = state.participants;

  courses.forEach(course => {
    const courseTables = tables[course] || [];
    const table = courseTables.find(t =>
      t.hostId === participant.id || t.guestIds.includes(participant.id)
    );
    if (!table) return;

    const timeInfo = state.config.times[course];
    const endTime = addMinutes(timeInfo.start, timeInfo.duration);
    const isHost = table.hostId === participant.id;

    let companions = [];
    if (!table.isSocial) {
      const allIds = [table.hostId, ...table.guestIds].filter(id => id !== participant.id);
      companions = allIds.map(id => {
        const p = participants.find(x => x.id === id);
        return p ? (p.name2 ? `${p.name1} & ${p.name2}` : p.name1) : '';
      }).filter(Boolean);
    }

    route.push({
      course,
      time: timeInfo.start,
      endTime,
      isHost,
      address: table.isSocial ? null : table.address,
      hostName: table.isSocial ? null : (isHost ? I18n.t('app.overview.yourself', 'u zelf') : table.hostName),
      companions,
      isSocial: table.isSocial
    });
  });

  return route;
}

function renderPerPerson() {
  const el = document.getElementById('per-person-content');
  const participants = state.participants;

  el.innerHTML = participants.map(p => {
    const fullName = p.name2 ? `${escapeHtml(p.name1)} &amp; ${escapeHtml(p.name2)}` : escapeHtml(p.name1);
    const route = getPersonRoute(p);

    return `
      <div class="person-schedule-card">
        <div class="person-schedule-header">
          <h3>📋 ${fullName}</h3>
          <p>📍 ${escapeHtml(p.address.full)}${p.diet1 ? ` · 🥦 ${escapeHtml(p.diet1)}${p.diet2 ? ' / ' + escapeHtml(p.diet2) : ''}` : ''}</p>
        </div>
        <div class="schedule-route">
          ${route.map(r => `
            <div class="route-item">
              <div class="route-time">${r.time}</div>
              <div class="route-icon">${COURSE_ICONS[r.course]}</div>
              <div class="route-detail">
                <div class="route-course">
                  ${getCourseLabel(r.course)}
                  ${r.isHost ? `<span class="hosting-badge">🏠 ${I18n.t('app.overview.you_are_host', 'U bent gastheer/vrouw')}</span>` : ''}
                </div>
                ${r.isSocial ? `<div class="route-address">${I18n.t('app.planning.everyone_together', 'Iedereen bijeen')}</div>` : `
                  <div class="route-address">📍 ${escapeHtml(r.address?.street)}, ${escapeHtml(r.address?.postcode)} ${escapeHtml(r.address?.city)}</div>
                  ${!r.isHost ? `<div class="route-companions">${I18n.t('app.overview.host', 'Gastheer/vrouw')}: <span>${escapeHtml(r.hostName)}</span></div>` : ''}
                  <div class="route-companions">${I18n.t('app.overview.tablemates', 'Tafelgenoten')}: <span>${r.companions.length ? r.companions.map(c => escapeHtml(c)).join(', ') : '–'}</span></div>
                `}
              </div>
            </div>`).join('')}
        </div>
      </div>`;
  }).join('');
}

function renderPerLocation() {
  const el = document.getElementById('per-location-content');
  const { courses, tables } = state.planning;
  const participants = state.participants;

  const locationSections = [];

  courses.forEach(course => {
    const courseTables = tables[course] || [];

    courseTables.forEach((table, i) => {
      if (table.isSocial) {
        locationSections.push(`
          <div class="location-card">
            <div class="location-header">
              <h3>${COURSE_ICONS[course]} ${getCourseLabel(course)} – ${I18n.t('app.overview.social_moment', 'Sociaal moment')}</h3>
              <p>${I18n.t('app.overview.all_together', 'Alle deelnemers bijeen')} • ${state.config.times[course].start} – ${addMinutes(state.config.times[course].start, state.config.times[course].duration)}</p>
            </div>
            <div class="location-body">
              <table class="guests-table">
                <thead><tr><th>${I18n.t('app.overview.name', 'Naam')}</th><th>${I18n.t('app.overview.dietary', 'Dieetwensen')}</th></tr></thead>
                <tbody>${table.guestIds.map(gid => {
                  const g = participants.find(p => p.id === gid);
                  const diet = [g?.diet1, g?.diet2].filter(Boolean).join(', ');
                  return `<tr><td>${g?.name2 ? escapeHtml(g.name1) + ' &amp; ' + escapeHtml(g.name2) : escapeHtml(g?.name1)}</td><td>${escapeHtml(diet) || '–'}</td></tr>`;
                }).join('')}</tbody>
              </table>
            </div>
          </div>`);
        return;
      }

      const host = participants.find(p => p.id === table.hostId);
      if (!host) return;
      const timeStr = `${state.config.times[course].start} – ${addMinutes(state.config.times[course].start, state.config.times[course].duration)}`;

      locationSections.push(`
        <div class="location-card">
          <div class="location-header">
            <h3>${COURSE_ICONS[course]} ${getCourseLabel(course)} – ${I18n.t('app.planning.table', 'Tafel')} ${i + 1}</h3>
            <p>🏠 ${escapeHtml(table.hostName)} · 📍 ${escapeHtml(host.address.full)} · ⏰ ${timeStr}</p>
          </div>
          <div class="location-body">
            <table class="guests-table">
              <thead><tr><th>${I18n.t('app.overview.name', 'Naam')}</th><th>${I18n.t('app.overview.role', 'Rol')}</th><th>${I18n.t('app.overview.dietary', 'Dieetwensen')}</th></tr></thead>
              <tbody>
                <tr style="background:#fff8f8">
                  <td><strong>${escapeHtml(table.hostName)}</strong></td>
                  <td><span class="host-badge" style="font-size:0.75rem;background:var(--primary);color:white;padding:2px 6px;border-radius:8px">${I18n.t('app.overview.host', 'Gastheer/vrouw')}</span></td>
                  <td>${escapeHtml([host.diet1, host.diet2].filter(Boolean).join(', ')) || '–'}</td>
                </tr>
                ${table.guestIds.map((gid, gi) => {
                  const g = participants.find(p => p.id === gid);
                  const diet = [g?.diet1, g?.diet2].filter(Boolean).join(', ');
                  return `<tr><td>${escapeHtml(table.guestNames[gi])}</td><td>${I18n.t('app.overview.guest', 'Gast')}</td><td>${escapeHtml(diet) || '–'}</td></tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>`);
    });
  });

  el.innerHTML = locationSections.join('');
}

function renderEnvelopes() {
  const el = document.getElementById('envelope-content');
  const { courses, tables } = state.planning;
  const participants = state.participants;

  // Only courses that have a physical table AND a next destination
  const hostingCourses = courses.filter(c => c !== 'voorborrel' && c !== 'naborrel');
  // Courses for which we print cards = all hosting courses except the very last
  // (if the last hosting course is followed by a social, we still need cards)
  const cardCourses = hostingCourses.filter((c, i) => {
    const globalIdx = courses.indexOf(c);
    return globalIdx < courses.length - 1; // there is a next course
  });

  if (cardCourses.length === 0) {
    el.innerHTML = `<p class="hint">${I18n.t('app.envelope.no_cards', 'Geen envelop-kaartjes beschikbaar voor de huidige planning.')}</p>`;
    return;
  }

  function addrStr(address) {
    if (!address) return I18n.t('app.envelope.location_unknown', 'Locatie onbekend');
    return `${escapeHtml(address.street)}${address.housenumber ? ' ' + escapeHtml(address.housenumber) : ''}, ${escapeHtml(address.postcode)} ${escapeHtml(address.city)}`;
  }

  el.innerHTML = cardCourses.map(course => {
    const globalIdx = courses.indexOf(course);
    const nextCourse = courses[globalIdx + 1];
    const courseTables = (tables[course] || []).filter(t => !t.isSocial);
    const nextCourseTables = tables[nextCourse] || [];
    const nextIsSocial = nextCourseTables[0]?.isSocial || false;

    return `
      <div class="env-course-section">
        <div class="env-course-section-title">
          ${COURSE_ICONS[course]} ${getCourseLabel(course)}
          <span class="env-next-arrow">→ ${I18n.t('app.envelope.next', 'volgende')}: ${COURSE_ICONS[nextCourse]} ${getCourseLabel(nextCourse)}</span>
        </div>
        ${courseTables.map(table => {
          const tableAddr = addrStr(table.address);
          const allIds = [table.hostId, ...table.guestIds].filter(Boolean);

          return `
            <div class="env-table-group">
              <div class="env-table-location">📍 ${I18n.t('app.envelope.table_at', 'Tafel bij')}: ${escapeHtml(table.hostName) || tableAddr} &nbsp;—&nbsp; ${tableAddr}</div>
              <div class="env-cards-row">
                ${allIds.map(pid => {
                  const person = participants.find(p => p.id === pid);
                  if (!person) return '';
                  const personName = person.name2 ? `${escapeHtml(person.name1)} &amp; ${escapeHtml(person.name2)}` : escapeHtml(person.name1);

                  let nextHostName = '', nextAddr = '', nextIsHost = false;
                  if (nextIsSocial) {
                    const social = nextCourseTables[0];
                    nextHostName = escapeHtml(social?.hostName || '');
                    nextAddr = social?.address ? addrStr(social.address) : '';
                  } else {
                    const nextTable = nextCourseTables.find(t => t.hostId === pid || t.guestIds.includes(pid));
                    if (nextTable) {
                      nextIsHost = nextTable.hostId === pid;
                      nextHostName = nextIsHost ? '' : escapeHtml(nextTable.hostName || '');
                      nextAddr = addrStr(nextTable.address);
                    }
                  }

                  return `
                    <div class="env-card-new">
                      <div class="env-card-top">
                        <div class="env-card-event">${escapeHtml(state.config.eventName)}</div>
                        <div class="env-card-person">${personName}</div>
                        <div class="env-card-current-course">${COURSE_ICONS[course]} ${getCourseLabel(course)} — ${I18n.t('app.envelope.open_at_end', 'open aan het einde van dit gerecht')}</div>
                      </div>
                      <div class="env-card-divider">✦ ${I18n.t('app.envelope.your_next_destination', 'Jouw volgende bestemming')} ✦</div>
                      <div class="env-card-bottom">
                        <div class="env-card-next-course">${COURSE_ICONS[nextCourse]} ${getCourseLabel(nextCourse)}</div>
                        ${nextIsSocial
                          ? `<div class="env-card-next-host">${I18n.t('app.planning.everyone_together', 'Iedereen bijeen')}</div>
                             ${nextAddr ? `<div class="env-card-next-addr">📍 ${nextAddr}</div>` : ''}`
                          : nextIsHost
                            ? `<div class="env-card-next-host hosting">🏠 ${I18n.t('app.overview.you_are_host', 'U bent gastheer/vrouw')}</div>
                               <div class="env-card-next-addr">📍 ${nextAddr}</div>`
                            : `<div class="env-card-next-host">${I18n.t('app.envelope.at', 'Bij')}: ${nextHostName}</div>
                               <div class="env-card-next-addr">📍 ${nextAddr}</div>`
                        }
                      </div>
                    </div>`;
                }).join('')}
              </div>
            </div>`;
        }).join('')}
      </div>`;
  }).join('');
}

// ---- Print ----
function printWithStyle(css) {
  const style = document.createElement('style');
  style.id = 'print-filter';
  style.textContent = css;
  document.head.appendChild(style);
  const cleanup = () => { style.remove(); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  window.print();
}

function printSection(section) {
  if (window.RDA_DEMO?.isActive?.()) { window.RDA_DEMO.showPaywall('paywall_print'); return; }
  printWithStyle(`
    @media print {
      #tab-per-person, #tab-per-location, #tab-envelope { display: none !important; }
      #tab-${section} { display: block !important; }
    }`);
}

function printSingleEnvelopes() {
  if (window.RDA_DEMO?.isActive?.()) { window.RDA_DEMO.showPaywall('paywall_print'); return; }
  printWithStyle(`
    @media print {
      #tab-per-person, #tab-per-location { display: none !important; }
      #tab-envelope { display: block !important; }
      .env-course-section { page-break-after: always; }
      .env-card-new { border: 2px dashed #ccc !important; }
    }`);
}

// ---- Utilities ----
function addMinutes(timeStr, minutes) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const nh = Math.floor(total / 60) % 24;
  const nm = total % 60;
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
}

// ---- Postcode Lookup ----
let postcodeTimer = null;

function autoLookupPostcode() {
  const pc = document.getElementById('p-postcode').value.replace(/\s/g, '');
  const nr = document.getElementById('p-housenumber').value.trim();
  if (pc.length >= 6 && nr) lookupPostcode();
}

async function lookupPostcode() {
  const pc = document.getElementById('p-postcode').value.replace(/\s/g, '').toUpperCase();
  const nr = document.getElementById('p-housenumber').value.trim();
  if (!pc || !nr) return;

  const btn = document.getElementById('btn-postcode-lookup');
  const status = document.getElementById('postcode-status');
  btn.disabled = true;
  btn.textContent = '⏳';
  if (status) { status.className = 'postcode-status loading'; status.textContent = I18n.t('app.postcode.loading', 'Ophalen…'); }

  try {
    const url = `https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?q=${encodeURIComponent(pc)}+${encodeURIComponent(nr)}&fq=type:adres&fl=straatnaam,woonplaatsnaam&rows=1`;
    const res = await fetch(url);
    const data = await res.json();
    const doc = data?.response?.docs?.[0];
    if (doc?.straatnaam) {
      document.getElementById('p-street').value = doc.straatnaam;
      document.getElementById('p-city').value = doc.woonplaatsnaam || '';
      if (status) { status.className = 'postcode-status ok'; status.textContent = I18n.t('app.postcode.found', '✓ Adres gevonden'); }
    } else {
      if (status) { status.className = 'postcode-status err'; status.textContent = I18n.t('app.postcode.not_found', 'Adres niet gevonden. Vul handmatig in.'); }
    }
  } catch {
    if (status) { status.className = 'postcode-status err'; status.textContent = I18n.t('app.postcode.failed', 'Ophalen mislukt. Vul handmatig in.'); }
  }

  btn.disabled = false;
  btn.textContent = I18n.t('app.modal.lookup_btn', '🔍 Opzoeken');
}

// ---- Social Location Config (Step 3) ----
function renderSocialLocationConfig() {
  const activeSocial = ['voorborrel', 'naborrel'].filter(c => state.config.optionalCourses[c]);
  const card = document.getElementById('social-locations-card');

  if (activeSocial.length === 0) {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';

  const body = document.getElementById('social-locations-body');
  body.innerHTML = activeSocial.map(course => {
    const current = state.socialHosts[course];
    const isCustom = current?.customName !== undefined;
    const selectedId = current?.participantId || '';

    const participantOptions = state.participants.map(p =>
      `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${p.name2 ? escapeHtml(p.name1) + ' &amp; ' + escapeHtml(p.name2) : escapeHtml(p.name1)} – ${escapeHtml(p.address.street)} ${escapeHtml(p.address.housenumber || '')}</option>`
    ).join('');

    return `
      <div class="social-location-row">
        <div class="social-location-label">${COURSE_ICONS[course]} ${getCourseLabel(course)}</div>
        <div class="social-location-fields">
          <select onchange="onSocialHostTypeChange('${course}', this.value)">
            <option value="">– ${I18n.t('app.social.unknown_location', 'Locatie onbekend / later invullen')} –</option>
            <option value="participant" ${!isCustom && selectedId ? 'selected' : ''}>${I18n.t('app.social.participant_host', 'Deelnemer als gastheer')}</option>
            <option value="custom" ${isCustom ? 'selected' : ''}>${I18n.t('app.social.custom_address', 'Aangepast adres')}</option>
          </select>
          <select id="social-participant-${course}" style="display:${!isCustom && selectedId ? 'block' : 'none'}"
            onchange="onSocialParticipantChange('${course}', this.value)">
            <option value="">${I18n.t('app.social.select_participant', 'Selecteer deelnemer…')}</option>
            ${participantOptions}
          </select>
          <div class="social-location-addr ${isCustom ? 'visible' : ''}" id="social-custom-${course}">
            <input type="text" placeholder="${I18n.t('app.social.name_desc', 'Naam / omschrijving')}" value="${current?.customName || ''}"
              oninput="onSocialCustomChange('${course}', 'customName', this.value)">
            <input type="text" placeholder="${I18n.t('app.social.street_nr', 'Straat + nr')}" value="${current?.customAddress?.street || ''}"
              oninput="onSocialCustomChange('${course}', 'street', this.value)">
            <input type="text" placeholder="${I18n.t('app.social.postcode', 'Postcode')}" value="${current?.customAddress?.postcode || ''}"
              oninput="onSocialCustomChange('${course}', 'postcode', this.value)" style="max-width:90px">
            <input type="text" placeholder="${I18n.t('app.social.city', 'Woonplaats')}" value="${current?.customAddress?.city || ''}"
              oninput="onSocialCustomChange('${course}', 'city', this.value)">
          </div>
        </div>
      </div>`;
  }).join('');
}

function onSocialHostTypeChange(course, type) {
  const participantSel = document.getElementById(`social-participant-${course}`);
  const customDiv = document.getElementById(`social-custom-${course}`);
  if (type === 'participant') {
    participantSel.style.display = 'block';
    customDiv.classList.remove('visible');
    state.socialHosts[course] = { participantId: parseInt(participantSel.value) || null };
  } else if (type === 'custom') {
    participantSel.style.display = 'none';
    customDiv.classList.add('visible');
    state.socialHosts[course] = { customName: '', customAddress: { street: '', postcode: '', city: '', full: '' } };
  } else {
    participantSel.style.display = 'none';
    customDiv.classList.remove('visible');
    state.socialHosts[course] = null;
  }
}

function onSocialParticipantChange(course, value) {
  state.socialHosts[course] = { participantId: parseInt(value) || null };
}

function onSocialCustomChange(course, field, value) {
  if (!state.socialHosts[course]) state.socialHosts[course] = { customName: '', customAddress: {} };
  if (field === 'customName') {
    state.socialHosts[course].customName = value;
  } else {
    state.socialHosts[course].customAddress[field] = value;
    const a = state.socialHosts[course].customAddress;
    a.full = `${a.street}, ${a.postcode} ${a.city}`;
  }
}

// ---- Group Management ----
const STORAGE_GROUPS = 'runningdinner_groups';
const STORAGE_SNAPSHOTS = 'runningdinner_snapshots';

function getStoredGroups() {
  try { return JSON.parse(localStorage.getItem(STORAGE_GROUPS) || '{}'); } catch { return {}; }
}
function getStoredSnapshots() {
  try { return JSON.parse(localStorage.getItem(STORAGE_SNAPSHOTS) || '{}'); } catch { return {}; }
}

function showSaveGroupModal() {
  if (window.RDA_DEMO?.isActive?.()) { window.RDA_DEMO.showPaywall('paywall_export'); return; }
  const groups = getStoredGroups();
  document.getElementById('list-modal-title').textContent = I18n.t('app.groups.save_title', '💾 Deelnemersgroep opslaan');
  document.getElementById('list-modal-body').innerHTML = `
    <div class="list-modal-save-row">
      <input type="text" id="save-group-name" placeholder="${I18n.t('app.groups.save_placeholder', "Naam voor deze groep (bijv. 'Editie 2026')")}" value="">
      <button class="btn-primary" onclick="confirmSaveGroup()">${I18n.t('app.modal.save', 'Opslaan')}</button>
    </div>
    <p class="hint">${I18n.t('app.groups.existing_groups', 'Bestaande groepen (klik om naam over te nemen)')}:</p>
    ${Object.keys(groups).length ? Object.entries(groups).map(([name, g]) => `
      <div class="list-modal-item" data-group-name="${escapeHtml(name)}" onclick="document.getElementById('save-group-name').value=this.dataset.groupName">
        <div class="list-modal-item-name">${escapeHtml(name)}</div>
        <div class="list-modal-item-meta">${g.participants?.length || 0} ${I18n.t('app.stats.participants', 'deelnemers')} · ${escapeHtml(g.savedAt || '')}</div>
        <button class="btn-danger btn-small" onclick="event.stopPropagation();deleteGroup(this.closest('[data-group-name]').dataset.groupName)">🗑️</button>
      </div>`).join('') : `<p class="list-modal-empty">${I18n.t('app.groups.no_groups', 'Geen opgeslagen groepen.')}</p>`}`;
  document.getElementById('list-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('save-group-name').focus(), 50);
}

function confirmSaveGroup() {
  const name = document.getElementById('save-group-name').value.trim();
  if (!name) { alert(I18n.t('app.alert.enter_name', 'Voer een naam in.')); return; }
  const groups = getStoredGroups();
  groups[name] = { participants: state.participants, savedAt: new Date().toLocaleDateString('nl-NL') };
  localStorage.setItem(STORAGE_GROUPS, JSON.stringify(groups));
  closeListModal();
  alert(I18n.t('app.alert.group_saved_prefix', 'Groep') + ` "${name}" ` + I18n.t('app.alert.saved', 'opgeslagen!'));
}

function deleteGroup(name) {
  if (!confirm(I18n.t('app.confirm.delete_group', 'Groep') + ` "${name}" ` + I18n.t('app.confirm.delete_suffix', 'verwijderen?'))) return;
  const groups = getStoredGroups();
  delete groups[name];
  localStorage.setItem(STORAGE_GROUPS, JSON.stringify(groups));
  showSaveGroupModal();
}

function showLoadGroupModal() {
  const groups = getStoredGroups();
  document.getElementById('list-modal-title').textContent = I18n.t('app.groups.load_title', '📂 Deelnemersgroep laden');
  document.getElementById('list-modal-body').innerHTML = Object.keys(groups).length
    ? Object.entries(groups).map(([name, g]) => `
        <div class="list-modal-item" data-group-name="${escapeHtml(name)}">
          <div>
            <div class="list-modal-item-name">${escapeHtml(name)}</div>
            <div class="list-modal-item-meta">${g.participants?.length || 0} ${I18n.t('app.stats.participants', 'deelnemers')} · ${I18n.t('app.groups.saved_at', 'opgeslagen')} ${escapeHtml(g.savedAt || '')}</div>
          </div>
          <button class="btn-primary btn-small" onclick="confirmLoadGroup(this.closest('[data-group-name]').dataset.groupName)">${I18n.t('app.groups.load_btn', 'Laden')}</button>
          <button class="btn-danger btn-small" onclick="deleteGroup(this.closest('[data-group-name]').dataset.groupName);showLoadGroupModal()">🗑️</button>
        </div>`).join('')
    : `<p class="list-modal-empty">${I18n.t('app.groups.no_groups_hint', 'Geen opgeslagen groepen. Sla eerst een groep op via "Groep opslaan".')}</p>`;
  document.getElementById('list-modal').style.display = 'flex';
}

function confirmLoadGroup(name) {
  if (!confirm(I18n.t('app.confirm.load_group_prefix', 'Groep') + ` "${name}" ` + I18n.t('app.confirm.load_group_suffix', 'laden? De huidige deelnemers worden vervangen.'))) return;
  const groups = getStoredGroups();
  const g = groups[name];
  if (!g) return;
  state.participants = g.participants.map(p => ({ ...p }));
  state.nextId = Math.max(...state.participants.map(p => p.id), 0) + 1;
  state.planning = null;
  closeListModal();
  renderParticipantsList();
}

function deleteAllParticipants() {
  if (!confirm(I18n.t('app.confirm.delete_all_prefix', 'Alle') + ` ${state.participants.length} ` + I18n.t('app.confirm.delete_all_suffix', 'deelnemers verwijderen? Dit kan niet ongedaan worden gemaakt.'))) return;
  state.participants = [];
  state.planning = null;
  state.nextId = 1;
  renderParticipantsList();
}

// ---- Planning Snapshots ----
function savePlanningSnapshot() {
  if (window.RDA_DEMO?.isActive?.()) { window.RDA_DEMO.showPaywall('paywall_export'); return; }
  if (!state.planning) { alert(I18n.t('app.alert.generate_first', 'Genereer eerst een planning in stap 3.')); return; }
  const name = prompt(I18n.t('app.snapshots.name_prompt', 'Naam voor deze momentopname:'), `Planning ${new Date().toLocaleDateString(I18n.getLang() === 'en' ? 'en-GB' : 'nl-NL')}`);
  if (!name) return;
  const snapshots = getStoredSnapshots();
  snapshots[name] = {
    config: state.config,
    participants: state.participants,
    forcedCombos: state.forcedCombos,
    socialHosts: state.socialHosts,
    planning: state.planning,
    savedAt: new Date().toLocaleString('nl-NL')
  };
  localStorage.setItem(STORAGE_SNAPSHOTS, JSON.stringify(snapshots));
  alert(I18n.t('app.alert.snapshot_prefix', 'Momentopname') + ` "${name}" ` + I18n.t('app.alert.saved', 'opgeslagen!'));
}

function showLoadSnapshotModal() {
  const snapshots = getStoredSnapshots();
  document.getElementById('list-modal-title').textContent = I18n.t('app.snapshots.load_title', '📂 Momentopname laden');
  document.getElementById('list-modal-body').innerHTML = Object.keys(snapshots).length
    ? Object.entries(snapshots).map(([name, s]) => `
        <div class="list-modal-item" data-snapshot-name="${escapeHtml(name)}">
          <div>
            <div class="list-modal-item-name">${escapeHtml(name)}</div>
            <div class="list-modal-item-meta">${s.participants?.length || 0} ${I18n.t('app.stats.participants', 'deelnemers')} · ${escapeHtml(s.savedAt || '')}</div>
          </div>
          <button class="btn-primary btn-small" onclick="confirmLoadSnapshot(this.closest('[data-snapshot-name]').dataset.snapshotName)">${I18n.t('app.groups.load_btn', 'Laden')}</button>
          <button class="btn-danger btn-small" onclick="deleteSnapshot(this.closest('[data-snapshot-name]').dataset.snapshotName)">🗑️</button>
        </div>`).join('')
    : `<p class="list-modal-empty">${I18n.t('app.snapshots.no_snapshots', 'Geen opgeslagen momentopnames.')}</p>`;
  document.getElementById('list-modal').style.display = 'flex';
}

function deleteSnapshot(name) {
  if (!confirm(I18n.t('app.alert.snapshot_prefix', 'Momentopname') + ` "${name}" ` + I18n.t('app.confirm.delete_suffix', 'verwijderen?'))) return;
  const snapshots = getStoredSnapshots();
  delete snapshots[name];
  localStorage.setItem(STORAGE_SNAPSHOTS, JSON.stringify(snapshots));
  showLoadSnapshotModal();
}

function confirmLoadSnapshot(name) {
  if (!confirm(I18n.t('app.alert.snapshot_prefix', 'Momentopname') + ` "${name}" ` + I18n.t('app.confirm.load_snapshot_suffix', 'laden? De huidige staat wordt overschreven.'))) return;
  const snapshots = getStoredSnapshots();
  const s = snapshots[name];
  if (!s) return;
  state.config = s.config;
  state.participants = s.participants;
  state.forcedCombos = s.forcedCombos || [];
  state.socialHosts = s.socialHosts || { voorborrel: null, naborrel: null };
  state.planning = s.planning;
  state.nextId = Math.max(...state.participants.map(p => p.id), 0) + 1;
  closeListModal();
  goToStep(4);
}

function closeListModal() {
  document.getElementById('list-modal').style.display = 'none';
}

// ---- Excel Import / Export ----
// SheetJS (xlsx.full.min.js) wordt pas geladen zodra de user op "Importeer"
// of "Download sjabloon" klikt. Dat scheelt ~880KB aan initial app-load.
let _xlsxLoading = null;
function loadXlsx() {
  if (typeof XLSX !== 'undefined') return Promise.resolve();
  if (_xlsxLoading) return _xlsxLoading;
  _xlsxLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/xlsx.full.min.js';
    s.async = true;
    s.onload  = () => resolve();
    s.onerror = () => { _xlsxLoading = null; reject(new Error('xlsx load failed')); };
    document.head.appendChild(s);
  });
  return _xlsxLoading;
}

function getTemplateHeaders() {
  return [
    I18n.t('app.excel.name_person1', 'Naam persoon 1*'),
    I18n.t('app.excel.name_partner', 'Naam partner'),
    I18n.t('app.excel.postcode', 'Postcode*'),
    I18n.t('app.excel.housenumber', 'Huisnummer*'),
    I18n.t('app.excel.street', 'Straatnaam'),
    I18n.t('app.excel.city', 'Woonplaats'),
    I18n.t('app.excel.host_preference', 'Gastrol voorkeur'),
    I18n.t('app.excel.avail_p1_voorborrel', 'Beschikb. P1: voorborrel'),
    I18n.t('app.excel.avail_p1_voorgerecht', 'Beschikb. P1: voorgerecht'),
    I18n.t('app.excel.avail_p1_hoofdgerecht', 'Beschikb. P1: hoofdgerecht'),
    I18n.t('app.excel.avail_p1_nagerecht', 'Beschikb. P1: nagerecht'),
    I18n.t('app.excel.avail_p1_naborrel', 'Beschikb. P1: naborrel'),
    I18n.t('app.excel.avail_partner_voorborrel', 'Beschikb. partner: voorborrel'),
    I18n.t('app.excel.avail_partner_voorgerecht', 'Beschikb. partner: voorgerecht'),
    I18n.t('app.excel.avail_partner_hoofdgerecht', 'Beschikb. partner: hoofdgerecht'),
    I18n.t('app.excel.avail_partner_nagerecht', 'Beschikb. partner: nagerecht'),
    I18n.t('app.excel.avail_partner_naborrel', 'Beschikb. partner: naborrel'),
    I18n.t('app.excel.diet_person1', 'Dieetwensen persoon 1'),
    I18n.t('app.excel.diet_partner', 'Dieetwensen partner'),
    I18n.t('app.excel.prefer_with', 'Wil graag samen met'),
    I18n.t('app.excel.avoid', 'Wil NIET samen met')
  ];
}

function getTemplateExample() {
  const yes = I18n.t('app.excel.yes', 'ja');
  const no = I18n.t('app.excel.no', 'nee');
  return [
    'Jan de Vries', 'Marie de Vries', '1015AB', '45', 'Keizersgracht', 'Amsterdam',
    'voorgerecht',
    yes, yes, yes, yes, yes,
    yes, yes, yes, no, no,
    '', I18n.t('app.excel.example_vegetarian', 'vegetarisch'),
    '', ''
  ];
}

function getInstructiesRows() {
  const yes = I18n.t('app.excel.instr_yes', 'Ja');
  const no = I18n.t('app.excel.instr_no', 'Nee');
  return [
    [I18n.t('app.excel.instr_column', 'Kolom'), I18n.t('app.excel.instr_required', 'Verplicht'), I18n.t('app.excel.instr_explanation', 'Uitleg'), I18n.t('app.excel.instr_valid_values', 'Geldige waarden')],
    [I18n.t('app.excel.instr_name1', 'Naam persoon 1'), yes, I18n.t('app.excel.instr_name1_desc', 'Volledige naam van de eerste persoon'), ''],
    [I18n.t('app.excel.instr_partner', 'Naam partner'), no, I18n.t('app.excel.instr_partner_desc', 'Volledige naam van de partner (leeglaten indien geen partner)'), ''],
    [I18n.t('app.excel.instr_postcode', 'Postcode'), yes, I18n.t('app.excel.instr_postcode_desc', 'Postcode zonder spatie'), I18n.t('app.excel.instr_postcode_eg', 'bijv. 1015AB')],
    [I18n.t('app.excel.instr_housenr', 'Huisnummer'), yes, I18n.t('app.excel.instr_housenr_desc', 'Alleen het huisnummer (inclusief toevoeging)'), I18n.t('app.excel.instr_housenr_eg', 'bijv. 45 of 45A')],
    [I18n.t('app.excel.instr_street', 'Straatnaam'), no, I18n.t('app.excel.instr_street_desc', 'Wordt automatisch gevuld via postcode indien leeg'), ''],
    [I18n.t('app.excel.instr_city', 'Woonplaats'), no, I18n.t('app.excel.instr_city_desc', 'Wordt automatisch gevuld via postcode indien leeg'), ''],
    [I18n.t('app.excel.instr_host', 'Gastrol voorkeur'), no, I18n.t('app.excel.instr_host_desc', 'Bij welk gerecht wil de persoon gastheer/vrouw zijn?'), 'voorborrel / voorgerecht / hoofdgerecht / nagerecht / naborrel / ' + I18n.t('app.excel.instr_empty', 'leeg')],
    [I18n.t('app.excel.instr_avail_p1', 'Beschikb. P1: *'), no, I18n.t('app.excel.instr_avail_p1_desc', 'Is persoon 1 aanwezig bij dit onderdeel?'), I18n.t('app.excel.instr_yes_no', 'ja / nee  (leeg = ja)')],
    [I18n.t('app.excel.instr_avail_partner', 'Beschikb. partner: *'), no, I18n.t('app.excel.instr_avail_partner_desc', 'Is de partner aanwezig bij dit onderdeel?'), I18n.t('app.excel.instr_yes_no', 'ja / nee  (leeg = ja)')],
    [I18n.t('app.excel.instr_diet1', 'Dieetwensen persoon 1'), no, I18n.t('app.excel.instr_diet1_desc', 'Allergieën of dieetwensen van persoon 1'), I18n.t('app.excel.instr_free_text', 'Vrije tekst')],
    [I18n.t('app.excel.instr_diet2', 'Dieetwensen partner'), no, I18n.t('app.excel.instr_diet2_desc', 'Allergieën of dieetwensen van de partner'), I18n.t('app.excel.instr_free_text', 'Vrije tekst')],
    [I18n.t('app.excel.instr_prefer', 'Wil graag samen met'), no, I18n.t('app.excel.instr_prefer_desc', 'Namen van personen waarmee men graag aan tafel zit (komma-gescheiden)'), I18n.t('app.excel.instr_prefer_eg', 'bijv. Lisa Jansen, Thomas Smit')],
    [I18n.t('app.excel.instr_avoid', 'Wil NIET samen met'), no, I18n.t('app.excel.instr_avoid_desc', 'Namen van personen waarmee men NIET aan tafel wil (komma-gescheiden)'), I18n.t('app.excel.instr_avoid_eg', 'bijv. Kevin Peters')],
    [],
    [I18n.t('app.excel.instr_warning', 'LET OP: Verwijder de voorbeeldrij (rij 2 in het Deelnemers-tabblad) vóór het importeren!')],
  ];
}

async function downloadTemplate() {
  if (window.RDA_DEMO?.isActive?.()) { window.RDA_DEMO.showPaywall('paywall_excel'); return; }
  try { await loadXlsx(); } catch {
    alert(I18n.t('app.alert.xlsx_not_loaded', 'Excel-bibliotheek nog niet geladen. Controleer de internetverbinding en probeer opnieuw.'));
    return;
  }

  const wb = XLSX.utils.book_new();
  const headers = getTemplateHeaders();
  const example = getTemplateExample();

  // Sheet 1: Deelnemers / Participants
  const ws = XLSX.utils.aoa_to_sheet([headers, example]);
  ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length + 2, 14) }));

  // Style header row (bold + blue background) – basic cell metadata
  const headerRange = XLSX.utils.decode_range(ws['!ref']);
  for (let c = headerRange.s.c; c <= headerRange.e.c; c++) {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c });
    if (!ws[cellRef]) continue;
    ws[cellRef].s = { font: { bold: true }, fill: { fgColor: { rgb: 'C7D9F0' } } };
  }

  const sheetNameParticipants = I18n.t('app.excel.sheet_participants', 'Deelnemers');
  XLSX.utils.book_append_sheet(wb, ws, sheetNameParticipants);

  // Sheet 2: Instructies / Instructions
  const wsI = XLSX.utils.aoa_to_sheet(getInstructiesRows());
  wsI['!cols'] = [{ wch: 30 }, { wch: 10 }, { wch: 55 }, { wch: 55 }];
  XLSX.utils.book_append_sheet(wb, wsI, I18n.t('app.excel.sheet_instructions', 'Instructies'));

  XLSX.writeFile(wb, I18n.t('app.excel.filename', 'running-dinner-deelnemers-sjabloon.xlsx'));
}

async function importParticipantsFromFile(event) {
  if (window.RDA_DEMO?.isActive?.()) {
    window.RDA_DEMO.showPaywall('paywall_excel');
    if (event?.target) event.target.value = '';
    return;
  }
  const file = event.target.files[0];
  if (!file) return;

  try { await loadXlsx(); } catch {
    showImportStatus('error', I18n.t('app.import.xlsx_not_loaded', 'Excel-bibliotheek niet geladen. Controleer de internetverbinding.'));
    event.target.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      // Use first sheet named 'Deelnemers' or 'Participants', or fall back to first sheet
      const sheetName = wb.SheetNames.includes('Deelnemers') ? 'Deelnemers'
        : wb.SheetNames.includes('Participants') ? 'Participants'
        : wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      if (rows.length < 2) {
        showImportStatus('error', I18n.t('app.import.no_data', 'Het bestand heeft geen gegevens (minstens een kopregel en één dataregel vereist).'));
        event.target.value = '';
        return;
      }

      // Row 0 = headers, rows 1+ = data (skip rows where name1 is empty)
      const dataRows = rows.slice(1).filter(r => String(r[0] || '').trim() !== '');
      const avBool = val => { const v = String(val).trim().toLowerCase(); return v !== 'nee' && v !== 'no' && v !== '0'; };
      const validHostPrefs = ['voorborrel', 'voorgerecht', 'hoofdgerecht', 'nagerecht', 'naborrel'];
      const allCourses = ['voorborrel', 'voorgerecht', 'hoofdgerecht', 'nagerecht', 'naborrel'];

      let added = 0, skipped = 0;

      dataRows.forEach(row => {
        const name1 = String(row[0] || '').trim();
        if (!name1) { skipped++; return; }

        const name2   = String(row[1] || '').trim() || null;
        const postcode = String(row[2] || '').trim().replace(/\s/g, '').toUpperCase();
        const housenumber = String(row[3] || '').trim();
        const street  = String(row[4] || '').trim();
        const city    = String(row[5] || '').trim();
        const hostPref = String(row[6] || '').trim().toLowerCase();

        // Availability columns 7–11 (P1), 12–16 (partner)
        const availability = {};
        allCourses.forEach((c, i) => {
          availability[c] = {
            person1: avBool(row[7 + i] !== '' ? row[7 + i] : 'ja'),
            person2: name2 ? avBool(row[12 + i] !== '' ? row[12 + i] : 'ja') : false
          };
        });

        const diet1 = String(row[17] || '').trim() || null;
        const diet2 = String(row[18] || '').trim() || null;
        const preferWith = String(row[19] || '').trim()
          ? String(row[19]).split(',').map(s => s.trim()).filter(Boolean) : [];
        const avoid = String(row[20] || '').trim()
          ? String(row[20]).split(',').map(s => s.trim()).filter(Boolean) : [];

        state.participants.push({
          id: state.nextId++,
          name1,
          name2,
          address: {
            street,
            housenumber,
            postcode,
            city,
            full: `${street}${housenumber ? ' ' + housenumber : ''}, ${postcode} ${city}`.trim()
          },
          availability,
          hostPreference: validHostPrefs.includes(hostPref) ? hostPref : null,
          diet1,
          diet2,
          preferWith,
          avoid
        });
        added++;
      });

      renderParticipantsList();
      showImportStatus('ok', `✓ ${added} ${I18n.t('app.import.imported_suffix', 'deelnemer(s) succesvol geïmporteerd')}${skipped ? ` (${skipped} ${I18n.t('app.import.skipped', 'overgeslagen')})` : ''}.`);
    } catch (err) {
      showImportStatus('error', `${I18n.t('app.import.failed', 'Importeren mislukt')}: ${err.message}`);
    }
    event.target.value = ''; // reset so same file can be re-imported
  };
  reader.readAsArrayBuffer(file);
}

function showImportStatus(type, msg) {
  const el = document.getElementById('import-status');
  if (!el) return;
  el.className = `import-status-msg ${type === 'ok' ? 'import-ok' : 'import-err'}`;
  el.textContent = msg;
  setTimeout(() => { el.textContent = ''; el.className = 'import-status-msg'; }, 6000);
}

// ---- Sample Data (for testing) ----
function loadSampleData() {
  const sampleParticipants = [
    { name1: 'Jan de Vries', name2: 'Marie de Vries', street: 'Keizersgracht', housenumber: '45', postcode: '1015AB', city: 'Amsterdam', hostPref: 'voorgerecht', diet1: '', diet2: 'vegetarisch' },
    { name1: 'Pieter Bakker', name2: 'Els Bakker', street: 'Prinsengracht', housenumber: '12', postcode: '1015DK', city: 'Amsterdam', hostPref: 'hoofdgerecht', diet1: '', diet2: '' },
    { name1: 'Thomas Smit', name2: null, street: 'Herengracht', housenumber: '78', postcode: '1017RZ', city: 'Amsterdam', hostPref: 'nagerecht', diet1: 'noten allergie', diet2: null },
    { name1: 'Lisa Jansen', name2: 'Mark Jansen', street: 'Jordaan', housenumber: '33', postcode: '1016TW', city: 'Amsterdam', hostPref: '', diet1: '', diet2: '' },
    { name1: 'Sophie Meijer', name2: 'Daan Meijer', street: 'De Pijp', housenumber: '7', postcode: '1072AK', city: 'Amsterdam', hostPref: 'voorgerecht', diet1: 'vegan', diet2: '' },
    { name1: 'Henk Visser', name2: 'Ans Visser', street: 'Amstelveenseweg', housenumber: '99', postcode: '1075XV', city: 'Amsterdam', hostPref: '', diet1: 'glutenvrij', diet2: '' },
    { name1: 'Roos van Dam', name2: null, street: 'Vondelpark', housenumber: '4', postcode: '1054GD', city: 'Amsterdam', hostPref: 'hoofdgerecht', diet1: '', diet2: null },
    { name1: 'Kevin Peters', name2: 'Anna Peters', street: 'Oud-West', housenumber: '56', postcode: '1053RT', city: 'Amsterdam', hostPref: '', diet1: '', diet2: 'lactose-intolerant' },
    { name1: 'Bas Hoekstra', name2: 'Femke Hoekstra', street: 'Buitenveldert', housenumber: '21', postcode: '1081AC', city: 'Amsterdam', hostPref: 'nagerecht', diet1: '', diet2: '' },
    { name1: 'Inge de Boer', name2: 'Rob de Boer', street: 'Waterlooplein', housenumber: '3', postcode: '1011NW', city: 'Amsterdam', hostPref: '', diet1: '', diet2: '' },
    { name1: 'Frank Willems', name2: null, street: 'NDSM-werf', housenumber: '8', postcode: '1033RD', city: 'Amsterdam-Noord', hostPref: 'voorgerecht', diet1: 'pescotarisch', diet2: null },
    { name1: 'Carolien Berg', name2: 'Sven Berg', street: 'IJburg', housenumber: '14', postcode: '1087AK', city: 'Amsterdam', hostPref: '', diet1: '', diet2: '' }
  ];

  sampleParticipants.forEach(sp => {
    const courses = getActiveCourses();
    const availability = {};
    courses.forEach(c => { availability[c] = { person1: true, person2: true }; });

    state.participants.push({
      id: state.nextId++,
      name1: sp.name1,
      name2: sp.name2,
      address: {
        street: sp.street,
        housenumber: sp.housenumber,
        postcode: sp.postcode,
        city: sp.city,
        full: `${sp.street} ${sp.housenumber}, ${sp.postcode} ${sp.city}`
      },
      availability,
      hostPreference: sp.hostPref || null,
      diet1: sp.diet1 || null,
      diet2: sp.diet2 || null,
      preferWith: [],
      avoid: []
    });
  });

  renderParticipantsList();
}

// ---- Rating System ----
function showRatingModal() {
  // Check if user already rated
  fetch('/api/ratings/mine')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      const existing = data?.rating;
      const modal = document.getElementById('rating-modal');
      if (!modal) return;
      const currentScore   = existing?.score || 0;
      const currentComment = existing?.comment || '';
      const currentName    = existing?.display_name || '';
      const currentStatus  = existing?.status || null;
      const statusLine = currentStatus === 'pending'
        ? `<p style="font-size:.78rem;color:var(--text-light);margin:4px 0 0;text-align:center">⏳ ${I18n.t('app.rating.status_pending', 'In afwachting van goedkeuring')}</p>`
        : currentStatus === 'approved'
        ? `<p style="font-size:.78rem;color:var(--success);margin:4px 0 0;text-align:center">✓ ${I18n.t('app.rating.status_approved', 'Zichtbaar op de homepage')}</p>`
        : currentStatus === 'rejected' || currentStatus === 'hidden'
        ? `<p style="font-size:.78rem;color:var(--text-light);margin:4px 0 0;text-align:center">${I18n.t('app.rating.status_hidden', 'Niet publiek zichtbaar')}</p>`
        : '';
      document.getElementById('rating-modal-body').innerHTML = `
        <div style="text-align:center;margin-bottom:16px">
          <div style="font-size:2rem;margin-bottom:8px">🍽️</div>
          <h3 style="margin:0 0 6px;font-size:1.15rem;color:var(--secondary)">${existing ? I18n.t('app.rating.update_title', 'Jouw beoordeling bijwerken') : I18n.t('app.rating.ask_title', 'Hoe vind je de planner?')}</h3>
          <p style="color:var(--text-light);font-size:.88rem;margin:0">${I18n.t('app.rating.feedback_helps', 'Jouw feedback helpt ons de tool te verbeteren')}</p>
          ${statusLine}
        </div>
        <div id="rating-stars" style="display:flex;justify-content:center;gap:8px;margin:20px 0;font-size:2.2rem;cursor:pointer">
          ${[1,2,3,4,5].map(n =>
            `<span class="rating-star" data-score="${n}" style="color:${n <= currentScore ? '#f59e0b' : '#d1d5db'};transition:color .15s" onmouseenter="hoverStars(${n})" onmouseleave="resetStars()" onclick="selectStar(${n})">${n <= currentScore ? '★' : '☆'}</span>`
          ).join('')}
        </div>
        <input type="hidden" id="rating-score" value="${currentScore}">
        <div style="margin-bottom:12px">
          <label style="font-size:.85rem;font-weight:600;color:var(--secondary);display:block;margin-bottom:6px">${I18n.t('app.rating.name_label', 'Naam (optioneel, getoond bij publicatie)')}</label>
          <input type="text" id="rating-name" maxlength="80" value="${escapeHtml(currentName)}"
            placeholder="${I18n.t('app.rating.name_placeholder', 'bv. Sanne uit Utrecht')}"
            style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:var(--radius);font-family:inherit;font-size:.9rem">
        </div>
        <div style="margin-bottom:16px">
          <label style="font-size:.85rem;font-weight:600;color:var(--secondary);display:block;margin-bottom:6px">${I18n.t('app.rating.comment_label', 'Opmerking (optioneel)')}</label>
          <textarea id="rating-comment" rows="3" maxlength="1000" style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:var(--radius);font-family:inherit;font-size:.9rem;resize:vertical"
            placeholder="${I18n.t('app.rating.comment_placeholder', 'Wat vind je goed? Wat kan beter?')}">${escapeHtml(currentComment)}</textarea>
          <!-- Zachte hint bij hoge scores zonder comment: nodigt uit tot tekst. -->
          <p id="rating-hint-high" style="display:none;font-size:.78rem;color:#92400E;background:#FFFBEB;border:1px solid #FCD34D;border-radius:6px;margin:6px 0 0;padding:8px 12px">
            ✨ ${I18n.t('app.rating.hint_high', 'Je review is extra waardevol als je ook een zin schrijft — die komt bij goedkeuring op de homepage.')}
          </p>
          <p style="font-size:.75rem;color:var(--text-light);margin:4px 0 0">${I18n.t('app.rating.moderation_notice', 'Reviews met een opmerking worden gemodereerd voordat ze zichtbaar zijn op de homepage.')}</p>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="btn-secondary" onclick="closeRatingModal()">${I18n.t('app.rating.later', 'Later')}</button>
          <button class="btn-primary" id="rating-submit-btn" onclick="submitRating()">${I18n.t('app.rating.submit', 'Verstuur beoordeling')}</button>
        </div>
        <p id="rating-status" style="font-size:.85rem;margin-top:10px;text-align:center"></p>`;
      modal.style.display = 'flex';
      // Bind comment-input listener + initial hint-state
      const commentEl = document.getElementById('rating-comment');
      if (commentEl) commentEl.addEventListener('input', updateRatingHint);
      updateRatingHint();
    })
    .catch(() => {});
}

let _selectedStar = 0;

function hoverStars(n) {
  document.querySelectorAll('.rating-star').forEach(s => {
    const score = parseInt(s.dataset.score);
    s.style.color = score <= n ? '#f59e0b' : '#d1d5db';
    s.textContent = score <= n ? '★' : '☆';
  });
}

function resetStars() {
  const current = parseInt(document.getElementById('rating-score')?.value || '0');
  hoverStars(current);
}

function selectStar(n) {
  _selectedStar = n;
  document.getElementById('rating-score').value = n;
  hoverStars(n);
  updateRatingHint();
}

// Toon een zachte hint als de user 4 of 5 sterren geeft zonder opmerking.
function updateRatingHint() {
  const hint = document.getElementById('rating-hint-high');
  if (!hint) return;
  const score = parseInt(document.getElementById('rating-score')?.value || '0', 10);
  const commentEl = document.getElementById('rating-comment');
  const hasComment = commentEl && commentEl.value.trim().length > 0;
  hint.style.display = (score >= 4 && !hasComment) ? 'block' : 'none';
}

async function submitRating() {
  const score = parseInt(document.getElementById('rating-score').value);
  const comment = document.getElementById('rating-comment').value.trim();
  const displayName = (document.getElementById('rating-name')?.value || '').trim();
  const status = document.getElementById('rating-status');
  const btn = document.getElementById('rating-submit-btn');

  if (!score || score < 1) {
    status.textContent = I18n.t('app.rating.select_star', 'Selecteer minimaal 1 ster');
    status.style.color = 'var(--danger)';
    return;
  }

  btn.disabled = true;
  btn.textContent = I18n.t('app.rating.submitting', 'Versturen...');

  try {
    const res = await fetch('/api/ratings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ score, comment, display_name: displayName }),
    });
    const data = await res.json();
    if (res.ok) {
      status.textContent = data.message || I18n.t('app.rating.thanks', 'Bedankt!');
      status.style.color = 'var(--success)';
      if (window.plausible) plausible('Review-Submit', { props: { score: String(score) } });
      setTimeout(() => closeRatingModal(), 1500);
    } else {
      status.textContent = data.error || I18n.t('app.rating.error', 'Er ging iets mis');
      status.style.color = 'var(--danger)';
    }
  } catch {
    status.textContent = I18n.t('app.rating.network_error', 'Netwerkfout');
    status.style.color = 'var(--danger)';
  }

  btn.disabled = false;
  btn.textContent = I18n.t('app.rating.submit', 'Verstuur beoordeling');
}

function closeRatingModal() {
  const m = document.getElementById('rating-modal');
  if (m) m.style.display = 'none';
}

// Show rating prompt when user first visits step 4
let _ratingPromptShown = false;
function maybeShowRatingPrompt() {
  if (window.RDA_DEMO?.isActive?.()) return; // Geen review-prompt in demo
  if (_ratingPromptShown) return;
  _ratingPromptShown = true;
  // Wait a moment so user sees the overview first
  setTimeout(() => showRatingModal(), 3000);
}

// ---- Keyboard: Escape closes modals ----
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const ratingModal = document.getElementById('rating-modal');
    if (ratingModal && ratingModal.style.display === 'flex') {
      closeRatingModal();
    } else if (document.getElementById('participant-modal').style.display === 'flex') {
      closeParticipantModal();
    } else if (document.getElementById('list-modal').style.display === 'flex') {
      closeListModal();
    }
  }
});

// ---- Init ----
// Expose state-getter zodat demo-mode.js de state kan serialiseren bij carry-over
window.__rda_getState = () => state;

// ---- Carry-over uit demo-sessie: prompt om data over te nemen ----
function showCarryoverPrompt(carryover) {
  const lang = (typeof I18n !== 'undefined' && I18n.getLang) ? I18n.getLang() : 'nl';
  const tT = {
    nl: { title: '🍽️ Je demo-data staat klaar', body: 'We hebben je werk uit de demo bewaard. Wil je hiermee verder of fris beginnen?', load: 'Verder met demo-data', discard: 'Fris beginnen', loaded: 'Demo-data geladen' },
    en: { title: '🍽️ Your demo data is ready', body: 'We saved your work from the demo. Continue with it or start fresh?', load: 'Continue with demo data', discard: 'Start fresh', loaded: 'Demo data loaded' },
    es: { title: '🍽️ Tus datos de la demo están listos', body: 'Hemos guardado tu trabajo de la demo. ¿Quieres continuar con eso o empezar de cero?', load: 'Continuar con datos de la demo', discard: 'Empezar de cero', loaded: 'Datos de la demo cargados' },
    de: { title: '🍽️ Deine Demo-Daten sind bereit', body: 'Wir haben deine Arbeit aus der Demo gespeichert. Damit weitermachen oder neu beginnen?', load: 'Mit Demo-Daten fortfahren', discard: 'Neu starten', loaded: 'Demo-Daten geladen' },
  };
  const T = tT[lang] || tT.nl;

  const card = document.createElement('div');
  card.id = 'demo-carryover-card';
  card.style.cssText = 'position:sticky;top:0;z-index:500;background:linear-gradient(135deg,#fff7ed 0%,#fef3c7 100%);border-bottom:2px solid #fcd34d;padding:14px 20px;font-family:"Plus Jakarta Sans",system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.06)';
  card.innerHTML = `
    <div style="max-width:1200px;margin:0 auto;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <div style="flex:1;min-width:240px">
        <div style="font-weight:700;color:#1E293B;font-size:.95rem;margin-bottom:2px">${T.title}</div>
        <div style="color:#64748B;font-size:.85rem">${T.body}</div>
      </div>
      <button type="button" id="co-load-btn" style="background:#E85D3A;color:#fff;border:none;font-weight:700;padding:9px 18px;border-radius:9px;cursor:pointer;font-size:.88rem;font-family:inherit;box-shadow:0 3px 10px rgba(232,93,58,.25)">${T.load}</button>
      <button type="button" id="co-discard-btn" style="background:transparent;border:1px solid #E2E8F0;color:#64748B;font-weight:600;padding:8px 16px;border-radius:9px;cursor:pointer;font-size:.85rem;font-family:inherit">${T.discard}</button>
    </div>`;
  document.body.insertBefore(card, document.body.firstChild);

  document.getElementById('co-load-btn').addEventListener('click', () => {
    try {
      // Vervang state met carry-over data
      Object.assign(state.config, carryover.config || {});
      state.participants = (carryover.participants || []).map(p => ({ ...p }));
      state.forcedCombos = carryover.forcedCombos || [];
      state.socialHosts  = carryover.socialHosts  || { voorborrel: null, naborrel: null };
      state.nextId = (state.participants.length || 0) + 1;
      state.planning = null;

      // Sync UI-velden
      const evName = document.getElementById('event-name');
      const evDate = document.getElementById('event-date');
      const evCity = document.getElementById('event-city');
      if (evName) evName.value = state.config.eventName || '';
      if (evDate) evDate.value = state.config.eventDate || '';
      if (evCity) evCity.value = state.config.eventCity || '';
      const minEl = document.getElementById('min-table-size');
      const maxEl = document.getElementById('max-table-size');
      if (minEl) minEl.value = state.config.minTableSize || 4;
      if (maxEl) maxEl.value = state.config.maxTableSize || 6;

      if (typeof renderParticipantsList === 'function') renderParticipantsList();
      window.RDA_DEMO?.clearCarryover?.();
      try { window.plausible?.('Demo Carryover Loaded', { props: { count: state.participants.length, lang } }); } catch {}

      // Toon kort succes-feedback en verberg de card
      card.innerHTML = `<div style="max-width:1200px;margin:0 auto;text-align:center;color:#166534;font-weight:700;font-size:.95rem">✓ ${T.loaded}</div>`;
      setTimeout(() => card.remove(), 2200);
    } catch (e) {
      console.warn('[demo] carryover load failed', e);
      card.remove();
    }
  });

  document.getElementById('co-discard-btn').addEventListener('click', () => {
    window.RDA_DEMO?.clearCarryover?.();
    card.remove();
  });
}

function init() {
  initStep1();
  updateHostPreferenceOptions();

  // Demo-modus: vul state met sample-data en render UI direct
  if (window.RDA_DEMO?.isActive?.()) {
    try {
      window.RDA_DEMO.applyToState(state);
      // Render direct de deelnemerslijst zodat gebruikers de data zien als ze naar stap 2 gaan
      if (typeof renderParticipantsList === 'function') renderParticipantsList();
    } catch (e) { console.warn('[demo] applyToState failed', e); }
  } else if (window.RDA_DEMO?.getCarryover) {
    // Niet-demo modus: check of er een carry-over is uit een eerdere demo-sessie
    try {
      const co = window.RDA_DEMO.getCarryover();
      if (co && co.participants && co.participants.length > 0) {
        showCarryoverPrompt(co);
      }
    } catch (e) { console.warn('[demo] carryover check failed', e); }
  }

  // Add sample data button only in dev mode (?dev in URL)
  if (new URLSearchParams(location.search).has('dev')) {
    const devBtn = document.createElement('button');
    devBtn.className = 'btn-secondary btn-small';
    devBtn.textContent = I18n.t('app.dev.load_sample', '📋 Laad voorbeelddata');
    devBtn.style.marginLeft = 'auto';
    devBtn.onclick = loadSampleData;
    document.querySelector('.participants-header').appendChild(devBtn);
  }

  // Deep-link: /?review=1 opent direct de review-modal (vanaf profiel etc.)
  if (new URLSearchParams(location.search).has('review')) {
    setTimeout(() => { try { showRatingModal(); } catch {} }, 300);
  }

  // Onboarding-tour bij eerste bezoek (skipbaar + onthouden in localStorage)
  // In demo-modus overslaan zodat de tour de paywall-modal niet hindert.
  if (!window.RDA_DEMO?.isActive?.()) maybeShowOnboarding();
}

// ---- Onboarding Tour ----
// 4 stappen, één tooltip per keer, rechts-onder. State in localStorage
// zodat gebruikers die 'm afsluiten 'm niet opnieuw krijgen.
const ONBOARDING_STEPS = [
  {
    step: 1,
    titleKey: 'app.onboarding.step1_title', titleFallback: '1. Event instellen',
    bodyKey:  'app.onboarding.step1_body',  bodyFallback:  'Kies datum, naam en welke gangen je wilt (voorborrel, voor-, hoofd-, nagerecht, naborrel). Klik op "Naar deelnemers" als je tevreden bent.',
    scrollTo: 'step-1',
  },
  {
    step: 2,
    titleKey: 'app.onboarding.step2_title', titleFallback: '2. Deelnemers toevoegen',
    bodyKey:  'app.onboarding.step2_body',  bodyFallback:  'Voeg handmatig deelnemers toe, importeer via Excel of gebruik "Laad voorbeelddata" (?dev in URL) om snel te testen. Vul waar mogelijk dieetwensen in.',
    scrollTo: 'step-2',
  },
  {
    step: 3,
    titleKey: 'app.onboarding.step3_title', titleFallback: '3. Planning berekenen',
    bodyKey:  'app.onboarding.step3_body',  bodyFallback:  'De planner wijst automatisch tafels toe, rekening houdend met dieetwensen, beschikbaarheid en voorkeuren. Je kunt naderhand nog handmatig schuiven.',
    scrollTo: 'step-3',
  },
  {
    step: 4,
    titleKey: 'app.onboarding.step4_title', titleFallback: '4. Overzicht & afdrukken',
    bodyKey:  'app.onboarding.step4_body',  bodyFallback:  'Print per-persoon routes of envelop-kaartjes voor de verrassing bij tafel. Sla je planning op als momentopname om later te raadplegen.',
    scrollTo: 'step-4',
  },
];
let _onboardingStepIdx = 0;

function maybeShowOnboarding() {
  try {
    if (localStorage.getItem('rda-onboarding-done') === '1') return;
  } catch { /* localStorage blocked */ return; }
  const el = document.getElementById('onboarding-tour');
  if (!el) return;
  _onboardingStepIdx = 0;
  // Korte vertraging zodat de initial render eerst klaar is
  setTimeout(() => {
    renderOnboardingStep();
    el.style.display = 'block';
  }, 800);
}

function renderOnboardingStep() {
  const s = ONBOARDING_STEPS[_onboardingStepIdx];
  if (!s) { closeOnboarding(true); return; }
  const titleEl   = document.getElementById('onb-title');
  const bodyEl    = document.getElementById('onb-body');
  const counterEl = document.getElementById('onb-step-counter');
  const nextBtn   = document.getElementById('onb-next-btn');
  if (!titleEl || !bodyEl || !counterEl || !nextBtn) return;
  titleEl.textContent = I18n.t(s.titleKey, s.titleFallback);
  bodyEl.textContent  = I18n.t(s.bodyKey,  s.bodyFallback);
  counterEl.textContent = I18n.t('app.onboarding.counter', 'Stap {n} van 4').replace('{n}', s.step);
  nextBtn.textContent = (_onboardingStepIdx === ONBOARDING_STEPS.length - 1)
    ? I18n.t('app.onboarding.finish', 'Begin! ✓')
    : I18n.t('app.onboarding.next', 'Volgende →');
  // Scroll de bijbehorende stap in beeld (zachte highlight)
  const target = document.getElementById(s.scrollTo);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function onboardingNext() {
  _onboardingStepIdx++;
  if (_onboardingStepIdx >= ONBOARDING_STEPS.length) {
    closeOnboarding(true);
  } else {
    renderOnboardingStep();
  }
}

function closeOnboarding(finished = false) {
  const el = document.getElementById('onboarding-tour');
  if (el) el.style.display = 'none';
  try { localStorage.setItem('rda-onboarding-done', '1'); } catch {}
  if (window.plausible) plausible('Onboarding-' + (finished ? 'Finish' : 'Skip'));
}

document.addEventListener('DOMContentLoaded', init);
