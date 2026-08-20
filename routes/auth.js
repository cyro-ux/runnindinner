/**
 * Auth- en accountroutes: registreren, in-/uitloggen, wachtwoordbeheer,
 * auto-verlenging en incassomachtiging.
 *
 * Factory met dependency-injection; alle async handlers zitten in
 * asyncHandler zodat een rejectie bij de centrale error-handler belandt
 * in plaats van de request te laten hangen (Express 4).
 */
'use strict';

const express = require('express');
const { asyncHandler } = require('../lib/async-handler');

module.exports = function authRoutes(deps) {
  const {
    db, t, bcrypt, jwt, JWT_SECRET, crypto, uuidv4, sendMail, wrapHtml,
    BASE_URL, mollie, activeSessions, requireAuth, generateReferralCode,
    IS_PROD, SUPPORTED_LANGS,
  } = deps;
  const router = express.Router();

// POST /api/auth/register
router.post('/api/auth/register', asyncHandler(async (req, res) => {
  const { email, password, referralCode, isBusiness, companyName, vatId } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: t(req, 'email_pw_required') });
  if (password.length < 8) return res.status(400).json({ error: t(req, 'pw_min_8') });

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (exists) return res.status(409).json({ error: t(req, 'email_in_use') });

  // Validate referral code if provided
  let referredBy = null;
  if (referralCode) {
    const refUser = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(String(referralCode).trim());
    if (refUser) referredBy = refUser.id;
  }

  // B2B/B2C indication — set at registration so we know which legal regime
  // applies (consumer = right-of-withdrawal exception; business = NL Digital).
  const isBiz = isBusiness === true || isBusiness === 'true' || isBusiness === 1;
  const cleanCompany = isBiz && companyName ? String(companyName).trim().slice(0, 200) : null;
  const cleanVat     = isBiz && vatId       ? String(vatId).trim().toUpperCase().slice(0, 32) : null;

  const hash = await bcrypt.hash(password, 12);
  const id   = uuidv4();
  const lang = req.lang || 'nl';
  const code = generateReferralCode();
  db.prepare(
    `INSERT INTO users
       (id, email, password_hash, role, created_at, language, referral_code, referred_by,
        is_business, company_name, vat_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, email.toLowerCase(), hash, 'user', Date.now(), lang, code, referredBy,
    isBiz ? 1 : 0, cleanCompany, cleanVat,
  );

  res.json({ ok: true, message: t(req, 'account_created') });
}));

// POST /api/auth/login
router.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
  if (!user) return res.status(401).json({ error: t(req, 'bad_credentials') });

  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) return res.status(401).json({ error: t(req, 'bad_credentials') });

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  res.cookie('token', token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    maxAge: 30 * 24 * 3600 * 1000,
  });

  // Set language cookie from user preference
  if (user.language && SUPPORTED_LANGS.includes(user.language)) {
    res.cookie('lang', user.language, { maxAge: 365 * 86400000, sameSite: 'lax' });
  }

  // Track active session + last login
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), user.id);
  activeSessions.set(user.id, { email: user.email, loginAt: Date.now(), lastSeen: Date.now() });

  res.json({
    ok: true,
    user: {
      email: user.email,
      role:  user.role,
      license_until: user.license_until,
    },
  });
}));

// POST /api/auth/logout
router.post('/api/auth/logout', requireAuth, (req, res) => {
  activeSessions.delete(req.user.id);
  res.clearCookie('token');
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.prepare(
    'SELECT email, role, license_until, language, is_business, company_name, vat_id FROM users WHERE id = ?'
  ).get(req.user.id);
  if (!user) return res.status(404).json({ error: t(req, 'user_not_found') });
  // Normalise is_business to boolean for easy client-side use
  user.is_business = !!user.is_business;
  res.json({ ok: true, user });
});

// POST /api/auth/change-password
router.post('/api/auth/change-password', requireAuth, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: t(req, 'fill_both_fields') });
  if (newPassword.length < 8) return res.status(400).json({ error: t(req, 'new_pw_min_8') });

  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: t(req, 'user_not_found') });

  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) return res.status(401).json({ error: t(req, 'current_pw_wrong') });

  const hash = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ ok: true, message: t(req, 'pw_changed') });
}));

// PUT /api/user/auto-renew  – toggle automatic renewal
router.put('/api/user/auto-renew', requireAuth, (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: t(req, 'give_enabled') });

  const user = db.prepare('SELECT mollie_mandate_id, auto_renew FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: t(req, 'user_not_found') });

  if (enabled && !user.mollie_mandate_id) {
    return res.status(400).json({
      error: t(req, 'no_mandate_needs'),
      needsMandate: true,
    });
  }

  db.prepare('UPDATE users SET auto_renew = ? WHERE id = ?').run(enabled ? 1 : 0, req.user.id);
  res.json({ ok: true, auto_renew: enabled, message: enabled ? t(req, 'auto_renew_on') : t(req, 'auto_renew_off') });
});

// DELETE /api/user/mandate  – revoke Mollie mandate
router.delete('/api/user/mandate', requireAuth, asyncHandler(async (req, res) => {
  const user = db.prepare('SELECT mollie_customer_id, mollie_mandate_id FROM users WHERE id = ?').get(req.user.id);
  if (!user || !user.mollie_mandate_id) return res.status(404).json({ error: t(req, 'no_mandate_found') });

  try {
    await mollie.customerMandates.revoke({ customerId: user.mollie_customer_id, id: user.mollie_mandate_id });
  } catch (err) {
    console.error('[mandate] revoke error:', err.message);
    // Continue anyway — mandate may already be revoked at Mollie
  }

  db.prepare('UPDATE users SET mollie_mandate_id = NULL, auto_renew = 0 WHERE id = ?').run(req.user.id);
  res.json({ ok: true, message: t(req, 'mandate_revoked') });
}));

// POST /api/auth/forgot-password
router.post('/api/auth/forgot-password', asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get((email || '').toLowerCase());

  // Always return OK to prevent email enumeration
  res.json({ ok: true, message: t(req, 'reset_email_sent') });

  if (!user) return;

  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 2 * 3600 * 1000; // 2 hours
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
  db.prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expiresAt);

  const link = `${BASE_URL}/reset-password.html?token=${token}`;
  // Use stored user language if available, otherwise request language
  const userFull = db.prepare('SELECT language FROM users WHERE id = ?').get(user.id);
  const lang = userFull?.language || req.lang || 'nl';
  const isEN = lang === 'en';

  await sendMail(user.email,
    isEN ? 'Reset your password - Running Dinner Planner' : 'Wachtwoord opnieuw instellen - Running Dinner Planner',
    wrapHtml(`
          <h2 style="color:#1a56db;margin:0 0 16px">Running Dinner Planner</h2>
          <p style="color:#374151;line-height:1.6">${isEN ? 'Hi,' : 'Hallo,'}</p>
          <p style="color:#374151;line-height:1.6">${isEN
            ? 'You have requested a password reset. Click the button below to set a new password. This link is valid for 2 hours.'
            : 'Je hebt een wachtwoord-reset aangevraagd. Klik op onderstaande knop om een nieuw wachtwoord in te stellen. Deze link is 2 uur geldig.'
          }</p>
          <p style="margin:24px 0;text-align:center">
            <a href="${link}" style="background:#1a56db;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">
              ${isEN ? 'Set new password' : 'Nieuw wachtwoord instellen'}
            </a>
          </p>
          <p style="color:#6b7280;font-size:13px;line-height:1.5">${isEN
            ? `Button not working? Copy this link into your browser:<br><a href="${link}" style="color:#1a56db;word-break:break-all">${link}</a>`
            : `Werkt de knop niet? Kopieer dan deze link in je browser:<br><a href="${link}" style="color:#1a56db;word-break:break-all">${link}</a>`
          }</p>
          <p style="color:#6b7280;font-size:13px;line-height:1.5">${isEN
            ? 'Didn\'t request this? You can safely ignore this email.'
            : 'Heb jij dit niet aangevraagd? Dan kun je deze e-mail veilig negeren.'
          }</p>
    `, lang));
}));

// POST /api/auth/reset-password
router.post('/api/auth/reset-password', asyncHandler(async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: t(req, 'token_pw_required') });
  if (password.length < 8) return res.status(400).json({ error: t(req, 'pw_min_8') });

  const row = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(token);
  if (!row || row.expires_at < Date.now()) return res.status(400).json({ error: t(req, 'invalid_reset_link') });

  const hash = await bcrypt.hash(password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
  db.prepare('DELETE FROM password_resets WHERE token = ?').run(token);

  res.json({ ok: true, message: t(req, 'pw_changed_login') });
}));

  return router;
};
