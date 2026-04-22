#!/usr/bin/env node
/**
 * retention.js — dagelijkse AVG-retentie-opschoning voor runningdinner.app
 *
 * Uitgevoerd via cron om 04:00 (na de backup om 03:00).
 *
 * Retentieregels (zoals beloofd in privacy.html):
 *   - Evenementgegevens: 90 dagen na event-datum → verwijderd
 *     (events zonder datum: 180 dagen na created_at → fallback)
 *   - Wachtwoord-reset-tokens: direct verwijderen zodra verlopen
 *   - Audit-log: > 2 jaar → verwijderd
 *   - Sessies: N.v.t. (JWT-based, geen server-side state)
 *
 * Uitvoer: regels op stdout met aantallen; exit 0 zelfs bij niks te doen.
 * Faal: exit 1 met stacktrace (cron logt naar /var/log/rda-retention.log).
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

// Config: DB-pad en retentie-dagen (overschrijfbaar via env voor testen)
const DB_PATH         = process.env.DB_PATH      || path.join(__dirname, '..', 'data', 'app.db');
const EVENT_DAYS      = parseInt(process.env.RETENTION_EVENT_DAYS      || '90',  10);
const EVENT_ORPHAN_D  = parseInt(process.env.RETENTION_EVENT_ORPHAN_D  || '180', 10);
const AUDIT_DAYS      = parseInt(process.env.RETENTION_AUDIT_DAYS      || '730', 10); // 2 jaar

function log(...args) { console.log('[retention]', new Date().toISOString(), '|', ...args); }

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON'); // dubbele veiligheid

const now = Date.now();
const sinceEvent      = now - EVENT_DAYS * 86400000;
const sinceEventOrphan = now - EVENT_ORPHAN_D * 86400000;
const sinceAudit      = now - AUDIT_DAYS * 86400000;

try {
  const t0 = Date.now();
  let total = 0;

  // 1. Event-participants eerst (child) — events waarvan de datum > 90d terug ligt
  const oldEventsWithDate = db.prepare(`
    SELECT id FROM events
    WHERE date IS NOT NULL AND date != ''
      AND (julianday('now') - julianday(date)) > ?
  `).all(EVENT_DAYS);

  // Plus events zonder datum, ouder dan 180d (safety net voor verweesde events)
  const oldOrphanEvents = db.prepare(`
    SELECT id FROM events
    WHERE (date IS NULL OR date = '') AND created_at < ?
  `).all(sinceEventOrphan);

  const eventIds = [...oldEventsWithDate, ...oldOrphanEvents].map(r => r.id);
  log('old events identified:', oldEventsWithDate.length, 'with-date /', oldOrphanEvents.length, 'orphan');

  if (eventIds.length) {
    const placeholders = eventIds.map(() => '?').join(',');
    const pInfo = db.prepare(`DELETE FROM event_participants WHERE event_id IN (${placeholders})`).run(...eventIds);
    const eInfo = db.prepare(`DELETE FROM events             WHERE id       IN (${placeholders})`).run(...eventIds);
    log('deleted', pInfo.changes, 'event_participants +', eInfo.changes, 'events (>', EVENT_DAYS, 'd or orphan >', EVENT_ORPHAN_D, 'd)');
    total += pInfo.changes + eInfo.changes;
  }

  // 2. Wachtwoord-reset-tokens: verwijder al verlopen
  const pwrInfo = db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(now);
  if (pwrInfo.changes) {
    log('deleted', pwrInfo.changes, 'expired password_resets');
    total += pwrInfo.changes;
  }

  // 3. Audit-log: > 2 jaar
  const auditInfo = db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(sinceAudit);
  if (auditInfo.changes) {
    log('deleted', auditInfo.changes, 'audit_log rows (>', AUDIT_DAYS, 'd)');
    total += auditInfo.changes;
  }

  // 4. (Toekomst) User-delete retentie: accountgegevens blijven zolang
  // account actief is + 12 maanden na opzegging. Momenteel verwijdert de
  // profile-delete-flow directly; geen 12m grace. Wordt herbekeken bij
  // eerste user-delete use-case.

  const dt = Date.now() - t0;
  log('done in', dt, 'ms; total rows removed:', total);
  process.exit(0);
} catch (err) {
  log('FAIL:', err.message);
  console.error(err.stack);
  process.exit(1);
} finally {
  db.close();
}
