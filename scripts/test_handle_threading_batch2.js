#!/usr/bin/env node
/**
 * Handle threading, batch 2 (decisions §24, Path A step 2): `ensureShipments`
 * and `reserveForOrder` take the handle.
 *
 *   node scripts/test_handle_threading_batch2.js
 *
 * THE PAIR LANDS TOGETHER because they share one enclosing transaction — the
 * checkout's, at `POST /api/retail/orders`. Threading either one alone leaves
 * that block half on the handle and half on tdb(), which is a worse state to
 * stop in than not having started.
 *
 * SAME STANDARD AS BATCH 1, AND FOR THE SAME REASON. `d7515a36` claimed this
 * work was done when it was not, so a signature is not evidence. Both helpers
 * are EXTRACTED FROM THEIR REAL FILES AND EXECUTED, with `tdb()` pointing at one
 * database and the handle at another. A parameter that is accepted and then
 * ignored fails, because the rows land in the wrong database.
 *
 * *** THE READS MATTER AS MUCH AS THE WRITES IN ensureShipments ***
 * The checkout INSERTs retail_orders and retail_order_items and then calls it
 * from inside that same transaction. If its SELECTs ran outside, they would find
 * no order, take the `if (!o) return []` arm, and create no parcels — silently,
 * behind a 200. Test 3 is that case: the order exists ONLY in the tdb()
 * database, a handle is passed, and creating parcels from it would prove the
 * read went to the wrong place. Test 2 is the mirror.
 *
 * *** WHY THE INTERNAL TRANSACTIONS ARE NOT withTransaction ***
 * The brief for this work asked for them to become nested `withTransaction`
 * calls. That was measured before it was written, and it breaks the checkout —
 * test 8 holds the measurement so the justification cannot rot into a comment
 * nobody re-checks. withTransaction tracks depth in its OWN AsyncLocalStorage,
 * so from inside a better-sqlite3 transaction it believes it is outermost,
 * issues a literal BEGIN, and SQLite refuses it. It is also async, and a
 * synchronous transaction body cannot await it. better-sqlite3 already maps a
 * nested .transaction() to a SAVEPOINT, so `h.transaction()` keeps exactly
 * today's semantics. This changes when the CHECKOUT is converted, which
 * lib/db-transaction.js records as blocked on BEGIN IMMEDIATE.
 *
 * ── TWO HARNESS LIMITS, STATED RATHER THAN HIDDEN ─────────────────────────
 * 1. node:sqlite HAS NO .transaction(). Where the native binding is absent, the
 *    suite installs a reference .transaction() issuing the same BEGIN/COMMIT and
 *    SAVEPOINT/RELEASE statements better-sqlite3 issues. Only a better-sqlite3
 *    run exercises the real one; the footer says which ran.
 * 2. planShipments AND supplierShipmentLabel ARE INJECTED, not reproduced. Both
 *    are pure — neither touches the database, verified below in test 10 — so
 *    what they return cannot affect which database a statement lands in, and
 *    their real behaviour is already covered by test_shipments_split_merge.js.
 *
 * NO CONCURRENCY IS CLAIMED HERE. Both helpers are synchronous, and a
 * "concurrency" test whose calls originate in one synchronous block tests
 * nothing — that mistake is recorded in lib/db-transaction.js. Nesting is tested
 * instead, which is the property this batch actually changes.
 *
 * TO PROVE THE SUITE CAN FAIL:  HT2_SABOTAGE=1 node scripts/test_handle_threading_batch2.js
 * Sabotage flips ONE headline assertion per helper — two in total, one each.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb, driver } = require('./test-support/memory-db');
const { withTransaction, transactionDepth } = require('../lib/db-transaction');

const SABOTAGE = process.env.HT2_SABOTAGE === '1';
const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const RETAIL_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const INV_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'inventory.js'), 'utf8');

const TABLES = ['retail_orders', 'retail_order_items', 'retail_shipments',
  'retail_stock_reservations', 'retail_store_stock', 'storefront_config'];

// Every column the two helpers write. Read off their SQL, not off the schema —
// the point is to catch a harness table grown THINNER than the code, which is
// how conversion batch 2 was nearly green and wrong.
const WRITTEN_COLUMNS = {
  retail_shipments: ['order_id', 'mode', 'label', 'created_at', 'updated_at',
    'tracking_carrier', 'tracking_number', 'tracking_status',
    'tracking_events_json', 'tracking_synced_at', 'tracking_last_error',
    'tracking_kd100_subscribed', 'tracking_scenario', 'tracking_scenario_data_json',
    'tracking_scenario_notified', 'dispatched_at', 'delivered_at'],
  retail_order_items: ['shipment_id'],
  retail_stock_reservations: ['store_id', 'product_id', 'order_id', 'qty',
    'channel', 'status', 'expires_at'],
};

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── Source handling (same stripper as batch 1 / check-tenant-als.js) ───────
function stripComments(src) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i]; i++;
      }
      if (i < n) { out += q; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

const RETAIL = stripComments(RETAIL_SRC);
const INV = stripComments(INV_SRC);

function extractFunction(code, name) {
  const m = new RegExp(`^function ${name}\\(`, 'm').exec(code);
  if (!m) throw new Error(`function ${name} not found`);
  const end = code.indexOf('\n}', m.index);
  if (end === -1) throw new Error(`unterminated function ${name}`);
  return code.slice(m.index, end + 2);
}

function instantiate(code, name, scope) {
  const src = extractFunction(code, name);
  const keys = Object.keys(scope);
  return new Function(...keys, `${src}\nreturn ${name};`)(...keys.map(k => scope[k]));
}

// ── Fixtures ───────────────────────────────────────────────────────────────
/**
 * A reference .transaction(), for drivers that do not ship one.
 *
 * The same statements better-sqlite3 issues, including its free SAVEPOINT
 * nesting — which is the exact property this batch relies on and therefore the
 * exact property the harness must not fake away.
 */
function ensureTransactionMethod(db) {
  if (typeof db.transaction === 'function') return db;   // better-sqlite3: the real one
  let depth = 0;
  db.transaction = (fn) => (...args) => {
    const mine = depth;
    const sp = `tacet_test_sp_${mine}`;
    if (mine === 0) db.exec('BEGIN'); else db.exec(`SAVEPOINT ${sp}`);
    depth = mine + 1;
    try {
      const r = fn(...args);
      depth = mine;
      if (mine === 0) db.exec('COMMIT'); else db.exec(`RELEASE SAVEPOINT ${sp}`);
      return r;
    } catch (e) {
      depth = mine;
      try {
        if (mine === 0) db.exec('ROLLBACK');
        else { db.exec(`ROLLBACK TO SAVEPOINT ${sp}`); db.exec(`RELEASE SAVEPOINT ${sp}`); }
      } catch { /* already unwound */ }
      throw e;
    }
  };
  return db;
}
const REAL_TX = (() => typeof openTablesDb(DB_SRC, ['storefront_config']).transaction === 'function')();

function newDb() { return ensureTransactionMethod(openTablesDb(DB_SRC, TABLES)); }

/** An order with two items, in whichever database is given. */
function seedOrder(db, { orderId = 1, tracking = null } = {}) {
  db.prepare('INSERT INTO retail_orders (id, order_no, address_json) VALUES (?, ?, ?)')
    .run(orderId, `NO-${orderId}`, JSON.stringify({ city: 'Beijing', province: 'Beijing' }));
  if (tracking) {
    db.prepare('UPDATE retail_orders SET tracking_carrier = ?, tracking_number = ? WHERE id = ?')
      .run(tracking.carrier, tracking.number, orderId);
  }
  for (const id of [10, 11]) {
    db.prepare(`INSERT INTO retail_order_items (id, order_id, qty, unit_price, line_total)
                VALUES (?, ?, 1, 0, 0)`).run(id, orderId);
  }
  return orderId;
}

const PLAN = () => [{ mode: 'land', label: 'Land shipment · 陆运', item_ids: [10, 11] }];
const shipmentScope = () => ({
  planShipments: PLAN,
  supplierShipmentLabel: () => 'Supplier-direct · 供应商直发',
});

const countShipments = db => db.prepare('SELECT COUNT(*) c FROM retail_shipments').get().c;
const countRes = db => db.prepare('SELECT COUNT(*) c FROM retail_stock_reservations').get().c;

async function main() {
  console.log('\nHandle threading batch 2 — ensureShipments, reserveForOrder\n');

  // ── 1. The harness schema is not thinner than the code ───────────────────
  await it('the harness carries every column these helpers write', () => {
    const db = newDb();
    for (const [table, cols] of Object.entries(WRITTEN_COLUMNS)) {
      const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
      for (const c of cols) {
        assert.ok(have.has(c), `${table}.${c} is missing from the harness-built schema`);
      }
    }
    // The five columns ensureShipments actually INSERTs, pinned against the real
    // table: §24 records that retail_shipments has gained five columns since
    // this INSERT was written and that none is NOT NULL. If that changes, this
    // helper starts writing an incomplete row.
    const notNull = db.prepare('PRAGMA table_info(retail_shipments)').all()
      .filter(c => c.notnull && c.dflt_value == null).map(c => c.name).sort();
    assert.deepStrictEqual(notNull, ['mode', 'order_id'],
      'retail_shipments gained a NOT NULL column ensureShipments does not write');
  });

  // ── 2-3. ensureShipments — the handle decides BOTH reads and writes ──────
  await it('HEADLINE ensureShipments — parcels land in the passed handle, not tdb()', () => {
    const ambient = newDb(), handle = newDb();
    seedOrder(handle);
    const ensureShipments = instantiate(RETAIL, 'ensureShipments',
      { tdb: () => ambient, ...shipmentScope() });

    const rows = ensureShipments(1, handle);
    const expect = SABOTAGE ? 0 : 1;
    assert.strictEqual(rows.length, expect, 'the returned parcels are wrong');
    assert.strictEqual(countShipments(handle), 1, 'no parcel was written to the handle');
    assert.strictEqual(countShipments(ambient), 0,
      'a parcel ALSO landed in the tdb() database — the parameter is accepted but not used');
    const assigned = handle.prepare(
      'SELECT COUNT(*) c FROM retail_order_items WHERE shipment_id IS NOT NULL').get().c;
    assert.strictEqual(assigned, 2, 'items were not assigned to the parcel through the handle');
  });

  await it('ensureShipments — the SELECTs read the handle, not tdb()', () => {
    // The order exists ONLY in the tdb() database. A helper whose reads went to
    // tdb() would find it and build parcels; one reading the handle finds
    // nothing and returns [] — which is the answer that proves the read target.
    const ambient = newDb(), handle = newDb();
    seedOrder(ambient);
    const ensureShipments = instantiate(RETAIL, 'ensureShipments',
      { tdb: () => ambient, ...shipmentScope() });

    const rows = ensureShipments(1, handle);
    assert.deepStrictEqual(rows, [], 'it found an order that exists only in the tdb() database');
    assert.strictEqual(countShipments(ambient), 0, 'it wrote into the tdb() database');
    assert.strictEqual(countShipments(handle), 0, 'it wrote a parcel for an order it cannot see');
  });

  await it('ensureShipments — the legacy tracking mirror also runs on the handle', () => {
    const ambient = newDb(), handle = newDb();
    seedOrder(handle, { tracking: { carrier: 'jd', number: 'JD123' } });
    const ensureShipments = instantiate(RETAIL, 'ensureShipments',
      { tdb: () => ambient, ...shipmentScope() });
    ensureShipments(1, handle);

    const s = handle.prepare('SELECT tracking_carrier, tracking_number FROM retail_shipments').get();
    assert.strictEqual(s.tracking_carrier, 'jd', 'the tracking mirror did not reach the handle');
    assert.strictEqual(s.tracking_number, 'JD123');
  });

  await it('ensureShipments — an existing caller that passes no handle uses tdb()', () => {
    const ambient = newDb();
    seedOrder(ambient);
    const ensureShipments = instantiate(RETAIL, 'ensureShipments',
      { tdb: () => ambient, ...shipmentScope() });
    const rows = ensureShipments(1);
    assert.strictEqual(rows.length, 1, 'the default tdb() path stopped working');
    assert.strictEqual(countShipments(ambient), 1);
  });

  // ── 4. Nesting: it runs inside an outer transaction, and unwinds with it ──
  await it('ensureShipments — nests inside an outer transaction on the same handle', () => {
    const ambient = newDb(), handle = newDb();
    seedOrder(handle);
    const ensureShipments = instantiate(RETAIL, 'ensureShipments',
      { tdb: () => ambient, ...shipmentScope() });

    // The shape the checkout has: an outer transaction on the handle, the helper
    // called from inside it. Its own .transaction() must become a savepoint.
    handle.transaction(() => { ensureShipments(1, handle); })();
    assert.strictEqual(countShipments(handle), 1, 'the nested write did not survive the outer commit');
  });

  await it('ensureShipments — its writes roll back when the OUTER transaction fails', () => {
    const ambient = newDb(), handle = newDb();
    seedOrder(handle);
    const ensureShipments = instantiate(RETAIL, 'ensureShipments',
      { tdb: () => ambient, ...shipmentScope() });

    assert.throws(() => {
      handle.transaction(() => {
        ensureShipments(1, handle);
        throw new Error('outer fails after the helper succeeded');
      })();
    }, /outer fails/);
    assert.strictEqual(countShipments(handle), 0,
      'the parcel survived the outer rollback — it was written outside the transaction');
    const assigned = handle.prepare(
      'SELECT COUNT(*) c FROM retail_order_items WHERE shipment_id IS NOT NULL').get().c;
    assert.strictEqual(assigned, 0, 'the item assignment survived the outer rollback');
    // Without this the test passes VACUOUSLY: "nothing is in the handle" is also
    // true of a helper that ignored the handle and wrote to tdb() instead. The
    // parcel has to be absent from BOTH, or it went somewhere the rollback could
    // not reach.
    assert.strictEqual(countShipments(ambient), 0,
      'the parcel landed in the tdb() database, where the outer rollback cannot reach it');
  });

  // ── 5-7. reserveForOrder ─────────────────────────────────────────────────
  const invScope = (ambient, avail = 100) => ({
    tdb: () => ambient,
    ttlMinutes: () => 30,
    getAvailable: () => ({ available: avail, exists: avail > 0 }),
  });

  await it('HEADLINE reserveForOrder — reservations land in the passed handle, not tdb()', () => {
    const ambient = newDb(), handle = newDb();
    const reserveForOrder = instantiate(INV, 'reserveForOrder', invScope(ambient));

    const r = reserveForOrder({ storeId: 1, orderId: 1, items: [{ product_id: 5, qty: 2 }] }, handle);
    const expect = SABOTAGE ? 0 : 1;
    assert.strictEqual(r.reservations.length, expect, 'the returned reservations are wrong');
    assert.strictEqual(countRes(handle), 1, 'no reservation was written to the handle');
    assert.strictEqual(countRes(ambient), 0,
      'a reservation ALSO landed in the tdb() database — the parameter is accepted but not used');
    const row = handle.prepare('SELECT store_id, product_id, order_id, qty, channel, status FROM retail_stock_reservations').get();
    assert.deepStrictEqual(
      [row.store_id, row.product_id, row.order_id, row.qty, row.channel, row.status],
      [1, 5, 1, 2, 'wechat', 'active'], 'the reservation row is not what the SQL says it writes');
  });

  await it('reserveForOrder — an existing caller that passes no handle uses tdb()', () => {
    const ambient = newDb();
    const reserveForOrder = instantiate(INV, 'reserveForOrder', invScope(ambient));
    reserveForOrder({ storeId: 1, orderId: 1, items: [{ product_id: 5, qty: 1 }] });
    assert.strictEqual(countRes(ambient), 1, 'the default tdb() path stopped working');
  });

  await it('reserveForOrder — its writes roll back when the OUTER transaction fails', () => {
    const ambient = newDb(), handle = newDb();
    const reserveForOrder = instantiate(INV, 'reserveForOrder', invScope(ambient));
    assert.throws(() => {
      handle.transaction(() => {
        reserveForOrder({ storeId: 1, orderId: 1, items: [{ product_id: 5, qty: 1 }] }, handle);
        throw new Error('outer fails after the helper succeeded');
      })();
    }, /outer fails/);
    assert.strictEqual(countRes(handle), 0,
      'the reservation survived the outer rollback — it was written outside the transaction');
    // Same vacuity guard as the ensureShipments rollback above: absent from the
    // handle is only meaningful if it is absent from tdb()'s database too.
    assert.strictEqual(countRes(ambient), 0,
      'the reservation landed in the tdb() database, where the outer rollback cannot reach it');
  });

  await it('reserveForOrder — a shortage still throws, and reserves nothing', () => {
    const ambient = newDb(), handle = newDb();
    const reserveForOrder = instantiate(INV, 'reserveForOrder', invScope(ambient, 0));
    assert.throws(
      () => reserveForOrder({ storeId: 1, orderId: 1, items: [{ product_id: 5, qty: 1 }] }, handle),
      /product_not_stocked_here/, 'the all-or-nothing refusal changed shape');
    assert.strictEqual(countRes(handle), 0, 'a refused reserve still wrote a row');
  });

  // ── 8. The measurement behind "not withTransaction" ──────────────────────
  await it('withTransaction CANNOT be nested inside a non-withTransaction transaction', async () => {
    // This is the justification for keeping h.transaction(), pinned as a test so
    // it cannot rot into a comment nobody re-checks.
    const db = newDb();
    db.exec('BEGIN IMMEDIATE');                        // stands in for .immediate()
    assert.strictEqual(transactionDepth(db), 0,
      'withTransaction can now see a foreign transaction — re-evaluate the h.transaction() decision');
    await assert.rejects(
      () => withTransaction(db, (tx) => { tx.prepare('SELECT 1').get(); }),
      /within a transaction/,
      'withTransaction no longer issues a BEGIN here — re-evaluate the decision');
    try { db.exec('ROLLBACK'); } catch { /* nothing open */ }
  });

  await it('withTransaction DOES nest correctly inside its own kind — the control', async () => {
    const db = newDb();
    await withTransaction(db, async () => {
      assert.strictEqual(transactionDepth(db), 1, 'outer depth is wrong');
      await withTransaction(db, () => {
        assert.strictEqual(transactionDepth(db), 2, 'inner is not on the savepoint path');
      });
    });
  });

  // ── 9-10. Source-level: no alias, no stray tdb(), pure injected callees ──
  await it('neither helper reaches tdb() anywhere except its own parameter default', () => {
    for (const [code, name] of [[RETAIL, 'ensureShipments'], [INV, 'reserveForOrder']]) {
      const src = extractFunction(code, name);
      // Split on `) {`, NOT on the first `{`: reserveForOrder's first parameter
      // is a destructuring pattern, so the first brace in the source belongs to
      // the parameter list and splitting there would hide the handle default.
      const header = src.slice(0, src.indexOf(') {') + 1);
      const body = src.slice(src.indexOf(') {') + 2);
      assert.ok(/h = tdb\(\)/.test(header), `${name}'s signature has no tdb() default`);
      assert.ok(!/\btdb\(\)/.test(body),
        `${name} still calls tdb() in its body — the parameter is not the only source of the handle`);
      assert.ok(!/\b(const|let|var)\s+\w+\s*=\s*tdb\(\)/.test(src),
        `${name} keeps a local alias of tdb() — an alias reads like a threaded handle and is not one`);
    }
  });

  await it('every prepare() and transaction() in both helpers is on the parameter', () => {
    for (const [code, name] of [[RETAIL, 'ensureShipments'], [INV, 'reserveForOrder']]) {
      const src = extractFunction(code, name);
      const body = src.slice(src.indexOf(') {') + 2);
      const recvs = [...body.matchAll(/(\w+(?:\(\))?)\s*\.(prepare|transaction)\s*\(/g)];
      assert.ok(recvs.length > 0, `${name} prepares nothing — the extraction is wrong`);
      for (const [, recv, method] of recvs) {
        assert.strictEqual(recv, 'h', `${name} calls .${method}() on \`${recv}\`, not on the handle \`h\``);
      }
    }
    // And the nesting form is still the better-sqlite3 one, deliberately.
    for (const [code, name] of [[RETAIL, 'ensureShipments'], [INV, 'reserveForOrder']]) {
      const src = extractFunction(code, name);
      assert.ok(/h\.transaction\(/.test(src), `${name} lost its internal transaction`);
      assert.ok(!/withTransaction\(/.test(src),
        `${name} was converted to withTransaction — test 8 shows that breaks the checkout`);
    }
  });

  await it('planShipments and supplierShipmentLabel are pure — injecting them is sound', () => {
    for (const name of ['planShipments', 'supplierShipmentLabel']) {
      const src = extractFunction(RETAIL, name);
      assert.ok(!/\.prepare\s*\(/.test(src), `${name} touches the database — it cannot be injected as a stub`);
      assert.ok(!/\btdb\(\)/.test(src), `${name} reaches tdb() — it cannot be injected as a stub`);
    }
  });

  // ── 11. Existing call sites, and the out-of-scope helpers ────────────────
  await it('all eleven ensureShipments call sites still pass one argument', () => {
    const calls = [...RETAIL.matchAll(/(^|[^\w.])ensureShipments\s*\(([^)]*)\)/gm)]
      .filter(m => !/function\s+$/.test(RETAIL.slice(Math.max(0, m.index - 12), m.index + m[1].length)));
    const args = calls.map(m => m[2].trim()).filter(a => !a.startsWith('orderId, h'));
    assert.strictEqual(args.length, 11, `expected 11 ensureShipments call sites, found ${args.length}`);
    for (const a of args) {
      assert.ok(!a.includes(','), `an ensureShipments call site now passes a handle: ${a}`);
    }
  });

  await it('both reserveForOrder call sites still pass one argument', () => {
    const n = [...RETAIL.matchAll(/inventory\.reserveForOrder\(/g)].length;
    assert.strictEqual(n, 2, `expected 2 reserveForOrder call sites, found ${n}`);
    assert.ok(!/inventory\.reserveForOrder\([\s\S]{0,400}?\}\s*,\s*\w/.test(RETAIL),
      'a reserveForOrder call site now passes a handle');
  });

  await it('reconcileTier and createOrReuseManualCustomer are untouched — out of scope', () => {
    assert.ok(/^function reconcileTier\(customerId, spend, storedTier\) \{$/m.test(RETAIL),
      'reconcileTier changed shape — it is money-adjacent and out of this batch');
    // createOrReuseManualCustomer HAS NOW TRAVELLED, and this assertion is
    // updated rather than deleted. It said the helper must not move until its
    // route was classified; the route was classified and converted, so the
    // pin moves to the threaded signature instead of disappearing. Its own
    // suite is scripts/test_handle_threading_manual_customer.js.
    assert.ok(/^function createOrReuseManualCustomer\(\{ nickname, email, phone, userId \}, h = tdb\(\)\) \{$/m.test(RETAIL),
      'createOrReuseManualCustomer changed shape — it is threaded now; see test_handle_threading_manual_customer.js');
  });

  console.log('');
  console.log(`  driver: ${driver}${REAL_TX ? '' : '  (.transaction() = reference BEGIN/SAVEPOINT implementation — this driver has none)'}`);
  if (SABOTAGE) {
    console.log(`  sabotage: ${fail} of the 2 per-helper headline assertions failed`);
    console.log('  (fewer than 2 means a helper is NOT covered by a red-provable check)');
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
