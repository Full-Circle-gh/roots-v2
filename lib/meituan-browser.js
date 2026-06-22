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

  async init() {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    const { chromium } = getPlaywright();

    const hasSession = fs.existsSync(this.sessionFile);
    const storageState = hasSession
      ? JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'))
      : undefined;

    // First run (no saved session): headed so staff can log in via WeChat QR
    const headless = hasSession;
    this._log(hasSession ? 'restoring session (headless)' : 'no session — launching headed for manual login');

    // On Windows prefer system Edge/Chrome; on Linux use bundled Chromium.
    const isWindows = process.platform === 'win32';
    // Tier 1 anti-fingerprint: AutomationControlled is the flag Chromium sets
    // that makes navigator.webdriver=true — the single strongest "this is a bot"
    // signal. Disabling it (plus the init script below) removes that tell.
    const stealthArgs = ['--disable-blink-features=AutomationControlled'];
    const launchOpts = {
      headless,
      args: isWindows
        ? stealthArgs
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

  async close() {
    try { await this._saveSession(); } catch {}
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
  // Navigates to product list, finds the product, runs the 改库存 dialog.
  async updateStock(productNameCn, productNameEn, newQty) {
    if (!await this.ensureLoggedIn()) return false;

    await this.page.goto(
      `${MERCHANT_URL}/#/gw/static_resource/product#/listView`,
      { waitUntil: 'domcontentloaded', timeout: 20000 }
    );
    await this._humanPause(2500, 4200);

    if (this._isVerifyPage()) { this._flagVerification('product list'); return false; }

    const iframe = await this._getMainIframe();
    if (!iframe) {
      if (this._isVerifyPage()) { this._flagVerification('product list'); return false; }
      return this._withFallback('updateStock: no iframe', false);
    }
    this.verificationRequired = false; // reached the real dashboard

    // Find the product by matching its name input
    const found = await iframe.evaluate((cn, en) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const productInput = inputs.find(inp =>
        inp.value && inp.type === 'text' && inp.placeholder !== '搜索商品或规格名称' &&
        (inp.value.includes(cn) || (en && inp.value.toLowerCase().includes(en.toLowerCase())))
      );
      if (!productInput) return false;

      // Walk up to find the row containing this product's checkbox
      let row = productInput;
      const allInputs = inputs;
      for (let i = 0; i < 20; i++) {
        row = row.parentElement;
        if (!row) break;
        if (row.innerText && row.innerText.includes('库存')) {
          const checkbox = row.querySelector('input[type="checkbox"]');
          if (checkbox) {
            checkbox.click();
            return true;
          }
        }
      }
      return false;
    }, productNameCn || '', productNameEn || '');

    if (!found) {
      this._log(`product not found: ${productNameCn || productNameEn}`);
      return false;
    }

    await iframe.waitForTimeout(this._rand(400, 900));

    // Click 改库存 in the bulk action bar
    const barClicked = await iframe.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span'));
      const btn = spans.find(s => s.innerText && s.innerText.trim() === '改库存');
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (!barClicked) {
      this._log('改库存 button not found');
      return false;
    }

    await iframe.waitForTimeout(this._rand(650, 1300));

    // Fill in the dialog
    const confirmed = await iframe.evaluate((qty) => {
      const dialogs = Array.from(document.querySelectorAll('[class*="modal"],[class*="dialog"],[role="dialog"]'));
      const stockDialog = dialogs.find(d =>
        d.offsetParent !== null && d.innerText && d.innerText.includes('批量修改库存')
      );
      if (!stockDialog) return false;

      const inputs = Array.from(stockDialog.querySelectorAll('input'));
      // Select 自定义库存 radio (value=3)
      const customRadio = inputs.find(i => i.type === 'radio' && i.value === '3');
      if (customRadio) customRadio.click();

      const stockInput = inputs.find(i => i.placeholder === '请填写剩余库存');
      if (!stockInput) return false;

      // Use native input setter to bypass React's synthetic event system
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(stockInput, String(qty));
      stockInput.dispatchEvent(new Event('input',  { bubbles: true }));
      stockInput.dispatchEvent(new Event('change', { bubbles: true }));

      const confirmBtn = Array.from(stockDialog.querySelectorAll('button,span,div'))
        .find(b => b.innerText && b.innerText.trim() === '确定');
      if (confirmBtn) { confirmBtn.click(); return true; }
      return false;
    }, newQty);

    if (confirmed) {
      await iframe.waitForTimeout(this._rand(800, 1600));
      this._log(`stock updated: ${productNameCn || productNameEn} → ${newQty}`);
    } else {
      this._log(`stock dialog confirm failed for ${productNameCn || productNameEn}`);
    }
    return confirmed;
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

  // Batch update: push multiple products in one product-list visit.
  // items = [{ productNameCn, productNameEn, newQty }]
  async batchUpdateStock(items) {
    if (!items || !items.length) return { ok: 0, fail: 0 };
    let ok = 0, fail = 0;
    for (const item of items) {
      const success = await this.updateStock(item.productNameCn, item.productNameEn, item.newQty);
      if (success) ok++; else fail++;
      await this._humanPause(900, 2600); // human-like pause between products
    }
    this._log(`batchUpdateStock: ${ok} ok, ${fail} fail`);
    return { ok, fail };
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
