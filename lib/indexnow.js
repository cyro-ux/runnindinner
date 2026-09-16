/**
 * IndexNow (Bing/DuckDuckGo/Yandex e.a.): meldt URL's direct bij zoekmachines
 * zodra er content wijzigt, i.p.v. wachten op een crawl.
 *
 * De sleutel is bewust publiek: het protocol verifieert eigendom doordat
 * dezelfde sleutel op https://<host>/<key>.txt staat (zie public/).
 * Aangeroepen vanuit de deploy (routes/admin.js: POST /api/admin/indexnow)
 * na elke prod-deploy — deploys zijn precies de momenten waarop content wijzigt.
 */
'use strict';

const KEY = '58c073495c5a4b64877fc04ab286686d';
const ENDPOINT = 'https://api.indexnow.org/indexnow';

function extractSitemapUrls(xml) {
  return [...String(xml).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

function buildPayload(urls, base = 'https://runningdinner.app') {
  const host = new URL(base).host;
  return {
    host,
    key: KEY,
    keyLocation: `${base}/${KEY}.txt`,
    urlList: urls,
  };
}

/** Leest de eigen sitemap en dient alle URL's in bij IndexNow. */
async function submitSitemap(base = 'https://runningdinner.app', fetchImpl = fetch) {
  const res = await fetchImpl(`${base}/sitemap.xml`);
  if (!res.ok) throw new Error(`sitemap fetch failed: ${res.status}`);
  const urls = extractSitemapUrls(await res.text());
  if (urls.length === 0) return { submitted: 0, status: null };
  const submit = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(buildPayload(urls, base)),
  });
  // 200 = verwerkt, 202 = geaccepteerd (sleutelvalidatie volgt async)
  return { submitted: urls.length, status: submit.status };
}

module.exports = { KEY, extractSitemapUrls, buildPayload, submitSitemap };
