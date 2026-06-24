// Guanyi (gzgrocery) stock-sync daemon — a separate pm2 process that keeps
// gzgrocery's Guanyi on-hand equal to our Tianhe warehouse stock.
//
// Unlike Meituan this channel is stock-OUT only (we never import orders FROM
// Guanyi), so the loop does just two things, checked every ~10s (jittered):
//   1. processStockQueue — reconcile guanyi_sync_queue targets into Guanyi by
//      creating an inbound/outbound document for (target − current) and approving.
//   2. processListingJobs — refresh the guanyi_listings cache on admin request.
//
// Start:  pm2 start scripts/guanyi-daemon.js --name guanyi-sync
// Logs:   pm2 logs guanyi-sync
//
// First run needs a logged-in session: run scripts/guanyi-login.js once (headed,
// a human types the password), copy data/guanyi-sessions/<store>-session.json to
// the box, then start/restart this daemon.

'use strict';

const path = require('path');
const fs   = require('fs');
const envFile = path.join(__dirname, '../.env');
try {
  require('dotenv').config({ path: envFile });
} catch {
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

const db = require('../database');
const { getBrowser, closeAll } = require('../lib/guanyi-browser');

const QUEUE_CHECK_MS = 10_000;

// Don't fire on an exact fixed cadence.
function jitter(baseMs, frac = 0.3) {
  const spread = baseMs * frac;
  return Math.round(baseMs - spread + Math.random() * spread * 2);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(storeCode, msg) {
  console.log(`[guanyi-daemon:${storeCode}] ${new Date().toISOString()} ${msg}`);
}
function logSync(storeCode, eventType, status, detail, errorMsg) {
  try {
    db.prepare(`
      INSERT INTO guanyi_sync_log (store_code, event_type, status, detail, error_msg)
      VALUES (?, ?, ?, ?, ?)
    `).run(storeCode, eventType, status, detail ? JSON.stringify(detail) : null, errorMsg || null);
  } catch {}
}

// ── Stock push queue ──────────────────────────────────────────────────────────

async function processStockQueue() {
  const rows = db.prepare(`
    SELECT q.*, p.name_cn, p.name_en, p.sku,
           m.guanyi_name, m.guanyi_code, m.guanyi_sku_id, m.guanyi_item_id, m.guanyi_item_sku_id
      FROM guanyi_sync_queue q
      LEFT JOIN store_products p ON p.id = q.product_id
      LEFT JOIN guanyi_product_map m
             ON m.product_id = q.product_id AND m.retail_store_id = q.retail_store_id
     WHERE q.status = 'pending' AND q.attempts < 3
     ORDER BY q.created_at
     LIMIT 60
  `).all();
  if (!rows.length) return;

  const byStore = {};
  for (const row of rows) (byStore[row.store_code] = byStore[row.store_code] || []).push(row);

  for (const [storeCode, items] of Object.entries(byStore)) {
    // Collapse to the latest target per product so we reconcile once, not once
    // per intermediate change. Older same-product rows are retired as superseded.
    const latest = new Map();
    const superseded = [];
    for (const row of items) {
      const prev = latest.get(row.product_id);
      if (prev) superseded.push(prev);
      latest.set(row.product_id, row);
    }
    for (const row of superseded) {
      db.prepare(`UPDATE guanyi_sync_queue SET status='done', processed_at=CURRENT_TIMESTAMP, last_error='superseded' WHERE id=?`).run(row.id);
    }
    const pushRows = Array.from(latest.values());

    // Rows with no usable Guanyi mapping (never matched, or matched without a
    // sku id) can't be pushed — fail them clearly instead of looping.
    const ready = [];
    for (const row of pushRows) {
      if (!row.guanyi_sku_id) {
        db.prepare(`UPDATE guanyi_sync_queue SET status='error', processed_at=CURRENT_TIMESTAMP, attempts=attempts+1, last_error='no guanyi mapping' WHERE id=?`).run(row.id);
        continue;
      }
      ready.push(row);
    }
    if (!ready.length) continue;

    let browser;
    try {
      browser = await getBrowser(storeCode);

      // One product-list read for the whole batch → current on-hand per sku.
      const listing = await browser.fetchListings();
      if (!listing) throw new Error('fetchListings returned null (not logged in?)');
      const curBySku = new Map();
      for (const r of listing.rows) curBySku.set(r.skuId, r);

      for (const row of ready) {
        db.prepare(`UPDATE guanyi_sync_queue SET status='processing', attempts=attempts+1 WHERE id=?`).run(row.id);
      }

      const apply = ready.map(row => {
        const cur = curBySku.get(String(row.guanyi_sku_id));
        return {
          row,
          skuId:      row.guanyi_sku_id,
          itemId:     row.guanyi_item_id,
          itemSkuId:  row.guanyi_item_sku_id,
          code:       row.guanyi_code,
          name:       row.guanyi_name || row.name_cn || '',
          currentQty: cur ? cur.currentQty : null, // null → not found in Guanyi
          targetQty:  row.new_qty,
        };
      });

      // Items whose sku wasn't in the live list can't be reconciled safely.
      const missing = apply.filter(a => a.currentQty == null);
      for (const a of missing) {
        db.prepare(`UPDATE guanyi_sync_queue SET status='error', processed_at=CURRENT_TIMESTAMP, last_error='sku not found in Guanyi list' WHERE id=?`).run(a.row.id);
        logSync(storeCode, 'stock_push', 'error', { name: a.name, sku: a.skuId }, 'sku not in Guanyi list');
      }
      const pushable = apply.filter(a => a.currentQty != null);
      if (!pushable.length) continue;

      const results = await browser.applyDeltas(pushable);

      for (const res of results) {
        const row = res.row;
        if (res.ok || res.skipped) {
          db.prepare(`UPDATE guanyi_sync_queue SET status='done', processed_at=CURRENT_TIMESTAMP, last_error=NULL WHERE id=?`).run(row.id);
          db.prepare(`UPDATE guanyi_product_map SET last_pushed_qty=?, last_delta=?, last_pushed_at=CURRENT_TIMESTAMP WHERE retail_store_id=? AND product_id=?`)
            .run(res.targetQty, res.skipped ? 0 : res.delta, row.retail_store_id, row.product_id);
          logSync(storeCode, 'stock_push', 'ok',
            { name: res.name, target: res.targetQty, was: res.currentQty, delta: res.skipped ? 0 : res.delta, skipped: !!res.skipped });
        } else {
          db.prepare(`UPDATE guanyi_sync_queue SET status='error', processed_at=CURRENT_TIMESTAMP, last_error='document create/approve failed' WHERE id=?`).run(row.id);
          logSync(storeCode, 'stock_push', 'error', { name: res.name, target: res.targetQty, delta: res.delta });
        }
      }
    } catch (err) {
      log(storeCode, `processStockQueue error: ${err.message}`);
      for (const row of ready) {
        db.prepare(`UPDATE guanyi_sync_queue SET status='error', last_error=? WHERE id=? AND status='processing'`)
          .run(String(err.message).slice(0, 200), row.id);
      }
      logSync(storeCode, 'stock_push', 'error', null, err.message);
    }
  }
}

// ── Listing refresh jobs ───────────────────────────────────────────────────────

async function processListingJobs() {
  const jobs = db.prepare(`SELECT * FROM guanyi_listing_jobs WHERE status='pending' ORDER BY created_at LIMIT 5`).all();
  if (!jobs.length) return;

  for (const job of jobs) {
    db.prepare(`UPDATE guanyi_listing_jobs SET status='processing' WHERE id=?`).run(job.id);
    try {
      const browser = await getBrowser(job.store_code);
      const listing = await browser.fetchListings();
      if (!listing) throw new Error('fetchListings returned null (not logged in or no rows)');
      const rows = listing.rows || [];

      const tx = db.transaction(() => {
        db.prepare(`DELETE FROM guanyi_listings WHERE store_code=?`).run(job.store_code);
        const ins = db.prepare(`
          INSERT OR REPLACE INTO guanyi_listings
            (store_code, guanyi_name, code, sku_id, item_id, item_sku_id, warehouse_id, warehouse_name, current_qty)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const r of rows) {
          ins.run(job.store_code, r.guanyiName, r.code, r.skuId, r.itemId, r.itemSkuId,
                  r.warehouseId, r.warehouseName, r.currentQty);
        }
      });
      tx();

      db.prepare(`UPDATE guanyi_listing_jobs SET status='done', result_count=?, error=NULL, completed_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(rows.length, job.id);
      logSync(job.store_code, 'listing_refresh', 'ok', { count: rows.length });
      log(job.store_code, `listing refresh done: ${rows.length} product(s)`);
    } catch (err) {
      db.prepare(`UPDATE guanyi_listing_jobs SET status='error', error=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(String(err.message).slice(0, 200), job.id);
      logSync(job.store_code, 'listing_refresh', 'error', null, err.message);
      log(job.store_code, `processListingJobs error: ${err.message}`);
    }
  }
}

// ── Main loop ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('[guanyi-daemon] starting');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await processStockQueue(); } catch (e) { console.error('[guanyi-daemon] queue:', e.message); }
    try { await processListingJobs(); } catch (e) { console.error('[guanyi-daemon] jobs:', e.message); }
    await sleep(jitter(QUEUE_CHECK_MS));
  }
}

process.on('SIGINT',  async () => { await closeAll(); process.exit(0); });
process.on('SIGTERM', async () => { await closeAll(); process.exit(0); });

main().catch(err => { console.error('[guanyi-daemon] fatal:', err); process.exit(1); });
