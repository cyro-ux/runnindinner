// Uit profile.html gelicht: inline <script> mag niet meer onder de CSP
// (script-src zonder 'unsafe-inline').
  I18n.onReady(() => {
    const c = document.getElementById('auth-lang-toggle');
    if (c) c.appendChild(I18n.createToggle());
  });

  const $ = s => document.querySelector(s);

  // Auth check
  async function loadProfile() {
    const r = await fetch('/api/user/profile');
    if (!r.ok) { window.location.href = '/login.html'; return; }
    const { user, payments } = await r.json();

    // Account info
    $('#user-email').textContent = user.email;
    $('#user-since').textContent = new Date(user.created_at).toLocaleDateString('nl-NL', { year: 'numeric', month: 'long', day: 'numeric' });

    if (user.license_until) {
      const expiry = new Date(user.license_until);
      const active = expiry > new Date();
      const badgeText = active ? I18n.t('auth.profile.badge_active', 'Actief') : I18n.t('auth.profile.badge_expired', 'Verlopen');
      $('#user-license').innerHTML = `
        <span class="badge ${active ? 'badge-active' : 'badge-expired'}">${badgeText}</span>
        ${I18n.t('auth.profile.until_prefix', 't/m')} ${expiry.toLocaleDateString('nl-NL', { year: 'numeric', month: 'long', day: 'numeric' })}
      `;
    } else {
      $('#user-license').innerHTML = '<span class="badge badge-none">' + I18n.t('auth.profile.badge_none', 'Geen abonnement') + '</span>';
    }

    // Auto-renewal
    renderAutoRenew(user);

    // Invoices
    const container = $('#invoices-container');
    if (!payments || payments.length === 0) {
      container.innerHTML = '<div class="empty-state">' + I18n.t('auth.profile.no_invoices', 'Je hebt nog geen facturen.') + '</div>';
      return;
    }

    const downloadIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M10 2a1 1 0 011 1v7.586l2.293-2.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L9 10.586V3a1 1 0 011-1z"/><path d="M3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"/></svg>`;

    container.innerHTML = `
      <table class="invoice-table">
        <thead>
          <tr>
            <th>${I18n.t('auth.profile.invoice_number', 'Factuurnummer')}</th>
            <th>${I18n.t('auth.profile.invoice_date', 'Datum')}</th>
            <th>${I18n.t('auth.profile.invoice_amount', 'Bedrag')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${payments.map(p => `
            <tr>
              <td>${p.invoice_number}</td>
              <td>${new Date(p.created_at).toLocaleDateString('nl-NL')}</td>
              <td>${new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(p.amount_cents / 100)}</td>
              <td>
                <a href="/api/payments/invoice/${encodeURIComponent(p.invoice_number)}" class="btn-download" download>
                  ${downloadIcon} PDF
                </a>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderAutoRenew(user) {
    const status = $('#ar-status');
    const actions = $('#ar-actions');
    const hasMandate = !!user.mollie_mandate_id;
    const isOn = !!user.auto_renew;

    if (isOn) {
      status.innerHTML = '<span class="badge badge-active">' + I18n.t('auth.profile.ar_enabled', 'Ingeschakeld') + '</span>';
      if (user.license_until) {
        $('#ar-next-label').style.display = '';
        $('#ar-next').style.display = '';
        $('#ar-next').textContent = new Date(user.license_until).toLocaleDateString('nl-NL', { year: 'numeric', month: 'long', day: 'numeric' });
      }
      actions.innerHTML = '<button class="btn-save" id="ar-toggle-btn" style="background:#dc2626">' + I18n.t('auth.profile.ar_disable', 'Uitschakelen') + '</button>';
    } else if (hasMandate) {
      status.innerHTML = '<span class="badge badge-expired">' + I18n.t('auth.profile.ar_disabled', 'Uitgeschakeld') + '</span> <span style="color:#6b7280;font-size:13px">(' + I18n.t('auth.profile.ar_mandate_active', 'machtiging actief') + ')</span>';
      actions.innerHTML = '<button class="btn-save" id="ar-toggle-btn">' + I18n.t('auth.profile.ar_enable', 'Inschakelen') + '</button>';
    } else {
      status.innerHTML = '<span class="badge badge-none">' + I18n.t('auth.profile.ar_unavailable', 'Niet beschikbaar') + '</span>';
      actions.innerHTML = '<p style="font-size:13px;color:#6b7280;margin:0">' + I18n.t('auth.profile.ar_activate_hint', 'Activeer automatische verlenging bij je') + ' <a href="/subscribe.html" style="color:#1a56db">' + I18n.t('auth.profile.ar_next_payment_link', 'volgende betaling') + '</a>.</p>';
      return;
    }

    $('#ar-toggle-btn').addEventListener('click', async () => {
      const btn = $('#ar-toggle-btn');
      const msg = $('#ar-msg');
      btn.disabled = true;
      msg.textContent = '';
      try {
        const r = await fetch('/api/user/auto-renew', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !isOn }),
        });
        const data = await r.json();
        if (r.ok) {
          msg.textContent = data.message;
          msg.className = 'msg msg-ok';
          // Reload to refresh state
          setTimeout(() => loadProfile(), 800);
        } else {
          msg.textContent = data.error || I18n.t('auth.profile.error_generic', 'Er ging iets mis.');
          msg.className = 'msg msg-err';
          btn.disabled = false;
        }
      } catch {
        msg.textContent = I18n.t('auth.profile.error_connection', 'Verbindingsfout.');
        msg.className = 'msg msg-err';
        btn.disabled = false;
      }
    });
  }

  loadProfile();

  // ── Referral programma ──────────────────────────────────────────────────
  async function loadReferral() {
    try {
      const r = await fetch('/api/user/referral');
      const d = await r.json();
      if (!d.ok) return;
      document.getElementById('ref-url').value = d.inviteUrl;
      document.getElementById('ref-stat-converted').textContent = d.stats.converted;
      document.getElementById('ref-stat-rewards').textContent = d.stats.rewardsEarned;
      document.getElementById('ref-stat-needed').textContent = d.stats.neededForNextReward;

      const shareText = I18n.t('auth.profile.referral_share_text',
        'Ik gebruik Running Dinner Planner om een running dinner te organiseren — supermakkelijk en maar €5 per jaar. Meld je aan via deze link dan krijgen we allebei een bonus:') + ' ' + d.inviteUrl;
      const utm = '&utm_source={src}&utm_medium=referral&utm_campaign=invite';

      const hookShare = (id, getUrl) => {
        const btn = document.getElementById(id);
        if (btn) btn.addEventListener('click', () => window.open(getUrl(), '_blank'));
      };
      hookShare('share-whatsapp', () => `https://wa.me/?text=${encodeURIComponent(shareText + ' ' + utm.replace('{src}', 'whatsapp'))}`);
      hookShare('share-email',    () => `mailto:?subject=${encodeURIComponent('Running Dinner Planner')}&body=${encodeURIComponent(shareText)}`);
      hookShare('share-facebook', () => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(d.inviteUrl + '?utm_source=facebook&utm_medium=referral&utm_campaign=invite')}`);
      hookShare('share-linkedin', () => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(d.inviteUrl + '?utm_source=linkedin&utm_medium=referral&utm_campaign=invite')}`);

      // Web Share API on mobile
      if (navigator.share) {
        const nativeBtn = document.getElementById('share-native');
        nativeBtn.style.display = 'inline-flex';
        nativeBtn.addEventListener('click', () => {
          navigator.share({ title: 'Running Dinner Planner', text: shareText, url: d.inviteUrl }).catch(() => {});
        });
      }

      // Copy button
      document.getElementById('ref-copy-btn').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(d.inviteUrl);
          const btn = document.getElementById('ref-copy-btn');
          const orig = btn.textContent;
          btn.textContent = '✓ ' + I18n.t('auth.profile.referral_copied', 'Gekopieerd');
          setTimeout(() => { btn.textContent = orig; }, 1500);
        } catch { /* fallback: select the text */ document.getElementById('ref-url').select(); }
      });
    } catch { /* silent fail */ }
  }
  loadReferral();

  // ── GDPR: delete account flow ──────────────────────────────────────────
  const delModal = document.getElementById('delete-modal');
  document.getElementById('delete-account-btn').addEventListener('click', () => {
    delModal.style.display = 'flex';
    document.getElementById('del-confirm').value = '';
    document.getElementById('del-password').value = '';
    document.getElementById('del-msg').textContent = '';
  });
  document.getElementById('del-cancel-btn').addEventListener('click', () => {
    delModal.style.display = 'none';
  });
  document.getElementById('del-confirm-btn').addEventListener('click', async () => {
    const confirm = document.getElementById('del-confirm').value;
    const password = document.getElementById('del-password').value;
    const msg = document.getElementById('del-msg');
    msg.textContent = '';
    if (confirm !== 'DELETE') {
      msg.textContent = I18n.t('auth.profile.delete_err_type', 'Typ exact "DELETE" om te bevestigen.');
      msg.className = 'msg msg-err';
      return;
    }
    if (!password) {
      msg.textContent = I18n.t('auth.profile.delete_err_password', 'Wachtwoord is verplicht.');
      msg.className = 'msg msg-err';
      return;
    }
    try {
      const r = await fetch('/api/user/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm, password }),
      });
      const d = await r.json();
      if (r.ok) {
        msg.textContent = I18n.t('auth.profile.delete_success', 'Account verwijderd. Je wordt uitgelogd…');
        msg.className = 'msg msg-ok';
        setTimeout(() => { window.location.href = '/'; }, 1500);
      } else {
        msg.textContent = d.error || I18n.t('auth.profile.delete_err_generic', 'Verwijderen mislukt.');
        msg.className = 'msg msg-err';
      }
    } catch {
      msg.textContent = I18n.t('auth.profile.error_connection', 'Verbindingsfout.');
      msg.className = 'msg msg-err';
    }
  });

  // Change password
  $('#pw-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#pw-btn');
    const msg = $('#pw-msg');
    btn.disabled = true;
    msg.textContent = '';

    try {
      const r = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: $('#current-pw').value,
          newPassword: $('#new-pw').value,
        }),
      });
      const data = await r.json();
      if (r.ok) {
        msg.textContent = I18n.t('auth.profile.password_changed', 'Wachtwoord gewijzigd!');
        msg.className = 'msg msg-ok';
        $('#pw-form').reset();
      } else {
        msg.textContent = data.error || I18n.t('auth.profile.error_generic', 'Er ging iets mis.');
        msg.className = 'msg msg-err';
      }
    } catch {
      msg.textContent = I18n.t('auth.profile.error_connection', 'Verbindingsfout.');
      msg.className = 'msg msg-err';
    }
    btn.disabled = false;
  });

  // Logout
  $('#logout-btn').addEventListener('click', async e => {
    e.preventDefault();
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });
