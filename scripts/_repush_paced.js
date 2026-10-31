// Clear the crash-thrashed queue for the 26 healed products, then re-push them
// in small PACED waves so the daemon never has a batch big enough to crash.
// Run with the daemon RUNNING (it drains each wave). Read/writes the queue only.
//
//   node scripts/_repush_paced.js
'use strict';
const path = require('path');
require('../database');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '../data/roots.db'));
const { enqueueProductStock } = require('../lib/meituan-bundles');

const STORE_ID = 1;
const IDS = [90,228,256,266,267,268,269,270,272,273,274,275,276,277,278,279,280,281,283,285,286,305,314,319,323,324];
const WAVE = 3;
const POLL_MS = 6000;
const MAX_WAIT_MS = 150000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1) Clear the thrash: retire every non-done row for these products.
const ph = '(' + IDS.join(',') + ')';
const cleared = db.prepare(`UPDATE meituan_sync_queue SET status='done', last_error='cleared-for-repace'
   WHERE product_id IN ${ph} AND status <> 'done'`).run();
console.log(`cleared ${cleared.changes} stuck/error/pending rows\n`);

(async () => {
  for (let i = 0; i < IDS.length; i += WAVE) {
    const wave = IDS.slice(i, i + WAVE);
    for (const pid of wave) enqueueProductStock(db, STORE_ID, pid);
    console.log(`wave ${i/WAVE+1}: enqueued ${wave.join(', ')}`);

    const deadline = Date.now() + MAX_WAIT_MS;
    const wph = '(' + wave.join(',') + ')';
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const pend = db.prepare(`SELECT count(*) c FROM meituan_sync_queue
         WHERE product_id IN ${wph} AND status IN ('pending','processing')`).get().c;
      if (pend === 0) break;
    }
    // report outcome for the wave
    for (const pid of wave) {
      const r = db.prepare(`SELECT status,last_error FROM meituan_sync_queue
         WHERE product_id=? ORDER BY id DESC LIMIT 1`).get(pid);
      const mm = db.prepare(`SELECT last_pushed_qty q,last_pushed_at t FROM meituan_product_map
         WHERE product_id=? AND retail_store_id=?`).get(pid, STORE_ID);
      console.log(`   ${pid}: queue=${r?r.status:'?'}  last_pushed=${mm?mm.q:'?'} @ ${mm?mm.t:'?'}`);
    }
  }
  console.log('\ndone. Re-run match/scrape to verify, or check Meituan.');
  process.exit(0);
})();
