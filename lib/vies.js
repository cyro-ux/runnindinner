/**
 * VIES — EU VAT-ID validator.
 *
 * Gebruikt de REST-variant van de VIES-service van de Europese Commissie:
 *   https://ec.europa.eu/taxation_customs/vies/rest-api/ms/<COUNTRY>/vat/<VATNUM>
 *
 * Retourneert: { valid, name, address, raw }
 *
 * Let op:
 *   - De VIES-service valt regelmatig uit per lidstaat. Bij een 5xx of timeout
 *     behandelen we de VAT-ID als NIET-gevalideerd (conservatieve keuze).
 *     Zo rekenen we eerder te veel BTW dan te weinig.
 *   - Het antwoord moet worden gecachet (min. 24u) om VIES niet te overbelasten.
 */

'use strict';

const https = require('node:https');

const VIES_TIMEOUT_MS = 8000;

// In-memory cache: { key: { valid, name, address, cachedAt } }
const _cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24u

function _cacheKey(country, vatNumber) {
  return `${String(country).toUpperCase()}:${String(vatNumber).replace(/\s/g, '')}`;
}

/**
 * Split een full VAT-ID (bijv. "DE123456789") in country + nummer.
 * Geeft { country, number } of throws als het formaat niet klopt.
 */
function parseVatId(fullId) {
  if (!fullId) throw new Error('[vies] VAT-ID is required');
  const s = String(fullId).replace(/\s/g, '').toUpperCase();
  const m = s.match(/^([A-Z]{2})([A-Z0-9+*.]{2,12})$/);
  if (!m) throw new Error(`[vies] invalid VAT-ID format: ${fullId}`);
  const country = m[1] === 'EL' ? 'GR' : m[1]; // Greece ISO-fout in VAT-context
  return { country, number: m[2] };
}

/**
 * Valideer een VAT-ID via de VIES-service.
 * @param {string} fullId  bijv. "DE123456789"
 * @returns {Promise<{valid:boolean, name?:string, address?:string, raw?:any, error?:string}>}
 */
async function validate(fullId) {
  let parsed;
  try {
    parsed = parseVatId(fullId);
  } catch (err) {
    return { valid: false, error: err.message };
  }
  const { country, number } = parsed;
  const cacheKey = _cacheKey(country, number);

  // Cache-hit
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return { valid: cached.valid, name: cached.name, address: cached.address, cached: true };
  }

  // Call VIES (REST API — newer, simpler than SOAP)
  const url = `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${country}/vat/${number}`;
  try {
    const body = await new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: VIES_TIMEOUT_MS }, (resp) => {
        let data = '';
        resp.on('data', (chunk) => { data += chunk; });
        resp.on('end', () => {
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch { reject(new Error('invalid JSON from VIES')); }
          } else {
            reject(new Error(`VIES HTTP ${resp.statusCode}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('VIES timeout')); });
    });

    // Shape of VIES REST response:
    // { isValid: true, requestDate: "...", userError: "VALID",
    //   name: "...", address: "...", requestIdentifier: "...", ... }
    const valid = body?.isValid === true;
    const entry = {
      valid,
      name: body?.name || null,
      address: body?.address || null,
      cachedAt: Date.now(),
    };
    _cache.set(cacheKey, entry);
    return { valid, name: entry.name, address: entry.address, raw: body };
  } catch (err) {
    // Conservatief: VIES down = niet-gevalideerd (gebruiker betaalt lokale BTW)
    return { valid: false, error: err.message };
  }
}

/**
 * Test-hulpje: cache leegmaken (voor unit-tests).
 */
function _clearCache() {
  _cache.clear();
}

module.exports = { validate, parseVatId, _clearCache };
