#!/usr/bin/env node
/**
 * Apply approved product-name suggestions to the LIVE catalog (store_products).
 *
 * Updates ONLY name_en / name_cn. Never touches price, stock, sort_order, tags,
 * images, publish flags — anything else.
 *
 *   node scripts/apply_name_suggestions.js            # DRY-RUN (default, no writes)
 *   node scripts/apply_name_suggestions.js --write    # take a backup, then apply
 *
 * RUN THIS ON THE PROD SERVER — the local data/roots.db is a stale legacy copy
 * with no store_products table. From /root/roots-v2:
 *   node scripts/apply_name_suggestions.js            (check the report)
 *   node scripts/apply_name_suggestions.js --write    (apply for real)
 *
 * Matching key, in order: sku (case-insensitive) → external_id → exact name_en.
 * Idempotent: rows already carrying the target name are left untouched.
 */
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const WRITE   = process.argv.includes('--write');
const DB_PATH  = path.join(__dirname, '..', 'data', 'roots.db');
const MAP_PATH = path.join(__dirname, 'name_suggestions_apply.json');

if (!fs.existsSync(MAP_PATH)) { console.error('Missing mapping:', MAP_PATH); process.exit(1); }
const entries = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
if (!Array.isArray(entries) || !entries.length) { console.error('Mapping is empty'); process.exit(1); }

const db = new Database(DB_PATH);

// Confirm we're pointed at the real catalog.
const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='store_products'").get();
if (!hasTable) {
  console.error('No store_products table in', DB_PATH);
  console.error('You are probably on a dev machine — run this ON THE PROD SERVER.');
  process.exit(1);
}
const cols = db.prepare('PRAGMA table_info(store_products)').all().map(c => c.name);
for (const need of ['id','name_en','name_cn']) {
  if (!cols.includes(need)) { console.error('store_products missing column:', need); process.exit(1); }
}
const hasSku = cols.includes('sku');
const hasExt = cols.includes('external_id');
const hasUpd = cols.includes('updated_at');

const bySku = hasSku ? db.prepare('SELECT id,name_en,name_cn,sku FROM store_products WHERE LOWER(sku)=LOWER(?)') : null;
const byExt = hasExt ? db.prepare('SELECT id,name_en,name_cn FROM store_products WHERE external_id=?') : null;
const byName = db.prepare('SELECT id,name_en,name_cn FROM store_products WHERE name_en=?');
const upd = db.prepare(`UPDATE store_products SET name_en=?, name_cn=?${hasUpd ? ', updated_at=CURRENT_TIMESTAMP' : ''} WHERE id=?`);

function findRows(e) {
  if (hasSku && e.sku) { const r = bySku.all(e.sku); if (r.length) return { rows: r, via: 'sku' }; }
  if (hasExt && e.external_id != null) { const r = byExt.all(e.external_id); if (r.length) return { rows: r, via: 'external_id' }; }
  const r = byName.all(e.cur_en); if (r.length) return { rows: r, via: 'name_en' };
  return { rows: [], via: null };
}

const report = { change: [], noop: [], unmatched: [], ambiguous: [] };
const plan = [];
for (const e of entries) {
  const { rows, via } = findRows(e);
  if (!rows.length) { report.unmatched.push(e); continue; }
  if (rows.length > 1) { report.ambiguous.push({ ...e, via, n: rows.length }); continue; }
  const row = rows[0];
  const same = (row.name_en || '') === (e.new_en || '') && (row.name_cn || '') === (e.new_cn || '');
  if (same) { report.noop.push(e); continue; }
  report.change.push({ id: row.id, via, from_en: row.name_en, to_en: e.new_en, from_cn: row.name_cn, to_cn: e.new_cn });
  plan.push({ id: row.id, en: e.new_en, cn: e.new_cn });
}

console.log(`\n${WRITE ? 'WRITE' : 'DRY-RUN'} — ${entries.length} approved renames in mapping`);
console.log(`  will change : ${report.change.length}`);
console.log(`  already set : ${report.noop.length}`);
console.log(`  unmatched   : ${report.unmatched.length}`);
console.log(`  ambiguous   : ${report.ambiguous.length}  (multiple rows share the key — skipped for safety)`);

if (report.change.length) {
  console.log('\nChanges:');
  for (const c of report.change) {
    console.log(`  #${c.id} [${c.via}]`);
    console.log(`     EN: ${c.from_en}  ->  ${c.to_en}`);
    if ((c.from_cn||'') !== (c.to_cn||'')) console.log(`     CN: ${c.from_cn||'—'}  ->  ${c.to_cn||'—'}`);
  }
}
if (report.unmatched.length) {
  console.log('\nUnmatched (no store_products row by sku/external_id/name — left alone):');
  for (const e of report.unmatched) console.log(`  [sku ${e.sku}] ${e.cur_en}`);
}
if (report.ambiguous.length) {
  console.log('\nAmbiguous (key matched >1 row — skipped, review by hand):');
  for (const e of report.ambiguous) console.log(`  [${e.via} -> ${e.n} rows] ${e.cur_en}`);
}

if (!WRITE) {
  console.log('\nDry-run only. Re-run with --write to apply (a backup is taken first).');
  process.exit(0);
}
if (!plan.length) { console.log('\nNothing to write.'); process.exit(0); }

// Consistent backup via SQLite online-backup API, then apply in one transaction.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const bak = `${DB_PATH}.namebak-${stamp}`;
db.backup(bak).then(() => {
  console.log(`\nBackup written: ${bak}`);
  const tx = db.transaction(() => { for (const p of plan) upd.run(p.en, p.cn, p.id); });
  tx();
  console.log(`✅ Applied ${plan.length} name updates to store_products.`);
  process.exit(0);
}).catch(err => { console.error('Backup failed — NOT writing:', err.message); process.exit(1); });
