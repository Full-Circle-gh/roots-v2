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
//   6. line unit 'pc' vs item 'pcs'  → same unit, price flows (synonym rule)
//   7. a later PO that prices case 3 cleanly → its open skip auto-resolves and
//                                      leaves the Alerts feed

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('@libsql/client');

const ROOT = path.join(__dirname, '..');
const dbFile = path.join(os.tmpdir(), `price-writeback-test-${process.pid}.db`);
try { fs.unlinkSync(dbFile); } catch {}

const fixture = new Database(dbFile);
fixture.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));

// schema.sql is only half the story — database.js adds later columns by
// ALTER TABLE at boot, and the alerts feed reads some of them. Mirror just
// those six (database.js:29, 35, 36, 59, 69, 426) so the fixture matches a
// real database. Anything else missing will show up as a loud SqliteError —
// source_recipe_id joined the list when firePriceAlertsForPO started calling
// lib/recipe-rollup.js's recompute after a price write-back (§29 step 3):
// planRollup() reads this column on every call, guarded row or not.
for (const sql of [
  "ALTER TABLE purchase_orders ADD COLUMN source TEXT DEFAULT 'manual'",
  'ALTER TABLE po_line_items ADD COLUMN lot_number TEXT',
  'ALTER TABLE po_line_items ADD COLUMN expiry_date DATE',
  'ALTER TABLE products ADD COLUMN is_active INTEGER DEFAULT 1',
  'ALTER TABLE products ADD COLUMN stock_qty INTEGER DEFAULT 0',
  'ALTER TABLE ingredients ADD COLUMN source_recipe_id INTEGER REFERENCES recipes(id)',
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
insIng.run(700, 'Kitchen Hat',        null,    'J-59', 'pcs', 'pcs',    1, null, null, 12, 12);
insIng.run(571, 'Drinking Water',     '饮用水',  'F-26', 'g',   'g',      1, null, null, 0, 0);
fixture.prepare('UPDATE ingredients SET free_by_design = 1 WHERE id = 571').run();

fixture.prepare(`INSERT INTO purchase_orders (id,po_number,date,status) VALUES (1,'PO-TEST-1',date('now'),'Ordered')`).run();
const insLine = fixture.prepare(`INSERT INTO po_line_items
  (po_id,ingredient_id,name_en,sku,qty,unit,cost_per_unit,total_cost) VALUES (?,?,?,?,?,?,?,?)`);
insLine.run(1, 66,  'Black Sesame Seeds',  'C-40', 2, 'bag',    26,  52);   // case 1
insLine.run(1, 601, 'Meat Grinder RY-22S', 'M-99', 1, 'pcs',    135, 135);  // case 2
insLine.run(1, 234, 'Dry Mint Leaves',     'E-40', 1, 'bottle', 45,  45);   // case 3
insLine.run(1, 139, 'Red Lentils',         'C-5',  1, 'kg',     52,  52);   // case 4 — line says kg, item is bag
insLine.run(1, 64,  'Cutlery Set',         'H-26', 3, 'bag',    27,  81);   // case 5
insLine.run(1, 700, 'Kitchen Hat',         'J-59', 4, 'pc',     14,  56);   // case 6 — 'pc' vs 'pcs'
insLine.run(1, 571, 'Drinking Water',      'F-26', 5, 'g',      2,   10);   // case 8 — someone invoiced the water
insIng.run(801, 'Chickpeas',          null,    'C-90', 'g',   'kg',     1, null, null, 0.012, 12);
insLine.run(1, 801, 'Chickpeas',           'C-90', 3, '',       14,  42);   // case 9 — unit left blank
// case 10 (§140) — counted contents. A roll of 1000 labels, used one label at a
// time: the recipe unit is pcs, so every earlier case here says "do not divide"
// and this row is the exception, because it says outright how many pieces a
// roll holds. Its stored cost starts at the WRONG number on purpose — ¥9.27,
// the whole roll's price, which is what this write-back put there before the
// contents pair could be counted.
insIng.run(57, 'Label Paper', '包装标签贴纸', 'J-57', 'pcs', 'pcs', 1, 1000, 'pcs', 9.27, 9.27);
insLine.run(1, 57, 'Label Paper', 'J-57', 2, 'pcs', 9.27, 18.54);

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

console.log('\n── Case 6: line says pc, item says pcs — same unit ──────────────');
const hat = byId(after, 700);
check('J-59 cost_per_unit', hat.cost_per_unit, 14);
check('J-59 not skipped',   result.skips.some(s => s.sku === 'J-59'), false);

console.log('\n── Case 7: a later PO fixes case 3 — the skip auto-resolves ─────');
// Someone fills in what a bottle of mint holds, then the next order arrives.
fixture.prepare("UPDATE ingredients SET pack_contents_qty = 95, pack_contents_unit = 'g' WHERE id = 234").run();
fixture.prepare("INSERT INTO purchase_orders (id,po_number,date,status) VALUES (2,'PO-TEST-2',date('now'),'Ordered')").run();
insLine.run(2, 234, 'Dry Mint Leaves', 'E-40', 1, 'bottle', 50, 50);
purchases.firePriceAlertsForPO(2, 'po_ordered');

const mintNow  = fixture.prepare('SELECT cost_per_unit, buy_price FROM ingredients WHERE id = 234').get();
const mintSkip = fixture.prepare('SELECT reason, resolved_at FROM ingredient_cost_skips WHERE ingredient_id = 234').get();
console.log(`  E-40 cost_per_unit → ${mintNow.cost_per_unit}   buy_price → ${mintNow.buy_price}`);
console.log(`  E-40 skip row: ${mintSkip.reason}, resolved_at=${mintSkip.resolved_at}`);
check('E-40 now prices',            +mintNow.cost_per_unit.toFixed(6), +(50 / 95).toFixed(6));
check('E-40 skip resolved',         mintSkip.resolved_at !== null,     true);
check('skip row kept, not deleted', fixture.prepare('SELECT COUNT(*) AS c FROM ingredient_cost_skips').get().c, 4);

console.log('\n── Case 8: an item marked free by design, invoiced anyway ──────');
// The flag is a decision; a supplier price does not get to overrule it.
const water = byId(after, 571);
console.log(`  F-26 cost_per_unit → ${water.cost_per_unit}   buy_price → ${water.buy_price}`);
check('water still costs nothing', water.cost_per_unit, 0);
check('buy_price untouched',       water.buy_price,     0);
check('skip reason', (result.skips.find(s => s.sku === 'F-26') || {}).reason, 'marked_free');

console.log('\n── Case 9: nobody chose a unit — skipped, not guessed ──────────');
// The PO row template no longer preselects kg, so an untouched line arrives
// blank. That must reach the guard and be reported, never quietly priced.
const chick = byId(after, 801);
console.log(`  C-90 cost_per_unit → ${chick.cost_per_unit}   buy_price → ${chick.buy_price}`);
check('cost untouched',  chick.cost_per_unit, 0.012);
check('price untouched', chick.buy_price,     12);
check('skip reason', (result.skips.find(s => s.sku === 'C-90') || {}).reason, 'unit_mismatch');

console.log('\n── Case 10: a roll of 1000 labels, priced per label (§140) ──────');
// THE LOOP THIS CLOSES. Every PO for this material re-derived the cost from the
// roll price and stored ¥9.27 a label; two such rows sit in the live cost
// history for J-57. The pack contents now divide it, and the invoice price is
// still the roll's — buy_price is what the supplier charges and what the ±5%
// alert compares against, so it must NOT become the per-label figure.
const label = byId(after, 57);
console.log(`  J-57 cost_per_unit → ${label.cost_per_unit}   buy_price → ${label.buy_price}`);
check('J-57 cost_per_unit', +label.cost_per_unit.toFixed(9), 0.00927);
check('J-57 buy_price stays the roll price', label.buy_price, 9.27);
check('J-57 not skipped', result.skips.some(s => s.sku === 'J-57'), false);

console.log('\n── Price history (append-only, one row per priced line) ─────────');
for (const h of fixture.prepare('SELECT ingredient_id,price,buy_unit,source FROM ingredient_price_history ORDER BY id').all()) {
  console.log(`  ingredient ${h.ingredient_id}  ¥${h.price} / ${h.buy_unit}  (${h.source})`);
}

console.log('\n── Skip rows recorded in ingredient_cost_skips ──────────────────');
const skipRows = fixture.prepare('SELECT id,ingredient_id,po_id,reason,line_unit,line_price FROM ingredient_cost_skips ORDER BY id').all();
for (const s of skipRows) console.log(`  id=${s.id} ingredient=${s.ingredient_id} po=${s.po_id} ${s.reason} (line ¥${s.line_price} / ${s.line_unit})`);
check('skip rows stored', skipRows.length, 4);


// ── WHICH SKIPS ARE STILL OPEN ──────────────────────────────────────────────
// This block used to mount routes/alerts.js on a throwaway express app and
// GET /api/alerts/feed + /api/alerts/unread-count, asserting the costSkips
// section those endpoints assembled. §78 deleted routes/alerts.js — the feed
// was public/app.html's panel and that page is gone.
//
// THE ASSERTIONS ARE KEPT AND RE-AIMED AT THE ROWS, not deleted with the
// reader. What the feed reported was a projection of ingredient_cost_skips:
// which skips are unresolved, how many, and how they split by reason. Every
// one of those is a property of the table that firePriceAlertsForPO — which
// SURVIVES, and is what this suite exists to test — actually writes. Reading
// them here asserts the same facts one layer closer to the cause.
//
// What is genuinely gone is the round trip: nothing now proves an HTTP reader
// assembles these rows correctly, because there is no longer such a reader.
const openSkips = fixture.prepare(
  'SELECT ingredient_id, po_id, reason FROM ingredient_cost_skips WHERE resolved_at IS NULL ORDER BY id'
).all();
console.log('\n── Open (unresolved) rows in ingredient_cost_skips ──────────────');
for (const s of openSkips) console.log(`  ingredient=${s.ingredient_id} po=${s.po_id} ${s.reason}`);

// Only C-5 is still open on E-40's reason — E-40 resolved itself in case 7,
// which is why an open count of 3 against 4 stored rows is the assertion.
check('three skips are still open', openSkips.length, 3);
check('and one of the four resolved', skipRows.length - openSkips.length, 1);

const byReason = [...new Set(openSkips.map(s => s.reason))].sort();
console.log('  open reasons:', JSON.stringify(byReason));
check('the open skips split across two reasons', byReason.length, 2);

fixture.close();
try { fs.unlinkSync(dbFile); } catch {}
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
