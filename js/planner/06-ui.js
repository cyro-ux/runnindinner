// 06-ui.js — Rating, toetsenbord, event-delegatie (data-action), init, demo-carry-over, onboarding.
// Laadvolgorde staat in lib/planner-files.js (manifest voor
// index.html, server-allowlist en tests). Klassieke scripts,
// geen modules: functies zijn globaal over de delen heen.
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
            `<span class="rating-star" data-score="${n}" style="color:${n <= currentScore ? '#f59e0b' : '#d1d5db'};transition:color .15s" data-star="${n}" data-action="selectStar" data-arg="${n}">${n <= currentScore ? '★' : '☆'}</span>`
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
          <button class="btn-secondary" data-action="closeRatingModal">${I18n.t('app.rating.later', 'Later')}</button>
          <button class="btn-primary" id="rating-submit-btn" data-action="submitRating">${I18n.t('app.rating.submit', 'Verstuur beoordeling')}</button>
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

// ---- Event delegation (geen inline on*-attributen) ----
// Alle UI-events lopen via data-attributen en één set gedelegeerde listeners.
// Daardoor kan de CSP-directive script-src-attr op 'none' — een injectie via
// een attribuut (bv. uit geïmporteerde Excel-data) kan dan nooit meer draaien.
const UI_ACTIONS = {
  goToStep:               (arg) => goToStep(parseInt(arg, 10)),
  switchTab:              (arg) => switchTab(arg),
  setShareMode:           (arg) => setShareMode(arg),
  printSection:           (arg) => printSection(arg),
  printSingleEnvelopes:   () => printSingleEnvelopes(),
  closeParticipantModal:  () => closeParticipantModal(),
  closeRatingModal:       () => closeRatingModal(),
  closeListModal:         () => closeListModal(),
  closeOnboarding:        () => closeOnboarding(),
  onboardingNext:         () => onboardingNext(),
  openAddParticipant:     (arg) => openAddParticipant(arg !== undefined && arg !== '' ? parseInt(arg, 10) : undefined),
  deleteParticipant:      (arg) => deleteParticipant(parseInt(arg, 10)),
  deleteAllParticipants:  () => deleteAllParticipants(),
  addForcedCombo:         () => addForcedCombo(),
  removeForcedCombo:      (arg) => removeForcedCombo(parseInt(arg, 10)),
  generatePlanning:       () => generatePlanning(),
  regeneratePlanning:     () => regeneratePlanning(),
  checkDistances:         () => checkDistances(),
  downloadTemplate:       () => downloadTemplate(),
  importFile:             () => document.getElementById('import-file').click(),
  lookupPostcode:         () => lookupPostcode(),
  showSaveGroupModal:     () => showSaveGroupModal(),
  showLoadGroupModal:     () => showLoadGroupModal(),
  showLoadSnapshotModal:  () => showLoadSnapshotModal(),
  savePlanningSnapshot:   () => savePlanningSnapshot(),
  showRatingModal:        () => showRatingModal(),
  submitRating:           () => submitRating(),
  selectStar:             (arg) => selectStar(parseInt(arg, 10)),
  publishDigitalPlanning: () => publishDigitalPlanning(),
  deleteSharedPlanning:   () => deleteSharedPlanning(),
  copyShareLink:          (_a, el) => copyShareLink(el),
  undoChange:             (arg) => undoChange(parseInt(arg, 10)),
  undoAllChanges:         () => undoAllChanges(),
  confirmSaveGroup:       () => confirmSaveGroup(),
  // Groep-/snapshot-rijen: de naam zit op de dichtstbijzijnde data-container.
  fillGroupName: (_a, el) => {
    const n = el.closest('[data-group-name]')?.dataset.groupName;
    const inp = document.getElementById('save-group-name');
    if (n && inp) inp.value = n;
  },
  loadGroup:   (_a, el) => { const n = el.closest('[data-group-name]')?.dataset.groupName; if (n) confirmLoadGroup(n); },
  deleteGroup: (_a, el) => { const n = el.closest('[data-group-name]')?.dataset.groupName; if (n) deleteGroup(n); },
  deleteGroupAndRefresh: (_a, el) => {
    const n = el.closest('[data-group-name]')?.dataset.groupName;
    if (n) { deleteGroup(n); showLoadGroupModal(); }
  },
  loadSnapshot:   (_a, el) => { const n = el.closest('[data-snapshot-name]')?.dataset.snapshotName; if (n) confirmLoadSnapshot(n); },
  deleteSnapshot: (_a, el) => { const n = el.closest('[data-snapshot-name]')?.dataset.snapshotName; if (n) deleteSnapshot(n); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = UI_ACTIONS[el.dataset.action];
  // closest() pakt het BINNENSTE element met data-action; een knop in een
  // klikbare rij wint dus automatisch — geen stopPropagation meer nodig.
  if (fn) fn(el.dataset.arg, el, e);
});

const UI_CHANGE = {
  importParticipantsFromFile: (el, e) => importParticipantsFromFile(e),
  updateForcedCombo:       (el) => updateForcedCombo(parseInt(el.dataset.id, 10), el.dataset.field, el.value),
  toggleForcedComboCourse: (el) => toggleForcedComboCourse(parseInt(el.dataset.id, 10), el.dataset.course, el.checked),
  socialHostType:          (el) => onSocialHostTypeChange(el.dataset.course, el.value),
  socialParticipant:       (el) => onSocialParticipantChange(el.dataset.course, el.value),
};
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el) UI_CHANGE[el.dataset.change]?.(el, e);
});

const UI_INPUT = {
  socialCustom: (el) => onSocialCustomChange(el.dataset.course, el.dataset.field, el.value),
  stripSpaces:  (el) => { el.value = el.value.replace(/\s/g, ''); },
};
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-input]');
  if (el) UI_INPUT[el.dataset.input]?.(el, e);
});

document.addEventListener('submit', (e) => {
  if (e.target?.dataset?.submit === 'saveParticipant') saveParticipant(e);
});

// blur bubbelt niet; focusout wel.
document.addEventListener('focusout', (e) => {
  if (e.target?.dataset?.blur === 'autoLookupPostcode') autoLookupPostcode();
});

// mouseenter/-leave bubbelen niet; mouseover/-out wel (met relatedTarget-check).
document.addEventListener('mouseover', (e) => {
  const st = e.target.closest('[data-star]');
  if (st) hoverStars(parseInt(st.dataset.star, 10));
});
document.addEventListener('mouseout', (e) => {
  const st = e.target.closest('[data-star]');
  if (st && !st.contains(e.relatedTarget)) resetStars();
});

// Drag & drop van tafel-gasten (dragstart/-over/-leave/-end/drop bubbelen).
document.addEventListener('dragstart', (e) => {
  const g = e.target.closest?.('[data-drag-guest]');
  if (g) onDragStart(e, parseInt(g.dataset.dragGuest, 10), g.dataset.dragTable, g.dataset.dragCourse);
});
document.addEventListener('dragend', (e) => {
  if (e.target.closest?.('[data-drag-guest]')) onDragEnd(e);
});
document.addEventListener('dragover', (e) => {
  const t = e.target.closest?.('[data-drop-table]');
  if (t) onDragOver(e, t);
});
document.addEventListener('dragleave', (e) => {
  const t = e.target.closest?.('[data-drop-table]');
  if (t) onDragLeave(e, t);
});
document.addEventListener('drop', (e) => {
  const t = e.target.closest?.('[data-drop-table]');
  if (t) onDrop(e, t.dataset.dropTable, t.dataset.dropCourse, t);
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
