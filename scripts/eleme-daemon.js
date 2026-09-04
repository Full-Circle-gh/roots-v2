// Eleme (饿了么) sync daemon — runs as a separate pm2 process.
//
// Eleme's official OpenAPI rejects our single-store accounts ("暂不支持该账户登录"
// — see ELEME_BROWSER_RECON.md), so — like the Meituan 外卖 daemon — this drives a
// headless Playwright session against the merchant backend (lib/eleme-browser.js)
// instead of holding an OAuth access_token. lib/eleme-client.js (the old OAuth
// client) is dead; nothing in this file calls it any more.
//
// Every ~10s: drain eleme_sync_queue → push stock changes to Eleme via the browser.
// Every ~5min per store: read the order list and mirror new orders into roots.
//
// ORDER COLLECTION (Tier 0 + Tier 1) — what this reads, and what it deliberately
// does not, because every extra request is detection surface:
//
//   Tier 0, free: everything in the order list the poll reads anyway — order id
//     and 流水号, real placed-at time, status label, delivery ETA, 预订单 window,
//     customer note, cutlery, per-line names/qty/prices, and the address/phone
//     ALREADY MASKED by Eleme (隐私号). No extra call for any of it.
//   Tier 1, one call per NEW order: the order-detail read, which a merchant's own
//     UI fires when a card is opened — so our call rate tracks the real order
//     rate. Adds the money split Eleme won't put in the list (merchant income
//     after commission, platform-vs-merchant discount, packaging/delivery fees).
//     Never fires on a re-poll of an order we already have.
//
// Cancels and refunds are read too, from the queue the merchant page already
// polls (a voided order LEAVES the in-process list, so the list alone can never
// see one). Confirmed voids return their stock through the ledgered adjuster; see
// routes/eleme-internal.js for the once-only / re-deduct guards.
//
// NOT collected, on purpose: anything that UN-MASKS a customer (the real number
// behind the 隐私号, the full address, the name) — Eleme audits those reads per
// view and an automated pattern is exactly what that audit is for, and it is a
// PIPL problem regardless of detection; bulk export endpoints; deep history
// backfills; reviews and market/competitor analytics. None of it is needed to
// mirror an order.
//
// The recon captured the order RPC method NAMES and no payloads, so the reader in
// lib/eleme-browser.js prefers to READ WHAT THE PAGE ITSELF FETCHES rather than
// issue its own call — see the rung ladder there. Shape probing is off unless
// ELEME_ORDER_PROBE=1.
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
//
// Order-related env (all optional):
//   ELEME_ORDER_POLL=0            turn order polling off entirely
//   ELEME_ORDER_TIER1=0           order list only, skip the per-order detail read
//   ELEME_ORDER_PROBE=1           allow the last-resort request-shape probe
//   ELEME_ORDER_DETAIL_METHOD=…   name the detail RPC once it's been observed
//   ELEME_MONEY_SCALE=yuan|fen    pin the wire money unit (default: auto-detect)

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
// Per-store opening hours. A merchant backend that keeps refreshing at 4am is
// itself a bot tell, so order polling sleeps when the shop is shut. Stores with no
// hours on file come back null → treated as always-open, so a new store is never
// silently muted.
const { storeHours, within, syncWindow, envLeadMin } = require('../lib/store-hours');
const { packQty } = require('../lib/pack-units');
// Ops-alert latches that survive a restart (see lib/alert-latch).
const { latchStore } = require('../lib/alert-latch');
// Level-triggered backstop for this edge-triggered queue. See below.
const { sweepStockDrift, ELEME: DRIFT_ELEME } = require('../lib/channel-drift-sweep');

const QUEUE_CHECK_MS = 10_000; // stock push cadence
const ORDER_POLL_MS  = 300_000; // per-store order read, jittered ±40% (matches meituan-daemon)
const ORDER_POLL_ON  = process.env.ELEME_ORDER_POLL !== '0';
const TIER1_DETAIL   = process.env.ELEME_ORDER_TIER1 !== '0';
const OPEN_GRACE_MIN = 30;      // poll a little either side of opening hours
// Sync starts this far before opening when the store has no explicit
// "Sync starts · 同步开始" time on its row. Unset → the shared default in
// lib/store-hours (2 h). Eleme pre-orders are placed well before the doors open,
// and stock they were quoted from yesterday's numbers is an oversell.
const PREOPEN_LEAD_MIN = envLeadMin(process.env.ELEME_PREOPEN_LEAD_MIN);
const INTERNAL_PORT  = process.env.PORT || 3000;
const INTERNAL_BASE  = `http://127.0.0.1:${INTERNAL_PORT}`;
// Order polling has been failing this long before it pages anyone — roughly six
// missed polls, so a proxy blip or a single browser relaunch stays quiet.
const ORDER_DOWN_AFTER_MS = 30 * 60_000;
// Stock-drift backstop. This queue is edge-triggered — one row per change — so a
// push that dies terminally (processStockQueue's status='error' branch below)
// leaves that product frozen on Eleme with nothing left to retry it: the drain
// reads only pending rows, the orphan sweep only 'processing', and the admin
// merely counts the errors. This sweep re-reads actual stock against what Eleme
// last accepted (eleme_product_map.last_pushed_qty) and re-enqueues the gap, no
// matter why the earlier push failed. Cheap — a couple of indexed reads, NO
// BROWSER — and self-limiting: see the cool-down and cap in
// lib/channel-drift-sweep. 30 min is well inside a trading day.
const DRIFT_SWEEP_MS = 1_800_000; // 30 min
// Time-based delivered flip, same cadence and same rule as meituan-daemon's. Our
// order read is the IN-PROGRESS tab, so an order that completes drops off the
// list before we ever see a 已完成 label and nothing afterwards can advance it.
// Pure server-side SQL — no browser — so it runs whatever the stores are doing.
const DELIVER_SWEEP_MS = 1_800_000; // 30 min

function internalSecret() {
  return process.env.ELEME_INTERNAL_SECRET || 'eleme-daemon-internal';
}

// Self-expiring manual override, for verifying a read outside opening hours.
// Counts from daemon START and reverts on its own, so there is no way to leave a
// 24/7 poll running by accident — which would itself be a bot tell. Same shape as
// meituan-daemon MEITUAN_FORCE_OPEN_MINUTES. Harmless when unset.
const FORCE_OPEN_UNTIL = Number(process.env.ELEME_FORCE_OPEN_MINUTES) > 0
  ? Date.now() + Number(process.env.ELEME_FORCE_OPEN_MINUTES) * 60_000
  : 0;

// Inside the store's SYNC window — its opening hours widened at the front by the
// store's own "Sync starts · 同步开始" time (or the default pre-open lead), so the
// morning's pre-orders are quoted off live stock. openGraceMin: 0 because
// syncWindow has already folded the front grace into its start.
function isStoreOpen(storeCode, now = new Date()) {
  if (FORCE_OPEN_UNTIL && now.getTime() < FORCE_OPEN_UNTIL) return true;
  const win = syncWindow(storeHours(storeCode), { leadMin: PREOPEN_LEAD_MIN, graceMin: OPEN_GRACE_MIN });
  return within(win, { openGraceMin: 0, closeGraceMin: OPEN_GRACE_MIN, now });
}

// Bounded JSON for the columns we archive — a raw order payload is unbounded in
// principle and this table is kept forever.
function safeJson(value, cap = 20000) {
  if (value == null) return null;
  try {
    const s = JSON.stringify(value);
    return s.length > cap ? s.slice(0, cap) : s;
  } catch { return null; }
}

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

// Order polling down. Deliberately slower to fire than the login/verify latches
// above: those detect a state a human must fix, this one mostly catches transient
// network/browser trouble that heals itself, so it waits ORDER_DOWN_AFTER_MS of
// unbroken failure before paging.
const lastOrderPollOk = {};

function noteOrderPollResult(storeCode, ok, errMsg) {
  const key = 'order_poll_down:' + storeCode;
  const now = Date.now();
  if (ok) {
    lastOrderPollOk[storeCode] = now;
    if (alerts[key]) {
      alerts[key] = false;
      logSync(storeCode, 'order_poll_recovered', 'ok', null, 'Eleme order polling recovered');
      sendOpsAlert(`✅ 饿了么 ${storeCode} 订单读取已恢复\nEleme ${storeCode} order polling recovered`);
    }
    return;
  }
  if (!lastOrderPollOk[storeCode]) { lastOrderPollOk[storeCode] = now; return; }
  if (now - lastOrderPollOk[storeCode] < ORDER_DOWN_AFTER_MS) return;
  if (alerts[key]) return;
  alerts[key] = true;
  logSync(storeCode, 'order_poll_down', 'error', null, errMsg || 'Eleme order polling failing');
  sendOpsAlert(`🔴 饿了么 ${storeCode} 订单已超过30分钟读取失败，新订单可能未入库\nEleme ${storeCode} order polling has been failing for 30+ min — new orders may not be mirrored`);
}

// ── Order polling ────────────────────────────────────────────────────────────

// The first payload of each kind, structure only (values stripped by
// shapeDigest), written to the sync log once per process. This is the artefact
// that closes the recon's open TODO: the first live order prints Eleme's real
// field names, so the candidate-key lists in lib/eleme-browser.js can be replaced
// with the actual ones instead of another capture session.
const shapeLogged = {};
function logOrderShapes(storeCode, browser) {
  for (const kind of ['list', 'detail', 'void']) {
    const key = storeCode + ':' + kind;
    const digest = browser.orderShapes && browser.orderShapes[kind];
    if (!digest || shapeLogged[key]) continue;
    shapeLogged[key] = true;
    logSync(storeCode, 'order_shape', 'ok', { kind, digest });
    log(storeCode, `${kind} payload shape recorded to eleme_sync_log (${digest.length} chars)`);
  }
  // The request side, once per process. Values kept (query params, no customer
  // data) — this is what shows the real tab/queryType a replay had to fill blind.
  const rqKey = storeCode + ':requests';
  if (!shapeLogged[rqKey]) {
    const snap = browser.orderRequestSnapshot ? browser.orderRequestSnapshot() : null;
    if (snap && Object.keys(snap).length) {
      shapeLogged[rqKey] = true;
      logSync(storeCode, 'order_rpc_requests', 'ok', {
        params: snap,
        responsesCaptured: browser._orderRpcResult ? Array.from(browser._orderRpcResult.keys()) : [],
        responsesUnusable: browser._orderRpcSkip ? Object.fromEntries(browser._orderRpcSkip) : {},
      });
      log(storeCode, `observed ${Object.keys(snap).length} order RPC request body/bodies → eleme_sync_log`);
    }
  }
}

// Everything the order carries that has no retail_orders column of its own —
// archived beside the import row so a wrong ELEME_MONEY_SCALE guess, or a later
// margin question, is answerable from stored data instead of a re-read.
function archiveFields(order) {
  return {
    daySeq: order.daySeq,
    moneyDivisor: order.moneyDivisor,
    // Which field said where the order was. The status equivalent of
    // totalKeyPath below, and archived for the same reason: "VALID" sat in
    // channel_status on every Eleme order for months and nothing recorded that
    // it had been read off an order-validity flag rather than a lifecycle field.
    statusKeyPath: order.statusKeyPath || null,
    statusIsStage: order.statusIsStage !== false,
    // Which payload field the order total was read out of, and what the LINES
    // said the basket was worth. Stored because the two disagreeing is the whole
    // of the EL20260901417897 bug and neither number, on its own, could say why.
    totalKeyPath: order.totalKeyPath,
    // The same question for the other five money fields. A settlement that
    // doesn't reconcile is diagnosable only if each term can say which payload
    // field it came out of — see the moneyKeyPaths note in lib/eleme-browser.js.
    moneyKeyPaths: order.moneyKeyPaths || null,
    channelTotal: order.total,
    itemsTotal: order.itemsTotal,
    merchantIncome: order.merchantIncome,
    commission: order.commission,
    platformSubsidy: order.platformSubsidy,
    shopDiscount: order.shopDiscount,
    packagingFee: order.packagingFee,
    deliveryFee: order.deliveryFee,
    refundDesc: order.refundDesc,
    // Both already masked by Eleme — kept for rider contact / routing, never
    // un-masked (see the Tier 3 note in the file header).
    addressMasked: order.addressMasked,
    phoneMasked: order.phoneMasked,
    detail: order.rawDetail || null,
  };
}

async function pollOrders(cfg) {
  const storeCode = cfg.store_code;
  const storeId   = cfg.store_id;
  let browser;
  try {
    browser = await getBrowser(storeCode, cfg.shop_id);
    const orders = await browser.getPendingOrders();

    noteLoginResult(storeCode, browser.loggedIn);
    noteVerifyResult(storeCode, browser.verificationRequired);
    logOrderShapes(storeCode, browser);
    // A challenge isn't a poll failure — it's already alerted on its own latch,
    // and counting it here would page twice for one cause.
    if (!browser.verificationRequired) noteOrderPollResult(storeCode, true);

    for (const order of orders) {
      if (!order.elemeOrderId) continue;

      const existing = db.prepare(
        'SELECT id FROM eleme_order_import WHERE eleme_order_id = ?'
      ).get(order.elemeOrderId);
      if (existing) {
        // Already mirrored — keep Eleme's status label current and move on. No
        // detail read: Tier 1 is once per order, not once per poll.
        await refreshOrderStatus(storeCode, order);
        continue;
      }

      log(storeCode, `new order ${order.elemeOrderId}`);

      // Tier 1 — the one extra call, and only for an order we've never seen.
      if (TIER1_DETAIL) {
        try {
          const detail = await browser.getOrderDetail(order.elemeOrderId);
          if (detail) browser.mergeOrderDetail(order, detail);
        } catch (e) {
          log(storeCode, `order detail read failed for ${order.elemeOrderId}: ${e.message}`);
        }
      }

      const rootsOrderId = await ingestOrder(storeId, storeCode, order);

      db.prepare(`
        INSERT OR IGNORE INTO eleme_order_import
          (eleme_order_id, retail_order_id, store_code, status, raw_payload, detail_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(order.elemeOrderId, rootsOrderId || null, storeCode,
             rootsOrderId ? 'imported' : 'error',
             safeJson(order.raw), safeJson(archiveFields(order)));

      logSync(storeCode, 'order_import', rootsOrderId ? 'ok' : 'error',
        { elemeOrderId: order.elemeOrderId, rootsOrderId, items: (order.items || []).length,
          // Both money readings, in the line that is already written for every
          // import. The import log is the first place anyone looks when an order
          // reads wrong, and "the total was ¥17.50" was never the useful half of
          // that sentence on its own.
          total: order.total, itemsTotal: order.itemsTotal,
          totalKeyPath: order.totalKeyPath, status: order.statusDesc,
          statusKeyPath: order.statusKeyPath });
    }

    // Voids. These have dropped OUT of the list above, so they are read from the
    // refund/exception queue and pushed through the same status refresh — which is
    // what actually returns the stock. Only orders we already mirror are touched;
    // a void for an order we never imported has nothing to give back.
    await pollVoidedOrders(storeCode, browser);
  } catch (err) {
    log(storeCode, `pollOrders error: ${err.message}`);
    logSync(storeCode, 'order_poll', 'error', null, err.message);
    noteOrderPollResult(storeCode, false, err.message);
  }
}

// Read Eleme's refund/exception queue and refresh any of those orders we hold.
// The refresh endpoint decides whether a label is a CONFIRMED void and does the
// restock; this only has to deliver the label. Best-effort — never breaks the poll.
async function pollVoidedOrders(storeCode, browser) {
  let voided = [];
  try {
    voided = await browser.getVoidedOrders();
  } catch (e) {
    log(storeCode, `getVoidedOrders failed: ${e.message}`);
    return;
  }
  if (!voided.length) return;

  let touched = 0;
  for (const order of voided) {
    if (!order.elemeOrderId || !order.statusDesc) continue;
    const held = db.prepare(
      'SELECT retail_order_id FROM eleme_order_import WHERE eleme_order_id = ?'
    ).get(order.elemeOrderId);
    if (!held || !held.retail_order_id) continue; // never mirrored — nothing to undo
    await refreshOrderStatus(storeCode, order);
    touched++;
  }
  if (touched) log(storeCode, `refund/exception queue: refreshed ${touched} of ${voided.length} order(s)`);
}

// Create the order + deduct stock through the internal API (localhost only).
// Returns the new retail_order.id, or null on failure.
async function ingestOrder(storeId, storeCode, order) {
  try {
    const res = await fetch(`${INTERNAL_BASE}/api/internal/eleme/ingest-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': internalSecret() },
      body: JSON.stringify({ storeId, storeCode, order }),
    });
    if (!res.ok) {
      log(storeCode, `ingestOrder HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    return data.orderId || null;
  } catch (err) {
    log(storeCode, `ingestOrder fetch error: ${err.message}`);
    return null;
  }
}

// Mark any mirrored Eleme order delivered once it is an hour past the ETA Eleme
// itself promised. The endpoint carries the reasoning; here it is one call for
// every store at once, touching no browser. Best-effort — never breaks the loop.
async function autoDeliverPastEta() {
  try {
    const res = await fetch(`${INTERNAL_BASE}/api/internal/eleme/auto-deliver-past-eta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': internalSecret() },
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.delivered) log('all', `auto-delivered ${data.delivered} order(s) past ETA+1h`);
    }
  } catch (err) { log('all', `autoDeliverPastEta error: ${err.message}`); }
}

// Refresh an already-mirrored order's Eleme status label (server-side no-op when
// nothing changed). Best-effort — a failed refresh must never break the poll.
async function refreshOrderStatus(storeCode, order) {
  if (!order.statusDesc) return;
  try {
    const res = await fetch(`${INTERNAL_BASE}/api/internal/eleme/update-order-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': internalSecret() },
      // The platform-owned extras ride along too, so an order mirrored before this
      // build parsed them backfills itself instead of staying permanently blank.
      body: JSON.stringify({
        elemeOrderId: order.elemeOrderId, statusDesc: order.statusDesc, eta: order.eta,
        // Which payload field the label came out of, and whether that field
        // names a lifecycle stage at all. Only ever logged, never stored on the
        // order — it is what makes an unreadable label diagnosable without
        // re-reading the order off the platform.
        statusKeyPath: order.statusKeyPath, statusIsStage: order.statusIsStage,
        preOrderAt: order.preOrderAt, note: order.note,
        needsCutlery: order.needsCutlery, placedAt: order.placedAt,
        // The economics, when the LIST row carries them (no Tier 1 read happens
        // on a refresh). Fills a blank only, so this heals an order imported
        // before those columns were written and never touches one that has them.
        // shopDiscount rides along for the same reason: it is the term that makes
        // subtotal + packing + shipping - discount equal the order's own total,
        // and every order mirrored before this build has it recorded nowhere.
        merchantIncome: order.merchantIncome, commission: order.commission,
        shopDiscount: order.shopDiscount,
      }),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.changed) log(storeCode, `order ${order.elemeOrderId} status → ${order.statusDesc}`);
      // Stock moving on a void is worth its own line: it is the one thing here
      // that changes inventory rather than just a label.
      if (data.restocked) {
        log(storeCode, `order ${order.elemeOrderId} voided — returned ${data.restocked} line(s) to stock`);
        logSync(storeCode, 'order_void_restock', 'ok',
          { elemeOrderId: order.elemeOrderId, statusDesc: order.statusDesc, lines: data.restocked });
      }
      if (data.rededucted) {
        log(storeCode, `order ${order.elemeOrderId} revived — re-deducted ${data.rededucted} line(s)`);
        logSync(storeCode, 'order_void_rededuct', 'ok',
          { elemeOrderId: order.elemeOrderId, statusDesc: order.statusDesc, lines: data.rededucted });
      }
    }
  } catch (err) { log(storeCode, `refreshOrderStatus error: ${err.message}`); }
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

  // One row per CLAIM: a product that holds several options of one listing (a
  // multipack — 1瓶 / 3瓶 / 6瓶 of the same bottle, each its own stock box on
  // Eleme) fans a single queue row out into one push per box. The queue row's
  // own verdict is then decided once from all of them.
  const rows = db.prepare(`
    SELECT q.*, p.name_cn, p.name_en,
           COALESCE(m.extend_code, p.sku) AS sku,
           m.id         AS map_id,
           m.eleme_name AS map_eleme_name,
           m.spec_id    AS map_spec_id,
           m.spec_name  AS map_spec_name,
           COALESCE(m.units_per_pack, 1) AS map_units
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

    // Collapse to the latest qty per target, where the target is the stock box —
    // collapsing on the product alone would push one of a multipack's boxes and
    // silently drop the rest.
    const latest = new Map();
    const superseded = [];
    for (const row of items) {
      const key = row.map_id ? `p:${row.product_id}:m${row.map_id}` : `p:${row.product_id}`;
      const prev = latest.get(key);
      if (prev) superseded.push(prev);
      latest.set(key, row);
    }
    const pushRows = Array.from(latest.values());
    // Retire a superseded queue row only if NO surviving push still rides on it:
    // one queue row now feeds several pushes, and an older row that lost one box
    // to a newer row may still own the others.
    const liveQueueIds = new Set(pushRows.map(r => r.id));
    for (const row of superseded) {
      if (liveQueueIds.has(row.id)) continue;
      db.prepare(`UPDATE eleme_sync_queue SET status='done', processed_at=CURRENT_TIMESTAMP, last_error='superseded' WHERE id=?`).run(row.id);
    }

    let browser;
    try {
      browser = await getBrowser(storeCode, cfg.shop_id);

      // Once per QUEUE row — pushRows can hold the same row several times (one
      // per claimed box), and counting each as an attempt would burn the retry
      // budget in a single cycle.
      for (const id of new Set(pushRows.map(r => r.id))) {
        db.prepare(`UPDATE eleme_sync_queue SET status='processing', attempts=attempts+1 WHERE id=?`).run(id);
      }

      // Eleme has no extCode/货号 to match on yet (ELEME_BROWSER_RECON.md), so a
      // product only resolves by NAME — prefer the operator-confirmed Eleme
      // listing name (eleme_product_map.eleme_name) over the raw Roots name,
      // the same override meituan-daemon.js honours for the identical reason.
      const batchItems = pushRows.map(row => ({
        row, targetCn: row.map_eleme_name || row.name_cn, targetEn: row.name_en, sku: row.sku,
        // What this box can sell, not what the shelf holds: a 6-bottle option fed
        // the raw count would offer 40 six-packs off 40 bottles.
        newQty: packQty(row.new_qty, row.map_units),
        // Which size inside that listing, when the operator picked one. Without
        // it a multi-size listing falls back to a guess that fabricates stock.
        specGlobalId: row.map_spec_id || null,
      }));
      const results = await browser.batchUpdateStock(batchItems);

      noteLoginResult(storeCode, browser.loggedIn);
      noteVerifyResult(storeCode, browser.verificationRequired);
      const challenged = browser.verificationRequired;

      // Record what each BOX did, then decide each QUEUE ROW once: a row that fed
      // three boxes is only done when all three took the number, and must stay
      // pending if any of them still needs another go.
      const verdicts = new Map(); // queue row id -> { row, ok, transient, reason }
      for (const res of results) {
        const { row, newQty, ok, transient } = res;
        const v = verdicts.get(row.id) || { row, ok: true, transient: false, reason: null };
        v.ok = v.ok && !!ok;
        if (!ok && transient) v.transient = true;
        // First refusal that explained itself speaks for the row. A row feeding
        // three boxes could in principle collect several; the first is the one
        // an operator needs, and they are the same sentence in practice.
        if (!ok && res.reason && !v.reason) v.reason = res.reason;
        verdicts.set(row.id, v);
        if (ok && row.map_id) {
          // item_id has existed since the table was created (database.js) as the
          // "cached Eleme item id" and was NULL on every row, written by nothing.
          // It is the column §30 rule 7 asks for, so it is finally filled: WHICH
          // listing this push landed on, not merely that one succeeded.
          //
          // COALESCE so a push that somehow arrives without an id leaves the
          // last known one standing rather than blanking it — a missing value is
          // not evidence that the old one was wrong.
          db.prepare(`UPDATE eleme_product_map
                         SET last_pushed_qty=?, last_pushed_at=CURRENT_TIMESTAMP,
                             item_id = COALESCE(?, item_id)
                       WHERE id=?`)
            .run(newQty, res.targetItemId || null, row.map_id);
        }
        if (ok) {
          // The map columns are last-write-wins and carry no history, so the map
          // alone can never answer a question about a PAST push — which is
          // exactly what finding 9 ran into. The log is the half that keeps it.
          logSync(storeCode, 'stock_push', 'ok', {
            product_id: row.product_id, sku: row.sku, qty: newQty,
            spec: row.map_spec_name || null, units: Number(row.map_units) || 1,
            target_name: res.targetName || null, target_item_id: res.targetItemId || null,
          });
        }
      }

      for (const res of Array.from(verdicts.values())) {
        const { row, ok, transient, reason } = res;
        // The shelf count, not one box's share of it: this verdict covers every
        // box the row fed, and naming one of their numbers would read as the
        // whole row's.
        const newQty = row.new_qty;
        if (ok) {
          db.prepare(`UPDATE eleme_sync_queue SET status='done', processed_at=CURRENT_TIMESTAMP, last_error=NULL WHERE id=?`).run(row.id);
        } else if (challenged) {
          // Deferred by risk-control, not a real failure — requeue and refund the
          // attempt so it retries once cleared (no burned attempts).
          db.prepare(`UPDATE eleme_sync_queue SET status='pending', attempts=attempts-1 WHERE id=?`).run(row.id);
        } else if (transient && (row.attempts || 0) + 1 < 3) {
          // row.attempts is the PRE-increment value from the SELECT above (the
          // UPDATE that bumped it doesn't mutate this in-memory row) — +1 checks
          // whether the count the retry query will actually see next time is
          // still under the cap. Without it, a row's 3rd attempt (attempts now
          // really 3) kept re-marking 'pending' here, but status='pending' AND
          // attempts<3 never selects it again — stuck forever, invisible to both
          // the retry query and the terminal-error branch below.
          db.prepare(`UPDATE eleme_sync_queue SET status='pending', last_error='transient push failure — will retry' WHERE id=?`).run(row.id);
        } else {
          // `reason` is a refusal that explained itself — today that is a name
          // the catalogue does not carry. It reaches BOTH places an operator can
          // read: last_error on the queue row, and error_msg on the sync log,
          // which the Eleme tab's push panel renders in red
          // (public/retail-admin/14-eleme.js elRenderPushLog).
          //
          // It also arrives on the FIRST attempt rather than the third. An
          // unresolvable name is not transient, so it never enters the retry
          // branch above, and the row no longer spends ~36 seconds pretending a
          // config error might be a network blip.
          //
          // The bilingual pairs below are unchanged; the new sentence is English
          // on both sides because no Chinese for it exists yet and §30 rule 3
          // forbids composing one.
          const why = transient ? 'transient push failure — retries exhausted'
                                : (reason || 'browser update failed');
          db.prepare(`UPDATE eleme_sync_queue SET status='error', processed_at=CURRENT_TIMESTAMP, last_error=? WHERE id=?`)
            .run(why, row.id);
          logSync(storeCode, 'stock_push', 'error', { product_id: row.product_id, sku: row.sku, qty: newQty },
            transient ? 'update failed after retries · 多次重试仍失败'
                      : (reason || 'browser update failed · 更新失败'));
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

// Heal rows stranded in 'processing' by a mid-batch crash/restart. Called at
// startup AND periodically from the main loop (see ORPHAN_SWEEP_MS below) —
// startup-only isn't enough: this box runs several other daemons and deploys
// land constantly, and a crash that happens well after boot (confirmed live,
// 2026-08-23 — an unrelated concurrent deploy bounced pm2 mid-batch) leaves
// rows stuck in 'processing' with NO further restart to trigger recovery,
// silently invisible to both the retry query and the terminal-error path.
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

const ORPHAN_SWEEP_MS = 5 * 60_000; // matches the "stale after 5 min" threshold above
let lastOrphanSweep = 0;

// 0, not Date.now(): the sweep runs on the FIRST tick after start. A daemon that
// has just come up after a crash or a deploy is exactly when the queue is most
// likely to hold terminally-failed rows nothing else will ever look at, so making
// it wait half an hour to find out would be backwards.
let lastDriftSweep = 0;
let lastDeliverSweep = 0;

// ── Catalogue cache (feeds the admin's Eleme-name autocomplete) ─────────────
// Eleme's live catalogue only exists inside THIS process's browser session —
// the admin server can't fetch it without driving a second, competing login.
// Refresh a DB copy periodically instead; the admin API just reads that.
const CATALOGUE_REFRESH_MS = 30 * 60_000;
let lastCatalogueRefresh = 0;
// storeCode → epochMs the next order poll is due. Empty at boot, so every store
// polls once immediately and then settles onto its own jittered cadence.
const nextOrderPollAt = {};

async function refreshCatalogueCache(configs) {
  for (const cfg of configs) {
    try {
      const browser = await getBrowser(cfg.store_code, cfg.shop_id);
      const names = await browser.listFoods();
      if (!names) { log(cfg.store_code, 'catalogue cache refresh skipped (not logged in / nav failed)'); continue; }
      const snap = browser.catalogueSnapshot();
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM eleme_catalogue_cache WHERE store_code = ?').run(cfg.store_code);
        const ins = db.prepare(`
          INSERT INTO eleme_catalogue_cache (store_code, name, item_global_id, stock, specs, updated_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);
        // specs = every size behind this listing name, so the admin can offer a
        // "which size" picker without driving its own browser login.
        for (const it of snap) {
          ins.run(cfg.store_code, it.name, it.itemGlobalId, it.stock,
                  (it.specs && it.specs.length) ? JSON.stringify(it.specs) : null);
        }
      });
      tx();
      log(cfg.store_code, `catalogue cache refreshed: ${snap.length} item(s)`);
    } catch (e) {
      log(cfg.store_code, `catalogue cache refresh failed: ${e.message}`);
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('[eleme-daemon] starting (browser automation — see ELEME_BROWSER_RECON.md)');
  console.log(ORDER_POLL_ON
    ? `[eleme-daemon] order polling on (~${Math.round(ORDER_POLL_MS / 60000)} min/store, Tier 1 detail ${TIER1_DETAIL ? 'on' : 'off'})`
    : '[eleme-daemon] order polling disabled (ELEME_ORDER_POLL=0)');
  recoverOrphanedProcessing();
  lastOrphanSweep = Date.now();

  while (true) {
    if (Date.now() - lastOrphanSweep >= ORPHAN_SWEEP_MS) {
      recoverOrphanedProcessing();
      lastOrphanSweep = Date.now();
    }
    if (!elemeEnabled()) { await sleep(jitter(QUEUE_CHECK_MS)); continue; }

    const configs = getStoreConfigs();
    if (Date.now() - lastCatalogueRefresh >= CATALOGUE_REFRESH_MS) {
      lastCatalogueRefresh = Date.now();
      await refreshCatalogueCache(configs); // runs before the queue check so a first-boot admin visit isn't empty for 30 min
    }
    // Order poll — per store, on its own jittered ~5 min schedule, independent of
    // the 10s stock-queue tick. Gated on opening hours only, NOT on the channel
    // close switch: closing the channel stops new orders arriving on Eleme but
    // must not strand the ones already in flight.
    if (ORDER_POLL_ON) {
      for (const cfg of configs) {
        const code = cfg.store_code;
        if (Date.now() < (nextOrderPollAt[code] || 0)) continue;
        if (!isStoreOpen(code)) { nextOrderPollAt[code] = Date.now() + jitter(ORDER_POLL_MS, 0.4); continue; }
        nextOrderPollAt[code] = Date.now() + jitter(ORDER_POLL_MS, 0.4);
        await pollOrders(cfg);
      }
    }

    // Level-triggered backstop for the edge-triggered queue: re-enqueue anything
    // whose stock no longer matches what Eleme last accepted. Runs BEFORE the push
    // so recovered rows go out in this same cycle.
    //
    // Deliberately NOT gated on opening hours or on the channel close switch. It
    // touches no browser, so there is no bot-footprint reason to sleep it, and the
    // rows it writes are just pending work: processStockQueue's own
    // channelClosedStores('eleme') gate holds them until the store reopens rather
    // than dropping them. Gating the sweep instead would mean a store that closed
    // mid-incident came back with its drift still unrecorded and unqueued.
    //
    // configs is already this daemon's own stores — getStoreConfigs applies
    // ELEME_SKIP_STORES and requires a linked eleme_shops.shop_id.
    if (Date.now() - lastDriftSweep >= DRIFT_SWEEP_MS) {
      lastDriftSweep = Date.now();
      sweepStockDrift(db, DRIFT_ELEME, {
        storeCodes: configs.map(c => c.store_code),
        log, logSync, sendOpsAlert, alerts,
      });
    }

    // Orders that completed after dropping off the in-progress list. Not gated on
    // opening hours or on the channel close switch, for the same reason as the
    // drift sweep above: no browser is touched, and an order left non-terminal
    // because the shop shut is exactly the one this is for.
    if (Date.now() - lastDeliverSweep >= DELIVER_SWEEP_MS) {
      lastDeliverSweep = Date.now();
      await autoDeliverPastEta();
    }

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
