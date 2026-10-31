#!/usr/bin/env node
/**
 * Apply China organic-claim compliance edits to store_products, BY LIVE id.
 *   - strips 有机 from in-scope powder titles (cacao/alfalfa/maca)
 *   - removes 有机 from CN descriptions (ingredient-level organic claims),
 *     guarding 有机酸 / 有机物; soy-milk powder is exempt (not in the edit set)
 * Never touches name_en, price, stock, images, or English text.
 *
 *   node scripts/apply_compliance.js            # DRY-RUN (default)
 *   node scripts/apply_compliance.js --write     # backup, then apply
 *
 * RUN ON THE PROD SERVER from /root/roots-v2 (local data/roots.db is stale).
 * Safety: each field is written only if the live value still equals the dumped
 * value. If a row changed since the dump (e.g. you ran the rename first), that
 * field is skipped and reported — never clobbered.
 */
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const WRITE   = process.argv.includes('--write');
const DB_PATH  = path.join(__dirname, '..', 'data', 'roots.db');
const EDITS    = path.join(__dirname, 'compliance_edits.json');

const edits = JSON.parse(fs.readFileSync(EDITS, 'utf8'));
const db = new Database(DB_PATH);
const cols = db.prepare('PRAGMA table_info(store_products)').all().map(c => c.name);
const hasUpd = cols.includes('updated_at');
const getRow = db.prepare('SELECT id, name_cn, description_cn FROM store_products WHERE id = ?');

const plan = [];          // {id, field, val}
const report = { title: [], desc: [], skipped: [], missing: [] };

for (const e of edits) {
  const row = getRow.get(e.id);
  if (!row) { report.missing.push(e); continue; }
  if ('name_cn' in e) {
    if ((row.name_cn || '') === (e._old_name_cn || '')) {
      plan.push({ id: e.id, field: 'name_cn', val: e.name_cn });
      report.title.push({ id: e.id, from: row.name_cn, to: e.name_cn });
    } else {
      report.skipped.push({ id: e.id, field: 'name_cn', reason: 'live differs from dump', live: row.name_cn });
    }
  }
  if ('description_cn' in e) {
    if ((row.description_cn || '') === (e._old_desc_cn || '')) {
      plan.push({ id: e.id, field: 'description_cn', val: e.description_cn });
      const removed = ((e._old_desc_cn || '').match(/有机/g) || []).length - ((e.description_cn || '').match(/有机/g) || []).length;
      report.desc.push({ id: e.id, name: e.name_en, removed });
    } else {
      report.skipped.push({ id: e.id, field: 'description_cn', reason: 'live differs from dump' });
    }
  }
}

console.log(`\n${WRITE ? 'WRITE' : 'DRY-RUN'} — compliance edits for ${edits.length} products`);
console.log(`  title strips : ${report.title.length}`);
console.log(`  descriptions : ${report.desc.length}  (${report.desc.reduce((a,b)=>a+b.removed,0)} 有机 removed)`);
console.log(`  skipped      : ${report.skipped.length}  (live text drifted from dump)`);
console.log(`  missing rows : ${report.missing.length}`);

if (report.title.length) {
  console.log('\nTitle changes:');
  for (const t of report.title) console.log(`  #${t.id}  ${t.from}  ->  ${t.to}`);
}
if (report.desc.length) {
  console.log('\nDescription cleanups:');
  for (const d of report.desc) console.log(`  #${d.id}  ${d.name}  (−${d.removed} 有机)`);
}
if (report.skipped.length) {
  console.log('\nSkipped (live differs from dump — not overwritten):');
  for (const s of report.skipped) console.log(`  #${s.id} ${s.field}${s.live ? '  live="'+s.live+'"' : ''}`);
}

if (!WRITE) { console.log('\nDry-run only. Re-run with --write to apply (backup taken first).'); process.exit(0); }
if (!plan.length) { console.log('\nNothing to write.'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const bak = `${DB_PATH}.compliancebak-${stamp}`;
db.backup(bak).then(() => {
  console.log(`\nBackup written: ${bak}`);
  // better-sqlite3 can't bind identifiers, so use one statement per field.
  const setName = db.prepare(`UPDATE store_products SET name_cn=?${hasUpd ? ', updated_at=CURRENT_TIMESTAMP' : ''} WHERE id=?`);
  const setDesc = db.prepare(`UPDATE store_products SET description_cn=?${hasUpd ? ', updated_at=CURRENT_TIMESTAMP' : ''} WHERE id=?`);
  const tx = db.transaction(() => {
    for (const p of plan) {
      if (p.field === 'name_cn') setName.run(p.val, p.id);
      else setDesc.run(p.val, p.id);
    }
  });
  tx();
  console.log(`✅ Applied ${plan.length} field updates across ${new Set(plan.map(p=>p.id)).size} products.`);
  process.exit(0);
}).catch(err => { console.error('Backup failed — NOT writing:', err.message); process.exit(1); });
