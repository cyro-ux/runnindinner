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
      // Geen inline <script> meer — alles staat in externe bestanden
      // (bewaakt door lib/no-inline-handlers.test.js in de CI-gate).
      scriptSrc: ["'self'", "https://js.mollie.com"],
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
const PLANNER_FILES = new Set(['', 'index.html', 'style.css', 'js/page-boot.js', ...require('./lib/planner-files')]);
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




// ── Publieke + overige API-routes: zie routes/public.js (tranche 8) ────────
app.use(require('./routes/public')({
  db, t, uuidv4, sendMail, wrapHtml, BASE_URL, requireAuth, requireAdmin,
  getSetting, escHtml, priceResolver, crypto,
}));
// ── Content-/SEO-routes: zie routes/pages.js (tranche 9) ───────────────────
app.use(require('./routes/pages')({ ROOT: __dirname, fs, path, blog, SUPPORTED_LANGS }));
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
