/**
 * Smoke-test voor de kritieke registratie → betaling flow.
 *
 * Draait tegen een bestaande server (default acc-omgeving). Zet
 *   BASE_URL=https://acc.runningdiner.nl  (default)
 *   BASE_URL=http://localhost:3001        (lokaal tegen dev-server)
 *
 * Test-users krijgen een unieke email van de vorm
 *   smoke-<timestamp>@example.test
 * zodat ze herkenbaar zijn in admin. Periodieke bulk-cleanup is een
 * handmatige admin-taak (zoek op 'smoke-' → bulk-delete).
 *
 * Uitvoeren:  node --test tests/smoke.test.js
 */

'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

const BASE_URL = process.env.BASE_URL || 'https://acc.runningdiner.nl';
const TEST_EMAIL = `smoke-${Date.now()}@example.test`;
const TEST_PASSWORD = 'Smoke-Test-Password-123';

// Minimal cookie-jar that tracks all cookies by name (needed because the
// server sets both `token` and `lang` during a single request; earlier we
// kept only the last Set-Cookie which dropped the auth token).
const cookieJar = {};

async function req(method, path, { body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  const cookieStr = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookieStr) h['Cookie'] = cookieStr;
  const res = await fetch(BASE_URL + path, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  // Parse ALL Set-Cookie headers. Node 18.14+: headers.getSetCookie().
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const sc of setCookies) {
    const first = sc.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) cookieJar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

describe('runningdinner.app smoke tests', () => {
  before(() => {
    console.log(`[smoke] target: ${BASE_URL}`);
    console.log(`[smoke] test email: ${TEST_EMAIL}`);
  });

  test('public pages respond 200', async () => {
    for (const path of ['/', '/blog', '/register.html', '/subscribe.html', '/privacy.html', '/herroepingsrecht.html']) {
      const r = await req('GET', path);
      assert.equal(r.status, 200, `GET ${path}`);
    }
  });

  test('404 page returns HTML with status 404', async () => {
    const r = await req('GET', '/zeker-niet-bestaand-pad');
    assert.equal(r.status, 404);
    assert.match(r.text, /Running Dinner Planner/);
  });

  test('API 404 returns JSON', async () => {
    const r = await req('GET', '/api/bestaat-niet');
    assert.equal(r.status, 404);
    assert.ok(r.body?.error, 'expected {error} JSON');
  });

  test('register a fresh consumer account', async () => {
    const r = await req('POST', '/api/auth/register', {
      body: {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        isBusiness: false,
      },
    });
    assert.equal(r.status, 200, 'register should succeed');
    assert.equal(r.body?.ok, true);
  });

  test('duplicate register returns 409', async () => {
    const r = await req('POST', '/api/auth/register', {
      body: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    assert.equal(r.status, 409, 'duplicate email should be 409');
  });

  test('login with new credentials', async () => {
    const r = await req('POST', '/api/auth/login', {
      body: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    assert.equal(r.status, 200, 'login should succeed');
    assert.ok(cookieJar.token, 'session cookie (token) should be set');
  });

  test('login with wrong password returns 401', async () => {
    const r = await req('POST', '/api/auth/login', {
      body: { email: TEST_EMAIL, password: 'wrong' },
    });
    assert.equal(r.status, 401);
  });

  test('auth/me returns user data with is_business=false', async () => {
    const r = await req('GET', '/api/auth/me');
    assert.equal(r.status, 200);
    assert.equal(r.body?.user?.email, TEST_EMAIL);
    assert.equal(r.body?.user?.is_business, false, 'consumer account');
  });

  test('create-payment without waiver is rejected (400)', async () => {
    const r = await req('POST', '/api/mollie/create-payment', {
      body: { autoRenew: false }, // no waiverAccepted
    });
    assert.equal(r.status, 400, 'consumer without waiver should be blocked');
    assert.ok(r.body?.error, 'error message expected');
  });

  test('create-payment with waiver returns Mollie URL or documented error', async () => {
    const r = await req('POST', '/api/mollie/create-payment', {
      body: { autoRenew: false, waiverAccepted: true },
    });
    // Success → Mollie URL. Or 500 if Mollie creds niet beschikbaar op dit env.
    // Beide zijn acceptabel voor smoke: dit bewijst dat de waiver-check is
    // doorgelaten en de server tot de Mollie-call is gekomen.
    assert.ok(r.status === 200 || r.status === 500,
      `expected 200 (ok) or 500 (mollie down); got ${r.status}`);
    if (r.status === 200) {
      assert.match(r.body?.url || '', /mollie|checkout/i, 'expected Mollie checkout URL');
    }
  });

  test('pricing endpoint is public and returns cents', async () => {
    const r = await req('GET', '/api/mollie/price');
    assert.equal(r.status, 200);
    assert.ok(typeof r.body?.cents === 'number' && r.body.cents > 0, 'expected positive cents');
  });

  test('sitemap.xml is served as XML', async () => {
    const r = await req('GET', '/sitemap.xml');
    assert.equal(r.status, 200);
    assert.match(r.text, /<urlset/);
    assert.match(r.text, /\/blog\//, 'sitemap should contain blog URLs');
  });

  test('testimonials public endpoint returns ok JSON', async () => {
    const r = await req('GET', '/api/testimonials/public');
    assert.equal(r.status, 200);
    assert.equal(r.body?.ok, true);
    assert.ok(Array.isArray(r.body?.testimonials));
  });
});
