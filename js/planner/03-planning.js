// 03-planning.js — Stap 3: planningsalgoritme, drag-and-drop en afstandscheck.
// Laadvolgorde staat in lib/planner-files.js (manifest voor
// index.html, server-allowlist en tests). Klassieke scripts,
// geen modules: functies zijn globaal over de delen heen.
// ---- Step 3: Planning Algorithm ----

/**
 * Main planning algorithm.
 * For each hosting course, assigns a host and fills their table with guests
 * maximizing unique tablemate encounters across all courses.
 */
function generatePlanning(participantOrder) {
  const courses = getActiveCourses();
  const hostCourses = ['voorgerecht', 'hoofdgerecht', 'nagerecht']; // only these have home hosts
  // Optionele alternatieve volgorde (voor "opnieuw genereren") — de zichtbare
  // deelnemerslijst in state blijft daarbij ongemoeid.
  const participants = participantOrder || state.participants;

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
  // Shuffle een KOPIE voor een ander resultaat; voorheen werd state.participants
  // zelf geschud, waardoor de volgorde in de deelnemerslijst zichtbaar
  // versprong bij elke hergeneratie.
  const shuffled = [...state.participants];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  generatePlanning(shuffled);
}

function assignHosts(participants, hostCourses, warnings) {
  const assignments = {};
  const alreadyHost = new Set(); // each participant can only host once

  hostCourses.forEach(course => {
    // Gastheer kan iedereen zijn van wie tenminste één persoon thuis is.
    const available = participants.filter(
      p => personSeatsAt(p, course) > 0 && !alreadyHost.has(p.id));

    const preferred = available.filter(p => p.hostPreference === course);
    const others    = available.filter(p => p.hostPreference !== course);

    // Totaal aantal personen dat deze gang meedoet (per persoon geteld, dus
    // een koppel waarvan er één afhaakt telt hier voor 1).
    const totalSlots = participants
      .reduce((sum, p) => sum + personSeatsAt(p, course), 0);

    // maxTableSize = max GUESTS (not counting host).
    // Each table seats: 1 host-slot + maxGuests guest-slots → maxGuests+1 slots total.
    // So baseTables ≈ ceil(totalSlots / (maxGuests + 1)).
    const maxGuests = state.config.maxTableSize;
    const baseTables = Math.max(1, Math.ceil(totalSlots / (maxGuests + 1)));

    // Hosts kiezen tot er genoeg WERKELIJKE capaciteit is. De baseline-schatting
    // gaat uit van de globale max, maar een host kan een eigen (kleinere of
    // grotere) customMaxGuests hebben. Zonder deze check zouden bij meerdere
    // krappe hosts te weinig tafels ontstaan en zou fillTables gasten alsnog op
    // een volle tafel moeten dumpen.
    const pool = [...preferred, ...others];
    const hosts = [];
    let capacity = 0; // host-stoelen + gasten-capaciteit van de gekozen hosts
    while (pool.length > 0 && (hosts.length < baseTables || capacity < totalSlots)) {
      const host = pool.shift();
      hosts.push(host);
      alreadyHost.add(host.id);
      capacity += personSeatsAt(host, course) + hostMaxGuests(host);
    }

    if (capacity < totalSlots) {
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
    hostName: displayNameAt(host, course),
    address: host.address,
    guestIds: [],
    guestNames: []
  }));

  const hostIds = new Set(hosts.map(h => h.id));
  // Alleen entries waarvan iemand deze gang meedoet. Een koppel waarvan
  // persoon 1 afhaakt maar de partner wél komt, hoort er dus gewoon bij.
  const guests = participants.filter(p => !hostIds.has(p.id) && personSeatsAt(p, course) > 0);

  // Per-tafel max/min: een host kan zelf customMaxGuests/customMinGuests zetten
  // (bv. kleine eetkamer = max 2). Fallback op state.config-default.
  const tableMax = (t) => hostMaxGuests(pMap.get(t.hostId));
  const tableMin = (t) => hostMinGuests(pMap.get(t.hostId));

  // Count occupied guest-seats at a table (koppels = 2, met meereiziger = 3, host excluded)
  const guestSeats = (t) => t.guestIds.reduce((sum, gid) => {
    const g = pMap.get(gid);
    return sum + (g ? personSeatsAt(g, course) : 1);
  }, 0);

  // Seats a participant occupies (1, 2 or 3)
  const personSeats = (p) => personSeatsAt(p, course);

  // Sort guests by total unique tablemates seen so far (fewest = most variety to gain)
  const sortedGuests = [...guests].sort((a, b) =>
    (tableMateHistory[a.id]?.size ?? 0) - (tableMateHistory[b.id]?.size ?? 0)
  );

  const forcedGroups = buildForcedGroups(state.forcedCombos, participants);

  sortedGuests.forEach(guest => {
    const forcedTable = findForcedTable(guest.id, forcedGroups, tables, participants, course);
    let targetTable;

    if (forcedTable !== null) {
      targetTable = forcedTable;
    } else {
      const seats = personSeats(guest);
      // Only consider tables that still have room (max per-host)
      const candidates = tables.filter(t => guestSeats(t) + seats <= tableMax(t));

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
            const p = participants.find(x => x.name1 === name || x.name2 === name || x.name3 === name);
            return p && (tbl.hostId === p.id || tbl.guestIds.includes(p.id));
          }) ? 100 : 0;
          const preferBonus = (tbl) => (guest.preferWith || []).some(name => {
            const p = participants.find(x => x.name1 === name || x.name2 === name || x.name3 === name);
            return p && (tbl.hostId === p.id || tbl.guestIds.includes(p.id));
          }) ? -5 : 0;

          const scoreT    = fillT    + overlapT    + avoidPenalty(t)    + preferBonus(t);
          const scoreBest = fillBest + overlapBest + avoidPenalty(best) + preferBonus(best);
          return scoreT <= scoreBest ? t : best;
        }, candidates[0]);
      }
    }

    targetTable.guestIds.push(guest.id);
    targetTable.guestNames.push(displayNameAt(guest, course));
  });

  // Warn on underfilled tables (per-host min)
  tables.forEach(t => {
    const count = guestSeats(t);
    const minForThis = tableMin(t);
    if (count < minForThis) {
      // hostName is door de gebruiker aangeleverd (handmatig of via Excel-import)
      // en waarschuwingen worden als HTML gerenderd → hier escapen.
      warnings.push(I18n.t('app.warning.table_underfilled_prefix', 'Tafel van') + ` ${escapeHtml(t.hostName)} ` + I18n.t('app.warning.table_underfilled_at', 'bij') + ` ${getCourseLabel(course)} ` + I18n.t('app.warning.table_underfilled_suffix', 'heeft slechts') + ` ${count} ` + I18n.t('app.warning.guests', 'gast(en)') + ` (${I18n.t('app.warning.guideline_min', 'richtlijn minimum')}: ${minForThis}).`);
    }
  });

  return tables;
}

function countSeats(table, participants) {
  // Aantal personen aan tafel incl. host (voor weergave). Gebruikt dezelfde
  // beschikbaarheids-logica als het algoritme, zodat het getoonde aantal
  // stoelen klopt met waar fillTables mee gerekend heeft.
  const pMap = new Map(participants.map(p => [p.id, p]));
  const seatsOf = (p) => {
    if (!p) return 0;
    return table.course ? personSeatsAt(p, table.course)
                        : 1 + (p.name2 ? 1 : 0) + (p.name3 ? 1 : 0);
  };
  let n = seatsOf(pMap.get(table.hostId));
  table.guestIds.forEach(gid => { n += seatsOf(pMap.get(gid)); });
  return n;
}

function countOverlap(guestId, table, history) {
  let count = 0;
  if (history[guestId]?.has(table.hostId)) count++;
  table.guestIds.forEach(id => { if (history[guestId]?.has(id)) count++; });
  return count;
}

function buildForcedGroups(combos, participants) {
  // Geeft array van { ids: [p1, p2], courses: [...] } terug.
  // courses = [] betekent "alle gangen" (backward-compat).
  return combos.map(fc => {
    const p1 = participants.find(p => p.name1 === fc.person1 || p.name2 === fc.person1 || p.name3 === fc.person1);
    const p2 = participants.find(p => p.name1 === fc.person2 || p.name2 === fc.person2 || p.name3 === fc.person2);
    if (p1 && p2) return { ids: [p1.id, p2.id], courses: Array.isArray(fc.courses) ? fc.courses : [] };
    return null;
  }).filter(Boolean);
}

function findForcedTable(guestId, forcedGroups, tables, participants, currentCourse) {
  // Find if this guest has a forced partner already placed somewhere,
  // and only honor the combo if the current course is in scope.
  for (const group of forcedGroups) {
    if (!group.ids.includes(guestId)) continue;
    // Scope-check: lege courses-array = alle gangen, anders alleen geselecteerde
    if (group.courses.length > 0 && !group.courses.includes(currentCourse)) continue;
    const partner = group.ids.find(id => id !== guestId);
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
      hostName = displayNameAt(host, course);
      address = host.address;
    }
  } else if (hostConfig?.customName) {
    hostName = hostConfig.customName;
    address = hostConfig.customAddress;
  }

  // Ook bij een borrel telt beschikbaarheid: wie deze aanvinkt overslaat,
  // hoort niet op de lijst van de gastheer te staan.
  const attending = participants.filter(p => personSeatsAt(p, course) > 0);

  return [{
    id: course + '-0',
    course,
    hostId,
    hostName,
    address,
    isSocial: true,
    guestIds: attending.map(p => p.id),
    guestNames: attending.map(p => displayNameAt(p, course))
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
    // Dedupe: "tafel vol" wordt per onplaatsbare gast gepusht en zou anders
    // meerdere identieke regels opleveren.
    const unique = [...new Set(warnings)];
    warnEl.style.display = 'block';
    warnEl.innerHTML = `<h4>⚠️ ${I18n.t('app.planning.attention_points', 'Aandachtspunten')}</h4><ul>${unique.map(w => `<li>${w}</li>`).join('')}</ul>`;
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
  const hostDiet = dietsOf(host);
  const seats = countSeats(table, participants);
  const addr = table.address
    ? `${escapeHtml(table.address.street)} ${escapeHtml(table.address.housenumber || '')}, ${escapeHtml(table.address.postcode)} ${escapeHtml(table.address.city)}`
    : '';

  return `
    <div class="table-card dnd-table" id="dnd-${table.id}"
         data-drop-table="${table.id}" data-drop-course="${course}">
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
          const diet = dietsOf(g);
          return `
            <div class="table-guest guest-chip"
                 draggable="true"
                 data-drag-guest="${gid}" data-drag-table="${table.id}" data-drag-course="${course}">
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

// `el` is de drop-container; bij gedelegeerde events wijst currentTarget naar
// document, dus het element komt expliciet mee vanuit de dispatcher.
function onDragOver(event, el) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  el.classList.add('drag-over');
}

function onDragLeave(event, el) {
  if (!el.contains(event.relatedTarget)) {
    el.classList.remove('drag-over');
  }
}

function onDrop(event, targetTableId, targetCourse, el) {
  event.preventDefault();
  el.classList.remove('drag-over');
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

  // Capaciteitscheck: handmatig slepen mag de (per-host) max niet stilzwijgend
  // overschrijden. De organisator mag het bewust doen, maar wel geïnformeerd.
  if (!toTable.isSocial) {
    const pMap = new Map(state.participants.map(p => [p.id, p]));
    const occupied = toTable.guestIds.reduce((sum, gid) => {
      const g = pMap.get(gid);
      return sum + (g ? personSeatsAt(g, course) : 0);
    }, 0);
    const moving = personSeatsAt(pMap.get(personId), course);
    const max = hostMaxGuests(pMap.get(toTable.hostId));
    if (occupied + moving > max) {
      const msg = I18n.t('app.confirm.table_over_capacity',
        'Deze tafel zit dan boven het maximum aantal gasten') +
        ` (${occupied + moving}/${max}). ` +
        I18n.t('app.confirm.continue_anyway', 'Toch verplaatsen?');
      if (!confirm(msg)) return;
    }
  }

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
        <button class="btn-danger btn-small" data-action="undoAllChanges">↩ ${I18n.t('app.planning.undo_all', 'Alle ongedaan maken')}</button>
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
          <button class="btn-secondary btn-small" data-action="undoChange" data-arg="${c.id}">↩ ${I18n.t('app.planning.undo', 'Ongedaan')}</button>
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

