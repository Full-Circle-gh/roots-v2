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

// Defensive: ensure the pickup-inference tables exist even if the deployed
// database.js predates them (the box is deployed by scp, not a migration run).
function ensurePickupTables() {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS guanyi_pickup_baseline (
      store_code TEXT NOT NULL, product_id INTEGER NOT NULL, guanyi_sku_id TEXT,
      baseline_qty INTEGER, acked_push_at TEXT, settle_pending INTEGER DEFAULT 0,
      settle_target INTEGER, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (store_code, product_id));`);
    db.exec(`CREATE TABLE IF NOT EXISTS guanyi_pickup_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, store_code TEXT, product_id INTEGER,
      guanyi_sku_id TEXT, guanyi_name TEXT, observed_qty INTEGER, baseline_qty INTEGER,
      drift INTEGER, inferred_pickup INTEGER, tianhe_qty INTEGER, mode TEXT, action TEXT,
      note TEXT, resolved INTEGER DEFAULT 0, resolution TEXT, resolved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gypl_created ON guanyi_pickup_log(created_at)`);
    for (const col of ['resolved INTEGER DEFAULT 0', 'resolution TEXT', 'resolved_at DATETIME']) {
      try { db.exec(`ALTER TABLE guanyi_pickup_log ADD COLUMN ${col}`); } catch (e) {}
    }
  } catch (e) { console.error('[guanyi-daemon] ensurePickupTables:', e.message); }
}
ensurePickupTables();

const QUEUE_CHECK_MS = 10_000;

// ── gzgrocery pickup inference (we can't read their orders — infer from stock) ──
// Mode: off | shadow | live.  Phase 0 = 'shadow' (detect + LOG what it WOULD
// decrement, change nothing). 'live' (Phase 1) actually decrements Tianhe.
let PICKUP_MODE = (process.env.GUANYI_PICKUP_MODE || 'off').toLowerCase();
if (!['off', 'shadow', 'live'].includes(PICKUP_MODE)) PICKUP_MODE = 'off';
const GUANYI_STORE_CODE  = process.env.GUANYI_STORE_CODE || 'tianhe';
const RECONCILE_MS       = Number(process.env.GUANYI_RECONCILE_MS || 60_000);   // how often to sample
const PICKUP_CAP         = Number(process.env.GUANYI_PICKUP_CAP || 50);          // a single drop bigger than this is flagged, not applied
const SETTLE_TIMEOUT_MS  = Number(process.env.GUANYI_SETTLE_TIMEOUT_MS || 180_000); // give a push this long to settle before trusting drift
let _lastReconcileAt = 0;

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

// A transient Guanyi failure: keep the row retryable (back to 'pending') while
// it still has attempts left, otherwise burn it to a terminal 'error' and log.
// attempts was already incremented when the row was set 'processing', so the
// row's current attempts reflects this try.
function retryOrFail(storeCode, row, retryError, logDetail, terminalError) {
  const r = db.prepare(`SELECT attempts FROM guanyi_sync_queue WHERE id=?`).get(row.id);
  const attempts = r ? r.attempts : 99;
  if (attempts < 3) {
    db.prepare(`UPDATE guanyi_sync_queue SET status='pending', processed_at=NULL, last_error=? WHERE id=?`)
      .run(retryError, row.id);
  } else {
    db.prepare(`UPDATE guanyi_sync_queue SET status='error', processed_at=CURRENT_TIMESTAMP, last_error=? WHERE id=?`)
      .run(terminalError, row.id);
    logSync(storeCode, 'stock_push', 'error', logDetail, terminalError);
  }
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
          name:       (cur && cur.guanyiName) || row.guanyi_name || row.name_cn || '',
          currentQty: cur ? cur.currentQty : null, // null → not found in Guanyi
          disabled:   cur ? !!cur.disabled : false, // 已停用 in Guanyi
          targetQty:  row.new_qty,
        };
      });

      // Items whose sku wasn't in the live list can't be reconciled safely.
      const missing = apply.filter(a => a.currentQty == null);
      for (const a of missing) {
        db.prepare(`UPDATE guanyi_sync_queue SET status='error', processed_at=CURRENT_TIMESTAMP, last_error='sku not found in Guanyi list' WHERE id=?`).run(a.row.id);
        logSync(storeCode, 'stock_push', 'error', { name: a.name, sku: a.skuId }, 'sku not in Guanyi list');
      }
      // 已停用 (deactivated) SKUs can't take an adjustment — Guanyi rejects them
      // with 系统异常 and poisons the whole batch. Skip them (mark done, not error)
      // and turn off their mapping so they stop being re-queued on the next push.
      const disabled = apply.filter(a => a.currentQty != null && a.disabled);
      for (const a of disabled) {
        db.prepare(`UPDATE guanyi_sync_queue SET status='done', processed_at=CURRENT_TIMESTAMP, last_error='guanyi disabled (已停用) — skipped' WHERE id=?`).run(a.row.id);
        db.prepare(`UPDATE guanyi_product_map SET sync_enabled=0, updated_at=CURRENT_TIMESTAMP WHERE retail_store_id=? AND product_id=?`).run(a.row.retail_store_id, a.row.product_id);
        logSync(storeCode, 'stock_push', 'skipped', { name: a.name, sku: a.skuId }, '已停用 (disabled in Guanyi)');
      }
      if (disabled.length) log(storeCode, `skipped ${disabled.length} 已停用 product(s), sync_enabled cleared`);

      const pushable = apply.filter(a => a.currentQty != null && !a.disabled);
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
        } else if (res.transient) {
          // Guanyi-side hiccup (系统异常 etc.). Keep retryable until attempts hit
          // 3 so the daemon self-heals; only burn to terminal error once spent.
          retryOrFail(storeCode, row, '系统异常 (transient) — retrying', { name: res.name, target: res.targetQty }, '系统异常 after retries');
        } else {
          db.prepare(`UPDATE guanyi_sync_queue SET status='error', processed_at=CURRENT_TIMESTAMP, last_error='document create/approve failed' WHERE id=?`).run(row.id);
          logSync(storeCode, 'stock_push', 'error', { name: res.name, target: res.targetQty, delta: res.delta });
        }
      }
    } catch (err) {
      // A thrown batch (fetchListings null, network/proxy blip) is transient —
      // keep the still-processing rows retryable rather than failing them once.
      log(storeCode, `processStockQueue error: ${err.message}`);
      for (const row of ready) {
        const r = db.prepare(`SELECT attempts, status FROM guanyi_sync_queue WHERE id=?`).get(row.id);
        if (!r || r.status !== 'processing') continue;
        if (r.attempts < 3) {
          db.prepare(`UPDATE guanyi_sync_queue SET status='pending', processed_at=NULL, last_error=? WHERE id=?`)
            .run(String(err.message).slice(0, 200), row.id);
        } else {
          db.prepare(`UPDATE guanyi_sync_queue SET status='error', processed_at=CURRENT_TIMESTAMP, last_error=? WHERE id=?`)
            .run(String(err.message).slice(0, 200), row.id);
        }
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

// ── gzgrocery pickup reconcile (infer sales from Guanyi stock drift) ──────────
//
// gzgrocery holds no stock and never edits the Guanyi number, so the only thing
// that lowers a product's salableQty (besides our own push) is a customer order.
// We mirror our stock INTO Guanyi, so a drop BELOW what we last set = exactly the
// units they sold. This pass tracks a per-product baseline and, on an autonomous
// downward drift, infers a pickup. In 'shadow' mode it ONLY logs what it would
// decrement; in 'live' mode it would also apply the decrement to Tianhe (Phase 1).
async function processPickupReconcile() {
  if (PICKUP_MODE === 'off') return;
  const now = Date.now();
  if (now - _lastReconcileAt < RECONCILE_MS) return;
  _lastReconcileAt = now;

  const maps = db.prepare(`
    SELECT m.product_id, m.retail_store_id, m.store_code, m.guanyi_sku_id, m.guanyi_name,
           m.last_pushed_qty, m.last_pushed_at, m.last_delta,
           COALESCE(s.physical_qty, 0) AS tianhe_qty
      FROM guanyi_product_map m
      LEFT JOIN retail_store_stock s ON s.product_id = m.product_id AND s.store_id = m.retail_store_id
     WHERE m.sync_enabled = 1 AND m.guanyi_sku_id IS NOT NULL
  `).all();
  if (!maps.length) return;

  const byStore = {};
  for (const m of maps) (byStore[m.store_code] = byStore[m.store_code] || []).push(m);

  for (const [storeCode, items] of Object.entries(byStore)) {
    let listing;
    try {
      const browser = await getBrowser(storeCode);
      listing = await browser.fetchListings();
    } catch (e) { log(storeCode, `pickup reconcile fetch error: ${e.message}`); continue; }
    if (!listing) continue;
    const curBySku = new Map();
    for (const r of listing.rows) curBySku.set(String(r.skuId), r);

    let detected = 0;
    for (const m of items) {
      const cur = curBySku.get(String(m.guanyi_sku_id));
      if (!cur || cur.disabled) continue;          // not listed / 已停用 → skip
      if (reconcileOne(storeCode, m, cur)) detected++;
    }
    if (detected) log(storeCode, `pickup reconcile (${PICKUP_MODE}): ${detected} drop(s) detected`);
  }
}

// Reconcile one product against its baseline. Returns true if a pickup drop was
// logged this cycle. NEVER changes Tianhe in 'shadow' mode.
function reconcileOne(storeCode, m, cur) {
  const observed = cur.currentQty;
  const name = cur.guanyiName || m.guanyi_name || '';
  const b = db.prepare(`SELECT * FROM guanyi_pickup_baseline WHERE store_code=? AND product_id=?`).get(storeCode, m.product_id);

  const logRow = (action, drift, pickup, note) => {
    db.prepare(`INSERT INTO guanyi_pickup_log
        (store_code,product_id,guanyi_sku_id,guanyi_name,observed_qty,baseline_qty,drift,inferred_pickup,tianhe_qty,mode,action,note)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(storeCode, m.product_id, m.guanyi_sku_id, name, observed,
           b ? b.baseline_qty : null, drift == null ? null : drift,
           pickup == null ? null : pickup, m.tianhe_qty, PICKUP_MODE, action, note || null);
  };

  if (!b) {
    db.prepare(`INSERT INTO guanyi_pickup_baseline
        (store_code,product_id,guanyi_sku_id,baseline_qty,acked_push_at,settle_pending,settle_target,updated_at)
        VALUES (?,?,?,?,?,0,NULL,CURRENT_TIMESTAMP)`)
      .run(storeCode, m.product_id, m.guanyi_sku_id, observed, m.last_pushed_at || null);
    logRow('init', 0, 0, `baseline=${observed}`);
    return false;
  }

  // Our own push also moves the Guanyi number — don't read that as a pickup.
  // When a new push (non-zero delta) has happened, wait for it to settle.
  const newPush = m.last_pushed_at && m.last_pushed_at !== b.acked_push_at && (m.last_delta || 0) !== 0;
  let settlePending = b.settle_pending;
  let settleTarget  = b.settle_target;
  let ackedPushAt   = b.acked_push_at;
  if (newPush) { settlePending = 1; settleTarget = m.last_pushed_qty; ackedPushAt = m.last_pushed_at; }

  if (settlePending) {
    const settled  = settleTarget != null && observed === settleTarget;
    const pushedMs = m.last_pushed_at ? Date.parse(m.last_pushed_at.replace(' ', 'T') + 'Z') : 0;
    const timedOut = pushedMs && (Date.now() - pushedMs > SETTLE_TIMEOUT_MS);
    if (settled || timedOut) {
      db.prepare(`UPDATE guanyi_pickup_baseline SET baseline_qty=?, acked_push_at=?, settle_pending=0, settle_target=NULL, updated_at=CURRENT_TIMESTAMP WHERE store_code=? AND product_id=?`)
        .run(observed, ackedPushAt, storeCode, m.product_id);
      logRow('resync', observed - b.baseline_qty, null, settled ? 'push settled' : 'settle timeout');
    } else {
      db.prepare(`UPDATE guanyi_pickup_baseline SET settle_pending=1, settle_target=?, acked_push_at=?, updated_at=CURRENT_TIMESTAMP WHERE store_code=? AND product_id=?`)
        .run(settleTarget, ackedPushAt, storeCode, m.product_id);
    }
    return false;
  }

  const drift = observed - b.baseline_qty;
  if (drift === 0) return false;

  let detected = false;
  if (drift < 0) {
    const pickup = -drift;
    const capped = pickup > PICKUP_CAP || pickup > m.tianhe_qty;
    if (capped) {
      logRow('capped', drift, pickup, `drop ${pickup} > cap ${PICKUP_CAP} or Tianhe ${m.tianhe_qty} — NOT applied, review`);
    } else if (PICKUP_MODE === 'live') {
      // Phase 1: apply the decrement to Tianhe through the canonical inventory
      // path so it's ledgered AND fanned out to the other channels (Meituan/web)
      // — the units physically left the building. adjustStock uses tdb(), which
      // in this headless daemon resolves to the same shared db (Roots = tenant 1).
      const newQty = Math.max(0, m.tianhe_qty - pickup);
      const clamped = (m.tianhe_qty - pickup) < 0;
      try {
        const { adjustStock } = require('../lib/inventory');
        adjustStock({
          storeId: m.retail_store_id, productId: m.product_id, newPhysicalQty: newQty,
          actorLabel: 'guanyi-pickup', reason: 'guanyi_pickup',
          note: `inferred gzgrocery pickup: ${name} ${b.baseline_qty}→${observed} (−${pickup})`,
        });
        logRow('decremented', drift, pickup, `Tianhe ${m.tianhe_qty}→${newQty}${clamped ? ' (CLAMPED at 0)' : ''}`);
        log(storeCode, `pickup: ${name} −${pickup} → Tianhe ${m.tianhe_qty}→${newQty}${clamped ? ' (clamped)' : ''}`);
      } catch (e) {
        logRow('error', drift, pickup, `adjustStock failed: ${String(e.message).slice(0, 120)}`);
        log(storeCode, `pickup decrement FAILED for ${name}: ${e.message}`);
      }
    } else {
      logRow('would_decrement', drift, pickup, `shadow: would set Tianhe ${m.tianhe_qty}->${m.tianhe_qty - pickup}`);
    }
    detected = true;
  } else {
    logRow('drift_up', drift, null, `Guanyi rose +${drift} with no push (cancellation/return?) — not applied`);
  }
  db.prepare(`UPDATE guanyi_pickup_baseline SET baseline_qty=?, updated_at=CURRENT_TIMESTAMP WHERE store_code=? AND product_id=?`)
    .run(observed, storeCode, m.product_id);
  return detected;
}

// ── Main loop ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[guanyi-daemon] starting (pickup-mode=${PICKUP_MODE}, reconcile=${RECONCILE_MS}ms, cap=${PICKUP_CAP})`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await processStockQueue(); } catch (e) { console.error('[guanyi-daemon] queue:', e.message); }
    try { await processPickupReconcile(); } catch (e) { console.error('[guanyi-daemon] reconcile:', e.message); }
    try { await processListingJobs(); } catch (e) { console.error('[guanyi-daemon] jobs:', e.message); }
    await sleep(jitter(QUEUE_CHECK_MS));
  }
}

process.on('SIGINT',  async () => { await closeAll(); process.exit(0); });
process.on('SIGTERM', async () => { await closeAll(); process.exit(0); });

main().catch(err => { console.error('[guanyi-daemon] fatal:', err); process.exit(1); });
