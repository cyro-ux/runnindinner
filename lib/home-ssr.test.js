'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { applyI18n, applyCms, pickCmsForLang, applyAggregateRating } = require('./home-ssr');

test('applyI18n: tekst, html, attributen en escaping', () => {
  const dict = { nav: { demo: 'Demo & mehr', cta: 'Los' }, hero: { hint: 'Einmal <b>zahlen</b>' }, form: { mail: 'E-Mail "hier"' } };
  const html = '<a href="/demo" data-i18n="nav.demo">Demo</a>'
    + '<p class="x" data-i18n-html="hero.hint">Betaal <span>€5</span></p>'
    + '<input data-i18n-placeholder="form.mail" placeholder="Mail">'
    + '<span data-i18n="onbekend.key">blijft</span>';
  const out = applyI18n(html, dict);
  assert.ok(out.includes('>Demo &amp; mehr</a>'), 'tekst ge-escaped');
  assert.ok(out.includes('>Einmal <b>zahlen</b></p>'), 'html raw');
  assert.ok(out.includes('placeholder="E-Mail &quot;hier&quot;"'), 'attribuut');
  assert.ok(out.includes('>blijft</span>'), 'onbekende key ongemoeid');
});

test('applyI18n: geneste tags onder data-i18n blijven ongemoeid', () => {
  const out = applyI18n('<p data-i18n="k">a <b>b</b></p>', { k: 'X' });
  assert.ok(out.includes('a <b>b</b>'));
});

test('applyI18n op de echte homepage + de.json vertaalt het gros', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'home.html'), 'utf8');
  const de = JSON.parse(fs.readFileSync(path.join(root, 'public', 'lang', 'de.json'), 'utf8'));
  const out = applyI18n(html, de);
  assert.ok(out.includes('Demo ausprobieren'), 'hero-CTA Duits');
  assert.ok(!out.includes('Probeer de demo →'), 'NL-CTA weg');
  assert.ok(out.includes('<span id="price-display">'), 'data-i18n-html behoudt prijs-span');
});

test('applyAggregateRating: actuele score in JSON-LD, fallback bij geen reviews', () => {
  const html = '{"aggregateRating":{"@type":"AggregateRating","ratingValue": "5.0","reviewCount": "1","bestRating":"5"}}';
  const out = applyAggregateRating(html, { count: 3, avg: 4.7 });
  assert.ok(out.includes('"ratingValue": "4.7"'), 'gemiddelde bijgewerkt');
  assert.ok(out.includes('"reviewCount": "3"'), 'aantal bijgewerkt');
  assert.strictEqual(applyAggregateRating(html, null), html, 'null: HTML ongemoeid');
  assert.strictEqual(applyAggregateRating(html, { count: 0, avg: 0 }), html, 'geen reviews: HTML ongemoeid');
  // De echte homepage bevat het blok dat de helper verwacht
  const root = path.join(__dirname, '..');
  const home = fs.readFileSync(path.join(root, 'public', 'home.html'), 'utf8');
  const homeOut = applyAggregateRating(home, { count: 7, avg: 4.9 });
  assert.ok(homeOut.includes('"ratingValue": "4.9"') && homeOut.includes('"reviewCount": "7"'), 'werkt op home.html');
});

test('applyCms + pickCmsForLang: DE-overlay in H1', () => {
  const rows = [{ key: 'hero_title', value: 'NL titel' }, { key: 'hero_title_de', value: 'DE Titel <x>' }];
  const cms = pickCmsForLang(rows, 'de');
  assert.strictEqual(cms.hero_title, 'DE Titel <x>');
  assert.strictEqual(pickCmsForLang(rows, 'nl').hero_title, 'NL titel');
  const out = applyCms('<h1 id="cms-hero-title">oud</h1>', cms);
  assert.ok(out.includes('<h1 id="cms-hero-title">DE Titel &lt;x&gt;</h1>'));
});
