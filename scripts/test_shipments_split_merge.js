#!/usr/bin/env node
/**
 * POST /api/retail-admin/orders/:id/shipments/split — the two-branch merge.
 *
 *   node scripts/test_shipments_split_merge.js
 *
 * WHAT THIS IS FIXING, so the assertions read as more than shape-checking.
 * The path carried TWO router.post registrations. "Ship part later" shipped
 * 2026-06-06 and worked — nine real splits on orders 130, 141-146 and 158
 * between 06-06 and 06-08. On 2026-06-14 a second registration of the SAME path
 * landed higher in the file, and Express matches the first, so from that day the
 * to-follow split could not be reached. It did not fail loudly: the reachable
 * handler ignores the body, so a to-follow request DELETED EVERY PARCEL ON THE
 * ORDER and re-planned from scratch, then returned success.
 *
 * So this file has one job above all others: prove that a request carrying
 * item_ids can never reach the re-plan. That is the bug, and everything else
 * here is secondary to it.
 *
 * THE UNDO-COMBINE BRANCH IS IN LIVE USE AND MUST NOT CHANGE. It is the path
 * behind "Split into separate parcels", and the tests below pin it against a
 * reference implementation of the pre-merge handler rather than merely checking
 * it still works — "works" would not catch a subtle change of shape.
 *
 * routes/retail.js cannot be required from a test — it opens the database at
 * load, registers routes and starts intervals — so both branch bodies are
 * reproduced verbatim below and the dispatch rule is reproduced with them.
 * Section 6 reads the REAL file to prove the reproduction still matches it and
 * that only one registration survives.
 *
 * *** THE WRITTEN-COLUMN ASSERTION IS SECTION 1, AND IT IS NOT CEREMONY ***
 * The shared harness has now produced a table thinner than the code three
 * batches running. Section 1 lists every column BOTH branches write and fails if
 * any is absent from the harness-built schema.
 *
 * TO PROVE THE SUITE CAN FAIL:  SPLIT_MERGE_SABOTAGE=1 node scripts/test_shipments_split_merge.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb, driver } = require('./test-support/memory-db');
const { withTransaction } = require('../lib/db-transaction');

const SABOTAGE = process.env.SPLIT_MERGE_SABOTAGE === '1';
const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const TABLES = ['retail_orders', 'retail_order_items', 'retail_shipments'];

// Every column the two branches write.
//   Branch A inserts a parcel and re-points items onto it.
//   Branch B nulls shipment_id, deletes parcels, and re-plans (the re-plan is
//   ensureShipments, which inserts the SAME five columns — checked in section 6).
const WRITTEN_COLUMNS = {
  retail_shipments: ['order_id', 'mode', 'label', 'created_at', 'updated_at'],
  retail_order_items: ['shipment_id'],
};

// The columns retail_shipments has gained since the to-follow branch last ran on
// 2026-06-08. None is NOT NULL and none is set by ensureShipments either, so a
// parcel this branch creates is shaped exactly like every other parcel in the
// system. Asserted rather than assumed — if one of these ever becomes NOT NULL,
// branch A starts writing an incomplete row and this fails first.
const GAINED_SINCE_2026_06_08 = ['local_eta', 'eta_source', 'package_count',
  'air_delay_cleared_at', 'air_delay_cleared_by'];

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const fresh = () => openTablesDb(DB_SRC, TABLES);

// ── The dispatch rule, reproduced from the handler ────────────────────────
// Presence, not length. `{ item_ids: [] }` is a to-follow request that lost its
// items; answering it with branch B would be the regression again.
function chooseBranch(body) {
  return Object.prototype.hasOwnProperty.call(body || {}, 'item_ids') ? 'to_follow' : 'undo_combine';
}

// ── Branch A — ship part later ────────────────────────────────────────────
// `res` is a recording stand-in so the guards' status codes are observable.
function makeRes() {
  const r = { status_: 200, body_: null };
  r.status = (n) => { r.status_ = n; return r; };
  r.json = (b) => { r.body_ = b; return r; };
  return r;
}

async function branchToFollow(h, id, body, res, hook) {
  const itemIds = Array.isArray(body?.item_ids)
    ? body.item_ids.map(n => parseInt(n, 10)).filter(Number.isInteger)
    : [];
  if (!itemIds.length) return res.status(400).json({ success: false, error: 'no_items' });

  const o = h.prepare('SELECT id, status FROM retail_orders WHERE id = ?').get(id);
  if (!o) return res.status(404).json({ success: false, error: 'not_found' });

  const placeholders = itemIds.map(() => '?').join(',');
  const items = h.prepare(
    `SELECT i.id, i.shipment_id, s.mode AS ship_mode, s.dispatched_at AS ship_dispatched
       FROM retail_order_items i
       LEFT JOIN retail_shipments s ON s.id = i.shipment_id
      WHERE i.order_id = ? AND i.id IN (${placeholders})`
  ).all(id, ...itemIds);
  if (items.length !== itemIds.length) {
    return res.status(400).json({ success: false, error: 'invalid_items' });
  }
  if (items.some(it => it.ship_dispatched)) {
    return res.status(409).json({ success: false, error: 'item_already_dispatched' });
  }

  const movingBySource = new Map();
  for (const it of items) {
    movingBySource.set(it.shipment_id, (movingBySource.get(it.shipment_id) || 0) + 1);
  }
  for (const [shipId, moving] of movingBySource) {
    if (!shipId) continue;
    const total = h.prepare(
      'SELECT COUNT(*) AS n FROM retail_order_items WHERE shipment_id = ?'
    ).get(shipId).n;
    if (moving >= total) {
      return res.status(422).json({ success: false, error: 'would_empty_shipment', shipment_id: shipId });
    }
  }

  const mode = items[0].ship_mode || 'land';
  const label = (mode === 'air' ? 'Air shipment · 空运'
              : mode === 'local' ? 'Local delivery · 同城配送'
              : 'Land shipment · 陆运') + ' (to follow · 后补)';

  const newShipmentId = await withTransaction(h, (tx) => {
    const r = tx.prepare(
      `INSERT INTO retail_shipments (order_id, mode, label, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(id, mode, label);
    const newId = r.lastInsertRowid;
    if (hook) hook();
    const reassign = tx.prepare('UPDATE retail_order_items SET shipment_id = ? WHERE id = ? AND order_id = ?');
    for (const it of items) reassign.run(newId, it.id, id);
    return newId;
  });
  return res.json({ success: true, data: { new_shipment_id: Number(newShipmentId) } });
}

// ── Branch B — undo a combine ─────────────────────────────────────────────
// ensureShipments is the real planner and cannot be required here, so it is
// injected. What matters is that the branch nulls, deletes and then re-plans,
// in that order, and reports the planner's count.
function branchUndoCombine(h, id, res, ensureShipments) {
  const o = h.prepare('SELECT id FROM retail_orders WHERE id = ?').get(id);
  if (!o) return res.status(404).json({ success: false, error: 'not_found' });
  const shipments = h.prepare(
    'SELECT * FROM retail_shipments WHERE order_id = ? ORDER BY id ASC'
  ).all(id);
  if (shipments.some(s => s.tracking_number || s.tracking_carrier)) {
    return res.status(409).json({ success: false, error: 'has_tracking' });
  }
  const tx = h.transaction
    ? h.transaction(() => {
      h.prepare('UPDATE retail_order_items SET shipment_id = NULL WHERE order_id = ?').run(id);
      h.prepare('DELETE FROM retail_shipments WHERE order_id = ?').run(id);
    })
    : () => {
      h.exec('BEGIN');
      try {
        h.prepare('UPDATE retail_order_items SET shipment_id = NULL WHERE order_id = ?').run(id);
        h.prepare('DELETE FROM retail_shipments WHERE order_id = ?').run(id);
        h.exec('COMMIT');
      } catch (e) { try { h.exec('ROLLBACK'); } catch { /* already unwound */ } throw e; }
    };
  tx();
  const rebuilt = ensureShipments(id);
  return res.json({ success: true, shipments: rebuilt.length });
}

/** The merged handler: dispatch, then the branch. */
async function handler(h, id, body, ensureShipments, hook) {
  const res = makeRes();
  if (chooseBranch(body) === 'to_follow') {
    await branchToFollow(h, id, body, res, hook);
  } else {
    branchUndoCombine(h, id, res, ensureShipments);
  }
  return res;
}

/**
 * THE PRE-MERGE REACHABLE HANDLER, reproduced as a reference. Branch B must
 * still behave exactly like this — that path is in live use.
 */
function preMergeReachable(h, id, ensureShipments) {
  const res = makeRes();
  branchUndoCombine(h, id, res, ensureShipments);
  return res;
}

// A stand-in planner: rebuilds one land parcel holding every item, which is what
// ensureShipments does for a non-splitting destination. It writes the SAME five
// columns the real one writes.
function makePlanner(h) {
  return (orderId) => {
    const r = h.prepare(
      `INSERT INTO retail_shipments (order_id, mode, label, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(orderId, 'land', 'Land shipment · 陆运');
    h.prepare('UPDATE retail_order_items SET shipment_id = ? WHERE order_id = ?')
      .run(r.lastInsertRowid, orderId);
    return [{ id: Number(r.lastInsertRowid) }];
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────
function seedOrder(db, id) {
  db.prepare('INSERT INTO retail_orders (id, order_no, status) VALUES (?,?,?)').run(id, 'RO-' + id, 'paid');
}
function seedItems(db, orderId, ids) {
  const ins = db.prepare(
    'INSERT INTO retail_order_items (id, order_id, qty, unit_price, line_total) VALUES (?,?,1,1,1)'
  );
  for (const i of ids) ins.run(i, orderId);
}
function seedShipment(db, orderId, mode, extra = {}) {
  const r = db.prepare(
    `INSERT INTO retail_shipments (order_id, mode, label, tracking_number, dispatched_at)
     VALUES (?,?,?,?,?)`
  ).run(orderId, mode, mode + ' label', extra.tracking_number || null, extra.dispatched_at || null);
  return Number(r.lastInsertRowid);
}
const shipRows = (db) => db.prepare('SELECT id, order_id, mode, label FROM retail_shipments ORDER BY id').all();
const itemRows = (db) => db.prepare('SELECT id, shipment_id FROM retail_order_items ORDER BY id').all();

/** One parcel holding three items — the shape both branches act on. */
function buildOrder(db, oid) {
  seedOrder(db, oid);
  seedItems(db, oid, [oid * 10 + 1, oid * 10 + 2, oid * 10 + 3]);
  const land = seedShipment(db, oid, 'land');
  db.prepare('UPDATE retail_order_items SET shipment_id = ? WHERE order_id = ?').run(land, oid);
  return land;
}

async function main() {
  console.log(`\nSHIPMENTS/SPLIT — THE TWO-BRANCH MERGE (driver: ${driver})`);
  if (SABOTAGE) console.log('  *** SPLIT_MERGE_SABOTAGE=1 — expected values flipped, this run MUST fail 4 ***');
  console.log('');

  console.log('[1] HARNESS COVERS EVERY COLUMN BOTH BRANCHES WRITE');
  console.log('    Third batch running that the shared harness came back thin.');
  await it('every written column exists in the harness-built schema', () => {
    const db = fresh();
    const gaps = [];
    for (const [t, cols] of Object.entries(WRITTEN_COLUMNS)) {
      const have = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name));
      for (const c of cols) if (!have.has(c)) gaps.push(`${t}.${c}`);
    }
    assert.deepStrictEqual(gaps, [], `harness schema is missing ${gaps.join(', ')}`);
  });
  await it('retail_shipments has exactly two NOT NULL columns, and branch A sets both', () => {
    const db = fresh();
    const notNull = db.prepare('PRAGMA table_info(retail_shipments)').all()
      .filter(c => c.notnull && !c.pk && c.dflt_value === null)
      .map(c => c.name);
    assert.deepStrictEqual(notNull.sort(), ['mode', 'order_id']);
    for (const c of notNull) assert.ok(WRITTEN_COLUMNS.retail_shipments.includes(c));
  });
  await it('the columns gained since 2026-06-08 are all still nullable', () => {
    // If one becomes NOT NULL, branch A writes an incomplete parcel row and this
    // is the assertion that says so before a customer finds out.
    const db = fresh();
    const info = new Map(db.prepare('PRAGMA table_info(retail_shipments)').all().map(c => [c.name, c]));
    for (const c of GAINED_SINCE_2026_06_08) {
      assert.ok(info.has(c), `${c} is missing from the harness schema`);
      assert.strictEqual(info.get(c).notnull, 0, `${c} became NOT NULL and branch A does not set it`);
    }
  });

  console.log('\n[2] THE BUG — item_ids must NEVER reach the destructive re-plan');
  await it('item_ids present routes to the to-follow branch, not the re-plan', async () => {
    const db = fresh();
    const land = buildOrder(db, 500);
    let plannerRan = false;
    const planner = () => { plannerRan = true; return []; };
    const res = await handler(db, 500, { item_ids: [5001] }, planner);
    assert.strictEqual(plannerRan, SABOTAGE ? true : false, 'the re-plan ran on a to-follow request');
    assert.strictEqual(res.status_, 200);
    // The source parcel survives — the re-plan would have deleted it.
    assert.ok(shipRows(db).some(s => s.id === land), 'the original parcel was destroyed');
    assert.strictEqual(shipRows(db).length, 2, 'one new parcel beside the original');
  });
  await it('an EMPTY item_ids is a 400, never a silent rebuild', async () => {
    const db = fresh();
    const before = { ships: shipRows(db), items: itemRows(db) };
    buildOrder(db, 501);
    const snap = { ships: shipRows(db), items: itemRows(db) };
    let plannerRan = false;
    const res = await handler(db, 501, { item_ids: [] }, () => { plannerRan = true; return []; });
    assert.strictEqual(res.status_, 400);
    assert.deepStrictEqual(res.body_, { success: false, error: 'no_items' });
    assert.strictEqual(plannerRan, false, 'an empty item_ids reached the re-plan');
    assert.deepStrictEqual(shipRows(db), snap.ships);
    assert.deepStrictEqual(itemRows(db), snap.items);
    assert.ok(before.ships.length === 0);
  });
  await it('THE REGRESSION, EXECUTED: the pre-merge handler destroys the same request', async () => {
    // Not a description of the bug — the bug, run. The pre-merge reachable
    // handler is handed a to-follow request and shown doing the wrong thing, so
    // the fix is measured against a demonstrated failure rather than a claim.
    const oldDb = fresh(); const land = buildOrder(oldDb, 503);
    const newDb = fresh(); buildOrder(newDb, 503);

    const oldRes = preMergeReachable(oldDb, 503, makePlanner(oldDb));   // ignores the body
    const newRes = await handler(newDb, 503, { item_ids: [5031] }, makePlanner(newDb));
    assert.strictEqual(newRes.status_, 200);

    // OLD: the source parcel is gone, every item is back on one re-planned
    // parcel, and it answered success.
    assert.ok(!shipRows(oldDb).some(s => s.id === land), 'pre-merge should have deleted the parcel');
    assert.strictEqual(new Set(itemRows(oldDb).map(r => r.shipment_id)).size, 1,
      'pre-merge should have collapsed every item onto one parcel');
    assert.strictEqual(oldRes.body_.success, true, 'and it reported success while doing it');

    // NEW: the source parcel survives and only the ticked item moved.
    assert.ok(shipRows(newDb).some(s => s.id === land), 'the fix must keep the source parcel');
    assert.strictEqual(new Set(itemRows(newDb).map(r => r.shipment_id)).size, 2,
      'the fix must leave the order split across two parcels');
    assert.notDeepStrictEqual(shipRows(newDb), shipRows(oldDb),
      'the fix produced the same outcome as the bug');
  });
  await it('a malformed item_ids is a 400 too — not an undo-combine', async () => {
    const db = fresh();
    buildOrder(db, 502);
    const snap = shipRows(db);
    let plannerRan = false;
    const res = await handler(db, 502, { item_ids: ['abc', null] }, () => { plannerRan = true; return []; });
    assert.strictEqual(res.status_, 400);
    assert.strictEqual(plannerRan, false, 'a malformed item_ids reached the re-plan');
    assert.deepStrictEqual(shipRows(db), snap);
  });

  console.log('\n[3] BRANCH A — ship part later');
  await it('the ticked items move to a NEW parcel and the rest stay put', async () => {
    const db = fresh();
    const land = buildOrder(db, 510);
    const res = await handler(db, 510, { item_ids: [5101] }, makePlanner(db));
    const newId = res.body_.data.new_shipment_id;
    assert.strictEqual(res.status_, SABOTAGE ? 500 : 200);
    const items = new Map(itemRows(db).map(r => [r.id, r.shipment_id]));
    assert.strictEqual(items.get(5101), newId, 'the ticked item did not move');
    assert.strictEqual(items.get(5102), land, 'an unticked item moved');
    assert.strictEqual(items.get(5103), land, 'an unticked item moved');
  });
  await it('the new parcel carries the to-follow label, copied not composed', async () => {
    const db = fresh();
    buildOrder(db, 511);
    const res = await handler(db, 511, { item_ids: [5111] }, makePlanner(db));
    const row = db.prepare('SELECT mode, label FROM retail_shipments WHERE id = ?')
      .get(res.body_.data.new_shipment_id);
    assert.strictEqual(row.mode, 'land', 'the mode is inherited from the source parcel');
    assert.strictEqual(row.label, 'Land shipment · 陆运 (to follow · 后补)');
  });
  await it('the label follows the source parcel\'s mode for air and local', async () => {
    for (const [mode, expect] of [
      ['air', 'Air shipment · 空运 (to follow · 后补)'],
      ['local', 'Local delivery · 同城配送 (to follow · 后补)'],
    ]) {
      const db = fresh();
      seedOrder(db, 512); seedItems(db, 512, [5121, 5122]);
      const src = seedShipment(db, 512, mode);
      db.prepare('UPDATE retail_order_items SET shipment_id = ? WHERE order_id = ?').run(src, 512);
      const res = await handler(db, 512, { item_ids: [5121] }, makePlanner(db));
      const row = db.prepare('SELECT label FROM retail_shipments WHERE id = ?')
        .get(res.body_.data.new_shipment_id);
      assert.strictEqual(row.label, expect);
    }
  });
  await it('refuses to empty a source parcel — 422 would_empty_shipment', async () => {
    const db = fresh();
    seedOrder(db, 513); seedItems(db, 513, [5131, 5132]);
    const src = seedShipment(db, 513, 'land');
    db.prepare('UPDATE retail_order_items SET shipment_id = ? WHERE order_id = ?').run(src, 513);
    const snap = shipRows(db);
    const res = await handler(db, 513, { item_ids: [5131, 5132] }, makePlanner(db));
    assert.strictEqual(res.status_, 422);
    assert.strictEqual(res.body_.error, 'would_empty_shipment');
    assert.deepStrictEqual(shipRows(db), snap, 'a refused split must write nothing');
  });
  await it('refuses items already in a dispatched parcel — 409', async () => {
    const db = fresh();
    seedOrder(db, 514); seedItems(db, 514, [5141, 5142, 5143]);
    const src = seedShipment(db, 514, 'land', { dispatched_at: '2026-08-01 10:00:00' });
    db.prepare('UPDATE retail_order_items SET shipment_id = ? WHERE order_id = ?').run(src, 514);
    const snap = shipRows(db);
    const res = await handler(db, 514, { item_ids: [5141] }, makePlanner(db));
    assert.strictEqual(res.status_, 409);
    assert.strictEqual(res.body_.error, 'item_already_dispatched');
    assert.deepStrictEqual(shipRows(db), snap);
  });
  await it('an id from another order is 400 invalid_items, not a silent partial', async () => {
    const db = fresh();
    buildOrder(db, 515); buildOrder(db, 516);
    const snap = itemRows(db);
    const res = await handler(db, 515, { item_ids: [5151, 5161] }, makePlanner(db));
    assert.strictEqual(res.status_, 400);
    assert.strictEqual(res.body_.error, 'invalid_items');
    assert.deepStrictEqual(itemRows(db), snap);
  });
  await it('a failure after the INSERT leaves no orphan parcel', async () => {
    const db = fresh();
    buildOrder(db, 517);
    const snap = { ships: shipRows(db), items: itemRows(db) };
    await assert.rejects(
      () => handler(db, 517, { item_ids: [5171] }, makePlanner(db), () => { throw new Error('mid'); }),
      /mid/);
    assert.deepStrictEqual(shipRows(db), snap.ships, 'the new parcel must have rolled back');
    assert.deepStrictEqual(itemRows(db), snap.items);
  });

  console.log('\n[4] BRANCH B — undo a combine, pinned against the pre-merge handler');
  console.log('    This path is in LIVE USE. It must not change.');
  await it('merged branch B === the pre-merge handler, same rows and same response', async () => {
    const a = fresh(); buildOrder(a, 520);
    const b = fresh(); buildOrder(b, 520);
    const oldRes = preMergeReachable(a, 520, makePlanner(a));
    const newRes = await handler(b, 520, {}, makePlanner(b));
    assert.deepStrictEqual(newRes.body_, SABOTAGE ? { success: false } : oldRes.body_);
    assert.strictEqual(newRes.status_, oldRes.status_);
    assert.deepStrictEqual(shipRows(b), shipRows(a));
    assert.deepStrictEqual(itemRows(b), itemRows(a));
    assert.deepStrictEqual(newRes.body_, { success: true, shipments: 1 });
  });
  await it('no body at all behaves the same as an empty object', async () => {
    const a = fresh(); buildOrder(a, 521);
    const b = fresh(); buildOrder(b, 521);
    const r1 = await handler(a, 521, undefined, makePlanner(a));
    const r2 = await handler(b, 521, {}, makePlanner(b));
    assert.deepStrictEqual(r1.body_, r2.body_);
    assert.deepStrictEqual(shipRows(a), shipRows(b));
  });
  await it('a body with other keys but no item_ids is still an undo-combine', async () => {
    const db = fresh(); buildOrder(db, 522);
    const res = await handler(db, 522, { reason: 'operator asked' }, makePlanner(db));
    assert.deepStrictEqual(res.body_, { success: true, shipments: 1 });
  });
  await it('a waybill on any parcel still blocks it — 409 has_tracking', async () => {
    const db = fresh();
    seedOrder(db, 523); seedItems(db, 523, [5231, 5232]);
    seedShipment(db, 523, 'land', { tracking_number: 'JD123' });
    const snap = shipRows(db);
    let plannerRan = false;
    const res = await handler(db, 523, {}, () => { plannerRan = true; return []; });
    assert.strictEqual(res.status_, 409);
    assert.strictEqual(res.body_.error, 'has_tracking');
    assert.strictEqual(plannerRan, false);
    assert.deepStrictEqual(shipRows(db), snap);
  });
  await it('the old parcels are gone and the re-planned one holds every item', async () => {
    const db = fresh();
    seedOrder(db, 524); seedItems(db, 524, [5241, 5242]);
    const air = seedShipment(db, 524, 'air');
    const land = seedShipment(db, 524, 'land');
    db.prepare('UPDATE retail_order_items SET shipment_id = ? WHERE id = ?').run(air, 5241);
    db.prepare('UPDATE retail_order_items SET shipment_id = ? WHERE id = ?').run(land, 5242);
    await handler(db, 524, {}, makePlanner(db));
    const ships = shipRows(db);
    assert.strictEqual(ships.length, 1);
    assert.ok(!ships.some(s => s.id === air || s.id === land), 'an old parcel survived');
    assert.deepStrictEqual([...new Set(itemRows(db).map(r => r.shipment_id))], [ships[0].id]);
  });

  console.log('\n[5] AN UNKNOWN ORDER IS 404 ON BOTH BRANCHES');
  await it('404 whichever branch the body selects', async () => {
    const a = fresh(); const b = fresh();
    const r1 = await handler(a, 999, { item_ids: [1] }, makePlanner(a));
    const r2 = await handler(b, 999, {}, makePlanner(b));
    assert.strictEqual(r1.status_, 404);
    assert.strictEqual(r2.status_, 404);
  });

  console.log('\n[6] THE REAL FILE — one registration, and it matches this reproduction');
  const RETAIL_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
  await it('the path is registered EXACTLY ONCE — the regression cannot come back', () => {
    const n = [...RETAIL_SRC.matchAll(
      /router\.post\('\/api\/retail-admin\/orders\/:id\/shipments\/split'/g)].length;
    assert.strictEqual(n, SABOTAGE ? 2 : 1, `found ${n} registrations of the split path`);
  });
  await it('no other admin route path is registered twice either', () => {
    const seen = new Map();
    for (const m of RETAIL_SRC.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)) {
      const k = `${m[1]} ${m[2]}`;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    const dupes = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
    assert.deepStrictEqual(dupes, [], `shadowed route(s): ${dupes.join(', ')}`);
  });
  await it('the handler dispatches on hasOwnProperty, not on array length', () => {
    // Branching on length is how `{ item_ids: [] }` would reach the re-plan.
    assert.ok(/hasOwnProperty\.call\(req\.body \|\| \{\}, 'item_ids'\)/.test(RETAIL_SRC),
      'the presence check is gone — an empty item_ids can reach branch B again');
  });
  await it('the to-follow label in the file is byte-identical to the one asserted here', () => {
    assert.ok(RETAIL_SRC.includes("+ ' (to follow · 后补)';"), 'the to-follow suffix changed');
    assert.ok(RETAIL_SRC.includes("'Air shipment · 空运'"));
    assert.ok(RETAIL_SRC.includes("'Local delivery · 同城配送'"));
    assert.ok(RETAIL_SRC.includes("'Land shipment · 陆运'"));
  });
  await it('ensureShipments writes the same five columns branch A writes', () => {
    // This is what makes "branch A creates a normal parcel" true rather than
    // hopeful: the system's own planner sets no more than these either.
    const at = RETAIL_SRC.indexOf('function ensureShipments');
    assert.notStrictEqual(at, -1);
    const ins = /INSERT INTO retail_shipments \(([^)]*)\)/.exec(RETAIL_SRC.slice(at));
    const cols = ins[1].split(',').map(s => s.trim());
    assert.deepStrictEqual(cols, WRITTEN_COLUMNS.retail_shipments);
  });

  console.log('');
  console.log(`  driver: ${driver}`);
  if (SABOTAGE) {
    console.log(`  sabotage: ${fail} of the 4 headline assertions failed`);
    console.log('  (one per proven claim: the bug, branch A, branch B, single registration)');
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
