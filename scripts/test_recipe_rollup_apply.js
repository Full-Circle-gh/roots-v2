#!/usr/bin/env node
/**
 * test_recipe_rollup_apply.js — does applyRollup() (the function every live
 * trigger point calls) actually write, write ONLY what it should, and stay
 * inert when nothing moved?
 *
 * scripts/test_recipe_rollup.js already proves planRollup's arithmetic and
 * ordering are correct — this file does not re-check that. It proves the
 * write half: the thing a trigger site actually calls, and the three
 * specific failure modes named in the brief for §29 step 3:
 *
 *   1. a trigger that never fires               (stale cost, caught by comparing
 *                                                 "before applyRollup" to "after")
 *   2. a trigger that walks the wrong direction  (upstream/raw writes, caught by
 *                                                 asserting raw ingredients and the
 *                                                 recipes table are untouched)
 *   3. a trigger that fires on a linked          (caught by asserting applyRollup
 *      ingredient's own cost write               ignores whatever a linked row's
 *      (self-referential)                        own stored cost currently says)
 *
 * Plus: the zero-delta requirement itself (an already-correct graph is a
 * true no-op) and the cycle refusal (nothing written, ever).
 *
 * In-memory fixture only. No real database, no network.
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
const { applyRollup, backsLinkedMaterial, applyProductBuildCosts, applyProductCosts } =
  require(path.join(__dirname, '..', 'lib', 'recipe-rollup'));
const { computeRecipeCost } = require(path.join(__dirname, '..', 'lib', 'recipe-cost'));

// Same shape as scripts/test_recipe_rollup.js's fixture, plus `updated_at` so
// "was this row touched" is checkable without relying on the value alone.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE recipes (
      id INTEGER PRIMARY KEY, name_en TEXT, sku TEXT, category TEXT,
      batch_size REAL, servings INTEGER, is_active INTEGER DEFAULT 1);
    CREATE TABLE ingredients (
      id INTEGER PRIMARY KEY, name_en TEXT, name_cn TEXT, sku TEXT, unit TEXT DEFAULT 'g',
      cost_per_unit REAL DEFAULT 0, free_by_design INTEGER DEFAULT 0,
      -- §29's second addendum, settled 2026-08-27: how much of a made
      -- material's cost is overhead its own recipe added, so a parent can
      -- leave it out of its own overhead base.
      overhead_per_unit REAL DEFAULT 0,
      source_recipe_id INTEGER, is_active INTEGER DEFAULT 1, updated_at TEXT);
    CREATE TABLE recipe_ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT, recipe_id INTEGER, ingredient_id INTEGER,
      name_en TEXT, name_cn TEXT, sku TEXT, qty REAL, unit TEXT DEFAULT 'g', sort_order INTEGER DEFAULT 0);
    CREATE TABLE recipe_cost_data (
      recipe_id INTEGER PRIMARY KEY, labour REAL DEFAULT 0, packaging REAL DEFAULT 0,
      overhead_pct REAL DEFAULT 0, sell_price REAL DEFAULT 0, target_food_cost REAL DEFAULT 30,
      updated_at DATETIME);
    -- Step 2, docs/tacet-product-build-lines-design.md. store_products kept
    -- minimal but must match every column loadLinkedProducts() SELECTs
    -- (including sku) — omitting one doesn't fail loudly, it makes that
    -- query throw, which loadLinkedProducts()'s own try/catch reads as "no
    -- storefront" and silently returns [], masking whatever this fixture
    -- meant to test. Found exactly this way while writing case 14 below.
    CREATE TABLE store_products (
      id INTEGER PRIMARY KEY, name_en TEXT, sku TEXT, recipe_id INTEGER, unit_cost REAL,
      is_active INTEGER DEFAULT 1, updated_at TEXT);
    CREATE TABLE product_build_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, ingredient_id INTEGER,
      name_en TEXT, name_cn TEXT, sku TEXT, qty REAL, unit TEXT DEFAULT 'g',
      notes TEXT, sort_order INTEGER DEFAULT 0);
    -- lib/features.js's productionEnabled() reads this; absent = defaults to
    -- ON, so most cases below need no row here at all — only the
    -- "not gated" case sets one explicitly.
    CREATE TABLE storefront_config (key TEXT PRIMARY KEY, value_json TEXT);
  `);
  return db;
}
function seedProduct(db, { id, recipe_id, unit_cost, active }) {
  db.prepare('INSERT INTO store_products (id,name_en,recipe_id,unit_cost,is_active) VALUES (?,?,?,?,?)')
    .run(id, 'Product ' + id, recipe_id == null ? null : recipe_id, unit_cost == null ? null : unit_cost,
         active === undefined ? 1 : active);
}
function seedBuildLine(db, { product_id, ingredient_id, qty, unit, sort_order }) {
  db.prepare('INSERT INTO product_build_lines (product_id,ingredient_id,name_en,qty,unit,sort_order) VALUES (?,?,?,?,?,?)')
    .run(product_id, ingredient_id == null ? null : ingredient_id, 'line', qty, unit || 'g', sort_order || 0);
}
const productRow = (db, id) => db.prepare('SELECT * FROM store_products WHERE id = ?').get(id);
function seed(db, { recipes = [], materials = [], lines = [] }) {
  const r = db.prepare('INSERT INTO recipes (id,name_en,batch_size,is_active) VALUES (?,?,?,?)');
  const m = db.prepare("INSERT INTO ingredients (id,name_en,unit,cost_per_unit,source_recipe_id,updated_at) VALUES (?,?,?,?,?,'seed')");
  const l = db.prepare('INSERT INTO recipe_ingredients (recipe_id,ingredient_id,name_en,qty,unit,sort_order) VALUES (?,?,?,?,?,?)');
  for (const [id, batch, active] of recipes) r.run(id, 'Recipe ' + id, batch, active === undefined ? 1 : active);
  for (const [id, cpu, src] of materials) m.run(id, 'Material ' + id, 'g', cpu, src === undefined ? null : src);
  let i = 0;
  for (const [rid, iid, qty] of lines) l.run(rid, iid, 'line', qty, 'g', i++);
  return db;
}
const ingRow = (db, id) => db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);

let failures = 0;
function check(label, actual, expected, detail) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${detail ? ' — ' + detail : ''}`);
  else if (detail) console.log(`        ${detail}`);
}

// ── 1 · "never fires" — a stale graph stays stale until applyRollup runs ───
// R1 makes M10 from 200g raw M99. Bump M99's price DIRECTLY (as a guarded
// writer's own UPDATE would, before it calls fireRecompute) and confirm M10
// stays at its old, now-wrong value until applyRollup is actually called.
// This is the exact failure mode a trigger site that forgets to call
// applyRollup would produce, made visible.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100]],
    materials: [[99, 0.5, null], [10, 1.0, 1]], // M10 currently 1.0/g (matches old M99 price)
    lines: [[1, 99, 200]],
  });
  db.prepare('UPDATE ingredients SET cost_per_unit = 1.0, updated_at = ? WHERE id = 99').run('raw-price-bump');
  check('before recompute: linked material is stale', ingRow(db, 10).cost_per_unit, 1.0,
        '200g x 1.0 = 200/100g = 2.0/g is the true cost now, but nothing has run yet');

  const result = applyRollup(db, { source: 'test' });
  check('applyRollup reports it fired', result.applied, true);
  check('after recompute: linked material now correct', ingRow(db, 10).cost_per_unit, 2.0,
        '200g x 1.0 = 200 / 100g batch = 2.0/g');
  db.close();
}

// ── 2 · fires and walks DOWNSTREAM, transitively (2 levels) ────────────────
// R1 makes M10 from raw M99. R2 makes M20 from M10. Move M99's price and
// confirm BOTH M10 and M20 update in one applyRollup call, in the right
// direction (downstream), not just the immediate consumer.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100], [2, 100]],
    materials: [[99, 0.5, null], [10, 1.0, 1], [20, 0.5, 2]],
    lines: [[1, 99, 200], [2, 10, 50]],
  });
  db.prepare("UPDATE ingredients SET cost_per_unit = 1.0, updated_at = 'raw-bump' WHERE id = 99").run();
  const result = applyRollup(db, { source: 'test' });
  check('transitive: level-1 material recomputed', ingRow(db, 10).cost_per_unit, 2.0, '200g x 1.0 / 100g = 2.0/g');
  check('transitive: level-2 material recomputed off the NEW level-1 cost', ingRow(db, 20).cost_per_unit, 1.0, '50g x 2.0 / 100g = 1.0/g');
  check('written count covers both', result.written, 2);
  db.close();
}

// ── 3 · "wrong direction" — never writes a raw (unlinked) ingredient ───────
// Even though the raw material's price is what moved the whole graph, it is
// never itself in planRollup's change set (loadLinkedMaterials only reads
// source_recipe_id IS NOT NULL rows) — applyRollup's UPDATE is compounded on
// `source_recipe_id = ?`, which can never match a NULL. Assert the raw row's
// cost AND updated_at are byte-for-byte untouched by the call.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100]],
    materials: [[99, 0.5, null], [10, 1.0, 1]],
    lines: [[1, 99, 200]],
  });
  db.prepare("UPDATE ingredients SET cost_per_unit = 1.0, updated_at = 'raw-bump' WHERE id = 99").run();
  const before = ingRow(db, 99);
  applyRollup(db, { source: 'test' });
  const after = ingRow(db, 99);
  check('raw ingredient cost is untouched by applyRollup', after.cost_per_unit, before.cost_per_unit);
  check('raw ingredient updated_at is untouched (not re-stamped)', after.updated_at, before.updated_at, 'proves no UPDATE statement even matched this row');
  db.close();
}

// ── 3b · "wrong direction" — never writes the `recipes` table ──────────────
// applyRollup only ever issues `UPDATE ingredients ...`. Snapshot every
// recipes row before and after a real recompute pass and require byte
// equality — this is also what makes recursion into the recipe-save
// triggers (routes/recipes.js) structurally impossible: those fire on writes
// to `recipes`/`recipe_cost_data`, and applyRollup never produces one.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100], [2, 100]],
    materials: [[99, 0.5, null], [10, 1.0, 1], [20, 0.5, 2]],
    lines: [[1, 99, 200], [2, 10, 50]],
  });
  db.prepare("UPDATE ingredients SET cost_per_unit = 1.0, updated_at = 'raw-bump' WHERE id = 99").run();
  const before = JSON.stringify(db.prepare('SELECT * FROM recipes ORDER BY id').all());
  applyRollup(db, { source: 'test' });
  const after = JSON.stringify(db.prepare('SELECT * FROM recipes ORDER BY id').all());
  check('the recipes table is never written by applyRollup', after, before,
        'no recipes-table write means no path back into the recipe-save trigger points — structurally, not by convention');
  db.close();
}

// ── 4 · self-referential — a linked material's OWN stored cost is ignored ──
// Simulates the guard failing (or being bypassed some other way) and a
// linked row's cost_per_unit getting hand-set to a wrong number directly.
// applyRollup must derive M10's cost from R1's recipe ONLY, never read or
// preserve whatever M10.cost_per_unit currently holds — so the wrong number
// is overwritten, not amplified or left alone.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100]],
    materials: [[99, 0.5, null], [10, 999, 1]], // M10 hand-set to a bogus 999
    lines: [[1, 99, 200]],
  });
  const result = applyRollup(db, { source: 'test' });
  check('a linked material self-write is corrected, not trusted', ingRow(db, 10).cost_per_unit, 1.0,
        'derived purely from R1 (200g x 0.5 / 100g), the bogus 999 is never read');
  check('this reads as a normal change, not a special self-reference path', result.written, 1);
  db.close();
}

// ── 5 · zero-delta — an already-correct graph is a true no-op ──────────────
// The gate the deploy itself must pass: running applyRollup against a graph
// that already matches must write nothing and leave updated_at alone.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100]],
    materials: [[99, 0.5, null], [10, 1.0, 1]], // already correct: 200x0.5/100=1.0
    lines: [[1, 99, 200]],
  });
  const before = ingRow(db, 10);
  const result = applyRollup(db, { source: 'test' });
  const after = ingRow(db, 10);
  check('nothing written on an already-correct graph', result.written, 0);
  check('cost_per_unit literally unchanged', after.cost_per_unit, before.cost_per_unit);
  check('updated_at NOT re-stamped (a true no-op, not a same-value rewrite)', after.updated_at, before.updated_at,
        'a recompute firing after deploy with no data change must be invisible');
  db.close();
}

// ── 6 · a cycle refuses the whole pass — writes nothing ────────────────────
{
  const db = seed(makeDb(), {
    recipes: [[1, 100], [2, 100]],
    materials: [[10, 0, 1], [20, 0, 2]],
    lines: [[1, 20, 10], [2, 10, 10]],
  });
  const before10 = ingRow(db, 10).cost_per_unit, before20 = ingRow(db, 20).cost_per_unit;
  const result = applyRollup(db, { source: 'test' });
  check('a cycle is not applied', result.applied, false);
  check('a cycle is reported, not swallowed', result.reason, 'cycle');
  check('nothing written for M10 on a cycle', ingRow(db, 10).cost_per_unit, before10);
  check('nothing written for M20 on a cycle', ingRow(db, 20).cost_per_unit, before20);
  db.close();
}

// ── 7 · blocked materials stay frozen, never zeroed, through applyRollup ───
// (planRollup already proves the plan marks these blocked — this proves the
// WRITE half respects that: nothing lands in the database for them.)
{
  const db = seed(makeDb(), {
    recipes: [[1, 100], [2, 0]], // R2 has no batch_size -> blocked
    materials: [[99, 0.5, null], [10, 1.0, 1], [20, 7, 2]],
    lines: [[1, 99, 200], [2, 10, 50]],
  });
  const before20 = ingRow(db, 20).cost_per_unit;
  applyRollup(db, { source: 'test' });
  check('blocked material keeps its old cost, not zeroed', ingRow(db, 20).cost_per_unit, before20);
  check("blocked material's updated_at is not re-stamped", ingRow(db, 20).updated_at, 'seed');
  db.close();
}

// ── 8 · better-sqlite3 nests applyRollup as a SAVEPOINT ────────────────────
// routes/admin.js repair-items calls applyRollup from inside its OWN
// db.transaction(). Confirm that composition works: calling applyRollup from
// inside an outer transaction still writes correctly and commits together.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100]],
    materials: [[99, 0.5, null], [10, 1.0, 1]],
    lines: [[1, 99, 200]],
  });
  db.prepare("UPDATE ingredients SET cost_per_unit = 1.0, updated_at = 'raw-bump' WHERE id = 99").run();
  const outer = db.transaction(() => {
    db.prepare("UPDATE ingredients SET name_en = 'renamed' WHERE id = 99").run();
    return applyRollup(db, { source: 'nested-test' });
  });
  const result = outer();
  check('nested applyRollup still applies', result.applied, true);
  check('nested applyRollup still writes the recomputed cost', ingRow(db, 10).cost_per_unit, 2.0);
  check("outer transaction's own write also committed", ingRow(db, 99).name_en, 'renamed');
  db.close();
}

// ── 9 · the compound WHERE is what makes a mismatch loud, not silent ───────
// applyRollup always re-plans fresh at write time (same synchronous call, no
// window for the table to move underneath it), so the row-count throw is a
// defence-in-depth belt rather than something normal operation can trip —
// there is no way to hand applyRollup a stale external plan. What IS testable
// directly is the mechanism the throw relies on: the compound
// `WHERE id = ? AND source_recipe_id = ?` match. Prove that when a
// (ingredient, recipe) pair no longer holds — the one way this can happen at
// all, a material getting unlinked between two separate reads — the UPDATE
// matches ZERO rows rather than the wrong row. That changes:0 signal is
// exactly what applyRollup's `r.changes !== 1` check turns into a throw
// instead of a silent no-op or a write to an unrelated ingredient.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100]],
    materials: [[99, 0.5, null], [10, 1.0, 1]],
    lines: [[1, 99, 200]],
  });
  db.prepare('UPDATE ingredients SET source_recipe_id = NULL WHERE id = 10').run(); // unlinked between reads
  const upd = db.prepare('UPDATE ingredients SET cost_per_unit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND source_recipe_id = ?');
  const r = upd.run(2.0, 10, 1);
  check('a stale (ingredient, recipe) pair matches zero rows, not the wrong row', r.changes, 0,
        'applyRollup treats r.changes !== 1 as throw-worthy rather than writing silently');
  db.close();
}

// ── 10 · backsLinkedMaterial — the gate the recipe-save trigger points use ─
{
  const db = seed(makeDb(), {
    recipes: [[1, 100], [2, 100]],
    materials: [[99, 0.5, null], [10, 1.0, 1]], // only recipe 1 backs a material
    lines: [[1, 99, 200]],
  });
  check('recipe backing a linked material: true', backsLinkedMaterial(db, 1), true);
  check('ordinary recipe nothing points at: false', backsLinkedMaterial(db, 2), false);
  check('recipe id with no rows at all: false', backsLinkedMaterial(db, 999), false);
  db.close();
}

// ── 11 · a build-line product recomputes through the SAME trigger network ──
// docs/tacet-product-build-lines-design.md §3's central claim: no new call
// site needed anywhere, because applyProductBuildCosts() runs inside
// applyRollup() exactly the way applyProductCosts() already does. Prove it
// by bumping a raw material's price the same way any of the eight live
// trigger points do (routes/ingredients.js, routes/purchases.js, etc. — a
// direct UPDATE before calling fireRecompute) and confirming a product whose
// build list contains that material picks up the new figure from a single
// applyRollup() call, with no build-list-specific trigger call anywhere in
// this test.
{
  const db = seed(makeDb(), { recipes: [[1, 100]], materials: [[50, 0.10, null]] });
  seedProduct(db, { id: 200, unit_cost: null });
  seedBuildLine(db, { product_id: 200, ingredient_id: 50, qty: 250 }); // 250g @ 0.10/g = 25.0
  const result = applyRollup(db, { source: 'test-build-line-recompute' });
  check('build-line product: applyRollup reports it applied', result.applied, true);
  check('build-line product: buildProductsWritten counts it', result.buildProductsWritten, 1);
  check('build-line product: unit_cost written from the build list', productRow(db, 200).unit_cost, 25);

  db.prepare("UPDATE ingredients SET cost_per_unit = 0.20, updated_at = 'raw-bump' WHERE id = 50").run();
  const second = applyRollup(db, { source: 'test-build-line-recompute-2' });
  check('build-line product: a raw material price bump recomputes it', productRow(db, 200).unit_cost, 50,
        'same trigger a live cpuMoved guard would fire, no new call site');
  check('build-line product: second pass still reports written', second.buildProductsWritten, 1);
  db.close();
}

// ── 12 · a blocked build list CLEARS the stored figure ────────────────────
// REVERSED 2026-08-27, deliberately. This case previously asserted that a
// blocked list leaves the prior figure alone, mirroring the recipe writer's
// "blocked writes nothing, never 0 or null". That was wrong HERE and the
// difference is ownership, not arithmetic: applyProductCosts() now skips any
// product with a build list, so whatever sits in unit_cost came from a source
// that has been retired for that product. Left alone it FREEZES — the recipe
// writer skips it, this writer refuses it, and nothing ever corrects it.
//
// Found live: product 23 (Hazelnut-Chocolate Spread) held ¥46.05 from recipe
// 64 while its build list carried packaging only and one unpriced line, and
// the Products list went on reporting a 48.3% margin off the orphaned figure.
// §31 rule 9 — unknown is not zero, and unknown must be VISIBLE.
{
  const db = seed(makeDb(), { recipes: [] });
  seedProduct(db, { id: 201, unit_cost: 12.5 }); // a figure from the retired source
  seedBuildLine(db, { product_id: 201, ingredient_id: 999, qty: 1, unit: 'pcs' }); // no such material
  const result = applyRollup(db, { source: 'test-build-line-blocked' });
  check('blocked build list: buildProductsBlocked counts it', result.buildProductsBlocked, 1);
  check('blocked build list: buildProductsWritten does not', result.buildProductsWritten, 0);
  check('blocked build list: the orphaned figure is CLEARED, not frozen', productRow(db, 201).unit_cost, null);
  check('blocked build list: the clear is reported', result.buildProductsCleared, 1);
  db.close();
}

// ── 12b · clearing is idempotent, and does not churn an already-null row ──
// The guard matters because applyRollup fires on every material price change:
// a blocked product must not rewrite (and re-stamp updated_at on) a row that
// is already null, every single pass, forever.
{
  const db = seed(makeDb(), { recipes: [] });
  seedProduct(db, { id: 202, unit_cost: null });
  seedBuildLine(db, { product_id: 202, ingredient_id: 999, qty: 1, unit: 'pcs' });
  const result = applyRollup(db, { source: 'test-build-line-blocked-already-null' });
  check('already-null blocked product: still counted blocked', result.buildProductsBlocked, 1);
  check('already-null blocked product: nothing cleared, no needless write', result.buildProductsCleared, 0);
  check('already-null blocked product: stays null', productRow(db, 202).unit_cost, null);
  db.close();
}

// ── 12c · a list that UNBLOCKS writes the real figure over the cleared one ─
// The reason clearing is safe: the number was never data, it was derived, and
// it comes straight back the moment the blocking line can be priced.
{
  const db = seed(makeDb(), { recipes: [], materials: [[50, 0.10, null]] });
  seedProduct(db, { id: 203, unit_cost: 99.0 });
  seedBuildLine(db, { product_id: 203, ingredient_id: 999, qty: 1, unit: 'pcs' }); // blocks
  applyRollup(db, { source: 'test-unblock-step1' });
  check('unblock: cleared while blocked', productRow(db, 203).unit_cost, null);
  // Point the line at a real, priced material — the operator setting the cost.
  db.prepare('UPDATE product_build_lines SET ingredient_id = 50, qty = 250, unit = ? WHERE product_id = 203').run('g');
  const r2 = applyRollup(db, { source: 'test-unblock-step2' });
  check('unblock: the real figure is written', productRow(db, 203).unit_cost, 25);
  check('unblock: reported as written, not cleared', r2.buildProductsWritten, 1);
  db.close();
}

// ── 13 · material-linked AND build-line products both update in ONE pass ──
// The design doc's "same transaction" claim, proven directly: a single
// applyRollup() call moves a recipe-linked material's cost, a product that
// takes its cost from that recipe, AND an unrelated build-line product, all
// from one raw material price change.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100]],                        // batch_size 100 — same shape as case 8
    materials: [[99, 0.5, null], [10, 1.0, 1]],  // recipe 1 makes material 10
    lines: [[1, 99, 200]],                       // recipe 1 consumes 200g of raw material 99
  });
  seedProduct(db, { id: 300, recipe_id: 1, unit_cost: null }); // recipe-linked product — untouched by this PR
  seedProduct(db, { id: 301, unit_cost: null }); // build-line product
  seedBuildLine(db, { product_id: 301, ingredient_id: 99, qty: 100 }); // 100g @ raw material 99's price
  db.prepare("UPDATE ingredients SET cost_per_unit = 1.0, updated_at = 'raw-bump' WHERE id = 99").run();
  const result = applyRollup(db, { source: 'test-both-writers-one-pass' });
  // Same arithmetic as case 8: 200g @ 1.0/g = 200 ingredientCost, /100 batch_size = 2.0/g.
  check('one pass: linked material recomputed', ingRow(db, 10).cost_per_unit, 2.0);
  check('one pass: build-line product written', productRow(db, 301).unit_cost, 100, '100g @ 1.0/g raw material = 100');
  check('one pass: both counted in the SAME result object', result.buildProductsWritten >= 1 && result.written >= 1, true, JSON.stringify(result));
  db.close();
}

// ── 14 · applyProductBuildCosts is NOT gated by productionEnabled — §31 rule 7 ──
// Unlike applyProductCosts() (recipe-based), a build list must keep working
// with Production switched OFF, because §31 rule 7 requires it to reach a
// tenant with no kitchen at all. Prove the two writers actually diverge on
// the identical database, not just that neither happens to be exercised.
{
  const db = seed(makeDb(), { recipes: [[1, 100]], materials: [[99, 0.5, null], [10, 1.0, 1]] });
  db.prepare("INSERT INTO storefront_config (key, value_json) VALUES ('features.production', 'false')").run();
  seedProduct(db, { id: 400, recipe_id: 1, unit_cost: null });   // recipe-based — should be SKIPPED
  seedProduct(db, { id: 401, unit_cost: null });                  // build-line — should NOT be skipped
  seedBuildLine(db, { product_id: 401, ingredient_id: 99, qty: 100 }); // 100g @ 0.5/g = 50
  const result = applyRollup(db, { source: 'test-production-off' });
  check('production off: recipe-based product is skipped, not written', productRow(db, 400).unit_cost, null);
  check('production off: recipe-based skip is reported', result.productsSkippedProductionOff > 0, true);
  check('production off: build-line product IS written anyway (§31 rule 7)', productRow(db, 401).unit_cost, 50);
  db.close();
}

// ── 15 · loadBuildListProducts / applyProductBuildCosts alone, no table ────
// A handle predating this migration (every fixture above the fold in this
// file, and every existing test in this repo) must not crash a caller that
// invokes applyProductBuildCosts() directly, mirroring loadLinkedProducts()'s
// own established defence.
{
  const bareDb = new Database(':memory:');
  bareDb.exec('CREATE TABLE ingredients (id INTEGER PRIMARY KEY)'); // deliberately no store_products, no product_build_lines
  let threw = false;
  let result = null;
  try { result = applyProductBuildCosts(bareDb); } catch (e) { threw = true; }
  check('no product_build_lines table: does not throw', threw, false);
  check('no product_build_lines table: reads as nothing to cost', result && result.written === 0 && result.blocked === 0, true, JSON.stringify(result));
  bareDb.close();
}

// ── 16 · §31's addendum ENFORCED — a product with BOTH a recipe_id and a
// build list takes its cost from the build list, and applyProductCosts()
// leaves it alone ENTIRELY. This is the fix requested after PR #122's
// review: the skip must be a condition stated inside applyProductCosts()
// (productIdsWithBuildLines()), not an accident of which of the two writers
// applyRollup() happens to call second — a reader who reorders those two
// calls must get the identical answer.
//
// Proven by giving the recipe a REAL, positive, correctly-derivable cost —
// batch_size, servings, a priced ingredient line, no recipe_cost_data
// oddities — that WOULD have been written if the skip weren't real. A test
// that only checked "no error was thrown" could pass even if the skip did
// nothing at all; asserting the stored value equals the build list's figure
// (15) and NOT the recipe's (10) is what actually proves precedence.
{
  const db = seed(makeDb(), { materials: [[99, 1.0, null], [88, 0.30, null]] });
  // Not using seed()'s recipes tuple — it has no servings slot, and a null
  // servings recipe always yields costPerServing: null (blocked) regardless
  // of this fix, which would prove nothing. Direct INSERT for full control.
  db.prepare('INSERT INTO recipes (id,name_en,batch_size,servings,is_active) VALUES (1,?,100,10,1)').run('Recipe 1');
  db.prepare("INSERT INTO recipe_ingredients (recipe_id,ingredient_id,name_en,qty,unit,sort_order) VALUES (1,99,'line',100,'g',0)").run();
  seedProduct(db, { id: 500, recipe_id: 1, unit_cost: null });
  seedBuildLine(db, { product_id: 500, ingredient_id: 88, qty: 50, unit: 'g' }); // 50g @ 0.30/g = 15.0

  // Setup sanity — confirm the recipe ALONE really would produce a real,
  // different, positive cost. If this assertion fails, the test below would
  // pass for the wrong reason (both sources agreeing, or the recipe being
  // blocked anyway) rather than proving the skip.
  const wouldHaveBeen = computeRecipeCost(1, db);
  check('setup sanity: the recipe alone yields a real cost the skip must override', wouldHaveBeen.costPerServing, 10);

  const result = applyRollup(db, { source: 'test-build-list-wins-over-recipe' });
  check('both sources on one product: unit_cost is the BUILD LIST figure (15), not the recipe (10)', productRow(db, 500).unit_cost, 15);
  check('both sources: applyProductCosts reports the skip explicitly', result.productsSkippedHasBuildList, 1);
  check('both sources: applyProductCosts wrote nothing for this product', result.productsWritten, 0);
  check('both sources: applyProductBuildCosts is the one that actually wrote it', result.buildProductsWritten, 1);

  // Reordering the two calls must not change the answer — the guarantee
  // lives inside applyProductCosts() itself, not in applyRollup()'s call
  // order. Prove it by calling applyProductCosts() a second time, alone,
  // directly, after applyProductBuildCosts() already ran.
  const direct = applyProductCosts(db);
  check('calling applyProductCosts() alone, after the fact, still skips it', direct.skippedHasBuildList, 1);
  check('and still leaves the build-list-derived value in place', productRow(db, 500).unit_cost, 15);
  db.close();
}


// ── 17 · OVERHEAD DOES NOT COMPOUND (§29's second addendum) ───────────────
// A parent's rate applies to the FOOD cost of its lines, not to overhead a
// child already added. The child's overhead still counts in the parent's
// total — it just is not multiplied a second time.
//
// The graph, chosen so every figure is checkable by hand:
//   R1 makes M10 from 100g of raw M99 at 1.00/g, with overhead 50%.
//       ingredientCost 100, overhead 50% of 100 = 50, batch 150 over 100g
//       -> M10 costs 1.50/g, of which 0.50/g is overhead.
//   R2 consumes 100g of M10, with its own overhead 50%.
//       ingredientCost 150. Compounding would take 50% of 150 = 75.
//       NOT compounding takes 50% of (150 - 50 embedded) = 50.
//       So batch is 150 + 50 = 200, not 225.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100], [2, 100]],
    materials: [[99, 1.0, null], [10, 0, 1], [20, 0, 2]],
    lines: [[1, 99, 100]],
  });
  db.prepare('INSERT INTO recipe_ingredients (recipe_id,ingredient_id,name_en,qty,unit,sort_order) VALUES (2,10,?,100,?,0)').run('line', 'g');
  db.prepare('INSERT INTO recipe_cost_data (recipe_id,overhead_pct) VALUES (1,50)').run();
  db.prepare('INSERT INTO recipe_cost_data (recipe_id,overhead_pct) VALUES (2,50)').run();

  const r = applyRollup(db, { source: 'test-overhead-no-compound' });
  check('overhead: rollup applied', r.applied, true, JSON.stringify(r));

  const m10 = ingRow(db, 10);
  check('child material costs 1.50/g (100 food + 50 overhead over 100g)', m10.cost_per_unit, 1.5);
  check('and records 0.50/g of that as ITS overhead', m10.overhead_per_unit, 0.5);

  const m20 = ingRow(db, 20);
  // 150 food-in (incl. the child's 50 overhead) + 50 own overhead = 200 / 100g
  check('parent costs 2.00/g — NOT 2.25, which is what compounding gives', m20.cost_per_unit, 2);
  // Its own overhead share is 0.50/g; the child's 0.50/g is food to it, and is
  // NOT re-declared as overhead — otherwise a grandparent would exclude twice.
  check('parent records only ITS OWN 0.50/g as overhead', m20.overhead_per_unit, 0.5);
  db.close();
}

// ── 18 · the child's overhead is still IN the parent's total ─────────────
// The rule removes it from the BASE, never from the money. Same graph with the
// parent's rate at zero: the parent must still cost 1.50/g, carrying the
// child's overhead through untouched.
{
  const db = seed(makeDb(), {
    recipes: [[1, 100], [2, 100]],
    materials: [[99, 1.0, null], [10, 0, 1], [20, 0, 2]],
    lines: [[1, 99, 100]],
  });
  db.prepare('INSERT INTO recipe_ingredients (recipe_id,ingredient_id,name_en,qty,unit,sort_order) VALUES (2,10,?,100,?,0)').run('line', 'g');
  db.prepare('INSERT INTO recipe_cost_data (recipe_id,overhead_pct) VALUES (1,50)').run();
  applyRollup(db, { source: 'test-overhead-passthrough' });
  check('parent with no rate of its own still carries the child overhead', ingRow(db, 20).cost_per_unit, 1.5);
  check('and declares none of it as its own', ingRow(db, 20).overhead_per_unit, 0);
  db.close();
}

console.log();
if (failures) { console.log(`${failures} case(s) behaved wrongly.`); process.exit(1); }
console.log('All applyRollup/trigger cases behaved as specified.');
