#!/usr/bin/env node
/**
 * Diagnose why a product (or its variants) renders a plain description.
 *
 * The mini-app PDP renders the rich design blocks ONLY when use_block_design is
 * truthy AND description_blocks is a non-empty array (product.js ~613). Otherwise
 * it falls back to rich-text (description_format='rich') or plain text.
 *
 * This prints, for every active product whose name matches --name (and every
 * sibling in its variant group), the three things that decide the renderer:
 *   use_block_design | block count | description_format
 * plus a verdict (BLOCKS / RICH-HTML / PLAIN) so you can see at a glance which
 * variant is plain and why.
 *
 * READ-ONLY. Run ON THE SERVER:
 *   node scripts/diagnose_variant_descriptions.js --name "coconut yogurt"
 *   node scripts/diagnose_variant_descriptions.js --group 90
 */
const path = require('path');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
function flag(name, def) { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; }
const NAME = flag('--name', null);
const GROUP = flag('--group', null) != null ? parseInt(flag('--group', null), 10) : null;

const db = new Database(path.join(__dirname, '..', 'data', 'roots.db'));

function blockCount(json) { try { const a = JSON.parse(json); return Array.isArray(a) ? a.length : 0; } catch { return 0; } }

let seeds;
if (GROUP != null) {
  seeds = db.prepare('SELECT id, variant_group_id FROM store_products WHERE variant_group_id = ? AND COALESCE(is_active,1)=1').all(GROUP);
} else if (NAME) {
  seeds = db.prepare(`SELECT id, variant_group_id FROM store_products
                       WHERE COALESCE(is_active,1)=1 AND (name_en LIKE ? OR name_cn LIKE ?)`)
            .all('%' + NAME + '%', '%' + NAME + '%');
} else {
  console.error('Pass --name "<text>" or --group <id>.'); process.exit(1);
}

// Expand to full variant groups so we see every sibling.
const groupIds = new Set();
const loose = [];
for (const s of seeds) { if (s.variant_group_id != null) groupIds.add(s.variant_group_id); else loose.push(s.id); }

const rows = db.prepare(`
  SELECT id, name_en, name_cn, sku, variant_group_id, variant_label,
         COALESCE(use_block_design,0) AS ubd, description_blocks, description_format,
         description_en, description_cn
    FROM store_products
   WHERE COALESCE(is_active,1)=1
     AND (variant_group_id IN (${[...groupIds].map(()=>'?').join(',') || 'NULL'}) OR id IN (${loose.map(()=>'?').join(',') || 'NULL'}))
   ORDER BY variant_group_id, id
`).all(...[...groupIds], ...loose);

if (!rows.length) { console.log('No matching products.'); db.close(); process.exit(0); }

console.log('\n  id     name                                   sku      ubd  blocks  fmt      hasText  VERDICT');
for (const r of rows) {
  const bc = blockCount(r.description_blocks);
  const hasText = !!((r.description_en && r.description_en.trim()) || (r.description_cn && r.description_cn.trim()));
  let verdict;
  if (r.ubd && bc > 0) verdict = 'BLOCKS (rich)';
  else if (r.description_format === 'rich' && hasText) verdict = 'RICH-HTML';
  else if (bc > 0 && !r.ubd) verdict = 'PLAIN  ← blocks exist, toggle OFF (fixable by --apply)';
  else verdict = 'PLAIN  ← no blocks copied';
  const own = r.id === r.variant_group_id ? '*owner' : (r.variant_label || '');
  console.log(`  #${String(r.id).padEnd(5)} ${String(r.name_en||r.name_cn||'').slice(0,36).padEnd(38)} ${String(r.sku||'-').padEnd(8)} ${String(r.ubd).padEnd(4)} ${String(bc).padEnd(7)} ${String(r.description_format||'-').padEnd(8)} ${(hasText?'yes':'no').padEnd(8)} ${verdict}  ${own}`);
}
console.log('');
db.close();
