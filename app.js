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
    eventCity: ''
  },
  participants: [],
  forcedCombos: [],
  planning: null,
  nextId: 1,
  // Hosts for social courses: { participantId } or { customAddress }
  socialHosts: { voorborrel: null, naborrel: null },
  manualChanges: []
};

const COURSE_LABELS = {
  voorborrel: 'Voorborrel',
  voorgerecht: 'Voorgerecht',
  hoofdgerecht: 'Hoofdgerecht',
  nagerecht: 'Nagerecht',
  naborrel: 'Naborrel'
};
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
  if (n === 4) renderOverview();
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
}

// ---- Step 2: Participants ----
function updateHostPreferenceOptions() {
  const sel = document.getElementById('p-host-preference');
  if (!sel) return;
  const courses = getActiveCourses();
  const cur = sel.value;
  sel.innerHTML = '<option value="">Geen voorkeur</option>';
  courses.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = COURSE_ICONS[c] + ' ' + COURSE_LABELS[c];
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
      <span class="availability-course-name">${COURSE_ICONS[course]} ${COURSE_LABELS[course]}</span>
      <div class="availability-checks">
        <label class="availability-check">
          <input type="checkbox" name="avail-${course}-p1" ${p1avail ? 'checked' : ''}> Persoon 1
        </label>
        <label class="availability-check" id="avail-partner-${course}">
          <input type="checkbox" name="avail-${course}-p2" ${p2avail ? 'checked' : ''}> Partner
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
    document.getElementById('modal-title').textContent = 'Deelnemer bewerken';
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
    document.getElementById('modal-title').textContent = 'Deelnemer toevoegen';
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
  if (!confirm('Deelnemer verwijderen?')) return;
  state.participants = state.participants.filter(p => p.id !== id);
  renderParticipantsList();
  state.planning = null;
}

function renderParticipantsList() {
  const list = document.getElementById('participants-list');
  const count = document.getElementById('participant-count');
  count.textContent = state.participants.length;

  if (state.participants.length === 0) {
    list.innerHTML = '<p class="empty-state">Nog geen deelnemers toegevoegd. Klik op "+ Deelnemer toevoegen" om te beginnen.</p>';
    return;
  }

  list.innerHTML = state.participants.map(p => {
    const initials = escapeHtml((p.name1[0] + (p.name2 ? p.name2[0] : '')).toUpperCase());
    const fullName = p.name2 ? `${escapeHtml(p.name1)} &amp; ${escapeHtml(p.name2)}` : escapeHtml(p.name1);
    const tags = [];
    if (p.hostPreference) tags.push(`<span class="tag tag-host">${COURSE_ICONS[p.hostPreference]} Host: ${COURSE_LABELS[p.hostPreference]}</span>`);
    if (p.diet1) tags.push(`<span class="tag tag-diet">🥦 ${escapeHtml(p.diet1)}${p.diet2 ? ' / ' + escapeHtml(p.diet2) : ''}</span>`);

    const courses = getActiveCourses();
    const unavailable = courses.filter(c => {
      const av = p.availability[c];
      if (!av) return false;
      return !av.person1 || (p.name2 && !av.person2);
    });
    if (unavailable.length) tags.push(`<span class="tag tag-unavailable">⚠ Niet: ${unavailable.map(c => COURSE_LABELS[c]).join(', ')}</span>`);

    return `
      <div class="participant-card">
        <div class="participant-avatar">${initials}</div>
        <div class="participant-info">
          <div class="participant-name">${fullName}</div>
          <div class="participant-address">📍 ${escapeHtml(p.address.full)}</div>
          <div class="participant-meta">${tags.join('')}</div>
        </div>
        <div class="participant-actions">
          <button class="btn-secondary btn-small" onclick="openAddParticipant(${p.id})">✏️ Bewerken</button>
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
        <option value="">Selecteer persoon 1...</option>
        ${names.map(n => `<option value="${escapeHtml(n)}" ${fc.person1 === n ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}
      </select>
      <span>altijd samen met</span>
      <select onchange="updateForcedCombo(${fc.id}, 'person2', this.value)">
        <option value="">Selecteer persoon 2...</option>
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
    alert('Voeg minimaal 3 deelnemers toe om een planning te maken.');
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
      warnings.push(`Te weinig beschikbare gastheren voor ${COURSE_LABELS[course]}. Overweeg meer deelnemers toe te voegen.`);
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
        warnings.push(`Tafel vol bij ${COURSE_LABELS[course]}. Vergroot het maximum aantal gasten per tafel of voeg een extra gastheer toe.`);
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
      warnings.push(`Tafel van ${t.hostName} bij ${COURSE_LABELS[course]} heeft slechts ${count} gast(en) (richtlijn minimum: ${minGuests}).`);
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
    <div class="stat-box"><div class="stat-number">${participants.length}</div><div class="stat-label">Deelnemers</div></div>
    <div class="stat-box"><div class="stat-number">${participants.filter(p => p.name2).length}</div><div class="stat-label">Koppels</div></div>
    <div class="stat-box"><div class="stat-number">${diversityScore}</div><div class="stat-label">Gem. nieuwe tafelgenoten</div></div>
    <div class="stat-box"><div class="stat-number">${courses.length}</div><div class="stat-label">Gangen</div></div>`;

  // Warnings
  const warnEl = document.getElementById('planning-warnings');
  if (warnings.length) {
    warnEl.style.display = 'block';
    warnEl.innerHTML = `<h4>⚠️ Aandachtspunten</h4><ul>${warnings.map(w => `<li>${w}</li>`).join('')}</ul>`;
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
          <h4>${COURSE_LABELS[course]}</h4>
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
        <div class="table-card-header">Iedereen bijeen <span>👥 ${table.guestIds.length}</span></div>
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
        Tafel ${i + 1} – ${escapeHtml(table.address?.city || '')}
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
              <span class="drag-handle" title="Sleep om te verplaatsen">⠿</span>
              👤 ${escapeHtml(table.guestNames[gi])}
              ${diet ? `<span class="diet-icon" title="${escapeHtml(diet)}">🥦</span>` : ''}
            </div>`;
        }).join('')}
        ${table.guestIds.length === 0
          ? '<div class="dnd-empty-slot">Sleep een gast hierheen</div>' : ''}
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
    alert('Gasten kunnen alleen worden verplaatst binnen dezelfde gang.');
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
  if (!confirm('Alle handmatige wijzigingen ongedaan maken?')) return;
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
    el.innerHTML = '<p class="hint">Nog geen handmatige wijzigingen. Sleep gasten (⠿) tussen tafels om te wisselen.</p>';
    return;
  }
  el.innerHTML = `
    <div class="change-log">
      <div class="change-log-header">
        <span>${state.manualChanges.length} wijziging(en)</span>
        <button class="btn-danger btn-small" onclick="undoAllChanges()">↩ Alle ongedaan maken</button>
      </div>
      ${state.manualChanges.map((c, i) => `
        <div class="change-item">
          <div class="change-info">
            <span class="change-num">${i + 1}</span>
            <div class="change-desc">
              <strong>${escapeHtml(c.personName)}</strong> verplaatst van
              <em>${escapeHtml(c.fromHostName)}</em> → <em>${escapeHtml(c.toHostName)}</em>
              <span class="change-course">${COURSE_ICONS[c.course]} ${COURSE_LABELS[c.course]}</span>
            </div>
          </div>
          <button class="btn-secondary btn-small" onclick="undoChange(${c.id})">↩ Ongedaan</button>
        </div>`).join('')}
    </div>`;
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
    document.getElementById('per-person-content').innerHTML = '<p class="hint">Ga eerst naar stap 3 en genereer een planning.</p>';
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
      hostName: table.isSocial ? null : (isHost ? 'u zelf' : table.hostName),
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
                  ${COURSE_LABELS[r.course]}
                  ${r.isHost ? '<span class="hosting-badge">🏠 U bent gastheer/vrouw</span>' : ''}
                </div>
                ${r.isSocial ? '<div class="route-address">Iedereen bijeen</div>' : `
                  <div class="route-address">📍 ${escapeHtml(r.address?.street)}, ${escapeHtml(r.address?.postcode)} ${escapeHtml(r.address?.city)}</div>
                  ${!r.isHost ? `<div class="route-companions">Gastheer/vrouw: <span>${escapeHtml(r.hostName)}</span></div>` : ''}
                  <div class="route-companions">Tafelgenoten: <span>${r.companions.length ? r.companions.map(c => escapeHtml(c)).join(', ') : '–'}</span></div>
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
              <h3>${COURSE_ICONS[course]} ${COURSE_LABELS[course]} – Sociaal moment</h3>
              <p>Alle deelnemers bijeen • ${state.config.times[course].start} – ${addMinutes(state.config.times[course].start, state.config.times[course].duration)}</p>
            </div>
            <div class="location-body">
              <table class="guests-table">
                <thead><tr><th>Naam</th><th>Dieetwensen</th></tr></thead>
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
            <h3>${COURSE_ICONS[course]} ${COURSE_LABELS[course]} – Tafel ${i + 1}</h3>
            <p>🏠 ${escapeHtml(table.hostName)} · 📍 ${escapeHtml(host.address.full)} · ⏰ ${timeStr}</p>
          </div>
          <div class="location-body">
            <table class="guests-table">
              <thead><tr><th>Naam</th><th>Rol</th><th>Dieetwensen</th></tr></thead>
              <tbody>
                <tr style="background:#fff8f8">
                  <td><strong>${escapeHtml(table.hostName)}</strong></td>
                  <td><span class="host-badge" style="font-size:0.75rem;background:var(--primary);color:white;padding:2px 6px;border-radius:8px">Gastheer/vrouw</span></td>
                  <td>${escapeHtml([host.diet1, host.diet2].filter(Boolean).join(', ')) || '–'}</td>
                </tr>
                ${table.guestIds.map((gid, gi) => {
                  const g = participants.find(p => p.id === gid);
                  const diet = [g?.diet1, g?.diet2].filter(Boolean).join(', ');
                  return `<tr><td>${escapeHtml(table.guestNames[gi])}</td><td>Gast</td><td>${escapeHtml(diet) || '–'}</td></tr>`;
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
    el.innerHTML = '<p class="hint">Geen envelop-kaartjes beschikbaar voor de huidige planning.</p>';
    return;
  }

  function addrStr(address) {
    if (!address) return 'Locatie onbekend';
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
          ${COURSE_ICONS[course]} ${COURSE_LABELS[course]}
          <span class="env-next-arrow">→ volgende: ${COURSE_ICONS[nextCourse]} ${COURSE_LABELS[nextCourse]}</span>
        </div>
        ${courseTables.map(table => {
          const tableAddr = addrStr(table.address);
          const allIds = [table.hostId, ...table.guestIds].filter(Boolean);

          return `
            <div class="env-table-group">
              <div class="env-table-location">📍 Tafel bij: ${escapeHtml(table.hostName) || tableAddr} &nbsp;—&nbsp; ${tableAddr}</div>
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
                        <div class="env-card-current-course">${COURSE_ICONS[course]} ${COURSE_LABELS[course]} — open aan het einde van dit gerecht</div>
                      </div>
                      <div class="env-card-divider">✦ Jouw volgende bestemming ✦</div>
                      <div class="env-card-bottom">
                        <div class="env-card-next-course">${COURSE_ICONS[nextCourse]} ${COURSE_LABELS[nextCourse]}</div>
                        ${nextIsSocial
                          ? `<div class="env-card-next-host">Iedereen bijeen</div>
                             ${nextAddr ? `<div class="env-card-next-addr">📍 ${nextAddr}</div>` : ''}`
                          : nextIsHost
                            ? `<div class="env-card-next-host hosting">🏠 U bent gastheer/vrouw</div>
                               <div class="env-card-next-addr">📍 ${nextAddr}</div>`
                            : `<div class="env-card-next-host">Bij: ${nextHostName}</div>
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
  printWithStyle(`
    @media print {
      #tab-per-person, #tab-per-location, #tab-envelope { display: none !important; }
      #tab-${section} { display: block !important; }
    }`);
}

function printSingleEnvelopes() {
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
  if (status) { status.className = 'postcode-status loading'; status.textContent = 'Ophalen…'; }

  try {
    const url = `https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?q=${encodeURIComponent(pc)}+${encodeURIComponent(nr)}&fq=type:adres&fl=straatnaam,woonplaatsnaam&rows=1`;
    const res = await fetch(url);
    const data = await res.json();
    const doc = data?.response?.docs?.[0];
    if (doc?.straatnaam) {
      document.getElementById('p-street').value = doc.straatnaam;
      document.getElementById('p-city').value = doc.woonplaatsnaam || '';
      if (status) { status.className = 'postcode-status ok'; status.textContent = '✓ Adres gevonden'; }
    } else {
      if (status) { status.className = 'postcode-status err'; status.textContent = 'Adres niet gevonden. Vul handmatig in.'; }
    }
  } catch {
    if (status) { status.className = 'postcode-status err'; status.textContent = 'Ophalen mislukt. Vul handmatig in.'; }
  }

  btn.disabled = false;
  btn.textContent = '🔍 Opzoeken';
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
        <div class="social-location-label">${COURSE_ICONS[course]} ${COURSE_LABELS[course]}</div>
        <div class="social-location-fields">
          <select onchange="onSocialHostTypeChange('${course}', this.value)">
            <option value="">– Locatie onbekend / later invullen –</option>
            <option value="participant" ${!isCustom && selectedId ? 'selected' : ''}>Deelnemer als gastheer</option>
            <option value="custom" ${isCustom ? 'selected' : ''}>Aangepast adres</option>
          </select>
          <select id="social-participant-${course}" style="display:${!isCustom && selectedId ? 'block' : 'none'}"
            onchange="onSocialParticipantChange('${course}', this.value)">
            <option value="">Selecteer deelnemer…</option>
            ${participantOptions}
          </select>
          <div class="social-location-addr ${isCustom ? 'visible' : ''}" id="social-custom-${course}">
            <input type="text" placeholder="Naam / omschrijving" value="${current?.customName || ''}"
              oninput="onSocialCustomChange('${course}', 'customName', this.value)">
            <input type="text" placeholder="Straat + nr" value="${current?.customAddress?.street || ''}"
              oninput="onSocialCustomChange('${course}', 'street', this.value)">
            <input type="text" placeholder="Postcode" value="${current?.customAddress?.postcode || ''}"
              oninput="onSocialCustomChange('${course}', 'postcode', this.value)" style="max-width:90px">
            <input type="text" placeholder="Woonplaats" value="${current?.customAddress?.city || ''}"
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
  const groups = getStoredGroups();
  document.getElementById('list-modal-title').textContent = '💾 Deelnemersgroep opslaan';
  document.getElementById('list-modal-body').innerHTML = `
    <div class="list-modal-save-row">
      <input type="text" id="save-group-name" placeholder="Naam voor deze groep (bijv. 'Editie 2026')" value="">
      <button class="btn-primary" onclick="confirmSaveGroup()">Opslaan</button>
    </div>
    <p class="hint">Bestaande groepen (klik om naam over te nemen):</p>
    ${Object.keys(groups).length ? Object.entries(groups).map(([name, g]) => `
      <div class="list-modal-item" data-group-name="${escapeHtml(name)}" onclick="document.getElementById('save-group-name').value=this.dataset.groupName">
        <div class="list-modal-item-name">${escapeHtml(name)}</div>
        <div class="list-modal-item-meta">${g.participants?.length || 0} deelnemers · ${escapeHtml(g.savedAt || '')}</div>
        <button class="btn-danger btn-small" onclick="event.stopPropagation();deleteGroup(this.closest('[data-group-name]').dataset.groupName)">🗑️</button>
      </div>`).join('') : '<p class="list-modal-empty">Geen opgeslagen groepen.</p>'}`;
  document.getElementById('list-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('save-group-name').focus(), 50);
}

function confirmSaveGroup() {
  const name = document.getElementById('save-group-name').value.trim();
  if (!name) { alert('Voer een naam in.'); return; }
  const groups = getStoredGroups();
  groups[name] = { participants: state.participants, savedAt: new Date().toLocaleDateString('nl-NL') };
  localStorage.setItem(STORAGE_GROUPS, JSON.stringify(groups));
  closeListModal();
  alert(`Groep "${name}" opgeslagen!`);
}

function deleteGroup(name) {
  if (!confirm(`Groep "${name}" verwijderen?`)) return;
  const groups = getStoredGroups();
  delete groups[name];
  localStorage.setItem(STORAGE_GROUPS, JSON.stringify(groups));
  showSaveGroupModal();
}

function showLoadGroupModal() {
  const groups = getStoredGroups();
  document.getElementById('list-modal-title').textContent = '📂 Deelnemersgroep laden';
  document.getElementById('list-modal-body').innerHTML = Object.keys(groups).length
    ? Object.entries(groups).map(([name, g]) => `
        <div class="list-modal-item" data-group-name="${escapeHtml(name)}">
          <div>
            <div class="list-modal-item-name">${escapeHtml(name)}</div>
            <div class="list-modal-item-meta">${g.participants?.length || 0} deelnemers · opgeslagen ${escapeHtml(g.savedAt || '')}</div>
          </div>
          <button class="btn-primary btn-small" onclick="confirmLoadGroup(this.closest('[data-group-name]').dataset.groupName)">Laden</button>
          <button class="btn-danger btn-small" onclick="deleteGroup(this.closest('[data-group-name]').dataset.groupName);showLoadGroupModal()">🗑️</button>
        </div>`).join('')
    : '<p class="list-modal-empty">Geen opgeslagen groepen. Sla eerst een groep op via "Groep opslaan".</p>';
  document.getElementById('list-modal').style.display = 'flex';
}

function confirmLoadGroup(name) {
  if (!confirm(`Groep "${name}" laden? De huidige deelnemers worden vervangen.`)) return;
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
  if (!confirm(`Alle ${state.participants.length} deelnemers verwijderen? Dit kan niet ongedaan worden gemaakt.`)) return;
  state.participants = [];
  state.planning = null;
  state.nextId = 1;
  renderParticipantsList();
}

// ---- Planning Snapshots ----
function savePlanningSnapshot() {
  if (!state.planning) { alert('Genereer eerst een planning in stap 3.'); return; }
  const name = prompt('Naam voor deze momentopname:', `Planning ${new Date().toLocaleDateString('nl-NL')}`);
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
  alert(`Momentopname "${name}" opgeslagen!`);
}

function showLoadSnapshotModal() {
  const snapshots = getStoredSnapshots();
  document.getElementById('list-modal-title').textContent = '📂 Momentopname laden';
  document.getElementById('list-modal-body').innerHTML = Object.keys(snapshots).length
    ? Object.entries(snapshots).map(([name, s]) => `
        <div class="list-modal-item" data-snapshot-name="${escapeHtml(name)}">
          <div>
            <div class="list-modal-item-name">${escapeHtml(name)}</div>
            <div class="list-modal-item-meta">${s.participants?.length || 0} deelnemers · ${escapeHtml(s.savedAt || '')}</div>
          </div>
          <button class="btn-primary btn-small" onclick="confirmLoadSnapshot(this.closest('[data-snapshot-name]').dataset.snapshotName)">Laden</button>
          <button class="btn-danger btn-small" onclick="deleteSnapshot(this.closest('[data-snapshot-name]').dataset.snapshotName)">🗑️</button>
        </div>`).join('')
    : '<p class="list-modal-empty">Geen opgeslagen momentopnames.</p>';
  document.getElementById('list-modal').style.display = 'flex';
}

function deleteSnapshot(name) {
  if (!confirm(`Momentopname "${name}" verwijderen?`)) return;
  const snapshots = getStoredSnapshots();
  delete snapshots[name];
  localStorage.setItem(STORAGE_SNAPSHOTS, JSON.stringify(snapshots));
  showLoadSnapshotModal();
}

function confirmLoadSnapshot(name) {
  if (!confirm(`Momentopname "${name}" laden? De huidige staat wordt overschreven.`)) return;
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
const TEMPLATE_HEADERS = [
  'Naam persoon 1*', 'Naam partner', 'Postcode*', 'Huisnummer*', 'Straatnaam', 'Woonplaats',
  'Gastrol voorkeur',
  'Beschikb. P1: voorborrel', 'Beschikb. P1: voorgerecht', 'Beschikb. P1: hoofdgerecht', 'Beschikb. P1: nagerecht', 'Beschikb. P1: naborrel',
  'Beschikb. partner: voorborrel', 'Beschikb. partner: voorgerecht', 'Beschikb. partner: hoofdgerecht', 'Beschikb. partner: nagerecht', 'Beschikb. partner: naborrel',
  'Dieetwensen persoon 1', 'Dieetwensen partner',
  'Wil graag samen met', 'Wil NIET samen met'
];

const TEMPLATE_EXAMPLE = [
  'Jan de Vries', 'Marie de Vries', '1015AB', '45', 'Keizersgracht', 'Amsterdam',
  'voorgerecht',
  'ja', 'ja', 'ja', 'ja', 'ja',
  'ja', 'ja', 'ja', 'nee', 'nee',
  '', 'vegetarisch',
  '', ''
];

const INSTRUCTIES_ROWS = [
  ['Kolom', 'Verplicht', 'Uitleg', 'Geldige waarden'],
  ['Naam persoon 1', 'Ja', 'Volledige naam van de eerste persoon', ''],
  ['Naam partner', 'Nee', 'Volledige naam van de partner (leeglaten indien geen partner)', ''],
  ['Postcode', 'Ja', 'Postcode zonder spatie', 'bijv. 1015AB'],
  ['Huisnummer', 'Ja', 'Alleen het huisnummer (inclusief toevoeging)', 'bijv. 45 of 45A'],
  ['Straatnaam', 'Nee', 'Wordt automatisch gevuld via postcode indien leeg', ''],
  ['Woonplaats', 'Nee', 'Wordt automatisch gevuld via postcode indien leeg', ''],
  ['Gastrol voorkeur', 'Nee', 'Bij welk gerecht wil de persoon gastheer/vrouw zijn?', 'voorborrel / voorgerecht / hoofdgerecht / nagerecht / naborrel / leeg'],
  ['Beschikb. P1: *', 'Nee', 'Is persoon 1 aanwezig bij dit onderdeel?', 'ja / nee  (leeg = ja)'],
  ['Beschikb. partner: *', 'Nee', 'Is de partner aanwezig bij dit onderdeel?', 'ja / nee  (leeg = ja)'],
  ['Dieetwensen persoon 1', 'Nee', 'Allergieën of dieetwensen van persoon 1', 'Vrije tekst'],
  ['Dieetwensen partner', 'Nee', 'Allergieën of dieetwensen van de partner', 'Vrije tekst'],
  ['Wil graag samen met', 'Nee', 'Namen van personen waarmee men graag aan tafel zit (komma-gescheiden)', 'bijv. Lisa Jansen, Thomas Smit'],
  ['Wil NIET samen met', 'Nee', 'Namen van personen waarmee men NIET aan tafel wil (komma-gescheiden)', 'bijv. Kevin Peters'],
  [],
  ['LET OP: Verwijder de voorbeeldrij (rij 2 in het Deelnemers-tabblad) vóór het importeren!'],
];

function downloadTemplate() {
  if (typeof XLSX === 'undefined') {
    alert('Excel-bibliotheek nog niet geladen. Controleer de internetverbinding en probeer opnieuw.');
    return;
  }

  const wb = XLSX.utils.book_new();

  // Sheet 1: Deelnemers
  const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, TEMPLATE_EXAMPLE]);
  ws['!cols'] = TEMPLATE_HEADERS.map(h => ({ wch: Math.max(h.length + 2, 14) }));

  // Style header row (bold + blue background) – basic cell metadata
  const headerRange = XLSX.utils.decode_range(ws['!ref']);
  for (let c = headerRange.s.c; c <= headerRange.e.c; c++) {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c });
    if (!ws[cellRef]) continue;
    ws[cellRef].s = { font: { bold: true }, fill: { fgColor: { rgb: 'C7D9F0' } } };
  }

  XLSX.utils.book_append_sheet(wb, ws, 'Deelnemers');

  // Sheet 2: Instructies
  const wsI = XLSX.utils.aoa_to_sheet(INSTRUCTIES_ROWS);
  wsI['!cols'] = [{ wch: 30 }, { wch: 10 }, { wch: 55 }, { wch: 55 }];
  XLSX.utils.book_append_sheet(wb, wsI, 'Instructies');

  XLSX.writeFile(wb, 'running-dinner-deelnemers-sjabloon.xlsx');
}

function importParticipantsFromFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (typeof XLSX === 'undefined') {
    showImportStatus('error', 'Excel-bibliotheek niet geladen. Controleer de internetverbinding.');
    return;
  }

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      // Use first sheet named 'Deelnemers', or fall back to first sheet
      const sheetName = wb.SheetNames.includes('Deelnemers') ? 'Deelnemers' : wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      if (rows.length < 2) {
        showImportStatus('error', 'Het bestand heeft geen gegevens (minstens een kopregel en één dataregel vereist).');
        event.target.value = '';
        return;
      }

      // Row 0 = headers, rows 1+ = data (skip rows where name1 is empty)
      const dataRows = rows.slice(1).filter(r => String(r[0] || '').trim() !== '');
      const avBool = val => String(val).trim().toLowerCase() !== 'nee' && String(val).trim() !== '0';
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
      showImportStatus('ok', `✓ ${added} deelnemer(s) succesvol geïmporteerd${skipped ? ` (${skipped} overgeslagen)` : ''}.`);
    } catch (err) {
      showImportStatus('error', `Importeren mislukt: ${err.message}`);
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

// ---- Keyboard: Escape closes modals ----
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.getElementById('participant-modal').style.display === 'flex') {
      closeParticipantModal();
    } else if (document.getElementById('list-modal').style.display === 'flex') {
      closeListModal();
    }
  }
});

// ---- Init ----
function init() {
  initStep1();
  updateHostPreferenceOptions();

  // Add sample data button only in dev mode (?dev in URL)
  if (new URLSearchParams(location.search).has('dev')) {
    const devBtn = document.createElement('button');
    devBtn.className = 'btn-secondary btn-small';
    devBtn.textContent = '📋 Laad voorbeelddata';
    devBtn.style.marginLeft = 'auto';
    devBtn.onclick = loadSampleData;
    document.querySelector('.participants-header').appendChild(devBtn);
  }
}

document.addEventListener('DOMContentLoaded', init);
