/**
 * Route-calculator — afstanden en tijden tussen running-dinner-hosts.
 *
 * Kosten-bewuste architectuur:
 *   - Geocoding via Nominatim (OSM) — gratis, 1 req/s rate-limit
 *   - Routing via OSRM public server — gratis, geen API key
 *   - Alle responses gecached in memory (24u) EN in DB voor persistente cache
 *
 * Bij schaal: swap naar Mapbox ($0.50 per 1k requests) of self-host OSRM op
 * dezelfde Hetzner-machine. Dit is dan een one-line-change in `_geocode` /
 * `_route`.
 *
 * Privacy: alleen publieke adressen (event-locaties) worden doorgestuurd naar
 * OSM. Geen persoonlijke data verlaat onze server. Nominatim kent een strict
 * "don't send personal data" beleid.
 */

'use strict';

const https = require('node:https');

// Respecteer Nominatim usage policy: max 1 req/s, user-agent met contact
const USER_AGENT = 'runningdinner.app/1.0 (hello@runningdinner.nl)';
const NOMINATIM_HOST = 'nominatim.openstreetmap.org';
const OSRM_HOST = 'router.project-osrm.org';

// In-memory cache (24u TTL)
const _cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function _cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() - e.t > CACHE_TTL_MS) { _cache.delete(key); return null; }
  return e.v;
}
function _cacheSet(key, value) {
  _cache.set(key, { v: value, t: Date.now() });
}

function _httpGet(host, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host, path,
      headers: { 'User-Agent': USER_AGENT, ...headers },
      timeout: 10000,
    }, (resp) => {
      let data = '';
      resp.on('data', c => { data += c; });
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: resp.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Geocode een adres → { lat, lon, displayName }.
 * Gebruikt Nominatim, cached 24u.
 */
async function geocode(address) {
  if (!address) throw new Error('[route] address required');
  const key = `geo:${address.toLowerCase()}`;
  const cached = _cacheGet(key);
  if (cached) return cached;

  const q = encodeURIComponent(address);
  const path = `/search?q=${q}&format=json&limit=1&addressdetails=0`;
  const resp = await _httpGet(NOMINATIM_HOST, path);
  if (resp.status !== 200 || !Array.isArray(resp.body) || !resp.body.length) {
    throw new Error(`[route] no geocode result for: ${address}`);
  }
  const hit = resp.body[0];
  const result = {
    lat: parseFloat(hit.lat),
    lon: parseFloat(hit.lon),
    displayName: hit.display_name,
  };
  _cacheSet(key, result);
  return result;
}

/**
 * Bereken route (afstand in meters + duur in seconden) tussen twee coördinaten
 * via OSRM. Profile default: "driving" (auto); "cycling" en "walking" zijn
 * ook beschikbaar bij de public OSRM-server.
 */
async function route(from, to, profile = 'driving') {
  const key = `route:${profile}:${from.lat},${from.lon}:${to.lat},${to.lon}`;
  const cached = _cacheGet(key);
  if (cached) return cached;

  const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  const path = `/route/v1/${profile}/${coords}?overview=false&steps=false`;
  const resp = await _httpGet(OSRM_HOST, path);
  if (resp.status !== 200 || !resp.body?.routes?.length) {
    throw new Error('[route] no route found');
  }
  const r = resp.body.routes[0];
  const result = { distanceMeters: r.distance, durationSeconds: r.duration };
  _cacheSet(key, result);
  return result;
}

/**
 * High-level: bereken de totale route voor een deelnemer die 3 gangen loopt:
 * thuis → voorgerecht-host → hoofdgerecht-host → nagerecht-host → thuis.
 *
 * @param {Array<string>} addresses  Volgorde: [home, host1, host2, host3, home]
 * @param {string} [profile]        'driving' | 'cycling' | 'walking'
 * @returns {Promise<{segments, totalDistanceMeters, totalDurationSeconds}>}
 */
async function fullParticipantRoute(addresses, profile = 'driving') {
  if (!Array.isArray(addresses) || addresses.length < 2) {
    throw new Error('[route] need at least 2 addresses');
  }
  // Geocode alles (serieel — Nominatim 1 req/s policy)
  const points = [];
  for (const a of addresses) {
    points.push(await geocode(a));
    await new Promise(r => setTimeout(r, 1100)); // respect rate limit
  }
  // Route elk segment
  const segments = [];
  let totalDistance = 0;
  let totalDuration = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const r = await route(points[i], points[i + 1], profile);
    segments.push({
      from: addresses[i],
      to:   addresses[i + 1],
      distanceMeters:  r.distanceMeters,
      durationSeconds: r.durationSeconds,
    });
    totalDistance += r.distanceMeters;
    totalDuration += r.durationSeconds;
    await new Promise(r => setTimeout(r, 300));
  }
  return {
    segments,
    totalDistanceMeters:  totalDistance,
    totalDurationSeconds: totalDuration,
  };
}

/** Invalidate cache (voor unit-tests). */
function _clearCache() { _cache.clear(); }

module.exports = { geocode, route, fullParticipantRoute, _clearCache };
