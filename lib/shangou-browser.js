'use strict';
/* global document */

// 闪购 (Meituan Instashopping, shangoue.meituan.com) browser bridge.
//
// Unlike lib/meituan-browser.js — which LAUNCHES a Playwright Chromium against the
// 外卖 backend (e.waimai.meituan.com) — the 闪购 data APIs reject any browser that
// carries Playwright's automation fingerprint (navigator.webdriver=true) with HTTP
// 403, regardless of session. The fix: attach over CDP to a GENUINE Chrome that we
// launch ourselves with only --remote-debugging-port (no automation flags), so
// webdriver stays false and Meituan's H5guard treats it as a real user. All data
// calls are issued via fetch FROM INSIDE the logged-in page, where H5guard
// transparently signs them with a valid `mtgsig` — so we never compute the
// signature ourselves and reads + the stock write are plain fetch calls.
//
// The genuine Chrome is launched + kept alive separately (scripts/shangou-chrome,
// headful under Xvfb on the box, routed through the GZ proxy). This module only
// attaches to it. See feature_meituan_tier1_fingerprint memory for the full story.

const playwright = require('playwright');

const CDP_URL    = process.env.SHANGOU_CDP_URL        || 'http://127.0.0.1:9333';
const WMPOIID    = process.env.SHANGOU_WMPOIID        || '12866824';
const REGION_ID  = process.env.SHANGOU_REGION_ID      || '1000440100';
const REGION_VER = process.env.SHANGOU_REGION_VERSION || '1631517219';
const HOST       = 'https://shangoue.meituan.com';
// csec params the page always appends; H5guard adds mtgsig on top of these.
const CSEC_QS = `region_id=${REGION_ID}&region_version=${REGION_VER}&yodaReady=h5&csecplatform=4&csecversion=4.2.4`;

const norm = (s) => String(s == null ? '' : s).trim();

class ShangouBrowser {
  constructor(storeCode) {
    this.storeCode = storeCode;
    this.browser   = null;
    this.context   = null;
    this.page      = null;
    // Mirrors lib/meituan-browser so the daemon's verify cool-down logic is reusable.
    this.verificationRequired = false;
  }

  _log(msg) { console.log(`[shangou:${this.storeCode}] ${msg}`); }

  // Attach to the genuine Chrome over CDP and grab its logged-in 闪购 page. Safe to
  // call repeatedly — reconnects if the previous attach was torn down.
  async connect() {
    if (this.page && !this.page.isClosed()) return this.page;
    // Tear down any stale CDP attach before reconnecting — otherwise every
    // reconnect (Chrome not logged in / no 闪购 page) leaks the previous
    // connectOverCDP WebSocket (an fd + buffers per attempt), climbing
    // fd/memory over time. yuexiu runs on this bridge, so keep it leak-free.
    if (this.browser) { try { await this.browser.close(); } catch { /* ignore */ } this.browser = null; }
    const browser = await playwright.chromium.connectOverCDP(CDP_URL);
    this.browser = browser;
    try {
      this.context = browser.contexts()[0];
      if (!this.context) throw new Error('no browser context on the CDP target');
      const pages = this.context.pages();
      this.page = pages.find(p => p.url().includes('shangoue.meituan.com'))
               || pages.find(p => p.url().includes('meituan.com'))
               || pages[0];
      if (!this.page) throw new Error('no 闪购 page open in the genuine Chrome');
      return this.page;
    } catch (e) {
      // Don't leak the connection we just opened when wiring it up fails.
      try { await browser.close(); } catch { /* ignore */ }
      this.browser = this.context = this.page = null;
      throw e;
    }
  }

  // True when the attached page is on the merchant dashboard (not the login gate).
  // The 闪购 data APIs return code:0 only for an authenticated session; a logged-out
  // page redirects to waimaie.meituan.com/.../login. We treat a non-zero/auth error
  // from a cheap call as "needs login".
  async isLoggedIn() {
    try {
      // Clear the per-operation verify flag so it reflects THIS check, not a stale
      // 403 from a previous call (the daemon reads it to detect both a fresh
      // challenge AND recovery). _api re-raises it if this call is challenged.
      this.verificationRequired = false;
      await this.connect();
      const url = this.page.url();
      if (/login_gw|\/logon|passport\.meituan/.test(url)) return false;
      // A 1-row product query is the cheapest call that returns code:0 only for an
      // authenticated session (a logged-out page 403s / returns a non-zero code).
      const r = await this._api('/reuse/sc/product/retail/r/searchListPageNew',
        `wmPoiId=${WMPOIID}&needTag=0&needCount=0&pageSize=1&pageNum=1`);
      return r.code === 0;
    } catch (e) { return false; }
  }

  // Issue an authenticated call FROM THE PAGE CONTEXT so H5guard signs it. Returns
  // { status, code, msg, data }. A 401/redirect-style failure flags re-login; a
  // verify challenge (rare on 闪购, but mirror the 外卖 contract) flags verification.
  async _api(path, body, method = 'POST') {
    await this.connect();
    const out = await this.page.evaluate(async ({ host, path, qs, body, method }) => {
      try {
        const res = await fetch(`${host}${path}?${qs}`, {
          method,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body != null ? body : undefined,
          credentials: 'include',
        });
        let json = null, text = '';
        try { text = await res.text(); json = JSON.parse(text); } catch (e) {}
        return { status: res.status, code: json ? json.code : null,
                 msg: json ? (json.msg || '') : text.slice(0, 300),
                 data: json ? json.data : null };
      } catch (e) { return { status: 0, code: null, msg: String(e), data: null }; }
    }, { host: HOST, path, qs: CSEC_QS, body, method });

    if (out.status === 403 || /verify\.meituan|验证中心/.test(out.msg || '')) {
      this.verificationRequired = true;
    }
    return out;
  }

  // ── Reads ────────────────────────────────────────────────────────────────────

  // Full product catalogue with per-sku stock. Paginates searchListPageNew. Returns
  // a flat list of skus: { spuId, spuName, skuId, code (货号/sourceFoodCode), spec,
  // stock, price }. `code` is the natural join key to a roots product SKU.
  async getProducts() {
    const all = [];
    const pageSize = 100;
    for (let pageNum = 1; pageNum <= 50; pageNum++) {
      const body = `wmPoiId=${WMPOIID}&needTag=0&needCount=1&needCombinationSpu=2&brandId=0&tagId=0`
        + `&searchWord=&state=0&saleStatus=0&limitSale=0&noStockAutoClear=-1&stockState=0`
        + `&minMonthSale=-1&maxMonthSale=-1&sellState=0&minPrice=-1&maxPrice=-1&productProblem=0`
        + `&tabStatus=0&sortType=0&pageSize=${pageSize}&pageNum=${pageNum}&productProblems=`;
      const r = await this._api('/reuse/sc/product/retail/r/searchListPageNew', body);
      if (r.code !== 0 || !r.data) {
        if (pageNum === 1) throw new Error(`searchListPageNew failed (status ${r.status}, code ${r.code}, ${r.msg})`);
        break;
      }
      const list = r.data.productList || [];
      for (const spu of list) {
        for (const sku of (spu.wmProductSkus || [])) {
          all.push({
            spuId:   spu.id,
            spuName: norm(spu.name),
            skuId:   sku.id,
            code:    norm(sku.sourceFoodCode),
            spec:    norm(sku.spec),
            stock:   sku.stock == null ? null : Number(sku.stock),
            price:   sku.price,
          });
        }
      }
      const total = Number(r.data.totalCount || 0);
      if (pageNum * pageSize >= total || list.length === 0) break;
    }
    return all;
  }

  // ── Writes ───────────────────────────────────────────────────────────────────

  // Set absolute stock for one 闪购 sku. Returns { ok, apiRejected }: `apiRejected`
  // is true ONLY for a genuine rejection — a real HTTP-200 reply with a non-zero
  // business code. status 0 (fetch threw), 403 (verify), or any non-200 is
  // TRANSIENT (apiRejected:false) and should be retried, not marked terminal.
  async setSkuStock(skuId, stock) {
    const body = `wmPoiId=${WMPOIID}&skuIds=${skuId}&stock=${Number(stock)}&editSource=1&packageConfirmFlag=false`;
    const r = await this._api('/reuse/sc/product/retail/w/batchUpdateSkuStock', body);
    const apiRejected = r.status === 200 && r.code != null && r.code !== 0;
    return { ok: r.code === 0, apiRejected };
  }

  // Daemon-compatible batch push. Takes the same item shape the meituan-daemon builds
  // ({ row, isBundle, targetCn, targetEn, sku, newQty }) and returns each item with
  // an `ok` flag plus a `transient` flag. `transient` (only meaningful when ok is
  // false) means "retry me" — a catalogue/network hiccup or an unresolved match (a
  // partial catalogue read), NOT a genuine 闪购 API rejection. The daemon keeps
  // transient rows pending instead of burying them as a terminal error that never
  // self-heals. Resolves the 闪购 skuId by 货号 (sku === sourceFoodCode); falls back
  // to an exact/substring listing-name match (targetCn / targetEn). One catalogue
  // fetch per batch.
  async batchUpdateStock(items) {
    this.verificationRequired = false; // reflect THIS batch (see isLoggedIn note)
    const products = await this.getProducts();
    const byCode = new Map();
    for (const p of products) if (p.code) byCode.set(p.code, p);

    const results = [];
    for (const item of items) {
      let target = null;
      if (item.sku && byCode.has(norm(item.sku))) {
        target = byCode.get(norm(item.sku));
      } else {
        const names = [item.targetCn, item.targetEn].map(norm).filter(Boolean);
        target = products.find(p => names.some(n => p.spuName === n))
              || products.find(p => names.some(n => n && p.spuName.includes(n)));
      }
      let ok = false, transient = false;
      if (target) {
        try {
          const r = await this.setSkuStock(target.skuId, item.newQty);
          ok = r.ok;
          transient = !r.ok && !r.apiRejected; // non-rejection failure → retry
        } catch (e) {
          this._log(`setSkuStock error for ${target.skuId}: ${e.message}`);
          transient = true; // network/page hiccup → retry
        }
      } else {
        this._log(`no 闪购 sku match for sku=${item.sku} name=${item.targetCn || item.targetEn}`);
        transient = true; // maybe a partial catalogue read → retry, don't bury
      }
      results.push({ ...item, ok, transient: !ok && transient, skuId: target ? target.skuId : null });
    }
    return results;
  }

  // ── Orders ─────────────────────────────────────────────────────────────────
  // Poll the incremental new-order feed. /order/list/interval returns
  // data.newOrders (null when none) plus data.dataChannel counts. The store opened
  // with zero orders so the per-order item shape is not yet known; until a real
  // order is captured this returns { orders: [], rawNew } and the daemon LOGS rawNew
  // verbatim on the first non-empty payload so we can finalise the parser without
  // guessing. Defensive best-effort parse is attempted but the daemon treats an
  // unparseable order as "needs raw capture" rather than importing garbage.
  async getOrderInterval() {
    const r = await this._api('/gw/api/unified/r/order/list/interval',
      'isAutoAccept=0&dateAndSeq=&countDateAndSeq=&isCountReq=true&scIndex=1');
    const data = r.data || {};
    return {
      ok: r.code === 0,
      newCount: (data.dataChannel && Number(data.dataChannel.order_new_count)) || 0,
      newOrders: data.newOrders || data.newIndexOrders || null,
    };
  }

  // Daemon contract: return today's (Asia/Shanghai) orders to import, each shaped
  // { meituanOrderNo, daySeq, total, items:[{name, qty, sku}], paid, raw }. Dedup
  // against meituan_order_import is the caller's job, so returning all of today is
  // safe — already-imported orders are skipped there.
  //
  // 闪购 is on Meituan Retail (hasMigratedToRetail) and auto-accepts orders, so the
  // legacy /order/list/interval new-order feed stays empty (it only badges the
  // 待接单 bucket, which an auto-accepted order has already left). We instead read
  // the same JSON API the "全部订单" page uses (POST order/list/page/history) via the
  // in-page fetch so H5guard signs it, exactly like the stock push. Items live in
  // orderInfo.foodInfo.cartDetails[].details[] with skuCode = 货号 (the join key).
  async getPendingOrders() {
    this.verificationRequired = false; // reflect THIS poll (see isLoggedIn note)

    // Today in Asia/Shanghai, independent of the box's TZ.
    const sh = new Date(Date.now() + 8 * 3600 * 1000);
    const ymd = `${sh.getUTCFullYear()}-${String(sh.getUTCMonth() + 1).padStart(2, '0')}`
      + `-${String(sh.getUTCDate()).padStart(2, '0')}`;
    const pageParam = JSON.stringify({ pageSize: 50, pageNum: 1, sort: 0, nextLabel: '', lastLabel: '', direction: 0, sortField: 1 });
    const extParam  = JSON.stringify({ phfRollback: 0, requestWmPoiId: String(WMPOIID), searchTag: 14 });
    const body = `tag=history_all&pageParam=${encodeURIComponent(pageParam)}`
      + `&extParam=${encodeURIComponent(extParam)}&startDate=${ymd}&endDate=${ymd}`;

    const r = await this._api('/gw/api/unified/r/order/list/page/history', body);
    if (r.code !== 0 || !r.data) {
      this._log(`order history fetch failed (status ${r.status}, code ${r.code}, ${r.msg})`);
      return [];
    }

    const list = Array.isArray(r.data.orderList) ? r.data.orderList : [];
    const orders = [];
    for (const o of list) {
      let ci = {}, oi = {};
      try { ci = JSON.parse(o.commonInfo || '{}'); } catch (e) {}
      try { oi = JSON.parse(o.orderInfo  || '{}'); } catch (e) {}

      const no = ci.wmOrderViewIdStr
        || (ci.wm_order_id_view != null ? String(ci.wm_order_id_view) : '');
      if (!no) continue;

      // 闪购 orders are prepaid; only mirror confirmed-paid ones so we never
      // decrement stock for an unpaid/abandoned order. payStatus 3 = paid.
      const paid = ci.payStatus === 3 || ci.payStatus == null;
      if (!paid) continue;

      // Items: orderInfo.foodInfo.cartDetails[].details[] → { foodName, count, skuCode }.
      const carts = (oi.foodInfo && Array.isArray(oi.foodInfo.cartDetails)) ? oi.foodInfo.cartDetails : [];
      const items = [];
      let total = 0;
      for (const c of carts) {
        for (const f of (Array.isArray(c.details) ? c.details : [])) {
          const name = norm(f.foodName || f.name || f.skuName);
          const qty  = Number(f.count || f.quantity || f.qty || 0);
          const sku  = norm(f.skuCode || f.sourceFoodCode || f.upcCode || '');
          if (name && qty) {
            items.push({ name, qty, sku });
            total += (Number(f.foodPrice || f.price || 0) || 0) * qty;
          }
        }
      }

      orders.push({
        meituanOrderNo: no,
        daySeq: ci.wm_poi_order_dayseq != null ? ci.wm_poi_order_dayseq : null,
        total,
        items,
        paid,
        raw: o, // daemon logs this for the first real order
      });
    }
    this._log(`found ${orders.length} paid order(s) via order history API`);
    return orders;
  }

  // CDP-attached genuine Chrome persists its own profile to disk; nothing to do.
  async persistSession() { return true; }
  // Import-only contract: never auto-accept on Meituan.
  async acceptOrder() { return null; }

  // ── Business status (营业 / 休息 open-close) ─────────────────────────────────
  // 闪购 uses the IDENTICAL endpoints as 外卖 (captured 2026-07-01,
  // feature_meituan_store_open_close): READ /common/businessStatus {wmPoiId},
  // WRITE /api/poi/change_status status=<1|3>&wmPoiId&token. Issued from the page
  // (H5guard signs) with the csec params the page always appends. status 1 = 营业,
  // 3 = 停业. The read needs no signing; the write reads the `token` cookie.
  async getBusinessStatus() {
    try {
      await this.connect();
      const out = await this.page.evaluate(async ({ host, wmPoiId, csec }) => {
        const r = await fetch(`${host}/common/businessStatus?${csec}`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `wmPoiId=${wmPoiId}`, credentials: 'include',
        });
        let j = null; try { j = await r.json(); } catch (e) {}
        return { httpStatus: r.status, json: j };
      }, { host: HOST, wmPoiId: WMPOIID, csec: CSEC_QS });
      if (out.httpStatus === 403) this.verificationRequired = true;
      const j = out.json || {};
      const ok = out.httpStatus === 200 && j.code === 0;
      return { ok, open: j.status === 1, status: j.status, subStatus: j.subStatus,
               statusDesc: j.wmPoiStatusDesc, detailDesc: j.statusDescInfo, hoursDesc: j.shippingTimeDesc, raw: j };
    } catch (e) { this._log(`getBusinessStatus error: ${e.message}`); return { ok: false, error: e.message }; }
  }

  // open=true → 营业 (1), open=false → 停业 (3). Returns { ok, code, msg, newDesc, hadToken }.
  async setBusinessStatus(open) {
    const status = open ? 1 : 3;
    try {
      await this.connect();
      const out = await this.page.evaluate(async ({ host, wmPoiId, csec, status }) => {
        const ck = (k) => { const m = document.cookie.match(new RegExp('(?:^|; )' + k + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; };
        const token = ck('token');
        const body = `status=${status}&wmPoiId=${wmPoiId}&token=${encodeURIComponent(token)}`;
        const r = await fetch(`${host}/api/poi/change_status?${csec}`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body, credentials: 'include',
        });
        let j = null; try { j = await r.json(); } catch (e) {}
        return { httpStatus: r.status, json: j, hadToken: !!token };
      }, { host: HOST, wmPoiId: WMPOIID, csec: CSEC_QS, status });
      if (out.httpStatus === 403) this.verificationRequired = true;
      const j = out.json || {};
      const ok = out.httpStatus === 200 && j.code === 0;
      this._log(`setBusinessStatus(${open ? 'OPEN' : 'CLOSED'}) → ${ok ? 'ok' : 'FAIL'} code=${j.code} ${j.msg || ''}${out.hadToken ? '' : ' (NO token cookie!)'}`);
      return { ok, code: j.code, msg: j.msg, hadToken: out.hadToken,
               newDesc: j.data && (j.data.strWmPoiStatusDesc || j.data.wmPoiStatusDesc), raw: j };
    } catch (e) { this._log(`setBusinessStatus error: ${e.message}`); return { ok: false, error: e.message }; }
  }

  async close() {
    // Detach CDP only — never close the genuine Chrome (it's the long-lived agent).
    try { await this.browser?.close(); } catch {}
    this.browser = this.context = this.page = null;
  }
}

// Per-store singletons, mirroring lib/meituan-browser's getBrowser/closeAll.
const _instances = {};
async function getShangouBrowser(storeCode) {
  if (!_instances[storeCode]) _instances[storeCode] = new ShangouBrowser(storeCode);
  await _instances[storeCode].connect();
  return _instances[storeCode];
}
async function closeAllShangou() {
  for (const b of Object.values(_instances)) { try { await b.close(); } catch {} }
}

module.exports = { ShangouBrowser, getShangouBrowser, closeAllShangou };
