// READ-ONLY. Dump the full content of variant groups whose OWNER has no design
// blocks, so we can author blocks from real existing content (no fabrication).
// Also prints one reference owner's full block JSON as an authoring template.
//   node scripts/_dump_blockless_groups.js
//   node scripts/_dump_blockless_groups.js --ref 285   # change the template example
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'roots.db'));
const argv = process.argv.slice(2);
const REF = (() => { const i = argv.indexOf('--ref'); return i >= 0 && argv[i + 1] ? parseInt(argv[i + 1], 10) : 285; })();

function bc(json) { try { const a = JSON.parse(json); return Array.isArray(a) ? a.length : 0; } catch { return 0; } }

// Every non-owner variant whose own blocks are empty AND whose owner also has no blocks.
const variants = db.prepare(`
  SELECT id, variant_group_id FROM store_products
   WHERE COALESCE(is_active,1)=1 AND variant_group_id IS NOT NULL AND id != variant_group_id
`).all().filter(v => {
  if (bc(db.prepare('SELECT description_blocks d FROM store_products WHERE id=?').get(v.id).d) > 0) return false;
  const o = db.prepare('SELECT description_blocks d FROM store_products WHERE id=?').get(v.variant_group_id);
  return o && bc(o.d) === 0;
});

const groupIds = [...new Set(variants.map(v => v.variant_group_id))];
console.log(`\n=== ${groupIds.length} blockless owner groups ===\n`);

const full = db.prepare(`SELECT id, name_en, name_cn, category, sku, variant_label, tagline_en, tagline_cn,
  free_of, description_format, description_en, description_cn, nutrition, colophon_character
  FROM store_products WHERE id=?`);

for (const gid of groupIds) {
  const rows = db.prepare(`SELECT id, name_en, name_cn, sku, variant_label, variant_group_id
    FROM store_products WHERE variant_group_id=? AND COALESCE(is_active,1)=1 ORDER BY id`).all(gid);
  const owner = full.get(gid);
  console.log(`\n──────── GROUP ${gid} · ${owner.category || '(no category)'} ────────`);
  console.log(`OWNER #${owner.id} ${owner.name_en} / ${owner.name_cn}  [${owner.sku}]`);
  console.log(`  tagline: ${owner.tagline_en || '-'} / ${owner.tagline_cn || '-'}`);
  console.log(`  free_of: ${owner.free_of || '-'}`);
  console.log(`  fmt=${owner.description_format} colophon=${owner.colophon_character || '-'}`);
  console.log(`  desc_en: ${(owner.description_en || '').replace(/\s+/g, ' ').slice(0, 600)}`);
  console.log(`  desc_cn: ${(owner.description_cn || '').replace(/\s+/g, ' ').slice(0, 600)}`);
  console.log(`  nutrition: ${owner.nutrition || '-'}`);
  console.log(`  siblings:`);
  for (const r of rows) {
    const tag = r.id === gid ? '(owner)' : (r.variant_label || '');
    console.log(`    #${r.id} ${r.name_en || r.name_cn}  [${r.sku}] ${tag}`);
  }
}

const ref = db.prepare('SELECT name_en, description_blocks FROM store_products WHERE id=?').get(REF);
console.log(`\n\n=== REFERENCE TEMPLATE — owner #${REF} ${ref ? ref.name_en : '(missing)'} block JSON ===\n`);
console.log(ref ? ref.description_blocks : '(no such product)');
db.close();
