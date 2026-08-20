/**
 * Wachter: geen inline event-handler-attributen in de frontend-bronnen.
 *
 * De CSP-directive script-src-attr staat op 'none' — een on*-attribuut dat
 * hier opnieuw insluipt zou in productie een stil kapotte knop opleveren
 * (CSP blokkeert zonder zichtbare fout voor de gebruiker). Deze test laat
 * de CI-gate daar hard op falen.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FILES = [
  'index.html',
  ...require('./planner-files'),
  'public/demo-mode.js',
  'public/home.html',
  'admin/index.html',
];

const INLINE_HANDLER_RE = /\bon(?:click|dblclick|change|input|blur|focus|submit|load|error|drag\w*|drop|mouse\w+|key\w+|touch\w+|wheel|scroll|contextmenu)\s*=\s*["']/g;

test('geen inline event-handlers in frontend-bronnen (CSP script-src-attr)', () => {
  for (const rel of FILES) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const hits = src.match(INLINE_HANDLER_RE) || [];
    assert.deepStrictEqual(hits, [], `${rel} bevat inline handlers — gebruik de data-action-dispatcher`);
  }
});

test('geen inline <script>-blokken in HTML (CSP script-src zonder unsafe-inline)', () => {
  const root = path.join(__dirname, '..');
  const htmlFiles = ['index.html',
    ...fs.readdirSync(path.join(root, 'public')).filter((f) => f.endsWith('.html')).map((f) => `public/${f}`),
    ...fs.readdirSync(path.join(root, 'admin')).filter((f) => f.endsWith('.html')).map((f) => `admin/${f}`)];
  for (const rel of htmlFiles) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    // Kale <script> zonder src wordt door de CSP geblokkeerd; data-blokken
    // zoals application/ld+json zijn niet-uitvoerbaar en mogen wel.
    const hits = src.match(/<script>(?!\s*<\/script>)/g) || [];
    assert.deepStrictEqual(hits, [], `${rel} bevat een inline <script> — externaliseer naar een .js-bestand`);
  }
});
