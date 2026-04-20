'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolve, availableCurrencies } = require('./price-resolver');

// ── Primary markets ─────────────────────────────────────────────────────────
test('NL → €5,00 EUR + iDEAL first', () => {
  const r = resolve({ country: 'NL' });
  assert.equal(r.currency, 'EUR');
  assert.equal(r.cents, 500);
  assert.equal(r.displayPrice, '€5,00');
  assert.equal(r.mollieMethods[0], 'ideal');
});

test('BE → €5,00 EUR + Bancontact first', () => {
  const r = resolve({ country: 'BE' });
  assert.equal(r.currency, 'EUR');
  assert.equal(r.mollieMethods[0], 'bancontact');
});

test('GB → £4.99 GBP + card first', () => {
  const r = resolve({ country: 'GB' });
  assert.equal(r.currency, 'GBP');
  assert.equal(r.cents, 499);
  assert.equal(r.displayPrice, '£4.99');
  assert.equal(r.mollieMethods[0], 'creditcard');
});

test('UK (synonym) → treated as GB', () => {
  const r = resolve({ country: 'UK' });
  assert.equal(r.currency, 'GBP');
  assert.equal(r.country, 'GB');
});

test('US → $5.99 USD', () => {
  const r = resolve({ country: 'US' });
  assert.equal(r.currency, 'USD');
  assert.equal(r.cents, 599);
  assert.equal(r.displayPrice, '$5.99');
});

test('CA → C$7.99 CAD', () => {
  const r = resolve({ country: 'CA' });
  assert.equal(r.currency, 'CAD');
  assert.equal(r.cents, 799);
});

test('AU → A$8.99 AUD', () => {
  const r = resolve({ country: 'AU' });
  assert.equal(r.currency, 'AUD');
  assert.equal(r.cents, 899);
});

test('NZ → NZ$9.99 NZD', () => {
  const r = resolve({ country: 'NZ' });
  assert.equal(r.currency, 'NZD');
  assert.equal(r.cents, 999);
});

// ── EU countries all get EUR ────────────────────────────────────────────────
test('DE → €5,00 EUR', () => {
  const r = resolve({ country: 'DE' });
  assert.equal(r.currency, 'EUR');
  assert.equal(r.cents, 500);
});

test('ES → €5,00 EUR', () => {
  const r = resolve({ country: 'ES' });
  assert.equal(r.currency, 'EUR');
});

test('IE (Ireland) → EUR (not GBP)', () => {
  const r = resolve({ country: 'IE' });
  assert.equal(r.currency, 'EUR');
});

// ── Rest of world defaults to USD ───────────────────────────────────────────
test('MX → $5.99 USD (LatAm)', () => {
  const r = resolve({ country: 'MX' });
  assert.equal(r.currency, 'USD');
  assert.equal(r.cents, 599);
});

test('AR → $5.99 USD', () => {
  const r = resolve({ country: 'AR' });
  assert.equal(r.currency, 'USD');
});

test('JP → $5.99 USD (not listed explicitly)', () => {
  const r = resolve({ country: 'JP' });
  assert.equal(r.currency, 'USD');
});

// ── Manual override ─────────────────────────────────────────────────────────
test('NL with USD override → $5.99', () => {
  const r = resolve({ country: 'NL', currency: 'USD' });
  assert.equal(r.currency, 'USD');
  assert.equal(r.cents, 599);
});

test('US with EUR override → €5,00', () => {
  const r = resolve({ country: 'US', currency: 'EUR' });
  assert.equal(r.currency, 'EUR');
  assert.equal(r.cents, 500);
});

test('unknown currency override → falls back to country', () => {
  const r = resolve({ country: 'NL', currency: 'XYZ' });
  assert.equal(r.currency, 'EUR');
});

// ── Edge cases ──────────────────────────────────────────────────────────────
test('no country → defaults to NL/EUR', () => {
  const r = resolve({});
  assert.equal(r.currency, 'EUR');
});

test('lowercase country', () => {
  const r = resolve({ country: 'de' });
  assert.equal(r.currency, 'EUR');
});

test('availableCurrencies returns all 6', () => {
  const list = availableCurrencies();
  assert.equal(list.length, 6);
  const codes = list.map(c => c.code);
  assert.deepEqual(codes, ['EUR', 'GBP', 'USD', 'CAD', 'AUD', 'NZD']);
});
