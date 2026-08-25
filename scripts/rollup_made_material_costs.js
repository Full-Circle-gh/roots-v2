#!/usr/bin/env node
// The first nested-recipe cost rollup (§29 step 2) — THIS ONE MOVES MONEY.
//
// The 27 materials linked in step 1 still hold whatever cost they had before
// they were linked. This computes what each one's recipe actually says it costs
// and writes that. Every downstream recipe that consumes one re-prices as a
// result, which is the point and also the risk, so:
//
// DRY RUN BY DEFAULT — opens the database read-only and writes nothing.
//
//   node scripts/rollup_made_material_costs.js                     # dry run
//   node scripts/rollup_made_material_costs.js --apply             # writes
//   node scripts/rollup_made_material_costs.js --db /path/roots.db
//
// --apply additionally: copies the database first, re-plans from scratch
// INSIDE the write transaction, and refuses to write if that fresh plan
// differs from the one it just showed. A plan reviewed ten minutes ago is not
// evidence about the database now; drift fails the whole run closed rather
// than applying half of it.
//
// Re-runnable. A second run finds every cost already correct and reports zero
// changes — it is not a one-shot that corrupts on repeat.
//
// BLOCKED MATERIALS ARE NAMED, NOT ZEROED. A source recipe with no batch_size
// or an unpriced line writes nothing at all; the material keeps its old value
// and is listed under "blocked" with the reason. Writing 0 would make an
// unknown cost read as free, which is the one thing it never means.

'use strict';

const path = require('path');
const fs = require('fs');

function loadSqlite() {
  try { return require('better-sqlite3'); } catch (e) { /* fall through */ }
  for (const base of [path.join(__dirname, '..', '..', '..', '..'), '/root/roots-v2']) {
    try { return require(path.join(base, 'node_modules', 'better-sqlite3')); } catch (e) { /* next */ }
  }
  console.error('better-sqlite3 not found.');
  process.exit(2);
}
const Database = loadSqlite();
const { planRollup } = require(path.join(__dirname, '..', 'lib', 'recipe-rollup'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const dbIdx = args.indexOf('--db');
const DB_PATH = dbIdx >= 0 && args[dbIdx + 1] ? args[dbIdx + 1] : path.join(__dirname, '..', 'data', 'roots.db');

const money = n => (Number(n) || 0).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
const pad = (s, n) => String(s).padEnd(n);

const db = new Database(DB_PATH, { readonly: !APPLY, fileMustExist: true });
console.log(`${APPLY ? '*** APPLY — THIS WRITES ***' : 'DRY RUN'} · ${DB_PATH}${APPLY ? '' : ' (opened read-only)'}\n`);

const plan = planRollup(db);

// ── refuse on a cycle ───────────────────────────────────────────────────────
if (plan.cycle.length) {
  console.error('REFUSING: the linked-material graph contains a cycle.');
  console.error('Recipes that could not be ordered: ' + plan.cycle.join(', '));
  console.error('No order exists, so no cost can be defended. Break the loop first.');
  process.exit(1);
}

console.log(`linked materials: ${plan.linkedCount}`);
console.log(`dependency order: ${plan.order.join(' → ')}`);
console.log(`already correct:  ${plan.unchanged}\n`);

// ── what would change ───────────────────────────────────────────────────────
const changes = [...plan.changes].sort((a, b) => {
  const impact = c => Math.abs(c.newCpu - c.oldCpu) * Math.max(c.consumers.length, 1);
  return impact(b) - impact(a);
});

console.log(`══ ${changes.length} material cost(s) WOULD CHANGE ${'═'.repeat(30)}`);
if (!changes.length) console.log('  (none — every linked material already holds its recipe cost)');
for (const c of changes) {
  const dir = c.newCpu > c.oldCpu ? '↑' : '↓';
  console.log(`\n  ${pad(c.name, 34)} ${c.sku ? '[' + c.sku + ']' : ''}`);
  console.log(`    cost/${c.unit || 'g'}:  ${money(c.oldCpu)}  →  ${money(c.newCpu)}   ${dir}`);
  console.log(`    from its recipe: batch ${c.batchSize}${c.unit || 'g'} costing ¥${(c.batchCost).toFixed(2)}`);
  if (c.consumers.length) {
    console.log(`    consumed by ${c.consumers.length} recipe(s): ${c.consumers.join(', ')}`);
  } else {
    console.log(`    consumed by no other recipe yet`);
  }
}

// ── what is blocked, and why ────────────────────────────────────────────────
const REASON = {
  no_batch_size:      'the recipe has no batch size — nothing to divide by',
  unpriced_lines:     'the recipe has unpriced ingredient line(s)',
  no_ingredient_lines:'the recipe has no ingredient lines at all',
  no_cost_per_unit:   'the recipe cannot produce a per-unit cost',
  recipe_archived:    'the source recipe is archived',
  recipe_missing:     'the source recipe row is gone',
};
console.log(`\n\n══ ${plan.blocked.length} material(s) BLOCKED — nothing written, cost left as-is ${'═'.repeat(10)}`);
for (const b of plan.blocked) {
  const why = REASON[b.reason] || b.reason;
  console.log(`  ${pad(b.name, 34)} keeps ${money(b.oldCpu)}  — ${why}${b.unpriced ? ` (${b.unpriced} line(s))` : ''}`);
}
if (plan.blocked.length) {
  console.log('\n  These are NOT written as 0. A blocked cost is unknown, not free.');
}

// ── totals, so the output can be checked before it is trusted ───────────────
const up = changes.filter(c => c.newCpu > c.oldCpu).length;
const down = changes.filter(c => c.newCpu < c.oldCpu).length;
const fromZero = changes.filter(c => !(c.oldCpu > 0)).length;
console.log(`\n\n══ totals ${'═'.repeat(50)}`);
console.log(`  linked materials:      ${plan.linkedCount}`);
console.log(`  would change:          ${changes.length}   (${up} up, ${down} down; ${fromZero} rising from zero)`);
console.log(`  already correct:       ${plan.unchanged}`);
console.log(`  blocked (untouched):   ${plan.blocked.length}`);
console.log(`  ─────────────────────`);
console.log(`  accounted for:         ${changes.length + plan.unchanged + plan.blocked.length} of ${plan.linkedCount}`);

if (!APPLY) {
  console.log(`\nDRY RUN — nothing was written.`);
  console.log(`Review the above, then re-run with --apply to write these ${changes.length} cost(s).`);
  db.close();
  process.exit(0);
}

// ── apply ───────────────────────────────────────────────────────────────────
if (!changes.length) {
  console.log('\nNothing to write.');
  db.close();
  process.exit(0);
}

const backup = DB_PATH.replace(/\.db$/, `-pre-rollup-${Date.now()}.db`);
fs.copyFileSync(DB_PATH, backup);
console.log(`\nBacked up database → ${backup}`);

let written = 0;
const tx = db.transaction(() => {
  // Re-plan against the live database inside the transaction. If anything moved
  // since the plan printed above, the two disagree and the whole run aborts
  // with nothing written — better than applying a plan the operator did not see.
  const fresh = planRollup(db);
  const key = p => JSON.stringify(
    [...p.changes].sort((a, b) => a.ingredient_id - b.ingredient_id)
      .map(c => [c.ingredient_id, Math.round(c.oldCpu * 1e6), Math.round(c.newCpu * 1e6)])
  );
  if (key(fresh) !== key(plan)) {
    throw new Error('the database changed since the plan was computed — nothing written. Re-run the dry run and review it again.');
  }
  const upd = db.prepare('UPDATE ingredients SET cost_per_unit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND source_recipe_id = ?');
  for (const c of fresh.changes) {
    const res = upd.run(c.newCpu, c.ingredient_id, c.recipe_id);
    if (res.changes !== 1) {
      throw new Error(`expected to update exactly 1 row for #${c.ingredient_id} (${c.name}), updated ${res.changes} — nothing written.`);
    }
    written++;
    console.log(`  wrote ${pad(c.name, 34)} ${money(c.oldCpu)} → ${money(c.newCpu)}`);
  }
});

try {
  tx();
  console.log(`\nAPPLIED — ${written} material cost(s) written. ${plan.blocked.length} blocked material(s) untouched.`);
  console.log(`If anything looks wrong, the pre-apply database is at ${backup}`);
} catch (e) {
  console.error(`\nABORTED — ${e.message}`);
  console.error('The transaction rolled back; no cost was written.');
  db.close();
  process.exit(1);
}
db.close();
