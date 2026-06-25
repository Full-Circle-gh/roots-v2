#!/usr/bin/env node
/**
 * Read-only: dump the spec_strip "Product Type / 产品类型" cell for every
 * Ready-to-Eat product, so we can see which ones show "新鲜·2天内食用" etc.
 * Run ON THE SERVER against data/roots.db.
 */
const Database = require('better-sqlite3');
const db = new Database('data/roots.db', { readonly: true });

const rows = db.prepare(
  `SELECT id, name_en, name_cn, top_category, sub_category, is_published, description_blocks
     FROM store_products
    WHERE top_category = 'Ready to Eat'
    ORDER BY sub_category, id`
).all();

for (const r of rows) {
  let blocks = [];
  try { blocks = JSON.parse(r.description_blocks || '[]'); } catch {}
  const spec = blocks.find(b => b.type === 'spec_strip');
  const cells = spec && Array.isArray(spec.cells) ? spec.cells : [];
  const cellStr = cells.map(c => `[${c.k_cn || c.k_en}=${c.v_en || ''}/${c.v_cn || ''}]`).join(' ');
  console.log(
    `#${r.id} ${(r.name_en || '').padEnd(30)} ${(r.sub_category || '').padEnd(18)} ` +
    `${r.is_published ? 'pub' : 'DRAFT'} ${spec ? '' : 'NO-SPEC '}${cellStr}`
  );
}
db.close();
