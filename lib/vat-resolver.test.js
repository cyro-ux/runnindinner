/**
 * Unit-tests voor VatResolver.
 * Run: node --test lib/vat-resolver.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolve, splitGross, normCountry } = require('./vat-resolver');

// ── Thuis-land: NL → 21% ────────────────────────────────────────────────────
test('NL consumer → 21% domestic', () => {
  const r = resolve({ country: 'NL' });
  assert.equal(r.rate, 21);
  assert.equal(r.scheme, 'DOMESTIC');
  assert.equal(r.taxCode, 'NL_STANDARD_21');
});

test('NL business without VAT-ID → 21% domestic (still NL VAT)', () => {
  const r = resolve({ country: 'NL', isBusiness: true });
  assert.equal(r.rate, 21);
  assert.equal(r.scheme, 'DOMESTIC');
});

// ── EU B2C (OSS) ────────────────────────────────────────────────────────────
test('DE consumer → 19% via OSS', () => {
  const r = resolve({ country: 'DE' });
  assert.equal(r.rate, 19);
  assert.equal(r.scheme, 'OSS');
  assert.equal(r.taxCode, 'OSS_DE_19');
});

test('HU consumer → 27% (highest in EU)', () => {
  const r = resolve({ country: 'HU' });
  assert.equal(r.rate, 27);
  assert.equal(r.scheme, 'OSS');
});

test('LU consumer → 17% (lowest in EU)', () => {
  const r = resolve({ country: 'LU' });
  assert.equal(r.rate, 17);
});

test('IE consumer → 23% via OSS', () => {
  const r = resolve({ country: 'IE' });
  assert.equal(r.rate, 23);
  assert.equal(r.scheme, 'OSS');
});

// ── EU B2B (reverse charge) ─────────────────────────────────────────────────
test('DE business with valid VAT-ID → reverse charge 0%', () => {
  const r = resolve({
    country: 'DE', isBusiness: true, vatId: 'DE123456789', vatIdValid: true,
  });
  assert.equal(r.rate, 0);
  assert.equal(r.scheme, 'REVERSE_CHARGE');
  assert.match(r.exemptionReason, /artikel 44/);
});

test('DE business without valid VAT-ID → treated as B2C', () => {
  const r = resolve({
    country: 'DE', isBusiness: true, vatId: 'DE999', vatIdValid: false,
  });
  assert.equal(r.rate, 19);
  assert.equal(r.scheme, 'OSS');
});

test('DE business without VAT-ID at all → treated as B2C', () => {
  const r = resolve({ country: 'DE', isBusiness: true });
  assert.equal(r.rate, 19);
  assert.equal(r.scheme, 'OSS');
});

// ── UK (post-Brexit) ────────────────────────────────────────────────────────
test('GB consumer → 0% UK (non-established supplier)', () => {
  const r = resolve({ country: 'GB' });
  assert.equal(r.rate, 0);
  assert.equal(r.scheme, 'UK');
});

test('UK (wrong but common code) → same as GB', () => {
  const r = resolve({ country: 'UK' });
  assert.equal(r.rate, 0);
  assert.equal(r.scheme, 'UK');
});

// ── Non-EU export ───────────────────────────────────────────────────────────
test('US consumer → 0% export', () => {
  const r = resolve({ country: 'US' });
  assert.equal(r.rate, 0);
  assert.equal(r.scheme, 'EXPORT');
  assert.equal(r.taxCode, 'EXPORT_ZERO');
});

test('CA consumer → 0% export', () => {
  const r = resolve({ country: 'CA' });
  assert.equal(r.rate, 0);
  assert.equal(r.scheme, 'EXPORT');
});

test('AU consumer → 0% export', () => {
  const r = resolve({ country: 'AU' });
  assert.equal(r.rate, 0);
  assert.equal(r.scheme, 'EXPORT');
});

test('MX consumer (LatAm) → 0% export', () => {
  const r = resolve({ country: 'MX' });
  assert.equal(r.rate, 0);
  assert.equal(r.scheme, 'EXPORT');
});

test('NO consumer (EEA but not EU) → 0% export', () => {
  const r = resolve({ country: 'NO' });
  assert.equal(r.rate, 0);
  assert.equal(r.scheme, 'EXPORT');
});

// ── Case-insensitivity ──────────────────────────────────────────────────────
test('lowercase country code is normalized', () => {
  const r = resolve({ country: 'nl' });
  assert.equal(r.rate, 21);
});

test('normCountry("uk") → "GB"', () => {
  assert.equal(normCountry('uk'), 'GB');
});

test('normCountry("el") → "GR"', () => {
  assert.equal(normCountry('el'), 'GR');
});

// ── Error cases ─────────────────────────────────────────────────────────────
test('missing country throws', () => {
  assert.throws(() => resolve({}), /country is required/);
});

test('unknown EU country (e.g. XX) → export export', () => {
  // XX is not in EU_COUNTRIES, so it goes to export path — not an error
  const r = resolve({ country: 'XX' });
  assert.equal(r.scheme, 'EXPORT');
});

// ── splitGross — BTW scheiden van bruto-bedrag ──────────────────────────────
test('splitGross NL 21% → €5 gross = €4,13 net + €0,87 VAT', () => {
  // 500 cents gross / 1.21 = 413.22 → rounded to 413
  const r = splitGross(500, 21);
  assert.equal(r.grossCents, 500);
  assert.equal(r.netCents, 413);
  assert.equal(r.vatCents, 87);
});

test('splitGross with 0% rate → all net, no VAT', () => {
  const r = splitGross(599, 0);
  assert.equal(r.netCents, 599);
  assert.equal(r.vatCents, 0);
  assert.equal(r.grossCents, 599);
});

test('splitGross DE 19% → €5,99 gross = €5,03 net + €0,96 VAT', () => {
  // 599 / 1.19 = 503.36 → 503
  const r = splitGross(599, 19);
  assert.equal(r.netCents, 503);
  assert.equal(r.vatCents, 96);
});

test('splitGross HU 27% → €5 gross = €3,94 net + €1,06 VAT', () => {
  const r = splitGross(500, 27);
  assert.equal(r.netCents, 394);
  assert.equal(r.vatCents, 106);
});

// ── End-to-end: een volledige transactie doorrekenen ────────────────────────
test('e2e: Spanish consumer buying €5/year', () => {
  const v = resolve({ country: 'ES' });
  const s = splitGross(500, v.rate);
  assert.equal(v.rate, 21);
  assert.equal(v.scheme, 'OSS');
  assert.equal(s.netCents, 413);
  assert.equal(s.vatCents, 87);
});

test('e2e: German B2B with valid VAT-ID buying €5/year', () => {
  const v = resolve({
    country: 'DE', isBusiness: true, vatId: 'DE123456789', vatIdValid: true,
  });
  const s = splitGross(500, v.rate);
  assert.equal(v.rate, 0);
  assert.equal(s.netCents, 500);
  assert.equal(s.vatCents, 0);
});

test('e2e: US consumer buying $5.99/year → full amount is net, no VAT', () => {
  const v = resolve({ country: 'US' });
  const s = splitGross(599, v.rate);
  assert.equal(v.rate, 0);
  assert.equal(v.scheme, 'EXPORT');
  assert.equal(s.netCents, 599);
  assert.equal(s.vatCents, 0);
});
