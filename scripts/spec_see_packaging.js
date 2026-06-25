#!/usr/bin/env node
/**
 * Change the spec_strip "Product Type / 产品类型" cell from the fresh
 * shelf-life value ("新鲜·2天内食用" / "Fresh · eat within N days") to
 * "See packaging" / "见包装" on Ready-to-Eat products.
 *
 * Targets ONLY cells that are the Product-Type cell AND currently carry a
 * fresh/eat-within shelf-life value, so frozen ("冷冻·加热即食") and
 * refrigerated-grain specs are left untouched.
 *
 * DRY by default. Set APPLY=1 to write (backs up each row to backups/ first).
 *   base64 -w0 scripts/spec_see_packaging.js | ssh ... 'cd /root/roots-v2 && base64 -d | [APPLY=1] node -'
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const APPLY = !!process.env.APPLY;
const db = new Database('data/roots.db');

const NEW_EN = 'See packaging';
const NEW_CN = '见包装';

// Is this the Product-Type cell?
const isTypeCell = (c) =>
  /产品类型|product\s*type|类型|\btype\b/i.test(`${c.k_cn || ''} ${c.k_en || ''}`);

// Does this cell's value look like a fresh / eat-within shelf life?
const isFreshValue = (c) => {
  const v = `${c.v_cn || ''} ${c.v_en || ''}`;
  return /新鲜|内食用|eat within|fresh/i.test(v);
};

const rows = db.prepare(
  `SELECT id, name_en, description_blocks
     FROM store_products
    WHERE top_category = 'Ready to Eat'`
).all();

let changed = 0;
const rep = [];
for (const r of rows) {
  let blocks;
  try { blocks = JSON.parse(r.description_blocks || '[]'); } catch { continue; }
  let touched = false;
  for (const b of blocks) {
    if (b.type !== 'spec_strip' || !Array.isArray(b.cells)) continue;
    for (const c of b.cells) {
      if (isTypeCell(c) && isFreshValue(c)) {
        rep.push(`#${r.id} ${(r.name_en || '').padEnd(30)} "${c.v_cn || c.v_en}" → "${NEW_CN} / ${NEW_EN}"`);
        c.v_en = NEW_EN;
        c.v_cn = NEW_CN;
        touched = true;
      }
    }
  }
  if (touched) {
    changed++;
    if (APPLY) {
      try { fs.mkdirSync('backups', { recursive: true }); } catch {}
      fs.writeFileSync(`backups/specpkg_${r.id}_${Date.now()}.json`, r.description_blocks);
      db.prepare('UPDATE store_products SET description_blocks=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(JSON.stringify(blocks), r.id);
    }
  }
}

console.log(rep.join('\n') || '(no matching cells)');
console.log(APPLY ? `== APPLIED to ${changed} products ==` : `== DRY: would change ${changed} products (set APPLY=1) ==`);
db.close();
