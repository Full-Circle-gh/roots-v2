#!/usr/bin/env node
/**
 * test_recipe_versions.js — does a recipe's history actually let a change be
 * taken back, and does it stay a history worth reading?
 *
 * The Recipes record autosaves (public/retail-admin/19-recipes.js). That is only
 * safe because every save first files the state it displaced, so this file
 * covers the three properties that make the filing worth having:
 *
 *   1. A version is the state BEFORE the save, and restoring it puts back all
 *      four halves of the record — details, ingredient lines, steps and the
 *      manual cost inputs. A partial restore is the failure that matters most:
 *      a recipe whose lines and whose batch size came from different days is
 *      worse than no restore at all, because it looks fine.
 *
 *   2. Autosave does not drown it. A background save every second or two would
 *      file a hundred near-identical rows an hour and bury the one point anyone
 *      wants, so saves inside a window share one version — and the one KEPT is
 *      the OLDER, which is the restore point a person actually means. Cases 3
 *      and 4 are the reason COALESCE_MS exists; a version of this lib that
 *      filed unconditionally would pass case 1 and fail both.
 *
 *   3. A restore is itself undoable. The one thing a history panel must never
 *      be able to do is destroy the present.
 *
 * Case 7 covers the column-discovery rule: `substitutes` and `image_data`
 * arrived through database.js's addColumn long after these tables were first
 * written, so a tenant DB can legitimately be missing them and neither the
 * snapshot nor the restore may 500 over one.
 *
 * In-memory fixture only. No real database, no HTTP, no app modules beyond the
 * two libs under test — the writes are called directly.
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
const V = require(path.join(__dirname, '..', 'lib', 'recipe-versions'));
const { saveRecipeCostData } = require(path.join(__dirname, '..', 'lib', 'recipe-cost-data-write'));

// The four tables the snapshot spans, as schema.sql declares them (plus the
// columns database.js adds later). `withLateColumns: false` builds the older
// shape a tenant DB provisioned before those migrations still has.
function makeDb(opts) {
  const late = !opts || opts.withLateColumns !== false;
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_en TEXT NOT NULL, name_cn TEXT, sku TEXT UNIQUE, category TEXT,
      batch_size REAL, servings INTEGER, serving_size REAL,
      shelf_life TEXT, storage TEXT, notes TEXT,
      recipe_type TEXT DEFAULT 'made', is_active INTEGER DEFAULT 1,
      ${late ? 'image_data TEXT,' : ''}
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE recipe_ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL, ingredient_id INTEGER,
      name_en TEXT NOT NULL, name_cn TEXT, sku TEXT,
      qty REAL NOT NULL, unit TEXT DEFAULT 'g', notes TEXT,
      ${late ? 'substitutes TEXT,' : ''}
      sort_order INTEGER DEFAULT 0);
    CREATE TABLE recipe_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL, step_number INTEGER NOT NULL,
      name TEXT, instructions TEXT);
    CREATE TABLE recipe_cost_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL UNIQUE,
      labour REAL DEFAULT 0, packaging REAL DEFAULT 0, packaging_type_id INTEGER,
      overhead_pct REAL DEFAULT 0, sell_price REAL DEFAULT 0,
      target_food_cost REAL DEFAULT 30,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  `);
  return db;
}

// Choco-Hazel Bars as the screenshot in the brief shows it: two lines, a step,
// and a cost row. Small enough to assert on line by line.
function seedRecipe(db) {
  db.prepare(`INSERT INTO recipes (name_en, name_cn, sku, category, batch_size, servings, notes)
    VALUES ('Choco-Hazel Bars', '榛子巧克力棒', 'CHB-1', 'Bars', 3800, 38, 'original')`).run();
  const id = 1;
  const ins = db.prepare(`INSERT INTO recipe_ingredients
    (recipe_id, ingredient_id, name_en, qty, unit, sort_order) VALUES (?,?,?,?,?,?)`);
  ins.run(id, 11, 'Hazelnuts', 1200, 'g', 0);
  ins.run(id, 12, 'Dark chocolate', 900, 'g', 1);
  db.prepare(`INSERT INTO recipe_steps (recipe_id, step_number, name, instructions)
    VALUES (?, 1, 'Roast', 'Roast the hazelnuts at 160C')`).run(id);
  saveRecipeCostData(db, id, { labour: 40, packaging: 0, overhead_pct: 10, sell_price: 47, target_food_cost: 30 });
  return id;
}

const linesOf = (db, id) =>
  db.prepare('SELECT name_en, qty, unit FROM recipe_ingredients WHERE recipe_id = ? ORDER BY sort_order').all(id);
const recipeOf = (db, id) => db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
const costOf = (db, id) => db.prepare('SELECT * FROM recipe_cost_data WHERE recipe_id = ?').get(id);
const versionCount = (db, id) =>
  db.prepare('SELECT COUNT(*) n FROM recipe_versions WHERE recipe_id = ?').get(id).n;

// A save, as the routes make it: file the displaced state, then write.
function save(db, id, changes, opts) {
  V.snapshotRecipe(db, id, opts || { source: 'manual' });
  if (changes.recipe) {
    const keys = Object.keys(changes.recipe);
    db.prepare(`UPDATE recipes SET ${keys.map(k => k + '=?').join(',')} WHERE id = ?`)
      .run(...keys.map(k => changes.recipe[k]), id);
  }
  if (changes.ingredients) {
    db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(id);
    const ins = db.prepare(
      'INSERT INTO recipe_ingredients (recipe_id, ingredient_id, name_en, qty, unit, sort_order) VALUES (?,?,?,?,?,?)');
    changes.ingredients.forEach((l, i) => ins.run(id, l.ingredient_id || null, l.name_en, l.qty, l.unit || 'g', i));
  }
  if (changes.steps) {
    db.prepare('DELETE FROM recipe_steps WHERE recipe_id = ?').run(id);
    const ins = db.prepare('INSERT INTO recipe_steps (recipe_id, step_number, name, instructions) VALUES (?,?,?,?)');
    changes.steps.forEach((s, i) => ins.run(id, i + 1, s.name || null, s.instructions || null));
  }
  if (changes.costData) saveRecipeCostData(db, id, changes.costData);
}

// Rewrite a filed version's clock, so the coalescing windows can be exercised
// without the test sleeping through them.
function ageVersion(db, versionId, secondsAgo) {
  db.prepare("UPDATE recipe_versions SET created_at = datetime('now', ?) WHERE id = ?")
    .run(`-${secondsAgo} seconds`, versionId);
}

let failures = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected)
    || (typeof actual === 'number' && typeof expected === 'number' && Math.abs(actual - expected) < 1e-9)
    || (typeof actual === 'object' && typeof expected === 'object'
        && JSON.stringify(actual) === JSON.stringify(expected));
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${ok ? '' : `  — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

// ── 1. A version is the state BEFORE the save ────────────────────────────────
console.log('\n1. The filed version holds what the save displaced, not what it wrote');
{
  const db = makeDb();
  const id = seedRecipe(db);
  save(db, id, { recipe: { batch_size: 9999 } });
  const v = V.listVersions(db, id)[0];
  const full = V.getVersion(db, id, v.id);
  check('one version filed', versionCount(db, id), 1);
  check('version holds the OLD batch size', full.snapshot.recipe.batch_size, 3800);
  check('the recipe holds the new one', recipeOf(db, id).batch_size, 9999);
  check('summary columns are filled for the list', v.line_count, 2);
}

// ── 2. Restore puts back all four halves ─────────────────────────────────────
// The failure this guards is a restore that brings the details back and leaves
// yesterday's ingredient lines in place — a recipe that looks restored and is
// not. Every part of the record is changed here before restoring, so a
// half-restore cannot pass.
console.log('\n2. Restore puts back details, lines, steps AND cost inputs');
{
  const db = makeDb();
  const id = seedRecipe(db);
  save(db, id, {
    recipe: { name_en: 'Choco-Hazel Bars v2', batch_size: 4200, notes: 'reworked' },
    ingredients: [{ ingredient_id: 11, name_en: 'Hazelnuts', qty: 1500, unit: 'g' }],
    steps: [{ name: 'Temper', instructions: 'Temper the chocolate' }],
    costData: { labour: 90, packaging: 0, overhead_pct: 25, sell_price: 60, target_food_cost: 30 },
  });
  const v = V.listVersions(db, id)[0];
  const out = V.restoreVersion(db, id, v.id, { actor: 'test', saveCostData: saveRecipeCostData });
  check('restore reported ok', out.ok, true);
  check('nothing was held back', out.held.length, 0);
  const r = recipeOf(db, id);
  check('name restored', r.name_en, 'Choco-Hazel Bars');
  check('batch size restored', r.batch_size, 3800);
  check('notes restored', r.notes, 'original');
  check('both ingredient lines restored', linesOf(db, id).length, 2);
  check('the deleted line came back', linesOf(db, id)[1].name_en, 'Dark chocolate');
  check('the step came back', db.prepare('SELECT name FROM recipe_steps WHERE recipe_id = ?').get(id).name, 'Roast');
  check('labour restored', costOf(db, id).labour, 40);
  check('sell price restored', costOf(db, id).sell_price, 47);
}

// ── 3. Autosave does not drown the history ───────────────────────────────────
console.log('\n3. Autosaves inside the window share ONE version, and it is the older state');
{
  const db = makeDb();
  const id = seedRecipe(db);
  save(db, id, { recipe: { batch_size: 3900 } }, { source: 'auto' });
  save(db, id, { recipe: { batch_size: 4000 } }, { source: 'auto' });
  save(db, id, { recipe: { batch_size: 4100 } }, { source: 'auto' });
  check('three autosaves filed one version', versionCount(db, id), 1);
  const full = V.getVersion(db, id, V.listVersions(db, id)[0].id);
  check('and it is the state before the FIRST of them', full.snapshot.recipe.batch_size, 3800);
}

console.log('\n4. Once the window has passed, the next autosave files its own point');
{
  const db = makeDb();
  const id = seedRecipe(db);
  save(db, id, { recipe: { batch_size: 3900 } }, { source: 'auto' });
  ageVersion(db, V.listVersions(db, id)[0].id, 600);   // ten minutes ago
  save(db, id, { recipe: { batch_size: 4000 } }, { source: 'auto' });
  check('two points now', versionCount(db, id), 2);
  const list = V.listVersions(db, id);
  check('newest first', V.getVersion(db, id, list[0].id).snapshot.recipe.batch_size, 3900);
  check('oldest last', V.getVersion(db, id, list[1].id).snapshot.recipe.batch_size, 3800);
}

// The two requests one logical save makes (the recipe PUT and the cost PUT)
// must not read as two edits in the panel.
console.log('\n5. One manual save is one version, even though it is two requests');
{
  const db = makeDb();
  const id = seedRecipe(db);
  save(db, id, { recipe: { batch_size: 3900 } }, { source: 'manual' });
  V.snapshotRecipe(db, id, { source: 'manual' });          // the cost route's own call
  saveRecipeCostData(db, id, { labour: 55, sell_price: 47 });
  check('still one version', versionCount(db, id), 1);
}

// ── 6. A restore is itself undoable ──────────────────────────────────────────
console.log('\n6. Restoring files the present first, so the restore can be undone');
{
  const db = makeDb();
  const id = seedRecipe(db);
  save(db, id, { recipe: { batch_size: 9999 } }, { source: 'manual' });
  const old = V.listVersions(db, id)[0];
  V.restoreVersion(db, id, old.id, { saveCostData: saveRecipeCostData });
  check('batch size went back', recipeOf(db, id).batch_size, 3800);
  const afterRestore = V.listVersions(db, id);
  check('the restore filed a point of its own', afterRestore.length, 2);
  check('labelled as a restore', afterRestore[0].source, 'restore');
  V.restoreVersion(db, id, afterRestore[0].id, { saveCostData: saveRecipeCostData });
  check('undoing the restore brings 9999 back', recipeOf(db, id).batch_size, 9999);
}

// ── 7. A tenant DB missing the late columns still works ──────────────────────
console.log('\n7. Missing late columns (substitutes / image_data) are skipped, never a 500');
{
  const db = makeDb({ withLateColumns: false });
  const id = seedRecipe(db);
  save(db, id, { ingredients: [{ ingredient_id: 11, name_en: 'Hazelnuts', qty: 1, unit: 'g' }] });
  const v = V.listVersions(db, id)[0];
  check('a version was still filed', !!v, true);
  const full = V.getVersion(db, id, v.id);
  check('the snapshot carries no substitutes key',
    Object.prototype.hasOwnProperty.call(full.snapshot.ingredients[0], 'substitutes'), false);
  const out = V.restoreVersion(db, id, v.id, { saveCostData: saveRecipeCostData });
  check('restore succeeded anyway', out.ok, true);
  check('both lines came back', linesOf(db, id).length, 2);
}

// ── 8. An unchanged save files nothing ───────────────────────────────────────
// A save where nothing moved (the operator pressed Save twice) must not add a
// row that says the same thing as the one below it.
console.log('\n8. A save that changed nothing files no version');
{
  const db = makeDb();
  const id = seedRecipe(db);
  V.snapshotRecipe(db, id, { source: 'manual' });
  ageVersion(db, V.listVersions(db, id)[0].id, 600);
  const again = V.snapshotRecipe(db, id, { source: 'manual' });
  check('declined', again.filed, false);
  check('and said why', again.reason, 'unchanged');
  check('still one version', versionCount(db, id), 1);
}

// ── 9. A SKU another recipe has taken since is held back, not fatal ──────────
// The whole restore failing over a code, and taking the ingredient lines with
// it, is the wrong trade — the lines are what anyone came for.
console.log('\n9. A SKU taken since is held back; the rest of the version still lands');
{
  const db = makeDb();
  const id = seedRecipe(db);
  save(db, id, { recipe: { sku: 'CHB-2', batch_size: 4500 } });
  db.prepare("INSERT INTO recipes (name_en, sku) VALUES ('Someone else', 'CHB-1')").run();
  const v = V.listVersions(db, id)[0];
  const out = V.restoreVersion(db, id, v.id, { saveCostData: saveRecipeCostData });
  check('restore still succeeded', out.ok, true);
  check('and named what it could not put back', out.held, ['sku']);
  check('the SKU was left alone', recipeOf(db, id).sku, 'CHB-2');
  check('everything else went back', recipeOf(db, id).batch_size, 3800);
}

// ── 10. The table does not grow without bound ────────────────────────────────
console.log('\n10. Only the newest MAX_VERSIONS are kept');
{
  const db = makeDb();
  const id = seedRecipe(db);
  for (let i = 0; i < V.MAX_VERSIONS + 12; i++) {
    save(db, id, { recipe: { batch_size: 4000 + i } }, { source: 'manual' });
    ageVersion(db, V.listVersions(db, id)[0].id, 600 + i);
  }
  check('pruned to the cap', versionCount(db, id), V.MAX_VERSIONS);
  const newest = V.getVersion(db, id, V.listVersions(db, id)[0].id);
  check('and the newest survived', newest.snapshot.recipe.batch_size, 4000 + V.MAX_VERSIONS + 10);
}

// ── 11. A missing recipe is declined, never thrown ───────────────────────────
// snapshotRecipe sits inside a save path: it must never be able to turn a save
// that worked into a 500 that says it did not.
console.log('\n11. A snapshot of a recipe that is not there declines quietly');
{
  const db = makeDb();
  const out = V.snapshotRecipe(db, 999, { source: 'manual' });
  check('declined', out.filed, false);
  check('with a reason', out.reason, 'not_found');
}

console.log(failures === 0
  ? '\nAll cases behaved.\n'
  : `\n${failures} case(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
