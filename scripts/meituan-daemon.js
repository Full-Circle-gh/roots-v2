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
const { execFile } = require('child_process');
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
const { sendOpsAlert } = require('../lib/ops-alert');

// Stores handled by a DIFFERENT channel daemon (e.g. yuexiu on 闪购/shangou-sync).
// Listed here so THIS 外卖 daemon never polls their (logged-out) e.waimai session or
// races the other daemon on their meituan_sync_queue rows. Set in .env, e.g.
// MEITUAN_SKIP_STORES=yuexiu
const SKIP_STORES = (process.env.MEITUAN_SKIP_STORES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const ORDER_POLL_MS  = 300_000; // how often to check for new Meituan orders (jittered ±40%)
// Import-only by default: pull orders into roots (records + stock) but do NOT
// click "accept" on Meituan. Set MEITUAN_AUTO_ACCEPT=1 in .env to re-enable.
const AUTO_ACCEPT    = process.env.MEITUAN_AUTO_ACCEPT === '1';
const QUEUE_CHECK_MS = 10_000;  // how often to process the stock push queue
// Re-persist each store's live session to disk this often (while logged in) so a
// CRASH — which skips the graceful close() that normally saves — still leaves a
// fresh cookie snapshot to restore, avoiding a forced re-login (the event that
// trips 验证中心). Meituan rotates session cookies during use; the login-time
// snapshot goes stale otherwise. Cheap (a few-KB file write); ~30 min is plenty.
const SESSION_SAVE_MS = 30 * 60_000;
const lastSessionSave = {}; // storeCode -> epochMs of last on-disk session refresh
const INTERNAL_PORT  = process.env.PORT || 3000;
const INTERNAL_BASE  = `http://127.0.0.1:${INTERNAL_PORT}`;

// Per-store opening hours (Asia/Shanghai). Outside these windows the store is
// closed on Meituan, so we stop order-polling: a merchant backend that keeps
// refreshing at 4am is itself a bot tell, and idling the browser saves RAM +
// proxy traffic. Minutes are local 24h; [open, close). A small grace buffer
// (OPEN_GRACE_MIN) widens the window so trailing/pre-orders still import and the
// on/off edge doesn't land exactly on the hour (also more human-looking).
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

// Self-expiring manual override (for testing a push outside opening hours):
// set env MEITUAN_FORCE_OPEN_MINUTES=30 and restart — every store counts as open
// for that many minutes from daemon start, then it reverts to the real hours on
// its own (no risk of leaving 24/7 edits on, which would be a bot tell). Harmless
// when unset.
const FORCE_OPEN_UNTIL = Number(process.env.MEITUAN_FORCE_OPEN_MINUTES) > 0
  ? Date.now() + Number(process.env.MEITUAN_FORCE_OPEN_MINUTES) * 60_000
  : 0;

// True when the store is within its (grace-padded) Meituan opening window. Stores
// with no configured hours default to always-open so a new store is never silently
// muted.
function isStoreOpen(storeCode, now = new Date()) {
  if (FORCE_OPEN_UNTIL && now.getTime() < FORCE_OPEN_UNTIL) return true;
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

// Quick proxy health probe: can the configured proxy actually REACH Meituan? A
// flaky GZ proxy that TCP-accepts but can't complete upstream requests makes
// every page load hang (net::ERR_TIMED_OUT / Timeout 30000ms). The browser layer
// then sees no dashboard iframe and MISREADS it as "session expired", triggering
// pointless re-logins — when the session is actually fine and the proxy is the
// dead link. Gating the loop on this turns a proxy outage into a clean, logged
// pause. Uses curl (always on the box); no extra deps. Direct mode (no proxy
// configured) is always "healthy". A real HTTP reply (even an error page) proves
// the proxy→Meituan path works; only 000/timeout counts as down.
function proxyHealthy(timeoutSec = 8) {
  // Probe the ACTIVE proxy (the failover watchdog's live choice — the same one
  // the browser uses), not a static env value. Otherwise the gate would pause the
  // whole loop when the env's default proxy is down even though a healthy fallback
  // is already in use. '' (direct) is always healthy.
  let proxy = process.env.MEITUAN_PROXY_URL || '';
  try {
    const a = require('../lib/proxy-manager').readActive('tianhe');
    if (a !== undefined) proxy = a;
  } catch (_) { /* manager optional — keep env value */ }
  if (!proxy) return Promise.resolve(true);
  // curl wants socks5h:// for remote DNS through a SOCKS5 exit.
  const probeUrl = proxy.startsWith('socks5://') ? 'socks5h://' + proxy.slice(9) : proxy;
  return new Promise((resolve) => {
    execFile('curl',
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-x', probeUrl,
       '--max-time', String(timeoutSec), 'https://e.waimai.meituan.com/'],
      { timeout: (timeoutSec + 4) * 1000 },
      (_err, stdout) => {
        const code = parseInt(String(stdout).trim(), 10) || 0;
        resolve(code >= 200 && code < 600);
      });
  });
}
function maskProxy(u) { return String(u || '').replace(/:[^:@/]+@/, ':****@'); }
// Latch so a proxy outage is logged once per transition, not every tick.
let proxyDownFlagged = false;

// Per-store latch so a 验证中心 challenge is logged once on transition, not
// every poll (which would flood the sync log the admin tab reads).
const verifyFlagged = {};

// Per-store latch so the "store closed → pausing polls" / "reopened → resuming"
// edge is logged once on transition, not on every loop tick.
const closedFlagged = {};

// Per-store browser-health tracking. A renderer crash / dropped Chromium makes
// every call throw "…has been closed"; lib/meituan-browser now auto-relaunches a
// dead instance, but if a page reliably crashes the renderer the relaunch can't
// stick. Without an alert that stays SILENT (the 2026-06-28 incident: tianhe died
// at ~04:35 and was only noticed hours later via a missing order). Track the first
// crash-class failure; if it persists past DOWN_ALERT_AFTER_MS, page ops once.
// Cleared (with a recovery alert) the moment a poll comes back clean.
const browserDown = {}; // storeCode -> { since: epochMs|null, alerted: bool }
const DOWN_ALERT_AFTER_MS = 10 * 60_000; // ~5 failed order polls before paging

// Does this error look like the browser/page died (vs. a verify/proxy issue,
// which have their own alerts)? Matches the Playwright "closed" / crash family
// and our own relaunch-cooldown sentinel.
function isBrowserDeadError(msg) {
  return /has been closed|Target (page|closed)|crash|relaunch cooling/i.test(String(msg || ''));
}

// Record the health of a poll/push cycle. ok=true clears the latch (and pages a
// recovery if we'd alerted). A crash-class failure starts/continues the latch and
// pages once it has persisted past the threshold. Non-crash failures are ignored
// here (verify/proxy own their own alerts) so we don't double-page.
function noteBrowserHealth(storeCode, ok, errMsg) {
  const s = browserDown[storeCode] || (browserDown[storeCode] = { since: null, alerted: false });
  if (ok) {
    if (s.alerted) {
      logSync(storeCode, 'browser_recovered', 'ok', null, 'browser back up — sync resumed');
      sendOpsAlert(`✅ 美团外卖 ${storeCode} 浏览器已恢复，库存/订单同步继续\nMeituan 外卖 ${storeCode} browser recovered — stock/order sync resumed`);
    }
    s.since = null; s.alerted = false;
    return;
  }
  if (!isBrowserDeadError(errMsg)) return; // not our concern
  const now = Date.now();
  if (s.since == null) s.since = now;
  if (!s.alerted && now - s.since >= DOWN_ALERT_AFTER_MS) {
    s.alerted = true;
    const mins = Math.round((now - s.since) / 60000);
    logSync(storeCode, 'browser_down', 'error', null,
      `browser keeps crashing (~${mins} min) — auto-relaunch not sticking, may need the box`);
    sendOpsAlert(`🔴 美团外卖 ${storeCode} 浏览器持续崩溃 ~${mins} 分钟，库存/订单同步已停，可能需要在盒子上处理\nMeituan 外卖 ${storeCode} browser keeps crashing for ~${mins} min — stock/order sync down, auto-relaunch isn't sticking, may need hands-on the box`);
  }
}

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
      sendOpsAlert(`🔴 美团外卖 ${storeCode} 掉线：验证中心风控，同步已暂停，需要人工验证\nMeituan 外卖 ${storeCode} disconnected (验证中心) — sync paused, needs a human to pass the captcha`);
    }
    log(storeCode, `verification challenge — cooling down ~${Math.round(wait / 60000)} min (strike ${s.strikes})`);
  } else {
    if (verifyFlagged[storeCode]) {
      verifyFlagged[storeCode] = false;
      logSync(storeCode, 'verify_cleared', 'ok', null, 'verification cleared — sync resumed');
      sendOpsAlert(`✅ 美团外卖 ${storeCode} 已恢复，同步继续\nMeituan 外卖 ${storeCode} recovered — sync resumed`);
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
  })).filter(s => s.meituanUser || true) // include all active stores
     .filter(s => !SKIP_STORES.includes(s.storeCode)); // …except ones on another channel
}

// ── Order polling ─────────────────────────────────────────────────────────────

async function pollOrders(storeConfig) {
  const { storeCode, storeId } = storeConfig;
  let browser;
  try {
    browser = await getBrowser(storeCode);
    const orders = await browser.getPendingOrders();
    noteBrowserHealth(storeCode, true); // a clean poll = browser alive

    // Surface + back off on a risk-control 验证中心 challenge: escalating
    // cool-down so we stop re-poking the verify page every cycle (logged once on
    // transition so it doesn't flood the sync log the admin tab reads).
    noteVerifyResult(storeCode, browser.verificationRequired);

    // Keep the on-disk session fresh while we're cleanly logged in, so a crash
    // restores recent cookies instead of the stale login-time snapshot (fewer
    // forced re-logins). Throttled; console-only log (not the admin sync log).
    if (!browser.verificationRequired) {
      const now = Date.now();
      if (!lastSessionSave[storeCode] || now - lastSessionSave[storeCode] >= SESSION_SAVE_MS) {
        if (await browser.persistSession()) {
          lastSessionSave[storeCode] = now;
          log(storeCode, 'session refreshed on disk');
        }
      }
    }

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
    noteBrowserHealth(storeCode, false, err.message); // pages ops if it persists
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
  // q.product_id is a store_products.id (order ingest, push-all, and adjustStock all
  // key off store_products) — NOT the legacy `products` kitchen table, whose ids
  // diverge for many SKUs. Joining `products` fed the wrong name/货号 for ~118 rows;
  // masked because the 外卖 push resolves by map_meituan_name first and most SPUs are
  // single-variant, but a wrong 货号 could still pick the wrong variant. Use
  // store_products so name fallback + variant-disambiguation 货号 are correct.
  const rows = db.prepare(`
    SELECT q.*, p.name_cn, p.name_en,
           COALESCE(mm.meituan_sku, p.sku) AS sku,
           mm.meituan_name AS map_meituan_name
      FROM meituan_sync_queue q
      LEFT JOIN store_products p ON p.id = q.product_id
      LEFT JOIN meituan_product_map mm
             ON mm.product_id = q.product_id AND mm.retail_store_id = q.retail_store_id
     WHERE q.status = 'pending' AND q.attempts < 3
     ORDER BY q.created_at
     LIMIT 40
  `).all();

  if (!rows.length) return;

  // Group by store
  const byStore = {};
  for (const row of rows) {
    (byStore[row.store_code] = byStore[row.store_code] || []).push(row);
  }

  for (const [storeCode, items] of Object.entries(byStore)) {
    // A store handled by another channel daemon (e.g. yuexiu on 闪购) — leave its
    // queue rows pending for that daemon; never touch them here.
    if (SKIP_STORES.includes(storeCode)) continue;
    // Don't push while the store is CLOSED on Meituan (a backend edit at 3am is a
    // bot tell, and stock accuracy doesn't matter until it reopens) or while it's
    // in a verification cool-down (a push would re-hit risk-control). Rows stay
    // pending and flush at the next open / after the cool-down.
    if (!isStoreOpen(storeCode)) continue;
    if (inVerifyCooldown(storeCode)) continue;

    // Collapse to the latest qty per product/bundle so we push each target once,
    // not replay every intermediate change. Older same-target rows are retired.
    const latest = new Map(); // key -> row
    const superseded = [];
    for (const row of items) {
      const key = row.bundle_id ? `b:${row.bundle_id}` : `p:${row.product_id}`;
      const prev = latest.get(key);
      if (prev) superseded.push(prev);
      latest.set(key, row);
    }
    for (const row of superseded) {
      db.prepare(`UPDATE meituan_sync_queue SET status='done', processed_at=CURRENT_TIMESTAMP, last_error='superseded' WHERE id=?`)
        .run(row.id);
    }
    const pushRows = Array.from(latest.values());

    let browser;
    try {
      browser = await getBrowser(storeCode);

      // Mark the rows we're about to push as processing.
      for (const row of pushRows) {
        db.prepare(`UPDATE meituan_sync_queue SET status='processing', attempts=attempts+1 WHERE id=?`)
          .run(row.id);
      }

      // Bundle rows target a Meituan listing by name; product rows by the
      // product's own name. _updateOneOnPage matches the list row by substring.
      const batchItems = pushRows.map(row => {
        const isBundle = !!row.bundle_id;
        return {
          row, isBundle,
          // Resolve products by the operator-confirmed Meituan listing name, not
          // the product's name_cn: a name_cn like "纯素椰子酸奶-桃子味（小）100g"
          // truncates (at the hyphen) to the generic "纯素椰子酸奶" shared by every
          // coconut yogurt, so the search matched the wrong spu. The mapped name
          // ("Peach Yogurt 纯素椰子酸奶-桃子味") is distinctive. Falls back to name_cn.
          targetCn: isBundle ? row.meituan_name : (row.map_meituan_name || row.name_cn),
          targetEn: isBundle ? null : row.name_en,
          sku:      isBundle ? null : row.sku,
          newQty:   row.new_qty,
        };
      });

      // One product-list page visit for the whole store (was one per item).
      const results = await browser.batchUpdateStock(batchItems);

      // If the store got challenged mid-batch, start its cool-down now.
      const challenged = browser.verificationRequired;
      if (challenged) noteVerifyResult(storeCode, true);

      for (const res of results) {
        const { row, isBundle, newQty, ok, transient } = res;
        if (ok) {
          db.prepare(`UPDATE meituan_sync_queue SET status='done', processed_at=CURRENT_TIMESTAMP, last_error=NULL WHERE id=?`)
            .run(row.id);
          if (isBundle) {
            db.prepare(`UPDATE meituan_bundles SET last_pushed_qty=?, last_pushed_at=CURRENT_TIMESTAMP WHERE id=?`)
              .run(newQty, row.bundle_id);
          } else {
            db.prepare(`UPDATE meituan_product_map SET last_pushed_qty=?, last_pushed_at=CURRENT_TIMESTAMP WHERE retail_store_id=? AND product_id=?`)
              .run(newQty, row.retail_store_id, row.product_id);
          }
          logSync(storeCode, 'stock_push', 'ok',
            { name_en: isBundle ? row.meituan_name : row.name_en,
              name_cn: isBundle ? row.meituan_name : row.name_cn,
              sku: isBundle ? null : row.sku, qty: newQty, bundle: isBundle });
        } else if (challenged) {
          // Deferred by risk-control, not a real failure — requeue and refund the
          // attempt so it retries once the cool-down passes (no burned attempts).
          db.prepare(`UPDATE meituan_sync_queue SET status='pending', attempts=attempts-1 WHERE id=?`)
            .run(row.id);
        } else if (transient && (row.attempts || 0) + 1 < 3) {
          // Transient automation hiccup (resolve / searchSugByName / navigation),
          // NOT a genuine Meituan API rejection. Leave the row pending so it
          // retries instead of being buried as a terminal 'error' that never
          // self-heals (the chronic-drift bug on flaky listings). No attempt
          // refund — attempts<3 still caps the retries. (attempts was already
          // incremented when the row was marked 'processing', so +1 here.)
          db.prepare(`UPDATE meituan_sync_queue SET status='pending', last_error='transient push failure — will retry' WHERE id=?`)
            .run(row.id);
        } else {
          // Genuine API rejection, or transient retries exhausted → terminal.
          // Surface the exhausted case too so a chronically-flaky listing isn't
          // left silently drifting (the failure the old code hid on attempt 1).
          db.prepare(`UPDATE meituan_sync_queue SET status='error', processed_at=CURRENT_TIMESTAMP, last_error=? WHERE id=?`)
            .run(transient ? 'transient push failure — retries exhausted' : 'browser update failed', row.id);
          logSync(storeCode, 'stock_push', 'error',
            { name_en: isBundle ? row.meituan_name : row.name_en,
              name_cn: isBundle ? row.meituan_name : row.name_cn,
              sku: isBundle ? null : row.sku, qty: newQty, bundle: isBundle },
            transient ? 'update failed after retries · 多次重试仍失败' : 'browser update failed · 更新失败');
        }
      }
    } catch (err) {
      log(storeCode, `processStockQueue error: ${err.message}`);
      // Reset only the rows we marked processing back to error.
      for (const row of pushRows) {
        db.prepare(`UPDATE meituan_sync_queue SET status='error', last_error=? WHERE id=? AND status='processing'`)
          .run(err.message.slice(0, 200), row.id);
      }
    }
  }
}

// ── Startup recovery: orphaned 'processing' rows ──────────────────────────────
// A queue row is flipped to status='processing' (attempts+1) just BEFORE the
// browser push. If the daemon is killed/restarted (pm2 restart, crash) mid-batch,
// the try/catch only resets rows the CURRENT run owns — rows from the dead run are
// stranded in 'processing' forever, and the retry query (status='pending' AND
// attempts<3) never picks them up, so that product's Meituan stock silently
// drifts. On 2026-06-27 we found 69 such orphans on tianhe, the oldest 5 days old.
//
// On startup, sweep THIS daemon's own stores for stale 'processing' rows and make
// them retryable again — but safely, mirroring the safe recovery in
// feature_meituan_push_error_terminal_no_retry:
//   • Scoped to OUR stores only, so we never disturb a row the sibling channel
//     daemon (闪购/shangou-sync) may legitimately have in flight on a shared queue.
//   • created_at older than ~5 min, so a near-simultaneous pm2 reload (two runs
//     briefly overlapping) can't race us onto a row a still-living run owns.
//   • If a NEWER queue row exists for the same product/bundle, this orphan's qty is
//     stale — retire it 'done' (superseded) rather than replay an outdated value
//     onto live Meituan stock.
//   • Otherwise re-enqueue at the product/bundle's CURRENT stock (physical_qty /
//     component floor), NOT the new_qty snapped before the crash, and refund the
//     one attempt the 'processing' mark burned.
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
    console.error('[meituan-daemon] orphan recovery query failed:', e.message);
    return;
  }
  if (!stale.length) return;

  const bundles = require('../lib/meituan-bundles');
  const stats = {}; // storeCode -> { requeued, retired }
  for (const row of stale) {
    const st = stats[row.store_code] || (stats[row.store_code] = { requeued: 0, retired: 0 });
    try {
      const isBundle = !!row.bundle_id;
      // A newer queue row for the same target (any status) means this orphan's
      // quantity is stale — retire it instead of replaying an old value.
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
      // Latest row for its target → re-enqueue at CURRENT stock truth.
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
      console.error(`[meituan-daemon] orphan recovery row ${row.id} failed:`, e.message);
    }
  }
  for (const [sc, s] of Object.entries(stats)) {
    if (!s.requeued && !s.retired) continue;
    console.log(`[meituan-daemon:${sc}] ${new Date().toISOString()} startup orphan recovery: ${s.requeued} re-enqueued, ${s.retired} retired`);
    logSync(sc, 'orphan_recovery', 'ok', s,
      `recovered ${s.requeued + s.retired} stale 'processing' row(s) at startup`);
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
  `).all()
    // Leave 闪购 stores' jobs for the shangou daemon — this 外卖 browser can't
    // reach shangoue.meituan.com, so grabbing them would only error the job.
    .filter(job => !SKIP_STORES.includes(job.store_code));

  if (!jobs.length) return;

  for (const job of jobs) {
    db.prepare(`UPDATE meituan_listing_jobs SET status='processing' WHERE id=?`).run(job.id);
    try {
      const browser = await getBrowser(job.store_code);
      const scrape = await browser.listProductsWithSpecs();
      if (!scrape) throw new Error('scrape returned null (not logged in or no content iframe)');
      const names = scrape.names || [];
      const listings = scrape.listings || [];

      const tx = db.transaction(() => {
        db.prepare(`DELETE FROM meituan_listings WHERE store_code=?`).run(job.store_code);
        const ins = db.prepare(
          `INSERT OR IGNORE INTO meituan_listings (store_code, listing_name) VALUES (?, ?)`
        );
        for (const n of names) ins.run(job.store_code, n);

        // Replace this store's captured specs (货号 per spec) wholesale.
        db.prepare(`DELETE FROM meituan_listing_specs WHERE store_code=?`).run(job.store_code);
        const insSpec = db.prepare(`
          INSERT INTO meituan_listing_specs
            (store_code, listing_name, spu_id, spec, sku_code, sku_id, stock, raw)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const l of listings) {
          for (const s of (l.skus || [])) {
            insSpec.run(job.store_code, l.name, l.spuId, s.spec || '', s.code || '',
                        s.skuId || '', s.stock == null ? null : Number(s.stock),
                        JSON.stringify(s.raw || null));
          }
        }
      });
      tx();

      const specCount = listings.reduce((a, l) => a + (l.skus ? l.skus.length : 0), 0);
      db.prepare(`
        UPDATE meituan_listing_jobs
           SET status='done', result_count=?, error=NULL, completed_at=CURRENT_TIMESTAMP
         WHERE id=?
      `).run(names.length, job.id);
      logSync(job.store_code, 'listing_scrape', 'ok', { count: names.length, specs: specCount });
      log(job.store_code, `listing scrape done: ${names.length} listing(s), ${specCount} spec(s) across ${listings.length} spu(s)`);
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

  // Heal any rows a previous run left stranded in 'processing' (killed mid-batch).
  recoverOrphanedProcessing(stores.map(s => s.storeCode));

  let lastOrderPoll = 0;
  let orderPollGap  = jitter(ORDER_POLL_MS, 0.4);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Date.now();

    // Proxy health-gate: if the shared proxy can't reach Meituan, PAUSE all work
    // this cycle. A dead proxy otherwise cascades into page-load timeouts, browser
    // crashes, and a FALSE "session expired" that triggers needless re-logins. We
    // simply wait it out and log the outage once (the admin sync log is the alert).
    if (!(await proxyHealthy())) {
      if (!proxyDownFlagged) {
        proxyDownFlagged = true;
        console.log(`[meituan-daemon] ${new Date().toISOString()} PROXY UNREACHABLE (${maskProxy(process.env.MEITUAN_PROXY_URL)}) — pausing sync until it recovers (the session is NOT logged out)`);
        for (const s of stores) logSync(s.storeCode, 'proxy_down', 'error', null, 'proxy cannot reach Meituan — sync paused');
        sendOpsAlert(`🔴 美团外卖 代理掉线，无法连接美团，同步已暂停（未掉登录）\nMeituan 外卖 proxy down — can't reach Meituan, sync paused (not logged out)`);
      }
      await sleep(jitter(QUEUE_CHECK_MS));
      continue;
    }
    if (proxyDownFlagged) {
      proxyDownFlagged = false;
      console.log(`[meituan-daemon] ${new Date().toISOString()} proxy recovered — resuming sync`);
      for (const s of stores) logSync(s.storeCode, 'proxy_up', 'ok', null, 'proxy reachable again — sync resumed');
      sendOpsAlert(`✅ 美团外卖 代理已恢复，同步继续\nMeituan 外卖 proxy recovered — sync resumed`);
    }

    // Poll for new orders on a jittered ~5 min cadence. Stagger stores so the two
    // browsers never hit Meituan at the same instant (lockstep concurrent polls
    // are themselves a bot tell, and serialising keeps RAM to one busy browser).
    if (now - lastOrderPoll >= orderPollGap) {
      lastOrderPoll = now;
      orderPollGap  = jitter(ORDER_POLL_MS, 0.4);
      // Only poll stores that are currently open on Meituan. Skipping closed
      // stores idles the browser overnight (RAM/proxy savings) and drops the
      // round-the-clock cadence that reads as a bot.
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
      }).filter(s => !inVerifyCooldown(s.storeCode)); // skip stores in a verify cool-down
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
