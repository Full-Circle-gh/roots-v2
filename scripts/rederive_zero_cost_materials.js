#!/usr/bin/env node
/**
 * rederive_zero_cost_materials.js — materials that were BOUGHT and PRICED but
 * whose per-unit cost was never worked out.
 *
 * WHY THIS EXISTS
 * ---------------
 * `ingredients.buy_price` is what a pack costs. `ingredients.cost_per_unit` is
 * what one recipe/build unit of it costs, and it is a STORED column — nothing
 * derives it on read. It is written at exactly two moments: a purchase-order
 * price write-back (routes/purchases.js) and a human saving the material form.
 * A row that has never been through either since its price was set keeps
 * `cost_per_unit = 0` while carrying a perfectly good `buy_price`.
 *
 * That reads as FREE to every consumer, and the product build list — which
 * refuses to publish a total containing an unpriced line — blocks on it. Found
 * live on ROOTS Plastic Jar Stickers (buy_price ¥0.0975, cost_per_unit 0),
 * which blocked Hazelnut-Chocolate Spread's whole build list. The same shape
 * was recorded across the label/sticker family in docs/packaging-findings.md.
 *
 * WHAT IT DOES, AND WHAT IT REFUSES TO DO
 * ---------------------------------------
 * For every active material with `buy_price > 0` and `cost_per_unit = 0` it
 * asks lib/ingredient-cost.js — THE one derivation, the same function
 * purchasing and the material form both call — what the per-unit cost should
 * be, and writes only what that function returns.
 *
 *   - It NEVER invents a divisor. `deriveCostPerUnit` returning null means
 *     "not derivable" and this script skips the row and prints the reason.
 *     That is the module's own rule ("null means write nothing, not zero")
 *     applied one level up.
 *   - It NEVER touches a row whose cost_per_unit is already non-zero. A wrong
 *     stored cost is a different problem with a different answer, and
 *     overwriting one here would hide it.
 *   - It NEVER touches a made material (`source_recipe_id` set). Those are
 *     owned by the recipe rollup and their buy_price is meaningless — writing
 *     a purchase-derived cost onto one would fight lib/recipe-rollup.js for
 *     the same column, which is the two-writers failure this codebase keeps
 *     paying for.
 *   - It NEVER touches `free_by_design` rows. Zero is their correct answer.
 *
 * DRY RUN BY DEFAULT. Prints the full plan and writes nothing. Pass --apply to
 * write, which runs in ONE transaction and fires the rollup afterwards so
 * every recipe and product cost that depended on these materials moves in the
 * same pass.
 *
 * Usage:
 *   node scripts/rederive_zero_cost_materials.js            # dry run
 *   node scripts/rederive_zero_cost_materials.js --apply    # write
 */
'use strict';

const path = require('path');
const APPLY = process.argv.includes('--apply');

const db = require(path.join(__dirname, '..', 'database'));
const { deriveCostPerUnit } = require(path.join(__dirname, '..', 'lib', 'ingredient-cost'));
const { fireRecompute } = require(path.join(__dirname, '..', 'lib', 'recipe-rollup'));

const rows = db.prepare(`
  SELECT id, name_en, name_cn, sku, item_kind, unit, buy_unit, buy_pack_size,
         pack_contents_qty, pack_contents_unit, cost_per_unit, buy_price,
         free_by_design, source_recipe_id
    FROM ingredients
   WHERE COALESCE(is_active, 1) = 1
     AND COALESCE(buy_price, 0) > 0
     AND COALESCE(cost_per_unit, 0) = 0
     AND COALESCE(free_by_design, 0) = 0
     AND source_recipe_id IS NULL
   ORDER BY item_kind, name_en COLLATE NOCASE
`).all();

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${rows.length} active material(s) with a buy price and no per-unit cost.\n`);

const plan = [];
const skip = [];
for (const r of rows) {
  const { cpu, reason } = deriveCostPerUnit(r, r.buy_price);
  if (cpu === null) { skip.push({ r, reason }); continue; }
  // Rounded the same 6dp the rollup and routes/admin.js's repair both use, so
  // a value written here is byte-identical to one written by either of them.
  plan.push({ r, cpu: Math.round(cpu * 1e6) / 1e6, reason });
}

if (plan.length) {
  console.log(`WOULD WRITE (${plan.length}):`);
  for (const p of plan) {
    console.log(
      `  #${String(p.r.id).padEnd(4)} ${String(p.r.name_en).slice(0, 42).padEnd(44)}`
      + ` ${String(p.r.item_kind || 'food').padEnd(10)}`
      + ` buy ${String(p.r.buy_price).padEnd(10)} / ${String(p.r.buy_unit || '').padEnd(6)}`
      + ` -> cost_per_unit ${p.cpu} per ${p.r.unit || ''}   (${p.reason})`
    );
  }
  console.log('');
}

if (skip.length) {
  console.log(`NOT DERIVABLE, LEFT ALONE (${skip.length}):`);
  for (const s of skip) {
    console.log(`  #${String(s.r.id).padEnd(4)} ${String(s.r.name_en).slice(0, 42).padEnd(44)} ${s.reason}`);
  }
  console.log('');
}

if (!APPLY) {
  console.log('Nothing was written. Re-run with --apply to write the plan above.');
  process.exit(0);
}

if (!plan.length) {
  console.log('Nothing to write.');
  process.exit(0);
}

const upd = db.prepare(
  'UPDATE ingredients SET cost_per_unit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND COALESCE(cost_per_unit,0) = 0'
);
// The compound match is the safety: a row whose cost was set by someone else
// between the plan and the write no longer matches, so this can only ever fill
// a still-empty figure. It can never overwrite a real one.
const tx = db.transaction(() => {
  let n = 0;
  for (const p of plan) {
    const r = upd.run(p.cpu, p.r.id);
    if (r.changes !== 1) {
      throw new Error(`expected to update exactly 1 row for material #${p.r.id} (${p.r.name_en}), matched ${r.changes}`);
    }
    n++;
  }
  return n;
});

const written = tx();
console.log(`Wrote ${written} material cost(s).`);

// Every recipe and product that consumed one of these was costed against a
// zero. Fire the existing rollup so those figures move in this same run
// rather than waiting for an unrelated save to trigger it.
const roll = fireRecompute(db, { source: 'scripts.rederive_zero_cost_materials' });
console.log('Rollup:', JSON.stringify(roll));
