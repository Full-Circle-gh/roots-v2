// 青云聚信 (Qingyun) delivery-tracking daemon — separate pm2 process.
//
// 青云聚信 is Meituan's delivery AGGREGATOR (saas.cyanclouds.com). This daemon ATTACHES
// over CDP to a genuine Chrome (scripts/qingyun-chrome.js, headful under Xvfb, GZ
// proxy) and reads each in-flight delivery's status + live rider GPS via the portal's
// signed APIs, mirroring it into delivery_jobs so the customer order-tracking endpoint
// can relay status + a live map. READ-ONLY: staff still dispatch couriers by hand in
// the app; we never dispatch/cancel here.
//
// Status enums (raw Qingyun): orderStatus 20 待配送 → 30 in-flight → 50 已送达;
// deliveryStatus parallels. rider_lat/lng are GCJ-02 ×1e6 and go NULL once delivered.
//
// Start: pm2 start scripts/qingyun-daemon.js --name qingyun-sync
// Logs:  pm2 logs qingyun-sync
// Re-login: scan the QR in the genuine Chrome (see scripts/qingyun-chrome.js).

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
const { getQingyunBrowser, closeAllQingyun } = require('../lib/qingyun-browser');
const { sendOpsAlert } = require('../lib/ops-alert');

const STORES = (process.env.QINGYUN_STORES || 'tianhe')
  .split(',').map(s => s.trim()).filter(Boolean);

const POLL_MS = Number(process.env.QINGYUN_POLL_MS || 25_000); // ~25s (jittered)
const DELIVERED_STATUS = 50; // orderStatus once 已送达

function jitter(baseMs, frac = 0.3) {
  const spread = baseMs * frac;
  return Math.round(baseMs - spread + Math.random() * spread * 2);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(storeCode, msg) {
  console.log(`[qingyun-daemon:${storeCode}] ${new Date().toISOString()} ${msg}`);
}
function logSync(storeCode, eventType, status, detail, errorMsg) {
  try {
    db.prepare(`INSERT INTO qingyun_sync_log (store_code, event_type, status, detail, error_msg)
                VALUES (?, ?, ?, ?, ?)`)
      .run(storeCode, eventType, status, detail ? JSON.stringify(detail) : null, errorMsg || null);
  } catch { /* logging must never throw */ }
}
// Per-store heartbeat so the admin Delivery card shows a truthful status even when
// a connected store simply has no active deliveries (which log no polls). One row
// per store, upserted each poll — bounded.
function heartbeat(storeCode, loggedIn) {
  try {
    db.prepare(`INSERT INTO qingyun_status (store_code, logged_in, last_ok, updated_at)
                VALUES (@s, @li, CASE WHEN @li = 1 THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP)
                ON CONFLICT(store_code) DO UPDATE SET
                  logged_in  = @li,
                  last_ok    = CASE WHEN @li = 1 THEN CURRENT_TIMESTAMP ELSE qingyun_status.last_ok END,
                  updated_at = CURRENT_TIMESTAMP`)
      .run({ s: storeCode, li: loggedIn ? 1 : 0 });
  } catch { /* heartbeat must never throw */ }
}

// ── Proxy health gate (mirrors shangou-daemon) ────────────────────────────────
// The genuine Chrome reaches Meituan through the same GZ proxy. If that proxy
// TCP-accepts but can't complete upstream requests, every page fetch fails and the
// daemon MISREADS it as "needs login". Gate the loop on a cheap curl probe. Direct
// mode (no proxy) is always healthy → no-op.
const PROXY = process.env.QINGYUN_PROXY_UPSTREAM != null
  ? process.env.QINGYUN_PROXY_UPSTREAM
  : (process.env.MEITUAN_PROXY_URL || '');
function proxyHealthy(timeoutSec = 8) {
  if (!PROXY) return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile('curl',
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-x', PROXY,
       '--max-time', String(timeoutSec), 'https://saas.cyanclouds.com/'],
      { timeout: (timeoutSec + 4) * 1000 },
      (_err, stdout) => {
        const code = parseInt(String(stdout).trim(), 10) || 0;
        resolve(code >= 200 && code < 600);
      });
  });
}
function maskProxy(u) { return String(u || '').replace(/:[^:@/]+@/, ':****@'); }
let proxyDownFlagged = false;

// ── 验证中心 / login backoff (mirrors shangou-daemon) ──────────────────────────
const VERIFY_COOLDOWN_BASE_MS = 30 * 60_000;
const VERIFY_COOLDOWN_MAX_MS  = 4 * 60 * 60_000;
const verifyState   = {};
const verifyFlagged = {};
function inVerifyCooldown(storeCode, now = Date.now()) {
  const s = verifyState[storeCode];
  return !!(s && s.until && now < s.until);
}
function noteVerifyResult(storeCode, challenged) {
  const s = verifyState[storeCode] || (verifyState[storeCode] = { until: 0, strikes: 0 });
  if (challenged) {
    s.strikes = Math.min(s.strikes + 1, 8);
    const wait = Math.min(VERIFY_COOLDOWN_BASE_MS * 2 ** (s.strikes - 1), VERIFY_COOLDOWN_MAX_MS);
    s.until = Date.now() + wait;
    if (!verifyFlagged[storeCode]) {
      verifyFlagged[storeCode] = true;
      logSync(storeCode, 'verify_required', 'error', null,
        `青云 验证中心 challenge — a human must pass the captcha; backing off ~${Math.round(wait / 60000)} min`);
      sendOpsAlert(`🔴 青云聚信 ${storeCode} 风控/验证，配送跟踪已暂停，需要在盒子上重新登录\nQingyun ${storeCode} risk-control — delivery tracking paused, needs re-login`);
    }
    log(storeCode, `verification challenge — cooling down ~${Math.round(wait / 60000)} min (strike ${s.strikes})`);
  } else {
    if (verifyFlagged[storeCode]) {
      verifyFlagged[storeCode] = false;
      logSync(storeCode, 'verify_cleared', 'ok', null, 'verification cleared — tracking resumed');
      sendOpsAlert(`✅ 青云聚信 ${storeCode} 已恢复，配送跟踪继续\nQingyun ${storeCode} recovered — tracking resumed`);
    }
    s.strikes = 0; s.until = 0;
  }
}
const downFlagged = {};

// ── Match a Qingyun delivery to a roots order ──────────────────────────────────
// Primary: the roots order_no (e.g. R2026...) stamped into the 备注/userRemark at
// dispatch. Fallback: the recipient phone against a recent non-delivered roots order.
// Returns retail_orders.id or null. Never throws.
function matchRetailOrderId(d) {
  try {
    const remark = String(d.userRemark || '');
    const m = remark.match(/R\d{8,}/i) || remark.match(/#\s*(\d{3,})/);
    if (m) {
      const ref = (m[0].startsWith('#') ? m[1] : m[0]).toUpperCase();
      const byNo = db.prepare('SELECT id FROM retail_orders WHERE UPPER(order_no) = ?').get(ref)
                || db.prepare("SELECT id FROM retail_orders WHERE UPPER(order_no) LIKE ?").get('%' + ref + '%');
      if (byNo) return byNo.id;
    }
    const phone = String(d.recipientPhone || '').replace(/\D/g, '');
    if (phone.length >= 7) {
      const byPhone = db.prepare(`
        SELECT id FROM retail_orders
         WHERE REPLACE(REPLACE(recipient_phone,' ',''),'-','') LIKE ?
           AND status NOT IN ('delivered','cancelled','refunded')
         ORDER BY id DESC LIMIT 1`).get('%' + phone.slice(-8) + '%');
      if (byPhone) return byPhone.id;
    }
  } catch (e) { log('match', `matchRetailOrderId error: ${e.message}`); }
  return null;
}

const upsert = db.prepare(`
  INSERT INTO delivery_jobs
    (qingyun_order_id, retail_order_id, store_code, channel_name, carrier_name, waybill_id,
     delivery_id, rider_name, rider_phone, order_status, delivery_status,
     rider_lat, rider_lng, rider_to_cust_m, eta_seconds,
     recipient_name, recipient_phone, recipient_addr, recipient_lat, recipient_lng,
     expected_delivery_at, raw_order, raw_track, updated_at)
  VALUES
    (@qingyun_order_id, @retail_order_id, @store_code, @channel_name, @carrier_name, @waybill_id,
     @delivery_id, @rider_name, @rider_phone, @order_status, @delivery_status,
     @rider_lat, @rider_lng, @rider_to_cust_m, @eta_seconds,
     @recipient_name, @recipient_phone, @recipient_addr, @recipient_lat, @recipient_lng,
     @expected_delivery_at, @raw_order, @raw_track, CURRENT_TIMESTAMP)
  ON CONFLICT(qingyun_order_id) DO UPDATE SET
    retail_order_id  = COALESCE(delivery_jobs.retail_order_id, excluded.retail_order_id),
    carrier_name     = COALESCE(excluded.carrier_name, delivery_jobs.carrier_name),
    waybill_id       = COALESCE(excluded.waybill_id, delivery_jobs.waybill_id),
    delivery_id      = COALESCE(excluded.delivery_id, delivery_jobs.delivery_id),
    rider_name       = COALESCE(excluded.rider_name, delivery_jobs.rider_name),
    rider_phone      = COALESCE(excluded.rider_phone, delivery_jobs.rider_phone),
    order_status     = excluded.order_status,
    delivery_status  = excluded.delivery_status,
    rider_lat        = excluded.rider_lat,
    rider_lng        = excluded.rider_lng,
    rider_to_cust_m  = excluded.rider_to_cust_m,
    eta_seconds      = excluded.eta_seconds,
    expected_delivery_at = COALESCE(excluded.expected_delivery_at, delivery_jobs.expected_delivery_at),
    raw_order        = excluded.raw_order,
    raw_track        = COALESCE(excluded.raw_track, delivery_jobs.raw_track),
    updated_at       = CURRENT_TIMESTAMP
`);

async function pollStore(storeCode) {
  if (inVerifyCooldown(storeCode)) return;
  let br;
  try {
    br = await getQingyunBrowser(storeCode);
    if (!(await br.isLoggedIn())) {
      if (br.verificationRequired) { noteVerifyResult(storeCode, true); return; }
      if (!downFlagged[storeCode]) {
        downFlagged[storeCode] = true;
        logSync(storeCode, 'needs_login', 'error', null, '青云 Chrome not logged in — scan the QR on the box');
        log(storeCode, 'not logged in — skipping poll');
        sendOpsAlert(`🔴 青云聚信 ${storeCode} 未登录，配送跟踪已停止，需要扫码重新登录\nQingyun ${storeCode} not logged in — tracking stopped, scan QR to re-login`);
      }
      heartbeat(storeCode, false);
      return;
    }
    const wasDown = downFlagged[storeCode];
    downFlagged[storeCode] = false;
    heartbeat(storeCode, true);
    if (wasDown) sendOpsAlert(`✅ 青云聚信 ${storeCode} 重新登录成功，配送跟踪继续\nQingyun ${storeCode} logged back in — tracking resumed`);
    noteVerifyResult(storeCode, false);

    const { ok, bootstrap, orders } = await br.getActiveDeliveries();
    if (br.verificationRequired) { noteVerifyResult(storeCode, true); return; }
    if (bootstrap) {
      log(storeCode, 'no order/list captured yet — open the order page in the genuine Chrome (待取货/配送中 view)');
      logSync(storeCode, 'bootstrap', 'ok', null, 'waiting for the app to issue an order/list (open the order page)');
      return;
    }
    if (!ok) return;

    let tracked = 0;
    for (const d of orders) {
      if (!d.qingyunOrderId) continue;
      // Live rider GPS for in-flight orders (skip the coordinate fetch once delivered).
      let track = null;
      if (d.orderStatus != null && d.orderStatus < DELIVERED_STATUS) {
        try { track = await br.getRiderTrack(d.qingyunOrderId); }
        catch (e) { log(storeCode, `getRiderTrack ${d.qingyunOrderId} error: ${e.message}`); }
      }
      const retailOrderId = matchRetailOrderId(d);
      upsert.run({
        qingyun_order_id: d.qingyunOrderId,
        retail_order_id: retailOrderId,
        store_code: storeCode,
        channel_name: d.channelName || null,
        carrier_name: d.carrierName || (track && null) || null,
        waybill_id: track ? (track.waybillId || null) : null,
        delivery_id: d.deliveryId || (track && track.deliveryId) || null,
        rider_name: d.riderName || null,
        rider_phone: d.riderPhone || null,
        order_status: track ? (track.orderStatus ?? d.orderStatus) : d.orderStatus,
        delivery_status: track ? (track.deliveryStatus ?? d.deliveryStatus) : d.deliveryStatus,
        rider_lat: track ? track.riderLat : null,
        rider_lng: track ? track.riderLng : null,
        rider_to_cust_m: track ? track.riderToCustM : null,
        eta_seconds: track ? track.etaSeconds : null,
        recipient_name: d.recipientName || null,
        recipient_phone: d.recipientPhone || null,
        recipient_addr: d.recipientAddr || null,
        recipient_lat: d.recipientLat ?? null,
        recipient_lng: d.recipientLng ?? null,
        expected_delivery_at: d.expectedDeliveredTime || null,
        raw_order: JSON.stringify(d.raw).slice(0, 20000),
        raw_track: track ? JSON.stringify(track.raw).slice(0, 20000) : null,
      });
      tracked++;
    }
    if (tracked) logSync(storeCode, 'poll', 'ok', { tracked });
    log(storeCode, `tracked ${tracked} active delivery(ies)`);
  } catch (err) {
    log(storeCode, `pollStore error: ${err.message}`);
    logSync(storeCode, 'poll', 'error', null, err.message);
  }
}

async function main() {
  console.log(`[qingyun-daemon] starting — stores: ${STORES.join(', ')}`);
  let gap = jitter(POLL_MS, 0.3);
  let last = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Date.now();

    if (!(await proxyHealthy())) {
      if (!proxyDownFlagged) {
        proxyDownFlagged = true;
        console.log(`[qingyun-daemon] ${new Date().toISOString()} PROXY UNREACHABLE (${maskProxy(PROXY)}) — pausing (session NOT logged out)`);
        for (const s of STORES) logSync(s, 'proxy_down', 'error', null, 'proxy cannot reach Meituan — tracking paused');
        sendOpsAlert(`🔴 青云聚信 代理掉线，无法连接，配送跟踪已暂停（未掉登录）\nQingyun proxy down — tracking paused (not logged out)`);
      }
      await sleep(jitter(POLL_MS));
      continue;
    }
    if (proxyDownFlagged) {
      proxyDownFlagged = false;
      console.log(`[qingyun-daemon] ${new Date().toISOString()} proxy recovered — resuming`);
      for (const s of STORES) logSync(s, 'proxy_up', 'ok', null, 'proxy reachable again — tracking resumed');
      sendOpsAlert(`✅ 青云聚信 代理已恢复，配送跟踪继续\nQingyun proxy recovered — tracking resumed`);
    }

    if (now - last >= gap) {
      last = now;
      gap = jitter(POLL_MS, 0.3);
      for (const storeCode of STORES) await pollStore(storeCode);
    }
    await sleep(jitter(5_000));
  }
}

process.on('SIGINT',  async () => { await closeAllQingyun(); process.exit(0); });
process.on('SIGTERM', async () => { await closeAllQingyun(); process.exit(0); });

main().catch(err => { console.error('[qingyun-daemon] fatal:', err); process.exit(1); });
