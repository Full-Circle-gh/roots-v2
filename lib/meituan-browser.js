/* global window, document, navigator, getComputedStyle, Notification, MimeType, Plugin, PluginArray, MimeTypeArray */
// (The names above are DOM globals referenced inside addInitScript / page.evaluate
//  callbacks that run in the BROWSER context, not Node — declared here so the
//  deploy-time eslint no-undef gate doesn't flag them. This file was hand-patched
//  on the box and never went through the lint gate before; declaring them keeps
//  real Node-side typos still caught.)
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

  // navigator.plugins / mimeTypes — headless Chromium reports an EMPTY
  // PluginArray; real desktop Chrome ships the built-in PDF viewer entries.
  // Under headful/Xvfb these are already correct, so only synthesize when empty
  // (the headless-fallback path) — never replace a real PluginArray with a fake,
  // which would be a louder tell than the empty one.
  try {
    if (!navigator.plugins || navigator.plugins.length === 0) {
      const mkMime = (type) => {
        const m = Object.create(MimeType.prototype);
        Object.defineProperties(m, {
          type:        { value: type, enumerable: true },
          suffixes:    { value: 'pdf', enumerable: true },
          description: { value: 'Portable Document Format', enumerable: true },
        });
        return m;
      };
      const mimeApp = mkMime('application/pdf');
      const mimeTxt = mkMime('text/pdf');
      const mimes = [mimeApp, mimeTxt];
      const names = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer',
                     'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'];
      const plugins = names.map((name) => {
        const p = Object.create(Plugin.prototype);
        Object.defineProperties(p, {
          name:        { value: name, enumerable: true },
          filename:    { value: 'internal-pdf-viewer', enumerable: true },
          description: { value: 'Portable Document Format', enumerable: true },
          length:      { value: mimes.length },
          0:           { value: mimeApp, enumerable: true },
          1:           { value: mimeTxt, enumerable: true },
          item:        { value: function (i) { return mimes[i] || null; } },
          namedItem:   { value: function (t) { return mimes.find(m => m.type === t) || null; } },
        });
        return p;
      });
      const buildArray = (Proto, items, keyOf) => {
        const arr = Object.create(Proto.prototype);
        items.forEach((it, i) => Object.defineProperty(arr, i, { value: it, enumerable: true }));
        Object.defineProperties(arr, {
          length:    { value: items.length },
          item:      { value: function (i) { return items[i] || null; } },
          namedItem: { value: function (n) { return items.find(it => keyOf(it) === n) || null; } },
        });
        return arr;
      };
      define(navigator, 'plugins',   buildArray(PluginArray,   plugins, p => p.name));
      define(navigator, 'mimeTypes', buildArray(MimeTypeArray, mimes,   m => m.type));
    }
  } catch (e) {}

  // Notification.permission vs navigator.permissions.query — headless reports a
  // mismatch (query → 'prompt' while Notification.permission → 'denied') that
  // real Chrome never shows. Align the query result to the actual permission so
  // the two agree.
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const origQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function (params) {
        if (params && params.name === 'notifications' && typeof Notification !== 'undefined') {
          return Promise.resolve({ state: Notification.permission, onchange: null });
        }
        return origQuery(params);
      };
    }
  } catch (e) {}
}

// Tier 4: resolve an optional outbound proxy from config (tenant-neutral — no
// hardcoded host). Per-store override MEITUAN_PROXY_<STORECODE> wins, else the
// shared MEITUAN_PROXY_URL. Accepts http(s)://user:pass@host:port or
// socks5://host:port. Unset → null → direct connection (current behaviour).
// Raw proxy URL the daemon should use for a store: the failover watchdog's live
// choice (data/proxy-active.json, re-picked across residential→GZ→direct on
// health) wins; else the env default. '' = direct. Lazy-require keeps the
// proxy-manager optional so a missing module never breaks the browser.
function activeProxyRaw(storeCode) {
  try {
    const active = require('./proxy-manager').readActive(storeCode);
    if (active !== undefined) return active; // '' is a valid value (direct)
  } catch (_) { /* manager optional — fall through to env */ }
  return (storeCode && process.env[`MEITUAN_PROXY_${String(storeCode).toUpperCase()}`])
    || process.env.MEITUAN_PROXY_URL || '';
}

function resolveProxy(storeCode) {
  const raw = activeProxyRaw(storeCode);
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

    // By default a restored session runs headless. Opt into HEADFUL (under Xvfb
    // on the Linux daemon) with MEITUAN_HEADFUL=1 to shed the headless-only
    // fingerprint tells that survive the init-script spoof — empty
    // navigator.plugins/mimeTypes, missing media codecs, absent chrome.runtime,
    // off Notification.permission. Only go headful when a display actually
    // exists (DISPLAY on Linux, or Windows); otherwise fall back to headless so
    // a box missing Xvfb never stalls sync. (Identical to the old behaviour when
    // the flag is unset: opts.headed→headed, session→headless, no session→headed.)
    const displayAvailable = process.platform === 'win32' || !!process.env.DISPLAY;
    const headfulRequested = process.env.MEITUAN_HEADFUL === '1';
    const goHeadful = headfulRequested && displayAvailable;
    const headless = opts.headed ? false : (useSession ? !goHeadful : false);
    if (useSession && headfulRequested && !displayAvailable) {
      this._log('MEITUAN_HEADFUL set but no DISPLAY — staying headless (run the daemon under xvfb-run, or start Xvfb and set DISPLAY=:99)');
    }
    this._log(!useSession
      ? (opts.ignoreSession ? 'fresh login (existing session kept until new login succeeds)'
                            : 'no session — launching headed for manual login')
      : (headless ? 'restoring session (headless)' : 'restoring session (headful / Xvfb)'));

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
        : ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-default-apps', '--disable-breakpad', '--disable-domain-reliability', '--no-pings', '--disk-cache-size=33554432', '--media-cache-size=16777216', '--disable-gpu-shader-disk-cache', ...stealthArgs],
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
    // Record the raw proxy URL this browser is launched with, so getBrowser can
    // relaunch it when the failover watchdog switches the active proxy.
    this._proxyRaw = activeProxyRaw(this.storeCode);
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

    // A proxy/network outage makes this goto time out. That is NOT a logout —
    // surface it as such so callers don't trigger a pointless re-login. (The
    // daemon also gates the whole loop on proxy health, so this is belt-and-
    // suspenders for any direct caller.)
    try {
      await this.page.goto(MERCHANT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      this._log(`merchant page unreachable (${String(e.message).split('\n')[0].slice(0, 60)}) — proxy/network down, NOT a logout`);
      return false;
    }
    await this._humanPause(2500, 4200);

    // Risk-control challenge: bail clearly instead of misreporting login.
    if (this._isVerifyPage()) { this._flagVerification('login'); return false; }

    const url = this.page.url();
    // Login confirmed when URL is on either meituan merchant domain with session params
    const isOnMerchant = (u) =>
      (u.includes('waimaie.meituan.com') || u.includes('e.waimai.meituan.com')) &&
      !u.includes('/login_gw') && !u.includes('/login?') && !u.includes('#/login');
    if (isOnMerchant(url)) {
      // URL alone is a FALSE POSITIVE: a logged-out session flashes the bare
      // e.waimai.meituan.com/#/order URL for a moment before Meituan redirects it
      // to login_gw#/login. Real proof of an authenticated session is the merchant
      // content iframe (the same frame order/stock polling needs). Require it
      // before claiming login — and before calling _saveSession, so a logged-out
      // shell never overwrites a good session file with its bogus state.
      if (await this._getMainIframe()) {
        this._loggedIn = true;
        await this._saveSession();
        this._log('login confirmed');
        return true;
      }
      this._log('on merchant URL but no dashboard iframe — session not authenticated (needs login)');
      // fall through to the not-logged-in handling below
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

  // True only when the underlying Chromium is still usable. A renderer crash or
  // a dropped browser process leaves this.browser/page as stale references that
  // every subsequent call throws "Target page, context or browser has been
  // closed" on — the daemon then loops forever on a dead browser (silently
  // dropping orders) until the process is restarted. The factory uses this to
  // relaunch a dead instance instead. Wrapped in try/catch because isConnected()/
  // isClosed() themselves throw once the connection is gone.
  isAlive() {
    try {
      if (!this.browser || !this.browser.isConnected()) return false;
      if (!this.page || this.page.isClosed()) return false;
      return true;
    } catch { return false; }
  }

  // ── Order polling ─────────────────────────────────────────────────────────

  // Parse an order's clickCopyContent string into stock line-items.
  //
  // The order-list API does NOT return a structured food array — the only
  // machine-readable item list is copyButtonVo.clickCopyContent, e.g.:
  //   "...已隐藏  香柠草康普茶Lemongrass (300ml)x1  素食藜麦沙拉 Quinoa Salad(1-300)x1
  //    中东鹰嘴豆泥套餐 Hummus Combo[萌系麦薄脆 Whole Wheat Crackers(4-270)x1、
  //    Hummus Asli  中东鹰嘴豆泥(1-10)x1]  Basil Pesto 阿古罗勒青酱(1-20)x1
  //    无需餐具 No cutleryx1  合计：176.5元  备注:... (已付款) ..."
  //
  // The merchant encodes each Roots SKU as a "(\d+-\d+)" token inside the Meituan
  // spec name, so SKU is the reliable mapping key. A 套餐 (combo) lists its
  // components inside [ ]; the combo wrapper itself holds no stock. Items with no
  // SKU token (e.g. Lemongrass "(300ml)") fall back to name matching downstream.
  _parseOrderCopy(copy) {
    const s = String(copy || '');
    // Narrow to the items region: after the privacy notice, before the total.
    let region = s;
    const start = region.search(/已隐藏/);
    if (start >= 0) region = region.slice(start + '已隐藏'.length);
    const endM = region.search(/合计[:：]/);
    if (endM >= 0) region = region.slice(0, endM);
    // Expand combo brackets in place: keep the components (split on 、), drop only
    // the bracket chars. The combo wrapper text then has no trailing xN and is
    // skipped below.
    region = region.replace(/\[([^\]]*)\]/g, (_m, inner) => '  ' + inner.replace(/、/g, '  ') + '  ');

    const SKIP = /(无需餐具|No\s*cutlery|餐具|打包费|配送费|包装费)/i;
    const items = [];
    for (const seg of region.split(/\s{2,}/).map(t => t.trim()).filter(Boolean)) {
      const qm = seg.match(/[x×]\s*(\d+)\s*$/i);
      if (!qm) continue;                 // segments without a trailing qty aren't items
      const qty = parseInt(qm[1], 10);
      if (!qty) continue;
      const name = seg.slice(0, qm.index).trim();
      if (!name || SKIP.test(seg)) continue;
      const skuM = name.match(/\((\d+-\d+)\)/);
      items.push({ name, sku: skuM ? skuM[1] : null, qty });
    }
    return items;
  }

  // Returns today's orders (Asia/Shanghai) from the merchant order list.
  //
  // tianhe is on Meituan Retail (hasMigratedToRetail) and orders auto-accept, so
  // the old "scrape the 待接单 cards" approach found nothing: by poll time the
  // order has already left the new bucket. Instead we read the same JSON API the
  // "全部订单" page uses (POST order/list/page/history), via an in-page fetch so
  // Meituan's H5guard SDK signs it (exactly like the stock-push). Dedup against
  // meituan_order_import is the caller's job, so returning all of today is safe.
  async getPendingOrders() {
    if (!await this.ensureLoggedIn()) return [];

    // The order list lives in the orderbusiness SPA, not #/order. Loading it
    // initialises H5guard + the POI/auth context our in-page fetch needs.
    await this.page.goto(`${MERCHANT_URL}/new_fe/orderbusiness#/order/history`,
      { waitUntil: 'domcontentloaded', timeout: 25000 });
    await this._humanPause(3000, 5000);

    if (this._isVerifyPage()) { this._flagVerification('order page'); return []; }

    const frame = this.page.frames().find(f => {
      try { return f.url().includes('e.waimai.meituan.com') && !f.url().includes('imChat'); }
      catch (e) { return false; }
    }) || this.page.mainFrame();

    // Today in Asia/Shanghai (independent of server TZ).
    const sh = new Date(Date.now() + 8 * 3600 * 1000);
    const ymd = `${sh.getUTCFullYear()}-${String(sh.getUTCMonth() + 1).padStart(2, '0')}-${String(sh.getUTCDate()).padStart(2, '0')}`;

    let raw;
    try {
      raw = await frame.evaluate(async (ymd) => {
        const pageParam = JSON.stringify({ pageSize: 50, pageNum: 1, sort: 0, nextLabel: '', lastLabel: '', direction: 0 });
        const extParam  = JSON.stringify({ phfRollback: 0, searchTag: -1 });
        const body = `tag=allOrder&pageParam=${encodeURIComponent(pageParam)}`
          + `&extParam=${encodeURIComponent(extParam)}&startDate=${ymd}&endDate=${ymd}`;
        const r = await fetch('/gw/api/unified/r/order/list/page/history', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body, credentials: 'include',
        });
        let j = null; try { j = await r.json(); } catch (e) {}
        return { status: r.status, data: j };
      }, ymd);
    } catch (e) {
      return this._withFallback(`getPendingOrders fetch error: ${String(e.message).slice(0, 80)}`, []);
    }

    if (!raw || raw.status !== 200 || !raw.data || raw.data.code !== 0) {
      this._log(`order list fetch failed: ${JSON.stringify(raw).slice(0, 160)}`);
      return [];
    }
    this.verificationRequired = false; // reached the real dashboard

    const list = (raw.data.data && raw.data.data.orderList) || [];
    const orders = [];
    for (const o of list) {
      let oi = {}, ci = {};
      try { oi = JSON.parse(o.orderInfo  || '{}'); } catch (e) {}
      try { ci = JSON.parse(o.commonInfo || '{}'); } catch (e) {}
      const u = oi.unifiedOrderInfo || {};
      const viewId = String(u.wmOrderViewId || ci.wm_order_id_view || '');
      if (!viewId) continue;
      const copy   = (u.copyButtonVo && u.copyButtonVo.clickCopyContent) || '';
      const totalM = copy.match(/合计[:：]\s*([\d.]+)\s*元/);
      const paid   = /已付款/.test(copy) || (u.basicVo && u.basicVo.payStatus === 3);
      orders.push({
        meituanOrderNo: viewId,
        daySeq:     ci.wm_poi_order_dayseq != null ? ci.wm_poi_order_dayseq : (u.dayseq || null),
        items:      this._parseOrderCopy(copy),
        total:      totalM ? parseFloat(totalM[1]) : 0,
        paid:       !!paid,
        statusDesc: u.statusDesc || '',
        placedTime: u.orderTimeFmt || '',
      });
    }
    this._log(`found ${orders.length} order(s) via order list API`);
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
  // Returns { ok, transient }. A login failure or an unresolved product (a
  // searchSugByName / navigation hiccup) is transient → the caller retries it
  // rather than burying the row as a terminal error that never self-heals.
  async updateStock(productNameCn, productNameEn, newQty, sku) {
    if (!await this.ensureLoggedIn()) return { ok: false, transient: true };
    const ids = await this._resolveProductIds(productNameCn, productNameEn);
    if (!ids) return { ok: false, transient: true }; // resolve/nav hiccup → retry
    return this._applyStockRule(ids, newQty, productNameCn || productNameEn, sku);
  }

  // Push stock to a product's SKU(s). Single-SKU products get the plain value.
  // Multi-variant products (wraps/soups: a main "单点/Only…" SKU plus +add-on
  // SKUs) follow the operator's rule, keyed on the product's Roots stock N:
  //   N >= 3  → every variant available (a big number)
  //   N <= 2  → ONLY the main variant (SKU index 0) carries the real count N;
  //             every add-on variant drops to 0, so the last couple can't be
  //             over-ordered across different add-ons.
  // Returns { ok, transient }. `transient` is true when the failure should be
  // retried (an automation/navigation hiccup) rather than marked terminal. A
  // failure is terminal ONLY when every failing SKU was a genuine API rejection.
  async _applyStockRule(ids, newQty, label, sku) {
    const skus = (ids && ids.skus) || [];
    // No resolved SKUs is a resolve/load hiccup, not a real rejection → retry.
    if (!skus.length) { this._log(`no skus to set for ${label}`); return { ok: false, transient: true }; }

    // Per-spec targeting: when this Roots product's SKU code (e.g. "1-180") appears
    // in exactly one of the spu's spec strings ("130g 小 (1-180)(约180克)"), it owns
    // that single spec — set only it to the product's own stock. This is how two
    // separate Roots size-variants share one Meituan spu (two specs) without
    // overwriting each other; without it the multi-variant rule below would wrongly
    // drive every spec from one variant's stock. Real wraps/soups don't carry per-
    // SKU codes in their spec text, so they fall through to the rule unchanged.
    const code = String(sku || '').trim();
    if (code) {
      // Prefer the spec whose DEDICATED 货号 field equals this Roots SKU (exact,
      // 100% accurate). Fall back to the SKU token embedded in the spec text
      // (older listings that carry "(1-180)" in the spec name). The `via` tag in
      // the log tells us whether the list payload actually carries the dedicated
      // field — the signal that gates the name-free Phase 2.
      let owned = skus.filter(s => s.fieldCode && s.fieldCode.trim() === code);
      let via = 'field';
      if (!owned.length) { owned = skus.filter(s => this._specHasSku(s.spec, code)); via = 'spec'; }
      if (owned.length === 1) {
        this._log(`sku ${code} → 1 spec via ${via} [${owned[0].spec}]`);
        return this._toTransient(await this._apiSetSku(ids.spuId, owned[0].skuId, newQty, `${label} [${owned[0].spec}]`));
      }
      if (owned.length > 1) this._log(`sku ${code} matched ${owned.length} specs (via ${via}) for ${label}; using rule`);
      if (owned.length === 0) this._log(`sku ${code} matched NO spec for ${label} (specs: ${skus.map(s => s.spec).join(' | ')}) — likely wrong listing resolved; using rule`);
    }

    if (skus.length === 1) {
      return this._toTransient(await this._apiSetSku(ids.spuId, skus[0].skuId, newQty, label));
    }

    const N = Number(newQty);
    const BIG = 999;
    const targets = skus.map((s, i) => (N >= 3) ? BIG : (i === 0 ? N : 0));
    const leaves = [];
    for (let i = 0; i < skus.length; i++) {
      leaves.push(await this._apiSetSku(ids.spuId, skus[i].skuId, targets[i], `${label} [${skus[i].spec}]`));
      if (i < skus.length - 1) await this._humanPause(300, 700);
    }
    this._log(`variants set: ${label} (Roots N=${N}) → [${targets.join(', ')}]`);
    const ok = leaves.every(r => r.ok);
    // Retry the whole item unless every failing variant was a genuine rejection.
    const transient = !ok && leaves.some(r => !r.ok && !r.apiRejected);
    return { ok, transient };
  }

  // Collapse a single _apiSetSku result {ok, apiRejected} into the {ok, transient}
  // shape callers act on: any non-rejected failure is transient (retry).
  _toTransient(r) { return { ok: !!(r && r.ok), transient: !(r && r.ok) && !(r && r.apiRejected) }; }

  // Resolve {spuId, skuId} for a product by its mapped Meituan name. spuId/skuId
  // are stable, so the (navigation-heavy) lookup is cached per name; later syncs
  // for the same product skip straight to the write.
  async _resolveProductIds(productNameCn, productNameEn) {
    const key = (productNameCn || productNameEn || '').trim();
    if (!key) return null;
    if (this._idCache.has(key)) return this._idCache.get(key);

    const core = this._coreQuery(productNameCn || productNameEn);

    // 1) name -> spuId via Meituan's search-suggest (fires while typing). Always a
    //    FRESH load here (not the idempotent warm-up nav): each resolve needs the
    //    list in its clean initial state so the search box + suggest capture work,
    //    without a prior product's category-filter/modal state lingering.
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

    const sug = this._sugFromCapture(productNameCn, productNameEn);
    if (!sug || !sug.spuId) { this._log(`product not found on Meituan (suggest): ${key}`); return null; }

    // 2) spuId -> skuId by opening the product's category so getSpuListCommon
    //    returns the full spu (wmProductSkuVos carries the sku id + stock). This
    //    resolves EVERY product type, including 套餐 combos: combos don't use the
    //    single-product editView/v2 editor, so the old editor-navigation lookup
    //    never captured their sku and they all failed with "could not resolve".
    const cat = String(sug.tagName || '').replace(/[^一-鿿A-Za-z0-9]/g, '').trim() || sug.tagName;
    if (cat) { try { await frame.locator(`text=${cat}`).first().click({ timeout: 6000 }); } catch (e) {} }
    await frame.waitForTimeout(this._rand(3000, 3800));

    const skus = this._skusFromSpuList(sug.spuId, productNameCn, productNameEn);
    if (!skus || !skus.length) { this._log(`could not resolve skuId for ${key}`); return null; }

    // Diagnostic: how many of this spu's specs carried a DEDICATED 货号 field in
    // the list payload (vs only a code embedded in the spec text). >0 on any
    // product proves getSpuListCommon exposes the SKU → name-free Phase 2 viable.
    const withField = skus.filter(s => s.fieldCode).length;
    this._log(`resolved ${key}: ${skus.length} spec(s), dedicated 货号 field on ${withField}`);
    // When we couldn't find the SKU, dump where digit-dash-digit values DO live
    // in the raw list payload so we can see if the 货号 is present (under another
    // field) or genuinely absent from getSpuListCommon (editView-only).
    if (!withField && skus[0] && skus[0].raw) {
      const hits = [];
      this._skuLikeHits(skus[0].raw, '', hits);
      this._log(`  raw sku0 keys=[${Object.keys(skus[0].raw).join(',')}] sku-like=[${hits.slice(0, 12).map(h => h.path + '=' + h.val).join(' | ') || 'none'}]`);
    }

    const ids = { spuId: String(sug.spuId), skus };
    this._idCache.set(key, ids);
    return ids;
  }

  // Set stock via Meituan's batchUpdateSkuStock API. autoRefresh=0 so the value
  // sticks (auto-replenish would otherwise refill it back to max). Issued as a
  // plain cookie-authenticated fetch from the logged-in page — no UI, no signing.
  // NOTE: this endpoint sets the spu-LEVEL stock — it cannot target one spec of a
  // multi-spec listing (a skuId here, real or 0, is ignored; the value broadcasts
  // to every spec, last write wins). Meituan only sets per-spec stock via the full
  // /w/save editor payload (stockAndBoxPriceSkus[].wmProductStock.stock). The
  // platform avoids this entirely by mapping each Roots size-variant to its OWN
  // single-spec Meituan product, so spu == sku and this push is exact.
  // Returns { ok, apiRejected }. `apiRejected` is true ONLY for a genuine
  // Meituan API-level rejection — a real HTTP-200 reply carrying a non-zero
  // business code. Every other failure (missing wmPoiId, a thrown fetch, a
  // non-200 / no reply from a navigation hiccup) is TRANSIENT (apiRejected:false)
  // and should be retried by the caller, not buried as a terminal error.
  async _apiSetSku(spuId, skuId, newQty, label) {
    if (!this._wmPoiId) { this._log(`stock push: wmPoiId unknown for ${label}`); return { ok: false, apiRejected: false }; }
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
      }, { spuId: String(spuId), skuId: String(skuId), wmPoiId: this._wmPoiId, stock: newQty });
    } catch (e) {
      this._log(`stock API error for ${label}: ${String(e.message).slice(0, 80)}`);
      return { ok: false, apiRejected: false }; // transient: page/network hiccup
    }

    const ok = !!res && res.status === 200 && res.code === 0;
    if (ok) { this._log(`stock updated: ${label} → ${newQty}`); return { ok: true, apiRejected: false }; }

    // 套餐 (combo) with an out-of-stock component (code 10048 / msg mentions 套餐).
    // A combo's stock CAN be set, but only while all its component single-products
    // have stock; if any component is out, Meituan forces the whole combo sold-out
    // and refuses the override. That's the correct end state, so treat it as
    // handled (no retry) — when the component restocks, the resulting stock change
    // re-queues the combo and the push then succeeds.
    if (res && (res.code === 10048 || /套餐/.test(res.msg || ''))) {
      this._log(`套餐 combo "${label}": a component is out of stock → Meituan keeps the combo sold-out (can't override); leaving as-is`);
      return { ok: true, apiRejected: false }; // correct end state — treat as handled
    }

    this._log(`stock push failed for ${label}: ${JSON.stringify(res)}`);
    // Only a real reply (HTTP 200) with a non-zero business code is a genuine
    // API rejection. A missing/garbled reply or a non-200 is transient → retry.
    const apiRejected = !!res && res.status === 200 && res.code != null && res.code !== 0;
    return { ok: false, apiRejected };
  }

  // Leading same-script run of a name (CJK or Latin) — the substring Meituan's
  // search matches against. "红扁豆汤Red Lentils Soup" -> "红扁豆汤".
  _coreQuery(term) {
    const t = String(term || '');
    const m = t.match(/^[一-鿿]+/) || t.match(/^[A-Za-z][A-Za-z ]*[A-Za-z]/) || t.match(/^[A-Za-z]+/);
    const c = m ? m[0].trim() : t;
    return c.length >= 2 ? c : t;
  }

  // A Roots SKU code (e.g. "1-180") owns a Meituan spec when it appears in the spec
  // text as a whole token: "130g 小 (1-180)(约180克)". The token boundary stops
  // "1-19" matching "1-190" and "1-180" matching "11-180".
  _specHasSku(spec, code) {
    if (!spec || !code) return false;
    const esc = String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^0-9A-Za-z-])${esc}([^0-9A-Za-z-]|$)`).test(String(spec));
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

  // Matched suggestion from a searchSugByName capture, carrying both the spuId
  // and the product's category (tagName) needed to open the right category list.
  _sugFromCapture(cn, en) {
    const cands = [];
    for (const c of this._apiCap) {
      if (!/searchSugByName/.test(c.url)) continue;
      for (const v of ((c.data && c.data.data && c.data.data.searchSugVos) || [])) cands.push(v);
    }
    if (!cands.length) return null;
    const cnT = String(cn || '').trim();
    // Exact name match wins — otherwise a 套餐 combo that merely shares the name
    // prefix (e.g. "法拉费卷套餐" vs the wrap "法拉费卷 Falafel Wrap") could be picked.
    let v = cnT && cands.find(x => String(x.name).trim() === cnT);
    if (!v) {
      // else the shortest matching name (closest to the base product, not a combo).
      const m = cands.filter(x => this._nameMatches(x.name, cn, en));
      m.sort((a, b) => String(a.name).length - String(b.name).length);
      v = m[0];
    }
    return v ? { spuId: String(v.spuId), tagName: v.tagName || '' } : null;
  }

  // ALL skus (in spec order) of the matched spu from a getSpuListCommon capture
  // (the category product list). Matched by spuId first (robust against the
  // wrap-vs-combo name collision — a wrap and its 套餐 share a name prefix), name
  // as fallback. Works for single-sku, multi-variant, and 套餐 combo products.
  _skusFromSpuList(spuId, cn, en) {
    for (const c of this._apiCap) {
      if (!/getSpuListCommon/.test(c.url)) continue;
      const vos = (c.data && c.data.data && c.data.data.spuListVos) || [];
      let v = spuId ? vos.find(x => String(x.id) === String(spuId)) : null;
      if (!v) v = vos.find(x => this._nameMatches(x.name, cn, en));
      const skuVos = v && Array.isArray(v.wmProductSkuVos) ? v.wmProductSkuVos : null;
      if (skuVos && skuVos.length) {
        return skuVos
          .filter(s => s && s.id != null)
          .map(s => ({ skuId: String(s.id), spec: s.spec || '', stock: s.stock, raw: s,
                       fieldCode: this._skuCodeFromSkuObj(s),
                       code: this._skuCodeFromSkuObj(s) || this._skuCodeFromSpec(s.spec) }));
      }
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

  // The 货号 (merchant article number) Meituan prints inside a spec string — the
  // token the per-spec stock push matches on. Prefer the parenthesised group that
  // contains a digit-dash-digit code (handles full-width parens and multipack
  // suffixes): "240g（小）（2-370）"→"2-370", "1瓶 (4-770 X1)(1升)"→"4-770 X1",
  // "130g 小 (1-180)(约180克)"→"1-180". Falls back to a bare code token, else ''.
  _skuCodeFromSpec(spec) {
    const s = String(spec || '');
    const groups = s.match(/[(（]([^()（）]*\d+-\d+[^()（）]*)[)）]/g) || [];
    if (groups.length) {
      const inner = groups[0].replace(/^[(（]|[)）]$/g, '').trim();
      if (inner) return inner;
    }
    const bare = s.match(/\d+-\d+[A-Za-z0-9 *]*/);
    return bare ? bare[0].trim() : '';
  }

  // The DEDICATED 货号 / SKU field a merchant sets per spec on the Meituan edit
  // page (the screenshot's "SKU 1-430" row), as opposed to a code embedded in the
  // spec display text. The 外卖 getSpuListCommon sku object MAY carry it under
  // sourceFoodCode (the field 闪购 uses) or a sibling — we check the known names,
  // then scan code-ish keys for a clean Roots-SKU token (\d+-\d+). Field-name-
  // agnostic so it works whatever Meituan calls it. Returns '' when the list
  // payload doesn't include the SKU at all → callers fall back to the spec-text
  // code (current behaviour), so this is purely additive.
  _skuCodeFromSkuObj(s) {
    if (!s || typeof s !== 'object') return '';
    const NAMED = ['sourceFoodCode', 'sku', 'skuCode', 'merchantSkuCode', 'articleNumber', 'code', 'upc'];
    for (const k of NAMED) {
      const v = s[k];
      if (typeof v === 'string' && /^\s*\d+-\d+/.test(v)) return v.trim();
    }
    // Fall back to any code-ish field holding an exact Roots-SKU value (avoids
    // matching unrelated numeric strings like dates by restricting the key name).
    for (const k of Object.keys(s)) {
      if (!/code|sku|food|article|barcode|upc/i.test(k)) continue;
      const v = s[k];
      if (typeof v === 'string' && /^\s*\d+-\d+\s*$/.test(v)) return v.trim();
    }
    // Last resort: a deep scan for a value that is EXACTLY a clean Roots-SKU
    // token (\d+-\d+) anywhere in the sku object, whatever Meituan names the
    // field. Exact-match only, so suffixed spec echoes ("2-240(120克)") and
    // unrelated numbers don't false-positive.
    const hits = [];
    this._skuLikeHits(s, '', hits);
    const exact = hits.find(h => /^\d+-\d+$/.test(h.val));
    return exact ? exact.val : '';
  }

  // Recursively collect {path, val} for every string/number value that contains a
  // digit-dash-digit token — used both by the deep SKU scan above and the
  // diagnostic that locates where Meituan keeps the 货号 in the list payload.
  _skuLikeHits(node, path, out, depth) {
    depth = depth || 0;
    if (out.length >= 24 || depth > 5 || node == null) return;
    const t = typeof node;
    if (t === 'string' || t === 'number') {
      if (/\d+-\d+/.test(String(node))) out.push({ path, val: String(node).slice(0, 28) });
      return;
    }
    if (t !== 'object') return;
    for (const k of Object.keys(node)) this._skuLikeHits(node[k], path ? path + '.' + k : k, out, depth + 1);
  }

  // Like listProducts(), but also returns each listing's specs with the captured
  // 货号. Scrolling the list view fires getSpuListCommon for the loaded pages, which
  // carry wmProductSkuVos (spec + skuId + stock); we harvest those from _apiCap.
  // Returns { names: [...], listings: [{name, spuId, skus:[{spec, code, skuId, stock, raw}]}] }.
  async listProductsWithSpecs() {
    this._apiCap = [];                       // fresh capture window for this scrape
    const names = await this.listProducts(); // scrolls the list → populates _apiCap
    if (names == null) return null;

    const bySpu = new Map();                 // spuId -> {name, spuId, skus:[]}
    for (const c of this._apiCap) {
      if (!/getSpuListCommon/.test(c.url)) continue;
      const vos = (c.data && c.data.data && c.data.data.spuListVos) || [];
      for (const v of vos) {
        if (!v || v.id == null) continue;
        const skuVos = Array.isArray(v.wmProductSkuVos) ? v.wmProductSkuVos : [];
        if (!skuVos.length) continue;
        bySpu.set(String(v.id), {
          name:  v.name || '',
          spuId: String(v.id),
          skus:  skuVos.filter(s => s && s.id != null).map(s => ({
            spec:  s.spec || '',
            code:  this._skuCodeFromSkuObj(s) || this._skuCodeFromSpec(s.spec),
            skuId: String(s.id),
            stock: s.stock,
            raw:   s,
          })),
        });
      }
    }
    const listings = Array.from(bySpu.values());
    this._log(`listProductsWithSpecs: ${listings.length} spu(s) with specs`);
    return { names, listings };
  }

  // Batch update: push multiple products in ONE product-list visit. The previous
  // version re-navigated per item (N heavy SPA loads — a needless bot footprint);
  // this loads the list once, then updates each product on the same page.
  // items = [{ targetCn, targetEn, newQty, ...passthrough }]. Returns the input
  // items each augmented with `ok`. A mid-batch 验证中心 challenge sets
  // this.verificationRequired and the remaining items return ok:false (the caller
  // requeues them to retry once the cool-down passes, rather than burning attempts).
  // Warm-up / shared navigation to the product (inventory) list — the page a real
  // merchant edits stock from. Idempotent: when the session is already on the list
  // (mid-batch) it skips the reload. Used both as the batch warm-up and by
  // _resolveProductIds, so product stock-writes never fire while the page is still
  // on /#/order from the last order poll (an incoherent "editing product stock from
  // the orders screen" footprint). Returns false on a verify challenge or nav error.
  async _ensureOnProductList() {
    try {
      if (!this.page.url().includes('product#/listView')) {
        await this.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/listView`,
          { waitUntil: 'domcontentloaded', timeout: 20000 });
        await this._humanPause(2500, 4200);
      }
      return !this._isVerifyPage();
    } catch (e) {
      this._log(`product-list nav failed: ${String(e.message).slice(0, 80)}`);
      return false;
    }
  }

  // Each returned item is augmented with { ok, transient }. `transient` (only
  // meaningful when ok is false) tells the daemon to keep the queue row pending
  // and retry — an automation hiccup, NOT a genuine Meituan API rejection. Only
  // a real rejection (transient:false) should become a terminal queue error.
  async batchUpdateStock(items) {
    if (!items || !items.length) return [];
    if (!await this.ensureLoggedIn()) return items.map(it => ({ ...it, ok: false, transient: true }));

    // Warm-up navigation: land on the inventory list before any stock-write so the
    // API calls issue from the product page (where a human edits stock), not from
    // /#/order left over from the last order poll. _resolveProductIds shares this
    // nav, so the whole batch is a single page load. On a verify challenge here,
    // abort the batch (the rows stay pending and flush after the cool-down).
    if (!await this._ensureOnProductList() && this._isVerifyPage()) {
      this._flagVerification('product list');
      return items.map(it => ({ ...it, ok: false, transient: true }));
    }

    const out = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      // Items skipped after a mid-batch verify challenge stay pending (the daemon
      // requeues them via its `challenged` branch); flag transient as a fallback.
      if (this.verificationRequired) { out.push({ ...it, ok: false, transient: true }); continue; }
      let r = { ok: false, transient: true };
      try {
        r = await this.updateStock(it.targetCn, it.targetEn, it.newQty, it.sku);
      } catch (e) {
        this._log(`batch item failed: ${String(e.message).slice(0, 80)}`);
        r = { ok: false, transient: true }; // a thrown error is an automation hiccup → retry
      }
      out.push({ ...it, ok: !!r.ok, transient: !r.ok && !!r.transient });
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

  // Re-persist the live session's cookies to disk. Meituan rotates session
  // cookies during use, so the snapshot captured at login time goes stale; a
  // crash (which skips close()) would then restore expired cookies on the next
  // start and force a fresh login — the riskiest event (it's what trips 验证中心).
  // Calling this periodically while logged in keeps the on-disk session fresh so
  // a restart, graceful OR crashed, restores recent cookies and skips re-login.
  // No-op unless authenticated, so it never clobbers a good file with a
  // logged-out snapshot. Returns true when it actually wrote.
  async persistSession() {
    if (!this._loggedIn || !this.context) return false;
    try { await this._saveSession(); return true; } catch (e) { return false; }
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
const lastLaunchAt = {}; // storeCode → epochMs of last full (re)launch

// Don't spin up a fresh Chromium more than once per minute. If a page reliably
// crashes the renderer, naive rebuild-every-cycle would thrash the box launching
// heavy headful Chromes every 10s; this bounds it to one relaunch/min while still
// recovering quickly from a one-off crash.
const RELAUNCH_COOLDOWN_MS = 60_000;

async function getBrowser(storeCode) {
  const existing = instances[storeCode];
  // Reuse only a live browser whose proxy still matches the watchdog's choice.
  if (existing && existing.isAlive() && existing._proxyRaw === activeProxyRaw(storeCode)) return existing;

  // Otherwise tear it down and relaunch. Two triggers:
  //   • dead (renderer crash / browser disconnect) — self-heal instead of looping
  //     forever on a closed page; closing also reaps the orphaned Chromium.
  //   • the failover watchdog switched the active proxy — apply the new exit IP.
  if (existing) {
    const proxyChanged = existing.isAlive() && existing._proxyRaw !== activeProxyRaw(storeCode);
    const now = Date.now();
    // Throttle CRASH relaunches (renderer-thrash guard); a deliberate proxy switch
    // bypasses the cooldown so failover takes effect promptly.
    if (!proxyChanged && lastLaunchAt[storeCode] && now - lastLaunchAt[storeCode] < RELAUNCH_COOLDOWN_MS) {
      throw new Error('meituan browser relaunch cooling down (renderer recently crashed) — will retry shortly');
    }
    console.log(`[meituan:${storeCode}] ${proxyChanged
      ? `proxy switched (${existing._proxyRaw || 'direct'} → ${activeProxyRaw(storeCode) || 'direct'}) — relaunching`
      : 'browser not alive (crash/disconnect) — relaunching from saved session'}`);
    try { await existing.close(); } catch {}
    delete instances[storeCode];
  }

  lastLaunchAt[storeCode] = Date.now();
  const b = new MeituanBrowser(storeCode);
  await b.init();
  instances[storeCode] = b;
  return b;
}

async function closeAll() {
  for (const b of Object.values(instances)) await b.close();
  for (const k of Object.keys(instances)) delete instances[k];
}

module.exports = { MeituanBrowser, getBrowser, closeAll, fingerprintInitScript };
