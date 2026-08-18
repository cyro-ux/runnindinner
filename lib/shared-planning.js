/**
 * Gedeelde (digitale) planningen — de "digitale envelopkaartjes".
 *
 * De organisator publiceert de planning; elke deelnemer krijgt een
 * token-link (/r/:token) waarop het volgende adres pas wordt onthuld
 * zodra de vorige gang is afgelopen — het digitale equivalent van
 * "open de envelop aan het einde van dit gerecht".
 *
 * Dit bestand bevat uitsluitend pure logica (geen DB, geen Express),
 * zodat de onthul-berekening unit-testbaar is. Tijden zijn wandklok
 * Europe/Amsterdam, omgezet via amsterdamTime() uit ical.js — zelfde
 * les als de .ics-tijdzone-bug: nooit op servertijd vertrouwen.
 */
'use strict';

const { amsterdamTime } = require('./ical');

const MAX_PARTICIPANTS = 200;
const MAX_NAME_LEN     = 200;
const MAX_ADDR_LEN     = 300;
const COURSE_KEYS = ['voorborrel', 'voorgerecht', 'hoofdgerecht', 'nagerecht', 'naborrel'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Gang-labels voor de onthul-pagina, per taal.
const COURSE_LABELS = {
  nl: { voorborrel: 'Voorborrel', voorgerecht: 'Voorgerecht', hoofdgerecht: 'Hoofdgerecht', nagerecht: 'Nagerecht', naborrel: 'Naborrel' },
  en: { voorborrel: 'Pre-dinner drinks', voorgerecht: 'Starter', hoofdgerecht: 'Main course', nagerecht: 'Dessert', naborrel: 'After-party drinks' },
  es: { voorborrel: 'Aperitivo previo', voorgerecht: 'Entrante', hoofdgerecht: 'Plato principal', nagerecht: 'Postre', naborrel: 'Copas finales' },
  de: { voorborrel: 'Aperitif', voorgerecht: 'Vorspeise', hoofdgerecht: 'Hauptgang', nagerecht: 'Dessert', naborrel: 'Absacker' },
};
const COURSE_ICONS = { voorborrel: '🥂', voorgerecht: '🥗', hoofdgerecht: '🍖', nagerecht: '🍰', naborrel: '🎉' };

/**
 * Bepaal per gang het UTC-moment waarop het adres onthuld wordt.
 * Regel (envelop-metafoor): gang N gaat open aan het EINDE van gang N-1.
 * De eerste gang is meteen zichtbaar (je moet weten waar je begint).
 *
 * @param {Array<{course:string, time:string, endTime:string}>} courses  in avond-volgorde
 * @param {string} eventDate  ISO-datum 'YYYY-MM-DD'
 * @returns {Array<{course:string, revealAt:Date|null}>}  null = direct zichtbaar
 */
function buildRevealSchedule(courses, eventDate) {
  return courses.map((c, i) => {
    if (i === 0) return { course: c.course, revealAt: null };
    const prev = courses[i - 1];
    return { course: c.course, revealAt: amsterdamTime(eventDate, `${prev.endTime}:00`) };
  });
}

/** Is deze gang onthuld op moment `now`? */
function isRevealed(revealAt, now = new Date()) {
  return revealAt === null || now.getTime() >= revealAt.getTime();
}

/**
 * Bewaartermijn: eventdatum + 30 dagen. Zonder (geldige) datum: nu + 60 dagen.
 * Adressen van derden horen niet eeuwig op de server te staan.
 */
function computeExpiry(eventDate, now = new Date()) {
  const d = eventDate ? new Date(`${eventDate}T00:00:00Z`) : null;
  if (d && !isNaN(d.getTime())) return d.getTime() + 30 * 86400000;
  return now.getTime() + 60 * 86400000;
}

/**
 * Valideer + normaliseer de publish-payload van de frontend.
 * Gooit Error met leesbare message bij ongeldige input.
 */
function validatePublishPayload(body) {
  if (!body || typeof body !== 'object') throw new Error('invalid payload');

  const eventName = String(body.eventName || '').trim().slice(0, MAX_NAME_LEN);
  if (!eventName) throw new Error('eventName required');

  const eventDate = String(body.eventDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) throw new Error('eventDate (YYYY-MM-DD) required');

  const locale = ['nl', 'en', 'es', 'de'].includes(body.locale) ? body.locale : 'nl';

  if (!Array.isArray(body.courses) || body.courses.length === 0) throw new Error('courses required');
  const courses = body.courses.map(c => {
    const course = String(c.course || '');
    if (!COURSE_KEYS.includes(course)) throw new Error(`unknown course: ${course}`);
    const time = String(c.time || ''); const endTime = String(c.endTime || '');
    if (!TIME_RE.test(time) || !TIME_RE.test(endTime)) throw new Error(`invalid times for ${course}`);
    return { course, time, endTime };
  });

  if (!Array.isArray(body.participants) || body.participants.length === 0) throw new Error('participants required');
  if (body.participants.length > MAX_PARTICIPANTS) throw new Error(`max ${MAX_PARTICIPANTS} participants`);

  const participants = body.participants.map(p => {
    const name = String(p.name || '').trim().slice(0, MAX_NAME_LEN);
    if (!name) throw new Error('participant name required');
    if (!Array.isArray(p.route)) throw new Error(`route required for ${name}`);
    const route = p.route.map(r => {
      const course = String(r.course || '');
      if (!COURSE_KEYS.includes(course)) throw new Error(`unknown course in route: ${course}`);
      return {
        course,
        isHost:     !!r.isHost,
        isSocial:   !!r.isSocial,
        address:    r.address  ? String(r.address).slice(0, MAX_ADDR_LEN)  : null,
        hostName:   r.hostName ? String(r.hostName).slice(0, MAX_NAME_LEN) : null,
        companions: Array.isArray(r.companions)
          ? r.companions.slice(0, 40).map(x => String(x).slice(0, MAX_NAME_LEN))
          : [],
      };
    });
    return { name, route };
  });

  return { eventName, eventDate, locale, courses, participants };
}

module.exports = {
  buildRevealSchedule, isRevealed, computeExpiry, validatePublishPayload,
  COURSE_LABELS, COURSE_ICONS,
};
