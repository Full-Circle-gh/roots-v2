// Apply the catalog-match change set: for each row in
// data/meituan-mapping-changes-<store>.json, point the mapping at the current
// Meituan listing title (matched by 货号), then enqueue a stock push.
//
//   node scripts/meituan-apply-catalog-changes.js tianhe         # dry-run (prints)
//   node scripts/meituan-apply-catalog-changes.js tianhe apply   # writes + enqueues
'use strict';
const path = require('path');
const fs   = require('fs');
require('../database');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '../data/roots.db'));
const { enqueueProductStock } = require('../lib/meituan-bundles');

const store   = process.argv[2] || 'tianhe';
const doApply = process.argv[3] === 'apply';
const STORE_ID = 1; // tianhe

const changes = JSON.parse(fs.readFileSync(path.join(__dirname, `../data/meituan-mapping-changes-${store}.json`), 'utf8'));
const upd = db.prepare(`UPDATE meituan_product_map
   SET meituan_name = ?, meituan_spu_id = ?, meituan_sku_id = NULL
 WHERE product_id = ? AND retail_store_id = ?`);

console.log(`${doApply ? 'APPLYING' : 'DRY-RUN'} ${changes.length} change(s) for ${store}\n`);
let n = 0;
for (const c of changes) {
  console.log(`${c.product_id} [${c.sku}]  "${c.old}"  ->  "${c.new}"`);
  if (doApply) {
    const r = upd.run(c.new, c.spu, c.product_id, STORE_ID);
    if (r.changes) n++;
  }
}
if (doApply) {
  console.log(`\nupdated ${n} mapping(s); enqueueing pushes...`);
  for (const c of changes) enqueueProductStock(db, STORE_ID, c.product_id);
  console.log('enqueued all. done.');
} else {
  console.log('\n(dry-run — re-run with "apply" to write)');
}
