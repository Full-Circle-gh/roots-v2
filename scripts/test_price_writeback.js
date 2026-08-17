#!/usr/bin/env node
// Exercises the PO price write-back (routes/purchases.js firePriceAlertsForPO)
// against a FIXTURE database — never the live one.
//
// The fixture is built from schema.sql in a temp file, `require.cache` is
// primed so routes/purchases.js resolves `../database` to that handle, and the
// real function is then called on a real PO. Every assertion reads the values
// BACK out of the database; nothing is asserted against what we meant to write.
//
// Run:  node scripts/test_price_writeback.js
//
// Cases, all from the 2026-08-17 brief:
//   1. bag-bought food (C-40 shape)  → pack price divided by pack contents
//   2. pcs item                      → pack price stored as-is, no division
//   3. container, no pack contents   → SKIP, old cost left intact
//   4. PO line unit ≠ item buy_unit  → SKIP, old cost left intact
//   5. recipe unit 'bag'             → pack price stored as-is (per-piece rule,
//                                      extended to bag/bottle/box 2026-08-17)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const dbFile = path.join(os.tmpdir(), `price-writeback-test-${process.pid}.db`);
try { fs.unlinkSync(dbFile); } catch {}

const fixture = new Database(dbFile);
fixture.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));

// schema.sql is only half the story — database.js adds later columns by
// ALTER TABLE at boot, and the alerts feed reads some of them. Mirror just
// those five (database.js:29, 35, 36, 59, 69) so the fixture matches a real
// database. Anything else missing will show up as a loud SqliteError.
for (const sql of [
  "ALTER TABLE purchase_orders ADD COLUMN source TEXT DEFAULT 'manual'",
  'ALTER TABLE po_line_items ADD COLUMN lot_number TEXT',
  'ALTER TABLE po_line_items ADD COLUMN expiry_date DATE',
  'ALTER TABLE products ADD COLUMN is_active INTEGER DEFAULT 1',
  'ALTER TABLE products ADD COLUMN stock_qty INTEGER DEFAULT 0',
]) { try { fixture.exec(sql); } catch {} }

// Prime the module cache so `require('../database')` inside the route hands
// back the fixture. Must happen BEFORE routes/purchases.js is required.
const dbModulePath = require.resolve(path.join(ROOT, 'database.js'));
require.cache[dbModulePath] = {
  id: dbModulePath, filename: dbModulePath, path: path.dirname(dbModulePath),
  loaded: true, children: [], paths: [], exports: fixture,
};

const insIng = fixture.prepare(`INSERT INTO ingredients
  (id,name_en,name_cn,sku,unit,buy_unit,buy_pack_size,pack_contents_qty,pack_contents_unit,cost_per_unit,buy_price)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

// id, name, sku, recipe unit, buy unit, pack size, contents qty, contents unit, cost/unit, buy price
insIng.run(66,  'Black Sesame Seeds', '黑芝麻', 'C-40', 'g',   'bag',    1, 500,  'g', 15.8, 15.8);
insIng.run(601, 'Meat Grinder RY-22S', null,   'M-99', 'pcs', 'pcs',    1, null, null, 120, 120);
insIng.run(234, 'Dry Mint Leaves',    null,    'E-40', 'g',   'bottle', 1, null, null, 0.42, 40);
insIng.run(139, 'Red Lentils',        null,    'C-5',  'g',   'bag',    1, 500,  'g', 0.0204, 10.21);
insIng.run(64,  'Cutlery Set',        null,    'H-26', 'bag', 'bag',    1, null, null, 24.63, 24.63);

fixture.prepare(`INSERT INTO purchase_orders (id,po_number,date,status) VALUES (1,'PO-TEST-1',date('now'),'Ordered')`).run();
const insLine = fixture.prepare(`INSERT INTO po_line_items
  (po_id,ingredient_id,name_en,sku,qty,unit,cost_per_unit,total_cost) VALUES (?,?,?,?,?,?,?,?)`);
insLine.run(1, 66,  'Black Sesame Seeds',  'C-40', 2, 'bag',    26,  52);   // case 1
insLine.run(1, 601, 'Meat Grinder RY-22S', 'M-99', 1, 'pcs',    135, 135);  // case 2
insLine.run(1, 234, 'Dry Mint Leaves',     'E-40', 1, 'bottle', 45,  45);   // case 3
insLine.run(1, 139, 'Red Lentils',         'C-5',  1, 'kg',     52,  52);   // case 4 — line says kg, item is bag
insLine.run(1, 64,  'Cutlery Set',         'H-26', 3, 'bag',    27,  81);   // case 5

const before = fixture.prepare('SELECT id,sku,unit,buy_unit,cost_per_unit,buy_price FROM ingredients ORDER BY id').all();

const purchases = require(path.join(ROOT, 'routes', 'purchases.js'));
const result = purchases.firePriceAlertsForPO(1, 'po_ordered');

const after = fixture.prepare('SELECT id,sku,unit,buy_unit,cost_per_unit,buy_price FROM ingredients ORDER BY id').all();
const byId = (rows, id) => rows.find(r => r.id === id);

console.log('\n── Rows read back from the fixture DB ───────────────────────────');
for (const row of after) {
  const b = byId(before, row.id);
  console.log(`  ${row.sku.padEnd(6)} unit=${String(row.unit).padEnd(4)} buy_unit=${String(row.buy_unit).padEnd(7)}` +
              ` cost_per_unit ${b.cost_per_unit} → ${row.cost_per_unit}   buy_price ${b.buy_price} → ${row.buy_price}`);
}
console.log('\n── Skips returned ──────────────────────────────────────────────');
for (const s of result.skips) console.log(`  ${s.sku} ${s.name_en} — ${s.reason}`);
if (!result.skips.length) console.log('  (none)');

let failures = 0;
function check(label, actual, expected) {
  const ok = typeof expected === 'number' && typeof actual === 'number'
    ? Math.abs(actual - expected) < 1e-9
    : actual === expected;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label} — expected ${expected}, got ${actual}`);
  if (!ok) failures++;
}

console.log('\n── Case 1: bag-bought food, ¥26 for a 1×500 g bag ──────────────');
const c40 = byId(after, 66);
check('C-40 cost_per_unit', c40.cost_per_unit, 0.052);
check('C-40 buy_price',     c40.buy_price,     26);
check('C-40 buy_unit unchanged', c40.buy_unit, 'bag');

console.log('\n── Case 2: pcs item, ¥135 per piece — no division ───────────────');
const pcs = byId(after, 601);
check('M-99 cost_per_unit', pcs.cost_per_unit, 135);
check('M-99 buy_price',     pcs.buy_price,     135);

console.log('\n── Case 3: bottle with pack_contents_qty NULL — skip ────────────');
const bottle = byId(after, 234);
check('E-40 cost_per_unit unchanged', bottle.cost_per_unit, 0.42);
check('E-40 buy_price unchanged',     bottle.buy_price,     40);
check('E-40 skip reason', (result.skips.find(s => s.sku === 'E-40') || {}).reason, 'no_pack_contents');

console.log('\n── Case 4: line unit kg vs item buy_unit bag — skip ─────────────');
const mismatch = byId(after, 139);
check('C-5 cost_per_unit unchanged', mismatch.cost_per_unit, 0.0204);
check('C-5 buy_price unchanged',     mismatch.buy_price,     10.21);
check('C-5 skip reason', (result.skips.find(s => s.sku === 'C-5') || {}).reason, 'unit_mismatch');

console.log('\n── Case 5: recipe unit bag, ¥27 per bag — no division ───────────');
const bagUnit = byId(after, 64);
check('H-26 cost_per_unit', bagUnit.cost_per_unit, 27);
check('H-26 buy_price',     bagUnit.buy_price,     27);

console.log('\n── Price history (append-only, one row per priced line) ─────────');
for (const h of fixture.prepare('SELECT ingredient_id,price,buy_unit,source FROM ingredient_price_history ORDER BY id').all()) {
  console.log(`  ingredient ${h.ingredient_id}  ¥${h.price} / ${h.buy_unit}  (${h.source})`);
}

console.log('\n── Skip rows recorded in ingredient_cost_skips ──────────────────');
const skipRows = fixture.prepare('SELECT id,ingredient_id,po_id,reason,line_unit,line_price FROM ingredient_cost_skips ORDER BY id').all();
for (const s of skipRows) console.log(`  id=${s.id} ingredient=${s.ingredient_id} po=${s.po_id} ${s.reason} (line ¥${s.line_price} / ${s.line_unit})`);
check('skip rows stored', skipRows.length, 2);

// ── Does a skip actually reach the Alerts feed? ─────────────────────────────
// Mount routes/alerts.js on a throwaway express app with auth stubbed out and
// call the real endpoint over HTTP. Requires the stub to land in the module
// cache AFTER routes/purchases.js loaded the real middleware and BEFORE
// routes/alerts.js is required.
(async () => {
  const authPath = require.resolve(path.join(ROOT, 'middleware', 'auth.js'));
  require.cache[authPath] = {
    id: authPath, filename: authPath, path: path.dirname(authPath), loaded: true, children: [], paths: [],
    exports: {
      requireAuth: (req, _res, next) => { req.user = { id: 1, username: 'test', role: 'admin' }; req.permissions = { alerts: 1 }; next(); },
      requirePermission: () => (_req, _res, next) => next(),
      requireDelete: (_req, _res, next) => next(),
      logActivity: () => {},
    },
  };
  const express = require('express');
  const app = express();
  app.use(require(path.join(ROOT, 'routes', 'alerts.js')));
  const server = app.listen(0);
  const port = server.address().port;

  const feed = await (await fetch(`http://127.0.0.1:${port}/api/alerts/feed`)).json();
  const badge = await (await fetch(`http://127.0.0.1:${port}/api/alerts/unread-count`)).json();

  console.log('\n── GET /api/alerts/feed → costSkips section ─────────────────────');
  for (const s of (feed.data.costSkips || [])) {
    console.log(`  ${s.ingredient_sku} ${s.ingredient_name} — ${s.reason}  (PO ${s.po_number}, line ¥${s.line_price}/${s.line_unit}, cost kept ${s.cost_per_unit}/${s.recipe_unit})`);
  }
  check('feed returns both skips',      (feed.data.costSkips || []).length, 2);
  check('feed count agrees',            feed.data.counts.costSkips,        2);
  check('badge count includes skips',   badge.breakdown.costSkips,         2);

  server.close();
  fixture.close();
  try { fs.unlinkSync(dbFile); } catch {}
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
