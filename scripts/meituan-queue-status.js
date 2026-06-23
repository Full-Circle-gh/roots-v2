// READ-ONLY diagnostic: which products' Meituan stock pushes are stuck/failed,
// and why. Looks at the push queue (meituan_sync_queue) and the sync log
// (meituan_sync_log). No writes.
//
//   node scripts/meituan-queue-status.js
'use strict';

const path = require('path');
const fs   = require('fs');
const envFile = path.join(__dirname, '../.env');
try { require('dotenv').config({ path: envFile }); }
catch {
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}
const db = require('../database');

function q(sql, ...args) { try { return db.prepare(sql).all(...args); } catch (e) { return { __err: e.message }; } }

console.log('\n═════ MEITUAN STOCK-PUSH DIAGNOSTIC ═════\n');

// 1) Queue status breakdown
const counts = q(`SELECT store_code, status, COUNT(*) n FROM meituan_sync_queue GROUP BY store_code, status ORDER BY store_code, status`);
console.log('── Queue rows by store + status ──');
if (counts.__err) console.log('  (meituan_sync_queue:', counts.__err, ')');
else if (!counts.length) console.log('  (queue empty)');
else for (const r of counts) console.log(`  ${r.store_code || '?'} · ${r.status} : ${r.n}`);

// 2) Stuck / failed queue rows (not done, OR maxed attempts, OR carry an error)
const stuck = q(`
  SELECT q.id, q.store_code, q.status, q.attempts, q.new_qty, q.bundle_id, q.last_error,
         p.name_cn, p.name_en, m.meituan_name
    FROM meituan_sync_queue q
    LEFT JOIN products p ON p.id = q.product_id
    LEFT JOIN meituan_product_map m ON m.product_id = q.product_id AND m.retail_store_id = q.retail_store_id
   WHERE q.status != 'done' OR q.attempts >= 3 OR q.last_error IS NOT NULL
   ORDER BY q.attempts DESC, q.id DESC
   LIMIT 80`);
console.log('\n── Stuck / failed queue rows ──');
if (stuck.__err) console.log('  (query error:', stuck.__err, ')');
else if (!stuck.length) console.log('  ✓ none — every queued push is done.');
else for (const r of stuck) {
  const label = r.bundle_id ? `[bundle ${r.bundle_id}] ${r.meituan_name || ''}` : `${r.name_cn || ''} ${r.name_en || ''}`.trim();
  console.log(`  #${r.id} ${r.store_code} · ${r.status} · tries=${r.attempts} · →${r.new_qty} · ${label}`);
  if (r.last_error) console.log(`        last_error: ${r.last_error}`);
}

// 3) Distinct products that errored in the sync log (historical failures)
const errs = q(`
  SELECT store_code, detail, error_msg, MAX(created_at) last_at, COUNT(*) n
    FROM meituan_sync_log
   WHERE event_type = 'stock_push' AND status = 'error'
   GROUP BY store_code, detail
   ORDER BY last_at DESC
   LIMIT 80`);
console.log('\n── Products with stock_push errors in the log ──');
if (errs.__err) console.log('  (meituan_sync_log:', errs.__err, ')');
else if (!errs.length) console.log('  ✓ no logged stock_push errors.');
else for (const r of errs) {
  let name = r.detail;
  try { const d = JSON.parse(r.detail); name = (d.name || '') + (d.bundle ? ' (bundle)' : '') + (d.qty != null ? ` →${d.qty}` : ''); } catch {}
  console.log(`  ${r.store_code} · ${name} · ×${r.n} · last ${r.last_at}`);
  if (r.error_msg) console.log(`        ${r.error_msg}`);
}

// 4) Mapped products vs. products with NO Meituan mapping (a common "can't update" cause)
const unmapped = q(`
  SELECT s.store_code, COUNT(*) n
    FROM meituan_product_map m
    JOIN meituan_stores s ON s.id = m.retail_store_id
   WHERE (m.meituan_name IS NULL OR m.meituan_name = '')
   GROUP BY s.store_code`);
console.log('\n── Mappings missing a Meituan name (can never resolve) ──');
if (unmapped.__err) console.log('  (skipped:', unmapped.__err, ')');
else if (!unmapped.length) console.log('  ✓ all mappings have a Meituan name.');
else for (const r of unmapped) console.log(`  ${r.store_code}: ${r.n} mapping(s) with blank meituan_name`);

console.log('\n═════════════════════════════════════════\n');
process.exit(0);
