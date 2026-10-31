#!/usr/bin/env node
/**
 * Fix variants that show a PLAIN description instead of the rich design blocks.
 *
 * Why: variants are spawned by POST /products/:id/duplicate?as_variant, which
 * copied `description_blocks` from the parent but NOT the `use_block_design`
 * toggle. So the copy landed with the parent's block JSON sitting in its
 * `description_blocks` column but `use_block_design = 0` — and the mini-app
 * product page only renders blocks when `use_block_design` is truthy
 * (miniapp/pages/product/product.js ~613). Result: the variant (e.g. the
 * big-size probiotic coconut yogurt) falls back to the plain-text renderer
 * even though it already has the full design-block description.
 *
 * The endpoint is now fixed for NEW variants (retail.js copies use_block_design).
 * This script repairs EXISTING rows: any product that has a non-empty
 * `description_blocks` array but `use_block_design = 0` gets the toggle flipped
 * to 1, so the customer page renders the blocks it already has.
 *
 * READ-ONLY by default (prints a plan, writes nothing). On --apply it backs up
 * data/roots.db first. Run ON THE SERVER:
 *
 *   node scripts/fix_variant_block_design.js            # scan (dry-run)
 *   node scripts/fix_variant_block_design.js --apply    # flip the toggle
 *   node scripts/fix_variant_block_design.js --variants-only --apply   # only rows in a variant group
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const VARIANTS_ONLY = argv.includes('--variants-only');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH);

function blockCount(json) {
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.length : 0; } catch { return 0; }
}

// Products carrying block JSON but with the renderer toggle OFF.
let rows = db.prepare(`
  SELECT id, name_en, name_cn, sku, variant_group_id, variant_label,
         description_blocks, COALESCE(use_block_design, 0) AS use_block_design
    FROM store_products
   WHERE COALESCE(is_active, 1) = 1
     AND COALESCE(use_block_design, 0) = 0
     AND description_blocks IS NOT NULL AND TRIM(description_blocks) NOT IN ('', '[]')
   ORDER BY variant_group_id, sku, id
`).all().filter(r => blockCount(r.description_blocks) > 0);

if (VARIANTS_ONLY) rows = rows.filter(r => r.variant_group_id != null);

console.log(`\nProducts with design blocks present but use_block_design = 0: ${rows.length}` +
            (VARIANTS_ONLY ? '  (variant-group rows only)' : ''));
console.log('\n  product                                          sku        blocks  variant');
for (const r of rows) {
  const v = r.variant_group_id != null
    ? `group ${r.variant_group_id}${r.id === r.variant_group_id ? ' (owner)' : ''}${r.variant_label ? ' · ' + r.variant_label : ''}`
    : '-';
  console.log(`  #${String(r.id).padEnd(5)} ${String(r.name_en || r.name_cn || '').slice(0, 40).padEnd(42)} ${String(r.sku || '-').padEnd(10)} ${String(blockCount(r.description_blocks)).padEnd(6)} ${v}`);
}

if (!APPLY) {
  console.log(`\nDRY RUN — nothing written. Re-run with --apply to flip use_block_design → 1 on the rows above.`);
  console.log(`  (add --variants-only to limit to rows that belong to a variant group)\n`);
  db.close();
  process.exit(0);
}

if (!rows.length) { console.log('\nNothing to fix.'); db.close(); process.exit(0); }

const backup = DB_PATH.replace(/\.db$/, `.backup-blockdesign.db`);
fs.copyFileSync(DB_PATH, backup);
console.log(`\nBacked up DB → ${path.basename(backup)}`);

const upd = db.prepare('UPDATE store_products SET use_block_design = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
const tx = db.transaction((list) => { for (const r of list) upd.run(r.id); });
tx(rows);

console.log(`Flipped use_block_design → 1 on ${rows.length} product(s). The mini-app will render their design blocks now (server reads live, no restart needed).\n`);
db.close();
