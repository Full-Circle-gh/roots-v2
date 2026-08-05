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

// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { getQingyunBrowser, closeAllQingyun, resolveCdpUrl } = require('../lib/qingyun-browser');
const { sendOpsAlert } = require('../lib/ops-alert');
// Hold off on channel calls while a holder Chrome is freshly launched (mirrors
// shangou-daemon) — a cold browser hit seconds after launch earns the 风控 403.
const { coldMsRemaining, isColdStartChallenge } = require('../lib/browser-warmup');
// Ops-alert latches that survive a restart (see lib/alert-latch).
const { latchStore } = require('../lib/alert-latch');
const geocode = require('../lib/geocode'); // Tencent/AMap — resolve English/pin-less addresses
const { buildCreatePayload } = require('../lib/qingyun-payload'); // shared with the ship-from override
const inventory = require('../lib/inventory'); // isQingyunSameCityToday — same-city/same-day eligibility
const { storeHours, within } = require('../lib/store-hours'); // opening hours, for the alert window

const STORES = (process.env.QINGYUN_STORES || 'tianhe')
  .split(',').map(s => s.trim()).filter(Boolean);

const POLL_MS = Number(process.env.QINGYUN_POLL_MS || 25_000); // ~25s (jittered)
const DELIVERED_STATUS = 50; // orderStatus once 已送达

// ── When ops alerts may page ──────────────────────────────────────────────────
// Tracking itself stays on round the clock, on purpose: a rider dispatched at
// 20:10 is still on the road at 20:40, and tomorrow's orders keep draining the
// push queue overnight. It's the PAGES that need opening hours. Every session-
// health alert below ends in "walk to the box and scan the QR" — 2026-07-29
// yuexiu paged 未登录/scan-QR at 23:15, three hours after it shut, with nothing in
// flight and nobody able to act until the morning.
//
// Outside the window we neither send nor latch, and the condition is re-checked on
// every poll. So a fault that survives the night pages once at opening; one that
// heals overnight clears quietly; and an incident raised during the day still gets
// its recovery ✅ (its latch was never touched while muted).
const ALERT_OPEN_GRACE_MIN  = Number(process.env.QINGYUN_ALERT_OPEN_GRACE_MIN  || 15); // staff arrive before the doors open
const ALERT_CLOSE_GRACE_MIN = Number(process.env.QINGYUN_ALERT_CLOSE_GRACE_MIN || 90); // …and the last rider is still out after they shut
// Fallback for stores whose retail_stores row carries no hours, mirroring
// meituan-daemon/shangou-daemon so all three agree on the same windows today.
// Filling in a store's "Opens · 开门 / Closes · 关门" fields overrides this, and is
// all a new tenant has to do. ⚠️ Those two fields ALSO drive the customer pickup
// window (resolvePickupTime in routes/retail.js), which is why this stays a
// daemon-local fallback instead of being written into the store rows.
const LEGACY_ALERT_HOURS = {
  tianhe: { open: 10 * 60 + 0, close: 20 * 60 + 0  }, // 10:00–20:00
  yuexiu: { open: 11 * 60 + 0, close: 20 * 60 + 15 }, // 11:00–20:15
};
// Escape hatch for a genuine 24h store, or for testing an alert path on demand.
const ALERT_ALWAYS = process.env.QINGYUN_ALERT_ALWAYS === '1';

// True when a page for this store would reach someone who can act on it.
function alertsAllowed(storeCode, now = new Date()) {
  if (ALERT_ALWAYS) return true;
  const hours = storeHours(storeCode) || LEGACY_ALERT_HOURS[storeCode] || null;
  return within(hours, {
    openGraceMin: ALERT_OPEN_GRACE_MIN, closeGraceMin: ALERT_CLOSE_GRACE_MIN, now,
  });
}
// The proxy serves every store this process holds, so it only goes quiet once they
// are all shut.
function anyStoreAlertsAllowed() { return STORES.some(s => alertsAllowed(s)); }

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
// Alert latches live on disk (lib/alert-latch) so a daemon restart mid-incident
// still knows it owes the ops group a recovery message.
const alerts = latchStore('qingyun');
// Both qingyun daemons (tianhe + yuexiu) write the same latch dir, so the
// process-wide proxy latch gets its own key per store set — otherwise one
// daemon's recovery would clear the other's open incident.
const PROXY_LATCH = 'proxy_down:' + STORES.join('_');
// Residential VPN links blip for well under a minute; only page ops after the
// proxy fails this many consecutive probes (mirrors shangou-daemon).
let proxyFailStreak = 0;
const PROXY_DOWN_GRACE = Number(process.env.MEITUAN_PROXY_DOWN_GRACE || 3);

// ── 验证中心 / login backoff (mirrors shangou-daemon) ──────────────────────────
const VERIFY_COOLDOWN_BASE_MS = 30 * 60_000;
const VERIFY_COOLDOWN_MAX_MS  = 4 * 60 * 60_000;
const verifyState   = {};
const verifyFlagged = alerts; // keyed 'verify:<storeCode>'
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
    if (!verifyFlagged['verify:' + storeCode] && alertsAllowed(storeCode)) {
      verifyFlagged['verify:' + storeCode] = true;
      const mins = Math.round(wait / 60000);
      // Cold browser vs. a genuinely dead session — see shangou-daemon for the story.
      const cold = isColdStartChallenge(resolveCdpUrl(storeCode));
      logSync(storeCode, 'verify_required', 'error', null,
        cold
          ? `青云 验证中心 challenge right after a browser relaunch — session intact; backing off ~${mins} min`
          : `青云 验证中心 challenge — a human must pass the captcha; backing off ~${mins} min`);
      sendOpsAlert(cold
        ? `🟠 青云聚信 ${storeCode} 风控/验证（浏览器刚重启，登录未掉），配送跟踪暂停约 ${mins} 分钟后自动恢复，无需操作\nQingyun ${storeCode} risk-control right after a browser restart — NOT logged out, tracking auto-resumes in ~${mins} min, no action needed`
        : `🔴 青云聚信 ${storeCode} 风控/验证，配送跟踪已暂停，需要在盒子上重新登录\nQingyun ${storeCode} risk-control — delivery tracking paused, needs re-login`);
    }
    log(storeCode, `verification challenge — cooling down ~${Math.round(wait / 60000)} min (strike ${s.strikes})`);
  } else {
    // Hold the recovery note (not the cool-down reset below it) until the store is
    // open, so an incident raised in the afternoon still gets its all-clear —
    // in the morning rather than at 3am.
    if (verifyFlagged['verify:' + storeCode] && alertsAllowed(storeCode)) {
      verifyFlagged['verify:' + storeCode] = false;
      logSync(storeCode, 'verify_cleared', 'ok', null, 'verification cleared — tracking resumed');
      sendOpsAlert(`✅ 青云聚信 ${storeCode} 已恢复，配送跟踪继续\nQingyun ${storeCode} recovered — tracking resumed`);
    }
    s.strikes = 0; s.until = 0;
  }
}
const downFlagged = alerts; // keyed 'login:<storeCode>'
// A single isLoggedIn() false is usually a transient blip (residential-proxy hiccup
// or an H5guard signing retry) that clears on the very next poll — 2026-07-16 a lone
// skipped poll paged ops at 03:21 and self-healed 5min later. Only alert once the
// session stays down for this many consecutive polls (~90s), mirroring PROXY_DOWN_GRACE.
const loginFailStreak = {};
const LOGIN_DOWN_GRACE = Number(process.env.QINGYUN_LOGIN_DOWN_GRACE || 3);
// Bootstrap = logged in but no captured order/list to replay (page reloaded).
// 2026-07-02: yuexiu sat in this state 10h unnoticed — alert once it persists.
const bootstrapSince = {};
const bootstrapFlagged = alerts; // keyed 'bootstrap:<storeCode>'
const BOOTSTRAP_ALERT_MS = Number(process.env.QINGYUN_BOOTSTRAP_ALERT_MS || 10 * 60_000);

// ── Heartbeat canary (generic stall backstop) ──────────────────────────────────
// The verify / login / bootstrap / proxy alerts above each cover a KNOWN silent
// mode — but pollStore()'s outer catch (bottom of this file) just logs to console
// on anything else, with NO alert. That gap is real: 2026-07-26 yuexiu's holder
// Chrome SEGV-crash-looped for hours (browserType.connectOverCDP timing out /
// ECONNREFUSED on every attempt) — every failure happened before isLoggedIn() was
// even reached, so none of the four alerts above ever fired. Zero WeCom pages for
// a multi-hour outage. This tracks "time since a poll last got past the login
// check" per store and pages ops if it's stale, regardless of the reason — parked
// while a known cause is already alerting so we don't double-page one incident.
const HEARTBEAT_STALE_MS = Number(process.env.QINGYUN_HEARTBEAT_STALE_MIN || 10) * 60_000;
const lastPollOk = {};
const heartbeatFlagged = alerts; // keyed 'stall:<storeCode>'
function noteLoginOk(storeCode) { lastPollOk[storeCode] = Date.now(); }
function heartbeatTick(storeCode) {
  const now = Date.now();
  // Also excused outside opening hours — the clock restarts at opening, so a shut
  // store can't hand ops a "no clean poll in ~700 min" page the moment it opens.
  const excused = inVerifyCooldown(storeCode)
    || downFlagged['login:' + storeCode]
    || bootstrapFlagged['bootstrap:' + storeCode]
    || alerts[PROXY_LATCH]
    || !alertsAllowed(storeCode);
  if (excused || lastPollOk[storeCode] == null) { lastPollOk[storeCode] = now; return; }
  const stale = now - lastPollOk[storeCode] >= HEARTBEAT_STALE_MS;
  if (stale && !heartbeatFlagged['stall:' + storeCode]) {
    heartbeatFlagged['stall:' + storeCode] = true;
    const mins = Math.round((now - lastPollOk[storeCode]) / 60000);
    logSync(storeCode, 'poll_stalled', 'error', null,
      `no clean poll in ~${mins} min, not explained by login/verify/proxy — the Chrome process is likely crash-looping`);
    sendOpsAlert(`🔴 青云聚信 ${storeCode} 约 ${mins} 分钟没有一次成功轮询（非登录/验证/代理原因），浏览器可能在反复崩溃，请检查\nQingyun ${storeCode} — no successful poll in ~${mins} min, not explained by login/verify/proxy — the Chrome process may be crash-looping; please check`);
  } else if (!stale && heartbeatFlagged['stall:' + storeCode]) {
    heartbeatFlagged['stall:' + storeCode] = false;
    logSync(storeCode, 'poll_resumed', 'ok', null, 'polling succeeding again');
    sendOpsAlert(`✅ 青云聚信 ${storeCode} 轮询已恢复\nQingyun ${storeCode} polling back to normal`);
  }
}

// ── Match a Qingyun delivery to a roots order ──────────────────────────────────
// Primary: the roots order_no (e.g. R2026...) stamped into the 备注/userRemark at
// dispatch. Fallback: the recipient phone against a recent non-delivered roots order.
// Returns retail_orders.id or null. Never throws.
function matchRetailOrderId(d) {
  try {
    // Channel deliveries dispatched THROUGH Qingyun (Meituan's own delivery is
    // fulfilled by a Qingyun rider) carry the upstream platform order number as
    // channelOrderId. Our Meituan mirror stores that number in
    // meituan_order_import.meituan_order_no → retail_order_id, so an exact match
    // links the rider to the right mirrored order. This is the reliable key for
    // Meituan: the 备注/phone fallbacks below don't apply — Meituan masks the
    // customer phone and never stamps our order ref into the 备注. A contains-
    // match backs up the exact one in case the aggregator wraps our id with a
    // prefix/suffix; meituan_order_no is a long unique id so it won't over-match.
    const chanNo = String(d.channelOrderId || '').trim();
    if (chanNo.length >= 6) {
      const byChan =
           db.prepare('SELECT retail_order_id FROM meituan_order_import WHERE meituan_order_no = ? AND retail_order_id IS NOT NULL').get(chanNo)
        || db.prepare("SELECT retail_order_id FROM meituan_order_import WHERE ? LIKE '%' || meituan_order_no || '%' AND retail_order_id IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(chanNo);
      if (byChan && byChan.retail_order_id) return byChan.retail_order_id;
    }
    const remark = String(d.userRemark || '');
    // Our own pushes stamp `<order_no> · <slot>` into the 备注, so the FIRST token is
    // the order number verbatim — match it as-is. The prefix patterns below only knew
    // R… and MA…, so every TC-numbered order missed: those linked by phone luck alone,
    // and not at all once the order closed (the phone fallback skips cancelled ones).
    // Order numbers are per-tenant, so no new prefix belongs in a pattern here.
    // A marketplace remark is a customer note ("环保单，顾客不需要附带餐具"); its first
    // token isn't an order number and simply won't match a row.
    const tok = remark.split('·')[0].trim().split(/\s+/)[0].replace(/[^A-Za-z0-9-]/g, '');
    if (tok.length >= 4) {
      const byTok = db.prepare('SELECT id FROM retail_orders WHERE UPPER(order_no) = ?').get(tok.toUpperCase());
      if (byTok) return byTok.id;
    }
    const m = remark.match(/MA\d{7}/i) || remark.match(/R\d{6,}/i) || remark.match(/#\s*(\d{3,})/);
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

// An abandoned copy: staff moved this order's pickup point to another store, so a
// NEW Qingyun order carries the delivery and this one is only waiting to be cancelled
// in the old store's app. Both copies carry the same order_no in their 备注, so the
// match above would happily re-link this one and the drawer would flip between two
// riders. Superseded rows stay unlinked for good.
function isSuperseded(qingyunOrderId) {
  try {
    const r = db.prepare('SELECT superseded FROM delivery_jobs WHERE qingyun_order_id = ?').get(String(qingyunOrderId));
    return !!(r && r.superseded);
  } catch { return false; }
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
    -- Keep the last-known rider position/ETA when a poll carries no fresh track
    -- (a track-less reconcile / status refresh has these as NULL). Overwriting with
    -- NULL made the live map lose the rider between pings — "Rider en route" but the
    -- dot vanished. A poll WITH a real track always supplies non-NULL values, so the
    -- rider still updates every live tick; only empty polls fall back to last-known.
    rider_lat        = COALESCE(excluded.rider_lat, delivery_jobs.rider_lat),
    rider_lng        = COALESCE(excluded.rider_lng, delivery_jobs.rider_lng),
    rider_to_cust_m  = COALESCE(excluded.rider_to_cust_m, delivery_jobs.rider_to_cust_m),
    eta_seconds      = COALESCE(excluded.eta_seconds, delivery_jobs.eta_seconds),
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
  // track.etaSeconds is route.duration, which tracks whichever leg the rider is
  // CURRENTLY navigating — the shop until they've collected the parcel (deliveryStatus
  // < 30), the customer after. Before pickup that's time-to-shop, not time-to-customer,
  // so only trust it as the fallback "estimated arrival" once actually picked up.
  const pickedUp = track && Number(track.deliveryStatus) >= 30;
  if (!hhmm && pickedUp && Number.isFinite(track.etaSeconds) && track.etaSeconds > 0) {
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
// The builder itself lives in lib/qingyun-payload so the ship-from override in
// routes/retail.js (which re-creates the order under another store's account) builds
// byte-identical fields — above all the 备注, which is how tracking finds its way back.
function pushPayload(order, shop, br) {
  return buildCreatePayload(order, shop, br, {
    geocode,
    goodsPicUrl: cfg('delivery.qingyunGoodsPicUrl', 'https://s3plus.meituan.net/dap-orderdetail/qy/1783175410205_goods.png'),
    onWarn: (msg) => log('push', msg),
  });
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
      const payload = await pushPayload(order, shop, br);
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
        // Deliberately NOT gated on alertsAllowed: giving up is terminal (nothing
        // retries this row), so holding the page for opening hours would mean an
        // order quietly never reaching Qingyun. It's one message that sits in the
        // group until morning, not a repeating page.
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
      loginFailStreak[storeCode] = (loginFailStreak[storeCode] || 0) + 1;
      const held = loginFailStreak[storeCode] >= LOGIN_DOWN_GRACE && !alertsAllowed(storeCode);
      log(storeCode, `not logged in — skipping poll (${loginFailStreak[storeCode]}/${LOGIN_DOWN_GRACE})`
        + (held ? ' — store shut, holding the page until it opens' : ''));
      // Debounce: only page ops once the session has stayed down for GRACE consecutive
      // polls — a lone transient blip clears before we ever alert (no more 3am false alarms).
      // The streak keeps counting while the store is shut, so a session that's still
      // down at opening pages on the first poll of the day rather than 90s later.
      if (!downFlagged['login:' + storeCode] && loginFailStreak[storeCode] >= LOGIN_DOWN_GRACE
          && alertsAllowed(storeCode)) {
        downFlagged['login:' + storeCode] = true;
        logSync(storeCode, 'needs_login', 'error', null, '青云 Chrome not logged in — scan the QR on the box');
        sendOpsAlert(`🔴 青云聚信 ${storeCode} 未登录，配送跟踪已停止，需要扫码重新登录\nQingyun ${storeCode} not logged in — tracking stopped, scan QR to re-login`);
      }
      heartbeat(storeCode, false);
      return;
    }
    // Keep the latch until we're allowed to say it's over, so a session that dropped
    // at 19:00 and came back at 02:00 still gets its all-clear when someone's there.
    const wasDown = downFlagged['login:' + storeCode] && alertsAllowed(storeCode);
    if (wasDown) downFlagged['login:' + storeCode] = false;
    loginFailStreak[storeCode] = 0;
    heartbeat(storeCode, true);
    noteLoginOk(storeCode);

    // Phase 2: create any queued paid delivery orders in Qingyun (no-op unless the
    // toggle is on and rows are pending). Runs while logged in, before tracking, so
    // a push isn't held up by the tracking bootstrap. Never blocks the poll.
    try { await drainPushQueue(storeCode, br); } catch (e) { log(storeCode, `push drain error: ${e.message}`); }
    if (wasDown) sendOpsAlert(`✅ 青云聚信 ${storeCode} 重新登录成功，配送跟踪继续\nQingyun ${storeCode} logged back in — tracking resumed`);
    noteVerifyResult(storeCode, false);

    const { ok, bootstrap, orders, reason } = await br.getActiveDeliveries();
    if (br.verificationRequired) { noteVerifyResult(storeCode, true); return; }
    if (bootstrap) {
      // EVERY order/list tab call failed and the self-heal drive (re-arm capture →
      // order page → 配送中 tab → reload) didn't restore it. The old alert here said
      // "lost the captured order list — open the 配送中 tab", which described the
      // capture-replay design the poll no longer uses: since order/list moved to our
      // own signed calls, this state means the page can't reach the API at all. Say
      // that, and carry the last failure so whoever gets paged knows whether they're
      // walking to the box for a risk-control block, a dead session, or a hung page.
      // The clock keeps running while the store is shut and the page waits for
      // opening, so the morning's alert carries the true duration — a "~900 min"
      // tells ops straight away this is an overnight death, not a fresh blip.
      if (!bootstrapSince[storeCode]) bootstrapSince[storeCode] = Date.now();
      if (!bootstrapFlagged['bootstrap:' + storeCode] && Date.now() - bootstrapSince[storeCode] >= BOOTSTRAP_ALERT_MS
          && alertsAllowed(storeCode)) {
        bootstrapFlagged['bootstrap:' + storeCode] = true;
        const mins = Math.round((Date.now() - bootstrapSince[storeCode]) / 60000);
        const why = reason ? ` [${reason}]` : '';
        sendOpsAlert(`🔴 青云聚信 ${storeCode} 订单接口连续约 ${mins} 分钟失败，自动修复无效，配送跟踪已停止 — 请在盒子上打开青云订单页，确认仍处于登录状态${why}\nQingyun ${storeCode} order/list failing for ~${mins} min and self-heal didn't fix it — tracking stopped; open the Qingyun order page on the box and check it's still logged in${why}`);
      }
      log(storeCode, `order/list unavailable — self-heal did not restore it${reason ? ` (${reason})` : ''}`);
      logSync(storeCode, 'bootstrap', 'error', null, `order/list unavailable — self-heal did not restore it${reason ? ` (${reason})` : ''}`);
      return;
    }
    if (bootstrapFlagged['bootstrap:' + storeCode] && alertsAllowed(storeCode)) {
      bootstrapFlagged['bootstrap:' + storeCode] = false;
      sendOpsAlert(`✅ 青云聚信 ${storeCode} 订单接口已恢复，配送跟踪继续\nQingyun ${storeCode} order/list answering again — tracking resumed`);
    }
    bootstrapSince[storeCode] = 0;
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
      const retailOrderId = isSuperseded(d.qingyunOrderId) ? null : matchRetailOrderId(d);
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
          'SELECT retail_order_id, order_status, superseded FROM delivery_jobs WHERE qingyun_order_id = ?'
        ).get(d.qingyunOrderId);
        if (!existing) continue;                                  // untracked → skip
        if ((existing.order_status ?? 0) >= DELIVERED_STATUS) continue; // already delivered
        const retailOrderId = existing.superseded
          ? null                                                  // abandoned copy — never re-link
          : (existing.retail_order_id || matchRetailOrderId(d));
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
  const warmupFlagged = {};  // store_code → log the cold-Chrome hold once per transition

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Date.now();

    if (!(await proxyHealthy())) {
      proxyFailStreak++;
      // Log the outage the moment the streak crosses, whatever the hour — the page
      // itself waits for a store to be open (see alertsAllowed), so the console is
      // the only trace of a night-time drop until then.
      if (proxyFailStreak === PROXY_DOWN_GRACE) {
        console.log(`[qingyun-daemon] ${new Date().toISOString()} PROXY UNREACHABLE (${maskProxy(PROXY)}) — pausing (session NOT logged out)`);
      }
      if (!alerts[PROXY_LATCH] && proxyFailStreak >= PROXY_DOWN_GRACE && anyStoreAlertsAllowed()) {
        alerts[PROXY_LATCH] = true;
        for (const s of STORES) logSync(s, 'proxy_down', 'error', null, 'proxy cannot reach Meituan — tracking paused');
        sendOpsAlert(`🔴 青云聚信 代理掉线，无法连接，配送跟踪已暂停（未掉登录）\nQingyun proxy down — tracking paused (not logged out)`);
      }
      await sleep(jitter(POLL_MS));
      continue;
    }
    proxyFailStreak = 0;
    if (alerts[PROXY_LATCH] && anyStoreAlertsAllowed()) {
      alerts[PROXY_LATCH] = false;
      console.log(`[qingyun-daemon] ${new Date().toISOString()} proxy recovered — resuming`);
      for (const s of STORES) logSync(s, 'proxy_up', 'ok', null, 'proxy reachable again — tracking resumed');
      sendOpsAlert(`✅ 青云聚信 代理已恢复，配送跟踪继续\nQingyun proxy recovered — tracking resumed`);
    }

    for (const s of STORES) heartbeatTick(s);

    if (now - last >= gap) {
      last = now;
      gap = jitter(POLL_MS, 0.3);
      for (const storeCode of STORES) {
        // Each store has its own holder Chrome (own CDP port) — skip only the one
        // that just relaunched, and only until it's warm. A skipped poll costs one
        // cycle; hitting a cold browser costs a 30-min risk-control cool-down.
        const coldMs = await coldMsRemaining(resolveCdpUrl(storeCode));
        if (coldMs > 0) {
          if (!warmupFlagged[storeCode]) {
            warmupFlagged[storeCode] = true;
            log(storeCode, `holder Chrome relaunched — holding calls ~${Math.round(coldMs / 1000)}s so it isn't hit cold`);
            logSync(storeCode, 'chrome_warmup', 'ok', null, 'holder Chrome relaunched — pausing calls for the warm-up window');
          }
          continue;
        }
        if (warmupFlagged[storeCode]) {
          warmupFlagged[storeCode] = false;
          log(storeCode, 'browser warm — resuming polling');
          logSync(storeCode, 'chrome_warm', 'ok', null, 'warm-up over — tracking resumed');
        }
        await pollStore(storeCode);
      }
    }
    await sleep(jitter(5_000));
  }
}

process.on('SIGINT',  async () => { await closeAllQingyun(); process.exit(0); });
process.on('SIGTERM', async () => { await closeAllQingyun(); process.exit(0); });

main().catch(err => { console.error('[qingyun-daemon] fatal:', err); process.exit(1); });
