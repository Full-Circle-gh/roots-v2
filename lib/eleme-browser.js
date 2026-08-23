/* global fetch */
// Playwright browser automation for the Eleme (饿了么) Napos merchant backend.
//
// Twin of lib/meituan-browser.js — same session-persist / anti-fingerprint / proxy
// machinery — but the merchant UI is cross-origin FaaS micro-frontends calling one
// JSON-RPC gateway (app-api.shop.ele.me, the "ncp" envelope) instead of Meituan's
// per-feature REST APIs. Eleme's official OpenAPI rejects our single-store
// accounts ("暂不支持该账户登录" — see ELEME_BROWSER_RECON.md), so this replaces
// lib/eleme-client.js (OAuth, now dead) the same way meituan-browser.js replaced
// nothing — it was always the only option for 外卖.
//
// The RPC contract here is reverse-engineered from a single live network capture
// (2026-08-23, shop 1304930646) — see ELEME_BROWSER_RECON.md for the raw capture
// and the parts of the contract that are still guesses (marked below). STOCK push
// (FoodService2.updateFoodStock) is the one call captured payload-and-response, so
// it's the one this file trusts fully; everything upstream of it (category/food
// listing) is shape-agnostic on purpose, so an unguessed field name degrades to
// "found nothing" instead of a crash.
//
// Orders are NOT wired yet — the RPC method names are known but no live order was
// captured, so the payload/response shapes are unknown. getPendingOrders/
// acceptOrder are stubs; wire them once an order lands (see the comment there).

const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');
const { browserEnv } = require('./browser-env');
// The Tier-2 anti-fingerprint init script is a generic "coherent Windows Chrome"
// spoof with nothing Meituan-specific in it — reuse it rather than duplicate
// ~140 lines of navigator/WebGL/plugin shimming.
const { fingerprintInitScript } = require('./meituan-browser');

const SESSION_DIR  = path.join(__dirname, '../data/eleme-sessions');
const MERCHANT_URL = 'https://melody.shop.ele.me';
const GOODS_URL    = 'https://napos-goods-pc.faas.ele.me/single/goods-manage';
const API_HOST     = 'app-api.shop.ele.me';

let playwright;
function getPlaywright() {
  if (!playwright) playwright = require('playwright');
  return playwright;
}

// Proxy resolution — same shape as meituan-browser's resolveProxy, namespaced
// ELEME_*, but it defaults to the SAME active-proxy decision the store's Meituan
// channel already elected (proxy-manager's state file is keyed by storeCode) so
// every channel for a given store rides one coherent exit IP — the anti-
// fingerprint story the recon build plan calls for ("same residential-proxy +
// fingerprint treatment as Meituan Tianhe").
function activeProxyRaw(storeCode) {
  try {
    const active = require('./proxy-manager').readActive(storeCode);
    if (active !== undefined) return active; // '' is a valid value (direct)
  } catch (_) { /* manager optional — fall through to env */ }
  return (storeCode && process.env[`ELEME_PROXY_${String(storeCode).toUpperCase()}`])
    || process.env.ELEME_PROXY_URL || '';
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
    console.error(`[eleme] ignoring malformed proxy URL: ${e.message}`);
    return null;
  }
}

class ElemeBrowser {
  constructor(storeCode, shopId) {
    this.storeCode = storeCode;
    this.shopId    = shopId != null ? String(shopId) : '';
    this.sessionFile = path.join(SESSION_DIR, `${storeCode}-session.json`);
    this.browser = null;
    this.context = null;
    this.page    = null;
    this._loggedIn = false;
    // Set when Eleme redirects to its Alibaba risk-control challenge (isaac.ele.me
    // / ynuf.aliapp.org, seen at login per the recon). Mirrors meituan-browser's
    // verificationRequired so callers back off instead of hammering it.
    this.verificationRequired = false;
    // The auth credential every RPC call needs (metas.ksid) — captured passively
    // off the page's OWN traffic (see the context 'request' listener in init()),
    // not guessed from a cookie/localStorage key that could change out from under
    // us. Session cookies ride along automatically; ksid does not persist across
    // a restart the way cookies do, so it's re-captured fresh every init().
    this._ksid = null;
    // name -> { itemGlobalId, skus:[{...captured sku fields incl. stock}] }.
    // Populated a whole-catalogue pass at a time (see _loadFoodCatalogue) since
    // Eleme's stock RPC is scoped per food-group, not searchable by name.
    this._foodCache = new Map();
  }

  _isVerifyPage() {
    try { return /isaac\.ele\.me|ynuf\.aliapp\.org|\/verify/i.test(this.page.url()); }
    catch (e) { return false; }
  }
  _flagVerification(where) {
    this.verificationRequired = true;
    this._log(`⚠️ verification required (risk control) at ${where} — a human must pass the challenge; sync paused for this store`);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async init(opts = {}) {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    const { chromium } = getPlaywright();

    const useSession = !opts.ignoreSession && fs.existsSync(this.sessionFile);
    const storageState = useSession
      ? JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'))
      : undefined;

    const displayAvailable = process.platform === 'win32' || !!process.env.DISPLAY;
    const headfulRequested = process.env.ELEME_HEADFUL === '1';
    const goHeadful = headfulRequested && displayAvailable;
    const headless = opts.headed ? false : (useSession ? !goHeadful : false);
    if (useSession && headfulRequested && !displayAvailable) {
      this._log('ELEME_HEADFUL set but no DISPLAY — staying headless (run under xvfb-run, or start Xvfb and set DISPLAY=:99)');
    }
    this._log(!useSession
      ? (opts.ignoreSession ? 'fresh login (existing session kept until new login succeeds)'
                            : 'no session — launching headed for manual login')
      : (headless ? 'restoring session (headless)' : 'restoring session (headful / Xvfb)'));

    const isWindows = process.platform === 'win32';
    const stealthArgs = ['--disable-blink-features=AutomationControlled'];
    const launchOpts = {
      headless,
      env: browserEnv(),
      args: isWindows
        ? [...stealthArgs, '--disable-gpu', '--disable-dev-shm-usage']
        : ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-default-apps', '--disable-breakpad', '--disable-domain-reliability', '--no-pings', '--disk-cache-size=33554432', '--media-cache-size=16777216', '--disable-gpu-shader-disk-cache', ...stealthArgs],
    };
    if (isWindows) {
      const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
      if (fs.existsSync(edgePath)) launchOpts.executablePath = edgePath;
      else launchOpts.channel = 'msedge';
    }

    this._proxyRaw = activeProxyRaw(this.storeCode);
    const proxy = resolveProxy(this.storeCode);
    if (proxy) { launchOpts.proxy = proxy; this._log(`using proxy ${proxy.server}`); }
    else this._log('no proxy configured (direct datacenter IP)');

    this.browser = await chromium.launch(launchOpts);

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
    await this.context.addInitScript(fingerprintInitScript, { chromeVer, chromeMajor });

    // Capture ksid (+ confirm shopId) straight off the RPC calls the page ITSELF
    // makes while loading — the same "inject a hook, read what fires" trick the
    // recon capture used, rather than guessing where ksid lives client-side (a
    // cookie? localStorage? a JS global? all three are page-implementation
    // details that can change silently; the wire format is the contract).
    // Context-level (not page-level) so it also catches the goods-manage
    // standalone tab and any iframe, regardless of which one fires first.
    this.context.on('request', (req) => {
      try {
        if (req.method() !== 'POST') return;
        if (!req.url().includes(API_HOST)) return;
        const body = req.postData();
        if (!body) return;
        let json; try { json = JSON.parse(body); } catch (e) { return; }
        const metas = json && json.metas;
        if (metas && metas.ksid) {
          if (this._ksid !== metas.ksid) this._log('captured ksid from live traffic');
          this._ksid = metas.ksid;
        }
        if (metas && metas.shopId && !this.shopId) this.shopId = String(metas.shopId);
      } catch (e) {}
    });

    this.page = await this.context.newPage();
  }

  _shellUrl() {
    return this.shopId ? `${MERCHANT_URL}/app/shop/${this.shopId}` : MERCHANT_URL;
  }

  async _waitForKsid(maxMs) {
    const deadline = Date.now() + maxMs;
    while (!this._ksid && Date.now() < deadline) {
      await this.page.waitForTimeout(300);
    }
    return !!this._ksid;
  }

  async ensureLoggedIn() {
    if (this._loggedIn && this._ksid) return true;

    // A proxy/network outage makes this goto time out. That is NOT a logout —
    // surface it as such so callers don't trigger a pointless re-login.
    try {
      await this.page.goto(this._shellUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      this._log(`merchant page unreachable (${String(e.message).split('\n')[0].slice(0, 60)}) — proxy/network down, NOT a logout`);
      return false;
    }
    await this._humanPause(2500, 4200);

    if (this._isVerifyPage()) { this._flagVerification('login'); return false; }

    // The shell's own widgets fire RPCs on load, so a real logged-in session
    // hands us a ksid within a few seconds. URL alone is not proof (a logged-out
    // session can flash the shop URL before redirecting to login — same false-
    // positive meituan-browser guards against).
    const onShop = (u) => this.shopId ? u.includes(`/shop/${this.shopId}`) : /\/shop\/\d+/.test(u);
    if (onShop(this.page.url()) && await this._waitForKsid(8000)) {
      this._loggedIn = true;
      await this._saveSession();
      this._log('login confirmed (ksid captured)');
      return true;
    }

    // Not logged in: if there's no saved session yet, wait for a human to log in.
    const hasSession = fs.existsSync(this.sessionFile);
    if (!hasSession) {
      this._log('waiting for manual login (up to 3 min)...');
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        await this.page.waitForTimeout(2500);
        if (this._isVerifyPage()) continue;
        if (onShop(this.page.url()) && await this._waitForKsid(4000)) {
          this._loggedIn = true;
          await this._saveSession();
          this._log('manual login successful — session saved');
          return true;
        }
      }
      this._log('login timeout');
      return false;
    }

    this._log('session expired — delete session file and re-run in headed mode');
    return false;
  }

  // Interactive headed login for the standalone eleme-login helper (scripts/
  // eleme-login.js). Unlike ensureLoggedIn (which bails the moment it sees a
  // challenge so the daemon doesn't hang), this keeps the window open and polls,
  // letting a human clear it. Only succeeds once ksid has actually been captured.
  async interactiveLogin(maxMs = 360000) {
    const onShop = (u) => !!u && /\/shop\/\d+/.test(u);
    await this.page.goto(this._shellUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page.waitForTimeout(6000);
    this._log('window open — log in, solve any risk-control challenge; waiting for the shop dashboard…');

    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      try {
        await this.page.waitForTimeout(2500);
        if (this._isVerifyPage()) continue;
        if (!onShop(this.page.url())) continue;
        if (!this._ksid) continue;
        this._loggedIn = true;
        await this._saveSession();
        this._log('login successful — session saved');
        return true;
      } catch (e) {
        const msg = String(e.message || '');
        if (/crash|has been closed|Target (page|closed)/i.test(msg)) {
          this._log(`recovering from page crash: ${msg.slice(0, 50)}`);
          try {
            this.page = await this.context.newPage();
            await this.page.goto(this._shellUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 });
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

  isAlive() {
    try {
      if (!this.browser || !this.browser.isConnected()) return false;
      if (!this.page || this.page.isClosed()) return false;
      return true;
    } catch { return false; }
  }

  // Public read of session state (callers alert on this transitioning, same as
  // verificationRequired) — _loggedIn stays the internal field so init()/close()
  // can reset it freely without touching a public contract.
  get loggedIn() { return this._loggedIn; }

  // The goods-manage micro-frontend runs standalone in a top-level tab once the
  // shared .ele.me cookies are set (confirmed live — this is how the recon
  // capture was taken), and it's the origin our own fetch() calls need to run
  // from for the RPC gateway to accept them the same way it accepts the real UI.
  async _ensureOnGoodsManage() {
    try {
      if (!this.page.url().startsWith(GOODS_URL)) {
        await this.page.goto(GOODS_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await this._humanPause(2000, 3500);
      }
      if (this._isVerifyPage()) { this._flagVerification('goods-manage'); return false; }
      return true;
    } catch (e) {
      this._log(`goods-manage nav failed: ${String(e.message).slice(0, 80)}`);
      return false;
    }
  }

  // ── RPC ("ncp" envelope) ─────────────────────────────────────────────────

  // One JSON-RPC call to app-api.shop.ele.me, issued as an in-page fetch so the
  // shared .ele.me session cookies ride along (no request signing observed).
  // `id` IS validated server-side (confirmed live 2026-08-23 — a made-up short
  // token gets ILLEGAL_REQUEST/"requestId is invalid", and reusing one id across
  // calls gets an internal SERVER_ERROR, presumably an idempotency/dedup check).
  // Live traffic shows every one of the page's own calls uses a FRESH random
  // 32-char uppercase-hex token (a UUIDv4 with the dashes stripped) + "|" +
  // epoch-ms — match that exactly, one per call.
  async _rpc(path, service, rpcMethod, request) {
    if (!this._ksid) return { ok: false, transient: true, reason: 'no ksid captured yet' };
    const reqId = crypto.randomUUID().replace(/-/g, '').toUpperCase();
    const body = {
      id: `${reqId}|${Date.now()}`,
      service, method: rpcMethod,
      params: { request },
      metas: { appName: 'melody', appVersion: '4.4.0', ksid: this._ksid, shopId: Number(this.shopId) },
      ncp: '2.0.0', adapter: 'ncp',
    };
    const url = `https://${API_HOST}/${path}/?method=${service}.${rpcMethod}`;
    let res;
    try {
      res = await this.page.evaluate(async ({ url, body }) => {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });
        let j = null; try { j = await r.json(); } catch (e) {}
        return { status: r.status, json: j };
      }, { url, body });
    } catch (e) {
      return { ok: false, transient: true, reason: `fetch error: ${String(e.message).slice(0, 100)}` };
    }
    if (!res || res.status !== 200 || !res.json) {
      return { ok: false, transient: true, reason: `HTTP ${res && res.status}` };
    }
    // Envelope stays HTTP 200 on a business error; the error lives in .error.
    if (res.json.error) {
      return { ok: false, transient: false, reason: JSON.stringify(res.json.error).slice(0, 200) };
    }
    return { ok: true, result: res.json.result };
  }

  // The food object's sku-array field name is "specs" (confirmed live capture,
  // 2026-08-23) — found structurally rather than hardcoded anyway (the first
  // array property whose items carry `stock` plus a skuGlobalId/specGlobalId),
  // the same defensive technique lib/meituan-browser.js uses (_extractSku) for
  // its own shape gaps, in case a future response nests it differently. Keeps
  // every original field, since updateFoodStock wants the sku object handed
  // back close to how it read.
  _skusFromFood(food) {
    if (!food || typeof food !== 'object') return [];
    for (const v of Object.values(food)) {
      if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' &&
          'stock' in v[0] && (('skuGlobalId' in v[0]) || ('specGlobalId' in v[0]))) {
        return v.map(s => ({ ...s }));
      }
    }
    return [];
  }

  // Foods embedded directly in a queryCategoryWithFoodFilter category (see
  // below) — harvest them straight from that response instead of a second
  // round-trip. Returns the set of groupGlobalIds that were fully covered this
  // way, so the caller knows which groups still need their own fetch.
  _harvestEmbeddedFoods(categories) {
    const handled = new Set();
    if (!Array.isArray(categories)) return handled;
    for (const cat of categories) {
      if (!cat || !cat.groupGlobalId || !Array.isArray(cat.foodList)) continue;
      handled.add(String(cat.groupGlobalId));
      for (const food of cat.foodList) {
        const name = String(food.name || '').trim();
        if (!name) continue;
        const skus = this._skusFromFood(food);
        if (skus.length) this._foodCache.set(name, { itemGlobalId: food.itemGlobalId, skus });
      }
    }
    return handled;
  }

  // Populate _foodCache with every food in every group — one full pass per
  // session (foods rarely get renamed), so the FIRST push of a run pays for the
  // whole catalogue and every push after it is a cache hit.
  //
  // FoodService2.queryCategoryWithFoodFilter lists every category with its
  // groupGlobalId + foodCount, and (with withFoods:true) embeds the food list
  // for at least the first/currently-open category — the merchant UI evidently
  // lazy-loads the rest as you scroll, so any category whose foodList comes back
  // null needs its own queryFoodsByGroupGlobalId call (the one call the recon
  // fully captured payload-and-response for).
  async _loadFoodCatalogue() {
    const r = await this._rpc('nevermore.goods/invoke', 'FoodService2', 'queryCategoryWithFoodFilter', {
      shopId: Number(this.shopId), foodQueryFilter: 'ALL', withFoods: true, withPackageUpgradeTag: true,
    });
    if (!r.ok) { this._log(`category listing failed: ${r.reason}`); return false; }
    const categories = Array.isArray(r.result) ? r.result : [];
    if (!categories.length) { this._log('no food groups found — category RPC returned nothing usable'); return false; }

    const handled = this._harvestEmbeddedFoods(categories);
    const remaining = categories.filter(c => c && c.groupGlobalId && !handled.has(String(c.groupGlobalId)));
    for (const cat of remaining) {
      const groupGlobalId = String(cat.groupGlobalId);
      // shopId is a STRING here per the recon capture — confirmed footgun: this
      // sibling call in the SAME service wants shopId as a NUMBER (see
      // _apiUpdateFoodStock and the queryCategoryWithFoodFilter call above).
      const rr = await this._rpc('nevermore.goods/invoke', 'FoodService2', 'queryFoodsByGroupGlobalId',
        { shopId: String(this.shopId), groupGlobalId, withPackageUpgradeTag: true });
      if (!rr.ok) { this._log(`group ${groupGlobalId} (${cat.name || ''}) fetch failed: ${rr.reason}`); continue; }
      const foods = (rr.result && rr.result.foods) || [];
      for (const food of foods) {
        const name = String(food.name || '').trim();
        if (!name) continue;
        const skus = this._skusFromFood(food);
        if (skus.length) this._foodCache.set(name, { itemGlobalId: food.itemGlobalId, skus });
      }
      await this._humanPause(200, 500);
    }
    this._log(`food catalogue loaded: ${this._foodCache.size} item(s) across ${categories.length} group(s)`);
    return this._foodCache.size > 0;
  }

  // A captured food name matches the mapped name on an exact hit, or either
  // containing the other (loose fallback — same spirit as meituan-browser's
  // _nameMatches, simpler because Eleme gives no separate EN name field to try).
  _findByFuzzyName(name) {
    for (const [k, v] of this._foodCache) {
      if (k === name || k.includes(name) || name.includes(k)) return v;
    }
    return null;
  }

  // ── Stock push ────────────────────────────────────────────────────────────

  // Push one product's stock to Eleme by name (our Eleme items carry no extCode —
  // see the ELEME_BROWSER_RECON.md footgun — so name is the only matching key
  // until a one-time 货号-backfill pass changes that). `sku` (our own 货号) is
  // accepted for interface parity with meituan-browser.updateStock but unused
  // until per-spec extCode matching is wired.
  //
  // `specGlobalId` is the operator's answer to "which size inside this listing"
  // (eleme_product_map.spec_id, chosen in the admin against the cached specs).
  // When set it is the WHOLE match — one size gets the number and nothing else
  // is touched, so two Roots size-variants can share one Eleme listing without
  // overwriting each other.
  async updateStock(productNameCn, productNameEn, newQty, sku, specGlobalId) {
    if (!await this.ensureLoggedIn()) return { ok: false, transient: true };
    if (!await this._ensureOnGoodsManage()) return { ok: false, transient: true };
    if (!await this._waitForKsid(8000)) return { ok: false, transient: true };

    const name = String(productNameCn || productNameEn || '').trim();
    if (!name) return { ok: false, transient: false };

    let entry = this._foodCache.get(name);
    if (!entry) {
      if (!this._foodCache.size) await this._loadFoodCatalogue();
      entry = this._foodCache.get(name) || this._findByFuzzyName(name);
    }
    if (!entry) { this._log(`product not found on Eleme: ${name}`); return { ok: false, transient: true }; }

    return this._applyStockRule(entry, newQty, name, specGlobalId);
  }

  // Three ways to decide which size(s) of a listing get the number, in order:
  //
  //   1. The operator mapped ONE size (specGlobalId) — write only that size.
  //      This is the accurate path and the only one that lets two Roots
  //      size-variants share one Eleme listing.
  //   2. The listing has exactly one size — unambiguous, write it.
  //   3. Neither — fall back to the wraps/soups rule below. It is a GUESS: the
  //      number it writes is not this product's real stock. Kept because real
  //      wraps/soups (a main size plus add-on sizes, all fed by one Roots
  //      product) genuinely need it, but for a size-variant group it fabricates
  //      stock, so it now says so in the log.
  //
  // A mapped size that is no longer on the listing is a terminal config error,
  // NOT a reason to fall through to the guess — falling through is exactly the
  // behaviour this mapping exists to stop.
  async _applyStockRule(entry, newQty, label, specGlobalId) {
    const skus = entry.skus || [];
    if (!skus.length) return { ok: false, transient: true };

    const want = specGlobalId == null ? '' : String(specGlobalId).trim();
    if (want) {
      const hit = skus.find(sk => String(sk.specGlobalId || sk.skuGlobalId || '') === want);
      if (hit) {
        const sizeName = hit.name || want;
        return this._apiUpdateFoodStock(entry.itemGlobalId, hit, newQty, `${label} [${sizeName}]`);
      }
      this._log(`mapped size ${want} is no longer on "${label}" (sizes: ${skus.map(sk => `${sk.name || '?'}:${sk.specGlobalId}`).join(' | ')}) — not guessing`);
      return { ok: false, transient: false };
    }

    if (skus.length === 1) {
      return this._apiUpdateFoodStock(entry.itemGlobalId, skus[0], newQty, label);
    }
    const N = Number(newQty);
    const BIG = 9999;
    const targets = skus.map((_, i) => (N >= 3) ? BIG : (i === 0 ? N : 0));
    const results = [];
    for (let i = 0; i < skus.length; i++) {
      results.push(await this._apiUpdateFoodStock(entry.itemGlobalId, skus[i], targets[i], `${label} [sku ${i}]`));
      if (i < skus.length - 1) await this._humanPause(300, 700);
    }
    this._log(`variants set (GUESS — no size mapped): ${label} (Roots N=${N}) → [${targets.join(', ')}]`);
    const ok = results.every(r => r.ok);
    const transient = !ok && results.some(r => !r.ok && r.transient);
    return { ok, transient };
  }

  // Set one sku's stock via FoodService2.updateFoodStock. The captured payload
  // (ELEME_BROWSER_RECON.md) reflects the sku object straight back with only
  // `stock` changed — but the READ shape (foods[].*) wasn't captured field-for-
  // field, so default anything it might not carry rather than send `undefined`
  // for a field Eleme requires.
  //
  // Footgun (from the recon captures): shopId is a STRING in the read call
  // (queryFoodsByGroupGlobalId) but a bare NUMBER in this write call — matched
  // literally rather than "fixed" to be consistent.
  //
  // Footgun #2 (confirmed live 2026-08-23): a real read (queryCategoryWithFood
  // Filter's embedded foodList) carries `specGlobalId` on the spec object but NO
  // `skuGlobalId` field at all — recon's captured write payload showed both set
  // to the SAME value, so default skuGlobalId from specGlobalId rather than
  // sending `undefined` for a field the write requires.
  async _apiUpdateFoodStock(itemGlobalId, sku, newQty, label) {
    const foodSkuStock = {
      id: sku.id, foodId: sku.foodId != null ? sku.foodId : sku.id,
      skuGlobalId: sku.skuGlobalId || sku.specGlobalId, specGlobalId: sku.specGlobalId || sku.skuGlobalId,
      price: sku.price, stock: Number(newQty),
      maxStock: sku.maxStock != null ? sku.maxStock : 10000,
      stockStatus: sku.stockStatus != null ? sku.stockStatus : 0,
      stockType: sku.stockType != null ? sku.stockType : 0,
      packageFee: sku.packageFee != null ? sku.packageFee : 0,
      packageShare: sku.packageShare != null ? sku.packageShare : 1,
      extCode: sku.extCode != null ? sku.extCode : '',
      name: sku.name != null ? sku.name : '',
      pid: sku.pid != null ? sku.pid : '',
      canEditPrice: sku.canEditPrice != null ? sku.canEditPrice : true,
    };
    const r = await this._rpc('nevermore.goods/invoke', 'FoodService2', 'updateFoodStock', {
      shopId: Number(this.shopId),
      itemGlobalId,
      foodSkuStocks: [foodSkuStock],
    });
    if (r.ok) { this._log(`stock updated: ${label} → ${newQty}`); return { ok: true, transient: false }; }
    this._log(`stock push failed for ${label}: ${r.reason}`);
    return { ok: false, transient: r.transient };
  }

  // Batch update: push multiple products in ONE goods-manage visit (one catalogue
  // load), mirroring meituan-browser.batchUpdateStock. items = [{ targetCn,
  // targetEn, newQty, sku, ...passthrough }]. Returns the input items each
  // augmented with { ok, transient }.
  async batchUpdateStock(items) {
    if (!items || !items.length) return [];
    if (!await this.ensureLoggedIn()) return items.map(it => ({ ...it, ok: false, transient: true }));
    if (!await this._ensureOnGoodsManage()) return items.map(it => ({ ...it, ok: false, transient: true }));
    if (!await this._waitForKsid(8000)) return items.map(it => ({ ...it, ok: false, transient: true }));
    if (!this._foodCache.size) await this._loadFoodCatalogue();

    const out = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (this.verificationRequired) { out.push({ ...it, ok: false, transient: true }); continue; }
      let r;
      try {
        r = await this.updateStock(it.targetCn, it.targetEn, it.newQty, it.sku, it.specGlobalId);
      } catch (e) {
        this._log(`batch item failed: ${String(e.message).slice(0, 80)}`);
        r = { ok: false, transient: true };
      }
      out.push({ ...it, ok: !!r.ok, transient: !r.ok && !!r.transient });
      if (i < items.length - 1) await this._humanPause(400, 1000);
    }
    const okN = out.filter(r => r.ok).length;
    this._log(`batchUpdateStock: ${okN} ok, ${out.length - okN} fail`);
    return out;
  }

  // Diagnostic: every food name currently on Eleme (admin tooling / sanity checks).
  async listFoods() {
    if (!await this.ensureLoggedIn()) return null;
    if (!await this._ensureOnGoodsManage()) return null;
    if (!await this._waitForKsid(8000)) return null;
    await this._loadFoodCatalogue();
    return Array.from(this._foodCache.keys());
  }

  // Read-only snapshot of the currently-cached catalogue — no network call,
  // just what listFoods()/updateStock() already loaded into _foodCache this
  // session. Used by the daemon to write eleme_catalogue_cache (the admin
  // UI's autocomplete source), so call listFoods() first if you need it fresh.
  catalogueSnapshot() {
    const out = [];
    for (const [name, entry] of this._foodCache) {
      const skus = entry.skus || [];
      const sku = skus[0] || {};
      out.push({
        name,
        itemGlobalId: entry.itemGlobalId || null,
        stock: sku.stock != null ? sku.stock : null,
        // Every size behind this one name. The admin needs these to offer the
        // "which size" picker; `name` can be blank on a single-size listing, so
        // price/stock ride along to keep the options tellable apart.
        specs: skus.map(sk => ({
          specGlobalId: String(sk.specGlobalId || sk.skuGlobalId || ''),
          name: sk.name || '',
          price: sk.price != null ? sk.price : null,
          stock: sk.stock != null ? sk.stock : null,
        })).filter(sp => sp.specGlobalId),
      });
    }
    return out;
  }

  // ── Orders — NOT WIRED YET ───────────────────────────────────────────────
  // Method names are known (OrderWebService.queryInProcessOrders,
  // PollingService.unprocessedOrders, etc — see ELEME_BROWSER_RECON.md) but no
  // live order was captured during recon, so the request/response shapes are
  // unknown. Wire these once an order lands: open napos-order-pc.faas.ele.me
  // standalone (same pattern as _ensureOnGoodsManage), drive the UI or call
  // _rpc() directly, and read what the context 'request'/'response' hooks catch.
  async getPendingOrders() {
    this._log('getPendingOrders: not implemented — needs a live order capture (see ELEME_BROWSER_RECON.md)');
    return [];
  }
  async acceptOrder() {
    this._log('acceptOrder: not implemented — needs a live order capture (see ELEME_BROWSER_RECON.md)');
    return false;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  async _saveSession() {
    if (!this.context) return;
    const state = await this.context.storageState();
    fs.writeFileSync(this.sessionFile, JSON.stringify(state));
  }

  // Re-persist the live session's cookies to disk periodically (see the same
  // rationale in meituan-browser.js — a crash skips close()'s save, and a stale
  // cookie snapshot forces a re-login, the riskiest event for tripping risk-
  // control). No-op unless authenticated.
  async persistSession() {
    if (!this._loggedIn || !this.context) return false;
    try { await this._saveSession(); return true; } catch (e) { return false; }
  }

  _rand(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }
  async _humanPause(min = 600, max = 1600) { await this.page.waitForTimeout(this._rand(min, max)); }

  _log(msg) {
    console.log(`[eleme:${this.storeCode}] ${msg}`);
  }
}

// ── Factory: get or create a browser instance per store ──────────────────────
const instances = {};
const lastLaunchAt = {}; // storeCode → epochMs of last full (re)launch

// Don't spin up a fresh Chromium more than once per minute (see meituan-browser's
// identical guard — the same renderer-thrash concern applies here).
const RELAUNCH_COOLDOWN_MS = 60_000;

async function getBrowser(storeCode, shopId) {
  const existing = instances[storeCode];
  if (existing && existing.isAlive() && existing._proxyRaw === activeProxyRaw(storeCode)) return existing;

  if (existing) {
    const proxyChanged = existing.isAlive() && existing._proxyRaw !== activeProxyRaw(storeCode);
    const now = Date.now();
    if (!proxyChanged && lastLaunchAt[storeCode] && now - lastLaunchAt[storeCode] < RELAUNCH_COOLDOWN_MS) {
      throw new Error('eleme browser relaunch cooling down (renderer recently crashed) — will retry shortly');
    }
    console.log(`[eleme:${storeCode}] ${proxyChanged
      ? `proxy switched (${existing._proxyRaw || 'direct'} → ${activeProxyRaw(storeCode) || 'direct'}) — relaunching`
      : 'browser not alive (crash/disconnect) — relaunching from saved session'}`);
    try { await existing.close(); } catch {}
    delete instances[storeCode];
  }

  lastLaunchAt[storeCode] = Date.now();
  const b = new ElemeBrowser(storeCode, shopId);
  await b.init();
  instances[storeCode] = b;
  return b;
}

async function closeAll() {
  for (const b of Object.values(instances)) await b.close();
  for (const k of Object.keys(instances)) delete instances[k];
}

module.exports = { ElemeBrowser, getBrowser, closeAll };
