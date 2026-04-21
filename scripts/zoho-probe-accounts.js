#!/usr/bin/env node
/**
 * zoho-probe-accounts.js
 *
 * Test-factuurtjes aanmaken per BTW-scheme om te verifiëren dat de
 * juiste grootboekrekening (account_id) geraakt wordt door onze
 * zoho-sync integratie.
 *
 * Gebruik:
 *   node scripts/zoho-probe-accounts.js            (dry-run, logt alleen de mapping)
 *   node scripts/zoho-probe-accounts.js --create   (maakt DRAFT-facturen aan in Zoho)
 *
 * Facturen worden aangemaakt op een test-customer (Zoho contact met
 * e-mail zoho-probe@runningdinner.app) en bewust NIET gestatused, zodat
 * je ze na inspectie via de Zoho UI handmatig kunt verwijderen.
 */

'use strict';

require('dotenv').config();

const zoho = require('../lib/zoho-client');
const { ACCOUNT_MAP } = require('../lib/zoho-sync');
const { resolve: resolveVat, splitGross } = require('../lib/vat-resolver');
const taxMapper = require('../lib/zoho-tax-mapper');

const CASES = [
  { label: 'NL consumer',    country: 'NL', isBusiness: false, vatId: null,          vatIdValid: false },
  { label: 'DE consumer',    country: 'DE', isBusiness: false, vatId: null,          vatIdValid: false },
  { label: 'DE business+VAT',country: 'DE', isBusiness: true,  vatId: 'DE123456789', vatIdValid: true  },
  { label: 'GB consumer',    country: 'GB', isBusiness: false, vatId: null,          vatIdValid: false },
  { label: 'US consumer',    country: 'US', isBusiness: false, vatId: null,          vatIdValid: false },
];

(async () => {
  const doCreate = process.argv.includes('--create');
  console.log('─'.repeat(70));
  console.log(' Zoho Books grootboek-probe — vat.scheme → account_id');
  console.log('─'.repeat(70));
  console.log('ACCOUNT_MAP:', ACCOUNT_MAP);
  console.log('─'.repeat(70));

  const GROSS_CENTS = 995; // €9,95 zoals huidig abonnement
  let customerId = null;

  if (doCreate) {
    if (!zoho.isConfigured()) {
      console.error('Zoho is niet geconfigureerd — zet ZOHO_* env-vars.');
      process.exit(1);
    }
    console.log('[probe] zoek/maak test-customer zoho-probe@runningdinner.app …');
    const existing = await zoho.findCustomerByEmail('zoho-probe@runningdinner.app');
    if (existing?.contact_id) {
      customerId = existing.contact_id;
      console.log('[probe]   bestaand: ' + customerId);
    } else {
      const created = await zoho.createCustomer({
        name: 'Zoho Probe (do not use)',
        email: 'zoho-probe@runningdinner.app',
        country: 'NL',
        isBusiness: false,
      });
      customerId = created?.contact_id;
      console.log('[probe]   nieuw: ' + customerId);
    }
  }

  for (const c of CASES) {
    const vat = resolveVat(c);
    const split = splitGross(GROSS_CENTS, vat.rate);
    const accountId = ACCOUNT_MAP[vat.scheme] || ACCOUNT_MAP.DOMESTIC;
    console.log(
      `  ${c.label.padEnd(22)} scheme=${vat.scheme.padEnd(16)} rate=${String(vat.rate).padStart(4)}%  →  account_id=${accountId}`
    );

    if (doCreate && customerId) {
      let taxId = null;
      try { taxId = await taxMapper.getTaxId(vat); } catch {}
      try {
        const inv = await zoho.createInvoice({
          customerId,
          currency: 'EUR',
          netCents: split.netCents,
          description: `[PROBE ${c.label}] Running Dinner Planner`,
          mollie_payment_id: `probe_${Date.now()}_${c.label.replace(/\W/g, '')}`,
          taxId,
          exemptionReason: vat.exemptionReason,
          accountId,
        });
        console.log(`    → invoice_id=${inv?.invoice_id}  number=${inv?.invoice_number}`);
      } catch (err) {
        console.error(`    → FAIL: ${err.message}`);
      }
    }
  }

  console.log('─'.repeat(70));
  if (!doCreate) {
    console.log('Dry-run — draai nogmaals met --create om test-facturen aan te maken.');
  } else {
    console.log('Klaar. Verwijder de DRAFT-facturen in Zoho Books na verificatie.');
  }
})();
