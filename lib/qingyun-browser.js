'use strict';

/* global window, document, XMLHttpRequest --
   these are browser globals referenced INSIDE page.evaluate() callbacks, which run
   in the logged-in Chrome page context (not Node). Declaring them keeps the deploy's
   eslint no-undef gate happy without disabling the rule for genuine Node typos. */

// 青云聚信 (Qingyun Juxin, https://saas.cyanclouds.com) browser bridge.
//
// 青云聚信 is MEITUAN'S OWN delivery AGGREGATOR — it bundles many carriers
// (京东急送/京东特惠/货拉拉跑腿/闪送/美团配送…) behind one dispatch, so reading at this
// one layer covers every courier the merchant uses. The portal is plain Meituan
// plumbing: every data call is `POST /api/pc/...`, application/x-www-form-urlencoded,
// cookie + H5guard-signed (mtgsig), `{code:0,data}` envelope — IDENTICAL to the 闪购
// crack (lib/shangou-browser.js). So, like 闪购, the data APIs reject Playwright's
// automation fingerprint; we attach over CDP to a GENUINE Chrome we launch ourselves
// (scripts/qingyun-chrome.js, headful under Xvfb, GZ/residential proxy) and issue all
// calls via fetch FROM INSIDE the logged-in page, where H5guard signs them.
//
// Two footguns learned during recon (2026-06-29, see feature_qingyun_delivery_tracking):
//   1. Content-Type MUST be application/x-www-form-urlencoded — JSON bodies 415.
//   2. The app issues its calls via XMLHttpRequest holding its OWN saved reference,
//      so a window.fetch override is bypassed (can't intercept that way). We don't
//      need to: we REPLAY the calls ourselves via the page's fetch (H5guard still
//      signs it) and also passively HARVEST the bodies the app sends by patching
//      XMLHttpRequest.prototype (a prototype patch can't be bypassed) — that gives us
//      the exact, correct request body for order/list without guessing its params.
//
// Read-only (Phase 1): we never dispatch/cancel here — staff still dispatch by hand
// in the app; we only READ status + rider GPS and relay it to the customer.

const playwright = require('playwright');

const CDP_URL = process.env.QINGYUN_CDP_URL || 'http://127.0.0.1:9343';
// Per-store CDP endpoint. Each store's daemon runs one Chrome (its own QINGYUN_CDP_URL),
// but roots-v2 drives BOTH stores' Chromes from a single process (for the on-demand
// carrier picker / dispatch), so it resolves each store to its own port via
// QINGYUN_CDP_URL_<STORE> (e.g. QINGYUN_CDP_URL_YUEXIU=http://127.0.0.1:9345), falling
// back to QINGYUN_CDP_URL. Store-agnostic callers (the daemon) just use the default.
function resolveCdpUrl(storeCode) {
  const key = 'QINGYUN_CDP_URL_' + String(storeCode || '').toUpperCase();
  return process.env[key] || CDP_URL;
}
// A Qingyun merchant account can be bound to MORE THAN ONE shop (confirmed for
// yuexiu 2026-07-26: merchant/shop/list returns TWO shops at the same address,
// id 10392199 "GO VEGAN 哈素萌" and id 9762205 "GO VEGAN!哈素萌" — list order is
// whatever Qingyun's API returns, not meaningful). getShop() below defaults to
// list[0], which is wrong whenever the operator wants the OTHER shop. Set
// QINGYUN_SHOP_ID_<STORE> (e.g. QINGYUN_SHOP_ID_YUEXIU=9762205) to pin it.
function resolveShopId(storeCode) {
  const key = 'QINGYUN_SHOP_ID_' + String(storeCode || '').toUpperCase();
  const v = process.env[key];
  return v ? String(v).trim() : null;
}
const HOST    = 'https://saas.cyanclouds.com';
// csec params the page appends to every call; H5guard adds mtgsig on top.
const CSEC_QS = 'yodaReady=h5&csecplatform=4&csecversion=4.2.4';
// The order SPA the genuine Chrome parks on (order/list fires from here).
const ORDER_URL = `${HOST}/aggregator/saas/order`;
// Order-list TAB statuses that can hold an active (undelivered) delivery. Poll them
// all and merge; the caller keeps only orderStatus<50, so a superset is harmless.
//
// Re-mapped from the live portal 2026-07-29 by clicking each tab and recording the
// status it queries — the codes had SHIFTED under us:
//   5 = 待配送 (created, no courier called)   10 = 待抢单 (courier called, no rider yet)
//  20 = 待取货 (rider assigned, collecting)   30 = 配送中 (on the way)
// This list used to read '20,30' from back when 20 meant 待配送. It silently became
// "待取货 + 配送中", so an order sitting awaiting-dispatch — every freshly auto-pushed
// order — was invisible to tracking, along with the whole finding-a-rider stage. The
// symptom was a store logging "tracked 0 active delivery(ies)" while its 待配送 tab
// had orders in it. Override via env if they move again.
const ACTIVE_LIST_STATUSES = (process.env.QINGYUN_ACTIVE_STATUSES || '5,10,20,30')
  .split(',').map(s => s.trim()).filter(Boolean);
// Don't drive the page (reload / tab-click) more than once per this window, so a
// persistent problem can't reload-storm the portal.
const RECOVER_COOLDOWN_MS = Number(process.env.QINGYUN_RECOVER_COOLDOWN_MS || 60_000);

const norm = (s) => String(s == null ? '' : s).trim();
const numOrNull = (v) => (v == null || v === '' || Number.isNaN(Number(v))) ? null : Number(v);

class QingyunBrowser {
  constructor(storeCode) {
    this.storeCode = storeCode;
    this.browser = null;
    this.context = null;
    this.page = null;
    // Mirrors lib/shangou-browser so the daemon's verify cool-down logic is reusable.
    this.verificationRequired = false;
    this._captureInstalled = false;
    this._loadHooked = false;   // page.on('load') wired once per attached page
    this._lastRecoverAt = 0;    // rate-limit active page-drive recovery
    this._shop = null; // cached merchant/shop/list result (shopId + cityId)
    this.cdpUrl = resolveCdpUrl(storeCode); // this store's Chrome (per-store port)
  }

  _log(msg) { console.log(`[qingyun:${this.storeCode}] ${msg}`); }

  // Attach to the genuine Chrome over CDP and grab its logged-in Qingyun page. Safe to
  // call repeatedly — reconnects if the previous attach was torn down.
  async connect() {
    if (this.page && !this.page.isClosed()) return this.page;
    this._loadHooked = false;
    // Tear down any stale CDP attach before reconnecting. Without this, every
    // reconnect (Chrome not logged in / no cyanclouds page / 验证中心) leaks the
    // previous connectOverCDP WebSocket — one fd + its buffers per failed poll
    // (~every 25s) — which over hours climbs fd/memory and wedges the box.
    if (this.browser) { try { await this.browser.close(); } catch { /* ignore */ } this.browser = null; }
    const browser = await playwright.chromium.connectOverCDP(this.cdpUrl);
    this.browser = browser;
    try {
      this.context = browser.contexts()[0];
      if (!this.context) throw new Error('no browser context on the CDP target');
      const pages = this.context.pages();
      this.page = pages.find(p => p.url().includes('cyanclouds.com'))
               || pages.find(p => p.url().includes('meituan.com'))
               || pages[0];
      if (!this.page) throw new Error('no Qingyun page open in the genuine Chrome');
      // Re-arm the capture hook on EVERY page load/navigation. This is the fix for the
      // recurring "lost the captured order list (page likely reloaded)" stall: a reload
      // wipes window.__qy AND the in-page hook, but the page object stays alive so
      // connect() used to early-return without ever re-installing. Now every reload
      // fires this listener and re-arms the hook, so the app's next order/list is caught.
      if (!this._loadHooked) {
        this._loadHooked = true;
        this.page.on('load', () => {
          this._captureInstalled = false;
          this._installCapture().catch(() => { /* best-effort */ });
        });
      }
      await this._installCapture();
      return this.page;
    } catch (e) {
      // Don't leak the connection we just opened when wiring it up fails.
      try { await browser.close(); } catch { /* ignore */ }
      this.browser = this.context = this.page = null;
      throw e;
    }
  }

  // Patch XMLHttpRequest in the page (idempotent) so the app's OWN order/list and
  // coordinate calls are recorded into window.__qy with their real (correctly-signed-
  // context) request bodies. We reuse those bodies to replay — this is how we get the
  // exact order/list query params without ever seeing them client-side. The patch is
  // a prototype patch, so it can't be bypassed by a saved reference.
  async _installCapture() {
    // Always run the in-page evaluate — it self-guards on window.__qyInstalled, which
    // is the ONLY reliable signal (a Node-side flag goes stale the instant the page
    // reloads out from under us). The evaluate is a cheap no-op once armed.
    if (!this.page || this.page.isClosed()) return;
    try {
      await this.page.evaluate(() => {
        if (window.__qyInstalled) return;
        window.__qyInstalled = true;
        window.__qy = window.__qy || {};
        const oOpen = XMLHttpRequest.prototype.open;
        const oSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (m, u) { this.__qyUrl = u; return oOpen.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function (b) {
          const self = this;
          this.addEventListener('load', function () {
            try {
              const u = self.__qyUrl || '';
              if (typeof u !== 'string' || !u.includes('/api/pc/order/')) return;
              const path = u.split('?')[0].split('/api/pc/')[1];
              const body = b != null ? String(b) : '';
              for (const ep of ['list/count', 'mapOrderList', 'detail/coordinate', 'list', 'detail']) {
                if (path === 'order/' + ep) { window.__qy[ep] = { body, resp: (self.responseText || '') }; break; }
              }
            } catch (e) { /* ignore */ }
          });
          return oSend.apply(this, arguments);
        };
      });
      this._captureInstalled = true;
    } catch (e) {
      this._log(`installCapture failed: ${e.message}`);
    }
  }

  // Issue an authenticated form-urlencoded POST FROM THE PAGE CONTEXT so H5guard signs
  // it. Returns { status, code, msg, data }. A 401/redirect flags re-login; a 403 /
  // 验证中心 flags verification (mirrors the 闪购 contract).
  async _api(path, body) {
    await this.connect();
    const out = await this.page.evaluate(async ({ host, path, qs, body }) => {
      try {
        const res = await fetch(`${host}/api/pc/${path}?${qs}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body != null ? body : '',
          credentials: 'include',
        });
        let json = null, text = '';
        try { text = await res.text(); json = JSON.parse(text); } catch (e) { /* non-JSON */ }
        return { status: res.status, code: json ? json.code : null,
                 msg: json ? (json.msg || json.message || '') : text.slice(0, 300),
                 data: json ? json.data : null };
      } catch (e) { return { status: 0, code: null, msg: String(e), data: null }; }
    }, { host: HOST, path, qs: CSEC_QS, body });

    if (out.status === 401 || /login|passport\.meituan/.test(out.msg || '')) {
      // handled by isLoggedIn / caller
    }
    if (out.status === 403 || /verify\.meituan|验证中心/.test(out.msg || '')) {
      this.verificationRequired = true;
    }
    return out;
  }

  // Read whatever the app has captured into window.__qy for one endpoint:
  // { body, resp } or null. Bodies are the REAL request bodies (use to replay).
  async _captured(ep) {
    await this.connect();
    try {
      return await this.page.evaluate((k) => (window.__qy && window.__qy[k]) || null, ep);
    } catch (e) { return null; }
  }

  // True when the attached page is on the merchant dashboard (not the login QR gate).
  // The Qingyun data APIs return code:0 only for an authenticated session. We replay
  // the app's last real order/list/count body (cheap, no side effects). If the app
  // hasn't issued one yet, fall back to a URL check.
  async isLoggedIn() {
    try {
      this.verificationRequired = false;
      await this.connect();
      const url = this.page.url();
      if (/\/login|passport\.meituan|waimaie\.meituan.*login/.test(url)) return false;
      const cap = await this._captured('list/count');
      if (cap && cap.body) {
        const r = await this._api('order/list/count', cap.body);
        return r.code === 0;
      }
      // No captured body yet — best-effort: a logged-in page is on /aggregator/saas.
      // The QR login page lives at the site root.
      return /\/aggregator\/saas/.test(url);
    } catch (e) { return false; }
  }

  // ── Reads ──────────────────────────────────────────────────────────────────
  // Normalise one order/list dataList[] entry to the fields we relay. orderStatus:
  // 20 待配送 → 30 in-flight(grabbed→delivering) → 50 已送达. orderDeliveryInfo carries
  // the carrier + rider once a courier grabs it. userRemark is the 备注 we stamp with
  // the roots order ref (matchKey).
  _parseOrder(o) {
    const di = o.orderDeliveryInfo || {};
    return {
      qingyunOrderId: norm(o.orderId || o.tradeOrderId),
      channelOrderId: norm(o.channelOrderId),
      channelName: norm(o.channelName),
      orderStatus: numOrNull(o.orderStatus),
      deliveryStatus: numOrNull(o.deliveryStatus),
      carrierName: norm(di.carrierName || ''),
      deliveryId: norm(o.deliveryId || ''),
      riderName: norm(o.riderNamePlain || o.riderName || di.riderName || ''),
      riderPhone: norm(o.riderPhonePlain || o.riderPhone || di.riderPhone || ''),
      recipientName: norm(o.recipientName),
      recipientPhone: norm(o.recipientPhonePlain || o.recipientPhone),
      recipientAddr: norm(o.recipientAddressPlain || o.recipientAddress),
      recipientLat: numOrNull(o.recipientLat),
      recipientLng: numOrNull(o.recipientLng),
      userRemark: norm(o.userRemark),
      expectedDeliveredTime: o.expectedDeliveredTime || null,
      raw: o,
    };
  }

  // Active deliveries to track. The caller (daemon) has already confirmed the session
  // is logged in, so we query the order-list tabs directly with our own signed body
  // (H5guard signs each _api call in-page — we don't need the app's captured body).
  // We poll every ACTIVE_LIST_STATUSES tab and MERGE, keeping only in-flight orders
  // (orderStatus < DELIVERED). This catches 青云自建 self-pushed orders that stay on
  // tab 20 after a rider grabs them, which the old 配送中-only (tab 30) poll missed.
  // Returns { ok, bootstrap, orders }. bootstrap:true only when EVERY tab call failed
  // (session likely dropped mid-poll) — a human/self-heal is then needed.
  async getActiveDeliveries() {
    this.verificationRequired = false;
    let res = await this._pollActiveTabs();
    if (!res.anyOk) {
      // Every tab call failed — the page may have navigated away / lost session since
      // the isLoggedIn gate. Drive the self-heal, then RE-POLL in this same cycle: a
      // drive that worked should resume tracking now, not one poll interval later.
      let healed = false;
      try { healed = await this._recaptureOrderList(); }
      catch (e) { this._log(`recapture failed: ${e.message}`); }
      if (healed) res = await this._pollActiveTabs();
      if (!res.anyOk) {
        // `reason` travels to the ops alert: "every order/list failed" is not
        // actionable on its own, but a 403 vs a session error vs a hung page tells
        // whoever gets paged which of those they're walking to the box to fix.
        return { ok: false, bootstrap: true, orders: [], reason: res.lastFail || 'order/list failed with no response' };
      }
    }
    return { ok: true, bootstrap: false, orders: [...res.byId.values()] };
  }

  // Poll every active tab once and merge. Returns { anyOk, byId, lastFail } — the
  // caller decides what a total failure means.
  async _pollActiveTabs() {
    const DELIVERED = 50;
    const byId = new Map();
    let anyOk = false, lastFail = '';
    for (const st of ACTIVE_LIST_STATUSES) {
      const body = `webVersion=4.5.25&status=${st}&sortRule=11&pageNum=1&pageSize=20`;
      let r;
      try { r = await this._api('order/list', body); }
      catch (e) { lastFail = `tab ${st} threw: ${e.message}`; this._log(`order/list status=${st} threw: ${e.message}`); continue; }
      if (r.code !== 0 || !r.data) {
        lastFail = `tab ${st}: HTTP ${r.status}, code ${r.code}${r.msg ? ', ' + String(r.msg).slice(0, 120) : ''}`;
        this._log(`order/list status=${st} failed (status ${r.status}, code ${r.code}, ${r.msg})`);
        continue;
      }
      anyOk = true;
      const list = Array.isArray(r.data.dataList) ? r.data.dataList : [];
      for (const raw of list) {
        const o = this._parseOrder(raw);
        if (!o.qingyunOrderId) continue;
        if (o.orderStatus != null && o.orderStatus >= DELIVERED) continue; // delivered/history
        // First tab that carries a given order wins (they can overlap across tabs).
        if (!byId.has(o.qingyunOrderId)) byId.set(o.qingyunOrderId, o);
      }
    }
    return { anyOk, byId, lastFail };
  }

  // Recently-completed (已送达, orderStatus 50) deliveries — the first page of the
  // 完成 tab. Used only to RECONCILE orders we already track (mark them delivered on
  // the rider's real drop-off); the daemon never imports untracked history. Returns
  // a parsed-order array (empty on any error — completion reconcile is best-effort).
  async getCompletedDeliveries() {
    try {
      const r = await this._api('order/list', 'webVersion=4.5.25&status=50&sortRule=11&pageNum=1&pageSize=20');
      if (r.code !== 0 || !r.data) { this._log(`order/list completed failed (code ${r.code}, ${r.msg})`); return []; }
      const list = Array.isArray(r.data.dataList) ? r.data.dataList : [];
      return list.map(o => this._parseOrder(o));
    } catch (e) { this._log(`getCompletedDeliveries threw: ${e.message}`); return []; }
  }

  // Make the app re-issue order/list without a human. A reload (or fresh login) wipes
  // window.__qy, so we have no body to replay; here we re-arm the capture hook, make
  // sure we're on the order SPA, click the 配送中 tab (AJAX, fires order/list), and — if
  // the tab isn't there — hard-reload so the SPA fires its own list on mount. Bounded
  // wait for the capture to land. Rate-limited (RECOVER_COOLDOWN_MS) so a persistent
  // fault can't reload-storm the portal. Best-effort; returns true if it recaptured.
  async _recaptureOrderList() {
    const now = Date.now();
    if (this._lastRecoverAt && now - this._lastRecoverAt < RECOVER_COOLDOWN_MS) return false;
    this._lastRecoverAt = now;
    await this.connect();
    await this._installCapture();

    try {
      if (!/\/aggregator\/saas\/order/.test(this.page.url())) {
        await this.page.goto(ORDER_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await this._installCapture(); // fresh document — re-arm before it fires anything
      }
    } catch (e) { this._log(`recapture goto: ${e.message}`); }

    let clicked = await this._clickDeliveringTab();
    if (!clicked) {
      // Tab absent (page still booting or markup changed) — a hard reload re-runs the
      // SPA, which issues its own default order/list on mount.
      try {
        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
        await this._installCapture();
        clicked = await this._clickDeliveringTab();
      } catch (e) { this._log(`recapture reload: ${e.message}`); }
    }

    // Verify by what the tracker actually USES: a signed order/list must succeed.
    // The old check waited for window.__qy — the captured body the active-delivery
    // poll stopped needing once it moved to its own signed calls — so a drive that
    // had genuinely fixed the page still reported failure, and the daemon paged a
    // human to "open the 配送中 tab" for a page that was already working.
    try {
      const st = ACTIVE_LIST_STATUSES[0];
      const r = await this._api('order/list', `webVersion=4.5.25&status=${st}&sortRule=11&pageNum=1&pageSize=1`);
      const okNow = r.code === 0 && !!r.data;
      this._log(okNow
        ? 'order/list answering again — tracking self-healed'
        : `self-heal drive did not restore order/list (status ${r.status}, code ${r.code}, ${r.msg})`);
      return okNow;
    } catch (e) { this._log(`self-heal probe threw: ${e.message}`); return false; }
  }

  // Click the 配送中 (in-flight) tab within the order SPA so the app fires an order/list
  // for the view we track. Tolerant of minor markup changes; never throws.
  async _clickDeliveringTab() {
    try {
      const tab = this.page.locator(
        'span.order-tab-label:has-text("配送中"), .order-tab:has-text("配送中"), [class*="tab"]:has-text("配送中")'
      ).first();
      await tab.waitFor({ state: 'visible', timeout: 6_000 });
      await tab.click({ timeout: 4_000 });
      return true;
    } catch { return false; }
  }

  // Live rider track for one order: POST order/detail/coordinate (body: orderId).
  // Returns the GCJ-02 ×1e6 rider position + route. riderLat/Lng are null once the
  // order is delivered (the endpoint stops returning them). Returns null on failure.
  async getRiderTrack(qingyunOrderId) {
    const body = `orderId=${encodeURIComponent(qingyunOrderId)}`;
    const r = await this._api('order/detail/coordinate', body);
    if (r.code !== 0 || !r.data) return null;
    const d = r.data;
    const route = d.routeInfo || {};
    return {
      orderStatus: numOrNull(d.orderStatus),
      deliveryStatus: numOrNull(d.deliveryStatus),
      deliveryId: norm(d.deliveryId || ''),
      waybillId: norm(d.waybillId || ''),
      riderLat: numOrNull(d.riderLat),     // GCJ-02 ×1e6 (null once delivered)
      riderLng: numOrNull(d.riderLng),
      shopLat: numOrNull(d.shopLat),
      shopLng: numOrNull(d.shopLng),
      recipientLat: numOrNull(d.recipientLat),
      recipientLng: numOrNull(d.recipientLng),
      riderToShopM: numOrNull(d.riderShopDistance),
      riderToCustM: numOrNull(d.riderRecipientDistance),
      deliveryDistanceM: numOrNull(d.deliveryDistance),
      etaSeconds: numOrNull(route.duration),
      routeCoords: Array.isArray(route.routeCoords) ? route.routeCoords : [], // [{lng,lat}] ×1e6
      raw: d,
    };
  }

  // ── Writes (Phase 2): create a same-city delivery order ──────────────────────
  // Look up THIS store's Qingyun shop (shopId + cityId). Cached per instance. A
  // single-store merchant account returns one shop. Needed as the create call's
  // sender (shopId) and to bound geocoding to the shop's city (同城 = same city).
  async getShop() {
    if (this._shop) return this._shop;
    const r = await this._api('merchant/shop/list', 'webVersion=4.5.25&pageNum=1&pageSize=20&keywords=');
    const list = (r.code === 0 && r.data && Array.isArray(r.data.list)) ? r.data.list : [];
    const wantId = resolveShopId(this.storeCode);
    const s = (wantId && list.find((x) => norm(x.id) === wantId)) || list[0] || null;
    if (!s) return null;
    this._shop = {
      shopId: norm(s.id), cityId: numOrNull(s.cityId), name: norm(s.name),
      lat: numOrNull(s.lat), lng: numOrNull(s.lng),
    };
    return this._shop;
  }

  // Geocode a free-text address within a city → { lng, lat } as GCJ-02 ×1e6 ints +
  // cityId. Same call the create form's address box uses (dap/lbs/keyWordSearch);
  // takes the top POI. Only used as a FALLBACK when the roots order has no precise
  // customer pin. Returns null when nothing matches.
  async geocode(address, cityId) {
    const body = `webVersion=4.5.25&keywords=${encodeURIComponent(norm(address))}`
      + `&city=${encodeURIComponent(cityId || '')}&cityLimit=true&page=1&pageSize=20`;
    const r = await this._api('dap/lbs/keyWordSearch', body);
    const poi = (r.code === 0 && r.data && Array.isArray(r.data.pois)) ? r.data.pois[0] : null;
    if (!poi || !poi.location) return null;
    const [lng, lat] = String(poi.location).split(',').map(Number);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return {
      lng: Math.round(lng * 1e6), lat: Math.round(lat * 1e6),
      cityId: numOrNull(poi.citycode) || numOrNull(cityId),
      name: norm(poi.name), address: norm(poi.address),
    };
  }

  // Create a 同城配送 (same-city) delivery order → it lands in the merchant's 待配送
  // list with NO courier dispatched (staff still pick the carrier). This is the ONLY
  // write we do. Idempotency is the caller's job (the push queue). Fields: { shopId,
  // recipientName, recipientPhone, recipientAddress, recipientLng, recipientLat (GCJ-02
  // ×1e6), cityId, doorInfo?, goods:[{name,price,count,picUrl?}], remark, expectFrom,
  // expectTo (unix seconds) }. Returns { ok, orderId, code, msg }.
  async createOrder(f) {
    const p = new URLSearchParams();
    p.set('webVersion', '4.5.25');
    p.set('fulfillmentType', '1');          // 1 = 同城配送
    p.set('shopId', String(f.shopId));
    p.set('recipientName', norm(f.recipientName));
    p.set('recipientPhone', norm(f.recipientPhone));
    p.set('recipientDoorInfo', norm(f.doorInfo));
    p.set('bookerExtPhoneNum', '');
    p.set('bookerPhone', '');
    const goods = (f.goods && f.goods.length) ? f.goods : [{ name: 'Order', price: 0, count: 1, picUrl: f.goodsPicUrl }];
    goods.forEach((g, i) => {
      p.set(`goodsInfo[${i}][name]`, (norm(g.name) || 'Order').slice(0, 50));
      p.set(`goodsInfo[${i}][price]`, String(g.price != null ? g.price : 0));
      p.set(`goodsInfo[${i}][count]`, String(g.count != null ? g.count : 1));
      const pic = g.picUrl || f.goodsPicUrl;
      if (pic) p.set(`goodsInfo[${i}][picUrl]`, pic);
    });
    p.set('invoiceInfo[taxTitle]', '');
    p.set('invoiceInfo[taxNo]', '');
    p.set('remark', norm(f.remark).slice(0, 200));
    p.set('remarkInfo[internalRemark]', '');
    p.set('remarkInfo[candleText]', '');
    p.set('remarkInfo[accessoriesText]', '');
    p.set('blessingText', '');
    p.set('recipientAddress', norm(f.recipientAddress));
    p.set('recipientLng', String(f.recipientLng));
    p.set('recipientLat', String(f.recipientLat));
    p.set('cityId', String(f.cityId));
    p.set('expectedLeftDeliveryTime', String(f.expectFrom));
    p.set('expectedRightDeliveryTime', String(f.expectTo));
    const r = await this._api('order/create', p.toString());
    return { ok: r.code === 0, orderId: r.code === 0 ? norm(r.data) : null, code: r.code, msg: r.msg, status: r.status };
  }

  // Remove an order from the merchant's Qingyun list. This is the portal's
  // 更多 → 删除订单 → 继续删除, captured live 2026-07-29: a precheck (order/hide/query)
  // then the write (order/hide/confirm), both form-urlencoded + signed, body just
  // `orderId`. Returns { ok, code, msg }.
  //
  // Scope: an order NOBODY has been sent for (待配送). That's what 删除订单 is offered
  // for — once a courier is called the portal offers a different action (cancelling a
  // live delivery, which can carry a fee), and we have NOT recon'd that one. Callers
  // must check the order is undispatched first; this method won't discover it for you.
  async cancelOrder(qingyunOrderId) {
    const body = `webVersion=4.5.25&orderId=${encodeURIComponent(qingyunOrderId)}`;
    // The dialog runs this before it opens; if Qingyun objects (already gone, wrong
    // state) it says so here and we never fire the write.
    const pre = await this._api('order/hide/query', body);
    if (pre.code !== 0) return { ok: false, code: pre.code, msg: pre.msg || 'precheck refused' };
    const r = await this._api('order/hide/confirm', body);
    return { ok: r.code === 0, code: r.code, msg: r.msg };
  }

  // ── Dispatch (Phase 2b): live carrier compare + send a courier ───────────────
  // Live 比价 for a 待配送 Qingyun order: list carriers + each one's current price.
  // Mirrors the app's dialog: queryShopPreviewConfig → serviceProductList, then a
  // previewSingle per carrier for the fee + a fresh waybillId (which delivery/create
  // needs). Returns { ok, carriers:[{carrierId, serviceCode, carrierName, serviceName,
  // tab, feeCents, feeYuan, distanceM, waybillId, recommended, cheapest, enabled}] }.
  // `enabled:false` carriers (not authorized / unsupported) are returned too so the UI
  // can grey them out. previewId is one shared client timestamp (as the app does).
  async quoteCarriers(qingyunOrderId) {
    const shop = await this.getShop();
    if (!shop || !shop.shopId) return { ok: false, msg: 'no shop', carriers: [] };
    const cfg = await this._api('delivery/queryShopPreviewConfig',
      `webVersion=4.5.25&shopId=${encodeURIComponent(shop.shopId)}&queryScene=2&version=&hash=`);
    if (cfg.code !== 0 || !cfg.data) return { ok: false, msg: cfg.msg || 'config failed', carriers: [] };
    const list = Array.isArray(cfg.data.serviceProductList) ? cfg.data.serviceProductList : [];
    const tabName = (m) => (m || {});
    const previewId = Date.now();
    const out = [];
    for (const sp of list) {
      const carrierId = sp.carrierId, serviceCode = norm(sp.serviceCode);
      const body = `webVersion=4.5.25&orderId=${encodeURIComponent(qingyunOrderId)}`
        + `&carrierId=${encodeURIComponent(carrierId)}&serviceCode=${encodeURIComponent(serviceCode)}`
        + `&insuredMark=0&scene=1&childOrderId=&serviceMode=${sp.serviceMode || 0}`
        + `&expectedPickupTime=0&scheduledDeliveryTime=0&previewId=${previewId}&isCarrierEnabled=1`;
      let pv = null;
      try { pv = await this._api('delivery/previewSingle', body); } catch (e) { /* one carrier failing shouldn't sink the list */ }
      const d = (pv && pv.code === 0) ? pv.data : null;
      out.push({
        carrierId, serviceCode,
        carrierName: norm(sp.carrierName), serviceName: norm(sp.serviceName),
        serviceMode: sp.serviceMode || 0,
        tab: Array.isArray(sp.serviceTags) && sp.serviceTags.length ? norm(sp.serviceTags[0].tagName) : '',
        feeCents: d ? numOrNull(d.totalFee) : null,
        feeYuan: d && d.totalFee != null ? Math.round(d.totalFee) / 100 : null,
        distanceM: d ? numOrNull(d.deliveryDistance) : null,
        waybillId: d ? norm(d.waybillId) : '',
        // A real, dispatchable courier quote = a positive fee + a waybill. The ¥0
        // rows (unauthorized 美团 / 商家自配送 self-delivery) come back priced 0; they're
        // returned for display but are NOT selectable couriers.
        enabled: !!(d && numOrNull(d.totalFee) > 0 && norm(d.waybillId)),
      });
    }
    // Flag the cheapest ENABLED carrier so the UI can pre-select it (Qingyun's own
    // default strategy is lowest_price).
    const enabled = out.filter(c => c.enabled && c.feeCents != null);
    if (enabled.length) {
      const min = enabled.reduce((a, b) => (b.feeCents < a.feeCents ? b : a));
      min.cheapest = true;
    }
    return { ok: true, carriers: out };
  }

  // Dispatch a 待配送 Qingyun order (发起配送 → delivery/create). Pass either ONE carrier
  // entry from quoteCarriers, or an ARRAY of them for concurrent dispatch (并发发单 — call
  // several couriers at once, whoever accepts first takes the order and only that one is
  // billed; the platform auto-cancels the rest). Every entry must carry a FRESH waybillId
  // (re-quote just before dispatch so it hasn't expired). tipCents = optional 小费. The fee
  // is deducted from the merchant's Qingyun wallet. Returns { ok, code, msg }.
  async dispatch(qingyunOrderId, carrier, tipCents = 0) {
    const shop = await this.getShop();
    if (!shop || !shop.shopId) return { ok: false, msg: 'no shop' };
    const picks = Array.isArray(carrier) ? carrier : [carrier];
    if (!picks.length || picks.some(p => !p || !p.waybillId)) {
      return { ok: false, msg: 'carrier missing waybillId (re-quote first)' };
    }
    const c = picks.map(p => ({
      carrierId: p.carrierId,
      carrierName: p.carrierName || '',
      serviceCode: p.serviceCode,
      serviceName: p.serviceName || '',
      deliveryFee: p.feeCents != null ? p.feeCents : 0,
      discountFee: 0, insuredFee: 0,
      deliveryDistance: p.distanceM != null ? p.distanceM : 0,
      tipAmount: tipCents || 0,
      serviceMode: p.serviceMode || 0,
      waybillId: p.waybillId,
      ignoreDeliveryFeeLimit: 0,
    }));
    const body = `webVersion=4.5.25&selfRiderDispatchMode=0&carrier=${encodeURIComponent(JSON.stringify(c))}`
      + `&orderId=${encodeURIComponent(qingyunOrderId)}&shopId=${encodeURIComponent(shop.shopId)}`
      + `&expectedPickupTime=0&scheduledDeliveryTime=0&remark=&adjustedWeight=0&insuredMark=0`;
    const r = await this._api('delivery/create', body);
    return { ok: r.code === 0, code: r.code, msg: r.msg, data: r.data };
  }

  // CDP-attached genuine Chrome persists its own profile to disk; nothing to do.
  async persistSession() { return true; }

  async close() {
    // Detach CDP only — never close the genuine Chrome (it's the long-lived agent).
    try { await this.browser?.close(); } catch { /* ignore */ }
    this.browser = this.context = this.page = null;
    this._captureInstalled = false;
  }
}

// Per-store singletons, mirroring lib/shangou-browser's getShangouBrowser/closeAll.
const _instances = {};
async function getQingyunBrowser(storeCode) {
  if (!_instances[storeCode]) _instances[storeCode] = new QingyunBrowser(storeCode);
  await _instances[storeCode].connect();
  return _instances[storeCode];
}
async function closeAllQingyun() {
  for (const b of Object.values(_instances)) { try { await b.close(); } catch { /* ignore */ } }
}

module.exports = { QingyunBrowser, getQingyunBrowser, closeAllQingyun, resolveCdpUrl };
