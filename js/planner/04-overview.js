// 04-overview.js — Stap 4: overzicht, printen, digitaal delen, utilities, postcode-lookup.
// Laadvolgorde staat in lib/planner-files.js (manifest voor
// index.html, server-allowlist en tests). Klassieke scripts,
// geen modules: functies zijn globaal over de delen heen.
// ---- Step 4: Overview ----
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab-btn[data-arg="${name}"]`).classList.add('active');
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
        return displayNameAt(p, course);
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
    const fullName = displayNameSafe(p);
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
                <tbody>${table.guestIds.map((gid, gi) => {
                  const g = participants.find(p => p.id === gid);
                  const diet = dietsOf(g);
                  return `<tr><td>${escapeHtml(table.guestNames[gi] || displayName(g))}</td><td>${escapeHtml(diet) || '–'}</td></tr>`;
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
                  <td>${escapeHtml(dietsOf(host)) || '–'}</td>
                </tr>
                ${table.guestIds.map((gid, gi) => {
                  const g = participants.find(p => p.id === gid);
                  const diet = dietsOf(g);
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

// ---- Digitaal delen (alternatief voor papieren enveloppen) ----
// De organisator publiceert de planning naar de server; elke deelnemer krijgt
// een persoonlijke /r/:token-link waarop het volgende adres pas verschijnt
// zodra de vorige gang is afgelopen. Versturen via wa.me (gratis, organisator
// klikt zelf per deelnemer). Zie lib/shared-planning.js + server.js.

function setShareMode(mode) {
  document.getElementById('share-mode-paper')?.classList.toggle('active', mode === 'paper');
  document.getElementById('share-mode-digital')?.classList.toggle('active', mode === 'digital');
  const paper = document.getElementById('share-paper-panel');
  const digital = document.getElementById('share-digital-panel');
  if (paper)   paper.style.display   = mode === 'paper'   ? 'block' : 'none';
  if (digital) digital.style.display = mode === 'digital' ? 'block' : 'none';
}

function _shareStatus(msg, isErr) {
  const el = document.getElementById('share-status');
  if (!el) return;
  el.style.display = msg ? 'block' : 'none';
  el.textContent = msg || '';
  el.style.color = isErr ? '#c62828' : '';
}

function buildPublishPayload() {
  const courses = getActiveCourses().map(c => {
    const tinfo = state.config.times[c];
    return { course: c, time: tinfo.start, endTime: addMinutes(tinfo.start, tinfo.duration) };
  });
  const participants = [];
  state.participants.forEach(p => {
    const route = getPersonRoute(p).map(r => ({
      course:   r.course,
      isHost:   r.isHost,
      isSocial: r.isSocial,
      address:  r.address ? `${r.address.street} ${r.address.housenumber || ''}, ${r.address.postcode} ${r.address.city}`.replace(/\s+/g, ' ').trim() : null,
      // Server toont zelf een "jij bent gastheer"-badge; hostName alleen voor gasten
      hostName: r.isHost ? null : (r.hostName || null),
      companions: r.companions || [],
    }));
    if (route.length) participants.push({ name: displayName(p), route });
  });
  return {
    eventName: state.config.eventName || 'Running Dinner',
    eventDate: state.config.eventDate,
    locale: I18n.getLang(),
    courses,
    participants,
  };
}

async function publishDigitalPlanning() {
  if (window.RDA_DEMO?.isActive?.()) { window.RDA_DEMO.showPaywall('paywall_digital'); return; }
  if (!state.planning) { alert(I18n.t('app.alert.generate_first', 'Genereer eerst een planning in stap 3.')); return; }

  const btn = document.getElementById('btn-publish-links');
  btn.disabled = true;
  _shareStatus(I18n.t('app.share.publishing', 'Deellinks maken…'));
  try {
    const res = await fetch('/api/plannings/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPublishPayload()),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error(I18n.t('app.share.login_required', 'Log in om deellinks te maken.'));
    if (!res.ok) throw new Error(data.error || 'publish failed');
    _shareStatus('');
    renderShareLinks(data.links, data.expiresAt);
    if (window.plausible) plausible('Digital-Share-Publish', { props: { participants: data.links.length } });
  } catch (err) {
    _shareStatus(I18n.t('app.share.error', 'Deellinks maken mislukt') + ': ' + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

function renderShareLinks(links, expiresAt) {
  const list = document.getElementById('share-links-list');
  if (!list) return;
  if (!links || !links.length) { list.innerHTML = ''; return; }

  const expiryDate = expiresAt
    ? new Date(expiresAt).toLocaleDateString(I18n.getLang() === 'nl' ? 'nl-NL' : I18n.getLang())
    : null;

  list.innerHTML = `
    <div class="share-links-head">
      <strong>${links.length} ${I18n.t('app.share.links_ready', 'persoonlijke links klaar')}</strong>
      ${expiryDate ? `<span class="hint">${I18n.t('app.share.expires_note', 'Verlopen automatisch op')} ${escapeHtml(expiryDate)}</span>` : ''}
    </div>
    ${links.map(l => `
      <div class="share-link-row">
        <span class="share-link-name">${escapeHtml(l.name)}</span>
        <a class="btn-whatsapp btn-small" href="${escapeHtml(l.waUrl)}" target="_blank" rel="noopener">\u{1F4AC} WhatsApp</a>
        <button type="button" class="btn-secondary btn-small" data-url="${escapeHtml(l.url)}" data-action="copyShareLink">\u{1F4CB} ${I18n.t('app.share.copy_btn', 'Kopieer link')}</button>
      </div>`).join('')}`;

  const pubBtn = document.getElementById('btn-publish-links');
  if (pubBtn) pubBtn.textContent = '\u{1F501} ' + I18n.t('app.share.republish_btn', 'Opnieuw maken (na wijziging)');
  const delBtn = document.getElementById('btn-delete-links');
  if (delBtn) delBtn.style.display = 'inline-block';
}

async function copyShareLink(btn) {
  try {
    await navigator.clipboard.writeText(btn.dataset.url);
    const orig = btn.textContent;
    btn.textContent = '\u2713 ' + I18n.t('app.share.copied', 'Gekopieerd');
    setTimeout(() => { btn.textContent = orig; }, 1600);
  } catch {
    prompt(I18n.t('app.share.copy_manual', 'Kopieer de link handmatig:'), btn.dataset.url);
  }
}

async function deleteSharedPlanning() {
  if (!confirm(I18n.t('app.share.delete_confirm', 'Alle deellinks intrekken? Deelnemers kunnen hun route dan niet meer openen.'))) return;
  try {
    const res = await fetch('/api/plannings/mine', { method: 'DELETE' });
    if (!res.ok) throw new Error('delete failed');
    document.getElementById('share-links-list').innerHTML = '';
    document.getElementById('btn-delete-links').style.display = 'none';
    const pubBtn = document.getElementById('btn-publish-links');
    if (pubBtn) pubBtn.textContent = '\u{1F517} ' + I18n.t('app.share.publish_btn', 'Maak deellinks');
    _shareStatus(I18n.t('app.share.deleted', 'Deellinks ingetrokken.'));
  } catch (err) {
    _shareStatus(I18n.t('app.share.error', 'Deellinks maken mislukt') + ': ' + err.message, true);
  }
}

// Bij binnenkomst op stap 4: bestaande publicatie terughalen (stil bij
// demo, file:// of niet-ingelogd — dan blijft het paneel gewoon leeg).
async function loadSharedPlanning() {
  if (window.RDA_DEMO?.isActive?.()) return;
  if (location.protocol === 'file:') return;
  try {
    const res = await fetch('/api/plannings/mine');
    if (!res.ok) return;
    const data = await res.json();
    if (data.planning?.links?.length) renderShareLinks(data.planning.links, data.planning.expiresAt);
  } catch { /* stil — delen is optioneel */ }
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

