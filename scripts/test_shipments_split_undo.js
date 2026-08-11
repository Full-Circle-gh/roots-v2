#!/usr/bin/env node
/**
 * POST /orders/:id/shipments/split — BRANCH B (undo combine).
 *
 * Two defects, tested together because they live three lines apart:
 *
 *   1. THE MISSING shipsNothing GUARD. Branch B called ensureShipments
 *      unconditionally. ensureShipments does not guard on fulfilment type — it
 *      never reads the column — so undo-combine on a pickup or counter order
 *      CREATED Air/Land parcels for an order collected at the store. Unlike
 *      every other shipment defect this one does NOT self-heal: the order-detail
 *      read returns [] for these orders instead of reconciling them, so the
 *      phantom parcels survive and feie starts printing parcel blocks for a
 *      counter sale.
 *
 *   2. THE TWO-TRANSACTION WINDOW — NOT COVERED IN THIS COMMIT. The branch
 *      deletes every shipment and nulls every shipment_id, COMMITS, then
 *      rebuilds in ensureShipments' own transaction. A process death between the
 *      two leaves the order with no parcels at all. It is a separate defect and
 *      gets its own commit and its own tests, so the guard stays separable in
 *      history from the atomicity change.
 *
 * THE REAL HANDLER IS UNDER TEST, not a reproduction. The route registration is
 * extracted from routes/retail.js and executed against a fake `router` that
 * captures the handler, with the REAL ensureShipments (also extracted) and the
 * REAL shipsNothing from lib/fulfilment. Only planShipments is stubbed — and
 * deliberately, because a spy on it is how "the rebuild actually ran" is
 * asserted rather than inferred from a row count.
 *
 * MUTATIONS MUST PROVE THEY MUTATED. Every sabotage below asserts the source
 * actually changed before its red counts as evidence — the v4.27 rule, whose
 * first occurrence was a CRLF anchor in this very repo that matched nothing and
 * produced ten red lines proving nothing. The tree is checked out CRLF, so no
 * anchor here contains a newline.
 *
 * Offline. No network, no install, no production database.
 *   node scripts/test_shipments_split_undo.js
 *   SU_SABOTAGE=guard  node scripts/test_shipments_split_undo.js   (expect RED)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb, driver } = require('./test-support/memory-db');
const { shipsNothing } = require('../lib/fulfilment');
const { withTransaction } = require('../lib/db-transaction');

const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const RETAIL_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const SABOTAGE = process.env.SU_SABOTAGE || '';

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── Source handling — the string-aware stripper used by every suite here ────
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

function extractFunction(code, name) {
  const m = new RegExp(`^function ${name}\\(`, 'm').exec(code);
  if (!m) throw new Error(`function ${name} not found`);
  const end = code.indexOf('\n}', m.index);
  if (end === -1) throw new Error(`unterminated function ${name}`);
  return code.slice(m.index, end + 2);
}

/** The route registration, from `router.post('<path>'` to the `});` at column 0. */
function extractRoute(code, routePath) {
  const needle = `router.post('${routePath}'`;
  const i = code.indexOf(needle);
  if (i === -1) throw new Error(`route ${routePath} not found`);
  const end = code.indexOf('\n});', i);
  if (end === -1) throw new Error(`unterminated route ${routePath}`);
  return code.slice(i, end + 4);
}

const ROUTE_PATH = '/api/retail-admin/orders/:id/shipments/split';

// ── SABOTAGE — each one asserts it changed the source (v4.27) ───────────────
//
// No anchor contains a newline: the tree is CRLF and a "\n" anchor silently
// matches nothing, which is exactly how a mutation comes to prove nothing.
const MUTATIONS = {
  // Remove the guard added in commit 1 — the pickup tests must go red.
  guard: {
    why: 'reverts the shipsNothing guard',
    parts: [{ find: /if \(shipsNothing\(o\)\) \{/, replace: 'if (false) {' }],
  },
  // Put the rebuild back OUTSIDE the transaction — the pre-fix shape, where the
  // delete commits on its own and ensureShipments rebuilds in a second one.
  //
  // `\s*` rather than a literal line ending: the tree is CRLF, and an anchor
  // that hard-codes one is the fragility v4.27 is about. The REPLACEMENT may
  // contain newlines — it is building source, not matching it.
  split: {
    why: 'reverts the single transaction to delete-commit-then-rebuild',
    parts: [
      { find: /const rebuilt = tdb\(\)\.transaction\(\(\) => \{/, replace: 'const __tx = tdb().transaction(() => {' },
      { find: /return ensureShipments\(id\);\s*\}\)\(\);/, replace: '})();\n  const rebuilt = ensureShipments(id);' },
    ],
  },
};

function sources() {
  let route = extractRoute(RETAIL, ROUTE_PATH);
  const ensure = extractFunction(RETAIL, 'ensureShipments');
  if (SABOTAGE) {
    const m = MUTATIONS[SABOTAGE];
    if (!m) throw new Error(`unknown SU_SABOTAGE=${SABOTAGE}`);
    const before = route;
    // THE v4.27 RULE, applied per PART rather than once at the end: a mutation
    // that silently matches nothing still turns every test red, and that red
    // looks exactly like a successful red-proof. Each part must be shown to have
    // changed the source, or the run is not evidence of anything.
    for (const [i, p] of m.parts.entries()) {
      const prev = route;
      route = route.replace(p.find, p.replace);
      assert.notStrictEqual(route, prev,
        `SABOTAGE '${SABOTAGE}' part ${i + 1}/${m.parts.length} (${p.find}) matched NOTHING — `
        + 'it changed no source, so every failure below would be meaningless');
    }
    assert.notStrictEqual(route, before, `SABOTAGE '${SABOTAGE}' produced identical source`);
  }
  return { route, ensure };
}

// ── Harness ────────────────────────────────────────────────────────────────
const TABLES = ['retail_orders', 'retail_order_items', 'retail_shipments', 'storefront_config'];

function ensureTransactionMethod(db) {
  if (typeof db.transaction === 'function') return db;
  // better-sqlite3's nesting, reproduced: outermost BEGIN, inner -> SAVEPOINT.
  // This is the property the merged transaction relies on, so the harness must
  // not fake it away.
  let depth = 0;
  db.transaction = (fn) => (...args) => {
    const mine = depth, sp = `su_sp_${mine}`;
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

/**
 * Build the REAL handler with the REAL ensureShipments behind it.
 * planShipments is a spy: asserting it was CALLED is how the tests prove the
 * rebuild ran, rather than inferring it from a row count that a stale read
 * could also produce.
 */
function build({ planImpl } = {}) {
  const db = ensureTransactionMethod(openTablesDb(DB_SRC, TABLES));
  const tdb = () => db;
  const planCalls = [];
  const planShipments = (items, city, province, opts) => {
    planCalls.push({ n: items.length, city, province, opts });
    if (planImpl) return planImpl(items);
    return [{ mode: 'air', label: 'Air shipment · 空运', item_ids: items.map(i => i.id) }];
  };
  const { route, ensure } = sources();
  const ensureShipments = new Function('tdb', 'planShipments', 'supplierShipmentLabel',
    `${ensure}\nreturn ensureShipments;`)(tdb, planShipments, () => 'Supplier · 供应商直发');

  let handler = null;
  const router = { post: (p, ...fns) => { handler = fns[fns.length - 1]; } };
  const express = { json: () => (req, res, next) => next && next() };
  const logs = [];
  const logActivity = (...a) => logs.push(a);
  new Function('router', 'requireRetailAdmin', 'express', 'tdb', 'ensureShipments',
    'shipsNothing', 'logActivity', 'withTransaction', route)
    (router, (req, res, next) => next && next(), express, tdb, ensureShipments,
     shipsNothing, logActivity, withTransaction);
  assert.ok(typeof handler === 'function', 'route handler was not captured');
  return { db, handler, planCalls, logs, ensureShipments, tdb };
}

/** Drive the captured handler and collect the response. */
async function call(handler, id, body) {
  const out = { code: 200, json: null };
  const res = {
    status(c) { out.code = c; return res; },
    json(j) { out.json = j; return res; },
  };
  await handler({ params: { id: String(id) }, body: body || {}, user: { id: 1, username: 'test' }, ip: '::1' }, res);
  return out;
}

// `order_no` is NOT NULL with no default; retail_order_items needs qty,
// unit_price and line_total. Found by the fixture failing against the REAL
// schema and fixed here rather than by thinning the table.
function seedOrder(db, { id = 1, ft = 'delivery', items = 2, shipments = 1, label = '合并发货' } = {}) {
  db.prepare('INSERT INTO retail_orders (id, order_no, fulfillment_type, address_json) VALUES (?, ?, ?, ?)')
    .run(id, `R${id}`, ft, JSON.stringify({ city: 'Beijing', province: 'Beijing', district: 'Chaoyang' }));
  const shipIds = [];
  for (let s = 0; s < shipments; s++) {
    const r = db.prepare('INSERT INTO retail_shipments (order_id, mode, label) VALUES (?, ?, ?)')
      .run(id, 'air', label);
    shipIds.push(Number(r.lastInsertRowid));
  }
  for (let i = 0; i < items; i++) {
    db.prepare('INSERT INTO retail_order_items (order_id, shipment_id, qty, unit_price, line_total) VALUES (?, ?, 1, 10, 10)')
      .run(id, shipIds[0] ?? null);
  }
  return shipIds;
}
const shipCount = (db, id) => Number(db.prepare('SELECT COUNT(*) n FROM retail_shipments WHERE order_id = ?').get(id).n);
const assignedCount = (db, id) => Number(db.prepare('SELECT COUNT(*) n FROM retail_order_items WHERE order_id = ? AND shipment_id IS NOT NULL').get(id).n);

(async () => {
  console.log(`\nshipments/split — branch B: the guard and the window  (driver: ${driver})`
    + `${SABOTAGE ? `   [SABOTAGE=${SABOTAGE} — expect RED]` : ''}\n`);

  // ── COMMIT 1 — the guard ────────────────────────────────────────────────
  for (const ft of ['pickup', 'counter']) {
    await it(`a ${ft} order is REFUSED and gains NO shipments`, async () => {
      const { db, handler, planCalls } = build();
      seedOrder(db, { id: 1, ft, items: 2, shipments: 0 });
      const r = await call(handler, 1);
      assert.strictEqual(r.code, 409, `expected 409, got ${r.code}`);
      assert.strictEqual(r.json.error, 'ships_nothing', `expected ships_nothing, got ${r.json.error}`);
      assert.strictEqual(shipCount(db, 1), 0, `${ft} order gained parcels it must never have`);
      assert.strictEqual(planCalls.length, 0, 'the planner ran for an order that ships nothing');
    });
  }

  await it('mixed-case fulfillment_type is still refused (DELIVERY is not pickup, PICKUP is)', async () => {
    const a = build();
    seedOrder(a.db, { id: 1, ft: 'PICKUP', items: 1, shipments: 0 });
    const ra = await call(a.handler, 1);
    assert.strictEqual(ra.code, 409, 'upper-case PICKUP was not recognised as shipping nothing');
    assert.strictEqual(shipCount(a.db, 1), 0);

    const b = build();
    seedOrder(b.db, { id: 2, ft: 'DELIVERY', items: 1, shipments: 1 });
    const rb = await call(b.handler, 2);
    assert.strictEqual(rb.code, 200, 'upper-case DELIVERY was wrongly refused');
  });

  await it('a NULL fulfillment_type is treated as shipping — the normal path', async () => {
    const { db, handler, planCalls } = build();
    seedOrder(db, { id: 1, ft: null, items: 2, shipments: 1 });
    const r = await call(handler, 1);
    assert.strictEqual(r.code, 200, `NULL fulfillment_type was refused: ${JSON.stringify(r.json)}`);
    assert.ok(planCalls.length > 0, 'the rebuild did not run for a NULL fulfillment_type order');
    assert.ok(shipCount(db, 1) > 0, 'no parcels were rebuilt');
  });

  // ── The normal path must not be broken by the guard ─────────────────────
  await it('a delivery order still rebuilds — parcels replaced and items reassigned', async () => {
    const { db, handler, planCalls, logs } = build();
    seedOrder(db, { id: 1, ft: 'delivery', items: 3, shipments: 1 });
    const before = shipCount(db, 1);
    const r = await call(handler, 1);
    assert.strictEqual(r.code, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.success, true);
    assert.strictEqual(planCalls.length, 1, 'the planner should have run exactly once');
    assert.strictEqual(planCalls[0].n, 3, 'the planner did not see all three items');
    assert.strictEqual(shipCount(db, 1), before, 'expected the same number of parcels rebuilt');
    assert.strictEqual(assignedCount(db, 1), 3, 'items were left unassigned after the rebuild');
    assert.strictEqual(logs.length, 1, 'the activity line did not fire');
    assert.strictEqual(logs[0][2], 'shipments_split');
  });

  await it('an order with a waybill is still refused before anything is deleted', async () => {
    const { db, handler } = build();
    seedOrder(db, { id: 1, ft: 'delivery', items: 2, shipments: 1 });
    db.prepare('UPDATE retail_shipments SET tracking_number = ? WHERE order_id = ?').run('SF123', 1);
    const r = await call(handler, 1);
    assert.strictEqual(r.code, 409);
    assert.strictEqual(r.json.error, 'has_tracking');
    assert.strictEqual(shipCount(db, 1), 1, 'the guarded order lost its parcel anyway');
  });

  // ── COMMIT 2 — one transaction ──────────────────────────────────────────
  await it('THE REBUILD RUNS INSIDE THE TRANSACTION — the early-return does NOT fire', async () => {
    // ensureShipments returns early if any shipment already exists. Inside the
    // merged transaction its SELECT must see the UNCOMMITTED delete (zero rows)
    // and proceed. If read-own-writes did not hold, it would early-return with
    // the rows this block just deleted and the rebuild would silently not happen
    // — which is the failure mode the merge itself could introduce.
    //
    // Asserted on the PLANNER SPY, not on a row count: a row count cannot tell a
    // real rebuild apart from an early-return over stale rows.
    const { db, handler, planCalls } = build();
    seedOrder(db, { id: 1, ft: 'delivery', items: 2, shipments: 1 });
    await call(handler, 1);
    assert.strictEqual(planCalls.length, 1,
      'the planner never ran — ensureShipments early-returned, so it did not see the uncommitted DELETE');
    assert.strictEqual(planCalls[0].n, 2, 'the planner did not see the order\'s items');
  });

  await it('A FAILURE DURING THE REBUILD ROLLS THE DELETE BACK — order not left parcel-less', async () => {
    const original = 2;
    const { db, handler } = build({ planImpl: () => { throw new Error('simulated crash during rebuild'); } });
    const ids = seedOrder(db, { id: 1, ft: 'delivery', items: 2, shipments: original });
    assert.strictEqual(shipCount(db, 1), original, 'fixture did not seed the expected parcels');
    let threw = null;
    try { await call(handler, 1); } catch (e) { threw = e; }
    assert.ok(threw, 'the rebuild failure did not surface — it was swallowed');
    // The ORIGINAL count, not merely non-zero: a partial rebuild would also be
    // non-zero and would still be data loss.
    assert.strictEqual(shipCount(db, 1), original,
      `expected the original ${original} parcels restored, found ${shipCount(db, 1)}`);
    const surviving = db.prepare('SELECT id FROM retail_shipments WHERE order_id = 1 ORDER BY id').all().map(r => Number(r.id));
    assert.deepStrictEqual(surviving, ids, 'the parcels came back as DIFFERENT rows — the delete was not rolled back');
    assert.strictEqual(assignedCount(db, 1), 2, 'items were left unassigned — the shipment_id NULLing was not rolled back');
  });

  // ── Source-level, comment-stripped ──────────────────────────────────────
  await it('the delete and the rebuild are in ONE transaction — asserted on source', () => {
    const { route } = sources();
    const open = route.indexOf('tdb().transaction(');
    const del = route.indexOf('DELETE FROM retail_shipments');
    const ens = route.indexOf('return ensureShipments(id)');
    assert.notStrictEqual(open, -1, 'the transaction is gone');
    assert.notStrictEqual(del, -1, 'the delete is gone');
    assert.notStrictEqual(ens, -1,
      'ensureShipments is not RETURNED from inside the transaction — it is back outside it');
    assert.ok(open < del && del < ens,
      'the rebuild is not inside the transaction that performs the delete');
  });

  await it('the guard sits BEFORE the destructive transaction', () => {
    const { route } = sources();
    const guard = route.indexOf('shipsNothing(o)');
    const del = route.indexOf('DELETE FROM retail_shipments');
    assert.notStrictEqual(guard, -1, 'the shipsNothing guard is gone');
    assert.ok(guard < del, 'the guard runs after the delete — it would not prevent anything');
  });

  await it('the order read selects fulfillment_type — the guard cannot work without it', () => {
    const { route } = sources();
    assert.ok(/SELECT id, fulfillment_type FROM retail_orders/.test(route),
      'fulfillment_type is not selected, so shipsNothing() would always see undefined');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
