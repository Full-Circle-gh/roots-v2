#!/usr/bin/env node
/**
 * test_waste_used_for_making.js — §461: stock taken to make something on the
 * spot is recorded on the waste screen, and is NOT counted as waste.
 *
 *   node scripts/test_waste_used_for_making.js
 *
 * Ash, 2026-10-12: to make a cashew chocolate milk when the bar's cashew butter
 * has run out, staff take a jar from the stock fridge. It is not waste, but it
 * has to be recorded. Reason code `used_for_making`, marked `not_loss`.
 *
 * Covers, against a real in-memory SQLite and the real route (only the seams
 * are stubbed, as test_waste_staff_eaten.js does):
 *   1. the reason is served, marked not_loss, and is the only one marked so.
 *   2. recording one moves stock and keeps the full cost, like any entry.
 *   3. the loss totals leave it out; its own totals carry it.
 *   4. filtered to it alone, the loss totals are zero and its own are not.
 *   5. a void takes it out of its own totals and returns the stock.
 *   6. the list write takes it too.
 *   7. a caller without waste:costs gets its count and units, never its money.
 *   8. it is not a reason a salad's kept dressing is left out under (§281).
 *   9. both screens read not_loss from the server and keep it out of the loss.
 *
 * Exit 0 = every case behaved. Exit 1 = at least one did not.
 */
'use strict';

const fs = require('fs');
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

const ROOT = path.join(__dirname, '..');

// The follow-up table exactly as database.js creates it.
function eatenDdl() {
  const src = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
  const m = src.match(/CREATE TABLE IF NOT EXISTS waste_staff_eaten \([\s\S]*?\n {2}\);/);
  if (!m) throw new Error('waste_staff_eaten DDL not found in database.js');
  return m[0];
}

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
    CREATE TABLE retail_stores (id INTEGER PRIMARY KEY, code TEXT, name_en TEXT, name_cn TEXT, timezone TEXT);
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
  db.exec(eatenDdl());
  db.prepare('INSERT INTO retail_stores (id, code, name_en, name_cn, timezone) VALUES (1, ?, ?, ?, ?)')
    .run('tianhe', 'Tianhe', '天河店', 'Asia/Shanghai');
  const p = db.prepare('INSERT INTO store_products (id, name_en, name_cn, sku, unit_cost) VALUES (?,?,?,?,?)');
  p.run(10, 'Cashew butter', '腰果酱', 'A10', 12.0);
  p.run(11, 'Sourdough loaf', '酸种面包', 'A11', 17.0);
  const s = db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (1, ?, ?)');
  s.run(10, 50); s.run(11, 50);
  return db;
}
const db = makeDb();
const stock = id => db.prepare('SELECT physical_qty AS q FROM retail_store_stock WHERE store_id = 1 AND product_id = ?').get(id).q;
const entry = id => db.prepare('SELECT qty, reason_code, cost_total_cents, voided_by_waste_id FROM waste_records WHERE id = ?').get(id);

// ── Seams, stubbed before the route loads ────────────────────────────────────
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
stub('lib/business-date', { businessDateForLocation: () => '2026-10-11' });
stub('middleware/auth', { logActivity: () => {} });
stub('routes/retail', { requireRetailAdmin: (req, res, next) => next() });
stub('lib/recipe-rollup', { fireRecompute: () => ({ ok: true }) });

const express = require('express');
let caps = new Set(['waste:view', 'waste:costs', 'waste:record', 'waste:void']);
let who = { id: 1, username: 'lily', display_name: 'Lily' };
const app = express();
app.use((req, res, next) => { req.caps = caps; req.user = who; next(); });
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
const WASTE = '/api/retail-admin/waste';
async function record(pid, qty, reason, note) {
  const r = await call('POST', WASTE, { location_id: 1, subject_type: 'product', store_product_id: pid, qty, reason_code: reason, note });
  if (r.status !== 200) throw new Error('could not record: ' + JSON.stringify(r.body));
  return r.body.data.id;
}

(async () => {
  section('1 · the reason is served and marked not a loss');
  {
    const r = await call('GET', `${WASTE}/reasons`);
    const u = (r.body.data || []).find(x => x.code === 'used_for_making');
    check('served', !!u, true);
    check('labels', u && [u.en, u.cn], ['Used for making', '制作取用']);
    check('marked not_loss', u && u.not_loss, true);
    check('it is the only one marked so',
      (r.body.data || []).filter(x => x.not_loss).map(x => x.code), ['used_for_making']);
  }

  const dropped = await record(11, 2, 'damaged');
  let jar;
  section('2 · recording one moves stock and keeps the full cost');
  {
    const before = stock(10);
    jar = await record(10, 1, 'used_for_making', 'cashew chocolate milk');
    const e = entry(jar);
    check('stock went down by one', stock(10), before - 1);
    check('reason kept', e.reason_code, 'used_for_making');
    check('full cost, ¥12.00', e.cost_total_cents, 1200);
    check('the note is kept', db.prepare('SELECT note FROM waste_records WHERE id = ?').get(jar).note, 'cashew chocolate milk');
    check('no note is fine', (await call('POST', WASTE, { location_id: 1, subject_type: 'product',
      store_product_id: 10, qty: 2, reason_code: 'used_for_making' })).status, 200);
  }

  section('3 · the loss totals leave it out');
  {
    const r = await call('GET', WASTE);
    const t = r.body.totals;
    // Loss: the two damaged loaves, 2 × ¥17. Used: 1 + 2 jars × ¥12.
    check('loss total is the damaged loaves only', [t.cost_total_cents, t.qty_total, t.entries], [3400, 2, 1]);
    check('used for making: ¥36, 3 jars, 2 entries',
      [t.used_for_making_cents, t.used_for_making_qty, t.used_for_making_entries, t.used_for_making_uncosted], [3600, 3, 2, 0]);
    check('both rows are still listed', r.body.data.filter(x => x.reason_code === 'used_for_making').length, 2);
  }

  section('4 · filtered to it alone');
  {
    const t = (await call('GET', `${WASTE}?reason=used_for_making`)).body.totals;
    check('no loss in that filter', [t.cost_total_cents, t.entries], [0, 0]);
    check('its own figure is there', t.used_for_making_cents, 3600);
    const d = (await call('GET', `${WASTE}?reason=damaged`)).body.totals;
    check('a loss filter has no used-for-making', [d.used_for_making_cents, d.used_for_making_entries], [0, 0]);
  }

  section('5 · a void takes it out and returns the stock');
  {
    const before = stock(10);
    const v = await call('POST', `${WASTE}/${jar}/void`, {});
    check('void went through', v.status, 200);
    check('the jar is back', stock(10), before + 1);
    const t = (await call('GET', WASTE)).body.totals;
    check('used for making drops to ¥24, 1 entry', [t.used_for_making_cents, t.used_for_making_entries], [2400, 1]);
    check('the loss total did not move', t.cost_total_cents, 3400);
  }

  section('6 · the list write takes it');
  {
    const before = stock(10);
    const r = await call('POST', `${WASTE}/bulk`, { location_id: 1, items: [
      { store_product_id: 10, qty: 1, reason_code: 'used_for_making', note: 'cashew chocolate milk' },
      { store_product_id: 11, qty: 1, reason_code: 'expired' },
    ] });
    check('200', r.status, 200);
    check('stock went down', stock(10), before - 1);
    const t = (await call('GET', WASTE)).body.totals;
    check('loss +¥17, used +¥12', [t.cost_total_cents, t.used_for_making_cents], [5100, 3600]);
  }

  section('7 · no money to a caller without waste:costs');
  {
    caps = new Set(['waste:view', 'waste:record']);
    const t = (await call('GET', WASTE)).body.totals;
    check('no cents, no uncosted count', ['used_for_making_cents' in t, 'used_for_making_uncosted' in t], [false, false]);
    check('the count and the units are still there', [t.used_for_making_entries, t.used_for_making_qty], [2, 3]);
    caps = new Set(['waste:view', 'waste:costs', 'waste:record', 'waste:void']);
  }

  section('8 · not a reason a kept line is left out under');
  {
    const { KEPT_LINE_REASONS } = require(path.join(ROOT, 'lib', 'waste-record'));
    check('used_for_making charges the whole product', KEPT_LINE_REASONS.has('used_for_making'), false);
  }

  section('9 · both screens read not_loss from the server');
  {
    const desk = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '20-waste.js'), 'utf8');
    const phone = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
    check('desktop reads not_loss', /r\.not_loss/.test(desk), true);
    check('phone reads not_loss', /x\.not_loss/.test(phone), true);
    check('neither names the code', [/used_for_making'/.test(desk), /used_for_making'/.test(phone)], [false, false]);
    check('desktop shows its own figure', /used_for_making_cents/.test(desk), true);
    check('phone shows its own figure', /used_for_making_cents/.test(phone), true);
  }

  void dropped;
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
