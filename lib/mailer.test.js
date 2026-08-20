/**
 * Tests voor lib/mailer.js + een 4-talen-wachter over de hele codebase.
 *
 * Drie productiebugs deze week hadden dezelfde vorm: een vertaalmap met
 * nl/en/es maar zonder de (foutpagina, verwijdermail, mailfooter) — en de
 * referral-mail gaf Duitse gebruikers zelfs een undefined-body. De wachter
 * eist dat elk bronbestand evenveel nl:-, en:-, es:- als de:-sleutels
 * heeft; een nieuwe map die een taal mist laat de CI-gate falen.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { wrapHtml, wrapInvoiceHtml, formatEur, EMAIL_LOCALES, INVOICE_LABELS } = require('./mailer');

test('EMAIL_LOCALES en INVOICE_LABELS dekken alle 4 talen', () => {
  for (const obj of [EMAIL_LOCALES, INVOICE_LABELS]) {
    assert.deepStrictEqual(Object.keys(obj).sort(), ['de', 'en', 'es', 'nl']);
  }
});

test('wrapHtml: footer in alle 4 talen, onbekende taal valt terug op NL', () => {
  const probes = { nl: 'omdat je een account', en: 'because you have an account',
                   es: 'porque tienes una cuenta', de: 'weil du ein Konto' };
  for (const [lang, probe] of Object.entries(probes)) {
    assert.ok(wrapHtml('<p>x</p>', lang).includes(probe), lang);
  }
  assert.ok(wrapHtml('<p>x</p>', 'fr').includes(probes.nl));
});

test('wrapInvoiceHtml rendert de body', () => {
  assert.ok(wrapInvoiceHtml('<p>factuur</p>').includes('<p>factuur</p>'));
});

test('formatEur formatteert centen als euro', () => {
  assert.match(formatEur(500), /5,00/);
});

test('4-talen-invariant: elk bronbestand heeft evenveel nl/en/es/de-sleutels', () => {
  const root = path.join(__dirname, '..');
  const files = ['server.js',
    ...fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => `lib/${f}`),
    ...fs.readdirSync(path.join(root, 'routes')).filter((f) => f.endsWith('.js')).map((f) => `routes/${f}`)];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    // [ \t]* blijft binnen de regel; let op de dubbele backslash — in een
    // template literal wordt een enkele \t stilletjes een tab-teken.
    const count = (lang) => (src.match(new RegExp('^[ \\t]*' + lang + ':', 'gm')) || []).length
      + (src.match(new RegExp('[{,] ?' + lang + ':', 'g')) || []).length;
    const [nl, en, es, de] = ['nl', 'en', 'es', 'de'].map(count);
    assert.ok(nl === en && en === es && es === de,
      `${rel}: ongelijk aantal taal-sleutels (nl=${nl}, en=${en}, es=${es}, de=${de}) — mist een vertaalmap een taal?`);
  }
});
