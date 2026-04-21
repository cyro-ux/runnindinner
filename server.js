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
const zohoSync = require('./lib/zoho-sync');
const zohoClient = require('./lib/zoho-client');
const priceResolver = require('./lib/price-resolver');
const blog = require('./lib/blog');
const sentry = require('./lib/sentry');
// Initialiseer Sentry zo vroeg mogelijk — heeft geen effect zonder SENTRY_DSN
if (sentry.isEnabled()) console.log('[boot] Sentry active');

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

  CREATE TABLE IF NOT EXISTS referral_rewards (
    id                   TEXT PRIMARY KEY,
    user_id              TEXT NOT NULL,        -- referrer who earned the reward
    referred_user_ids    TEXT NOT NULL,        -- JSON array of 3 referred users
    reward_days          INTEGER NOT NULL DEFAULT 365,
    applied_at           INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vouchers (
    id                   TEXT PRIMARY KEY,
    code                 TEXT UNIQUE NOT NULL,
    description          TEXT,
    discount_percent     INTEGER,       -- 0-100; NULL if not a percentage
    free_days            INTEGER,       -- gratis licentie-dagen; NULL if a discount
    max_uses             INTEGER,       -- NULL = unlimited
    expires_at           INTEGER,       -- timestamp; NULL = no expiry
    created_at           INTEGER NOT NULL,
    created_by           TEXT            -- admin user_id
  );

  CREATE TABLE IF NOT EXISTS voucher_redemptions (
    id                   TEXT PRIMARY KEY,
    voucher_id           TEXT NOT NULL,
    user_id              TEXT NOT NULL,
    payment_id           TEXT,           -- NULL for free_days voucher without payment
    redeemed_at          INTEGER NOT NULL,
    FOREIGN KEY (voucher_id) REFERENCES vouchers(id)
  );

  CREATE TABLE IF NOT EXISTS events (
    id                   TEXT PRIMARY KEY,
    user_id              TEXT NOT NULL,   -- organiser
    name                 TEXT NOT NULL,
    date                 TEXT,            -- ISO date
    max_participants     INTEGER,
    courses              INTEGER NOT NULL DEFAULT 3,
    location_note        TEXT,
    donation_goal_cents  INTEGER,
    donation_raised_cents INTEGER NOT NULL DEFAULT 0,
    logo_url             TEXT,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL,
    archived_at          INTEGER
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id              TEXT,            -- NULL voor niet-ingelogde acties
    actor_email          TEXT,            -- snapshot van email op actie-moment
    action               TEXT NOT NULL,   -- 'user.delete' | 'voucher.create' | 'cms.update' | ...
    target_type          TEXT,            -- 'user' | 'voucher' | 'event' | 'payment' | ...
    target_id            TEXT,
    data_json            TEXT,            -- JSON-payload (diff, context)
    ip                   TEXT,
    user_agent           TEXT,
    created_at           INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS audit_log_user_idx   ON audit_log(user_id);
  CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log(action);
  CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at);

  CREATE TABLE IF NOT EXISTS event_participants (
    id                   TEXT PRIMARY KEY,
    event_id             TEXT NOT NULL,
    name                 TEXT NOT NULL,
    email                TEXT,
    phone                TEXT,              -- opt-in only, for WhatsApp share
    address              TEXT,
    diet_notes           TEXT,
    availability_json    TEXT,               -- JSON array of courses they can attend
    is_host_for          TEXT,               -- course name (Voorgerecht/Hoofdgerecht/...)
    token                TEXT UNIQUE,        -- for personalised page URL
    created_at           INTEGER NOT NULL,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
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
if (!userCols.includes('country'))                db.exec("ALTER TABLE users ADD COLUMN country TEXT");
if (!userCols.includes('is_business'))            db.exec("ALTER TABLE users ADD COLUMN is_business INTEGER NOT NULL DEFAULT 0");
if (!userCols.includes('vat_id'))                 db.exec("ALTER TABLE users ADD COLUMN vat_id TEXT");
if (!userCols.includes('vat_id_valid'))           db.exec("ALTER TABLE users ADD COLUMN vat_id_valid INTEGER NOT NULL DEFAULT 0");
if (!userCols.includes('zoho_customer_id'))       db.exec("ALTER TABLE users ADD COLUMN zoho_customer_id TEXT");
if (!userCols.includes('company_name'))           db.exec("ALTER TABLE users ADD COLUMN company_name TEXT");
if (!userCols.includes('referral_code'))          db.exec("ALTER TABLE users ADD COLUMN referral_code TEXT");
if (!userCols.includes('referred_by'))            db.exec("ALTER TABLE users ADD COLUMN referred_by TEXT");
// Create unique index on referral_code (nullable values allowed but unique when set)
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_idx ON users(referral_code) WHERE referral_code IS NOT NULL');
// Backfill referral codes for existing users
const usersWithoutCode = db.prepare("SELECT id FROM users WHERE referral_code IS NULL").all();
if (usersWithoutCode.length > 0) {
  const genCode = () => Math.random().toString(36).slice(2, 8); // 6-char alphanumeric
  const upd = db.prepare('UPDATE users SET referral_code = ? WHERE id = ?');
  for (const u of usersWithoutCode) {
    let code, attempts = 0;
    do {
      code = genCode();
      attempts++;
      if (attempts > 10) throw new Error('Could not generate unique referral code');
      const exists = db.prepare('SELECT 1 FROM users WHERE referral_code = ?').get(code);
      if (!exists) break;
    } while (true);
    upd.run(code, u.id);
  }
  console.log(`[boot] Generated ${usersWithoutCode.length} referral codes for existing users`);
}
const paymentCols = db.prepare("PRAGMA table_info(payments)").all().map(c => c.name);
if (!paymentCols.includes('mollie_payment_id')) db.exec("ALTER TABLE payments ADD COLUMN mollie_payment_id TEXT");
if (!paymentCols.includes('payment_type'))      db.exec("ALTER TABLE payments ADD COLUMN payment_type TEXT NOT NULL DEFAULT 'one-time'");
if (!paymentCols.includes('vat_rate'))          db.exec("ALTER TABLE payments ADD COLUMN vat_rate REAL");
if (!paymentCols.includes('vat_scheme'))        db.exec("ALTER TABLE payments ADD COLUMN vat_scheme TEXT");
if (!paymentCols.includes('country'))           db.exec("ALTER TABLE payments ADD COLUMN country TEXT");
if (!paymentCols.includes('zoho_invoice_id'))   db.exec("ALTER TABLE payments ADD COLUMN zoho_invoice_id TEXT");
if (!paymentCols.includes('zoho_sync_status')) db.exec("ALTER TABLE payments ADD COLUMN zoho_sync_status TEXT NOT NULL DEFAULT 'pending'");
if (!paymentCols.includes('zoho_sync_error'))  db.exec("ALTER TABLE payments ADD COLUMN zoho_sync_error TEXT");
if (!paymentCols.includes('zoho_synced_at'))   db.exec("ALTER TABLE payments ADD COLUMN zoho_synced_at INTEGER");

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

// Seed English CMS defaults (personal tone, matching Dutch live texts)
cmsDefault.run('hero_title_en', 'From spreadsheet chaos to planning in minutes', now);
cmsDefault.run('hero_subtitle_en', 'After years of organizing running dinners myself with endless spreadsheets, duplicate guests and wrong routes, I built this tool. Everything I ran into is now built in as standard.', now);
cmsDefault.run('hero_cta_en', 'Start now for €5/year', now);
cmsDefault.run('features_intro_en', 'Every feature was born from a problem I encountered while organizing. No unnecessary bells and whistles — only what you really need.', now);
cmsDefault.run('price_label_en', '€5 per year', now);
cmsDefault.run('footer_text_en', 'Built from personal experience. Every feature solves a real problem.', now);

cmsDefault.run('hero_title_es', 'Del caos de hojas de cálculo a la planificación en minutos', now);
cmsDefault.run('hero_subtitle_es', 'Después de años organizando cenas itinerantes con interminables hojas de cálculo, invitados duplicados y rutas equivocadas, creé esta herramienta. Todo con lo que me topé ya está integrado por defecto.', now);
cmsDefault.run('hero_cta_es', 'Empieza ahora por €5/año', now);
cmsDefault.run('features_intro_es', 'Cada función nació de un problema que encontré organizando. Sin adornos innecesarios, solo lo que realmente necesitas.', now);
cmsDefault.run('price_label_es', '€5 al año', now);
cmsDefault.run('footer_text_es', 'Creado desde la experiencia personal. Cada función soluciona un problema real.', now);

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
  const brevo = require('./lib/brevo');
  // If Brevo is configured, prefer it over SMTP (better deliverability + analytics)
  if (brevo.isConfigured()) {
    try {
      await brevo.sendTransactional({ to, subject, html: wrapHtml(html), replyTo });
      return;
    } catch (err) {
      console.error('[mail] Brevo failed, falling back to SMTP:', err.message);
      // fall through to SMTP
    }
  }
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
      'List-Unsubscribe': `<mailto:${process.env.MAIL_FROM_ADDRESS || 'noreply@runningdinner.app'}?subject=unsubscribe>`,
    },
  };
  if (replyTo) mailOptions.replyTo = replyTo;
  await mailer.sendMail(mailOptions);
}

// Wrap HTML content in a proper email document structure
function wrapHtml(body, lang = 'nl') {
  const footers = {
    nl: 'Je ontvangt deze e-mail omdat je een account hebt of bent uitgenodigd.',
    en: 'You are receiving this email because you have an account or have been invited.',
    es: 'Recibes este correo porque tienes una cuenta o has sido invitado.',
  };
  const footer = footers[lang] || footers.nl;
  return `<!DOCTYPE html>
<html lang="${lang}" xmlns="http://www.w3.org/1999/xhtml">
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
                Running Dinner Planner &bull; runningdinner.app<br>
                ${footer}
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

// Email locale helpers
const EMAIL_LOCALES = { nl: 'nl-NL', en: 'en-GB', es: 'es-ES' };

// Labels for invoice/payment emails by language
const INVOICE_LABELS = {
  nl: {
    hi: 'Hallo,',
    thanks: (date) => `Bedankt voor je betaling! Je abonnement is actief t/m <strong>${date}</strong>.`,
    invoice_number: 'Factuurnummer',
    description: 'Omschrijving',
    sub_label: '1 jaar abonnement',
    amount: 'Bedrag',
    date: 'Datum',
    open_planner: 'Open de planner',
    subject: (no) => `Factuur ${no} - Running Dinner Planner`,
  },
  en: {
    hi: 'Hi,',
    thanks: (date) => `Thank you for your payment! Your subscription is active until <strong>${date}</strong>.`,
    invoice_number: 'Invoice number',
    description: 'Description',
    sub_label: '1 year subscription',
    amount: 'Amount',
    date: 'Date',
    open_planner: 'Open the planner',
    subject: (no) => `Invoice ${no} - Running Dinner Planner`,
  },
  es: {
    hi: 'Hola,',
    thanks: (date) => `¡Gracias por tu pago! Tu suscripción está activa hasta el <strong>${date}</strong>.`,
    invoice_number: 'Número de factura',
    description: 'Descripción',
    sub_label: 'Suscripción de 1 año',
    amount: 'Importe',
    date: 'Fecha',
    open_planner: 'Abrir el planificador',
    subject: (no) => `Factura ${no} - Running Dinner Planner`,
  },
};

async function sendInvoiceMail(user, payment) {
  const lang = user.language || 'nl';
  const locale = EMAIL_LOCALES[lang] || EMAIL_LOCALES.nl;
  const L = INVOICE_LABELS[lang] || INVOICE_LABELS.nl;
  const untilDate = new Date(user.license_until).toLocaleDateString(locale);

  const html = `
          <h2 style="color:#1a56db;margin:0 0 16px">Running Dinner Planner</h2>
          <p style="color:#374151;line-height:1.6">${L.hi}</p>
          <p style="color:#374151;line-height:1.6">${L.thanks(untilDate)}</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px">
            <tr style="background:#f3f4f6">
              <td style="padding:8px 12px;color:#374151">${L.invoice_number}</td>
              <td style="padding:8px 12px;color:#374151"><strong>${payment.invoice_number}</strong></td>
            </tr>
            <tr>
              <td style="padding:8px 12px;color:#374151">${L.description}</td>
              <td style="padding:8px 12px;color:#374151">Running Dinner Planner - ${L.sub_label}</td>
            </tr>
            <tr style="background:#f3f4f6">
              <td style="padding:8px 12px;color:#374151">${L.amount}</td>
              <td style="padding:8px 12px;color:#374151"><strong>${formatEur(payment.amount_cents)}</strong></td>
            </tr>
            <tr>
              <td style="padding:8px 12px;color:#374151">${L.date}</td>
              <td style="padding:8px 12px;color:#374151">${new Date(payment.created_at).toLocaleDateString(locale)}</td>
            </tr>
          </table>
          <p style="margin:24px 0;text-align:center">
            <a href="${BASE_URL}/app" style="background:#1a56db;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">${L.open_planner}</a>
          </p>
  `;
  await sendMail(user.email, L.subject(payment.invoice_number), wrapHtml(html, lang));
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' })); // Mollie webhook sends urlencoded body
app.use(cookieParser());

// ── Language detection middleware ─────────────────────────────────────────────
const SUPPORTED_LANGS = ['nl', 'en', 'es'];
function detectLanguage(req, res, next) {
  // 1. URL path: /en/, /es/, etc. prefix = explicit choice
  let matched = null;
  for (const lang of SUPPORTED_LANGS) {
    if (lang === 'nl') continue;
    if (req.path.startsWith(`/${lang}/`) || req.path === `/${lang}`) {
      matched = lang; break;
    }
  }
  if (matched) {
    req.lang = matched;
  // 2. Cookie: returning visitor
  } else if (req.cookies?.lang && SUPPORTED_LANGS.includes(req.cookies.lang)) {
    req.lang = req.cookies.lang;
  // 3. Accept-Language header: first visit, browser setting
  } else {
    const accept = (req.headers['accept-language'] || '').toLowerCase();
    if (accept.startsWith('es')) req.lang = 'es';
    else if (accept.startsWith('en')) req.lang = 'en';
    else req.lang = 'nl';
  }
  // Set/update cookie if needed
  if (!req.cookies?.lang || req.cookies.lang !== req.lang) {
    res.cookie('lang', req.lang, { maxAge: 365 * 86400000, sameSite: 'lax' });
  }
  next();
}
app.use(detectLanguage);

// ── Country detection middleware ─────────────────────────────────────────────
// Cloudflare populates CF-IPCountry; accept-language suffix as fallback.
function detectCountry(req, res, next) {
  // 1. Explicit cookie (user chose a currency/country manually)
  if (req.cookies?.country && /^[A-Z]{2}$/i.test(req.cookies.country)) {
    req.country = req.cookies.country.toUpperCase();
  // 2. Cloudflare header (free, accurate IP geolocation)
  } else if (req.headers['cf-ipcountry']) {
    const cfc = String(req.headers['cf-ipcountry']).toUpperCase();
    req.country = cfc === 'XX' || cfc === 'T1' ? 'NL' : cfc;
  // 3. Accept-Language heuristic (last resort)
  } else {
    const al = (req.headers['accept-language'] || '').toLowerCase();
    if (al.startsWith('en-gb')) req.country = 'GB';
    else if (al.startsWith('en-us')) req.country = 'US';
    else if (al.startsWith('en-ca')) req.country = 'CA';
    else if (al.startsWith('en-au')) req.country = 'AU';
    else if (al.startsWith('en-nz')) req.country = 'NZ';
    else if (al.startsWith('es')) req.country = 'ES';
    else if (al.startsWith('de')) req.country = 'DE';
    else if (al.startsWith('fr')) req.country = 'FR';
    else req.country = 'NL';
  }
  next();
}
app.use(detectCountry);

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
app.use('/es/app', express.static(path.join(__dirname)));  // Spanish version serves same static files
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use('/en', express.static(path.join(__dirname, 'public'))); // English public files (CSS, images, lang/)
app.use('/es', express.static(path.join(__dirname, 'public'))); // Spanish public files (CSS, images, lang/)
app.use(express.static(path.join(__dirname, 'public')));

// ── Server-side translations ─────────────────────────────────────────────────
const T = {
  nl: {
    not_logged_in:       'Niet ingelogd',
    session_expired:     'Sessie verlopen',
    no_access:           'Geen toegang',
    no_active_sub:       'Geen actief abonnement',
    email_pw_required:   'E-mail en wachtwoord verplicht',
    pw_min_8:            'Wachtwoord minimaal 8 tekens',
    email_in_use:        'E-mailadres al in gebruik',
    bad_credentials:     'Onbekend e-mailadres of onjuist wachtwoord',
    account_created:     'Account aangemaakt. Je kunt nu inloggen.',
    user_not_found:      'Gebruiker niet gevonden',
    fill_both_fields:    'Vul beide velden in',
    new_pw_min_8:        'Nieuw wachtwoord moet minimaal 8 tekens zijn',
    current_pw_wrong:    'Huidig wachtwoord is onjuist',
    pw_changed:          'Wachtwoord gewijzigd',
    give_enabled:        'Geef { enabled: true/false } mee',
    no_mandate_found:    'Geen machtiging gevonden',
    mandate_revoked:     'Machtiging ingetrokken en automatische verlenging uitgeschakeld',
    reset_email_sent:    'Als dit e-mailadres bekend is, ontvang je een link.',
    token_pw_required:   'Token en wachtwoord verplicht',
    invalid_reset_link:  'Ongeldige of verlopen link',
    pw_changed_login:    'Wachtwoord gewijzigd. Je kunt nu inloggen.',
    payment_failed:      'Betaling kon niet worden gestart',
    invoice_not_found:   'Factuur niet gevonden',
    key_dataurl_req:     'key en dataUrl verplicht',
    email_required:      'E-mailadres is verplicht',
    pw_required_invite:  'Wachtwoord verplicht (of kies uitnodigingslink)',
    cannot_edit_admin:   'Kan andere admin niet bewerken',
    user_updated:        'Gebruiker bijgewerkt',
    invite_sent:         'Uitnodiging verstuurd naar {email}',
    email_send_failed:   'E-mail kon niet worden verstuurd',
    min_price:           'Minimale prijs €1,00',
    invalid_duration:    'Ongeldige duur',
    invalid_env:         'Ongeldige omgeving',
    deploy_registered:   'Deployment naar {env} geregistreerd.',
    invalid_number:      'Ongeldig getal',
    score_1_5:           'Score moet 1-5 zijn',
    rating_updated:      'Beoordeling bijgewerkt',
    thanks_rating:       'Bedankt voor je beoordeling!',
    all_fields_required: 'Alle velden zijn verplicht',
    message_sent:        'Je bericht is verzonden!',
    message_send_failed: 'Bericht kon niet worden verzonden. Probeer het later opnieuw.',
    invalid_lang:        'Ongeldige taal. Kies "nl" of "en".',
    too_many_requests:   'Te veel verzoeken. Probeer het later opnieuw.',
    no_mandate_needs:    'Geen machtiging gevonden. Doe eerst een betaling met automatische verlenging ingeschakeld.',
    auto_renew_on:       'Automatische verlenging ingeschakeld',
    auto_renew_off:      'Automatische verlenging uitgeschakeld',
  },
  en: {
    not_logged_in:       'Not logged in',
    session_expired:     'Session expired',
    no_access:           'Access denied',
    no_active_sub:       'No active subscription',
    email_pw_required:   'Email and password are required',
    pw_min_8:            'Password must be at least 8 characters',
    email_in_use:        'Email address already in use',
    bad_credentials:     'Unknown email address or incorrect password',
    account_created:     'Account created. You can now log in.',
    user_not_found:      'User not found',
    fill_both_fields:    'Please fill in both fields',
    new_pw_min_8:        'New password must be at least 8 characters',
    current_pw_wrong:    'Current password is incorrect',
    pw_changed:          'Password changed',
    give_enabled:        'Provide { enabled: true/false }',
    no_mandate_found:    'No mandate found',
    mandate_revoked:     'Mandate revoked and auto-renewal disabled',
    reset_email_sent:    'If this email address is known, you will receive a link.',
    token_pw_required:   'Token and password are required',
    invalid_reset_link:  'Invalid or expired link',
    pw_changed_login:    'Password changed. You can now log in.',
    payment_failed:      'Payment could not be started',
    invoice_not_found:   'Invoice not found',
    key_dataurl_req:     'key and dataUrl are required',
    email_required:      'Email address is required',
    pw_required_invite:  'Password required (or choose invitation link)',
    cannot_edit_admin:   'Cannot edit another admin',
    user_updated:        'User updated',
    invite_sent:         'Invitation sent to {email}',
    email_send_failed:   'Email could not be sent',
    min_price:           'Minimum price €1.00',
    invalid_duration:    'Invalid duration',
    invalid_env:         'Invalid environment',
    deploy_registered:   'Deployment to {env} registered.',
    invalid_number:      'Invalid number',
    score_1_5:           'Score must be 1-5',
    rating_updated:      'Rating updated',
    thanks_rating:       'Thank you for your rating!',
    all_fields_required: 'All fields are required',
    message_sent:        'Your message has been sent!',
    message_send_failed: 'Message could not be sent. Please try again later.',
    invalid_lang:        'Invalid language. Choose "nl", "en" or "es".',
    too_many_requests:   'Too many requests. Please try again later.',
    no_mandate_needs:    'No mandate found. Please make a payment with auto-renewal enabled first.',
    auto_renew_on:       'Auto-renewal enabled',
    auto_renew_off:      'Auto-renewal disabled',
  },
  es: {
    not_logged_in:       'No has iniciado sesión',
    session_expired:     'Sesión expirada',
    no_access:           'Acceso denegado',
    no_active_sub:       'Sin suscripción activa',
    email_pw_required:   'Se requieren correo electrónico y contraseña',
    pw_min_8:            'La contraseña debe tener al menos 8 caracteres',
    email_in_use:        'La dirección de correo ya está en uso',
    bad_credentials:     'Correo desconocido o contraseña incorrecta',
    account_created:     'Cuenta creada. Ya puedes iniciar sesión.',
    user_not_found:      'Usuario no encontrado',
    fill_both_fields:    'Rellena ambos campos',
    new_pw_min_8:        'La nueva contraseña debe tener al menos 8 caracteres',
    current_pw_wrong:    'La contraseña actual es incorrecta',
    pw_changed:          'Contraseña cambiada',
    give_enabled:        'Proporciona { enabled: true/false }',
    no_mandate_found:    'No se encontró autorización',
    mandate_revoked:     'Autorización revocada y renovación automática desactivada',
    reset_email_sent:    'Si este correo es conocido, recibirás un enlace.',
    token_pw_required:   'Se requieren token y contraseña',
    invalid_reset_link:  'Enlace no válido o expirado',
    pw_changed_login:    'Contraseña cambiada. Ya puedes iniciar sesión.',
    payment_failed:      'No se pudo iniciar el pago',
    invoice_not_found:   'Factura no encontrada',
    key_dataurl_req:     'Se requieren key y dataUrl',
    email_required:      'El correo electrónico es obligatorio',
    pw_required_invite:  'Contraseña requerida (o elige enlace de invitación)',
    cannot_edit_admin:   'No se puede editar a otro administrador',
    user_updated:        'Usuario actualizado',
    invite_sent:         'Invitación enviada a {email}',
    email_send_failed:   'No se pudo enviar el correo',
    min_price:           'Precio mínimo €1,00',
    invalid_duration:    'Duración no válida',
    invalid_env:         'Entorno no válido',
    deploy_registered:   'Despliegue a {env} registrado.',
    invalid_number:      'Número no válido',
    score_1_5:           'La puntuación debe ser 1-5',
    rating_updated:      'Valoración actualizada',
    thanks_rating:       '¡Gracias por tu valoración!',
    all_fields_required: 'Todos los campos son obligatorios',
    message_sent:        '¡Tu mensaje ha sido enviado!',
    message_send_failed: 'No se pudo enviar el mensaje. Inténtalo más tarde.',
    invalid_lang:        'Idioma no válido. Elige "nl", "en" o "es".',
    too_many_requests:   'Demasiadas solicitudes. Inténtalo más tarde.',
    no_mandate_needs:    'No se encontró autorización. Primero realiza un pago con renovación automática activada.',
    auto_renew_on:       'Renovación automática activada',
    auto_renew_off:      'Renovación automática desactivada',
  }
};
function t(req, key, replacements) {
  let msg = (T[req?.lang || 'nl'] || T.nl)[key] || T.nl[key] || key;
  if (replacements) {
    for (const [k, v] of Object.entries(replacements)) {
      msg = msg.replace(`{${k}}`, v);
    }
  }
  return msg;
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers?.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: t(req, 'not_logged_in') });
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
    res.status(401).json({ error: t(req, 'session_expired') });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: t(req, 'no_access') });
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
      return res.status(402).json({ error: t(req, 'no_active_sub'), redirect: '/subscribe.html' });
    }
    next();
  });
}

// ── Auth routes ───────────────────────────────────────────────────────────────

// Helper: generate a unique referral code
function generateReferralCode() {
  for (let i = 0; i < 10; i++) {
    const code = Math.random().toString(36).slice(2, 8);
    if (!db.prepare('SELECT 1 FROM users WHERE referral_code = ?').get(code)) {
      return code;
    }
  }
  throw new Error('Could not generate unique referral code');
}

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const { email, password, referralCode } = req.body || {};
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

  const hash = await bcrypt.hash(password, 12);
  const id   = uuidv4();
  const lang = req.lang || 'nl';
  const code = generateReferralCode();
  db.prepare(
    'INSERT INTO users (id, email, password_hash, role, created_at, language, referral_code, referred_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, email.toLowerCase(), hash, 'user', Date.now(), lang, code, referredBy);

  res.json({ ok: true, message: t(req, 'account_created') });
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
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
  if (!user) return res.status(404).json({ error: t(req, 'user_not_found') });
  res.json({ ok: true, user });
});

// POST /api/auth/change-password
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
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
});

// PUT /api/user/auto-renew  – toggle automatic renewal
app.put('/api/user/auto-renew', requireAuth, (req, res) => {
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
app.delete('/api/user/mandate', requireAuth, async (req, res) => {
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
});

// POST /api/auth/forgot-password
app.post('/api/auth/forgot-password', async (req, res) => {
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
});

// POST /api/auth/reset-password
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: t(req, 'token_pw_required') });
  if (password.length < 8) return res.status(400).json({ error: t(req, 'pw_min_8') });

  const row = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(token);
  if (!row || row.expires_at < Date.now()) return res.status(400).json({ error: t(req, 'invalid_reset_link') });

  const hash = await bcrypt.hash(password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
  db.prepare('DELETE FROM password_resets WHERE token = ?').run(token);

  res.json({ ok: true, message: t(req, 'pw_changed_login') });
});

// ── Mollie / Payment routes ───────────────────────────────────────────────────

// POST /api/mollie/create-payment
app.post('/api/mollie/create-payment', requireAuth, async (req, res) => {
  const user       = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const autoRenew  = req.body?.autoRenew === true;

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

    // ── Refund / chargeback handling (idempotent via stored flag in DB) ────
    const refundedCents = payment.amountRefunded ? Math.round(parseFloat(payment.amountRefunded.value) * 100) : 0;
    const chargebackCents = payment.amountChargedBack ? Math.round(parseFloat(payment.amountChargedBack.value) * 100) : 0;

    if (refundedCents > 0 || chargebackCents > 0) {
      const localPayment = db.prepare('SELECT * FROM payments WHERE mollie_payment_id = ?').get(payment.id);
      if (localPayment && !localPayment.zoho_sync_error?.includes('refunded')) {
        const reason = chargebackCents > 0 ? 'Chargeback' : 'Refund';
        console.log(`[mollie] ${reason} detected for payment ${payment.id}: ${refundedCents || chargebackCents} cents`);

        // Create credit note in Zoho (idempotency: check if already done via sync_status)
        zohoSync.syncRefund(db, localPayment.id, reason).then((r) => {
          if (r.synced) {
            db.prepare('UPDATE payments SET status = ?, zoho_sync_error = ? WHERE id = ?')
              .run(chargebackCents > 0 ? 'chargeback' : 'refunded',
                   `${reason} processed; credit_note=${r.creditnote_id}`,
                   localPayment.id);
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
        };
        const bodyMap = {
          nl: `<p>Hallo,</p><p>We hebben een ${reason === 'Chargeback' ? 'chargeback' : 'terugbetaling'} verwerkt voor je betaling. De creditnota is in je boekhouding opgenomen.</p>`,
          en: `<p>Hi,</p><p>We've processed a ${reason.toLowerCase()} for your payment. A credit note has been registered.</p>`,
          es: `<p>Hola,</p><p>Hemos procesado un ${reason === 'Chargeback' ? 'contracargo' : 'reembolso'} de tu pago. Se ha registrado una nota de crédito.</p>`,
        };
        sendMail(user.email, subjectMap[lang] || subjectMap.nl, wrapHtml(bodyMap[lang] || bodyMap.nl, lang)).catch(console.error);
      }
      return res.send('ok');
    }

    // Handle failed recurring payments
    if (payment.status === 'failed' && payment.sequenceType === 'recurring') {
      console.log(`[mollie] recurring payment failed for user ${userId}`);
      const failCount = db.prepare(
        "SELECT COUNT(*) as c FROM payments WHERE user_id = ? AND status = 'failed' AND payment_type = 'recurring' AND created_at > ?"
      ).get(userId, Date.now() - 30 * 86400000).c;

      if (failCount >= 2) {
        // 3rd failure (including this one) → disable auto-renewal
        db.prepare('UPDATE users SET auto_renew = 0 WHERE id = ?').run(userId);
        const uLang = user.language || 'nl';
        const uEN = uLang === 'en';
        sendMail(user.email,
          uEN ? 'Auto-renewal disabled - Running Dinner Planner' : 'Automatische verlenging uitgeschakeld - Running Dinner Planner',
          wrapHtml(`
          <h2 style="color:#1a56db;margin:0 0 16px">Running Dinner Planner</h2>
          <p style="color:#374151;line-height:1.6">${uEN ? 'Hi,' : 'Hallo,'}</p>
          <p style="color:#374151;line-height:1.6">${uEN
            ? 'Your auto-renewal has been disabled because the payment failed multiple times.'
            : 'Je automatische verlenging is uitgeschakeld omdat de betaling meerdere keren niet gelukt is.'
          }</p>
          <p style="color:#374151;line-height:1.6">${uEN
            ? 'You can renew your subscription manually using the button below.'
            : 'Je kunt je abonnement handmatig verlengen via onderstaande knop.'
          }</p>
          <p style="margin:24px 0;text-align:center">
            <a href="${BASE_URL}/subscribe.html" style="background:#1a56db;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">${uEN ? 'Renew subscription' : 'Abonnement verlengen'}</a>
          </p>
        `, uLang)).catch(console.error);
      } else {
        const uLang2 = user.language || 'nl';
        const uEN2 = uLang2 === 'en';
        sendMail(user.email,
          uEN2 ? 'Auto-renewal failed - Running Dinner Planner' : 'Automatische verlenging mislukt - Running Dinner Planner',
          wrapHtml(`
          <h2 style="color:#1a56db;margin:0 0 16px">Running Dinner Planner</h2>
          <p style="color:#374151;line-height:1.6">${uEN2 ? 'Hi,' : 'Hallo,'}</p>
          <p style="color:#374151;line-height:1.6">${uEN2
            ? 'The automatic renewal of your subscription has failed. We will try again soon.'
            : 'De automatische verlenging van je abonnement is niet gelukt. We proberen het binnenkort opnieuw.'
          }</p>
          <p style="color:#374151;line-height:1.6">${uEN2
            ? 'Would you rather handle it yourself? Renew manually:'
            : 'Wil je het zelf regelen? Verleng dan handmatig:'
          }</p>
          <p style="margin:24px 0;text-align:center">
            <a href="${BASE_URL}/subscribe.html" style="background:#1a56db;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">${uEN2 ? 'Renew manually' : 'Handmatig verlengen'}</a>
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
});

// ── Brevo: one-shot admin endpoint to set API key without leaking it ──────
// Writes BREVO_API_KEY to .env + updates process.env. Returns only success.
app.post('/api/admin/brevo/set-key', requireAdmin, async (req, res) => {
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
app.post('/api/admin/brevo/set-smtp-key', requireAdmin, async (req, res) => {
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

app.get('/api/admin/sentry/status', requireAdmin, (req, res) => {
  res.json({ ok: true, enabled: sentry.isEnabled() });
});

app.post('/api/admin/sentry/test', requireAdmin, (req, res) => {
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
app.get('/api/admin/audit', requireAdmin, (req, res) => {
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
app.get('/api/vouchers/validate/:code', (req, res) => {
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
app.get('/api/admin/vouchers', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT v.*,
      (SELECT COUNT(*) FROM voucher_redemptions WHERE voucher_id = v.id) as redeemed_count
    FROM vouchers v
    ORDER BY v.created_at DESC
  `).all();
  res.json({ ok: true, vouchers: rows, enabled: vouchersEnabled() });
});

// Admin: create voucher
app.post('/api/admin/vouchers', requireAdmin, (req, res) => {
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
app.delete('/api/admin/vouchers/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM vouchers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Admin: toggle vouchers feature flag
app.put('/api/admin/vouchers/enabled', requireAdmin, (req, res) => {
  const { enabled } = req.body || {};
  db.prepare("INSERT INTO settings (key, value) VALUES ('vouchers_enabled', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(enabled ? '1' : '0');
  res.json({ ok: true, enabled: Boolean(enabled) });
});

// ── Event CRUD (backend-only — frontend app.js blijft client-side voor nu) ──
// Deze endpoints zijn klaar, maar de planner-index.html gebruikt ze nog niet.
// Wanneer Sprint 6b actief wordt (persistent events), dan haakt de frontend
// hier op aan.

app.post('/api/events', requireAuth, (req, res) => {
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

app.get('/api/events', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM events WHERE user_id = ? AND archived_at IS NULL ORDER BY date DESC, created_at DESC'
  ).all(req.user.id);
  res.json({ ok: true, events: rows });
});

app.get('/api/events/:id', requireAuth, (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  const participants = db.prepare('SELECT * FROM event_participants WHERE event_id = ? ORDER BY name').all(ev.id);
  res.json({ ok: true, event: ev, participants });
});

app.put('/api/events/:id', requireAuth, (req, res) => {
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

app.delete('/api/events/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM events WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Participants sub-resource
app.post('/api/events/:id/participants', requireAuth, (req, res) => {
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
app.get('/api/events/:id/calendar.ics', requireAuth, (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!ev) return res.status(404).send('Not found');
  const { buildEventCalendar } = require('./lib/ical');
  const ics = buildEventCalendar(ev);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${ev.id}.ics"`);
  res.send(ics);
});

// GET /api/events/:id/participants/:token/calendar.ics  – public, token-based
// Persoonlijke kalender voor één deelnemer. Geen auth nodig, alleen het token
// dat alleen de organisator deelt.
app.get('/api/events/:eventId/participants/:token/calendar.ics', (req, res) => {
  const participant = db.prepare(`
    SELECT ep.*, e.id as evt_id, e.name as evt_name, e.date as evt_date, e.user_id as organiser_id
    FROM event_participants ep JOIN events e ON e.id = ep.event_id
    WHERE ep.event_id = ? AND ep.token = ?
  `).get(req.params.eventId, req.params.token);
  if (!participant) return res.status(404).send('Not found');

  const { buildParticipantCalendar } = require('./lib/ical');
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

app.delete('/api/events/:eventId/participants/:id', requireAuth, (req, res) => {
  // Verify ownership via event
  const ev = db.prepare('SELECT id FROM events WHERE id = ? AND user_id = ?').get(req.params.eventId, req.user.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  db.prepare('DELETE FROM event_participants WHERE id = ? AND event_id = ?').run(req.params.id, ev.id);
  res.json({ ok: true });
});

// ── Referral system ──────────────────────────────────────────────────────────
const REFERRAL_THRESHOLD = 3;        // converted referrals needed per reward
const REFERRAL_REWARD_DAYS = 365;    // extension granted per reward

/**
 * Check if a user has earned a new referral reward and apply it.
 * Idempotent: counts total rewards already applied vs total conversions.
 * If (conversions) ≥ (rewards_earned + 1) * threshold → apply next reward.
 */
function checkReferralReward(referrerId) {
  const referrer = db.prepare('SELECT * FROM users WHERE id = ?').get(referrerId);
  if (!referrer) return;

  // Converted referrals = referred users who have paid at least once (license_until set)
  const converted = db.prepare(`
    SELECT id FROM users
    WHERE referred_by = ?
      AND license_until IS NOT NULL
      AND license_until > 0
    ORDER BY created_at ASC
  `).all(referrerId);

  const rewardsEarned = db.prepare(
    'SELECT COUNT(*) as c FROM referral_rewards WHERE user_id = ?'
  ).get(referrerId).c;

  const expectedRewards = Math.floor(converted.length / REFERRAL_THRESHOLD);
  if (expectedRewards <= rewardsEarned) return; // no new reward

  // Apply rewards for each batch of 3 not yet rewarded
  for (let i = rewardsEarned; i < expectedRewards; i++) {
    const batch = converted.slice(i * REFERRAL_THRESHOLD, (i + 1) * REFERRAL_THRESHOLD);
    const ids = batch.map(u => u.id);

    // Extend license by 365 days (from later of now / current license end)
    const now = Date.now();
    const base = (referrer.license_until && referrer.license_until > now) ? referrer.license_until : now;
    const newUntil = base + REFERRAL_REWARD_DAYS * 86400000;
    db.prepare('UPDATE users SET license_until = ? WHERE id = ?').run(newUntil, referrerId);

    db.prepare(`
      INSERT INTO referral_rewards (id, user_id, referred_user_ids, reward_days, applied_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), referrerId, JSON.stringify(ids), REFERRAL_REWARD_DAYS, now);

    // Notify the referrer in their language
    const lang = referrer.language || 'nl';
    const subj = { nl: '🎉 Gratis jaar verdiend via referrals',
                   en: '🎉 Free year earned through referrals',
                   es: '🎉 Año gratis ganado gracias a referidos' }[lang] || 'Free year earned';
    const body = {
      nl: `<p>Hallo,</p><p>Super nieuws! Drie mensen hebben via jouw uitnodigingslink een abonnement genomen, dus je hebt <strong>1 gratis jaar</strong> cadeau gekregen. Je abonnement loopt nu tot <strong>${new Date(newUntil).toLocaleDateString('nl-NL')}</strong>.</p><p>Bedankt dat je Running Dinner Planner aanbeveelt!</p>`,
      en: `<p>Hi,</p><p>Great news! Three people signed up through your invitation link, so you've earned <strong>1 free year</strong> as a thank-you. Your subscription now runs until <strong>${new Date(newUntil).toLocaleDateString('en-GB')}</strong>.</p><p>Thanks for recommending Running Dinner Planner!</p>`,
      es: `<p>Hola,</p><p>¡Buenas noticias! Tres personas se suscribieron a través de tu enlace de invitación, así que has ganado <strong>1 año gratis</strong>. Tu suscripción ahora dura hasta el <strong>${new Date(newUntil).toLocaleDateString('es-ES')}</strong>.</p><p>¡Gracias por recomendar Running Dinner Planner!</p>`,
    }[lang];
    sendMail(referrer.email, subj, wrapHtml(body, lang)).catch(console.error);

    console.log(`[referral] Applied reward #${i + 1} to user ${referrerId} (${batch.length} conversions)`);
  }
}

// GET /api/user/referral  – returns code, stats, invite URL
app.get('/api/user/referral', requireAuth, (req, res) => {
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
app.get('/api/user/data-export', requireAuth, (req, res) => {
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
app.delete('/api/user/account', requireAuth, async (req, res) => {
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

  // Delete cascade (foreign keys on ratings, sessions, payments)
  // We KEEP payments for accounting/Zoho retention but anonymize the user link.
  const anonEmail = `deleted-${uuidv4()}@deleted.local`;
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
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
  const subject = { nl: 'Je account is verwijderd', en: 'Your account has been deleted', es: 'Tu cuenta ha sido eliminada' }[lang] || 'Account deleted';
  const body = {
    nl: '<p>Hallo,</p><p>Je Running Dinner Planner-account is permanent verwijderd. Facturen blijven bewaard zoals fiscaal verplicht.</p>',
    en: '<p>Hi,</p><p>Your Running Dinner Planner account has been permanently deleted. Invoices are retained as required by tax law.</p>',
    es: '<p>Hola,</p><p>Tu cuenta de Running Dinner Planner ha sido eliminada permanentemente. Las facturas se conservan según la ley fiscal.</p>',
  }[lang] || '<p>Your account has been deleted.</p>';
  sendMail(user.email, subject, wrapHtml(body, lang)).catch(console.error);

  res.json({ ok: true, message: 'Account deleted' });
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
    .text('Vragen? Neem contact op via het contactformulier op runningdinner.app', 50, 765, { align: 'center', width: 495 });

  doc.end();
});

// GET /api/user/profile  – user profile data
app.get('/api/user/profile', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, role, user_type, created_at, last_login, license_until, auto_renew, mollie_mandate_id FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: t(req, 'user_not_found') });
  const payments = db.prepare(
    "SELECT invoice_number, amount_cents, currency, status, created_at FROM payments WHERE user_id = ? AND status = 'paid' ORDER BY created_at DESC"
  ).all(req.user.id);
  res.json({ ok: true, user, payments });
});

// ── CMS routes ────────────────────────────────────────────────────────────────

// GET /api/cms  (public, language-aware)
app.get('/api/cms', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM cms').all();
  const all  = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const lang = req.lang || 'nl';
  const LANG_SUFFIXES = ['_en', '_es'];

  // Build language-aware CMS object:
  // For non-NL: if hero_title_{lang} exists, return it under `hero_title` (client stays simple)
  // For NL: return base keys as-is, skip all language-suffixed keys
  const cms = {};
  for (const [key, value] of Object.entries(all)) {
    // skip language-suffixed keys from base output (they're used as overlays)
    if (LANG_SUFFIXES.some(s => key.endsWith(s))) continue;

    if (lang !== 'nl') {
      const langKey = `${key}_${lang}`;
      if (all[langKey]) { cms[key] = all[langKey]; continue; }
    }
    cms[key] = value;
  }

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
  if (!key || !dataUrl) return res.status(400).json({ error: t(req, 'key_dataurl_req') });
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
app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
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
app.post('/api/admin/users/:id/invite', requireAdmin, async (req, res) => {
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
app.get('/api/admin/referrals', requireAdmin, (req, res) => {
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
app.post('/api/admin/zoho/bootstrap', requireAdmin, async (req, res) => {
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
app.post('/api/admin/zoho/ensure-eu-taxes', requireAdmin, async (req, res) => {
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
app.get('/api/admin/zoho/status', requireAdmin, (req, res) => {
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
app.post('/api/admin/zoho/retry/:paymentId', requireAdmin, async (req, res) => {
  try {
    const result = await zohoSync.syncPayment(db, req.params.paymentId);
    res.json({ ok: result.synced, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/zoho/discrepancies  – recent payments missing from Zoho
app.get('/api/admin/zoho/discrepancies', requireAdmin, (req, res) => {
  const days = Math.min(parseInt(req.query.days || '7', 10), 90);
  const rows = zohoSync.listDiscrepancies(db, days);
  res.json({ ok: true, days, count: rows.length, discrepancies: rows });
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
  if (isNaN(n) || n < 0) return res.status(400).json({ error: t(req, 'invalid_number') });
  db.prepare("INSERT INTO settings (key, value) VALUES ('planning_counter', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(n));
  res.json({ ok: true, count: n });
});

// ── Analytics (Plausible proxy) ──────────────────────────────────────────────

const PLAUSIBLE_API_KEY = process.env.PLAUSIBLE_API_KEY || '';
const PLAUSIBLE_BASE    = process.env.PLAUSIBLE_BASE_URL || 'http://127.0.0.1:8000';
const PLAUSIBLE_SITE_ID = process.env.PLAUSIBLE_SITE_ID || 'runningdiner.nl';

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
app.get('/api/admin/analytics/realtime', requireAdmin, async (req, res) => {
  try {
    const r = await plausibleFetch(`/api/v1/stats/realtime/visitors?site_id=${PLAUSIBLE_SITE_ID}`);
    res.json({ ok: true, visitors: r.body });
  } catch { res.json({ ok: false, visitors: 0 }); }
});

// GET /api/admin/analytics/aggregate?period=30d
app.get('/api/admin/analytics/aggregate', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const metrics = 'visitors,pageviews,bounce_rate,visit_duration';
    const r = await plausibleFetch(`/api/v1/stats/aggregate?site_id=${PLAUSIBLE_SITE_ID}&period=${encodeURIComponent(period)}&metrics=${metrics}`);
    res.json({ ok: true, results: r.body.results || {} });
  } catch { res.json({ ok: false, results: {} }); }
});

// GET /api/admin/analytics/timeseries?period=30d&interval=date
app.get('/api/admin/analytics/timeseries', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const interval = req.query.interval || 'date';
    const metrics = req.query.metrics || 'visitors';
    const r = await plausibleFetch(`/api/v1/stats/timeseries?site_id=${PLAUSIBLE_SITE_ID}&period=${encodeURIComponent(period)}&interval=${interval}&metrics=${metrics}`);
    res.json({ ok: true, results: r.body.results || [] });
  } catch { res.json({ ok: false, results: [] }); }
});

// GET /api/admin/analytics/pages?period=30d&limit=10
app.get('/api/admin/analytics/pages', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const limit  = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const r = await plausibleFetch(`/api/v1/stats/breakdown?site_id=${PLAUSIBLE_SITE_ID}&period=${encodeURIComponent(period)}&property=event:page&metrics=visitors,pageviews&limit=${limit}`);
    res.json({ ok: true, results: r.body.results || [] });
  } catch { res.json({ ok: false, results: [] }); }
});

// GET /api/admin/analytics/sources?period=30d&limit=10
app.get('/api/admin/analytics/sources', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const limit  = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const r = await plausibleFetch(`/api/v1/stats/breakdown?site_id=${PLAUSIBLE_SITE_ID}&period=${encodeURIComponent(period)}&property=visit:source&metrics=visitors&limit=${limit}`);
    res.json({ ok: true, results: r.body.results || [] });
  } catch { res.json({ ok: false, results: [] }); }
});

// GET /api/admin/analytics/countries?period=30d&limit=10
app.get('/api/admin/analytics/countries', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const limit  = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const r = await plausibleFetch(`/api/v1/stats/breakdown?site_id=${PLAUSIBLE_SITE_ID}&period=${encodeURIComponent(period)}&property=visit:country&metrics=visitors&limit=${limit}`);
    res.json({ ok: true, results: r.body.results || [] });
  } catch { res.json({ ok: false, results: [] }); }
});

// GET /api/admin/analytics/devices?period=30d
app.get('/api/admin/analytics/devices', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const r = await plausibleFetch(`/api/v1/stats/breakdown?site_id=${PLAUSIBLE_SITE_ID}&period=${encodeURIComponent(period)}&property=visit:device&metrics=visitors&limit=5`);
    res.json({ ok: true, results: r.body.results || [] });
  } catch { res.json({ ok: false, results: [] }); }
});

// GET /api/admin/analytics/events?period=30d
app.get('/api/admin/analytics/events', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const r = await plausibleFetch(`/api/v1/stats/breakdown?site_id=${PLAUSIBLE_SITE_ID}&period=${encodeURIComponent(period)}&property=event:name&metrics=visitors&limit=20`);
    // Filter out 'pageview' — only custom events
    const custom = (r.body.results || []).filter(e => e.name !== 'pageview');
    res.json({ ok: true, results: custom });
  } catch { res.json({ ok: false, results: [] }); }
});

// ── Pricing (public, language/country-aware) ─────────────────────────────────

// GET /api/pricing  – returns price based on detected or chosen country
app.get('/api/pricing', (req, res) => {
  const currency = req.query.currency || req.cookies?.currency || null;
  const country  = req.query.country  || req.cookies?.country  || req.country;
  const price = priceResolver.resolve({ country, currency });
  res.json({
    ok: true,
    ...price,
    availableCurrencies: priceResolver.availableCurrencies(),
  });
});

// POST /api/pricing/preference  – user explicitly selected currency/country
app.post('/api/pricing/preference', (req, res) => {
  const { currency, country } = req.body || {};
  if (currency) res.cookie('currency', String(currency).toUpperCase(), { maxAge: 365 * 86400000, sameSite: 'lax' });
  if (country)  res.cookie('country',  String(country).toUpperCase(),  { maxAge: 365 * 86400000, sameSite: 'lax' });
  const price = priceResolver.resolve({
    country:  country  || req.country,
    currency: currency || req.cookies?.currency,
  });
  res.json({ ok: true, ...price });
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
  if (!s || s < 1 || s > 5) return res.status(400).json({ error: t(req, 'score_1_5') });

  // Check if user already rated (allow max 1 per user to keep it fair)
  const existing = db.prepare('SELECT id FROM ratings WHERE user_id = ?').get(req.user.id);
  if (existing) {
    // Update existing rating
    db.prepare('UPDATE ratings SET score = ?, comment = ?, created_at = ? WHERE user_id = ?')
      .run(s, comment || null, Date.now(), req.user.id);
    return res.json({ ok: true, message: t(req, 'rating_updated'), updated: true });
  }

  const id = uuidv4();
  db.prepare('INSERT INTO ratings (id, user_id, score, comment, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, s, comment || null, Date.now());

  res.json({ ok: true, message: t(req, 'thanks_rating') });
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
  if (!name || !email || !message) return res.status(400).json({ error: t(req, 'all_fields_required') });

  // Basic email-format validation to prevent spam / header-injection attempts
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: t(req, 'all_fields_required') });
  }

  const contactEmail = process.env.CONTACT_EMAIL || 'cyro@vanmalsen.net';
  const safeName    = escHtml(name).slice(0, 200);
  const safeEmail   = escHtml(email).slice(0, 200);
  const safeMessage = escHtml(message).slice(0, 5000).replace(/\n/g, '<br>');
  const lang = req.lang || 'nl';

  // Labels per locale for the admin-notification email (body stays pragmatic —
  // primary goal is readability for the recipient, not a fully localised mail).
  const LBL = {
    nl: { title: 'Nieuw contactbericht', name: 'Naam', email: 'E-mail', message: 'Bericht', language: 'Taal' },
    en: { title: 'New contact message',   name: 'Name', email: 'Email', message: 'Message', language: 'Language' },
    es: { title: 'Nuevo mensaje de contacto', name: 'Nombre', email: 'Correo', message: 'Mensaje', language: 'Idioma' },
  }[lang] || { title: 'New contact message', name: 'Name', email: 'Email', message: 'Message', language: 'Language' };

  const html = `
          <h2 style="color:#1a56db;margin:0 0 16px">${LBL.title}</h2>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
            <tr style="background:#f3f4f6">
              <td style="padding:8px 12px;color:#374151;font-weight:bold;width:110px">${LBL.name}</td>
              <td style="padding:8px 12px;color:#374151">${safeName}</td>
            </tr>
            <tr>
              <td style="padding:8px 12px;color:#374151;font-weight:bold">${LBL.email}</td>
              <td style="padding:8px 12px;color:#374151"><a href="mailto:${safeEmail}" style="color:#1a56db">${safeEmail}</a></td>
            </tr>
            <tr style="background:#f3f4f6">
              <td style="padding:8px 12px;color:#374151;font-weight:bold">${LBL.language}</td>
              <td style="padding:8px 12px;color:#374151">${lang.toUpperCase()}</td>
            </tr>
          </table>
          <p style="color:#374151;font-weight:bold;margin:16px 0 8px">${LBL.message}:</p>
          <div style="border-left:3px solid #1a56db;padding:12px 16px;margin:0;background:#f9fafb;color:#374151;line-height:1.6">${safeMessage}</div>
  `;

  // Subject always starts with "RDA" + locale tag so Cyro can triage in Gmail
  const subject = `RDA [${lang.toUpperCase()}] ${LBL.title}: ${safeName}`;

  try {
    await sendMail(contactEmail, subject, html, { replyTo: email });
    res.json({ ok: true, message: t(req, 'message_sent') });
  } catch (err) {
    console.error('[contact] mail error:', err.message);
    res.status(500).json({ error: t(req, 'message_send_failed') });
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
  if (!language || !SUPPORTED_LANGS.includes(language)) {
    return res.status(400).json({ error: t(req, 'invalid_lang') });
  }
  db.prepare('UPDATE users SET language = ? WHERE id = ?').run(language, req.user.id);
  res.cookie('lang', language, { maxAge: 365 * 86400000, sameSite: 'lax' });
  res.json({ ok: true, language });
});

// ── Sitemap ──────────────────────────────────────────────────────────────────
app.get('/sitemap.xml', (req, res) => {
  const base = 'https://runningdinner.app';
  const today = new Date().toISOString().split('T')[0];

  // Pages with NL + EN + ES alternates
  const multilingualPages = [
    { nl: '/',                en: '/en/',                es: '/es/',                priority: '1.0', changefreq: 'weekly' },
    { nl: '/login.html',      en: '/en/login.html',      es: '/es/login.html',      priority: '0.6', changefreq: 'monthly' },
    { nl: '/register.html',   en: '/en/register.html',   es: '/es/register.html',   priority: '0.7', changefreq: 'monthly' },
    { nl: '/subscribe.html',  en: '/en/subscribe.html',  es: '/es/subscribe.html',  priority: '0.7', changefreq: 'monthly' },
  ];

  const hreflangBlock = (page) => `
    <xhtml:link rel="alternate" hreflang="nl" href="${base}${page.nl}"/>
    <xhtml:link rel="alternate" hreflang="en" href="${base}${page.en}"/>
    <xhtml:link rel="alternate" hreflang="es" href="${base}${page.es}"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${base}${page.nl}"/>`;

  let urls = '';
  for (const page of multilingualPages) {
    for (const lang of ['nl', 'en', 'es']) {
      urls += `
  <url>
    <loc>${base}${page[lang]}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>${hreflangBlock(page)}
  </url>`;
    }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls}
</urlset>`;

  res.type('application/xml').send(xml);
});

// ── English route handling (/en/*) ──────────────────────────────────────────

// Build English homepage variant at startup (cached in memory for SEO)
const homeHtmlPath = path.join(__dirname, 'public', 'home.html');
let homeHtmlEN = null;
try {
  let html = fs.readFileSync(homeHtmlPath, 'utf8');

  // 1. <html lang="nl"> → <html lang="en">
  html = html.replace('<html lang="nl">', '<html lang="en">');

  // 2. <title>
  html = html.replace(
    /<title>[^<]+<\/title>/,
    '<title>Organize a Running Dinner – The Easiest Planner | Running Dinner Planner</title>'
  );

  // 3. <meta name="description">
  html = html.replace(
    /<meta name="description" content="[^"]*">/,
    '<meta name="description" content="Built by an organiser, for organisers. From spreadsheet chaos to planning in minutes. Subscription only €5 per year.">'
  );

  // 4. <meta name="keywords">
  html = html.replace(
    /<meta name="keywords" content="[^"]*">/,
    '<meta name="keywords" content="running dinner organise, running dinner planner, progressive dinner, dinner party planner, running dinner tool, running dinner app">'
  );

  // 5. canonical
  html = html.replace(
    /<link rel="canonical" href="https:\/\/runningdinner\.app\/">/,
    '<link rel="canonical" href="https://runningdinner.app/en/">'
  );

  // 6. Open Graph
  html = html.replace(
    /<meta property="og:url" content="https:\/\/runningdinner\.app\/">/,
    '<meta property="og:url" content="https://runningdinner.app/en/">'
  );
  html = html.replace(
    /<meta property="og:title" content="[^"]*">/,
    '<meta property="og:title" content="Running Dinner Planner – From spreadsheet chaos to planning in minutes">'
  );
  html = html.replace(
    /<meta property="og:description" content="[^"]*">/,
    '<meta property="og:description" content="Built by an organiser, for organisers. Everything I ran into is now built in as standard.">'
  );

  // 7. Twitter Card
  html = html.replace(
    /<meta name="twitter:title" content="[^"]*">/,
    '<meta name="twitter:title" content="Running Dinner Planner – From spreadsheet chaos to planning in minutes">'
  );
  html = html.replace(
    /<meta name="twitter:description" content="[^"]*">/,
    '<meta name="twitter:description" content="Built by an organiser. Everything I ran into is now built in as standard. €5 per year.">'
  );

  // 8. Schema.org SoftwareApplication
  html = html.replace(
    '"description": "Organiseer een running dinner moeiteloos. Plan routes, wijs tafels toe en druk enveloppen af."',
    '"description": "Organize a running dinner effortlessly. Plan routes, assign tables and print envelopes."'
  );
  html = html.replace(
    '"url": "https://runningdinner.app/"',
    '"url": "https://runningdinner.app/en/"'
  );
  html = html.replace(
    '"description": "1 jaar abonnement"',
    '"description": "1 year subscription"'
  );

  // 9. FAQ structured data
  html = html.replace(
    '"name": "Wat is een running dinner?"',
    '"name": "What is a running dinner?"'
  );
  html = html.replace(
    '"text": "Een running dinner (ook wel lopend diner of diner en route) is een sociaal evenement waarbij deelnemers elke gang van het diner bij een andere gastheer eten. Zo ontmoet iedereen nieuwe mensen."',
    '"text": "A running dinner (also known as a progressive dinner) is a social event where participants eat each course of the dinner at a different host\'s home. This way everyone meets new people."'
  );
  html = html.replace(
    '"name": "Hoe werkt de Running Dinner Planner?"',
    '"name": "How does the Running Dinner Planner work?"'
  );
  html = html.replace(
    '"text": "Je voert deelnemers in, configureert de gangenstructuur en de planner wijst automatisch tafels en routes toe zodat iedereen zoveel mogelijk nieuwe tafelgenoten ontmoet. Daarna druk je de envelop-kaartjes af."',
    '"text": "You enter participants, configure the course structure and the planner automatically assigns tables and routes so everyone meets as many new tablemates as possible. Then you print the envelope cards."'
  );
  html = html.replace(
    '"name": "Hoeveel kost de Running Dinner Planner?"',
    '"name": "How much does the Running Dinner Planner cost?"'
  );
  html = html.replace(
    '"text": "Het abonnement kost slechts €5 per jaar. Je kunt daarmee onbeperkt evenementen organiseren."',
    '"text": "The subscription costs only €5 per year. You can organize unlimited events with it."'
  );

  homeHtmlEN = html;
  console.log('[boot] English homepage SEO variant generated');
} catch (e) {
  console.warn('[boot] Could not generate English homepage variant:', e.message);
}

// Build Spanish homepage variant at startup (cached in memory for SEO)
let homeHtmlES = null;
try {
  let html = fs.readFileSync(homeHtmlPath, 'utf8');

  // 1. <html lang>
  html = html.replace('<html lang="nl">', '<html lang="es">');

  // 2. <title>
  html = html.replace(
    /<title>[^<]+<\/title>/,
    '<title>Organiza una Cena Itinerante – El Planificador más Sencillo | Running Dinner Planner</title>'
  );

  // 3. <meta description>
  html = html.replace(
    /<meta name="description" content="[^"]*">/,
    '<meta name="description" content="Creado por un organizador, para organizadores. Del caos de hojas de cálculo a la planificación en minutos. Suscripción de solo €5 al año.">'
  );

  // 4. keywords
  html = html.replace(
    /<meta name="keywords" content="[^"]*">/,
    '<meta name="keywords" content="cena itinerante, cena progresiva, organizar cena itinerante, planificador cenas, running dinner español, herramienta cena itinerante">'
  );

  // 5. canonical
  html = html.replace(
    /<link rel="canonical" href="https:\/\/runningdinner\.app\/">/,
    '<link rel="canonical" href="https://runningdinner.app/es/">'
  );

  // 6. Open Graph
  html = html.replace(
    /<meta property="og:url" content="https:\/\/runningdinner\.app\/">/,
    '<meta property="og:url" content="https://runningdinner.app/es/">'
  );
  html = html.replace(
    /<meta property="og:title" content="[^"]*">/,
    '<meta property="og:title" content="Running Dinner Planner – Del caos de hojas de cálculo a la planificación en minutos">'
  );
  html = html.replace(
    /<meta property="og:description" content="[^"]*">/,
    '<meta property="og:description" content="Creado por un organizador, para organizadores. Todo con lo que me topé ya está integrado.">'
  );

  // 7. Twitter Card
  html = html.replace(
    /<meta name="twitter:title" content="[^"]*">/,
    '<meta name="twitter:title" content="Running Dinner Planner – Del caos a la planificación en minutos">'
  );
  html = html.replace(
    /<meta name="twitter:description" content="[^"]*">/,
    '<meta name="twitter:description" content="Creado por un organizador. Todo lo que necesitas está integrado. €5 al año.">'
  );

  // 8. Schema.org SoftwareApplication
  html = html.replace(
    '"description": "Organiseer een running dinner moeiteloos. Plan routes, wijs tafels toe en druk enveloppen af."',
    '"description": "Organiza una cena itinerante sin esfuerzo. Planifica rutas, asigna mesas e imprime sobres."'
  );
  html = html.replace(
    '"url": "https://runningdinner.app/"',
    '"url": "https://runningdinner.app/es/"'
  );
  html = html.replace(
    '"description": "1 jaar abonnement"',
    '"description": "Suscripción de 1 año"'
  );

  // 9. FAQ structured data
  html = html.replace(
    '"name": "Wat is een running dinner?"',
    '"name": "¿Qué es una cena itinerante?"'
  );
  html = html.replace(
    '"text": "Een running dinner (ook wel lopend diner of diner en route) is een sociaal evenement waarbij deelnemers elke gang van het diner bij een andere gastheer eten. Zo ontmoet iedereen nieuwe mensen."',
    '"text": "Una cena itinerante (también llamada cena progresiva) es un evento social donde los participantes cenan cada plato en casa de un anfitrión diferente. Así todos conocen a gente nueva."'
  );
  html = html.replace(
    '"name": "Hoe werkt de Running Dinner Planner?"',
    '"name": "¿Cómo funciona el Running Dinner Planner?"'
  );
  html = html.replace(
    '"text": "Je voert deelnemers in, configureert de gangenstructuur en de planner wijst automatisch tafels en routes toe zodat iedereen zoveel mogelijk nieuwe tafelgenoten ontmoet. Daarna druk je de envelop-kaartjes af."',
    '"text": "Introduces a los participantes, configuras la estructura de los platos y el planificador asigna automáticamente mesas y rutas para que todos conozcan al máximo de nuevos compañeros de mesa. Después imprimes los sobres."'
  );
  html = html.replace(
    '"name": "Hoeveel kost de Running Dinner Planner?"',
    '"name": "¿Cuánto cuesta el Running Dinner Planner?"'
  );
  html = html.replace(
    '"text": "Het abonnement kost slechts €5 per jaar. Je kunt daarmee onbeperkt evenementen organiseren."',
    '"text": "La suscripción cuesta solo €5 al año. Con ella puedes organizar eventos de forma ilimitada."'
  );

  homeHtmlES = html;
  console.log('[boot] Spanish homepage SEO variant generated');
} catch (e) {
  console.warn('[boot] Could not generate Spanish homepage variant:', e.message);
}

// Serve English homepage with SEO-optimized <head>
app.get('/en/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get(['/en', '/en/'], (req, res) => {
  if (homeHtmlEN) {
    res.type('html').send(homeHtmlEN);
  } else {
    res.sendFile(homeHtmlPath);
  }
});
app.get('/en/:page.html', (req, res) => {
  const file = path.join(__dirname, 'public', `${req.params.page}.html`);
  if (fs.existsSync(file)) {
    res.sendFile(file);
  } else {
    res.status(404).sendFile(homeHtmlPath);
  }
});

// Serve Spanish homepage with SEO-optimized <head>
app.get('/es/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get(['/es', '/es/'], (req, res) => {
  if (homeHtmlES) {
    res.type('html').send(homeHtmlES);
  } else {
    res.sendFile(homeHtmlPath);
  }
});
app.get('/es/:page.html', (req, res) => {
  const file = path.join(__dirname, 'public', `${req.params.page}.html`);
  if (fs.existsSync(file)) {
    res.sendFile(file);
  } else {
    res.status(404).sendFile(homeHtmlPath);
  }
});

// ── Blog (preview: drafts zijn niet in de publieke listing) ─────────────────
const BLOG_STYLE = `
  .blog-page { max-width: 780px; margin: 50px auto; padding: 0 20px; font-family: 'Plus Jakarta Sans', system-ui, sans-serif; color: #1E293B; }
  .blog-page h1 { font-size: 2.2rem; letter-spacing: -.02em; margin-bottom: 10px; }
  .blog-page h2 { font-size: 1.4rem; margin: 32px 0 12px; }
  .blog-page h3 { font-size: 1.1rem; margin: 22px 0 8px; font-weight: 700; }
  .blog-page p, .blog-page li { font-size: 1rem; line-height: 1.7; color: #334155; }
  .blog-page ul { margin: 10px 0 10px 22px; }
  .blog-page a { color: #E85D3A; }
  .blog-page code { background: #F1F5F9; padding: 2px 6px; border-radius: 4px; font-size: .88em; }
  .blog-page pre { background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 16px; overflow-x: auto; }
  .blog-meta { color: #94A3B8; font-size: .9rem; margin-bottom: 28px; border-bottom: 1px solid #F1F5F9; padding-bottom: 18px; }
  .blog-nav { margin-bottom: 20px; font-size: .9rem; }
  .blog-nav a { color: #64748B; text-decoration: none; }
  .blog-nav a:hover { color: #E85D3A; }
  .blog-list-item { padding: 24px 0; border-bottom: 1px solid #F1F5F9; }
  .blog-list-item a { color: #1E293B; text-decoration: none; }
  .blog-list-item h3 { font-size: 1.2rem; margin-bottom: 6px; }
  .blog-list-item .desc { color: #64748B; font-size: .95rem; }
  .blog-draft-badge { background: #FEF3C7; color: #92400E; padding: 2px 8px; border-radius: 4px; font-size: .72rem; margin-left: 8px; font-weight: 600; }
`;

function renderBlogShell(title, content, locale) {
  const headerLinks = `<a href="/">← ${locale === 'en' ? 'Back to home' : locale === 'es' ? 'Volver al inicio' : 'Terug naar home'}</a>`;
  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex"><!-- blog preview-only -->
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap">
<style>${BLOG_STYLE}</style>
</head>
<body>
<article class="blog-page">
<div class="blog-nav">${headerLinks}</div>
${content}
</article>
</body>
</html>`;
}

// Public blog listing (only published posts)
app.get('/blog', (req, res) => {
  const locale = req.lang || 'nl';
  const posts = blog.listPublished(locale);
  const listTitle = locale === 'en' ? 'Blog' : locale === 'es' ? 'Blog' : 'Blog';
  const emptyText = locale === 'en' ? 'No posts yet. Come back soon.'
    : locale === 'es' ? 'Aún no hay artículos. Vuelve pronto.'
    : 'Nog geen artikelen. Kom binnenkort terug.';
  let content = `<h1>${listTitle}</h1>`;
  if (!posts.length) {
    content += `<p style="color:#64748B;margin-top:20px">${emptyText}</p>`;
  } else {
    for (const p of posts) {
      content += `
        <div class="blog-list-item">
          <a href="/blog/${p.slug}">
            <h3>${p.title}</h3>
            <p class="desc">${p.description}</p>
          </a>
        </div>`;
    }
  }
  res.type('html').send(renderBlogShell(listTitle, content, locale));
});

// Individual blog post
app.get('/blog/:slug', (req, res) => {
  const locale = req.lang || 'nl';
  const post = blog.getBySlug(req.params.slug, locale);
  if (!post) return res.status(404).type('html').send(renderBlogShell('Not found', '<h1>Not found</h1><p>Dit artikel bestaat niet of is nog niet gepubliceerd.</p>', locale));
  // Admins may preview drafts; everyone else gets 404 on draft
  const isAdminPreview = req.cookies?.token; // crude check: any logged-in user; tighter check below would require verifying the JWT
  if (post.draft && !isAdminPreview) {
    return res.status(404).type('html').send(renderBlogShell('Not found', '<h1>Not found</h1>', locale));
  }
  const html = blog.render(post);
  const meta = `<div class="blog-meta">${post.date || ''} • ${post.author}${post.draft ? ' <span class="blog-draft-badge">DRAFT</span>' : ''}</div>`;
  const content = meta + html;
  res.type('html').send(renderBlogShell(post.title, content, locale));
});

// Admin API: list all posts (including drafts) for content management
app.get('/api/admin/blog', requireAdmin, (req, res) => {
  const posts = blog.listAll().map(({ body, ...rest }) => rest); // omit body for list view
  res.json({ ok: true, posts });
});

// Admin API: toggle draft state
app.put('/api/admin/blog/:filename/draft', requireAdmin, (req, res) => {
  try {
    const { draft } = req.body || {};
    blog.setDraft(req.params.filename, Boolean(draft));
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Segment-landingspagina's (preview: noindex, niet in sitemap) ────────────
['service-clubs', 'verenigingen', 'vriendengroepen'].forEach(slug => {
  app.get('/' + slug, (req, res) => res.sendFile(path.join(__dirname, 'public', slug + '.html')));
  app.get('/en/' + slug, (req, res) => res.sendFile(path.join(__dirname, 'public', slug + '.html')));
  app.get('/es/' + slug, (req, res) => res.sendFile(path.join(__dirname, 'public', slug + '.html')));
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
    SELECT id, email, license_until, language
    FROM users
    WHERE auto_renew = 1
      AND license_until BETWEEN ? AND ?
      AND (renewal_reminder_sent IS NULL OR renewal_reminder_sent < ?)
  `).all(now, reminderWindow, reminderCooldown);

  const priceCents = parseInt(getSetting('subscription_price_cents') || '500', 10);

  for (const user of users) {
    const uLang = user.language || 'nl';
    const uEN = uLang === 'en';
    const locale = uEN ? 'en-GB' : 'nl-NL';
    const renewDate = new Date(user.license_until).toLocaleDateString(locale, {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    try {
      await sendMail(user.email,
        uEN ? 'Your subscription will be renewed soon - Running Dinner Planner' : 'Je abonnement wordt binnenkort verlengd - Running Dinner Planner',
        wrapHtml(`
        <h2 style="color:#1a56db;margin:0 0 16px">Running Dinner Planner</h2>
        <p style="color:#374151;line-height:1.6">${uEN ? 'Hi,' : 'Hallo,'}</p>
        <p style="color:#374151;line-height:1.6">${uEN
          ? `Your subscription will be automatically renewed on <strong>${renewDate}</strong> for <strong>${formatEur(priceCents)}</strong>.`
          : `Je abonnement wordt automatisch verlengd op <strong>${renewDate}</strong> voor <strong>${formatEur(priceCents)}</strong>.`
        }</p>
        <p style="color:#374151;line-height:1.6">${uEN
          ? 'No action needed. Want to disable auto-renewal? You can do so in your profile.'
          : 'Je hoeft niets te doen. Wil je de automatische verlenging uitschakelen? Dat kan in je profiel.'
        }</p>
        <p style="margin:24px 0;text-align:center">
          <a href="${BASE_URL}/profile.html" style="background:#1a56db;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">${uEN ? 'Go to my profile' : 'Naar mijn profiel'}</a>
        </p>
        <p style="color:#6b7280;font-size:13px;line-height:1.5">${uEN
          ? 'You will automatically receive an invoice by email after renewal.'
          : 'Je ontvangt na verlenging automatisch een factuur per e-mail.'
        }</p>
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

// ── Error handling ───────────────────────────────────────────────────────────
// Sentry error-reporter (no-op zonder SENTRY_DSN). Plaats VÓÓR de eigen
// error-handler zodat alle niet-afgehandelde errors worden gerapporteerd.
app.use(sentry.errorHandler());

// Generic fallback error handler — zorgt ervoor dat de client een schone
// JSON-response krijgt ook bij ongecachete exceptions in async routes.
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, '→', err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: err.expose ? err.message : 'Internal server error',
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[${ENV}] Running Dinner Planner server draait op http://localhost:${PORT}`);
});
