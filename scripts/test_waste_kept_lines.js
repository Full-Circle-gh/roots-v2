#!/usr/bin/env node
/**
 * test_waste_kept_lines.js — §281: a salad that expired or spoiled is written
 * off WITHOUT the dressing the shop kept.
 *
 * Reported by Ash, 2026-09-27, from the live waste screen: Beet Salad and
 * Tabbouleh Bowl written off as Expired carried their dressing's cost, though
 * the dressing is packed on its own and goes back on the shelf. Ash's rule: a
 * build-list line ticked "packed separately" is left out of an EXPIRED or
 * SPOILED write-off, and counted in full for every other reason.
 *
 * Covers, against a real in-memory SQLite and the real route files:
 *   1. wasteUnitCostYuan() — expired and spoiled subtract the ticked line;
 *      damaged, staff, sampling, other and "no reason yet" charge in full.
 *   2. the cases that must fall through to today's figure untouched: no tick,
 *      no build list, a blocked list, a bundle.
 *   3. every line with a cost ticked is UNCOSTED, not a ¥0 loss (§32 rule 10).
 *   4. the product's own cost is unchanged by the tick — sales and margin still
 *      count the dressing, because every salad sold goes out with it.
 *   5. recordProductWaste() stores the reduced figure.
 *   6. GET /waste/preview reads the reason and names what it left out, so the
 *      figure shown before Record equals the figure stored.
 *   7. the build-list save writes the flag and the read returns it; a client
 *      that does not send it writes 0.
 *
 * Numbers are the live Beet Salad build list, 2026-09-27
 * (scripts/diagnose_dressing_waste.js): salad 310 g, box, sticker, label,
 * dressing 50 g.
 *
 * Exit 0 = every case behaved. Exit 1 = at least one did not.
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

let failures = 0;
function check(label, actual, expected) {
  const ok = typeof expected === 'number' && typeof actual === 'number'
    ? Math.abs(actual - expected) < 1e-9
    : JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { console.log('\n── ' + t); }

// ── The fixture ────────────────────────────────────────────────────────────
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
  // Materials — per-unit costs chosen so each line equals the live figure.
  const mat = db.prepare('INSERT INTO ingredients (id,name_en,name_cn,unit,cost_per_unit,item_kind) VALUES (?,?,?,?,?,?)');
  mat.run(1, 'Beet Salad', '甜菜沙拉', 'g', 5.2734 / 310, 'food');
  mat.run(2, 'Carton Food Container - Circle', null, 'pcs', 0.4318, 'packaging');
  mat.run(3, 'ROOTS Salad Stickers', null, 'pcs', 0.0825, 'packaging');
  mat.run(4, 'Label Paper', null, 'pcs', 0.0093, 'packaging');
  mat.run(5, 'Beet salad dressing', '甜菜沙拉酱', 'g', 3.1143 / 50, 'food');
  mat.run(6, 'Unpriced thing', null, 'g', 0, 'food');
  return db;
}
function addLine(db, productId, ingredientId, qty, unit, kept, sort) {
  const i = db.prepare('SELECT name_en, name_cn FROM ingredients WHERE id = ?').get(ingredientId);
  db.prepare(`INSERT INTO product_build_lines
      (product_id, ingredient_id, name_en, name_cn, qty, unit, sort_order, packed_separately)
      VALUES (?,?,?,?,?,?,?,?)`).run(productId, ingredientId, i.name_en, i.name_cn, qty, unit, sort, kept ? 1 : 0);
}
const FULL = 5.2734 + 0.4318 + 0.0825 + 0.0093 + 3.1143;   // 8.9113
const KEPT = 3.1143;
function beetSalad(db, id, { tickDressing = true } = {}) {
  db.prepare('INSERT INTO store_products (id, name_en, unit_cost) VALUES (?,?,?)').run(id, 'Beet Salad', FULL);
  addLine(db, id, 1, 310, 'g', false, 0);
  addLine(db, id, 2, 1, 'pcs', false, 1);
  addLine(db, id, 3, 1, 'pcs', false, 2);
  addLine(db, id, 4, 1, 'pcs', false, 3);
  addLine(db, id, 5, 50, 'g', tickDressing, 4);
}

// ── Seams. Stubbed BEFORE the modules under test load, because they resolve
//    these at require time. Only seams; the cost code is all real. ──────────
let db = makeDb();
const ROOT = path.join(__dirname, '..');
function stub(rel, value) {
  const abs = require.resolve(path.join(ROOT, rel));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: value };
}
const adjustCalls = [];
stub('lib/inventory', { adjustStock: (a) => { adjustCalls.push(a); return {}; } });
stub('lib/tenant-db', { tdb: () => db, rawTenantDb: () => db });
stub('lib/business-date', { businessDateForLocation: () => '2026-09-27' });
stub('middleware/auth', { logActivity: () => {} });
stub('routes/retail', { requireRetailAdmin: (req, res, next) => next() });
stub('lib/recipe-rollup', { fireRecompute: () => ({ ok: true }) });

const { wasteUnitCostYuan, recordProductWaste, KEPT_LINE_REASONS } = require(path.join(ROOT, 'lib', 'waste-record'));
const { computeProductBuildCost } = require(path.join(ROOT, 'lib', 'product-build-cost'));

const express = require('express');
const app = express();
app.use((req, res, next) => {
  req.caps = new Set(['waste:view', 'waste:costs', 'waste:record']);
  req.user = { id: 1, username: 'ash', display_name: 'Ash' };
  next();
});
app.use(require(path.join(ROOT, 'routes', 'retail-waste')));
app.use(require(path.join(ROOT, 'routes', 'retail-product-build')));

function call(method, url, body) {
  return new Promise((resolve) => {
    const req = Object.assign(require('stream').Readable.from([]), {
      method, url, originalUrl: url,
      // A JSON content-type with the body already attached, so express.json()
      // on the build-list PUT sees a parsed body and does not wait on a stream.
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

(async () => {
  section('1 · the reason decides');
  beetSalad(db, 10);
  check('the kept reasons are exactly expired and spoiled',
    [...KEPT_LINE_REASONS].sort(), ['expired', 'spoiled']);
  check('expired leaves the dressing out', wasteUnitCostYuan(db, 10, 'expired').unitYuan, FULL - KEPT);
  check('spoiled leaves the dressing out', wasteUnitCostYuan(db, 10, 'spoiled').unitYuan, FULL - KEPT);
  for (const r of ['damaged', 'preparation_error', 'staff_consumption', 'sampling', 'other', '']) {
    check(`"${r || 'no reason yet'}" charges in full`, wasteUnitCostYuan(db, 10, r).unitYuan, FULL);
  }
  check('it names what it left out', wasteUnitCostYuan(db, 10, 'expired').kept.map(k => k.name_en), ['Beet salad dressing']);
  check('and names nothing when nothing was left out', wasteUnitCostYuan(db, 10, 'damaged').kept, []);

  section('2 · what falls through to today\'s figure');
  beetSalad(db, 11, { tickDressing: false });
  check('no tick: expired charges in full', wasteUnitCostYuan(db, 11, 'expired').unitYuan, FULL);
  db.prepare('INSERT INTO store_products (id, name_en, unit_cost) VALUES (12, ?, 12.5)').run('Typed cost, no list');
  check('no build list: the typed cost', wasteUnitCostYuan(db, 12, 'expired').unitYuan, 12.5);
  // A blocked list: one unpriced line. Its stored cost is already null (the
  // rollup clears it), so the answer is uncosted either way — never a partial.
  db.prepare('INSERT INTO store_products (id, name_en, unit_cost) VALUES (13, ?, NULL)').run('Blocked');
  addLine(db, 13, 1, 100, 'g', false, 0);
  addLine(db, 13, 6, 10, 'g', false, 1);
  addLine(db, 13, 5, 50, 'g', true, 2);
  check('a blocked list: uncosted, not a partial sum', wasteUnitCostYuan(db, 13, 'expired').unitYuan, null);
  // A bundle is costed from its components, never from a build list.
  db.prepare('INSERT INTO store_products (id, name_en, unit_cost) VALUES (14, ?, 4)').run('Component');
  db.prepare("INSERT INTO store_products (id, name_en, unit_cost, bundle_items) VALUES (15, ?, NULL, ?)")
    .run('Bundle', JSON.stringify([{ product_id: 14, qty: 2 }]));
  addLine(db, 15, 5, 50, 'g', true, 0);
  const bundleFull = require(path.join(ROOT, 'lib', 'product-cost')).productUnitCostYuan(db, 15);
  check('(the bundle really is derived: 2 × ¥4)', bundleFull, 8);
  check('a bundle: its own derived cost, untouched by a stray tick',
    wasteUnitCostYuan(db, 15, 'expired').unitYuan, bundleFull);

  section('3 · everything kept is uncosted, not free');
  db.prepare('INSERT INTO store_products (id, name_en, unit_cost) VALUES (16, ?, 3.1143)').run('Dressing only');
  addLine(db, 16, 5, 50, 'g', true, 0);
  check('every costed line ticked: null, never ¥0', wasteUnitCostYuan(db, 16, 'expired').unitYuan, null);

  section('4 · the product\'s own cost does not move');
  check('build cost still counts the dressing', computeProductBuildCost(10, db).unitCost, FULL);
  check('and the line says it is packed separately', computeProductBuildCost(10, db).lines[4].packedSeparately, true);
  check('the others say they are not', computeProductBuildCost(10, db).lines[0].packedSeparately, false);

  section('5 · the stored write-off');
  db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (1, 10, 5)').run();
  const idExp = db.transaction(() => recordProductWaste({
    db, locationId: 1, productId: 10, qty: 2, unit: null, reason: 'expired', note: null,
    actor: { id: 1, label: 'Ash' }, businessDate: '2026-09-27',
  }))();
  const idDmg = db.transaction(() => recordProductWaste({
    db, locationId: 1, productId: 10, qty: 1, unit: null, reason: 'damaged', note: null,
    actor: { id: 1, label: 'Ash' }, businessDate: '2026-09-27',
  }))();
  const row = id => db.prepare('SELECT cost_total_cents, is_uncosted FROM waste_records WHERE id = ?').get(id);
  check('2 × expired Beet Salad stores ¥11.41, not ¥17.82',
    row(idExp).cost_total_cents, Math.round((FULL - KEPT) * 2 * 100));
  check('1 × damaged stores the full ¥8.91', row(idDmg).cost_total_cents, Math.round(FULL * 100));
  check('stock moves the whole product either way', adjustCalls.map(a => a.deltaQty), [-2, -1]);

  section('6 · the preview agrees with the write');
  {
    const exp = await call('GET', '/api/retail-admin/waste/preview?store_product_id=10&qty=2&reason_code=expired');
    check('expired preview = the stored figure', exp.body.data.cost_total_cents, row(idExp).cost_total_cents);
    check('and names the kept line', exp.body.data.kept_lines, [{ name_en: 'Beet salad dressing', name_cn: '甜菜沙拉酱' }]);
    const dmg = await call('GET', '/api/retail-admin/waste/preview?store_product_id=10&qty=1&reason_code=damaged');
    check('damaged preview = the stored figure', dmg.body.data.cost_total_cents, row(idDmg).cost_total_cents);
    check('and names nothing', dmg.body.data.kept_lines, []);
    const none = await call('GET', '/api/retail-admin/waste/preview?store_product_id=10&qty=1');
    check('no reason sent: the full cost, as before', none.body.data.cost_total_cents, Math.round(FULL * 100));
  }

  section('7 · the build-list screen saves and reads the tick');
  {
    const got = await call('GET', '/api/retail-admin/products/10/build-lines');
    check('the read returns the flag', got.body.data.lines.map(l => l.packed_separately), [0, 0, 0, 0, 1]);
    const lines = got.body.data.lines.map(l => ({
      ingredient_id: l.ingredient_id, name_en: l.name_en, name_cn: l.name_cn, sku: l.sku,
      qty: l.qty, unit: l.unit, notes: l.notes, packed_separately: !!l.packed_separately,
    }));
    // Untick the dressing, tick the salad itself.
    lines[4].packed_separately = false;
    lines[0].packed_separately = true;
    const put = await call('PUT', '/api/retail-admin/products/10/build-lines', { lines });
    check('the save succeeds', put.body.success, true);
    const after = db.prepare('SELECT packed_separately FROM product_build_lines WHERE product_id = 10 ORDER BY sort_order').all();
    check('the save writes what was sent', after.map(r => r.packed_separately), [1, 0, 0, 0, 0]);
    // A client that predates the flag sends lines without it.
    const old = lines.map(l => { const o = { ...l }; delete o.packed_separately; return o; });
    await call('PUT', '/api/retail-admin/products/10/build-lines', { lines: old });
    const after2 = db.prepare('SELECT packed_separately FROM product_build_lines WHERE product_id = 10').all();
    check('a line sent without the flag is written as 0', after2.every(r => r.packed_separately === 0), true);
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
