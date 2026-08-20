// Uit forgot-password.html gelicht: inline <script> mag niet meer onder de CSP
// (script-src zonder 'unsafe-inline').
  I18n.onReady(() => {
    const c = document.getElementById('auth-lang-toggle');
    if (c) c.appendChild(I18n.createToggle());
  });

  document.getElementById('forgot-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn   = document.getElementById('submit-btn');
    const succEl = document.getElementById('success-msg');
    const errEl  = document.getElementById('error-msg');
    succEl.style.display = errEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = I18n.t('auth.forgot.sending', 'Versturen...');

    try {
      const res  = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: document.getElementById('email').value }),
      });
      const data = await res.json();
      succEl.textContent = data.message || I18n.t('auth.forgot.success', 'Als dit adres bekend is, ontvang je een e-mail.');
      succEl.style.display = 'block';
      e.target.reset();
    } catch {
      errEl.textContent = I18n.t('auth.forgot.error_network', 'Netwerkfout. Probeer het opnieuw.');
      errEl.style.display = 'block';
    }

    btn.disabled = false;
    btn.textContent = I18n.t('auth.forgot.submit', 'Verstuur resetlink');
  });
