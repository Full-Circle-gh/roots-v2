// 闪购 (Meituan Instashopping) sync daemon — separate pm2 process from meituan-sync.
//
// yuexiu was force-migrated by licensing from 外卖 (e.waimai) to 闪购
// (shangoue.meituan.com), whose data APIs reject Playwright's automation
// fingerprint with 403. This daemon instead ATTACHES over CDP to a genuine Chrome
// (launched + kept alive by scripts/shangou-chrome.js, headful under Xvfb, routed
// through the GZ proxy) and drives the backend by calling its APIs from inside the
// logged-in page, where H5guard signs them. See lib/shangou-browser.js.
//
// Responsibilities (only for stores in SHANGOU_STORES, default 'yuexiu'):
//   • Push stock changes from roots → 闪购 (reads the shared meituan_sync_queue)
//   • Poll 闪购 for new orders → import into roots (deducts stock)
//
// The 外卖 meituan-daemon must NOT also process these stores — set
// MEITUAN_SKIP_STORES=yuexiu there so the two daemons never race on the queue.
//
// Start: pm2 start scripts/shangou-daemon.js --name shangou-sync
// Logs:  pm2 logs shangou-sync

'use strict';

const path = require('path');
const fs   = require('fs');
const { execFile } = require('child_process');
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
const { getShangouBrowser, closeAllShangou, shangouCdpUrl } = require('../lib/shangou-browser');
const { sendOpsAlert } = require('../lib/ops-alert');
// Hold off on channel calls while the holder Chrome is freshly launched — a cold
// browser that gets hit seconds after launch is what earns the 风控 403.
const { coldMsRemaining, isColdStartChallenge } = require('../lib/browser-warmup');
// Ops-alert latches that survive a restart, so a bounce mid-incident can't swallow
// the recovery message the group is waiting on.
const { latchStore } = require('../lib/alert-latch');
const { sweepStockDrift } = require('../lib/meituan-drift-sweep');

const SHANGOU_STORES = (process.env.SHANGOU_STORES || 'yuexiu')
  .split(',').map(s => s.trim()).filter(Boolean);

const ORDER_POLL_MS  = 120_000;  // poll new orders ~2 min (jittered)
// Trailing re-poll: 闪购 flips an order to 已完成 late (customer confirm / auto-
// confirm, often the next day, outside the today window), so an order last seen as
// 配送中 freezes at "Dispatched" forever. On a slow cadence re-read a widened window
// and advance any still-non-terminal mirrored order.
const ORDER_SWEEP_MS  = 1_800_000;                                   // 30 min
const ORDER_SWEEP_DAYS = Number(process.env.SHANGOU_SWEEP_DAYS) || 3; // window back
const QUEUE_CHECK_MS = 10_000;   // process stock-push queue every ~10s
// Stock-drift backstop — same reasoning as the 外卖 daemon, same shared queue: a
// terminally-failed push leaves that listing frozen with nothing left to retry it.
// See lib/meituan-drift-sweep for the cool-down and cap that keep it cheap.
const DRIFT_SWEEP_MS = 1_800_000; // 30 min
const MAP_REFRESH_MS = 60 * 60_000; // re-map by 货号 hourly so new products self-activate
const INTERNAL_PORT  = process.env.PORT || 3000;
const INTERNAL_BASE  = `http://127.0.0.1:${INTERNAL_PORT}`;
const OPEN_GRACE_MIN = 15;

// Per-store opening hours (Asia/Shanghai); outside these we don't poll/push.
const STORE_HOURS = {
  yuexiu: { open: 11 * 60 + 0, close: 20 * 60 + 15 },
};

const FORCE_OPEN_UNTIL = Number(process.env.SHANGOU_FORCE_OPEN_MINUTES) > 0
  ? Date.now() + Number(process.env.SHANGOU_FORCE_OPEN_MINUTES) * 60_000 : 0;

function shanghaiMinutes(now = new Date()) {
  const s = new Date(now.getTime() + 8 * 3600 * 1000);
  return s.getUTCHours() * 60 + s.getUTCMinutes();
}
function isStoreOpen(storeCode, now = new Date()) {
  if (FORCE_OPEN_UNTIL && now.getTime() < FORCE_OPEN_UNTIL) return true;
  const h = STORE_HOURS[storeCode];
  if (!h) return true;
  const m = shanghaiMinutes(now);
  return m >= (h.open - OPEN_GRACE_MIN) && m < (h.close + OPEN_GRACE_MIN);
}
function jitter(baseMs, frac = 0.3) {
  const spread = baseMs * frac;
  return Math.round(baseMs - spread + Math.random() * spread * 2);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Proxy health gate (mirrors meituan-daemon) ────────────────────────────────
// 闪购 Chrome reaches Meituan through the same GZ proxy (shangou-chrome's auth
// forwarder → SHANGOU_PROXY_UPSTREAM, default MEITUAN_PROXY_URL). If that proxy
// TCP-accepts but can't complete upstream requests, every page fetch hangs/fails
// and the daemon MISREADS it as "needs login" — burning queue attempts into
// terminal errors and drifting stock. Gating the loop on a cheap curl probe turns
// a proxy outage into a clean, logged pause instead. Direct mode (no proxy) is
// always "healthy", so this is a no-op when 闪购 runs on the box's direct IP.
const SHANGOU_PROXY = process.env.SHANGOU_PROXY_UPSTREAM != null
  ? process.env.SHANGOU_PROXY_UPSTREAM
  : (process.env.MEITUAN_PROXY_URL || '');
function proxyHealthy(timeoutSec = 8) {
  if (!SHANGOU_PROXY) return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile('curl',
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-x', SHANGOU_PROXY,
       '--max-time', String(timeoutSec), 'https://shangoue.meituan.com/'],
      { timeout: (timeoutSec + 4) * 1000 },
      (_err, stdout) => {
        const code = parseInt(String(stdout).trim(), 10) || 0;
        resolve(code >= 200 && code < 600);
      });
  });
}
function maskProxy(u) { return String(u || '').replace(/:[^:@/]+@/, ':****@'); }
// Alert latches live on disk (lib/alert-latch) so a daemon restart mid-incident
// still knows it owes the ops group a recovery message.
const alerts = latchStore('shangou');
// Debounce: the residential SOCKS5 exit flaps for seconds at a time. Pause sync on
// the first missed probe (safe), but only PAGE ops after a sustained outage so brief
// blips don't spam the alerts group. ~grace × QUEUE_CHECK_MS.
let proxyFailStreak = 0;
const PROXY_DOWN_GRACE = Number(process.env.MEITUAN_PROXY_DOWN_GRACE || 3);

// ── 验证中心 risk-control backoff (mirrors meituan-daemon) ─────────────────────
// 闪购 rarely throws a verify challenge, but when a 403/验证中心 hits, re-poking the
// session every 10s only deepens the flag / poisons the IP. Back off on an
// escalating cool-down per consecutive strike; clear it once a call comes back
// clean. A human still has to pass any captcha — this just stops us hammering it.
const VERIFY_COOLDOWN_BASE_MS = 30 * 60_000;      // first strike: 30 min
const VERIFY_COOLDOWN_MAX_MS  = 4 * 60 * 60_000;  // cap: 4 h
const verifyState   = {}; // storeCode -> { until: epochMs, strikes: n }
const verifyFlagged = alerts; // keyed 'verify:<storeCode>' (log once per transition)

function inVerifyCooldown(storeCode, now = Date.now()) {
  const s = verifyState[storeCode];
  return !!(s && s.until && now < s.until);
}

// Record the outcome of a call that could have been challenged. Challenge:
// escalate the cool-down and log once on transition. Clean: clear it and log
// recovery once.
function noteVerifyResult(storeCode, challenged) {
  const s = verifyState[storeCode] || (verifyState[storeCode] = { until: 0, strikes: 0 });
  if (challenged) {
    s.strikes = Math.min(s.strikes + 1, 8);
    const wait = Math.min(VERIFY_COOLDOWN_BASE_MS * 2 ** (s.strikes - 1), VERIFY_COOLDOWN_MAX_MS);
    s.until = Date.now() + wait;
    if (!verifyFlagged['verify:' + storeCode]) {
      verifyFlagged['verify:' + storeCode] = true;
      const mins = Math.round(wait / 60000);
      // A challenge minutes after the holder Chrome relaunched is the cold browser,
      // not an expired session: the profile is still logged in and the cool-down
      // clears it on its own. Say so, instead of sending ops to the box to re-login.
      const cold = isColdStartChallenge(shangouCdpUrl());
      logSync(storeCode, 'verify_required', 'error', null,
        cold
          ? `闪购 验证中心 challenge right after a browser relaunch — session intact; backing off ~${mins} min`
          : `闪购 验证中心 challenge — a human must pass the captcha; backing off ~${mins} min`);
      sendOpsAlert(cold
        ? `🟠 美团闪购 ${storeCode} 风控/验证（浏览器刚重启，登录未掉），库存同步暂停约 ${mins} 分钟后自动恢复，无需操作\nMeituan 闪购 ${storeCode} risk-control right after a browser restart — NOT logged out, stock sync auto-resumes in ~${mins} min, no action needed`
        : `🔴 美团闪购 ${storeCode} 掉线：风控/验证，库存同步已暂停，需要在盒子上重新登录\nMeituan 闪购 ${storeCode} disconnected (risk-control 403) — stock sync paused, needs re-login`);
    }
    log(storeCode, `verification challenge — cooling down ~${Math.round(wait / 60000)} min (strike ${s.strikes})`);
  } else {
    if (verifyFlagged['verify:' + storeCode]) {
      verifyFlagged['verify:' + storeCode] = false;
      logSync(storeCode, 'verify_cleared', 'ok', null, 'verification cleared — sync resumed');
      sendOpsAlert(`✅ 美团闪购 ${storeCode} 已恢复，库存同步继续\nMeituan 闪购 ${storeCode} recovered — stock sync resumed`);
    }
    s.strikes = 0;
    s.until = 0;
  }
}

function log(storeCode, msg) {
  console.log(`[shangou-daemon:${storeCode}] ${new Date().toISOString()} ${msg}`);
}
function logSync(storeCode, eventType, status, detail, errorMsg) {
  try {
    db.prepare(`INSERT INTO meituan_sync_log (store_code, event_type, status, detail, error_msg)
                VALUES (?, ?, ?, ?, ?)`)
      .run(storeCode, eventType, status, detail ? JSON.stringify(detail) : null, errorMsg || null);
  } catch {}
}
function internalSecret() { return process.env.MEITUAN_INTERNAL_SECRET || 'meituan-daemon-internal'; }

// Map store_code → retail_stores.id (for ingest + queue scoping).
function storeIdFor(storeCode) {
  const row = db.prepare(`SELECT id FROM retail_stores WHERE code = ?`).get(storeCode);
  return row ? row.id : null;
}

// Latch so "needs login" / "chrome down" is logged once per transition.
const downFlagged = alerts; // keyed 'login:<storeCode>'
const rawCaptured = {}; // store_code → true once we've logged a raw order sample

// ── Stock push ────────────────────────────────────────────────────────────────

async function processStockQueue() {
  const placeholders = SHANGOU_STORES.map(() => '?').join(',');
  // The queue's product_id is a store_products.id (the canonical retail catalogue
  // the stock/order paths key off) — NOT the legacy `products` kitchen table, whose
  // ids diverge for some SKUs (e.g. Hummus = store_products 360 but products 17).
  // Joining `products` here pulled the WRONG name/sku for divergent-id products and
  // could resolve the push to the wrong 闪购 listing by 货号. The roots SKU is
  // COALESCE(mm.meituan_sku, p.sku) — that 货号 maps to the 闪购 sourceFoodCode.
  const rows = db.prepare(`
    SELECT q.*, p.name_cn, p.name_en,
           COALESCE(mm.meituan_sku, p.sku) AS sku,
           mm.meituan_name AS map_meituan_name
      FROM meituan_sync_queue q
      LEFT JOIN store_products p ON p.id = q.product_id
      LEFT JOIN meituan_product_map mm
             ON mm.product_id = q.product_id AND mm.retail_store_id = q.retail_store_id
     WHERE q.status = 'pending' AND q.attempts < 3 AND q.store_code IN (${placeholders})
     ORDER BY q.created_at
     LIMIT 40
  `).all(...SHANGOU_STORES);
  if (!rows.length) return;

  const byStore = {};
  for (const row of rows) (byStore[row.store_code] = byStore[row.store_code] || []).push(row);

  for (const [storeCode, items] of Object.entries(byStore)) {
    if (!isStoreOpen(storeCode)) continue;
    // In a verify cool-down: leave rows pending and flush after it passes — a push
    // now would only re-hit risk-control.
    if (inVerifyCooldown(storeCode)) continue;

    // Collapse to the latest qty per product/bundle.
    const latest = new Map(); const superseded = [];
    for (const row of items) {
      const key = row.bundle_id ? `b:${row.bundle_id}` : `p:${row.product_id}`;
      if (latest.get(key)) superseded.push(latest.get(key));
      latest.set(key, row);
    }
    for (const row of superseded) {
      db.prepare(`UPDATE meituan_sync_queue SET status='done', processed_at=CURRENT_TIMESTAMP, last_error='superseded' WHERE id=?`).run(row.id);
    }
    const pushRows = Array.from(latest.values());

    let browser;
    try {
      browser = await getShangouBrowser(storeCode);
      if (!(await browser.isLoggedIn())) {
        // Distinguish a risk-control challenge (403/验证中心) from a real logout: a
        // challenge gets the escalating cool-down, not a "go log in" alert (and we
        // stop re-hitting it every 10s).
        if (browser.verificationRequired) { noteVerifyResult(storeCode, true); continue; }
        if (!downFlagged['login:' + storeCode]) {
          downFlagged['login:' + storeCode] = true;
          logSync(storeCode, 'needs_login', 'error', null, '闪购 Chrome not logged in — a human must log in on the box');
          log(storeCode, 'not logged in — skipping stock push');
          sendOpsAlert(`🔴 美团闪购 ${storeCode} 未登录，库存同步已停止，需要重新登录\nMeituan 闪购 ${storeCode} not logged in — stock sync stopped, needs re-login`);
        }
        continue;
      }
      const wasDown = downFlagged['login:' + storeCode];
      downFlagged['login:' + storeCode] = false;
      if (wasDown) sendOpsAlert(`✅ 美团闪购 ${storeCode} 重新登录成功，库存同步继续\nMeituan 闪购 ${storeCode} logged back in — stock sync resumed`);
      noteVerifyResult(storeCode, false); // clean call — clear any prior cool-down

      for (const row of pushRows) {
        db.prepare(`UPDATE meituan_sync_queue SET status='processing', attempts=attempts+1 WHERE id=?`).run(row.id);
      }

      const batchItems = pushRows.map(row => {
        const isBundle = !!row.bundle_id;
        return {
          row, isBundle,
          targetCn: isBundle ? row.meituan_name : (row.map_meituan_name || row.name_cn),
          targetEn: isBundle ? null : row.name_en,
          sku:      isBundle ? null : row.sku,
          newQty:   row.new_qty,
        };
      });

      const results = await browser.batchUpdateStock(batchItems);

      // If the store got challenged mid-batch, start its cool-down now so the rest
      // of the loop and the next cycle back off.
      const challenged = browser.verificationRequired;
      if (challenged) noteVerifyResult(storeCode, true);

      for (const res of results) {
        const { row, isBundle, newQty, ok, transient } = res;
        if (ok) {
          db.prepare(`UPDATE meituan_sync_queue SET status='done', processed_at=CURRENT_TIMESTAMP, last_error=NULL WHERE id=?`).run(row.id);
          if (!isBundle) {
            db.prepare(`UPDATE meituan_product_map SET last_pushed_qty=?, last_pushed_at=CURRENT_TIMESTAMP WHERE retail_store_id=? AND product_id=?`)
              .run(newQty, row.retail_store_id, row.product_id);
          } else {
            // Record the bundle's landed qty too (the 外卖 daemon always did; this
            // side didn't). Without it a bundle looks permanently unsynced, which
            // would have the drift sweep re-push every combo on every pass.
            db.prepare(`UPDATE meituan_bundles SET last_pushed_qty=?, last_pushed_at=CURRENT_TIMESTAMP WHERE id=?`)
              .run(newQty, row.bundle_id);
          }
          logSync(storeCode, 'stock_push', 'ok',
            { name_en: isBundle ? row.meituan_name : row.name_en,
              name_cn: isBundle ? row.meituan_name : row.name_cn,
              sku: isBundle ? null : row.sku, qty: newQty, skuId: res.skuId, bundle: isBundle });
        } else if (challenged) {
          // Deferred by risk-control, not a real match failure — requeue and refund
          // the attempt so it retries once the cool-down passes (no burned attempts,
          // no false terminal error that would drift the product's stock).
          db.prepare(`UPDATE meituan_sync_queue SET status='pending', attempts=attempts-1 WHERE id=?`).run(row.id);
        } else if (transient && (row.attempts || 0) + 1 < 3) {
          // Transient failure (network/page hiccup or unresolved match from a partial
          // catalogue read) — keep pending so it retries; attempts<3 still caps it.
          // Don't refund the attempt (unlike a challenge, this WAS a real try).
          db.prepare(`UPDATE meituan_sync_queue SET status='pending', last_error='transient push failure — will retry' WHERE id=?`).run(row.id);
        } else {
          // Genuine 闪购 API rejection, or transient retries exhausted → terminal.
          db.prepare(`UPDATE meituan_sync_queue SET status='error', processed_at=CURRENT_TIMESTAMP, last_error=? WHERE id=?`)
            .run(transient ? 'no 闪购 match / transient — retries exhausted' : 'no 闪购 match or update failed', row.id);
          logSync(storeCode, 'stock_push', 'error',
            { name_en: isBundle ? row.meituan_name : row.name_en,
              name_cn: isBundle ? row.meituan_name : row.name_cn,
              sku: isBundle ? null : row.sku, qty: newQty, bundle: isBundle },
            transient ? 'no 闪购 match after retries · 闪购多次重试仍未匹配' : 'no 闪购 sku match or update failed · 闪购未匹配或更新失败');
        }
      }
    } catch (err) {
      log(storeCode, `processStockQueue error: ${err.message}`);
      // The BATCH died (Chrome/page crash, navigation timeout, proxy blip) — that
      // says nothing about any single product, and most of these rows never reached
      // 闪购 at all. Burying them as terminal 'error' is what froze the 外卖 side's
      // stock for weeks, so requeue them as pending instead. The attempt is kept,
      // not refunded, so a Chrome that dies on every batch can't retry forever at
      // 10s intervals; attempts<3 bounds it and the 30-minute drift sweep is what
      // recovers the row if all three tries get eaten.
      for (const row of pushRows) {
        db.prepare(`UPDATE meituan_sync_queue
                       SET status='pending', last_error=?
                     WHERE id=? AND status='processing'`)
          .run(`batch failed (${err.message.slice(0, 150)}) — will retry`, row.id);
      }
    }
  }
}

// ── Startup recovery: orphaned 'processing' rows ──────────────────────────────
// A queue row is flipped to status='processing' (attempts+1) just BEFORE the push.
// If the daemon is killed/restarted (pm2 restart, crash) mid-batch, the try/catch
// only resets rows the CURRENT run owns — rows from the dead run are stranded in
// 'processing' forever, and the retry query (status='pending' AND attempts<3) never
// picks them up, so that product's 闪购 stock silently drifts. (On 2026-06-27 the
// 外卖 side showed 69 such orphans on tianhe, the oldest 5 days old.)
//
// On startup, sweep THIS daemon's own stores (SHANGOU_STORES) for stale rows and
// make them retryable again — safely, mirroring the recovery in
// feature_meituan_push_error_terminal_no_retry:
//   • Scoped to OUR stores only, so we never touch a row the 外卖 daemon owns on the
//     shared meituan_sync_queue.
//   • created_at older than ~5 min, so a near-simultaneous pm2 reload can't race us
//     onto a row a still-living run owns.
//   • A NEWER queue row for the same product/bundle ⇒ retire this orphan 'done'
//     (superseded) instead of replaying a stale value onto live 闪购 stock.
//   • Otherwise re-enqueue at the product's CURRENT physical_qty (bundle: component
//     floor), NOT the stale new_qty, and refund the attempt the mark burned.
function recoverOrphanedProcessing(storeCodes) {
  if (!storeCodes || !storeCodes.length) return;
  const ph = storeCodes.map(() => '?').join(',');
  let stale;
  try {
    stale = db.prepare(`
      SELECT * FROM meituan_sync_queue
       WHERE status = 'processing'
         AND store_code IN (${ph})
         AND created_at < datetime('now', '-5 minutes')
       ORDER BY created_at, id
    `).all(...storeCodes);
  } catch (e) {
    console.error('[shangou-daemon] orphan recovery query failed:', e.message);
    return;
  }
  if (!stale.length) return;

  const bundles = require('../lib/meituan-bundles');
  const stats = {}; // storeCode -> { requeued, retired }
  for (const row of stale) {
    const st = stats[row.store_code] || (stats[row.store_code] = { requeued: 0, retired: 0 });
    try {
      const isBundle = !!row.bundle_id;
      const newer = isBundle
        ? db.prepare(`SELECT 1 FROM meituan_sync_queue
                       WHERE store_code=? AND bundle_id=? AND id<>?
                         AND (created_at>? OR (created_at=? AND id>?)) LIMIT 1`)
            .get(row.store_code, row.bundle_id, row.id, row.created_at, row.created_at, row.id)
        : db.prepare(`SELECT 1 FROM meituan_sync_queue
                       WHERE store_code=? AND product_id=? AND bundle_id IS NULL AND id<>?
                         AND (created_at>? OR (created_at=? AND id>?)) LIMIT 1`)
            .get(row.store_code, row.product_id, row.id, row.created_at, row.created_at, row.id);
      if (newer) {
        db.prepare(`UPDATE meituan_sync_queue SET status='done', processed_at=CURRENT_TIMESTAMP, last_error='superseded — stale processing recovered at startup' WHERE id=?`)
          .run(row.id);
        st.retired++;
        continue;
      }
      let qty;
      if (isBundle) {
        const bundle = db.prepare('SELECT * FROM meituan_bundles WHERE id=?').get(row.bundle_id);
        if (!bundle) {
          db.prepare(`UPDATE meituan_sync_queue SET status='done', processed_at=CURRENT_TIMESTAMP, last_error='bundle removed — stale processing retired at startup' WHERE id=?`)
            .run(row.id);
          st.retired++;
          continue;
        }
        qty = bundles.bundleStock(db, bundle);
      } else {
        const r = db.prepare('SELECT COALESCE(physical_qty,0) AS q FROM retail_store_stock WHERE store_id=? AND product_id=?')
          .get(row.retail_store_id, row.product_id);
        qty = r ? r.q : 0;
      }
      db.prepare(`UPDATE meituan_sync_queue
                     SET status='pending', new_qty=?,
                         attempts=MAX(attempts-1, 0),
                         last_error='recovered stale processing at startup — re-enqueued at current stock'
                   WHERE id=?`).run(qty, row.id);
      st.requeued++;
    } catch (e) {
      console.error(`[shangou-daemon] orphan recovery row ${row.id} failed:`, e.message);
    }
  }
  for (const [sc, s] of Object.entries(stats)) {
    if (!s.requeued && !s.retired) continue;
    console.log(`[shangou-daemon:${sc}] ${new Date().toISOString()} startup orphan recovery: ${s.requeued} re-enqueued, ${s.retired} retired`);
    logSync(sc, 'orphan_recovery', 'ok', s,
      `recovered ${s.requeued + s.retired} stale 'processing' row(s) at startup`);
  }
}

// ── Order import ────────────────────────────────────────────────────────────────

async function pollOrders(storeCode) {
  const storeId = storeIdFor(storeCode);
  if (!storeId) return;
  if (inVerifyCooldown(storeCode)) return; // backing off a verify challenge
  let browser;
  try {
    browser = await getShangouBrowser(storeCode);
    if (!(await browser.isLoggedIn())) {
      if (browser.verificationRequired) noteVerifyResult(storeCode, true);
      return; // logged once in stock path
    }
    const orders = await browser.getPendingOrders();
    // Surface + back off on a risk-control challenge during the poll.
    noteVerifyResult(storeCode, browser.verificationRequired);
    if (browser.verificationRequired) return;
    for (const order of orders) {
      // First real order: log the raw payload verbatim so we can finalise the
      // item/field mapping (the store opened empty, so the shape is unconfirmed).
      if (!rawCaptured[storeCode]) {
        rawCaptured[storeCode] = true;
        logSync(storeCode, 'order_raw', 'ok', { sample: order.raw }, 'first 闪购 order payload captured for parser finalisation');
        log(storeCode, `RAW order payload captured: ${JSON.stringify(order.raw).slice(0, 500)}`);
      }
      if (!order.meituanOrderNo || !order.items.length) {
        logSync(storeCode, 'order_unparsed', 'error',
          { no: order.meituanOrderNo, items: order.items.length },
          'order could not be parsed — see order_raw; not imported');
        continue;
      }
      const existing = db.prepare('SELECT id FROM meituan_order_import WHERE meituan_order_no = ?').get(order.meituanOrderNo);
      if (existing) {
        // Already mirrored — just keep its platform status label current
        // (拣货中 → 配送中 → 已完成) so the Orders list tracks the real state.
        await refreshOrderStatus(storeCode, order);
        continue;
      }

      log(storeCode, `new order ${order.meituanOrderNo}`);
      const rootsOrderId = await ingestOrder(storeId, storeCode, order);
      db.prepare(`INSERT OR IGNORE INTO meituan_order_import
                    (meituan_order_no, retail_order_id, store_code, accepted_at, status)
                  VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)`)
        .run(order.meituanOrderNo, rootsOrderId || null, storeCode, rootsOrderId ? 'imported' : 'error');
      logSync(storeCode, 'order_import', rootsOrderId ? 'ok' : 'error',
        { meituanOrderNo: order.meituanOrderNo, rootsOrderId });
    }
  } catch (err) {
    log(storeCode, `pollOrders error: ${err.message}`);
    logSync(storeCode, 'order_poll', 'error', null, err.message);
  }
}

async function ingestOrder(storeId, storeCode, order) {
  try {
    const res = await fetch(`${INTERNAL_BASE}/api/internal/meituan/ingest-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': internalSecret() },
      body: JSON.stringify({ storeId, storeCode, order }),
    });
    if (!res.ok) { log(storeCode, `ingestOrder HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`); return null; }
    const data = await res.json();
    return data.orderId || null;
  } catch (err) { log(storeCode, `ingestOrder fetch error: ${err.message}`); return null; }
}

// Refresh an already-mirrored order's Meituan status label (no-op server-side
// when unchanged). Best-effort: a failed refresh must never break the poll.
async function refreshOrderStatus(storeCode, order) {
  if (!order.statusDesc) return;
  try {
    const res = await fetch(`${INTERNAL_BASE}/api/internal/meituan/update-order-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': internalSecret() },
      body: JSON.stringify({ meituanOrderNo: order.meituanOrderNo, statusDesc: order.statusDesc, eta: order.eta }),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.changed) log(storeCode, `order ${order.meituanOrderNo} status → ${order.statusDesc}`);
    }
  } catch (err) { log(storeCode, `refreshOrderStatus error: ${err.message}`); }
}

// Time-based delivered flip: mark any mirrored order delivered once it is an hour
// past its ETA (闪购's own 已完成 confirm can lag delivery by a day+). Pure server-side
// DB rule — no browser — covering all stores in one call. Best-effort.
async function autoDeliverPastEta() {
  try {
    const res = await fetch(`${INTERNAL_BASE}/api/internal/meituan/auto-deliver-past-eta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': internalSecret() },
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.delivered) log('all', `auto-delivered ${data.delivered} order(s) past ETA+1h`);
    }
  } catch (err) { log('all', `autoDeliverPastEta error: ${err.message}`); }
}

// Trailing sweep: advance orders stuck at a non-terminal status because 闪购 marked
// them 已完成 after they left the today window. Only touches the browser when at
// least one such order exists (else no extra 闪购 traffic), reads a widened window
// once, and refreshes their status labels (the update endpoint no-ops when
// unchanged). Best-effort — never breaks the loop.
async function sweepStaleOrders(storeCode) {
  if (inVerifyCooldown(storeCode)) return;
  const stale = db.prepare(`
    SELECT i.meituan_order_no
      FROM meituan_order_import i
      JOIN retail_orders o ON o.id = i.retail_order_id
     WHERE i.store_code = ?
       AND o.status IN ('paid','preparing','dispatched')
       AND o.placed_at >= datetime('now', ?)
  `).all(storeCode, `-${ORDER_SWEEP_DAYS} days`);
  if (!stale.length) return;

  let browser;
  try {
    browser = await getShangouBrowser(storeCode);
    if (!browser || !(await browser.isLoggedIn())) {
      if (browser && browser.verificationRequired) noteVerifyResult(storeCode, true);
      return;
    }
    const orders = await browser.getPendingOrders({ sinceDays: ORDER_SWEEP_DAYS, pageSize: 100 });
    noteVerifyResult(storeCode, browser.verificationRequired);
    if (!orders.length) return;

    const want = new Set(stale.map(s => s.meituan_order_no));
    let advanced = 0;
    for (const order of orders) {
      if (!want.has(order.meituanOrderNo)) continue; // only the stale ones
      await refreshOrderStatus(storeCode, order);
      advanced++;
    }
    log(storeCode, `stale-order sweep: ${stale.length} pending, refreshed ${advanced}`);
  } catch (err) {
    log(storeCode, `sweepStaleOrders error: ${err.message}`);
    logSync(storeCode, 'order_sweep', 'error', null, err.message);
  }
}

// ── Auto-map (闪购 is mapped by 货号) ────────────────────────────────────────────
// 闪购 needs no per-product mapping UI: a roots product is "on 闪购" iff a 闪购 sku
// carries the same 货号 (sourceFoodCode === store_products.sku). This reads the live
// catalogue and upserts meituan_product_map for every match (sync_enabled=1) so the
// product's stock changes start enqueueing — replacing the old manual seed script.
// Also refreshes meituan_listings so the admin tab shows the 闪购 listing names.
// Additive only: never deletes/disables (a partial catalogue read shouldn't silently
// switch a product off). Returns { mapped, listings, unmatched }.
async function autoMapStore(storeCode) {
  const storeId = storeIdFor(storeCode);
  if (!storeId) return null;
  const browser = await getShangouBrowser(storeCode);
  if (!(await browser.isLoggedIn())) {
    if (browser.verificationRequired) noteVerifyResult(storeCode, true);
    return null;
  }
  const prods = await browser.getProducts(); // [{ code(货号), spuName, ... }]

  const findProd = db.prepare(
    'SELECT id FROM store_products WHERE sku = ? ORDER BY is_active DESC, id ASC LIMIT 1'
  );
  const upsertMap = db.prepare(`
    INSERT INTO meituan_product_map (retail_store_id, product_id, store_code, meituan_name, sync_enabled)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(retail_store_id, product_id) DO UPDATE SET
      meituan_name = excluded.meituan_name, sync_enabled = 1, updated_at = CURRENT_TIMESTAMP
  `);
  const insListing = db.prepare(
    'INSERT OR IGNORE INTO meituan_listings (store_code, listing_name) VALUES (?, ?)'
  );

  let mapped = 0; const seen = new Set(); const unmatched = []; const names = new Set();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM meituan_listings WHERE store_code=?').run(storeCode);
    for (const p of prods) {
      if (p.spuName) names.add(p.spuName);
      if (!p.code || p.code === '-') continue;
      const rp = findProd.get(p.code);
      if (!rp) { unmatched.push(`${p.spuName} (货号 ${p.code})`); continue; }
      if (!seen.has(rp.id)) { seen.add(rp.id); upsertMap.run(storeId, rp.id, storeCode, p.spuName); mapped++; }
    }
    for (const n of names) insListing.run(storeCode, n);
  });
  tx();

  log(storeCode, `auto-map: ${mapped} product(s) mapped by 货号, ${names.size} listing(s)`
    + (unmatched.length ? `, ${unmatched.length} 闪购 sku(s) not in roots` : ''));
  logSync(storeCode, 'auto_map', 'ok', { mapped, listings: names.size, unmatched: unmatched.slice(0, 20) });
  return { mapped, listings: names.size, unmatched };
}

// On-demand "Fetch from Meituan" jobs from the admin tab (meituan_listing_jobs).
// Only this daemon's 闪购 stores — the 外卖 daemon skips them (MEITUAN_SKIP_STORES).
async function processListingJobs() {
  const ph = SHANGOU_STORES.map(() => '?').join(',');
  const jobs = db.prepare(
    `SELECT * FROM meituan_listing_jobs WHERE status='pending' AND store_code IN (${ph}) ORDER BY created_at LIMIT 5`
  ).all(...SHANGOU_STORES);
  for (const job of jobs) {
    if (!isStoreOpen(job.store_code) || inVerifyCooldown(job.store_code)) continue;
    db.prepare(`UPDATE meituan_listing_jobs SET status='processing' WHERE id=?`).run(job.id);
    try {
      const r = await autoMapStore(job.store_code);
      if (!r) throw new Error('闪购 Chrome not logged in / catalogue unavailable');
      db.prepare(`UPDATE meituan_listing_jobs SET status='done', result_count=?, error=NULL, completed_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(r.listings, job.id);
    } catch (err) {
      db.prepare(`UPDATE meituan_listing_jobs SET status='error', error=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(String(err.message).slice(0, 200), job.id);
      log(job.store_code, `processListingJobs error: ${err.message}`);
      logSync(job.store_code, 'auto_map', 'error', null, err.message);
    }
  }
}

// ── Business status (营业/休息 open-close) ───────────────────────────────────
// The web server writes store_business_status.target_open (operator toggle); this
// daemon — which owns the logged-in 闪购 session — applies it via change_status,
// then reads /common/businessStatus back so the toggle UI reflects reality. Read
// is throttled; a pending command is applied immediately on any cycle. NOT gated
// by isStoreOpen (an operator can close/reopen anytime); the loop's proxy gate
// still applies. See feature_meituan_store_open_close.
const STATUS_READ_MS = 60_000;
const lastStatusRead = {};

function saveBusinessStatus(storeCode, s) {
  db.prepare(`
    INSERT INTO store_business_status
      (store_code, is_open, mt_status, sub_status, status_desc, detail_desc, hours_desc, read_ok, read_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(store_code) DO UPDATE SET
      is_open=excluded.is_open, mt_status=excluded.mt_status, sub_status=excluded.sub_status,
      status_desc=excluded.status_desc, detail_desc=excluded.detail_desc, hours_desc=excluded.hours_desc,
      read_ok=1, read_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
  `).run(storeCode, s.open ? 1 : 0, s.status != null ? s.status : null, s.subStatus != null ? s.subStatus : null,
         s.statusDesc || null, s.detailDesc || null, s.hoursDesc || null);
}
function markStatusReadFailed(storeCode) {
  db.prepare(`
    INSERT INTO store_business_status (store_code, read_ok, updated_at)
    VALUES (?, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(store_code) DO UPDATE SET read_ok=0, updated_at=CURRENT_TIMESTAMP
  `).run(storeCode);
}
// Reflect a just-applied flip immediately (trust the write). Meituan's status READ
// can trail the change_status write, so a read-back right after a flip may return
// the OLD state — this keeps the toggle UI correct meanwhile. Only touches
// is_open/mt_status/status_desc; sub_status/hours_desc reconcile on the next read.
function saveAppliedStatus(storeCode, open, newDesc) {
  db.prepare(`
    INSERT INTO store_business_status (store_code, is_open, mt_status, status_desc, read_ok, read_at, updated_at)
    VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(store_code) DO UPDATE SET
      is_open=excluded.is_open, mt_status=excluded.mt_status,
      status_desc=COALESCE(excluded.status_desc, status_desc),
      read_ok=1, read_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
  `).run(storeCode, open ? 1 : 0, open ? 1 : 3, newDesc || (open ? '营业中' : '停业中'));
}

async function syncBusinessStatus(storeCode) {
  let cmd = null;
  try { cmd = db.prepare("SELECT target_open FROM store_business_status WHERE store_code=? AND target_open IS NOT NULL").get(storeCode); }
  catch (_) { cmd = null; }
  const due = Date.now() - (lastStatusRead[storeCode] || 0) >= STATUS_READ_MS;
  if (!cmd && !due) return;

  try {
    const browser = await getShangouBrowser(storeCode);
    if (!(await browser.isLoggedIn())) {
      if (browser.verificationRequired) noteVerifyResult(storeCode, true);
      markStatusReadFailed(storeCode);
      return; // don't clear a pending command — retry once logged back in
    }
    let appliedTarget = null;
    if (cmd) {
      const targetOpen = cmd.target_open === 1;
      const r = await browser.setBusinessStatus(targetOpen);
      db.prepare(`UPDATE store_business_status SET target_open=NULL, last_result=?, updated_at=CURRENT_TIMESTAMP WHERE store_code=?`)
        .run(JSON.stringify({ ok: r.ok, code: r.code, msg: r.msg || r.error || null, newDesc: r.newDesc || null, hadToken: r.hadToken, at: new Date().toISOString() }), storeCode);
      logSync(storeCode, 'business_status_set', r.ok ? 'ok' : 'error',
        { targetOpen, code: r.code, newDesc: r.newDesc, hadToken: r.hadToken }, r.ok ? null : (r.msg || r.error || 'change_status failed'));
      log(storeCode, `business status → ${targetOpen ? 'OPEN' : 'CLOSED'}: ${r.ok ? 'ok' : 'FAILED ' + (r.msg || r.error || '')}`);
      // Trust the write: reflect the new state at once (the READ below can lag it).
      if (r.ok) { appliedTarget = targetOpen; saveAppliedStatus(storeCode, targetOpen, r.newDesc); }
    }
    const s = await browser.getBusinessStatus();
    lastStatusRead[storeCode] = Date.now();
    if (s.ok) {
      if (appliedTarget !== null && s.open !== appliedTarget) {
        // Read replica still trailing the just-applied flip — keep the applied state
        // (don't clobber with stale data) and re-read soon to reconcile sub_status.
        lastStatusRead[storeCode] = Date.now() - (STATUS_READ_MS - 30_000);
        log(storeCode, `status read lag after flip (read=${s.open ? 'open' : 'closed'} vs applied ${appliedTarget ? 'open' : 'closed'}) — keeping applied state, re-reading soon`);
      } else {
        saveBusinessStatus(storeCode, s);
      }
    } else if (appliedTarget === null) {
      markStatusReadFailed(storeCode);
    }
  } catch (e) {
    log(storeCode, `syncBusinessStatus error: ${e.message}`);
    try { markStatusReadFailed(storeCode); } catch (_) {}
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[shangou-daemon] starting — stores: ${SHANGOU_STORES.join(', ')}`);

  // Heal any rows a previous run left stranded in 'processing' (killed mid-batch).
  recoverOrphanedProcessing(SHANGOU_STORES);

  let lastOrderPoll = 0;
  let warmupFlagged = false;   // log the cold-Chrome hold once per transition
  let orderPollGap = jitter(ORDER_POLL_MS, 0.4);
  let lastOrderSweep = 0;
  // 0 = sweep on the first cycle so a deploy re-queues whatever the previous build
  // left stranded, instead of waiting out the interval.
  let lastDriftSweep = 0;
  const lastMapRefresh = {}; // store_code → ts of last auto-map pass

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Date.now();

    // Proxy health-gate: if the GZ proxy can't reach Meituan, PAUSE this cycle. A
    // dead proxy otherwise makes every page fetch fail and the daemon misreads it
    // as "needs login" (burning queue attempts into terminal errors). Wait it out
    // and log the outage once. No-op in direct mode (no proxy configured).
    if (!(await proxyHealthy())) {
      proxyFailStreak++;
      if (!alerts['proxy_down'] && proxyFailStreak >= PROXY_DOWN_GRACE) {
        alerts['proxy_down'] = true;
        console.log(`[shangou-daemon] ${new Date().toISOString()} PROXY UNREACHABLE (${maskProxy(SHANGOU_PROXY)}) — pausing sync until it recovers (the session is NOT logged out)`);
        for (const s of SHANGOU_STORES) logSync(s, 'proxy_down', 'error', null, 'proxy cannot reach Meituan — sync paused');
        sendOpsAlert(`🔴 美团闪购 代理掉线，无法连接美团，同步已暂停（未掉登录）\nMeituan 闪购 proxy down — can't reach Meituan, sync paused (not logged out)`);
      }
      await sleep(jitter(QUEUE_CHECK_MS));
      continue;
    }
    proxyFailStreak = 0;
    if (alerts['proxy_down']) {
      alerts['proxy_down'] = false;
      console.log(`[shangou-daemon] ${new Date().toISOString()} proxy recovered — resuming sync`);
      for (const s of SHANGOU_STORES) logSync(s, 'proxy_up', 'ok', null, 'proxy reachable again — sync resumed');
      sendOpsAlert(`✅ 美团闪购 代理已恢复，同步继续\nMeituan 闪购 proxy recovered — sync resumed`);
    }

    // Cold-browser gate. The holder Chrome relaunches on a crash, on a proxy
    // failover switch, and on any pm2 restart — and a data call fired seconds into
    // a brand-new browser is exactly what earned the 403 验证中心 on 2026-07-25.
    // Wait the warm-up out: a paused cycle costs ~90s, a challenge costs 30 min.
    const coldMs = await coldMsRemaining(shangouCdpUrl());
    if (coldMs > 0) {
      if (!warmupFlagged) {
        warmupFlagged = true;
        console.log(`[shangou-daemon] ${new Date().toISOString()} holder Chrome relaunched — holding calls ~${Math.round(coldMs / 1000)}s so it isn't hit cold`);
        for (const s of SHANGOU_STORES) logSync(s, 'chrome_warmup', 'ok', null, 'holder Chrome relaunched — pausing calls for the warm-up window');
      }
      await sleep(Math.min(coldMs + 500, QUEUE_CHECK_MS));
      continue;
    }
    if (warmupFlagged) {
      warmupFlagged = false;
      console.log(`[shangou-daemon] ${new Date().toISOString()} browser warm — resuming sync`);
      for (const s of SHANGOU_STORES) logSync(s, 'chrome_warm', 'ok', null, 'warm-up over — sync resumed');
    }

    if (now - lastOrderPoll >= orderPollGap) {
      lastOrderPoll = now;
      orderPollGap = jitter(ORDER_POLL_MS, 0.4);
      for (const storeCode of SHANGOU_STORES) {
        // Skip closed stores and ones in a verify cool-down (pollOrders also guards).
        if (isStoreOpen(storeCode) && !inVerifyCooldown(storeCode)) await pollOrders(storeCode);
      }
    }
    // Trailing sweep for late 已完成 flips. Runs regardless of open/closed (orders
    // complete after close), but only touches a browser when a store actually has a
    // non-terminal order in the window — sweepStaleOrders guards on that.
    if (now - lastOrderSweep >= ORDER_SWEEP_MS) {
      lastOrderSweep = now;
      await autoDeliverPastEta(); // time-based delivered flip (no browser)
      for (const storeCode of SHANGOU_STORES) await sweepStaleOrders(storeCode);
    }

    // Re-enqueue anything whose stock no longer matches what 闪购 last accepted,
    // before the push so recovered rows go out in this same cycle. No browser.
    if (now - lastDriftSweep >= DRIFT_SWEEP_MS) {
      lastDriftSweep = now;
      sweepStockDrift(db, {
        storeCodes: SHANGOU_STORES, // only this daemon's stores — the queue is shared
        channel: '闪购', log, logSync, sendOpsAlert, alerts,
      });
    }

    await processStockQueue();

    // Apply any pending open/close command + refresh live status for the toggle UI.
    for (const storeCode of SHANGOU_STORES) {
      if (inVerifyCooldown(storeCode)) continue;
      await syncBusinessStatus(storeCode);
    }

    // On-demand "Fetch from Meituan" jobs (admin tab) + hourly auto-map so newly
    // listed products self-activate without the manual seed script.
    await processListingJobs();
    for (const storeCode of SHANGOU_STORES) {
      if (!isStoreOpen(storeCode) || inVerifyCooldown(storeCode)) continue;
      if (now - (lastMapRefresh[storeCode] || 0) < MAP_REFRESH_MS) continue;
      lastMapRefresh[storeCode] = now;
      try { await autoMapStore(storeCode); }
      catch (e) { log(storeCode, `auto-map error: ${e.message}`); }
    }

    await sleep(jitter(QUEUE_CHECK_MS));
  }
}

process.on('SIGINT',  async () => { await closeAllShangou(); process.exit(0); });
process.on('SIGTERM', async () => { await closeAllShangou(); process.exit(0); });

main().catch(err => { console.error('[shangou-daemon] fatal:', err); process.exit(1); });
