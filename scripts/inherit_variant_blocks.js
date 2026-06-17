#!/usr/bin/env node
/**
 * Give variant siblings the design-block description their group owner has.
 *
 * Some variants (e.g. "Big Size Probiotic Coconut Yogurt") were created before
 * the duplicate endpoint copied design blocks, so their `description_blocks` is
 * EMPTY — they fall back to rich-HTML / plain text on the PDP while the group
 * owner (the base flavor) shows the full design blocks. A size variant is the
 * same product as its owner (just a different size), so the owner's blocks are
 * the right description to show.
 *
 * For every NON-owner variant row (id != variant_group_id) whose own
 * description_blocks is empty but whose OWNER has non-empty blocks, this copies
 * the owner's description_blocks down and sets use_block_design = 1. The
 * variant's own name/price/size/text are left untouched.
 *
 * READ-ONLY by default (prints a plan, writes nothing). On --apply it backs up
 * data/roots.db first. Run ON THE SERVER:
 *   node scripts/inherit_variant_blocks.js            # scan (dry-run)
 *   node scripts/inherit_variant_blocks.js --apply    # copy owner blocks down
 *   node scripts/inherit_variant_blocks.js --group 90 --apply   # one group only
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
function flag(name, def) { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; }
const ONLY_GROUP = flag('--group', null) != null ? parseInt(flag('--group', null), 10) : null;

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH);

function blockCount(json) { try { const a = JSON.parse(json); return Array.isArray(a) ? a.length : 0; } catch { return 0; } }

// Non-owner variant rows with NO blocks of their own.
let variants = db.prepare(`
  SELECT id, name_en, name_cn, sku, variant_group_id, variant_label, description_blocks
    FROM store_products
   WHERE COALESCE(is_active,1)=1
     AND variant_group_id IS NOT NULL
     AND id != variant_group_id
   ORDER BY variant_group_id, id
`).all().filter(v => blockCount(v.description_blocks) === 0);

if (ONLY_GROUP != null) variants = variants.filter(v => v.variant_group_id === ONLY_GROUP);

// Pair each with its owner; keep only those whose owner actually has blocks.
const getOwner = db.prepare('SELECT id, name_en, description_blocks, COALESCE(use_block_design,0) AS ubd FROM store_products WHERE id = ?');
const fixable = [];
const skipped = [];
for (const v of variants) {
  const owner = getOwner.get(v.variant_group_id);
  const oc = owner ? blockCount(owner.description_blocks) : 0;
  if (owner && oc > 0) fixable.push({ v, owner, oc });
  else skipped.push({ v, reason: owner ? 'owner has no blocks either' : 'owner row missing' });
}

console.log(`\nVariant siblings with empty blocks whose owner HAS blocks: ${fixable.length}` + (ONLY_GROUP != null ? `  (group ${ONLY_GROUP} only)` : ''));
console.log('\n  variant                                          sku        ← owner (blocks)');
for (const f of fixable) {
  console.log(`  #${String(f.v.id).padEnd(5)} ${String(f.v.name_en||f.v.name_cn||'').slice(0,40).padEnd(42)} ${String(f.v.sku||'-').padEnd(10)} ← #${f.owner.id} ${String(f.owner.name_en||'').slice(0,22)} (${f.oc})`);
}
if (skipped.length) {
  console.log(`\n  Skipped (owner has no blocks to give): ${skipped.map(s => '#' + s.v.id).join(', ')}`);
}

if (!APPLY) {
  console.log(`\nDRY RUN — nothing written. Re-run with --apply to copy each owner's design_blocks into the variant above and turn use_block_design on.\n`);
  db.close();
  process.exit(0);
}

if (!fixable.length) { console.log('\nNothing to inherit.'); db.close(); process.exit(0); }

const backup = DB_PATH.replace(/\.db$/, `.backup-inheritblocks.db`);
fs.copyFileSync(DB_PATH, backup);
console.log(`\nBacked up DB → ${path.basename(backup)}`);

const upd = db.prepare('UPDATE store_products SET description_blocks = ?, use_block_design = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
const tx = db.transaction((list) => { for (const f of list) upd.run(f.owner.description_blocks, f.v.id); });
tx(fixable);

console.log(`Copied owner design blocks into ${fixable.length} variant(s) and set use_block_design = 1. The mini-app renders them now (server reads live, no restart needed).`);
console.log(`Each variant keeps its own name/size/price; only the description blocks were inherited. Tweak any per-variant block in the editor if a size detail differs.\n`);
db.close();
