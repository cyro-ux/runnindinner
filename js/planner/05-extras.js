// 05-extras.js — Sociale locaties, groepenbeheer, snapshots, Excel-import/export, voorbeelddata.
// Laadvolgorde staat in lib/planner-files.js (manifest voor
// index.html, server-allowlist en tests). Klassieke scripts,
// geen modules: functies zijn globaal over de delen heen.
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
      `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${displayNameSafe(p)} – ${escapeHtml(p.address.street)} ${escapeHtml(p.address.housenumber || '')}</option>`
    ).join('');

    return `
      <div class="social-location-row">
        <div class="social-location-label">${COURSE_ICONS[course]} ${getCourseLabel(course)}</div>
        <div class="social-location-fields">
          <select data-change="socialHostType" data-course="${course}">
            <option value="">– ${I18n.t('app.social.unknown_location', 'Locatie onbekend / later invullen')} –</option>
            <option value="participant" ${!isCustom && selectedId ? 'selected' : ''}>${I18n.t('app.social.participant_host', 'Deelnemer als gastheer')}</option>
            <option value="custom" ${isCustom ? 'selected' : ''}>${I18n.t('app.social.custom_address', 'Aangepast adres')}</option>
          </select>
          <select id="social-participant-${course}" style="display:${!isCustom && selectedId ? 'block' : 'none'}"
            data-change="socialParticipant" data-course="${course}">
            <option value="">${I18n.t('app.social.select_participant', 'Selecteer deelnemer…')}</option>
            ${participantOptions}
          </select>
          <div class="social-location-addr ${isCustom ? 'visible' : ''}" id="social-custom-${course}">
            <input type="text" placeholder="${I18n.t('app.social.name_desc', 'Naam / omschrijving')}" value="${current?.customName || ''}"
              data-input="socialCustom" data-course="${course}" data-field="customName">
            <input type="text" placeholder="${I18n.t('app.social.street_nr', 'Straat + nr')}" value="${current?.customAddress?.street || ''}"
              data-input="socialCustom" data-course="${course}" data-field="street">
            <input type="text" placeholder="${I18n.t('app.social.postcode', 'Postcode')}" value="${current?.customAddress?.postcode || ''}"
              data-input="socialCustom" data-course="${course}" data-field="postcode" style="max-width:90px">
            <input type="text" placeholder="${I18n.t('app.social.city', 'Woonplaats')}" value="${current?.customAddress?.city || ''}"
              data-input="socialCustom" data-course="${course}" data-field="city">
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
      <button class="btn-primary" data-action="confirmSaveGroup">${I18n.t('app.modal.save', 'Opslaan')}</button>
    </div>
    <p class="hint">${I18n.t('app.groups.existing_groups', 'Bestaande groepen (klik om naam over te nemen)')}:</p>
    ${Object.keys(groups).length ? Object.entries(groups).map(([name, g]) => `
      <div class="list-modal-item" data-group-name="${escapeHtml(name)}" data-action="fillGroupName">
        <div class="list-modal-item-name">${escapeHtml(name)}</div>
        <div class="list-modal-item-meta">${g.participants?.length || 0} ${I18n.t('app.stats.participants', 'deelnemers')} · ${escapeHtml(g.savedAt || '')}</div>
        <button class="btn-danger btn-small" data-action="deleteGroup">🗑️</button>
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
          <button class="btn-primary btn-small" data-action="loadGroup">${I18n.t('app.groups.load_btn', 'Laden')}</button>
          <button class="btn-danger btn-small" data-action="deleteGroupAndRefresh">🗑️</button>
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
  if (window.RDA_DEMO?.isActive?.()) { window.RDA_DEMO.showPaywall('paywall_edit'); return; }
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
          <button class="btn-primary btn-small" data-action="loadSnapshot">${I18n.t('app.groups.load_btn', 'Laden')}</button>
          <button class="btn-danger btn-small" data-action="deleteSnapshot">🗑️</button>
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
    I18n.t('app.excel.avoid', 'Wil NIET samen met'),
    I18n.t('app.excel.name_extra', 'Naam meereiziger'),
    I18n.t('app.excel.avail_extra_voorborrel', 'Beschikb. meereiziger: voorborrel'),
    I18n.t('app.excel.avail_extra_voorgerecht', 'Beschikb. meereiziger: voorgerecht'),
    I18n.t('app.excel.avail_extra_hoofdgerecht', 'Beschikb. meereiziger: hoofdgerecht'),
    I18n.t('app.excel.avail_extra_nagerecht', 'Beschikb. meereiziger: nagerecht'),
    I18n.t('app.excel.avail_extra_naborrel', 'Beschikb. meereiziger: naborrel'),
    I18n.t('app.excel.diet_extra', 'Dieetwensen meereiziger'),
    I18n.t('app.excel.custom_min', 'Min. gasten als gastheer (optioneel)'),
    I18n.t('app.excel.custom_max', 'Max. gasten als gastheer (optioneel)')
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
    '', '',
    // Optioneel: meereiziger zonder eigen vervoer (laat leeg als niet van toepassing)
    '', '', '', '', '', '', '',
    // Optioneel: afwijkende gastheer-capaciteit (laat leeg = algemene instelling)
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
    [I18n.t('app.excel.instr_name_extra', 'Naam meereiziger'), no, I18n.t('app.excel.instr_name_extra_desc', 'Optioneel: naam van een alleenstaande die zonder eigen vervoer met dit koppel meereist. Hij/zij zit altijd aan dezelfde tafel.'), ''],
    [I18n.t('app.excel.instr_avail_extra', 'Beschikb. meereiziger: *'), no, I18n.t('app.excel.instr_avail_extra_desc', 'Is de meereiziger aanwezig bij dit onderdeel?'), I18n.t('app.excel.instr_yes_no', 'ja / nee  (leeg = ja)')],
    [I18n.t('app.excel.instr_diet_extra', 'Dieetwensen meereiziger'), no, I18n.t('app.excel.instr_diet_extra_desc', 'Allergieën of dieetwensen van de meereiziger'), I18n.t('app.excel.instr_free_text', 'Vrije tekst')],
    [I18n.t('app.excel.instr_custom_min', 'Min. gasten als gastheer'), no, I18n.t('app.excel.instr_custom_min_desc', 'Afwijkend minimum aantal gasten bij deze gastheer/vrouw (leeg = algemene instelling uit stap 1).'), I18n.t('app.excel.instr_custom_num_eg', 'bijv. 2')],
    [I18n.t('app.excel.instr_custom_max', 'Max. gasten als gastheer'), no, I18n.t('app.excel.instr_custom_max_desc', 'Afwijkend maximum aantal gasten bij deze gastheer/vrouw (leeg = algemene instelling). Handig bij kleine of juist grote ruimte.'), I18n.t('app.excel.instr_custom_num_eg', 'bijv. 2')],
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

        // Optionele meereiziger-kolommen aan het einde (backward compat: nieuwe
        // templates hebben cols 21–27, oude templates niet → undefined → leeg)
        const name3 = String(row[21] || '').trim() || null;
        const diet3 = String(row[27] || '').trim() || null;

        // Optionele afwijkende gastheer-capaciteit (cols 28–29)
        const _parseNum = v => {
          const s = String(v || '').trim();
          if (!s) return null;
          const n = parseInt(s, 10);
          return (Number.isFinite(n) && n > 0) ? n : null;
        };
        const customMinGuests = _parseNum(row[28]);
        const customMaxGuests = _parseNum(row[29]);

        // Availability columns 7–11 (P1), 12–16 (partner), 22–26 (meereiziger)
        const availability = {};
        allCourses.forEach((c, i) => {
          availability[c] = {
            person1: avBool(row[7 + i] !== '' ? row[7 + i] : 'ja'),
            person2: name2 ? avBool(row[12 + i] !== '' ? row[12 + i] : 'ja') : false,
            person3: name3 ? avBool(row[22 + i] !== '' ? row[22 + i] : 'ja') : false
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
          name3,
          address: {
            street,
            housenumber,
            postcode,
            city,
            full: `${street}${housenumber ? ' ' + housenumber : ''}, ${postcode} ${city}`.trim()
          },
          availability,
          hostPreference: validHostPrefs.includes(hostPref) ? hostPref : null,
          customMinGuests,
          customMaxGuests,
          diet1,
          diet2,
          diet3,
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
    courses.forEach(c => { availability[c] = { person1: true, person2: true, person3: true }; });

    state.participants.push({
      id: state.nextId++,
      name1: sp.name1,
      name2: sp.name2,
      name3: sp.name3 || null,
      address: {
        street: sp.street,
        housenumber: sp.housenumber,
        postcode: sp.postcode,
        city: sp.city,
        full: `${sp.street} ${sp.housenumber}, ${sp.postcode} ${sp.city}`
      },
      availability,
      hostPreference: sp.hostPref || null,
      customMinGuests: Number.isFinite(sp.customMinGuests) ? sp.customMinGuests : null,
      customMaxGuests: Number.isFinite(sp.customMaxGuests) ? sp.customMaxGuests : null,
      diet1: sp.diet1 || null,
      diet2: sp.diet2 || null,
      diet3: sp.diet3 || null,
      preferWith: [],
      avoid: []
    });
  });

  renderParticipantsList();
}

