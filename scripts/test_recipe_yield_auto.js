#!/usr/bin/env node
//
// test_recipe_yield_auto.js — the batch size nobody types, and the serving
// count that follows it.
//
// WHAT THIS IS FOR
// ----------------
// `recipes.batch_size` is the number every per-gram cost divides by: batchCost
// / batch_size is costPerGram, which lib/recipe-rollup.js writes onto a
// material, which reaches a product's unit cost and its margin. It was typed by
// hand, and 4 of the recipes backing a material had never had one typed — the
// cascade refuses those outright with `no_batch_size`.
//
// It is now derived: the sum of the ingredient lines that end up in the
// product, with `recipe_ingredients.in_yield` naming the ones that do not (a
// stock brewed for its flavour and poured away is a real cost with no share of
// the yield), and `recipes.batch_size_auto` / `servings_auto` saying per recipe
// whether to derive at all.
//
// THE THREE THINGS THAT WOULD MAKE THIS DANGEROUS, each asserted below:
//   1. A sum that is SHORT. Grams are only added to grams; one ml or pcs line
//      refuses the whole derivation rather than understating it, because a
//      batch size short one ingredient overstates cost per gram silently, all
//      the way down to a margin.
//   2. A live figure MOVING ON DEPLOY. Every recipe that already carried a
//      typed batch size is marked manual by database.js's recipe_yield_auto_v1,
//      and a manual recipe must resolve to exactly what it resolved to before.
//   3. An excluded line being QUIETLY RE-COUNTED by a door that has no control
//      for it — the kitchen Cost Sheet replaces recipe_ingredients wholesale.
//
// HOW IT RUNS THE REAL CODE — nothing here is a paraphrase.
//   * The derivation is lib/recipe-cost.js's own export, required directly.
//   * applyAutoYield is lib/recipe-yield.js, run against a real in-memory
//     database built from the shipped DDL.
//   * The migration's two UPDATEs are LIFTED OUT of database.js and run.
//   * The editor's hints are LIFTED OUT of public/retail-admin/19-recipes.js
//     and executed in a vm, so every sentence asserted is one the shipped file
//     produced.
//
// USAGE   node scripts/test_recipe_yield_auto.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const assert = require('assert');

const ROOT        = path.join(__dirname, '..');
const read        = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const DATABASE_JS = read('database.js');
const SCHEMA_SQL  = read('schema.sql');
const RECIPES_JS  = read('public', 'retail-admin', '19-recipes.js');
const RETAIL_ROUTE = read('routes', 'retail-recipes.js');
const KITCHEN_ROUTE = read('routes', 'recipes.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failures++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
function section(t) { console.log('\n' + t); }

const RC = require('../lib/recipe-cost');

// ═══════════════════════════════════════════════════════════════════════════
section('1. The sum — what a batch weighs');
// ═══════════════════════════════════════════════════════════════════════════

check('the derivation is exported, not re-derived per caller', () => {
  ['computeYield', 'resolveYield', 'massInGrams', 'lineInYield'].forEach(k =>
    assert.strictEqual(typeof RC[k], 'function', `missing export: ${k}`));
});

check('grams are added up, to the figure on the screenshot', () => {
  // The Chai Mix lines, verbatim.
  const y = RC.computeYield([
    { qty: 15, unit: 'g' }, { qty: 4.5, unit: 'g' }, { qty: 4.5, unit: 'g' },
    { qty: 3.75, unit: 'g' }, { qty: 75, unit: 'g' }, { qty: 67.5, unit: 'g' },
    { qty: 144, unit: 'g' }, { qty: 8.93, unit: 'g' }, { qty: 225, unit: 'g' },
  ]);
  assert.strictEqual(y.ok, true);
  assert.strictEqual(y.grams, 548.18);
  assert.strictEqual(y.countedLines, 9);
});

check('mass units convert among themselves with exact factors', () => {
  assert.strictEqual(RC.massInGrams(1, 'kg'), 1000);
  assert.strictEqual(RC.massInGrams(1, 'oz'), 28.349523125);
  assert.strictEqual(RC.massInGrams(2, 'LB'), 907.18474);
  assert.strictEqual(RC.computeYield([{ qty: 0.5, unit: 'kg' }, { qty: 250, unit: 'g' }]).grams, 750);
});

check('nothing crosses a dimension — ml and pcs have no weight', () => {
  assert.strictEqual(RC.massInGrams(160, 'ml'), null);
  assert.strictEqual(RC.massInGrams(2, 'pcs'), null);
});

// THE HEADLINE REFUSAL. A short total is worse than none: it divides into
// batchCost to make costPerGram, which becomes a material's cost.
check('ONE unweighable line refuses the whole sum and names it', () => {
  const y = RC.computeYield([
    { qty: 200, unit: 'g', name_en: 'Flour' },
    { qty: 160, unit: 'ml', name_en: 'Milk' },
  ]);
  assert.strictEqual(y.ok, false);
  assert.strictEqual(y.grams, null, 'a refused sum must not report a number');
  assert.strictEqual(y.reason, 'unweighable_lines');
  assert.deepStrictEqual(y.blockingLines.map(b => b.name), ['Milk']);
  assert.strictEqual(y.blockingLines[0].unit, 'ml');
});

check('a line left out of the yield is not counted and does not block', () => {
  const y = RC.computeYield([
    { qty: 200, unit: 'g' },
    { qty: 500, unit: 'g', in_yield: 0 },     // stock, brewed and poured away
    { qty: 2, unit: 'pcs', in_yield: 0 },     // and one that could not be weighed anyway
  ]);
  assert.strictEqual(y.ok, true);
  assert.strictEqual(y.grams, 200);
  assert.strictEqual(y.excludedLines, 2);
  assert.strictEqual(y.countedLines, 1);
});

check('in_yield defaults ON — a line written before the column counts', () => {
  assert.strictEqual(RC.lineInYield({ qty: 1, unit: 'g' }), true);
  assert.strictEqual(RC.lineInYield({ in_yield: null }), true);
  assert.strictEqual(RC.lineInYield({ in_yield: 1 }), true);
  assert.strictEqual(RC.lineInYield({ in_yield: 0 }), false);
  assert.strictEqual(RC.lineInYield({ in_yield: false }), false);
});

check('no lines, or every line excluded, is a refusal rather than a zero', () => {
  assert.deepStrictEqual(
    [RC.computeYield([]).ok, RC.computeYield([]).grams, RC.computeYield([]).reason],
    [false, null, 'no_countable_lines']);
  assert.strictEqual(RC.computeYield([{ qty: 5, unit: 'g', in_yield: 0 }]).ok, false);
});

check('float noise never reaches the field', () => {
  assert.strictEqual(RC.computeYield([{ qty: 0.1, unit: 'g' }, { qty: 0.2, unit: 'g' }]).grams, 0.3);
});

// ═══════════════════════════════════════════════════════════════════════════
section('2. Resolving — derived where the recipe says derive');
// ═══════════════════════════════════════════════════════════════════════════

const LINES = [{ qty: 300, unit: 'g' }, { qty: 200, unit: 'g' }];

check('auto: the batch size is the sum, whatever the column says', () => {
  const y = RC.resolveYield({ batch_size: 9999, batch_size_auto: 1 }, LINES);
  assert.strictEqual(y.batchSize, 500);
  assert.strictEqual(y.batchAuto, true);
});

// (2) of the three dangers: a recipe that states its own yield — reduction on
// the stove, a pack filled to weight — must be left exactly alone.
check('manual: the stored figure stands, and the lines are not consulted', () => {
  const y = RC.resolveYield({ batch_size: 420, batch_size_auto: 0 }, LINES);
  assert.strictEqual(y.batchSize, 420);
  assert.strictEqual(y.yield, null, 'a manual recipe should not even compute a sum');
});

check('ABSENT flags mean manual — a caller that predates the column is unchanged', () => {
  const y = RC.resolveYield({ batch_size: 420 }, LINES);
  assert.strictEqual(y.batchSize, 420);
  assert.strictEqual(y.servings, 0);
});

check('auto with a refused sum falls back to the stored figure, never to nothing', () => {
  const y = RC.resolveYield({ batch_size: 420, batch_size_auto: 1 },
    [{ qty: 300, unit: 'g' }, { qty: 1, unit: 'pcs' }]);
  assert.strictEqual(y.batchSize, 420);
  assert.strictEqual(y.yield.ok, false);
});

check('servings are batch ÷ serving size, floored, with the tail named', () => {
  const y = RC.resolveYield(
    { batch_size_auto: 1, servings_auto: 1, serving_size: 25 },
    [{ qty: 224.55, unit: 'g' }]);
  assert.strictEqual(y.batchSize, 224.55);
  assert.strictEqual(y.servings, 8, '8.98 servings is eight sellable ones');
  assert.strictEqual(y.servingsLeftover, 24.55);
});

check('an exact division never comes out one serving short', () => {
  const y = RC.resolveYield({ batch_size_auto: 1, servings_auto: 1, serving_size: 0.1 },
    [{ qty: 0.3, unit: 'g' }]);
  assert.strictEqual(y.servings, 3, '0.3/0.1 is 2.9999… in binary floating point');
  assert.strictEqual(y.servingsLeftover, 0);
});

check('no serving size means no serving count — not a zero-division, not a 1', () => {
  const y = RC.resolveYield({ batch_size_auto: 1, servings_auto: 1 }, LINES);
  assert.strictEqual(y.servings, 0);
});

check('a serving bigger than the batch yields none, and says so by yielding none', () => {
  const y = RC.resolveYield({ batch_size_auto: 1, servings_auto: 1, serving_size: 900 }, LINES);
  assert.strictEqual(y.servings, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
section('3. The cost breakdown reads the resolved figures');
// ═══════════════════════════════════════════════════════════════════════════

const PRICED = [
  { qty: 300, unit: 'g', master_cost: 0.02, master_unit: 'g' },
  { qty: 200, unit: 'g', master_cost: 0.01, master_unit: 'g' },
];

check('a derived batch size produces the cost per gram that was blocked before', () => {
  const c = RC.computeRecipeCost({
    recipe: { id: 1, name_en: 'X', batch_size: null, batch_size_auto: 1 },
    ingredients: PRICED, costData: null,
  });
  assert.strictEqual(c.batchCost, 8);
  assert.strictEqual(c.batchSize, 500);
  assert.strictEqual(c.costPerGram, 0.016);
  assert.strictEqual(c.batchSizeAuto, true);
  assert.strictEqual(c.yield.ok, true);
});

check('cost per serving follows a derived serving count', () => {
  const c = RC.computeRecipeCost({
    recipe: { id: 1, name_en: 'X', batch_size_auto: 1, servings_auto: 1, serving_size: 100 },
    ingredients: PRICED, costData: null,
  });
  assert.strictEqual(c.servings, 5);
  assert.strictEqual(c.costPerServing, 1.6);
  assert.strictEqual(c.servingsLeftover, 0);
});

// (2) again, at the level that matters most: the figure the rollup reads.
check('a manual recipe computes EXACTLY what it computed before this feature', () => {
  const recipe = { id: 1, name_en: 'X', batch_size: 400, servings: 4, batch_size_auto: 0, servings_auto: 0 };
  const c = RC.computeRecipeCost({ recipe, ingredients: PRICED, costData: null });
  assert.strictEqual(c.batchSize, 400);
  assert.strictEqual(c.servings, 4);
  assert.strictEqual(c.costPerGram, 8 / 400);
  assert.strictEqual(c.costPerServing, 2);
  assert.strictEqual(c.materialCostPerGram, 8 / 400);
});

check('an excluded line is still COSTED in full — only the weight changes', () => {
  const c = RC.computeRecipeCost({
    recipe: { id: 1, name_en: 'X', batch_size_auto: 1 },
    ingredients: [
      { qty: 300, unit: 'g', master_cost: 0.02, master_unit: 'g' },
      { qty: 200, unit: 'g', master_cost: 0.01, master_unit: 'g', in_yield: 0 },
    ],
    costData: null,
  });
  assert.strictEqual(c.batchCost, 8, 'the discarded stock is paid for');
  assert.strictEqual(c.batchSize, 300, 'and does not come out of the pot');
  assert.strictEqual(c.zeroCostIngredientLines, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
section('4. The write path stamps the row (lib/recipe-yield.js)');
// ═══════════════════════════════════════════════════════════════════════════

const { openTablesDb, addTables, driver } = require('./test-support/memory-db');
console.log(`  (sqlite driver: ${driver})`);
const { applyAutoYield } = require('../lib/recipe-yield');

function freshDb() {
  const db = openTablesDb(DATABASE_JS, []);
  addTables(db, SCHEMA_SQL, DATABASE_JS, ['recipes', 'recipe_ingredients']);
  return db;
}
function makeRecipe(db, cols) {
  const keys = Object.keys(cols);
  const r = db.prepare(`INSERT INTO recipes (name_en${keys.length ? ',' + keys.join(',') : ''})
    VALUES (?${keys.map(() => ',?').join('')})`).run('R', ...keys.map(k => cols[k]));
  return Number(r.lastInsertRowid);
}
function addLine(db, recipeId, qty, unit, inYield) {
  db.prepare('INSERT INTO recipe_ingredients (recipe_id,name_en,qty,unit,in_yield,sort_order) VALUES (?,?,?,?,?,0)')
    .run(recipeId, 'L', qty, unit, inYield === undefined ? 1 : inYield);
}
const rowOf = (db, id) => db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);

check('the shipped DDL carries all three columns', () => {
  const db = freshDb();
  const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all('recipes').map(r => r.name);
  assert.ok(cols.includes('batch_size_auto') && cols.includes('servings_auto'), cols.join(','));
  const lc = db.prepare('SELECT name FROM pragma_table_info(?)').all('recipe_ingredients').map(r => r.name);
  assert.ok(lc.includes('in_yield'), lc.join(','));
});

check('an auto recipe has its batch size and serving count written back', () => {
  const db = freshDb();
  const id = makeRecipe(db, { batch_size_auto: 1, servings_auto: 1, serving_size: 100 });
  addLine(db, id, 300, 'g'); addLine(db, id, 250, 'g');
  applyAutoYield(db, id);
  const r = rowOf(db, id);
  assert.strictEqual(r.batch_size, 550);
  assert.strictEqual(Number(r.servings), 5);
});

check('a manual recipe is not touched at all', () => {
  const db = freshDb();
  const id = makeRecipe(db, { batch_size: 999, servings: 3, batch_size_auto: 0, servings_auto: 0 });
  addLine(db, id, 300, 'g');
  applyAutoYield(db, id);
  const r = rowOf(db, id);
  assert.strictEqual(r.batch_size, 999);
  assert.strictEqual(Number(r.servings), 3);
});

check('a refused sum does not DELETE the batch size the recipe already had', () => {
  const db = freshDb();
  const id = makeRecipe(db, { batch_size: 800, batch_size_auto: 1 });
  addLine(db, id, 300, 'g'); addLine(db, id, 2, 'pcs');
  applyAutoYield(db, id);
  assert.strictEqual(rowOf(db, id).batch_size, 800);
});

check('an excluded line is left out of the written figure', () => {
  const db = freshDb();
  const id = makeRecipe(db, { batch_size_auto: 1 });
  addLine(db, id, 300, 'g'); addLine(db, id, 500, 'g', 0);
  applyAutoYield(db, id);
  assert.strictEqual(rowOf(db, id).batch_size, 300);
});

check('it never throws — a missing recipe is an answer, not a 500', () => {
  const db = freshDb();
  assert.strictEqual(applyAutoYield(db, 4242).ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════
section('5. The migration protects every figure somebody typed');
// ═══════════════════════════════════════════════════════════════════════════

// The two UPDATEs, lifted from database.js rather than restated — a change to
// either there has to show up here.
function migrationSql() {
  const block = DATABASE_JS.slice(DATABASE_JS.indexOf("ranYieldAuto"));
  const found = [...block.matchAll(/db\.prepare\('(UPDATE recipes SET (?:batch_size_auto|servings_auto)[^']*)'\)/g)]
    .map(m => m[1]);
  assert.strictEqual(found.length, 2, 'expected two UPDATEs in recipe_yield_auto_v1');
  return found;
}

check('a recipe with a typed batch size is marked manual; one with none derives', () => {
  const db = freshDb();
  const typed  = makeRecipe(db, { batch_size: 700, servings: 7 });
  const untyped = makeRecipe(db, {});
  for (const sql of migrationSql()) db.prepare(sql).run();
  assert.strictEqual(rowOf(db, typed).batch_size_auto, 0);
  assert.strictEqual(rowOf(db, typed).servings_auto, 0);
  assert.strictEqual(rowOf(db, untyped).batch_size_auto, 1, 'the column default opts a blank recipe in');
  assert.strictEqual(rowOf(db, untyped).servings_auto, 1);
});

check('the two halves are decided separately', () => {
  const db = freshDb();
  const id = makeRecipe(db, { batch_size: 700 });   // batch typed, servings not
  for (const sql of migrationSql()) db.prepare(sql).run();
  assert.strictEqual(rowOf(db, id).batch_size_auto, 0);
  assert.strictEqual(rowOf(db, id).servings_auto, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
section('6. Both doors: the stamp, and the flag nobody may drop');
// ═══════════════════════════════════════════════════════════════════════════

check('the retail door stamps the row BEFORE the material recompute divides by it', () => {
  const at = RETAIL_ROUTE.indexOf('applyAutoYield(db, req.params.id)');
  const fire = RETAIL_ROUTE.indexOf('fireRecompute(tdb()');
  assert.ok(at > 0 && fire > at, 'applyAutoYield must run before fireRecompute in the update');
  assert.ok(RETAIL_ROUTE.includes('applyAutoYield(db, recipeId)'), 'and on create');
});

check('the kitchen door stamps it too', () => {
  const at = KITCHEN_ROUTE.indexOf('applyAutoYield(db, req.params.id)');
  const fire = KITCHEN_ROUTE.indexOf("fireRecompute(db, { source: 'recipes.update'");
  assert.ok(at > 0 && fire > at);
});

// (3) of the three dangers. The kitchen Cost Sheet replaces recipe_ingredients
// wholesale and has no control for in_yield; without this it would re-count a
// deliberately discarded ingredient on every save.
check('both doors carry in_yield across a delete-and-reinsert', () => {
  [['routes/recipes.js', KITCHEN_ROUTE], ['routes/retail-recipes.js', RETAIL_ROUTE]].forEach(([name, src]) => {
    assert.ok(/prevYield/.test(src), `${name} does not preserve in_yield`);
    assert.ok(src.includes('in_yield,notes') || src.includes('in_yield, notes'),
      `${name} does not write in_yield on insert`);
  });
});

// A column added to an INSERT and forgotten in its VALUES list is a 500 on
// somebody's save and nothing before that. SQLite settles it at PREPARE time —
// "table recipes has N columns but M values were supplied" — so every recipe
// statement both doors ship is prepared here against the real tables.
check('every recipe/line statement in both doors prepares against the real schema', () => {
  const db = freshDb();
  const pats = [
    /INSERT INTO recipes[\s\S]*?VALUES \([^)]*\)/g,
    /UPDATE recipes SET[\s\S]*?WHERE id\s*=\s*\?/g,
    /INSERT INTO recipe_ingredients[\s\S]*?VALUES \([^)]*\)/g,
  ];
  let n = 0;
  for (const [name, src] of [['routes/recipes.js', KITCHEN_ROUTE], ['routes/retail-recipes.js', RETAIL_ROUTE]]) {
    for (const re of pats) {
      for (const [sql] of src.matchAll(re)) {
        n++;
        try { db.prepare(sql); }
        catch (e) { throw new Error(`${name}: ${e.message}\n      ${sql.replace(/\s+/g, ' ').slice(0, 160)}`); }
      }
    }
  }
  assert.ok(n >= 8, `expected at least 8 statements, prepared ${n}`);
});

check('a create that carries a typed batch size is filed as manual', () => {
  assert.ok(RETAIL_ROUTE.includes('b.batch_size == null ? 1 : 0'));
  assert.ok(KITCHEN_ROUTE.includes('batch_size ? 0 : 1'));
});

// ═══════════════════════════════════════════════════════════════════════════
section('7. The editor — the shipped hints, executed');
// ═══════════════════════════════════════════════════════════════════════════

// The block as it ships, from its own banner to the next one. Executed, not
// paraphrased: every sentence asserted below is one 19-recipes.js produced.
const UI_FROM = RECIPES_JS.indexOf('  // ── The batch size nobody should have to add up');
const UI_TO   = RECIPES_JS.indexOf("  // ── Does THIS line's unit disagree");
assert.ok(UI_FROM > 0 && UI_TO > UI_FROM, 'the yield block was not found in 19-recipes.js');
const UI_BLOCK = RECIPES_JS.slice(UI_FROM, UI_TO);

function hint(which, rec, lines) {
  const sandbox = {
    _rec: rec, _lines: lines,
    esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    T: (en) => en,
    COST: () => RC,
    // draftDetails lives further down the shipped file; the block calls it and
    // this stands in for it with the same shape it returns.
    draftDetails: () => ({
      batch_size: rec.batch_size, servings: rec.servings, serving_size: rec.serving_size,
      batch_size_auto: rec.batch_size_auto, servings_auto: rec.servings_auto,
    }),
    document: { getElementById: () => null },
    window: {}, markDirty: () => {}, rcpRecompute: () => {},
  };
  const ctx = vm.createContext(sandbox);
  return vm.runInContext(UI_BLOCK + `\n;(${which === 'batch' ? 'batchHint' : 'servHint'})(resolvedYield());`, ctx);
}

check('auto batch: the hint accounts for the number in the field', () => {
  const h = hint('batch', { batch_size_auto: 1 }, [{ qty: 300, unit: 'g' }, { qty: 200, unit: 'g' }]);
  assert.ok(/Auto/.test(h), h);
  assert.ok(/2 ingredient lines added up/.test(h), h);
  assert.ok(/Type it myself/.test(h), h);
});

check('auto batch: an excluded line is counted out loud', () => {
  const h = hint('batch', { batch_size_auto: 1 },
    [{ qty: 300, unit: 'g' }, { qty: 200, unit: 'g', in_yield: 0 }]);
  assert.ok(/1 left out of the batch/.test(h), h);
});

check('a refused sum NAMES the lines standing in the way', () => {
  const h = hint('batch', { batch_size_auto: 1, batch_size: 800 },
    [{ qty: 300, unit: 'g', name_en: 'Flour' }, { qty: 160, unit: 'ml', name_en: 'Milk' }]);
  assert.ok(/Milk \(ml\)/.test(h), h);
  assert.ok(/only grams can be weighed together/.test(h), h);
  assert.ok(/class="warn"/.test(h), 'a refusal must be marked, not read as ordinary prose');
});

check('a manual batch size is OFFERED the total rather than having it applied', () => {
  const h = hint('batch', { batch_size_auto: 0, batch_size: 420 },
    [{ qty: 300, unit: 'g' }, { qty: 200, unit: 'g' }]);
  assert.ok(/Use the ingredient total \(500 g\)/.test(h), h);
  assert.ok(/rcpYieldAuto\('batch',1\)/.test(h), h);
});

check('auto servings: the division and the tail are both shown', () => {
  const h = hint('servings', { batch_size_auto: 1, servings_auto: 1, serving_size: 25 },
    [{ qty: 224.55, unit: 'g' }]);
  assert.ok(/224\.55 g ÷ 25 g/.test(h), h);
  assert.ok(/24\.55 g left over/.test(h), h);
});

check('auto servings with no serving size says what is missing', () => {
  const h = hint('servings', { batch_size_auto: 1, servings_auto: 1 }, [{ qty: 500, unit: 'g' }]);
  assert.ok(/fill in a serving size/.test(h), h);
});

check('a serving bigger than the batch is called out, not printed as zero', () => {
  const h = hint('servings', { batch_size_auto: 1, servings_auto: 1, serving_size: 900 },
    [{ qty: 500, unit: 'g' }]);
  assert.ok(/bigger than the whole batch/.test(h), h);
});

check('the editor sends both flags and every line\'s in_yield', () => {
  assert.ok(/in_yield: lineInYield\(l\) \? 1 : 0/.test(RECIPES_JS), 'lines must carry in_yield');
  assert.ok(/batch_size_auto: autoBatch\(\) \? 1 : 0/.test(RECIPES_JS));
  assert.ok(/servings_auto: autoServings\(\) \? 1 : 0/.test(RECIPES_JS));
});

check('the derived fields are READONLY, never disabled', () => {
  assert.ok(/readonly class="rcp-input rcp-auto"/.test(RECIPES_JS),
    'a disabled input is skipped by the form read that has to save the derived figure');
  assert.ok(!/disabled.*rcp-auto/.test(RECIPES_JS));
});

check('the line control and its column both ship, with styling', () => {
  assert.ok(/rcpLineYield\(/.test(RECIPES_JS));
  assert.ok(/lh-yield/.test(RECIPES_JS));
  const css = read('public', 'retail-admin.css');
  assert.ok(/\.rcp-line-yield/.test(css) && /\.lh-yield/.test(css) && /is-out-of-yield/.test(css));
  assert.ok(/\.rcp-input\.rcp-auto/.test(css));
});

check('version history carries the three new columns, so undo can put them back', () => {
  const v = read('lib', 'recipe-versions.js');
  assert.ok(/'batch_size_auto', 'servings_auto'/.test(v));
  assert.ok(/'unit', 'in_yield', 'notes'/.test(v));
});

console.log(failures ? `\n${failures} FAILED` : '\nAll assertions held');
process.exit(failures ? 1 : 0);
