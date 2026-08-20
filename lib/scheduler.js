/**
 * Achtergrond-scheduler: automatische verlengingen (Mollie recurring),
 * verloopherinneringen, opschonen van verlopen gedeelde planningen en
 * achtergebleven smoke-accounts, en de dagelijkse Zoho-reconciliatie.
 * Draait alleen in productie (ENV-check), elk uur + eenmalig 30s na boot.
 * Uit server.js gelicht als tranche 11; factory met dependency-injection.
 */
'use strict';

module.exports = function startScheduler(deps) {
  const { db, mollie, sendMail, wrapHtml, formatEur, getSetting, BASE_URL, ENV, zohoSync } = deps;

async function processAutoRenewals() {
  const now  = Date.now();
  const soon = now + 1 * 86400000; // license expires within 1 day
  const grace = now - 7 * 86400000; // or expired up to 7 days ago

  const users = db.prepare(`
    SELECT id, email, mollie_customer_id, mollie_mandate_id, license_until
    FROM users
    WHERE auto_renew = 1
      AND mollie_mandate_id IS NOT NULL
      AND mollie_customer_id IS NOT NULL
      AND license_until BETWEEN ? AND ?
  `).all(grace, soon);

  for (const user of users) {
    // Idempotency: skip if we already created a payment in the last 14 days for this user
    const recent = db.prepare(
      "SELECT id FROM payments WHERE user_id = ? AND payment_type = 'recurring' AND created_at > ?"
    ).get(user.id, now - 14 * 86400000);
    if (recent) continue;

    const priceCents  = parseInt(getSetting('subscription_price_cents') || '500', 10);
    const amountValue = (priceCents / 100).toFixed(2);

    try {
      await mollie.payments.create({
        amount:       { currency: 'EUR', value: amountValue },
        description:  'Running Dinner Planner - automatische verlenging',
        sequenceType: 'recurring',
        customerId:   user.mollie_customer_id,
        mandateId:    user.mollie_mandate_id,
        webhookUrl:   `${BASE_URL}/api/mollie/webhook`,
        metadata:     { user_id: user.id, autoRenew: true },
      });
      console.log(`[scheduler] recurring payment created for ${user.email}`);
    } catch (err) {
      console.error(`[scheduler] recurring payment failed for ${user.email}:`, err.message);
    }
  }
}

async function checkRenewalReminders() {
  const now = Date.now();
  const reminderWindow = now + 14 * 86400000; // 14 days from now
  const reminderCooldown = now - 13 * 86400000;

  const users = db.prepare(`
    SELECT id, email, license_until, language
    FROM users
    WHERE auto_renew = 1
      AND license_until BETWEEN ? AND ?
      AND (renewal_reminder_sent IS NULL OR renewal_reminder_sent < ?)
  `).all(now, reminderWindow, reminderCooldown);

  const priceCents = parseInt(getSetting('subscription_price_cents') || '500', 10);

  // Multi-language reminder labels. Uitgebreidere talen (es/de) erbij om
  // consistent te blijven met de invoice-mail en CMS-content.
  const REMINDER_L = {
    nl: { hi: 'Hallo,', subject: (n) => `${n} - Running Dinner Planner`, subj: 'Je abonnement wordt binnenkort verlengd',
          body: (d, p) => `Je abonnement wordt automatisch verlengd op <strong>${d}</strong> voor <strong>${p}</strong>.`,
          opt:  'Je hoeft niets te doen. Wil je de automatische verlenging uitschakelen? Dat kan in je profiel.',
          cta:  'Naar mijn profiel',
          note: 'Je ontvangt na verlenging automatisch een factuur per e-mail.' },
    en: { hi: 'Hi,', subj: 'Your subscription will be renewed soon',
          body: (d, p) => `Your subscription will be automatically renewed on <strong>${d}</strong> for <strong>${p}</strong>.`,
          opt:  'No action needed. Want to disable auto-renewal? You can do so in your profile.',
          cta:  'Go to my profile',
          note: 'You will automatically receive an invoice by email after renewal.' },
    es: { hi: 'Hola,', subj: 'Tu suscripción se renovará pronto',
          body: (d, p) => `Tu suscripción se renovará automáticamente el <strong>${d}</strong> por <strong>${p}</strong>.`,
          opt:  'No es necesario hacer nada. ¿Quieres desactivar la renovación automática? Puedes hacerlo en tu perfil.',
          cta:  'Ir a mi perfil',
          note: 'Recibirás automáticamente una factura por correo electrónico tras la renovación.' },
    de: { hi: 'Hallo,', subj: 'Ihr Abonnement wird bald verlängert',
          body: (d, p) => `Ihr Abonnement wird automatisch am <strong>${d}</strong> für <strong>${p}</strong> verlängert.`,
          opt:  'Keine Aktion erforderlich. Möchten Sie die automatische Verlängerung deaktivieren? Das geht in Ihrem Profil.',
          cta:  'Zu meinem Profil',
          note: 'Sie erhalten nach der Verlängerung automatisch eine Rechnung per E-Mail.' },
  };
  const LOCALE_MAP = { nl: 'nl-NL', en: 'en-GB', es: 'es-ES', de: 'de-DE' };

  for (const user of users) {
    const uLang  = user.language || 'nl';
    const L      = REMINDER_L[uLang] || REMINDER_L.nl;
    const locale = LOCALE_MAP[uLang] || LOCALE_MAP.nl;
    const renewDate = new Date(user.license_until).toLocaleDateString(locale, {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    try {
      await sendMail(user.email,
        `${L.subj} - Running Dinner Planner`,
        wrapHtml(`
        <h2 style="color:#1a56db;margin:0 0 16px">Running Dinner Planner</h2>
        <p style="color:#374151;line-height:1.6">${L.hi}</p>
        <p style="color:#374151;line-height:1.6">${L.body(renewDate, formatEur(priceCents))}</p>
        <p style="color:#374151;line-height:1.6">${L.opt}</p>
        <p style="margin:24px 0;text-align:center">
          <a href="${BASE_URL}/profile.html" style="background:#1a56db;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">${L.cta}</a>
        </p>
        <p style="color:#6b7280;font-size:13px;line-height:1.5">${L.note}</p>
      `, uLang));
      db.prepare('UPDATE users SET renewal_reminder_sent = ? WHERE id = ?').run(now, user.id);
      console.log(`[scheduler] renewal reminder sent to ${user.email}`);
    } catch (err) {
      console.error(`[scheduler] reminder mail failed for ${user.email}:`, err.message);
    }
  }
}

// Daily Zoho reconciliation: retry failed/missing syncs from the last 7 days
async function reconcileZoho() {
  if (!zohoClient.isConfigured()) return;
  const failed = zohoSync.listDiscrepancies(db, 7);
  if (!failed.length) return;
  console.log(`[zoho] reconciliation: retrying ${failed.length} failed syncs`);
  for (const p of failed) {
    try {
      const r = await zohoSync.syncPayment(db, p.id);
      if (r.synced) console.log(`[zoho] reconciled ${p.id} → ${r.zoho_invoice_id}`);
      // small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`[zoho] reconciliation failed for ${p.id}:`, err.message);
    }
  }
}

// Run scheduler every hour (only in production to avoid double runs during dev)
if (ENV === 'production') {
  const SCHEDULER_INTERVAL = 60 * 60 * 1000; // 1 hour
  let zohoTicker = 0;
  setInterval(async () => {
    try { await checkRenewalReminders(); } catch (e) { console.error('[scheduler] reminder error:', e.message); }
    try { await processAutoRenewals(); } catch (e) { console.error('[scheduler] renewal error:', e.message); }
    // Verlopen gedeelde planningen opruimen (AVG: adressen van derden
    // horen niet langer dan event + 30 dagen op de server te staan).
    try {
      const expired = db.prepare('SELECT id FROM shared_plannings WHERE expires_at < ?').all(Date.now());
      for (const e of expired) {
        db.prepare('DELETE FROM shared_planning_participants WHERE planning_id = ?').run(e.id);
        db.prepare('DELETE FROM shared_plannings WHERE id = ?').run(e.id);
      }
      if (expired.length) console.log(`[scheduler] ${expired.length} verlopen gedeelde planning(en) opgeruimd`);
    } catch (e) { console.error('[scheduler] shared-planning cleanup error:', e.message); }
    // Achtergebleven smoke-testaccounts opruimen (de smoke-test ruimt zichzelf
    // op via het GDPR-endpoint, maar een afgebroken run kan er een achterlaten).
    try {
      const stale = db.prepare(
        "SELECT id FROM users WHERE email LIKE 'smoke-%@example.test' AND created_at < ?"
      ).all(Date.now() - 24 * 3600 * 1000);
      for (const u of stale) {
        db.prepare('DELETE FROM ratings WHERE user_id = ?').run(u.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      }
      if (stale.length) console.log(`[scheduler] ${stale.length} achtergebleven smoke-account(s) opgeruimd`);
    } catch (e) { console.error('[scheduler] smoke cleanup error:', e.message); }
    // Zoho reconciliation once per 24h (every 24 ticks)
    zohoTicker++;
    if (zohoTicker % 24 === 0) {
      try { await reconcileZoho(); } catch (e) { console.error('[scheduler] zoho reconcile error:', e.message); }
    }
  }, SCHEDULER_INTERVAL);
  // Also run once 30 seconds after startup
  setTimeout(async () => {
    try { await checkRenewalReminders(); } catch (e) { console.error('[scheduler] reminder error:', e.message); }
    try { await processAutoRenewals(); } catch (e) { console.error('[scheduler] renewal error:', e.message); }
    try { await reconcileZoho(); } catch (e) { console.error('[scheduler] zoho reconcile error:', e.message); }
  }, 30000);
}
};
