/**
 * Minimal RFC 5545 iCalendar builder. Geen dependency — de spec is simpel
 * genoeg om met string-concatenation te doen.
 *
 * Gebruikt voor kalender-exports van running dinners: organisatoren willen
 * het event in hun eigen agenda, en deelnemers willen hun persoonlijke
 * indeling (voor/hoofd/nagerecht) met exacte start- en eindtijden.
 */

'use strict';

const CRLF = '\r\n';

function _escapeText(s) {
  // RFC 5545: escape \, ;, , and newlines
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Fold lines > 75 octets (RFC 5545 §3.1)
function _fold(line) {
  if (line.length <= 75) return line;
  const parts = [];
  let rest = line;
  while (rest.length > 75) {
    parts.push(rest.slice(0, 75));
    rest = ' ' + rest.slice(75);
  }
  parts.push(rest);
  return parts.join(CRLF);
}

// Format date as YYYYMMDDTHHMMSSZ (UTC)
function _fmtDate(d) {
  const dt = new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`
    + `T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}${pad(dt.getUTCSeconds())}Z`;
}

/**
 * Bouw een complete iCalendar-bestand met 1+ events.
 *
 * @param {Array<object>} events
 *   - uid       (string, required)
 *   - start     (Date|string|number)
 *   - end       (Date|string|number)
 *   - summary   (string)
 *   - description (string)
 *   - location  (string, optional)
 *   - url       (string, optional)
 * @param {object} [opts]
 *   - prodId    (string) default runningdinner.app
 *   - calName   (string) display-naam in agenda
 * @returns {string} ICS-bestand
 */
function build(events, { prodId = '-//runningdinner.app//EN', calName = 'Running Dinner' } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodId}`,
    `X-WR-CALNAME:${_escapeText(calName)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  const now = _fmtDate(new Date());
  for (const ev of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${ev.uid}`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART:${_fmtDate(ev.start)}`);
    lines.push(`DTEND:${_fmtDate(ev.end)}`);
    lines.push(`SUMMARY:${_escapeText(ev.summary)}`);
    if (ev.description) lines.push(`DESCRIPTION:${_escapeText(ev.description)}`);
    if (ev.location)    lines.push(`LOCATION:${_escapeText(ev.location)}`);
    if (ev.url)         lines.push(`URL:${ev.url}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(_fold).join(CRLF) + CRLF;
}

/**
 * Maak een VEVENT-blok voor het hele running dinner (voorborrel t/m naborrel).
 */
function buildEventCalendar(event) {
  const start = event.date ? new Date(event.date + 'T18:00:00') : new Date();
  const end   = event.date ? new Date(event.date + 'T23:30:00') : new Date();
  const desc = [
    'Running Dinner',
    event.location_note ? `\nStart: ${event.location_note}` : '',
    event.logo_url ? `\n\n${event.logo_url}` : '',
  ].join('');

  return build([{
    uid:         `event-${event.id}@runningdiner.nl`,
    start,
    end,
    summary:     event.name,
    description: desc,
    location:    event.location_note || '',
    url:         `https://runningdiner.nl/events/${event.id}`,
  }], { calName: event.name });
}

/**
 * Maak een VCALENDAR met 3-5 VEVENTs voor een deelnemer (per gang één).
 */
function buildParticipantCalendar(event, participant, courses) {
  const dayStart = event.date ? new Date(event.date + 'T18:00:00') : new Date();
  const ics = [];
  let cursor = new Date(dayStart);
  const COURSE_DURATION_MIN = 90;
  const TRAVEL_MIN = 15;

  for (const c of courses) {
    const start = new Date(cursor);
    const end   = new Date(start.getTime() + COURSE_DURATION_MIN * 60000);
    ics.push({
      uid:         `course-${event.id}-${participant.id}-${c.name}@runningdiner.nl`,
      start,
      end,
      summary:     `${event.name}: ${c.name}`,
      description: `Gang: ${c.name}\nBij: ${c.host || ''}\nTafelgenoten: ${(c.tableMates || []).join(', ')}`,
      location:    c.address || '',
    });
    cursor = new Date(end.getTime() + TRAVEL_MIN * 60000);
  }

  return build(ics, { calName: `${event.name} — ${participant.name}` });
}

module.exports = { build, buildEventCalendar, buildParticipantCalendar };
