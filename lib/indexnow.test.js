'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KEY, extractSitemapUrls, buildPayload, submitSitemap } = require('./indexnow');

test('extractSitemapUrls haalt alle loc-elementen uit de sitemap', () => {
  const xml = `<?xml version="1.0"?>
    <urlset><url><loc>https://runningdinner.app/</loc></url>
    <url><loc>https://runningdinner.app/blog/x</loc><lastmod>2026-09-11</lastmod></url>
    <xhtml:link rel="alternate" href="https://runningdinner.app/en/"/></urlset>`;
  assert.deepEqual(extractSitemapUrls(xml), [
    'https://runningdinner.app/',
    'https://runningdinner.app/blog/x',
  ]);
});

test('buildPayload bevat host, key en keyLocation volgens het protocol', () => {
  const p = buildPayload(['https://runningdinner.app/'], 'https://runningdinner.app');
  assert.equal(p.host, 'runningdinner.app');
  assert.equal(p.key, KEY);
  assert.equal(p.keyLocation, `https://runningdinner.app/${KEY}.txt`);
  assert.deepEqual(p.urlList, ['https://runningdinner.app/']);
});

test('submitSitemap leest sitemap en post naar IndexNow', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    if (String(url).endsWith('/sitemap.xml')) {
      return { ok: true, text: async () => '<urlset><url><loc>https://runningdinner.app/</loc></url></urlset>' };
    }
    return { ok: true, status: 202 };
  };
  const result = await submitSitemap('https://runningdinner.app', fakeFetch);
  assert.equal(result.submitted, 1);
  assert.equal(result.status, 202);
  assert.equal(calls.length, 2);
  const body = JSON.parse(calls[1].opts.body);
  assert.equal(body.host, 'runningdinner.app');
  assert.deepEqual(body.urlList, ['https://runningdinner.app/']);
});

test('sleutelbestand in public/ bevat exact de key', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'public', `${KEY}.txt`);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), KEY);
});
