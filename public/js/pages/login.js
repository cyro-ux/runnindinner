// Uit login.html gelicht: inline <script> mag niet meer onder de CSP
// (script-src zonder 'unsafe-inline').
  I18n.onReady(() => {
    const c = document.getElementById('auth-lang-toggle');
    if (c) c.appendChild(I18n.createToggle());
  });

  // Redirect if already logged in
  fetch('/api/auth/me').then(r => {
    if (r.ok) return r.json();
  }).then(data => {
    if (data?.ok) {
      window.location.href = data.user.role === 'admin' ? '/admin/' : '/app';
    }
  }).catch(() => {});

  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('submit-btn');
    const err = document.getElementById('error-msg');
    btn.disabled = true;
    btn.textContent = I18n.t('auth.login.logging_in', 'Inloggen...');
    err.style.display = 'none';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email:    document.getElementById('email').value,
          password: document.getElementById('password').value,
        }),
      });
      const data = await res.json();

      if (res.ok) {
        const redirect = new URLSearchParams(location.search).get('next') || '/app';
        window.location.href = data.user?.role === 'admin' ? '/admin/' : redirect;
      } else {
        err.textContent = data.error || I18n.t('auth.login.error_failed', 'Inloggen mislukt');
        err.style.display = 'block';
        btn.disabled = false;
        btn.textContent = I18n.t('auth.login.submit', 'Inloggen');
      }
    } catch {
      err.textContent = I18n.t('auth.login.error_network', 'Netwerkfout. Probeer het opnieuw.');
      err.style.display = 'block';
      btn.disabled = false;
      btn.textContent = I18n.t('auth.login.submit', 'Inloggen');
    }
  });
