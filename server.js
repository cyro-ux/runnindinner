/**
 * Running Dinner Planner – Express server
 * Auth (JWT+bcrypt), Mollie payments, admin API, CMS, contact form
 */

'use strict';

require('dotenv').config();

const express      = require('express');
const cookieParser = require('cookie-parser');
const path         = require('path');
const fs           = require('fs');
const os           = require('os');
const crypto       = require('crypto');
const bcrypt       = require('bcrypt');
const jwt          = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const Database     = require('better-sqlite3');
const nodemailer   = require('nodemailer');
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
`);

// Migrate existing DB: add columns if missing (SQLite has limited ALTER TABLE)
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('user_type'))       db.exec("ALTER TABLE users ADD COLUMN user_type TEXT NOT NULL DEFAULT 'paid'");
if (!userCols.includes('last_login'))      db.exec("ALTER TABLE users ADD COLUMN last_login INTEGER");
if (!userCols.includes('mollie_customer_id')) db.exec("ALTER TABLE users ADD COLUMN mollie_customer_id TEXT");
const paymentCols = db.prepare("PRAGMA table_info(payments)").all().map(c => c.name);
if (!paymentCols.includes('mollie_payment_id')) db.exec("ALTER TABLE payments ADD COLUMN mollie_payment_id TEXT");

// Seed default settings
const setDefault = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);
setDefault.run('subscription_price_cents', String(process.env.SUBSCRIPTION_PRICE_CENTS || '500'));
setDefault.run('subscription_duration_days', '365');
setDefault.run('planning_counter', '0');

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

async function sendMail(to, subject, html) {
  if (!process.env.SMTP_HOST) {
    console.log(`[mail] SMTP not configured – would send to ${to}: ${subject}`);
    return;
  }
  await mailer.sendMail({ from: process.env.MAIL_FROM, to, subject, html });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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
    <div style="font-family:sans-serif;max-width:520px;margin:auto">
      <h2 style="color:#1a56db">Running Dinner Planner</h2>
      <p>Hallo,</p>
      <p>Bedankt voor je betaling! Je abonnement is actief t/m <strong>${new Date(user.license_until).toLocaleDateString('nl-NL')}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;margin:20px 0">
        <tr style="background:#f3f4f6">
          <td style="padding:8px 12px">Factuurnummer</td>
          <td style="padding:8px 12px"><strong>${payment.invoice_number}</strong></td>
        </tr>
        <tr>
          <td style="padding:8px 12px">Omschrijving</td>
          <td style="padding:8px 12px">Running Dinner Planner – 1 jaar abonnement</td>
        </tr>
        <tr style="background:#f3f4f6">
          <td style="padding:8px 12px">Bedrag</td>
          <td style="padding:8px 12px"><strong>${formatEur(payment.amount_cents)}</strong></td>
        </tr>
        <tr>
          <td style="padding:8px 12px">Datum</td>
          <td style="padding:8px 12px">${new Date(payment.created_at).toLocaleDateString('nl-NL')}</td>
        </tr>
      </table>
      <p><a href="${BASE_URL}/app" style="background:#1a56db;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open de planner</a></p>
      <p style="color:#6b7280;font-size:12px">Running Dinner Planner &bull; ${BASE_URL}</p>
    </div>
  `;
  await sendMail(user.email, `Factuur ${payment.invoice_number} – Running Dinner Planner`, html);
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Mollie webhook sends urlencoded body
app.use(cookieParser());

// Serve static files
// The running dinner planner app lives at the repo root (index.html, app.js, style.css)
app.use('/app', express.static(path.join(__dirname)));
app.use('/admin', express.static(path.join(__dirname, 'admin')));
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
    const user = db.prepare('SELECT license_until FROM users WHERE id = ?').get(req.user.id);
    if (!user || !user.license_until || user.license_until < Date.now()) {
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
  db.prepare(
    'INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, email.toLowerCase(), hash, 'user', Date.now());

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
  const user = db.prepare('SELECT email, role, license_until FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
  res.json({ ok: true, user });
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
  await sendMail(user.email, 'Wachtwoord opnieuw instellen – Running Dinner Planner', `
    <p>Je hebt een wachtwoord-reset aangevraagd. Klik op de onderstaande link (geldig 2 uur):</p>
    <p><a href="${link}">${link}</a></p>
    <p>Heb jij dit niet aangevraagd? Negeer dan deze mail.</p>
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

  try {
    const payment = await mollie.payments.create({
      amount:      { currency: 'EUR', value: amountValue },
      description: 'Running Dinner Planner – 1 jaar abonnement',
      redirectUrl: `${BASE_URL}/payment-success.html`,
      webhookUrl:  `${BASE_URL}/api/mollie/webhook`,
      metadata:    { user_id: user.id },
      // No 'method' specified → Mollie shows all payment methods enabled in dashboard
    });

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
    // Verify payment status by fetching from Mollie (no signature needed)
    const payment = await mollie.payments.get(id);

    if (payment.status !== 'paid') return res.send('ok');

    const userId = payment.metadata?.user_id;
    if (!userId) return res.send('ok');

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.send('ok');

    // Idempotency: skip if already recorded
    const existing = db.prepare('SELECT id FROM payments WHERE mollie_payment_id = ?').get(payment.id);
    if (existing) return res.send('ok');

    const days         = parseInt(getSetting('subscription_duration_days') || '365', 10);
    const now          = Date.now();
    const licenseUntil = (user.license_until && user.license_until > now)
      ? user.license_until + days * 86400000   // extend existing subscription
      : now + days * 86400000;

    db.prepare('UPDATE users SET license_until = ? WHERE id = ?').run(licenseUntil, userId);

    const priceCents = Math.round(parseFloat(payment.amount.value) * 100);
    const invNr      = invoiceNumber();
    const payId      = uuidv4();
    db.prepare(`
      INSERT INTO payments (id, user_id, mollie_payment_id, amount_cents, currency, status, invoice_number, created_at)
      VALUES (?, ?, ?, ?, ?, 'paid', ?, ?)
    `).run(payId, userId, payment.id, priceCents, payment.amount.currency.toLowerCase(), invNr, now);

    const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    sendInvoiceMail(updatedUser, { invoice_number: invNr, amount_cents: priceCents, created_at: now }).catch(console.error);
  } catch (err) {
    console.error('[mollie] webhook error:', err.message);
  }

  res.send('ok'); // Always respond 200 so Mollie doesn't retry unnecessarily
});

// GET /api/payments/my  – current user's payment history
app.get('/api/payments/my', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT invoice_number, amount_cents, currency, status, created_at, mollie_payment_id FROM payments WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.user.id);
  res.json({ ok: true, payments: rows });
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

  res.json({ ok: true, stats: {
    totalUsers, activeUsers, expiredUsers,
    paidUsers, manualUsers, testUsers,
    totalRevenue, revenueMonth, priceCents,
    activeSessions: activeSesCount,
    serverLoad: loadPct,
    memoryUsed: memPct,
    planningCount,
  }});
});

// GET /api/admin/users  – with payment count and member duration
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.email, u.role, u.user_type, u.created_at, u.last_login, u.license_until,
           COUNT(p.id) as payment_count
    FROM users u
    LEFT JOIN payments p ON p.user_id = u.id AND p.status = 'paid'
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();
  res.json({ ok: true, users });
});

// POST /api/admin/users  – manually create user
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { email, password, user_type = 'manual', license_days } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'E-mail en wachtwoord verplicht' });
  if (password.length < 8) return res.status(400).json({ error: 'Wachtwoord minimaal 8 tekens' });
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (exists) return res.status(409).json({ error: 'E-mailadres al in gebruik' });

  const hash         = await bcrypt.hash(password, 12);
  const id           = uuidv4();
  const licenseUntil = license_days ? Date.now() + parseInt(license_days, 10) * 86400000 : null;

  db.prepare(`
    INSERT INTO users (id, email, password_hash, role, user_type, created_at, license_until)
    VALUES (?, ?, ?, 'user', ?, ?, ?)
  `).run(id, email.toLowerCase(), hash, user_type, Date.now(), licenseUntil);

  res.json({ ok: true, message: 'Gebruiker aangemaakt.' });
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

// ── Contact form ──────────────────────────────────────────────────────────────

// POST /api/contact
app.post('/api/contact', async (req, res) => {
  const { name, email, message } = req.body || {};
  if (!name || !email || !message) return res.status(400).json({ error: 'Alle velden zijn verplicht' });

  const contactEmail = process.env.CONTACT_EMAIL || 'cyro@vanmalsen.net';
  const html = `
    <h3>Nieuw contactbericht via Running Dinner Planner</h3>
    <p><strong>Naam:</strong> ${name}</p>
    <p><strong>E-mail:</strong> ${email}</p>
    <p><strong>Bericht:</strong></p>
    <blockquote style="border-left:3px solid #ccc;padding-left:12px;margin:8px 0">${message.replace(/\n/g, '<br>')}</blockquote>
  `;

  try {
    await sendMail(contactEmail, `Contactformulier: ${name}`, html);
    res.json({ ok: true, message: 'Je bericht is verzonden!' });
  } catch (err) {
    console.error('[contact] mail error:', err.message);
    res.status(500).json({ error: 'Bericht kon niet worden verzonden. Probeer het later opnieuw.' });
  }
});

// ── App access check ──────────────────────────────────────────────────────────

// GET /api/app/access  – check if user may use the planner
app.get('/api/app/access', requireAuth, (req, res) => {
  const user = db.prepare('SELECT license_until, role FROM users WHERE id = ?').get(req.user.id);
  const hasAccess = user && (user.role === 'admin' || (user.license_until && user.license_until > Date.now()));
  res.json({
    ok: true,
    access: hasAccess,
    license_until: user?.license_until || null,
  });
});

// ── SPA fallbacks ─────────────────────────────────────────────────────────────
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[${ENV}] Running Dinner Planner server draait op http://localhost:${PORT}`);
});
