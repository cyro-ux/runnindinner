/**
 * Unit-tests voor VIES parsing (geen echte API-calls — die gaan via integratietest).
 * Run: node --test lib/vies.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseVatId } = require('./vies');

test('parseVatId DE123456789', () => {
  const r = parseVatId('DE123456789');
  assert.equal(r.country, 'DE');
  assert.equal(r.number, '123456789');
});

test('parseVatId with spaces', () => {
  const r = parseVatId('NL 8570 97 632 B01');
  assert.equal(r.country, 'NL');
  assert.equal(r.number, '857097632B01');
});

test('parseVatId lowercase', () => {
  const r = parseVatId('be0123456789');
  assert.equal(r.country, 'BE');
});

test('parseVatId EL → GR (Greece)', () => {
  const r = parseVatId('EL123456789');
  assert.equal(r.country, 'GR');
});

test('parseVatId empty throws', () => {
  assert.throws(() => parseVatId(''), /required/);
});

test('parseVatId invalid format throws', () => {
  assert.throws(() => parseVatId('123456789'), /invalid/);
});

test('parseVatId too long throws', () => {
  assert.throws(() => parseVatId('DE12345678901234567890'), /invalid/);
});
