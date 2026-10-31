// One-off: import EN/CN product descriptions scraped from OUT1N into
// store_products. Safe: only fills description_en/description_cn that are
// currently EMPTY (never overwrites), only touches DRAFT rows (is_published=0),
// and sets description_format='rich' when content is written.
// Usage:  node scripts/import_descriptions.js --dry   (preview)
//         node scripts/import_descriptions.js --apply (write)
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'data', 'roots.db'));
const rows = require(path.join(__dirname, '..', 'data', 'fc_descriptions.json'));

const APPLY = process.argv.includes('--apply');
const isEmpty = s => !s || !String(s).replace(/<[^>]*>|&nbsp;|\s/g, '').trim();

const getRow = db.prepare('SELECT id, name_en, is_published, is_active, description_en, description_cn, description_format FROM store_products WHERE id = ?');
const upd = db.prepare('UPDATE store_products SET description_en = ?, description_cn = ?, description_format = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');

let willEn = 0, willCn = 0, skipNotDraft = 0, skipMissing = 0, skipFilled = 0, touched = 0;
const plan = [];
for (const r of rows) {
  const cur = getRow.get(r.id);
  if (!cur) { skipMissing++; continue; }
  if (cur.is_active != 1 || (cur.is_published || 0) !== 0) { skipNotDraft++; continue; }
  let newEn = cur.description_en, newCn = cur.description_cn, changed = false;
  if (r.en && isEmpty(cur.description_en)) { newEn = r.en; willEn++; changed = true; }
  if (r.cn && isEmpty(cur.description_cn)) { newCn = r.cn; willCn++; changed = true; }
  if (!changed) { skipFilled++; continue; }
  touched++;
  plan.push({ id: r.id, name: cur.name_en, setEn: newEn !== cur.description_en, setCn: newCn !== cur.description_cn });
  if (APPLY) upd.run(newEn, newCn, 'rich', r.id);
}

console.log(`${APPLY ? 'APPLIED' : 'DRY-RUN'} — rows in file: ${rows.length}`);
console.log(`  products updated:        ${touched}`);
console.log(`  description_en filled:   ${willEn}`);
console.log(`  description_cn filled:   ${willCn}`);
console.log(`  skipped (not a draft):   ${skipNotDraft}`);
console.log(`  skipped (id not found):  ${skipMissing}`);
console.log(`  skipped (already filled):${skipFilled}`);
console.log('  sample:', plan.slice(0, 5).map(p => `${p.id}:${p.name}`).join(' | '));
