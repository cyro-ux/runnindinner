/**
 * Ingelogde-gebruiker-routes: events (CRUD + iCal), referral, AVG
 * (data-export + zelfverwijdering), betaalhistorie/facturen, profiel
 * en taalvoorkeur. Factory met dependency-injection (tranche 7);
 * async handlers in asyncHandler.
 */
'use strict';

const express = require('express');
const { asyncHandler } = require('../lib/async-handler');

module.exports = function accountRoutes(deps) {
  const {
    db, t, requireAuth, uuidv4, bcrypt, mollie, sendMail, wrapHtml,
    activeSessions, generateReferralCode, BASE_URL, SUPPORTED_LANGS,
    PDFDocument, formatEur, invoiceNumber,
  } = deps;
  const router = express.Router();

// ── Event CRUD (backend-only — frontend app.js blijft client-side voor nu) ──
// Deze endpoints zijn klaar, maar de planner-index.html gebruikt ze nog niet.
// Wanneer Sprint 6b actief wordt (persistent events), dan haakt de frontend
// hier op aan.

router.post('/api/events', requireAuth, (req, res) => {
  const { name, date, maxParticipants, courses = 3, locationNote, donationGoalCents, logoUrl } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = uuidv4();
  const now = Date.now();
  db.prepare(`
    INSERT INTO events (id, user_id, name, date, max_participants, courses, location_note,
                       donation_goal_cents, logo_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, name, date || null, maxParticipants ?? null, courses,
         locationNote || null, donationGoalCents ?? null, logoUrl || null, now, now);
  res.json({ ok: true, id });
});

router.get('/api/events', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM events WHERE user_id = ? AND archived_at IS NULL ORDER BY date DESC, created_at DESC'
  ).all(req.user.id);
  res.json({ ok: true, events: rows });
});

router.get('/api/events/:id', requireAuth, (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  const participants = db.prepare('SELECT * FROM event_participants WHERE event_id = ? ORDER BY name').all(ev.id);
  res.json({ ok: true, event: ev, participants });
});

router.put('/api/events/:id', requireAuth, (req, res) => {
  const { name, date, maxParticipants, courses, locationNote, donationGoalCents, logoUrl } = req.body || {};
  const result = db.prepare(`
    UPDATE events SET
      name = COALESCE(?, name),
      date = COALESCE(?, date),
      max_participants = COALESCE(?, max_participants),
      courses = COALESCE(?, courses),
      location_note = COALESCE(?, location_note),
      donation_goal_cents = COALESCE(?, donation_goal_cents),
      logo_url = COALESCE(?, logo_url),
      updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(name ?? null, date ?? null, maxParticipants ?? null, courses ?? null,
         locationNote ?? null, donationGoalCents ?? null, logoUrl ?? null,
         Date.now(), req.params.id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.delete('/api/events/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM events WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Participants sub-resource
router.post('/api/events/:id/participants', requireAuth, (req, res) => {
  const ev = db.prepare('SELECT id FROM events WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const { name, email, phone, address, dietNotes, availability, isHostFor } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = uuidv4();
  const token = uuidv4().replace(/-/g, '').slice(0, 16); // personalised page URL token
  db.prepare(`
    INSERT INTO event_participants
      (id, event_id, name, email, phone, address, diet_notes, availability_json, is_host_for, token, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, ev.id, name, email || null, phone || null, address || null,
         dietNotes || null, availability ? JSON.stringify(availability) : null,
         isHostFor || null, token, Date.now());
  res.json({ ok: true, id, token });
});

// GET /api/events/:id/calendar.ics  – download het event in iCal-formaat
// (werkt voor de organisator; logged-in required)
router.get('/api/events/:id/calendar.ics', requireAuth, (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!ev) return res.status(404).send('Not found');
  const { buildEventCalendar } = require('../lib/ical');
  const ics = buildEventCalendar(ev);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${ev.id}.ics"`);
  res.send(ics);
});

// GET /api/events/:id/participants/:token/calendar.ics  – public, token-based
// Persoonlijke kalender voor één deelnemer. Geen auth nodig, alleen het token
// dat alleen de organisator deelt.
router.get('/api/events/:eventId/participants/:token/calendar.ics', (req, res) => {
  const participant = db.prepare(`
    SELECT ep.*, e.id as evt_id, e.name as evt_name, e.date as evt_date, e.user_id as organiser_id
    FROM event_participants ep JOIN events e ON e.id = ep.event_id
    WHERE ep.event_id = ? AND ep.token = ?
  `).get(req.params.eventId, req.params.token);
  if (!participant) return res.status(404).send('Not found');

  const { buildParticipantCalendar } = require('../lib/ical');
  // TODO: vervangen door echte courses-data uit planning; placeholder voor nu
  const courses = [
    { name: 'Voorgerecht',  host: participant.is_host_for === 'Voorgerecht'  ? 'Jij' : '—', tableMates: [], address: '' },
    { name: 'Hoofdgerecht', host: participant.is_host_for === 'Hoofdgerecht' ? 'Jij' : '—', tableMates: [], address: '' },
    { name: 'Nagerecht',    host: participant.is_host_for === 'Nagerecht'    ? 'Jij' : '—', tableMates: [], address: '' },
  ];
  const event = { id: participant.evt_id, name: participant.evt_name, date: participant.evt_date };
  const ics = buildParticipantCalendar(event, participant, courses);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${event.id}-${participant.name.replace(/\s+/g, '-')}.ics"`);
  res.send(ics);
});

router.delete('/api/events/:eventId/participants/:id', requireAuth, (req, res) => {
  // Verify ownership via event
  const ev = db.prepare('SELECT id FROM events WHERE id = ? AND user_id = ?').get(req.params.eventId, req.user.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  db.prepare('DELETE FROM event_participants WHERE id = ? AND event_id = ?').run(req.params.id, ev.id);
  res.json({ ok: true });
});

router.get('/api/user/referral', requireAuth, (req, res) => {
  let user = db.prepare('SELECT referral_code FROM users WHERE id = ?').get(req.user.id);
  if (!user?.referral_code) {
    // Backfill code if missing (shouldn't happen after migration)
    const code = generateReferralCode();
    db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(code, req.user.id);
    user = { referral_code: code };
  }

  const referredTotal = db.prepare('SELECT COUNT(*) as c FROM users WHERE referred_by = ?').get(req.user.id).c;
  const converted = db.prepare(
    "SELECT COUNT(*) as c FROM users WHERE referred_by = ? AND license_until IS NOT NULL AND license_until > 0"
  ).get(req.user.id).c;
  const rewardsEarned = db.prepare(
    'SELECT COUNT(*) as c FROM referral_rewards WHERE user_id = ?'
  ).get(req.user.id).c;

  const inviteUrl = `${BASE_URL}/register.html?ref=${user.referral_code}`;
  const progressToNext = converted % REFERRAL_THRESHOLD;
  const needed = REFERRAL_THRESHOLD - progressToNext;

  res.json({
    ok: true,
    code: user.referral_code,
    inviteUrl,
    stats: {
      referredTotal,
      converted,
      rewardsEarned,
      progressToNext,         // 0-2
      neededForNextReward: needed, // 1-3
      threshold: REFERRAL_THRESHOLD,
      rewardDays: REFERRAL_REWARD_DAYS,
    },
  });
});

// ── GDPR: self-service data portability + account deletion ──────────────────

// GET /api/user/data-export  – full JSON dump of user's own data (GDPR Art. 20)
router.get('/api/user/data-export', requireAuth, (req, res) => {
  const user = db.prepare(`
    SELECT id, email, role, user_type, created_at, last_login, license_until,
           auto_renew, language, country, is_business, vat_id, company_name,
           mollie_customer_id, mollie_mandate_id
    FROM users WHERE id = ?
  `).get(req.user.id);

  if (!user) return res.status(404).json({ error: t(req, 'user_not_found') });

  const payments = db.prepare(`
    SELECT invoice_number, amount_cents, currency, status, payment_type,
           created_at, country, vat_rate, vat_scheme
    FROM payments WHERE user_id = ? ORDER BY created_at DESC
  `).all(req.user.id);

  const ratings = db.prepare(`
    SELECT score, comment, created_at FROM ratings WHERE user_id = ?
  `).all(req.user.id);

  const exportData = {
    _meta: {
      exportedAt: new Date().toISOString(),
      gdprArticle: 'Art. 20 GDPR — Right to data portability',
      source: 'runningdinner.app',
    },
    profile: {
      ...user,
      created_at:   new Date(user.created_at).toISOString(),
      last_login:   user.last_login ? new Date(user.last_login).toISOString() : null,
      license_until: user.license_until ? new Date(user.license_until).toISOString() : null,
    },
    payments: payments.map(p => ({
      ...p,
      amount: (p.amount_cents / 100).toFixed(2),
      created_at: new Date(p.created_at).toISOString(),
    })),
    ratings: ratings.map(r => ({ ...r, created_at: new Date(r.created_at).toISOString() })),
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="runningdinner-data-${user.email}-${new Date().toISOString().split('T')[0]}.json"`);
  res.send(JSON.stringify(exportData, null, 2));
});

// DELETE /api/user/account  – permanently delete own account (GDPR Art. 17)
// Requires current password as confirmation to prevent accidental deletion.
router.delete('/api/user/account', requireAuth, asyncHandler(async (req, res) => {
  const { password, confirm } = req.body || {};
  if (confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm' });
  if (!password) return res.status(400).json({ error: t(req, 'email_pw_required') });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: t(req, 'user_not_found') });

  // Don't allow admin self-deletion (safety)
  if (user.role === 'admin') {
    return res.status(403).json({ error: 'Admin accounts cannot be deleted via self-service' });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: t(req, 'current_pw_wrong') });

  // Revoke Mollie mandate if present (stops future charges)
  if (user.mollie_mandate_id && user.mollie_customer_id) {
    try {
      await mollie.customerMandates.delete(user.mollie_mandate_id, { customerId: user.mollie_customer_id });
    } catch (err) {
      console.warn('[delete-account] mandate revoke failed:', err.message);
    }
  }

  // Delete cascade (ratings; payments blijven bewaard). Sessies zijn
  // in-memory (activeSessions) — er is géén sessions-tabel; de eerdere
  // DELETE daarop liet deze handler crashen zodat AVG-zelfverwijdering
  // in de praktijk nooit werkte (eeuwige spinner).
  db.prepare('DELETE FROM ratings WHERE user_id = ?').run(user.id);
  // Anonymize payments instead of deleting (tax law retention)
  db.prepare('UPDATE payments SET user_id = ?, zoho_sync_error = ? WHERE user_id = ?')
    .run('deleted-' + user.id, 'User self-deleted account', user.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

  // Clear session cookie
  res.clearCookie('token');
  activeSessions.delete(user.id);

  // Notify via email (last contact)
  const lang = user.language || 'nl';
  const subject = { nl: 'Je account is verwijderd', en: 'Your account has been deleted', es: 'Tu cuenta ha sido eliminada', de: 'Dein Konto wurde gelöscht' }[lang] || 'Account deleted';
  const body = {
    nl: '<p>Hallo,</p><p>Je Running Dinner Planner-account is permanent verwijderd. Facturen blijven bewaard zoals fiscaal verplicht.</p>',
    en: '<p>Hi,</p><p>Your Running Dinner Planner account has been permanently deleted. Invoices are retained as required by tax law.</p>',
    es: '<p>Hola,</p><p>Tu cuenta de Running Dinner Planner ha sido eliminada permanentemente. Las facturas se conservan según la ley fiscal.</p>',
    de: '<p>Hallo,</p><p>Dein Running-Dinner-Planner-Konto wurde dauerhaft gelöscht. Rechnungen werden gemäß steuerlicher Aufbewahrungspflicht aufbewahrt.</p>',
  }[lang] || '<p>Your account has been deleted.</p>';
  sendMail(user.email, subject, wrapHtml(body, lang)).catch(console.error);

  res.json({ ok: true, message: 'Account deleted' });
}));

// GET /api/payments/my  – current user's payment history
router.get('/api/payments/my', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT invoice_number, amount_cents, currency, status, created_at, mollie_payment_id FROM payments WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.user.id);
  res.json({ ok: true, payments: rows });
});

// GET /api/payments/invoice/:invoiceNumber  – download invoice as PDF
router.get('/api/payments/invoice/:invoiceNumber', requireAuth, (req, res) => {
  const payment = db.prepare(
    'SELECT p.*, u.email FROM payments p JOIN users u ON u.id = p.user_id WHERE p.invoice_number = ? AND p.user_id = ? AND p.status = ?'
  ).get(req.params.invoiceNumber, req.user.id, 'paid');

  if (!payment) return res.status(404).json({ error: t(req, 'invoice_not_found') });

  const doc = new PDFDocument({ size: 'A4', margin: 50 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="factuur-${payment.invoice_number}.pdf"`);
  doc.pipe(res);

  const blue = '#1a56db';
  const gray = '#6b7280';
  const dark = '#111827';
  const payDate = new Date(payment.created_at);
  const amount = formatEur(payment.amount_cents);
  const btwRate = 21;
  const exclBtw = payment.amount_cents / (1 + btwRate / 100);
  const btwAmount = payment.amount_cents - exclBtw;

  // Header
  doc.fontSize(24).fillColor(blue).text('Running Dinner Planner', 50, 50);
  doc.fontSize(10).fillColor(gray).text('runningdinner.app', 50, 80);
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor(gray).text('VMH B.V.', 50, 100);
  doc.text('KvK: 08142482 · BTW NL8152.92.715.B01', 50, 115);

  // Invoice title
  doc.fontSize(18).fillColor(dark).text('FACTUUR', 400, 50, { align: 'right' });
  doc.fontSize(10).fillColor(gray)
    .text(`Factuurnummer: ${payment.invoice_number}`, 400, 78, { align: 'right' })
    .text(`Datum: ${payDate.toLocaleDateString('nl-NL')}`, 400, 93, { align: 'right' });

  // Divider
  doc.moveTo(50, 145).lineTo(545, 145).strokeColor('#e5e7eb').stroke();

  // Bill to
  doc.fontSize(10).fillColor(gray).text('Factuur aan:', 50, 160);
  doc.fontSize(11).fillColor(dark).text(payment.email, 50, 175);

  // Table header
  const tableTop = 220;
  doc.rect(50, tableTop, 495, 25).fill('#f3f4f6');
  doc.fontSize(10).fillColor(dark)
    .text('Omschrijving', 60, tableTop + 7)
    .text('Aantal', 340, tableTop + 7, { width: 50, align: 'center' })
    .text('Prijs', 400, tableTop + 7, { width: 70, align: 'right' })
    .text('Totaal', 475, tableTop + 7, { width: 70, align: 'right' });

  // Table row
  const rowY = tableTop + 30;
  doc.fontSize(10).fillColor(dark)
    .text('Running Dinner Planner - 1 jaar abonnement', 60, rowY)
    .text('1', 340, rowY, { width: 50, align: 'center' })
    .text(amount, 400, rowY, { width: 70, align: 'right' })
    .text(amount, 475, rowY, { width: 70, align: 'right' });

  // Divider
  doc.moveTo(50, rowY + 25).lineTo(545, rowY + 25).strokeColor('#e5e7eb').stroke();

  // Totals
  const totalsY = rowY + 40;
  doc.fontSize(10).fillColor(gray)
    .text('Subtotaal excl. BTW', 350, totalsY, { width: 120, align: 'right' })
    .text(formatEur(Math.round(exclBtw)), 475, totalsY, { width: 70, align: 'right' });
  doc.text(`BTW ${btwRate}%`, 350, totalsY + 18, { width: 120, align: 'right' })
    .text(formatEur(Math.round(btwAmount)), 475, totalsY + 18, { width: 70, align: 'right' });

  doc.moveTo(350, totalsY + 38).lineTo(545, totalsY + 38).strokeColor('#e5e7eb').stroke();

  doc.fontSize(12).fillColor(dark).font('Helvetica-Bold')
    .text('Totaal incl. BTW', 350, totalsY + 45, { width: 120, align: 'right' })
    .text(amount, 475, totalsY + 45, { width: 70, align: 'right' });

  // Payment info
  doc.font('Helvetica').fontSize(10).fillColor(gray);
  const infoY = totalsY + 90;
  doc.text('Betaalmethode: iDEAL via Mollie', 50, infoY);
  doc.text(`Betaald op: ${payDate.toLocaleDateString('nl-NL')}`, 50, infoY + 15);
  doc.text('Status: Voldaan', 50, infoY + 30);
  if (payment.mollie_payment_id) {
    doc.text(`Referentie: ${payment.mollie_payment_id}`, 50, infoY + 45);
  }

  // Footer
  doc.fontSize(9).fillColor(gray)
    .text('Running Dinner Planner is een dienst van VMH BV', 50, 750, { align: 'center', width: 495 })
    .text('Vragen? Neem contact op via het contactformulier op runningdinner.app', 50, 765, { align: 'center', width: 495 });

  doc.end();
});

// GET /api/user/profile  – user profile data
router.get('/api/user/profile', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, role, user_type, created_at, last_login, license_until, auto_renew, mollie_mandate_id FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: t(req, 'user_not_found') });
  const payments = db.prepare(
    "SELECT invoice_number, amount_cents, currency, status, created_at FROM payments WHERE user_id = ? AND status = 'paid' ORDER BY created_at DESC"
  ).all(req.user.id);
  res.json({ ok: true, user, payments });
});

router.put('/api/user/language', requireAuth, (req, res) => {
  const { language } = req.body || {};
  if (!language || !SUPPORTED_LANGS.includes(language)) {
    return res.status(400).json({ error: t(req, 'invalid_lang') });
  }
  db.prepare('UPDATE users SET language = ? WHERE id = ?').run(language, req.user.id);
  res.cookie('lang', language, { maxAge: 365 * 86400000, sameSite: 'lax' });
  res.json({ ok: true, language });
});

  return router;
};
