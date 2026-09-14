#!/usr/bin/env node
/**
 * One-off: mark "this cost is not complete" across the catalogue.
 *
 * Ash's instruction, 2026-09-14: set store_products.cost_incomplete on EVERY
 * product except forty named SKUs. The forty, and whether their other pack
 * sizes count with them, live in lib/cost-complete-keep-list.js — one list,
 * read by this script and by scripts/diagnose_cost_incomplete_sweep.js alike,
 * so the survey and the write cannot disagree about what was asked for.
 *
 *   node scripts/oneoff_mark_cost_incomplete.js          # prints the plan, writes nothing
 *   node scripts/oneoff_mark_cost_incomplete.js --apply  # write
 *
 * Run it through Actions → "One-off prod repair". Dry run first; that path
 * takes a verified online backup before it writes.
 *
 * ── WHAT IT WRITES ────────────────────────────────────────────────────────
 * One column, one value: cost_incomplete = 1, on active rows that are not
 * keepers and do not already hold 1. Nothing else on the row is touched —
 * not unit_cost, not the prices, not updated_at. The tag is a fact about the
 * cost and changing it is not an edit to the product.
 *
 * ── WHAT IT REFUSES TO TOUCH ──────────────────────────────────────────────
 * THE KEEPERS' OWN TAGS, IN EITHER DIRECTION. Two of the forty (1-370, 1-90)
 * already carry a 1 from the 2026-08 seed. Ash said what to do to the OTHER
 * products; he did not say to clear these. Clearing a tag somebody set on
 * purpose is the one move here that cannot be read back off the page
 * afterwards, so it is left for him to make in the editor, and this script
 * names them in its output every run.
 *
 * DELETED PRODUCTS. is_active = 0. routes/retail.js nulls their sku on delete,
 * so an exception list could not name them even if anyone wanted to, and a tag
 * on a row nobody can reach says nothing to anybody.
 *
 * ROWS THAT ALREADY HOLD 1. Skipped, so the count printed is the count of rows
 * that actually change and a second run reports nothing to do.
 *
 * OTHER TENANTS. It writes to the database it is pointed at and no other. Roots
 * is tenant #1 in roots.db; the per-tenant files (lib/tenant-db.js) are separate
 * businesses whose costs are not Ash's to tag. The 2026-09-14 survey found none
 * of them even carries the column.
 *
 * ── THE GUARD THAT CAN STOP IT ────────────────────────────────────────────
 * A KEEPER THAT MATCHES NO ROW IS A SILENT WRONG MARK. The forty were typed by
 * hand; a typo matches nothing, the product it meant to spare gets marked, and
 * nothing in the write says so. So an unmatched keeper ABORTS the run — unless
 * it is explained by a keeper that DID match being a prefix of it.
 *
 * That exception is not a loophole, it is the observed case: `1-310 D` and
 * `1-320 D` match no row, while `1-310` (Beet Salad) and `1-320` (Thai
 * Buckwheat Noodle Salad) match and are spared. The "D" spellings name
 * products this table does not hold separately, and the products they name are
 * already excluded — so no row is marked that Ash asked to be spared, which is
 * the only thing the guard is protecting. A keeper explained by nothing is a
 * typo and stops the run.
 *
 * A keeper matching MORE THAN ONE row also aborts: the forty were read off a
 * page that folds variants, and two rows on one sku means the sku is not the
 * identifier this assumed it was.
 *
 * ── HOW IT WRITES ─────────────────────────────────────────────────────────
 * One transaction. It re-counts inside the same transaction after the UPDATE
 * and rolls back if the after-count is not what the plan predicted — a write
 * that touched a different number of rows than it said it would is not a write
 * anybody should keep.
 *
 * NO BACKUP IS TAKEN HERE, DELIBERATELY. .github/workflows/oneoff.yml takes one
 * first on the apply path, through SQLite's online .backup API with an
 * integrity_check that aborts the run if it is not "ok". A byte copy from in
 * here would be the weaker thing: roots.db carries a live WAL, so a copy of the
 * main file alone is torn.
 *
 * EXIT CODES
 *   0  ran (dry run, or applied)
 *   1  ABORTED: a keeper matched no row or several, or the after-count did not
 *      match the plan. Nothing was written.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const WRITE = process.argv.includes('--apply');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const Database = (() => {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3')); }
})();

const {
  KEEP_SKUS, KEEP_SIBLINGS, skuKey, isKeeper, namesKeeper,
} = require(path.join(HOME, 'lib', 'cost-complete-keep-list.js'));

const dbPath = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
if (!fs.existsSync(dbPath)) { console.error('DB not found at', dbPath); process.exit(1); }
const db = new Database(dbPath);

const J = v => (v === null || v === undefined ? 'NULL' : String(v));
const state = v => (v === null || v === undefined ? 'NULL' : String(v));

console.log(`\n${WRITE ? 'APPLYING' : 'DRY RUN'} — ${dbPath}`);
console.log(`keepers named: ${KEEP_SKUS.length}   other pack sizes count as keepers: ${KEEP_SIBLINGS}\n`);

const rows = db.prepare(`
  SELECT id, sku, name_en, COALESCE(is_active, 1) AS is_active,
         unit_cost, cost_incomplete, variant_group_id
    FROM store_products`).all();
const active = rows.filter(r => r.is_active === 1);

// ── the guard ─────────────────────────────────────────────────────────────
const byKey = new Map();
for (const r of rows) {
  const k = skuKey(r.sku);
  if (k == null) continue;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(r);
}
const matched = KEEP_SKUS.filter(s => (byKey.get(skuKey(s)) || []).length === 1);
const several = KEEP_SKUS.filter(s => (byKey.get(skuKey(s)) || []).length > 1);
const unmatched = KEEP_SKUS.filter(s => !(byKey.get(skuKey(s)) || []).length);

// Explained: a keeper that DID match is a prefix of this one, so the product it
// names is already spared and no row is marked that Ash asked to spare.
const matchedKeys = matched.map(skuKey);
const explained = s => matchedKeys.some(k => k !== skuKey(s) && skuKey(s).startsWith(k));
const unexplained = unmatched.filter(s => !explained(s));

console.log(`keepers matched exactly one row: ${matched.length}`);
if (unmatched.length) {
  console.log(`\nkeepers matching NO row: ${unmatched.length}`);
  for (const s of unmatched) {
    const why = explained(s)
      ? `explained — ${matchedKeys.filter(k => skuKey(s).startsWith(k) && k !== skuKey(s)).join(', ')} matched and is spared`
      : 'UNEXPLAINED';
    console.log(`   ${String(s).padEnd(10)} ${why}`);
  }
}
if (several.length) console.log(`\nkeepers matching SEVERAL rows: ${several.join(', ')}`);

if (unexplained.length || several.length) {
  console.error('\nABORTED. A keeper that matches no row silently marks the product it meant to spare,');
  console.error('and a keeper matching several means the sku is not the identifier this assumed.');
  console.error('Fix the list in lib/cost-complete-keep-list.js. Nothing was written.\n');
  db.close();
  process.exit(1);
}

// ── the plan ──────────────────────────────────────────────────────────────
const keeperGroups = new Set(
  active.filter(r => isKeeper(r.sku) && r.variant_group_id != null && r.variant_group_id !== '')
        .map(r => String(r.variant_group_id)));

// A row is spared when it is one of the forty, or — with KEEP_SIBLINGS on — it
// is the same goods in another pack: the same variant family as a keeper, or a
// keeper's code inside its own sku.
const sparedBecause = (r) => {
  if (isKeeper(r.sku)) return 'named';
  if (!KEEP_SIBLINGS) return null;
  if (r.variant_group_id != null && r.variant_group_id !== ''
      && keeperGroups.has(String(r.variant_group_id))) return 'same variant family as a keeper';
  if (namesKeeper(r.sku)) return "names a keeper's code";
  return null;
};

const spared = active.filter(r => sparedBecause(r));
const targets = active.filter(r => !sparedBecause(r));
const toWrite = targets.filter(r => r.cost_incomplete !== 1);
const keptTagged = spared.filter(r => r.cost_incomplete === 1);

console.log(`\nactive products                 ${active.length}`);
console.log(`spared                          ${spared.length}`);
for (const why of ['named', 'same variant family as a keeper', "names a keeper's code"]) {
  const n = spared.filter(r => sparedBecause(r) === why).length;
  if (n) console.log(`   ${String(n).padStart(3)}  ${why}`);
}
console.log(`would be marked                 ${targets.length}`);
console.log(`   already 1, skipped           ${targets.length - toWrite.length}`);
console.log(`   ACTUALLY WRITTEN             ${toWrite.length}`);
console.log(`inactive rows, untouched        ${rows.length - active.length}`);

if (KEEP_SIBLINGS) {
  const sibs = spared.filter(r => sparedBecause(r) !== 'named');
  console.log(`\nspared as another pack of a keeper (${sibs.length}):`);
  for (const r of sibs) console.log(`   id ${String(r.id).padEnd(4)} sku ${J(r.sku).padEnd(20)} ${J(r.name_en)}`);
}

console.log(`\nspared products that ALREADY carry the tag — left exactly as they are (${keptTagged.length}):`);
if (!keptTagged.length) console.log('   (none)');
for (const r of keptTagged) console.log(`   id ${String(r.id).padEnd(4)} sku ${J(r.sku).padEnd(20)} ${J(r.name_en)}`);

if (!toWrite.length) {
  console.log('\nNothing to do — every product that should carry the tag already does.\n');
  db.close();
  process.exit(0);
}

if (!WRITE) {
  console.log(`\n── the ${toWrite.length} row(s) that would change ──`);
  console.log('   id   | sku                  | from | cost    | name');
  for (const r of toWrite) {
    console.log(`   ${String(r.id).padEnd(4)} | ${J(r.sku).padEnd(20)} | ${state(r.cost_incomplete).padEnd(4)} | ${J(r.unit_cost).padEnd(7)} | ${J(r.name_en)}`);
  }
  console.log('\nDRY RUN — nothing was written. Re-run with apply=true to write.\n');
  db.close();
  process.exit(0);
}

// ── the write ─────────────────────────────────────────────────────────────
const ids = toWrite.map(r => r.id);
// Every target ends up at 1, AND the spared rows that already held one keep
// it — this script clears nothing. Counting only the targets predicted 5 where
// the table would truthfully hold 7, and the transaction below rolled the whole
// write back on the mismatch. That is the check working; the arithmetic it was
// checking against was the thing that was wrong.
const expectedAfter = targets.length + keptTagged.length;

const apply = db.transaction(() => {
  const upd = db.prepare('UPDATE store_products SET cost_incomplete = 1 WHERE id = ?');
  let n = 0;
  for (const id of ids) n += upd.run(id).changes;
  // Re-counted inside the transaction: a write that touched a different number
  // of rows than the plan named is not a write anybody should keep.
  const after = db.prepare(
    'SELECT COUNT(*) AS n FROM store_products WHERE COALESCE(is_active,1) = 1 AND cost_incomplete = 1').get().n;
  if (n !== ids.length) throw new Error(`updated ${n} row(s), planned ${ids.length}`);
  if (after !== expectedAfter) throw new Error(`after the write ${after} active row(s) carry the tag, planned ${expectedAfter}`);
  return { n, after };
});

try {
  const { n, after } = apply();
  console.log(`\nWROTE ${n} row(s). ${after} active product(s) now carry "this cost is not complete".`);
  console.log(`${spared.length} spared, of which ${keptTagged.length} already carried the tag and were left alone.\n`);
} catch (e) {
  console.error('\nABORTED and ROLLED BACK: ' + e.message);
  console.error('Nothing was written.\n');
  db.close();
  process.exit(1);
}
db.close();
