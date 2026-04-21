'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build, buildEventCalendar } = require('./ical');

test('build generates valid VCALENDAR skeleton', () => {
  const out = build([{
    uid: 'abc@runningdinner.app',
    start: new Date('2026-12-20T18:00:00Z'),
    end:   new Date('2026-12-20T23:30:00Z'),
    summary: 'Winter Running Dinner',
  }]);
  assert.match(out, /^BEGIN:VCALENDAR/);
  assert.match(out, /END:VCALENDAR\r\n$/);
  assert.match(out, /BEGIN:VEVENT/);
  assert.match(out, /UID:abc@runningdinner\.app/);
  assert.match(out, /DTSTART:20261220T180000Z/);
  assert.match(out, /DTEND:20261220T233000Z/);
  assert.match(out, /SUMMARY:Winter Running Dinner/);
  assert.match(out, /END:VEVENT/);
});

test('build uses CRLF line endings', () => {
  const out = build([{ uid: 'x', start: new Date(), end: new Date(), summary: 'y' }]);
  assert.match(out, /\r\n/);
  assert.doesNotMatch(out.split('\r\n').join(''), /\n/); // no stray LFs
});

test('build escapes special chars in text', () => {
  const out = build([{
    uid: 'x',
    start: new Date(),
    end: new Date(),
    summary: 'Dinner, 3 courses; including desserts',
  }]);
  assert.match(out, /SUMMARY:Dinner\\, 3 courses\\; including desserts/);
});

test('build escapes backslashes', () => {
  const out = build([{ uid: 'x', start: new Date(), end: new Date(), summary: 'path\\to' }]);
  assert.match(out, /SUMMARY:path\\\\to/);
});

test('build includes multiple events', () => {
  const out = build([
    { uid: 'a', start: new Date(), end: new Date(), summary: 'First' },
    { uid: 'b', start: new Date(), end: new Date(), summary: 'Second' },
  ]);
  const matches = out.match(/BEGIN:VEVENT/g);
  assert.equal(matches.length, 2);
});

test('buildEventCalendar uses event.date + 18:00 start', () => {
  const out = buildEventCalendar({
    id: 'evt1',
    name: 'Zomer diner',
    date: '2026-06-15',
    location_note: 'Startlocatie: Café De Kroon',
  });
  assert.match(out, /UID:event-evt1@runningdinner\.app/);
  assert.match(out, /DTSTART:20260615T16/); // 18:00 Europe/Amsterdam = 16:00 UTC (DST)
  assert.match(out, /LOCATION:Startlocatie/);
});
