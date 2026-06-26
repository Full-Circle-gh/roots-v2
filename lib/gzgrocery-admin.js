// gzgrocery OpenCart admin client (read-only).
//
// gzgrocery runs their storefront on OpenCart at GZGROCERY_ADMIN_URL (e.g.
// https://www.gzgrocery.cn/admin/). Their orders include MANY third-party
// grocery items plus a handful of OUR products. We can read their full order
// list + per-order line items, so we decrement our Tianhe stock the moment a
// (paid) order appears — regardless of its scheduled delivery date.
//
// This is a pure-HTTPS client (no headless browser): OpenCart admin is
// server-rendered, so login + list + order-info are plain form posts / GETs.
// We keep a cookie jar (OCSESSID) and the per-session user_token, and re-login
// transparently when the session expires.
//
// IMPORTANT route quirk: this OpenCart resolves order sub-actions with a SLASH
// (`route=sale/order/info`), NOT a dot (`sale/order.info` → Permission Denied).

'use strict';

const https = require('https');
const http  = require('http');
const { URL } = require('url');

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function stripTags(s) { return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }

class GzGroceryAdmin {
  constructor({ baseUrl, username, password } = {}) {
    this.baseUrl  = (baseUrl || process.env.GZGROCERY_ADMIN_URL || '').replace(/\/+$/, '') + '/';
    this.username = username || process.env.GZGROCERY_ADMIN_USER;
    this.password = password || process.env.GZGROCERY_ADMIN_PASS;
    this.cookies  = new Map();          // name -> value
    this.userToken = null;
    this.timeoutMs = Number(process.env.GZGROCERY_HTTP_TIMEOUT_MS || 25000);
    if (!this.baseUrl || this.baseUrl === '/') throw new Error('GZGROCERY_ADMIN_URL not set');
  }

  _cookieHeader() {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  _absorbCookies(setCookie) {
    for (const line of (setCookie || [])) {
      const m = /^\s*([^=]+)=([^;]*)/.exec(line);
      if (m) this.cookies.set(m[1].trim(), m[2].trim());
    }
  }

  // Low-level request. opts: { method, route, query, form, followRedirect }
  _request({ method = 'GET', route, query = {}, form = null, followRedirect = false }) {
    const u = new URL('index.php', this.baseUrl);
    if (route) u.searchParams.set('route', route);
    for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, v);

    let body = null;
    const headers = {
      'User-Agent': 'roots-gzgrocery-sync/1.0',
      'Accept': 'text/html,application/json',
      'Cookie': this._cookieHeader(),
    };
    if (form) {
      body = new URLSearchParams(form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const lib = u.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const req = lib.request(u, { method, headers, timeout: this.timeoutMs }, (res) => {
        this._absorbCookies(res.headers['set-cookie']);
        let chunks = '';
        res.on('data', d => { chunks += d; });
        res.on('end', () => resolve({
          status: res.statusCode,
          location: res.headers.location || null,
          body: chunks,
        }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`timeout after ${this.timeoutMs}ms`)));
      if (body) req.write(body);
      req.end();
    });
  }

  async login() {
    this.cookies.clear();
    this.userToken = null;
    // 1. GET login page → seed OCSESSID + scrape csrfToken.
    const page = await this._request({ method: 'GET', route: 'common/login' });
    const m = /name="csrfToken"\s+value="([^"]+)"/i.exec(page.body);
    const csrf = m ? m[1] : '';
    // 2. POST credentials.
    const resp = await this._request({
      method: 'POST', route: 'common/login',
      form: { username: this.username, password: this.password, csrfToken: csrf },
    });
    // Success = 302 to dashboard with user_token in the Location.
    const tok = /user_token=([a-zA-Z0-9]+)/.exec(resp.location || resp.body || '');
    if (!tok) {
      const why = /Warning|No match|incorrect|error/i.exec(stripTags(resp.body)) ? 'bad credentials' : `unexpected response (http ${resp.status})`;
      throw new Error(`gzgrocery login failed: ${why}`);
    }
    this.userToken = tok[1];
    return this.userToken;
  }

  async ensureLoggedIn() { if (!this.userToken) await this.login(); return this.userToken; }

  // GET a route, transparently re-logging in if the session has expired.
  async _get(route, query = {}) {
    await this.ensureLoggedIn();
    let r = await this._request({ method: 'GET', route, query: { ...query, user_token: this.userToken } });
    if (this._looksLoggedOut(r)) {
      await this.login();
      r = await this._request({ method: 'GET', route, query: { ...query, user_token: this.userToken } });
    }
    return r;
  }
  _looksLoggedOut(r) {
    if (r.status === 302 && /route=common\/login/.test(r.location || '')) return true;
    return /name="csrfToken"|route=common\/login\b.*type="password"/i.test(r.body || '') &&
           /Please enter|Login|用户名|密码/i.test(stripTags(r.body || ''));
  }

  // ── Order list ────────────────────────────────────────────────────────────
  // Returns the most recent orders (OpenCart sorts order_id desc), newest first.
  // Walks pages until `maxPages` or until an order older than `sinceDays` is hit.
  async fetchOrders({ maxPages = 5, sinceDays = 3 } = {}) {
    const out = [];
    const cutoff = Date.now() - sinceDays * 86400000;
    for (let page = 1; page <= maxPages; page++) {
      const r = await this._get('sale/order', { page });
      const rows = this._parseOrderList(r.body);
      if (!rows.length) break;
      out.push(...rows);
      const oldest = rows[rows.length - 1];
      if (oldest && oldest.dateAddedMs && oldest.dateAddedMs < cutoff) break;
    }
    return out;
  }

  _parseOrderList(html) {
    const rows = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(html))) {
      const block = tr[1];
      const idm = /order_id=(\d+)[^"]*">\s*(?:<[^>]*>\s*)*(?:View|查看)/i.exec(block) ||
                  /order_id=(\d+)/.exec(block);
      if (!idm || !/View|查看|order_id=/.test(block)) continue;
      // require this to be a data row (has a ￥ total and an order number)
      const cells = [];
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let td;
      while ((td = tdRe.exec(block))) cells.push(stripTags(td[1]));
      const joined = cells.join(' | ');
      if (!/[￥¥]\s?[\d.]+/.test(joined)) continue; // not an order row

      const orderId = Number(idm[1]);
      const orderNo = (/(\b\d{12,}\b)/.exec(joined) || [])[1] || null;
      const total   = parseFloat((/[￥¥]\s?([\d,]+\.?\d*)/.exec(joined) || [])[1]?.replace(/,/g, '') || 'NaN');
      const status  = this._cellStatus(cells);
      const dates   = (joined.match(/\d{2,4}[-/]\d{2}[-/]\d{2,4}[ T]\d{2}:\d{2}(?::\d{2})?/g) || []);
      const dateAdded    = dates[0] || null;
      const deliveryTime = dates[1] || null;
      const customer = (cells.find(c => /\(\d{6,}\)/.test(c)) || cells[1] || '').slice(0, 200);

      rows.push({
        orderId, orderNo, total: isNaN(total) ? null : total, status,
        dateAdded, deliveryTime, customer,
        dateAddedMs: this._parseDateMs(dateAdded),
      });
    }
    // de-dupe (the table can include header/footer artefacts) and sort desc
    const seen = new Set();
    return rows.filter(r => (seen.has(r.orderId) ? false : seen.add(r.orderId)))
               .sort((a, b) => b.orderId - a.orderId);
  }

  _cellStatus(cells) {
    const KNOWN = ['Paid', 'Pending', 'Processing', 'Shipped', 'Complete', 'Completed',
      'Canceled', 'Cancelled', 'Denied', 'Refunded', 'Reversed', 'Chargeback',
      'Expired', 'Voided', 'Failed', 'Missing Orders', 'Partially Shipped',
      '已支付', '待支付', '待处理', '已审核', '已取消', '退款中', '支付失败',
      '部分发货', '全部发货', '已完成', '无法抵扣', '已拆分'];
    for (const c of cells) {
      const t = c.trim();
      if (KNOWN.includes(t)) return t;
    }
    return null;
  }

  _parseDateMs(s) {
    if (!s) return null;
    // formats: "27/06/2026 00:01:47" or "2026-06-27 15:00:00"
    let m = /(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)) - 8 * 3600000;
    m = /(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - 8 * 3600000;
    return null;
  }

  // ── Order line items ───────────────────────────────────────────────────────
  // Returns [{ product, model, skuCol, qty }] from the "Order Products" table.
  async fetchOrderItems(orderId) {
    const r = await this._get('sale/order/info', { order_id: orderId });
    if (/Permission Denied/i.test(r.body)) throw new Error(`order ${orderId}: permission denied (account lacks sale/order access)`);
    return this._parseOrderItems(r.body);
  }

  _parseOrderItems(html) {
    // Isolate the products table: the panel whose header row contains both
    // "Model"/"型号" and "Quantity"/"数量".
    const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
    let target = null;
    for (const t of tables) {
      if (/(Model|型号)/i.test(t) && /(Quantity|数量)/i.test(t) && /(Unit Price|单价|Total|小计|合计)/i.test(t)) { target = t; break; }
    }
    if (!target) return [];
    const items = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(target))) {
      const cells = [];
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let td;
      while ((td = tdRe.exec(tr[1]))) cells.push(td[1]);
      if (cells.length < 5) continue;                       // header / spacer / totals row
      const text = cells.map(stripTags);
      // Column order: Image | Product | Model | SKU | Quantity | Unit Price | Total
      const qty = parseInt((text[4] || '').replace(/[^\d]/g, ''), 10);
      if (!Number.isFinite(qty)) continue;                  // not a product row (e.g. Sub-Total)
      const product = text[1] || '';
      const model   = text[2] || '';
      const skuCol  = text[3] || '';
      if (!product && !model) continue;
      items.push({ product, model, skuCol, qty });
    }
    return items;
  }
}

// Extract OUR product SKU token (e.g. "1-310", "4-202", "1-100X") from an order
// line. Our products carry the SKU in the Chinese "Model" field, ALWAYS prefixed
// "GV"/"GVF" (GoVegan / GoVegan Fresh): "GVF 1-310 甜菜根沙拉", "GV 4-680 …".
// Third-party grocery lines have no such prefix. We therefore:
//   1. prefer a GV/GVF-prefixed token (authoritative, zero false positives), then
//   2. fall back to any \d+-\d+ token — but the caller still gates on our SKU map,
// so stray tokens from weights ("700-800g") or dates ("best before 2026-10") that
// happen to slip through never match a real product.
// Pass ONLY the Model field(s) — the English product name is the false-positive
// source and must not be scanned.
function extractSku(...fields) {
  for (const f of fields) {
    const gv = /\bGVF?\s*[·\- ]?\s*(\d+-\d+[A-Za-z]?)\b/i.exec(String(f || ''));
    if (gv) return gv[1].toUpperCase();
  }
  for (const f of fields) {
    const m = /\b(\d+-\d+[A-Za-z]?)\b/.exec(String(f || ''));
    if (m) return m[1].toUpperCase();
  }
  return null;
}

module.exports = { GzGroceryAdmin, extractSku, stripTags };
