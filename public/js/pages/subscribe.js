// Uit subscribe.html gelicht: inline <script> mag niet meer onder de CSP
// (script-src zonder 'unsafe-inline').
  I18n.onReady(() => {
    const c = document.getElementById('auth-lang-toggle');
    if (c) c.appendChild(I18n.createToggle());
  });

  const params = new URLSearchParams(location.search);
  if (params.get('cancelled')) {
    document.getElementById('cancelled-msg').style.display = 'block';
  }

  const autoRenewCb = document.getElementById('auto-renew-cb');
  const autoRenewInfo = document.getElementById('auto-renew-info');
  const waiverCb = document.getElementById('waiver-cb');
  const payBtn   = document.getElementById('pay-btn');

  autoRenewCb.addEventListener('change', () => {
    autoRenewInfo.style.display = autoRenewCb.checked ? 'block' : 'none';
  });

  // Pay-button blijft disabled tot de herroepingsrecht-waiver is aangevinkt
  // (alleen voor consumenten — zakelijke gebruikers krijgen de button direct
  // enabled in de /api/auth/me-handler hierboven).
  waiverCb.addEventListener('change', () => {
    if (!isBusinessUser) payBtn.disabled = !waiverCb.checked;
  });

  // Check auth + existing license + account type (B2B/B2C)
  let isBusinessUser = false;
  fetch('/api/auth/me')
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(data => {
      if (!data?.ok) { window.location.href = '/login.html?next=/subscribe.html'; return; }
      const user = data.user;
      if (user.license_until && user.license_until > Date.now()) {
        const until = new Date(user.license_until).toLocaleDateString('nl-NL');
        const alr   = document.getElementById('already-msg');
        alr.textContent = I18n.t('auth.subscribe.already_active_prefix', 'Je hebt al een actief abonnement t/m ') + until + I18n.t('auth.subscribe.already_active_suffix', '. Betalen verlengt je abonnement met 1 jaar.');
        alr.style.display = 'block';
      }
      // B2B users: hide waiver (right-of-withdrawal only applies to consumers),
      // unlock pay button directly, show business-info note instead.
      isBusinessUser = !!user.is_business;
      if (isBusinessUser) {
        document.getElementById('waiver-wrap').style.display = 'none';
        document.getElementById('business-note').style.display = 'block';
        payBtn.disabled = false;
      }
    })
    .catch(() => { window.location.href = '/login.html?next=/subscribe.html'; });

  // Load actual price (multi-currency aware)
  fetch('/api/pricing')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data) document.getElementById('price-display').innerHTML = data.displayPrice + ' <span>' + I18n.t('auth.subscribe.per_year', '/ jaar') + '</span>';
    })
    .catch(() => {});

  // Initiate payment
  document.getElementById('pay-btn').addEventListener('click', async () => {
    const btn = document.getElementById('pay-btn');
    const err = document.getElementById('error-msg');
    btn.disabled = true;
    btn.textContent = I18n.t('auth.subscribe.redirecting', 'Doorsturen naar betaalpagina...');
    err.style.display = 'none';

    try {
      const res  = await fetch('/api/mollie/create-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoRenew: autoRenewCb.checked,
          // Waiver-checkbox telt alleen voor consumenten; voor zakelijke
          // klanten laten we het server-side toch op 'true' staan zodat de
          // payment-call niet onnodig faalt.
          waiverAccepted: isBusinessUser ? true : waiverCb.checked,
        }),
      });
      const data = await res.json();
      if (res.ok && data.url) {
        if (window.plausible) plausible('Payment-Start');
        window.location.href = data.url;
      } else {
        err.textContent = data.error || I18n.t('auth.subscribe.error_payment', 'Betaling kon niet worden gestart.');
        err.style.display = 'block';
        btn.disabled = false;
        btn.textContent = I18n.t('auth.subscribe.pay_button_text', 'Nu betalen & direct toegang');
      }
    } catch {
      err.textContent = I18n.t('auth.subscribe.error_network', 'Netwerkfout. Probeer het opnieuw.');
      err.style.display = 'block';
      btn.disabled = false;
      btn.textContent = I18n.t('auth.subscribe.pay_button_text', 'Nu betalen & direct toegang');
    }
  });
