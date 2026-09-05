#!/usr/bin/env node
'use strict';

// Tests for lib/channel-drift-sweep.js against a throwaway in-memory database.
//
//   node scripts/test_channel_drift_sweep.js
//
// Touches nothing real: every case builds its own :memory: database, so this is
// safe to run on the production box and safe to run concurrently with itself.
//
// The tables below are the SHAPE the sweep reads, not a copy of the whole schema.
// eleme_product_map and eleme_sync_queue are reproduced column-for-column from
// database.js:5374-5412 plus the PACK_MAPS additions at :5515-5522 (units_per_pack,
// spec_key) and spec_name at :5471 — those are what the sweep actually touches, so
// a drift between this DDL and the real one would show up as a failing test rather
// than a passing one. store_products and retail_store_stock are cut down to the
// columns the sweep reads (store_products is assembled dynamically in database.js
// from the kitchen `products` table, so there is no literal DDL to copy).

const Database = require('better-sqlite3');
const sweep = require('../lib/channel-drift-sweep');

const { sweepStockDrift, chronicDrift, ELEME, CHRONIC_HOURS, MAX_ROWS, DRIFT_RETRY_HOURS } = sweep;

// ── Tiny harness ─────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push({ name, message: e.message });
    console.log(`  FAIL ${name}\n         ${e.message}`);
  }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || 'value'}: expected ${b}, got ${a}`);
}
function ok(cond, what) { if (!cond) throw new Error(what || 'expected truthy'); }
function section(t) { console.log(`\n${t}`); }

// ── Fixture ──────────────────────────────────────────────────────────────────

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE store_products (
      id            INTEGER PRIMARY KEY,
      sku           TEXT,
      name_cn       TEXT,
      name_en       TEXT,
      is_active     INTEGER DEFAULT 1,
      bundle_items  TEXT
    );
    CREATE TABLE retail_store_stock (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id     INTEGER NOT NULL,
      product_id   INTEGER NOT NULL,
      physical_qty INTEGER NOT NULL DEFAULT 0,
      UNIQUE(store_id, product_id)
    );
    CREATE TABLE eleme_product_map (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      retail_store_id   INTEGER NOT NULL,
      product_id        INTEGER NOT NULL,
      store_code        TEXT NOT NULL,
      extend_code       TEXT,
      eleme_name        TEXT,
      item_id           TEXT,
      spec_id           TEXT,
      spec_name         TEXT,
      last_pushed_qty   INTEGER,
      last_pushed_at    DATETIME,
      sync_enabled      INTEGER NOT NULL DEFAULT 1,
      units_per_pack    INTEGER NOT NULL DEFAULT 1,
      spec_key          TEXT NOT NULL DEFAULT '',
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE eleme_sync_queue (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      retail_store_id  INTEGER NOT NULL,
      product_id       INTEGER NOT NULL,
      store_code       TEXT NOT NULL,
      new_qty          INTEGER NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',
      attempts         INTEGER NOT NULL DEFAULT 0,
      last_error       TEXT,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at     DATETIME
    );
  `);
  return db;
}

const STORE_ID = 1;
const STORE = 'tianhe';

// One mapped, in-stock, in-sync product. Every case below starts from this and
// changes exactly one thing, so a failure names the thing that changed.
function seedProduct(db, id, {
  stock = 10, pushed = 10, units = 1, syncEnabled = 1, isActive = 1,
  pushedHoursAgo = 1, bundleItems = null, specKey = '', store = STORE,
} = {}) {
  db.prepare(`INSERT INTO store_products (id, sku, name_cn, name_en, is_active, bundle_items)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, `SKU-${id}`, `商品${id}`, `Product ${id}`, isActive, bundleItems);
  db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)')
    .run(STORE_ID, id, stock);
  db.prepare(`INSERT INTO eleme_product_map
      (retail_store_id, product_id, store_code, eleme_name, spec_name, last_pushed_qty,
       last_pushed_at, sync_enabled, units_per_pack, spec_key)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?), ?, ?, ?)`)
    .run(STORE_ID, id, store, `听装${id}`, null, pushed,
         `-${pushedHoursAgo} hours`, syncEnabled, units, specKey);
}

// A second claim on the same product — a multipack option, its own stock box and
// its own last_pushed_qty. The map's UNIQUE(store, product) was dropped for
// exactly this (database.js:5537-5553).
function seedClaim(db, productId, { pushed, units, specKey, pushedHoursAgo = 1 }) {
  db.prepare(`INSERT INTO eleme_product_map
      (retail_store_id, product_id, store_code, eleme_name, last_pushed_qty,
       last_pushed_at, sync_enabled, units_per_pack, spec_key)
      VALUES (?, ?, ?, ?, ?, datetime('now', ?), 1, ?, ?)`)
    .run(STORE_ID, productId, STORE, `听装${productId}`, pushed,
         `-${pushedHoursAgo} hours`, units, specKey);
}

function queueRow(db, productId, { status = 'pending', hoursAgo = 0, qty = 0 } = {}) {
  db.prepare(`INSERT INTO eleme_sync_queue
      (retail_store_id, product_id, store_code, new_qty, status, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', ?))`)
    .run(STORE_ID, productId, STORE, qty, status, `-${hoursAgo} hours`);
}

// Collects everything the sweep tries to say, so a test can assert on the record
// as well as on the queue.
function recorder() {
  const logs = [], alertsSent = [], lines = [];
  return {
    logs, alertsSent, lines,
    log: (sc, msg) => lines.push({ sc, msg }),
    logSync: (sc, type, status, detail, msg) => logs.push({ sc, type, status, detail, msg }),
    notifyMerchant: (msg) => alertsSent.push(msg),
  };
}

// Stands in for lib/alert-latch's latchStore(). The real one is a Proxy over one
// file per key, and its READ of an unset key is `false`, never undefined — code
// under test branches on that, so a plain {} would be a more forgiving double than
// production. Same interface, in memory.
function latchStub() {
  const mem = new Map();
  return new Proxy({}, {
    get: (_t, k) => (typeof k === 'string' ? !!mem.get(k) : undefined),
    set: (_t, k, v) => { if (typeof k === 'string') mem.set(k, !!v); return true; },
    has: (_t, k) => (typeof k === 'string' ? !!mem.get(k) : false),
  });
}

function run(db, rec, { descriptor = ELEME, alerts = latchStub(), storeCodes = [STORE] } = {}) {
  return sweepStockDrift(db, descriptor, {
    storeCodes, log: rec.log, logSync: rec.logSync,
    notifyMerchant: rec.notifyMerchant, alerts,
  });
}

const queued = (db) => db.prepare(
  `SELECT product_id, new_qty, status, last_error FROM eleme_sync_queue
    WHERE last_error = 'drift sweep — last push never landed' ORDER BY product_id`).all();

// A descriptor identical to the shipped Eleme one but WITH alert copy, so the
// latch/paging path can be exercised. It is deliberately English-only nonsense:
// this is a test double, not a proposal for the real string, and the real one is
// Ash's to supply (see the ELEME descriptor's placeholder note).
const WITH_COPY = Object.assign({}, ELEME, {
  alert: {
    chronic: ({ storeCode, count, hours, items }) =>
      `CHRONIC ${storeCode} ${count} ${hours} ${items.map(i => `${i.sku}:${i.now}/${i.was}`).join(',')}`,
    clear: ({ storeCode }) => `CLEAR ${storeCode}`,
  },
});

// ── 1. The comparison ────────────────────────────────────────────────────────

section('1 · what counts as drift');

check('a drifted row is enqueued, at the SHELF figure', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 101, { stock: 7, pushed: 3 });
  const res = run(db, rec);
  eq(res.enqueued, 1, 'enqueued');
  eq(queued(db), [{ product_id: 101, new_qty: 7, status: 'pending',
                    last_error: 'drift sweep — last push never landed' }], 'queue');
});

check('a matching row is left alone', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 102, { stock: 7, pushed: 7 });
  eq(run(db, rec).enqueued, 0, 'enqueued');
  eq(queued(db).length, 0, 'queue');
});

check('NULL last_pushed_qty is drift — nothing ever landed', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 103, { stock: 4, pushed: null });
  eq(run(db, rec).enqueued, 1, 'enqueued');
  eq(queued(db)[0].new_qty, 4, 'new_qty');
});

check('zero against zero is not drift', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 104, { stock: 0, pushed: 0 });
  eq(run(db, rec).enqueued, 0, 'enqueued');
});

check('exact inequality — one unit apart is drift, no tolerance', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 105, { stock: 10, pushed: 9 });
  eq(run(db, rec).enqueued, 1, 'enqueued');
});

// ── 2. Pack claims ───────────────────────────────────────────────────────────

section('2 · pack claims (units_per_pack)');

check('a 6-pack claim holding floor(stock/6) is in sync, not drifted', () => {
  const db = freshDb(); const rec = recorder();
  // 40 on the shelf, a 6-bottle option: the box should read 6, and does.
  seedProduct(db, 201, { stock: 40, pushed: 6, units: 6 });
  eq(run(db, rec).enqueued, 0, 'enqueued');
});

check('a 6-pack claim holding the RAW count is drifted', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 202, { stock: 40, pushed: 40, units: 6 });
  eq(run(db, rec).enqueued, 1, 'enqueued');
  // The SHELF figure goes on the queue — the drain re-derives per box.
  eq(queued(db)[0].new_qty, 40, 'new_qty is the shelf count, not 6');
});

check('several claims on one product spend ONE row of the budget', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 203, { stock: 40, pushed: 0, units: 1, specKey: 'one' });   // drifted
  seedClaim(db, 203, { pushed: 0, units: 3, specKey: 'three' });              // drifted
  seedClaim(db, 203, { pushed: 0, units: 6, specKey: 'six' });                // drifted
  eq(run(db, rec).enqueued, 1, 'enqueued');
  eq(queued(db)[0].new_qty, 40, 'new_qty');
});

check('negative stock uses packQty (clamped to 0), so it settles instead of drifting forever', () => {
  const db = freshDb(); const rec = recorder();
  // The daemon writes packQty(-3, 1) = 0. A sweep computing Math.trunc(-3/1) = -3
  // would call this drifted on every cycle for ever — which is the live defect in
  // lib/meituan-drift-sweep.js:146 that this module deliberately does not repeat.
  seedProduct(db, 204, { stock: -3, pushed: 0 });
  eq(run(db, rec).enqueued, 0, 'enqueued');
});

// ── 3. Roots bundle products ─────────────────────────────────────────────────

section('3 · roots bundle products (component floor)');

check('a bundle is judged on its component floor, not its own shelf row', () => {
  const db = freshDb(); const rec = recorder();
  // Components: 12 of #301 and 4 of #302, one each per bundle → floor is 4.
  seedProduct(db, 301, { stock: 12, pushed: 12 });
  seedProduct(db, 302, { stock: 4,  pushed: 4 });
  seedProduct(db, 303, { stock: 51, pushed: 4,
                         bundleItems: JSON.stringify([{ id: 301, qty: 1 }, { id: 302, qty: 1 }]) });
  // #303's own shelf row says 51 — a vestigial number no sale moves. Pushed 4 IS
  // the floor, so it is in sync and must not be re-pushed at 51.
  eq(run(db, rec).enqueued, 0, 'enqueued');
});

check('a bundle that genuinely drifted is caught even when its shelf row matches', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 311, { stock: 12, pushed: 12 });
  seedProduct(db, 312, { stock: 2,  pushed: 2 });
  // Shelf row 7 == pushed 7, so the SQL arm alone would call this in sync. The
  // component floor is 2, so it is not.
  seedProduct(db, 313, { stock: 7, pushed: 7,
                         bundleItems: JSON.stringify([{ id: 311, qty: 1 }, { id: 312, qty: 1 }]) });
  const res = run(db, rec);
  eq(res.enqueued, 1, 'enqueued');
  eq(queued(db)[0].product_id, 313, 'product');
  eq(queued(db)[0].new_qty, 2, 'new_qty is the component floor');
});

// ── 4. The guards that stop churn ────────────────────────────────────────────

section('4 · suppression');

check('an archived product is not re-queued', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 401, { stock: 7, pushed: 3, isActive: 0 });
  eq(run(db, rec).enqueued, 0, 'enqueued');
});

check('a product with no store_products row still counts (unknown reads as active)', () => {
  const db = freshDb(); const rec = recorder();
  db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)')
    .run(STORE_ID, 402, 7);
  db.prepare(`INSERT INTO eleme_product_map
      (retail_store_id, product_id, store_code, last_pushed_qty, last_pushed_at)
      VALUES (?, ?, ?, ?, datetime('now','-1 hours'))`).run(STORE_ID, 402, STORE, 3);
  eq(run(db, rec).enqueued, 1, 'enqueued');
});

check('sync_enabled = 0 is not re-queued', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 403, { stock: 7, pushed: 3, syncEnabled: 0 });
  eq(run(db, rec).enqueued, 0, 'enqueued');
});

check('a target already pending in the queue is skipped (in flight)', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 404, { stock: 7, pushed: 3 });
  queueRow(db, 404, { status: 'pending', hoursAgo: 0 });
  eq(run(db, rec).enqueued, 0, 'enqueued');
});

check('a target being pushed right now is skipped (processing)', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 405, { stock: 7, pushed: 3 });
  queueRow(db, 405, { status: 'processing', hoursAgo: 0 });
  eq(run(db, rec).enqueued, 0, 'enqueued');
});

check(`a target tried inside the ${DRIFT_RETRY_HOURS}h cool-down is skipped even when its row died`, () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 406, { stock: 7, pushed: 3 });
  queueRow(db, 406, { status: 'error', hoursAgo: 1 });
  eq(run(db, rec).enqueued, 0, 'enqueued');
});

check(`a target whose failed row is older than ${DRIFT_RETRY_HOURS}h IS retried`, () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 407, { stock: 7, pushed: 3 });
  queueRow(db, 407, { status: 'error', hoursAgo: DRIFT_RETRY_HOURS + 1 });
  eq(run(db, rec).enqueued, 1, 'enqueued');
});

check("another store's queue row does not satisfy this store's cool-down", () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 408, { stock: 7, pushed: 3 });
  db.prepare(`INSERT INTO eleme_sync_queue (retail_store_id, product_id, store_code, new_qty, status)
              VALUES (?, ?, 'yuexiu', 0, 'pending')`).run(STORE_ID, 408);
  eq(run(db, rec).enqueued, 1, 'enqueued');
});

check('stores outside this daemon are never touched', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 409, { stock: 7, pushed: 3, store: 'yuexiu' });
  eq(run(db, rec, { storeCodes: [STORE] }).enqueued, 0, 'enqueued');
});

check('an empty store list is a no-op, not a full-table sweep', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 410, { stock: 7, pushed: 3 });
  eq(run(db, rec, { storeCodes: [] }).enqueued, 0, 'enqueued');
});

// ── 5. The cap ───────────────────────────────────────────────────────────────

section('5 · per-sweep cap');

check(`the ${MAX_ROWS}-row cap holds, and the worst drift goes first`, () => {
  const db = freshDb(); const rec = recorder();
  const n = MAX_ROWS + 15;
  for (let i = 0; i < n; i++) {
    // Older drift = higher product id here, so the ordering is checkable.
    seedProduct(db, 500 + i, { stock: 7, pushed: 3, pushedHoursAgo: i + 1 });
  }
  const res = run(db, rec);
  eq(res.enqueued, MAX_ROWS, 'enqueued');
  eq(queued(db).length, MAX_ROWS, 'queue rows');
  const ids = queued(db).map(r => r.product_id);
  // Worst first: the oldest drift (largest pushedHoursAgo → largest id) must be in.
  ok(ids.includes(500 + n - 1), 'the oldest drift made the batch');
  ok(!ids.includes(500), 'the newest drift was cut by the cap');
});

check('a second sweep does not re-queue what the first one just queued', () => {
  const db = freshDb(); const rec = recorder();
  for (let i = 0; i < MAX_ROWS + 5; i++) seedProduct(db, 600 + i, { stock: 7, pushed: 3, pushedHoursAgo: i + 1 });
  eq(run(db, rec).enqueued, MAX_ROWS, 'first sweep');
  const second = run(db, recorder());
  eq(second.enqueued, 5, 'second sweep picks up only the remainder');
});

// ── 6. Chronic drift and the latch ───────────────────────────────────────────

section('6 · chronic drift');

check(`nothing chronic under ${CHRONIC_HOURS}h`, () => {
  const db = freshDb();
  seedProduct(db, 701, { stock: 7, pushed: 3, pushedHoursAgo: CHRONIC_HOURS - 1 });
  eq(chronicDrift(db, ELEME, [STORE]).length, 0, 'chronic');
});

check(`chronic at exactly ${CHRONIC_HOURS}h`, () => {
  const db = freshDb();
  seedProduct(db, 702, { stock: 7, pushed: 3, pushedHoursAgo: CHRONIC_HOURS + 1 });
  const c = chronicDrift(db, ELEME, [STORE]);
  eq(c.length, 1, 'chronic count');
  eq(c[0].was, 3, 'was');
  eq(c[0].now, 7, 'now');
});

check('chronic ignores the cool-down — a retry 20 min ago is still weeks out of sync', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 703, { stock: 7, pushed: 3, pushedHoursAgo: 40 });
  queueRow(db, 703, { status: 'error', hoursAgo: 0 });   // inside the cool-down
  eq(chronicDrift(db, ELEME, [STORE]).length, 1, 'chronic still sees it');
  // …and the enqueue read still respects the cool-down for the same row.
  eq(run(db, rec).enqueued, 0, 'enqueued');
});

check('chronic excludes in-flight work — a queued push is not stranded', () => {
  const db = freshDb();
  seedProduct(db, 704, { stock: 7, pushed: 3, pushedHoursAgo: 40 });
  queueRow(db, 704, { status: 'pending', hoursAgo: 0 });
  eq(chronicDrift(db, ELEME, [STORE]).length, 0, 'chronic');
});

check('chronic carries the channel\'s own refusal verbatim', () => {
  const db = freshDb();
  seedProduct(db, 705, { stock: 7, pushed: 3, pushedHoursAgo: 40 });
  db.prepare(`INSERT INTO eleme_sync_queue
      (retail_store_id, product_id, store_code, new_qty, status, last_error, created_at)
      VALUES (?, ?, ?, 0, 'error', ?, datetime('now','-9 hours'))`)
    .run(STORE_ID, 705, STORE, 'no listing on this store carries that name');
  eq(chronicDrift(db, ELEME, [STORE])[0].why, 'no listing on this store carries that name', 'why');
});

check('chronic is read BEFORE enqueuing, so this sweep\'s own retries cannot hide it', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 706, { stock: 7, pushed: 3, pushedHoursAgo: 40 });
  const res = run(db, rec, { descriptor: WITH_COPY });
  eq(res.enqueued, 1, 'enqueued');
  eq(res.chronic.length, 1, 'chronic reported in the same sweep that queued the retry');
  ok(rec.alertsSent.some(m => m.startsWith('CHRONIC ')), 'paged');
});

check('the latch pages once, not every sweep', () => {
  const db = freshDb(); const alerts = latchStub();
  seedProduct(db, 707, { stock: 7, pushed: 3, pushedHoursAgo: 40 });
  const first = recorder();
  run(db, first, { descriptor: WITH_COPY, alerts });
  eq(first.alertsSent.length, 1, 'first sweep pages');
  const second = recorder();
  run(db, second, { descriptor: WITH_COPY, alerts });
  eq(second.alertsSent.length, 0, 'second sweep is silent');
  eq(alerts['drift:' + STORE], true, 'latch key');
});

check('the ✅ waits for the numbers to actually agree, not for the retry to be queued', () => {
  const db = freshDb(); const alerts = latchStub();
  seedProduct(db, 708, { stock: 7, pushed: 3, pushedHoursAgo: 40 });
  run(db, recorder(), { descriptor: WITH_COPY, alerts });
  eq(alerts['drift:' + STORE], true, 'latched');

  // The sweep queued a retry. Chronic now reads clean (in flight), but the push
  // has NOT landed — a symmetric clear would announce all-clear right here.
  const midway = recorder();
  run(db, midway, { descriptor: WITH_COPY, alerts });
  eq(midway.alertsSent.length, 0, 'no premature all-clear');
  eq(alerts['drift:' + STORE], true, 'still latched');

  // Now the push lands: the queue row completes and the map records what Eleme took.
  db.prepare("UPDATE eleme_sync_queue SET status='done', processed_at=CURRENT_TIMESTAMP").run();
  db.prepare('UPDATE eleme_product_map SET last_pushed_qty = 7').run();
  const after = recorder();
  run(db, after, { descriptor: WITH_COPY, alerts });
  eq(after.alertsSent, [`CLEAR ${STORE}`], 'all-clear');
  eq(alerts['drift:' + STORE], false, 'latch released');
});

check('a store whose drift is merely fresh does not hold another store\'s latch', () => {
  const db = freshDb(); const alerts = latchStub();
  seedProduct(db, 709, { stock: 7, pushed: 3, pushedHoursAgo: 40, store: 'tianhe' });
  seedProduct(db, 710, { stock: 7, pushed: 3, pushedHoursAgo: 1,  store: 'yuexiu' });
  const rec = recorder();
  run(db, rec, { descriptor: WITH_COPY, alerts, storeCodes: ['tianhe', 'yuexiu'] });
  eq(alerts['drift:tianhe'], true, 'tianhe latched');
  eq(alerts['drift:yuexiu'], false, 'yuexiu not latched');
  eq(rec.alertsSent.length, 1, 'one page');
});

// ── 7. The shipped Eleme descriptor's placeholder ────────────────────────────

section('7 · Eleme ships without alert copy (deliberate)');

check('no alert copy → the sweep still runs and still re-enqueues', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 801, { stock: 7, pushed: 3, pushedHoursAgo: 40 });
  eq(ELEME.alert, null, 'ELEME.alert is the placeholder');
  eq(run(db, rec).enqueued, 1, 'enqueued');
});

check('no alert copy → nothing is paged and NO Chinese is composed', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 802, { stock: 7, pushed: 3, pushedHoursAgo: 40 });
  run(db, rec);
  eq(rec.alertsSent, [], 'nothing sent to the ops group');
});

check('no alert copy → chronic drift is still recorded to the sync log', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 803, { stock: 7, pushed: 3, pushedHoursAgo: 40 });
  run(db, rec);
  const row = rec.logs.find(l => l.type === 'drift_chronic');
  ok(row, 'a drift_chronic row was written');
  eq(row.status, 'error', 'status');
  eq(row.detail.count, 1, 'count');
});

check('no alert copy → the latch is NOT set, so the first real alert is not swallowed', () => {
  const db = freshDb(); const alerts = latchStub();
  seedProduct(db, 804, { stock: 7, pushed: 3, pushedHoursAgo: 40 });
  run(db, recorder(), { alerts });
  eq(alerts['drift:' + STORE], false, 'latch untouched while copy is missing');

  // That sweep also queued a retry, and chronic excludes in-flight work — so the
  // target is legitimately not "stranded" until that retry resolves. Let it fail
  // terminally, which is the case this whole module exists for.
  db.prepare("UPDATE eleme_sync_queue SET status='error', last_error='no such listing'").run();

  // Copy arrives. The next sweep must page: the drift was never reported, so it
  // is news, not old news.
  const after = recorder();
  run(db, after, { descriptor: WITH_COPY, alerts });
  eq(after.alertsSent.length, 1, 'pages as soon as the copy exists');
  eq(alerts['drift:' + STORE], true, 'and latches from then on');
});

check('a target stays unreported only while its retry is genuinely in flight', () => {
  const db = freshDb(); const alerts = latchStub();
  seedProduct(db, 805, { stock: 7, pushed: 3, pushedHoursAgo: 40 });
  // Sweep 1 queues the retry. With copy present it pages straight away, because
  // chronic is read BEFORE the insert.
  const first = recorder();
  run(db, first, { descriptor: WITH_COPY, alerts });
  eq(first.alertsSent.length, 1, 'sweep 1 pages');
  // Sweep 2: the retry is pending, so nothing is stranded — but the latch is held,
  // so no all-clear either. Silence is the correct output here.
  const second = recorder();
  run(db, second, { descriptor: WITH_COPY, alerts });
  eq(second.alertsSent.length, 0, 'sweep 2 says nothing');
  eq(alerts['drift:' + STORE], true, 'and stays latched — the numbers still disagree');
});

// ── 8. The record ────────────────────────────────────────────────────────────

section('8 · what the sweep writes down');

check('a successful sweep logs drift_sweep/ok per store, with the items', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 901, { stock: 7, pushed: 3 });
  run(db, rec);
  const row = rec.logs.find(l => l.type === 'drift_sweep');
  ok(row, 'a drift_sweep row was written');
  eq(row.status, 'ok', 'status');
  eq(row.sc, STORE, 'store');
  eq(row.detail.count, 1, 'count');
  eq(row.detail.items[0].sku, 'SKU-901', 'sku');
  eq(row.detail.items[0].was, 3, 'was');
  eq(row.detail.items[0].now, 7, 'now');
});

check('a sweep that finds nothing writes nothing', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 902, { stock: 7, pushed: 7 });
  run(db, rec);
  eq(rec.logs.length, 0, 'no log rows');
});

check('a FAILED sweep is logged as drift_sweep/error, not swallowed to the console', () => {
  const db = freshDb(); const rec = recorder();
  seedProduct(db, 903, { stock: 7, pushed: 3 });
  // The exact production shape of this: the queue table is missing or unreadable.
  // lib/meituan-drift-sweep.js:261-263 console.errors here and nothing else — a
  // sweep that has silently stopped running then looks like a channel with no drift.
  db.exec('DROP TABLE eleme_sync_queue');
  const res = run(db, rec, { storeCodes: [STORE, 'yuexiu'] });
  eq(res.enqueued, 0, 'nothing enqueued');
  const errs = rec.logs.filter(l => l.type === 'drift_sweep' && l.status === 'error');
  eq(errs.length, 2, 'one error row per store in scope');
  ok(/drift sweep failed/.test(errs[0].msg), 'the message says what happened');
});

check('a bad descriptor is refused rather than interpolated into SQL', () => {
  const db = freshDb();
  let threw = null;
  try {
    sweepStockDrift(db, Object.assign({}, ELEME, { mapTable: 'eleme_product_map; DROP TABLE x' }),
      { storeCodes: [STORE] });
  } catch (e) { threw = e; }
  ok(threw && /bad mapTable/.test(threw.message), 'descriptor validated');
});

// ── Verdict ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  · ${f.name}\n      ${f.message}`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
