// Eleme (饿了么开放平台) bidirectional sync daemon — a separate pm2 process.
//
// Eleme exposes a real OAuth2 + JSON-RPC API, so — unlike the Meituan daemon —
// there is NO headless browser, proxy, cookie session, or risk-control 验证中心
// to nurse. This daemon just holds a per-store access_token and talks HTTPS.
//
// Loop:
//   • every ~30s         refresh any access_token nearing expiry
//   • every ~5 min       pull each shop's recent orders → ingest + deduct stock
//   • every ~10s         drain eleme_sync_queue → push stock to Eleme
//
// Start:  pm2 start scripts/eleme-daemon.js --name eleme-sync
// Logs:   pm2 logs eleme-sync
// Stop:   pm2 stop eleme-sync
//
// Prereqs (see the go-live checklist): ELEME_APP_KEY / ELEME_APP_SECRET in .env,
// each store authorised once via the admin "Connect Eleme" button (fills
// eleme_tokens + eleme_shops), and storefront_config 'eleme.enabled' = true.

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
const eleme = require('../lib/eleme-client');
const { sendOpsAlert } = require('../lib/ops-alert');
const { channelClosedStores } = require('../lib/inventory');

const ORDER_POLL_MS  = 300_000; // ~5 min (jittered) — order timing isn't critical
const QUEUE_CHECK_MS = 10_000;  // stock push cadence
const TOKEN_CHECK_MS = 30_000;  // proactive token-refresh check
const TOKEN_SKEW_MS  = 10 * 60_000; // refresh when <10 min of life remains
const INTERNAL_PORT  = process.env.PORT || 3000;
const INTERNAL_BASE  = `http://127.0.0.1:${INTERNAL_PORT}`;

// Stores handled by a different daemon/channel — never poll or push them here.
const SKIP_STORES = (process.env.ELEME_SKIP_STORES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// ── Helpers ───────────────────────────────────────────────────────────────────

function jitter(baseMs, frac = 0.3) {
  const spread = baseMs * frac;
  return Math.round(baseMs - spread + Math.random() * spread * 2);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function internalSecret() { return process.env.ELEME_INTERNAL_SECRET || 'eleme-daemon-internal'; }
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

// ── Token lifecycle ─────────────────────────────────────────────────────────

function getTokenRow(account) {
  return db.prepare('SELECT * FROM eleme_tokens WHERE account = ?').get(account);
}
function saveToken(account, tok) {
  const expiresAt = Date.now() + (Number(tok.expires_in) || 0) * 1000;
  db.prepare(`
    INSERT INTO eleme_tokens (account, access_token, refresh_token, token_type, scope, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(account) DO UPDATE SET
      access_token=excluded.access_token,
      refresh_token=COALESCE(excluded.refresh_token, eleme_tokens.refresh_token),
      token_type=excluded.token_type, scope=excluded.scope,
      expires_at=excluded.expires_at, updated_at=CURRENT_TIMESTAMP
  `).run(account, tok.access_token, tok.refresh_token || null,
         tok.token_type || null, tok.scope || null, expiresAt);
}

// Per-store auth-health latch so a re-auth alert fires once on transition.
const authDown = {}; // storeCode -> bool (currently alerted)
function noteAuth(storeCode, ok, detail) {
  if (ok) {
    if (authDown[storeCode]) {
      authDown[storeCode] = false;
      logSync(storeCode, 'auth_recovered', 'ok', null, 'Eleme authorisation restored — sync resumed');
      sendOpsAlert(`✅ 饿了么 ${storeCode} 授权已恢复，库存/订单同步继续\nEleme ${storeCode} authorisation restored — stock/order sync resumed`);
    }
    return;
  }
  if (!authDown[storeCode]) {
    authDown[storeCode] = true;
    logSync(storeCode, 'auth_required', 'error', null, detail || 'Eleme authorisation expired — needs re-connect');
    sendOpsAlert(`🔴 饿了么 ${storeCode} 授权失效，同步已暂停，需要在后台重新「连接饿了么」\nEleme ${storeCode} authorisation expired — sync paused, re-connect in the admin (Connect Eleme)`);
  }
}

// Return a valid access_token for an account, refreshing proactively. Null if the
// store has never authorised or the refresh_token is dead (→ paged via noteAuth).
async function freshAccessToken(account) {
  const row = getTokenRow(account);
  if (!row || !row.access_token) return null;
  if (row.expires_at && Date.now() < row.expires_at - TOKEN_SKEW_MS) return row.access_token;
  if (!row.refresh_token) { noteAuth(account, false, 'no refresh_token on file'); return row.access_token || null; }
  try {
    const tok = await eleme.refreshToken(row.refresh_token, row.scope || 'all');
    saveToken(account, tok);
    log(account, 'access_token refreshed');
    noteAuth(account, true);
    return tok.access_token;
  } catch (err) {
    log(account, `token refresh failed: ${err.message}`);
    noteAuth(account, false, err.message);
    return null;
  }
}

// ── Store config ─────────────────────────────────────────────────────────────
// Active stores joined to their mapped Eleme shop. Only stores with a shop_id are
// actionable (the operator linked them during OAuth).
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

// ── Order polling ─────────────────────────────────────────────────────────────

// Best-effort flatten of an Eleme order's line items into {name, sku, qty}. The
// exact getCommodities / order.groups shape varies by Eleme API version, so we
// probe the common field names. Tune once verified against the live sandbox.
function parseOrderItems(detail, commodities) {
  const out = [];
  const push = (it) => {
    if (!it) return;
    const name = it.name || it.title || it.foodName || '';
    const qty  = parseInt(it.quantity ?? it.amount ?? it.count ?? it.num ?? 0, 10) || 0;
    const sku  = it.extendCode || it.extend_code || it.skuCode || it.barCode || it.upc || null;
    if (qty > 0 && (name || sku)) out.push({ name, sku, qty });
  };
  const scan = (arr) => { for (const x of (arr || [])) push(x); };
  if (Array.isArray(commodities)) {
    for (const c of commodities) {
      if (c && Array.isArray(c.items)) scan(c.items);
      else push(c);
    }
  }
  if (!out.length && detail) {
    if (Array.isArray(detail.groups)) for (const g of detail.groups) scan(g.items || g.commodities);
    else scan(detail.products || detail.items || detail.commodities);
  }
  return out;
}

async function pollOrders(cfg, token) {
  const { store_code: storeCode, store_id: storeId, shop_id: shopId } = cfg;
  try {
    // Today's orders (Asia/Shanghai). getAllOrders is the catch-all source; the
    // import ledger makes re-imports idempotent, so re-reading the day is safe.
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    let pageNo = 1;
    const pageSize = 50;
    let imported = 0;
    // Page until a short page (defensive cap at 10 pages = 500 orders/poll).
    for (; pageNo <= 10; pageNo++) {
      let res;
      try {
        res = await eleme.order.getAllOrders(token, shopId, pageNo, pageSize, today);
      } catch (err) {
        if (err.elemeError) { handleApiAuthError(storeCode, err); }
        throw err;
      }
      noteAuth(storeCode, true);
      const orders = Array.isArray(res) ? res : (res && (res.list || res.orders || res.data)) || [];
      if (!orders.length) break;

      for (const order of orders) {
        const elemeOrderId = String(order.id || order.orderId || order.eleme_order_id || '');
        if (!elemeOrderId) continue;
        const seen = db.prepare('SELECT id FROM eleme_order_import WHERE eleme_order_id = ?').get(elemeOrderId);
        if (seen) continue;

        // Pull authoritative line items.
        let commodities = null;
        try { commodities = await eleme.order.getCommodities(token, elemeOrderId); } catch {}
        const items = parseOrderItems(order, commodities);
        const total = parseFloat(order.totalPrice ?? order.total ?? order.originalPrice ?? 0) || 0;

        const rootsOrderId = await ingestOrder(storeId, storeCode, { elemeOrderId, total, items });
        db.prepare(`
          INSERT OR IGNORE INTO eleme_order_import (eleme_order_id, retail_order_id, store_code, status, raw_payload)
          VALUES (?, ?, ?, ?, ?)
        `).run(elemeOrderId, rootsOrderId || null, storeCode,
               rootsOrderId ? 'imported' : 'error', JSON.stringify(order).slice(0, 4000));
        logSync(storeCode, 'order_import', rootsOrderId ? 'ok' : 'error',
          { elemeOrderId, rootsOrderId, items: items.length });
        imported++;
      }
      if (orders.length < pageSize) break;
    }
    if (imported) log(storeCode, `imported ${imported} new order(s)`);
  } catch (err) {
    log(storeCode, `pollOrders error: ${err.message}`);
    logSync(storeCode, 'order_poll', 'error', null, err.message);
  }
}

// Auth/expiry errors surfaced via the Eleme error code → flip the auth latch so
// the daemon backs off and pages ops to re-connect.
function handleApiAuthError(storeCode, err) {
  const code = err.elemeError && (err.elemeError.code || err.elemeError.name || '');
  if (/AUTH|TOKEN|UNAUTHORIZED|EXPIRE/i.test(String(code) + ' ' + err.message)) {
    noteAuth(storeCode, false, err.message);
  }
}

async function ingestOrder(storeId, storeCode, order) {
  try {
    const res = await fetch(`${INTERNAL_BASE}/api/internal/eleme/ingest-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': internalSecret() },
      body: JSON.stringify({ storeId, storeCode, order }),
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

// Resolve the Eleme spec id(s) for a product and set their stock. Caches the
// resolved item_id/spec_id on the map row so we skip the lookup next time. Eleme
// items can be multi-spec; we set every spec under the matched item to the same
// physical qty (single-variant is the common case). Returns { ok, transient }.
async function pushOne(token, shopId, row) {
  // 货号: explicit override on the map row, else the product's own SKU.
  const extendCode = row.extend_code || row.sku;
  if (!extendCode) return { ok: false, transient: false, reason: 'no SKU/extend code' };

  let item = null;
  // Re-use cached ids when present; otherwise resolve by 货号.
  try {
    item = await eleme.product.getItemByExtendCode(token, shopId, extendCode);
  } catch (err) {
    if (err.elemeError && /not.*found|不存在|no.*item/i.test(err.message)) {
      return { ok: false, transient: false, reason: 'no Eleme item for this 货号' };
    }
    return { ok: false, transient: true, reason: err.message };
  }
  if (!item) return { ok: false, transient: false, reason: 'no Eleme item for this 货号' };

  // Collect spec ids from the item shape (probe common field names).
  const specs = item.specs || item.itemSpecs || item.skus || [];
  const specIds = [];
  for (const s of specs) {
    const id = s.specId || s.id || s.skuId;
    if (id != null) specIds.push(id);
  }
  if (!specIds.length && (item.specId || item.id)) specIds.push(item.specId || item.id);
  if (!specIds.length) return { ok: false, transient: false, reason: 'item has no resolvable specId' };

  const stockMap = {};
  for (const id of specIds) stockMap[id] = row.new_qty;
  try {
    await eleme.product.batchUpdateStock(token, stockMap);
  } catch (err) {
    return { ok: false, transient: !err.elemeError, reason: err.message };
  }
  return { ok: true, itemId: item.id || item.itemId || null, specId: specIds[0] };
}

async function processStockQueue(configsByCode, tokens) {
  const rows = db.prepare(`
    SELECT q.*, COALESCE(m.extend_code, NULL) AS extend_code, p.sku AS sku
      FROM eleme_sync_queue q
      LEFT JOIN store_products p ON p.id = q.product_id
      LEFT JOIN eleme_product_map m
             ON m.product_id = q.product_id AND m.retail_store_id = q.retail_store_id
     WHERE q.status = 'pending' AND q.attempts < 3
     ORDER BY q.created_at
     LIMIT 40
  `).all();
  if (!rows.length) return;

  const byStore = {};
  for (const row of rows) (byStore[row.store_code] = byStore[row.store_code] || []).push(row);

  // Stores the operator has CLOSED for the Eleme channel (Sales-page close
  // matrix, channel_status.channel='eleme'). Honour it like Meituan honours its
  // opening hours: skip the push and leave rows pending so stock re-syncs the
  // moment the store is reopened — never silently drops the update.
  let elemeClosed = new Set();
  try { elemeClosed = channelClosedStores('eleme'); } catch (_) {}

  for (const [storeCode, items] of Object.entries(byStore)) {
    if (SKIP_STORES.includes(storeCode)) continue;
    if (elemeClosed.has(storeCode)) continue; // channel closed for this store — hold
    const cfg = configsByCode[storeCode];
    const token = tokens[storeCode];
    if (!cfg || !token) continue; // store not authorised — leave rows pending

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

    for (const row of latest.values()) {
      db.prepare(`UPDATE eleme_sync_queue SET status='processing', attempts=attempts+1 WHERE id=?`).run(row.id);
      const r = await pushOne(token, cfg.shop_id, row);
      if (r.ok) {
        db.prepare(`UPDATE eleme_sync_queue SET status='done', processed_at=CURRENT_TIMESTAMP, last_error=NULL WHERE id=?`).run(row.id);
        db.prepare(`UPDATE eleme_product_map
                       SET last_pushed_qty=?, last_pushed_at=CURRENT_TIMESTAMP,
                           item_id=COALESCE(?, item_id), spec_id=COALESCE(?, spec_id)
                     WHERE retail_store_id=? AND product_id=?`)
          .run(row.new_qty, r.itemId, r.specId, row.retail_store_id, row.product_id);
        logSync(storeCode, 'stock_push', 'ok', { product_id: row.product_id, sku: row.extend_code || row.sku, qty: row.new_qty });
      } else if (r.transient && (row.attempts || 0) < 3) {
        db.prepare(`UPDATE eleme_sync_queue SET status='pending', last_error=? WHERE id=?`)
          .run(`transient: ${String(r.reason).slice(0, 160)}`, row.id);
      } else {
        db.prepare(`UPDATE eleme_sync_queue SET status='error', processed_at=CURRENT_TIMESTAMP, last_error=? WHERE id=?`)
          .run(String(r.reason).slice(0, 200), row.id);
        logSync(storeCode, 'stock_push', 'error', { product_id: row.product_id, sku: row.extend_code || row.sku, qty: row.new_qty }, r.reason);
      }
    }
  }
}

// Heal rows stranded in 'processing' by a mid-batch crash/restart (same pattern as
// the Meituan daemon, minus bundles). Re-enqueue at current physical_qty.
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
  console.log('[eleme-daemon] starting');
  if (!eleme.isConfigured()) {
    // ELEME_APP_KEY / ELEME_APP_SECRET are unset (Eleme ships off-by-default).
    // Do NOT process.exit(1): under pm2 autorestart a non-zero exit triggers a
    // restart STORM, and every boot re-runs require('../database') (full
    // schema + migrations on load) — that churn burns CPU + memory box-wide and
    // can starve the storefront. Park cheaply instead and wait for a restart
    // once the keys are configured.
    console.error('[eleme-daemon] ELEME_APP_KEY / ELEME_APP_SECRET not set — idling (set the keys and restart to activate).');
    for (;;) { await sleep(60_000); }
  }
  recoverOrphanedProcessing();

  let lastOrderPoll = 0;
  let orderPollGap  = jitter(ORDER_POLL_MS, 0.4);
  let lastTokenCheck = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!elemeEnabled()) { await sleep(jitter(QUEUE_CHECK_MS)); continue; }

    const configs = getStoreConfigs();
    const configsByCode = {};
    for (const c of configs) configsByCode[c.store_code] = c;

    // Refresh tokens proactively; build a live token map for this cycle.
    const now = Date.now();
    const tokens = {};
    if (now - lastTokenCheck >= TOKEN_CHECK_MS || !lastTokenCheck) {
      lastTokenCheck = now;
      for (const c of configs) tokens[c.store_code] = await freshAccessToken(c.store_code);
    } else {
      for (const c of configs) {
        const row = getTokenRow(c.store_code);
        tokens[c.store_code] = row ? row.access_token : null;
      }
    }

    // Poll orders on a jittered ~5 min cadence, staggered across stores.
    if (now - lastOrderPoll >= orderPollGap) {
      lastOrderPoll = now;
      orderPollGap  = jitter(ORDER_POLL_MS, 0.4);
      for (let i = 0; i < configs.length; i++) {
        const c = configs[i];
        if (!tokens[c.store_code]) continue;
        await pollOrders(c, tokens[c.store_code]);
        if (i < configs.length - 1) await sleep(jitter(4000, 0.5));
      }
    }

    await processStockQueue(configsByCode, tokens);
    await sleep(jitter(QUEUE_CHECK_MS));
  }
}

process.on('SIGINT',  () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(err => {
  console.error('[eleme-daemon] fatal:', err);
  process.exit(1);
});
