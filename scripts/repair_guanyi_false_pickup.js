#!/usr/bin/env node
// One-off repair: reverse the false guanyi_pickup mass-decrement of 2026-06-27
// 01:23–02:41 local (UTC 2026-06-26 17:23–18:41). A bad Guanyi listing read
// returned ~0 for every product in one cycle ("129 drop(s) detected"), so the
// drift detector zeroed 63 real products (−1863 units). Those ≤50 drops slipped
// under PICKUP_CAP and were APPLIED (action=decremented); the >50 drops were
// capped/warned only. This adds the wrongly-removed units back via adjustStock
// (ledgered as guanyi_pickup_reversal, re-pushed to channels).
//
//   node scripts/repair_guanyi_false_pickup.js          # dry-run (default)
//   node scripts/repair_guanyi_false_pickup.js --apply   # apply

'use strict';
const path = require('path');
const fs   = require('fs');
const envFile = path.join(__dirname, '../.env');
try { require('dotenv').config({ path: envFile }); } catch {
  if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
}
const db = require('../database');
const { adjustStock } = require('../lib/inventory');

const APPLY = process.argv.includes('--apply');
// Incident window in UTC (ledger created_at is UTC). Tight bounds around the burst.
const FROM = '2026-06-26 17:00:00';
const TO   = '2026-06-26 19:00:00';

const rows = db.prepare(`
  SELECT store_id, product_id, SUM(delta) AS bad_delta, COUNT(*) n
    FROM retail_stock_ledger
   WHERE reason='guanyi_pickup' AND created_at >= ? AND created_at <= ?
   GROUP BY store_id, product_id
   HAVING bad_delta < 0
`).all(FROM, TO);

console.log(`${APPLY ? 'APPLYING' : 'DRY-RUN'} — ${rows.length} product(s) to restore`);
let totalBack = 0, applied = 0;
for (const r of rows) {
  const cur = db.prepare(`SELECT physical_qty FROM retail_store_stock WHERE store_id=? AND product_id=?`)
                .get(r.store_id, r.product_id)?.physical_qty ?? 0;
  const back = -r.bad_delta;                 // units to add back
  const next = cur + back;
  const p = db.prepare(`SELECT sku, name_en FROM store_products WHERE id=?`).get(r.product_id) || {};
  console.log(`  pid=${String(r.product_id).padStart(4)} ${(p.sku||'').padEnd(7)} ${String(p.name_en||'').slice(0,26).padEnd(26)} ${cur} +${back} → ${next}`);
  totalBack += back;
  if (APPLY) {
    adjustStock({
      storeId: r.store_id, productId: r.product_id, newPhysicalQty: next,
      actorLabel: 'guanyi-pickup-repair', reason: 'guanyi_pickup_reversal',
      note: `reverse false mass-decrement 2026-06-27 01:23-02:41 (bad Guanyi read): +${back}`,
    });
    applied++;
  }
}
console.log(`\n${APPLY ? 'DONE' : 'WOULD RESTORE'}: ${rows.length} products, +${totalBack} units${APPLY ? ` (${applied} applied)` : ''}`);
