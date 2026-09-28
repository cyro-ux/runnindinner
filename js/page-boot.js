// Uit index.html gelicht: inline <script> mag niet meer onder de CSP
// (script-src zonder 'unsafe-inline').
  // Auth check – only runs when accessed via the Node.js server (not file://)
  // In demo-mode wordt de auth-check overgeslagen: demo is publiek toegankelijk.
  (async function initAuthBar() {
    if (location.protocol === 'file:') return; // Direct file open – skip auth
    if (window.RDA_DEMO?.isActive?.()) return;  // Demo-modus – geen auth
    try {
      const res  = await fetch('/api/app/access');
      if (!res.ok) {
        if (res.status === 401) {
          // Not logged in → redirect to login
          window.location.href = '/login.html?next=/app';
        }
        // 404 or other = no Node.js backend (static server) → allow use
        return;
      }
      const data = await res.json();

      // Show auth bar
      const bar = document.getElementById('auth-bar');
      bar.style.display  = 'flex';

      if (!data.access) {
        // Logged in but no active license → show gate
        document.getElementById('app').style.display      = 'none';
        document.getElementById('auth-gate').style.display = 'flex';
        return;
      }

      // Has access – show license info
      if (data.license_until) {
        const until = new Date(data.license_until).toLocaleDateString(I18n.getLang() === 'en' ? 'en-GB' : 'nl-NL');
        document.getElementById('auth-license-info').textContent = I18n.t('app.auth.subscription_valid', 'Abonnement geldig t/m') + ` ${until}`;
      }

      // Show user email
      const meRes  = await fetch('/api/auth/me');
      const meData = await meRes.json();
      if (meData?.user?.email) {
        document.getElementById('auth-user-email').textContent = meData.user.email;
      }
    } catch {
      // Server not reachable – allow offline/direct use
    }

    // Logout
    document.getElementById('auth-logout-btn').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login.html';
    });
  })();

    // Language toggle in auth bar
    I18n.onReady(() => {
      const container = document.getElementById('app-lang-toggle');
      if (container) {
        const toggle = I18n.createToggle();
        // Donkere balk: inactieve talen als leesbare witte tekst met subtiele
        // rand, de actieve als witte pil. cssText overschrijft de standaard
        // (lichtgrijze) button-achtergrond die de tekst onleesbaar maakte.
        toggle.querySelectorAll('.lang-btn').forEach(btn => {
          btn.style.cssText = 'background:transparent;border:1px solid rgba(255,255,255,.4);color:#fff;font-size:.78rem;font-weight:600;padding:3px 8px;border-radius:6px;cursor:pointer';
        });
        toggle.querySelectorAll('.lang-btn.active').forEach(btn => {
          btn.style.cssText = 'background:#fff;border:1px solid #fff;color:#1E293B;font-size:.78rem;font-weight:700;padding:3px 8px;border-radius:6px;cursor:default';
        });
        toggle.querySelectorAll('.lang-sep').forEach(sep => { sep.style.color = 'rgba(255,255,255,.35)'; });
        container.appendChild(toggle);
      }
    });
