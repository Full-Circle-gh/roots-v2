// 青云聚信 (Qingyun) delivery-tracking daemon — separate pm2 process. Restarted
// by the deploy installer whenever a file it loads changes (see deploy-apply.sh).
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
const geocode = require('../lib/geocode'); // Tencent/AMap — resolve English/pin-less addresses
const inventory = require('../lib/inventory'); // isQingyunSameCityToday — same-city/same-day eligibility

const STORES = (process.env.QINGYUN_STORES || 'tianhe')
  .split(',').map(s => s.trim()).filter(Boolean);

const POLL_MS = Number(process.env.QINGYUN_POLL_MS || 25_000); // ~25s (jittered)
const DELIVERED_STATUS = 50; // orderStatus once 已送达

function jitter(baseMs, frac = 0.3) {
  const spread = baseMs * frac;
  return Math.round(baseMs - spread + Math.random() * spread * 2);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const norm = (s) => String(s == null ? '' : s).trim();

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
// Residential VPN links blip for well under a minute; only page ops after the
// proxy fails this many consecutive probes (mirrors shangou-daemon).
let proxyFailStreak = 0;
const PROXY_DOWN_GRACE = Number(process.env.MEITUAN_PROXY_DOWN_GRACE || 3);

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
// Bootstrap = logged in but no captured order/list to replay (page reloaded).
// 2026-07-02: yuexiu sat in this state 10h unnoticed — alert once it persists.
const bootstrapSince = {};
const bootstrapFlagged = {};
const BOOTSTRAP_ALERT_MS = Number(process.env.QINGYUN_BOOTSTRAP_ALERT_MS || 10 * 60_000);

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

// Build the delivery_jobs upsert row from a parsed order (+ optional live track).
// track is null for a completion reconcile (a delivered order has no live GPS); the
// upsert COALESCEs carrier/rider/waybill/etc, so a track-less row never wipes them.
function buildDeliveryRow(d, track, storeCode, retailOrderId) {
  return {
    qingyun_order_id: d.qingyunOrderId,
    retail_order_id: retailOrderId,
    store_code: storeCode,
    channel_name: d.channelName || null,
    carrier_name: d.carrierName || null,
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
  };
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

// ── Auto-fill the customer-facing ETA from the courier ────────────────────────
// A same-city (local) order's "Estimated arrival" was operator-typed. Once Qingyun
// dispatches a courier it hands us the promised arrival time (expectedDeliveredTime),
// so we stamp that onto the order's 'local' shipment (local_eta = 'HH:MM' Beijing) and
// mark eta_source='auto'. The customer order page + admin drawer both read local_eta,
// so one write feeds the whole chain. An operator override sets eta_source='manual'
// (see routes/retail.js saveLocalEta), which we never overwrite. Same-day by design:
// we only stamp when the promised time is today (Beijing) so a next-day scheduled
// order doesn't get a misleading same-day clock.
const stampEta = db.prepare(`
  UPDATE retail_shipments
     SET local_eta = @eta, eta_source = 'auto', updated_at = CURRENT_TIMESTAMP
   WHERE order_id = @order_id AND mode = 'local'
     AND (eta_source IS NULL OR eta_source != 'manual')
     AND COALESCE(local_eta, '') != @eta`);

// Qingyun timestamps arrive as unix epoch (seconds or ms) or an ISO-ish string.
// Return Beijing 'HH:MM' iff it lands on today (Beijing); else null. Never throws.
function beijingSameDayHHMM(val) {
  try {
    if (val == null || val === '') return null;
    let ms;
    if (typeof val === 'number' || /^\d+$/.test(String(val))) {
      const n = Number(val);
      ms = n < 1e12 ? n * 1000 : n;   // seconds vs milliseconds
    } else {
      ms = Date.parse(String(val).replace(' ', 'T'));
    }
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const bj  = new Date(ms + 8 * 3600 * 1000);
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    if (bj.getUTCFullYear() !== now.getUTCFullYear()
      || bj.getUTCMonth() !== now.getUTCMonth()
      || bj.getUTCDate() !== now.getUTCDate()) return null;   // not today Beijing
    const p = (n) => String(n).padStart(2, '0');
    return `${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`;
  } catch (e) { return null; }
}

// Stamp the courier's promised arrival onto the matched order's local shipment.
// Only for dispatched orders (a courier is actually on it) with a same-day ETA;
// falls back to now+eta_seconds when Qingyun gives no explicit promised time.
function stampLocalEta(retailOrderId, d, track) {
  if (!retailOrderId) return;
  const dispatched = !!(d.deliveryId || d.carrierName || d.riderName
    || (track && track.deliveryId) || (track && Number(track.deliveryStatus) > 0));
  if (!dispatched) return;
  let hhmm = beijingSameDayHHMM(d.expectedDeliveredTime);
  if (!hhmm && track && Number.isFinite(track.etaSeconds) && track.etaSeconds > 0) {
    hhmm = beijingSameDayHHMM(Date.now() + track.etaSeconds * 1000);
  }
  if (!hhmm) return;
  try { stampEta.run({ eta: hhmm, order_id: retailOrderId }); }
  catch (e) { log('eta', `stampLocalEta ${retailOrderId} error: ${e.message}`); }
}

// ── Phase 2: auto-push paid delivery orders into Qingyun (drain the queue) ─────
// The main app enqueues qingyun_push_queue rows on payment; here we hold the signed
// browser, so we build the create payload from the roots order and call order/create.
// The order lands 待配送 (no courier). We stamp order_no into 备注 so the existing
// tracking match links the rider back. Idempotent per row; retries with backoff.
const MAX_PUSH_ATTEMPTS = Number(process.env.QINGYUN_PUSH_MAX_ATTEMPTS || 5);
function cfg(key, fallback) {
  try { const r = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
    return r ? JSON.parse(r.value_json) : fallback; } catch { return fallback; }
}
// Turn a roots order into the createOrder() field bag. Throws (→ retry) if it lacks
// the essentials (recipient name/phone/address). Coords: the mini-app/web capture the
// customer's GCJ-02 pin — Qingyun's datum — so we pass them ×1e6; else geocode.
async function buildCreatePayload(order, shop, br) {
  let addr = {}; try { addr = JSON.parse(order.address_json || '{}') || {}; } catch { addr = {}; }
  const name  = norm(order.recipient_name || addr.name || addr.contact);
  const phone = norm(order.recipient_phone || addr.phone || addr.mobile);
  const text  = norm(addr.address || addr.detail || [addr.city, addr.district, addr.address, addr.detail].filter(Boolean).join(''));
  if (!name || !phone || !text) throw new Error('missing recipient name/phone/address');

  // Resolve the drop-off pin (Qingyun wants GCJ-02 ×1e6; the app's geocoders + the
  // mini-app map picker are all GCJ-02, so datums match). Chain, most-reliable first:
  //   1) the order's own coords (customer picked a pin) — best, language-agnostic;
  //   2) the app's Tencent/AMap geocoder over the Chinese 省/市/区 + street — resolves
  //      even an English-typed street, since the region anchors it;
  //   3) Qingyun's own POI search (weak on English) as a last automatic try;
  //   4) give up → the row retries then ops-alerts (never guesses a wrong spot).
  let lng = null, lat = null, cityId = shop.cityId;
  const dLng = Number(addr.lng), dLat = Number(addr.lat);
  if (Number.isFinite(dLng) && Number.isFinite(dLat) && dLng !== 0 && dLat !== 0) {
    lng = Math.round(dLng * 1e6); lat = Math.round(dLat * 1e6);
  } else {
    let g = null;
    try {
      if (geocode.configured()) {
        const c = await geocode.geocodeAddress({
          province: norm(addr.province), city: norm(addr.city), district: norm(addr.district),
          address: [norm(addr.address), norm(addr.detail)].filter(Boolean).join(' ') || text,
        });
        if (c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng))) {
          g = { lng: Math.round(Number(c.lng) * 1e6), lat: Math.round(Number(c.lat) * 1e6), cityId: shop.cityId };
        }
      }
    } catch (e) { log('push', `maps geocode failed for ${norm(order.order_no)}: ${e.message}`); }
    if (!g) g = await br.geocode(text, shop.cityId);   // Qingyun POI search fallback
    if (!g) throw new Error('geocode failed for address (no pin, unresolved text)');
    lng = g.lng; lat = g.lat; cityId = g.cityId || shop.cityId;
  }

  // Delivery time: a chosen slot → its epoch; else ASAP (~1h out). 待配送 only, so
  // this is informational until staff dispatch.
  const slotEpoch = order.scheduled_for ? Math.floor(Date.parse(order.scheduled_for) / 1000) : 0;
  const target = (slotEpoch && slotEpoch > Math.floor(Date.now() / 1000)) ? slotEpoch : Math.floor(Date.now() / 1000) + 3600;

  const slot = norm(order.delivery_slot_label);
  const remark = (norm(order.order_no) + (slot ? ` · ${slot}` : '')).slice(0, 200);
  const doorInfo = norm(addr.detail && addr.detail !== text ? addr.detail : '');

  return {
    shopId: shop.shopId,
    recipientName: name, recipientPhone: phone, recipientAddress: text, doorInfo,
    recipientLng: lng, recipientLat: lat, cityId,
    goods: [{ name: `Roots ${norm(order.order_no)}`, price: 0, count: 1 }],
    goodsPicUrl: norm(cfg('delivery.qingyunGoodsPicUrl', 'https://s3plus.meituan.net/dap-orderdetail/qy/1783175410205_goods.png')),
    remark, expectFrom: target, expectTo: target,
  };
}
async function drainPushQueue(storeCode, br) {
  if (cfg('delivery.qingyunAutoPush', false) !== true) return;

  // Reconcile: an order can reach 'paid' via several paths (online gateway, cash /
  // COD, admin "Mark paid") and only the gateway one runs the enqueue hook. So we
  // also sweep here for paid DELIVERY orders (this store) that have no queue row.
  // Bounded to orders paid AFTER auto-push was switched on (qingyunAutoPushSince),
  // so enabling never floods historical orders. Idempotent (UNIQUE + NOT EXISTS).
  //
  // Same eligibility gate as the app-side enqueue hook — isQingyunSameCityToday
  // filters each candidate in JS (mirroring the routing/same-day rules) so the
  // sweep never pulls in an out-of-city order, a later-day regular delivery, or a
  // marketplace (Meituan/Eleme) order. SQL only narrows to fresh, unqueued rows.
  const since = cfg('delivery.qingyunAutoPushSince', null);
  if (since) {
    try {
      const enq = db.prepare(
        "INSERT OR IGNORE INTO qingyun_push_queue (retail_order_id, store_code, status) VALUES (?, ?, 'pending')"
      );
      const candidates = db.prepare(`
        SELECT o.id, o.channel, o.address_json, o.delivery_slot_kind, o.scheduled_for
          FROM retail_orders o JOIN retail_stores rs ON rs.id = o.store_id
         WHERE rs.code = @sc AND o.fulfillment_type = 'delivery'
           AND o.status IN ('paid','preparing','dispatched')
           AND o.paid_at IS NOT NULL AND o.paid_at > @since
           AND NOT EXISTS (SELECT 1 FROM qingyun_push_queue q WHERE q.retail_order_id = o.id)`)
        .all({ sc: storeCode, since });
      for (const o of candidates) {
        if (inventory.isQingyunSameCityToday(o)) enq.run(o.id, storeCode);
      }
    } catch (e) { log(storeCode, `push reconcile error: ${e.message}`); }
  }

  let rows = [];
  try {
    rows = db.prepare(
      "SELECT * FROM qingyun_push_queue WHERE store_code = ? AND status IN ('pending') ORDER BY id LIMIT 3"
    ).all(storeCode);
  } catch { return; }
  if (!rows.length) return;
  const shop = await br.getShop();
  if (!shop || !shop.shopId) { log(storeCode, 'push: shop lookup failed — will retry'); return; }

  for (const row of rows) {
    db.prepare("UPDATE qingyun_push_queue SET status='processing', attempts=attempts+1, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
    try {
      const order = db.prepare(
        'SELECT id, order_no, channel, recipient_name, recipient_phone, address_json, delivery_slot_kind, scheduled_for, delivery_slot_label FROM retail_orders WHERE id = ?'
      ).get(row.retail_order_id);
      if (!order) { db.prepare("UPDATE qingyun_push_queue SET status='error', last_error='order gone', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id); continue; }
      // Final eligibility guard — a row queued before this gate existed (a stray
      // out-of-city / later-day / marketplace order) must not create a Qingyun
      // job. Retire it as 'skipped' instead of pushing it to 待配送.
      if (!inventory.isQingyunSameCityToday(order)) {
        db.prepare("UPDATE qingyun_push_queue SET status='skipped', last_error='not same-city same-day', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
        log(storeCode, `push: skipped order ${order.order_no} — not same-city same-day`);
        continue;
      }
      const payload = await buildCreatePayload(order, shop, br);
      const res = await br.createOrder(payload);
      if (res.ok) {
        db.prepare("UPDATE qingyun_push_queue SET status='done', qingyun_order_id=?, last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(res.orderId, row.id);
        log(storeCode, `push: created Qingyun order ${res.orderId} for ${order.order_no}`);
        logSync(storeCode, 'push', 'ok', { order_no: order.order_no, qy: res.orderId });
      } else {
        throw new Error(`create failed (code ${res.code}, ${res.msg})`);
      }
    } catch (e) {
      const attempts = row.attempts + 1;
      const done = attempts >= MAX_PUSH_ATTEMPTS;
      db.prepare("UPDATE qingyun_push_queue SET status=?, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(done ? 'error' : 'pending', String(e.message).slice(0, 300), row.id);
      log(storeCode, `push: order ${row.retail_order_id} failed (attempt ${attempts}${done ? ', giving up' : ''}): ${e.message}`);
      if (done) {
        logSync(storeCode, 'push', 'error', null, e.message);
        sendOpsAlert(`🔴 青云聚信 ${storeCode} 自动发单失败（订单#${row.retail_order_id}）：${e.message}\nQingyun ${storeCode} auto-create failed for order #${row.retail_order_id} — push it by hand`);
      }
    }
  }
}

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

    // Phase 2: create any queued paid delivery orders in Qingyun (no-op unless the
    // toggle is on and rows are pending). Runs while logged in, before tracking, so
    // a push isn't held up by the tracking bootstrap. Never blocks the poll.
    try { await drainPushQueue(storeCode, br); } catch (e) { log(storeCode, `push drain error: ${e.message}`); }
    if (wasDown) sendOpsAlert(`✅ 青云聚信 ${storeCode} 重新登录成功，配送跟踪继续\nQingyun ${storeCode} logged back in — tracking resumed`);
    noteVerifyResult(storeCode, false);

    const { ok, bootstrap, orders } = await br.getActiveDeliveries();
    if (br.verificationRequired) { noteVerifyResult(storeCode, true); return; }
    if (bootstrap) {
      // A page reload wipes the captured order/list body (window.__qy) and tracking
      // silently stops until a human reopens the 配送中 view. Page ops once it has
      // clearly persisted — a fresh login/redirect settles well inside the grace.
      if (!bootstrapSince[storeCode]) bootstrapSince[storeCode] = Date.now();
      if (!bootstrapFlagged[storeCode] && Date.now() - bootstrapSince[storeCode] >= BOOTSTRAP_ALERT_MS) {
        bootstrapFlagged[storeCode] = true;
        sendOpsAlert(`🔴 青云聚信 ${storeCode} 页面丢失订单列表（可能页面被刷新），配送跟踪已停止 — 请在盒子上打开订单页的配送中标签\nQingyun ${storeCode} lost the captured order list (page likely reloaded) — tracking stopped; open the 配送中 tab on the box`);
      }
      log(storeCode, 'no order/list captured yet — open the order page in the genuine Chrome (待取货/配送中 view)');
      logSync(storeCode, 'bootstrap', 'ok', null, 'waiting for the app to issue an order/list (open the order page)');
      return;
    }
    if (bootstrapFlagged[storeCode]) {
      sendOpsAlert(`✅ 青云聚信 ${storeCode} 订单列表已恢复，配送跟踪继续\nQingyun ${storeCode} order list recaptured — tracking resumed`);
    }
    bootstrapSince[storeCode] = 0;
    bootstrapFlagged[storeCode] = false;
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
      upsert.run(buildDeliveryRow(d, track, storeCode, retailOrderId));
      // Auto-fill the customer-facing "Estimated arrival" from the courier's
      // promised time (unless an operator set it by hand).
      stampLocalEta(retailOrderId, d, track);
      tracked++;
    }
    if (tracked) logSync(storeCode, 'poll', 'ok', { tracked });
    log(storeCode, `tracked ${tracked} active delivery(ies)`);

    // ── Completion reconcile ────────────────────────────────────────────────
    // A delivered order (orderStatus 50 已送达) drops off the active (20/30) tabs,
    // so its delivery_jobs row would otherwise freeze at its last in-flight status
    // and the roots order would only auto-deliver off the ETA timer — never off the
    // rider's REAL drop-off. Poll the recent 完成 tab and, for orders we ALREADY
    // track (never import history), stamp the final delivered state so the server
    // auto-deliver sweep flips the roots order on the true drop-off signal.
    try {
      const done = await br.getCompletedDeliveries();
      let reconciled = 0;
      for (const d of done) {
        if (!d.qingyunOrderId) continue;
        const existing = db.prepare(
          'SELECT retail_order_id, order_status FROM delivery_jobs WHERE qingyun_order_id = ?'
        ).get(d.qingyunOrderId);
        if (!existing) continue;                                  // untracked → skip
        if ((existing.order_status ?? 0) >= DELIVERED_STATUS) continue; // already delivered
        const retailOrderId = existing.retail_order_id || matchRetailOrderId(d);
        upsert.run(buildDeliveryRow(d, null, storeCode, retailOrderId));
        reconciled++;
      }
      if (reconciled) { logSync(storeCode, 'complete', 'ok', { reconciled }); log(storeCode, `reconciled ${reconciled} delivered order(s)`); }
    } catch (e) { log(storeCode, `completion reconcile error: ${e.message}`); }
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
      proxyFailStreak++;
      if (!proxyDownFlagged && proxyFailStreak >= PROXY_DOWN_GRACE) {
        proxyDownFlagged = true;
        console.log(`[qingyun-daemon] ${new Date().toISOString()} PROXY UNREACHABLE (${maskProxy(PROXY)}) — pausing (session NOT logged out)`);
        for (const s of STORES) logSync(s, 'proxy_down', 'error', null, 'proxy cannot reach Meituan — tracking paused');
        sendOpsAlert(`🔴 青云聚信 代理掉线，无法连接，配送跟踪已暂停（未掉登录）\nQingyun proxy down — tracking paused (not logged out)`);
      }
      await sleep(jitter(POLL_MS));
      continue;
    }
    proxyFailStreak = 0;
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
