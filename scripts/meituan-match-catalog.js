// READ-ONLY: cross-reference each Meituan mapping against the scraped catalog by
// 货号 (SKU code) and print what WOULD change — old meituan_name -> current
// listing title. No DB writes. Run scrape first to produce the catalog JSON.
//
//   node scripts/meituan-match-catalog.js tianhe
'use strict';
const path = require('path');
const fs   = require('fs');
require('../database');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '../data/roots.db'));

const store = process.argv[2] || 'tianhe';
const STORE_ID = 1; // tianhe
const cat = JSON.parse(fs.readFileSync(path.join(__dirname, `../data/meituan-catalog-${store}.json`), 'utf8'));

// 货号 -> [{spu,title,specsInSpu}]
// Skip combo ADD-ON specs ("+Rice糙米饭 1-280(190克)", "+哈里萨辣酱 Harrisa", …):
// the 货号 on an add-on belongs to the standalone product offered as a side, not
// to the combo. Counting them makes a single product (e.g. Brown Rice 1-280) look
// like it lives on every combo that offers it → false "still-multispec" matches.
// Only standalone/primary specs define where a 货号 really lives.
const byCode = new Map();
for (const l of cat.listings) for (const s of l.skus) {
  if (!s.code) continue;
  if (/^\s*\+/.test(s.spec)) continue;          // combo add-on — not the product's home
  if (!byCode.has(s.code)) byCode.set(s.code, []);
  byCode.get(s.code).push({ spu: l.spuId, title: l.name, specsInSpu: l.skus.length });
}

const rows = db.prepare(`
  SELECT mm.product_id, mm.meituan_name, COALESCE(NULLIF(mm.meituan_sku,''), sp.sku) AS sku,
         sp.name_en, sp.variant_label, sp.is_active, mm.sync_enabled
    FROM meituan_product_map mm
    LEFT JOIN store_products sp ON sp.id = mm.product_id
   WHERE mm.retail_store_id = ?
   ORDER BY mm.product_id
`).all(STORE_ID);

const changes = [], same = [], unmatched = [], ambiguous = [], multispec = [];
for (const r of rows) {
  const code = (r.sku || '').trim();
  const label = `${r.product_id} ${r.name_en||''}${r.variant_label?` (${r.variant_label})`:''} [sku ${code||'—'}]`;
  if (!code) { unmatched.push(`${label}  — NO SKU`); continue; }
  const hits = byCode.get(code);
  if (!hits) { unmatched.push(`${label}  — 货号 not found on Meituan`); continue; }
  if (hits.length > 1) { ambiguous.push(`${label}  — 货号 in ${hits.length} listings: ${hits.map(h=>h.title).join(' | ')}`); continue; }
  const h = hits[0];
  if (h.specsInSpu > 1) { multispec.push(`${label}  → "${h.title}" is STILL multi-spec (${h.specsInSpu} specs) — needs split; NOT auto-applied`); continue; }
  if ((r.meituan_name||'') === h.title) same.push(`${label}  = "${h.title}"`);
  else changes.push({ product_id: r.product_id, sku: code, old: r.meituan_name||'(blank)', new: h.title, spu: h.spu, active: r.is_active, enabled: r.sync_enabled });
}

console.log(`\n===== MATCH SUMMARY (${store}) =====`);
console.log(`mappings: ${rows.length} | changes: ${changes.length} | already-correct: ${same.length} | unmatched: ${unmatched.length} | ambiguous: ${ambiguous.length} | still-multispec: ${multispec.length}`);

console.log(`\n----- PROPOSED CHANGES (${changes.length}) -----`);
for (const c of changes) console.log(`${c.product_id} [${c.sku}]${c.active?'':' (inactive)'}${c.enabled?'':' (sync off)'}\n   old: ${c.old}\n   new: ${c.new}`);

console.log(`\n----- STILL MULTI-SPEC (broadcast risk, ${multispec.length}) -----`);
for (const m of multispec) console.log('  ' + m);

console.log(`\n----- AMBIGUOUS 货号 (${ambiguous.length}) -----`);
for (const a of ambiguous) console.log('  ' + a);

console.log(`\n----- UNMATCHED (${unmatched.length}) -----`);
for (const u of unmatched.slice(0, 80)) console.log('  ' + u);
if (unmatched.length > 80) console.log(`  ... +${unmatched.length-80} more`);

// write the change set for the apply step
fs.writeFileSync(path.join(__dirname, `../data/meituan-mapping-changes-${store}.json`), JSON.stringify(changes, null, 1));
console.log(`\nwrote ${changes.length} changes to data/meituan-mapping-changes-${store}.json`);
