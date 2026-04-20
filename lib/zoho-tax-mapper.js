/**
 * Zoho tax-mapper — vertaalt VatResolver's interne taxCode/rate naar een
 * echte Zoho tax_id.
 *
 * Strategie:
 *   - Bij eerste gebruik: haal alle `GET /settings/taxes` op uit Zoho.
 *   - Cache 60 minuten (taxes wijzigen zelden).
 *   - Match op percentage + optioneel land/specific_type.
 *
 * Voor 0%-tarieven (export, UK, reverse-charge): Zoho kan dit aan via
 * een "Zero Rate"-tax-code of via `is_taxable: false` op de regel. Wij
 * proberen eerst een exacte match (naam bevat 'export' / 'zero' / 'reverse')
 * en vallen anders terug op `null` — dan zet zoho-sync de regel op
 * non-taxable.
 */

'use strict';

const zoho = require('./zoho-client');

let _cache = null;       // { fetchedAt, taxes: [...] }
const TTL_MS = 60 * 60 * 1000;

async function _fetchTaxes() {
  if (_cache && Date.now() - _cache.fetchedAt < TTL_MS) return _cache.taxes;
  const resp = await zoho.call('GET', '/books/v3/settings/taxes');
  const taxes = resp?.taxes || [];
  _cache = { fetchedAt: Date.now(), taxes };
  return taxes;
}

/**
 * Haal de Zoho tax_id op voor een gegeven VatResolver-resultaat.
 *
 * @param {object} vat  resultaat van VatResolver.resolve()
 * @returns {Promise<string|null>}  tax_id, of null als er geen passende tax is
 */
async function getTaxId(vat) {
  const taxes = await _fetchTaxes();
  const target = Number(vat.rate);

  // 1. Niet-nul tarief: match op percentage (exacte match)
  if (target > 0) {
    const match = taxes.find(t => Number(t.tax_percentage) === target);
    return match?.tax_id || null;
  }

  // 2. 0%: probeer te matchen op naam op basis van scheme
  const scheme = vat.scheme || '';
  const nameMatchers = {
    EXPORT:          /export|zero|0%|nul/i,
    UK:              /uk|zero|0%/i,
    REVERSE_CHARGE:  /reverse|verlegd|0%/i,
  };
  const matcher = nameMatchers[scheme];
  if (matcher) {
    const match = taxes.find(t => Number(t.tax_percentage) === 0 && matcher.test(t.tax_name || ''));
    if (match) return match.tax_id;
  }

  // Geen match — laat zoho-sync beslissen (zet is_taxable=false)
  return null;
}

/** Force-refresh van de tax-cache (voor na toevoegen/wijzigen in Zoho UI). */
function invalidate() { _cache = null; }

module.exports = { getTaxId, invalidate };
