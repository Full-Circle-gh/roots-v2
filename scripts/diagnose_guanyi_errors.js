#!/usr/bin/env node
/**
 * Diagnose the Guanyi (gzgrocery) stock-sync "N error" pile-up.
 *
 * The admin dashboard shows a QUEUE error count (e.g. "110 error") but not WHY.
 * Each errored guanyi_sync_queue row carries a `last_error` string set by the
 * daemon at one of four distinct failure points (see scripts/guanyi-daemon.js):
 *
 *   'no guanyi mapping'          → the product's map row has no guanyi_sku_id
 *   'sku not found in Guanyi list' → mapped sku_id absent from the live listing
 *   'document create/approve failed' → the batch's ONE 库存调整单 check/create/
 *                                      approve failed (flips the whole batch)
 *   '<exception text>'           → fetchListings null (session/proxy down) etc.
 *
 * Because applyDeltas builds ONE adjustment document per batch, a single failed
 * approve marks every row in that batch as error — which is how the count jumps
 * to ~60/110 at once. This groups the errors so we fix the real cause.
 *
 * Read-only. Changes nothing. Run ON THE SERVER, against data/roots.db:
 *   node scripts/diagnose_guanyi_errors.js
 */
'use strict';
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'data', 'roots.db'), { readonly: true });
const STORE = process.env.GUANYI_STORE_CODE || 'tianhe';

function rows(sql, ...args) { return db.prepare(sql).all(...args); }
function one(sql, ...args) { return db.prepare(sql).get(...args); }
function has(table) {
  return !!one(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, table);
}

console.log(`\nGuanyi sync diagnostics  (store_code=${STORE})`);
console.log('═'.repeat(72));

if (!has('guanyi_sync_queue')) {
  console.log('guanyi_sync_queue table not found — wrong DB or channel not installed.');
  db.close(); process.exit(0);
}

// ── 1. Queue status tally ───────────────────────────────────────────────────
console.log('\nQUEUE by status:');
for (const r of rows(`SELECT status, COUNT(*) n FROM guanyi_sync_queue GROUP BY status ORDER BY n DESC`)) {
  console.log(`  ${String(r.status).padEnd(12)} ${r.n}`);
}

// ── 2. Error rows grouped by reason ─────────────────────────────────────────
console.log('\nERROR rows grouped by last_error:');
const byErr = rows(`
  SELECT COALESCE(last_error,'(null)') AS err, COUNT(*) n,
         MIN(created_at) AS first_seen, MAX(processed_at) AS last_seen
    FROM guanyi_sync_queue WHERE status='error'
   GROUP BY err ORDER BY n DESC
`);
if (!byErr.length) console.log('  (no error rows)');
for (const r of byErr) {
  console.log(`  ${String(r.n).padStart(4)} × "${r.err}"`);
  console.log(`         first ${r.first_seen}   last ${r.last_seen}`);
}

// ── 3. attempts distribution (have they exhausted retries?) ─────────────────
console.log('\nERROR rows by attempts (≥3 = will not retry):');
for (const r of rows(`SELECT attempts, COUNT(*) n FROM guanyi_sync_queue WHERE status='error' GROUP BY attempts ORDER BY attempts`)) {
  console.log(`  attempts=${r.attempts}  ${r.n}`);
}

// ── 4. Sample of distinct products that errored, with mapping health ────────
console.log('\nSample errored products (up to 20 distinct) + mapping state:');
const sample = rows(`
  SELECT q.product_id, q.new_qty, q.last_error,
         p.name_cn, p.name_en, p.sku AS product_sku,
         m.guanyi_name, m.guanyi_sku_id, m.sync_enabled, m.last_pushed_qty, m.last_delta
    FROM guanyi_sync_queue q
    LEFT JOIN store_products p ON p.id = q.product_id
    LEFT JOIN guanyi_product_map m
           ON m.product_id = q.product_id AND m.retail_store_id = q.retail_store_id
   WHERE q.status='error'
   GROUP BY q.product_id
   ORDER BY q.processed_at DESC
   LIMIT 20
`);
for (const r of sample) {
  console.log(`  #${r.product_id} ${r.name_cn || r.name_en || '?'}  sku=${r.product_sku || '-'}  target=${r.new_qty}`);
  console.log(`        gy_sku_id=${r.guanyi_sku_id || 'NONE'}  enabled=${r.sync_enabled}  lastPushedQty=${r.last_pushed_qty ?? '-'}  lastErr="${r.last_error}"`);
}

// ── 5. Is the listing cache fresh, and do errored sku_ids exist in it? ───────
if (has('guanyi_listings')) {
  const cache = rows(`SELECT sku_id, current_qty FROM guanyi_listings WHERE store_code=?`, STORE);
  const inCache = new Set(cache.map(c => String(c.sku_id)));
  console.log(`\nListing cache: ${cache.length} row(s) for ${STORE}.`);
  if (has('guanyi_listing_jobs')) {
    const job = one(`SELECT status, result_count, error, created_at, completed_at FROM guanyi_listing_jobs WHERE store_code=? ORDER BY id DESC LIMIT 1`, STORE);
    if (job) console.log(`  last refresh job: ${job.status} count=${job.result_count ?? '-'} at ${job.completed_at || job.created_at} err=${job.error || '-'}`);
  }
  const mapped = rows(`SELECT DISTINCT guanyi_sku_id FROM guanyi_product_map WHERE sync_enabled=1 AND guanyi_sku_id IS NOT NULL`);
  const missingFromCache = mapped.filter(m => !inCache.has(String(m.guanyi_sku_id)));
  console.log(`  mapped+enabled sku_ids: ${mapped.length}; NOT present in cache: ${missingFromCache.length}`);
  if (missingFromCache.length) {
    console.log(`    → these would fail with "sku not found in Guanyi list": ${missingFromCache.slice(0,15).map(m=>m.guanyi_sku_id).join(', ')}${missingFromCache.length>15?' …':''}`);
  }
}

// ── 6. Recent daemon log lines (errors first) ───────────────────────────────
if (has('guanyi_sync_log')) {
  console.log('\nRecent guanyi_sync_log (last 25):');
  for (const r of rows(`SELECT created_at, event_type, status, error_msg, detail FROM guanyi_sync_log ORDER BY id DESC LIMIT 25`)) {
    const tail = r.error_msg ? `  err="${r.error_msg}"` : (r.detail ? `  ${String(r.detail).slice(0,120)}` : '');
    console.log(`  ${r.created_at}  ${r.event_type}/${r.status}${tail}`);
  }
}

console.log('\n' + '═'.repeat(72));
console.log('Read the grouped reason in section 2 — that is the real fix target:');
console.log('  • mostly "document create/approve failed" → the 调整单 approve is');
console.log('    failing (stale unapproved test 调整单, or approve token). Clean the');
console.log('    leftover unapproved adjustments in Guanyi, then re-push.');
console.log('  • mostly "sku not found in Guanyi list" → refresh listings + re-match.');
console.log('  • mostly "no guanyi mapping" → those map rows lack guanyi_sku_id.');
console.log('  • mostly an exception text → session expired or proxy down.');
console.log('');
db.close();
