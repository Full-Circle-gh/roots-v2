#!/usr/bin/env node
/**
 * §300 step R7 — the money on a product's build list, and on the recipe
 * link's answer, is SENT only on the keys the screens draw it on.
 *
 *   node scripts/test_product_build_cost_visibility.js
 *
 *   products:costs   the product's cost: unit_cost, cost.unitCost/ingredientCost
 *   materials:costs  a material's price: each line's material_cost_per_unit and
 *                    material_buy_price, the bridge material's and each picker
 *                    row's cost_per_unit / buy_price, cost.lines' figures
 *
 * The rules are lib/recipe-cost-visibility.js's, copied: fails closed on an
 * unresolved cap set, keys deleted never zeroed, a field refused and never a
 * request, the computed cost allow-listed.
 *
 * FOUR PROMISES, each held here:
 *   1. A holder of both keys gets a byte-identical answer — checked by
 *      mounting the route twice, once with the visibility module and once
 *      with it replaced by a pass-through, and comparing the JSON.
 *   2. A non-holder gets no money key at any depth.
 *   3. A non-holder's SAVE blanks nothing: the save reads no money from the
 *      body, and the stored costs are what they were.
 *   4. The recipe-link answers (routes/retail.js) go through the product
 *      gate every other product read uses.
 *
 * The route is mounted on a bare express app over an in-memory database, the
 * pattern scripts/test_waste_kept_lines.js uses for the same router.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const pending = [];
function it(name, fn) {
  pending.push(async () => {
    try { await fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
  });
}
function section(t) { pending.push(() => console.log('\n' + t)); }

// ── The fixture ────────────────────────────────────────────────────────────
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE store_products (id INTEGER PRIMARY KEY, name_en TEXT, name_cn TEXT, sku TEXT,
      unit_cost REAL, recipe_id INTEGER);
    CREATE TABLE ingredients (id INTEGER PRIMARY KEY, name_en TEXT, name_cn TEXT, sku TEXT,
      unit TEXT DEFAULT 'g', cost_per_unit REAL DEFAULT 0, buy_price REAL, free_by_design INTEGER DEFAULT 0,
      overhead_per_unit REAL DEFAULT 0, item_kind TEXT DEFAULT 'food', is_active INTEGER DEFAULT 1,
      source_recipe_id INTEGER);
    CREATE TABLE product_build_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL,
      ingredient_id INTEGER, name_en TEXT NOT NULL, name_cn TEXT, sku TEXT, qty REAL NOT NULL,
      unit TEXT DEFAULT 'g', notes TEXT, sort_order INTEGER DEFAULT 0,
      packed_separately INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE recipes (id INTEGER PRIMARY KEY, name_en TEXT, name_cn TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE recipe_ingredients (id INTEGER PRIMARY KEY, recipe_id INTEGER, ingredient_id INTEGER, qty REAL, unit TEXT);
  `);
  db.prepare('INSERT INTO recipes (id,name_en,name_cn) VALUES (80,?,?)').run('Zhoug', '青酱');
  const mat = db.prepare('INSERT INTO ingredients (id,name_en,name_cn,sku,unit,cost_per_unit,buy_price,item_kind,source_recipe_id) VALUES (?,?,?,?,?,?,?,?,?)');
  mat.run(500, 'Zhoug (made)', '青酱(自制)', 'M-80', 'g', 0.04, null, 'food', 80);
  mat.run(600, 'Tub 200 ml', '200毫升杯', 'P-1', 'pcs', 0.45, 45, 'packaging', null);
  mat.run(601, 'Lid label', '盖标', 'P-2', 'pcs', 0.08, 8, 'packaging', null);
  db.prepare('INSERT INTO store_products (id,name_en,sku,unit_cost,recipe_id) VALUES (41,?,?,8.45,80)').run('Zhoug 200 g', '1-225');
  db.prepare('INSERT INTO store_products (id,name_en,sku,unit_cost,recipe_id) VALUES (42,?,?,NULL,80)').run('Zhoug 500 g', '1-226');
  const line = db.prepare('INSERT INTO product_build_lines (product_id,ingredient_id,name_en,name_cn,sku,qty,unit,sort_order) VALUES (?,?,?,?,?,?,?,?)');
  line.run(41, 600, 'Tub 200 ml', '200毫升杯', 'P-1', 1, 'pcs', 0);
  line.run(41, 500, 'Zhoug (made)', '青酱(自制)', 'M-80', 200, 'g', 1);
  // 42 has only packaging, so its recipe bridge is offered ('ready').
  line.run(42, 601, 'Lid label', '盖标', 'P-2', 1, 'pcs', 0);
  return db;
}
let db = makeDb();

function stub(rel, value) {
  const abs = require.resolve(path.join(ROOT, rel));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: value };
}
stub('lib/tenant-db', { tdb: () => db, rawTenantDb: () => db });
stub('routes/retail', { requireRetailAdmin: (req, res, next) => next() });
// The recompute is its own suite's business (test_recipe_rollup_apply.js).
// Stubbed to a no-op, so what the save itself writes is all there is to see.
stub('lib/recipe-rollup', { fireRecompute: () => ({ applied: true, written: 0 }) });

const express = require('express');
const ROUTE = path.join(ROOT, 'routes', 'retail-product-build.js');
const VIS = path.join(ROOT, 'lib', 'product-build-cost-visibility.js');
function mountRoute() {
  const app = express();
  app.use((req, res, next) => {
    const c = req.headers['x-test-caps'];
    req.caps = c === undefined ? null : new Set(String(c).split(',').filter(Boolean));
    next();
  });
  delete require.cache[require.resolve(ROUTE)];
  app.use(require(ROUTE));
  return app;
}
// The app as it now ships.
const appReal = mountRoute();
// The same route with the visibility module replaced by a pass-through —
// the answer as it was before §300 R7, to hold a holder's answer against.
const realVis = require(VIS);
require.cache[require.resolve(VIS)] = { id: VIS, filename: VIS, loaded: true, exports: Object.assign({}, realVis, {
  stripBuildPayload: (req, d) => d, stripPickerRows: (req, r) => r, stripProductRow: (req, r) => r,
}) };
const appBefore = mountRoute();
delete require.cache[require.resolve(VIS)];

function call(app, method, url, caps, body) {
  return new Promise((resolve) => {
    const headers = body ? { 'content-type': 'application/json', 'content-length': '0' } : {};
    if (caps !== null) headers['x-test-caps'] = caps.join(',');
    const req = Object.assign(require('stream').Readable.from([]), {
      method, url, originalUrl: url, headers, body: body || {}, _body: !!body, connection: {}, socket: {},
    });
    const res = {
      statusCode: 200, headersSent: false,
      setHeader() {}, getHeader() {}, removeHeader() {}, set() { return this; },
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload, raw: JSON.stringify(payload) }); return this; },
      send(payload) { resolve({ status: this.statusCode, body: payload, raw: String(payload) }); return this; },
      end() { resolve({ status: this.statusCode, body: null, raw: '' }); },
    };
    app(req, res);
  });
}

const BOTH = ['products:view', 'products:edit', 'products:costs', 'materials:costs'];
const PROD_ONLY = ['products:view', 'products:edit', 'products:costs'];
const MAT_ONLY = ['products:view', 'products:edit', 'materials:costs'];
const NEITHER = ['products:view', 'products:edit'];
// Every money key either payload can carry, at any depth.
const PRODUCT_MONEY = ['unit_cost', 'unitCost', 'ingredientCost'];
const MATERIAL_MONEY = ['material_cost_per_unit', 'material_buy_price', 'cost_per_unit', 'buy_price', 'costPerUnit', 'lineCost'];
function keysDeep(o, out = new Set()) {
  if (Array.isArray(o)) o.forEach((x) => keysDeep(x, out));
  else if (o && typeof o === 'object') for (const k of Object.keys(o)) { out.add(k); keysDeep(o[k], out); }
  return out;
}
const hasAny = (o, list) => { const k = keysDeep(o); return list.filter((x) => k.has(x)); };

const GET41 = '/api/retail-admin/products/41/build-lines';
const GET42 = '/api/retail-admin/products/42/build-lines';
const PICK = '/api/retail-admin/product-build/materials?search=l';

// ════════════════════════════════════════════════════════════════════════════
section('1 · A holder of both keys: byte-identical');
// ════════════════════════════════════════════════════════════════════════════
for (const [label, url] of [['GET build-lines (a costed list)', GET41], ['GET build-lines (the recipe bridge offered)', GET42], ['GET the picker', PICK]]) {
  it(label, async () => {
    const a = await call(appReal, 'GET', url, BOTH);
    const b = await call(appBefore, 'GET', url, BOTH);
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.raw, b.raw);
    assert.ok(hasAny(a.body, MATERIAL_MONEY).length && hasAny(a.body, ['cost_per_unit', 'material_cost_per_unit']).length,
      'and it does carry the money — the comparison is not of two empty answers');
  });
}
it('PUT build-lines answers a holder exactly as before', async () => {
  const lines = [{ ingredient_id: 600, name_en: 'Tub 200 ml', qty: 1, unit: 'pcs' }, { ingredient_id: 500, name_en: 'Zhoug (made)', qty: 200, unit: 'g' }];
  const a = await call(appReal, 'PUT', GET41, BOTH, { lines });
  const b = await call(appBefore, 'PUT', GET41, BOTH, { lines });
  assert.strictEqual(a.raw, b.raw);
  assert.strictEqual(a.body.data.unit_cost, 8.45);
});
it('the module hands a holder the SAME object, not a copy', () => {
  const req = { caps: new Set(BOTH) };
  const d = { unit_cost: 1, lines: [{ material_cost_per_unit: 1 }], cost: { unitCost: 1 } };
  assert.strictEqual(realVis.stripBuildPayload(req, d), d);
  const rows = [{ cost_per_unit: 1 }];
  assert.strictEqual(realVis.stripPickerRows(req, rows), rows);
  const row = { id: 1, unit_cost: 2 };
  assert.strictEqual(realVis.stripProductRow(req, row), row);
});

// ════════════════════════════════════════════════════════════════════════════
section('2 · A non-holder: no money key at any depth, and nothing else lost');
// ════════════════════════════════════════════════════════════════════════════
it('neither key: no product cost, no material price — the list, the counts and the bridge stay', async () => {
  const r = await call(appReal, 'GET', GET41, NEITHER);
  assert.deepStrictEqual(hasAny(r.body, PRODUCT_MONEY.concat(MATERIAL_MONEY)), []);
  const d = r.body.data;
  assert.deepStrictEqual(d.lines.map((l) => [l.ingredient_id, l.qty, l.unit, l.material_item_kind]),
    [[600, 1, 'pcs', 'packaging'], [500, 200, 'g', 'food']], 'the list itself is intact');
  assert.deepStrictEqual(Object.keys(d.cost).sort(),
    ['hasBuildList', 'ingredientLines', 'lines', 'packagingOnly', 'unreconciledUnitLines', 'zeroCostLines']);
  assert.strictEqual(d.cost.zeroCostLines, 0);
  const b = (await call(appReal, 'GET', GET42, NEITHER)).body.data;
  assert.strictEqual(b.recipe.state, 'ready');
  assert.strictEqual(b.recipe.material.id, 500);
  assert.ok(!('cost_per_unit' in b.recipe.material));
});
it('products:costs only: the product’s cost and the list’s total — no material’s rate', async () => {
  const d = (await call(appReal, 'GET', GET41, PROD_ONLY)).body.data;
  assert.strictEqual(d.unit_cost, 8.45);
  assert.strictEqual(d.cost.unitCost, 8.45);
  assert.deepStrictEqual(hasAny(d, MATERIAL_MONEY), []);
});
it('materials:costs only: the rates — no product cost', async () => {
  const d = (await call(appReal, 'GET', GET41, MAT_ONLY)).body.data;
  assert.deepStrictEqual(hasAny(d, PRODUCT_MONEY), []);
  assert.strictEqual(d.lines[1].material_cost_per_unit, 0.04);
  assert.strictEqual(d.lines[0].material_buy_price, 45);
  assert.strictEqual(d.cost.lines[1].costPerUnit, 0.04);
});
it('an unresolved cap set FAILS CLOSED — the recipe rule, copied', async () => {
  const r = await call(appReal, 'GET', GET41, null);
  assert.strictEqual(r.status, 200, 'a field is refused, never the request');
  assert.deepStrictEqual(hasAny(r.body, PRODUCT_MONEY.concat(MATERIAL_MONEY)), []);
  const p = await call(appReal, 'GET', PICK, null);
  assert.deepStrictEqual(hasAny(p.body, MATERIAL_MONEY), []);
});
it('the picker without materials:costs: the rows and the match count, no rate, no buy price', async () => {
  const r = await call(appReal, 'GET', PICK, PROD_ONLY);
  const b = await call(appBefore, 'GET', PICK, PROD_ONLY);
  assert.deepStrictEqual(hasAny(r.body, MATERIAL_MONEY), []);
  assert.deepStrictEqual(r.body.data.map((m) => m.id), b.body.data.map((m) => m.id));
  assert.strictEqual(r.body.matched, b.body.matched);
});
it('keys are DELETED, never zeroed', async () => {
  const d = (await call(appReal, 'GET', GET41, NEITHER)).body.data;
  assert.ok(!/"(unit_cost|material_cost_per_unit|material_buy_price|cost_per_unit)":0\b/.test(JSON.stringify(d)));
});

// ════════════════════════════════════════════════════════════════════════════
section('3 · A non-holder’s save blanks nothing');
// ════════════════════════════════════════════════════════════════════════════
it('the save reads no money from the body — a round trip of the stripped read changes no stored cost', async () => {
  const before = JSON.stringify([db.prepare('SELECT id, unit_cost FROM store_products ORDER BY id').all(),
    db.prepare('SELECT id, cost_per_unit, buy_price FROM ingredients ORDER BY id').all()]);
  const got = (await call(appReal, 'GET', GET41, NEITHER)).body.data;
  // What a client holding the stripped read sends back — plus, for good
  // measure, money keys it should never have, which the save must ignore.
  const lines = got.lines.map((l) => ({ ingredient_id: l.ingredient_id, name_en: l.name_en, name_cn: l.name_cn,
    sku: l.sku, qty: l.qty, unit: l.unit, notes: l.notes, packed_separately: !!l.packed_separately,
    material_cost_per_unit: 0, cost_per_unit: 0, unit_cost: 0 }));
  const put = await call(appReal, 'PUT', GET41, NEITHER, { lines, unit_cost: 0 });
  assert.strictEqual(put.body.success, true);
  const after = JSON.stringify([db.prepare('SELECT id, unit_cost FROM store_products ORDER BY id').all(),
    db.prepare('SELECT id, cost_per_unit, buy_price FROM ingredients ORDER BY id').all()]);
  assert.strictEqual(after, before, 'no stored cost moved');
  assert.deepStrictEqual(db.prepare('SELECT ingredient_id, qty, unit FROM product_build_lines WHERE product_id = 41 ORDER BY sort_order').all()
    .map((r) => [r.ingredient_id, r.qty, r.unit]), [[600, 1, 'pcs'], [500, 200, 'g']], 'and the list is saved');
  assert.ok(!('unit_cost' in put.body.data), 'the save’s answer carries no product cost either');
  assert.strictEqual(put.body.data.id, 41);
  // The INSERT reads exactly these body keys, and none is money.
  const src = fs.readFileSync(ROUTE, 'utf8');
  const ins = src.slice(src.indexOf('lines.forEach((l, i) => {'), src.indexOf('});\n  });\n  tx();'));
  assert.deepStrictEqual([...new Set(ins.match(/l\.([a-z_]+)/g))].sort(),
    ['l.ingredient_id', 'l.name_cn', 'l.name_en', 'l.notes', 'l.packed_separately', 'l.qty', 'l.sku', 'l.unit']);
});

// ════════════════════════════════════════════════════════════════════════════
section('4 · The recipe link’s answers (routes/retail.js)');
// ════════════════════════════════════════════════════════════════════════════
it('PUT and DELETE /recipe-link answer through stripProductCosts, the gate every product read uses', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
  const put = src.slice(src.indexOf("router.put('/api/retail-admin/products/:id/recipe-link'"),
    src.indexOf("router.delete('/api/retail-admin/products/:id/recipe-link'"));
  const del = src.slice(src.indexOf("router.delete('/api/retail-admin/products/:id/recipe-link'"),
    src.indexOf("router.get('/api/retail-admin/products/:id/recipe-health'"));
  assert.match(put, /res\.json\(\{ success: true, data: stripProductCosts\(req, row\), warning \}\);/);
  assert.match(del, /res\.json\(\{ success: true, data: stripProductCosts\(req, \{ \.\.\.row, recipe_name_en: null, recipe_name_cn: null \}\) \}\);/);
  assert.ok(!/res\.json\(\{ success: true, data: row/.test(put + del), 'no answer left unwrapped');
});
it('…which leaves a holder’s row untouched and takes unit_cost from everyone else, failing closed', () => {
  const V = require('../lib/product-cost-visibility');
  const shape = () => ({ id: 41, recipe_id: 80, unit_cost: 8.45, recipe_name_en: 'Zhoug', recipe_name_cn: '青酱' });
  const held = shape();
  assert.strictEqual(V.stripProductCosts({ caps: new Set(['products:costs']) }, held), held);
  assert.strictEqual(JSON.stringify(held), JSON.stringify(shape()), 'byte-identical');
  for (const req of [{ caps: new Set(['products:edit']) }, { caps: null }]) {
    const out = V.stripProductCosts(req, shape());
    assert.ok(!('unit_cost' in out));
    assert.deepStrictEqual(Object.keys(out), ['id', 'recipe_id', 'recipe_name_en', 'recipe_name_cn']);
  }
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
