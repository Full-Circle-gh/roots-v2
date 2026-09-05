const express = require('express');
// STEP ZERO of the async conversion (decisions §24). Patches Express so a route
// handler that returns a rejected promise reaches the global error handler at
// the bottom of this file instead of hanging the request forever. MUST be
// required before any routes/* module, because those register their handlers at
// require time and the guard wraps handlers as they are registered. It is a
// no-op while every handler is synchronous, which is the case today.
require('./lib/express-async-guard');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

// ── Tiny .env loader ─────────────────────────────────────────────────
// Loads /root/roots-v2/.env into process.env so we don't need a dotenv
// dep. Format: KEY=value per line, # comments allowed, blank lines OK.
// Existing process.env vars take precedence (so pm2's --update-env still
// works as expected). Used for ANTHROPIC_API_KEY and any future secrets.
// Extracted to lib/load-env.js so the scripts can parse the same file the
// same way (GAP G27). Behaviour here is unchanged: same format, same
// precedence, same swallow-and-warn. The report is ignored on purpose --
// the server has always started without a .env and must keep doing so.
require('./lib/load-env').loadEnv();

// Ensure data directory exists
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Last-line crash guards ───────────────────────────────────────────
// Historically this process had NO uncaughtException/unhandledRejection
// handlers and NO global Express error middleware. On Node 18+ an
// unhandled promise rejection TERMINATES the process by default — so a
// single async route handler that rejected without an internal try/catch
// would take the whole storefront down for EVERY user, not just that one
// request. That is the crash→pm2-restart loop the health-watchdog kept
// self-healing (see scripts/health-watchdog.js). These guards do two
// things the old setup couldn't: (1) log a full stack so the NEXT fall is
// diagnosable instead of a silent death, and (2) page ops via the same
// System-Alerts WeCom channel the watchdog uses.
function alertCrash(kind, err) {
  const stack = (err && err.stack) || String(err);
  console.error(`[FATAL] ${kind}:`, stack);
  // Best-effort page. Lazily required so a load-order issue here can never
  // itself crash boot; sendOpsAlert already no-ops when alerts are off.
  try {
    require('./lib/ops-alert')
      .sendOpsAlert(`🔴 roots-v2 ${kind}: ${(err && err.message) || err}. App stayed UP; check logs for the stack.`)
      .catch(() => {});
  } catch (_) { /* alerting must never block or throw here */ }
}
// A rejected promise almost never corrupts shared server state, so we log,
// page, and KEEP SERVING — this is what actually stops the falls: one bad
// request no longer kills the box for everyone.
process.on('unhandledRejection', (reason) => {
  alertCrash('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
});
// An uncaughtException can leave the process in an undefined state, so we
// still exit and let pm2 restart — but now with a logged stack + a page,
// instead of dying dark the way the pre-guard process did.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException — exiting for a clean pm2 restart:', err && err.stack);
  try {
    require('./lib/ops-alert')
      .sendOpsAlert(`🔴 roots-v2 uncaughtException: ${(err && err.message) || err} — restarting.`)
      .catch(() => {});
  } catch (_) { /* ignore */ }
  // Give the async page ~1s to flush, then exit non-zero so pm2 restarts us.
  setTimeout(() => process.exit(1), 1000).unref?.();
});

const app = express();

// Trust the first reverse proxy in front of us (nginx terminates TLS and
// forwards over plain HTTP on localhost:4000). Without this, req.secure is
// always false and "secure: true" cookies would never be set, breaking login.
// Also makes req.ip return the real client IP from X-Forwarded-For.
app.set('trust proxy', 1);

// Security headers. CSP/COEP are intentionally OFF — existing pages use
// inline scripts and the mini app loads images cross-origin via wx.previewImage.
// Tighten later by moving inline scripts to files and reviewing CORS surfaces.
//
// Referrer-Policy: helmet defaults to `no-referrer`, which strips the Referer
// from EVERY cross-origin request — including the Amap Maps JS-SDK tile/style
// calls on the web storefront's checkout map picker. Amap's domain whitelist is
// referer-based, so a stripped referer returns INVALID_USER_DOMAIN and the map
// renders blank in all browsers. `strict-origin-when-cross-origin` (the modern
// browser default) sends only the origin (scheme+host, no path/query) to secure
// cross-origin destinations, so the whitelist matches while leaking no page
// paths. Same-origin requests still get the full referer; downgrades send none.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Response compression (zero-dependency) ───────────────────────────
// nginx in front does NOT gzip our API responses, so JSON payloads ship
// uncompressed — the storefront/mini-app catalogue pull alone was >1 MB on the
// wire, and rich-HTML/JSON compresses ~85%. We wrap res.json ONLY: the binary
// image-streaming routes use res.send(buffer) and stay untouched (already-
// compressed JPEG/PNG must never be re-gzipped). The 1 KB floor skips tiny
// bodies (error payloads, counts) where the gzip header costs more than it
// saves. Adding the `compression` npm package would need a manual server-side
// `npm install` (the auto-deploy doesn't install deps), so we use built-in zlib.
app.use((req, res, next) => {
  if (!/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return next();
  const origJson = res.json.bind(res);
  res.json = (body) => {
    let str;
    try { str = JSON.stringify(body); } catch { return origJson(body); }
    if (!str || Buffer.byteLength(str) < 1024) return origJson(body);
    let gz;
    try { gz = zlib.gzipSync(str); } catch { return origJson(body); }
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.removeHeader('Content-Length');
    res.setHeader('Content-Length', gz.length);
    return res.end(gz);
  };
  next();
});

// Session secret. If unset OR equal to the historical hardcoded literal that
// shipped before the fix, fall back to a process-lifetime random key so an
// attacker who reads the source cannot forge cookies. The cost is that all
// sessions reset on every pm2 restart until a stable secret is in .env.
let SESSION_SECRET = process.env.SESSION_SECRET;
const LEAKED_DEFAULT = 'roots-v2-guangzhou-2026';
if (!SESSION_SECRET || SESSION_SECRET === LEAKED_DEFAULT) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.error('[security] SESSION_SECRET is missing or set to the publicly-known default.');
  console.error('[security] Using a temporary random secret — all sessions will reset on next restart.');
  console.error('[security] Fix: SESSION_SECRET=$(openssl rand -hex 32) appended to .env, then pm2 restart roots-v2.');
}

// Sessions — secure cookies in production (HTTPS), plain cookies in dev.
// "auto" lets Express decide based on req.secure (works correctly because
// trust proxy is set above).
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: DATA_DIR }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto'
  }
}));

// ── Canonical host ──────────────────────────────────────────────────────────
// The kitchen app lives only at food.rootskitchenchina.com. The bare domain,
// www, and the legacy app.* host bounce human page requests there.
// We deliberately DON'T redirect machine traffic that can't follow a 302 and is
// pinned to rootskitchenchina.com: WeChat/Alipay payment callbacks + the native
// mini-program's API base (/api/*), its brand fonts loaded via downloadFile
// (/assets/*), the in-WeChat web-view tracking page (/track…), and the ACME
// renewal challenge (/.well-known/*). store.* is untouched (own subdomain).
const KITCHEN_HOST = 'food.rootskitchenchina.com';
const LEGACY_KITCHEN_HOSTS = new Set([
  'rootskitchenchina.com',
  'www.rootskitchenchina.com',
  'app.rootskitchenchina.com',
]);
app.use((req, res, next) => {
  if (!LEGACY_KITCHEN_HOSTS.has((req.hostname || '').toLowerCase())) return next();
  const p = req.path;
  if (p.startsWith('/api/') || p.startsWith('/assets/') ||
      p.startsWith('/track') || p.startsWith('/.well-known/')) return next();
  return res.redirect(302, 'https://' + KITCHEN_HOST + req.originalUrl);
});

// Static files
app.use('/assets', express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // iOS WeChat's wx.loadFontFace rejects responses with content-type
    // font/otf or font/ttf; application/octet-stream is the universal accept.
    if (filePath.endsWith('.otf') || filePath.endsWith('.ttf') || filePath.endsWith('.woff') || filePath.endsWith('.woff2')) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    }
  },
}));

// The shared cost derivation (lib/ingredient-cost.js), served to the ingredient
// form so the browser and the server compute a cost the same way.
//
// NOT under /assets on purpose: that path is stale-while-revalidate in the
// service worker, so a phone could keep running an old copy of the formula for
// days after a deploy. Money maths must never be stale, so this is sent
// no-store and sw.js skips it too. Read per request rather than at boot so the
// bytes always match the file on disk.
app.get('/lib/ingredient-cost.js', (req, res) => {
  fs.readFile(path.join(__dirname, 'lib', 'ingredient-cost.js'), 'utf8', (err, src) => {
    if (err) {
      console.error('[cost helper] could not be read:', err.message);
      return res.status(500).type('text/plain').send('/* cost helper unavailable */');
    }
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.send(src);
  });
});

// The recipe cost breakdown (lib/recipe-cost.js), served to the recipe detail
// card and the Cost Sheet on exactly the same terms as the ingredient helper
// above: read per request so the bytes always match the file on disk, no-store
// so a browser cannot run yesterday's money formula, and skipped by the service
// worker (public/sw.js) so a phone cannot either. The Excel export route
// requires this same file from Node — one file, two runtimes, no second copy.
app.get('/lib/recipe-cost.js', (req, res) => {
  fs.readFile(path.join(__dirname, 'lib', 'recipe-cost.js'), 'utf8', (err, src) => {
    if (err) {
      console.error('[recipe cost helper] could not be read:', err.message);
      return res.status(500).type('text/plain').send('/* recipe cost helper unavailable */');
    }
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.send(src);
  });
});

// PWA assets — must be served from root for the service worker to claim "/" scope
app.get('/sw.js', (req, res) => {
  res.set('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').sendFile(path.join(__dirname, 'public', 'manifest.webmanifest'));
});
// "pos-icon-*" PNGs. The POS shell they were drawn for is gone, but these
// are STILL LIVE — they are the Web Push notification icon and badge for
// the kitchen SPA (public/app.html) and the service worker
// (public/sw.js), and the installed-app icons the counter till's manifest
// points at (public/till-manifest.webmanifest). Do not delete them with the
// POS page. They are generic Tacet artwork despite the name, which is what
// makes them reusable — sw.js:55 says so too.
['pos-icon-192.png','pos-icon-512.png','pos-icon-192-maskable.png','pos-icon-512-maskable.png'].forEach(name => {
  app.get('/' + name, (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(__dirname, 'public', name));
  });
});

// Favicon — browsers request these at the site root. Served from public/.
['favicon.ico','favicon.svg','favicon-32.png','apple-touch-icon.png','tacet-favicon.svg'].forEach(name => {
  app.get('/' + name, (req, res) => {
    res.set('Cache-Control', 'public, max-age=604800');
    res.sendFile(path.join(__dirname, 'public', name));
  });
});

// WeChat 业务域名 verify files. When adding a domain to the AppID's
// 业务域名 whitelist on mp.weixin.qq.com, WeChat hands you a verify
// file that must be reachable at the root path. Names vary:
//   • Legacy: MP_verify_XXXXXXXX.txt
//   • Newer:  short random alphanumeric like `iAvJxgFQsk.txt`
// This route matches either shape and serves it from `public/`.
app.get(/^\/(?:MP_verify_[A-Za-z0-9]+|[A-Za-z0-9]{6,32})\.txt$/, (req, res) => {
  const safeName = req.path.replace(/^\//, '');
  res.type('text/plain').sendFile(path.join(__dirname, 'public', safeName), (err) => {
    if (err) res.status(404).end();
  });
});

// Phase 2 safety gate: until per-tenant data isolation is cut over
// (TENANT_DATA_ISOLATION=1), hold NON-Roots backend tenants out of the shared
// data backend so a freshly-provisioned tenant can never read Roots' data.
// Roots (tenant #1), kitchen users, and the billing/account/signup surfaces
// are unaffected (those are already tenant-scoped or shared by design).
const tenantDb = require('./lib/tenant-db');
const tenantCreds = require('./lib/tenant-creds');   // establish encrypted tenant_secrets table at boot (Platform readiness ①)
app.use((req, res, next) => {
  if (tenantDb.DATA_ISOLATION_READY) return next();
  const tid = req.session?.tenantId;
  if (!req.session?.backendUserId || !tid || tid === tenantDb.ROOTS_TENANT_ID) return next();
  const guarded = req.path === '/retail-admin' || req.path.startsWith('/api/retail-admin') ||
                  req.path.startsWith('/product-editor') || req.path.startsWith('/cms');
  if (!guarded) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Your workspace is being set up · 工作区正在配置中' });
  return res.redirect('/backend/billing?provisioning=1');
});

// API responses must NEVER be cached — not by the browser, a CDN, or an
// intermediary proxy/VPN. A stale cached GET silently breaks the app: a
// cached {user:null} or a stale 401/302 on a polled endpoint bounces a
// logged-in user to /login. (Observed in the field behind a caching VPN.)
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});

// Stock-only lockdown. A backend operator with a RESTRICTED role may use ONLY
// the Quick Stock app — the /stock PWA, its assets, and the stock endpoints it
// calls. Everything else in the backend (the retail-admin shell, /backend/*
// pages, every other API) is blocked here in ONE place, so it can't be reached
// by a stray requireBackend copy that doesn't check the role. Full-access
// sessions skip instantly.
//
// WHICH ROLES ARE RESTRICTED IS DATA, NOT A LITERAL. This used to test
// `role !== 'kitchen' && role !== 'store_stock'`, which is the same rename
// hazard as the dashboard boards and the store pins, and the most dangerous of
// the three: rename "Kitchen" and a stock clerk silently gains the whole
// backend, on every request, with nothing on screen to say so. The answer now
// comes off the role record's stock_app_only flag, through the same
// version-keyed cache as everything else — so this middleware still costs
// exactly ONE query, the tenant_users read below.
//
// That read stays deliberately: role is not in the session (see loadCaller), so
// re-reading it per request is what makes a demotion or a deactivation take
// effect immediately instead of when the cookie expires.
app.use((req, res, next) => {
  if (!req.session?.backendUserId) return next();
  let u;
  try { u = require('./database').prepare('SELECT role, tenant_id FROM tenant_users WHERE id = ? AND is_active = 1').get(req.session.backendUserId); }
  catch (e) { return next(); }   // tables not ready — fail open to existing gates
  if (!u) return next();
  const role = u.role;
  // Fail OPEN on an unreadable record, as every other read in this layer does:
  // an operator who should be locked down and isn't is a bug, but an operator
  // locked out of the app they use all day by a resolution hiccup is an outage.
  let restricted = false;
  try {
    const rec = require('./lib/roles').recordFor(u.tenant_id, role);
    restricted = rec ? rec.stockAppOnly : (role === 'kitchen' || role === 'store_stock');
  } catch (e) { restricted = (role === 'kitchen' || role === 'store_stock'); }
  if (!restricted) return next();
  const p = req.path;
  if (p.startsWith('/api/')) {
    // The list lives in lib/stock-app-only.js, with the reasoning for what is on
    // it — including why the kitchen queue's three calls had to be added, and
    // why they are scoped by METHOD rather than path.
    return require('./lib/stock-app-only').stockAppOnlyAllows(req.method, p)
      ? next() : res.status(403).json({ error: 'kitchen_add_only' });
  }
  // Pages/assets: let the Add Stock app + its static assets through; bounce any
  // backend page (shell, login, team, billing…) to the app.
  if (p === '/stock' || p === '/stock-login' || p === '/stock-manifest.webmanifest'
      || p === '/stock-icon.svg' || p === '/apple-touch-icon.png' || p === '/favicon.ico') return next();
  if (p === '/retail-admin' || p.startsWith('/backend/')) return res.redirect('/stock');
  return next();   // fonts/css/img and other static assets
});

// Routes
//
// HANDLERS IN THESE FILES ARE ALREADY PROTECTED AGAINST ASYNC REJECTIONS, even
// though nothing here or in routes/* shows a wrapper. lib/express-async-guard,
// required at the top of this file, patches Route.prototype so every handler —
// and every per-route middleware — is wrapped as it is registered. That is
// deliberate: a per-route wrapper can be forgotten on a new route, and the
// failure it prevents (a request that never responds) is silent. The cost is
// this note. Do NOT add per-route asyncHandler(...) calls; they are redundant
// and the guard already skips anything it has wrapped.
app.use(require('./routes/auth'));
app.use(require('./routes/backend-auth'));   // Mini App Backend operator realm (separate from kitchen auth)
app.use(require('./routes/backend-team'));   // Mini App Backend team management (operators within a tenant)
app.use(require('./routes/backend-notices')); // Merchant-facing platform notices (broadcasts + impersonation banner)
app.use(require('./routes/billing'));        // Mini App Backend billing control plane (plans / subscriptions / invoices)
app.use(require('./routes/billing-pay'));    // Mini App Backend billing payments & lifecycle (select-plan / checkout / mark-paid)
app.use(require('./routes/backend-signup')); // Mini App Backend tenant signup / provisioning (gated in Phase 2)
app.use(require('./routes/saas-admin'));     // Platform owner console — tenants / subscriptions / branding (kitchen-admin gated)
app.use(require('./routes/store-admin'));    // Platform account-manager console — store-admin.* (platform_admins realm + audit)
app.use(require('./routes/ingredients'));
app.use(require('./routes/recipes'));
app.use(require('./routes/admin'));
app.use(require('./routes/products'));
app.use(require('./routes/purchases'));
app.use(require('./routes/finance'));
app.use(require('./routes/alerts'));
app.use(require('./routes/waste'));
app.use(require('./routes/kitchen'));
app.use(require('./routes/sales'));
app.use(require('./routes/restock'));
app.use(require('./routes/lookups'));
app.use(require('./routes/ai'));
app.use(require('./routes/production'));
app.use(require('./routes/pos'));
app.use(require('./routes/markets'));
app.use(require('./routes/push'));
app.use(require('./routes/events'));
app.use(require('./routes/feedback'));
// Public storefront tenant scope — maps the mini-app's AppID → tenant before
// the retail routes run. Path-scoped to /api/retail (does NOT match the
// segment-distinct /api/retail-admin, which has its own gate). No-op for Roots.
app.use('/api/retail', require('./middleware/public-tenant').publicTenantScope);
// Guest-pay surface (public pay page + its JSON API) is un-authed but keyed by
// an unguessable order token; tenant-scope it by host/appid just like /api/retail
// so tdb() reads the right tenant's order.
app.use('/pay', require('./middleware/public-tenant').publicTenantScope);
app.use('/api/pay', require('./middleware/public-tenant').publicTenantScope);
app.use(require('./routes/retail'));
app.use(require('./routes/retail-inventory'));
app.use(require('./routes/retail-purchasing')); // online store buying dept: suppliers + retail POs
app.use(require('./routes/retail-materials')); // Materials (物料) — the shared ingredients masterlist, backend door
app.use(require('./routes/retail-recipes')); // Recipes (食谱) — backend door onto the same recipes tables the kitchen app writes; not wired into any UI yet
app.use(require('./routes/retail-waste')); // Waste (损耗) — §32: a stock movement with a reason; product subjects only for now. NOT routes/waste.js, which is the kitchen screen's API and stays live until cutover
app.use(require('./routes/retail-product-build')); // Product build lines — Step 2 of docs/tacet-product-build-lines-design.md; table + write path only, no screen yet
app.use(require('./routes/recycle'));     // Recently deleted (audit E-07) — what was removed, and putting it back
app.use(require('./routes/saved-views')); // Saved views (audit E-08) — a named set of filters, pinned to the screen it belongs to
app.use(require('./routes/finance-summary')); // Finance Summary (§36) — Tacet's own staircase, on tdb() from the first commit. NOT routes/finance.js, which is the kitchen Finance API and is blocked-and-left-to-die under §36
app.use(require('./routes/finance-transactions')); // Finance Transactions (§36 v4.121) — the ledger of typed rows; reads income_entries + expense_entries, never the order record
app.use(require('./routes/retail-setup')); // new-tenant "Open your store" setup guide (auto-detected checklist)
app.use(require('./routes/sku')); // Settings → SKU codes: the tenant's automatic-numbering rules (lib/sku-format.js + lib/sku-rules.js)
app.use(require('./routes/retail-page-templates')); // product editor: imported custom templates
app.use('/api/internal/meituan', require('./routes/meituan-internal')); // daemon-only, localhost
app.use(require('./routes/meituan-admin')); // retail-admin Meituan sync config
app.use(require('./routes/guanyi-admin')); // retail-admin Guanyi (gzgrocery) sync config
app.use('/api/internal/eleme', require('./routes/eleme-internal')); // daemon-only, localhost
app.use(require('./routes/eleme-admin')); // retail-admin Eleme sync config + OAuth callback
app.use(require('./routes/integrations-admin')); // retail-admin Channels & Delivery hub

// Login page
app.get('/login', (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Does the session point to a still-valid backend operator? The gate pages
// below only redirect INTO the backend when this is true. Crucially, a session
// whose backendUserId no longer resolves to an active tenant_users row (deleted
// / deactivated operator, or a DB reseed that left the old session cookie
// behind) is CLEARED here — otherwise /backend/login would bounce to
// /retail-admin, whose bootstrap /api/backend/me returns null and bounces
// straight back, refreshing forever. Validating + clearing breaks that loop so
// the operator lands on the login form and can re-authenticate.
function backendSessionValid(req) {
  if (!req.session?.backendUserId) return false;
  try {
    const dbx = require('./database');
    const u = dbx.prepare('SELECT id FROM tenant_users WHERE id = ? AND is_active = 1').get(req.session.backendUserId);
    if (u) return true;
    delete req.session.backendUserId;
    delete req.session.tenantId;
  } catch (e) { /* tables not ready — fall through to the login page */ }
  return false;
}

// Mini App Backend login — separate branded sign-in for backend operators
// (tenant_users realm). Self-redirects to /retail-admin if already signed in.
// Co-brand the sign-in page per tenant. The page is pre-auth, so the tenant is
// resolved by Host (via tenant_domains) rather than session. When the host maps
// to a tenant that has set a brand, we swap the wordmark name, drop in the logo,
// and point the favicon at the mark. Anything unresolved falls back to the
// stock Tacet page — never a broken brand. Raw file is read once and cached.
let _loginHtmlRaw = null;
function _escHtmlAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function brandedLoginHtml(req) {
  if (_loginHtmlRaw == null) _loginHtmlRaw = fs.readFileSync(path.join(__dirname, 'public', 'backend-login.html'), 'utf8');
  let html = _loginHtmlRaw;
  try {
    const dbx = require('./database');
    const host = String(req.headers['x-forwarded-host'] || req.hostname || '').toLowerCase().split(':')[0];
    if (!host) return html;
    const dom = dbx.prepare("SELECT tenant_id FROM tenant_domains WHERE host = ? AND status = 'active'").get(host);
    if (!dom) return html;
    const t = dbx.prepare('SELECT id, brand_name, brand_logo_data, brand_mark_data, brand_credit, brand_updated_at FROM tenants WHERE id = ?').get(dom.tenant_id);
    if (!t || (!t.brand_name && !t.brand_logo_data)) return html;   // tenant hasn't co-branded → stock page
    const stamp = t.brand_updated_at ? +new Date(t.brand_updated_at) : 0;
    if (t.brand_name) {
      const nm = _escHtmlAttr(t.brand_name);
      html = html.replace('<span class="wordmark" data-no-i18n>tacet</span>', `<span class="wordmark tenant" data-no-i18n>${nm}</span>`)
                 .replace('<title>tacet · Sign in</title>', `<title>${nm} · Sign in</title>`);
    }
    if (t.brand_mark_data) {
      html = html.replace('</head>', `<link rel="icon" href="/api/backend/brand/${t.id}/mark?v=${stamp}"></head>`);
    }
    if (t.brand_logo_data) {
      html = html.replace(/<span class="wave"[\s\S]*?<\/span>/,
        `<img class="brandlogo" src="/api/backend/brand/${t.id}/logo?v=${stamp}" alt="">`);
    }
  } catch (e) { /* any hiccup → stock page */ }
  return html;
}
app.get('/backend/login', (req, res) => {
  if (backendSessionValid(req)) return res.redirect('/retail-admin');
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(brandedLoginHtml(req));
});

// Mini App Backend account — change password / sign out for backend operators.
app.get('/backend/account', (req, res) => {
  if (!req.session?.backendUserId) return res.redirect('/backend/login');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'backend-account.html'));
});

// Mini App Backend team — RETIRED as a page. public/backend-team.html was a
// standalone duplicate of the Team screen, written before the permission matrix
// existed: it carried its own role-name map, its own descriptions, its own
// sixteen hardcoded role <option> elements and its own owner-count logic, and
// it could not edit permissions at all. The rail stopped linking to it in
// 2026-07-14 when Team became a native tab; roles becoming per-tenant data is
// what settled it, because every role statement the page made would have been
// untrue for any tenant that renamed or deleted one.
//
// The URL survives as a redirect rather than a 404: it was reached from the
// topbar profile menu for months, so bookmarks exist, and ?tab= is the shell's
// own deep-link convention (see 10-extras.js).
app.get('/backend/team', (req, res) => {
  if (!req.session?.backendUserId) return res.redirect('/backend/login');
  res.redirect('/retail-admin?tab=team');
});

// Co-brand identity editor (logo + brand name). Moved out of the profile page
// (2026-07-14) — brand is business identity, not personal — and now reached
// from the left rail under Set up. The PUT /api/backend/brand endpoint enforces
// the owner/admin role; this page route only checks that someone's signed in.
app.get('/backend/brand', (req, res) => {
  if (!req.session?.backendUserId) return res.redirect('/backend/login');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'backend-brand.html'));
});

// The AI brand studio (audit B-04). A finished screen — brief form, progress
// state, preview, apply — backed by five working endpoints, with no route and
// no link: reachable only by typing /assets/brand-studio.html, because the
// static server exposes the whole public folder. Work paid for and unused.
// Same gate shape as /backend/brand above: signed in here, and the endpoints
// behind it enforce the role.
app.get('/backend/brand-studio', (req, res) => {
  if (!req.session?.backendUserId) return res.redirect('/backend/login');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'brand-studio.html'));
});

// SaaS-admin console — platform owner only (a kitchen `admin` session).
app.get('/saas-admin', (req, res) => {
  const dbx = require('./database');
  const u = req.session?.userId && dbx.prepare('SELECT role FROM users WHERE id = ? AND is_active = 1').get(req.session.userId);
  if (!u || u.role !== 'admin') return res.redirect('/login');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'saas-admin.html'));
});

// Mini App Backend signup — create a new tenant backend (gated in Phase 2).
app.get('/backend/signup', (req, res) => {
  if (backendSessionValid(req)) return res.redirect('/retail-admin');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'backend-signup.html'));
});

// Mini App Backend billing — plans / subscription / invoices for the tenant.
app.get('/backend/billing', (req, res) => {
  if (!req.session?.backendUserId) return res.redirect('/backend/login');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'backend-billing.html'));
});

// Subdomain that serves the online-store backend (Mini App Backend /
// retail-admin) at its root instead of the kitchen SPA. food.* / app.* / the
// bare domain all keep serving the kitchen app.
const STORE_HOST = 'store.rootskitchenchina.com';

// Subdomain that serves the PLATFORM "System Back Office" console (store-admin.html)
// at its root. This is the back office for the whole SaaS — the team manages
// every merchant account here (platform_admins realm). Distinct from STORE_HOST
// above, which serves an individual MERCHANT their own retail-admin backend.
const STORE_ADMIN_HOST = 'system.rootskitchenchina.com';

// Serve the platform console shell. The page self-auths via /api/store-admin/me
// and shows its own login form when signed out, so no server-side gate here
// (same self-auth pattern as the retail-admin shell). Always fresh — low-traffic
// and must never be pinned to a stale build by an intermediary cache.
function serveStoreAdmin(req, res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'store-admin.html'));
}

// Preview path on the EXISTING secure domain, so the console can be opened
// before store-admin.* DNS + TLS are set up (mirrors /shop-preview). Same shell.
app.get('/store-admin', serveStoreAdmin);

// ── Impersonation hand-off ("log in as store") ───────────────────────────
// A one-time token minted by the store-admin console is opened here ON THE
// MERCHANT-BACKEND HOST, so the session cookie lands on the right origin
// (cookies are host-scoped). We validate + burn the token, start the tenant's
// operator session, and stamp who's impersonating so the retail-admin banner
// can show it and offer an exit.
app.get('/impersonate', (req, res) => {
  const dbx = require('./database');
  const token = String(req.query.t || '').trim();
  const fail = (msg) => res.status(400).type('html').send('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;padding:40px;max-width:520px;margin:auto;color:#12161A"><h2>Impersonation link invalid</h2><p>'+msg+'</p><p><a href="https://'+STORE_ADMIN_HOST+'/">Back to System Back Office · 返回平台后台</a></p></body>');
  if (!token) return fail('Missing token. · 缺少令牌。');
  let row;
  try { row = dbx.prepare('SELECT * FROM platform_impersonation_tokens WHERE token = ?').get(token); }
  catch (e) { return fail('Not available. · 暂不可用。'); }
  if (!row || row.used_at) return fail('This link was already used. · 链接已被使用。');
  if (Date.parse(row.expires_at) < Date.now()) return fail('This link has expired — links last 2 minutes. · 链接已过期(有效期 2 分钟)。');
  const op = dbx.prepare('SELECT id, tenant_id, is_active FROM tenant_users WHERE id = ?').get(row.operator_id);
  const tenant = op && dbx.prepare('SELECT status FROM tenants WHERE id = ?').get(op.tenant_id);
  if (!op || !op.is_active || !tenant || tenant.status !== 'active') return fail('The store or operator is no longer available. · 店铺或操作员不可用。');
  dbx.prepare('UPDATE platform_impersonation_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
  req.session.backendUserId = op.id;
  req.session.tenantId = op.tenant_id;
  req.session.impersonatedBy = { kind: row.by_kind, id: row.by_id, name: row.by_name, at: new Date().toISOString() };
  req.session.cookie.maxAge = 2 * 60 * 60 * 1000;   // impersonation sessions stay short-lived
  return res.redirect('/');
});

// End an impersonation session and return to the console.
app.get('/impersonate/exit', (req, res) => {
  if (req.session) {
    delete req.session.backendUserId;
    delete req.session.tenantId;
    delete req.session.impersonatedBy;
  }
  return res.redirect('https://' + STORE_ADMIN_HOST + '/');
});

// Cache-busting stamp for the admin's static assets. Computed once per process,
// so it changes on every deploy (each deploy pm2-restarts the app) but stays
// stable within a running process — assets cache normally BETWEEN deploys, and a
// deploy invalidates them for free by minting new ?v= URLs. This is what stops
// operators from being pinned to old JavaScript by the browser / service-worker
// cache after a deploy (the shell HTML is already no-store, so it always carries
// the newest stamp and points the browser at the fresh asset URLs).
const ASSET_VER = Date.now().toString(36);
let _retailAdminHtmlCache = null;
function retailAdminShell() {
  if (_retailAdminHtmlCache) return _retailAdminHtmlCache;
  const raw = fs.readFileSync(path.join(__dirname, 'public', 'retail-admin.html'), 'utf8');
  // Append ?v=<stamp> to every local /assets/*.js and /assets/*.css URL.
  _retailAdminHtmlCache = raw.replace(/(\/assets\/[^"'?]+?\.(?:js|css))(["'])/g, `$1?v=${ASSET_VER}$2`);
  return _retailAdminHtmlCache;
}

// Serve the Mini App Backend (retail-admin) shell. Page self-auths via
// /api/auth/me. Shared by the /retail-admin path and the store.* subdomain root.
function serveRetailAdmin(req, res) {
  // Access gate: a Mini App Backend operator whose tenant is suspended (set by
  // the billing lifecycle job for non-payment) is sent to Billing to pay,
  // rather than into a backend whose APIs would 401. Kitchen users and
  // in-good-standing tenants pass straight through. Internal tenants (Roots)
  // are never suspended, so they always reach the backend.
  if (req.session?.backendUserId) {
    try {
      const dbx = require('./database');
      const u = dbx.prepare('SELECT tenant_id FROM tenant_users WHERE id = ? AND is_active = 1').get(req.session.backendUserId);
      const tenant = u && dbx.prepare('SELECT status FROM tenants WHERE id = ?').get(u.tenant_id);
      if (tenant && tenant.status !== 'active') return res.redirect('/backend/billing?suspended=1');
    } catch (e) { /* tables not ready — fail open to the page's own auth */ }
  }
  // no-STORE (not just no-cache): an intermediary caching proxy/VPN ignores
  // no-cache and will serve a stale shell — which pins the operator's browser
  // to old JavaScript even across reloads (exactly the /api caching footgun,
  // see the no-store block above). The backend shell is low-traffic and must
  // always be fresh, so forbid storing it anywhere.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  // Phones get Tacet Mobile — the monitoring-first companion — as THE backend on
  // mobile; desktop keeps the full admin. `?desktop=1` forces the desktop shell
  // (same escape hatch as /cms). WeChat's in-app browser (MicroMessenger) counts
  // as mobile. The companion self-auths against /api/retail-admin/* just like the
  // desktop shell, so the session/suspended gate above still applies first.
  const ua = req.get('user-agent') || '';
  const isMobile = /Android|iPhone|iPod|Windows Phone|Mobile|MicroMessenger/i.test(ua);
  if (isMobile && req.query.desktop !== '1') {
    return res.sendFile(path.join(__dirname, 'public', 'm.html'));
  }
  // Serve the shell with per-deploy versioned asset URLs so a deploy's new JS/CSS
  // is fetched immediately instead of being masked by the browser/SW cache.
  res.type('html').send(retailAdminShell());
}

// Customer-facing web storefront shell (public). Served for any host registered
// as an ACTIVE tenant_domains row — the browser-website counterpart of the
// WeChat mini-app. The page self-scopes: its /api/retail/* calls carry no
// x-wx-appid, so the public-tenant middleware resolves the tenant by Host.
const { lookupStorefrontHost } = require('./middleware/public-tenant');
function serveShop(req, res) {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'shop.html'));
}

// Main app - serves the SPA shell
const { requireAuth } = require('./middleware/auth');
app.get('/', (req, res) => {
  const host = (req.hostname || '').toLowerCase();
  // Platform account-manager console subdomain → the store-admin shell. Self-
  // auths against the platform_admins realm; checked before STORE_HOST so the
  // two subdomains never cross.
  if (host === STORE_ADMIN_HOST) {
    return serveStoreAdmin(req, res);
  }
  // Online-store subdomain lands directly on the Mini App Backend, not the
  // kitchen SPA. It self-auths, so we skip requireAuth for that host.
  if (host === STORE_HOST) {
    return serveRetailAdmin(req, res);
  }
  // A registered storefront domain → the public customer website.
  if (lookupStorefrontHost(req.hostname)) {
    return serveShop(req, res);
  }
  // Everything else (food.* / app.* / bare domain) → kitchen app, auth-gated.
  requireAuth(req, res, () => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'public', 'app.html'));
  });
});

// /retail-admin is retired as a standalone URL — the online-store backend now
// lives at store.rootskitchenchina.com. Every hit (old bookmarks, the
// post-login redirect, in-app back-links, deep links like ?tab=orders) bounces
// to the store root, carrying the query string. On the store host this is a
// same-origin redirect, so the session cookie is preserved; serveRetailAdmin
// still backs the store host's / and re-applies the suspended-tenant gate.
app.get('/retail-admin', (req, res) => {
  const i = req.originalUrl.indexOf('?');
  const qs = i === -1 ? '' : req.originalUrl.slice(i);
  res.redirect(302, 'https://' + STORE_HOST + '/' + qs);
});

// Counter till — the cashier-facing screen on a shop tablet. Same self-auth
// pattern as /product-editor below: the shell loads, then its own
// fetch('/api/retail-admin/stores') enforces auth and the page renders a
// signed-out state on 401/403. It deliberately does NOT redirect on 401 —
// /retail-admin bounces to the store host, and a till that redirects itself
// mid-shift is the redirect loop this product has already been bitten by.
//
// NOT the removed /pos. That shell was deleted 2026-08-04 (388c7e57) and its
// path still 302s away; §13 of the decisions doc retires POS as an app and
// keeps it as a sales CHANNEL. This is a different thing: a device screen for
// the `counter` FULFILMENT type, writing through the ordinary manual-order
// endpoint. New path, new file, no revival of either.
//
// PERMISSIONED, as of the `till:use` capability. The shell is still served to
// anyone who asks — this route stays a plain sendFile and deliberately does NOT
// gate, redirect or 403 — because the page's own boot does it: it reads
// /api/backend/me and stops on its boot screen with "no permission" unless the
// operator holds BOTH `till:use` (opens the screen) and `orders:edit` (what
// lib/cap-routes.js requires of the POST its Confirm makes). Gating here
// instead would mean redirecting a signed-out tablet, which is the loop the
// paragraph above exists to prevent. The rail row and the phone's More row are
// hidden by the same pair, so the URL is no longer the only door and no longer
// an unguarded one.
//
// no-store, not no-cache: the same reasoning as the backend shell. A till
// pinned to old JavaScript by an intermediary cache would keep charging with
// last week's prices, and it is a low-traffic page that can afford to be
// fetched fresh every time.
app.get('/till', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'till.html'));
});

// Full-page product block editor — opened in a new tab from the
// retail-admin Products grid (window.open('/product-editor?id=…')). Same
// self-auth pattern as /retail-admin: the shell loads, then the page's own
// fetch('/api/retail-admin/products') enforces auth and redirects to / on
// 401/403. Served no-cache (revalidate-always) so staff get the latest
// editor build on deploy while skipping the re-download when it's unchanged.
app.get('/product-editor', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'product-editor.html'));
});

// Storefront visual CMS editor. Same self-auth pattern; gated by `retail` perm.
// Served no-cache (revalidate-always) so staff see the latest editor build the
// moment we deploy — no "I refreshed but the picker still looks old" — without
// re-downloading the whole shell when nothing changed (server answers 304).
app.get('/cms', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  // Phones get the touch-first mobile editor; everything else gets the full
  // desktop editor. `?desktop=1` forces desktop (used by the mobile shell's
  // embedded preview iframe and the "Open on desktop" link). WeChat's in-app
  // browser reports as MicroMessenger, so it counts as mobile.
  const ua = req.get('user-agent') || '';
  const isMobile = /Android|iPhone|iPod|Windows Phone|Mobile|MicroMessenger/i.test(ua);
  const wantsDesktop = req.query.desktop === '1';
  const file = (isMobile && !wantsDesktop) ? 'cms-mobile.html' : 'cms.html';
  res.sendFile(path.join(__dirname, 'public', file));
});

// Tacet Mobile — the monitoring-first phone companion for the store backend.
// Same self-auth pattern as /product-editor and /retail-admin: the shell loads
// immediately, then its own fetch('/api/retail-admin/*') enforces auth and the
// page redirects to the store root on 401/403. Served no-store (like the admin
// shell) so operators always get the freshest build on deploy. Reachable at /m
// on any host, and it's the intended phone entry point on the store.* subdomain.
app.get('/m', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'm.html'));
});
// Tacet Mobile's install manifest + its launcher icons. Both must answer from
// the ROOT of the host the app runs on: a manifest is fetched by the browser,
// not the page, and its start_url ('/m') and scope ('/') are resolved against
// the manifest's own URL — parking it under /assets would scope the installed
// app to /assets and the install would be refused. The route mirrors
// /kitchen-manifest.webmanifest exactly; see the note above /kitchen for why a
// PWA's start_url has to be reachable without a redirect.
app.get('/m-manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').sendFile(path.join(__dirname, 'public', 'm-manifest.webmanifest'));
});
['tacet-icon-192.png', 'tacet-icon-512.png', 'tacet-icon-192-maskable.png',
  'tacet-icon-512-maskable.png', 'tacet-apple-touch-icon.png', 'tacet-icon.svg'].forEach(name => {
  app.get('/' + name, (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(__dirname, 'public', name));
  });
});

// Public storefront preview — renders the LIVE home.layout in a phone
// frame for any visitor. No auth, no editor chrome. Used by the team to
// share the current published layout via a link, and by stakeholders to
// see the mini app's home page without installing WeChat.
app.get('/storefront', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'storefront.html'));
});

// Web storefront PREVIEW path. The customer website normally serves at its own
// registered host (tenant_domains → serveShop on '/'), which needs DNS + TLS.
// This path lets the team open the storefront on the EXISTING secure domain
// before that's set up: shop.html self-scopes by Host, so on a non-storefront
// host it falls back to the default (Roots) catalogue. Safe + public (the page
// only reads public /api/retail/* data). Remove once real domains are live.
app.get('/shop-preview', serveShop);

// Public marketing landing page — the B2B pitch for the Full Circle
// platform. No auth, shareable link for prospects/investors.
app.get('/full-circle', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(__dirname, 'public', 'full-circle.html'));
});

// Kitchen station shell. PUBLIC route (no requireAuth) so Chrome can
// validate the manifest's start_url during PWA install — otherwise it
// silently fails when the route returns 302→/login. The page itself
// self-authenticates against the `kitchen` permission via /api/auth/me
// on load and bounces unauthenticated users to /login, so security is
// unchanged.
app.get('/kitchen', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'kitchen.html'));
});
app.get('/kitchen-manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').sendFile(path.join(__dirname, 'public', 'kitchen-manifest.webmanifest'));
});
['kitchen-icon-192.png','kitchen-icon-512.png','kitchen-icon-192-maskable.png','kitchen-icon-512-maskable.png'].forEach(name => {
  app.get('/' + name, (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(__dirname, 'public', name));
  });
});

// The /restock station shell was removed on 2026-08-04 — the restock flow is
// not used; warehouse staff do not raise restock orders anywhere. Gone with it:
// its manifest and its four icons. The `/api/restock/*` API in routes/restock.js
// stays — app.html and kitchen.html still drive restock orders through it.

// Quick Stock — phone-first inventory PWA for shop staff. Per-tenant add-on
// (toggled in the online-store backend under Settings → Quick Stock). Same
// public-route PWA pattern as /kitchen so the manifest start_url
// validates on install; the page self-authenticates against
// /api/auth/me and bounces unauthenticated visitors to /login. Editing is
// gated server-side per store (users.retail_store_id) by the stock APIs.
app.get('/stock', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'stock.html'));
});
app.get('/till-manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').sendFile(path.join(__dirname, 'public', 'till-manifest.webmanifest'));
});
app.get('/stock-manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').sendFile(path.join(__dirname, 'public', 'stock-manifest.webmanifest'));
});
// Host-aware login redirect for Quick Stock. The same /stock page is reachable
// on the online-store back office host (backend-operator realm) and on the
// kitchen host (kitchen-user realm), which have different login pages. The
// page sends a signed-out staffer here and the server picks the right one by
// host — keeping the realm logic server-side (where the host routing lives)
// instead of hardcoding a host in the client. `redirect` returns them to /stock.
app.get('/stock-login', (req, res) => {
  const host = (req.hostname || '').toLowerCase();
  const isBackendHost = host === STORE_HOST || host === STORE_ADMIN_HOST;
  // login.html honours ?redirect=<same-origin path> and returns the staffer to
  // /stock after sign-in; backend-login.html ignores params (lands on its own
  // home), so we just send them to the right login there.
  res.redirect(302, isBackendHost ? '/backend/login' : '/login?redirect=%2Fstock');
});
app.get('/stock-icon.svg', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('image/svg+xml').sendFile(path.join(__dirname, 'public', 'stock-icon.svg'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', time: new Date().toISOString() });
});

// /api/version — token that changes whenever the SPA shell (app.html)
// is redeployed. Clients poll this and pop a "new version available"
// banner when it differs from what they loaded with. mtime is enough —
// stat is cheap, hash would be overkill for a 600 KB file. Server-boot
// time is mixed in too so a process restart (e.g. backend code change)
// also nudges connected clients to refresh.
const fsCore = require('fs');
const APP_HTML_PATH = path.join(__dirname, 'public', 'app.html');
const RETAIL_ADMIN_HTML_PATH = path.join(__dirname, 'public', 'retail-admin.html');
const SERVER_BOOT_MS = Date.now();
app.get('/api/version', (req, res) => {
  let appMtime = 0, adminMtime = 0;
  try { appMtime = fsCore.statSync(APP_HTML_PATH).mtimeMs | 0; } catch {}
  try { adminMtime = fsCore.statSync(RETAIL_ADMIN_HTML_PATH).mtimeMs | 0; } catch {}
  // version = appHtmlMtime-retailAdminMtime-bootEpoch — changes when either
  // shell is replaced OR on a pm2 restart. The Mini App Backend (retail-admin)
  // polls this same token so a backend-only edit still nudges operators to
  // reload, even if the deploy didn't restart the process.
  res.json({
    success: true,
    version: `${appMtime}-${adminMtime}-${SERVER_BOOT_MS|0}`,
    app_mtime: appMtime,
    retail_admin_mtime: adminMtime,
    server_boot: SERVER_BOOT_MS,
  });
});

// 404
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  // On a storefront host, unknown GET paths are client-side SPA routes
  // (/product/123, /cart, …) — serve the shell so deep links and refreshes
  // keep their URL instead of bouncing to '/'.
  if (req.method === 'GET' && lookupStorefrontHost(req.hostname)) {
    return serveShop(req, res);
  }
  res.redirect('/');
});

// Page ops when a route error reaches the handler below.
//
// WHY THIS EXISTS. Before lib/express-async-guard, an error escaping an async
// handler became an unhandledRejection and paged ops through alertCrash at the
// top of this file. The guard now catches those and turns them into a clean
// 500 — better for the customer, but it also means that class of failure would
// stop paging entirely. This restores the page, on the path the guard forwards
// to, so the visibility survives the conversion.
//
// IT CANNOT DELAY OR BREAK THE RESPONSE. setImmediate defers it until after the
// 500 has been written: sendOpsAlert's first call opens a read-only sqlite
// handle to read the webhook config, and nothing on the response path should
// wait on that. The try/catch and .catch() mean neither a throw nor a rejected
// send can escape.
//
// RATE LIMITING IS THE ONE ALREADY IN lib/ops-alert.js — an identical message
// inside 60s is dropped there (DEDUP_MS). That only works if the text is STABLE
// across repeats, so it is built from the route PATTERN (/api/orders/:id) rather
// than the URL (/api/orders/1837) and carries nothing per-request. A burst on
// one broken endpoint therefore pages once a minute, not once a request.
function pageRouteError(req, err) {
  setImmediate(() => {
    try {
      // req.route holds the matched pattern; it is absent when the error came
      // from middleware that ran before any route matched, so fall back.
      const where = (req.route && ((req.baseUrl || '') + req.route.path)) || req.path || req.originalUrl;
      require('./lib/ops-alert')
        .sendOpsAlert(`🔴 roots-v2 route error: ${req.method} ${where} — ${(err && err.message) || err}. Returned 500; grep [route-error] for the stack.`)
        .catch(() => {});
    } catch (_) { /* alerting must never block or throw here */ }
  });
}

// Global error handler (4-arg). Catches anything a route threw synchronously
// or forwarded via next(err) so it becomes a clean 500 instead of an
// unhandled error. Must be registered LAST, after all routes and the 404.
// (Async rejections are routed here too, by lib/express-async-guard; without it
// they would never reach next() and the request would hang.)
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(`[route-error] ${req.method} ${req.originalUrl}:`, err && err.stack);
  pageRouteError(req, err);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'server_error' });
  res.status(500).send('Server error');
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Roots System v2 running on port ${PORT}`);
  // Fire a push notification announcing the current release if we
  // haven't already announced this version (see release.json + _migrations).
  try { require('./releases').announceLatestRelease(); }
  catch (e) { console.warn('[releases] announce failed at boot:', e.message); }
  // Start the retail-inventory reservation sweeper. Releases any
  // soft-reserves that have passed their expires_at and auto-cancels the
  // owning order if it never paid. Runs every 60s.
  try { require('./lib/inventory').startReservationSweeper(); }
  catch (e) { console.warn('[inventory.sweeper] start failed:', e.message); }
  // Kd100 subscription retry sweeper. Re-attempts failed kuaidi100
  // subscriptions every 30 min so transient API errors don't leave a
  // waybill silently un-synced. No-op when kd100 isn't configured.
  try {
    require('./lib/tracking').startKd100Sweeper({
      mainDb:         require('./database'),
      getTenantDb:    tenantDb.getTenantDb,
      getTenantCreds: tenantCreds.getTenantCreds,
    });
  } catch (e) { console.warn('[kd100.sweeper] start failed:', e.message); }
  // Delivery "ship it on time" reminder sweeper. Pushes retail operators 30 min
  // before a chosen time-window opens, or at 10:00 on the day of a date-only
  // delivery. Runs every 60s; fires once per order. No-op when push is off.
  try {
    require('./lib/delivery-reminders').startDeliveryReminderSweeper({
      mainDb:      require('./database'),
      getTenantDb: tenantDb.getTenantDb,
    });
  } catch (e) { console.warn('[ship.reminder] start failed:', e.message); }
  // Daily low-stock digest (audit E-06). A low-stock threshold has existed per
  // merchant and per shop all along and fed a dashboard card only — so a
  // merchant who did not open the admin never found out they were running out.
  // ONE message a day naming the shortest lines, at the hour the account chose
  // (09:00 by default), on by default. Runs every 10 min; the day-claim makes a
  // missed tick free. No-op when push is off.
  try {
    require('./lib/low-stock-digest').startLowStockDigestSweeper({
      mainDb:      require('./database'),
      getTenantDb: tenantDb.getTenantDb,
    });
  } catch (e) { console.warn('[lowstock.digest] start failed:', e.message); }
  // Seeded-review top-up sweeper. Holds every published product at the review
  // floor the operator set on Inbox → Reviews. OFF unless they turned it on, and
  // a no-op once the catalogue sits at the floor, so it costs nothing when idle.
  try {
    require('./lib/review-topup').startReviewTopupSweeper({
      mainDb:      require('./database'),
      getTenantDb: tenantDb.getTenantDb,
    });
  } catch (e) { console.warn('[review.topup] start failed:', e.message); }
  // Secrets-at-rest health (Platform readiness ⑩). A non-Roots tenant's creds
  // are AES-256-GCM encrypted under TENANT_SECRET_KEY; if that key is missing
  // on a box that already has tenants, none of their secrets can be decrypted
  // and they silently fall back to devMode. Surface it loudly at boot so a
  // misconfigured prod is caught before a tenant tries to operate.
  try {
    const box = require('./lib/secret-box');
    const n = require('./database').prepare('SELECT COUNT(*) AS c FROM tenants WHERE id <> 1').get().c;
    if (box.isConfigured()) {
      console.log(`[security] tenant secret-box configured (key fp ${box.keyFingerprint()}).`);
    } else if (n > 0) {
      console.error(`[security] ⚠️  TENANT_SECRET_KEY is NOT set but ${n} non-Roots tenant(s) exist — their stored credentials cannot be decrypted (they will run in devMode). Set TENANT_SECRET_KEY in .env and restart.`);
    }
  } catch (e) { console.warn('[security] secret-box health check skipped:', e.message); }
});
