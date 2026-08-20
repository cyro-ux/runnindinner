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

  -- Persistent geocoding cache. Address-strings are normalised (trim/lowercase)
  -- before hashing so kleine variaties dezelfde cache-hit geven. Nominatim's
  -- usage policy schrijft serverside-caching voor en deze tabel voorkomt dat
  -- we het rate-limit raken bij meerdere distance-checks in één event.
  CREATE TABLE IF NOT EXISTS geocode_cache (
    address_hash         TEXT PRIMARY KEY,    -- sha1 van genormaliseerde adres-string
    address_normalized   TEXT NOT NULL,
    lat                  REAL NOT NULL,
    lon                  REAL NOT NULL,
    display_name         TEXT,
    created_at           INTEGER NOT NULL
  );
`);

// Gedeelde (digitale) planningen — de digitale envelopkaartjes.
// Adressen van derden staan hier tijdelijk; expires_at (event + 30 dagen)
// wordt door de scheduler opgeruimd. Zie lib/shared-planning.js.
db.exec(`
  CREATE TABLE IF NOT EXISTS shared_plannings (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    event_name    TEXT NOT NULL,
    event_date    TEXT,
    locale        TEXT NOT NULL DEFAULT 'nl',
    courses_json  TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS shared_plannings_user_idx    ON shared_plannings(user_id);
  CREATE INDEX IF NOT EXISTS shared_plannings_expires_idx ON shared_plannings(expires_at);

  CREATE TABLE IF NOT EXISTS shared_planning_participants (
    token        TEXT PRIMARY KEY,
    planning_id  TEXT NOT NULL,
    name         TEXT NOT NULL,
    route_json   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS spp_planning_idx ON shared_planning_participants(planning_id);
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
// Herroepingsrecht-waiver: timestamp waarop de klant bij checkout expliciet
// heeft ingestemd met directe activering en afzien van herroepingsrecht
// (art. 6:230p sub e BW). Dient als bewijs bij eventueel geschil.
if (!userCols.includes('waiver_accepted_at'))     db.exec("ALTER TABLE users ADD COLUMN waiver_accepted_at INTEGER");
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
if (!paymentCols.includes('refunded_at'))      db.exec("ALTER TABLE payments ADD COLUMN refunded_at INTEGER");
if (!paymentCols.includes('credit_note_id'))   db.exec("ALTER TABLE payments ADD COLUMN credit_note_id TEXT");

// Ratings: add moderation columns (status + display name + who moderated)
const ratingCols = db.prepare("PRAGMA table_info(ratings)").all().map(c => c.name);
if (!ratingCols.includes('status'))        db.exec("ALTER TABLE ratings ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
if (!ratingCols.includes('display_name'))  db.exec("ALTER TABLE ratings ADD COLUMN display_name TEXT");
if (!ratingCols.includes('moderated_at'))  db.exec("ALTER TABLE ratings ADD COLUMN moderated_at INTEGER");
if (!ratingCols.includes('moderated_by'))  db.exec("ALTER TABLE ratings ADD COLUMN moderated_by TEXT");

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

// Seed German CMS defaults (formal "Sie", matching Dutch live texts)
cmsDefault.run('hero_title_de', 'Vom Tabellenchaos zur fertigen Planung in Minuten', now);
cmsDefault.run('hero_subtitle_de', 'Nach Jahren eigener Running Dinners mit endlosen Tabellen, doppelten Gästen und falschen Routen habe ich dieses Tool gebaut. Alles, worüber ich stolperte, ist bereits standardmäßig eingebaut.', now);
cmsDefault.run('hero_cta_de', 'Jetzt starten für €5/Jahr', now);
cmsDefault.run('features_intro_de', 'Jede Funktion entstand aus einem Problem, dem ich beim Organisieren begegnet bin. Kein unnötiger Schnickschnack — nur was Sie wirklich brauchen.', now);
cmsDefault.run('price_label_de', '€5 pro Jahr', now);
cmsDefault.run('footer_text_de', 'Aus persönlicher Erfahrung gebaut. Jede Funktion löst ein echtes Problem.', now);

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

/**
 * Dedicated wrapper voor factuur-mails. Toont het runningdinner.app logo in
 * de header en een duidelijk VMH-blok in de footer (KvK, BTW, adres). De
 * Zoho PDF-bijlage is juridisch de factuur — deze e-mail communiceert dat
 * de betaling door VMH B.V. wordt verwerkt (runningdinner.app is een
 * product van VMH).
 */
function wrapInvoiceHtml(body, lang = 'nl') {
  const footerLines = {
    nl: [
      'runningdinner.app is een product van <strong>VMH B.V.</strong>',
      'KvK 08142482 &bull; BTW NL8152.92.715.B01',
      'Hanekerweg 4, 7381 AM Klarenbeek, Nederland',
      '<a href="mailto:info@runningdinner.app" style="color:#6b7280">info@runningdinner.app</a>',
    ],
    en: [
      'runningdinner.app is a product of <strong>VMH B.V.</strong>',
      'Chamber of Commerce 08142482 &bull; VAT NL8152.92.715.B01',
      'Hanekerweg 4, 7381 AM Klarenbeek, The Netherlands',
      '<a href="mailto:info@runningdinner.app" style="color:#6b7280">info@runningdinner.app</a>',
    ],
    es: [
      'runningdinner.app es un producto de <strong>VMH B.V.</strong>',
      'Cámara de Comercio 08142482 &bull; NIF NL8152.92.715.B01',
      'Hanekerweg 4, 7381 AM Klarenbeek, Países Bajos',
      '<a href="mailto:info@runningdinner.app" style="color:#6b7280">info@runningdinner.app</a>',
    ],
    de: [
      'runningdinner.app ist ein Produkt der <strong>VMH B.V.</strong>',
      'Handelskammer 08142482 &bull; USt-IdNr. NL8152.92.715.B01',
      'Hanekerweg 4, 7381 AM Klarenbeek, Niederlande',
      '<a href="mailto:info@runningdinner.app" style="color:#6b7280">info@runningdinner.app</a>',
    ],
  };
  const lines = footerLines[lang] || footerLines.nl;
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
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;max-width:560px;width:100%">
          <tr>
            <td align="center" style="padding:32px 24px 8px 24px">
              <a href="https://runningdinner.app" style="text-decoration:none">
                <img src="https://runningdinner.app/images/runningdinner-logo-email.png" alt="runningdinner.app" width="200" style="width:200px;height:auto;display:block;border:0">
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 32px 24px 32px">
              ${body}
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px;border-top:1px solid #e5e7eb;text-align:center">
              <p style="margin:0;color:#6b7280;font-size:11px;line-height:17px">
                ${lines.join('<br>')}
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
const { escHtml } = require('./lib/html');

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
const EMAIL_LOCALES = { nl: 'nl-NL', en: 'en-GB', es: 'es-ES', de: 'de-DE' };

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
    waiver_heading: 'Bevestiging directe activering & afstand herroepingsrecht',
    waiver_body: (ts) => `Bij het afronden van je abonnement heb je op <strong>${ts}</strong> aangevinkt dat je uitdrukkelijk toestemming geeft voor directe activering van je account, en daarmee bevestigd dat je afziet van het herroepingsrecht zoals bedoeld in artikel 6:230p sub e BW. Deze e-mail dient als bevestiging op een duurzame drager conform BW 6:230v lid 7. Meer informatie op <a href="https://runningdinner.app/herroepingsrecht.html">runningdinner.app/herroepingsrecht.html</a>.`,
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
    waiver_heading: 'Confirmation of immediate activation & waiver of right of withdrawal',
    waiver_body: (ts) => `When completing your subscription you ticked on <strong>${ts}</strong> that you expressly consented to immediate activation of your account, thereby waiving your right of withdrawal as referred to in article 6:230p(e) Dutch Civil Code. This email serves as a confirmation on a durable medium, in line with article 6:230v(7) DCC. Full details at <a href="https://runningdinner.app/herroepingsrecht.html">runningdinner.app/herroepingsrecht.html</a>.`,
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
    waiver_heading: 'Confirmación de activación inmediata y renuncia al derecho de desistimiento',
    waiver_body: (ts) => `Al completar tu suscripción, el <strong>${ts}</strong> marcaste que otorgas consentimiento expreso para la activación inmediata de tu cuenta y con ello renuncias al derecho de desistimiento conforme al artículo 6:230p letra e del Código Civil neerlandés. Este correo sirve como confirmación en un soporte duradero, conforme al artículo 6:230v(7) BW. Más información en <a href="https://runningdinner.app/herroepingsrecht.html">runningdinner.app/herroepingsrecht.html</a>.`,
  },
  de: {
    hi: 'Hallo,',
    thanks: (date) => `Vielen Dank für deine Zahlung! Dein Abonnement ist aktiv bis zum <strong>${date}</strong>.`,
    invoice_number: 'Rechnungsnummer',
    description: 'Beschreibung',
    sub_label: '1 Jahr Abonnement',
    amount: 'Betrag',
    date: 'Datum',
    open_planner: 'Planer öffnen',
    subject: (no) => `Rechnung ${no} - Running Dinner Planner`,
    waiver_heading: 'Bestätigung der sofortigen Aktivierung & Verzicht auf das Widerrufsrecht',
    waiver_body: (ts) => `Beim Abschluss deines Abonnements hast du am <strong>${ts}</strong> angekreuzt, dass du der sofortigen Aktivierung deines Kontos ausdrücklich zustimmst und damit auf dein Widerrufsrecht gemäß Artikel 6:230p Buchstabe e des niederländischen Bürgerlichen Gesetzbuchs (BW) verzichtest. Diese E-Mail dient als Bestätigung auf einem dauerhaften Datenträger gemäß Artikel 6:230v Absatz 7 BW. Weitere Informationen unter <a href="https://runningdinner.app/herroepingsrecht.html">runningdinner.app/herroepingsrecht.html</a>.`,
  },
};

async function sendInvoiceMail(user, payment) {
  const lang = user.language || 'nl';
  const locale = EMAIL_LOCALES[lang] || EMAIL_LOCALES.nl;
  // Onbekende taal: val terug op EN (breedst begrepen), daarna NL.
  const L = INVOICE_LABELS[lang] || INVOICE_LABELS.en || INVOICE_LABELS.nl;
  const untilDate = new Date(user.license_until).toLocaleDateString(locale);

  // Optioneel waiver-bevestigingsblok — uitsluitend als de klant bij checkout
  // expliciet heeft ingestemd met directe activering. Dient als bevestiging
  // op een duurzame drager (BW 6:230v lid 7).
  let waiverBlock = '';
  if (user.waiver_accepted_at) {
    const ts = new Date(user.waiver_accepted_at).toLocaleString(locale);
    waiverBlock = `
          <div style="margin:24px 0;padding:14px 18px;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;font-size:13px;line-height:1.55;color:#78350f">
            <strong style="display:block;margin-bottom:6px">${L.waiver_heading}</strong>
            ${L.waiver_body(ts)}
          </div>`;
  }

  const html = `
          <p style="color:#374151;line-height:1.6;margin:0 0 12px">${L.hi}</p>
          <p style="color:#374151;line-height:1.6;margin:0 0 16px">${L.thanks(untilDate)}</p>
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
          ${waiverBlock}
          <p style="margin:24px 0;text-align:center">
            <a href="${BASE_URL}/app" style="background:#E85D3A;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">${L.open_planner}</a>
          </p>
  `;
  await sendMail(user.email, L.subject(payment.invoice_number), wrapInvoiceHtml(html, lang));
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

// We draaien achter Cloudflare → nginx (loopback) → Express op 127.0.0.1:3000.
// Dat zijn 2 proxy-hops. Zonder 'trust proxy' logt express-rate-limit een
// ValidationError bij elke request met X-Forwarded-For en kan het geen
// correct bron-IP lezen voor rate-limiting.
app.set('trust proxy', 2);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' })); // Mollie webhook sends urlencoded body
app.use(cookieParser());

// ── Language detection middleware ─────────────────────────────────────────────
const SUPPORTED_LANGS = ['nl', 'en', 'es', 'de'];
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
    else if (accept.startsWith('de')) req.lang = 'de';
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
      // Geen inline on*-attributen meer — alles loopt via data-action-delegatie
      // (bewaakt door lib/no-inline-handlers.test.js in de CI-gate).
      scriptSrcAttr: ["'none'"],
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
// De planner leeft op de repo-root, maar express.static op __dirname zelf
// zou óók server.js, lib/ en data/app.db(-wal) — de live database! —
// serveren. Daarom een strikte allowlist van wat de planner-pagina echt
// relatief opvraagt; al het overige valt door naar de 404.
const PLANNER_FILES = new Set(['', 'index.html', 'style.css', ...require('./lib/planner-files')]);
function plannerStatic() {
  const serve = express.static(path.join(__dirname));
  return (req, res, next) => {
    let rel;
    try { rel = decodeURIComponent(req.path).replace(/^\/+/, ''); }
    catch { return next(); }
    if (!PLANNER_FILES.has(rel)) return next();
    serve(req, res, next);
  };
}
app.use('/app', plannerStatic());
app.use('/en/app', plannerStatic());  // English version serves same static files
app.use('/es/app', plannerStatic());  // Spanish version serves same static files
app.use('/de/app', plannerStatic());  // German version serves same static files
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use('/en', express.static(path.join(__dirname, 'public'))); // English public files (CSS, images, lang/)
app.use('/es', express.static(path.join(__dirname, 'public'))); // Spanish public files (CSS, images, lang/)
app.use('/de', express.static(path.join(__dirname, 'public'))); // German public files (CSS, images, lang/)
app.use(express.static(path.join(__dirname, 'public')));

// ── Server-side translations ─────────────────────────────────────────────────
const { t } = require('./lib/server-translations');

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

// Auth-routes: zie routes/auth.js (tranche 5 van de opsplitsing).
app.use(require('./routes/auth')({
  db, t, bcrypt, jwt, JWT_SECRET, crypto, uuidv4, sendMail, wrapHtml,
  BASE_URL, mollie, activeSessions, requireAuth, generateReferralCode,
  IS_PROD, SUPPORTED_LANGS,
}));
// ── Mollie / Payment routes ─────────────────────────────────────────────
app.use(require('./routes/payments')({
  db, mollie, t, requireAuth, priceResolver, BASE_URL, getSetting, formatEur,
  sendMail, wrapHtml, uuidv4, invoiceNumber, sendInvoiceMail,
  checkReferralReward, zohoSync,
}));
// ── Admin-routes: zie routes/admin.js (tranche 6 van de opsplitsing) ────────
const ADMIN_DEPS = {
  db, fs, path, t, requireAdmin, getSetting, sendMail, wrapHtml, bcrypt,
  uuidv4, BASE_URL, activeSessions, sentry, zohoClient, zohoSync, blog,
};
app.use(require('./routes/admin')(ADMIN_DEPS));


// ── Account-routes: zie routes/account.js (tranche 7) ──────────────────────
app.use(require('./routes/account')({
  db, t, requireAuth, uuidv4, bcrypt, mollie, sendMail, wrapHtml,
  activeSessions, generateReferralCode, BASE_URL, SUPPORTED_LANGS,
  PDFDocument, formatEur, invoiceNumber,
}));


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




// ── CMS routes ────────────────────────────────────────────────────────────────

// GET /api/cms  (public, language-aware)
app.get('/api/cms', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM cms').all();
  const all  = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const lang = req.lang || 'nl';
  const LANG_SUFFIXES = ['_en', '_es', '_de'];

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

// ── Distance check (geocode + route via Nominatim/OSRM, DB-gecached) ────────
//
// Berekent reisafstanden tussen host-adressen voor de planning. Gebruikt
// route-calculator.js (Nominatim + OSRM) met een persistente DB-cache laag
// erbovenop, zodat we het Nominatim 1-req/s rate-limit niet halen bij
// herhaalde checks binnen hetzelfde event.
//
// Privacy: alleen door de organisator zelf-ingegeven adressen worden naar
// OSM/OSRM gestuurd. We sturen GEEN namen, e-mails of andere PII mee.
const routeCalc = require('./lib/route-calculator');

function _normalizeAddress(addr) {
  return String(addr || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function _hashAddress(addr) {
  return crypto.createHash('sha1').update(_normalizeAddress(addr)).digest('hex');
}
const GEOCODE_TTL_MS = 90 * 86400000; // 90 dagen — adressen veranderen zelden

async function _geocodeWithCache(address) {
  const norm = _normalizeAddress(address);
  if (!norm) throw new Error('empty address');
  const hash = _hashAddress(norm);

  const cached = db.prepare(
    'SELECT lat, lon, display_name, created_at FROM geocode_cache WHERE address_hash = ?'
  ).get(hash);
  if (cached && (Date.now() - cached.created_at) < GEOCODE_TTL_MS) {
    return { lat: cached.lat, lon: cached.lon, displayName: cached.display_name, cached: true };
  }

  const result = await routeCalc.geocode(norm);
  db.prepare(`
    INSERT OR REPLACE INTO geocode_cache
      (address_hash, address_normalized, lat, lon, display_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(hash, norm, result.lat, result.lon, result.displayName || '', Date.now());
  return { ...result, cached: false };
}

const distanceCheckLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 uur
  max: 20,                  // max 20 calls per uur per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Te veel afstand-checks. Probeer het later opnieuw.' },
});

app.post('/api/distance-check', distanceCheckLimiter, async (req, res) => {
  try {
    const { pairs, profile = 'walking' } = req.body || {};
    if (!Array.isArray(pairs) || pairs.length === 0) {
      return res.status(400).json({ error: 'pairs[] required' });
    }
    if (pairs.length > 200) {
      return res.status(400).json({ error: 'max 200 pairs per call' });
    }
    if (!['driving', 'cycling', 'walking'].includes(profile)) {
      return res.status(400).json({ error: 'invalid profile (driving|cycling|walking)' });
    }

    // Verzamel unieke adressen — minder Nominatim-calls bij overlap
    const uniqueAddresses = new Set();
    for (const p of pairs) {
      if (p.from) uniqueAddresses.add(_normalizeAddress(p.from));
      if (p.to)   uniqueAddresses.add(_normalizeAddress(p.to));
    }

    // Geocode (DB-cache + Nominatim met 1 req/s respect)
    const geo = {};
    let nominatimCallCount = 0;
    for (const addr of uniqueAddresses) {
      try {
        const g = await _geocodeWithCache(addr);
        geo[addr] = g;
        if (!g.cached) {
          nominatimCallCount++;
          // Respect Nominatim policy: 1 req/s tussen non-cached calls
          if (nominatimCallCount > 0) await new Promise(r => setTimeout(r, 1100));
        }
      } catch (err) {
        geo[addr] = { error: err.message };
      }
    }

    // Route per paar
    const results = [];
    for (const pair of pairs) {
      const from = geo[_normalizeAddress(pair.from)];
      const to   = geo[_normalizeAddress(pair.to)];
      if (!from || from.error || !to || to.error) {
        results.push({
          from: pair.from,
          to:   pair.to,
          error: from?.error || to?.error || 'geocode failed',
        });
        continue;
      }
      try {
        const r = await routeCalc.route(from, to, profile);
        results.push({
          from: pair.from,
          to:   pair.to,
          distanceMeters:  r.distanceMeters,
          durationSeconds: r.durationSeconds,
        });
      } catch (err) {
        results.push({ from: pair.from, to: pair.to, error: err.message });
      }
    }

    res.json({ ok: true, profile, pairs: results });
  } catch (err) {
    console.error('[distance-check] error:', err.message);
    res.status(500).json({ error: err.message });
  }
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
  const { score, comment, display_name } = req.body || {};
  const s = parseInt(score, 10);
  if (!s || s < 1 || s > 5) return res.status(400).json({ error: t(req, 'score_1_5') });

  const cleanComment = comment ? String(comment).trim().slice(0, 1000) : null;
  const cleanDisplay = display_name ? String(display_name).trim().slice(0, 80) : null;

  // Check if user already rated (allow max 1 per user to keep it fair)
  const existing = db.prepare('SELECT id FROM ratings WHERE user_id = ?').get(req.user.id);
  if (existing) {
    // Update existing rating — reset status to 'pending' so an edited review
    // goes back through moderation before reappearing on the homepage.
    db.prepare(`
      UPDATE ratings
      SET score = ?, comment = ?, display_name = ?, status = 'pending',
          moderated_at = NULL, moderated_by = NULL, created_at = ?
      WHERE user_id = ?
    `).run(s, cleanComment, cleanDisplay, Date.now(), req.user.id);
    return res.json({ ok: true, message: t(req, 'rating_updated'), updated: true });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO ratings (id, user_id, score, comment, display_name, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, req.user.id, s, cleanComment, cleanDisplay, Date.now());

  res.json({ ok: true, message: t(req, 'thanks_rating') });
});

// GET /api/ratings/mine  (authenticated – get own rating)
app.get('/api/ratings/mine', requireAuth, (req, res) => {
  const rating = db.prepare(
    'SELECT score, comment, display_name, status, created_at FROM ratings WHERE user_id = ?'
  ).get(req.user.id);
  res.json({ ok: true, rating: rating || null });
});

// GET /api/testimonials/public  (publiek – goedgekeurde reviews met comment)
// Alleen reviews met status='approved' EN een non-empty comment worden getoond.
// Sortering: nieuwste eerst. Limiet 24 zodat de homepage niet opblaast.
app.get('/api/testimonials/public', (_req, res) => {
  const rows = db.prepare(`
    SELECT r.score, r.comment, r.display_name, r.created_at, u.country
    FROM ratings r
    JOIN users u ON u.id = r.user_id
    WHERE r.status = 'approved'
      AND r.comment IS NOT NULL
      AND LENGTH(TRIM(r.comment)) > 0
    ORDER BY r.created_at DESC
    LIMIT 24
  `).all();
  res.json({
    ok: true,
    testimonials: rows.map(r => ({
      score:        r.score,
      comment:      r.comment,
      display_name: r.display_name || 'Anoniem',
      country:      r.country || null,
      created_at:   r.created_at,
    })),
  });
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

// ── Newsletter signup ──────────────────────────────────────────────────────────
// Vangt bezoekers die nog niet willen betalen maar wel op de hoogte willen
// blijven. Voegt het e-mailadres toe aan de Brevo-lijst "Nieuwsbrief".
const NEWSLETTER_LIST_ID = parseInt(process.env.NEWSLETTER_LIST_ID, 10) || 3;
const newsletterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 uur
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Te veel aanmeldingen. Probeer het later opnieuw.' },
});
app.post('/api/newsletter', newsletterLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  const brevo = require('./lib/brevo');
  if (!brevo.isConfigured()) {
    // Geen Brevo → toch niet falen voor de bezoeker; log alleen.
    console.warn('[newsletter] Brevo niet geconfigureerd, aanmelding genegeerd:', email);
    return res.json({ ok: true });
  }
  try {
    await brevo.addContactToList({
      email,
      listIds: [NEWSLETTER_LIST_ID],
      attributes: { LANG: (req.lang || 'nl').toUpperCase(), SOURCE: 'homepage' },
    });
    res.json({ ok: true });
  } catch (err) {
    // "Contact already exist" o.i.d. is geen echte fout voor de bezoeker.
    if (/already exist/i.test(err.message)) return res.json({ ok: true });
    console.error('[newsletter] error:', err.message);
    res.status(500).json({ error: 'newsletter_failed' });
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

// ── Gedeelde planningen (digitale envelopkaartjes) ───────────────────────
// De organisator publiceert de planning; elke deelnemer krijgt een token-link
// (/r/:token) waarop het volgende adres pas verschijnt zodra de vorige gang is
// afgelopen. Pure onthul-logica in lib/shared-planning.js (unit-getest).
const sharedPlanning = require('./lib/shared-planning');

// Zelfde toegangsregels als /api/app/access: admin, actieve licentie of grace.
function userHasAccess(userId) {
  const u = db.prepare('SELECT license_until, role, auto_renew FROM users WHERE id = ?').get(userId);
  if (!u) return false;
  const now = Date.now();
  const grace = 7 * 86400000;
  return u.role === 'admin'
    || (u.license_until && u.license_until > now)
    || (u.auto_renew && u.license_until && u.license_until + grace > now);
}

function sharedPlanningLinks(locale, participants) {
  const { shareParticipantSchedule } = require('./lib/whatsapp-share');
  return participants.map(p => {
    const url = `${BASE_URL}/r/${p.token}`;
    return {
      name: p.name,
      url,
      waUrl: shareParticipantSchedule({
        participantName: p.name.split(' ')[0],
        personalUrl: url,
        locale,
      }),
    };
  });
}

// POST /api/plannings/publish — vervangt een eerdere publicatie van deze user
// (max 1 actieve gedeelde planning per account houdt beheer en AVG simpel).
app.post('/api/plannings/publish', requireAuth, (req, res) => {
  if (!userHasAccess(req.user.id)) return res.status(403).json({ error: t(req, 'no_active_sub') });

  let payload;
  try { payload = sharedPlanning.validatePublishPayload(req.body); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  const planningId = uuidv4();
  const now = Date.now();
  const expiresAt = sharedPlanning.computeExpiry(payload.eventDate);

  const publish = db.transaction(() => {
    // Geen ON DELETE CASCADE-afhankelijkheid: expliciet beide tabellen opruimen.
    const old = db.prepare('SELECT id FROM shared_plannings WHERE user_id = ?').all(req.user.id);
    for (const o of old) db.prepare('DELETE FROM shared_planning_participants WHERE planning_id = ?').run(o.id);
    db.prepare('DELETE FROM shared_plannings WHERE user_id = ?').run(req.user.id);

    db.prepare(`
      INSERT INTO shared_plannings (id, user_id, event_name, event_date, locale, courses_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(planningId, req.user.id, payload.eventName, payload.eventDate, payload.locale,
           JSON.stringify(payload.courses), now, expiresAt);

    const ins = db.prepare('INSERT INTO shared_planning_participants (token, planning_id, name, route_json) VALUES (?, ?, ?, ?)');
    return payload.participants.map(pt => {
      const token = uuidv4();
      ins.run(token, planningId, pt.name, JSON.stringify(pt.route));
      return { token, name: pt.name };
    });
  });

  const rows = publish();
  res.json({ ok: true, planningId, expiresAt, links: sharedPlanningLinks(payload.locale, rows) });
});

// GET /api/plannings/mine — actieve publicatie terughalen (na refresh van stap 4)
app.get('/api/plannings/mine', requireAuth, (req, res) => {
  const planning = db.prepare('SELECT * FROM shared_plannings WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.user.id);
  if (!planning) return res.json({ ok: true, planning: null });
  const participants = db.prepare('SELECT token, name FROM shared_planning_participants WHERE planning_id = ?').all(planning.id);
  res.json({
    ok: true,
    planning: {
      id: planning.id,
      eventName: planning.event_name,
      eventDate: planning.event_date,
      expiresAt: planning.expires_at,
      links: sharedPlanningLinks(planning.locale, participants),
    },
  });
});

// DELETE /api/plannings/mine — organisator trekt alle deellinks in
app.delete('/api/plannings/mine', requireAuth, (req, res) => {
  const del = db.transaction(() => {
    const old = db.prepare('SELECT id FROM shared_plannings WHERE user_id = ?').all(req.user.id);
    for (const o of old) db.prepare('DELETE FROM shared_planning_participants WHERE planning_id = ?').run(o.id);
    db.prepare('DELETE FROM shared_plannings WHERE user_id = ?').run(req.user.id);
    return old.length;
  });
  res.json({ ok: true, removed: del() });
});

const { REVEAL_T, renderRevealPage } = require('./lib/reveal-page');

// GET /r/:token — publieke, persoonlijke onthul-pagina van één deelnemer.
// Tokens zijn uuidv4 (122 bits entropie): niet te raden, geen rate-limit nodig.
app.get('/r/:token', (req, res) => {
  const row = db.prepare(`
    SELECT spp.name, spp.route_json, sp.event_name, sp.event_date, sp.locale, sp.courses_json, sp.expires_at
    FROM shared_planning_participants spp
    JOIN shared_plannings sp ON sp.id = spp.planning_id
    WHERE spp.token = ?
  `).get(req.params.token);

  const locale = row?.locale || req.lang || 'nl';
  const R = REVEAL_T[locale] || REVEAL_T.nl;

  if (!row || row.expires_at < Date.now()) {
    return res.status(row ? 410 : 404).type('html')
      .send(renderRevealPage(locale, 'runningdinner.app', `<h1>🤷</h1><p class="sub">${escHtml(R.notfound)}</p>`, null));
  }

  const courses = JSON.parse(row.courses_json);
  const route   = JSON.parse(row.route_json);
  const schedule = sharedPlanning.buildRevealSchedule(courses, row.event_date);
  const revealMap = new Map(schedule.map(x => [x.course, x.revealAt]));
  const timeMap   = new Map(courses.map(c => [c.course, c]));
  const labels    = sharedPlanning.COURSE_LABELS[locale] || sharedPlanning.COURSE_LABELS.nl;
  const now = new Date();

  let nextRevealMs = null;
  const fmtTime = (d) => new Intl.DateTimeFormat(locale === 'nl' ? 'nl-NL' : locale, {
    timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit',
  }).format(d);

  const cards = route.map(item => {
    const c = timeMap.get(item.course);
    const revealAt = revealMap.has(item.course) ? revealMap.get(item.course) : null;
    const revealed = sharedPlanning.isRevealed(revealAt, now);
    const label = labels[item.course] || item.course;
    const icon  = sharedPlanning.COURSE_ICONS[item.course] || '🍽️';
    const timeStr = c ? `${c.time} – ${c.endTime}` : '';

    if (!revealed) {
      if (revealAt && (nextRevealMs === null || revealAt.getTime() < nextRevealMs)) nextRevealMs = revealAt.getTime();
      return `<div class="card locked">
        <div class="course-head"><span class="icon">${icon}</span><span class="name">${escHtml(label)}</span><span class="time">${escHtml(timeStr)}</span></div>
        <div class="lockmsg">🔒 ${escHtml(R.locked)} ${escHtml(fmtTime(revealAt))}</div>
      </div>`;
    }

    let detail = '';
    if (item.isHost) {
      detail += `<span class="hostbadge">${escHtml(R.youhost)}</span>`;
    }
    if (item.isSocial) {
      detail += `<div class="detail">${escHtml(R.together)}${item.address ? ` — <b>${escHtml(item.address)}</b>` : ''}</div>`;
    } else {
      if (!item.isHost && item.hostName) detail += `<div class="detail">${escHtml(R.host)}: <b>${escHtml(item.hostName)}</b></div>`;
      if (item.address) detail += `<div class="detail">${escHtml(R.address)}: <b>${escHtml(item.address)}</b></div>`;
      if (item.companions && item.companions.length) detail += `<div class="detail">${escHtml(R.mates)}: ${escHtml(item.companions.join(', '))}</div>`;
    }

    return `<div class="card">
      <div class="course-head"><span class="icon">${icon}</span><span class="name">${escHtml(label)}</span><span class="time">${escHtml(timeStr)}</span></div>
      ${detail}
    </div>`;
  }).join('');

  const inner = `
  <h1>${escHtml(R.hello)} ${escHtml(row.name)} 👋</h1>
  <p class="sub"><b>${escHtml(row.event_name)}</b> · ${escHtml(row.event_date)}<br>${escHtml(R.intro)}</p>
  ${cards}`;

  res.type('html').send(renderRevealPage(locale, `${row.event_name} — runningdinner.app`, inner, nextRevealMs));
});

// ── Language preference API ──────────────────────────────────────────────────


// ── Sitemap ──────────────────────────────────────────────────────────────────
app.get('/sitemap.xml', (req, res) => {
  const base = 'https://runningdinner.app';
  const today = new Date().toISOString().split('T')[0];

  // Static marketing pages: a fixed lastmod stops Google from seeing
  // "everything changed" on each deploy. Bump this date only when the
  // visible content on these pages is meaningfully changed.
  const STATIC_LASTMOD = '2026-04-21';

  // Pages with NL + EN + ES + DE alternates
  const multilingualPages = [
    { nl: '/',                   en: '/en/',                   es: '/es/',                   de: '/de/',                   priority: '1.0', changefreq: 'weekly' },
    { nl: '/login.html',         en: '/en/login.html',         es: '/es/login.html',         de: '/de/login.html',         priority: '0.6', changefreq: 'monthly' },
    { nl: '/register.html',      en: '/en/register.html',      es: '/es/register.html',      de: '/de/register.html',      priority: '0.7', changefreq: 'monthly' },
    { nl: '/subscribe.html',     en: '/en/subscribe.html',     es: '/es/subscribe.html',     de: '/de/subscribe.html',     priority: '0.7', changefreq: 'monthly' },
    // Segment-landingspagina's (SEO-kritiek voor long-tail keywords per doelgroep)
    { nl: '/service-clubs',      en: '/en/service-clubs',      es: '/es/service-clubs',      de: '/de/service-clubs',      priority: '0.9', changefreq: 'monthly' },
    { nl: '/verenigingen',       en: '/en/verenigingen',       es: '/es/verenigingen',       de: '/de/verenigingen',       priority: '0.9', changefreq: 'monthly' },
    { nl: '/vriendengroepen',    en: '/en/vriendengroepen',    es: '/es/vriendengroepen',    de: '/de/vriendengroepen',    priority: '0.9', changefreq: 'monthly' },
  ];

  const hreflangBlock = (page) => `
    <xhtml:link rel="alternate" hreflang="nl" href="${base}${page.nl}"/>
    <xhtml:link rel="alternate" hreflang="en" href="${base}${page.en}"/>
    <xhtml:link rel="alternate" hreflang="es" href="${base}${page.es}"/>
    <xhtml:link rel="alternate" hreflang="de" href="${base}${page.de}"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${base}${page.nl}"/>`;

  let urls = '';
  for (const page of multilingualPages) {
    for (const lang of ['nl', 'en', 'es', 'de']) {
      urls += `
  <url>
    <loc>${base}${page[lang]}</loc>
    <lastmod>${STATIC_LASTMOD}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>${hreflangBlock(page)}
  </url>`;
    }
  }

  // Blog index — listing itself barely changes; posts are separately timestamped
  urls += `
  <url><loc>${base}/blog</loc><lastmod>${STATIC_LASTMOD}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`;
  for (const lang of ['nl', 'en', 'es', 'de']) {
    for (const post of blog.listPublished(lang)) {
      const path = lang === 'nl' ? `/blog/${post.slug}` : `/${lang}/blog/${post.slug}`;
      const lastmod = post.date || today;
      urls += `
  <url>
    <loc>${base}${path}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
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

  // Demo-link wijzen naar de Engelse demo zodat de demo in de juiste taal start
  html = html.replace(/href="\/demo"/g, 'href="/en/demo"');
  // Segment-landingspagina's taal-prefixen (Voor wie?-sectie + footer)
  html = html.replace(/href="\/(verenigingen|service-clubs|vriendengroepen)"/g, 'href="/en/$1"');

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

  // Demo-link wijzen naar de Spaanse demo
  html = html.replace(/href="\/demo"/g, 'href="/es/demo"');
  // Segment-landingspagina's taal-prefixen (Voor wie?-sectie + footer)
  html = html.replace(/href="\/(verenigingen|service-clubs|vriendengroepen)"/g, 'href="/es/$1"');

  homeHtmlES = html;
  console.log('[boot] Spanish homepage SEO variant generated');
} catch (e) {
  console.warn('[boot] Could not generate Spanish homepage variant:', e.message);
}

// ── German homepage SEO variant (built at boot, cached in memory) ──────────
let homeHtmlDE = null;
try {
  let html = fs.readFileSync(homeHtmlPath, 'utf8');

  // 1. <html lang>
  html = html.replace('<html lang="nl">', '<html lang="de">');

  // 2. <title>
  html = html.replace(
    /<title>[^<]+<\/title>/,
    '<title>Running Dinner organisieren – Der einfachste Planer | Running Dinner Planner</title>'
  );

  // 3. <meta description>
  html = html.replace(
    /<meta name="description" content="[^"]*">/,
    '<meta name="description" content="Von einem Organisator für Organisatoren entwickelt. Vom Tabellenchaos zur fertigen Planung in Minuten. Abonnement für nur €5 pro Jahr.">'
  );

  // 4. keywords
  html = html.replace(
    /<meta name="keywords" content="[^"]*">/,
    '<meta name="keywords" content="running dinner, laufendes dinner, progressive dinner, running dinner organisieren, running dinner planen, running dinner app">'
  );

  // 5. canonical
  html = html.replace(
    /<link rel="canonical" href="https:\/\/runningdinner\.app\/">/,
    '<link rel="canonical" href="https://runningdinner.app/de/">'
  );

  // 6. Open Graph
  html = html.replace(
    /<meta property="og:url" content="https:\/\/runningdinner\.app\/">/,
    '<meta property="og:url" content="https://runningdinner.app/de/">'
  );
  html = html.replace(
    /<meta property="og:title" content="[^"]*">/,
    '<meta property="og:title" content="Running Dinner Planner – Vom Tabellenchaos zur Planung in Minuten">'
  );
  html = html.replace(
    /<meta property="og:description" content="[^"]*">/,
    '<meta property="og:description" content="Von einem Organisator für Organisatoren. Alles, worüber ich stolperte, ist bereits integriert.">'
  );

  // 7. Twitter Card
  html = html.replace(
    /<meta name="twitter:title" content="[^"]*">/,
    '<meta name="twitter:title" content="Running Dinner Planner – Vom Chaos zur Planung in Minuten">'
  );
  html = html.replace(
    /<meta name="twitter:description" content="[^"]*">/,
    '<meta name="twitter:description" content="Von einem Organisator entwickelt. Alles, was Sie brauchen, ist integriert. €5 pro Jahr.">'
  );

  // 8. Schema.org SoftwareApplication
  html = html.replace(
    '"description": "Organiseer een running dinner moeiteloos. Plan routes, wijs tafels toe en druk enveloppen af."',
    '"description": "Organisieren Sie ein Running Dinner mühelos. Planen Sie Routen, weisen Sie Tische zu und drucken Sie Umschläge."'
  );
  html = html.replace(
    '"url": "https://runningdinner.app/"',
    '"url": "https://runningdinner.app/de/"'
  );
  html = html.replace(
    '"description": "1 jaar abonnement"',
    '"description": "1 Jahr Abonnement"'
  );

  // 9. FAQ structured data
  html = html.replace(
    '"name": "Wat is een running dinner?"',
    '"name": "Was ist ein Running Dinner?"'
  );
  html = html.replace(
    '"text": "Een running dinner (ook wel lopend diner of diner en route) is een sociaal evenement waarbij deelnemers elke gang van het diner bij een andere gastheer eten. Zo ontmoet iedereen nieuwe mensen."',
    '"text": "Ein Running Dinner (auch Laufendes Dinner oder Progressive Dinner genannt) ist eine gesellige Veranstaltung, bei der die Teilnehmer jeden Gang bei einem anderen Gastgeber einnehmen. So lernen alle neue Leute kennen."'
  );
  html = html.replace(
    '"name": "Hoe werkt de Running Dinner Planner?"',
    '"name": "Wie funktioniert der Running Dinner Planner?"'
  );
  html = html.replace(
    '"text": "Je voert deelnemers in, configureert de gangenstructuur en de planner wijst automatisch tafels en routes toe zodat iedereen zoveel mogelijk nieuwe tafelgenoten ontmoet. Daarna druk je de envelop-kaartjes af."',
    '"text": "Sie geben Teilnehmer ein, konfigurieren die Gangstruktur, und der Planer weist automatisch Tische und Routen zu, sodass jeder so viele neue Tischgäste wie möglich trifft. Anschließend drucken Sie die Umschlag-Karten."'
  );
  html = html.replace(
    '"name": "Hoeveel kost de Running Dinner Planner?"',
    '"name": "Wie viel kostet der Running Dinner Planner?"'
  );
  html = html.replace(
    '"text": "Het abonnement kost slechts €5 per jaar. Je kunt daarmee onbeperkt evenementen organiseren."',
    '"text": "Das Abonnement kostet nur €5 pro Jahr. Damit können Sie unbegrenzt Events organisieren."'
  );

  // Demo-link wijzen naar de Duitse demo
  html = html.replace(/href="\/demo"/g, 'href="/de/demo"');
  // Segment-landingspagina's taal-prefixen (Voor wie?-sectie + footer)
  html = html.replace(/href="\/(verenigingen|service-clubs|vriendengroepen)"/g, 'href="/de/$1"');

  homeHtmlDE = html;
  console.log('[boot] German homepage SEO variant generated');
} catch (e) {
  console.warn('[boot] Could not generate German homepage variant:', e.message);
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

// Serve German homepage with SEO-optimized <head>
app.get('/de/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get(['/de', '/de/'], (req, res) => {
  if (homeHtmlDE) {
    res.type('html').send(homeHtmlDE);
  } else {
    res.sendFile(homeHtmlPath);
  }
});
app.get('/de/:page.html', (req, res) => {
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
  .blog-page table { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: .94rem; }
  .blog-page th, .blog-page td { border: 1px solid #E2E8F0; padding: 8px 12px; text-align: left; vertical-align: top; }
  .blog-page th { background: #F8FAFC; font-weight: 600; }
  .blog-page tr:nth-child(even) td { background: #FCFCFD; }
  .blog-page hr { border: none; border-top: 1px solid #E2E8F0; margin: 28px 0; }
  .blog-page li.task { list-style: none; margin-left: -20px; }
  .blog-page li.task input[type=checkbox] { margin-right: 8px; }
  .blog-header { max-width: 780px; margin: 32px auto 0; padding: 0 20px; }
  .blog-header a { display: inline-block; text-decoration: none; }
  .blog-header img { display: block; height: auto; max-width: 200px; }
  .blog-page { margin-top: 24px; }
  .blog-related { max-width: 780px; margin: 48px auto 60px; padding: 24px; background: #FFFBF7; border-radius: 12px; border: 1px solid #FDE5D0; }
  .blog-related h2 { font-size: 1.15rem; margin: 0 0 16px; color: #1E293B; }
  .blog-related ul { list-style: none; margin: 0; padding: 0; }
  .blog-related li { padding: 10px 0; border-bottom: 1px solid #FDE5D0; }
  .blog-related li:last-child { border-bottom: none; }
  .blog-related li a { color: #E85D3A; font-weight: 600; text-decoration: none; font-size: .98rem; }
  .blog-related li a:hover { text-decoration: underline; }
  .blog-related .related-desc { color: #64748B; font-size: .88rem; font-weight: 400; line-height: 1.5; display: inline-block; margin-top: 2px; }
`;

function renderBlogShell(title, content, locale, opts = {}) {
  const headerLinks = `<a href="/">← ${locale === 'en' ? 'Back to home' : locale === 'es' ? 'Volver al inicio' : locale === 'de' ? 'Zurück zur Startseite' : 'Terug naar home'}</a>`;
  const robots = opts.noindex
    ? '<meta name="robots" content="noindex,nofollow">'
    : '<meta name="robots" content="index,follow">';
  const descMeta = opts.description
    ? `<meta name="description" content="${opts.description.replace(/"/g, '&quot;')}">`
    : '';
  const canonical = opts.canonical
    ? `<link rel="canonical" href="${opts.canonical}">`
    : '';
  // Logo-URL is taal-agnostisch; op niet-NL serves wordt het bestand
  // via /en|/es|/de-prefix static mount bereikt, maar direct pad werkt altijd.
  const logoHeader = `<header class="blog-header"><a href="/" aria-label="runningdinner.app"><img src="/images/runningdinner-logo-email.png" alt="runningdinner.app" width="200" height="50"></a></header>`;

  // Helper: locale → og:locale code
  const ogLocaleCode = locale === 'nl' ? 'nl_NL' : locale === 'en' ? 'en_GB' : locale === 'es' ? 'es_ES' : locale === 'de' ? 'de_DE' : 'nl_NL';

  // BlogPosting JSON-LD voor rich snippets (datum, auteur, leestijd) in
  // Google search-resultaten. Alleen genereren voor ECHTE posts
  // (opts.post aanwezig), niet voor de blog-listing of 404-pagina.
  let jsonLd = '';
  let ogTags = '';
  if (opts.post && !opts.noindex) {
    const p = opts.post;
    const fallbackImg = 'https://runningdinner.app/images/screenshot-planning.jpg';
    const imgUrl = p.image || fallbackImg;
    const pageUrl = opts.canonical || `https://runningdinner.app/blog/${p.slug}`;
    // Google Rich Results Test eist ISO 8601 datetime mét tijdzone.
    // Frontmatter-datum is YYYY-MM-DD — we appenden 08:00 Amsterdam-tijd
    // zodat de datum/tijd valid is en consistent across deploys.
    const isoDate = p.date ? `${p.date}T08:00:00+02:00` : '';
    const ld = {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: p.title,
      description: p.description || '',
      image: imgUrl,
      author: {
        '@type': 'Person',
        name: p.author || 'Cyro van Malsen',
        url: 'https://runningdinner.app/',
      },
      publisher: {
        '@type': 'Organization',
        name: 'Running Dinner Planner',
        logo: { '@type': 'ImageObject', url: 'https://runningdinner.app/images/runningdinner-logo-email.png' },
      },
      datePublished: isoDate,
      dateModified: isoDate,
      mainEntityOfPage: { '@type': 'WebPage', '@id': pageUrl },
      inLanguage: locale,
      keywords: p.keywords || '',
    };
    jsonLd = `<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
    // Open Graph + Twitter Card zodat blog-shares op Facebook/LinkedIn/X
    // rijke previews tonen met titel, beschrijving en afbeelding.
    ogTags = `
<meta property="og:type" content="article">
<meta property="og:title" content="${String(p.title).replace(/"/g, '&quot;')}">
<meta property="og:description" content="${String(p.description || '').replace(/"/g, '&quot;')}">
<meta property="og:image" content="${imgUrl}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:locale" content="${ogLocaleCode}">
<meta property="og:site_name" content="Running Dinner Planner">
<meta property="article:published_time" content="${p.date || ''}">
<meta property="article:author" content="${p.author || 'Cyro van Malsen'}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${String(p.title).replace(/"/g, '&quot;')}">
<meta name="twitter:description" content="${String(p.description || '').replace(/"/g, '&quot;')}">
<meta name="twitter:image" content="${imgUrl}">`;
  } else if (!opts.noindex && (opts.canonical || opts.description)) {
    // Generic website OG tags voor blog-listing en andere niet-post pages.
    const fallbackImg = 'https://runningdinner.app/images/screenshot-planning.jpg';
    const ogTitle = String(title).replace(/"/g, '&quot;');
    const ogDesc  = String(opts.description || '').replace(/"/g, '&quot;');
    const pageUrl = opts.canonical || '';
    ogTags = `
<meta property="og:type" content="website">
<meta property="og:title" content="${ogTitle}">
<meta property="og:description" content="${ogDesc}">
<meta property="og:image" content="${fallbackImg}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:locale" content="${ogLocaleCode}">
<meta property="og:site_name" content="Running Dinner Planner">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${ogTitle}">
<meta name="twitter:description" content="${ogDesc}">
<meta name="twitter:image" content="${fallbackImg}">`;
  }

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${robots}
${descMeta}
${canonical}${ogTags}
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap">
<style>${BLOG_STYLE}</style>
${jsonLd}
</head>
<body>
${logoHeader}
<article class="blog-page">
<div class="blog-nav">${headerLinks}</div>
${content}
</article>
</body>
</html>`;
}

// Public blog listing (only published posts)
app.get(['/blog', '/en/blog', '/es/blog', '/de/blog'], (req, res) => {
  const locale = req.lang || 'nl';
  const prefix = locale === 'nl' ? '/blog' : `/${locale}/blog`;
  const posts = blog.listPublished(locale);
  const listTitle = 'Blog';
  const emptyText = locale === 'en' ? 'No posts yet. Come back soon.'
    : locale === 'es' ? 'Aún no hay artículos. Vuelve pronto.'
    : locale === 'de' ? 'Noch keine Artikel. Schauen Sie bald wieder vorbei.'
    : 'Nog geen artikelen. Kom binnenkort terug.';
  let content = `<h1>${listTitle}</h1>`;
  if (!posts.length) {
    content += `<p style="color:#64748B;margin-top:20px">${emptyText}</p>`;
  } else {
    for (const p of posts) {
      content += `
        <div class="blog-list-item">
          <a href="${prefix}/${p.slug}">
            <h3>${p.title}</h3>
            <p class="desc">${p.description}</p>
          </a>
        </div>`;
    }
  }
  res.type('html').send(renderBlogShell(listTitle, content, locale, {
    canonical: `https://runningdinner.app${prefix}`,
    description: locale === 'en' ? 'Running Dinner Planner blog — tips and guides for organisers.'
      : locale === 'es' ? 'Blog de Running Dinner Planner — consejos y guías para organizadores.'
      : locale === 'de' ? 'Running Dinner Planner Blog — Tipps und Anleitungen für Organisatoren.'
      : 'Running Dinner Planner blog — tips en gidsen voor organisatoren.',
  }));
});

// Individual blog post
app.get(['/blog/:slug', '/en/blog/:slug', '/es/blog/:slug', '/de/blog/:slug'], (req, res) => {
  const locale = req.lang || 'nl';
  const prefix = locale === 'nl' ? '/blog' : `/${locale}/blog`;
  const post = blog.getBySlug(req.params.slug, locale);
  if (!post) return res.status(404).type('html').send(renderBlogShell('Not found', '<h1>Not found</h1><p>Dit artikel bestaat niet of is nog niet gepubliceerd.</p>', locale, { noindex: true }));
  // Admins may preview drafts; everyone else gets 404 on draft
  const isAdminPreview = req.cookies?.token; // crude check: any logged-in user; tighter check below would require verifying the JWT
  if (post.draft && !isAdminPreview) {
    return res.status(404).type('html').send(renderBlogShell('Not found', '<h1>Not found</h1>', locale, { noindex: true }));
  }
  const html = blog.render(post);
  const meta = `<div class="blog-meta">${post.date || ''} • ${post.author}${post.draft ? ' <span class="blog-draft-badge">DRAFT</span>' : ''}</div>`;

  // Related posts voor internal linking (SEO). Keyword-overlap-gebaseerd,
  // same-locale, top 3. Versterkt topical authority voor pillar/spokes.
  let relatedBlock = '';
  if (!post.draft) {
    const related = blog.getRelated(post.slug, locale, 3);
    if (related.length) {
      const relatedLabel = locale === 'en' ? 'Related reading'
                        : locale === 'es' ? 'Sigue leyendo'
                        : locale === 'de' ? 'Das könnte Sie auch interessieren'
                        : 'Lees ook';
      const items = related.map(r =>
        `<li><a href="${prefix}/${r.slug}">${r.title}</a>${r.description ? `<br><span class="related-desc">${r.description}</span>` : ''}</li>`
      ).join('');
      relatedBlock = `
<aside class="blog-related">
  <h2>${relatedLabel}</h2>
  <ul>${items}</ul>
</aside>`;
    }
  }

  const content = meta + html + relatedBlock;
  res.type('html').send(renderBlogShell(post.title, content, locale, {
    noindex:     post.draft,   // drafts noindex; publicaties indexeerbaar
    canonical:   `https://runningdinner.app${prefix}/${post.slug}`,
    description: post.description || '',
    post,                      // voor BlogPosting JSON-LD + OG-tags
  }));
});

// Admin API: list all posts (including drafts) for content management


// ── Segment-landingspagina's (meertalig + indexeerbaar) ─────────────────────
// Bij boot bouwen we per (slug × taal) een HTML-variant met correcte
// <title>, <meta description>, <html lang>, canonical — en zonder noindex.
// Content-vertalingen komen client-side via data-i18n + lang/{locale}.json.
const SEGMENT_SLUGS = ['service-clubs', 'verenigingen', 'vriendengroepen'];
const SEGMENT_TO_I18N_KEY = {
  'service-clubs':   'clubs',
  'verenigingen':    'verenigingen',
  'vriendengroepen': 'vrienden',
};
const segmentHtmlCache = {}; // key: `${slug}:${locale}` → html

try {
  const langJSONs = {};
  for (const l of SUPPORTED_LANGS) {
    try { langJSONs[l] = require(`./public/lang/${l}.json`); } catch { langJSONs[l] = {}; }
  }

  for (const slug of SEGMENT_SLUGS) {
    const srcPath = path.join(__dirname, 'public', `${slug}.html`);
    let src;
    try { src = fs.readFileSync(srcPath, 'utf8'); }
    catch (e) { console.warn(`[boot] segment source not readable: ${slug}.html (${e.message})`); continue; }

    // Strip the noindex meta (+ optional HTML comment after it) eenmalig.
    // We laten het bestand op disk intact — alleen de in-memory cache is public.
    const baseHtml = src.replace(/<meta name="robots" content="noindex"[^>]*>(<!--[^>]*-->)?\s*\n?/g, '');

    for (const locale of SUPPORTED_LANGS) {
      let html = baseHtml;
      const segKey = SEGMENT_TO_I18N_KEY[slug];
      const seg    = langJSONs[locale]?.segment?.[segKey];

      // <html lang="nl"> → correct locale
      html = html.replace('<html lang="nl">', `<html lang="${locale}">`);

      // Vervang <title> en <meta description> met locale-specifieke SEO-tekst.
      // Voor NL blijft de NL-default (geen seo_title in nl.json).
      if (seg?.seo_title) {
        html = html.replace(/<title>[^<]+<\/title>/, `<title>${seg.seo_title}</title>`);
      }
      if (seg?.seo_description) {
        html = html.replace(/<meta name="description" content="[^"]*">/,
          `<meta name="description" content="${String(seg.seo_description).replace(/"/g, '&quot;')}">`);
      }

      // Canonical: /slug voor NL, /{locale}/slug voor andere talen
      const canonicalPath = locale === 'nl' ? `/${slug}` : `/${locale}/${slug}`;
      const canonicalUrl  = `https://runningdinner.app${canonicalPath}`;
      // Voeg canonical toe vlak voor </head> als die er nog niet staat
      if (!/<link[^>]+rel="canonical"/.test(html)) {
        html = html.replace('</head>',
          `  <link rel="canonical" href="${canonicalUrl}">\n</head>`);
      }

      // Open Graph + Twitter Card voor social shares. Title/description
      // komen uit seg.seo_title / seg.seo_description (of NL-defaults via
      // de al-aanwezige <title> en description tags — we extracten ze).
      if (!/<meta\s+property="og:/.test(html)) {
        const titleMatch = html.match(/<title>([^<]+)<\/title>/);
        const descMatch  = html.match(/<meta name="description" content="([^"]*)">/);
        const ogTitle    = (seg?.seo_title || titleMatch?.[1] || '').replace(/"/g, '&quot;');
        const ogDesc     = (seg?.seo_description || descMatch?.[1] || '').replace(/"/g, '&quot;');
        const ogLocale   = locale === 'nl' ? 'nl_NL' : locale === 'en' ? 'en_GB' : locale === 'es' ? 'es_ES' : 'de_DE';
        const ogBlock = `
  <meta property="og:type" content="website">
  <meta property="og:title" content="${ogTitle}">
  <meta property="og:description" content="${ogDesc}">
  <meta property="og:image" content="https://runningdinner.app/images/screenshot-planning.jpg">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:locale" content="${ogLocale}">
  <meta property="og:site_name" content="Running Dinner Planner">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${ogTitle}">
  <meta name="twitter:description" content="${ogDesc}">
  <meta name="twitter:image" content="https://runningdinner.app/images/screenshot-planning.jpg">`;
        html = html.replace('</head>', `${ogBlock}\n</head>`);
      }

      segmentHtmlCache[`${slug}:${locale}`] = html;
    }
  }
  console.log(`[boot] Segment SEO variants generated for ${SEGMENT_SLUGS.length} pages × ${SUPPORTED_LANGS.length} locales`);
} catch (e) {
  console.warn('[boot] Could not generate segment SEO variants:', e.message);
}

function sendSegmentPage(slug, locale, res) {
  const html = segmentHtmlCache[`${slug}:${locale}`];
  if (html) {
    res.type('html').send(html);
  } else {
    // Fallback: serve de originele NL-file (geen SEO-override, werkt nog wel)
    res.sendFile(path.join(__dirname, 'public', `${slug}.html`));
  }
}

SEGMENT_SLUGS.forEach(slug => {
  app.get('/' + slug,          (req, res) => sendSegmentPage(slug, 'nl', res));
  app.get('/en/' + slug,       (req, res) => sendSegmentPage(slug, 'en', res));
  app.get('/es/' + slug,       (req, res) => sendSegmentPage(slug, 'es', res));
  app.get('/de/' + slug,       (req, res) => sendSegmentPage(slug, 'de', res));
});

// ── Demo (publiek toegankelijk) ───────────────────────────────────────────────
// Serveert dezelfde index.html, maar /demo-mode.js detecteert het URL-pad en
// schakelt sample-data + paywall-modus aan. Geen auth, geen DB, geen schade.
//
// Belangrijk: zelfde patroon als /app gebruiken (plannerStatic — allowlist
// over express.static op __dirname), zodat /demo automatisch 301-redirect
// naar /demo/ doet en relatieve URLs (style.css, app.js, /lang/*) correct
// resolven, zonder de rest van de repo te exposen.
app.use('/demo',     plannerStatic());
app.use('/en/demo',  plannerStatic());
app.use('/es/demo',  plannerStatic());
app.use('/de/demo',  plannerStatic());

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

// ── Error handling ───────────────────────────────────────────────────────────

const { renderErrorPage } = require('./lib/error-page');
app.use(sentry.errorHandler());

// 404 catch-all — alle routes die tot hier komen bestaan niet. API-calls
// krijgen JSON, andere paden krijgen een branded HTML-pagina in de juiste taal.
app.use((req, res) => {
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  const locale = req.lang || 'nl';
  res.status(404).type('html').send(renderErrorPage(404, locale));
});

// Generic fallback error handler — zorgt ervoor dat client een nette
// response krijgt bij ongecachete exceptions in async routes.
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, '→', err.message);
  if (res.headersSent) return next(err);
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(err.status || 500).json({
      error: err.expose ? err.message : 'Internal server error',
    });
  }
  const locale = req.lang || 'nl';
  res.status(err.status || 500).type('html').send(renderErrorPage(err.status || 500, locale));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[${ENV}] Running Dinner Planner server draait op http://localhost:${PORT}`);
});
