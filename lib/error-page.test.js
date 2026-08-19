'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { renderErrorPage } = require('./error-page');

test('renderErrorPage: 404 en 500 in alle 4 talen', () => {
  for (const locale of ['nl', 'en', 'es', 'de']) {
    for (const status of [404, 500]) {
      const html = renderErrorPage(status, locale);
      assert.ok(html.includes(String(status)), `${locale}/${status}: statuscode zichtbaar`);
      assert.ok(html.includes('Running Dinner Planner'), `${locale}/${status}: branding`);
    }
  }
});

test('renderErrorPage: onbekende locale valt terug op NL', () => {
  assert.ok(renderErrorPage(404, 'fr').includes('bestaat niet'));
});
