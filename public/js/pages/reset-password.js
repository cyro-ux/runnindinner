// Uit reset-password.html gelicht: inline <script> mag niet meer onder de CSP
// (script-src zonder 'unsafe-inline').
  I18n.onReady(() => {
    const c = document.getElementById('auth-lang-toggle');
    if (c) c.appendChild(I18n.createToggle());
  });

  const token = new URLSearchParams(location.search).get('token');
  if (!token) {
    const err = document.getElementById('error-msg');
    err.textContent = I18n.t('auth.reset.error_invalid_link', 'Ongeldige resetlink. Vraag een nieuwe aan via "Wachtwoord vergeten".');
    err.style.display = 'block';
    document.getElementById('reset-form').style.display = 'none';
  }

  document.getElementById('reset-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn   = document.getElementById('submit-btn');
    const errEl  = document.getElementById('error-msg');
    const succEl = document.getElementById('success-msg');
    errEl.style.display = succEl.style.display = 'none';

    const password  = document.getElementById('password').value;
    const password2 = document.getElementById('password2').value;
    if (password !== password2) {
      errEl.textContent = I18n.t('auth.reset.error_mismatch', 'Wachtwoorden komen niet overeen');
      errEl.style.display = 'block';
      return;
    }

    btn.disabled = true;
    btn.textContent = I18n.t('auth.reset.saving', 'Opslaan...');

    try {
      const res  = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();

      if (res.ok) {
        succEl.textContent = data.message || I18n.t('auth.reset.success', 'Wachtwoord gewijzigd!');
        succEl.style.display = 'block';
        document.getElementById('login-link').style.display = 'block';
        document.getElementById('reset-form').style.display = 'none';
      } else {
        errEl.textContent = data.error || I18n.t('auth.reset.error_failed', 'Reset mislukt');
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = I18n.t('auth.reset.submit', 'Wachtwoord opslaan');
      }
    } catch {
      errEl.textContent = I18n.t('auth.reset.error_network', 'Netwerkfout. Probeer het opnieuw.');
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = I18n.t('auth.reset.submit', 'Wachtwoord opslaan');
    }
  });
