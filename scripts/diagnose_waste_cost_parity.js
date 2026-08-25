#!/usr/bin/env node
/**
 * diagnose_waste_cost_parity.js — THE GATE for step 2 of the recipe-cost
 * consolidation.
 *
 * Step 2 moves routes/waste.js computeProductCost() onto lib/recipe-cost.js.
 * Unlike step 1 this is NOT a pure no-op by construction: the shared module
 * honours `free_by_design`, and waste.js never did — its ingredient SELECT
 * never asked for the column. The claim is narrower than step 1's:
 *
 *   waste cost is unchanged ON TODAY'S DATA, because no ingredient currently
 *   holds free_by_design=1 together with a nonzero cost_per_unit.
 *
 * That is a claim about data, not about code, so it is measured here rather
 * than asserted — and it is measured at the same moment as the comparison, not
 * quoted from a run made earlier.
 *
 * THREE DIVERGENCES ARE POSSIBLE, AND ALL THREE ARE PROBED
 * --------------------------------------------------------
 * The old loop and the shared module differ in three ways. Each is only
 * invisible while the data stays in a particular shape, so each is measured:
 *
 *   1. free_by_design.  OLD counted a flagged-free line if it carried a price;
 *      NEW treats it as a real zero. Invisible only while no row is both
 *      flagged and priced.  → section 1
 *   2. NEGATIVE cost_per_unit.  OLD tested `ri.cost_per_unit && ri.qty`, which
 *      is TRUTHY for a negative price, so a negative cost was added to the
 *      subtotal. NEW tests `costPerUnit > 0`, which excludes it. Invisible only
 *      while no ingredient carries a negative cost.  → section 2
 *   3. qty coercion.  OLD used the raw column; NEW uses parseFloat(qty)||0.
 *      Identical for any REAL value, which qty is (NOT NULL REAL).  → covered
 *      by the row-by-row comparison in section 3.
 *
 * Section 3 is the comparison itself: the OLD computeProductCost, transcribed
 * verbatim from origin/main below, against the NEW one, over every product that
 * has a recipe_id AND every product any waste_entries row points at — the two
 * sets that can actually produce a different number on a screen or a write.
 *
 * The OLD function is a frozen literal copy. Do not refactor it; it is the
 * control, and tidying it stops this script testing anything.
 *
 * Every statement here is a SELECT. The database is opened read-only and the
 * connection is PROVEN read-only before anything else runs, by attempting a
 * CREATE TABLE and aborting if the write is accepted.
 */
'use strict';

const path = require('path');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';

function loadSqlite() {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require('/root/roots-v2/node_modules/better-sqlite3'); }
}
const Database = loadSqlite();
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting without comparing anything.');
  process.exit(2);
}

const { computeRecipeCost } = require(path.join(HOME, 'lib', 'recipe-cost.js'));

console.log('db:                ' + DB_PATH);
console.log('module under test: ' + path.join(HOME, 'lib', 'recipe-cost.js'));
console.log('run at (UTC):      ' + new Date().toISOString());
console.log('');

let failures = 0, checks = 0;
function assert(cond, msg) { checks++; if (cond) console.log('  PASS  ' + msg); else { failures++; console.log('  FAIL  ' + msg); } }
function note(msg) { console.log('        · ' + msg); }

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 1 · divergence A — free_by_design=1 AND cost_per_unit>0 ══');
{
  const rows = db.prepare(`
    SELECT id, name_en, cost_per_unit FROM ingredients
     WHERE COALESCE(free_by_design,0) = 1 AND COALESCE(cost_per_unit,0) > 0
  `).all();
  assert(rows.length === 0,
    `no ingredient is both flagged free and priced (found ${rows.length})`);
  for (const r of rows) note('AFFECTED: ' + JSON.stringify(r));
  const flagged = db.prepare(`SELECT id, name_en, cost_per_unit FROM ingredients WHERE COALESCE(free_by_design,0)=1`).all();
  note(`${flagged.length} flagged-free ingredient(s), all at cost 0: ` + flagged.map(f => `${f.name_en}=${f.cost_per_unit}`).join(', '));
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 2 · divergence B — NEGATIVE cost_per_unit ══');
{
  const rows = db.prepare(`
    SELECT id, name_en, cost_per_unit FROM ingredients WHERE cost_per_unit < 0
  `).all();
  assert(rows.length === 0,
    `no ingredient carries a negative cost_per_unit (found ${rows.length}) — `
    + 'OLD added those to the subtotal, NEW excludes them');
  for (const r of rows) note('AFFECTED: ' + JSON.stringify(r));
}

// ════════════════════════════════════════════════════════════════════════════
// THE OLD FUNCTION — frozen verbatim from origin/main routes/waste.js:14-49.
// Do not refactor. See header.
// ════════════════════════════════════════════════════════════════════════════
function OLD_computeProductCost(productId) {
  if (!productId) return { cost_per_unit: null, sell_price: 0, source: null };
  const p = db.prepare('SELECT sell_price, recipe_id, name_en FROM products WHERE id = ?').get(productId);
  if (!p) return { cost_per_unit: null, sell_price: 0, source: null };
  const sellPrice = p.sell_price || 0;
  if (!p.recipe_id) {
    return { cost_per_unit: null, sell_price: sellPrice, source: sellPrice > 0 ? 'sell_price' : null };
  }
  const recipe = db.prepare('SELECT servings FROM recipes WHERE id = ?').get(p.recipe_id);
  const cd = db.prepare('SELECT labour, packaging, overhead_pct FROM recipe_cost_data WHERE recipe_id = ?').get(p.recipe_id) || {};
  const ings = db.prepare(`
    SELECT ri.qty, ri.unit, i.cost_per_unit
    FROM recipe_ingredients ri
    LEFT JOIN ingredients i ON i.id = ri.ingredient_id
    WHERE ri.recipe_id = ?
  `).all(p.recipe_id);

  let ingTotal = 0;
  for (const ri of ings) {
    if (ri.cost_per_unit && ri.qty) ingTotal += ri.qty * ri.cost_per_unit;
  }
  const labour    = cd.labour       || 0;
  const overhead  = cd.overhead_pct || 0;
  const servings  = recipe?.servings || 0;
  const batchCost = ingTotal + labour + (ingTotal * overhead / 100);
  const costPerServ = servings > 0 ? batchCost / servings : null;

  if (costPerServ !== null && costPerServ > 0) {
    return { cost_per_unit: costPerServ, sell_price: sellPrice, source: 'recipe' };
  }
  return { cost_per_unit: null, sell_price: sellPrice, source: sellPrice > 0 ? 'sell_price' : null };
}

// THE NEW FUNCTION — the shape routes/waste.js now has. Packaging stays out;
// the sell-price fallback stays here.
function NEW_computeProductCost(productId) {
  if (!productId) return { cost_per_unit: null, sell_price: 0, source: null };
  const p = db.prepare('SELECT sell_price, recipe_id, name_en FROM products WHERE id = ?').get(productId);
  if (!p) return { cost_per_unit: null, sell_price: 0, source: null };
  const sellPrice = p.sell_price || 0;
  if (!p.recipe_id) {
    return { cost_per_unit: null, sell_price: sellPrice, source: sellPrice > 0 ? 'sell_price' : null };
  }
  const c = computeRecipeCost(p.recipe_id, db);
  if (!c) {
    return { cost_per_unit: null, sell_price: sellPrice, source: sellPrice > 0 ? 'sell_price' : null };
  }
  const batchCost = c.ingredientCost + c.labour + c.overheadAmount;
  const costPerServ = c.servings > 0 ? batchCost / c.servings : null;

  if (costPerServ !== null && costPerServ > 0) {
    return { cost_per_unit: costPerServ, sell_price: sellPrice, source: 'recipe' };
  }
  return { cost_per_unit: null, sell_price: sellPrice, source: sellPrice > 0 ? 'sell_price' : null };
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 3 · OLD vs NEW waste cost, product by product ══');
{
  // Two sets, unioned: every product carrying a recipe_id (what the preview
  // endpoint and the create handler can be asked for), and every product any
  // waste_entries row already points at (what a recomputation would touch).
  const ids = new Set();
  for (const r of db.prepare('SELECT id FROM products WHERE recipe_id IS NOT NULL').all()) ids.add(r.id);
  const wasteProducts = db.prepare('SELECT DISTINCT product_id AS id FROM waste_entries WHERE product_id IS NOT NULL').all();
  for (const r of wasteProducts) ids.add(r.id);
  // A handful of ids that exercise the guard paths, so the run is not vacuous
  // if the two sets above are small.
  for (const r of db.prepare('SELECT id FROM products ORDER BY id LIMIT 40').all()) ids.add(r.id);

  const list = [...ids].sort((a, b) => a - b);
  note(`${list.length} distinct product ids compared `
     + `(${db.prepare('SELECT COUNT(*) n FROM products WHERE recipe_id IS NOT NULL').get().n} with a recipe_id, `
     + `${wasteProducts.length} referenced by waste_entries)`);

  let deltas = 0, withCost = 0;
  const money = v => v === null ? '—' : '¥' + v.toFixed(4);
  for (const id of list) {
    const o = OLD_computeProductCost(id);
    const n = NEW_computeProductCost(id);
    if (o.cost_per_unit !== null) withCost++;
    const pairs = [
      ['cost_per_unit', o.cost_per_unit, n.cost_per_unit],
      ['sell_price',    o.sell_price,    n.sell_price],
      ['source',        o.source,        n.source],
      // The figure actually written to waste_entries.cost_lost for one unit.
      ['cost_lost@qty1',
        (o.cost_per_unit != null ? o.cost_per_unit : o.sell_price) * 1,
        (n.cost_per_unit != null ? n.cost_per_unit : n.sell_price) * 1],
      // And how it renders as money, which is what a person reads.
      ['render', money(o.cost_per_unit), money(n.cost_per_unit)],
    ];
    for (const [what, a, b] of pairs) {
      if (a !== b) {
        deltas++;
        if (deltas <= 30) {
          const nm = db.prepare('SELECT name_en FROM products WHERE id = ?').get(id);
          console.log(`  DELTA product ${id} "${(nm && nm.name_en || '').slice(0, 34)}" ${what}: OLD=${JSON.stringify(a)} NEW=${JSON.stringify(b)}`);
        }
      }
    }
  }
  note(`${withCost} of ${list.length} products resolve to a recipe-derived cost`);
  assert(deltas === 0, `waste cost is unchanged on today's data (${deltas} deltas)`);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 4 · existing waste_entries — would any stored cost_lost change ══');
{
  // Historical rows are NOT recomputed by this change (cost_lost is snapshotted
  // at write time). This asks the counterfactual: if each were re-costed today,
  // would OLD and NEW disagree? A delta here would mean future writes diverge.
  const rows = db.prepare(`
    SELECT id, product_id, qty, cost_lost FROM waste_entries
     WHERE product_id IS NOT NULL ORDER BY id
  `).all();
  let deltas = 0;
  for (const w of rows) {
    const o = OLD_computeProductCost(w.product_id);
    const n = NEW_computeProductCost(w.product_id);
    const oc = (o.cost_per_unit != null ? o.cost_per_unit : o.sell_price) * (w.qty || 0);
    const nc = (n.cost_per_unit != null ? n.cost_per_unit : n.sell_price) * (w.qty || 0);
    if (oc !== nc) {
      deltas++;
      if (deltas <= 20) console.log(`  DELTA waste_entry ${w.id} (product ${w.product_id}, qty ${w.qty}): OLD=${oc} NEW=${nc} (stored ${w.cost_lost})`);
    }
  }
  note(`${rows.length} waste_entries rows re-costed as a counterfactual`);
  assert(deltas === 0, `no historical waste row would be re-costed differently (${deltas} deltas)`);
}

console.log(`\n══ ${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed ══`);
if (failures > 0) {
  console.log('Step 2 moves a waste cost figure on live data. Stop and read the deltas above.');
  process.exit(1);
}
console.log('Consolidating waste.js onto lib/recipe-cost.js changes no number on today\'s data.');
console.log('The free_by_design fix it carries is latent: correct now, and correct later.');
process.exit(0);
