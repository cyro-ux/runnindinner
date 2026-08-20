// Uit payment-success.html gelicht: inline <script> mag niet meer onder de CSP
// (script-src zonder 'unsafe-inline').
  I18n.onReady(() => {
    const c = document.getElementById('auth-lang-toggle');
    if (c) c.appendChild(I18n.createToggle());
  });
  if (window.plausible) plausible('Payment-Complete');

  // Fetch updated user info to display license date + auto-renew status
  fetch('/api/app/access')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      const info = document.getElementById('info-block');
      if (data?.license_until) {
        const until = new Date(data.license_until).toLocaleDateString('nl-NL');
        let html = '<p>&#10003; <strong>' + I18n.t('auth.payment_success.subscription_active', 'Abonnement actief') + '</strong></p>';
        html += '<p>' + I18n.t('auth.payment_success.valid_until', 'Geldig tot') + ': <strong>' + until + '</strong></p>';
        if (data.auto_renew) {
          html += '<p>&#10003; <strong>' + I18n.t('auth.payment_success.auto_renew_on', 'Automatische verlenging ingeschakeld') + '</strong></p>';
        }
        info.innerHTML = html;
      } else {
        info.innerHTML = '<p>' + I18n.t('auth.payment_success.processing', 'Abonnement wordt verwerkt. Dit kan een moment duren.') + '</p>';
      }
    })
    .catch(() => {
      document.getElementById('info-block').innerHTML = '<p>' + I18n.t('auth.payment_success.processing_email', 'Abonnement wordt verwerkt. Controleer je e-mail voor de factuur.') + '</p>';
    });
