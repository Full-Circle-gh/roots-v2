#!/usr/bin/env node
/**
 * test_waste_bulk.js — §423: a LIST of losses recorded in one go.
 *
 *   node scripts/test_waste_bulk.js
 *
 * Staff asked for it, 2026-10-03: recording a clean-out one product at a time
 * "takes too much time and it's not efficient". POST /waste/bulk takes the
 * whole list. The rule that makes it safe to use is ALL OR NOTHING — a list
 * where the good lines save and the bad ones are skipped leaves staff believing
 * the whole clean-out is in while stock quietly disagrees with their paper.
 *
 * Covers, against a real in-memory SQLite and the real route and cost code
 * (only the seams are stubbed, as test_waste_kept_lines.js does):
 *   1. a good list writes every line, each with ITS OWN reason and note, and
 *      takes every line's quantity off the shelf.
 *   2. one line the shelf cannot cover: 409 naming the line, and NOTHING
 *      written — no rows, no stock moved, not even for the lines before it.
 *   3. the same product on two lines (two reasons) is checked TOGETHER: each is
 *      fine alone, the pair is not, and the second line is the one refused.
 *   4. every refusal names its line, and is made before anything is written.
 *   5. a caller without waste:costs is never sent a cost.
 *   6. the single write, whose checks moved into a shared helper, still refuses
 *      exactly what it refused before.
 *
 * Exit 0 = every case behaved. Exit 1 = at least one did not.
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { console.log('\n── ' + t); }

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE store_products (
      id INTEGER PRIMARY KEY, name_en TEXT, name_cn TEXT, sku TEXT, weight TEXT,
      unit_cost REAL, bundle_items TEXT, recipe_id INTEGER);
    CREATE TABLE ingredients (
      id INTEGER PRIMARY KEY, name_en TEXT, name_cn TEXT, sku TEXT, unit TEXT DEFAULT 'g',
      cost_per_unit REAL DEFAULT 0, buy_price REAL, free_by_design INTEGER DEFAULT 0,
      overhead_per_unit REAL DEFAULT 0, item_kind TEXT DEFAULT 'food', is_active INTEGER DEFAULT 1,
      source_recipe_id INTEGER);
    CREATE TABLE product_build_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, ingredient_id INTEGER,
      name_en TEXT NOT NULL, name_cn TEXT, sku TEXT, qty REAL NOT NULL, unit TEXT DEFAULT 'g',
      notes TEXT, sort_order INTEGER DEFAULT 0,
      packed_separately INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE retail_stores (id INTEGER PRIMARY KEY, timezone TEXT);
    CREATE TABLE retail_store_stock (store_id INTEGER, product_id INTEGER, physical_qty INTEGER);
    CREATE TABLE retail_stock_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, store_id INTEGER,
      product_id INTEGER, reason TEXT, ref_table TEXT, ref_id INTEGER);
    CREATE TABLE waste_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, location_id INTEGER, subject_type TEXT,
      store_product_id INTEGER, material_id INTEGER, qty REAL, unit TEXT, reason_code TEXT,
      note TEXT, cost_total_cents INTEGER, is_uncosted INTEGER, business_date TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, created_by INTEGER, created_by_label TEXT,
      reverses_waste_id INTEGER, voided_at TEXT, voided_by INTEGER, voided_by_label TEXT,
      voided_by_waste_id INTEGER);
  `);
  db.prepare('INSERT INTO retail_stores (id, timezone) VALUES (1, ?)').run('Asia/Shanghai');
  // Three products: 10 and 11 are costed, 12 has no cost on file.
  const p = db.prepare('INSERT INTO store_products (id, name_en, name_cn, sku, unit_cost) VALUES (?,?,?,?,?)');
  p.run(10, 'Oat milk 1L', '燕麦奶', 'A10', 4.0);
  p.run(11, 'Sourdough loaf', '酸种面包', 'A11', 17.0);
  p.run(12, 'Mixed nuts 250g', '混合坚果', 'A12', null);
  return db;
}
function stock(db, id) {
  return db.prepare('SELECT physical_qty AS q FROM retail_store_stock WHERE store_id = 1 AND product_id = ?').get(id).q;
}
function reset() {
  db.exec('DELETE FROM waste_records; DELETE FROM retail_stock_ledger; DELETE FROM retail_store_stock;');
  const s = db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (1, ?, ?)');
  s.run(10, 10); s.run(11, 6); s.run(12, 3);
}
const count = () => db.prepare('SELECT COUNT(*) AS n FROM waste_records').get().n;

// ── Seams, stubbed before the modules under test load. adjustStock here REALLY
//    moves the stock row (and so is rolled back with the transaction), which is
//    what lets the all-or-nothing and the pairing cases mean something. ───────
let db = makeDb();
const ROOT = path.join(__dirname, '..');
function stub(rel, value) {
  const abs = require.resolve(path.join(ROOT, rel));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: value };
}
stub('lib/inventory', {
  adjustStock: (a) => {
    db.prepare('UPDATE retail_store_stock SET physical_qty = physical_qty + ? WHERE store_id = ? AND product_id = ?')
      .run(a.deltaQty, a.storeId, a.productId);
    db.prepare("INSERT INTO retail_stock_ledger (store_id, product_id, reason) VALUES (?, ?, 'waste')").run(a.storeId, a.productId);
    return {};
  },
});
stub('lib/tenant-db', { tdb: () => db, rawTenantDb: () => db });
stub('lib/business-date', { businessDateForLocation: () => '2026-10-03' });
stub('middleware/auth', { logActivity: () => {} });
stub('routes/retail', { requireRetailAdmin: (req, res, next) => next() });
stub('lib/recipe-rollup', { fireRecompute: () => ({ ok: true }) });

const express = require('express');
let caps = new Set(['waste:view', 'waste:costs', 'waste:record']);
const app = express();
app.use((req, res, next) => {
  req.caps = caps;
  req.user = { id: 1, username: 'ash', display_name: 'Ash' };
  next();
});
app.use(require(path.join(ROOT, 'routes', 'retail-waste')));

function call(method, url, body) {
  return new Promise((resolve) => {
    const req = Object.assign(require('stream').Readable.from([]), {
      method, url, originalUrl: url,
      headers: body ? { 'content-type': 'application/json', 'content-length': '0' } : {},
      body: body || {}, _body: !!body, connection: {}, socket: {},
    });
    const res = {
      statusCode: 200, headersSent: false,
      setHeader() {}, getHeader() {}, removeHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
      send(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); },
    };
    app(req, res);
  });
}
const BULK = '/api/retail-admin/waste/bulk';
const line = (pid, qty, code, note) => ({ store_product_id: pid, qty, reason_code: code, note: note || null });

(async () => {
  section('1 · a good list writes every line, each with its own reason');
  {
    reset();
    const r = await call('POST', BULK, { location_id: 1, items: [
      line(10, 4, 'expired'), line(11, 2, 'expired'), line(12, 1, 'other', 'dropped on the floor'),
    ] });
    check('200', r.status, 200);
    check('three rows back', (r.body.data || []).length, 3);
    check('each line kept its own reason',
      db.prepare('SELECT reason_code FROM waste_records ORDER BY id').all().map(x => x.reason_code), ['expired', 'expired', 'other']);
    check('and the note belongs to the line that had it',
      db.prepare('SELECT note FROM waste_records ORDER BY id').all().map(x => x.note), [null, null, 'dropped on the floor']);
    check('every line came off the shelf', [stock(db, 10), stock(db, 11), stock(db, 12)], [6, 4, 2]);
    check('costed lines carry a cost', (r.body.data[0].cost_total_cents), 1600);
    check('an unpriced line is uncosted, not free', [r.body.data[2].is_uncosted, r.body.data[2].cost_total_cents], [1, null]);
  }

  section('2 · one line the shelf cannot cover: nothing is written');
  {
    reset();
    const r = await call('POST', BULK, { location_id: 1, items: [
      line(10, 4, 'expired'), line(11, 99, 'expired'), line(12, 1, 'expired'),
    ] });
    check('409', r.status, 409);
    check('insufficient_stock', r.body.error, 'insufficient_stock');
    check('it names the line (0-based)', r.body.line, 1);
    check('and the figures', [r.body.on_hand, r.body.requested], [6, 99]);
    check('no waste rows at all', count(), 0);
    check('not even the line BEFORE the bad one moved stock', [stock(db, 10), stock(db, 11), stock(db, 12)], [10, 6, 3]);
    check('no ledger movements either', db.prepare('SELECT COUNT(*) AS n FROM retail_stock_ledger').get().n, 0);
  }

  section('3 · the same product twice is checked together');
  {
    reset();
    // 6 on the shelf: 4 + 4 are each fine alone and not together.
    const r = await call('POST', BULK, { location_id: 1, items: [line(11, 4, 'expired'), line(11, 4, 'damaged')] });
    check('409 on the SECOND line', [r.status, r.body.line], [409, 1]);
    check('the second line was told what was left', [r.body.on_hand, r.body.requested], [2, 4]);
    check('nothing written', [count(), stock(db, 11)], [0, 6]);
    // and a pair that does fit goes through, under two reasons
    const ok = await call('POST', BULK, { location_id: 1, items: [line(11, 4, 'expired'), line(11, 2, 'damaged')] });
    check('a pair that fits is recorded', [ok.status, count(), stock(db, 11)], [200, 2, 0]);
  }

  section('4 · every refusal names its line and happens before any write');
  {
    reset();
    const cases = [
      ['no reason on line 2',        [line(10, 1, 'expired'), line(11, 1, '')],                      400, 'reason_invalid', 1],
      ['unknown reason',             [line(10, 1, 'bogus')],                                          400, 'reason_invalid', 0],
      ['other with no note',         [line(10, 1, 'expired'), line(11, 1, 'other')],                  400, 'note_required_for_other', 1],
      ['zero quantity',              [line(10, 0, 'expired')],                                        400, 'qty_positive_required', 0],
      ['fractional quantity',        [line(10, 1, 'expired'), line(11, 1.5, 'expired')],              400, 'qty_whole_units_required', 1],
      ['no product',                 [{ qty: 1, reason_code: 'expired' }],                            400, 'store_product_id_required', 0],
      ['a product that is not there',[line(10, 1, 'expired'), line(999, 1, 'expired')],               404, 'product_not_found', 1],
    ];
    for (const [label, items, status, code, at] of cases) {
      const r = await call('POST', BULK, { location_id: 1, items });
      check(`${label}: ${status} ${code}, line ${at}`, [r.status, r.body.error, r.body.line], [status, code, at]);
    }
    check('after all of those, nothing was written', [count(), stock(db, 10), stock(db, 11)], [0, 10, 6]);

    const none = await call('POST', BULK, { location_id: 1, items: [] });
    check('an empty list is refused', [none.status, none.body.error], [400, 'items_required']);
    const gone = await call('POST', BULK, { location_id: 1 });
    check('no list at all is refused', [gone.status, gone.body.error], [400, 'items_required']);
    const noloc = await call('POST', BULK, { items: [line(10, 1, 'expired')] });
    check('no store is refused', [noloc.status, noloc.body.error], [400, 'location_required']);
    const badloc = await call('POST', BULK, { location_id: 77, items: [line(10, 1, 'expired')] });
    check('a store that is not there is refused', [badloc.status, badloc.body.error], [404, 'location_not_found']);
    const big = await call('POST', BULK, { location_id: 1, items: Array.from({ length: 101 }, () => line(10, 1, 'expired')) });
    check('101 lines is too many', [big.status, big.body.error], [400, 'too_many_lines']);
  }

  section('5 · a caller who may not read money is never sent it');
  {
    reset();
    caps = new Set(['waste:view', 'waste:record']);
    const r = await call('POST', BULK, { location_id: 1, items: [line(10, 2, 'expired'), line(12, 1, 'expired')] });
    check('recorded', [r.status, count()], [200, 2]);
    check('the envelope says the costs are hidden', r.body.costs_hidden, true);
    check('no cost on any row',
      r.body.data.some(x => 'cost_total_cents' in x || 'is_uncosted' in x), false);
    caps = new Set(['waste:view', 'waste:costs', 'waste:record']);
  }

  section('6 · the single write still refuses what it always did');
  {
    reset();
    const SINGLE = '/api/retail-admin/waste';
    const base = { location_id: 1, subject_type: 'product', store_product_id: 10, qty: 1, reason_code: 'expired' };
    const ok = await call('POST', SINGLE, base);
    check('a good single write is recorded', [ok.status, count(), stock(db, 10)], [200, 1, 9]);
    const q0 = await call('POST', SINGLE, { ...base, qty: 0 });
    check('qty 0', [q0.status, q0.body.error], [400, 'qty_positive_required']);
    const qf = await call('POST', SINGLE, { ...base, qty: 1.5 });
    check('qty 1.5', [qf.status, qf.body.error], [400, 'qty_whole_units_required']);
    const rb = await call('POST', SINGLE, { ...base, reason_code: 'bogus' });
    check('bad reason', [rb.status, rb.body.error], [400, 'reason_invalid']);
    const on = await call('POST', SINGLE, { ...base, reason_code: 'other' });
    check('other with no note', [on.status, on.body.error], [400, 'note_required_for_other']);
    const ov = await call('POST', SINGLE, { ...base, qty: 99 });
    check('over the shelf', [ov.status, ov.body.error], [409, 'insufficient_stock']);
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
