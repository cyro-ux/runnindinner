/**
 * Zoho-sync — gegevens van de app naar Zoho Books brengen.
 *
 * Deze module is de enige plaats waar payments → invoices worden geschreven.
 * Het gebruikt VatResolver om het juiste BTW-tarief te bepalen en zoho-client
 * om de calls te doen.
 *
 * Idempotent: als `payments.zoho_invoice_id` al gevuld is, doet de call niets.
 */

'use strict';

const zoho = require('./zoho-client');
const taxMapper = require('./zoho-tax-mapper');
const { resolve: resolveVat, splitGross } = require('./vat-resolver');

/**
 * Mapping van vat.scheme → Zoho Books account_id (grootboekrekening).
 *
 * Gemaakt in Zoho Books (Other Income accounts, 2026-04-21):
 *   8040 Omzet RDA NL               4767620000000587025
 *   8041 Omzet RDA EU OSS            4767620000000587028
 *   8042 Omzet RDA Reverse Charge    4767620000000587031
 *   8043 Omzet RDA UK & Export       4767620000000587034
 *
 * Te overschrijven via env-vars ZOHO_ACCOUNT_DOMESTIC / _OSS / _REVERSE_CHARGE /
 * _UK / _EXPORT zodat accountant ze zonder code-change kan bijwerken.
 */
const ACCOUNT_MAP = {
  DOMESTIC:       process.env.ZOHO_ACCOUNT_DOMESTIC       || '4767620000000587025',
  OSS:            process.env.ZOHO_ACCOUNT_OSS            || '4767620000000587028',
  REVERSE_CHARGE: process.env.ZOHO_ACCOUNT_REVERSE_CHARGE || '4767620000000587031',
  UK:             process.env.ZOHO_ACCOUNT_UK             || '4767620000000587034',
  EXPORT:         process.env.ZOHO_ACCOUNT_EXPORT         || '4767620000000587034',
};

// Zoho invoice-template override. Default leeg → gebruikt VMH's default
// organisatie-template (correct: PDF-factuur is juridisch van VMH B.V.).
// Runningdinner.app-branding zit in de Brevo e-mail (wrapInvoiceHtml), niet
// in de PDF. Overschrijfbaar via env als er ooit een dedicated RDA-template
// moet komen. Zie ook stap 2 uit het factuur-plan 2026-04-23.
const INVOICE_TEMPLATE_ID = process.env.ZOHO_INVOICE_TEMPLATE_ID || '';

/**
 * Synchroniseer één betaling naar Zoho Books.
 * @param {object} db         better-sqlite3 instance
 * @param {string} paymentId  interne payments.id
 * @returns {Promise<{ synced: boolean, skipped?: boolean, error?: string, zoho_invoice_id?: string }>}
 */
async function syncPayment(db, paymentId) {
  if (!zoho.isConfigured()) {
    return { synced: false, skipped: true, error: 'zoho not configured' };
  }

  const payment = db.prepare(`
    SELECT p.*, u.email, u.country, u.is_business, u.vat_id, u.vat_id_valid,
           u.zoho_customer_id, u.company_name
    FROM payments p
    JOIN users u ON u.id = p.user_id
    WHERE p.id = ? AND p.status = 'paid'
  `).get(paymentId);

  if (!payment) {
    return { synced: false, error: 'payment not found or not paid' };
  }
  if (payment.zoho_invoice_id) {
    return { synced: true, skipped: true, zoho_invoice_id: payment.zoho_invoice_id };
  }

  // 1. Resolve BTW
  const country = payment.country || 'NL';
  const vat = resolveVat({
    country,
    isBusiness:  !!payment.is_business,
    vatId:       payment.vat_id,
    vatIdValid:  !!payment.vat_id_valid,
  });
  const split = splitGross(payment.amount_cents, vat.rate);

  // 2. Ensure customer in Zoho.
  //
  // Strategie: altijd een NIEUWE customer aanmaken met prefix "RDA — "
  // (behalve als we al een zoho_customer_id gecached hebben die zelf door
  // deze flow is aangemaakt). Dat voorkomt collision met historische Zoho-
  // contacten die toevallig hetzelfde email hebben (bv. Cyro's privé-adres
  // dat ook bij een andere klant staat). Accountant ziet ook meteen welke
  // klanten uit runningdinner.app komen doordat ze allemaal met "RDA — "
  // beginnen.
  let customerId = payment.zoho_customer_id;
  try {
    if (!customerId) {
      const baseName = payment.company_name
        || payment.email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const rdaName = 'RDA — ' + baseName;
      const created = await zoho.createCustomer({
        name:       rdaName,
        email:      payment.email,
        country,
        vatId:      payment.vat_id,
        isBusiness: !!payment.is_business,
      });
      customerId = created?.contact_id;
      if (customerId) {
        db.prepare('UPDATE users SET zoho_customer_id = ? WHERE id = ?')
          .run(customerId, payment.user_id);
      }
    }
  } catch (err) {
    _markFailed(db, paymentId, `customer sync: ${err.message}`);
    return { synced: false, error: err.message };
  }

  if (!customerId) {
    _markFailed(db, paymentId, 'no customer_id returned');
    return { synced: false, error: 'no customer_id returned' };
  }

  // 3. Resolve VatResolver scheme to actual Zoho tax_id
  let zohoTaxId = null;
  try {
    zohoTaxId = await taxMapper.getTaxId(vat);
  } catch (err) {
    console.warn('[zoho-sync] tax mapper failed, proceeding without tax_id:', err.message);
  }

  // 4. Resolve grootboek (account_id) op basis van BTW-scheme
  const accountId = ACCOUNT_MAP[vat.scheme] || ACCOUNT_MAP.DOMESTIC;
  if (!ACCOUNT_MAP[vat.scheme]) {
    console.warn(`[zoho-sync] no account mapping for scheme=${vat.scheme}, falling back to DOMESTIC`);
  }

  // 5. Create invoice (Zoho expects NET amount; it adds VAT from tax_id)
  try {
    const invoice = await zoho.createInvoice({
      customerId,
      currency:           (payment.currency || 'eur').toUpperCase(),
      netCents:           split.netCents,
      description:        'Running Dinner Planner — 1 jaar abonnement',
      mollie_payment_id:  payment.mollie_payment_id || payment.id,
      invoiceNumber:      payment.invoice_number,  // RD-2026-xxxx → Zoho neemt deze nummer over
      taxId:              zohoTaxId,
      exemptionReason:    vat.exemptionReason,
      accountId,
      templateId:         INVOICE_TEMPLATE_ID,
    });

    const invoiceId = invoice?.invoice_id;
    if (!invoiceId) {
      _markFailed(db, paymentId, 'no invoice_id returned');
      return { synced: false, error: 'no invoice_id returned' };
    }

    // 6. Record payment against invoice (al betaald via Mollie)
    try {
      await zoho.recordPayment({
        invoiceId,
        amountCents: payment.amount_cents,
        currency:    (payment.currency || 'eur').toUpperCase(),
        date:        new Date(payment.created_at).toISOString().split('T')[0],
        paymentMode: 'mollie',
      });
    } catch (err) {
      // Invoice exists maar payment-record faalt → waarschuwen maar niet falen
      console.warn('[zoho-sync] payment-record failed (invoice created):', err.message);
    }

    // 7. Update lokale record
    db.prepare(`
      UPDATE payments
      SET vat_rate = ?, vat_scheme = ?, country = ?,
          zoho_invoice_id = ?, zoho_sync_status = 'synced',
          zoho_sync_error = NULL, zoho_synced_at = ?
      WHERE id = ?
    `).run(vat.rate, vat.scheme, country, invoiceId, Date.now(), paymentId);

    return { synced: true, zoho_invoice_id: invoiceId };
  } catch (err) {
    _markFailed(db, paymentId, `invoice create: ${err.message}`);
    return { synced: false, error: err.message };
  }
}

function _markFailed(db, paymentId, error) {
  db.prepare(`
    UPDATE payments
    SET zoho_sync_status = 'failed', zoho_sync_error = ?
    WHERE id = ?
  `).run(String(error).slice(0, 500), paymentId);
}

/**
 * Creditnota voor refund/chargeback.
 */
async function syncRefund(db, paymentId, reason = 'Refund') {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment?.zoho_invoice_id) {
    return { synced: false, error: 'no zoho_invoice_id to refund' };
  }
  try {
    const note = await zoho.createCreditNote({
      invoiceId:   payment.zoho_invoice_id,
      amountCents: payment.amount_cents,
      reason,
    });
    return { synced: true, creditnote_id: note?.creditnote_id };
  } catch (err) {
    return { synced: false, error: err.message };
  }
}

/**
 * Dagelijks reconciliatie: check laatste 7 dagen op discrepanties.
 * Retourneert lijst van payments zonder zoho_invoice_id die wel status=paid hebben.
 */
function listDiscrepancies(db, daysBack = 7) {
  const since = Date.now() - daysBack * 86400000;
  return db.prepare(`
    SELECT id, user_id, mollie_payment_id, amount_cents, currency, created_at,
           zoho_sync_status, zoho_sync_error
    FROM payments
    WHERE status = 'paid'
      AND created_at >= ?
      AND (zoho_invoice_id IS NULL OR zoho_sync_status != 'synced')
    ORDER BY created_at DESC
  `).all(since);
}

module.exports = {
  syncPayment,
  syncRefund,
  listDiscrepancies,
  ACCOUNT_MAP, // geëxporteerd voor diagnose/probe-scripts
};
