// 02-participants.js — Stap 2: deelnemersbeheer en geforceerde combinaties.
// Laadvolgorde staat in lib/planner-files.js (manifest voor
// index.html, server-allowlist en tests). Klassieke scripts,
// geen modules: functies zijn globaal over de delen heen.
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

    const p1avail = participant ? participant.availability[course]?.person1 !== false : true;
    const p2avail = participant ? participant.availability[course]?.person2 !== false : true;
    const p3avail = participant ? participant.availability[course]?.person3 !== false : true;

    row.innerHTML = `
      <span class="availability-course-name">${COURSE_ICONS[course]} ${getCourseLabel(course)}</span>
      <div class="availability-checks">
        <label class="availability-check">
          <input type="checkbox" name="avail-${course}-p1" ${p1avail ? 'checked' : ''}> ${I18n.t('app.modal.person1', 'Persoon 1')}
        </label>
        <label class="availability-check" id="avail-partner-${course}">
          <input type="checkbox" name="avail-${course}-p2" ${p2avail ? 'checked' : ''}> ${I18n.t('app.modal.partner', 'Partner')}
        </label>
        <label class="availability-check" id="avail-extra-${course}">
          <input type="checkbox" name="avail-${course}-p3" ${p3avail ? 'checked' : ''}> ${I18n.t('app.modal.extra_person', 'Meereiziger')}
        </label>
      </div>`;
    grid.appendChild(row);
  });

  // Hide partner / meereiziger rows als die velden leeg zijn
  togglePartnerAvailability();
}

function togglePartnerAvailability() {
  const name2 = document.getElementById('p-name2');
  const name3 = document.getElementById('p-name3');
  const hasPartner = !!(name2 && name2.value.trim());
  const hasExtra   = !!(name3 && name3.value.trim());
  const courses = getActiveCourses();
  courses.forEach(course => {
    const el2 = document.getElementById('avail-partner-' + course);
    if (el2) el2.style.display = hasPartner ? 'flex' : 'none';
    const el3 = document.getElementById('avail-extra-' + course);
    if (el3) el3.style.display = hasExtra ? 'flex' : 'none';
  });
  const diet2 = document.getElementById('diet2-group');
  if (diet2) diet2.style.display = hasPartner ? 'flex' : 'none';
  const diet3 = document.getElementById('diet3-group');
  if (diet3) diet3.style.display = hasExtra ? 'flex' : 'none';
}

function openAddParticipant(id) {
  if (window.RDA_DEMO?.isActive?.()) { window.RDA_DEMO.showPaywall('paywall_edit'); return; }
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
    const name3El = document.getElementById('p-name3');
    if (name3El) name3El.value = participant.name3 || '';
    document.getElementById('p-street').value = participant.address.street;
    document.getElementById('p-housenumber').value = participant.address.housenumber || '';
    document.getElementById('p-postcode').value = participant.address.postcode;
    document.getElementById('p-city').value = participant.address.city;
    document.getElementById('p-host-preference').value = participant.hostPreference || '';
    const minEl = document.getElementById('p-custom-min');
    if (minEl) minEl.value = Number.isFinite(participant.customMinGuests) ? participant.customMinGuests : '';
    const maxEl = document.getElementById('p-custom-max');
    if (maxEl) maxEl.value = Number.isFinite(participant.customMaxGuests) ? participant.customMaxGuests : '';
    document.getElementById('p-diet1').value = participant.diet1 || '';
    document.getElementById('p-diet2').value = participant.diet2 || '';
    const diet3El = document.getElementById('p-diet3');
    if (diet3El) diet3El.value = participant.diet3 || '';
    document.getElementById('p-prefer-with').value = (participant.preferWith || []).join(', ');
    document.getElementById('p-avoid').value = (participant.avoid || []).join(', ');
  } else {
    document.getElementById('modal-title').textContent = I18n.t('app.modal.add_participant', 'Deelnemer toevoegen');
    document.getElementById('participant-id').value = '';
  }

  updateHostPreferenceOptions();
  buildAvailabilityGrid(participant);

  // Rebuild availability als partner of meereiziger ingevuld wordt
  const name2El = document.getElementById('p-name2');
  name2El.removeEventListener('input', togglePartnerAvailability);
  name2El.addEventListener('input', togglePartnerAvailability);
  const name3El2 = document.getElementById('p-name3');
  if (name3El2) {
    name3El2.removeEventListener('input', togglePartnerAvailability);
    name3El2.addEventListener('input', togglePartnerAvailability);
  }

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
    const p3El = document.querySelector(`input[name="avail-${course}-p3"]`);
    availability[course] = {
      person1: p1El ? p1El.checked : true,
      person2: p2El ? p2El.checked : true,
      person3: p3El ? p3El.checked : true
    };
  });

  const idVal = document.getElementById('participant-id').value;
  const street = document.getElementById('p-street').value.trim();
  const housenumber = document.getElementById('p-housenumber').value.trim();
  const postcode = document.getElementById('p-postcode').value.trim();
  const city = document.getElementById('p-city').value.trim();

  const _parseCapacity = (el) => {
    const raw = (el?.value || '').trim();
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return (Number.isFinite(n) && n > 0) ? n : null;
  };

  const customMin = _parseCapacity(document.getElementById('p-custom-min'));
  const customMax = _parseCapacity(document.getElementById('p-custom-max'));
  if (customMin !== null && customMax !== null && customMin > customMax) {
    alert(I18n.t('app.alert.min_above_max',
      'Het minimum aantal gasten kan niet hoger zijn dan het maximum.'));
    return;
  }

  const data = {
    name1: document.getElementById('p-name1').value.trim(),
    name2: document.getElementById('p-name2').value.trim() || null,
    name3: (document.getElementById('p-name3')?.value || '').trim() || null,
    address: {
      street,
      housenumber,
      postcode,
      city,
      full: `${street} ${housenumber}, ${postcode} ${city}`
    },
    availability,
    hostPreference: document.getElementById('p-host-preference').value || null,
    customMinGuests: customMin,
    customMaxGuests: customMax,
    diet1: document.getElementById('p-diet1').value.trim() || null,
    diet2: document.getElementById('p-diet2').value.trim() || null,
    diet3: (document.getElementById('p-diet3')?.value || '').trim() || null,
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
  if (window.RDA_DEMO?.isActive?.()) { window.RDA_DEMO.showPaywall('paywall_edit'); return; }
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
    const initials = escapeHtml(initialsOf(p));
    const fullName = displayNameSafe(p);
    const tags = [];
    if (p.hostPreference) tags.push(`<span class="tag tag-host">${COURSE_ICONS[p.hostPreference]} ${I18n.t('app.participants.host_label', 'Host')}: ${getCourseLabel(p.hostPreference)}</span>`);
    const diets = dietsOf(p);
    if (diets) tags.push(`<span class="tag tag-diet">🥦 ${escapeHtml(diets)}</span>`);
    if (p.name3) tags.push(`<span class="tag tag-extra">👤 ${I18n.t('app.participants.with_extra', 'Met meereiziger')}</span>`);
    if (Number.isFinite(p.customMinGuests) || Number.isFinite(p.customMaxGuests)) {
      const min = Number.isFinite(p.customMinGuests) ? p.customMinGuests : '–';
      const max = Number.isFinite(p.customMaxGuests) ? p.customMaxGuests : '–';
      tags.push(`<span class="tag tag-capacity">📐 ${I18n.t('app.participants.custom_capacity', 'Capaciteit')}: ${min}–${max}</span>`);
    }

    const courses = getActiveCourses();
    const unavailable = courses.filter(c => {
      const av = p.availability[c];
      if (!av) return false;
      return !av.person1 || (p.name2 && !av.person2) || (p.name3 && !av.person3);
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
          <button class="btn-secondary btn-small" data-action="openAddParticipant" data-arg="${p.id}">✏️ ${I18n.t('app.participants.edit_btn', 'Bewerken')}</button>
          <button class="btn-danger btn-small" data-action="deleteParticipant" data-arg="${p.id}">🗑️</button>
        </div>
      </div>`;
  }).join('');
}

// ---- Forced Combos ----
function addForcedCombo() {
  if (window.RDA_DEMO?.isActive?.()) { window.RDA_DEMO.showPaywall('paywall_edit'); return; }
  const id = Date.now();
  state.forcedCombos.push({ id, person1: '', person2: '', courses: [] });
  renderForcedCombos();
}

function removeForcedCombo(id) {
  if (window.RDA_DEMO?.isActive?.()) { window.RDA_DEMO.showPaywall('paywall_edit'); return; }
  state.forcedCombos = state.forcedCombos.filter(fc => fc.id !== id);
  renderForcedCombos();
}

function renderForcedCombos() {
  const list = document.getElementById('forced-combos-list');
  if (state.forcedCombos.length === 0) {
    list.innerHTML = '';
    return;
  }

  const names = state.participants.flatMap(p => [p.name1, p.name2, p.name3].filter(Boolean));
  const activeCourses = getActiveCourses();
  const hostCourses = activeCourses.filter(c => c === 'voorgerecht' || c === 'hoofdgerecht' || c === 'nagerecht');

  list.innerHTML = state.forcedCombos.map(fc => {
    // Backward-compat: bestaande combos zonder courses-veld → []  (= alle gangen)
    const selectedCourses = Array.isArray(fc.courses) ? fc.courses : [];
    const allCoursesMode = selectedCourses.length === 0;

    const courseChips = hostCourses.map(c => {
      const checked = selectedCourses.includes(c);
      const icon = COURSE_ICONS[c] || '';
      return `<label class="forced-combo-course ${checked ? 'is-active' : ''}">
        <input type="checkbox" ${checked ? 'checked' : ''} data-change="toggleForcedComboCourse" data-id="${fc.id}" data-course="${c}">
        <span>${icon} ${escapeHtml(getCourseLabel(c))}</span>
      </label>`;
    }).join('');

    const scopeHint = allCoursesMode
      ? I18n.t('app.forcedcombos.scope_all', 'Bij alle gangen samen')
      : I18n.t('app.forcedcombos.scope_some', 'Alleen bij geselecteerde gangen');

    return `
      <div class="forced-combo-item">
        <div class="forced-combo-row">
          <select data-change="updateForcedCombo" data-id="${fc.id}" data-field="person1">
            <option value="">${I18n.t('app.participants.select_person1', 'Selecteer persoon 1...')}</option>
            ${names.map(n => `<option value="${escapeHtml(n)}" ${fc.person1 === n ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}
          </select>
          <span>${I18n.t('app.participants.always_together', 'altijd samen met')}</span>
          <select data-change="updateForcedCombo" data-id="${fc.id}" data-field="person2">
            <option value="">${I18n.t('app.participants.select_person2', 'Selecteer persoon 2...')}</option>
            ${names.map(n => `<option value="${escapeHtml(n)}" ${fc.person2 === n ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}
          </select>
          <button class="btn-danger btn-small" data-action="removeForcedCombo" data-arg="${fc.id}">✕</button>
        </div>
        <div class="forced-combo-scope">
          <span class="forced-combo-scope-label">${escapeHtml(scopeHint)}:</span>
          ${courseChips}
        </div>
      </div>`;
  }).join('');
}

function updateForcedCombo(id, field, value) {
  const fc = state.forcedCombos.find(f => f.id === id);
  if (fc) fc[field] = value;
}

function toggleForcedComboCourse(id, course, isChecked) {
  const fc = state.forcedCombos.find(f => f.id === id);
  if (!fc) return;
  if (!Array.isArray(fc.courses)) fc.courses = [];
  if (isChecked) {
    if (!fc.courses.includes(course)) fc.courses.push(course);
  } else {
    fc.courses = fc.courses.filter(c => c !== course);
  }
  renderForcedCombos();
  state.planning = null; // invalidate planning
}

