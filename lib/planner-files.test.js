/**
 * Consistentie-wachter voor het planner-manifest (lib/planner-files.js).
 *
 * index.html moet exact de manifest-bestanden laden, in dezelfde volgorde —
 * een deel vergeten of verkeerd geordend zou pas in de browser opvallen
 * (ReferenceError bij init), niet in de vm-tests die zelf concateneren.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLANNER_FILES = require('./planner-files');
const root = path.join(__dirname, '..');

test('alle manifest-bestanden bestaan en zijn niet leeg', () => {
  for (const f of PLANNER_FILES) {
    const stat = fs.statSync(path.join(root, f));
    assert.ok(stat.size > 100, `${f} is verdacht klein (${stat.size} bytes)`);
  }
});

test('index.html laadt exact de manifest-bestanden, in manifest-volgorde', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const loaded = [...html.matchAll(/<script src="(js\/planner\/[^"?]+)/g)].map((m) => m[1]);
  assert.deepStrictEqual(loaded, PLANNER_FILES);
});

test('nergens verwijst nog iets naar het oude app.js', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(!/src="app\.js/.test(html), 'index.html laadt nog app.js');
  assert.ok(!fs.existsSync(path.join(root, 'app.js')), 'app.js bestaat nog op de root');
});
