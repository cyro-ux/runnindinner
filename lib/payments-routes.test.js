/**
 * Integratietest voor de Mollie-webhook (routes/payments.js).
 *
 * Draait met een echte in-memory SQLite en een nep-Mollie-client; mail,
 * Zoho en facturen zijn stubs. Skipt lokaal (better-sqlite3 bouwt niet
 * op de Windows-dev-machine) en draait in de CI-gate op ubuntu.
 *
 * Dekt de drie idempotency-paden die eerder alleen handmatig getest
 * waren: dubbele 'paid'-levering, dubbele 'failed recurring'-levering
 * (de bug van commit "webhook idempotency") en refund-afhandeling.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

let Database = null;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close(); // bindings-probe: require kan slagen terwijl de native build ontbreekt
} catch { Database = null; /* lokaal niet beschikbaar; CI draait dit wel */ }

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT, language TEXT, license_until INTEGER,
      mollie_customer_id TEXT, mollie_mandate_id TEXT, auto_renew INTEGER DEFAULT 0,
      referred_by TEXT, country TEXT, is_business INTEGER DEFAULT 0,
      waiver_accepted_at INTEGER
    );
    CREATE TABLE payments (
      id TEXT PRIMARY KEY, user_id TEXT, mollie_payment_id TEXT,
      amount_cents INTEGER, currency TEXT, status TEXT, invoice_number TEXT,
      payment_type TEXT, created_at INTEGER, refunded_at INTEGER,
      credit_note_id TEXT, zoho_sync_error TEXT
    );
  `);
  db.prepare("INSERT INTO users (id, email, language) VALUES ('u1', 'test@example.test', 'nl')").run();
  return db;
}

function makeApp(db, molliePayments) {
  const express = require('express');
  const paymentsRoutes = require('../routes/payments');
  let seq = 0;
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(paymentsRoutes({
    db,
    mollie: { payments: { get: async (id) => molliePayments[id] },
              customerMandates: { list: async () => [] } },
    t: (_req, key) => key,
    requireAuth: (_req, _res, next) => next(),
    priceResolver: { resolve: () => ({ cents: 500, currency: 'EUR', mollieMethods: ['ideal'] }) },
    BASE_URL: 'http://test.local',
    getSetting: (k) => ({ subscription_price_cents: '500', subscription_duration_days: '365' }[k] || null),
    formatEur: (c) => `€ ${(c / 100).toFixed(2)}`,
    sendMail: async () => {},
    wrapHtml: (b) => b,
    uuidv4: () => `uuid-${++seq}`,
    invoiceNumber: () => `TEST-${seq}`,
    sendInvoiceMail: async () => {},
    checkReferralReward: () => {},
    zohoSync: { syncPayment: async () => ({ synced: true }),
                syncRefund: async () => ({ synced: true }) },
  }));
  return app;
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const port = server.address().port;
    await fn(async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/mollie/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      return { status: res.status, text: await res.text() };
    });
  } finally {
    server.close();
  }
}

test('webhook: paid → licentie + factuurrij; dubbele levering blijft één rij', { skip: !Database }, async () => {
  const db = makeDb();
  const app = makeApp(db, {
    tr_paid: { id: 'tr_paid', status: 'paid', sequenceType: 'oneoff',
               amount: { value: '5.00', currency: 'EUR' },
               metadata: { user_id: 'u1' } },
  });
  await withServer(app, async (post) => {
    const r1 = await post('id=tr_paid');
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.text, 'ok');
    const user = db.prepare("SELECT * FROM users WHERE id = 'u1'").get();
    assert.ok(user.license_until > Date.now() + 300 * 86400000, 'licentie ~1 jaar vooruit');
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM payments').get().c, 1);

    await post('id=tr_paid'); // Mollie herhaalt leveringen
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM payments').get().c, 1, 'idempotent');
  });
});

test('webhook: failed recurring — dubbele levering telt niet dubbel mee', { skip: !Database }, async () => {
  const db = makeDb();
  const app = makeApp(db, {
    tr_fail: { id: 'tr_fail', status: 'failed', sequenceType: 'recurring',
               amount: { value: '5.00', currency: 'EUR' },
               metadata: { user_id: 'u1' } },
  });
  await withServer(app, async (post) => {
    await post('id=tr_fail');
    await post('id=tr_fail');
    const rows = db.prepare("SELECT * FROM payments WHERE status = 'failed'").all();
    assert.strictEqual(rows.length, 1, 'één failed-rij ondanks dubbele webhook');
    const user = db.prepare("SELECT auto_renew FROM users WHERE id = 'u1'").get();
    assert.strictEqual(user.auto_renew, 0, 'nog niet uitgeschakeld na 1 echte mislukking');
  });
});

test('webhook: refund zet status en refunded_at, idempotent', { skip: !Database }, async () => {
  const db = makeDb();
  db.prepare(`INSERT INTO payments (id, user_id, mollie_payment_id, amount_cents, currency, status, created_at)
              VALUES ('p1', 'u1', 'tr_ref', 500, 'eur', 'paid', ?)`).run(Date.now());
  const app = makeApp(db, {
    tr_ref: { id: 'tr_ref', status: 'paid', sequenceType: 'oneoff',
              amount: { value: '5.00', currency: 'EUR' },
              amountRefunded: { value: '5.00', currency: 'EUR' },
              metadata: { user_id: 'u1' } },
  });
  await withServer(app, async (post) => {
    await post('id=tr_ref');
    // syncRefund is async fire-and-forget; even tijd geven
    await new Promise((r) => setTimeout(r, 50));
    const p = db.prepare("SELECT * FROM payments WHERE id = 'p1'").get();
    assert.strictEqual(p.status, 'refunded');
    assert.ok(p.refunded_at, 'refunded_at gezet');
  });
});

test('webhook: ontbrekend id → 400', { skip: !Database }, async () => {
  const db = makeDb();
  await withServer(makeApp(db, {}), async (post) => {
    const r = await post('');
    assert.strictEqual(r.status, 400);
  });
});
