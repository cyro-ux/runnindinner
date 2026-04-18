/**
 * Running Dinner Planner – Express server
 * Auth (JWT+bcrypt), Mollie payments, admin API, CMS, contact form
 */

'use strict';

require('dotenv').config();

const express      = require('express');
const cookieParser = require('cookie-parser');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const fs           = require('fs');
const os           = require('os');
const crypto       = require('crypto');
const bcrypt       = require('bcrypt');
const jwt          = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const Database     = require('better-sqlite3');
const nodemailer   = require('nodemailer');
const PDFDocument  = require('pdfkit');
const { createMollieClient } = require('@mollie/api-client');

// ── Active sessions (in-memory, resets on server restart) ────────────────────
// Map<userId, { email, loginAt, lastSeen }>
const activeSessions = new Map();

// ── Config ────────────────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT || '3001', 10);
const ENV         = process.env.NODE_ENV || 'development';
const IS_PROD     = ENV === 'production';
const BASE_URL    = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const JWT_SECRET  = process.env.JWT_SECRET || 'change_me_in_production_use_long_random_string';
const DB_PATH     = process.env.DB_PATH || './data/app.db';

const mollie = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY || 'test_placeholder' });

// ── Database ──────────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                 TEXT PRIMARY KEY,
    email              TEXT UNIQUE NOT NULL,
    password_hash      TEXT NOT NULL,
    role               TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
    user_type          TEXT NOT NULL DEFAULT 'paid',   -- 'paid' | 'manual' | 'test'
    created_at         INTEGER NOT NULL,
    last_login         INTEGER,
    license_until      INTEGER,
    mollie_customer_id TEXT
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payments (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL,
    mollie_payment_id   TEXT,
    amount_cents        INTEGER NOT NULL,
    currency            TEXT NOT NULL DEFAULT 'eur',
    status              TEXT NOT NULL,   -- 'paid' | 'pending' | 'failed'
    invoice_number      TEXT,
    created_at          INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cms (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deployments (
    id          TEXT PRIMARY KEY,
    deployed_by TEXT NOT NULL,
    env         TEXT NOT NULL,
    note        TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ratings (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    score       INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
    comment     TEXT,
    created_at  INTEGER NOT NULL
  );
`);

// Migrate existing DB: add columns if missing (SQLite has limited ALTER TABLE)
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('user_type'))       db.exec("ALTER TABLE users ADD COLUMN user_type TEXT NOT NULL DEFAULT 'paid'");
if (!userCols.includes('last_login'))      db.exec("ALTER TABLE users ADD COLUMN last_login INTEGER");
if (!userCols.includes('mollie_customer_id')) db.exec("ALTER TABLE users ADD COLUMN mollie_customer_id TEXT");
if (!userCols.includes('auto_renew'))         db.exec("ALTER TABLE users ADD COLUMN auto_renew INTEGER NOT NULL DEFAULT 0");
if (!userCols.includes('mollie_mandate_id'))  db.exec("ALTER TABLE users ADD COLUMN mollie_mandate_id TEXT");
if (!userCols.includes('renewal_reminder_sent')) db.exec("ALTER TABLE users ADD COLUMN renewal_reminder_sent INTEGER");
if (!userCols.includes('language'))              db.exec("ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'nl'");
const paymentCols = db.prepare("PRAGMA table_info(payments)").all().map(c => c.name);
if (!paymentCols.includes('mollie_payment_id')) db.exec("ALTER TABLE payments ADD COLUMN mollie_payment_id TEXT");
if (!paymentCols.includes('payment_type'))      db.exec("ALTER TABLE payments ADD COLUMN payment_type TEXT NOT NULL DEFAULT 'one-time'");

// Seed default settings
const setDefault = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);
setDefault.run('subscription_price_cents', String(process.env.SUBSCRIPTION_PRICE_CENTS || '500'));
setDefault.run('subscription_duration_days', '365');
setDefault.run('planning_counter', '0');
setDefault.run('participant_counter', '0');

// Seed default CMS content
const cmsDefault = db.prepare(
  'INSERT OR IGNORE INTO cms (key, value, updated_at) VALUES (?, ?, ?)'
);
const now = Date.now();
cmsDefault.run('hero_title', 'De makkelijkste manier om jouw Running Dinner te organiseren', now);
cmsDefault.run('hero_subtitle', 'Plan routes, wijs tafels toe en druk enveloppen af — in minuten klaar.', now);
cmsDefault.run('hero_cta', 'Nu starten voor €5/jaar', now);
cmsDefault.run('features_intro', 'Alles wat je nodig hebt voor een perfect Running Dinner evenement.', now);
cmsDefault.run('price_label', '€5 per jaar', now);
cmsDefault.run('footer_text', '© 2025 Running Dinner Planner. Alle rechten voorbehouden.', now);

// Seed admin account (once)
(async () => {
  const existing = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (!existing && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    db.prepare(`
      INSERT INTO users (id, email, password_hash, role, created_at)
      VALUES (?, ?, ?, 'admin', ?)
    `).run(uuidv4(), process.env.ADMIN_EMAIL, hash, Date.now());
    console.log(`[boot] Admin account aangemaakt: ${process.env.ADMIN_EMAIL}`);
  }
})();

// ── Mail transporter ──────────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendMail(to, subject, html, { replyTo } = {}) {
  if (!process.env.SMTP_HOST) {
    console.log(`[mail] SMTP not configured – would send to ${to}: ${subject}`);
    return;
  }
  // Strip HTML tags for plain-text alternative (improves deliverability)
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&bull;/g, '•').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();

  const mailOptions = {
    from: process.env.MAIL_FROM,
    to,
    subject,
    html: wrapHtml(html),
    text,
    headers: {
      'X-Mailer': 'Running Dinner Planner',
      'List-Unsubscribe': `<mailto:${process.env.MAIL_FROM_ADDRESS || 'noreply@runningdiner.nl'}?subject=unsubscribe>`,
    },
  };
  if (replyTo) mailOptions.replyTo = replyTo;
  await mailer.sendMail(mailOptions);
}

// Wrap HTML content in a proper email document structure
function wrapHtml(body) {
  return `<!DOCTYPE html>
<html lang="nl" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Running Dinner Planner</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7">
    <tr>
      <td align="center" style="padding:24px 16px">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;max-width:520px;width:100%">
          <tr>
            <td style="padding:32px 24px">
              ${body}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px;border-top:1px solid #e5e7eb;text-align:center">
              <p style="margin:0;color:#9ca3af;font-size:11px;line-height:16px">
                Running Dinner Planner &bull; runningdiner.nl<br>
                Je ontvangt deze e-mail omdat je een account hebt of bent uitgenodigd.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setCmsValue(key, value) {
  db.prepare(
    'INSERT INTO cms (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
  ).run(key, value, Date.now());
}

function invoiceNumber() {
  const d = new Date();
  const seq = db.prepare("SELECT COUNT(*) as c FROM payments WHERE status='paid'").get().c + 1;
  return `RD-${d.getFullYear()}-${String(seq).padStart(4, '0')}`;
}

function formatEur(cents) {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

async function sendInvoiceMail(user, payment) {
  const html = `
          <h2 style="color:#1a56db;margin:0 0 16px">Running Dinner Planner</h2>
          <p style="color:#374151;line-height:1.6">Hallo,</p>
          <p style="color:#374151;line-height:1.6">Bedankt voor je betaling! Je abonnement is actief t/m <strong>${new Date(user.license_until).toLocaleDateString('nl-NL')}</strong>.</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px">
            <tr style="background:#f3f4f6">
              <td style="padding:8px 12px;color:#374151">Factuurnummer</td>
              <td style="padding:8px 12px;color:#374151"><strong>${payment.invoice_number}</strong></td>
            </tr>
            <tr>
              <td style="padding:8px 12px;color:#374151">Omschrijving</td>
              <td style="padding:8px 12px;color:#374151">Running Dinner Planner - 1 jaar abonnement</td>
            </tr>
            <tr style="background:#f3f4f6">
              <td style="padding:8px 12px;color:#374151">Bedrag</td>
              <td style="padding:8px 12px;color:#374151"><strong>${formatEur(payment.amount_cents)}</strong></td>
            </tr>
            <tr>
              <td style="padding:8px 12px;color:#374151">Datum</td>
              <td style="padding:8px 12px;color:#374151">${new Date(payment.created_at).toLocaleDateString('nl-NL')}</td>
            </tr>
          </table>
          <p style="margin:24px 0;text-align:center">
            <a href="${BASE_URL}/app" style="background:#1a56db;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">Open de planner</a>
          </p>
  `;
  await sendMail(user.email, `Factuur ${payment.invoice_number} - Running Dinner Planner`, html);
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' })); // Mollie webhook sends urlencoded body
app.use(cookieParser());

// ── Language detection middleware ─────────────────────────────────────────────
function detectLanguage(req, res, next) {
  // 1. URL path: /en/ prefix = explicit choice
  if (req.path.startsWith('/en/') || req.path === '/en') {
    req.lang = 'en';
  // 2. Cookie: returning visitor
  } else if (req.cookies?.lang && ['nl', 'en'].includes(req.cookies.lang)) {
    req.lang = req.cookies.lang;
  // 3. Accept-Language header: first visit, browser setting
  } else {
    const accept = req.headers['accept-language'] || '';
    req.lang = accept.toLowerCase().startsWith('en') ? 'en' : 'nl';
  }
  // Set/update cookie if needed
  if (!req.cookies?.lang || req.cookies.lang !== req.lang) {
    res.cookie('lang', req.lang, { maxAge: 365 * 86400000, sameSite: 'lax' });
  }
  next();
}
app.use(detectLanguage);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://js.mollie.com"],
      scriptSrcAttr: ["'unsafe-inline'"],  // allow onclick handlers in admin panel
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameSrc: ["https://js.mollie.com"],
    },
  },
  crossOriginEmbedderPolicy: false, // allow fonts from Google
}));

// Rate limiting: auth endpoints (login, register, forgot-password)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // max 15 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Te veel pogingen. Probeer het over 15 minuten opnieuw.' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);

// Rate limiting: payment creation
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Te veel betalingsverzoeken. Probeer het later opnieuw.' },
});
app.use('/api/mollie/create-payment', paymentLimiter);

// Rate limiting: contact form
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Te veel berichten verstuurd. Probeer het later opnieuw.' },
});
app.use('/api/contact', contactLimiter);

// General API rate limit
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Te veel verzoeken. Probeer het later opnieuw.' },
});
app.use('/api/', apiLimiter);

// Serve static files
// The running dinner planner app lives at the repo root (index.html, app.js, style.css)
app.use('/app', express.static(path.join(__dirname)));
app.use('/en/app', express.static(path.join(__dirname)));  // English version serves same static files
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use('/en', express.static(path.join(__dirname, 'public'))); // English public files (CSS, images, lang/)
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers?.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Niet ingelogd' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    // Refresh lastSeen for active session tracking
    if (activeSessions.has(req.user.id)) {
      activeSessions.get(req.user.id).lastSeen = Date.now();
    } else {
      // Restore session if server restarted
      activeSessions.set(req.user.id, { email: req.user.email, loginAt: Date.now(), lastSeen: Date.now() });
    }
    next();
  } catch {
    res.clearCookie('token');
    res.status(401).json({ error: 'Sessie verlopen' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Geen toegang' });
    next();
  });
}

function requireLicense(req, res, next) {
  requireAuth(req, res, () => {
    const user = db.prepare('SELECT license_until, auto_renew FROM users WHERE id = ?').get(req.user.id);
    if (!user || !user.license_until || user.license_until < Date.now()) {
      // Grace period: 7 days extra access if auto-renew is on (payment may be processing)
      const gracePeriod = 7 * 86400000;
      if (user?.auto_renew && user.license_until && user.license_until + gracePeriod > Date.now()) {
        return next();
      }
      return res.status(402).json({ error: 'Geen actief abonnement', redirect: '/subscribe.html' });
    }
    next();
  });
}

// ── Auth routes ───────────────────────────────────────────────────────────────

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'E-mail en wachtwoord verplicht' });
  if (password.length < 8) return res.status(400).json({ error: 'Wachtwoord minimaal 8 tekens' });

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (exists) return res.status(409).json({ error: 'E-mailadres al in gebruik' });

  const hash = await bcrypt.hash(password, 12);
  const id   = uuidv4();
  const lang = req.lang || 'nl';
  db.prepare(
    'INSERT INTO users (id, email, password_hash, role, created_at, language) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, email.toLowerCase(), hash, 'user', Date.now(), lang);

  res.json({ ok: true, message: 'Account aangemaakt. Je kunt nu inloggen.' });
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
  if (!user) return res.status(401).json({ error: 'Onbekend e-mailadres of onjuist wachtwoord' });

  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Onbekend e-mailadres of onjuist wachtwoord' });

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
  if (user.language && ['nl', 'en'].includes(user.language)) {
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
});

// POST /api/auth/logout
app.post('/api/auth/logout', requireAuth, (req, res) => {
  activeSessions.delete(req.user.id);
  res.clearCookie('token');
  res.json({ ok: true });
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT email, role, license_until, language FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
  res.json({ ok: true, user });
});

// POST /api/auth/change-password
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Vul beide velden in' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Nieuw wachtwoord moet minimaal 8 tekens zijn' });

  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });

  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Huidig wachtwoord is onjuist' });

  const hash = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ ok: true, message: 'Wachtwoord gewijzigd' });
});

// PUT /api/user/auto-renew  – toggle automatic renewal
app.put('/api/user/auto-renew', requireAuth, (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Geef { enabled: true/false } mee' });

  const user = db.prepare('SELECT mollie_mandate_id, auto_renew FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });

  if (enabled && !user.mollie_mandate_id) {
    return res.status(400).json({
      error: 'Geen machtiging gevonden. Doe eerst een betaling met automatische verlenging ingeschakeld.',
      needsMandate: true,
    });
  }

  db.prepare('UPDATE users SET auto_renew = ? WHERE id = ?').run(enabled ? 1 : 0, req.user.id);
  res.json({ ok: true, auto_renew: enabled, message: enabled ? 'Automatische verlenging ingeschakeld' : 'Automatische verlenging uitgeschakeld' });
});

// DELETE /api/user/mandate  – revoke Mollie mandate
app.delete('/api/user/mandate', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT mollie_customer_id, mollie_mandate_id FROM users WHERE id = ?').get(req.user.id);
  if (!user || !user.mollie_mandate_id) return res.status(404).json({ error: 'Geen machtiging gevonden' });

  try {
    await mollie.customerMandates.revoke({ customerId: user.mollie_customer_id, id: user.mollie_mandate_id });
  } catch (err) {
    console.error('[mandate] revoke error:', err.message);
    // Continue anyway — mandate may already be revoked at Mollie
  }

  db.prepare('UPDATE users SET mollie_mandate_id = NULL, auto_renew = 0 WHERE id = ?').run(req.user.id);
  res.json({ ok: true, message: 'Machtiging ingetrokken en automatische verlenging uitgeschakeld' });
});

// POST /api/auth/forgot-password
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get((email || '').toLowerCase());

  // Always return OK to prevent email enumeration
  res.json({ ok: true, message: 'Als dit e-mailadres bekend is, ontvang je een link.' });

  if (!user) return;

  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 2 * 3600 * 1000; // 2 hours
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
  db.prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expiresAt);

  const link = `${BASE_URL}/reset-password.html?token=${token}`;
  await sendMail(user.email, 'Wachtwoord opnieuw instellen - Running Dinner Planner', `
          <h2 style="color:#1a56db;margin:0 0 16px">Running Dinner Planner</h2>
          <p style="color:#374151;line-height:1.6">Hallo,</p>
          <p style="color:#374151;line-height:1.6">Je hebt een wachtwoord-reset aangevraagd. Klik op onderstaande knop om een nieuw wachtwoord in te stellen. Deze link is 2 uur geldig.</p>
          <p style="margin:24px 0;text-align:center">
            <a href="${link}" style="background:#1a56db;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">
              Nieuw wachtwoord instellen
            </a>
          </p>
          <p style="color:#6b7280;font-size:13px;line-height:1.5">Werkt de knop niet? Kopieer dan deze link in je browser:<br><a href="${link}" style="color:#1a56db;word-break:break-all">${link}</a></p>
          <p style="color:#6b7280;font-size:13px;line-height:1.5">Heb jij dit niet aangevraagd? Dan kun je deze e-mail veilig negeren.</p>
  `);
});

// POST /api/auth/reset-password
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token en wachtwoord verplicht' });
  if (password.length < 8) return res.status(400).json({ error: 'Wachtwoord minimaal 8 tekens' });

  const row = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(token);
  if (!row || row.expires_at < Date.now()) return res.status(400).json({ error: 'Ongeldige of verlopen link' });

  const hash = await bcrypt.hash(password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
  db.prepare('DELETE FROM password_resets WHERE token = ?').run(token);

  res.json({ ok: true, message: 'Wachtwoord gewijzigd. Je kunt nu inloggen.' });
});

// ── Mollie / Payment routes ───────────────────────────────────────────────────

// POST /api/mollie/create-payment
app.post('/api/mollie/create-payment', requireAuth, async (req, res) => {
  const user       = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const priceCents = parseInt(getSetting('subscription_price_cents') || '500', 10);
  const amountValue = (priceCents / 100).toFixed(2); // Mollie expects string like "5.00"
  const autoRenew  = req.body?.autoRenew === true;

  try {
    const paymentOpts = {
      amount:      { currency: 'EUR', value: amountValue },
      description: 'Running Dinner Planner - 1 jaar abonnement',
      redirectUrl: `${BASE_URL}/payment-success.html`,
      webhookUrl:  `${BASE_URL}/api/mollie/webhook`,
      metadata:    { user_id: user.id, autoRenew },
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
    res.status(500).json({ error: 'Betaling kon niet worden gestart' });
  }
});

// GET /api/mollie/price  (public)
app.get('/api/mollie/price', (req, res) => {
  const cents = parseInt(getSetting('subscription_price_cents') || '500', 10);
  res.json({ cents, formatted: formatEur(cents) });
});

// POST /api/mollie/webhook  (called by Mollie, urlencoded body: id=tr_xxxxx)
app.post('/api/mollie/webhook', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).send('Missing id');

  try {
    const payment = await mollie.payments.get(id);
    const userId  = payment.metadata?.user_id;
    if (!userId) return res.send('ok');

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.send('ok');

    // Handle failed recurring payments
    if (payment.status === 'failed' && payment.sequenceType === 'recurring') {
      console.log(`[mollie] recurring payment failed for user ${userId}`);
      const failCount = db.prepare(
        "SELECT COUNT(*) as c FROM payments WHERE user_id = ? AND status = 'failed' AND payment_type = 'recurring' AND created_at > ?"
      ).get(userId, Date.now() - 30 * 86400000).c;

      if (failCount >= 2) {
        // 3rd failure (including this one) → disable auto-renewal
        db.prepare('UPDATE users SET auto_renew = 0 WHERE id = ?').run(userId);
        sendMail(user.email, 'Automatische verlenging uitgeschakeld - Running Dinner Planner', `
          <h2 style="color:#1a56db;margin:0 0 16px">Running Dinner Planner</h2>
          <p style="color:#374151;line-height:1.6">Hallo,</p>
          <p style="color:#374151;line-height:1.6">Je automatische verlenging is uitgeschakeld omdat de betaling meerdere keren niet gelukt is.</p>
          <p style="color:#374151;line-height:1.6">Je kunt je abonnement handmatig verlengen via onderstaande knop.</p>
          <p style="margin:24px 0;text-align:center">
            <a href="${BASE_URL}/subscribe.html" style="background:#1a56db;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">Abonnement verlengen</a>
          </p>
        `).catch(console.error);
      } else {
        sendMail(user.email, 'Automatische verlenging mislukt - Running Dinner Planner', `
          <h2 style="color:#1a56db;margin:0 0 16px">Running Dinner Planner</h2>
          <p style="color:#374151;line-height:1.6">Hallo,</p>
          <p style="color:#374151;line-height:1.6">De automatische verlenging van je abonnement is niet gelukt. We proberen het binnenkort opnieuw.</p>
          <p style="color:#374151;line-height:1.6">Wil je het zelf regelen? Verleng dan handmatig:</p>
          <p style="margin:24px 0;text-align:center">
            <a href="${BASE_URL}/subscribe.html" style="background:#1a56db;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">Handmatig verlengen</a>
          </p>
        `).catch(console.error);
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
  } catch (err) {
    console.error('[mollie] webhook error:', err.message);
  }

  res.send('ok');
});

// GET /api/payments/my  – current user's payment history
app.get('/api/payments/my', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT invoice_number, amount_cents, currency, status, created_at, mollie_payment_id FROM payments WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.user.id);
  res.json({ ok: true, payments: rows });
});

// GET /api/payments/invoice/:invoiceNumber  – download invoice as PDF
app.get('/api/payments/invoice/:invoiceNumber', requireAuth, (req, res) => {
  const payment = db.prepare(
    'SELECT p.*, u.email FROM payments p JOIN users u ON u.id = p.user_id WHERE p.invoice_number = ? AND p.user_id = ? AND p.status = ?'
  ).get(req.params.invoiceNumber, req.user.id, 'paid');

  if (!payment) return res.status(404).json({ error: 'Factuur niet gevonden' });

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
  doc.fontSize(10).fillColor(gray).text('runningdiner.nl', 50, 80);
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor(gray).text('VMH BV', 50, 100);
  doc.text('KvK: 88765432', 50, 115);

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
    .text('Vragen? Neem contact op via het contactformulier op runningdiner.nl', 50, 765, { align: 'center', width: 495 });

  doc.end();
});

// GET /api/user/profile  – user profile data
app.get('/api/user/profile', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, role, user_type, created_at, last_login, license_until, auto_renew, mollie_mandate_id FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
  const payments = db.prepare(
    "SELECT invoice_number, amount_cents, currency, status, created_at FROM payments WHERE user_id = ? AND status = 'paid' ORDER BY created_at DESC"
  ).all(req.user.id);
  res.json({ ok: true, user, payments });
});

// ── CMS routes ────────────────────────────────────────────────────────────────

// GET /api/cms  (public)
app.get('/api/cms', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM cms').all();
  const cms  = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.json({ ok: true, cms });
});

// PUT /api/cms  (admin only)
app.put('/api/cms', requireAdmin, (req, res) => {
  const data = req.body || {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') setCmsValue(key, value);
  }
  res.json({ ok: true });
});

// POST /api/cms/photo  (admin only) – expects { key: string, dataUrl: string }
app.post('/api/cms/photo', requireAdmin, (req, res) => {
  const { key, dataUrl } = req.body || {};
  if (!key || !dataUrl) return res.status(400).json({ error: 'key en dataUrl verplicht' });
  // Store as data URL in CMS (simple approach; swap for file upload in production)
  setCmsValue(key, dataUrl);
  res.json({ ok: true });
});

// ── Admin routes ──────────────────────────────────────────────────────────────

// GET /api/admin/stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
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

// GET /api/admin/users  – with payment count and member duration
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.email, u.role, u.user_type, u.created_at, u.last_login, u.license_until,
           u.auto_renew, u.mollie_mandate_id,
           COUNT(p.id) as payment_count
    FROM users u
    LEFT JOIN payments p ON p.user_id = u.id AND p.status = 'paid'
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();
  res.json({ ok: true, users });
});

// POST /api/admin/users  – manually create user (optionally send invite)
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { email, password, user_type = 'manual', license_days, send_invite } = req.body || {};
  if (!email) return res.status(400).json({ error: 'E-mailadres is verplicht' });

  // If send_invite, password is optional (generate random one)
  const actualPassword = send_invite ? (password || crypto.randomBytes(16).toString('hex')) : password;
  if (!actualPassword) return res.status(400).json({ error: 'Wachtwoord verplicht (of kies uitnodigingslink)' });
  if (!send_invite && actualPassword.length < 8) return res.status(400).json({ error: 'Wachtwoord minimaal 8 tekens' });

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (exists) return res.status(409).json({ error: 'E-mailadres al in gebruik' });

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
      const html = `
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
      await sendMail(email.toLowerCase(), 'Uitnodiging Running Dinner Planner', html);
      inviteSent = true;
    } catch (err) {
      console.error('[invite] mail error:', err.message);
    }
  }

  const msg = inviteSent
    ? `Gebruiker aangemaakt en uitnodiging verstuurd naar ${email}`
    : send_invite
      ? 'Gebruiker aangemaakt, maar uitnodigingsmail kon niet verstuurd worden'
      : 'Gebruiker aangemaakt.';

  res.json({ ok: true, message: msg, user_id: id });
});

// PUT /api/admin/users/:id  – edit user (license, type, email)
app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const { email, user_type, license_days, license_until, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
  if (user.role === 'admin' && req.user.id !== user.id) return res.status(403).json({ error: 'Kan andere admin niet bewerken' });

  // Update email if changed
  if (email && email.toLowerCase() !== user.email) {
    const exists = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email.toLowerCase(), user.id);
    if (exists) return res.status(409).json({ error: 'E-mailadres al in gebruik' });
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
  res.json({ ok: true, message: 'Gebruiker bijgewerkt', user: updated });
});

// POST /api/admin/users/:id/invite  – send invitation email with password-set link
app.post('/api/admin/users/:id/invite', requireAdmin, async (req, res) => {
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });

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
    res.json({ ok: true, message: `Uitnodiging verstuurd naar ${user.email}` });
  } catch (err) {
    console.error('[invite] mail error:', err.message);
    res.status(500).json({ error: 'E-mail kon niet worden verstuurd' });
  }
});

// DELETE /api/admin/users/:id
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  activeSessions.delete(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ? AND role != ?').run(req.params.id, 'admin');
  res.json({ ok: true });
});

// GET /api/admin/orders  – all payments with user info
app.get('/api/admin/orders', requireAdmin, (req, res) => {
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
app.get('/api/admin/active-sessions', requireAdmin, (req, res) => {
  const cutoff  = Date.now() - 30 * 60 * 1000;
  const sessions = [...activeSessions.entries()]
    .filter(([, s]) => s.lastSeen > cutoff)
    .map(([userId, s]) => ({ userId, email: s.email, loginAt: s.loginAt, lastSeen: s.lastSeen }));
  res.json({ ok: true, sessions });
});

// PUT /api/admin/settings
app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const { subscription_price_cents, subscription_duration_days } = req.body || {};
  if (subscription_price_cents !== undefined) {
    const cents = parseInt(subscription_price_cents, 10);
    if (isNaN(cents) || cents < 100) return res.status(400).json({ error: 'Minimale prijs €1,00' });
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('subscription_price_cents', String(cents));
  }
  if (subscription_duration_days !== undefined) {
    const days = parseInt(subscription_duration_days, 10);
    if (isNaN(days) || days < 1) return res.status(400).json({ error: 'Ongeldige duur' });
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('subscription_duration_days', String(days));
  }
  res.json({ ok: true });
});

// GET /api/admin/deployments
app.get('/api/admin/deployments', requireAdmin, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM deployments ORDER BY created_at DESC LIMIT 20'
  ).all();
  res.json({ ok: true, deployments: rows });
});

// POST /api/admin/deploy
// Logs a deployment record. Actual deployment is via PM2/shell on the server.
app.post('/api/admin/deploy', requireAdmin, (req, res) => {
  const { env = 'production', note = '' } = req.body || {};
  const validEnvs = ['production', 'staging'];
  if (!validEnvs.includes(env)) return res.status(400).json({ error: 'Ongeldige omgeving' });

  const id = uuidv4();
  db.prepare(
    'INSERT INTO deployments (id, deployed_by, env, note, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, req.user.email, env, note, Date.now());

  // In a real setup: trigger a shell script here, e.g. via child_process.exec('pm2 reload app')
  // For now just log the deployment intent.
  console.log(`[deploy] ${env} deployment triggered by ${req.user.email}: ${note}`);

  res.json({ ok: true, message: `Deployment naar ${env} geregistreerd.` });
});

// ── Planning counter ──────────────────────────────────────────────────────────

// GET /api/planning-count  (public – for website counter widget)
app.get('/api/planning-count', (req, res) => {
  const count = parseInt(getSetting('planning_counter') || '0', 10);
  res.json({ ok: true, count });
});

// POST /api/planning-count/increment  (requires license – called from planner app)
app.post('/api/planning-count/increment', requireAuth, (req, res) => {
  const current = parseInt(getSetting('planning_counter') || '0', 10);
  db.prepare("INSERT INTO settings (key, value) VALUES ('planning_counter', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(current + 1));

  // Also track participant count if provided
  const { participantCount } = req.body || {};
  if (participantCount && parseInt(participantCount, 10) > 0) {
    const currentParticipants = parseInt(getSetting('participant_counter') || '0', 10);
    db.prepare("INSERT INTO settings (key, value) VALUES ('participant_counter', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(String(currentParticipants + parseInt(participantCount, 10)));
  }

  res.json({ ok: true, count: current + 1 });
});

// PUT /api/admin/planning-count  (admin – set manually)
app.put('/api/admin/planning-count', requireAdmin, (req, res) => {
  const { count } = req.body || {};
  const n = parseInt(count, 10);
  if (isNaN(n) || n < 0) return res.status(400).json({ error: 'Ongeldig getal' });
  db.prepare("INSERT INTO settings (key, value) VALUES ('planning_counter', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(n));
  res.json({ ok: true, count: n });
});

// ── Public stats (for homepage) ──────────────────────────────────────────────

// GET /api/public/stats  (no auth – cached data for homepage social proof bar)
app.get('/api/public/stats', (req, res) => {
  const dinners   = parseInt(getSetting('planning_counter') || '0', 10);
  const participants = parseInt(getSetting('participant_counter') || '0', 10);

  const ratingRow = db.prepare(
    "SELECT COALESCE(AVG(score), 0) as avg, COUNT(*) as cnt FROM ratings"
  ).get();

  const avgRating  = ratingRow.cnt > 0 ? Math.round(ratingRow.avg * 10) / 10 : 0;
  const ratingCount = ratingRow.cnt;

  res.json({
    ok: true,
    dinners,
    participants,
    avgRating,
    ratingCount,
  });
});

// ── Ratings ──────────────────────────────────────────────────────────────────

// POST /api/ratings  (authenticated – submit a rating)
app.post('/api/ratings', requireAuth, (req, res) => {
  const { score, comment } = req.body || {};
  const s = parseInt(score, 10);
  if (!s || s < 1 || s > 5) return res.status(400).json({ error: 'Score moet 1-5 zijn' });

  // Check if user already rated (allow max 1 per user to keep it fair)
  const existing = db.prepare('SELECT id FROM ratings WHERE user_id = ?').get(req.user.id);
  if (existing) {
    // Update existing rating
    db.prepare('UPDATE ratings SET score = ?, comment = ?, created_at = ? WHERE user_id = ?')
      .run(s, comment || null, Date.now(), req.user.id);
    return res.json({ ok: true, message: 'Beoordeling bijgewerkt', updated: true });
  }

  const id = uuidv4();
  db.prepare('INSERT INTO ratings (id, user_id, score, comment, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, s, comment || null, Date.now());

  res.json({ ok: true, message: 'Bedankt voor je beoordeling!' });
});

// GET /api/ratings/mine  (authenticated – get own rating)
app.get('/api/ratings/mine', requireAuth, (req, res) => {
  const rating = db.prepare('SELECT score, comment, created_at FROM ratings WHERE user_id = ?').get(req.user.id);
  res.json({ ok: true, rating: rating || null });
});

// ── Contact form ──────────────────────────────────────────────────────────────

// POST /api/contact
app.post('/api/contact', async (req, res) => {
  const { name, email, message } = req.body || {};
  if (!name || !email || !message) return res.status(400).json({ error: 'Alle velden zijn verplicht' });

  const contactEmail = process.env.CONTACT_EMAIL || 'cyro@vanmalsen.net';
  const safeName = escHtml(name);
  const safeEmail = escHtml(email);
  const safeMessage = escHtml(message).replace(/\n/g, '<br>');
  const html = `
          <h2 style="color:#1a56db;margin:0 0 16px">Nieuw contactbericht</h2>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
            <tr style="background:#f3f4f6">
              <td style="padding:8px 12px;color:#374151;font-weight:bold;width:80px">Naam</td>
              <td style="padding:8px 12px;color:#374151">${safeName}</td>
            </tr>
            <tr>
              <td style="padding:8px 12px;color:#374151;font-weight:bold">E-mail</td>
              <td style="padding:8px 12px;color:#374151"><a href="mailto:${safeEmail}" style="color:#1a56db">${safeEmail}</a></td>
            </tr>
          </table>
          <p style="color:#374151;font-weight:bold;margin:16px 0 8px">Bericht:</p>
          <div style="border-left:3px solid #1a56db;padding:12px 16px;margin:0;background:#f9fafb;color:#374151;line-height:1.6">${safeMessage}</div>
  `;

  try {
    await sendMail(contactEmail, `Contactformulier: ${name} - Running Dinner Planner`, html, { replyTo: email });
    res.json({ ok: true, message: 'Je bericht is verzonden!' });
  } catch (err) {
    console.error('[contact] mail error:', err.message);
    res.status(500).json({ error: 'Bericht kon niet worden verzonden. Probeer het later opnieuw.' });
  }
});

// ── App access check ──────────────────────────────────────────────────────────

// GET /api/app/access  – check if user may use the planner
app.get('/api/app/access', requireAuth, (req, res) => {
  const user = db.prepare('SELECT license_until, role, auto_renew FROM users WHERE id = ?').get(req.user.id);
  const now = Date.now();
  const gracePeriod = 7 * 86400000;
  const licenseActive = user?.license_until && user.license_until > now;
  const graceActive   = user?.auto_renew && user?.license_until && user.license_until + gracePeriod > now;
  const hasAccess = user && (user.role === 'admin' || licenseActive || graceActive);
  res.json({
    ok: true,
    access: hasAccess,
    license_until: user?.license_until || null,
    auto_renew: !!user?.auto_renew,
  });
});

// ── Language preference API ──────────────────────────────────────────────────
app.put('/api/user/language', requireAuth, (req, res) => {
  const { language } = req.body || {};
  if (!language || !['nl', 'en'].includes(language)) {
    return res.status(400).json({ error: 'Ongeldige taal. Kies "nl" of "en".' });
  }
  db.prepare('UPDATE users SET language = ? WHERE id = ?').run(language, req.user.id);
  res.cookie('lang', language, { maxAge: 365 * 86400000, sameSite: 'lax' });
  res.json({ ok: true, language });
});

// ── English route handling (/en/*) ──────────────────────────────────────────
// Serve the same HTML files for /en/ paths — language is applied client-side via i18n.js
app.get('/en/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/en', (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/en/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/en/:page.html', (req, res) => {
  const file = path.join(__dirname, 'public', `${req.params.page}.html`);
  if (fs.existsSync(file)) {
    res.sendFile(file);
  } else {
    res.status(404).sendFile(path.join(__dirname, 'public', 'home.html'));
  }
});

// ── SPA fallbacks ─────────────────────────────────────────────────────────────
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));

// ── Auto-renewal scheduler ────────────────────────────────────────────────────

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
    SELECT id, email, license_until
    FROM users
    WHERE auto_renew = 1
      AND license_until BETWEEN ? AND ?
      AND (renewal_reminder_sent IS NULL OR renewal_reminder_sent < ?)
  `).all(now, reminderWindow, reminderCooldown);

  const priceCents = parseInt(getSetting('subscription_price_cents') || '500', 10);

  for (const user of users) {
    const renewDate = new Date(user.license_until).toLocaleDateString('nl-NL', {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    try {
      await sendMail(user.email, 'Je abonnement wordt binnenkort verlengd - Running Dinner Planner', `
        <h2 style="color:#1a56db;margin:0 0 16px">Running Dinner Planner</h2>
        <p style="color:#374151;line-height:1.6">Hallo,</p>
        <p style="color:#374151;line-height:1.6">Je abonnement wordt automatisch verlengd op <strong>${renewDate}</strong> voor <strong>${formatEur(priceCents)}</strong>.</p>
        <p style="color:#374151;line-height:1.6">Je hoeft niets te doen. Wil je de automatische verlenging uitschakelen? Dat kan in je profiel.</p>
        <p style="margin:24px 0;text-align:center">
          <a href="${BASE_URL}/profile.html" style="background:#1a56db;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">Naar mijn profiel</a>
        </p>
        <p style="color:#6b7280;font-size:13px;line-height:1.5">Je ontvangt na verlenging automatisch een factuur per e-mail.</p>
      `);
      db.prepare('UPDATE users SET renewal_reminder_sent = ? WHERE id = ?').run(now, user.id);
      console.log(`[scheduler] renewal reminder sent to ${user.email}`);
    } catch (err) {
      console.error(`[scheduler] reminder mail failed for ${user.email}:`, err.message);
    }
  }
}

// Run scheduler every hour (only in production to avoid double runs during dev)
if (ENV === 'production') {
  const SCHEDULER_INTERVAL = 60 * 60 * 1000; // 1 hour
  setInterval(async () => {
    try { await checkRenewalReminders(); } catch (e) { console.error('[scheduler] reminder error:', e.message); }
    try { await processAutoRenewals(); } catch (e) { console.error('[scheduler] renewal error:', e.message); }
  }, SCHEDULER_INTERVAL);
  // Also run once 30 seconds after startup
  setTimeout(async () => {
    try { await checkRenewalReminders(); } catch (e) { console.error('[scheduler] reminder error:', e.message); }
    try { await processAutoRenewals(); } catch (e) { console.error('[scheduler] renewal error:', e.message); }
  }, 30000);
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[${ENV}] Running Dinner Planner server draait op http://localhost:${PORT}`);
});
