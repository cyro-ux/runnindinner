// Uit brevo-setup.html gelicht: inline <script> mag niet meer onder de CSP
// (script-src zonder 'unsafe-inline').
(() => {
  const hash = location.hash.replace(/^#/, '');
  // Accept both API keys (xkeysib-...) and SMTP keys (xsmtpsib-...)
  if (hash.startsWith('xkeysib-') || hash.startsWith('xsmtpsib-')) {
    document.getElementById('apikey').value = hash;
  }
  // Try sessionStorage as fallback (survives login redirect)
  const stored = sessionStorage.getItem('brevoKey');
  if (!hash && stored) document.getElementById('apikey').value = stored;
})();

document.getElementById('go').addEventListener('click', async () => {
  const btn = document.getElementById('go');
  const result = document.getElementById('result');
  const key = document.getElementById('apikey').value.trim();
  btn.disabled = true;
  result.style.display = 'none';

  // Route to correct endpoint based on prefix
  const endpoint = key.startsWith('xsmtpsib-')
    ? '/api/admin/brevo/set-smtp-key'
    : '/api/admin/brevo/set-key';
  const body = key.startsWith('xsmtpsib-')
    ? { smtpKey: key }
    : { apiKey: key };

  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    result.textContent = d.ok ? '✓ ' + d.message : '✗ ' + (d.error || JSON.stringify(d));
    result.className = 'result ' + (d.ok ? 'ok' : 'err');
    result.style.display = 'block';
    if (d.ok) {
      sessionStorage.removeItem('brevoKey');
      setTimeout(() => { location.hash = ''; }, 2000);
    }
  } catch (err) {
    result.textContent = '✗ ' + err.message;
    result.className = 'result err';
    result.style.display = 'block';
  }
  btn.disabled = false;
});
