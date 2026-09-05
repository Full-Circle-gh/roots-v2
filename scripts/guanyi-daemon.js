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
const { execFile } = require('child_process');
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

// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { getBrowser, closeAll } = require('../lib/guanyi-browser');
const { alertPlatform, alertMerchant, alertBoth } = require('../lib/ops-alert');
// ── Whose problem is it? (audit P-01) ─────────────────────────────────────
// Every alert below now says who is meant to ACT on it: alertMerchant for this
// account's trading day, alertPlatform for ours to fix, alertBoth for the rare
// thing that is genuinely both. Before this they all went to the platform's
// group, so a merchant was never told their own marketplace account had logged
// out.
//
// ONE ACCOUNT, TODAY, AND SAID PLAINLY. This daemon opens require('../database')
// — account 1's database — so account 1 is the only account it can be about. The
// addressing is real, not a placeholder; there is simply one addressee. When the
// channel sync becomes per-account (audit D-05, out of scope in this pass) this
// constant becomes a parameter and every alert below follows it with no second
// pass over these files.
const { ROOTS_TENANT_ID: ACCOUNT } = require('../lib/tenant-db');

const { claimWindow, clearWindow } = require('../lib/alert-latch');

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
// How many CONSECUTIVE identical bad-read-guard trips before the reading is taken
// as the new truth and the baselines are re-synced to it (see the guard itself).
const GUARD_RESYNC_AFTER = Number(process.env.GUANYI_GUARD_RESYNC_AFTER || 5);
const guardTripStreak = {};   // storeCode -> consecutive trips on an identical reading
const guardSig        = {};   // storeCode -> that reading's signature
let _lastReconcileAt = 0;

// ── Session health + auto-heal ────────────────────────────────────────────────
// The stock push is only as good as the Guanyi login behind it. When that session
// dies, pushes stop, Guanyi freezes at its last numbers, and gzgrocery keeps
// selling against them — silently, because processStockQueue only ever ran when
// something was queued and nothing here ever paged ops (unlike qingyun-daemon).
// So: probe the session on a timer whether or not work is pending, alert the
// System-Alerts WeCom group once it has genuinely gone (debounced, mirroring
// QINGYUN_LOGIN_DOWN_GRACE), alert again on recovery, and re-assert Tianhe's
// numbers for everything whose push died while we were locked out.
const HEALTH_MS        = Number(process.env.GUANYI_HEALTH_MS || 60_000);
const LOGIN_DOWN_GRACE = Number(process.env.GUANYI_LOGIN_DOWN_GRACE || 3);
const AUTOHEAL         = (process.env.GUANYI_AUTOHEAL || 'on').toLowerCase() !== 'off';
const RESYNC_MAX       = Number(process.env.GUANYI_RESYNC_MAX_PER_CYCLE || 25);
const loginFailStreak = {};   // storeCode -> consecutive failed probes
const downFlagged     = {};   // storeCode -> already alerted for this outage
const healedOnce      = {};   // storeCode -> heal has run since process start
let _lastHealthAt = 0;
// Keep the on-disk session in step with the live one (same interval and reasoning
// as meituan-daemon's SESSION_SAVE_MS), and warn while the login still works.
const SESSION_SAVE_MS       = Number(process.env.GUANYI_SESSION_SAVE_MS || 30 * 60_000);
const SESSION_WARN_MS       = Number(process.env.GUANYI_SESSION_WARN_MS || 72 * 3600_000);
const SESSION_WARN_EVERY_MS = Number(process.env.GUANYI_SESSION_WARN_EVERY_MS || 12 * 3600_000);
// Below this the notice stops saying "when convenient" and starts saying "now".
const SESSION_WARN_NOW_MS   = Number(process.env.GUANYI_SESSION_WARN_NOW_MS || 6 * 3600_000);
const lastSessionSave = {};   // storeCode -> epochMs of last on-disk refresh
const lastExpiryWarn  = {};   // storeCode -> epochMs of last "expiring soon" page
// THE EXPIRY NOTICE IS THE ONE ALERT HERE THAT HAS TO OUTLIVE THE PROCESS.
// Everything else this daemon pages about is a TRANSITION — the session just
// died, the proxy just came back — and re-announcing one of those after a
// restart is honest: the condition is live and a fresh process has no history.
// "Your login expires on Thursday, do it when convenient" is not a transition.
// It stays true for days, so an in-memory debounce holds it only until the next
// start, and on 2026-08-25 this daemon was restarting often enough (the box was
// also paging about disk >= 85%, which is what takes Chromium down) that the
// same advisory landed in the ops group roughly every twenty minutes. Once an
// alert channel does that, it stops being read — including for the alerts that
// mean the push has actually stopped. lib/alert-latch.js's claimWindow keeps the
// 12-hour window on disk — next to the latches the other four daemons already
// persist, and for the same reason — so a restart cannot re-open it. The "~0h"
// that made it absurd was lib/guanyi-browser.js reading the WAF's rolling cookie
// as the login's life; that is fixed in sessionExpiry().
const expiryWarnKey = (storeCode) => `${storeCode}:session_expiring`;

// ── Proxy health gate (mirrors meituan/shangou/qingyun-daemon) ────────────────
// A dead proxy makes fetchListings() fail exactly the way an expired session
// does — both come back null — so without this gate processSessionHealth blamed
// EVERY failure on the login and paged ops to burn ~6 min on a manual headed
// re-login (scripts/guanyi-login.js) even when the real fix was the proxy.
// Probes exactly what guanyi-browser.js's resolveProxy(storeCode) would launch
// Chrome on: the failover watchdog's live pick for this channel first (so Guanyi
// auto-follows the same residential/GZ/direct election Meituan's tianhe channel
// already makes — see lib/proxy-manager.js), else the static per-store env var.
// Direct mode (no proxy at all) is always "healthy" — a no-op there.
const GUANYI_BASE_URL      = 'https://v2.guanyierp.com';
const PROXY_DOWN_GRACE     = Number(process.env.GUANYI_PROXY_DOWN_GRACE || LOGIN_DOWN_GRACE);
const proxyFailStreak = {};   // storeCode -> consecutive failed probes
const proxyDownFlagged = {};  // storeCode -> already alerted for this outage
function activeProxy(storeCode) {
  try {
    const active = require('../lib/proxy-manager').readActive(storeCode);
    if (active !== undefined) return active; // '' is a valid value (direct)
  } catch (_) { /* manager optional — fall through to the static env var */ }
  return (storeCode && process.env[`GUANYI_PROXY_${String(storeCode).toUpperCase()}`])
    || process.env.GUANYI_PROXY_URL || '';
}
function proxyHealthy(storeCode, timeoutSec = 8) {
  const proxy = activeProxy(storeCode);
  if (!proxy) return Promise.resolve(true);
  // curl wants socks5h:// for remote DNS through a SOCKS5 exit — plain socks5://
  // resolves locally, which fails on a residential path Chrome handles fine.
  const probeUrl = proxy.startsWith('socks5://') ? 'socks5h://' + proxy.slice(9) : proxy;
  return new Promise((resolve) => {
    execFile('curl',
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-x', probeUrl,
       '--max-time', String(timeoutSec), `${GUANYI_BASE_URL}/`],
      { timeout: (timeoutSec + 4) * 1000 },
      (_err, stdout) => {
        const code = parseInt(String(stdout).trim(), 10) || 0;
        resolve(code >= 200 && code < 600);
      });
  });
}
function maskProxy(u) { return String(u || '').replace(/:[^:@/]+@/, ':****@'); }

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
          // Optimistically reconcile the cached Guanyi listing: after a successful
          // push Guanyi's stock for this SKU IS the target, so the admin table shows
          // "N =" instead of a stale "+delta" until the next heavy list refresh.
          if (res.targetQty != null) {
            db.prepare(`UPDATE guanyi_listings SET current_qty=?
                          WHERE store_code=? AND sku_id=(
                            SELECT guanyi_sku_id FROM guanyi_product_map
                             WHERE retail_store_id=? AND product_id=?)`)
              .run(res.targetQty, storeCode, row.retail_store_id, row.product_id);
          }
          logSync(storeCode, 'stock_push', 'ok',
            // res.name can be empty if the browser layer didn't echo it back, and
            // the OK line used to carry no SKU at all — so the log showed just a
            // bare number. Fall back to the queue row's names and the roots SKU.
            { name: res.name || row.guanyi_name || row.name_cn || row.name_en || '',
              sku: row.sku || row.guanyi_code || null,
              target: res.targetQty, was: res.currentQty, delta: res.skipped ? 0 : res.delta, skipped: !!res.skipped });
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

    // ── BAD-READ GUARD ────────────────────────────────────────────────────
    // A single garbage listing read (Guanyi momentarily returning ~0 for every
    // product) once zeroed 63 real products (−1863 units). Real pickups are a
    // handful of single-unit drops; a mass simultaneous drop — or a listing that
    // reads mostly zeros — is ALWAYS bad data, never sales. Pre-scan and skip
    // the whole store cycle (no decrement, no baseline change) if it looks off.
    {
      const MAX_DROPS = Number(process.env.GUANYI_MAX_DROPS_PER_CYCLE || 10);
      let drops = 0, zeros = 0, listed = 0;
      for (const m of items) {
        const cur = curBySku.get(String(m.guanyi_sku_id));
        if (!cur || cur.disabled) continue;
        listed++;
        if (Number(cur.currentQty) === 0) zeros++;
        const b = db.prepare(`SELECT baseline_qty FROM guanyi_pickup_baseline WHERE store_code=? AND product_id=?`).get(storeCode, m.product_id);
        if (b && Number(cur.currentQty) < b.baseline_qty) drops++;
      }
      if (listed >= 10 && (drops > MAX_DROPS || zeros > listed * 0.5)) {
        // The guard skips the cycle BEFORE any baseline is touched — which, for a
        // read that is bad only for a moment, is exactly right. But a baseline left
        // far behind reality (every push blocked through an outage while gzgrocery
        // kept selling) trips it on a read that is not garbage at all, and because
        // the skip also blocks the baseline update, the next cycle sees the same
        // gap and skips again. Nothing else writes that table, so it never escapes:
        // observed after 2026-08-25's proxy outage, an identical 141/18/184 every
        // 60s with no way out but a hand-edited database.
        //
        // So: hold the skip while the picture is still MOVING (a real garbage read
        // flickers — different products, different counts), and take a picture that
        // is byte-identical for GUARD_RESYNC_AFTER cycles running as the truth. Then
        // re-baseline to it and NEVER infer a pickup from the gap we jumped: those
        // units are unaccounted for either way, and inventing a decrement from a
        // number we just admitted we don't trust is how the guard's own -1863 unit
        // incident happened. Re-baselining only forfeits inference we never had.
        const sig = `${drops}/${zeros}/${listed}`;
        guardTripStreak[storeCode] = guardSig[storeCode] === sig ? (guardTripStreak[storeCode] || 0) + 1 : 1;
        guardSig[storeCode] = sig;
        const trips = guardTripStreak[storeCode];

        if (trips < GUARD_RESYNC_AFTER) {
          log(storeCode, `⚠ BAD-READ GUARD tripped (${trips}/${GUARD_RESYNC_AFTER}): ${drops} drop(s) / ${zeros} zero(s) of ${listed} listed — skipping cycle, NO decrement (likely a garbage Guanyi listing read).`);
          logSync(storeCode, 'pickup_guard', 'skip', { drops, zeros, listed, maxDrops: MAX_DROPS, trips });
          continue;
        }

        const rebase = db.prepare(`INSERT INTO guanyi_pickup_baseline
            (store_code,product_id,guanyi_sku_id,baseline_qty,acked_push_at,settle_pending,settle_target,updated_at)
            VALUES (?,?,?,?,?,0,NULL,CURRENT_TIMESTAMP)
            ON CONFLICT(store_code,product_id) DO UPDATE SET
              baseline_qty=excluded.baseline_qty, acked_push_at=excluded.acked_push_at,
              settle_pending=0, settle_target=NULL, updated_at=CURRENT_TIMESTAMP`);
        const note = db.prepare(`INSERT INTO guanyi_pickup_log
            (store_code,product_id,guanyi_sku_id,guanyi_name,observed_qty,baseline_qty,drift,inferred_pickup,tianhe_qty,mode,action,note)
            VALUES (?,?,?,?,?,?,?,NULL,?,?,'resync',?)`);
        let rebased = 0;
        const tx = db.transaction(() => {
          for (const m of items) {
            const cur = curBySku.get(String(m.guanyi_sku_id));
            if (!cur || cur.disabled) continue;
            const b = db.prepare(`SELECT baseline_qty FROM guanyi_pickup_baseline WHERE store_code=? AND product_id=?`).get(storeCode, m.product_id);
            const observed = Number(cur.currentQty);
            rebase.run(storeCode, m.product_id, m.guanyi_sku_id, observed, m.last_pushed_at || null);
            note.run(storeCode, m.product_id, m.guanyi_sku_id, cur.guanyiName || m.guanyi_name || '',
                     observed, b ? b.baseline_qty : null, b ? observed - b.baseline_qty : null,
                     m.tianhe_qty, PICKUP_MODE,
                     `guard re-baseline after ${trips} identical cycles — NO pickup inferred`);
            rebased++;
          }
        });
        tx();
        guardTripStreak[storeCode] = 0;
        guardSig[storeCode] = null;
        log(storeCode, `⚠ BAD-READ GUARD: same ${sig} for ${trips} cycles — accepted as truth, re-baselined ${rebased} product(s), NO pickup inferred.`);
        logSync(storeCode, 'pickup_guard', 'resync', { drops, zeros, listed, trips, rebased });
        // Not paged to WeCom: by construction nothing was lost and no action is
        // needed here (see the comment above this branch) — unlike a channel
        // disconnect or a proxy outage, this is the guard working as intended,
        // not a problem for a person to look at. Server log + logSync above are
        // enough to trace it after the fact if it ever needs investigating.
        continue;
      }
      guardTripStreak[storeCode] = 0;
      guardSig[storeCode] = null;
    }

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

// ── Session health + auto-heal ────────────────────────────────────────────────

// Every store we mirror stock into (the map is the authority; fall back to the
// configured single store so a fresh install still gets probed).
function guanyiStoreCodes() {
  try {
    const rows = db.prepare(`SELECT DISTINCT store_code FROM guanyi_product_map WHERE store_code IS NOT NULL AND store_code <> ''`).all();
    if (rows.length) return rows.map(r => r.store_code);
  } catch (e) { /* table missing on an older DB */ }
  return [GUANYI_STORE_CODE];
}

// Queue one product at the stock it has RIGHT NOW. Never re-queues a stale
// target: the number that failed to push minutes or days ago is not necessarily
// the number we hold today, and pushing it would write the wrong figure into
// Guanyi. Skips products that already have work waiting.
function enqueueCurrentStock(storeCode, retailStoreId, productId) {
  const pending = db.prepare(
    `SELECT 1 FROM guanyi_sync_queue WHERE retail_store_id=? AND product_id=? AND status IN ('pending','processing')`
  ).get(retailStoreId, productId);
  if (pending) return false;
  const row = db.prepare(
    `SELECT COALESCE(physical_qty, 0) AS q FROM retail_store_stock WHERE store_id=? AND product_id=?`
  ).get(retailStoreId, productId);
  db.prepare(`INSERT INTO guanyi_sync_queue (retail_store_id, product_id, store_code, new_qty, status)
              VALUES (?, ?, ?, ?, 'pending')`).run(retailStoreId, productId, storeCode, row ? row.q : 0);
  return true;
}

// Put right whatever went stale while the push was broken. Runs on the first
// healthy probe after start-up and after every recovery, with the listing we
// just read so no extra Guanyi traffic is needed.
function autoHeal(storeCode, listing) {
  if (!AUTOHEAL) return;
  const bySku = new Map();
  for (const r of listing.rows) bySku.set(String(r.skuId), r);

  const maps = db.prepare(`
    SELECT m.product_id, m.retail_store_id, m.guanyi_sku_id, m.sync_enabled, m.guanyi_name,
           p.sku, p.name_en, COALESCE(s.physical_qty, 0) AS tianhe_qty
      FROM guanyi_product_map m
      LEFT JOIN store_products p ON p.id = m.product_id
      LEFT JOIN retail_store_stock s ON s.product_id = m.product_id AND s.store_id = m.retail_store_id
     WHERE m.store_code = ? AND m.guanyi_sku_id IS NOT NULL
  `).all(storeCode);
  if (!maps.length) return;

  // A partial or garbage listing read must never drive a mass re-push. If most of
  // our mapped SKUs are missing from what we just read, treat the read as bad.
  const seen = maps.filter(m => bySku.has(String(m.guanyi_sku_id))).length;
  if (seen < maps.length * 0.5) {
    log(storeCode, `auto-heal: only ${seen}/${maps.length} mapped SKUs in the listing read — treating as a bad read, skipping`);
    logSync(storeCode, 'autoheal', 'skip', { seen, mapped: maps.length }, 'bad listing read');
    return;
  }

  const reenabled = [], revived = [], resynced = [];

  // 1. Mappings the daemon switched off itself (guanyi-daemon marks 已停用 SKUs
  //    sync_enabled=0 and nothing ever turned them back on). If Guanyi lists the
  //    SKU as active again, put it back in the fan-out.
  for (const m of maps) {
    if (m.sync_enabled) continue;
    const cur = bySku.get(String(m.guanyi_sku_id));
    if (!cur || cur.disabled) continue;
    db.prepare(`UPDATE guanyi_product_map SET sync_enabled=1, updated_at=CURRENT_TIMESTAMP
                 WHERE retail_store_id=? AND product_id=?`).run(m.retail_store_id, m.product_id);
    enqueueCurrentStock(storeCode, m.retail_store_id, m.product_id);
    reenabled.push(m.sku || m.guanyi_name || m.product_id);
  }

  // 2. Queue rows that died. processStockQueue only reads status='pending' AND
  //    attempts<3, so anything that burned its attempts (or hit a hard error while
  //    we were logged out) would sit dead for ever. Retire them and queue a fresh
  //    push at today's stock.
  const dead = db.prepare(`
    SELECT q.id, q.retail_store_id, q.product_id, p.sku
      FROM guanyi_sync_queue q LEFT JOIN store_products p ON p.id = q.product_id
     WHERE q.store_code = ? AND q.status = 'error'
  `).all(storeCode);
  const retire = db.prepare(`UPDATE guanyi_sync_queue SET status='done', processed_at=CURRENT_TIMESTAMP,
                                    last_error='auto-healed — re-queued at current stock' WHERE id=?`);
  for (const d of dead) {
    if (enqueueCurrentStock(storeCode, d.retail_store_id, d.product_id)) revived.push(d.sku || d.product_id);
    retire.run(d.id);
  }

  // 3. Safety net: anything where Guanyi simply disagrees with Tianhe. Skipped
  //    while pickup inference is live — that mode READS a downward drift as a
  //    gzgrocery sale, so re-pushing our number first would erase the very signal
  //    it works from. Capped, so a surprise never turns into a push storm.
  if (PICKUP_MODE !== 'live') {
    for (const m of maps) {
      if (!m.sync_enabled) continue;
      if (resynced.length >= RESYNC_MAX) break;
      const cur = bySku.get(String(m.guanyi_sku_id));
      if (!cur || cur.disabled) continue;
      if (Number(cur.currentQty) === Number(m.tianhe_qty)) continue;
      if (enqueueCurrentStock(storeCode, m.retail_store_id, m.product_id)) {
        resynced.push(`${m.sku || m.product_id} ${cur.currentQty}→${m.tianhe_qty}`);
      }
    }
  }

  const total = reenabled.length + revived.length + resynced.length;
  if (!total) return;
  const parts = [];
  if (reenabled.length) parts.push(`re-enabled ${reenabled.length} (${reenabled.slice(0, 5).join(', ')})`);
  if (revived.length)   parts.push(`revived ${revived.length} dead push(es) (${revived.slice(0, 5).join(', ')})`);
  if (resynced.length)  parts.push(`re-synced ${resynced.length} mismatch(es) (${resynced.slice(0, 5).join(', ')})`);
  const summary = parts.join('; ');
  log(storeCode, `auto-heal: ${summary}`);
  logSync(storeCode, 'autoheal', 'ok', { reenabled, revived, resynced });
  alertMerchant(ACCOUNT, `🩹 管易 ${storeCode} 库存同步已自动修复：${total} 个商品重新推送\nGuanyi ${storeCode} auto-healed — ${summary}`);
}

// Probe the login on a timer, regardless of whether anything is queued: an
// outage that starts while the queue is empty is exactly the one that goes
// unnoticed until gzgrocery orders something we do not have.
async function processSessionHealth() {
  const now = Date.now();
  if (now - _lastHealthAt < HEALTH_MS) return;
  _lastHealthAt = now;

  for (const storeCode of guanyiStoreCodes()) {
    // Rule out the proxy before blaming the login — a dead proxy fails
    // fetchListings() the same way an expired session does, and the fix is
    // completely different (nobody needs to touch a browser for this one).
    if (!(await proxyHealthy(storeCode))) {
      proxyFailStreak[storeCode] = (proxyFailStreak[storeCode] || 0) + 1;
      log(storeCode, `health: proxy unreachable (${proxyFailStreak[storeCode]}/${PROXY_DOWN_GRACE}) — not blaming the session`);
      if (!proxyDownFlagged[storeCode] && proxyFailStreak[storeCode] >= PROXY_DOWN_GRACE) {
        proxyDownFlagged[storeCode] = true;
        logSync(storeCode, 'proxy_down', 'error', null, 'proxy cannot reach Guanyi — stock push paused (not logged out)');
        alertPlatform(
          `🔴 管易 ${storeCode} 代理掉线，无法连接，库存推送已暂停（未掉登录）\n` +
          `Guanyi ${storeCode} proxy down (${maskProxy(activeProxy(storeCode))}) — stock push paused, session is NOT logged out, no need to re-run guanyi-login.js`
        );
      }
      continue; // skip the login-fail streak entirely — this isn't a login problem
    }
    if (proxyDownFlagged[storeCode]) {
      proxyDownFlagged[storeCode] = false;
      logSync(storeCode, 'proxy_up', 'ok', null, 'proxy reachable again — stock push resumed');
      alertPlatform(`✅ 管易 ${storeCode} 代理已恢复，库存推送继续\nGuanyi ${storeCode} proxy recovered — stock push resumed`);
    }
    proxyFailStreak[storeCode] = 0;

    let listing = null;
    try {
      const browser = await getBrowser(storeCode);
      listing = await browser.fetchListings();   // null = not logged in / bad response
    } catch (e) {
      log(storeCode, `health probe error: ${e.message}`);
    }

    if (!listing || !listing.rows || !listing.rows.length) {
      loginFailStreak[storeCode] = (loginFailStreak[storeCode] || 0) + 1;
      log(storeCode, `health: cannot read Guanyi (${loginFailStreak[storeCode]}/${LOGIN_DOWN_GRACE})`);
      // Debounce so a lone proxy blip or a slow page never pages ops at 3am —
      // same grace pattern qingyun-daemon uses for its own login watch.
      if (!downFlagged[storeCode] && loginFailStreak[storeCode] >= LOGIN_DOWN_GRACE) {
        downFlagged[storeCode] = true;
        logSync(storeCode, 'needs_login', 'error', null, 'Guanyi session expired — stock push STOPPED');
        alertMerchant(ACCOUNT, 
          `🔴 管易 ${storeCode} 登录已失效，库存推送已停止！gzgrocery 仍按旧库存下单，请在盒子上运行 scripts/guanyi-login.js 重新登录\n` +
          `Guanyi ${storeCode} session expired — stock push STOPPED. gzgrocery is still ordering against stale numbers; re-run scripts/guanyi-login.js on the box.`
        );
      }
      continue;
    }

    const wasDown = downFlagged[storeCode];
    downFlagged[storeCode] = false;
    loginFailStreak[storeCode] = 0;
    if (wasDown) {
      logSync(storeCode, 'needs_login', 'ok', null, 'session recovered');
      alertMerchant(ACCOUNT, `✅ 管易 ${storeCode} 已重新登录，库存推送恢复\nGuanyi ${storeCode} logged back in — stock push resumed`);
    }
    // Heal after any recovery, and once at start-up: a box restarted after a long
    // outage has no "down" transition to hang the heal off, but is exactly the
    // case where Guanyi is furthest out of date.
    if (wasDown || !healedOnce[storeCode]) {
      healedOnce[storeCode] = true;
      try { autoHeal(storeCode, listing); } catch (e) { log(storeCode, `auto-heal failed: ${e.message}`); }
    }

    // We just proved this session works. Write its CURRENT cookies to disk so a
    // restart resumes from them rather than from the login-time snapshot, which
    // is what the file otherwise keeps for ever (see persistSession). Throttled,
    // console-only — the same shape meituan-daemon uses.
    const nowMs = Date.now();
    if (!lastSessionSave[storeCode] || nowMs - lastSessionSave[storeCode] >= SESSION_SAVE_MS) {
      try {
        const browser = await getBrowser(storeCode);
        if (await browser.persistSession()) {
          lastSessionSave[storeCode] = nowMs;
          log(storeCode, 'session refreshed on disk');
        }
      } catch (e) { log(storeCode, `session refresh failed: ${e.message}`); }
    }

    // Say it before it happens. Everything else here reports a session that has
    // ALREADY died, by which point the push is down and someone has to drop what
    // they are doing; the cookies themselves know roughly when that will be, so
    // ask them and give the notice while the channel is still working.
    try {
      const browser = await getBrowser(storeCode);
      const exp = browser.sessionExpiry();
      if (exp) {
        const leftMs = exp.atMs - nowMs;
        const key = expiryWarnKey(storeCode);
        if (leftMs > 0 && leftMs <= SESSION_WARN_MS) {
          // Once per SESSION_WARN_EVERY_MS while inside the window: this is a
          // "get to it this week" notice, not something to repeat every minute
          // — and, because claimWindow keeps that window ON DISK, not something
          // to repeat every time this process starts either. Both are checked:
          // the in-memory one is the cheap hot path, the file is what makes the
          // window mean anything across a restart.
          const last = lastExpiryWarn[storeCode] || 0;
          if (nowMs - last >= SESSION_WARN_EVERY_MS
              && claimWindow('guanyi', key, SESSION_WARN_EVERY_MS,
                             { store: storeCode, cookie: exp.name, expires: new Date(exp.atMs).toISOString() })) {
            lastExpiryWarn[storeCode] = nowMs;
            const hrs = leftMs / 3600_000;
            const rounded = Math.max(1, Math.round(hrs));
            const cn = hrs < 1 ? '不到 1 小时' : `约 ${rounded} 小时`;
            const en = hrs < 1 ? '<1h' : `~${rounded}h`;
            log(storeCode, `session expiry warning: ${en} left on cookie ${exp.name} (expires ${new Date(exp.atMs).toISOString()})`);
            logSync(storeCode, 'session_expiring', 'error', { hours: rounded, cookie: exp.name, at: new Date(exp.atMs).toISOString() });
            // Never tell someone to take their time about something that is
            // hours away. Inside SESSION_WARN_NOW_MS the push is about to stop
            // and the message has to say so — the old text paired "~0h" with
            // "at your convenience", which is both alarming and useless.
            alertMerchant(ACCOUNT, leftMs <= SESSION_WARN_NOW_MS
              ? `🟠 管易 ${storeCode} 登录将在${cn}后过期，请尽快重新登录（过期后库存推送会停止）\n` +
                `Guanyi ${storeCode} login expires in ${en} — re-login NOW from the ops screen; stock push stops when it goes.`
              : `🟡 管易 ${storeCode} 登录将在${cn}后过期，请在方便时重新登录（现在同步仍正常）\n` +
                `Guanyi ${storeCode} login expires in ${en} — re-login at your convenience from the ops screen; sync is still fine for now.`);
          }
        } else if (leftMs > SESSION_WARN_MS) {
          lastExpiryWarn[storeCode] = 0;   // healthy again after a re-login
          clearWindow('guanyi', key);      // …and the next notice is news, not a repeat
        }
      }
    } catch (e) { log(storeCode, `session expiry check failed: ${e.message}`); }
  }
}

// ── Main loop ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[guanyi-daemon] starting (pickup-mode=${PICKUP_MODE}, reconcile=${RECONCILE_MS}ms, cap=${PICKUP_CAP}, ` +
              `health=${HEALTH_MS}ms grace=${LOGIN_DOWN_GRACE}, proxyGrace=${PROXY_DOWN_GRACE}, autoheal=${AUTOHEAL ? 'on' : 'off'})`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Health first: it owns the login alert and the heal, and a dead session makes
    // everything below it a no-op anyway.
    try { await processSessionHealth(); } catch (e) { console.error('[guanyi-daemon] health:', e.message); }
    try { await processStockQueue(); } catch (e) { console.error('[guanyi-daemon] queue:', e.message); }
    try { await processPickupReconcile(); } catch (e) { console.error('[guanyi-daemon] reconcile:', e.message); }
    try { await processListingJobs(); } catch (e) { console.error('[guanyi-daemon] jobs:', e.message); }
    await sleep(jitter(QUEUE_CHECK_MS));
  }
}

process.on('SIGINT',  async () => { await closeAll(); process.exit(0); });
process.on('SIGTERM', async () => { await closeAll(); process.exit(0); });

main().catch(err => { console.error('[guanyi-daemon] fatal:', err); process.exit(1); });
