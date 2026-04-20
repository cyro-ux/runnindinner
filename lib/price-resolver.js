/**
 * PriceResolver — bepaalt de juiste prijs + valuta per land.
 *
 * Strategie (uit groeiplan sectie 4.3):
 *   - NL/EU/Ierland: €5,00
 *   - UK:            £4,99
 *   - US:            $5,99
 *   - CA:            C$7,99
 *   - AU:            A$8,99
 *   - NZ:            NZ$9,99
 *   - LatAm + rest:  $5,99 (USD)
 *
 * Input:  { country, currency? }
 * Output: { currency, cents, displayPrice, locale, mollieMethods }
 */

'use strict';

const { EU_COUNTRIES } = require('./vat-resolver');

// Prijstabel. Verander hier één keer en het werkt overal door.
const PRICING = {
  EUR: { cents: 500,  symbol: '€',    format: (v) => `€${v.toFixed(2).replace('.', ',')}` },
  GBP: { cents: 499,  symbol: '£',    format: (v) => `£${v.toFixed(2)}` },
  USD: { cents: 599,  symbol: '$',    format: (v) => `$${v.toFixed(2)}` },
  CAD: { cents: 799,  symbol: 'C$',   format: (v) => `C$${v.toFixed(2)}` },
  AUD: { cents: 899,  symbol: 'A$',   format: (v) => `A$${v.toFixed(2)}` },
  NZD: { cents: 999,  symbol: 'NZ$',  format: (v) => `NZ$${v.toFixed(2)}` },
};

// Landcode → valuta-mapping. Niet-gelisted = EUR (EU) of USD (rest).
const COUNTRY_CURRENCY = {
  GB: 'GBP', UK: 'GBP', IE: 'EUR', // UK-special: ondanks post-Brexit blijft EUR in IE
  US: 'USD', PR: 'USD', VI: 'USD',
  CA: 'CAD',
  AU: 'AUD',
  NZ: 'NZD',
};

// Betaalmethode-volgorde per locale (eerste = default geselecteerd in checkout)
const PAYMENT_METHOD_ORDER = {
  NL: ['ideal',     'creditcard', 'paypal', 'bancontact', 'applepay', 'googlepay'],
  BE: ['bancontact','creditcard', 'ideal',  'paypal',     'applepay', 'googlepay'],
  DE: ['creditcard','paypal',     'sofort', 'applepay',   'googlepay'],
  FR: ['creditcard','paypal',     'applepay','googlepay'],
  // EU-fallback: kaart eerst
  EU: ['creditcard','paypal',     'sepadirectdebit', 'applepay', 'googlepay'],
  // Rest of world: kaart + PayPal (iDEAL/Bancontact niet beschikbaar)
  INTL: ['creditcard','paypal',   'applepay','googlepay'],
};

function normCountry(cc) {
  if (!cc) return null;
  const c = String(cc).trim().toUpperCase();
  if (c === 'UK') return 'GB';
  return c;
}

/**
 * Bepaal de prijs voor een bezoeker.
 * @param {object} input
 * @param {string} [input.country]    ISO-3166 alpha-2 landcode
 * @param {string} [input.currency]   expliciete valuta-override (voor handmatige keuze)
 * @returns {{
 *   currency: string,      // 'EUR' | 'GBP' | ...
 *   cents: number,         // 500, 499, 599, 799, 899, 999
 *   displayPrice: string,  // '€5,00', '£4.99', '$5.99', ...
 *   country: string,
 *   mollieMethods: string[] // geordende lijst voor checkout-UI
 * }}
 */
function resolve({ country, currency } = {}) {
  const cc = normCountry(country) || 'NL';

  // 1. Bepaal valuta: expliciete override > landmapping > EU-default > USD
  let curr = currency && PRICING[String(currency).toUpperCase()]
    ? String(currency).toUpperCase()
    : null;

  if (!curr) {
    curr = COUNTRY_CURRENCY[cc];
  }
  if (!curr) {
    // Niet in mapping: EU → EUR, rest → USD
    curr = EU_COUNTRIES.has(cc) ? 'EUR' : 'USD';
  }

  const priceConfig = PRICING[curr] || PRICING.EUR;

  // 2. Bepaal betaalmethode-volgorde
  const mollieMethods = PAYMENT_METHOD_ORDER[cc]
    || (EU_COUNTRIES.has(cc) ? PAYMENT_METHOD_ORDER.EU : PAYMENT_METHOD_ORDER.INTL);

  return {
    currency:     curr,
    cents:        priceConfig.cents,
    displayPrice: priceConfig.format(priceConfig.cents / 100),
    country:      cc,
    mollieMethods,
  };
}

/**
 * Beschikbare valuta's (voor de handmatige valuta-switcher in de UI).
 */
function availableCurrencies() {
  return Object.entries(PRICING).map(([code, cfg]) => ({
    code,
    symbol: cfg.symbol,
    displayPrice: cfg.format(cfg.cents / 100),
    cents: cfg.cents,
  }));
}

module.exports = {
  resolve,
  availableCurrencies,
  PRICING,
  COUNTRY_CURRENCY,
  PAYMENT_METHOD_ORDER,
};
