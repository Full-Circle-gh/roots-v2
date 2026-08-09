#!/usr/bin/env node
/**
 * Before/after equivalence for the FOURTH transaction conversion batch
 * (decisions §24, Path A step 3): nine inline route transactions moved from
 * better-sqlite3's db.transaction() onto withTransaction.
 *
 *   node scripts/test_tx_conversion_batch4.js
 *
 * THE NINE, and what each is here to prove:
 *   PUT  /category-tree                    a rename migration whose COUNT is the response
 *   POST /addresses            (customer)  lastInsertRowid out of the body, is_default cleared first
 *   PUT  /addresses/:id        (customer)  three conditional writes + the pin branch
 *   PUT  /products/:id/variants            an EARLY RETURN that must still commit
 *   POST /shipment-suggestion/apply        a local helper that had to take the handle
 *   POST /shipments/combine                re-point then delete, in one block
 *   POST /shipments/split      (to-follow) insert + reassign, new id out of the body
 *   POST /qingyun/confirm-point            a throw used as control flow, caught outside
 *   POST /qingyun/reschedule               write order is the point; requeue flag returned
 *
 * WHY IT IS SHAPED THIS WAY. "It still runs" is not the bar. Each body is run in
 * BOTH forms — the pre-conversion one and the converted one — against the same
 * fixtures on the same schema, and compared on everything observable: rows
 * written, the value the body returned, and the state left behind after a
 * mid-transaction failure.
 *
 * routes/retail.js cannot be required from a test — it opens the database at
 * load, registers routes and starts intervals — so the SQL and control flow of
 * each body are reproduced verbatim below. What the conversion did NOT touch
 * (normalizeChinaAddress, buildShipmentSuggestion, the surrounding handler) is
 * not reproduced: it is byte-identical in the diff, and copying it would only
 * prove that a copy equals itself.
 *
 * *** TEST 1 IS THE ONE THAT MATTERS MOST, AND IT IS NOT ABOUT TRANSACTIONS ***
 * Batch 2 was nearly GREEN AND WRONG because the shared harness silently dropped
 * columns whose addColumn() type it could not parse — the suite passed against a
 * table that was missing fields the code under test writes. Test 1 asserts that
 * every column these nine routes write actually EXISTS in the harness-built
 * schema. Without it, a future harness regression makes this whole file
 * meaningless while still reporting success. Add to WRITTEN_COLUMNS whenever a
 * converted route starts writing a new column.
 *
 * *** SABOTAGE IS PER-CONVERSION, NOT PER-FILE ***
 * The batch standard is "red proven for EVERY conversion, individually". A
 * sabotage switch that flips two assertions out of nine blocks does not meet it:
 * seven of the nine would still be unproven. So every one of the nine sections
 * below carries a headline assertion whose expected value SABOTAGE flips, and
 * the sabotage run is expected to fail nine of them — the footer prints the
 * count so a partial red is visible rather than passing for a full one.
 *
 * ONE DRIVER LIMITATION, STATED RATHER THAN HIDDEN. The pre-conversion form
 * calls db.transaction(), which node:sqlite does not have. On that driver the
 * "old" form is a manual BEGIN/COMMIT reference — the same statements
 * better-sqlite3 issues — and the footer says so. Only a better-sqlite3 run
 * compares against the REAL old implementation, which is why this is also run on
 * the box.
 *
 * TO PROVE THE SUITE CAN FAIL:  TX_CONV4_SABOTAGE=1 node scripts/test_tx_conversion_batch4.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb, addForkedStoreProducts, driver } =
  require('./test-support/memory-db');
const { withTransaction } = require('../lib/db-transaction');

const SABOTAGE = process.env.TX_CONV4_SABOTAGE === '1';
const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');

// Created by database.js. store_products is NOT here — it has no CREATE
// anywhere; the harness forks it off `products` the way the application does.
const DB_TABLES = ['storefront_config', 'retail_customer_addresses',
  'retail_orders', 'retail_order_items', 'retail_shipments',
  'qingyun_push_queue'];

// Every column the nine converted bodies write. Test 1 holds the harness to it.
// Read off the SQL below, not off the schema — the point is to catch a schema
// that has grown thinner than the code.
const WRITTEN_COLUMNS = {
  storefront_config: ['key', 'value_json', 'updated_at', 'updated_by'],
  store_products: ['top_category', 'subcategory', 'variant_group_id',
    'variant_label', 'variant_label_cn', 'variant_noun_en', 'variant_noun_cn',
    'variant_sort', 'updated_at'],
  retail_customer_addresses: ['customer_id', 'recipient_name', 'phone',
    'province', 'city', 'district', 'province_en', 'city_en', 'district_en',
    'address', 'detail', 'postal_code', 'is_default', 'lat', 'lng',
    'geocoded_at', 'geo_source', 'geo_precision', 'updated_at'],
  retail_shipments: ['order_id', 'mode', 'label', 'created_at', 'updated_at'],
  retail_order_items: ['shipment_id'],
  retail_orders: ['address_json', 'scheduled_for', 'delivery_slot_label',
    'delivery_slot_kind', 'seen_at', 'updated_at'],
  qingyun_push_queue: ['status', 'attempts', 'last_error', 'needs_point_at',
    'guessed_lat', 'guessed_lng', 'guessed_precision', 'geo_held_at',
    'updated_at'],
};

const REAL_OLD = (() => {
  const db = openTablesDb(DB_SRC, ['storefront_config']);
  return typeof db.transaction === 'function';
})();

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

/** Stand-in for db.transaction() on drivers that lack it — the same statements. */
function legacyTransaction(db, fn) {
  return (...args) => {
    db.exec('BEGIN');
    try { const r = fn(...args); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch { /* already unwound */ } throw e; }
  };
}
const makeOldTx = (db, fn) => (REAL_OLD ? db.transaction(fn) : legacyTransaction(db, fn));

function fresh() {
  const db = openTablesDb(DB_SRC, DB_TABLES);
  addForkedStoreProducts(db, SCHEMA_SRC, DB_SRC);
  return db;
}

// The two queue statements are read from the module the route reads them from,
// so a change there fails this suite instead of drifting past it.
const qingyunQueue = require('../lib/qingyun-queue');

// ── 1. PUT /category-tree ─────────────────────────────────────────────────
// `hook` injects a mid-transaction failure at the same point in both forms.
const UPSERT_TREE = `INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
           VALUES ('category.tree', ?, CURRENT_TIMESTAMP, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by`;

function treeBody(h, topRenames, subRenames, incoming, userId, hook) {
  const upsert = h.prepare(UPSERT_TREE);
  let migrated = 0;
  for (const r of topRenames) {
    h.prepare('UPDATE store_products SET top_category = ? WHERE top_category = ?').run('\u0000T' + r.id, r.oldName);
  }
  for (const r of topRenames) {
    const info = h.prepare('UPDATE store_products SET top_category = ? WHERE top_category = ?').run(r.newName, '\u0000T' + r.id);
    migrated += info.changes;
  }
  if (hook) hook();
  for (const r of subRenames) {
    h.prepare('UPDATE store_products SET subcategory = ? WHERE top_category = ? AND subcategory = ?').run('\u0000S' + r.id, r.parentNewName, r.oldName);
  }
  for (const r of subRenames) {
    const info = h.prepare('UPDATE store_products SET subcategory = ? WHERE top_category = ? AND subcategory = ?').run(r.newName, r.parentNewName, '\u0000S' + r.id);
    migrated += info.changes;
  }
  upsert.run(JSON.stringify(incoming), userId);
  return migrated;
}
const treeOld = (db, ...a) => makeOldTx(db, () => treeBody(db, ...a))();
const treeNew = (db, ...a) => withTransaction(db, (tx) => treeBody(tx, ...a));

// ── 2. POST /api/retail/addresses (customer) ──────────────────────────────
// The INSERT's geocoded_at slot is interpolated, not bound — reproduced as
// written, because a test that binds it would not be testing this statement.
function addrCreateBody(h, customerId, a, pin, pinSource, pinPrecision, hook) {
  if (a.is_default) {
    h.prepare('UPDATE retail_customer_addresses SET is_default = 0 WHERE customer_id = ?').run(customerId);
  }
  if (hook) hook();
  const info = h.prepare(
    `INSERT INTO retail_customer_addresses
       (customer_id, recipient_name, phone, province, city, district,
        province_en, city_en, district_en,
        address, detail, postal_code, is_default,
        lat, lng, geocoded_at, geo_source, geo_precision)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,${pin ? 'CURRENT_TIMESTAMP' : 'NULL'},?,?)`
  ).run(
    customerId, a.recipient_name, a.phone,
    a.province || null, a.city || null, a.district || null,
    a.province_en || null, a.city_en || null, a.district_en || null,
    a.address, a.detail || null, a.postal_code || null,
    a.is_default ? 1 : 0,
    pin ? pin.lat : null, pin ? pin.lng : null,
    pinSource, pinPrecision
  );
  return info.lastInsertRowid;
}
const addrCreateOld = (db, ...a) => makeOldTx(db, () => addrCreateBody(db, ...a))();
const addrCreateNew = (db, ...a) => withTransaction(db, (tx) => addrCreateBody(tx, ...a));

// ── 3. PUT /api/retail/addresses/:id (customer) ───────────────────────────
const UPD_ADDR = `UPDATE retail_customer_addresses
        SET recipient_name = COALESCE(?, recipient_name),
            phone          = COALESCE(?, phone),
            province       = COALESCE(?, province),
            city           = COALESCE(?, city),
            district       = COALESCE(?, district),
            address        = COALESCE(?, address),
            detail         = COALESCE(?, detail),
            postal_code    = COALESCE(?, postal_code),
            is_default     = COALESCE(?, is_default),
            updated_at     = CURRENT_TIMESTAMP
      WHERE id = ?`;

function addrUpdateBody(h, customerId, id, a, regionChanged, pin, pinPlan) {
  if (a.is_default) {
    h.prepare('UPDATE retail_customer_addresses SET is_default = 0 WHERE customer_id = ?').run(customerId);
  }
  if (regionChanged) {
    h.prepare(
      `UPDATE retail_customer_addresses
          SET province_en = ?, city_en = ?, district_en = ?
        WHERE id = ?`
    ).run(a.province_en || null, a.city_en || null, a.district_en || null, id);
  }
  h.prepare(UPD_ADDR).run(
    a.recipient_name ?? null, a.phone ?? null,
    a.province ?? null, a.city ?? null, a.district ?? null,
    a.address ?? null, a.detail ?? null, a.postal_code ?? null,
    a.is_default == null ? null : (a.is_default ? 1 : 0),
    id
  );
  if (pinPlan.action === 'set') {
    h.prepare(
      `UPDATE retail_customer_addresses
          SET lat = ?, lng = ?, geo_source = ?, geo_precision = ?, geocoded_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(pin.lat, pin.lng, pinPlan.source, pinPlan.precision, id);
  } else if (pinPlan.action === 'clear') {
    h.prepare(
      `UPDATE retail_customer_addresses
          SET lat = NULL, lng = NULL, geo_source = NULL, geo_precision = NULL, geocoded_at = NULL
        WHERE id = ?`
    ).run(id);
  }
}
const addrUpdateOld = (db, ...a) => makeOldTx(db, () => addrUpdateBody(db, ...a))();
const addrUpdateNew = (db, ...a) => withTransaction(db, (tx) => addrUpdateBody(tx, ...a));

// ── 4. PUT /products/:id/variants ─────────────────────────────────────────
function variantsBody(h, id, desired, prevGid, groupId, nounEn, nounCn) {
  if (desired.length < 2) {
    if (prevGid) h.prepare('UPDATE store_products SET variant_group_id=NULL, variant_label=NULL, variant_label_cn=NULL, variant_noun_en=NULL, variant_noun_cn=NULL, updated_at=CURRENT_TIMESTAMP WHERE variant_group_id=?').run(prevGid);
    h.prepare('UPDATE store_products SET variant_group_id=NULL, variant_label=NULL, variant_label_cn=NULL, variant_noun_en=NULL, variant_noun_cn=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(id);
    return 0;
  }
  if (prevGid) {
    const keep = desired.map(([mid]) => mid);
    const ph = keep.map(() => '?').join(',');
    h.prepare(`UPDATE store_products SET variant_group_id=NULL, variant_label=NULL, variant_label_cn=NULL, updated_at=CURRENT_TIMESTAMP WHERE variant_group_id=? AND id NOT IN (${ph})`).run(prevGid, ...keep);
  }
  const upd = h.prepare('UPDATE store_products SET variant_group_id=?, variant_label=?, variant_label_cn=?, variant_noun_en=?, variant_noun_cn=?, variant_sort=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
  desired.forEach(([mid, lbl], idx) => upd.run(groupId, lbl.label, lbl.label_cn, nounEn, nounCn, idx, mid));
  return desired.length;
}
const variantsOld = (db, ...a) => makeOldTx(db, () => variantsBody(db, ...a))();
const variantsNew = (db, ...a) => withTransaction(db, (tx) => variantsBody(tx, ...a));

// ── 5. POST /shipment-suggestion/apply ────────────────────────────────────
// ensureShipmentRow now TAKES THE HANDLE. That is the conversion here: closing
// over the outer handle would put its INSERT outside the block on pg.
function makeEnsureShipmentRow(orderId, byMode) {
  return (h, mode) => {
    if (byMode.has(mode)) return byMode.get(mode);
    const label = mode === 'air' ? 'Air shipment · 空运' : 'Land shipment · 陆运';
    const r = h.prepare(
      `INSERT INTO retail_shipments (order_id, mode, label, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(orderId, mode, label);
    byMode.set(mode, r.lastInsertRowid);
    return r.lastInsertRowid;
  };
}
function applyBody(h, id, plan, shipments, ensureShipmentRow, hook) {
  const reassign = h.prepare(
    'UPDATE retail_order_items SET shipment_id = ? WHERE id = ? AND order_id = ?'
  );
  for (const bk of plan) {
    const sid = ensureShipmentRow(h, bk.mode);
    for (const itemId of bk.item_ids) reassign.run(sid, itemId, id);
  }
  if (hook) hook();
  const emptyIds = h.prepare(
    `SELECT s.id FROM retail_shipments s
      WHERE s.order_id = ?
        AND NOT EXISTS (SELECT 1 FROM retail_order_items i WHERE i.shipment_id = s.id)`
  ).all(id);
  for (const row of emptyIds) {
    const s = shipments.find(x => x.id === row.id);
    if (s && (s.tracking_number || s.tracking_carrier)) continue;
    h.prepare('DELETE FROM retail_shipments WHERE id = ?').run(row.id);
  }
}
const applyOld = (db, ...a) => makeOldTx(db, () => applyBody(db, ...a))();
const applyNew = (db, ...a) => withTransaction(db, (tx) => applyBody(tx, ...a));

// ── 6. POST /shipments/combine ────────────────────────────────────────────
function combineBody(h, id, keep, mode, label, shipments, hook) {
  h.prepare('UPDATE retail_order_items SET shipment_id = ? WHERE order_id = ?').run(keep, id);
  h.prepare(
    'UPDATE retail_shipments SET mode = ?, label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(mode, label, keep);
  if (hook) hook();
  for (const s of shipments) {
    if (s.id !== keep) h.prepare('DELETE FROM retail_shipments WHERE id = ?').run(s.id);
  }
}
const combineOld = (db, ...a) => makeOldTx(db, () => combineBody(db, ...a))();
const combineNew = (db, ...a) => withTransaction(db, (tx) => combineBody(tx, ...a));

// ── 7. POST /shipments/split (the to-follow registration) ─────────────────
function splitBody(h, id, mode, label, items, hook) {
  const r = h.prepare(
    `INSERT INTO retail_shipments (order_id, mode, label, created_at, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  ).run(id, mode, label);
  const newId = r.lastInsertRowid;
  if (hook) hook();
  const reassign = h.prepare('UPDATE retail_order_items SET shipment_id = ? WHERE id = ? AND order_id = ?');
  for (const it of items) reassign.run(newId, it.id, id);
  return newId;
}
const splitOld = (db, ...a) => makeOldTx(db, () => splitBody(db, ...a))();
const splitNew = (db, ...a) => withTransaction(db, (tx) => splitBody(tx, ...a));

// ── 8. POST /qingyun/confirm-point ────────────────────────────────────────
// NO NETWORK CALL IS REPRODUCED HERE BECAUSE THERE IS NONE IN THE ROUTE. Both
// statements are local SQL; the push is the drain's work on its own poll.
function confirmPointBody(h, id, addrJson) {
  h.prepare('UPDATE retail_orders SET address_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(addrJson, id);
  const r = h.prepare(qingyunQueue.CONFIRM_POINT_SQL).run(id);
  if (!r.changes) throw new Error('row_moved');
  return true;
}
const confirmOld = (db, ...a) => makeOldTx(db, () => confirmPointBody(db, ...a))();
const confirmNew = (db, ...a) => withTransaction(db, (tx) => confirmPointBody(tx, ...a));

// ── 9. POST /qingyun/reschedule ───────────────────────────────────────────
function rescheduleBody(h, id, date, kind) {
  h.prepare(
    `UPDATE retail_orders
        SET scheduled_for = ?, delivery_slot_label = ?, delivery_slot_kind = ?,
            seen_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(date, date, kind, id);
  return h.prepare(qingyunQueue.MANUAL_RETRY_SQL).run(id).changes > 0;
}
const rescheduleOld = (db, ...a) => makeOldTx(db, () => rescheduleBody(db, ...a))();
const rescheduleNew = (db, ...a) => withTransaction(db, (tx) => rescheduleBody(tx, ...a));

// ── Fixtures ──────────────────────────────────────────────────────────────
// name_en / qty / unit_price / line_total are NOT NULL in the real tables. The
// fixtures carry them because the harness builds the REAL definitions — the same
// way batch 3's retail_auth_tokens fixture had to learn about expires_at.
function seedProducts(db, rows) {
  const ins = db.prepare('INSERT INTO store_products (id, name_en, top_category, subcategory) VALUES (?,?,?,?)');
  for (const r of rows) ins.run(r.id, r.name, r.top || null, r.sub || null);
}
function seedOrder(db, id) {
  db.prepare('INSERT INTO retail_orders (id, order_no, status) VALUES (?,?,?)')
    .run(id, 'RO-' + id, 'paid');
}
function seedItems(db, orderId, ids) {
  const ins = db.prepare(
    'INSERT INTO retail_order_items (id, order_id, qty, unit_price, line_total) VALUES (?,?,1,1,1)'
  );
  for (const i of ids) ins.run(i, orderId);
}
function seedShipment(db, orderId, mode, extra = {}) {
  const r = db.prepare(
    'INSERT INTO retail_shipments (order_id, mode, label, tracking_number) VALUES (?,?,?,?)'
  ).run(orderId, mode, mode + ' label', extra.tracking_number || null);
  return Number(r.lastInsertRowid);
}
function seedQueueRow(db, orderId, status) {
  db.prepare(
    `INSERT INTO qingyun_push_queue (retail_order_id, store_code, status, attempts)
     VALUES (?,?,?,3)`
  ).run(orderId, 'GZ01', status);
  db.prepare('UPDATE qingyun_push_queue SET needs_point_at = ?, guessed_lat = 23.1 WHERE retail_order_id = ?')
    .run('2026-08-09 00:00:00', orderId);
}

const prodRows = (db) => db.prepare('SELECT id, top_category, subcategory FROM store_products ORDER BY id').all();
const cfgRows = (db) => db.prepare('SELECT key, value_json FROM storefront_config ORDER BY key').all();
const addrRows = (db) => db.prepare(
  'SELECT id, customer_id, recipient_name, phone, city, city_en, detail, is_default, lat, lng, geo_source, geo_precision FROM retail_customer_addresses ORDER BY id'
).all();
const variantRows = (db) => db.prepare(
  'SELECT id, variant_group_id, variant_label, variant_label_cn, variant_noun_en, variant_noun_cn, variant_sort FROM store_products ORDER BY id'
).all();
const shipRows = (db) => db.prepare('SELECT id, order_id, mode, label FROM retail_shipments ORDER BY id').all();
const itemRows = (db) => db.prepare('SELECT id, shipment_id FROM retail_order_items ORDER BY id').all();
const orderRow = (db, id) => db.prepare(
  'SELECT address_json, scheduled_for, delivery_slot_label, delivery_slot_kind, seen_at FROM retail_orders WHERE id = ?'
).get(id);
const queueRow = (db, orderId) => db.prepare(
  'SELECT status, attempts, needs_point_at, guessed_lat FROM qingyun_push_queue WHERE retail_order_id = ?'
).get(orderId);

async function main() {
  console.log(`\nTRANSACTION CONVERSION — BATCH 4 (driver: ${driver})`);
  if (SABOTAGE) console.log('  *** TX_CONV4_SABOTAGE=1 — expected values flipped, this run MUST fail 9 ***');
  console.log('');

  console.log('[1] HARNESS COVERS EVERY COLUMN THESE ROUTES WRITE');
  console.log('    The batch 2 defect: a silently thinner table makes the rest of');
  console.log('    this file pass against a schema the real code would fail on.');
  await it('every written column exists in the harness-built schema', () => {
    const db = fresh();
    const gaps = [];
    for (const [t, cols] of Object.entries(WRITTEN_COLUMNS)) {
      const have = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name));
      for (const c of cols) if (!have.has(c)) gaps.push(`${t}.${c}`);
    }
    assert.deepStrictEqual(gaps, [], `harness schema is missing ${gaps.join(', ')}`);
  });

  // ── 1 ──────────────────────────────────────────────────────────────────
  console.log('\n[2] category-tree — the migrated COUNT is the response');
  const tops = [{ id: 'fresh', oldName: 'Fresh', newName: 'Produce' }];
  const subs = [{ id: 'leaf', parentNewName: 'Produce', oldName: 'Leafy', newName: 'Greens' }];
  const seedTree = (db) => seedProducts(db, [
    { id: 1, name: 'a', top: 'Fresh', sub: 'Leafy' },
    { id: 2, name: 'b', top: 'Fresh', sub: 'Leafy' },
    { id: 3, name: 'c', top: 'Pantry', sub: 'Oils' },
  ]);
  await it('both forms migrate the same rows and return the same count', async () => {
    const a = fresh(); seedTree(a);
    const b = fresh(); seedTree(b);
    const oldVal = treeOld(a, tops, subs, [{ id: 'fresh', name: 'Produce' }], 7);
    const newVal = await treeNew(b, tops, subs, [{ id: 'fresh', name: 'Produce' }], 7);
    assert.strictEqual(newVal, SABOTAGE ? 999 : oldVal);
    assert.strictEqual(newVal, 4, '2 top renames + 2 sub renames');
    assert.deepStrictEqual(prodRows(b), prodRows(a));
    assert.deepStrictEqual(cfgRows(b), cfgRows(a));
  });
  await it('the NUL sentinel never survives — no half-renamed row is left', async () => {
    const b = fresh(); seedTree(b);
    await treeNew(b, tops, subs, [{ id: 'fresh', name: 'Produce' }], 7);
    const stuck = b.prepare(
      "SELECT COUNT(*) n FROM store_products WHERE top_category LIKE char(0)||'%' OR subcategory LIKE char(0)||'%'"
    ).get().n;
    assert.strictEqual(stuck, 0);
  });
  await it('a failure after the top rename rolls the whole migration back', async () => {
    const b = fresh(); seedTree(b);
    const before = prodRows(b);
    await assert.rejects(
      () => treeNew(b, tops, subs, [{ id: 'fresh', name: 'Produce' }], 7, () => { throw new Error('mid'); }),
      /mid/);
    assert.deepStrictEqual(prodRows(b), before, 'the top rename must have rolled back too');
    assert.deepStrictEqual(cfgRows(b), [], 'and the tree must not have been saved');
  });

  // ── 2 ──────────────────────────────────────────────────────────────────
  console.log('\n[3] customer address create — lastInsertRowid out of the body');
  const addr = {
    recipient_name: 'R', phone: '13800000000', province: '广东省', city: '广州市',
    district: '天河区', province_en: 'Guangdong', city_en: 'Guangzhou',
    district_en: 'Tianhe', address: 'A', detail: 'det', postal_code: '510000',
    is_default: 1,
  };
  const pin = { lat: 23.13, lng: 113.26, fresh: true };
  await it('both forms return the same new id and write the same row', async () => {
    const a = fresh(); const b = fresh();
    const oldId = addrCreateOld(a, 3, addr, pin, 'customer_pin', 'rooftop');
    const newId = await addrCreateNew(b, 3, addr, pin, 'customer_pin', 'rooftop');
    assert.strictEqual(Number(newId), SABOTAGE ? -1 : Number(oldId));
    assert.deepStrictEqual(addrRows(b), addrRows(a));
    assert.strictEqual(addrRows(b)[0].geo_source, 'customer_pin');
  });
  await it('no pin → the interpolated geocoded_at slot writes NULL, not a stamp', async () => {
    const b = fresh();
    const id = await addrCreateNew(b, 3, addr, null, null, null);
    const r = b.prepare('SELECT lat, geocoded_at, geo_source FROM retail_customer_addresses WHERE id = ?').get(id);
    assert.deepStrictEqual([r.lat, r.geocoded_at, r.geo_source], [null, null, null]);
  });
  await it('a failure mid-body leaves neither the is_default clear nor the insert', async () => {
    const b = fresh();
    await addrCreateNew(b, 3, addr, pin, 'customer_pin', 'rooftop');
    const before = addrRows(b);
    await assert.rejects(
      () => addrCreateNew(b, 3, addr, pin, 'customer_pin', 'rooftop', () => { throw new Error('mid'); }),
      /mid/);
    assert.deepStrictEqual(addrRows(b), before, 'the is_default clear must have rolled back too');
  });

  // ── 3 ──────────────────────────────────────────────────────────────────
  console.log('\n[4] customer address update — region companions + the pin branch');
  await it('both forms agree on a region change that also re-pins', async () => {
    const a = fresh(); const b = fresh();
    const ia = addrCreateOld(a, 3, addr, pin, 'customer_pin', 'rooftop');
    const ib = await addrCreateNew(b, 3, addr, pin, 'customer_pin', 'rooftop');
    const edit = { ...addr, city: '深圳市', city_en: 'Shenzhen' };
    const plan = { action: 'set', source: 'customer_pin', precision: 'rooftop' };
    const newPin = { lat: 22.54, lng: 114.06 };
    addrUpdateOld(a, 3, ia, edit, true, newPin, plan);
    await addrUpdateNew(b, 3, ib, edit, true, newPin, plan);
    const expect = SABOTAGE ? [] : addrRows(a);
    assert.deepStrictEqual(addrRows(b), expect);
    assert.strictEqual(addrRows(b)[0].city_en, 'Shenzhen');
    assert.strictEqual(addrRows(b)[0].lat, 22.54);
  });
  await it('a phone-only edit touches nothing else and leaves the pin alone', async () => {
    const b = fresh();
    const id = await addrCreateNew(b, 3, addr, pin, 'customer_pin', 'rooftop');
    await addrUpdateNew(b, 3, id, { phone: '13911111111' }, false, null, { action: 'keep' });
    const r = addrRows(b)[0];
    assert.strictEqual(r.phone, '13911111111');
    assert.strictEqual(r.recipient_name, 'R');
    assert.strictEqual(r.lat, 23.13);
  });
  await it('the clear branch nulls all five coordinate columns together', async () => {
    const b = fresh();
    const id = await addrCreateNew(b, 3, addr, pin, 'customer_pin', 'rooftop');
    await addrUpdateNew(b, 3, id, { address: 'NEW' }, false, null, { action: 'clear' });
    const r = addrRows(b)[0];
    assert.deepStrictEqual([r.lat, r.lng, r.geo_source, r.geo_precision], [null, null, null, null]);
  });

  // ── 4 ──────────────────────────────────────────────────────────────────
  console.log('\n[5] product variants — the EARLY RETURN must still commit');
  const seedVariants = (db) => seedProducts(db, [
    { id: 10, name: 'red' }, { id: 11, name: 'blue' }, { id: 12, name: 'green' },
  ]);
  const desired3 = [[10, { label: 'Red', label_cn: '红' }], [11, { label: 'Blue', label_cn: '蓝' }]];
  await it('both forms group the same members and return the same count', async () => {
    const a = fresh(); seedVariants(a);
    const b = fresh(); seedVariants(b);
    const oldVal = variantsOld(a, 10, desired3, null, 10, 'color', '颜色');
    const newVal = await variantsNew(b, 10, desired3, null, 10, 'color', '颜色');
    assert.strictEqual(newVal, SABOTAGE ? 999 : oldVal);
    assert.strictEqual(newVal, 2);
    assert.deepStrictEqual(variantRows(b), variantRows(a));
  });
  await it('the disband path returns 0 AND its clears are committed, not discarded', async () => {
    const b = fresh(); seedVariants(b);
    await variantsNew(b, 10, desired3, null, 10, 'color', '颜色');
    const n = await variantsNew(b, 10, [[10, { label: 'Red', label_cn: '红' }]], 10, 10, null, null);
    assert.strictEqual(n, 0);
    // An early return is an ordinary resolution: withTransaction must COMMIT it.
    const rows = variantRows(b).filter(r => r.variant_group_id !== null);
    assert.deepStrictEqual(rows, [], 'the disband clears must have committed');
  });
  await it('members dropped from the list lose the group, the kept ones keep it', async () => {
    const b = fresh(); seedVariants(b);
    await variantsNew(b, 10, [...desired3, [12, { label: 'Green', label_cn: '绿' }]], null, 10, 'color', '颜色');
    await variantsNew(b, 10, desired3, 10, 10, 'color', '颜色');
    const byId = new Map(variantRows(b).map(r => [r.id, r.variant_group_id]));
    assert.deepStrictEqual([byId.get(10), byId.get(11), byId.get(12)], [10, 10, null]);
  });

  // ── 5 ──────────────────────────────────────────────────────────────────
  console.log('\n[6] shipment-suggestion/apply — the helper now takes the handle');
  await it('both forms re-bucket identically and drop the emptied parcel', async () => {
    const build = (db) => {
      seedOrder(db, 900); seedItems(db, 900, [1, 2, 3]);
      const land = seedShipment(db, 900, 'land');
      db.prepare('UPDATE retail_order_items SET shipment_id = ? WHERE order_id = ?').run(land, 900);
      return db.prepare('SELECT id, mode, tracking_number, tracking_carrier FROM retail_shipments WHERE order_id = 900').all();
    };
    const a = fresh(); const shipA = build(a);
    const b = fresh(); const shipB = build(b);
    const plan = [{ mode: 'air', item_ids: [1] }, { mode: 'land', item_ids: [2, 3] }];
    applyOld(a, 900, plan, shipA, makeEnsureShipmentRow(900, new Map(shipA.map(s => [s.mode, s.id]))));
    await applyNew(b, 900, plan, shipB, makeEnsureShipmentRow(900, new Map(shipB.map(s => [s.mode, s.id]))));
    const expect = SABOTAGE ? [] : shipRows(a);
    assert.deepStrictEqual(shipRows(b), expect);
    assert.deepStrictEqual(itemRows(b), itemRows(a));
    assert.strictEqual(shipRows(b).length, 2, 'the air parcel was created, the land one kept');
  });
  await it('the created parcel rolls back with the reassignment it was created for', async () => {
    const b = fresh();
    seedOrder(b, 901); seedItems(b, 901, [4, 5]);
    const land = seedShipment(b, 901, 'land');
    b.prepare('UPDATE retail_order_items SET shipment_id = ? WHERE order_id = ?').run(land, 901);
    const before = { ships: shipRows(b), items: itemRows(b) };
    const byMode = new Map([['land', land]]);
    await assert.rejects(
      () => applyNew(b, 901, [{ mode: 'air', item_ids: [4] }], before.ships,
        makeEnsureShipmentRow(901, byMode), () => { throw new Error('mid'); }),
      /mid/);
    assert.deepStrictEqual(shipRows(b), before.ships, 'the INSERTed air parcel must be gone');
    assert.deepStrictEqual(itemRows(b), before.items);
  });

  // ── 6 ──────────────────────────────────────────────────────────────────
  console.log('\n[7] shipments/combine — re-point then delete, in one block');
  const buildCombine = (db, oid) => {
    seedOrder(db, oid); seedItems(db, oid, [oid * 10 + 1, oid * 10 + 2]);
    const air = seedShipment(db, oid, 'air');
    const land = seedShipment(db, oid, 'land');
    db.prepare('UPDATE retail_order_items SET shipment_id = ? WHERE id = ?').run(air, oid * 10 + 1);
    db.prepare('UPDATE retail_order_items SET shipment_id = ? WHERE id = ?').run(land, oid * 10 + 2);
    return db.prepare('SELECT id FROM retail_shipments WHERE order_id = ? ORDER BY id').all(oid);
  };
  await it('both forms collapse to one parcel with every item on it', async () => {
    const a = fresh(); const sa = buildCombine(a, 910);
    const b = fresh(); const sb = buildCombine(b, 910);
    combineOld(a, 910, sa[0].id, 'air', 'Combined shipment · 合并发货', sa);
    await combineNew(b, 910, sb[0].id, 'air', 'Combined shipment · 合并发货', sb);
    const expect = SABOTAGE ? [] : shipRows(a);
    assert.deepStrictEqual(shipRows(b), expect);
    assert.deepStrictEqual(itemRows(b), itemRows(a));
    assert.strictEqual(shipRows(b).length, 1);
    assert.deepStrictEqual([...new Set(itemRows(b).map(r => r.shipment_id))], [sb[0].id]);
  });
  await it('a failure before the deletes leaves items on parcels that still exist', async () => {
    const b = fresh(); const sb = buildCombine(b, 911);
    const before = { ships: shipRows(b), items: itemRows(b) };
    await assert.rejects(
      () => combineNew(b, 911, sb[0].id, 'air', 'L', sb, () => { throw new Error('mid'); }),
      /mid/);
    assert.deepStrictEqual(shipRows(b), before.ships);
    assert.deepStrictEqual(itemRows(b), before.items, 'the re-point must have rolled back with the deletes');
  });

  // ── 7 ──────────────────────────────────────────────────────────────────
  console.log('\n[8] shipments/split (to-follow) — the new id out of the body');
  const buildSplit = (db, oid) => {
    seedOrder(db, oid); seedItems(db, oid, [oid * 10 + 1, oid * 10 + 2, oid * 10 + 3]);
    const land = seedShipment(db, oid, 'land');
    db.prepare('UPDATE retail_order_items SET shipment_id = ? WHERE order_id = ?').run(land, oid);
    return [{ id: oid * 10 + 1 }];
  };
  await it('both forms return the same new shipment id and move the same items', async () => {
    const a = fresh(); const ia = buildSplit(a, 920);
    const b = fresh(); const ib = buildSplit(b, 920);
    const label = 'Land shipment · 陆运 (to follow · 后补)';
    const oldId = splitOld(a, 920, 'land', label, ia);
    const newId = await splitNew(b, 920, 'land', label, ib);
    assert.strictEqual(Number(newId), SABOTAGE ? -1 : Number(oldId));
    assert.deepStrictEqual(shipRows(b), shipRows(a));
    assert.deepStrictEqual(itemRows(b), itemRows(a));
    assert.strictEqual(itemRows(b).find(r => r.id === 9201).shipment_id, Number(newId));
  });
  await it('a failure after the INSERT leaves no orphan parcel behind', async () => {
    const b = fresh(); const items = buildSplit(b, 921);
    const before = shipRows(b);
    await assert.rejects(
      () => splitNew(b, 921, 'land', 'L', items, () => { throw new Error('mid'); }),
      /mid/);
    assert.deepStrictEqual(shipRows(b), before, 'the new parcel must have rolled back');
  });

  // ── 8 ──────────────────────────────────────────────────────────────────
  console.log('\n[9] qingyun/confirm-point — a throw used as control flow');
  const addrJson = JSON.stringify({ city: '广州市', lat: 23.13, lng: 113.26, geo_source: 'staff_pin', geo_precision: null });
  await it('both forms write the point and requeue the row identically', async () => {
    const a = fresh(); seedOrder(a, 930); seedQueueRow(a, 930, 'needs_point');
    const b = fresh(); seedOrder(b, 930); seedQueueRow(b, 930, 'needs_point');
    const oldVal = confirmOld(a, 930, addrJson);
    const newVal = await confirmNew(b, 930, addrJson);
    assert.strictEqual(newVal, SABOTAGE ? false : oldVal);
    assert.deepStrictEqual(queueRow(b, 930), queueRow(a, 930));
    assert.deepStrictEqual(orderRow(b, 930).address_json, orderRow(a, 930).address_json);
    const q = queueRow(b, 930);
    assert.deepStrictEqual([q.status, q.attempts, q.needs_point_at, q.guessed_lat],
      ['pending', 0, null, null]);
  });
  await it('a row the drain already moved rolls the address write back too', async () => {
    const b = fresh(); seedOrder(b, 931); seedQueueRow(b, 931, 'done');
    const before = orderRow(b, 931);
    await assert.rejects(() => confirmNew(b, 931, addrJson), /row_moved/);
    assert.deepStrictEqual(orderRow(b, 931), before, 'the staff pin must NOT survive a lost race');
  });
  await it('the rethrown error is the ORIGINAL object — the 409 branch still reads it', async () => {
    const b = fresh(); seedOrder(b, 932); seedQueueRow(b, 932, 'done');
    const caught = await confirmNew(b, 932, addrJson).then(() => null, (e) => e);
    assert.strictEqual(caught.message, 'row_moved', 'a wrapper here turns the 409 into a 500');
  });

  // ── 9 ──────────────────────────────────────────────────────────────────
  console.log('\n[10] qingyun/reschedule — write order is the point');
  await it('both forms set the date first and return the same requeue flag', async () => {
    const a = fresh(); seedOrder(a, 940); seedQueueRow(a, 940, 'skipped');
    const b = fresh(); seedOrder(b, 940); seedQueueRow(b, 940, 'skipped');
    const oldVal = rescheduleOld(a, 940, '2026-08-09', 'today');
    const newVal = await rescheduleNew(b, 940, '2026-08-09', 'today');
    assert.strictEqual(newVal, SABOTAGE ? false : oldVal);
    assert.strictEqual(newVal, true);
    assert.deepStrictEqual(orderRow(b, 940), orderRow(a, 940));
    assert.deepStrictEqual(queueRow(b, 940), queueRow(a, 940));
  });
  await it('the new date and the requeue are visible together or not at all', async () => {
    const b = fresh(); seedOrder(b, 941); seedQueueRow(b, 941, 'skipped');
    await rescheduleNew(b, 941, '2026-08-09', 'today');
    const o = orderRow(b, 941);
    assert.deepStrictEqual([o.scheduled_for, o.delivery_slot_kind, o.seen_at],
      ['2026-08-09', 'today', null]);
    assert.strictEqual(queueRow(b, 941).status, 'pending',
      'a pending row whose order still held the OLD date is the failure this ordering exists to stop');
  });

  // ── The shared handle ──────────────────────────────────────────────────
  console.log('\n[11] CONCURRENCY — these nine now share one serialised handle');
  await it('two overlapping converted transactions do not interleave', async () => {
    const db = fresh();
    const order = [];
    const one = withTransaction(db, async () => { order.push('a1'); await null; order.push('a2'); });
    const two = withTransaction(db, async () => { order.push('b1'); await null; order.push('b2'); });
    await Promise.all([one, two]);
    assert.deepStrictEqual(order, ['a1', 'a2', 'b1', 'b2']);
  });
  await it('a failed confirm-point does not discard a concurrent combine\'s writes', async () => {
    const db = fresh();
    seedOrder(db, 950); seedQueueRow(db, 950, 'done');
    const sb = buildCombine(db, 951);
    const bad = confirmNew(db, 950, addrJson).catch(() => 'caught');
    const good = combineNew(db, 951, sb[0].id, 'air', 'C', sb);
    await Promise.all([bad, good]);
    assert.strictEqual(shipRows(db).filter(s => s.order_id === 951).length, 1,
      'the combine must have survived the other block\'s ROLLBACK');
  });

  // ── The two things this batch had to watch ─────────────────────────────
  // Both were checked by hand before converting. Neither stays checked unless
  // it is asserted, so both are read off the real routes/retail.js here.
  console.log('\n[12] THE TWO HAZARDS, READ OFF THE REAL FILE');
  const RETAIL_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');

  /**
   * Every registration of a route path — /shipments/split has TWO.
   *
   * The brace scan starts at the HANDLER's arrow, not at the first `{` after the
   * registration: PUT /category-tree passes `express.json({ limit: '256kb' })`,
   * and a scan that took the first brace would return that options object and
   * report the route as "not an async handler".
   */
  function handlerSources(method, routePath) {
    const re = new RegExp(`router\\.${method}\\('${routePath.replace(/[/:]/g, m => '\\' + m)}'`, 'g');
    const out = [];
    for (const m of RETAIL_SRC.matchAll(re)) {
      const arrow = /\(req,\s*res\)\s*=>\s*\{/.exec(RETAIL_SRC.slice(m.index));
      if (!arrow) throw new Error(`route ${method.toUpperCase()} ${routePath}: no (req, res) handler found`);
      let i = m.index + arrow.index + arrow[0].length - 1, depth = 0;
      for (; i < RETAIL_SRC.length; i++) {
        const c = RETAIL_SRC[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
      }
      out.push(RETAIL_SRC.slice(m.index, i + 1));
    }
    if (!out.length) throw new Error(`route ${method.toUpperCase()} ${routePath} not found`);
    return out;
  }
  const only = (m, p) => {
    const all = handlerSources(m, p);
    assert.strictEqual(all.length, 1, `${m.toUpperCase()} ${p} is registered ${all.length} times`);
    return all[0];
  };

  await it('no CONVERTED shipments route calls ensureShipments or mergeAddonItemsIntoShipments', () => {
    // Both are blocked behind the checkout. A converted route that called one
    // would drag an unconverted dual-context helper across the boundary.
    for (const src of [
      only('post', '/api/retail-admin/orders/:id/shipment-suggestion/apply'),
      only('post', '/api/retail-admin/orders/:id/shipments/combine'),
      handlerSources('post', '/api/retail-admin/orders/:id/shipments/split')[1],
    ]) {
      assert.ok(/withTransaction\(/.test(src), 'expected a converted handler here');
      assert.ok(!/\bensureShipments\s*\(/.test(src), 'a converted route calls ensureShipments');
      assert.ok(!/\bmergeAddonItemsIntoShipments\s*\(/.test(src),
        'a converted route calls mergeAddonItemsIntoShipments');
    }
  });

  await it('the split that DOES call ensureShipments is still excluded, on the old form', () => {
    const first = handlerSources('post', '/api/retail-admin/orders/:id/shipments/split')[0];
    assert.ok(/\bensureShipments\s*\(/.test(first), 'this is the wrong registration');
    assert.ok(/\.transaction\(/.test(first), 'it was converted — it must not be');
  });

  await it('PUT /integrations is still excluded — its env write must move out first', () => {
    const src = only('put', '/api/retail-admin/integrations');
    assert.ok(/\.transaction\(/.test(src), 'it was converted — the env write is still in the body');
  });

  await it('neither qingyun body awaits — a remote call there stalls every writer', () => {
    // The serialiser in lib/db-transaction queues outermost transactions per
    // handle. An await on Qingyun inside one of these blocks would hold the
    // shared handle open for the length of a network round trip.
    for (const p of ['/api/retail-admin/orders/:id/qingyun/confirm-point',
      '/api/retail-admin/orders/:id/qingyun/reschedule']) {
      const src = only('post', p);
      const at = src.indexOf('withTransaction(');
      assert.notStrictEqual(at, -1, `${p} is not converted`);
      let i = src.indexOf('{', src.indexOf('=>', at)), depth = 0, end = i;
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      const body = src.slice(src.indexOf('{', src.indexOf('=>', at)), end + 1);
      assert.ok(!/\bawait\b/.test(body), `${p}: its transaction body awaits`);
      assert.ok(!/\b(fetch|axios|qingyun(Api|Client))\b/.test(body), `${p}: a remote call is inside the block`);
    }
  });

  await it('all nine are async handlers whose transaction bodies never await', () => {
    const NINE = [
      ['put', '/api/retail-admin/category-tree'],
      ['post', '/api/retail/addresses'],
      ['put', '/api/retail/addresses/:id'],
      ['put', '/api/retail-admin/products/:id/variants'],
      ['post', '/api/retail-admin/orders/:id/shipment-suggestion/apply'],
      ['post', '/api/retail-admin/orders/:id/shipments/combine'],
      ['post', '/api/retail-admin/orders/:id/qingyun/confirm-point'],
      ['post', '/api/retail-admin/orders/:id/qingyun/reschedule'],
    ];
    const sources = NINE.map(([m, p]) => [`${m} ${p}`, only(m, p)]);
    sources.push(['post /shipments/split (to-follow)',
      handlerSources('post', '/api/retail-admin/orders/:id/shipments/split')[1]]);
    for (const [label, src] of sources) {
      assert.ok(/async\s*\(req, res\)/.test(src), `${label} is not an async handler`);
      assert.ok(/await withTransaction\(/.test(src), `${label} does not await withTransaction`);
      assert.ok(!/\.transaction\(/.test(src), `${label} still has an old-form transaction`);
    }
    assert.strictEqual(sources.length, 9);
  });

  console.log('');
  console.log(`  driver: ${driver}${REAL_OLD ? '' : '  (old form = manual BEGIN/COMMIT reference — this driver has no .transaction())'}`);
  if (SABOTAGE) {
    console.log(`  sabotage: ${fail} of the 9 per-conversion headline assertions failed`);
    console.log('  (fewer than 9 means a conversion is NOT covered by a red-provable check)');
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
