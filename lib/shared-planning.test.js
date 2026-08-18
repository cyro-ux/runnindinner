'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  buildRevealSchedule, isRevealed, computeExpiry, validatePublishPayload,
} = require('./shared-planning');

const COURSES = [
  { course: 'voorgerecht',  time: '18:00', endTime: '18:45' },
  { course: 'hoofdgerecht', time: '19:00', endTime: '20:00' },
  { course: 'nagerecht',    time: '20:15', endTime: '21:00' },
];

test('eerste gang is direct zichtbaar', () => {
  const sched = buildRevealSchedule(COURSES, '2026-06-15');
  assert.strictEqual(sched[0].revealAt, null);
  assert.ok(isRevealed(sched[0].revealAt, new Date('2020-01-01T00:00:00Z')));
});

test('gang N onthult aan het einde van gang N-1 (wandklok Amsterdam)', () => {
  const sched = buildRevealSchedule(COURSES, '2026-06-15');
  // 18:45 NL-zomertijd (CEST, +2) = 16:45 UTC — onafhankelijk van server-TZ
  assert.strictEqual(sched[1].revealAt.toISOString(), '2026-06-15T16:45:00.000Z');
  // 20:00 NL = 18:00 UTC
  assert.strictEqual(sched[2].revealAt.toISOString(), '2026-06-15T18:00:00.000Z');
});

test('wintertijd gebruikt CET (+1)', () => {
  const sched = buildRevealSchedule(COURSES, '2026-12-19');
  // 18:45 NL-wintertijd = 17:45 UTC
  assert.strictEqual(sched[1].revealAt.toISOString(), '2026-12-19T17:45:00.000Z');
});

test('isRevealed kantelt exact op het onthulmoment', () => {
  const at = new Date('2026-06-15T16:45:00Z');
  assert.strictEqual(isRevealed(at, new Date('2026-06-15T16:44:59Z')), false);
  assert.strictEqual(isRevealed(at, new Date('2026-06-15T16:45:00Z')), true);
});

test('computeExpiry: eventdatum + 30 dagen; fallback nu + 60', () => {
  const exp = computeExpiry('2026-06-15');
  assert.strictEqual(exp, new Date('2026-06-15T00:00:00Z').getTime() + 30 * 86400000);
  const now = new Date('2026-01-01T00:00:00Z');
  assert.strictEqual(computeExpiry('', now), now.getTime() + 60 * 86400000);
  assert.strictEqual(computeExpiry('geen-datum', now), now.getTime() + 60 * 86400000);
});

test('validatePublishPayload: normaliseert en begrenst', () => {
  const out = validatePublishPayload({
    eventName: '  Buurtdiner  ',
    eventDate: '2026-06-15',
    locale: 'de',
    courses: COURSES,
    participants: [{
      name: 'Lieke & Mark',
      route: [{ course: 'voorgerecht', isHost: true, address: 'Hanekerweg 8', hostName: 'zelf', companions: ['Roos & Niels'] }],
    }],
  });
  assert.strictEqual(out.eventName, 'Buurtdiner');
  assert.strictEqual(out.locale, 'de');
  assert.strictEqual(out.participants[0].route[0].isHost, true);
});

test('validatePublishPayload: weigert rommel', () => {
  const base = { eventName: 'X', eventDate: '2026-06-15', courses: COURSES, participants: [{ name: 'A', route: [] }] };
  assert.throws(() => validatePublishPayload({ ...base, eventDate: '15-06-2026' }), /eventDate/);
  assert.throws(() => validatePublishPayload({ ...base, courses: [{ course: 'ontbijt', time: '08:00', endTime: '09:00' }] }), /unknown course/);
  assert.throws(() => validatePublishPayload({ ...base, participants: [] }), /participants required/);
  assert.throws(() => validatePublishPayload({ ...base, participants: [{ name: '', route: [] }] }), /name required/);
  const many = Array.from({ length: 201 }, (_, i) => ({ name: `P${i}`, route: [] }));
  assert.throws(() => validatePublishPayload({ ...base, participants: many }), /max 200/);
});
