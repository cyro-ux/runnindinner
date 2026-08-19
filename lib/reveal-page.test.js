'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { REVEAL_T, renderRevealPage } = require('./reveal-page');

test('REVEAL_T heeft alle 4 talen met dezelfde sleutels', () => {
  const keys = Object.keys(REVEAL_T.nl).sort().join(',');
  for (const lang of ['en', 'es', 'de']) {
    assert.strictEqual(Object.keys(REVEAL_T[lang]).sort().join(','), keys, lang);
  }
});

test('renderRevealPage: locale, inhoud en reload-script', () => {
  const html = renderRevealPage('es', 'Mijn Event', '<p>inner</p>', Date.now() + 60000);
  assert.ok(html.includes('lang="es"'));
  assert.ok(html.includes('<p>inner</p>'));
  assert.ok(html.includes('setTimeout'), 'auto-reload bij nextRevealMs');
  assert.ok(!renderRevealPage('nl', 'x', 'y', null).includes('setTimeout'), 'geen reload zonder nextRevealMs');
});

test('renderRevealPage escapet de titel (event_name is user-input)', () => {
  const html = renderRevealPage('nl', '<script>alert(1)</script>', '', null);
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(html.includes('&lt;script&gt;'));
});
