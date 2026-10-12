#!/usr/bin/env node
/**
 * test_waste_recalculate.js — §465: an owner can re-price past waste entries
 * with today's product costs, after a product's cost was calculated wrong.
 *
 *   node scripts/test_waste_recalculate.js
 *
 * Ash, 2026-10-12, from the phone's waste list: the Beet Salad's dressing is
 * now ticked packed separately and the Tabbouleh Bowl's cost is fixed, and
 * "all waste list need to be update according to the new settings" — "the
 * cost was always right, calculation in the system of the product was wrong".
 *
 * Covers, against a real in-memory SQLite and the real route (only the seams
 * are stubbed, as test_waste_used_for_making.js does):
 *   1. GET lists only the live entries whose figure would change, old → new,
 *      and writes nothing.
 *   2. it leaves alone: an unchanged entry, a voided entry and its reversal, an
 *      entry whose product now has no cost (never turned into "no cost").
 *   3. POST writes the new figures, clears "no cost", and logs every change
 *      with its old figure in waste_cost_corrections.
 *   4. the list's total follows; a second GET finds nothing to change.
 *   5. a price that moved after the list was made: 409, nothing written.
 *   6. the filter is the list's: a reason or store outside it is not touched.
 *   7. owner only: without waste:void, or without waste:costs, 403 both ways.
 *   8. a bad body is refused.
 *   9. the capability map and the phone screen gate it on waste:void.
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

// A table exactly as database.js creates it.
function ddl(table) {
  const src = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
  const m = src.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n {2}\\);`));
  if (!m) throw new Error(`${table} DDL not found in database.js`);
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
  `);
  db.exec(ddl('waste_records'));
  db.exec(ddl('waste_staff_eaten'));
  db.exec(ddl('waste_cost_corrections'));
  const store = db.prepare('INSERT INTO retail_stores (id, code, name_en, name_cn, timezone) VALUES (?, ?, ?, ?, ?)');
  store.run(1, 'yuexiu', 'Yuexiu', '越秀店', 'Asia/Shanghai');
  store.run(2, 'tianhe', 'Tianhe', '天河店', 'Asia/Shanghai');
  // The live Beet Salad build list (test_waste_kept_lines.js): ¥8.91, of
  // which ¥3.11 is the dressing.
  const mat = db.prepare('INSERT INTO ingredients (id,name_en,name_cn,unit,cost_per_unit,item_kind) VALUES (?,?,?,?,?,?)');
  mat.run(1, 'Beet Salad', '甜菜沙拉', 'g', 5.2734 / 310, 'food');
  mat.run(2, 'Carton Food Container - Circle', null, 'pcs', 0.4318, 'packaging');
  mat.run(3, 'ROOTS Salad Stickers', null, 'pcs', 0.0825, 'packaging');
  mat.run(4, 'Label Paper', null, 'pcs', 0.0093, 'packaging');
  mat.run(5, 'Beet salad dressing', '甜菜沙拉酱', 'g', 3.1143 / 50, 'food');
  const p = db.prepare('INSERT INTO store_products (id, name_en, name_cn, sku, unit_cost) VALUES (?,?,?,?,?)');
  p.run(20, 'Beet Salad', '甜菜沙拉', 'S20', 8.9113);
  p.run(21, 'Tabbouleh Bowl', '塔布勒沙拉碗', 'S21', 10.64);
  p.run(22, 'Green Glow Juice', '绿光果汁', 'J22', null);
  p.run(23, 'Celerybration Juice', '芹菜汁', 'J23', 5);
  p.run(24, 'Mystery Jar', null, 'X24', 4);
  const line = db.prepare(`INSERT INTO product_build_lines
      (product_id, ingredient_id, name_en, qty, unit, sort_order, packed_separately) VALUES (20,?,?,?,?,?,0)`);
  line.run(1, 'Beet Salad', 310, 'g', 0);
  line.run(2, 'Container', 1, 'pcs', 1);
  line.run(3, 'Sticker', 1, 'pcs', 2);
  line.run(4, 'Label', 1, 'pcs', 3);
  line.run(5, 'Dressing', 50, 'g', 4);
  const s = db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?, ?, 50)');
  for (const store of [1, 2]) for (const id of [20, 21, 22, 23, 24]) s.run(store, id);
  return db;
}
const db = makeDb();
const cost = id => db.prepare('SELECT cost_total_cents AS c, is_uncosted AS u FROM waste_records WHERE id = ?').get(id);

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
const activity = [];
stub('middleware/auth', { logActivity: (...a) => activity.push(a) });
stub('routes/retail', { requireRetailAdmin: (req, res, next) => next() });
stub('lib/recipe-rollup', { fireRecompute: () => ({ ok: true }) });

const express = require('express');
const OWNER = ['waste:view', 'waste:costs', 'waste:record', 'waste:void'];
let caps = new Set(OWNER);
const app = express();
app.use((req, res, next) => { req.caps = caps; req.user = { id: 1, username: 'ash', display_name: 'Ash' }; next(); });
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
const RECALC = `${WASTE}/recalculate`;
async function record(pid, qty, reason, store = 1) {
  const r = await call('POST', WASTE, { location_id: store, subject_type: 'product', store_product_id: pid, qty, reason_code: reason });
  if (r.status !== 200) throw new Error('could not record: ' + JSON.stringify(r.body));
  return r.body.data.id;
}
const sendBack = list => ({ changes: list.map(c => ({ id: c.id, from_cents: c.from_cents, to_cents: c.to_cents })) });

(async () => {
  // Written while the product costs were wrong.
  const beet1 = await record(20, 1, 'expired');       // ¥8.91, dressing in
  const beet2 = await record(20, 2, 'expired');       // ¥17.82
  const beetDamaged = await record(20, 1, 'damaged'); // ¥8.91, and right: damaged charges in full
  const tabb = await record(21, 1, 'expired');        // ¥10.64
  const juice = await record(22, 1, 'expired');       // no cost
  const voided = await record(23, 1, 'expired');      // ¥5.00, then voided
  const jar = await record(24, 1, 'expired');         // ¥4.00
  const tianhe = await record(21, 1, 'expired', 2);   // ¥10.64 at the other store
  check('the void went through', (await call('POST', `${WASTE}/${voided}/void`, {})).status, 200);
  const reversal = db.prepare('SELECT id FROM waste_records WHERE reverses_waste_id = ?').get(voided).id;
  check('starting figures', [beet1, beet2, beetDamaged, tabb, juice, voided, jar].map(id => cost(id).c),
    [891, 1782, 891, 1064, null, 500, 400]);

  // The fixes: dressing ticked, Tabbouleh corrected, the juice costed. And two
  // changes that must NOT reach an entry: the voided juice's price, and the
  // jar's cost removed.
  db.prepare('UPDATE product_build_lines SET packed_separately = 1 WHERE product_id = 20 AND ingredient_id = 5').run();
  db.prepare('UPDATE store_products SET unit_cost = 10.26 WHERE id = 21').run();
  db.prepare('UPDATE store_products SET unit_cost = 3 WHERE id = 22').run();
  db.prepare('UPDATE store_products SET unit_cost = 6 WHERE id = 23').run();
  db.prepare('UPDATE store_products SET unit_cost = 0 WHERE id = 24').run();

  const q = '?from=2026-10-01&to=2026-10-12&location_id=1';
  let list;
  section('1 · GET lists what would change, and writes nothing');
  {
    const r = await call('GET', RECALC + q);
    check('200', r.status, 200);
    list = r.body.data;
    check('the four that change, newest first',
      list.map(c => [c.id, c.from_cents, c.to_cents]),
      [[juice, null, 300], [tabb, 1064, 1026], [beet2, 1782, 1159], [beet1, 891, 580]]);
    check('names travel with them', list.map(c => c.product_name_en),
      ['Green Glow Juice', 'Tabbouleh Bowl', 'Beet Salad', 'Beet Salad']);
    check('totals: old ¥37.37 (no-cost counts 0), new ¥30.65', r.body.totals,
      { entries: 4, from_cents: 1064 + 1782 + 891, to_cents: 300 + 1026 + 1159 + 580 });
    check('nothing written', [cost(beet1).c, cost(tabb).c, cost(juice).c], [891, 1064, null]);
    check('no correction rows', db.prepare('SELECT COUNT(*) AS n FROM waste_cost_corrections').get().n, 0);
  }

  section('2 · what it leaves alone');
  {
    const ids = list.map(c => c.id);
    check('a damaged salad still charges in full, so is unchanged', ids.includes(beetDamaged), false);
    check('the voided entry and its reversal', [ids.includes(voided), ids.includes(reversal)], [false, false]);
    check('a product with no cost now: the entry keeps its figure', ids.includes(jar), false);
    check('the other store, outside the filter', ids.includes(tianhe), false);
  }

  section('3 · POST writes the new figures and logs the old ones');
  {
    const r = await call('POST', RECALC, sendBack(list));
    check('200', r.status, 200);
    check('summary', r.body.data, { entries: 4, from_cents: 3737, to_cents: 3065 });
    check('new figures stored', [beet1, beet2, tabb, juice].map(id => cost(id).c), [580, 1159, 1026, 300]);
    check('the juice is costed now', cost(juice).u, 0);
    check('untouched', [beetDamaged, voided, reversal, jar, tianhe].map(id => cost(id).c), [891, 500, 500, 400, 1064]);
    const log = db.prepare('SELECT waste_id, from_cents, to_cents, created_by_label FROM waste_cost_corrections ORDER BY waste_id').all();
    check('one correction row each, with the old figure',
      log.map(l => [l.waste_id, l.from_cents, l.to_cents, l.created_by_label]),
      [[beet1, 891, 580, 'Ash'], [beet2, 1782, 1159, 'Ash'], [tabb, 1064, 1026, 'Ash'], [juice, null, 300, 'Ash']]);
    check('the activity log says so', activity.some(a => a[2] === 'recalculate_costs'), true);
  }

  section('4 · the list follows, and a second look finds nothing');
  {
    const t = (await call('GET', `${WASTE}${q}`)).body.totals;
    check('total ¥8.91 + ¥30.65 + ¥4.00', t.cost_total_cents, 891 + 3065 + 400);
    check('no entry without a cost', t.uncosted_entries, 0);
    check('nothing left to change', (await call('GET', RECALC + q)).body.data, []);
  }

  section('5 · a price that moved after the list was made');
  {
    db.prepare('UPDATE store_products SET unit_cost = 11 WHERE id = 21').run();
    const before = (await call('GET', RECALC + q)).body.data;
    check('Tabbouleh would go ¥10.26 → ¥11.00', before.map(c => [c.id, c.from_cents, c.to_cents]), [[tabb, 1026, 1100]]);
    db.prepare('UPDATE store_products SET unit_cost = 12 WHERE id = 21').run();
    const r = await call('POST', RECALC, sendBack(before));
    check('409 costs_changed', [r.status, r.body.error], [409, 'costs_changed']);
    check('nothing written', cost(tabb).c, 1026);
    // An entry voided after the list was made is refused the same way.
    const again = (await call('GET', RECALC + q)).body.data;
    await call('POST', `${WASTE}/${tabb}/void`, {});
    check('a voided entry is refused', (await call('POST', RECALC, sendBack(again))).status, 409);
  }

  section('6 · the filter is the list\'s');
  {
    db.prepare('UPDATE store_products SET unit_cost = 9 WHERE id = 21').run();
    check('a reason outside the filter', (await call('GET', `${RECALC}${q}&reason=damaged`)).body.data, []);
    check('the other store, asked for, is found',
      (await call('GET', `${RECALC}?location_id=2`)).body.data.map(c => [c.id, c.to_cents]), [[tianhe, 900]]);
  }

  section('7 · owner only');
  {
    caps = new Set(['waste:view', 'waste:costs', 'waste:record']);
    check('no waste:void: GET 403', (await call('GET', RECALC + q)).status, 403);
    check('no waste:void: POST 403', (await call('POST', RECALC, { changes: [{ id: tianhe, from_cents: 1064, to_cents: 900 }] })).status, 403);
    caps = new Set(['waste:view', 'waste:record', 'waste:void']);
    check('no waste:costs: GET 403', (await call('GET', RECALC + q)).status, 403);
    caps = null;
    check('caps unresolved: refused', (await call('GET', RECALC + q)).status, 403);
    caps = new Set(OWNER);
    check('nothing written by any of them', cost(tianhe).c, 1064);
  }

  section('8 · a bad body is refused');
  {
    check('no list', (await call('POST', RECALC, {})).status, 400);
    check('empty list', (await call('POST', RECALC, { changes: [] })).status, 400);
    check('an id twice', (await call('POST', RECALC, { changes: [
      { id: tianhe, from_cents: 1064, to_cents: 900 }, { id: tianhe, from_cents: 1064, to_cents: 900 }] })).status, 400);
    check('a bad id', (await call('POST', RECALC, { changes: [{ id: 'x', from_cents: 1, to_cents: 2 }] })).status, 400);
  }

  section('9 · the capability map and the phone gate it on waste:void');
  {
    const { requiredCapFor } = require(path.join(ROOT, 'lib', 'cap-routes'));
    check('POST /waste/recalculate needs waste:void', requiredCapFor('POST', RECALC), 'waste:void');
    check('recording still needs waste:record', requiredCapFor('POST', WASTE), 'waste:record');
    const phone = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
    const btn = phone.match(/function wstRecalcBtn\(\)\{[\s\S]*?\n\}/);
    check('the phone has the button', !!btn, true);
    check('it shows only with money and waste:void',
      !!btn && /wstShowMoney\(\)/.test(btn[0]) && /mCan\('waste:void'\)/.test(btn[0]), true);
    check('it is under the pulse line', /\$\{wstPulse\(\)\}\s*\$\{wstRecalcBtn\(\)\}/.test(phone), true);
    check('Save sends the list back', /apiWrite\('\/waste\/recalculate'/.test(phone), true);
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
