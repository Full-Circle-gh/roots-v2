#!/usr/bin/env node
/**
 * test_waste_staff_eaten.js — §455: how much of an EXPIRED loss the staff ate.
 *
 *   node scripts/test_waste_staff_eaten.js
 *
 * Ash, 2026-10-11: expired food is recorded as waste, and later the team may eat
 * some of it. The entry stays Expired; a follow-up says how many were eaten.
 * POST /waste/:id/eaten writes that follow-up and nothing else.
 *
 * Covers, against a real in-memory SQLite and the real route (only the seams
 * are stubbed, as test_waste_bulk.js does), with the follow-up table's DDL read
 * out of database.js so the CHECK under test is the one that ships:
 *   1. a figure is recorded, and the entry, its cost and the stock are untouched.
 *   2. sending it again is a correction: a new row, the latest wins, the first
 *      one is still in the history.
 *   3. 0 to qty is the range, both ends included; anything else is refused and
 *      nothing is written.
 *   4. only a live expired entry takes one — not another reason, not a voided
 *      entry, not a reversal, not a missing id.
 *   5. the list carries the figure and its history per row, and the total sums
 *      the latest figure of live entries only.
 *   6. a caller without waste:costs is not sent a cost in the response.
 *   7. the route is gated as waste:record, not waste:void.
 *   8. both screens call it.
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
  p.run(10, 'Caesar salad', '凯撒沙拉', 'A10', 12.0);
  p.run(11, 'Sourdough loaf', '酸种面包', 'A11', 17.0);
  const s = db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (1, ?, ?)');
  s.run(10, 50); s.run(11, 50);
  return db;
}
const db = makeDb();
const stock = id => db.prepare('SELECT physical_qty AS q FROM retail_store_stock WHERE store_id = 1 AND product_id = ?').get(id).q;
const notes = id => db.prepare('SELECT COUNT(*) AS n FROM waste_staff_eaten WHERE waste_id = ?').get(id).n;
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
const eaten = (id, qty) => call('POST', `${WASTE}/${id}/eaten`, { qty });
async function record(pid, qty, reason) {
  const r = await call('POST', WASTE, { location_id: 1, subject_type: 'product', store_product_id: pid, qty, reason_code: reason });
  if (r.status !== 200) throw new Error('could not record: ' + JSON.stringify(r.body));
  return r.body.data.id;
}

(async () => {
  const salads = await record(10, 10, 'expired');
  const loaves = await record(11, 3, 'expired');
  const dropped = await record(11, 2, 'damaged');
  const voidedOne = await record(10, 4, 'expired');

  section('1 · a figure is recorded and nothing else moves');
  {
    const before = { e: entry(salads), s: stock(10) };
    const r = await eaten(salads, 4);
    check('200', r.status, 200);
    check('the row says 4 eaten', r.body.data.eaten_by_staff_qty, 4);
    check('one line of history, by Lily', r.body.data.eaten_by_staff_history.map(h => [h.qty, h.by]), [[4, 'Lily']]);
    check('the entry is unchanged — still Expired, same qty, same cost', entry(salads), before.e);
    check('stock is unchanged', stock(10), before.s);
    check('the reason on the response is still expired', r.body.data.reason_code, 'expired');
  }

  section('2 · sending it again is a correction, and the first one stays');
  {
    who = { id: 2, username: 'ash', display_name: 'Ash' };
    const r = await eaten(salads, 5);
    check('200', r.status, 200);
    check('the latest wins', r.body.data.eaten_by_staff_qty, 5);
    check('both lines are in the history, oldest first',
      r.body.data.eaten_by_staff_history.map(h => [h.qty, h.by]), [[4, 'Lily'], [5, 'Ash']]);
    check('two rows, nothing overwritten', notes(salads), 2);
    who = { id: 1, username: 'lily', display_name: 'Lily' };
  }

  section('3 · 0 to qty, both ends included');
  {
    const n = notes(loaves);
    for (const bad of [-1, 4, '', 'abc', null]) {
      const r = await eaten(loaves, bad);
      check(`${JSON.stringify(bad)} is refused`, [r.status, r.body.error, r.body.max], [400, 'qty_out_of_range', 3]);
    }
    check('nothing was written by a refusal', notes(loaves), n);
    check('3 of 3 is fine', (await eaten(loaves, 3)).status, 200);
    const zero = await eaten(loaves, 0);
    check('0 is fine — it takes a figure back', [zero.status, zero.body.data.eaten_by_staff_qty], [200, 0]);
    check('half a unit is fine (half a loaf)', (await eaten(loaves, 1.5)).status, 200);
  }

  section('4 · only a live expired entry');
  {
    const d = await eaten(dropped, 1);
    check('damaged is refused', [d.status, d.body.error], [400, 'not_expired']);
    await eaten(voidedOne, 2);
    const v = await call('POST', `${WASTE}/${voidedOne}/void`, {});
    check('void went through', v.status, 200);
    const afterVoid = await eaten(voidedOne, 1);
    check('a voided entry is refused', [afterVoid.status, afterVoid.body.error], [409, 'not_a_live_entry']);
    const rev = await eaten(v.body.data.reversal.id, 1);
    check('a reversal is refused', [rev.status, rev.body.error], [409, 'not_a_live_entry']);
    const none = await eaten(9999, 1);
    check('a missing id is 404', none.status, 404);
  }

  section('5 · the list carries it, and the total counts live entries only');
  {
    const r = await call('GET', `${WASTE}?include_voided=1`);
    check('200', r.status, 200);
    const byId = Object.fromEntries(r.body.data.map(x => [x.id, x]));
    check('salads: 5, two lines of history', [byId[salads].eaten_by_staff_qty, byId[salads].eaten_by_staff_history.length], [5, 2]);
    check('loaves: the latest, 1.5', byId[loaves].eaten_by_staff_qty, 1.5);
    check('damaged: nothing said', [byId[dropped].eaten_by_staff_qty, byId[dropped].eaten_by_staff_history], [null, []]);
    check('the voided entry still shows what was said', byId[voidedOne].eaten_by_staff_qty, 2);
    check('no raw JSON column leaks', 'eaten_history_json' in byId[salads], false);
    // 5 (salads) + 1.5 (loaves); the voided entry's 2 is not a live loss.
    check('total eaten = 6.5', r.body.totals.eaten_by_staff_qty, 6.5);
    const onlyDamaged = await call('GET', `${WASTE}?reason=damaged`);
    check('a filter with nothing eaten totals 0', onlyDamaged.body.totals.eaten_by_staff_qty, 0);
  }

  section('6 · no cost to a caller without waste:costs');
  {
    caps = new Set(['waste:view', 'waste:record']);
    const r = await eaten(salads, 5);
    check('200 and costs_hidden', [r.status, r.body.costs_hidden], [200, true]);
    check('no cost on the row', 'cost_total_cents' in r.body.data || 'is_uncosted' in r.body.data, false);
    caps = new Set(['waste:view', 'waste:costs', 'waste:record', 'waste:void']);
  }

  section('7 · gated as waste:record');
  {
    const { requiredCapFor } = require(path.join(ROOT, 'lib', 'cap-routes'));
    check('POST /waste/5/eaten needs waste:record', requiredCapFor('POST', '/api/retail-admin/waste/5/eaten'), 'waste:record');
    check('void is still waste:void', requiredCapFor('POST', '/api/retail-admin/waste/5/void'), 'waste:void');
  }

  section('8 · both screens call it');
  {
    const desk = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '20-waste.js'), 'utf8');
    const phone = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
    check('desktop posts /eaten', /\/api\/retail-admin\/waste\/' \+ id \+ '\/eaten'/.test(desk), true);
    check('phone posts /eaten', /apiWrite\('\/waste\/'\+r\.id\+'\/eaten'/.test(phone), true);
    check('desktop offers it on expired only', /function eatenCell[\s\S]{0,200}reason_code !== 'expired'/.test(desk), true);
    check('phone offers it on expired only', /function wstEatenBtn[\s\S]{0,120}reason_code!=='expired'/.test(phone), true);
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
