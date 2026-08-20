// Uit index.html gelicht: inline <script> mag niet meer onder de CSP
// (script-src zonder 'unsafe-inline').
'use strict';

// ── Auth guard ─────────────────────────────────────────────────────────────
async function checkAuth() {
  try {
    const res  = await fetch('/api/auth/me');
    if (!res.ok) throw new Error('unauth');
    const data = await res.json();
    if (!data.ok || data.user.role !== 'admin') throw new Error('not admin');
    document.getElementById('hdr-user').textContent = data.user.email;
    const badge = document.getElementById('env-badge');
    if (location.port === '3001') { badge.textContent = 'DEV'; badge.className = 'hdr-env dev'; }
    else { badge.textContent = 'PROD'; badge.className = 'hdr-env prod'; }
  } catch {
    window.location.href = '/login.html?next=/admin/';
  }
}

// ── Navigation ─────────────────────────────────────────────────────────────
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelector(`.nav-item[data-page="${name}"]`).classList.add('active');
  const loaders = { dashboard: loadDashboard, sessions: loadSessions, users: loadUsers, orders: loadOrders, settings: loadSettings, cms: loadCms, analytics: loadAnalytics, blog: loadBlog, reviews: loadReviews, vouchers: loadVouchers, referrals: loadReferrals, accounting: loadAccounting, monitoring: loadMonitoring, deploy: loadDeploy };
  loaders[name]?.();
}
document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => showPage(btn.dataset.page)));

// Gedelegeerde acties voor dynamisch gegenereerde knoppen (geen inline
// on*-attributen; nodig voor CSP script-src-attr 'none').
const ADMIN_ACTIONS = {
  openEditUser:    (d) => openEditUser(d.id),
  sendInvite:      (d) => sendInvite(d.id, d.email),
  deleteUser:      (d) => deleteUser(d.id, d.email),
  retryZoho:       (d) => retryZoho(d.id),
  toggleBlogDraft: (d) => toggleBlogDraft(d.filename, d.draft === 'true'),
  moderateReview:  (d) => moderateReview(d.id, d.status),
  deleteReview:    (d) => deleteReview(d.id),
  deleteVoucher:   (d) => deleteVoucher(d.id, d.code),
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el) ADMIN_ACTIONS[el.dataset.action]?.(el.dataset);
});

// ── Logout ─────────────────────────────────────────────────────────────────
document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

// ── Helpers ────────────────────────────────────────────────────────────────
const fmtEur  = cents => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format((cents||0) / 100);
const fmtDate = ts    => ts ? new Date(ts).toLocaleDateString('nl-NL') : '–';
const fmtDT   = ts    => ts ? new Date(ts).toLocaleString('nl-NL') : '–';
const fmtAgo  = ts => {
  if (!ts) return '–';
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d === 0) return 'Vandaag';
  if (d === 1) return '1 dag geleden';
  if (d < 30)  return `${d} dagen geleden`;
  const m = Math.floor(d / 30);
  if (m < 12)  return `${m} maand${m>1?'en':''} geleden`;
  const y = Math.floor(m / 12);
  return `${y} jaar geleden`;
};
const memberDuration = ts => {
  if (!ts) return '–';
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d < 30)  return `${d} dag${d!==1?'en':''}`;
  const m = Math.floor(d / 30);
  if (m < 12)  return `${m} maand${m>1?'en':''}`;
  const y = Math.floor(m / 12); const rm = m % 12;
  return `${y} jaar${rm ? ` ${rm}m` : ''}`;
};
function escH(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function showAlert(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg; el.className = `alert ${type}`; el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}
function gaugeColor(pct) { return pct < 60 ? 'green' : pct < 85 ? 'amber' : 'red'; }

// ── DASHBOARD ──────────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const res  = await fetch('/api/admin/stats');
    const data = await res.json();
    const s    = data.stats;

    document.getElementById('st-total').textContent    = s.totalUsers;
    document.getElementById('st-type-breakdown').textContent = `${s.paidUsers} betaald · ${s.manualUsers} hand. · ${s.testUsers} test`;
    document.getElementById('st-active').textContent   = s.activeUsers;
    document.getElementById('st-pct').textContent      = s.totalUsers ? `${Math.round(s.activeUsers/s.totalUsers*100)}% van totaal` : '';
    document.getElementById('st-expired').textContent  = s.expiredUsers;
    document.getElementById('st-sessions').textContent = s.activeSessions;
    document.getElementById('st-revenue').textContent  = fmtEur(s.totalRevenue);
    document.getElementById('st-rev-month-label').textContent = `Deze maand: ${fmtEur(s.revenueMonth)}`;
    document.getElementById('st-plannings').textContent = s.planningCount.toLocaleString('nl-NL');
    document.getElementById('st-autorenew').textContent = s.autoRenewCount || 0;

    document.getElementById('ty-paid').textContent   = s.paidUsers;
    document.getElementById('ty-manual').textContent = s.manualUsers;
    document.getElementById('ty-test').textContent   = s.testUsers;

    // CPU gauge
    const cpuFill  = document.getElementById('cpu-fill');
    const cpuColor = gaugeColor(s.serverLoad);
    cpuFill.style.width = s.serverLoad + '%';
    cpuFill.className   = `gauge-fill ${cpuColor}`;
    document.getElementById('cpu-label').textContent = `${s.serverLoad}% — ${s.serverLoad < 60 ? 'normaal' : s.serverLoad < 85 ? 'verhoogd' : 'kritiek'}`;

    // Memory gauge
    const memFill  = document.getElementById('mem-fill');
    const memColor = gaugeColor(s.memoryUsed);
    memFill.style.width = s.memoryUsed + '%';
    memFill.className   = `gauge-fill ${memColor}`;
    document.getElementById('mem-label').textContent = `${s.memoryUsed}% in gebruik`;

    // Simple bar chart placeholder (last 12 months)
    const months = ['Okt','Nov','Dec','Jan','Feb','Mrt','Apr','Mei','Jun','Jul','Aug','Sep'];
    const bars   = [20,30,40,25,45,50,35,55,40,30,45,s.revenueMonth > 0 ? 75 : 60];
    const max    = Math.max(...bars);
    document.getElementById('revenue-chart').innerHTML =
      bars.map((b,i) => `<div class="bar${i===11?' cur':''}" style="height:${Math.round(b/max*100)}%" title="${months[i]}"></div>`).join('');
    document.getElementById('revenue-labels').innerHTML =
      months.map(m => `<span>${m}</span>`).join('');

    // Conversion ratio per window
    try {
      const cr = await fetch('/api/admin/conversion');
      const cd = await cr.json();
      if (cd.ok) {
        for (const key of ['7d', '30d', '90d', 'all']) {
          const w = cd.windows[key];
          const el  = document.getElementById('conv-' + key);
          const sub = document.getElementById('conv-' + key + '-sub');
          el.textContent = w.signups === 0 ? '–' : (w.conversion.toFixed(1) + '%');
          sub.textContent = `${w.paid} / ${w.signups} betaald`;
          // Color hint: green >= 30%, amber 10-30%, red < 10% (ignore when signups == 0)
          el.style.color = w.signups === 0 ? '#9CA3AF'
            : w.conversion >= 30 ? '#166534'
            : w.conversion >= 10 ? '#92400E'
            : '#991B1B';
        }
      }
    } catch (e) { /* non-fatal */ }

  } catch(e) { console.error(e); }
}

// ── SESSIES ────────────────────────────────────────────────────────────────
async function loadSessions() {
  const el = document.getElementById('sessions-list');
  try {
    const res  = await fetch('/api/admin/active-sessions');
    const data = await res.json();
    if (!data.sessions.length) {
      el.innerHTML = '<p style="color:var(--muted);font-size:.85rem">Geen actieve sessies op dit moment.</p>';
      return;
    }
    el.innerHTML = data.sessions.map(s => `
      <div class="session-item">
        <span class="session-dot"></span>
        <span class="session-email">${escH(s.email)}</span>
        <span style="font-size:.75rem;color:var(--muted)">Ingelogd ${fmtAgo(s.loginAt)}</span>
        <span class="session-time">Actief: ${fmtDT(s.lastSeen)}</span>
      </div>
    `).join('');
  } catch { el.innerHTML = '<p style="color:var(--red);font-size:.85rem">Laden mislukt</p>'; }
}
document.getElementById('refresh-sessions-btn').addEventListener('click', loadSessions);

// ── GEBRUIKERS ─────────────────────────────────────────────────────────────
async function loadUsers() {
  const tbody = document.getElementById('users-tbody');
  tbody.innerHTML = '<tr class="load-row"><td colspan="10">Laden…</td></tr>';
  try {
    const res  = await fetch('/api/admin/users');
    const data = await res.json();
    if (!data.users.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="10">Geen gebruikers</td></tr>'; return; }
    const now = Date.now();
    // Store users data for edit modal
    window._usersData = {};
    data.users.forEach(u => window._usersData[u.id] = u);
    tbody.innerHTML = data.users.map(u => {
      const active  = u.license_until && u.license_until > now;
      const typeMap = { paid: '💳 Betaald', manual: '✍️ Handmatig', test: '🧪 Test' };
      return `<tr>
        <td>${escH(u.email)}${u.is_business ? ` <span title="${escH(u.company_name||'Zakelijk')}" style="background:#dbeafe;color:#1e40af;padding:1px 6px;border-radius:4px;font-size:.68rem;font-weight:600;margin-left:4px">🏢 B2B</span>` : ''}</td>
        <td><span class="badge ${u.user_type||'paid'}">${typeMap[u.user_type]||u.user_type}</span></td>
        <td><span class="badge ${u.role}">${u.role}</span></td>
        <td>${fmtDate(u.created_at)}</td>
        <td>${memberDuration(u.created_at)}</td>
        <td>${fmtAgo(u.last_login)}</td>
        <td>${u.license_until ? fmtDate(u.license_until) : '–'}</td>
        <td style="text-align:center">${u.payment_count||0}</td>
        <td><span class="badge ${active?'active':'expired'}">${active?'Actief':'Verlopen'}</span>${u.auto_renew ? ' <span class="badge active" style="font-size:10px">Auto</span>' : ''}</td>
        <td>${u.role!=='admin' ? `<div class="action-btns">
          <button class="btn-sm btn-edit" data-action="openEditUser" data-id="${u.id}" title="Bewerken">✎</button>
          <button class="btn-sm btn-invite" data-action="sendInvite" data-id="${u.id}" data-email="${escH(u.email)}" title="Uitnodigingslink sturen">📧</button>
          <button class="btn-sm btn-del" data-action="deleteUser" data-id="${u.id}" data-email="${escH(u.email)}" title="Verwijderen">✕</button>
        </div>` : ''}</td>
      </tr>`;
    }).join('');
  } catch { tbody.innerHTML = '<tr class="empty-row"><td colspan="10">Laden mislukt</td></tr>'; }
}

async function deleteUser(id, email) {
  if (!confirm(`Gebruiker "${email}" definitief verwijderen?`)) return;
  await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
  loadUsers(); loadDashboard();
}

// Toggle password field based on invite checkbox
document.getElementById('nu-invite').addEventListener('change', e => {
  const pwField = document.getElementById('nu-password');
  if (e.target.checked) {
    pwField.disabled = true; pwField.placeholder = 'Wordt via e-mail ingesteld'; pwField.value = '';
  } else {
    pwField.disabled = false; pwField.placeholder = 'Min. 8 tekens';
  }
});
// Initial state (invite checked by default)
document.getElementById('nu-password').disabled = true;
document.getElementById('nu-password').placeholder = 'Wordt via e-mail ingesteld';

// Create user
document.getElementById('create-user-btn').addEventListener('click', async () => {
  const btn  = document.getElementById('create-user-btn');
  btn.disabled = true;
  const sendInvite = document.getElementById('nu-invite').checked;
  try {
    const body = {
      email:        document.getElementById('nu-email').value,
      user_type:    document.getElementById('nu-type').value,
      license_days: document.getElementById('nu-days').value || undefined,
      send_invite:  sendInvite,
    };
    if (!sendInvite) body.password = document.getElementById('nu-password').value;
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok) {
      showAlert('create-user-alert', data.message, 'ok');
      document.getElementById('nu-email').value = '';
      document.getElementById('nu-password').value = '';
      document.getElementById('nu-days').value = '';
      loadUsers(); loadDashboard();
    } else {
      showAlert('create-user-alert', data.error, 'err');
    }
  } catch { showAlert('create-user-alert', 'Netwerkfout', 'err'); }
  btn.disabled = false;
});

// ── EDIT USER MODAL ─────────────────────────────────────────────────────
function openEditUser(id) {
  console.log('[admin] openEditUser called with id:', id);
  const u = window._usersData?.[id];
  if (!u) {
    console.error('[admin] User not found in _usersData for id:', id, 'Available:', Object.keys(window._usersData || {}));
    alert('Gebruiker niet gevonden. Probeer de pagina te verversen.');
    return;
  }
  try {
    document.getElementById('edit-user-id').value = id;
    document.getElementById('edit-email').value = u.email;
    document.getElementById('edit-type').value = u.user_type || 'manual';
    document.getElementById('edit-license-display').value = u.license_until
      ? (u.license_until > Date.now() ? `Actief t/m ${fmtDate(u.license_until)}` : `Verlopen op ${fmtDate(u.license_until)}`)
      : 'Geen licentie';
    // Set date picker to current license date
    const dateInput = document.getElementById('edit-license-date');
    if (u.license_until) {
      const d = new Date(u.license_until);
      dateInput.value = d.toISOString().split('T')[0]; // YYYY-MM-DD format
    } else {
      dateInput.value = '';
    }
    document.getElementById('edit-license-days').value = '';
    document.getElementById('edit-remove-license').checked = false;
    document.getElementById('edit-password').value = '';
    document.getElementById('edit-modal').classList.add('open');
    console.log('[admin] Edit modal opened for:', u.email);
  } catch (err) {
    console.error('[admin] Error opening edit modal:', err);
    alert('Fout bij openen bewerkvenster: ' + err.message);
  }
}
function closeEditModal() { document.getElementById('edit-modal').classList.remove('open'); }
document.getElementById('edit-modal-close').addEventListener('click', closeEditModal);
document.getElementById('edit-cancel-btn').addEventListener('click', closeEditModal);
document.getElementById('edit-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeEditModal(); });

// Save edit
document.getElementById('edit-save-btn').addEventListener('click', async () => {
  const btn = document.getElementById('edit-save-btn');
  btn.disabled = true;
  const id = document.getElementById('edit-user-id').value;
  const body = {
    email:     document.getElementById('edit-email').value,
    user_type: document.getElementById('edit-type').value,
  };
  const days = document.getElementById('edit-license-days').value;
  const dateVal = document.getElementById('edit-license-date').value;
  if (days) {
    body.license_days = days;
  } else if (dateVal) {
    // Convert date string to timestamp (end of day)
    const d = new Date(dateVal + 'T23:59:59');
    body.license_until = d.getTime();
  } else if (document.getElementById('edit-remove-license').checked) {
    body.license_until = 'remove';
  }
  const pw = document.getElementById('edit-password').value;
  if (pw) body.password = pw;
  try {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok) {
      showAlert('edit-user-alert', data.message, 'ok');
      setTimeout(() => { closeEditModal(); loadUsers(); loadDashboard(); }, 800);
    } else {
      showAlert('edit-user-alert', data.error, 'err');
    }
  } catch { showAlert('edit-user-alert', 'Netwerkfout', 'err'); }
  btn.disabled = false;
});

// Send invite from edit modal
document.getElementById('edit-invite-btn').addEventListener('click', async () => {
  const id = document.getElementById('edit-user-id').value;
  const email = document.getElementById('edit-email').value;
  if (!confirm(`Uitnodigingslink sturen naar ${email}?`)) return;
  const btn = document.getElementById('edit-invite-btn');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/admin/users/${id}/invite`, { method: 'POST' });
    const data = await res.json();
    showAlert('edit-user-alert', res.ok ? data.message : (data.error||'Mislukt'), res.ok ? 'ok' : 'err');
  } catch { showAlert('edit-user-alert', 'Netwerkfout', 'err'); }
  btn.disabled = false;
});

// Send invite from table
async function sendInvite(id, email) {
  if (!confirm(`Uitnodigingslink sturen naar ${email}?`)) return;
  try {
    const res = await fetch(`/api/admin/users/${id}/invite`, { method: 'POST' });
    const data = await res.json();
    showAlert('create-user-alert', res.ok ? data.message : (data.error||'Mislukt'), res.ok ? 'ok' : 'err');
  } catch { showAlert('create-user-alert', 'Netwerkfout', 'err'); }
}

// ── BESTELLINGEN ───────────────────────────────────────────────────────────
async function loadOrders() {
  const tbody = document.getElementById('orders-tbody');
  tbody.innerHTML = '<tr class="load-row"><td colspan="7">Laden…</td></tr>';
  try {
    const res  = await fetch('/api/admin/orders');
    const data = await res.json();
    if (!data.orders.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Geen bestellingen</td></tr>'; return; }
    tbody.innerHTML = data.orders.map(o => `<tr>
      <td><strong>${escH(o.invoice_number||'–')}</strong></td>
      <td>${escH(o.user_email||'–')}</td>
      <td><span class="badge ${o.user_type||'paid'}">${{paid:'💳 Betaald',manual:'✍️ Hand.',test:'🧪 Test'}[o.user_type]||o.user_type||'–'}</span></td>
      <td>${fmtEur(o.amount_cents)}</td>
      <td>${fmtDate(o.created_at)}</td>
      <td><span class="badge ${o.status==='paid'?'active':'expired'}">${o.status}</span></td>
      <td style="font-size:.72rem;color:var(--muted);max-width:120px;overflow:hidden;text-overflow:ellipsis">${escH(o.mollie_payment_id||'–')}</td>
    </tr>`).join('');
  } catch { tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Laden mislukt</td></tr>'; }
}

// ── INSTELLINGEN ───────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const res  = await fetch('/api/admin/stats');
    const data = await res.json();
    document.getElementById('price-cents').value  = data.stats.priceCents;
    document.getElementById('duration-days').value = 365;
    document.getElementById('planning-count-input').value = data.stats.planningCount;
  } catch {}
}

document.getElementById('save-settings-btn').addEventListener('click', async () => {
  const btn = document.getElementById('save-settings-btn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription_price_cents:   parseInt(document.getElementById('price-cents').value, 10),
        subscription_duration_days: parseInt(document.getElementById('duration-days').value, 10),
      }),
    });
    const data = await res.json();
    showAlert('settings-alert', res.ok ? 'Opgeslagen' : (data.error||'Mislukt'), res.ok ? 'ok' : 'err');
  } catch { showAlert('settings-alert', 'Netwerkfout', 'err'); }
  btn.disabled = false;
});

document.getElementById('save-counter-btn').addEventListener('click', async () => {
  const btn = document.getElementById('save-counter-btn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/admin/planning-count', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: parseInt(document.getElementById('planning-count-input').value, 10) }),
    });
    const data = await res.json();
    showAlert('counter-alert', res.ok ? `Teller opgeslagen op ${data.count}` : (data.error||'Mislukt'), res.ok ? 'ok' : 'err');
  } catch { showAlert('counter-alert', 'Netwerkfout', 'err'); }
  btn.disabled = false;
});

// ── CMS ────────────────────────────────────────────────────────────────────
async function loadCms() {
  try {
    const res  = await fetch('/api/cms');
    const data = await res.json();
    const c    = data.cms || {};
    const map  = { 'cms-hero-title':'hero_title', 'cms-hero-subtitle':'hero_subtitle', 'cms-hero-cta':'hero_cta', 'cms-features-intro':'features_intro', 'cms-price-label':'price_label', 'cms-footer-text':'footer_text' };
    for (const [id, key] of Object.entries(map)) { const el = document.getElementById(id); if (el && c[key]) el.value = c[key]; }
    updateCmsPreview();
    if (c.hero_photo) { const img = document.getElementById('cms-photo-preview'); img.src = c.hero_photo; img.style.display = 'block'; }
  } catch {}
}

function updateCmsPreview() {
  document.getElementById('prev-title').textContent = document.getElementById('cms-hero-title').value;
  document.getElementById('prev-sub').textContent   = document.getElementById('cms-hero-subtitle').value;
  document.getElementById('prev-btn').textContent   = document.getElementById('cms-hero-cta').value;
}
['cms-hero-title','cms-hero-subtitle','cms-hero-cta'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateCmsPreview);
});

document.getElementById('save-cms-btn').addEventListener('click', async () => {
  const btn = document.getElementById('save-cms-btn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/cms', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hero_title:     document.getElementById('cms-hero-title').value,
        hero_subtitle:  document.getElementById('cms-hero-subtitle').value,
        hero_cta:       document.getElementById('cms-hero-cta').value,
        features_intro: document.getElementById('cms-features-intro').value,
        price_label:    document.getElementById('cms-price-label').value,
        footer_text:    document.getElementById('cms-footer-text').value,
      }),
    });
    showAlert('cms-alert', res.ok ? 'Teksten opgeslagen' : 'Opslaan mislukt', res.ok ? 'ok' : 'err');
  } catch { showAlert('cms-alert', 'Netwerkfout', 'err'); }
  btn.disabled = false;
});

document.getElementById('cms-photo').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { const img = document.getElementById('cms-photo-preview'); img.src = ev.target.result; img.style.display = 'block'; };
  reader.readAsDataURL(file);
});

document.getElementById('save-photo-btn').addEventListener('click', async () => {
  const file = document.getElementById('cms-photo').files[0];
  if (!file) { showAlert('cms-alert', 'Selecteer eerst een afbeelding', 'err'); return; }
  if (file.size > 2 * 1024 * 1024) { showAlert('cms-alert', 'Max 2 MB', 'err'); return; }
  const btn = document.getElementById('save-photo-btn'); btn.disabled = true;
  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      const res = await fetch('/api/cms/photo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'hero_photo', dataUrl: ev.target.result }) });
      showAlert('cms-alert', res.ok ? 'Afbeelding opgeslagen' : 'Mislukt', res.ok ? 'ok' : 'err');
    } catch { showAlert('cms-alert', 'Netwerkfout', 'err'); }
    btn.disabled = false;
  };
  reader.readAsDataURL(file);
});

// ── DEPLOYMENT ─────────────────────────────────────────────────────────────
async function loadDeploy() {
  const log = document.getElementById('deploy-log');
  try {
    const res  = await fetch('/api/admin/deployments');
    const data = await res.json();
    if (!data.deployments.length) { log.innerHTML = '<p style="color:var(--muted);font-size:.85rem">Nog geen deployments</p>'; return; }
    log.innerHTML = data.deployments.map(d => `
      <div class="deploy-item">
        <div class="deploy-top">
          <span class="deploy-env ${d.env}">${d.env.toUpperCase()}</span>
          <span class="deploy-time">${fmtDT(d.created_at)}</span>
        </div>
        <span style="color:var(--muted)">Door: ${escH(d.deployed_by)}${d.note ? ` — ${escH(d.note)}` : ''}</span>
      </div>`).join('');
  } catch { log.innerHTML = '<p style="color:var(--red);font-size:.85rem">Laden mislukt</p>'; }
}

async function triggerDeploy(env) {
  if (!confirm(`Deployen naar ${env}?`)) return;
  const btn = document.getElementById(`deploy-${env==='production'?'prod':'staging'}-btn`);
  btn.disabled = true;
  try {
    const res  = await fetch('/api/admin/deploy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ env, note: document.getElementById('deploy-note').value }) });
    const data = await res.json();
    showAlert('deploy-alert', res.ok ? data.message : (data.error||'Mislukt'), res.ok ? 'ok' : 'err');
    if (res.ok) loadDeploy();
  } catch { showAlert('deploy-alert', 'Netwerkfout', 'err'); }
  btn.disabled = false;
}
document.getElementById('deploy-prod-btn').addEventListener('click', () => triggerDeploy('production'));
document.getElementById('deploy-staging-btn').addEventListener('click', () => triggerDeploy('staging'));

// ── ANALYTICS ─────────────────────────────────────────────────────────────
const COUNTRY_NAMES = {
  NL:'Nederland',BE:'België',DE:'Duitsland',FR:'Frankrijk',GB:'Verenigd Koninkrijk',
  US:'Verenigde Staten',CA:'Canada',AU:'Australië',AT:'Oostenrijk',CH:'Zwitserland',
  ES:'Spanje',IT:'Italië',SE:'Zweden',NO:'Noorwegen',DK:'Denemarken',
  FI:'Finland',PL:'Polen',PT:'Portugal',IE:'Ierland',CZ:'Tsjechië',
  LU:'Luxemburg',SR:'Suriname',CW:'Curaçao',AW:'Aruba',ID:'Indonesië',
  ZA:'Zuid-Afrika',JP:'Japan',CN:'China',IN:'India',BR:'Brazilië',
  MX:'Mexico',RU:'Rusland',TR:'Turkije',KR:'Zuid-Korea',TH:'Thailand',
};
function countryName(code) { return COUNTRY_NAMES[code] || code || 'Direct / onbekend'; }
function fmtDuration(sec) {
  if (!sec || sec < 1) return '0s';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

let _analyticsInterval = null;

async function loadAnalytics() {
  const period = document.getElementById('analytics-period').value;

  // Clear and restart realtime polling
  if (_analyticsInterval) clearInterval(_analyticsInterval);
  async function pollRealtime() {
    try {
      const r = await fetch('/api/admin/analytics/realtime');
      const d = await r.json();
      document.getElementById('rt-count').textContent = d.visitors ?? 0;
    } catch {}
  }
  pollRealtime();
  _analyticsInterval = setInterval(pollRealtime, 15000);

  // Aggregate stats
  try {
    const r = await fetch(`/api/admin/analytics/aggregate?period=${period}`);
    const d = await r.json();
    const s = d.results || {};
    document.getElementById('an-visitors').textContent   = s.visitors?.value?.toLocaleString('nl-NL')   ?? '–';
    document.getElementById('an-pageviews').textContent  = s.pageviews?.value?.toLocaleString('nl-NL')  ?? '–';
    document.getElementById('an-bounce').textContent     = s.bounce_rate?.value != null ? s.bounce_rate.value + '%' : '–';
    document.getElementById('an-duration').textContent   = fmtDuration(s.visit_duration?.value);
  } catch { /* silently fail */ }

  // Timeseries chart
  try {
    const interval = (period === 'day') ? 'hour' : (period === '12mo' || period === '6mo') ? 'month' : 'date';
    const r = await fetch(`/api/admin/analytics/timeseries?period=${period}&interval=${interval}`);
    const d = await r.json();
    const pts = d.results || [];
    const chart = document.getElementById('analytics-chart');
    const labels = document.getElementById('analytics-chart-labels');
    if (!pts.length) {
      chart.innerHTML = '<span style="color:var(--muted);font-size:.85rem">Nog geen data beschikbaar</span>';
      labels.innerHTML = '';
    } else {
      const max = Math.max(...pts.map(p => p.visitors), 1);
      chart.innerHTML = pts.map((p, i) => {
        const h = Math.max(Math.round((p.visitors / max) * 100), 2);
        const lbl = interval === 'hour'
          ? new Date(p.date).getHours() + ':00'
          : interval === 'month'
            ? new Date(p.date + 'T00:00').toLocaleDateString('nl-NL', { month: 'short' })
            : new Date(p.date + 'T00:00').toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
        return `<div class="an-bar" style="height:${h}%"><div class="an-bar-tip">${lbl}: ${p.visitors}</div></div>`;
      }).join('');
      // Show ~6 evenly spaced labels
      const step = Math.max(1, Math.floor(pts.length / 6));
      labels.innerHTML = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map(p => {
        const lbl = interval === 'hour'
          ? new Date(p.date).getHours() + ':00'
          : interval === 'month'
            ? new Date(p.date + 'T00:00').toLocaleDateString('nl-NL', { month: 'short' })
            : new Date(p.date + 'T00:00').toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
        return `<span>${lbl}</span>`;
      }).join('');
    }
  } catch {}

  // Top pages
  try {
    const r = await fetch(`/api/admin/analytics/pages?period=${period}&limit=10`);
    const d = await r.json();
    const tbody = document.getElementById('an-pages-tbody');
    const rows = d.results || [];
    tbody.innerHTML = rows.length
      ? rows.map(p => `<tr><td>${escH(p.page)}</td><td style="text-align:right">${p.visitors}</td><td style="text-align:right">${p.pageviews}</td></tr>`).join('')
      : '<tr class="empty-row"><td colspan="3">Geen data</td></tr>';
  } catch {}

  // Sources
  try {
    const r = await fetch(`/api/admin/analytics/sources?period=${period}&limit=10`);
    const d = await r.json();
    const tbody = document.getElementById('an-sources-tbody');
    const rows = d.results || [];
    tbody.innerHTML = rows.length
      ? rows.map(s => `<tr><td>${escH(s.source || 'Direct / onbekend')}</td><td style="text-align:right">${s.visitors}</td></tr>`).join('')
      : '<tr class="empty-row"><td colspan="2">Geen data</td></tr>';
  } catch {}

  // Countries
  try {
    const r = await fetch(`/api/admin/analytics/countries?period=${period}&limit=10`);
    const d = await r.json();
    const tbody = document.getElementById('an-countries-tbody');
    const rows = d.results || [];
    tbody.innerHTML = rows.length
      ? rows.map(c => `<tr><td>${countryName(c.country)}</td><td style="text-align:right">${c.visitors}</td></tr>`).join('')
      : '<tr class="empty-row"><td colspan="2">Geen data</td></tr>';
  } catch {}

  // Devices
  try {
    const r = await fetch(`/api/admin/analytics/devices?period=${period}`);
    const d = await r.json();
    const tbody = document.getElementById('an-devices-tbody');
    const rows = d.results || [];
    const deviceLabels = { Desktop: '🖥️ Desktop', Mobile: '📱 Mobiel', Tablet: '📟 Tablet' };
    tbody.innerHTML = rows.length
      ? rows.map(v => `<tr><td>${deviceLabels[v.device] || v.device}</td><td style="text-align:right">${v.visitors}</td></tr>`).join('')
      : '<tr class="empty-row"><td colspan="2">Geen data</td></tr>';
  } catch {}

  // Custom events
  try {
    const r = await fetch(`/api/admin/analytics/events?period=${period}`);
    const d = await r.json();
    const tbody = document.getElementById('an-events-tbody');
    const rows = d.results || [];
    const eventLabels = { 'Signup': '📝 Registratie', 'Payment-Start': '💳 Betaling gestart', 'Payment-Complete': '✅ Betaling voltooid', 'Contact-Form': '📧 Contactformulier' };
    tbody.innerHTML = rows.length
      ? rows.map(e => `<tr><td>${eventLabels[e.name] || e.name}</td><td style="text-align:right">${e.visitors}</td></tr>`).join('')
      : '<tr class="empty-row"><td colspan="2">Geen events geregistreerd</td></tr>';
  } catch {}

  // Update "laatste update" timestamp na alle calls
  const lu = document.getElementById('analytics-last-updated');
  if (lu) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    lu.textContent = `Laatste update: ${hh}:${mm}:${ss}`;
  }

  // Start/herstart auto-refresh zolang Analytics zichtbaar is
  startAnalyticsAutoRefresh();
}

document.getElementById('analytics-period').addEventListener('change', loadAnalytics);
document.getElementById('refresh-analytics-btn').addEventListener('click', loadAnalytics);

// Auto-refresh elke 60s zolang Analytics-tab actief is. Bij elke navigatie naar
// Analytics (showPage → loadAnalytics) wordt de timer opnieuw gestart. Stopt
// vanzelf zodra de page niet meer 'active' is.
let _analyticsAutoRefresh = null;
function startAnalyticsAutoRefresh() {
  if (_analyticsAutoRefresh) clearInterval(_analyticsAutoRefresh);
  _analyticsAutoRefresh = setInterval(() => {
    if (document.getElementById('page-analytics')?.classList.contains('active')) {
      loadAnalytics();
    } else {
      clearInterval(_analyticsAutoRefresh);
      _analyticsAutoRefresh = null;
    }
  }, 60000);
}

// ── BOEKHOUDING (Zoho Books) ─────────────────────────────────────────────
async function loadAccounting() {
  const tbody = document.getElementById('zoho-tbody');
  const helpBox = document.getElementById('zoho-config-help');
  const badge = document.getElementById('zoho-config-badge');
  tbody.innerHTML = '<tr class="load-row"><td colspan="9">Laden…</td></tr>';
  try {
    const r = await fetch('/api/admin/zoho/status');
    const d = await r.json();

    // Config badge
    if (d.configured) {
      badge.textContent = '● Verbonden';
      badge.style.background = '#dcfce7';
      badge.style.color = '#166534';
      helpBox.style.display = 'none';
    } else {
      badge.textContent = '● Niet geconfigureerd';
      badge.style.background = '#fef2f2';
      badge.style.color = '#dc2626';
      helpBox.style.display = 'block';
    }

    // Stats counts
    const c = d.counts || {};
    document.getElementById('zoho-count-synced').textContent  = c.synced  || 0;
    document.getElementById('zoho-count-pending').textContent = c.pending || 0;
    document.getElementById('zoho-count-failed').textContent  = c.failed  || 0;
    document.getElementById('zoho-count-skipped').textContent = c.skipped || 0;

    // Transactions table
    const rows = d.transactions || [];
    if (!rows.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="9">Nog geen betaalde transacties</td></tr>';
      return;
    }
    const statusLabel = {
      synced:  '<span class="badge active">✓ Gesynchroniseerd</span>',
      pending: '<span class="badge manual">⏳ Wachtrij</span>',
      failed:  '<span class="badge expired">✕ Gefaald</span>',
      skipped: '<span class="badge test">– Overgeslagen</span>',
    };
    tbody.innerHTML = rows.map(t => {
      const st = t.zoho_sync_status || 'pending';
      const action = (st === 'failed' || st === 'pending')
        ? `<button class="btn-sm btn-edit" data-action="retryZoho" data-id="${t.id}">↻ Retry</button>`
        : (t.zoho_invoice_id
            ? `<span style="font-size:.72rem;color:var(--muted)">${escH(t.zoho_invoice_id)}</span>`
            : '–');
      const vat = t.vat_rate != null ? `${t.vat_rate}%` : '–';
      const scheme = t.vat_scheme ? `<span style="font-size:.7rem;color:var(--muted)">${escH(t.vat_scheme)}</span>` : '–';
      const errorHint = t.zoho_sync_error
        ? `<br><span style="font-size:.68rem;color:var(--red)" title="${escH(t.zoho_sync_error)}">${escH(t.zoho_sync_error.slice(0,40))}…</span>`
        : '';
      return `<tr>
        <td><strong>${escH(t.invoice_number || '–')}</strong></td>
        <td>${escH(t.email)}</td>
        <td>${fmtEur(t.amount_cents)} ${escH((t.currency||'').toUpperCase())}</td>
        <td>${escH(t.country || '–')}</td>
        <td>${vat}</td>
        <td>${scheme}</td>
        <td>${fmtDate(t.created_at)}</td>
        <td>${statusLabel[st] || st}${errorHint}</td>
        <td>${action}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9">Laden mislukt: ${escH(err.message)}</td></tr>`;
  }
}

async function retryZoho(paymentId) {
  try {
    const r = await fetch(`/api/admin/zoho/retry/${paymentId}`, { method: 'POST' });
    const d = await r.json();
    if (d.synced) alert('Gelukt: Zoho-invoice aangemaakt (' + d.zoho_invoice_id + ')');
    else alert('Mislukt: ' + (d.error || 'onbekende fout'));
    loadAccounting();
  } catch (err) {
    alert('Netwerkfout: ' + err.message);
  }
}

document.getElementById('refresh-zoho-btn').addEventListener('click', loadAccounting);

// ── BLOG ──────────────────────────────────────────────────────────────────
async function loadBlog() {
  const tbody = document.getElementById('blog-tbody');
  tbody.innerHTML = '<tr class="load-row"><td colspan="6">Laden…</td></tr>';
  try {
    const r = await fetch('/api/admin/blog');
    const d = await r.json();
    const posts = d.posts || [];
    if (!posts.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Geen blogposts gevonden in content/blog/</td></tr>';
      return;
    }
    tbody.innerHTML = posts.map(p => {
      const statusBadge = p.draft
        ? '<span class="badge test">📝 Draft</span>'
        : '<span class="badge active">✓ Published</span>';
      const toggleLabel = p.draft ? '🚀 Publiceer' : '📝 Zet naar draft';
      return `<tr>
        <td><a href="/blog/${escH(p.slug)}" target="_blank" style="color:var(--blue);text-decoration:none">${escH(p.title)}</a></td>
        <td><code style="font-size:.78rem;color:var(--muted)">${escH(p.slug)}</code></td>
        <td>${escH(p.locale)}</td>
        <td>${escH(p.date || '–')}</td>
        <td>${statusBadge}</td>
        <td><button class="btn-sm btn-edit" data-action="toggleBlogDraft" data-filename="${escH(p.filename)}" data-draft="${!p.draft}">${toggleLabel}</button></td>
      </tr>`;
    }).join('');
  } catch { tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Laden mislukt</td></tr>'; }
}

async function toggleBlogDraft(filename, makeDraft) {
  try {
    const r = await fetch(`/api/admin/blog/${encodeURIComponent(filename)}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: makeDraft }),
    });
    if (r.ok) loadBlog();
    else alert('Toggle mislukt');
  } catch (err) { alert('Netwerkfout: ' + err.message); }
}

// ── REVIEWS (moderation) ─────────────────────────────────────────────────
let _reviewsFilter = 'pending';

async function loadReviews() {
  const tbody = document.getElementById('reviews-tbody');
  tbody.innerHTML = '<tr class="load-row"><td colspan="8">Laden…</td></tr>';
  try {
    const r = await fetch('/api/admin/reviews?status=' + _reviewsFilter);
    const d = await r.json();
    const reviews = d.reviews || [];

    // Update filter-badge counts
    const c = d.counts || {};
    document.getElementById('rv-cnt-pending').textContent  = c.pending  || 0;
    document.getElementById('rv-cnt-approved').textContent = c.approved || 0;
    document.getElementById('rv-cnt-rejected').textContent = c.rejected || 0;
    document.getElementById('rv-cnt-hidden').textContent   = c.hidden   || 0;

    // Highlight active filter
    document.querySelectorAll('#reviews-filter button').forEach(btn => {
      const active = btn.dataset.filter === _reviewsFilter;
      btn.style.background = active ? 'var(--blue)' : '';
      btn.style.color = active ? '#fff' : '';
      btn.style.borderColor = active ? 'var(--blue)' : '';
    });

    if (!reviews.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8">Geen reviews met deze status.</td></tr>';
      return;
    }

    const statusBadge = (s) => ({
      pending:  '<span class="badge test">⏳ Pending</span>',
      approved: '<span class="badge active">✓ Approved</span>',
      rejected: '<span class="badge expired">✕ Rejected</span>',
      hidden:   '<span class="badge">🚫 Hidden</span>',
    }[s] || escH(s));

    tbody.innerHTML = reviews.map(r => {
      const stars = '★'.repeat(r.score) + '☆'.repeat(5 - r.score);
      const actions = [];
      if (r.status !== 'approved') actions.push(`<button class="btn-sm" style="background:#dcfce7;color:#166534" data-action="moderateReview" data-id="${r.id}" data-status="approved">✓ Goedkeuren</button>`);
      if (r.status !== 'rejected') actions.push(`<button class="btn-sm" style="background:#fef2f2;color:#dc2626" data-action="moderateReview" data-id="${r.id}" data-status="rejected">✕ Afwijzen</button>`);
      if (r.status !== 'hidden')   actions.push(`<button class="btn-sm btn-secondary" data-action="moderateReview" data-id="${r.id}" data-status="hidden">🚫 Verberg</button>`);
      if (r.status !== 'pending')  actions.push(`<button class="btn-sm btn-secondary" data-action="moderateReview" data-id="${r.id}" data-status="pending">↩ Reset</button>`);
      actions.push(`<button class="btn-sm btn-secondary" style="color:#dc2626" data-action="deleteReview" data-id="${r.id}">🗑</button>`);
      return `<tr>
        <td style="font-size:.78rem;color:var(--muted);white-space:nowrap">${fmtDT(r.created_at)}</td>
        <td style="color:#f59e0b;white-space:nowrap">${stars}</td>
        <td>${escH(r.display_name || '–')}</td>
        <td style="max-width:320px">${r.comment ? escH(r.comment).replace(/\n/g,'<br>') : '<span style="color:var(--muted)">(geen)</span>'}</td>
        <td style="font-size:.78rem">${escH(r.email || '–')}</td>
        <td>${escH(r.country || '–')}</td>
        <td>${statusBadge(r.status)}</td>
        <td style="white-space:nowrap">${actions.join(' ')}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">Laden mislukt: ' + escH(err.message) + '</td></tr>';
  }
}

async function moderateReview(id, status) {
  try {
    const r = await fetch('/api/admin/reviews/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (r.ok) loadReviews();
    else alert('Moderatie mislukt: ' + (await r.text()));
  } catch (err) { alert('Netwerkfout: ' + err.message); }
}

async function deleteReview(id) {
  if (!confirm('Definitief verwijderen? Dit kan niet ongedaan worden gemaakt. Gebruik \"Verberg\" als alternatief.')) return;
  try {
    const r = await fetch('/api/admin/reviews/' + encodeURIComponent(id), { method: 'DELETE' });
    if (r.ok) loadReviews();
    else alert('Verwijderen mislukt');
  } catch (err) { alert('Netwerkfout: ' + err.message); }
}

document.querySelectorAll('#reviews-filter button').forEach(btn => {
  btn.addEventListener('click', () => {
    _reviewsFilter = btn.dataset.filter;
    loadReviews();
  });
});

// ── MONITORING (Sentry + audit log) ──────────────────────────────────────
async function loadMonitoring() {
  // Sentry status
  const badge = document.getElementById('sentry-status-badge');
  const help  = document.getElementById('sentry-setup-help');
  try {
    const r = await fetch('/api/admin/sentry/status');
    const d = await r.json();
    if (d.enabled) {
      badge.textContent = '● Actief';
      badge.style.background = '#dcfce7';
      badge.style.color = '#166534';
      help.style.display = 'none';
    } else {
      badge.textContent = '○ Niet geconfigureerd';
      badge.style.background = '#fef2f2';
      badge.style.color = '#dc2626';
      help.style.display = 'block';
    }
  } catch {}

  // Audit log
  const tbody = document.getElementById('audit-tbody');
  tbody.innerHTML = '<tr class="load-row"><td colspan="5">Laden…</td></tr>';
  try {
    const r = await fetch('/api/admin/audit?limit=100');
    const d = await r.json();
    const entries = d.entries || [];
    if (!entries.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Nog geen audit-entries</td></tr>';
      return;
    }
    tbody.innerHTML = entries.map(e => `<tr>
      <td>${fmtDT(e.created_at)}</td>
      <td>${escH(e.actor_email || '–')}</td>
      <td><code style="font-size:.78rem;background:#F8FAFC;padding:2px 6px;border-radius:4px">${escH(e.action)}</code></td>
      <td>${e.target_type ? escH(e.target_type) + ':' + escH(e.target_id || '') : '–'}</td>
      <td style="font-size:.78rem;color:var(--muted)">${escH(e.ip || '–')}</td>
    </tr>`).join('');
  } catch {}
}

document.getElementById('sentry-test-btn').addEventListener('click', async () => {
  const btn = document.getElementById('sentry-test-btn');
  const result = document.getElementById('sentry-test-result');
  btn.disabled = true;
  result.textContent = 'Bezig…';
  try {
    const r = await fetch('/api/admin/sentry/test', { method: 'POST' });
    const d = await r.json();
    if (r.ok) {
      result.innerHTML = '<span style="color:var(--green)">✓ ' + escH(d.message) + '</span> <a href="https://sentry.io" target="_blank" style="color:var(--blue)">→ check Sentry</a>';
    } else {
      result.innerHTML = '<span style="color:var(--red)">' + escH(d.error || 'Mislukt') + '</span>';
    }
  } catch (err) {
    result.innerHTML = '<span style="color:var(--red)">Netwerkfout: ' + escH(err.message) + '</span>';
  }
  btn.disabled = false;
});

document.getElementById('sentry-dsn-save').addEventListener('click', async () => {
  const input = document.getElementById('sentry-dsn-input');
  const btn   = document.getElementById('sentry-dsn-save');
  const out   = document.getElementById('sentry-dsn-result');
  const dsn   = input.value.trim();
  btn.disabled = true;
  out.textContent = 'Bezig…';
  try {
    const r = await fetch('/api/admin/sentry/set-dsn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dsn }),
    });
    const d = await r.json();
    if (r.ok) {
      out.innerHTML = '<span style="color:var(--green)">✓ ' + escH(d.message) + '</span>';
      input.value = ''; // don't leave the DSN in the DOM
    } else {
      out.innerHTML = '<span style="color:var(--red)">✗ ' + escH(d.error || 'Mislukt') + '</span>';
    }
  } catch (err) {
    out.innerHTML = '<span style="color:var(--red)">Netwerkfout: ' + escH(err.message) + '</span>';
  }
  btn.disabled = false;
});

// ── VOUCHERS ─────────────────────────────────────────────────────────────
async function loadVouchers() {
  const tbody = document.getElementById('vouchers-tbody');
  const badge = document.getElementById('vouchers-enabled-badge');
  tbody.innerHTML = '<tr class="load-row"><td colspan="7">Laden…</td></tr>';
  try {
    const r = await fetch('/api/admin/vouchers');
    const d = await r.json();
    if (d.enabled) {
      badge.textContent = '● Actief';
      badge.style.background = '#dcfce7';
      badge.style.color = '#166534';
    } else {
      badge.textContent = '○ Uitgeschakeld';
      badge.style.background = '#fef2f2';
      badge.style.color = '#dc2626';
    }
    const rows = d.vouchers || [];
    if (!rows.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Geen vouchers aangemaakt</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(v => {
      const reward = v.discount_percent
        ? `<span class="badge manual">${v.discount_percent}% korting</span>`
        : v.free_days
        ? `<span class="badge active">${v.free_days} gratis dagen</span>`
        : '–';
      const expiry = v.expires_at ? fmtDate(v.expires_at) : '–';
      const max = v.max_uses || '∞';
      return `<tr>
        <td><strong><code style="font-family:monospace;background:#fff1ed;padding:3px 8px;border-radius:4px;color:#E85D3A">${escH(v.code)}</code></strong></td>
        <td>${escH(v.description || '–')}</td>
        <td>${reward}</td>
        <td style="text-align:right"><strong>${v.redeemed_count}</strong></td>
        <td>${max}</td>
        <td>${expiry}</td>
        <td><button class="btn-sm btn-del" data-action="deleteVoucher" data-id="${v.id}" data-code="${escH(v.code)}">🗑️ Verwijder</button></td>
      </tr>`;
    }).join('');
  } catch { tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Laden mislukt</td></tr>'; }
}

async function deleteVoucher(id, code) {
  if (!confirm(`Voucher "${code}" verwijderen?`)) return;
  await fetch(`/api/admin/vouchers/${id}`, { method: 'DELETE' });
  loadVouchers();
}

document.getElementById('create-voucher-btn').addEventListener('click', async () => {
  const btn = document.getElementById('create-voucher-btn');
  btn.disabled = true;
  const body = {
    code:            document.getElementById('nv-code').value.trim().toUpperCase(),
    description:     document.getElementById('nv-description').value.trim() || null,
    discountPercent: document.getElementById('nv-discount').value ? parseInt(document.getElementById('nv-discount').value, 10) : null,
    freeDays:        document.getElementById('nv-free-days').value ? parseInt(document.getElementById('nv-free-days').value, 10) : null,
    maxUses:         document.getElementById('nv-max-uses').value ? parseInt(document.getElementById('nv-max-uses').value, 10) : null,
    expiresAt:       document.getElementById('nv-expires').value ? new Date(document.getElementById('nv-expires').value + 'T23:59:59').getTime() : null,
  };
  try {
    const res = await fetch('/api/admin/vouchers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok) {
      showAlert('voucher-alert', 'Voucher aangemaakt', 'ok');
      document.getElementById('nv-code').value = '';
      document.getElementById('nv-description').value = '';
      document.getElementById('nv-discount').value = '';
      document.getElementById('nv-free-days').value = '';
      document.getElementById('nv-max-uses').value = '';
      document.getElementById('nv-expires').value = '';
      loadVouchers();
    } else {
      showAlert('voucher-alert', data.error || 'Mislukt', 'err');
    }
  } catch { showAlert('voucher-alert', 'Netwerkfout', 'err'); }
  btn.disabled = false;
});

document.getElementById('toggle-vouchers-btn').addEventListener('click', async () => {
  const currentBadge = document.getElementById('vouchers-enabled-badge').textContent;
  const nowEnabled = currentBadge.includes('Uitgeschakeld');
  await fetch('/api/admin/vouchers/enabled', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: nowEnabled }),
  });
  loadVouchers();
});

// ── REFERRALS ─────────────────────────────────────────────────────────────
async function loadReferrals() {
  const tbody = document.getElementById('referrals-tbody');
  tbody.innerHTML = '<tr class="load-row"><td colspan="6">Laden…</td></tr>';
  try {
    const r = await fetch('/api/admin/referrals');
    const d = await r.json();
    document.getElementById('ref-total-referred').textContent  = d.totals.total_referred || 0;
    document.getElementById('ref-total-converted').textContent = d.totals.total_converted || 0;
    document.getElementById('ref-total-rewards').textContent   = d.totals.total_rewards_applied || 0;

    const rows = d.topReferrers || [];
    if (!rows.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Nog geen referrals</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${escH(r.email)}</td>
        <td><code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:.78rem">${escH(r.referral_code || '-')}</code></td>
        <td style="text-align:right">${r.referred_total}</td>
        <td style="text-align:right"><strong>${r.converted}</strong></td>
        <td style="text-align:right">${r.rewards > 0 ? '<span class="badge active">🎁 ' + r.rewards + '</span>' : '–'}</td>
        <td>${fmtDate(r.created_at)}</td>
      </tr>`).join('');
  } catch { tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Laden mislukt</td></tr>'; }
}

// ── Zoho EU tax bulk-setup ─────────────────────────────────────────────────
async function zohoTaxSetup(dryRun) {
  const btn = dryRun ? document.getElementById('zoho-plan-btn') : document.getElementById('zoho-create-taxes-btn');
  const result = document.getElementById('zoho-tax-result');
  btn.disabled = true;
  result.innerHTML = '<span style="color:var(--muted)">Bezig…</span>';
  try {
    const url = '/api/admin/zoho/ensure-eu-taxes' + (dryRun ? '?dryRun=1' : '');
    const r = await fetch(url, { method: 'POST' });
    const d = await r.json();
    if (!r.ok) {
      result.innerHTML = '<span style="color:var(--red)">Fout: ' + escH(d.error || 'onbekend') + '</span>';
    } else if (d.dryRun) {
      const rows = d.plan.map(p => `<tr><td>${escH(p.name)}</td><td style="text-align:right">${p.rate}%</td><td>${escH(p.scheme)}</td></tr>`).join('');
      result.innerHTML = `<div style="margin-bottom:8px"><strong>${d.plan.length}</strong> nieuwe tarieven zullen worden aangemaakt (${d.totalExisting} bestaan al)</div>
        <div class="tbl-wrap" style="max-height:280px;overflow-y:auto"><table><thead><tr><th>Naam</th><th>Tarief</th><th>Regeling</th></tr></thead><tbody>${rows || '<tr class="empty-row"><td colspan="3">Alles bestaat al!</td></tr>'}</tbody></table></div>`;
    } else {
      const summary = `<div style="color:var(--green);margin-bottom:8px">✓ ${d.created} aangemaakt${d.failed > 0 ? ', <span style="color:var(--red)">' + d.failed + ' gefaald</span>' : ''} (${d.totalExisting} bestonden al)</div>`;
      const failedRows = d.results.filter(r => !r.success).map(r => `<tr><td>${escH(r.name)}</td><td style="color:var(--red);font-size:.75rem">${escH(r.error || '')}</td></tr>`).join('');
      result.innerHTML = summary + (failedRows ? `<div class="tbl-wrap"><table><thead><tr><th>Naam</th><th>Fout</th></tr></thead><tbody>${failedRows}</tbody></table></div>` : '');
      loadAccounting(); // refresh the status view
    }
  } catch (err) {
    result.innerHTML = '<span style="color:var(--red)">Netwerkfout: ' + escH(err.message) + '</span>';
  }
  btn.disabled = false;
}
document.getElementById('zoho-plan-btn').addEventListener('click', () => zohoTaxSetup(true));
document.getElementById('zoho-create-taxes-btn').addEventListener('click', () => {
  if (confirm('Dit maakt ~30 nieuwe tax codes aan in Zoho Books. Doorgaan?')) zohoTaxSetup(false);
});

// ── Init ───────────────────────────────────────────────────────────────────
(async () => {
  await checkAuth();
  loadDashboard();
})();
