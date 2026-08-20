// Uit home.html gelicht: inline <script> mag niet meer onder de CSP
// (script-src zonder 'unsafe-inline').
(function(){
  // Live testimonials loader — vervangt seed-testimonials zodra er ≥3
  // goedgekeurde reviews zijn. Onder de drempel blijft de seed staan
  // zodat nieuwe bezoekers altijd social proof zien.
  function escapeHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '🙂';
    return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
  }
  fetch('/api/testimonials/public')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      const list = data?.testimonials || [];
      if (list.length < 3) return; // behoud seed
      const grid = document.getElementById('testimonials-grid');
      if (!grid) return;
      grid.innerHTML = list.slice(0, 6).map(t => {
        const stars = '★'.repeat(t.score) + '☆'.repeat(5 - t.score);
        const name = escapeHtml(t.display_name || 'Organisator');
        const loc  = t.country ? ' · ' + escapeHtml(t.country) : '';
        return `
          <div class="testimonial">
            <div class="testimonial-stars">${stars}</div>
            <p>"${escapeHtml(t.comment)}"</p>
            <div class="testimonial-author">
              <div class="testimonial-avatar">${escapeHtml(initials(t.display_name))}</div>
              <div>
                <strong>${name}</strong>
                <span>${loc}</span>
              </div>
            </div>
          </div>`;
      }).join('');
    })
    .catch(() => { /* seed blijft staan bij fout */ });
})();

  // ── Screenshot carousel
  (function() {
    const slides = document.querySelectorAll('.screenshot-slide');
    const dots = document.querySelectorAll('.screenshot-dot');
    let current = 0;
    let timer;

    function goTo(i) {
      slides[current].classList.remove('active');
      dots[current].classList.remove('active');
      current = i;
      slides[current].classList.add('active');
      dots[current].classList.add('active');
    }

    function next() { goTo((current + 1) % slides.length); }

    function startAuto() { timer = setInterval(next, 4000); }
    function stopAuto() { clearInterval(timer); }

    dots.forEach(d => d.addEventListener('click', () => {
      stopAuto();
      goTo(+d.dataset.slide);
      startAuto();
    }));

    startAuto();
  })();

  // ── Nav scroll effect
  const nav = document.getElementById('nav');
  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 20);
  });

  // ── Mobile menu
  document.getElementById('hamburger').addEventListener('click', () => {
    document.getElementById('nav-mobile').classList.toggle('open');
  });

  // ── Close mobile menu on link click
  document.querySelectorAll('#nav-mobile a').forEach(a => {
    a.addEventListener('click', () => document.getElementById('nav-mobile').classList.remove('open'));
  });

  // ── Load real stats for social proof bar
  // Wait for I18n to be ready so fallback text is translated correctly
  I18n.onReady(() => {
    fetch('/api/public/stats')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        const fmt = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', '.') + 'k' : String(n);
        const dinEl = document.getElementById('sp-dinners');
        const partEl = document.getElementById('sp-participants');
        const ratEl = document.getElementById('sp-rating');
        if (dinEl)  dinEl.textContent  = data.dinners > 0 ? fmt(data.dinners) + '+' : '0';
        if (partEl) partEl.textContent = data.participants > 0 ? fmt(data.participants) + '+' : '0';
        if (ratEl)  ratEl.textContent  = data.ratingCount > 0 ? data.avgRating.toFixed(1) + ' \u2605' : I18n.t('social_proof.new', 'Nieuw');
      })
      .catch(() => {});
  });

  // ── Load CMS content + price
  fetch('/api/cms')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data?.cms) return;
      const c = data.cms;
      const set = (id, val) => { const el = document.getElementById(id); if (el && val) el.textContent = val; };
      set('cms-hero-title', c.hero_title);
      set('cms-hero-subtitle', c.hero_subtitle);
      set('cms-features-intro', c.features_intro);
      set('cms-footer-text', c.footer_text);
      set('cms-footer-copyright', c.footer_text);
      if (c.hero_cta) {
        const btn = document.getElementById('cms-hero-cta');
        if (btn) btn.textContent = c.hero_cta;
      }
    })
    .catch(() => {});

  // ── Multi-currency pricing: detect bezoeker-land via Cloudflare,
  //    update alle prijs-elementen met lokale valuta
  function updatePriceElements(price) {
    if (!price) return;
    ['price-display', 'price-display2'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = price.displayPrice;
    });
    // Update CTA-button prijslabel als de basis-tekst Nederlands is
    const cmsPriceLabel = document.getElementById('cms-price-label');
    if (cmsPriceLabel) cmsPriceLabel.textContent = price.displayPrice;
    // Update alle CTA-buttons met prijs in de tekst
    document.querySelectorAll('[data-i18n="nav.cta"], [data-i18n="cta.button"]').forEach(el => {
      // Alleen bijwerken als er al een prijs in staat (€ of £ etc.)
      if (/[€£$]\d/.test(el.textContent)) {
        el.textContent = el.textContent.replace(/[€£$][A-Z]{0,2}\d+[.,]?\d*/, price.displayPrice);
      }
    });
    window._currentPrice = price;
  }

  fetch('/api/pricing')
    .then(r => r.ok ? r.json() : null)
    .then(updatePriceElements)
    .catch(() => {});

  // Expose manual override for the currency switcher (niet-modaal)
  window.setCurrency = async (currency) => {
    const r = await fetch('/api/pricing/preference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currency }),
    });
    const data = await r.json();
    if (data.ok) updatePriceElements(data);
  };

  // ── Contact form
  document.getElementById('contact-form').addEventListener('submit', async e => {
    e.preventDefault();
    const status = document.getElementById('contact-status');
    const btn    = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = I18n.t('contact.sending', 'Versturen...');
    status.textContent = '';
    status.className = 'form-status';

    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:    document.getElementById('cf-name').value,
          email:   document.getElementById('cf-email').value,
          message: document.getElementById('cf-message').value,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        status.textContent = data.message || I18n.t('contact.success', 'Bericht verzonden!');
        status.classList.add('ok');
        e.target.reset();
      } else {
        status.textContent = data.error || I18n.t('contact.error', 'Er ging iets mis.');
        status.classList.add('err');
      }
    } catch {
      status.textContent = I18n.t('contact.network_error', 'Netwerkfout. Probeer het later opnieuw.');
      status.classList.add('err');
    }

    btn.disabled = false;
    btn.textContent = I18n.t('contact.submit', 'Verstuur bericht');
  });

  // ── Newsletter signup
  const nlForm = document.getElementById('newsletter-form');
  if (nlForm) {
    nlForm.addEventListener('submit', async e => {
      e.preventDefault();
      const msg = document.getElementById('newsletter-msg');
      const btn = nlForm.querySelector('button[type=submit]');
      const email = document.getElementById('newsletter-email').value;
      btn.disabled = true;
      msg.textContent = '';
      msg.className = 'newsletter-msg';
      try {
        const res = await fetch('/api/newsletter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        if (res.ok) {
          msg.textContent = I18n.t('newsletter.success', 'Bedankt! Je staat op de lijst.');
          msg.classList.add('ok');
          nlForm.reset();
          if (window.plausible) plausible('Newsletter-Signup');
        } else {
          msg.textContent = I18n.t('newsletter.error', 'Er ging iets mis. Controleer je e-mailadres.');
          msg.classList.add('err');
        }
      } catch {
        msg.textContent = I18n.t('newsletter.network_error', 'Netwerkfout. Probeer het later opnieuw.');
        msg.classList.add('err');
      }
      btn.disabled = false;
    });
  }

  // ── Smooth scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const target = document.querySelector(a.getAttribute('href'));
      if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
  });

  // Initialize language toggle in nav
  I18n.onReady(() => {
    const desktop = document.getElementById('lang-toggle-desktop');
    const mobile = document.getElementById('lang-toggle-mobile');
    if (desktop) desktop.appendChild(I18n.createToggle());
    if (mobile) mobile.appendChild(I18n.createToggle());
  });

  // ── Homepage WhatsApp/email share (no login needed, generic) ─────────────
  (function() {
    const shareText = () => I18n.t(
      'cta.share_text',
      'Gezien? Een tool die running dinners voor je plant. €5 per jaar, super handig:'
    ) + ' https://runningdinner.app/';
    const waBtn = document.getElementById('homepage-share-whatsapp');
    const mailBtn = document.getElementById('homepage-share-email');
    const natBtn = document.getElementById('homepage-share-native');
    if (waBtn) waBtn.addEventListener('click', () => {
      const text = shareText() + '?utm_source=whatsapp&utm_medium=organic_share&utm_campaign=homepage_share';
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
      if (window.plausible) plausible('Homepage-Share', { props: { channel: 'whatsapp' } });
    });
    if (mailBtn) mailBtn.addEventListener('click', () => {
      const text = shareText() + '?utm_source=email&utm_medium=organic_share&utm_campaign=homepage_share';
      window.open(`mailto:?subject=${encodeURIComponent('Running Dinner Planner')}&body=${encodeURIComponent(text)}`, '_blank');
      if (window.plausible) plausible('Homepage-Share', { props: { channel: 'email' } });
    });
    if (natBtn && navigator.share) {
      natBtn.style.display = 'inline-flex';
      natBtn.addEventListener('click', () => {
        navigator.share({
          title: 'Running Dinner Planner',
          text: shareText(),
          url: 'https://runningdinner.app/?utm_source=native_share&utm_medium=organic_share&utm_campaign=homepage_share',
        }).catch(() => {});
        if (window.plausible) plausible('Homepage-Share', { props: { channel: 'native' } });
      });
    }
  })();

  // ── Currency switcher (mini-dropdown, zichtbaar na eerste prijs-fetch) ──
  function buildCurrencySwitcher(currencies, current) {
    const sel = document.createElement('select');
    sel.className = 'currency-switcher';
    sel.style.cssText = 'margin-left:8px;border:1px solid #e2e8f0;border-radius:6px;padding:2px 6px;font-size:.78rem;background:#fff;color:#475569;cursor:pointer';
    sel.innerHTML = currencies.map(c =>
      `<option value="${c.code}"${c.code === current ? ' selected' : ''}>${c.symbol} ${c.code}</option>`
    ).join('');
    sel.addEventListener('change', () => window.setCurrency(sel.value));
    return sel;
  }
  fetch('/api/pricing')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data?.availableCurrencies) return;
      ['lang-toggle-desktop', 'lang-toggle-mobile'].forEach(id => {
        const container = document.getElementById(id);
        if (container) container.appendChild(buildCurrencySwitcher(data.availableCurrencies, data.currency));
      });
    })
    .catch(() => {});
