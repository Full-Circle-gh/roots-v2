#!/usr/bin/env node
/**
 * Backfill the product `weight` field (shown as the grey weight subline on the
 * shop list cards — shop.js builds it from `p.size`, which is store_products.weight)
 * from each product's PDP "Net Wt · 净重" spec-strip cell.
 *
 * WHY: lots of products show NO weight under the name on the Shop list even
 * though the weight is filled in the product's design description. The list
 * subline reads ONLY store_products.weight. The PDP shows the weight from the
 * `spec_strip` design block's "Net Wt / 净重" cell. When the operator typed the
 * weight into the spec strip but never filled the top-level Weight field, the
 * card shows nothing. This copies the spec-strip Net Wt into `weight` so the
 * card shows it too.
 *
 * SOURCE OF TRUTH: description_blocks (JSON array of { type, ...data }). The
 * relevant block is { type:'spec_strip', cells:[{k_en,k_cn,v_en,v_cn}, ...] };
 * the weight cell is the one whose key is "Net Wt" / "净重". We take v_en first
 * (e.g. "200g" — matches the existing card style), else v_cn (e.g. "200克").
 *
 * SAFE: only touches rows whose `weight` is currently EMPTY. Never overwrites a
 * weight the operator already set. Variant members are included (their value
 * also feeds the size-picker sheet), but the collapsed variant CARD drops the
 * subline by design, so the visible win is on single (non-variant) products.
 *
 * DRY-RUN BY DEFAULT. Run ON THE SERVER, against data/roots.db:
 *   node scripts/backfill_weight_from_spec_strip.js            # preview only
 *   node scripts/backfill_weight_from_spec_strip.js --write    # apply
 *   node scripts/backfill_weight_from_spec_strip.js --write --include-drafts
 */
const path = require('path');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const INCLUDE_DRAFTS = argv.includes('--include-drafts');

const db = new Database(path.join(__dirname, '..', 'data', 'roots.db'));

// Does store_products have an updated_at column? (busts the ?v=updated_at card cache)
const hasUpdatedAt = db.prepare("PRAGMA table_info(store_products)").all()
  .some(c => c.name === 'updated_at');

// Reject junk spec-strip values that should NEVER land on a card:
//  - placeholder text the operator never filled ("[fill] g", "[填写]", "— g")
//  - non-weights ("See packaging / 见包装", "1 SCOBY + starter liquid …")
//  - dual "two sizes" umbrella values ("230g / 500g") — wrong on one variant
//  - anything with no digit, or a runaway description (> 32 chars)
// Returns the cleaned string, or null to skip the product.
function cleanWeight(v) {
  if (!v) return null;
  const s = v.toString().trim();
  if (!s) return null;
  if (!/[0-9]/.test(s)) return null;                       // must contain a number
  if (s.includes('/')) return null;                        // dual variant value
  if (/[\[\]]|填写|placeholder|^[-—\s]+$/i.test(s)) return null;
  if (/see\s*packaging|见\s*包装|scoby|菌种/i.test(s)) return null;
  if (s.length > 32) return null;                          // runaway description
  return s;
}

// Pull the "Net Wt / 净重" value out of a description_blocks JSON string.
function netWtFromBlocks(json) {
  if (!json) return null;
  let blocks;
  try { blocks = JSON.parse(json); } catch { return null; }
  if (!Array.isArray(blocks)) blocks = (blocks && Array.isArray(blocks.blocks)) ? blocks.blocks : null;
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (!b || b.type !== 'spec_strip' || !Array.isArray(b.cells)) continue;
    for (const c of b.cells) {
      const ken = (c.k_en || '').toString().toLowerCase().replace(/[\s.]/g, '');
      const kcn = (c.k_cn || '').toString();
      const isNetWt =
        ken.includes('netwt') || ken.includes('netweight') ||
        ken === 'weight' || ken === 'wt' || ken === 'size' ||
        kcn.includes('净重') || kcn.includes('净含量') || kcn.includes('规格') || kcn.includes('重量');
      if (!isNetWt) continue;
      const vEn = (c.v_en || '').toString().trim();
      const vCn = (c.v_cn || '').toString().trim();
      const value = cleanWeight(vEn) || cleanWeight(vCn);
      if (value) return { value, v_en: vEn, v_cn: vCn };
    }
  }
  return null;
}

const rows = db.prepare(
  `SELECT id, name_en, name_cn, weight, sku, variant_group_id, is_published, is_active, description_blocks
     FROM store_products
    WHERE (weight IS NULL OR trim(weight) = '')`
).all();

const fillable = [];   // empty weight + we found a spec Net Wt
const noSpec   = [];   // empty weight + no spec Net Wt to copy

for (const r of rows) {
  if (!INCLUDE_DRAFTS && !r.is_published) continue;
  const hit = netWtFromBlocks(r.description_blocks);
  if (hit) fillable.push({ ...r, _new: hit.value, _v_en: hit.v_en, _v_cn: hit.v_cn });
  else noSpec.push(r);
}

const tag = r => `${r.is_published ? '' : '[DRAFT] '}${r.variant_group_id ? '[variant] ' : ''}`;

console.log(`\nProducts with an EMPTY weight: ${rows.length}` +
  (INCLUDE_DRAFTS ? '' : ' (published only — pass --include-drafts to include drafts)'));
console.log(`  → ${fillable.length} can be filled from their spec-strip Net Wt`);
console.log(`  → ${noSpec.length} have no spec-strip Net Wt (nothing to copy — fill by hand)\n`);

console.log('── WILL FILL ───────────────────────────────────────────────');
for (const r of fillable) {
  console.log(`  #${r.id} ${tag(r)}${(r.name_en || r.name_cn || '').slice(0, 40).padEnd(40)} → weight = "${r._new}"` +
    (r._v_cn && r._v_cn !== r._new ? `   (cn: ${r._v_cn})` : ''));
}

if (noSpec.length) {
  console.log('\n── NO SPEC NET-WT (left untouched) ─────────────────────────');
  for (const r of noSpec) {
    console.log(`  #${r.id} ${tag(r)}${(r.name_en || r.name_cn || '').slice(0, 40)}`);
  }
}

if (!WRITE) {
  console.log(`\nDRY RUN — nothing written. Re-run with --write to apply the ${fillable.length} fills above.\n`);
  db.close();
  process.exit(0);
}

const now = Math.floor(Date.now() / 1000);
const stmt = hasUpdatedAt
  ? db.prepare('UPDATE store_products SET weight = ?, updated_at = ? WHERE id = ?')
  : db.prepare('UPDATE store_products SET weight = ? WHERE id = ?');

const apply = db.transaction(list => {
  for (const r of list) {
    if (hasUpdatedAt) stmt.run(r._new, now, r.id);
    else stmt.run(r._new, r.id);
  }
});
apply(fillable);

console.log(`\n✅ Wrote weight on ${fillable.length} product(s).` +
  (hasUpdatedAt ? ' updated_at bumped (card cache will refresh).' : '') + '\n');
db.close();
