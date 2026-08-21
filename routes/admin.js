/**
 * Alle admin-routes: gebruikersbeheer, stats/conversie, orders, settings,
 * vouchers, audit-log, Brevo/Sentry-beheer, Zoho Books, Plausible-
 * analytics, review-moderatie en blog-drafts. Alleen bereikbaar met
 * requireAdmin. Factory met dependency-injection (tranche 6).
 */
'use strict';

const express = require('express');
const os = require('os'); // servermetrics in /api/admin/stats
const gsc = require('../lib/gsc');
const { asyncHandler } = require('../lib/async-handler');

module.exports = function adminRoutes(deps) {
  const {
    db, fs, path, t, requireAdmin, getSetting, sendMail, wrapHtml, bcrypt,
    uuidv4, BASE_URL, activeSessions, sentry, zohoClient, zohoSync, blog,
  } = deps;
  const router = express.Router();

// ── Brevo: one-shot admin endpoint to set API key without leaking it ──────
// Writes BREVO_API_KEY to .env + updates process.env. Returns only success.
router.post('/api/admin/brevo/set-key', requireAdmin, async (req, res) => {
  const { apiKey } = req.body || {};
  if (!apiKey || !/^xkeysib-[a-f0-9\-]{60,}/.test(String(apiKey))) {
    return res.status(400).json({ error: 'Invalid Brevo API key format' });
  }
  try {
    // Validate by pinging Brevo /account endpoint
    const https = require('node:https');
    const check = await new Promise((resolve) => {
      const r = https.get({
        host: 'api.brevo.com',
        path: '/v3/account',
        headers: { 'api-key': apiKey },
        timeout: 10000,
      }, (resp) => {
        let d = ''; resp.on('data', c => { d += c; });
        resp.on('end', () => resolve({ status: resp.statusCode, body: d }));
      });
      r.on('error', () => resolve({ status: 0 }));
    });
    if (check.status !== 200) {
      return res.status(400).json({ error: 'Key validation failed with Brevo API', status: check.status });
    }

    // Write to .env
    const envPath = path.join(__dirname, '.env');
    let envContent = '';
    try { envContent = fs.readFileSync(envPath, 'utf8'); } catch {}
    const re = /^BREVO_API_KEY=.*$/m;
    if (re.test(envContent)) envContent = envContent.replace(re, `BREVO_API_KEY=${apiKey}`);
    else envContent += (envContent.endsWith('\n') || envContent === '' ? '' : '\n') + `BREVO_API_KEY=${apiKey}\n`;
    fs.writeFileSync(envPath, envContent, { mode: 0o600 });
    process.env.BREVO_API_KEY = apiKey;
    res.json({ ok: true, message: 'Brevo API key updated + validated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/brevo/set-smtp-key — rotate SMTP_PASS without exposing it
router.post('/api/admin/brevo/set-smtp-key', requireAdmin, async (req, res) => {
  const { smtpKey } = req.body || {};
  if (!smtpKey || !/^xsmtpsib-[a-f0-9\-]{60,}/.test(String(smtpKey))) {
    return res.status(400).json({ error: 'Invalid Brevo SMTP key format (expect xsmtpsib-...)' });
  }
  try {
    const envPath = path.join(__dirname, '.env');
    let envContent = '';
    try { envContent = fs.readFileSync(envPath, 'utf8'); } catch {}
    const re = /^SMTP_PASS=.*$/m;
    if (re.test(envContent)) envContent = envContent.replace(re, `SMTP_PASS=${smtpKey}`);
    else envContent += (envContent.endsWith('\n') || envContent === '' ? '' : '\n') + `SMTP_PASS=${smtpKey}\n`;
    fs.writeFileSync(envPath, envContent, { mode: 0o600 });
    process.env.SMTP_PASS = smtpKey;
    // Force nodemailer transporter to re-initialize next call
    res.json({ ok: true, message: 'SMTP key updated. PM2 restart required for nodemailer transport to reload.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sentry: test-endpoints voor admin ───────────────────────────────────────
// Handig om te verifiëren dat Sentry daadwerkelijk errors ontvangt.

router.get('/api/admin/sentry/status', requireAdmin, (req, res) => {
  res.json({ ok: true, enabled: sentry.isEnabled() });
});

router.post('/api/admin/sentry/test', requireAdmin, (req, res) => {
  if (!sentry.isEnabled()) {
    return res.status(400).json({ error: 'Sentry not configured — set SENTRY_DSN and install @sentry/node' });
  }
  // Stuur een test-error + test-message naar Sentry
  sentry.captureMessage('Sentry test message from admin dashboard', 'info', {
    triggeredBy: req.user?.email,
    url: req.originalUrl,
  });
  try { throw new Error('Sentry test error from /api/admin/sentry/test'); }
  catch (err) { sentry.captureException(err, { triggeredBy: req.user?.email }); }
  res.json({ ok: true, message: 'Test event + exception sent to Sentry' });
});

// POST /api/admin/sentry/set-dsn  — persist SENTRY_DSN without leaking it
// through logs / transcript. Writes to .env + updates process.env, but the
// sentry wrapper caches its init-state so a PM2 restart is required for the
// new DSN to activate. Response never echoes the DSN back.
router.post('/api/admin/sentry/set-dsn', requireAdmin, async (req, res) => {
  const { dsn } = req.body || {};
  const cleanDsn = String(dsn || '').trim();
  // Permit clear via empty string, otherwise require Sentry DSN format
  if (cleanDsn && !/^https:\/\/[a-f0-9]+@[a-z0-9.\-]+\/\d+/i.test(cleanDsn)) {
    return res.status(400).json({ error: 'Invalid Sentry DSN format (expected https://<key>@<host>/<project>)' });
  }
  try {
    const envPath = path.join(__dirname, '.env');
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    if (envContent.match(/^SENTRY_DSN=/m)) {
      envContent = envContent.replace(/^SENTRY_DSN=.*$/m, `SENTRY_DSN=${cleanDsn}`);
    } else if (cleanDsn) {
      envContent += (envContent.endsWith('\n') || envContent === '' ? '' : '\n') + `SENTRY_DSN=${cleanDsn}\n`;
    }
    fs.writeFileSync(envPath, envContent, { mode: 0o600 });
    process.env.SENTRY_DSN = cleanDsn;
    try { logAudit(req, 'sentry.dsn_set', { targetType: 'env' }); } catch {}
    res.json({
      ok: true,
      message: cleanDsn
        ? 'Sentry DSN saved. PM2 restart required to activate the new DSN (sentry wrapper caches its init).'
        : 'Sentry DSN cleared. PM2 restart required to deactivate.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Audit log ────────────────────────────────────────────────────────────────
// Helper voor admin-acties. Wordt momenteel niet automatisch aangeroepen —
// bij Sprint 7 hooken we dit in de bestaande admin-endpoints (user-delete,
// voucher-create, CMS-update, deployment, etc.) zodra je groen licht geeft.

function logAudit(req, action, { targetType, targetId, data } = {}) {
  try {
    db.prepare(`
      INSERT INTO audit_log (user_id, actor_email, action, target_type, target_id, data_json, ip, user_agent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user?.id || null,
      req.user?.email || null,
      action,
      targetType || null,
      targetId || null,
      data ? JSON.stringify(data).slice(0, 4000) : null,
      (req.headers['cf-connecting-ip'] || req.ip || '').slice(0, 64),
      (req.headers['user-agent'] || '').slice(0, 256),
      Date.now(),
    );
  } catch (err) {
    console.error('[audit] failed to log:', err.message);
  }
}

// GET /api/admin/audit  – last 100 entries, filterable by action / user
router.get('/api/admin/audit', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  const filters = [];
  const params = [];
  if (req.query.action)  { filters.push('action LIKE ?');      params.push('%' + req.query.action + '%'); }
  if (req.query.userId)  { filters.push('user_id = ?');        params.push(req.query.userId); }
  if (req.query.target)  { filters.push('target_type = ?');    params.push(req.query.target); }
  const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
  const rows = db.prepare(
    `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ?`
  ).all(...params, limit);
  res.json({ ok: true, entries: rows });
});

// ── Vouchers / discount codes (feature-flagged) ─────────────────────────────
// Enabled when setting vouchers_enabled = '1'. Default: off.

function vouchersEnabled() {
  return getSetting('vouchers_enabled') === '1';
}

// Public: validate a voucher code (returns info without applying it)
router.get('/api/vouchers/validate/:code', (req, res) => {
  if (!vouchersEnabled()) return res.status(404).json({ error: 'Vouchers not enabled' });
  const code = String(req.params.code || '').trim().toUpperCase();
  const v = db.prepare('SELECT * FROM vouchers WHERE UPPER(code) = ?').get(code);
  if (!v) return res.status(404).json({ error: 'Invalid voucher' });
  if (v.expires_at && v.expires_at < Date.now()) return res.status(410).json({ error: 'Voucher expired' });
  const used = db.prepare('SELECT COUNT(*) as c FROM voucher_redemptions WHERE voucher_id = ?').get(v.id).c;
  if (v.max_uses && used >= v.max_uses) return res.status(409).json({ error: 'Voucher fully redeemed' });
  res.json({
    ok: true,
    code:            v.code,
    description:     v.description,
    discountPercent: v.discount_percent,
    freeDays:        v.free_days,
  });
});

// Admin: list all vouchers with usage stats
router.get('/api/admin/vouchers', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT v.*,
      (SELECT COUNT(*) FROM voucher_redemptions WHERE voucher_id = v.id) as redeemed_count
    FROM vouchers v
    ORDER BY v.created_at DESC
  `).all();
  res.json({ ok: true, vouchers: rows, enabled: vouchersEnabled() });
});

// Admin: create voucher
router.post('/api/admin/vouchers', requireAdmin, (req, res) => {
  const { code, description, discountPercent, freeDays, maxUses, expiresAt } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code required' });
  if (discountPercent == null && freeDays == null) return res.status(400).json({ error: 'Specify discount_percent or free_days' });
  const id = uuidv4();
  try {
    db.prepare(`
      INSERT INTO vouchers (id, code, description, discount_percent, free_days, max_uses, expires_at, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, code.trim().toUpperCase(), description || null,
           discountPercent ?? null, freeDays ?? null, maxUses ?? null, expiresAt ?? null,
           Date.now(), req.user.id);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// Admin: delete voucher
router.delete('/api/admin/vouchers/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM vouchers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Admin: toggle vouchers feature flag
router.put('/api/admin/vouchers/enabled', requireAdmin, (req, res) => {
  const { enabled } = req.body || {};
  db.prepare("INSERT INTO settings (key, value) VALUES ('vouchers_enabled', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(enabled ? '1' : '0');
  res.json({ ok: true, enabled: Boolean(enabled) });
});

// ── Admin routes ──────────────────────────────────────────────────────────────

// GET /api/admin/stats
router.get('/api/admin/stats', requireAdmin, (req, res) => {
  const now         = Date.now();
  const totalUsers  = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='user'").get().c;
  const activeUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='user' AND license_until > ?").get(now).c;
  const expiredUsers = totalUsers - activeUsers;

  // User type breakdown
  const paidUsers   = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='user' AND user_type='paid'").get().c;
  const manualUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='user' AND user_type='manual'").get().c;
  const testUsers   = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='user' AND user_type='test'").get().c;

  const totalRevenue = db.prepare("SELECT COALESCE(SUM(amount_cents),0) as s FROM payments WHERE status='paid'").get().s;
  const thisMonth    = new Date(); thisMonth.setDate(1); thisMonth.setHours(0,0,0,0);
  const revenueMonth = db.prepare("SELECT COALESCE(SUM(amount_cents),0) as s FROM payments WHERE status='paid' AND created_at >= ?").get(thisMonth.getTime()).s;
  const priceCents   = parseInt(getSetting('subscription_price_cents') || '500', 10);

  // Active sessions (seen in last 30 minutes)
  const sessionCutoff = now - 30 * 60 * 1000;
  const activeSesCount = [...activeSessions.values()].filter(s => s.lastSeen > sessionCutoff).length;

  // Server load (1-minute load average as percentage of CPU cores)
  const loadAvg    = os.loadavg()[0];
  const cpuCount   = os.cpus().length;
  const loadPct    = Math.min(100, Math.round((loadAvg / cpuCount) * 100));
  const memTotal   = os.totalmem();
  const memFree    = os.freemem();
  const memPct     = Math.round(((memTotal - memFree) / memTotal) * 100);

  // Planning counter
  const planningCount = parseInt(getSetting('planning_counter') || '0', 10);

  // Auto-renewal stats
  const autoRenewCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE auto_renew = 1").get().c;

  res.json({ ok: true, stats: {
    totalUsers, activeUsers, expiredUsers,
    paidUsers, manualUsers, testUsers,
    totalRevenue, revenueMonth, priceCents,
    activeSessions: activeSesCount,
    serverLoad: loadPct,
    memoryUsed: memPct,
    planningCount,
    autoRenewCount,
  }});
});

// GET /api/admin/conversion  — signup → first-paid conversion ratio over
// rolling windows. Based on our own DB (authoritative), not Plausible.
router.get('/api/admin/conversion', requireAdmin, (req, res) => {
  const now = Date.now();
  const windows = [
    { label: '7d',  ms:  7 * 86400000 },
    { label: '30d', ms: 30 * 86400000 },
    { label: '90d', ms: 90 * 86400000 },
    { label: 'all', ms: null },
  ];
  const stats = {};
  for (const w of windows) {
    const signupsSql = w.ms
      ? "SELECT COUNT(*) AS c FROM users WHERE role='user' AND created_at >= ?"
      : "SELECT COUNT(*) AS c FROM users WHERE role='user'";
    const paidSql = w.ms
      ? "SELECT COUNT(DISTINCT user_id) AS c FROM payments WHERE status='paid' AND created_at >= ?"
      : "SELECT COUNT(DISTINCT user_id) AS c FROM payments WHERE status='paid'";
    const cutoff = w.ms ? now - w.ms : null;
    const signups = w.ms ? db.prepare(signupsSql).get(cutoff).c : db.prepare(signupsSql).get().c;
    const paid    = w.ms ? db.prepare(paidSql).get(cutoff).c     : db.prepare(paidSql).get().c;
    stats[w.label] = {
      signups,
      paid,
      conversion: signups > 0 ? Math.round((paid / signups) * 1000) / 10 : 0, // % with 1 decimal
    };
  }
  res.json({ ok: true, windows: stats });
});

// GET /api/admin/users  – with payment count and member duration
router.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.email, u.role, u.user_type, u.created_at, u.last_login, u.license_until,
           u.auto_renew, u.mollie_mandate_id,
           u.is_business, u.company_name, u.vat_id, u.country, u.waiver_accepted_at,
           COUNT(p.id) as payment_count
    FROM users u
    LEFT JOIN payments p ON p.user_id = u.id AND p.status = 'paid'
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();
  // Normalise is_business to boolean
  for (const u of users) u.is_business = !!u.is_business;
  res.json({ ok: true, users });
});

// POST /api/admin/users  – manually create user (optionally send invite)
router.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { email, password, user_type = 'manual', license_days, send_invite } = req.body || {};
  if (!email) return res.status(400).json({ error: t(req, 'email_required') });

  // If send_invite, password is optional (generate random one)
  const actualPassword = send_invite ? (password || crypto.randomBytes(16).toString('hex')) : password;
  if (!actualPassword) return res.status(400).json({ error: t(req, 'pw_required_invite') });
  if (!send_invite && actualPassword.length < 8) return res.status(400).json({ error: t(req, 'pw_min_8') });

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (exists) return res.status(409).json({ error: t(req, 'email_in_use') });

  const hash         = await bcrypt.hash(actualPassword, 12);
  const id           = uuidv4();
  const licenseUntil = license_days ? Date.now() + parseInt(license_days, 10) * 86400000 : null;

  db.prepare(`
    INSERT INTO users (id, email, password_hash, role, user_type, created_at, license_until)
    VALUES (?, ?, ?, 'user', ?, ?, ?)
  `).run(id, email.toLowerCase(), hash, user_type, Date.now(), licenseUntil);

  // Send invitation email if requested
  let inviteSent = false;
  if (send_invite) {
    try {
      const token     = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 7 * 24 * 3600 * 1000;
      db.prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, id, expiresAt);

      const link = `${BASE_URL}/reset-password.html?token=${token}&invite=1`;
      const inviteBody = `
              <h2 style="color:#1a56db;margin:0 0 16px">Running Dinner Planner</h2>
              <p style="color:#374151;line-height:1.6">Hallo,</p>
              <p style="color:#374151;line-height:1.6">Je bent uitgenodigd om Running Dinner Planner te gebruiken. Klik op onderstaande knop om je wachtwoord in te stellen en aan de slag te gaan.</p>
              ${licenseUntil ? `<p style="color:#374151;line-height:1.6">Je abonnement is actief t/m <strong>${new Date(licenseUntil).toLocaleDateString('nl-NL')}</strong>.</p>` : ''}
              <p style="margin:24px 0;text-align:center">
                <a href="${link}" style="background:#1a56db;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">
                  Wachtwoord instellen
                </a>
              </p>
              <p style="color:#6b7280;font-size:13px;line-height:1.5">Deze link is 7 dagen geldig. Werkt de knop niet? Kopieer dan deze link in je browser:<br><a href="${link}" style="color:#1a56db;word-break:break-all">${link}</a></p>
      `;
      await sendMail(email.toLowerCase(), 'Uitnodiging Running Dinner Planner', wrapHtml(inviteBody));
      inviteSent = true;
    } catch (err) {
      console.error('[invite] mail error:', err.message);
    }
  }

  const msg = inviteSent
    ? (req.lang === 'en' ? `User created and invitation sent to ${email}` : `Gebruiker aangemaakt en uitnodiging verstuurd naar ${email}`)
    : send_invite
      ? (req.lang === 'en' ? 'User created, but invitation email could not be sent' : 'Gebruiker aangemaakt, maar uitnodigingsmail kon niet verstuurd worden')
      : (req.lang === 'en' ? 'User created.' : 'Gebruiker aangemaakt.');

  res.json({ ok: true, message: msg, user_id: id });
});

// PUT /api/admin/users/:id  – edit user (license, type, email)
router.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const { email, user_type, license_days, license_until, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: t(req, 'user_not_found') });
  if (user.role === 'admin' && req.user.id !== user.id) return res.status(403).json({ error: t(req, 'cannot_edit_admin') });

  // Update email if changed
  if (email && email.toLowerCase() !== user.email) {
    const exists = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email.toLowerCase(), user.id);
    if (exists) return res.status(409).json({ error: t(req, 'email_in_use') });
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email.toLowerCase(), user.id);
  }

  // Update type
  if (user_type && ['paid', 'manual', 'test'].includes(user_type)) {
    db.prepare('UPDATE users SET user_type = ? WHERE id = ?').run(user_type, user.id);
  }

  // Update license: license_days takes priority, then license_until, then 'remove' to clear
  if (license_days !== undefined && license_days !== null && license_days !== '') {
    const days = parseInt(license_days, 10);
    if (days > 0) {
      const newUntil = Date.now() + days * 86400000;
      db.prepare('UPDATE users SET license_until = ? WHERE id = ?').run(newUntil, user.id);
    }
  } else if (license_until === 'remove') {
    db.prepare('UPDATE users SET license_until = NULL WHERE id = ?').run(user.id);
  } else if (license_until && typeof license_until === 'number') {
    db.prepare('UPDATE users SET license_until = ? WHERE id = ?').run(license_until, user.id);
  }

  // Update password if provided
  if (password && password.length >= 8) {
    const hash = await bcrypt.hash(password, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  }

  const updated = db.prepare('SELECT id, email, role, user_type, license_until FROM users WHERE id = ?').get(user.id);
  res.json({ ok: true, message: t(req, 'user_updated'), user: updated });
});

// POST /api/admin/users/:id/invite  – send invitation email with password-set link
router.post('/api/admin/users/:id/invite', requireAdmin, async (req, res) => {
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: t(req, 'user_not_found') });

  // Generate password reset token (used as invite link)
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 7 * 24 * 3600 * 1000; // 7 days for invites
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
  db.prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expiresAt);

  const link = `${BASE_URL}/reset-password.html?token=${token}&invite=1`;
  const html = `
          <h2 style="color:#1a56db;margin:0 0 16px">Running Dinner Planner</h2>
          <p style="color:#374151;line-height:1.6">Hallo,</p>
          <p style="color:#374151;line-height:1.6">Je bent uitgenodigd om Running Dinner Planner te gebruiken. Klik op onderstaande knop om je wachtwoord in te stellen en aan de slag te gaan.</p>
          <p style="margin:24px 0;text-align:center">
            <a href="${link}" style="background:#1a56db;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">
              Wachtwoord instellen
            </a>
          </p>
          <p style="color:#6b7280;font-size:13px;line-height:1.5">Deze link is 7 dagen geldig. Werkt de knop niet? Kopieer dan deze link in je browser:<br><a href="${link}" style="color:#1a56db;word-break:break-all">${link}</a></p>
  `;

  try {
    await sendMail(user.email, 'Uitnodiging Running Dinner Planner', html);
    res.json({ ok: true, message: t(req, 'invite_sent', { email: user.email }) });
  } catch (err) {
    console.error('[invite] mail error:', err.message);
    res.status(500).json({ error: t(req, 'email_send_failed') });
  }
});

// DELETE /api/admin/users/:id
router.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  activeSessions.delete(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ? AND role != ?').run(req.params.id, 'admin');
  res.json({ ok: true });
});

// GET /api/admin/orders  – all payments with user info
router.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = db.prepare(`
    SELECT p.id, p.invoice_number, p.amount_cents, p.currency, p.status,
           p.created_at, p.mollie_payment_id,
           u.email as user_email, u.user_type
    FROM payments p
    LEFT JOIN users u ON u.id = p.user_id
    ORDER BY p.created_at DESC
  `).all();
  res.json({ ok: true, orders });
});

// GET /api/admin/active-sessions
router.get('/api/admin/active-sessions', requireAdmin, (req, res) => {
  const cutoff  = Date.now() - 30 * 60 * 1000;
  const sessions = [...activeSessions.entries()]
    .filter(([, s]) => s.lastSeen > cutoff)
    .map(([userId, s]) => ({ userId, email: s.email, loginAt: s.loginAt, lastSeen: s.lastSeen }));
  res.json({ ok: true, sessions });
});

// PUT /api/admin/settings
router.put('/api/admin/settings', requireAdmin, (req, res) => {
  const { subscription_price_cents, subscription_duration_days } = req.body || {};
  if (subscription_price_cents !== undefined) {
    const cents = parseInt(subscription_price_cents, 10);
    if (isNaN(cents) || cents < 100) return res.status(400).json({ error: t(req, 'min_price') });
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('subscription_price_cents', String(cents));
  }
  if (subscription_duration_days !== undefined) {
    const days = parseInt(subscription_duration_days, 10);
    if (isNaN(days) || days < 1) return res.status(400).json({ error: t(req, 'invalid_duration') });
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('subscription_duration_days', String(days));
  }
  res.json({ ok: true });
});

// ── Admin: referral overview ────────────────────────────────────────────────
router.get('/api/admin/referrals', requireAdmin, (req, res) => {
  const topReferrers = db.prepare(`
    SELECT * FROM (
      SELECT u.id, u.email, u.referral_code, u.created_at,
             (SELECT COUNT(*) FROM users WHERE referred_by = u.id) as referred_total,
             (SELECT COUNT(*) FROM users WHERE referred_by = u.id AND license_until IS NOT NULL AND license_until > 0) as converted,
             (SELECT COUNT(*) FROM referral_rewards WHERE user_id = u.id) as rewards
      FROM users u
      WHERE u.role = 'user'
    )
    WHERE referred_total > 0
    ORDER BY converted DESC, referred_total DESC
    LIMIT 50
  `).all();

  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE referred_by IS NOT NULL) as total_referred,
      (SELECT COUNT(*) FROM users WHERE referred_by IS NOT NULL AND license_until > 0) as total_converted,
      (SELECT COUNT(*) FROM referral_rewards) as total_rewards_applied
  `).get();

  res.json({ ok: true, totals, topReferrers });
});

// ── Zoho Books (admin) ───────────────────────────────────────────────────────

// POST /api/admin/zoho/bootstrap  – one-time OAuth setup
// Accepts { clientId, clientSecret, code, region? } → exchanges authorization code
// for refresh-token, fetches org ID, writes all credentials to .env, updates
// process.env so the current process picks up the new values immediately.
router.post('/api/admin/zoho/bootstrap', requireAdmin, async (req, res) => {
  const { clientId, clientSecret, code, region = 'com', orgId } = req.body || {};
  if (!clientId || !clientSecret || !code) {
    return res.status(400).json({ error: 'missing clientId/clientSecret/code' });
  }
  const accountsHost = region === 'eu' ? 'accounts.zoho.eu'
    : region === 'in' ? 'accounts.zoho.in'
    : region === 'com.au' ? 'accounts.zoho.com.au'
    : 'accounts.zoho.com';
  const apiHost = region === 'eu' ? 'www.zohoapis.eu'
    : region === 'in' ? 'www.zohoapis.in'
    : region === 'com.au' ? 'www.zohoapis.com.au'
    : 'www.zohoapis.com';

  const httpsReq = (opts, body = null) => new Promise((resolve, reject) => {
    const req = require('node:https').request(opts, (resp) => {
      let data = '';
      resp.on('data', (c) => { data += c; });
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: resp.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

  try {
    // 1. Exchange authorization code for refresh_token
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId, client_secret: clientSecret, code,
    });
    const tokenResp = await httpsReq({
      host: accountsHost, method: 'POST',
      path: '/oauth/v2/token?' + params.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (tokenResp.status !== 200 || !tokenResp.body?.refresh_token) {
      return res.status(400).json({ error: 'token exchange failed', detail: tokenResp.body });
    }
    const { refresh_token, access_token } = tokenResp.body;

    // 2. Fetch organizations if orgId not provided
    let finalOrgId = orgId;
    if (!finalOrgId) {
      const orgResp = await httpsReq({
        host: apiHost, method: 'GET',
        path: '/books/v3/organizations',
        headers: { Authorization: `Zoho-oauthtoken ${access_token}` },
      });
      const orgs = orgResp.body?.organizations || [];
      if (!orgs.length) {
        return res.status(400).json({ error: 'no organizations found in Zoho account' });
      }
      if (orgs.length === 1) {
        finalOrgId = String(orgs[0].organization_id);
      } else {
        // Multiple orgs — return them so user can pick
        return res.json({
          ok: false,
          needOrgSelection: true,
          organizations: orgs.map(o => ({ id: String(o.organization_id), name: o.name, currency: o.currency_code })),
        });
      }
    }

    // 3. Update .env file on disk + process.env (current process)
    const envPath = path.join(__dirname, '.env');
    let envContent = '';
    try { envContent = fs.readFileSync(envPath, 'utf8'); } catch { /* no .env yet */ }
    const updates = {
      ZOHO_CLIENT_ID:     clientId,
      ZOHO_CLIENT_SECRET: clientSecret,
      ZOHO_REFRESH_TOKEN: refresh_token,
      ZOHO_ORG_ID:        finalOrgId,
      ZOHO_REGION:        region,
    };
    for (const [k, v] of Object.entries(updates)) {
      const re = new RegExp(`^${k}=.*$`, 'm');
      if (re.test(envContent)) envContent = envContent.replace(re, `${k}=${v}`);
      else envContent += (envContent.endsWith('\n') || envContent === '' ? '' : '\n') + `${k}=${v}\n`;
      process.env[k] = v; // immediate activation in current process
    }
    fs.writeFileSync(envPath, envContent, { encoding: 'utf8', mode: 0o600 });

    // 4. Reset the cached token in zoho-client (forces re-read of new env)
    try { zohoClient._resetTokenCache(); } catch { /* noop */ }
    // Re-require to pick up new process.env values (Node caches module state)
    delete require.cache[require.resolve('./lib/zoho-client')];
    delete require.cache[require.resolve('./lib/zoho-sync')];

    res.json({ ok: true, orgId: finalOrgId, region });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/zoho/ensure-eu-taxes  – idempotent: creates EU OSS tax codes,
// reverse-charge, UK-zero and export-zero tax codes in Zoho if they don't exist yet.
// This maps 1-on-1 with what VatResolver can produce.
router.post('/api/admin/zoho/ensure-eu-taxes', requireAdmin, async (req, res) => {
  if (!zohoClient.isConfigured()) {
    return res.status(400).json({ error: 'Zoho not configured' });
  }

  // Import at runtime to avoid circular deps on boot
  const { EU_B2C_RATES } = require('./lib/vat-resolver');

  try {
    // Fetch existing taxes so we can skip duplicates
    const existing = await zohoClient.call('GET', '/books/v3/settings/taxes');
    const existingTaxes = existing.taxes || [];
    const existingByKey = new Set(existingTaxes.map(t => `${t.tax_name}|${t.tax_percentage}`));

    const plan = [];

    // 1. EU OSS rates (skip NL — that already exists as "BTW hoog 21%")
    for (const [cc, rate] of Object.entries(EU_B2C_RATES)) {
      if (cc === 'NL') continue;
      const name = `OSS ${cc} ${rate}%`;
      if (!existingByKey.has(`${name}|${rate}`)) {
        plan.push({ action: 'create', name, rate, type: 'tax', scheme: 'OSS', country: cc });
      }
    }

    // 2. Reverse charge 0%
    if (!existingTaxes.some(t => /reverse|verlegd/i.test(t.tax_name))) {
      plan.push({ action: 'create', name: 'EU Reverse Charge 0%', rate: 0, type: 'tax', scheme: 'REVERSE_CHARGE' });
    }

    // 3. UK zero
    if (!existingTaxes.some(t => /uk.*zero|uk.*0/i.test(t.tax_name))) {
      plan.push({ action: 'create', name: 'UK Zero Rate 0%', rate: 0, type: 'tax', scheme: 'UK' });
    }

    // 4. Export zero
    if (!existingTaxes.some(t => /export.*zero|export.*0/i.test(t.tax_name))) {
      plan.push({ action: 'create', name: 'Export Zero Rate 0%', rate: 0, type: 'tax', scheme: 'EXPORT' });
    }

    // Dry-run mode: return plan without executing
    if (req.query.dryRun === '1') {
      return res.json({ ok: true, dryRun: true, totalExisting: existingTaxes.length, plan });
    }

    // Execute serially with 1s delay between calls to stay under Zoho rate limits.
    // If any call fails with "Access Denied" (rate limit hit), abort early and
    // return partial results so we don't bang into a longer ban.
    const results = [];
    let rateLimited = false;
    for (const item of plan) {
      if (rateLimited) {
        results.push({ ...item, success: false, error: 'Skipped (rate limit reached earlier in batch)' });
        continue;
      }
      try {
        const created = await zohoClient.call('POST', '/books/v3/settings/taxes', {
          body: {
            tax_name: item.name,
            tax_percentage: item.rate,
            tax_type: 'tax',
          },
        });
        results.push({ ...item, success: true, tax_id: created?.tax?.tax_id });
      } catch (err) {
        results.push({ ...item, success: false, error: err.message });
        // Detect rate limit / auth issue — abort early to prevent longer ban
        if (/Access Denied|too many requests|401/.test(err.message)) {
          rateLimited = true;
        }
      }
      await new Promise(r => setTimeout(r, 1000)); // 1s between calls
    }

    // Invalidate the tax-mapper cache so next sync picks up the new codes
    const taxMapper = require('./lib/zoho-tax-mapper');
    taxMapper.invalidate();

    res.json({
      ok: true,
      totalExisting: existingTaxes.length,
      totalPlanned: plan.length,
      created: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/zoho/status  – last 50 transactions + sync state
router.get('/api/admin/zoho/status', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.invoice_number, p.amount_cents, p.currency, p.status,
           p.created_at, p.country, p.vat_rate, p.vat_scheme,
           p.zoho_invoice_id, p.zoho_sync_status, p.zoho_sync_error, p.zoho_synced_at,
           u.email
    FROM payments p
    JOIN users u ON u.id = p.user_id
    WHERE p.status = 'paid'
    ORDER BY p.created_at DESC
    LIMIT 50
  `).all();

  const counts = db.prepare(`
    SELECT zoho_sync_status, COUNT(*) as c
    FROM payments WHERE status='paid'
    GROUP BY zoho_sync_status
  `).all();

  res.json({
    ok: true,
    configured: zohoClient.isConfigured(),
    counts: Object.fromEntries(counts.map(r => [r.zoho_sync_status, r.c])),
    transactions: rows,
  });
});

// POST /api/admin/zoho/retry/:paymentId  – manual retry of a failed sync
router.post('/api/admin/zoho/retry/:paymentId', requireAdmin, async (req, res) => {
  try {
    const result = await zohoSync.syncPayment(db, req.params.paymentId);
    res.json({ ok: result.synced, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/zoho/discrepancies  – recent payments missing from Zoho
router.get('/api/admin/zoho/discrepancies', requireAdmin, (req, res) => {
  const days = Math.min(parseInt(req.query.days || '7', 10), 90);
  const rows = zohoSync.listDiscrepancies(db, days);
  res.json({ ok: true, days, count: rows.length, discrepancies: rows });
});

// GET /api/admin/deployments
router.get('/api/admin/deployments', requireAdmin, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM deployments ORDER BY created_at DESC LIMIT 20'
  ).all();
  res.json({ ok: true, deployments: rows });
});

// POST /api/admin/deploy
// Logs a deployment record. Actual deployment is via PM2/shell on the server.
router.post('/api/admin/deploy', requireAdmin, (req, res) => {
  const { env = 'production', note = '' } = req.body || {};
  const validEnvs = ['production', 'staging'];
  if (!validEnvs.includes(env)) return res.status(400).json({ error: t(req, 'invalid_env') });

  const id = uuidv4();
  db.prepare(
    'INSERT INTO deployments (id, deployed_by, env, note, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, req.user.email, env, note, Date.now());

  // In a real setup: trigger a shell script here, e.g. via child_process.exec('pm2 reload app')
  // For now just log the deployment intent.
  console.log(`[deploy] ${env} deployment triggered by ${req.user.email}: ${note}`);

  res.json({ ok: true, message: t(req, 'deploy_registered', { env }) });
});

router.put('/api/admin/planning-count', requireAdmin, (req, res) => {
  const { count } = req.body || {};
  const n = parseInt(count, 10);
  if (isNaN(n) || n < 0) return res.status(400).json({ error: t(req, 'invalid_number') });
  db.prepare("INSERT INTO settings (key, value) VALUES ('planning_counter', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(n));
  res.json({ ok: true, count: n });
});

// ── Analytics (Plausible proxy) ──────────────────────────────────────────────

const PLAUSIBLE_API_KEY = process.env.PLAUSIBLE_API_KEY || '';
const PLAUSIBLE_BASE    = process.env.PLAUSIBLE_BASE_URL || 'http://127.0.0.1:8000';
const PLAUSIBLE_SITE_ID = process.env.PLAUSIBLE_SITE_ID || 'runningdinner.app';

function plausibleFetch(apiPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, PLAUSIBLE_BASE);
    const http = require('http');
    const req = http.get(url, {
      headers: { 'Authorization': `Bearer ${PLAUSIBLE_API_KEY}` },
      timeout: 8000,
    }, (resp) => {
      let data = '';
      resp.on('data', chunk => { data += chunk; });
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: resp.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// GET /api/admin/analytics/realtime
// ── Google Search Console (service-account, zie lib/gsc.js) ─────────────
// GET /api/admin/gsc?days=28&dimension=query|page|country|device|date&limit=100
router.get('/api/admin/gsc', requireAdmin, asyncHandler(async (req, res) => {
  if (!gsc.isConfigured()) {
    return res.status(503).json({ ok: false, error: 'GSC niet geconfigureerd (GSC_KEY_FILE ontbreekt)' });
  }
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 28, 1), 480);
  const dimension = ['query', 'page', 'country', 'device', 'date'].includes(req.query.dimension)
    ? req.query.dimension : 'query';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
  const filters = [];
  if (req.query.page) filters.push({ dimension: 'page', operator: 'contains', expression: String(req.query.page) });
  if (req.query.country) filters.push({ dimension: 'country', operator: 'equals', expression: String(req.query.country).toLowerCase() });
  const result = await gsc.query({ days, dimensions: [dimension], rowLimit: limit, filters });
  res.json({ ok: true, ...result });
}));

router.get('/api/admin/analytics/realtime', requireAdmin, async (req, res) => {
  try {
    const r = await plausibleFetch(`/api/v1/stats/realtime/visitors?site_id=${PLAUSIBLE_SITE_ID}`);
    res.json({ ok: true, visitors: r.body });
  } catch { res.json({ ok: false, visitors: 0 }); }
});

// GET /api/admin/analytics/aggregate?period=30d
router.get('/api/admin/analytics/aggregate', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const metrics = 'visitors,pageviews,bounce_rate,visit_duration';
    const r = await plausibleFetch(`/api/v1/stats/aggregate?site_id=${PLAUSIBLE_SITE_ID}&period=${encodeURIComponent(period)}&metrics=${metrics}`);
    res.json({ ok: true, results: r.body.results || {} });
  } catch { res.json({ ok: false, results: {} }); }
});

// GET /api/admin/analytics/timeseries?period=30d&interval=date
router.get('/api/admin/analytics/timeseries', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const interval = req.query.interval || 'date';
    const metrics = req.query.metrics || 'visitors';
    const r = await plausibleFetch(`/api/v1/stats/timeseries?site_id=${PLAUSIBLE_SITE_ID}&period=${encodeURIComponent(period)}&interval=${interval}&metrics=${metrics}`);
    res.json({ ok: true, results: r.body.results || [] });
  } catch { res.json({ ok: false, results: [] }); }
});

// GET /api/admin/analytics/pages?period=30d&limit=10
router.get('/api/admin/analytics/pages', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const limit  = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const r = await plausibleFetch(`/api/v1/stats/breakdown?site_id=${PLAUSIBLE_SITE_ID}&period=${encodeURIComponent(period)}&property=event:page&metrics=visitors,pageviews&limit=${limit}`);
    res.json({ ok: true, results: r.body.results || [] });
  } catch { res.json({ ok: false, results: [] }); }
});

// GET /api/admin/analytics/sources?period=30d&limit=10
router.get('/api/admin/analytics/sources', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const limit  = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const r = await plausibleFetch(`/api/v1/stats/breakdown?site_id=${PLAUSIBLE_SITE_ID}&period=${encodeURIComponent(period)}&property=visit:source&metrics=visitors&limit=${limit}`);
    res.json({ ok: true, results: r.body.results || [] });
  } catch { res.json({ ok: false, results: [] }); }
});

// GET /api/admin/analytics/countries?period=30d&limit=10
router.get('/api/admin/analytics/countries', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const limit  = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const r = await plausibleFetch(`/api/v1/stats/breakdown?site_id=${PLAUSIBLE_SITE_ID}&period=${encodeURIComponent(period)}&property=visit:country&metrics=visitors&limit=${limit}`);
    res.json({ ok: true, results: r.body.results || [] });
  } catch { res.json({ ok: false, results: [] }); }
});

// GET /api/admin/analytics/devices?period=30d
router.get('/api/admin/analytics/devices', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const r = await plausibleFetch(`/api/v1/stats/breakdown?site_id=${PLAUSIBLE_SITE_ID}&period=${encodeURIComponent(period)}&property=visit:device&metrics=visitors&limit=5`);
    res.json({ ok: true, results: r.body.results || [] });
  } catch { res.json({ ok: false, results: [] }); }
});

// GET /api/admin/analytics/events?period=30d
router.get('/api/admin/analytics/events', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const r = await plausibleFetch(`/api/v1/stats/breakdown?site_id=${PLAUSIBLE_SITE_ID}&period=${encodeURIComponent(period)}&property=event:name&metrics=visitors&limit=20`);
    // Filter out 'pageview' — only custom events
    const custom = (r.body.results || []).filter(e => e.name !== 'pageview');
    res.json({ ok: true, results: custom });
  } catch { res.json({ ok: false, results: [] }); }
});

// ── Admin: reviews moderation ─────────────────────────────────────────────

// GET /api/admin/reviews?status=pending|approved|rejected|hidden|all
router.get('/api/admin/reviews', requireAdmin, (req, res) => {
  const status = String(req.query.status || 'all').toLowerCase();
  const allowed = ['pending', 'approved', 'rejected', 'hidden'];
  let where = '';
  const params = [];
  if (allowed.includes(status)) { where = 'WHERE r.status = ?'; params.push(status); }
  const rows = db.prepare(`
    SELECT r.id, r.user_id, r.score, r.comment, r.display_name, r.status,
           r.created_at, r.moderated_at, r.moderated_by,
           u.email, u.country
    FROM ratings r
    JOIN users u ON u.id = r.user_id
    ${where}
    ORDER BY r.created_at DESC
    LIMIT 500
  `).all(...params);

  const counts = db.prepare(`
    SELECT status, COUNT(*) AS n FROM ratings GROUP BY status
  `).all().reduce((acc, row) => { acc[row.status] = row.n; return acc; }, {});

  res.json({ ok: true, reviews: rows, counts });
});

// PUT /api/admin/reviews/:id  { status: 'approved' | 'rejected' | 'hidden' | 'pending' }
router.put('/api/admin/reviews/:id', requireAdmin, (req, res) => {
  const newStatus = String(req.body?.status || '').toLowerCase();
  const allowed = ['pending', 'approved', 'rejected', 'hidden'];
  if (!allowed.includes(newStatus)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }
  const info = db.prepare(`
    UPDATE ratings
    SET status = ?, moderated_at = ?, moderated_by = ?
    WHERE id = ?
  `).run(newStatus, Date.now(), req.user.id, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'review not found' });
  try { logAudit(req, 'review.moderate', { targetType: 'rating', targetId: req.params.id, data: { status: newStatus } }); } catch {}
  res.json({ ok: true, status: newStatus });
});

// DELETE /api/admin/reviews/:id  (hard delete; gebruik liever status='hidden')
router.delete('/api/admin/reviews/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM ratings WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'review not found' });
  try { logAudit(req, 'review.delete', { targetType: 'rating', targetId: req.params.id }); } catch {}
  res.json({ ok: true });
});

router.get('/api/admin/blog', requireAdmin, (req, res) => {
  const posts = blog.listAll().map(({ body, ...rest }) => rest); // omit body for list view
  res.json({ ok: true, posts });
});

// Admin API: toggle draft state
router.put('/api/admin/blog/:filename/draft', requireAdmin, (req, res) => {
  try {
    const { draft } = req.body || {};
    blog.setDraft(req.params.filename, Boolean(draft));
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

  return router;
};
