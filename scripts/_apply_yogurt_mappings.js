// One-off: point each Roots yogurt variant at its NEW single-spec Meituan listing
// title (post-split), then enqueue a stock push so each lands on its own spu.
// retail_store_id 1 = tianhe (the only mapped store; yuexiu pending login).
'use strict';
require('../database');
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '../data/roots.db'));
const { enqueueProductStock } = require('../lib/meituan-bundles');

const STORE_ID = 1;
const rows = [
  [260, 'Coconut Yogurt纯素椰子酸奶(230g)',   '26493524372'],
  [261, 'Coconut Yogurt 纯素椰子酸奶(500g)',  '21219210178'],
  [262, '纯素椰子酸奶-香草味Vanilla(130g)',   '26504571954'],
  [263, '纯素椰子酸奶-香草味Vanilla (230g)',  '21219210180'],
  [264, '纯素椰子酸奶-桃子味Peach(130g)',     '26502619932'],
  [265, '纯素椰子酸奶-桃子味Peach (230g)',    '21219210181'],
];

const upd = db.prepare(`UPDATE meituan_product_map
   SET meituan_name = ?, meituan_spu_id = ?, meituan_sku_id = NULL
 WHERE product_id = ? AND retail_store_id = ?`);

for (const [pid, name, spu] of rows) {
  const r = upd.run(name, spu, pid, STORE_ID);
  console.log(`map ${pid} -> "${name}" (spu ${spu})  rows=${r.changes}`);
}

console.log('\nenqueueing stock pushes...');
for (const [pid] of rows) {
  enqueueProductStock(db, STORE_ID, pid);
  console.log(`enqueued ${pid}`);
}
console.log('done');
