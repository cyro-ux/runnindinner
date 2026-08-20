/**
 * Integratietest: boot de volledige server via de module-export (geen
 * child-process, geen vaste poort) en test kernroutes end-to-end.
 * Skipt lokaal (better-sqlite3 bouwt niet op Windows); draait in CI.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

let canRun = true;
try { new (require('better-sqlite3'))(':memory:').close(); } catch { canRun = false; }

test('server-boot: export, kernroutes en statics-allowlist', { skip: !canRun }, async () => {
  process.env.DB_PATH = path.join(os.tmpdir(), `rda-boot-test-${process.pid}.db`);
  process.env.NODE_ENV = 'test'; // geen scheduler
  process.env.JWT_SECRET = 'test-secret-for-boot-test-only';

  const app = require('../server');
  assert.strictEqual(typeof app, 'function', 'server.js exporteert de Express-app');

  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p) => {
      const r = await fetch(base + p, { redirect: 'manual' });
      return { status: r.status, headers: r.headers, text: await r.text() };
    };

    assert.strictEqual((await get('/')).status, 200, 'homepage');
    assert.strictEqual((await get('/app/')).status, 200, 'planner');
    const price = await get('/api/mollie/price');
    assert.strictEqual(price.status, 200, 'health-endpoint');
    assert.ok(JSON.parse(price.text).cents > 0);

    const apiMiss = await get('/api/bestaat-niet');
    assert.strictEqual(apiMiss.status, 404);
    assert.ok(JSON.parse(apiMiss.text).error, 'API-404 is JSON');

    // Regressie op het statics-lek: repo-root mag niet bereikbaar zijn
    for (const leak of ['/app/server.js', '/app/data/app.db', '/app/lib/mailer.js', '/demo/package.json']) {
      assert.strictEqual((await get(leak)).status, 404, `${leak} moet 404 zijn`);
    }

    // CSP-regressie: geen unsafe-inline in script-src, attr op none
    const csp = (await get('/')).headers.get('content-security-policy') || '';
    assert.match(csp, /script-src [^;]*'self'/);
    assert.ok(!/script-src [^;]*unsafe-inline/.test(csp), "script-src zonder 'unsafe-inline'");
    assert.match(csp, /script-src-attr [^;]*'none'/);
  } finally {
    server.close();
  }
});
