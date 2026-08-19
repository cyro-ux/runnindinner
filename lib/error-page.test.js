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

test('renderErrorPage: onbekende locale valt terug op EN met veilige links', () => {
  const html = renderErrorPage(404, 'fr');
  assert.ok(html.includes('This page does not exist'), 'EN-tekst');
  assert.ok(!html.includes('/fr/'), 'geen kapotte /fr/-links');
  assert.ok(html.includes('lang="en"'));
});

test('renderErrorPage: Duits (grootste markt) heeft eigen teksten', () => {
  const html = renderErrorPage(404, 'de');
  assert.ok(html.includes('Diese Seite existiert nicht'));
  assert.ok(html.includes('/de/'), 'links naar Duitse pagina’s');
});
