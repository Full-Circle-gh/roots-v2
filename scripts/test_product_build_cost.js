#!/usr/bin/env node
/**
 * test_product_build_cost.js — does computeProductBuildCost() (Step 2 of
 * docs/tacet-product-build-lines-design.md) actually roll up a product's
 * build list the way §2 of that design specifies?
 *
 * Covers:
 *   - the flat-sum shape: qty × costPerUnit per line, summed, with NO
 *     servings/batch-size division anywhere — a build list describes one
 *     sellable unit, not a batch (the design doc's central simplification).
 *   - the Zhoug worked example itself: 250g of a material + 1 box + 1 label,
 *     three lines, reconciling to the exact figure by hand.
 *   - a per-piece packaging line (qty=1, unit='pcs') costs at the material's
 *     full cost_per_unit, undivided — proving lib/ingredient-cost.js's
 *     existing per-piece branch already does the right thing with zero new
 *     code, exactly as the design doc claims.
 *   - BLOCKED, ALL-OR-NOTHING: one unpriced line blocks the WHOLE product's
 *     unitCost to null, not a confidently-low partial sum — the same
 *     discipline lib/recipe-rollup.js's costOneRecipe() already holds.
 *   - an unreconciled unit (a volume line against a weight-stocked material)
 *     blocks on its own counter, same as a recipe line would.
 *   - free_by_design contributes a real zero and does NOT block — water
 *     doesn't cry wolf here either.
 *   - hasBuildList: false vs unitCost: null are different fects — no lines
 *     at all is not the same fact as a blocked list.
 *   - the id-form (loads via db) and the rows-form (caller-supplied) agree,
 *     the same parity computeRecipeCost's two call shapes hold.
 *
 * In-memory fixture only. No real database, no network, no writes outside
 * this process's own :memory: handle — this module makes none at all.
 *
 * Exit 0 = every case behaved. Exit 1 = at least one did not.
 */
'use strict';

const path = require('path');
function loadSqlite() {
  try { return require('better-sqlite3'); } catch (e) { /* fall through */ }
  for (const base of [path.join(__dirname, '..', '..', '..', '..'), '/root/roots-v2']) {
    try { return require(path.join(base, 'node_modules', 'better-sqlite3')); } catch (e) { /* next */ }
  }
  console.error('better-sqlite3 not found — run from the main checkout or the box.');
  process.exit(2);
}
const Database = loadSqlite();
const { computeProductBuildCost } = require(path.join(__dirname, '..', 'lib', 'product-build-cost'));

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name_en TEXT, name_cn TEXT, sku TEXT,
      unit TEXT DEFAULT 'g', cost_per_unit REAL DEFAULT 0, free_by_design INTEGER DEFAULT 0,
      -- §29's second addendum (2026-08-27): the overhead a made material's
      -- own recipe added, so a parent can exclude it from its base.
      overhead_per_unit REAL DEFAULT 0,
      item_kind TEXT DEFAULT 'food', is_active INTEGER DEFAULT 1);
    CREATE TABLE product_build_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, ingredient_id INTEGER,
      name_en TEXT, name_cn TEXT, sku TEXT, qty REAL, unit TEXT DEFAULT 'g',
      notes TEXT, sort_order INTEGER DEFAULT 0);
  `);
  return db;
}
function seedMaterial(db, { id, name_en, unit, cpu, free, item_kind }) {
  db.prepare('INSERT INTO ingredients (id,name_en,unit,cost_per_unit,free_by_design,item_kind) VALUES (?,?,?,?,?,?)')
    .run(id, name_en || ('Material ' + id), unit || 'g', cpu == null ? 0 : cpu, free ? 1 : 0, item_kind || 'food');
}
function seedLine(db, { product_id, ingredient_id, qty, unit, sort_order }) {
  db.prepare('INSERT INTO product_build_lines (product_id,ingredient_id,name_en,qty,unit,sort_order) VALUES (?,?,?,?,?,?)')
    .run(product_id, ingredient_id == null ? null : ingredient_id, 'line', qty, unit || 'g', sort_order || 0);
}

let failures = 0;
function check(label, actual, expected, detail) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${detail ? ' — ' + detail : ''}`);
  else if (detail) console.log(`        ${detail}`);
}

// 1 · no build lines at all — hasBuildList false, unitCost null, NOT the
//    same fact as a blocked list (checked separately in case 5).
{
  const db = makeDb();
  const c = computeProductBuildCost(999, db);
  check('no lines: hasBuildList is false', c.hasBuildList, false);
  check('no lines: unitCost is null', c.unitCost, null);
  db.close();
}

// 2 · the Zhoug worked example — 250g material @ ¥0.20/g + 1 box @ ¥1.12 +
//    1 label @ ¥0.08. Hand total: 50 + 1.12 + 0.08 = 51.20.
{
  const db = makeDb();
  seedMaterial(db, { id: 1, name_en: 'Zhoug (material)', unit: 'g', cpu: 0.20 });
  seedMaterial(db, { id: 2, name_en: '300ml plastic box', unit: 'pcs', cpu: 1.12, item_kind: 'packaging' });
  seedMaterial(db, { id: 3, name_en: 'Label', unit: 'pcs', cpu: 0.08, item_kind: 'packaging' });
  seedLine(db, { product_id: 5, ingredient_id: 1, qty: 250, unit: 'g', sort_order: 0 });
  seedLine(db, { product_id: 5, ingredient_id: 2, qty: 1, unit: 'pcs', sort_order: 1 });
  seedLine(db, { product_id: 5, ingredient_id: 3, qty: 1, unit: 'pcs', sort_order: 2 });
  const c = computeProductBuildCost(5, db);
  check('Zhoug worked example: hasBuildList true', c.hasBuildList, true);
  check('Zhoug worked example: three lines counted', c.ingredientLines, 3);
  check('Zhoug worked example: unitCost = 51.20', Math.round(c.unitCost * 100) / 100, 51.20, JSON.stringify(c));
  check('Zhoug worked example: no division by any servings/batch concept', c.unitCost, c.ingredientCost);
  db.close();
}

// 3 · a per-piece packaging line costs the full undivided cost_per_unit —
//    lib/ingredient-cost.js's existing branch needs no new code for this.
{
  const db = makeDb();
  seedMaterial(db, { id: 1, name_en: 'Jar', unit: 'pcs', cpu: 2.50 });
  seedLine(db, { product_id: 1, ingredient_id: 1, qty: 3, unit: 'pcs' });
  const c = computeProductBuildCost(1, db);
  check('per-piece line: qty 3 x 2.50 = 7.50, undivided', c.unitCost, 7.50);
  db.close();
}

// 4 · one unpriced line blocks the WHOLE product, not a partial sum.
{
  const db = makeDb();
  seedMaterial(db, { id: 1, name_en: 'Priced', unit: 'g', cpu: 0.10 });
  seedMaterial(db, { id: 2, name_en: 'Unpriced', unit: 'g', cpu: 0 });
  seedLine(db, { product_id: 1, ingredient_id: 1, qty: 100 });
  seedLine(db, { product_id: 1, ingredient_id: 2, qty: 50 });
  const c = computeProductBuildCost(1, db);
  check('unpriced line: hasBuildList still true', c.hasBuildList, true);
  check('unpriced line: unitCost is null (blocked), not a confident partial', c.unitCost, null);
  check('unpriced line: exactly one zeroCostLine counted', c.zeroCostLines, 1);
  check('unpriced line: ingredientCost still reports the partial for diagnostics', c.ingredientCost, 10);
  db.close();
}

// 5 · an unreconciled unit (volume line against a weight-stocked material)
//    blocks on its OWN counter, distinct from a genuinely unpriced line.
{
  const db = makeDb();
  seedMaterial(db, { id: 1, name_en: 'Oil, stocked by weight', unit: 'g', cpu: 0.05 });
  seedLine(db, { product_id: 1, ingredient_id: 1, qty: 100, unit: 'ml' }); // volume vs mass
  const c = computeProductBuildCost(1, db);
  check('unreconciled unit: unitCost is null (blocked)', c.unitCost, null);
  check('unreconciled unit: counted on its own counter', c.unreconciledUnitLines, 1);
  check('unreconciled unit: NOT double-counted as a zeroCostLine too', c.zeroCostLines, 0);
  db.close();
}

// 6 · free_by_design contributes a real zero and does not block.
{
  const db = makeDb();
  seedMaterial(db, { id: 1, name_en: 'Priced', unit: 'g', cpu: 0.10 });
  seedMaterial(db, { id: 2, name_en: 'Water (free by design)', unit: 'g', cpu: 0, free: true });
  seedLine(db, { product_id: 1, ingredient_id: 1, qty: 100 });
  seedLine(db, { product_id: 1, ingredient_id: 2, qty: 200 });
  const c = computeProductBuildCost(1, db);
  check('free line: unitCost is a real number, not blocked', c.unitCost, 10);
  check('free line: does not count as a zeroCostLine', c.zeroCostLines, 0);
  db.close();
}

// 7 · every line free_by_design — a genuine zero, distinct from "unknown".
{
  const db = makeDb();
  seedMaterial(db, { id: 1, name_en: 'Free', unit: 'g', cpu: 0, free: true });
  seedLine(db, { product_id: 1, ingredient_id: 1, qty: 500 });
  const c = computeProductBuildCost(1, db);
  check('all-free list: hasBuildList true', c.hasBuildList, true);
  check('all-free list: unitCost is a real 0, not null', c.unitCost, 0);
  db.close();
}

// 8 · a line with no ingredient_id at all (material later deleted, or never
//    picked) is treated the same as unpriced — blocks the whole product.
{
  const db = makeDb();
  seedLine(db, { product_id: 1, ingredient_id: null, qty: 1, unit: 'pcs' });
  const c = computeProductBuildCost(1, db);
  check('no-ingredient line: hasBuildList true (a row exists)', c.hasBuildList, true);
  check('no-ingredient line: unitCost is null (blocked)', c.unitCost, null);
  db.close();
}

// 9 · id-form and rows-form agree — same parity computeRecipeCost's two call
//    shapes hold, proven directly rather than assumed.
{
  const db = makeDb();
  seedMaterial(db, { id: 1, name_en: 'M', unit: 'g', cpu: 0.30 });
  seedLine(db, { product_id: 1, ingredient_id: 1, qty: 200 });
  const viaId = computeProductBuildCost(1, db);
  const rows = db.prepare(`SELECT pbl.*, i.cost_per_unit AS master_cost, i.unit AS master_unit,
         i.free_by_design AS master_free, i.name_en AS master_name_en
    FROM product_build_lines pbl LEFT JOIN ingredients i ON pbl.ingredient_id = i.id
   WHERE pbl.product_id = 1 ORDER BY pbl.sort_order`).all();
  const viaRows = computeProductBuildCost({ lines: rows });
  check('id-form and rows-form agree on unitCost', viaId.unitCost, viaRows.unitCost);
  check('id-form and rows-form agree on ingredientLines', viaId.ingredientLines, viaRows.ingredientLines);
  db.close();
}

console.log();
if (failures) { console.log(`${failures} case(s) behaved wrongly.`); process.exit(1); }
console.log('All product build cost cases behaved as specified.');
