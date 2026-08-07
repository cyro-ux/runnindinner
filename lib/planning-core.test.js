/**
 * Tests voor het planning-algoritme in app.js.
 *
 * app.js is browsercode (geen module), dus we draaien het in een vm-sandbox
 * met minimale stubs voor document/window/I18n. De top-level functies worden
 * globals in die sandbox; `state` is een top-level const en dus alleen
 * bereikbaar via de bestaande window.__rda_getState() hook.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const noop = () => {};
  const el = {
    classList: { add: noop, remove: noop, contains: () => false },
    addEventListener: noop, removeEventListener: noop,
    style: {}, value: '', textContent: '', innerHTML: '',
    appendChild: noop, focus: noop, reset: noop, remove: noop,
    querySelector: () => el, querySelectorAll: () => [],
  };
  const document = {
    querySelectorAll: () => [],
    querySelector: () => el,
    getElementById: () => el,
    createElement: () => el,
    addEventListener: noop,
    body: el,
    head: el,
  };
  const sandbox = {
    document,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    I18n: { t: (_k, fb) => fb ?? _k, getLang: () => 'nl', onReady: noop },
    fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }),
    alert: noop, confirm: () => true, prompt: () => null,
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'app.js' });
  sandbox.state = sandbox.__rda_getState();
  return sandbox;
}

/** Bouwt een deelnemer met standaard-beschikbaarheid voor alle gangen. */
function mkParticipant(id, opts = {}) {
  const courses = ['voorborrel', 'voorgerecht', 'hoofdgerecht', 'nagerecht', 'naborrel'];
  const availability = {};
  courses.forEach(c => {
    availability[c] = { person1: true, person2: true, person3: true, ...(opts.availability?.[c] || {}) };
  });
  // 'name2' in opts onderscheidt "expliciet null" (alleenstaand) van "niet
  // opgegeven" (default: koppel). Met ?? zou null ook de default triggeren.
  return {
    id,
    name1: opts.name1 || `P${id}`,
    name2: 'name2' in opts ? opts.name2 : `Partner${id}`,
    name3: 'name3' in opts ? opts.name3 : null,
    address: { street: 'Teststraat', housenumber: String(id), postcode: '1234AB', city: 'Testdorp', full: `Teststraat ${id}` },
    availability,
    hostPreference: opts.hostPreference ?? null,
    customMinGuests: opts.customMinGuests ?? null,
    customMaxGuests: opts.customMaxGuests ?? null,
    diet1: opts.diet1 ?? null,
    diet2: opts.diet2 ?? null,
    diet3: opts.diet3 ?? null,
    preferWith: [], avoid: [],
  };
}

// ── personSeatsAt ────────────────────────────────────────────────────────────

test('personSeatsAt telt 1, 2 of 3 stoelen', () => {
  const app = loadApp();
  const solo   = mkParticipant(1, { name2: null });
  const koppel = mkParticipant(2);
  const trio   = mkParticipant(3, { name3: 'Meereiziger' });

  assert.strictEqual(app.personSeatsAt(solo, 'voorgerecht'), 1);
  assert.strictEqual(app.personSeatsAt(koppel, 'voorgerecht'), 2);
  assert.strictEqual(app.personSeatsAt(trio, 'voorgerecht'), 3);
});

test('personSeatsAt respecteert beschikbaarheid per gang', () => {
  const app = loadApp();
  const trio = mkParticipant(1, {
    name3: 'Meereiziger',
    availability: { nagerecht: { person2: false, person3: false } },
  });
  assert.strictEqual(app.personSeatsAt(trio, 'voorgerecht'), 3);
  assert.strictEqual(app.personSeatsAt(trio, 'nagerecht'), 1, 'partner + meereiziger slaan nagerecht over');
});

// ── per-host capaciteit ──────────────────────────────────────────────────────

test('hostMaxGuests gebruikt custom waarde, anders de globale default', () => {
  const app = loadApp();
  app.state.config.maxTableSize = 6;

  assert.strictEqual(app.hostMaxGuests(mkParticipant(1)), 6, 'geen custom → globaal');
  assert.strictEqual(app.hostMaxGuests(mkParticipant(2, { customMaxGuests: 2 })), 2);
  assert.strictEqual(app.hostMaxGuests(mkParticipant(3, { customMaxGuests: 0 })), 6, '0 is ongeldig → globaal');
  assert.strictEqual(app.hostMaxGuests(undefined), 6, 'onbekende host → globaal');
});

test('REGRESSIE: meerdere krappe hosts krijgen genoeg tafels (geen overboeking)', () => {
  const app = loadApp();
  app.state.config.minTableSize = 4;
  app.state.config.maxTableSize = 6;
  app.state.forcedCombos = [];

  // 12 koppels = 24 personen. Drie hosts kunnen maar 2 gasten kwijt.
  const participants = [];
  for (let i = 1; i <= 12; i++) {
    participants.push(mkParticipant(i, {
      hostPreference: i <= 3 ? 'voorgerecht' : null,
      customMaxGuests: i <= 3 ? 2 : null,
    }));
  }
  app.state.participants = participants;

  const warnings = [];
  const hosts = app.assignHosts(participants, ['voorgerecht'], warnings).voorgerecht;

  const history = {};
  participants.forEach(p => { history[p.id] = new Set(); });
  const tables = app.fillTables('voorgerecht', hosts, participants, history, warnings);

  // Iedere niet-host moet geplaatst zijn.
  const hostIds = new Set(hosts.map(h => h.id));
  const placed = new Set(tables.flatMap(t => t.guestIds));
  const expectedGuests = participants.filter(p => !hostIds.has(p.id));
  assert.strictEqual(placed.size, expectedGuests.length, 'alle gasten geplaatst');

  // En geen enkele tafel mag boven zijn eigen maximum zitten.
  for (const t of tables) {
    const host = participants.find(p => p.id === t.hostId);
    const occupied = t.guestIds.reduce(
      (sum, gid) => sum + app.personSeatsAt(participants.find(p => p.id === gid), 'voorgerecht'), 0);
    assert.ok(
      occupied <= app.hostMaxGuests(host),
      `tafel van ${host.name1} heeft ${occupied} gasten, max ${app.hostMaxGuests(host)}`
    );
  }
});

test('per-host maximum wordt gerespecteerd bij één krappe host', () => {
  const app = loadApp();
  app.state.config.minTableSize = 4;
  app.state.config.maxTableSize = 6;
  app.state.forcedCombos = [];

  const participants = [];
  for (let i = 1; i <= 12; i++) {
    participants.push(mkParticipant(i, {
      hostPreference: i === 1 ? 'voorgerecht' : null,
      customMaxGuests: i === 1 ? 2 : null,
    }));
  }
  app.state.participants = participants;

  const warnings = [];
  const hosts = app.assignHosts(participants, ['voorgerecht'], warnings).voorgerecht;
  const history = {};
  participants.forEach(p => { history[p.id] = new Set(); });
  const tables = app.fillTables('voorgerecht', hosts, participants, history, warnings);

  const krapp = tables.find(t => t.hostId === 1);
  assert.ok(krapp, 'de krappe host is daadwerkelijk gastheer');
  const occupied = krapp.guestIds.reduce(
    (sum, gid) => sum + app.personSeatsAt(participants.find(p => p.id === gid), 'voorgerecht'), 0);
  assert.ok(occupied <= 2, `verwacht max 2 gasten, kreeg ${occupied}`);
});

// ── weergave-helpers ─────────────────────────────────────────────────────────

test('countSeats telt host + gasten en respecteert beschikbaarheid', () => {
  const app = loadApp();
  const host  = mkParticipant(1);                       // 2 personen
  const guest = mkParticipant(2, { name3: 'Extra' });    // 3 personen
  const skip  = mkParticipant(3, { availability: { nagerecht: { person2: false } } });

  const table = { course: 'voorgerecht', hostId: 1, guestIds: [2, 3] };
  assert.strictEqual(app.countSeats(table, [host, guest, skip]), 2 + 3 + 2);

  const laterTable = { course: 'nagerecht', hostId: 1, guestIds: [3] };
  assert.strictEqual(app.countSeats(laterTable, [host, skip]), 2 + 1, 'partner slaat nagerecht over');
});

test('dietsOf neemt de meereiziger mee', () => {
  const app = loadApp();
  const p = mkParticipant(1, { name3: 'Extra', diet1: 'Vegan', diet3: 'Glutenvrij' });
  assert.strictEqual(app.dietsOf(p), 'Vegan, Glutenvrij');
  assert.strictEqual(app.dietsOf(mkParticipant(2)), '');
  assert.strictEqual(app.dietsOf(undefined), '');
});

test('initialsOf is robuust bij lege namen', () => {
  const app = loadApp();
  assert.strictEqual(app.initialsOf(mkParticipant(1, { name1: 'Lieke', name2: 'Mark', name3: 'Sophie' })), 'LMS');
  assert.strictEqual(app.initialsOf(mkParticipant(2, { name1: 'Jan', name2: null })), 'J');
  assert.strictEqual(app.initialsOf({ name1: '', name2: null }), '?', 'lege naam geeft geen "UNDEFINED"');
  assert.strictEqual(app.initialsOf(undefined), '?');
});

test('displayName voegt partner en meereiziger toe', () => {
  const app = loadApp();
  assert.strictEqual(app.displayName(mkParticipant(1, { name1: 'A', name2: null })), 'A');
  assert.strictEqual(app.displayName(mkParticipant(2, { name1: 'A', name2: 'B' })), 'A & B');
  assert.strictEqual(app.displayName(mkParticipant(3, { name1: 'A', name2: 'B', name3: 'C' })), 'A & B & C');
});
