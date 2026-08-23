// Eleme (饿了么) sync daemon — runs as a separate pm2 process.
//
// Eleme's official OpenAPI rejects our single-store accounts ("暂不支持该账户登录"
// — see ELEME_BROWSER_RECON.md), so — like the Meituan 外卖 daemon — this drives a
// headless Playwright session against the merchant backend (lib/eleme-browser.js)
// instead of holding an OAuth access_token. lib/eleme-client.js (the old OAuth
// client) is dead; nothing in this file calls it any more.
//
// Every ~10s: drain eleme_sync_queue → push stock changes to Eleme via the browser.
//
// Orders are NOT wired yet. The recon captured the RPC method names
// (OrderWebService.queryInProcessOrders, PollingService.unprocessedOrders, …) but
// no live order, so the payload shapes are unknown — see lib/eleme-browser.js's
// getPendingOrders/acceptOrder stubs and ELEME_BROWSER_RECON.md. Wire order
// polling into the loop below once that lands (mirror scripts/meituan-daemon.js's
// pollOrders/ingestOrder shape — this file intentionally does not build out the
// full alerting/heartbeat machinery meituan-daemon.js has until there's an order
// path to protect too).
//
// Start:  pm2 start scripts/eleme-daemon.js --name eleme-sync
// Logs:   pm2 logs eleme-sync
// Stop:   pm2 stop eleme-sync
//
// First run per store: no session on disk yet, so the daemon can't log in on its
// own — run `node scripts/eleme-login.js <storeCode> <shopId>` on a machine with a
// display, then copy data/eleme-sessions/<storeCode>-session.json to the box.
//
// Prereqs: each store linked to its Eleme shop via eleme_shops (shop_id set), and
// storefront_config 'eleme.enabled' = true.

'use strict';

const path = require('path');
const fs   = require('fs');
// Load .env from project root (dotenv optional — fall back to a manual parse).
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
const { getBrowser } = require('../lib/eleme-browser');
const { sendOpsAlert } = require('../lib/ops-alert');
const { channelClosedStores } = require('../lib/inventory');
// Ops-alert latches that survive a restart (see lib/alert-latch).
const { latchStore } = require('../lib/alert-latch');

const QUEUE_CHECK_MS = 10_000; // stock push cadence

// Stores handled by a different daemon/channel — never poll or push them here.
const SKIP_STORES = (process.env.ELEME_SKIP_STORES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// ── Helpers ───────────────────────────────────────────────────────────────────

function jitter(baseMs, frac = 0.3) {
  const spread = baseMs * frac;
  return Math.round(baseMs - spread + Math.random() * spread * 2);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(storeCode, msg) { console.log(`[eleme-daemon:${storeCode}] ${new Date().toISOString()} ${msg}`); }
function logSync(storeCode, eventType, status, detail, errorMsg) {
  try {
    db.prepare(`
      INSERT INTO eleme_sync_log (store_code, event_type, status, detail, error_msg)
      VALUES (?, ?, ?, ?, ?)
    `).run(storeCode, eventType, status, detail ? JSON.stringify(detail) : null, errorMsg || null);
  } catch {}
}

// Is the Eleme channel switched on for the tenant?
function elemeEnabled() {
  try {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'eleme.enabled'").get();
    return row ? JSON.parse(row.value_json) === true : false;
  } catch { return false; }
}

// ── Store config ─────────────────────────────────────────────────────────────
// Active stores joined to their mapped Eleme shop. Only stores with a shop_id are
// actionable (the operator linked them during setup).
function getStoreConfigs() {
  const rows = db.prepare(`
    SELECT s.id AS store_id, s.code AS store_code, s.name_en,
           e.shop_id
      FROM retail_stores s
      JOIN eleme_shops e ON e.retail_store_id = s.id
     WHERE s.is_active = 1 AND e.shop_id IS NOT NULL AND e.shop_id <> ''
     ORDER BY s.sort_order, s.id
  `).all();
  return rows.filter(r => !SKIP_STORES.includes(r.store_code));
}

// ── Browser-health alerting ──────────────────────────────────────────────────
// Deliberately smaller than meituan-daemon's (no heartbeat/queue-stall canary
// yet) — the browser lib is brand new and stock push is the only wired path.
// Latches survive a restart (lib/alert-latch), same as every other channel.
const alerts = latchStore('eleme');

function noteLoginResult(storeCode, ok) {
  const key = 'login_required:' + storeCode;
  if (ok) {
    if (alerts[key]) {
      alerts[key] = false;
      logSync(storeCode, 'auth_recovered', 'ok', null, 'Eleme session restored — sync resumed');
      sendOpsAlert(`✅ 饿了么 ${storeCode} 已登录恢复，库存同步继续\nEleme ${storeCode} session restored — stock sync resumed`);
    }
    return;
  }
  if (!alerts[key]) {
    alerts[key] = true;
    logSync(storeCode, 'auth_required', 'error', null, 'Eleme session missing/expired — needs a manual login');
    sendOpsAlert(`🔴 饿了么 ${storeCode} 需要人工登录（浏览器自动化），库存同步已暂停\nEleme ${storeCode} needs a manual login (browser automation) — stock sync paused. Run: node scripts/eleme-login.js ${storeCode} <shopId>`);
  }
}

function noteVerifyResult(storeCode, challenged) {
  const key = 'verify:' + storeCode;
  if (challenged) {
    if (!alerts[key]) {
      alerts[key] = true;
      logSync(storeCode, 'verify_required', 'error', null, 'Eleme risk-control challenge — a human must clear it; sync paused');
      sendOpsAlert(`🔴 饿了么 ${storeCode} 风控验证，库存同步已暂停，需要人工处理\nEleme ${storeCode} hit a risk-control challenge — stock sync paused, needs a human`);
    }
  } else if (alerts[key]) {
    alerts[key] = false;
    logSync(storeCode, 'verify_cleared', 'ok', null, 'verification cleared — sync resumed');
    sendOpsAlert(`✅ 饿了么 ${storeCode} 风控已清除，同步恢复\nEleme ${storeCode} verification cleared — sync resumed`);
  }
}

// ── Stock push queue ──────────────────────────────────────────────────────────

async function processStockQueue(stores) {
  if (!stores.length) return;

  // Stores the operator has CLOSED for the Eleme channel (Sales-page close
  // matrix, channel_status.channel='eleme'). Honour it like Meituan honours its
  // opening hours: skip the push and leave rows pending so stock re-syncs the
  // moment the store is reopened — never silently drops the update.
  let elemeClosed = new Set();
  try { elemeClosed = channelClosedStores('eleme'); } catch (_) {}
  const eligible = stores.map(s => s.store_code).filter(c => !elemeClosed.has(c));
  if (!eligible.length) return;
  const ph = eligible.map(() => '?').join(',');

  const rows = db.prepare(`
    SELECT q.*, p.name_cn, p.name_en,
           COALESCE(m.extend_code, p.sku) AS sku
      FROM eleme_sync_queue q
      LEFT JOIN store_products p ON p.id = q.product_id
      LEFT JOIN eleme_product_map m
             ON m.product_id = q.product_id AND m.retail_store_id = q.retail_store_id
     WHERE q.status = 'pending' AND q.attempts < 3
       AND q.store_code IN (${ph})
     ORDER BY q.created_at
     LIMIT 40
  `).all(...eligible);
  if (!rows.length) return;

  const byStore = {};
  for (const row of rows) (byStore[row.store_code] = byStore[row.store_code] || []).push(row);
  const configByCode = {};
  for (const s of stores) configByCode[s.store_code] = s;

  for (const [storeCode, items] of Object.entries(byStore)) {
    if (!eligible.includes(storeCode)) continue; // guard — state can shift between query and push
    const cfg = configByCode[storeCode];
    if (!cfg) continue;

    // Collapse to the latest qty per product; retire superseded rows.
    const latest = new Map();
    const superseded = [];
    for (const row of items) {
      const key = `p:${row.product_id}`;
      const prev = latest.get(key);
      if (prev) superseded.push(prev);
      latest.set(key, row);
    }
    for (const row of superseded) {
      db.prepare(`UPDATE eleme_sync_queue SET status='done', processed_at=CURRENT_TIMESTAMP, last_error='superseded' WHERE id=?`).run(row.id);
    }
    const pushRows = Array.from(latest.values());

    let browser;
    try {
      browser = await getBrowser(storeCode, cfg.shop_id);

      for (const row of pushRows) {
        db.prepare(`UPDATE eleme_sync_queue SET status='processing', attempts=attempts+1 WHERE id=?`).run(row.id);
      }

      const batchItems = pushRows.map(row => ({
        row, targetCn: row.name_cn, targetEn: row.name_en, sku: row.sku, newQty: row.new_qty,
      }));
      const results = await browser.batchUpdateStock(batchItems);

      noteLoginResult(storeCode, browser.loggedIn);
      noteVerifyResult(storeCode, browser.verificationRequired);
      const challenged = browser.verificationRequired;

      for (const res of results) {
        const { row, newQty, ok, transient } = res;
        if (ok) {
          db.prepare(`UPDATE eleme_sync_queue SET status='done', processed_at=CURRENT_TIMESTAMP, last_error=NULL WHERE id=?`).run(row.id);
          db.prepare(`UPDATE eleme_product_map
                         SET last_pushed_qty=?, last_pushed_at=CURRENT_TIMESTAMP
                       WHERE retail_store_id=? AND product_id=?`)
            .run(newQty, row.retail_store_id, row.product_id);
          logSync(storeCode, 'stock_push', 'ok', { product_id: row.product_id, sku: row.sku, qty: newQty });
        } else if (challenged) {
          // Deferred by risk-control, not a real failure — requeue and refund the
          // attempt so it retries once cleared (no burned attempts).
          db.prepare(`UPDATE eleme_sync_queue SET status='pending', attempts=attempts-1 WHERE id=?`).run(row.id);
        } else if (transient && (row.attempts || 0) < 3) {
          db.prepare(`UPDATE eleme_sync_queue SET status='pending', last_error='transient push failure — will retry' WHERE id=?`).run(row.id);
        } else {
          db.prepare(`UPDATE eleme_sync_queue SET status='error', processed_at=CURRENT_TIMESTAMP, last_error=? WHERE id=?`)
            .run(transient ? 'transient push failure — retries exhausted' : 'browser update failed', row.id);
          logSync(storeCode, 'stock_push', 'error', { product_id: row.product_id, sku: row.sku, qty: newQty },
            transient ? 'update failed after retries · 多次重试仍失败' : 'browser update failed · 更新失败');
        }
      }
    } catch (err) {
      log(storeCode, `processStockQueue error: ${err.message}`);
      // The whole batch died (browser/page crash, nav timeout, proxy blip) — says
      // nothing about any individual product, so requeue rather than bury these
      // as terminal (mirrors meituan-daemon's identical reasoning). Attempt is NOT
      // refunded, so attempts<3 still bounds a browser that dies every batch.
      for (const row of pushRows) {
        db.prepare(`UPDATE eleme_sync_queue
                       SET status='pending', last_error=?
                     WHERE id=? AND status='processing'`)
          .run(`batch failed (${err.message.slice(0, 150)}) — will retry`, row.id);
      }
    }
  }
}

// Heal rows stranded in 'processing' by a mid-batch crash/restart.
function recoverOrphanedProcessing() {
  let stale;
  try {
    stale = db.prepare(`
      SELECT * FROM eleme_sync_queue
       WHERE status='processing' AND created_at < datetime('now', '-5 minutes')
    `).all();
  } catch { return; }
  for (const row of stale) {
    try {
      const newer = db.prepare(`
        SELECT 1 FROM eleme_sync_queue
         WHERE store_code=? AND product_id=? AND id<>?
           AND (created_at>? OR (created_at=? AND id>?)) LIMIT 1
      `).get(row.store_code, row.product_id, row.id, row.created_at, row.created_at, row.id);
      if (newer) {
        db.prepare(`UPDATE eleme_sync_queue SET status='done', processed_at=CURRENT_TIMESTAMP, last_error='superseded — stale processing recovered at startup' WHERE id=?`).run(row.id);
        continue;
      }
      const r = db.prepare('SELECT COALESCE(physical_qty,0) AS q FROM retail_store_stock WHERE store_id=? AND product_id=?')
        .get(row.retail_store_id, row.product_id);
      db.prepare(`UPDATE eleme_sync_queue SET status='pending', new_qty=?, attempts=MAX(attempts-1,0),
                     last_error='recovered stale processing at startup' WHERE id=?`)
        .run(r ? r.q : 0, row.id);
    } catch (e) { console.error(`[eleme-daemon] orphan recovery row ${row.id}:`, e.message); }
  }
  if (stale.length) console.log(`[eleme-daemon] startup orphan recovery: ${stale.length} row(s)`);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('[eleme-daemon] starting (browser automation — see ELEME_BROWSER_RECON.md)');
  console.log('[eleme-daemon] order polling not wired yet — stock push only, until a live order is captured');
  recoverOrphanedProcessing();

  while (true) {
    if (!elemeEnabled()) { await sleep(jitter(QUEUE_CHECK_MS)); continue; }

    const configs = getStoreConfigs();
    await processStockQueue(configs);
    await sleep(jitter(QUEUE_CHECK_MS));
  }
}

process.on('SIGINT',  () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(err => {
  console.error('[eleme-daemon] fatal:', err);
  process.exit(1);
});
