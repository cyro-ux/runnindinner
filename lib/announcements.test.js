'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ANNOUNCEMENTS, unseenFor, dateMs } = require('./announcements');

test('aankondigingen: unieke ids, geldige datums, 4 talen met title+text', () => {
  const ids = new Set();
  for (const a of ANNOUNCEMENTS) {
    assert.ok(a.id && !ids.has(a.id), `uniek id: ${a.id}`);
    ids.add(a.id);
    assert.ok(Number.isFinite(dateMs(a)), `geldige datum: ${a.date}`);
    for (const lang of ['nl', 'en', 'es', 'de']) {
      assert.ok(a[lang] && a[lang].title && a[lang].text, `${a.id}: ${lang} compleet`);
      assert.ok(a[lang].text.length <= 400, `${a.id}: ${lang} tekst niet te lang voor een banner`);
    }
  }
});

test('unseenFor: alleen aankondigingen ná registratie en ná laatste "gezien"', () => {
  const oldestMs = Math.min(...ANNOUNCEMENTS.map(dateMs));
  const newestMs = Math.max(...ANNOUNCEMENTS.map(dateMs));

  const before = { created_at: oldestMs - 86400000, announcements_seen_at: null };
  assert.equal(unseenFor(before).length, ANNOUNCEMENTS.length, 'bestaand account ziet alle releases');

  const fresh = { created_at: newestMs + 86400000, announcements_seen_at: null };
  assert.equal(unseenFor(fresh).length, 0, 'nieuw account krijgt geen backlog');

  const dismissed = { created_at: oldestMs - 86400000, announcements_seen_at: Date.now() };
  assert.equal(unseenFor(dismissed).length, 0, 'na wegklikken niets meer');
});
