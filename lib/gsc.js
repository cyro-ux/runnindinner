/**
 * Google Search Console-client (Search Analytics API) op basis van een
 * service-account — zonder googleapis-dependency: JWT (RS256) via Node's
 * crypto, token-exchange en API-call via fetch.
 *
 * Vereist: GSC_KEY_FILE (pad naar service-account-JSON, buiten de webroot,
 * rechten 600) en de service-account toegevoegd als gebruiker op de
 * Search Console-property. GSC_SITE (default 'sc-domain:runningdinner.app').
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const SITE = process.env.GSC_SITE || 'sc-domain:runningdinner.app';

let cachedToken = null; // { value, expiresAt }

function isConfigured() {
  const p = process.env.GSC_KEY_FILE;
  return Boolean(p && fs.existsSync(p));
}

function loadKey() {
  return JSON.parse(fs.readFileSync(process.env.GSC_KEY_FILE, 'utf8'));
}

const b64url = (input) => Buffer.from(input).toString('base64')
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/** Maakt de ondertekende JWT-assertion voor de token-exchange. */
function buildAssertion(key, nowSec = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600,
  }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), key.private_key);
  return `${header}.${claims}.${b64url(signature)}`;
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.value;
  const key = loadKey();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: buildAssertion(key),
    }),
  });
  if (!res.ok) throw new Error(`GSC token-exchange mislukt: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

/**
 * Search Analytics-query. dimensions: ['query'|'page'|'country'|'device'|'date'].
 * Geeft rows: [{ keys, clicks, impressions, ctr, position }].
 */
async function query({ days = 28, dimensions = ['query'], rowLimit = 100, filters = [] } = {}) {
  const token = await getAccessToken();
  const end = new Date(); end.setDate(end.getDate() - 2); // GSC loopt ~2 dagen achter
  const start = new Date(end); start.setDate(start.getDate() - days);
  const iso = (d) => d.toISOString().slice(0, 10);
  const body = {
    startDate: iso(start), endDate: iso(end), dimensions, rowLimit,
    ...(filters.length ? { dimensionFilterGroups: [{ filters }] } : {}),
  };
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GSC query mislukt: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { startDate: body.startDate, endDate: body.endDate, rows: data.rows || [] };
}

module.exports = { isConfigured, query, buildAssertion };
