#!/usr/bin/env node
/**
 * diagnose_dressing_waste.js — can "was the dressing kept?" be asked at all,
 * and would the arithmetic behind it be right?
 *
 * WHY THIS EXISTS
 * ---------------
 * Ash, 2026-09-17: a fresh meal is often binned WITHOUT its dressing, because
 * the dressing is packed separately and kept (Roots freezes it). The waste
 * ledger charges the whole product cost either way, so every such entry is
 * overstated by the dressing's share. The proposal is a tick on the material
 * ("packed separately, can be kept") and a two-chip question on the waste
 * sheet that subtracts that material's share when the answer is "kept".
 *
 * THE PROPOSAL RESTS ON THREE FACTS NOBODY HAS MEASURED, and a feature built
 * on a guessed one silently produces a wrong number rather than failing:
 *
 *   1. WHICH COST SOURCE IS LIVE for the products that actually get wasted.
 *      §31's addendum makes a build list a product's ONLY cost source once it
 *      has one, and lib/recipe-rollup.js's applyProductCosts() skips exactly
 *      those products. So the tick has to hang off whichever list really feeds
 *      the figure, and the two are different tables. Ash reports the dressing
 *      sits in the RECIPE as a material; this checks that against the box.
 *
 *   2. WHETHER THE PER-UNIT SHARE CAN BE COMPUTED. A recipe's contribution to
 *      one sellable unit is costPerServing, i.e. a line's batch cost divided by
 *      `servings`. A recipe with no servings, or a servings figure that is
 *      wrong, yields a subtraction that is wrong in the same proportion — and
 *      wrong DOWNWARD, which flatters. resolveYield() already tells auto from
 *      stated; this prints both rather than trusting the stored column.
 *
 *   3. HOW MANY TICKS THIS ACTUALLY IS. One dressing across eight salads is one
 *      tick and a good feature. Eight dressings across eight salads, each used
 *      once, is eight ticks for ¥4 a week and probably not worth building.
 *
 * It also prices the thing honestly: section 6 totals what the LIVE waste
 * ledger would have recorded had every dressing-ish line been excluded, so the
 * decision is taken against a real number rather than my estimate of one.
 *
 * IT DECIDES NOTHING AND CHANGES NOTHING. Read-only, and it proves it: the
 * database is opened `readonly: true` and a write is attempted and REQUIRED to
 * fail before any query runs.
 *
 * THE MATHS IS BORROWED, NOT RESTATED. computeRecipeCost() and
 * computeProductBuildCost() are the same two functions the rollup itself calls.
 * A measurement taken under its own re-derivation of costPerServing would be
 * grading a formula this repo does not use — the exact drift lib/recipe-cost.js's
 * header records as having produced four disagreeing copies.
 *
 * THE DRESSING MATCH IS A HEURISTIC AND IS LABELLED AS ONE. There is no
 * "dressing" concept in the schema — that is the whole point of the proposed
 * tick — so section 4 matches on name, in both languages, and prints what it
 * matched so a human can see what it caught and what it missed. Nothing here
 * depends on the match being complete; it is sizing the job, not doing it.
 *
 * HOW TO RUN IT
 *   .github/workflows/ro-query.yml (workflow_dispatch) with
 *     script = scripts/diagnose_dressing_waste.js
 *   Dispatch it against THIS BRANCH — the workflow checks out the ref it is
 *   given, and this file does not exist on main.
 */
'use strict';

const path = require('path');
const Database = require('@libsql/client');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || path.join(HOME, 'data', 'roots.db');

const { computeRecipeCost } = require(path.join(HOME, 'lib', 'recipe-cost'));
const { computeProductBuildCost } = require(path.join(HOME, 'lib', 'product-build-cost'));

// ── Output helpers ─────────────────────────────────────────────────────────
const out = (s = '') => console.log(s);
const rule = (t) => { out(); out('═'.repeat(78)); out(t); out('═'.repeat(78)); };
const sub = (t) => { out(); out('── ' + t + ' ' + '─'.repeat(Math.max(0, 74 - t.length))); };
const yuan = (n) => n == null ? '—' : '¥' + (Number(n) || 0).toFixed(4).replace(/0+$/, '').replace(/\.$/, '.00');
const money = (n) => n == null ? '—' : '¥' + (Number(n) || 0).toFixed(2);
const pct = (num, den) => (!Number(den) ? '—' : ((100 * Number(num)) / Number(den)).toFixed(1) + '%');

// ── Open read-only, and prove it ───────────────────────────────────────────
// A readonly flag that is not enforced is a comment. The write below must be
// REJECTED; if SQLite accepts it, this script holds a writable handle on
// production and must abort before it reads anything, not after.
let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error(`[dressing] cannot open ${DB_PATH}: ${e && e.message}`);
  process.exit(1);
}
try {
  db.prepare('CREATE TABLE _dressing_write_probe (x INTEGER)').run();
  console.error('[dressing] ABORT: the connection accepted a write. Not read-only.');
  process.exit(1);
} catch (e) {
  if (!/readonly|read-only|attempt to write/i.test(String(e && e.message))) {
    console.error(`[dressing] ABORT: write refused for an unexpected reason: ${e && e.message}`);
    process.exit(1);
  }
}

const has = (table) => {
  try { db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get(); return true; } catch (e) { return false; }
};

out('db:           ' + DB_PATH);
out('run at (UTC): ' + new Date().toISOString());

// ── Cost source, per §31's addendum ────────────────────────────────────────
// The order is not a preference, it is the rule: a product with any build line
// has ONE cost source and recipe_id is not consulted for it. Mirrors
// applyProductCosts()'s `buildListProductIds.has(p.id) -> skip` exactly.
const buildListIds = (() => {
  try {
    return new Set(db.prepare('SELECT DISTINCT product_id FROM product_build_lines').all().map(r => r.product_id));
  } catch (e) { return new Set(); }
})();

function costSource(p) {
  if (buildListIds.has(p.id)) return 'build-list';
  if (p.recipe_id != null) return 'recipe';
  return 'typed/none';
}

// ── The dressing heuristic, stated out loud ────────────────────────────────
// Name-matched in both languages because the schema has no such concept. Every
// match is PRINTED so the reader can judge it; nothing downstream assumes it is
// complete or correct.
const DRESSING_RE = /dressing|vinaigrette|tahini|tzatziki|aioli|zhoug|mayo|mayonnaise|sauce|dip|pesto|chimichurri|harissa|hummus|yog(h)?urt sauce|酱|汁|沙拉酱|调味/i;
const looksDressing = (name) => DRESSING_RE.test(String(name || ''));

// ════════════════════════════════════════════════════════════════════════════
rule('1 · WHAT ACTUALLY GETS WASTED, AND HOW EACH ONE IS COSTED');
// The live subset only — a voided loss and its reversal are not losses, and
// routes/retail-waste.js's own LIVE_ONLY predicate is the one being honoured.
let wasted = [];
if (!has('waste_records')) {
  out('  waste_records does not exist on this box — nothing to measure.');
} else {
  wasted = db.prepare(`
    SELECT w.store_product_id AS id,
           COUNT(*)           AS entries,
           SUM(w.qty)         AS units,
           SUM(COALESCE(w.cost_total_cents, 0)) AS cents,
           SUM(CASE WHEN w.is_uncosted = 1 THEN 1 ELSE 0 END) AS uncosted,
           MIN(w.business_date) AS first_date,
           MAX(w.business_date) AS last_date,
           sp.name_en, sp.name_cn, sp.unit_cost, sp.recipe_id
      FROM waste_records w
      LEFT JOIN store_products sp ON sp.id = w.store_product_id
     WHERE w.subject_type = 'product'
       AND w.reverses_waste_id IS NULL
       AND w.voided_by_waste_id IS NULL
     GROUP BY w.store_product_id
     ORDER BY cents DESC
  `).all();

  if (!wasted.length) {
    out('  No live product waste recorded yet.');
  } else {
    const totalCents = wasted.reduce((a, r) => a + (r.cents || 0), 0);
    out(`  ${wasted.length} distinct products, ${money(totalCents / 100)} written off in total`);
    out(`  window: ${wasted[0].first_date || '—'} … ${wasted.reduce((a, r) => r.last_date > a ? r.last_date : a, '')}`);
    out();
    out('  ' + 'product'.padEnd(34) + 'cost src'.padEnd(12) + 'unit'.padStart(9)
        + 'units'.padStart(7) + 'written off'.padStart(13));
    out('  ' + '─'.repeat(74));
    for (const r of wasted) {
      const src = costSource(r);
      out('  ' + String(r.name_en || ('#' + r.id + ' (deleted)')).slice(0, 33).padEnd(34)
          + src.padEnd(12)
          + String(r.unit_cost == null ? '—' : money(r.unit_cost)).padStart(9)
          + String(r.units).padStart(7)
          + money((r.cents || 0) / 100).padStart(13)
          + (r.uncosted ? '   (' + r.uncosted + ' uncosted)' : ''));
    }
    out();
    const bySrc = {};
    for (const r of wasted) { const s = costSource(r); bySrc[s] = (bySrc[s] || 0) + (r.cents || 0); }
    out('  Money written off, by which list feeds the cost:');
    for (const k of Object.keys(bySrc)) {
      out('    ' + k.padEnd(14) + money(bySrc[k] / 100).padStart(11) + '   ' + pct(bySrc[k], totalCents));
    }
    out();
    out('  READ THIS ROW FIRST. A product costed "typed/none" has no list of any');
    out('  kind behind its figure, so there is no dressing line to subtract and the');
    out('  proposed tick cannot reach it at all.');
  }
}

// ════════════════════════════════════════════════════════════════════════════
rule('2 · THE YIELD BEHIND EACH WASTED, RECIPE-COSTED PRODUCT');
out('  costPerServing is the figure the ledger charges, and it is a line\'s batch');
out('  cost divided by `servings`. A wrong servings makes the SUBTRACTION wrong in');
out('  the same proportion, downward, which flatters. auto = derived by');
out('  resolveYield(); stated = the typed column stands.');

const recipeProducts = wasted.filter(r => costSource(r) === 'recipe' && r.recipe_id != null);
if (!recipeProducts.length) {
  out();
  out('  None. (Either nothing wasted is recipe-costed, or section 1 found nothing.)');
} else {
  for (const p of recipeProducts) {
    sub(`${p.name_en || '#' + p.id}  ·  recipe #${p.recipe_id}`);
    let c = null;
    try { c = computeRecipeCost(p.recipe_id, db); } catch (e) {
      out('  computeRecipeCost threw: ' + (e && e.message));
      continue;
    }
    if (!c) { out('  computeRecipeCost returned nothing.'); continue; }
    out('  recipe            ' + (c.name_en || '') + (c.name_cn ? ' · ' + c.name_cn : ''));
    out('  servings          ' + c.servings + '   (' + (c.servingsAuto ? 'auto' : 'stated') + ')'
        + (c.servingsLeftover != null ? '   leftover ' + c.servingsLeftover + 'g' : ''));
    out('  batch size        ' + c.batchSize + 'g  (' + (c.batchSizeAuto ? 'auto' : 'stated') + ')');
    out('  cost per serving  ' + yuan(c.costPerServing)
        + '        product row says ' + (p.unit_cost == null ? '—' : yuan(p.unit_cost)));
    if (c.costPerServing != null && p.unit_cost != null
        && Math.abs(Number(c.costPerServing) - Number(p.unit_cost)) > 1e-6) {
      out('  ⚠ THE TWO DISAGREE — the stored figure is stale or blocked. Waste charges');
      out('    the STORED one, so a subtraction computed from the recipe would not');
      out('    line up with what the ledger recorded.');
    }
    if (!c.servings) out('  ⚠ NO SERVINGS. A per-unit share cannot be computed at all.');
    if (c.zeroCostIngredientLines) out('  ⚠ ' + c.zeroCostIngredientLines + ' line(s) with no cost');
    if (c.unreconciledUnitLines) out('  ⚠ ' + c.unreconciledUnitLines + ' line(s) whose unit cannot be reconciled');
  }
}

// ════════════════════════════════════════════════════════════════════════════
rule('3 · THE LINES, AND WHAT EACH IS WORTH IN ONE SELLABLE UNIT');
out('  This is the table the feature reads. "per unit" is what would come off the');
out('  waste cost if that line were ticked "packed separately" and the operator');
out('  answered "kept".');

for (const p of recipeProducts) {
  let c = null;
  try { c = computeRecipeCost(p.recipe_id, db); } catch (e) { c = null; }
  if (!c || !c.lines || !c.lines.length) continue;
  const servings = Number(c.servings) || 0;
  sub(`${p.name_en || '#' + p.id}  ·  ${servings || '?'} servings  ·  unit cost ${yuan(c.costPerServing)}`);
  out('    ' + 'material'.padEnd(32) + 'qty'.padStart(9) + ' u'
      + 'batch'.padStart(11) + 'per unit'.padStart(11) + 'share'.padStart(8) + '  flag');
  out('    ' + '─'.repeat(72));
  for (const l of c.lines) {
    const perUnit = (l.lineCost != null && servings) ? l.lineCost / servings : null;
    const share = (perUnit != null && c.costPerServing) ? pct(perUnit, c.costPerServing) : '—';
    out('    ' + String(l.name || '').slice(0, 31).padEnd(32)
        + String(l.qty).padStart(9) + ' ' + String(l.unit || '').padEnd(4)
        + (l.lineCost == null ? '—' : yuan(l.lineCost)).padStart(9)
        + (perUnit == null ? '—' : yuan(perUnit)).padStart(11)
        + String(share).padStart(8)
        + (looksDressing(l.name) || looksDressing(l.name_cn) ? '   ← dressing?' : '')
        + (l.freeByDesign ? '   free' : '')
        + (l.unreconciledUnit ? '   UNIT MISMATCH' : ''));
  }
}

// Build-list products get the same treatment — a build line already describes
// ONE sellable unit, so there is no servings division and no place for it to go
// wrong. Printed so the two shapes can be compared side by side.
const buildProducts = wasted.filter(r => costSource(r) === 'build-list');
for (const p of buildProducts) {
  let c = null;
  try { c = computeProductBuildCost(p.id, db); } catch (e) { c = null; }
  if (!c || !c.lines || !c.lines.length) continue;
  sub(`${p.name_en || '#' + p.id}  ·  BUILD LIST (one unit, no servings division)`);
  out('    ' + 'material'.padEnd(32) + 'qty'.padStart(9) + ' u' + 'per unit'.padStart(11) + 'share'.padStart(8) + '  flag');
  out('    ' + '─'.repeat(72));
  for (const l of c.lines) {
    out('    ' + String(l.name || '').slice(0, 31).padEnd(32)
        + String(l.qty).padStart(9) + ' ' + String(l.unit || '').padEnd(4)
        + (l.lineCost == null ? '—' : yuan(l.lineCost)).padStart(11)
        + String(l.lineCost != null && c.unitCost ? pct(l.lineCost, c.unitCost) : '—').padStart(8)
        + (looksDressing(l.name) || looksDressing(l.name_cn) ? '   ← dressing?' : ''));
  }
}

// ════════════════════════════════════════════════════════════════════════════
rule('4 · HOW MANY TICKS IS THIS? (dressing-ish materials and their reach)');
out('  Name-matched heuristic — see the header. Printed in full so the reader can');
out('  judge what it caught and what it missed.');
out();
const dressMats = db.prepare(`
  SELECT i.id, i.name_en, i.name_cn, i.unit, i.cost_per_unit, i.free_by_design,
         COALESCE(i.is_active, 1) AS is_active,
         (SELECT COUNT(DISTINCT ri.recipe_id) FROM recipe_ingredients ri WHERE ri.ingredient_id = i.id) AS in_recipes
    FROM ingredients i
   ORDER BY i.name_en
`).all().filter(m => looksDressing(m.name_en) || looksDressing(m.name_cn));

let buildUse = new Map();
try {
  for (const r of db.prepare(
    'SELECT ingredient_id AS id, COUNT(DISTINCT product_id) AS n FROM product_build_lines WHERE ingredient_id IS NOT NULL GROUP BY ingredient_id'
  ).all()) buildUse.set(r.id, r.n);
} catch (e) { /* table absent */ }

if (!dressMats.length) {
  out('  Nothing matched. Either the naming is different, or the dressing is not a');
  out('  material of its own — both of which change the proposal.');
} else {
  out('  ' + 'material'.padEnd(36) + 'cost/unit'.padStart(12) + 'recipes'.padStart(9) + 'builds'.padStart(8));
  out('  ' + '─'.repeat(66));
  for (const m of dressMats) {
    out('  ' + String(m.name_en || '').slice(0, 35).padEnd(36)
        + (m.cost_per_unit ? yuan(m.cost_per_unit) + '/' + (m.unit || '') : '—').padStart(12)
        + String(m.in_recipes).padStart(9)
        + String(buildUse.get(m.id) || 0).padStart(8)
        + (m.is_active ? '' : '   archived')
        + (m.free_by_design ? '   free by design' : ''));
  }
  const reach = dressMats.reduce((a, m) => a + m.in_recipes + (buildUse.get(m.id) || 0), 0);
  out();
  out(`  ${dressMats.length} tick(s) would cover ${reach} recipe/product list(s).`);
  out('  A high ratio is the case FOR the material-level tick. A ratio near 1:1 means');
  out('  a tick per product either way, and the feature is worth much less.');
}

// ════════════════════════════════════════════════════════════════════════════
rule('5 · REACH ACROSS THE WHOLE CATALOGUE');
const actives = db.prepare(
  'SELECT id, name_en, recipe_id, unit_cost FROM store_products WHERE COALESCE(is_active,1) = 1'
).all();
const tally = { 'build-list': 0, recipe: 0, 'typed/none': 0 };
for (const p of actives) tally[costSource(p)]++;
out('  active products            ' + String(actives.length).padStart(5));
for (const k of Object.keys(tally)) {
  out('    costed by ' + k.padEnd(14) + String(tally[k]).padStart(5) + '   ' + pct(tally[k], actives.length));
}
const dressIds = new Set(dressMats.map(m => m.id));
let withDressing = 0;
for (const p of actives) {
  const src = costSource(p);
  let ids = [];
  if (src === 'recipe') {
    ids = db.prepare('SELECT ingredient_id AS id FROM recipe_ingredients WHERE recipe_id = ?').all(p.recipe_id).map(r => r.id);
  } else if (src === 'build-list') {
    try { ids = db.prepare('SELECT ingredient_id AS id FROM product_build_lines WHERE product_id = ?').all(p.id).map(r => r.id); } catch (e) { ids = []; }
  }
  if (ids.some(id => dressIds.has(id))) withDressing++;
}
out('  products whose list holds a dressing-ish material   ' + String(withDressing).padStart(4)
    + '   ' + pct(withDressing, actives.length));

// ════════════════════════════════════════════════════════════════════════════
rule('6 · WHAT THE FEATURE WOULD HAVE BEEN WORTH, ON THE REAL LEDGER');
out('  The upper bound: every live waste entry re-priced as if the dressing had');
out('  been kept EVERY time. The true saving is some fraction of this, and nobody');
out('  can know which fraction until the question is actually being asked.');
out();
if (!wasted.length) {
  out('  Nothing to measure.');
} else {
  // Per-unit dressing share, by product, from whichever list is that product's
  // real cost source — the same precedence §31's addendum sets.
  const shareOf = new Map();
  for (const p of wasted) {
    const src = costSource(p);
    let share = 0;
    if (src === 'recipe' && p.recipe_id != null) {
      let c = null;
      try { c = computeRecipeCost(p.recipe_id, db); } catch (e) { c = null; }
      const servings = c && Number(c.servings);
      if (c && c.lines && servings) {
        for (const l of c.lines) {
          if (l.lineCost != null && l.ingredient_id != null && dressIds.has(l.ingredient_id)) {
            share += l.lineCost / servings;
          }
        }
      }
    } else if (src === 'build-list') {
      let c = null;
      try { c = computeProductBuildCost(p.id, db); } catch (e) { c = null; }
      if (c && c.lines) {
        for (const l of c.lines) {
          if (l.lineCost != null && l.ingredient_id != null && dressIds.has(l.ingredient_id)) share += l.lineCost;
        }
      }
    }
    shareOf.set(p.id, share);
  }

  let totalCents = 0, saveableCents = 0;
  out('  ' + 'product'.padEnd(34) + 'units'.padStart(7) + 'written off'.padStart(13) + 'recoverable'.padStart(13));
  out('  ' + '─'.repeat(68));
  for (const p of wasted) {
    const share = shareOf.get(p.id) || 0;
    const rec = Math.round(share * Number(p.units || 0) * 100);
    totalCents += (p.cents || 0);
    saveableCents += Math.min(rec, p.cents || 0);
    if (rec > 0) {
      out('  ' + String(p.name_en || '#' + p.id).slice(0, 33).padEnd(34)
          + String(p.units).padStart(7)
          + money((p.cents || 0) / 100).padStart(13)
          + money(Math.min(rec, p.cents || 0) / 100).padStart(13));
    }
  }
  out('  ' + '─'.repeat(68));
  out('  ' + 'TOTAL'.padEnd(41) + money(totalCents / 100).padStart(13) + money(saveableCents / 100).padStart(13));
  out();
  out('  Upper bound on the overstatement: ' + pct(saveableCents, totalCents) + ' of the waste ledger.');
  out('  Judge the build against this figure, not against the idea.');
}

out();
out('done.');
