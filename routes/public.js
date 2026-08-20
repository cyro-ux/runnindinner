/**
 * Publieke en overige API-routes: CMS, afstandscheck (Nominatim/OSRM,
 * DB-gecached), planningteller, prijzen, homepage-stats, ratings en
 * testimonials, contactformulier, nieuwsbrief, app-toegang en de
 * gedeelde planningen (digitale envelopkaartjes, incl. /r/:token).
 * Factory met dependency-injection (tranche 8); async handlers in
 * asyncHandler.
 */
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { asyncHandler } = require('../lib/async-handler');

module.exports = function publicRoutes(deps) {
  const {
    db, t, uuidv4, sendMail, wrapHtml, BASE_URL, requireAuth, requireAdmin,
    getSetting, escHtml, priceResolver, crypto,
  } = deps;
  const router = express.Router();

// ── CMS routes ────────────────────────────────────────────────────────────────

// GET /api/cms  (public, language-aware)
router.get('/api/cms', (req, res) => {
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
const routeCalc = require('../lib/route-calculator');

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

router.post('/api/distance-check', distanceCheckLimiter, asyncHandler(async (req, res) => {
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
}));

// PUT /api/cms  (admin only)
router.put('/api/cms', requireAdmin, (req, res) => {
  const data = req.body || {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') setCmsValue(key, value);
  }
  res.json({ ok: true });
});

// POST /api/cms/photo  (admin only) – expects { key: string, dataUrl: string }
router.post('/api/cms/photo', requireAdmin, (req, res) => {
  const { key, dataUrl } = req.body || {};
  if (!key || !dataUrl) return res.status(400).json({ error: t(req, 'key_dataurl_req') });
  // Store as data URL in CMS (simple approach; swap for file upload in production)
  setCmsValue(key, dataUrl);
  res.json({ ok: true });
});



// ── Planning counter ──────────────────────────────────────────────────────────

// GET /api/planning-count  (public – for website counter widget)
router.get('/api/planning-count', (req, res) => {
  const count = parseInt(getSetting('planning_counter') || '0', 10);
  res.json({ ok: true, count });
});

// POST /api/planning-count/increment  (requires license – called from planner app)
router.post('/api/planning-count/increment', requireAuth, (req, res) => {
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
router.get('/api/pricing', (req, res) => {
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
router.post('/api/pricing/preference', (req, res) => {
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
router.get('/api/public/stats', (req, res) => {
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
router.post('/api/ratings', requireAuth, (req, res) => {
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
router.get('/api/ratings/mine', requireAuth, (req, res) => {
  const rating = db.prepare(
    'SELECT score, comment, display_name, status, created_at FROM ratings WHERE user_id = ?'
  ).get(req.user.id);
  res.json({ ok: true, rating: rating || null });
});

// GET /api/testimonials/public  (publiek – goedgekeurde reviews met comment)
// Alleen reviews met status='approved' EN een non-empty comment worden getoond.
// Sortering: nieuwste eerst. Limiet 24 zodat de homepage niet opblaast.
router.get('/api/testimonials/public', (_req, res) => {
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
router.post('/api/contact', asyncHandler(async (req, res) => {
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
}));

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
router.post('/api/newsletter', newsletterLimiter, asyncHandler(async (req, res) => {
  const email = String(req.body?.email || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  const brevo = require('../lib/brevo');
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
}));

// ── App access check ──────────────────────────────────────────────────────────

// GET /api/app/access  – check if user may use the planner
router.get('/api/app/access', requireAuth, (req, res) => {
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
const sharedPlanning = require('../lib/shared-planning');

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
  const { shareParticipantSchedule } = require('../lib/whatsapp-share');
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
router.post('/api/plannings/publish', requireAuth, (req, res) => {
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
router.get('/api/plannings/mine', requireAuth, (req, res) => {
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
router.delete('/api/plannings/mine', requireAuth, (req, res) => {
  const del = db.transaction(() => {
    const old = db.prepare('SELECT id FROM shared_plannings WHERE user_id = ?').all(req.user.id);
    for (const o of old) db.prepare('DELETE FROM shared_planning_participants WHERE planning_id = ?').run(o.id);
    db.prepare('DELETE FROM shared_plannings WHERE user_id = ?').run(req.user.id);
    return old.length;
  });
  res.json({ ok: true, removed: del() });
});

const { REVEAL_T, renderRevealPage } = require('../lib/reveal-page');

// GET /r/:token — publieke, persoonlijke onthul-pagina van één deelnemer.
// Tokens zijn uuidv4 (122 bits entropie): niet te raden, geen rate-limit nodig.
router.get('/r/:token', (req, res) => {
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

  return router;
};
