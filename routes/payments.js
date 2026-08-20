/**
 * Mollie-/betaalroutes: checkout starten, publieke prijs, webhook
 * (paid / failed-recurring / refund-chargeback, allemaal idempotent).
 *
 * Factory met dependency-injection zodat de webhook zonder echte Mollie,
 * mailserver of Zoho te testen is (zie lib/payments-routes.test.js).
 */
'use strict';

const express = require('express');
const { asyncHandler } = require('../lib/async-handler');

module.exports = function paymentsRoutes(deps) {
  const {
    db, mollie, t, requireAuth, priceResolver, BASE_URL, getSetting, formatEur,
    sendMail, wrapHtml, uuidv4, invoiceNumber, sendInvoiceMail,
    checkReferralReward, zohoSync,
  } = deps;
  const router = express.Router();

// POST /api/mollie/create-payment
router.post('/api/mollie/create-payment', requireAuth, asyncHandler(async (req, res) => {
  const user       = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const autoRenew  = req.body?.autoRenew === true;
  const waiverAccepted = req.body?.waiverAccepted === true;

  // Waiver is alleen verplicht voor consumenten (B2C). Zakelijke klanten
  // (B2B) kunnen sowieso geen beroep doen op het herroepingsrecht — BW
  // 6:230p regelt consumentenrechten, ondernemers vallen daar niet onder.
  if (!user.is_business && !waiverAccepted) {
    return res.status(400).json({ error: t(req, 'waiver_required') });
  }

  // Log de waiver-acceptatie (met timestamp) voor bewijsvoering bij een
  // eventueel herroepingsrecht-geschil. Alleen zetten als klant consument is
  // én nog niet eerder geaccepteerd.
  if (!user.is_business && waiverAccepted && !user.waiver_accepted_at) {
    db.prepare('UPDATE users SET waiver_accepted_at = ? WHERE id = ?').run(Date.now(), user.id);
  }

  // Determine price + currency based on user's detected/chosen country
  // Priority: user profile country > request country > default NL
  const userCountry = user.country || req.country || 'NL';
  const preferredCurrency = req.cookies?.currency || null;
  const price = priceResolver.resolve({ country: userCountry, currency: preferredCurrency });

  // Store country on the user if not yet set (for invoices + Zoho)
  if (!user.country) {
    db.prepare('UPDATE users SET country = ? WHERE id = ?').run(userCountry, user.id);
  }

  const amountValue = (price.cents / 100).toFixed(2); // Mollie expects "5.00"

  try {
    const paymentOpts = {
      amount:      { currency: price.currency, value: amountValue },
      description: 'Running Dinner Planner - 1 year subscription',
      redirectUrl: `${BASE_URL}/payment-success.html`,
      webhookUrl:  `${BASE_URL}/api/mollie/webhook`,
      metadata:    { user_id: user.id, autoRenew, country: userCountry },
      // Restrict to locale-appropriate methods (order = preference)
      method:      price.mollieMethods,
      locale:      { NL: 'nl_NL', BE: 'nl_BE', DE: 'de_DE', FR: 'fr_FR',
                     ES: 'es_ES', GB: 'en_GB', US: 'en_US', CA: 'en_CA',
                     AU: 'en_GB', NZ: 'en_GB', IE: 'en_GB' }[userCountry] || 'en_GB',
    };

    // If auto-renew requested: create/reuse Mollie Customer and use sequenceType 'first'
    if (autoRenew) {
      let customerId = user.mollie_customer_id;
      if (!customerId) {
        const customer = await mollie.customers.create({ name: user.email, email: user.email });
        customerId = customer.id;
        db.prepare('UPDATE users SET mollie_customer_id = ? WHERE id = ?').run(customerId, user.id);
      }
      paymentOpts.customerId = customerId;
      paymentOpts.sequenceType = 'first';
    }

    const payment = await mollie.payments.create(paymentOpts);

    res.json({ ok: true, url: payment.getCheckoutUrl() });
  } catch (err) {
    console.error('[mollie] create-payment error:', err.message);
    res.status(500).json({ error: t(req, 'payment_failed') });
  }
}));

// GET /api/mollie/price  (public)
router.get('/api/mollie/price', (req, res) => {
  const cents = parseInt(getSetting('subscription_price_cents') || '500', 10);
  res.json({ cents, formatted: formatEur(cents) });
});

// POST /api/mollie/webhook  (called by Mollie, urlencoded body: id=tr_xxxxx)
router.post('/api/mollie/webhook', asyncHandler(async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).send('Missing id');

  try {
    const payment = await mollie.payments.get(id);
    const userId  = payment.metadata?.user_id;
    if (!userId) return res.send('ok');

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.send('ok');

    // ── Refund / chargeback handling (idempotent via stored flag in DB) ────
    const refundedCents = payment.amountRefunded ? Math.round(parseFloat(payment.amountRefunded.value) * 100) : 0;
    const chargebackCents = payment.amountChargedBack ? Math.round(parseFloat(payment.amountChargedBack.value) * 100) : 0;

    if (refundedCents > 0 || chargebackCents > 0) {
      const localPayment = db.prepare('SELECT * FROM payments WHERE mollie_payment_id = ?').get(payment.id);
      // Idempotency via dedicated refunded_at column (was vroeger gebaseerd op
      // zoho_sync_error string — fragiel). Skippen als al verwerkt.
      if (localPayment && !localPayment.refunded_at) {
        const reason = chargebackCents > 0 ? 'Chargeback' : 'Refund';
        console.log(`[mollie] ${reason} detected for payment ${payment.id}: ${refundedCents || chargebackCents} cents`);

        // Create credit note in Zoho (idempotency: check if already done via sync_status)
        zohoSync.syncRefund(db, localPayment.id, reason).then((r) => {
          if (r.synced) {
            db.prepare(`
              UPDATE payments
              SET status = ?, refunded_at = ?, credit_note_id = ?
              WHERE id = ?
            `).run(
              chargebackCents > 0 ? 'chargeback' : 'refunded',
              Date.now(),
              r.creditnote_id || null,
              localPayment.id
            );
          }
        }).catch((err) => console.error('[zoho] refund sync error:', err.message));

        // If refund/chargeback voids the entire payment, also revoke license
        const paidCents = Math.round(parseFloat(payment.amount.value) * 100);
        if ((refundedCents + chargebackCents) >= paidCents) {
          db.prepare('UPDATE users SET auto_renew = 0 WHERE id = ?').run(userId);
        }

        // Notify customer (in their language)
        const lang = user.language || 'nl';
        const subjectMap = {
          nl: `${reason === 'Chargeback' ? 'Chargeback' : 'Terugbetaling'} verwerkt - Running Dinner Planner`,
          en: `${reason} processed - Running Dinner Planner`,
          es: `${reason === 'Chargeback' ? 'Contracargo' : 'Reembolso'} procesado - Running Dinner Planner`,
          de: `${reason === 'Chargeback' ? 'Rückbuchung' : 'Rückerstattung'} verarbeitet - Running Dinner Planner`,
        };
        const bodyMap = {
          nl: `<p>Hallo,</p><p>We hebben een ${reason === 'Chargeback' ? 'chargeback' : 'terugbetaling'} verwerkt voor je betaling. De creditnota is in je boekhouding opgenomen.</p>`,
          en: `<p>Hi,</p><p>We've processed a ${reason.toLowerCase()} for your payment. A credit note has been registered.</p>`,
          es: `<p>Hola,</p><p>Hemos procesado un ${reason === 'Chargeback' ? 'contracargo' : 'reembolso'} de tu pago. Se ha registrado una nota de crédito.</p>`,
          de: `<p>Hallo,</p><p>Wir haben eine ${reason === 'Chargeback' ? 'Rückbuchung' : 'Rückerstattung'} für Ihre Zahlung verarbeitet. Eine Gutschrift wurde in Ihrer Buchhaltung erfasst.</p>`,
        };
        sendMail(user.email, subjectMap[lang] || subjectMap.nl, wrapHtml(bodyMap[lang] || bodyMap.nl, lang)).catch(console.error);
      }
      return res.send('ok');
    }

    // Handle failed recurring payments
    if (payment.status === 'failed' && payment.sequenceType === 'recurring') {
      // Idempotency: Mollie herhaalt webhook-calls. Zonder deze check zou een
      // dubbele levering van dezelfde mislukte incasso (a) een tweede
      // 'failed'-rij inserten, (b) failCount kunstmatig opdrijven richting de
      // uitschakel-drempel en (c) de klant dubbele mails sturen.
      const alreadyRecorded = db.prepare('SELECT id FROM payments WHERE mollie_payment_id = ?').get(payment.id);
      if (alreadyRecorded) return res.send('ok');

      console.log(`[mollie] recurring payment failed for user ${userId}`);
      const failCount = db.prepare(
        "SELECT COUNT(*) as c FROM payments WHERE user_id = ? AND status = 'failed' AND payment_type = 'recurring' AND created_at > ?"
      ).get(userId, Date.now() - 30 * 86400000).c;

      if (failCount >= 2) {
        // 3rd failure (including this one) → disable auto-renewal
        db.prepare('UPDATE users SET auto_renew = 0 WHERE id = ?').run(userId);
        const uLang = user.language || 'nl';
        const FAIL_L = {
          nl: { hi: 'Hallo,', subj: 'Automatische verlenging uitgeschakeld',
                line1: 'Je automatische verlenging is uitgeschakeld omdat de betaling meerdere keren niet gelukt is.',
                line2: 'Je kunt je abonnement handmatig verlengen via onderstaande knop.',
                cta:   'Abonnement verlengen' },
          en: { hi: 'Hi,', subj: 'Auto-renewal disabled',
                line1: 'Your auto-renewal has been disabled because the payment failed multiple times.',
                line2: 'You can renew your subscription manually using the button below.',
                cta:   'Renew subscription' },
          es: { hi: 'Hola,', subj: 'Renovación automática desactivada',
                line1: 'Hemos desactivado tu renovación automática porque el pago falló varias veces.',
                line2: 'Puedes renovar tu suscripción manualmente con el botón de abajo.',
                cta:   'Renovar suscripción' },
          de: { hi: 'Hallo,', subj: 'Automatische Verlängerung deaktiviert',
                line1: 'Ihre automatische Verlängerung wurde deaktiviert, weil die Zahlung mehrfach fehlgeschlagen ist.',
                line2: 'Sie können Ihr Abonnement manuell über die Schaltfläche unten verlängern.',
                cta:   'Abonnement verlängern' },
        };
        const F = FAIL_L[uLang] || FAIL_L.nl;
        sendMail(user.email,
          `${F.subj} - Running Dinner Planner`,
          wrapHtml(`
          <h2 style="color:#1a56db;margin:0 0 16px">Running Dinner Planner</h2>
          <p style="color:#374151;line-height:1.6">${F.hi}</p>
          <p style="color:#374151;line-height:1.6">${F.line1}</p>
          <p style="color:#374151;line-height:1.6">${F.line2}</p>
          <p style="margin:24px 0;text-align:center">
            <a href="${BASE_URL}/subscribe.html" style="background:#1a56db;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">${F.cta}</a>
          </p>
        `, uLang)).catch(console.error);
      } else {
        const uLang2 = user.language || 'nl';
        const RETRY_L = {
          nl: { hi: 'Hallo,', subj: 'Automatische verlenging mislukt',
                line1: 'De automatische verlenging van je abonnement is niet gelukt. We proberen het binnenkort opnieuw.',
                line2: 'Wil je het zelf regelen? Verleng dan handmatig:',
                cta:   'Handmatig verlengen' },
          en: { hi: 'Hi,', subj: 'Auto-renewal failed',
                line1: 'The automatic renewal of your subscription has failed. We will try again soon.',
                line2: 'Would you rather handle it yourself? Renew manually:',
                cta:   'Renew manually' },
          es: { hi: 'Hola,', subj: 'La renovación automática ha fallado',
                line1: 'La renovación automática de tu suscripción no se pudo completar. Lo intentaremos de nuevo pronto.',
                line2: '¿Prefieres hacerlo tú? Renueva manualmente:',
                cta:   'Renovar manualmente' },
          de: { hi: 'Hallo,', subj: 'Automatische Verlängerung fehlgeschlagen',
                line1: 'Die automatische Verlängerung Ihres Abonnements ist nicht gelungen. Wir versuchen es bald erneut.',
                line2: 'Möchten Sie es selbst erledigen? Verlängern Sie manuell:',
                cta:   'Manuell verlängern' },
        };
        const R = RETRY_L[uLang2] || RETRY_L.nl;
        sendMail(user.email,
          `${R.subj} - Running Dinner Planner`,
          wrapHtml(`
          <h2 style="color:#1a56db;margin:0 0 16px">Running Dinner Planner</h2>
          <p style="color:#374151;line-height:1.6">${R.hi}</p>
          <p style="color:#374151;line-height:1.6">${R.line1}</p>
          <p style="color:#374151;line-height:1.6">${R.line2}</p>
          <p style="margin:24px 0;text-align:center">
            <a href="${BASE_URL}/subscribe.html" style="background:#1a56db;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">${R.cta}</a>
          </p>
        `, uLang2)).catch(console.error);
      }

      // Record failed payment
      db.prepare(`
        INSERT INTO payments (id, user_id, mollie_payment_id, amount_cents, currency, status, payment_type, created_at)
        VALUES (?, ?, ?, ?, ?, 'failed', 'recurring', ?)
      `).run(uuidv4(), userId, payment.id, Math.round(parseFloat(payment.amount.value) * 100),
        payment.amount.currency.toLowerCase(), Date.now());

      return res.send('ok');
    }

    if (payment.status !== 'paid') return res.send('ok');

    // Idempotency: skip if already recorded
    const existing = db.prepare('SELECT id FROM payments WHERE mollie_payment_id = ?').get(payment.id);
    if (existing) return res.send('ok');

    // Determine payment type
    const seqType    = payment.sequenceType || 'oneoff';
    const payType    = seqType === 'first' ? 'first' : seqType === 'recurring' ? 'recurring' : 'one-time';
    const autoRenew  = payment.metadata?.autoRenew === true || payment.metadata?.autoRenew === 'true';

    const days         = parseInt(getSetting('subscription_duration_days') || '365', 10);
    const now          = Date.now();
    const licenseUntil = (user.license_until && user.license_until > now)
      ? user.license_until + days * 86400000
      : now + days * 86400000;

    db.prepare('UPDATE users SET license_until = ? WHERE id = ?').run(licenseUntil, userId);

    // After first payment: retrieve and store mandate for future recurring payments
    if (seqType === 'first' && user.mollie_customer_id) {
      try {
        const mandates = await mollie.customerMandates.list({ customerId: user.mollie_customer_id });
        const validMandate = mandates.find(m => m.status === 'valid' || m.status === 'pending');
        if (validMandate) {
          db.prepare('UPDATE users SET mollie_mandate_id = ?, auto_renew = ? WHERE id = ?')
            .run(validMandate.id, autoRenew ? 1 : 0, userId);
        }
      } catch (mandateErr) {
        console.error('[mollie] mandate fetch error:', mandateErr.message);
      }
    }

    const priceCents = Math.round(parseFloat(payment.amount.value) * 100);
    const invNr      = invoiceNumber();
    const payId      = uuidv4();
    db.prepare(`
      INSERT INTO payments (id, user_id, mollie_payment_id, amount_cents, currency, status, invoice_number, payment_type, created_at)
      VALUES (?, ?, ?, ?, ?, 'paid', ?, ?, ?)
    `).run(payId, userId, payment.id, priceCents, payment.amount.currency.toLowerCase(), invNr, payType, now);

    const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    sendInvoiceMail(updatedUser, { invoice_number: invNr, amount_cents: priceCents, created_at: now }).catch(console.error);

    // Check referral reward: if this was a first-time payment for this user AND
    // they were referred, the referrer may have hit the 3-conversion threshold.
    if (updatedUser.referred_by && seqType !== 'recurring') {
      try { checkReferralReward(updatedUser.referred_by); } catch (e) { console.error('[referral]', e.message); }
    }

    // Sync to Zoho Books (fire-and-forget; reconciliation-cron vangt fouten op)
    zohoSync.syncPayment(db, payId).then((r) => {
      if (!r.synced && !r.skipped) {
        console.warn('[zoho] sync failed for', payId, r.error);
      }
    }).catch((err) => {
      console.error('[zoho] sync error for', payId, err.message);
    });
  } catch (err) {
    console.error('[mollie] webhook error:', err.message);
  }

  res.send('ok');
}));

  return router;
};
