// Meituan bidirectional sync daemon — runs as a separate pm2 process.
//
// Every ~5 minutes (jittered):
//   1. Poll 天河 + 越秀 Meituan backends for new pending orders
//   2. Import each order into roots-v2 + deduct stock (import-only by default;
//      auto-accept on Meituan is off unless MEITUAN_AUTO_ACCEPT=1)
// (~5 min, not 60–120s: order timing isn't critical — Meituan prints its own
//  receipt — so the daemon's job is stock sync + unified records. A slow,
//  irregular poll minimises the recurring page loads = smaller bot footprint,
//  while still deducting stock within minutes so other channels don't oversell.)
//
// Immediately (checked every 10 seconds):
//   3. Process meituan_sync_queue — push stock changes from roots-v2 to Meituan
//
// Start:  pm2 start scripts/meituan-daemon.js --name meituan-sync
// Logs:   pm2 logs meituan-sync
// Stop:   pm2 stop meituan-sync
//
// First run per store: browser launches in headed mode so staff can log in
// (Meituan requires WeChat QR or phone login). Session is saved; subsequent
// runs are headless.

'use strict';

const path = require('path');
const fs   = require('fs');
// Load .env from project root (dotenv may not be installed — fall back to manual parse)
const envFile = path.join(__dirname, '../.env');
try {
  require('dotenv').config({ path: envFile });
} catch {
  // dotenv not available — parse .env manually
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

const db = require('../database');
const { getBrowser, closeAll } = require('../lib/meituan-browser');

const ORDER_POLL_MS  = 300_000; // how often to check for new Meituan orders (jittered ±40%)
// Import-only by default: pull orders into roots (records + stock) but do NOT
// click "accept" on Meituan. Set MEITUAN_AUTO_ACCEPT=1 in .env to re-enable.
const AUTO_ACCEPT    = process.env.MEITUAN_AUTO_ACCEPT === '1';
const QUEUE_CHECK_MS = 10_000;  // how often to process the stock push queue
const INTERNAL_PORT  = process.env.PORT || 3000;
const INTERNAL_BASE  = `http://127.0.0.1:${INTERNAL_PORT}`;

// Per-store opening hours (Asia/Shanghai). Outside these windows the store is
// closed on Meituan, so we stop order-polling AND stock-pushing: a merchant
// backend that keeps refreshing/editing at 4am is itself a bot tell, and idling
// the browser saves RAM + proxy traffic. Minutes are local 24h; [open, close).
// A small grace buffer (OPEN_GRACE_MIN) widens the window so trailing/pre-orders
// still import and the on/off edge doesn't land exactly on the hour.
const OPEN_GRACE_MIN = 15;
const STORE_HOURS = {
  yuexiu: { open: 11 * 60 + 0,  close: 20 * 60 + 15 }, // 11:00–20:15
  tianhe: { open: 10 * 60 + 0,  close: 20 * 60 + 0  }, // 10:00–20:00
};

// Minutes-since-midnight in Asia/Shanghai (UTC+8), independent of server TZ.
function shanghaiMinutes(now = new Date()) {
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes();
}

// True when the store is within its (grace-padded) Meituan opening window. Stores
// with no configured hours default to always-open so a new store is never
// silently muted.
function isStoreOpen(storeCode, now = new Date()) {
  const h = STORE_HOURS[storeCode];
  if (!h) return true;
  const m = shanghaiMinutes(now);
  return m >= (h.open - OPEN_GRACE_MIN) && m < (h.close + OPEN_GRACE_MIN);
}

// Tier 1 fingerprint reduction: never act on an exact fixed cadence. Each
// interval is re-jittered so order polls and queue checks land at human-
// irregular times instead of a metronomic 60s / 10s that screams "bot".
function jitter(baseMs, frac = 0.3) {
  const spread = baseMs * frac;
  return Math.round(baseMs - spread + Math.random() * spread * 2);
}

// Per-store latch so a 验证中心 challenge is logged once on transition, not
// every poll (which would flood the sync log the admin tab reads).
const verifyFlagged = {};

// Per-store latch so the "store closed → pausing polls" / "reopened → resuming"
// edge is logged once on transition, not on every loop tick.
const closedFlagged = {};

// When a store hits the 验证中心 challenge, STOP touching it for a while instead
// of re-navigating into the verify page every cycle — every such hit re-pokes
// risk-control from the already-flagged session and only deepens the flag /
// poisons the proxy IP. The cool-down escalates per consecutive strike and
// resets once a poll comes back clean. A human still has to pass the captcha;
// this just stops us hammering it in the meantime.
const VERIFY_COOLDOWN_BASE_MS = 30 * 60_000;      // first strike: 30 min
const VERIFY_COOLDOWN_MAX_MS  = 4 * 60 * 60_000;  // cap: 4 h
const verifyState = {}; // storeCode -> { until: epochMs, strikes: n }

function inVerifyCooldown(storeCode, now = Date.now()) {
  const s = verifyState[storeCode];
  return !!(s && s.until && now < s.until);
}

// Record the outcome of a navigation that could have been challenged. On a
// challenge: escalate the cool-down and log once on transition. On a clean
// result: clear the cool-down and log the recovery once.
function noteVerifyResult(storeCode, challenged) {
  const s = verifyState[storeCode] || (verifyState[storeCode] = { until: 0, strikes: 0 });
  if (challenged) {
    s.strikes = Math.min(s.strikes + 1, 8);
    const wait = Math.min(VERIFY_COOLDOWN_BASE_MS * 2 ** (s.strikes - 1), VERIFY_COOLDOWN_MAX_MS);
    s.until = Date.now() + wait;
    if (!verifyFlagged[storeCode]) {
      verifyFlagged[storeCode] = true;
      logSync(storeCode, 'verify_required', 'error', null,
        `Meituan 验证中心 challenge — a human must pass the captcha; backing off ~${Math.round(wait / 60000)} min`);
    }
    log(storeCode, `verification challenge — cooling down ~${Math.round(wait / 60000)} min (strike ${s.strikes})`);
  } else {
    if (verifyFlagged[storeCode]) {
      verifyFlagged[storeCode] = false;
      logSync(storeCode, 'verify_cleared', 'ok', null, 'verification cleared — sync resumed');
    }
    s.strikes = 0;
    s.until = 0;
  }
}

// ── Store config ─────────────────────────────────────────────────────────────
// Reads store codes from retail_stores table; maps code → Meituan credentials
// from environment variables.
function getStoreConfigs() {
  const stores = db.prepare(`
    SELECT id, code, name_en FROM retail_stores WHERE is_active = 1 ORDER BY sort_order
  `).all();

  return stores.map(s => ({
    storeId:   s.id,
    storeCode: s.code,
    namEn:     s.name_en,
    meituanUser: process.env[`MEITUAN_${s.code.toUpperCase()}_USER`] || '',
    meituanPass: process.env[`MEITUAN_${s.code.toUpperCase()}_PASS`] || '',
  })).filter(s => s.meituanUser || true); // include all active stores
}

// ── Order polling ─────────────────────────────────────────────────────────────

async function pollOrders(storeConfig) {
  const { storeCode, storeId } = storeConfig;
  let browser;
  try {
    browser = await getBrowser(storeCode);
    const orders = await browser.getPendingOrders();

    // Surface + back off on a risk-control 验证中心 challenge: escalating
    // cool-down so we stop re-poking the verify page every cycle (logged once on
    // transition so it doesn't flood the sync log the admin tab reads).
    noteVerifyResult(storeCode, browser.verificationRequired);

    for (const order of orders) {
      if (!order.meituanOrderNo) continue;

      // Skip already-imported orders
      const existing = db.prepare(
        'SELECT id FROM meituan_order_import WHERE meituan_order_no = ?'
      ).get(order.meituanOrderNo);
      if (existing) continue;

      log(storeCode, `new order ${order.meituanOrderNo}`);

      // 1. (optional) Accept on Meituan — OFF by default (import-only mode).
      //    Meituan prints its own receipt and acceptance is handled on Meituan's
      //    side, so the daemon just mirrors the order into roots for records +
      //    stock. Set MEITUAN_AUTO_ACCEPT=1 to re-enable the auto-accept click.
      let accepted = null;
      if (AUTO_ACCEPT) accepted = await browser.acceptOrder(order.meituanOrderNo);

      // 2. Create in roots-v2 via internal API (this deducts stock → re-syncs)
      const rootsOrderId = await ingestOrder(storeId, storeCode, order);

      // 3. Record import
      db.prepare(`
        INSERT OR IGNORE INTO meituan_order_import
          (meituan_order_no, retail_order_id, store_code, accepted_at, status)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
      `).run(
        order.meituanOrderNo,
        rootsOrderId || null,
        storeCode,
        rootsOrderId ? 'imported' : 'error'
      );

      logSync(storeCode, 'order_import', rootsOrderId ? 'ok' : 'error',
        { meituanOrderNo: order.meituanOrderNo, rootsOrderId, accepted: AUTO_ACCEPT ? !!accepted : 'skipped' });
    }
  } catch (err) {
    log(storeCode, `pollOrders error: ${err.message}`);
    logSync(storeCode, 'order_poll', 'error', null, err.message);
  }
}

// Call internal roots-v2 API to create the order and deduct stock.
// Returns the new retail_order.id or null on failure.
async function ingestOrder(storeId, storeCode, meituanOrder) {
  try {
    const res = await fetch(`${INTERNAL_BASE}/api/internal/meituan/ingest-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': internalSecret() },
      body: JSON.stringify({ storeId, storeCode, order: meituanOrder }),
    });
    if (!res.ok) {
      const text = await res.text();
      log(storeCode, `ingestOrder HTTP ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    return data.orderId || null;
  } catch (err) {
    log(storeCode, `ingestOrder fetch error: ${err.message}`);
    return null;
  }
}

// ── Stock push queue ──────────────────────────────────────────────────────────

async function processStockQueue() {
  // Pull the operator-mapped Meituan title (meituan_product_map.meituan_name)
  // alongside the product's own names. The Meituan listing is titled by the
  // operator, NOT by our name_cn — searching the merchant list by name_cn
  // matches nothing. name_cn/name_en come from store_products (the storefront
  // catalog the product_id actually references), not the stale kitchen table.
  const rows = db.prepare(`
    SELECT q.*, sp.name_cn, sp.name_en, m.meituan_name AS mapped_name
      FROM meituan_sync_queue q
      LEFT JOIN store_products sp ON sp.id = q.product_id
      LEFT JOIN meituan_product_map m
             ON m.product_id = q.product_id AND m.retail_store_id = q.retail_store_id
     WHERE q.status = 'pending' AND q.attempts < 3
     ORDER BY q.created_at
     LIMIT 20
  `).all();

  if (!rows.length) return;

  // Group by store
  const byStore = {};
  for (const row of rows) {
    (byStore[row.store_code] = byStore[row.store_code] || []).push(row);
  }

  for (const [storeCode, items] of Object.entries(byStore)) {
    // Don't push while the store is CLOSED on Meituan (a 3am backend edit is a
    // bot tell, and stock accuracy doesn't matter until it reopens) or while it's
    // in a verification cool-down (a push would re-hit risk-control). Rows stay
    // pending and flush at the next open / after the cool-down.
    if (!isStoreOpen(storeCode)) continue;
    if (inVerifyCooldown(storeCode)) continue;

    let browser;
    try {
      browser = await getBrowser(storeCode);

      for (const item of items) {
        // Mark as processing
        db.prepare(`UPDATE meituan_sync_queue SET status='processing', attempts=attempts+1 WHERE id=?`)
          .run(item.id);

        // Bundle rows target a Meituan listing by name; product rows by the
        // product's own name. updateStock matches the list row by name substring.
        const isBundle = !!item.bundle_id;
        // Products search by the mapped Meituan title (fallback to name_cn if
        // the operator never filled 商品名). Bundles carry their own meituan_name.
        const targetCn = isBundle ? item.meituan_name : (item.mapped_name || item.name_cn);
        const targetEn = isBundle ? null : item.name_en;
        const ok = await browser.updateStock(targetCn, targetEn, item.new_qty);

        db.prepare(`
          UPDATE meituan_sync_queue
             SET status=?, processed_at=CURRENT_TIMESTAMP, last_error=?
           WHERE id=?
        `).run(ok ? 'done' : 'error', ok ? null : 'browser update failed', item.id);

        if (ok) {
          if (isBundle) {
            db.prepare(`
              UPDATE meituan_bundles
                 SET last_pushed_qty=?, last_pushed_at=CURRENT_TIMESTAMP
               WHERE id=?
            `).run(item.new_qty, item.bundle_id);
          } else {
            db.prepare(`
              UPDATE meituan_product_map
                 SET last_pushed_qty=?, last_pushed_at=CURRENT_TIMESTAMP
               WHERE retail_store_id=? AND product_id=?
            `).run(item.new_qty, item.retail_store_id, item.product_id);
          }
        }

        logSync(storeCode, 'stock_push', ok ? 'ok' : 'error',
          { name: isBundle ? item.meituan_name : item.name_en, qty: item.new_qty, bundle: isBundle });
      }
      // If the store got challenged mid-push, start its cool-down so the next
      // cycle skips it instead of re-hitting the verify page.
      if (browser && browser.verificationRequired) noteVerifyResult(storeCode, true);
    } catch (err) {
      log(storeCode, `processStockQueue error: ${err.message}`);
      // Mark all items for this store as error
      for (const item of items) {
        if (item.status === 'processing') {
          db.prepare(`UPDATE meituan_sync_queue SET status='error', last_error=? WHERE id=?`)
            .run(err.message.slice(0, 200), item.id);
        }
      }
    }
  }
}

// ── Listing scrape jobs ────────────────────────────────────────────────────────
// The admin Meituan tab enqueues a job to read the live product titles from a
// store's Meituan backend; we own the logged-in browser, so we run it and fill
// meituan_listings. One store at a time (each navigates the shared browser).

async function processListingJobs() {
  const jobs = db.prepare(`
    SELECT * FROM meituan_listing_jobs
     WHERE status = 'pending'
     ORDER BY created_at
     LIMIT 5
  `).all();

  if (!jobs.length) return;

  for (const job of jobs) {
    db.prepare(`UPDATE meituan_listing_jobs SET status='processing' WHERE id=?`).run(job.id);
    try {
      const browser = await getBrowser(job.store_code);
      const names = await browser.listProducts();
      if (!names) throw new Error('scrape returned null (not logged in or no content iframe)');

      const tx = db.transaction(() => {
        db.prepare(`DELETE FROM meituan_listings WHERE store_code=?`).run(job.store_code);
        const ins = db.prepare(
          `INSERT OR IGNORE INTO meituan_listings (store_code, listing_name) VALUES (?, ?)`
        );
        for (const n of names) ins.run(job.store_code, n);
      });
      tx();

      db.prepare(`
        UPDATE meituan_listing_jobs
           SET status='done', result_count=?, error=NULL, completed_at=CURRENT_TIMESTAMP
         WHERE id=?
      `).run(names.length, job.id);
      logSync(job.store_code, 'listing_scrape', 'ok', { count: names.length });
      log(job.store_code, `listing scrape done: ${names.length} listing(s)`);
    } catch (err) {
      db.prepare(`
        UPDATE meituan_listing_jobs
           SET status='error', error=?, completed_at=CURRENT_TIMESTAMP
         WHERE id=?
      `).run(err.message.slice(0, 200), job.id);
      logSync(job.store_code, 'listing_scrape', 'error', null, err.message);
      log(job.store_code, `processListingJobs error: ${err.message}`);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function internalSecret() {
  return process.env.MEITUAN_INTERNAL_SECRET || 'meituan-daemon-internal';
}

function log(storeCode, msg) {
  console.log(`[meituan-daemon:${storeCode}] ${new Date().toISOString()} ${msg}`);
}

function logSync(storeCode, eventType, status, detail, errorMsg) {
  try {
    db.prepare(`
      INSERT INTO meituan_sync_log (store_code, event_type, status, detail, error_msg)
      VALUES (?, ?, ?, ?, ?)
    `).run(storeCode, eventType, status, detail ? JSON.stringify(detail) : null, errorMsg || null);
  } catch {}
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('[meituan-daemon] starting');

  const stores = getStoreConfigs();
  if (!stores.length) {
    console.error('[meituan-daemon] no active stores found — exiting');
    process.exit(1);
  }
  console.log(`[meituan-daemon] stores: ${stores.map(s => s.storeCode).join(', ')}`);

  let lastOrderPoll = 0;
  let orderPollGap  = jitter(ORDER_POLL_MS, 0.4);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Date.now();

    // Poll for new orders on a jittered ~5 min cadence. Stagger stores so the two
    // browsers never hit Meituan at the same instant (lockstep concurrent polls
    // are themselves a bot tell, and serialising keeps RAM to one busy browser).
    if (now - lastOrderPoll >= orderPollGap) {
      lastOrderPoll = now;
      orderPollGap  = jitter(ORDER_POLL_MS, 0.4);
      // Only poll stores currently open on Meituan, and skip any in a verify
      // cool-down — idling overnight + after a challenge drops the round-the-
      // clock cadence that reads as a bot.
      const openStores = stores.filter(s => {
        const open = isStoreOpen(s.storeCode);
        if (!open && !closedFlagged[s.storeCode]) {
          closedFlagged[s.storeCode] = true;
          log(s.storeCode, 'store closed — pausing order polls');
          logSync(s.storeCode, 'poll_paused', 'ok', null, 'outside opening hours');
        } else if (open && closedFlagged[s.storeCode]) {
          closedFlagged[s.storeCode] = false;
          log(s.storeCode, 'store reopened — resuming order polls');
          logSync(s.storeCode, 'poll_resumed', 'ok', null, 'within opening hours');
        }
        return open;
      }).filter(s => !inVerifyCooldown(s.storeCode));
      for (let i = 0; i < openStores.length; i++) {
        await pollOrders(openStores[i]);
        if (i < openStores.length - 1) await sleep(jitter(8000, 0.5));
      }
    }

    // Always process stock queue
    await processStockQueue();

    // Handle any on-demand listing-scrape requests from the admin tab
    await processListingJobs();

    await sleep(jitter(QUEUE_CHECK_MS));
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

process.on('SIGINT',  async () => { await closeAll(); process.exit(0); });
process.on('SIGTERM', async () => { await closeAll(); process.exit(0); });

main().catch(err => {
  console.error('[meituan-daemon] fatal:', err);
  process.exit(1);
});
