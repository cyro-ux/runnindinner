/**
 * VatResolver — bepaalt het juiste BTW-tarief en de fiscale regel per klant.
 *
 * Input:  { country, isBusiness, vatId, vatIdValid, homeCountry='NL' }
 * Output: { rate, reason, taxCode, exemptionReason, scheme }
 *
 * Regels (zie requirements 14a):
 *   - NL-consument                         → 21% (thuis-land)
 *   - EU-consument (B2C)                   → lokaal EU-tarief via OSS
 *   - EU-B2B met geldig VAT-ID             → 0% reverse-charge (art. 44 2006/112/EG)
 *   - EU-B2B zonder (geldig) VAT-ID        → lokaal EU-tarief (behandelen als B2C)
 *   - UK                                   → 0% (voorlopig niet-gevestigde leverancier; accountant-keuze)
 *   - Non-EU (US/CA/AU/NZ/LatAm/…)         → 0% export van digitale dienst
 *
 * De module is puur — geen netwerk-calls, geen state.
 * Alle tarieven komen uit een tabel die één keer per jaar door de accountant wordt gecontroleerd.
 */

'use strict';

// EU-27 landcodes (ISO-3166-1 alpha-2) — let op: GB/UK zit hier NIET in sinds Brexit
const EU_COUNTRIES = new Set([
  'AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU','IE',
  'IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK',
]);

// EU BTW-tarieven voor digitale diensten (B2C) — standaard-tarief per land.
// Bron: EU Commission VAT rates in Member States (jaarlijks te controleren).
// Tarieven in % (2026; laat accountant bevestigen voor officieel gebruik).
const EU_B2C_RATES = {
  AT: 20, BE: 21, BG: 20, CY: 19, CZ: 21, DE: 19, DK: 25, EE: 22, ES: 21,
  FI: 25.5, FR: 20, GR: 24, HR: 25, HU: 27, IE: 23, IT: 22, LT: 21, LU: 17,
  LV: 21, MT: 18, NL: 21, PL: 23, PT: 23, RO: 19, SE: 25, SI: 22, SK: 23,
};

// ISO-3166 normalisatie: accepteer lowercase en synoniemen
function normCountry(cc) {
  if (!cc) return null;
  const c = String(cc).trim().toUpperCase();
  // UK is de ISO-fout-schrijfwijze; officieel is het GB
  if (c === 'UK') return 'GB';
  if (c === 'EL') return 'GR'; // Griekenland
  return c;
}

/**
 * Bepaal BTW voor een transactie.
 *
 * @param {object} input
 * @param {string} input.country       ISO-3166 landcode van de klant
 * @param {boolean} [input.isBusiness] true = zakelijke klant (EU B2B)
 * @param {string}  [input.vatId]      VAT-ID van zakelijke klant
 * @param {boolean} [input.vatIdValid] of vatId geverifieerd is via VIES
 * @param {string}  [input.homeCountry='NL'] het land waar runningdinner.app gevestigd is
 * @returns {{
 *   rate: number,            // percentage, 0-27
 *   scheme: string,          // 'DOMESTIC' | 'OSS' | 'REVERSE_CHARGE' | 'EXPORT' | 'UK'
 *   reason: string,          // menselijke uitleg (voor logs)
 *   taxCode: string,         // Zoho tax-code key (in Zoho-config te mappen)
 *   exemptionReason?: string // tekst voor op factuur indien 0%
 * }}
 */
function resolve({ country, isBusiness = false, vatId = null, vatIdValid = false, homeCountry = 'NL' } = {}) {
  const cc   = normCountry(country);
  const home = normCountry(homeCountry);

  if (!cc) {
    throw new Error('[VatResolver] country is required');
  }

  // 1. Thuis-land (NL voor Nederlandse leverancier) → altijd domestic rate
  if (cc === home) {
    const rate = EU_B2C_RATES[home] ?? 21;
    return {
      rate,
      scheme: 'DOMESTIC',
      reason: `Domestic sale in ${home}`,
      taxCode: `${home}_STANDARD_${rate}`,
    };
  }

  // 2. EU-land
  if (EU_COUNTRIES.has(cc)) {
    // B2B met geldig VAT-ID → reverse charge (0%)
    if (isBusiness && vatId && vatIdValid) {
      return {
        rate: 0,
        scheme: 'REVERSE_CHARGE',
        reason: `EU B2B reverse charge to ${cc} (VAT-ID ${vatId})`,
        taxCode: 'EU_REVERSE_CHARGE',
        exemptionReason: 'BTW verlegd, artikel 44 BTW-richtlijn 2006/112/EG',
      };
    }
    // B2C of B2B zonder geldig VAT-ID → lokaal tarief via OSS
    const rate = EU_B2C_RATES[cc];
    if (rate === undefined) {
      throw new Error(`[VatResolver] no EU B2C rate known for ${cc}`);
    }
    return {
      rate,
      scheme: 'OSS',
      reason: `EU B2C sale to ${cc} via One-Stop Shop`,
      taxCode: `OSS_${cc}_${rate}`,
    };
  }

  // 3. Verenigd Koninkrijk (post-Brexit, apart geval)
  //    Voor nu: zero-rate (niet-gevestigde leverancier < drempel). Accountant
  //    kan overstappen naar UK VAT-registratie zodra drempel gehaald is.
  if (cc === 'GB') {
    return {
      rate: 0,
      scheme: 'UK',
      reason: 'UK sale — non-established supplier, below registration threshold',
      taxCode: 'UK_ZERO',
      exemptionReason: 'Outside scope of UK VAT (non-established, digital service below threshold)',
    };
  }

  // 4. Alle overige landen (US/CA/AU/NZ/LatAm/…) → 0% export
  return {
    rate: 0,
    scheme: 'EXPORT',
    reason: `Export of digital service to ${cc}`,
    taxCode: 'EXPORT_ZERO',
    exemptionReason: 'Export van digitale dienst buiten de EU',
  };
}

/**
 * Bereken de BTW-bedragen op basis van een netto-bedrag (in centen).
 * Mollie-prijs is inclusief BTW; voor invoices willen we netto + BTW apart.
 *
 * @param {number} grossCents  totaalbedrag in centen (incl. BTW)
 * @param {number} rate        BTW-percentage (bijv. 21)
 * @returns {{ netCents: number, vatCents: number, grossCents: number }}
 */
function splitGross(grossCents, rate) {
  if (rate === 0) {
    return { netCents: grossCents, vatCents: 0, grossCents };
  }
  // net = gross / (1 + rate/100)
  const netCents = Math.round(grossCents / (1 + rate / 100));
  const vatCents = grossCents - netCents;
  return { netCents, vatCents, grossCents };
}

module.exports = {
  resolve,
  splitGross,
  EU_COUNTRIES,
  EU_B2C_RATES,
  normCountry,
};
