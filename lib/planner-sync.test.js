/**
 * Tests voor de serverside planner-opslag (routes/account.js):
 * roundtrip, validatie, groottelimiet en verwijderen. In-memory SQLite;
 * skipt lokaal (geen native build), draait in de CI-gate.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

let Database = null;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); }
catch { Database = null; }

function makeApp(db) {
  const express = require('express');
  const accountRoutes = require('../routes/account');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(accountRoutes({
    db,
    t: (_req, k) => k,
    requireAuth: (req, _res, next) => { req.user = { id: 'u1', email: 'x@y.z' }; next(); },
    uuidv4: () => 'id-' + Math.random().toString(36).slice(2),
    bcrypt: {}, mollie: {}, sendMail: async () => {}, wrapHtml: (b) => b,
    activeSessions: new Map(), generateReferralCode: () => 'code',
    BASE_URL: 'http://test', SUPPORTED_LANGS: ['nl'],
    PDFDocument: function () {}, formatEur: (c) => String(c), invoiceNumber: () => 'X',
  }));
  return app;
}

test('planner-opslag: roundtrip, validatie, limiet, delete', { skip: !Database }, async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE planner_saves (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, slot TEXT NOT NULL DEFAULT 'current',
    state_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(user_id, slot));`);
  const server = makeApp(db).listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/planner/state`;
    const call = async (method, body) => {
      const r = await fetch(base, { method, headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, data: await r.json().catch(() => null) };
    };

    let r = await call('GET');
    assert.strictEqual(r.data.state, null, 'leeg bij start');

    const state = { config: { eventName: 'Test' }, participants: [{ id: 1, name1: 'A' }], nextId: 2 };
    r = await call('PUT', { state });
    assert.strictEqual(r.status, 200);

    r = await call('GET');
    assert.deepStrictEqual(r.data.state, state, 'roundtrip identiek');
    assert.ok(r.data.updatedAt > 0);

    // tweede PUT overschrijft (upsert, geen tweede rij)
    await call('PUT', { state: { config: { eventName: 'V2' } } });
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM planner_saves').get().c, 1);
    r = await call('GET');
    assert.strictEqual(r.data.state.config.eventName, 'V2');

    r = await call('PUT', { state: 'geen-object' });
    assert.strictEqual(r.status, 400);

    r = await call('PUT', { state: { blob: 'x'.repeat(450 * 1024) } });
    assert.strictEqual(r.status, 413, 'te groot geweigerd');

    r = await call('DELETE');
    assert.strictEqual(r.status, 200);
    r = await call('GET');
    assert.strictEqual(r.data.state, null, 'weg na delete');
  } finally {
    server.close();
  }
});
