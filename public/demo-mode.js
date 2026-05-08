/* ============================================================
   Running Dinner Planner — Demo Mode
   ============================================================
   Wordt geladen op /demo (en /en/demo, /es/demo, /de/demo).

   Geeft prospects een speelbare versie van de app met
   voorgeladen sample-data, zonder dat ze daadwerkelijk hun
   eigen event kunnen afdrukken/exporteren — dat is de paywall.

   Werking:
   - Detecteert demo via URL-pad
   - Vult state met fictieve deelnemers in/rond Klarenbeek
   - Toont persistente banner bovenaan
   - Onderschept print-/export-knoppen → toont upsell-modal
   - Blokkeert localStorage.setItem voor app-keys (refresh = reset)
   - Skipt auth-check (geen login vereist)

   Loadt VÓÓR app.js zodat we state.config defaults kunnen overrulen
   en localStorage kunnen gaten vóór de app start.
   ============================================================ */
'use strict';

(function () {
  const PATH = window.location.pathname.replace(/\/$/, '');

  // ---- Detectie ----
  function isActive() {
    return /^\/demo$/i.test(PATH) || /^\/(en|es|de)\/demo$/i.test(PATH);
  }
  function getLang() {
    const m = PATH.match(/^\/(en|es|de)\/demo/i);
    return m ? m[1].toLowerCase() : 'nl';
  }

  if (!isActive()) {
    // Geen demo — exporteer minimale stub zodat app.js veilig kan checken
    window.RDA_DEMO = { isActive: () => false };
    return;
  }

  // ============================================================
  // SAMPLE DATA — 16 deelnemers in/rond Klarenbeek (8 koppels + variaties)
  // Adressen zijn fictief maar plausibel voor de regio.
  // ============================================================
  const SAMPLE_PARTICIPANTS_NL = [
    { name1: 'Lieke',   name2: 'Mark',    address: { street: 'Hanekerweg',       housenumber: '8',  postcode: '7381 AM', city: 'Klarenbeek' }, diet1: null, diet2: 'Vegetarisch',     hostPreference: 'voorgerecht',  preferWith: [], avoid: [] },
    { name1: 'Sanne',   name2: 'Joost',   address: { street: 'Klarenbeekseweg',  housenumber: '32', postcode: '7382 BB', city: 'Klarenbeek' }, diet1: 'Glutenvrij', diet2: null,      hostPreference: 'hoofdgerecht', preferWith: [], avoid: [] },
    { name1: 'Peter',   name2: 'Anouk',   address: { street: 'Woudweg',          housenumber: '14', postcode: '7383 RC', city: 'Klarenbeek' }, diet1: null, diet2: null,             hostPreference: null,           preferWith: [], avoid: [] },
    { name1: 'Daan',    name2: 'Eva',     address: { street: 'Hessenallee',      housenumber: '5',  postcode: '7383 RB', city: 'Klarenbeek' }, diet1: null, diet2: 'Vegan',          hostPreference: 'nagerecht',    preferWith: [], avoid: [] },
    { name1: 'Maaike',  name2: 'Bram',    address: { street: 'Hoofdweg',         housenumber: '47', postcode: '7381 AT', city: 'Klarenbeek' }, diet1: null, diet2: null,             hostPreference: 'voorgerecht',  preferWith: [], avoid: [] },
    { name1: 'Tim',     name2: 'Judith',  address: { street: 'Veldhuizen',       housenumber: '21', postcode: '7382 CD', city: 'Klarenbeek' }, diet1: 'Lactose-intolerant', diet2: null, hostPreference: 'hoofdgerecht', preferWith: [], avoid: [] },
    { name1: 'Roos',    name2: 'Niels',   address: { street: 'Molenweg',         housenumber: '9',  postcode: '7383 AB', city: 'Klarenbeek' }, diet1: null, diet2: null,             hostPreference: null,           preferWith: [], avoid: [] },
    { name1: 'Esther',  name2: 'Joep',    address: { street: 'Bosweg',           housenumber: '18', postcode: '7382 BC', city: 'Klarenbeek' }, diet1: null, diet2: null,             hostPreference: 'nagerecht',    preferWith: [], avoid: [] },
    { name1: 'Kim',     name2: 'Lars',    address: { street: 'Beekstraat',       housenumber: '12', postcode: '7381 BX', city: 'Klarenbeek' }, diet1: null, diet2: null,             hostPreference: 'voorgerecht',  preferWith: [], avoid: [] },
    { name1: 'Floor',   name2: 'Bas',     address: { street: 'Kerkstraat',       housenumber: '7',  postcode: '7382 AB', city: 'Klarenbeek' }, diet1: 'Notenallergie', diet2: null,  hostPreference: 'hoofdgerecht', preferWith: [], avoid: [] },
    { name1: 'Yara',    name2: 'Sven',    address: { street: 'Lindenlaan',       housenumber: '3',  postcode: '7383 ED', city: 'Klarenbeek' }, diet1: null, diet2: null,             hostPreference: 'nagerecht',    preferWith: [], avoid: [] },
    { name1: 'Anne',    name2: 'Rik',     address: { street: 'Esdoornstraat',    housenumber: '22', postcode: '7382 CE', city: 'Klarenbeek' }, diet1: null, diet2: 'Vegetarisch',    hostPreference: null,           preferWith: [], avoid: [] },
  ];

  // Vertalingen banner + modal — minimaal, alleen voor demo-UI
  const I18N = {
    nl: {
      banner_text: 'Je gebruikt de demo met fictieve deelnemers.',
      banner_cta: 'Eigen planning starten — €5/jaar',
      reset: 'Reset demo',
      modal_title: 'Klaar voor het echte werk?',
      modal_body: 'Printen, Excel-exports en je eigen deelnemers opslaan zit in het volledige product. Voor €5 per jaar plan je onbeperkt running dinners — geen abonnement-vallen, geen advertenties.',
      modal_cta_subscribe: 'Start abonnement — €5/jaar',
      modal_cta_close: 'Verder kijken in demo',
      paywall_print: 'Printen is in de demo geblokkeerd.',
      paywall_export: 'Exporteren is in de demo geblokkeerd.',
      paywall_excel: 'Excel-import en -template zijn in de demo geblokkeerd.',
    },
    en: {
      banner_text: 'You\'re using the demo with sample participants.',
      banner_cta: 'Start your own planning — €5/year',
      reset: 'Reset demo',
      modal_title: 'Ready for the real thing?',
      modal_body: 'Printing, Excel exports and saving your own participants are part of the full product. For €5 a year you can plan unlimited running dinners — no subscription traps, no ads.',
      modal_cta_subscribe: 'Start subscription — €5/year',
      modal_cta_close: 'Keep exploring the demo',
      paywall_print: 'Printing is blocked in the demo.',
      paywall_export: 'Exporting is blocked in the demo.',
      paywall_excel: 'Excel import and templates are blocked in the demo.',
    },
    es: {
      banner_text: 'Estás usando la demo con participantes ficticios.',
      banner_cta: 'Empieza tu propia planificación — 5 €/año',
      reset: 'Reiniciar demo',
      modal_title: '¿Listo para hacerlo en serio?',
      modal_body: 'Imprimir, exportar a Excel y guardar tus propios participantes forman parte del producto completo. Por 5 € al año planificas cenas itinerantes sin límite — sin trampas, sin anuncios.',
      modal_cta_subscribe: 'Suscribirse — 5 €/año',
      modal_cta_close: 'Seguir explorando la demo',
      paywall_print: 'La impresión está bloqueada en la demo.',
      paywall_export: 'La exportación está bloqueada en la demo.',
      paywall_excel: 'La importación y plantillas de Excel están bloqueadas en la demo.',
    },
    de: {
      banner_text: 'Du nutzt die Demo mit fiktiven Teilnehmern.',
      banner_cta: 'Eigene Planung starten — 5 €/Jahr',
      reset: 'Demo zurücksetzen',
      modal_title: 'Bereit für das echte Event?',
      modal_body: 'Drucken, Excel-Exports und das Speichern eigener Teilnehmer sind Teil des Vollprodukts. Für 5 € pro Jahr planst du unbegrenzt Running Dinner — keine Abo-Fallen, keine Werbung.',
      modal_cta_subscribe: 'Abo starten — 5 €/Jahr',
      modal_cta_close: 'Weiter in der Demo',
      paywall_print: 'Drucken ist in der Demo deaktiviert.',
      paywall_export: 'Exportieren ist in der Demo deaktiviert.',
      paywall_excel: 'Excel-Import und Vorlagen sind in der Demo deaktiviert.',
    },
  };

  const lang = getLang();
  const T = I18N[lang] || I18N.nl;

  // ============================================================
  // Dieet-labels per taal — gebruikt om sample-data tags te vertalen
  // De NL-key blijft de bron-key in SAMPLE_PARTICIPANTS_NL.
  // ============================================================
  const DIETS_I18N = {
    Vegetarisch:        { nl: 'Vegetarisch',        en: 'Vegetarian',         es: 'Vegetariano',          de: 'Vegetarisch' },
    Vegan:              { nl: 'Vegan',              en: 'Vegan',              es: 'Vegano',               de: 'Vegan' },
    Glutenvrij:         { nl: 'Glutenvrij',         en: 'Gluten-free',        es: 'Sin gluten',           de: 'Glutenfrei' },
    'Lactose-intolerant': { nl: 'Lactose-intolerant', en: 'Lactose-intolerant', es: 'Intolerante a la lactosa', de: 'Laktoseintoleranz' },
    Notenallergie:      { nl: 'Notenallergie',      en: 'Nut allergy',        es: 'Alergia a frutos secos', de: 'Nussallergie' },
  };
  function tDiet(label) {
    if (!label) return null;
    const entry = DIETS_I18N[label];
    return entry ? (entry[lang] || label) : label;
  }

  // Subscribe-link prefix per taal
  const SUBSCRIBE_URL = lang === 'nl' ? '/subscribe.html' : `/${lang}/subscribe.html`;

  // ============================================================
  // localStorage gating — blokkeer schrijven naar app-keys
  // (lezen blijft toegestaan zodat onboarding-tour state niet kapot gaat)
  // ============================================================
  const BLOCKED_KEYS = [
    'runningdinner_groups',
    'runningdinner_snapshots',
  ];
  const _setItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (key, value) {
    if (BLOCKED_KEYS.includes(key)) {
      // No-op in demo — wijzigingen verdwijnen bij refresh
      return;
    }
    return _setItem(key, value);
  };

  // ============================================================
  // State injectie — wordt aangeroepen door applyTo(state) na app.js init
  // ============================================================
  function applyToState(state) {
    if (!state) return;
    // Config-overrides (voorbeeld-event in juni 2026, Klarenbeek)
    state.config.eventName = lang === 'nl' ? 'Buurt Running Dinner Klarenbeek'
      : lang === 'en' ? 'Klarenbeek Neighborhood Running Dinner'
      : lang === 'es' ? 'Cena Itinerante Klarenbeek'
      : 'Nachbarschafts-Running-Dinner Klarenbeek';
    state.config.eventDate = '2026-06-13';
    state.config.eventCity = 'Klarenbeek';
    state.config.minTableSize = 4;
    state.config.maxTableSize = 6;

    // Deelnemers met default availability (alle gangen aan voor beide personen)
    const courses = ['voorborrel', 'voorgerecht', 'hoofdgerecht', 'nagerecht', 'naborrel'];
    state.participants = SAMPLE_PARTICIPANTS_NL.map((p, i) => {
      const availability = {};
      courses.forEach(c => { availability[c] = { person1: true, person2: true }; });
      return {
        id: i + 1,
        name1: p.name1,
        name2: p.name2,
        address: { ...p.address, full: `${p.address.street} ${p.address.housenumber}, ${p.address.postcode} ${p.address.city}` },
        availability,
        hostPreference: p.hostPreference,
        diet1: tDiet(p.diet1),
        diet2: tDiet(p.diet2),
        preferWith: p.preferWith || [],
        avoid: p.avoid || [],
      };
    });
    state.nextId = state.participants.length + 1;

    // Sync UI-velden voor stap 1 zodat configuratie zichtbaar is
    setTimeout(() => {
      const evName = document.getElementById('event-name');
      const evDate = document.getElementById('event-date');
      const evCity = document.getElementById('event-city');
      if (evName) evName.value = state.config.eventName;
      if (evDate) evDate.value = state.config.eventDate;
      if (evCity) evCity.value = state.config.eventCity;
    }, 100);
  }

  // ============================================================
  // Banner + Modal opbouw (DOM)
  // ============================================================
  function injectBanner() {
    const banner = document.createElement('div');
    banner.id = 'demo-banner';
    banner.innerHTML = `
      <div class="demo-banner-inner">
        <span class="demo-banner-icon">🍽️</span>
        <span class="demo-banner-text">${escapeHtml(T.banner_text)}</span>
        <a href="${SUBSCRIBE_URL}" class="demo-banner-cta">${escapeHtml(T.banner_cta)}</a>
        <button type="button" class="demo-banner-reset" title="${escapeHtml(T.reset)}" onclick="window.location.reload()">↻</button>
      </div>`;
    document.body.insertBefore(banner, document.body.firstChild);
  }

  function injectModal() {
    const modal = document.createElement('div');
    modal.id = 'demo-paywall-modal';
    modal.style.display = 'none';
    modal.innerHTML = `
      <div class="demo-modal-overlay" onclick="RDA_DEMO.closePaywall()"></div>
      <div class="demo-modal-card">
        <div class="demo-modal-icon">🔒</div>
        <h2 class="demo-modal-title">${escapeHtml(T.modal_title)}</h2>
        <p class="demo-modal-reason" id="demo-modal-reason"></p>
        <p class="demo-modal-body">${escapeHtml(T.modal_body)}</p>
        <div class="demo-modal-actions">
          <a href="${SUBSCRIBE_URL}" class="demo-modal-btn-primary">${escapeHtml(T.modal_cta_subscribe)}</a>
          <button type="button" class="demo-modal-btn-secondary" onclick="RDA_DEMO.closePaywall()">${escapeHtml(T.modal_cta_close)}</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }

  // ============================================================
  // Paywall handling
  // ============================================================
  function showPaywall(reasonKey) {
    const modal = document.getElementById('demo-paywall-modal');
    const reasonEl = document.getElementById('demo-modal-reason');
    if (reasonEl) reasonEl.textContent = T[reasonKey] || '';
    if (modal) modal.style.display = 'flex';
    // Tracking-event (Plausible custom event als beschikbaar)
    try { window.plausible?.('Demo Paywall Hit', { props: { reason: reasonKey, lang } }); } catch {}
  }
  function closePaywall() {
    const modal = document.getElementById('demo-paywall-modal');
    if (modal) modal.style.display = 'none';
  }

  // ============================================================
  // Print-/Export-functies overrulen
  // ============================================================
  function interceptApp() {
    // Vervang print-functies door paywall
    if (typeof window.printSection === 'function') {
      window.printSection = function () { showPaywall('paywall_print'); };
    }
    if (typeof window.printSingleEnvelopes === 'function') {
      window.printSingleEnvelopes = function () { showPaywall('paywall_print'); };
    }
    // Excel-template + import
    if (typeof window.downloadTemplate === 'function') {
      window.downloadTemplate = function () { showPaywall('paywall_excel'); };
    }
    if (typeof window.importParticipantsFromFile === 'function') {
      window.importParticipantsFromFile = function () { showPaywall('paywall_excel'); };
    }
    // Snapshot opslaan (gebruikt localStorage maar geen schade — paywall toch netter)
    if (typeof window.savePlanningSnapshot === 'function') {
      window.savePlanningSnapshot = function () { showPaywall('paywall_export'); };
    }
  }

  // ============================================================
  // Util
  // ============================================================
  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ============================================================
  // Tracking — Plausible custom event "Demo Started"
  // ============================================================
  function trackStarted() {
    try { window.plausible?.('Demo Started', { props: { lang } }); } catch {}
  }

  // ============================================================
  // Public API
  // ============================================================
  window.RDA_DEMO = {
    isActive: () => true,
    getLang,
    applyToState,
    showPaywall,
    closePaywall,
  };

  // ============================================================
  // Verberg UI-elementen die in demo geen zin hebben
  // ============================================================
  function hideIrrelevantUI() {
    // "Hoe ging het?" / Schrijf-een-review-card op stap 4
    const ratingCard = document.getElementById('rating-card');
    if (ratingCard) ratingCard.style.display = 'none';
  }

  // ============================================================
  // Init — banner direct, modal direct, hooks na DOM ready
  // ============================================================
  function init() {
    injectBanner();
    injectModal();
    interceptApp();
    hideIrrelevantUI();
    trackStarted();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
