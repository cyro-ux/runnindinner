'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildShareUrl, shareEventInvite, shareParticipantSchedule, sharePersonalSchedule,
} = require('./whatsapp-share');

test('buildShareUrl without phone = broadcast', () => {
  const u = buildShareUrl({ text: 'hello world' });
  assert.match(u, /^https:\/\/wa\.me\/\?text=hello%20world$/);
});

test('buildShareUrl with phone strips non-digits', () => {
  const u = buildShareUrl({ phone: '+31 6 1234 5678', text: 'hi' });
  assert.match(u, /^https:\/\/wa\.me\/31612345678\?text=hi$/);
});

test('shareEventInvite NL contains event name + UTM', () => {
  const u = shareEventInvite({
    eventName: 'Winterdiner 2026',
    eventDate: '20 december',
    registerUrl: 'https://runningdiner.nl/events/abc/register',
    locale: 'nl',
  });
  const decoded = decodeURIComponent(u);
  assert.match(decoded, /Winterdiner 2026/);
  assert.match(decoded, /20 december/);
  assert.match(decoded, /utm_source=whatsapp/);
  assert.match(decoded, /utm_campaign=event_invite/);
});

test('shareEventInvite EN uses English copy', () => {
  const u = shareEventInvite({
    eventName: 'Summer Dinner',
    eventDate: 'Aug 20',
    registerUrl: 'https://runningdiner.nl/events/abc/register',
    locale: 'en',
  });
  const decoded = decodeURIComponent(u);
  assert.match(decoded, /organising/);
  assert.doesNotMatch(decoded, /organiseer/);
});

test('shareEventInvite ES uses "cena itinerante"', () => {
  const u = shareEventInvite({
    eventName: 'Gran Cena',
    eventDate: '15 abril',
    registerUrl: 'https://runningdiner.nl/events/abc/register',
    locale: 'es',
  });
  const decoded = decodeURIComponent(u);
  assert.match(decoded, /Cena itinerante/);
});

test('shareParticipantSchedule personalises greeting', () => {
  const u = shareParticipantSchedule({
    participantName: 'Jan',
    personalUrl: 'https://runningdiner.nl/events/abc/p/xyz',
  });
  const decoded = decodeURIComponent(u);
  assert.match(decoded, /Hoi Jan/);
});

test('sharePersonalSchedule is a broadcast (no phone)', () => {
  const u = sharePersonalSchedule({
    eventName: 'Winter',
    personalUrl: 'https://runningdiner.nl/events/abc/p/xyz',
  });
  assert.match(u, /^https:\/\/wa\.me\/\?text=/);
});

test('UTM merges overrides with defaults', () => {
  const u = shareEventInvite({
    eventName: 'X', eventDate: 'Y',
    registerUrl: 'https://runningdiner.nl/events/abc/register',
  });
  const decoded = decodeURIComponent(u);
  // default utm_source=whatsapp, overridden campaign=event_invite
  assert.match(decoded, /utm_medium=organic_share/);
  assert.match(decoded, /utm_campaign=event_invite/);
});
