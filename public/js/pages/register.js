// Uit register.html gelicht: inline <script> mag niet meer onder de CSP
// (script-src zonder 'unsafe-inline').
  I18n.onReady(() => {
    const c = document.getElementById('auth-lang-toggle');
    if (c) c.appendChild(I18n.createToggle());
  });

  // Capture referral code from URL if present (persist in sessionStorage in case
  // user navigates away and back)
  const urlParams = new URLSearchParams(window.location.search);
  const urlRef = urlParams.get('ref');
  if (urlRef) {
    sessionStorage.setItem('rd_ref', urlRef);
    // Show a subtle "invited by a friend" banner
    const banner = document.createElement('div');
    banner.style.cssText = 'background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px;font-size:.85rem;color:#166534;margin-bottom:16px;text-align:center';
    banner.innerHTML = '🎉 ' + I18n.t('auth.register.invited', 'Je bent uitgenodigd door een vriend!');
    const form = document.getElementById('register-form');
    form.parentElement.insertBefore(banner, form);
  }

  // Show/hide business fields based on radio selection
  const bizFields = document.getElementById('business-fields');
  document.querySelectorAll('input[name="account-type"]').forEach(r => {
    r.addEventListener('change', () => {
      const isBiz = document.querySelector('input[name="account-type"]:checked').value === 'business';
      bizFields.style.display = isBiz ? 'block' : 'none';
      // Highlight selected card
      document.getElementById('type-consumer-lbl').style.background = isBiz ? '#f9fafb' : '#eff6ff';
      document.getElementById('type-business-lbl').style.background = isBiz ? '#eff6ff' : '#f9fafb';
    });
  });
  // Apply initial highlight
  document.getElementById('type-consumer-lbl').style.background = '#eff6ff';

  document.getElementById('register-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn    = document.getElementById('submit-btn');
    const errEl  = document.getElementById('error-msg');
    const succEl = document.getElementById('success-msg');
    errEl.style.display = succEl.style.display = 'none';

    const password  = document.getElementById('password').value;
    const password2 = document.getElementById('password2').value;
    if (password !== password2) {
      errEl.textContent = I18n.t('auth.register.error_mismatch', 'Wachtwoorden komen niet overeen');
      errEl.style.display = 'block';
      return;
    }

    const isBusiness = document.querySelector('input[name="account-type"]:checked').value === 'business';
    const companyName = document.getElementById('company-name').value.trim();
    const vatId = document.getElementById('vat-id').value.trim();
    if (isBusiness && !companyName) {
      errEl.textContent = I18n.t('auth.register.error_company_required', 'Bedrijfsnaam is verplicht bij zakelijke registratie');
      errEl.style.display = 'block';
      return;
    }

    btn.disabled = true;
    btn.textContent = I18n.t('auth.register.creating', 'Account aanmaken…');

    try {
      const refCode = sessionStorage.getItem('rd_ref') || urlRef || null;
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: document.getElementById('email').value,
          password,
          referralCode: refCode,
          isBusiness,
          companyName: isBusiness ? companyName : null,
          vatId: isBusiness ? vatId : null,
        }),
      });
      const data = await res.json();

      if (res.ok) {
        // Auto-login and redirect to subscribe page — consumer must tick the
        // waiver checkbox there; we no longer auto-call create-payment since
        // that endpoint now requires explicit consent for consumer accounts.
        const loginRes = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: document.getElementById('email').value, password }),
        });
        if (window.plausible) plausible('Signup');
        succEl.textContent = I18n.t('auth.register.success_redirect', 'Account aangemaakt! Doorsturen naar betaalpagina…');
        succEl.style.display = 'block';
        setTimeout(() => { window.location.href = loginRes.ok ? '/subscribe.html' : '/login.html?next=/subscribe.html'; }, 800);
      } else {
        errEl.textContent = data.error || I18n.t('auth.register.error_failed', 'Registreren mislukt');
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = I18n.t('auth.register.submit', 'Account aanmaken → naar betalen');
      }
    } catch {
      errEl.textContent = I18n.t('auth.register.error_network', 'Netwerkfout. Probeer het opnieuw.');
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = I18n.t('auth.register.submit', 'Account aanmaken → naar betalen');
    }
  });
