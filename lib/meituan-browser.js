// Playwright browser automation for Meituan merchant backend.
// Handles login, order polling, stock pushing for 天河 + 越秀 stores.
// Sessions are persisted to data/meituan-sessions/ so the browser stays logged
// in between runs. First run: launch in headed mode so staff can log in manually
// (Meituan may require WeChat QR scan). Subsequent runs: headless, auto-restore.

const path = require('path');
const fs   = require('fs');

const SESSION_DIR = path.join(__dirname, '../data/meituan-sessions');
const MERCHANT_URL = 'https://e.waimai.meituan.com';

let playwright;
function getPlaywright() {
  if (!playwright) playwright = require('playwright');
  return playwright;
}

// Tier 2 anti-fingerprint: a single COHERENT Windows-desktop Chrome identity.
// This runs in every page/iframe before site scripts. The cardinal rule is
// internal consistency — UA, platform, client-hints, WebGL and locale must all
// tell the SAME story, because a contradictory spoof is a louder bot signal
// than no spoof at all. The Windows story matches the Windows UA the session
// was first created with (switching to the real Linux engine mid-session would
// look like a device change). Exported so the self-test runs the exact code.
function fingerprintInitScript({ chromeVer, chromeMajor }) {
  const define = (obj, key, val) => {
    try { Object.defineProperty(obj, key, { get: () => val, configurable: true }); } catch (e) {}
  };

  // The #1 tell (belt-and-suspenders with the launch flag).
  define(navigator, 'webdriver', undefined);

  // Coherent Windows desktop surfaces.
  define(navigator, 'platform', 'Win32');
  define(navigator, 'vendor', 'Google Inc.');
  define(navigator, 'language', 'zh-CN');
  define(navigator, 'languages', ['zh-CN', 'zh']);
  define(navigator, 'hardwareConcurrency', 8);
  define(navigator, 'deviceMemory', 8);

  // Client Hints (navigator.userAgentData) consistent with the UA string above.
  try {
    const brands = [
      { brand: 'Chromium', version: String(chromeMajor) },
      { brand: 'Google Chrome', version: String(chromeMajor) },
      { brand: 'Not.A/Brand', version: '24' },
    ];
    const uaData = {
      brands,
      mobile: false,
      platform: 'Windows',
      getHighEntropyValues: () => Promise.resolve({
        architecture: 'x86',
        bitness: '64',
        brands,
        fullVersionList: brands.map(b => ({
          brand: b.brand,
          version: b.brand.indexOf('Brand') >= 0 ? '24.0.0.0' : chromeVer,
        })),
        mobile: false,
        model: '',
        platform: 'Windows',
        platformVersion: '15.0.0',
        uaFullVersion: chromeVer,
        wow64: false,
      }),
      toJSON: () => ({ brands, mobile: false, platform: 'Windows' }),
    };
    define(navigator, 'userAgentData', uaData);
  } catch (e) {}

  // window.chrome — headless Chromium omits it (or ships it incomplete); real
  // Chrome exposes chrome.runtime. Ensure it exists regardless of engine.
  try {
    window.chrome = window.chrome || {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
    if (!window.chrome.app) window.chrome.app = { isInstalled: false };
    if (!window.chrome.csi) window.chrome.csi = function () {};
    if (!window.chrome.loadTimes) window.chrome.loadTimes = function () {};
  } catch (e) {}

  // WebGL vendor/renderer — hide the headless "SwiftShader/Mesa software" tell
  // behind a plausible Windows GPU string (consistent with a Windows desktop).
  try {
    const spoof = {
      37445: 'Google Inc. (Intel)',                                                       // UNMASKED_VENDOR_WEBGL
      37446: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',  // UNMASKED_RENDERER_WEBGL
    };
    for (const Ctor of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Ctor) continue;
      const orig = Ctor.prototype.getParameter;
      Ctor.prototype.getParameter = function (p) {
        if (p in spoof) return spoof[p];
        return orig.call(this, p);
      };
    }
  } catch (e) {}
}

// Tier 4: resolve an optional outbound proxy from config (tenant-neutral — no
// hardcoded host). Per-store override MEITUAN_PROXY_<STORECODE> wins, else the
// shared MEITUAN_PROXY_URL. Accepts http(s)://user:pass@host:port or
// socks5://host:port. Unset → null → direct connection (current behaviour).
function resolveProxy(storeCode) {
  const raw = (storeCode && process.env[`MEITUAN_PROXY_${String(storeCode).toUpperCase()}`])
    || process.env.MEITUAN_PROXY_URL || '';
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const proxy = { server: `${u.protocol}//${u.host}` };
    if (u.username) proxy.username = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
    return proxy;
  } catch (e) {
    console.error(`[meituan] ignoring malformed proxy URL: ${e.message}`);
    return null;
  }
}

class MeituanBrowser {
  constructor(storeCode) {
    this.storeCode   = storeCode; // 'tianhe' | 'yuexiu'
    this.sessionFile = path.join(SESSION_DIR, `${storeCode}-session.json`);
    this.browser     = null;
    this.context     = null;
    this.page        = null;
    this._loggedIn   = false;
    // Set when Meituan redirects to its 验证中心 (verify.meituan.com) human
    // challenge. The daemon surfaces this to the admin tab instead of silently
    // spamming "no iframe". Cleared once a poll reaches the real dashboard.
    this.verificationRequired = false;
    // Stock push works via Meituan's own JSON APIs, captured from the logged-in
    // page. _apiCap is a rolling buffer of relevant API responses (filled by the
    // response handler in init); _idCache maps a product name -> {spuId,skuId}
    // (stable, so resolved once); _wmPoiId is the store's POI id (read once).
    this._apiCap   = [];
    this._idCache  = new Map();
    this._wmPoiId  = null;
  }

  // True when the current page is Meituan's risk-control verification challenge.
  _isVerifyPage() {
    try { return this.page.url().includes('verify.meituan.com'); } catch (e) { return false; }
  }

  _flagVerification(where) {
    this.verificationRequired = true;
    this._log(`⚠️ verification required (验证中心) at ${where} — a human must pass the captcha; sync paused for this store`);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  // opts.headed       — force a visible window (interactive login).
  // opts.ignoreSession — start with fresh cookies, but DON'T touch the saved
  //                      file (it's only overwritten on a successful login), so
  //                      re-running an interactive login can't destroy a good
  //                      session.
  async init(opts = {}) {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    const { chromium } = getPlaywright();

    const useSession = !opts.ignoreSession && fs.existsSync(this.sessionFile);
    const storageState = useSession
      ? JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'))
      : undefined;

    const headless = opts.headed ? false : useSession;
    this._log(useSession ? 'restoring session (headless)'
      : (opts.ignoreSession ? 'fresh login (existing session kept until new login succeeds)'
                            : 'no session — launching headed for manual login'));

    // On Windows prefer system Edge/Chrome; on Linux use bundled Chromium.
    const isWindows = process.platform === 'win32';
    // Tier 1 anti-fingerprint: AutomationControlled is the flag Chromium sets
    // that makes navigator.webdriver=true — the single strongest "this is a bot"
    // signal. Disabling it (plus the init script below) removes that tell.
    const stealthArgs = ['--disable-blink-features=AutomationControlled'];
    // --disable-gpu + --disable-dev-shm-usage stabilise the renderer (headed Edge
    // on Windows was crashing with "Page crashed" during the login wait; the
    // Linux daemon already passes the shm flag).
    const launchOpts = {
      headless,
      args: isWindows
        ? [...stealthArgs, '--disable-gpu', '--disable-dev-shm-usage']
        : ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', ...stealthArgs],
    };
    if (isWindows) {
      // Use installed Microsoft Edge (always present on Windows 10/11)
      const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
      const fs2 = require('fs');
      if (fs2.existsSync(edgePath)) launchOpts.executablePath = edgePath;
      else launchOpts.channel = 'msedge'; // fallback: let Playwright find Edge
    }

    // Tier 4: route through a regional (e.g. Guangzhou) proxy when configured so
    // the merchant appears to connect from the store's region instead of the
    // server's datacenter IP — the dominant risk-control signal behind the
    // 验证中心 challenge. Applied at launch so headed first-login uses it too,
    // keeping the session's birth IP and the daemon's run IP identical.
    const proxy = resolveProxy(this.storeCode);
    if (proxy) { launchOpts.proxy = proxy; this._log(`using proxy ${proxy.server}`); }
    else this._log('no proxy configured (direct datacenter IP)');

    this.browser = await chromium.launch(launchOpts);

    // Match the UA's Chrome version to the REAL engine so the claimed version
    // and the actual JS feature set agree (the old hardcoded 124 lied once the
    // bundled Chromium moved on). browser.version() → "124.0.6367.118" etc.
    let chromeVer = '124.0.0.0';
    try {
      const m = String(this.browser.version()).match(/(\d+\.\d+\.\d+\.\d+)/);
      if (m) chromeVer = m[1];
    } catch (e) {}
    const chromeMajor = chromeVer.split('.')[0];
    const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;

    this.context = await this.browser.newContext({
      storageState,
      userAgent,
      viewport: { width: 1920, height: 1080 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });

    // Tier 2: apply the coherent Windows fingerprint in every page/iframe.
    await this.context.addInitScript(fingerprintInitScript, { chromeVer, chromeMajor });

    this.page = await this.context.newPage();

    // Capture Meituan's own product/stock JSON APIs so stock push can read spuId/
    // skuId and the store POI id straight from the logged-in page (the same calls
    // the merchant UI makes). Keeps a small rolling buffer; cleared per lookup.
    this.page.on('response', async (resp) => {
      try {
        const u = resp.url();
        if (!this._wmPoiId) { const m = u.match(/[?&]wmPoiId=(\d+)/); if (m) this._wmPoiId = m[1]; }
        if (!/searchSugByName|getSpuListCommon|editView\/v2/.test(u)) return;
        const data = await resp.json();
        this._apiCap.push({ url: u.split('?')[0], data });
        if (this._apiCap.length > 40) this._apiCap.shift();
      } catch (e) {}
    });
  }

  async ensureLoggedIn() {
    if (this._loggedIn) return true;

    await this.page.goto(MERCHANT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this._humanPause(2500, 4200);

    // Risk-control challenge: bail clearly instead of misreporting login.
    if (this._isVerifyPage()) { this._flagVerification('login'); return false; }

    const url = this.page.url();
    // Login confirmed when URL is on either meituan merchant domain with session params
    const isOnMerchant = (u) =>
      (u.includes('waimaie.meituan.com') || u.includes('e.waimai.meituan.com')) &&
      !u.includes('/login_gw') && !u.includes('/login?') && !u.includes('#/login');
    if (isOnMerchant(url)) {
      this._loggedIn = true;
      await this._saveSession();
      this._log('login confirmed');
      return true;
    }

    // Not logged in: if headed, wait up to 3 minutes for staff to scan QR
    const hasSession = fs.existsSync(this.sessionFile);
    if (!hasSession) {
      this._log('waiting for manual login (up to 3 min)...');
      try {
        await this.page.waitForURL(
          (u) => isOnMerchant(u.toString()),
          { timeout: 180000 }
        );
        this._loggedIn = true;
        await this._saveSession();
        this._log('manual login successful — session saved');
        return true;
      } catch {
        this._log('login timeout');
        return false;
      }
    }

    this._log('session expired — delete session file and re-run in headed mode');
    return false;
  }

  // Interactive headed login for the standalone meituan-login helper. UNLIKE
  // ensureLoggedIn (which bails the moment it sees the 验证中心 page so the
  // daemon doesn't hang), this keeps the window open and polls, letting a human
  // scan the QR and solve the slider. It only succeeds once the page is truly on
  // the merchant dashboard (not login, not verify). Not called by the daemon.
  async interactiveLogin(maxMs = 360000) {
    const onMerchant = (u) => !!u && (u.includes('waimaie.meituan.com') || u.includes('e.waimai.meituan.com'));
    const isLoginUrl = (u) => !u || u.includes('/login_gw') || u.includes('/login?') ||
      u.includes('#/login') || u.includes('passport.meituan');
    // Real proof of being on the authenticated dashboard: a merchant content
    // iframe is present (the daemon relies on the same frame). Avoids the false
    // positive where the bare e.waimai URL flashes before redirecting to login.
    const hasContentFrame = () => {
      try {
        return this.page.frames().some(f =>
          f !== this.page.mainFrame() && f.url().includes('meituan.com') && !f.url().startsWith('about:'));
      } catch (e) { return false; }
    };
    const hasLoginForm = async () => {
      try {
        return await this.page.evaluate(() => {
          const t = document.body ? document.body.innerText : '';
          return t.includes('账号登录') || t.includes('验证码登录') ||
                 t.includes('输入密码') || t.includes('输入账号');
        });
      } catch (e) { return false; }
    };

    await this.page.goto(MERCHANT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page.waitForTimeout(6000); // let the SPA redirect to login if not authenticated
    this._log('window open — log in (account+password or SMS), solve any slider; waiting for dashboard…');

    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      try {
        await this.page.waitForTimeout(2500);
        const url = this.page.url();
        if (!onMerchant(url) || isLoginUrl(url) || this._isVerifyPage()) continue;
        if (await hasLoginForm()) continue;   // still showing the login form
        if (!hasContentFrame()) continue;     // dashboard frame not loaded yet
        this._loggedIn = true;
        await this._saveSession();
        this._log('login successful — session saved');
        return true;
      } catch (e) {
        const msg = String(e.message || '');
        // Only a genuine renderer crash needs a fresh page; an "execution context
        // destroyed" is just a navigation race — ignore and keep polling.
        if (/crash|has been closed|Target (page|closed)/i.test(msg)) {
          this._log(`recovering from page crash: ${msg.slice(0, 50)}`);
          try {
            this.page = await this.context.newPage();
            await this.page.goto(MERCHANT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch (e2) { await new Promise(r => setTimeout(r, 2000)); }
        }
      }
    }
    this._log('timed out waiting for manual login');
    return false;
  }

  async close() {
    // Only persist a session we actually logged into — otherwise a failed/
    // abandoned interactive login would overwrite a good session with a
    // logged-out one.
    try { if (this._loggedIn) await this._saveSession(); } catch {}
    try { await this.browser?.close(); } catch {}
    this.browser = this.context = this.page = null;
    this._loggedIn = false;
  }

  // ── Order polling ─────────────────────────────────────────────────────────

  // Returns array of pending order objects from 待接单 tab.
  async getPendingOrders() {
    if (!await this.ensureLoggedIn()) return [];

    // Navigate to orders section
    await this.page.goto(`${MERCHANT_URL}/#/order`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await this._humanPause(2500, 4200);

    // The order page is where risk-control most often redirects to 验证中心.
    if (this._isVerifyPage()) { this._flagVerification('order page'); return []; }

    const iframe = await this._getMainIframe();
    if (!iframe) {
      if (this._isVerifyPage()) { this._flagVerification('order page'); return []; }
      return this._withFallback('getPendingOrders: no iframe', []);
    }
    this.verificationRequired = false; // reached the real dashboard

    const orders = await iframe.evaluate(() => {
      // Collect all order cards visible on page
      const cards = Array.from(document.querySelectorAll('[class*="order-card"],[class*="orderCard"],[class*="order-item"],[class*="orderItem"]'));
      if (!cards.length) {
        // Fallback: find by data structure
        const all = Array.from(document.querySelectorAll('[data-order-id],[data-orderid]'));
        return all.map(el => ({
          meituanOrderNo: el.getAttribute('data-order-id') || el.getAttribute('data-orderid') || '',
          rawHtml: el.innerText.slice(0, 500),
        }));
      }
      return cards.map(card => {
        const text = card.innerText || '';
        const noMatch = text.match(/(?:订单号[：:]\s*)?(MT\d{18,}|\d{18,})/);
        const totalMatch = text.match(/¥\s*([\d.]+)/);
        const timeMatch  = text.match(/(\d{2}:\d{2})/);
        // Items: look for qty × name patterns
        const itemEls = card.querySelectorAll('[class*="item"],[class*="food"],[class*="dish"],[class*="product"]');
        const items = Array.from(itemEls).map(el => {
          const t = el.innerText || '';
          const m = t.match(/(\d+)\s*×\s*(.+)|(.+)\s*×\s*(\d+)/);
          return m ? { name: (m[2] || m[3] || '').trim(), qty: parseInt(m[1] || m[4]) } : null;
        }).filter(Boolean);

        return {
          meituanOrderNo: noMatch ? noMatch[1] : '',
          total: totalMatch ? parseFloat(totalMatch[1]) : 0,
          placedTime: timeMatch ? timeMatch[1] : '',
          items,
          rawText: text.slice(0, 800),
        };
      }).filter(o => o.meituanOrderNo || o.rawText.includes('¥'));
    });

    this._log(`found ${orders.length} order(s) on order page`);
    return orders;
  }

  // Accept a pending order on Meituan by order number. Returns true on success.
  async acceptOrder(meituanOrderNo) {
    if (!await this.ensureLoggedIn()) return false;
    const iframe = await this._getMainIframe();
    if (!iframe) return false;

    const clicked = await iframe.evaluate((no) => {
      // Find card containing this order number
      const cards = Array.from(document.querySelectorAll('[class*="order"]'));
      for (const card of cards) {
        if (card.innerText && card.innerText.includes(no)) {
          const buttons = card.querySelectorAll('button,span,div');
          for (const b of buttons) {
            if (b.innerText && (b.innerText.trim() === '接单' || b.innerText.trim() === '确认接单')) {
              b.click();
              return true;
            }
          }
        }
      }
      return false;
    }, meituanOrderNo);

    if (clicked) {
      await this._humanPause(1200, 2400);
      this._log(`accepted order ${meituanOrderNo}`);
    } else {
      this._log(`could not find accept button for order ${meituanOrderNo}`);
    }
    return clicked;
  }

  // ── Stock push ────────────────────────────────────────────────────────────

  // Update stock for a product by its roots-v2 product name (name_cn or name_en).
  // Single-item convenience wrapper: ensure we're on the product list, then run
  // the 改库存 dialog once. Multi-item callers should prefer batchUpdateStock so
  // the product list is loaded a single time for the whole store.
  // Push one product's stock to Meituan. Meituan's product search box is a
  // jump-to-editor autocomplete (it can't filter the list), so the old "find the
  // row, tick it, drive the 改库存 dialog" approach could never reach the product.
  // Instead we use Meituan's OWN JSON APIs, exactly as the merchant UI does:
  //   name -> spuId (searchSugByName) -> skuId (editView/v2) -> set stock
  //           (POST /reuse/product/food/w/batchUpdateSkuStock).
  // The write needs only the session cookies (no request signing), so it's a
  // plain fetch issued from the logged-in page.
  async updateStock(productNameCn, productNameEn, newQty) {
    if (!await this.ensureLoggedIn()) return false;
    const ids = await this._resolveProductIds(productNameCn, productNameEn);
    if (!ids) return false;
    return this._apiSetStock(ids, newQty, productNameCn || productNameEn);
  }

  // Resolve {spuId, skuId} for a product by its mapped Meituan name. spuId/skuId
  // are stable, so the (navigation-heavy) lookup is cached per name; later syncs
  // for the same product skip straight to the write.
  async _resolveProductIds(productNameCn, productNameEn) {
    const key = (productNameCn || productNameEn || '').trim();
    if (!key) return null;
    if (this._idCache.has(key)) return this._idCache.get(key);

    const core = this._coreQuery(productNameCn || productNameEn);

    // 1) name -> spuId via Meituan's search-suggest (fires while typing).
    await this.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/listView`,
      { waitUntil: 'domcontentloaded', timeout: 20000 });
    await this._humanPause(2500, 4200);
    if (this._isVerifyPage()) { this._flagVerification('product list'); return null; }
    const frame = await this._getProductFrame();
    if (!frame) {
      if (this._isVerifyPage()) { this._flagVerification('product list'); return null; }
      return this._withFallback('updateStock: no content frame', null);
    }
    this.verificationRequired = false;
    await frame.evaluate(() => { for (const el of document.querySelectorAll('.roo-modal,[class*="backdrop"]')) el.style.display = 'none'; }).catch(() => {});

    this._apiCap = [];
    const sh = await frame.$('input[placeholder="搜索商品或规格名称"]').catch(() => null);
    if (!sh) return this._withFallback('updateStock: no search box', null);
    await sh.click({ timeout: 8000 }).catch(() => {});
    await sh.fill('');
    await sh.type(core, { delay: this._rand(60, 110) });
    await frame.waitForTimeout(this._rand(1800, 2600));

    const spuId = this._spuIdFromCapture(productNameCn, productNameEn);
    if (!spuId) { this._log(`product not found on Meituan (suggest): ${key}`); return null; }

    // 2) spuId -> skuId via the product editor (deterministic URL navigation;
    //    editView/v2 returns wmProductSpu carrying the sku id + current stock).
    this._apiCap = [];
    await this.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/editView?spuId=${spuId}`,
      { waitUntil: 'domcontentloaded', timeout: 20000 });
    await this._humanPause(2500, 4200);
    const sku = this._skuFromCapture(productNameCn, productNameEn);
    if (!sku || !sku.skuId) { this._log(`could not resolve skuId for ${key}`); return null; }

    const ids = { spuId, skuId: sku.skuId };
    this._idCache.set(key, ids);
    return ids;
  }

  // Set stock via Meituan's batchUpdateSkuStock API. autoRefresh=0 so the value
  // sticks (auto-replenish would otherwise refill it back to max). Issued as a
  // plain cookie-authenticated fetch from the logged-in page — no UI, no signing.
  async _apiSetStock(ids, newQty, label) {
    if (!this._wmPoiId) { this._log(`stock push: wmPoiId unknown for ${label}`); return false; }
    const frame = this.page.frames().find(f => {
      try { return f.url().includes('e.waimai.meituan.com') && !f.url().includes('imChat'); } catch (e) { return false; }
    }) || this.page.mainFrame();

    let res;
    try {
      res = await frame.evaluate(async ({ spuId, skuId, wmPoiId, stock }) => {
        const body = new URLSearchParams({
          v2: '1', opTab: '0', tagCat: '1', spuIds: String(spuId), wmPoiId: String(wmPoiId),
          stock: String(stock), maxStock: '-1', viewStyle: '0', skuIds: String(skuId), autoRefresh: '0',
          newSupplyParam: JSON.stringify({
            wmPoiId: Number(wmPoiId), spuIds: String(spuId), templateId: -1,
            stockInfo: JSON.stringify({ skuId: 0, stock: Number(stock), maxStock: -1, autoRefresh: 0 }),
            requestSource: '1'
          })
        }).toString();
        const r = await fetch('/reuse/product/food/w/batchUpdateSkuStock', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body, credentials: 'include'
        });
        let j = null; try { j = await r.json(); } catch (e) {}
        return { status: r.status, code: j && j.code, msg: j && j.msg };
      }, { spuId: ids.spuId, skuId: ids.skuId, wmPoiId: this._wmPoiId, stock: newQty });
    } catch (e) {
      this._log(`stock API error for ${label}: ${String(e.message).slice(0, 80)}`);
      return false;
    }

    const ok = !!res && res.status === 200 && res.code === 0;
    if (ok) { this._log(`stock updated: ${label} → ${newQty}`); return true; }

    // 套餐 (combo) with an out-of-stock component (code 10048 / msg mentions 套餐).
    // A combo's stock CAN be set, but only while all its component single-products
    // have stock; if any component is out, Meituan forces the whole combo sold-out
    // and refuses the override. That's the correct end state, so treat it as
    // handled (no retry) — when the component restocks, the resulting stock change
    // re-queues the combo and the push then succeeds.
    if (res && (res.code === 10048 || /套餐/.test(res.msg || ''))) {
      this._log(`套餐 combo "${label}": a component is out of stock → Meituan keeps the combo sold-out (can't override); leaving as-is`);
      return true;
    }

    this._log(`stock push failed for ${label}: ${JSON.stringify(res)}`);
    return ok;
  }

  // Leading same-script run of a name (CJK or Latin) — the substring Meituan's
  // search matches against. "红扁豆汤Red Lentils Soup" -> "红扁豆汤".
  _coreQuery(term) {
    const t = String(term || '');
    const m = t.match(/^[一-鿿]+/) || t.match(/^[A-Za-z][A-Za-z ]*[A-Za-z]/) || t.match(/^[A-Za-z]+/);
    const c = m ? m[0].trim() : t;
    return c.length >= 2 ? c : t;
  }

  // A captured product/suggestion name matches the mapped name if it contains the
  // CN name, its leading-script core, or (case-insensitively) the EN name.
  _nameMatches(candidateName, cn, en) {
    const n = String(candidateName || '');
    if (cn && n.includes(cn)) return true;
    const core = this._coreQuery(cn || en);
    if (core && n.includes(core)) return true;
    if (en && n.toLowerCase().includes(String(en).toLowerCase())) return true;
    return false;
  }

  _spuIdFromCapture(cn, en) {
    for (const c of this._apiCap) {
      if (!/searchSugByName/.test(c.url)) continue;
      const vos = (c.data && c.data.data && c.data.data.searchSugVos) || [];
      const v = vos.find(x => this._nameMatches(x.name, cn, en));
      if (v) return String(v.spuId);
    }
    return null;
  }

  _skuFromCapture(cn, en) {
    for (const c of this._apiCap) {
      const hit = {};
      this._extractSku(c.data, cn, en, hit);
      if (hit.found) return hit.found;
    }
    return null;
  }

  // Structure-agnostic: find a spu-shaped object (name matches + has `id`) that
  // carries a child *sku* array whose items have id + stock; return its first sku.
  _extractSku(node, cn, en, hit) {
    if (!node || typeof node !== 'object' || hit.found) return;
    if (Array.isArray(node)) { for (const x of node) this._extractSku(x, cn, en, hit); return; }
    if (typeof node.name === 'string' && this._nameMatches(node.name, cn, en) && ('id' in node)) {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' &&
            ('id' in v[0]) && ('stock' in v[0]) && /sku/i.test(k)) {
          hit.found = { spuId: String(node.id), skuId: String(v[0].id), stock: v[0].stock };
          return;
        }
      }
    }
    for (const k of Object.keys(node)) this._extractSku(node[k], cn, en, hit);
  }

  // The product content iframe (the one that owns the product search box), as
  // opposed to the page shell. Distinct from _getMainIframe (used for orders),
  // which just grabs the first Meituan frame.
  async _getProductFrame() {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(this._rand(500, 900));
      const frames = this.page.frames().filter(f =>
        f !== this.page.mainFrame() && f.url().includes('meituan.com') &&
        !f.url().startsWith('about:') && !f.url().includes('imChat'));
      for (const f of frames) {
        const hit = await f.$('input[placeholder="搜索商品或规格名称"]').catch(() => null);
        if (hit) return f;
      }
      const byUrl = frames.find(f => f.url().includes('region_id'));
      if (byUrl) return byUrl;
    }
    return null;
  }

  // ── Listing scrape ──────────────────────────────────────────────────────────

  // Read every product/listing title from the store's Meituan product list.
  // Returns an array of distinct names (the exact titles as they appear on
  // Meituan), or null if not logged in / the content iframe never loaded.
  // The merchant list is virtualised, so rows are collected progressively while
  // scrolling (scraping only at the end would miss rows that scrolled out).
  async listProducts() {
    if (!await this.ensureLoggedIn()) return null;

    await this.page.goto(
      `${MERCHANT_URL}/#/gw/static_resource/product#/listView`,
      { waitUntil: 'domcontentloaded', timeout: 20000 }
    );
    await this._humanPause(2500, 4200);

    const iframe = await this._getMainIframe();
    if (!iframe) return this._withFallback('listProducts: no iframe', null);

    const names = await iframe.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));

      // The product name lives in a text input on each row; the only other text
      // input is the search box (placeholder 搜索商品或规格名称). Same heuristic
      // updateStock uses to find a product — kept identical so a scraped name is
      // exactly what the matcher later searches for.
      const set = new Set();
      const collect = () => {
        for (const inp of document.querySelectorAll('input')) {
          if (inp.type === 'text' && inp.value && inp.placeholder !== '搜索商品或规格名称') {
            const v = inp.value.trim();
            if (v) set.add(v);
          }
        }
      };

      // Find the tallest scrollable container (the product list pane).
      const scrollers = Array.from(document.querySelectorAll('*')).filter(el => {
        const s = getComputedStyle(el);
        return (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
               el.scrollHeight > el.clientHeight + 50;
      });
      const scroller = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] ||
                       document.scrollingElement || document.body;

      collect();
      let lastTop = -1;
      for (let i = 0; i < 40; i++) {
        scroller.scrollTop += Math.max(200, scroller.clientHeight * 0.8);
        await sleep(320);
        collect();
        // Stop once we've reached the bottom and it isn't moving any more.
        if (scroller.scrollTop === lastTop) break;
        lastTop = scroller.scrollTop;
      }
      return Array.from(set);
    });

    this._log(`listProducts: scraped ${names ? names.length : 0} listing(s)`);
    return names || [];
  }

  // Batch update: push multiple products in ONE product-list visit. The previous
  // version re-navigated per item (N heavy SPA loads — a needless bot footprint);
  // this loads the list once, then updates each product on the same page.
  // items = [{ targetCn, targetEn, newQty, ...passthrough }]. Returns the input
  // items each augmented with `ok`. A mid-batch 验证中心 challenge sets
  // this.verificationRequired and the remaining items return ok:false (the caller
  // requeues them to retry once the cool-down passes, rather than burning attempts).
  async batchUpdateStock(items) {
    if (!items || !items.length) return [];
    if (!await this.ensureLoggedIn()) return items.map(it => ({ ...it, ok: false }));

    const out = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (this.verificationRequired) { out.push({ ...it, ok: false }); continue; }
      let ok = false;
      try {
        ok = await this.updateStock(it.targetCn, it.targetEn, it.newQty);
      } catch (e) {
        this._log(`batch item failed: ${String(e.message).slice(0, 80)}`);
      }
      out.push({ ...it, ok });
      if (i < items.length - 1) await this._humanPause(900, 2600); // human pause between products
    }
    const okN = out.filter(r => r.ok).length;
    this._log(`batchUpdateStock: ${okN} ok, ${out.length - okN} fail`);
    return out;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  async _getMainIframe() {
    // The merchant content iframe (waimaie.meituan.com) loads asynchronously
    // after navigation and its timing varies run-to-run. Poll for it with
    // jittered gaps up to ~10s instead of betting on a single fixed wait — a
    // one-shot timeout intermittently misses the frame and skips the poll.
    const find = () => this.page.frames().find(f =>
      f !== this.page.mainFrame() &&
      f.url().includes('meituan.com') &&
      !f.url().startsWith('about:')
    );
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(this._rand(600, 1100));
      const contentFrame = find();
      if (contentFrame) return contentFrame;
    }
    // Diagnostic: nothing matched in 10s. Dump what actually loaded so we can
    // tell a slow/renamed content frame apart from a risk-control challenge
    // page (which has no dashboard iframe at all).
    try {
      const frameUrls = this.page.frames().map(f => f.url()).filter(Boolean);
      let title = '';
      try { title = await this.page.title(); } catch (e) {}
      this._log(`iframe diag: url=${this.page.url()} title="${String(title).slice(0, 80)}" frames=[${frameUrls.join(' | ').slice(0, 400)}]`);
    } catch (e) {}
    return null;
  }

  async _saveSession() {
    if (!this.context) return;
    const state = await this.context.storageState();
    fs.writeFileSync(this.sessionFile, JSON.stringify(state));
  }

  // Randomised waits so actions never fire on a robotic fixed cadence — the
  // behavioural half of Tier 1 fingerprint reduction. Real risk-control flags
  // perfectly-regular timing; jittered pauses read as a human clicking around.
  _rand(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }
  async _humanPause(min = 600, max = 1600) { await this.page.waitForTimeout(this._rand(min, max)); }

  _log(msg) {
    console.log(`[meituan:${this.storeCode}] ${msg}`);
  }

  _withFallback(msg, fallback) {
    this._log(msg);
    return fallback;
  }
}

// ── Factory: get or create a browser instance per store ──────────────────────
const instances = {};

async function getBrowser(storeCode) {
  if (!instances[storeCode]) {
    const b = new MeituanBrowser(storeCode);
    await b.init();
    instances[storeCode] = b;
  }
  return instances[storeCode];
}

async function closeAll() {
  for (const b of Object.values(instances)) await b.close();
  for (const k of Object.keys(instances)) delete instances[k];
}

module.exports = { MeituanBrowser, getBrowser, closeAll, fingerprintInitScript };
