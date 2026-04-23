/**
 * Zoho Books API-client.
 *
 * Gebaseerd op de OAuth 2.0 refresh-token flow zoals beschreven in
 * requirements-document sectie 14a + blok H van 14b.
 *
 * **Vereist env-variables:**
 *   ZOHO_CLIENT_ID       — uit api-console.zoho.eu self-client
 *   ZOHO_CLIENT_SECRET   — idem
 *   ZOHO_REFRESH_TOKEN   — gegenereerd bij eerste setup
 *   ZOHO_ORG_ID          — Organization ID uit Zoho Books (Settings → Organization Profile)
 *   ZOHO_REGION          — 'com' (default), 'eu', 'in', 'com.au', …
 *
 * De client:
 *   - haalt zelf access-tokens op en cachet ze in-memory tot 5 min voor expiry
 *   - wrapt alle API-calls met automatische retry + refresh bij 401
 *   - logt fouten naar console (later: Sentry)
 */

'use strict';

const https = require('node:https');

const CLIENT_ID      = process.env.ZOHO_CLIENT_ID      || '';
const CLIENT_SECRET  = process.env.ZOHO_CLIENT_SECRET  || '';
const REFRESH_TOKEN  = process.env.ZOHO_REFRESH_TOKEN  || '';
const ORG_ID         = process.env.ZOHO_ORG_ID         || '';
const REGION         = process.env.ZOHO_REGION         || 'com';

const ACCOUNTS_HOST = {
  com:      'accounts.zoho.com',
  eu:       'accounts.zoho.eu',
  in:       'accounts.zoho.in',
  'com.au': 'accounts.zoho.com.au',
}[REGION] || 'accounts.zoho.com';

const BOOKS_HOST = {
  com:      'www.zohoapis.com',
  eu:       'www.zohoapis.eu',
  in:       'www.zohoapis.in',
  'com.au': 'www.zohoapis.com.au',
}[REGION] || 'www.zohoapis.com';

// Token-cache: in-memory + disk-persisted so PM2 restarts don't trigger
// new refresh-calls (which Zoho rate-limits aggressively).
const path = require('node:path');
const fs   = require('node:fs');
const TOKEN_CACHE_PATH = path.join(__dirname, '..', 'data', '.zoho-token-cache.json');

let _accessToken = null;
let _expiresAt   = 0;

// Load cache from disk on module load
try {
  if (fs.existsSync(TOKEN_CACHE_PATH)) {
    const cached = JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, 'utf8'));
    if (cached.accessToken && cached.expiresAt > Date.now() + 60000) {
      _accessToken = cached.accessToken;
      _expiresAt   = cached.expiresAt;
    }
  }
} catch { /* ignore cache load errors */ }

function _persistTokenCache() {
  try {
    fs.mkdirSync(path.dirname(TOKEN_CACHE_PATH), { recursive: true });
    fs.writeFileSync(
      TOKEN_CACHE_PATH,
      JSON.stringify({ accessToken: _accessToken, expiresAt: _expiresAt }),
      { mode: 0o600 },
    );
  } catch { /* non-fatal */ }
}

function _isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN && ORG_ID);
}

function _request({ host, method = 'GET', path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const opts = {
      host,
      method,
      path,
      headers: { Accept: 'application/json', ...headers },
      timeout: 15000,
    };
    const req = https.request(opts, (resp) => {
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { /* leave as string */ }
        resolve({ status: resp.statusCode, body: parsed ?? data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('zoho timeout')); });
    if (body) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.setHeader('Content-Length', Buffer.byteLength(payload));
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Ruil refresh-token in voor een access-token.
 * Wordt automatisch aangeroepen wanneer de huidige token verlopen is.
 */
async function _fetchAccessToken() {
  if (!_isConfigured()) {
    throw new Error('[zoho] missing credentials — set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID');
  }
  const params = new URLSearchParams({
    refresh_token: REFRESH_TOKEN,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type:    'refresh_token',
  });
  const { status, body } = await _request({
    host:    ACCOUNTS_HOST,
    method:  'POST',
    path:    `/oauth/v2/token?${params.toString()}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (status !== 200 || !body?.access_token) {
    const err = body?.error || body?.error_description || `HTTP ${status}`;
    throw new Error(`[zoho] token refresh failed: ${err}`);
  }
  _accessToken = body.access_token;
  _expiresAt   = Date.now() + (body.expires_in * 1000) - (5 * 60 * 1000); // refresh 5 min vóór expiry
  _persistTokenCache();
  return _accessToken;
}

async function _getAccessToken() {
  if (_accessToken && Date.now() < _expiresAt) return _accessToken;
  return _fetchAccessToken();
}

/**
 * Authenticated call naar de Zoho Books API.
 * Pad begint met `/books/v3/...`, organization_id wordt automatisch toegevoegd.
 */
async function call(method, path, { body = null, query = {} } = {}) {
  if (!_isConfigured()) {
    throw new Error('[zoho] not configured — skipping call');
  }
  const token = await _getAccessToken();
  const qp = new URLSearchParams({ organization_id: ORG_ID, ...query });
  const fullPath = `${path}?${qp.toString()}`;

  let resp = await _request({
    host: BOOKS_HOST,
    method,
    path: fullPath,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  // 401 handling — only refresh+retry if the 401 looks like an expired token,
  // NOT if it's a scope/permission problem (retrying won't help there and
  // spams Zoho's rate-limiter).
  if (resp.status === 401) {
    const bodyStr = JSON.stringify(resp.body || '');
    const isExpiredToken = /invalid.?token|token.?expired|token.?invalid/i.test(bodyStr);
    const isScope = /not authorized|invalid_token_scope|insufficient/i.test(bodyStr);

    if (isExpiredToken && !isScope) {
      _accessToken = null; _expiresAt = 0;
      const fresh = await _getAccessToken();
      resp = await _request({
        host: BOOKS_HOST,
        method,
        path: fullPath,
        headers: {
          Authorization: `Zoho-oauthtoken ${fresh}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    }
    // scope 401 → just fall through to throw below (don't retry)
  }

  if (resp.status >= 200 && resp.status < 300) return resp.body;
  const errMsg = resp.body?.message || JSON.stringify(resp.body);
  throw new Error(`[zoho] ${method} ${path} → ${resp.status}: ${errMsg}`);
}

// ── High-level helpers ──────────────────────────────────────────────────────

/**
 * Zoek customer op e-mailadres. Retourneert alleen contacten van type
 * 'customer'; vendors met hetzelfde email worden overgeslagen zodat we
 * niet per ongeluk op een inkoop-contact een verkoop-factuur maken.
 */
async function findCustomerByEmail(email) {
  // Zoho accepteert contact_type als query-filter
  const body = await call('GET', '/books/v3/contacts', {
    query: { email, contact_type: 'customer' },
  });
  return body?.contacts?.[0] || null;
}

/**
 * Maak een nieuwe customer aan in Zoho Books.
 * Minimaal vereist: contact_name + email.
 */
async function createCustomer({ name, email, country, vatId, isBusiness = false }) {
  const body = {
    contact_name:    name || email,
    company_name:    isBusiness ? name : undefined,
    contact_type:    'customer',
    customer_sub_type: isBusiness ? 'business' : 'individual',
    contact_persons: [{ email, is_primary_contact: true }],
    billing_address: country ? { country } : undefined,
    vat_treatment:   undefined, // ingevuld door VatResolver bij invoice
    tax_reg_no:      vatId || undefined,
  };
  const resp = await call('POST', '/books/v3/contacts', { body });
  return resp?.contact;
}

/**
 * Maak een factuur aan voor een bestaande customer.
 *
 * @param {object} opts
 * @param {string} opts.customerId        Zoho customer_id
 * @param {string} opts.currency          ISO 4217 ('EUR', 'GBP', ...)
 * @param {number} opts.netCents          bedrag EXCL. BTW in centen (Zoho voegt BTW toe)
 * @param {string} opts.description       "Running Dinner Planner – 1 jaar abonnement"
 * @param {string} opts.mollie_payment_id voor idempotency/reference
 * @param {string} [opts.invoiceNumber]   Onze eigen factuurnummer (RD-2026-xxxx); Zoho neemt deze over i.p.v. auto-nummering
 * @param {string} [opts.taxId]           Zoho tax_id (uit getTaxId); null = non-taxable line
 * @param {string} [opts.exemptionReason] indien 0% — wordt als notitie op factuur gezet
 * @param {string} [opts.accountId]       Zoho account_id (grootboek) voor de omzet-regel
 * @param {string} [opts.templateId]      Zoho invoice-template_id — overschrijft default layout (logo, header, footer)
 */
async function createInvoice(opts) {
  const {
    customerId, currency, netCents, description,
    mollie_payment_id, invoiceNumber, taxId, exemptionReason, accountId, templateId,
  } = opts;

  const netAmount = netCents / 100;
  const lineItem = {
    name: description,
    rate: netAmount, // Zoho: rate is unit price EXCL tax; Zoho adds VAT separately
    quantity: 1,
    item_total: netAmount,
  };
  if (accountId) {
    lineItem.account_id = accountId;
  }
  if (taxId) {
    lineItem.tax_id = taxId;
  } else {
    // No matching tax — mark line as non-taxable
    lineItem.tax_exemption_code = 'non-taxable';
  }

  const body = {
    customer_id: customerId,
    currency_code: String(currency).toUpperCase(),
    reference_number: mollie_payment_id,
    notes: exemptionReason || undefined,
    line_items: [lineItem],
    payment_options: { payment_gateways: [] }, // al betaald via Mollie
  };
  // Eigen factuurnummer meegeven (RD-2026-xxxx) zodat Zoho deze als
  // invoice_number opslaat i.p.v. zijn eigen INV-xxx serie. Zo zijn de
  // nummers in onze app, Brevo-mail en Zoho gelijk en herkent de
  // accountant direct runningdinner.app-facturen tussen VMH-facturen.
  if (invoiceNumber) {
    body.invoice_number = invoiceNumber;
    // Vertel Zoho dat wij onze eigen nummer beheren voor deze invoice
    // (anders negeert Zoho het veld en gebruikt zijn auto-nummering).
    body.ignore_auto_number_generation = true;
  }
  if (templateId) {
    body.template_id = templateId;
  }
  const resp = await call('POST', '/books/v3/invoices', { body });
  return resp?.invoice;
}

/**
 * Markeer een factuur als betaald (record payment).
 */
async function recordPayment({ invoiceId, amountCents, currency, date, paymentMode = 'mollie' }) {
  const body = {
    customer_id:  undefined, // vult Zoho in op basis van invoice
    payment_mode: paymentMode,
    amount:       amountCents / 100,
    date:         date || new Date().toISOString().split('T')[0],
    reference_number: paymentMode,
    invoices:     [{ invoice_id: invoiceId, amount_applied: amountCents / 100 }],
  };
  const resp = await call('POST', '/books/v3/customerpayments', { body });
  return resp?.payment;
}

/**
 * Maak een creditnota aan voor een refund of chargeback.
 */
async function createCreditNote({ invoiceId, amountCents, reason }) {
  const body = {
    invoice_id: invoiceId,
    line_items: [{
      name:        reason || 'Refund',
      rate:        amountCents / 100,
      quantity:    1,
      item_total:  amountCents / 100,
    }],
  };
  const resp = await call('POST', '/books/v3/creditnotes', { body });
  return resp?.creditnote;
}

module.exports = {
  isConfigured: _isConfigured,
  call,
  findCustomerByEmail,
  createCustomer,
  createInvoice,
  recordPayment,
  createCreditNote,
  // test-hulpje om de token-cache te resetten
  _resetTokenCache: () => { _accessToken = null; _expiresAt = 0; },
};
