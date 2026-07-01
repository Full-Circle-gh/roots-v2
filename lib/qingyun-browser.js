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
const HOST    = 'https://saas.cyanclouds.com';
// csec params the page appends to every call; H5guard adds mtgsig on top.
const CSEC_QS = 'yodaReady=h5&csecplatform=4&csecversion=4.2.4';

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
  }

  _log(msg) { console.log(`[qingyun:${this.storeCode}] ${msg}`); }

  // Attach to the genuine Chrome over CDP and grab its logged-in Qingyun page. Safe to
  // call repeatedly — reconnects if the previous attach was torn down.
  async connect() {
    if (this.page && !this.page.isClosed()) return this.page;
    // Tear down any stale CDP attach before reconnecting. Without this, every
    // reconnect (Chrome not logged in / no cyanclouds page / 验证中心) leaks the
    // previous connectOverCDP WebSocket — one fd + its buffers per failed poll
    // (~every 25s) — which over hours climbs fd/memory and wedges the box.
    if (this.browser) { try { await this.browser.close(); } catch { /* ignore */ } this.browser = null; }
    const browser = await playwright.chromium.connectOverCDP(CDP_URL);
    this.browser = browser;
    try {
      this.context = browser.contexts()[0];
      if (!this.context) throw new Error('no browser context on the CDP target');
      const pages = this.context.pages();
      this.page = pages.find(p => p.url().includes('cyanclouds.com'))
               || pages.find(p => p.url().includes('meituan.com'))
               || pages[0];
      if (!this.page) throw new Error('no Qingyun page open in the genuine Chrome');
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
    if (this._captureInstalled && this.page && !this.page.isClosed()) return;
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

  // Active deliveries to track. We REPLAY order/list using the app's last real request
  // body (harvested by _installCapture) — that body carries the correct, signed query
  // params for whichever tab the app last loaded. The genuine Chrome should be parked
  // on a view that lists in-flight orders (待取货/配送中). Returns { ok, bootstrap,
  // orders }. `bootstrap:true` means the app hasn't issued an order/list yet (open the
  // order page once in the genuine Chrome); the daemon logs it instead of erroring.
  async getActiveDeliveries() {
    this.verificationRequired = false;
    const cap = await this._captured('list');
    if (!cap || !cap.body) return { ok: false, bootstrap: true, orders: [] };
    const r = await this._api('order/list', cap.body);
    if (r.code !== 0 || !r.data) {
      this._log(`order/list failed (status ${r.status}, code ${r.code}, ${r.msg})`);
      return { ok: false, bootstrap: false, orders: [] };
    }
    const list = Array.isArray(r.data.dataList) ? r.data.dataList : [];
    return { ok: true, bootstrap: false, orders: list.map(o => this._parseOrder(o)) };
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

module.exports = { QingyunBrowser, getQingyunBrowser, closeAllQingyun };
