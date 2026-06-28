const express = require('express');
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
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const text = fs.readFileSync(envPath, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // Strip optional surrounding quotes (so KEY="value" works too).
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) { console.warn('[.env load]', e.message); }
})();

// Ensure data directory exists
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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

// PWA assets — must be served from root for the service worker to claim "/" scope
app.get('/sw.js', (req, res) => {
  res.set('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').sendFile(path.join(__dirname, 'public', 'manifest.webmanifest'));
});
// Dedicated POS manifest — separate scope/start_url so installing the
// home-screen icon launches straight into /pos for vendors.
app.get('/pos-manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').sendFile(path.join(__dirname, 'public', 'pos-manifest.webmanifest'));
});
// PNG icons for the POS PWA. Served from root so the manifest's bare
// "/pos-icon-…" paths resolve regardless of scope.
['pos-icon-192.png','pos-icon-512.png','pos-icon-192-maskable.png','pos-icon-512-maskable.png'].forEach(name => {
  app.get('/' + name, (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(__dirname, 'public', name));
  });
});

// Favicon — browsers request these at the site root. Served from public/.
['favicon.ico','favicon.svg','favicon-32.png','apple-touch-icon.png'].forEach(name => {
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
// calls. Two roles are restricted this way:
//   • 'kitchen'      — kitchen staff, created from the Team page (add-only)
//   • 'store_stock'  — store stock clerks, created under Settings → Operations →
//                      Stores, pinned to one store (recount their own store)
// Everything else in the backend (the retail-admin shell, /backend/* pages,
// every other API) is blocked here in ONE place, so it can't be reached by a
// stray requireBackend copy that doesn't check the role. Full-access sessions
// (owner/admin/staff) skip instantly.
app.use((req, res, next) => {
  if (!req.session?.backendUserId) return next();
  let role;
  try { role = require('./database').prepare('SELECT role FROM tenant_users WHERE id = ? AND is_active = 1').get(req.session.backendUserId)?.role; }
  catch (e) { return next(); }   // tables not ready — fail open to existing gates
  if (role !== 'kitchen' && role !== 'store_stock') return next();
  const p = req.path;
  if (p.startsWith('/api/')) {
    const ok = p === '/api/retail-admin/quick-stock/context'
      || /^\/api\/retail-admin\/stores\/\d+\/stock(\/\d+)?$/.test(p)
      || p === '/api/backend/logout';
    return ok ? next() : res.status(403).json({ error: 'kitchen_add_only' });
  }
  // Pages/assets: let the Add Stock app + its static assets through; bounce any
  // backend page (shell, login, team, billing…) to the app.
  if (p === '/stock' || p === '/stock-login' || p === '/stock-manifest.webmanifest'
      || p === '/stock-icon.svg' || p === '/apple-touch-icon.png' || p === '/favicon.ico') return next();
  if (p === '/retail-admin' || p.startsWith('/backend/')) return res.redirect('/stock');
  return next();   // fonts/css/img and other static assets
});

// Routes
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
app.use(require('./routes/retail'));
app.use(require('./routes/retail-inventory'));
app.use(require('./routes/retail-page-templates')); // product editor: imported custom templates
app.use('/api/internal/meituan', require('./routes/meituan-internal')); // daemon-only, localhost
app.use(require('./routes/meituan-admin')); // retail-admin Meituan sync config
app.use(require('./routes/guanyi-admin')); // retail-admin Guanyi (gzgrocery) sync config

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
app.get('/backend/login', (req, res) => {
  if (backendSessionValid(req)) return res.redirect('/retail-admin');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'backend-login.html'));
});

// Mini App Backend account — change password / sign out for backend operators.
app.get('/backend/account', (req, res) => {
  if (!req.session?.backendUserId) return res.redirect('/backend/login');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'backend-account.html'));
});

// Mini App Backend team — manage operators within the tenant (invite / role /
// deactivate / reset password). Reached from the topbar profile menu.
app.get('/backend/team', (req, res) => {
  if (!req.session?.backendUserId) return res.redirect('/backend/login');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'backend-team.html'));
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
  res.sendFile(path.join(__dirname, 'public', 'retail-admin.html'));
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
    // Auto-route POS-only users to the cashier shell so they don't see a
    // permission-empty admin SPA. Admins still go to the full app from /.
    // (They can hit /pos directly to test the cashier flow.)
    const db = require('./database');
    const perms = db.prepare('SELECT * FROM permissions WHERE user_id = ?').get(req.user.id) || {};
    const isAdmin = req.user.role === 'admin';
    const hasPos  = !!perms.pos;
    // Module flags that grant access to the main SPA. Mirrors the MODULES
    // list in app.html; if any are true, give them the SPA.
    const SPA_PERMS = ['dashboard','recipes','ingredients','products','purchases','finance','sales','kitchen','waste','restock','alerts','suppliers','retail'];
    const hasAnySpa = SPA_PERMS.some(k => perms[k]);
    if (!isAdmin && hasPos && !hasAnySpa) {
      return res.redirect('/pos');
    }
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

// Tablet/phone POS shell. PUBLIC route (no requireAuth) so Chrome can
// validate the manifest's start_url during PWA install — otherwise it
// silently fails when the route returns 302→/login. The page itself
// authenticates via /api/auth/me on load and bounces unauthenticated
// users to /login, so security is unchanged.
app.get('/pos', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'pos.html'));
});

// Kitchen station shell. Same PWA pattern as /pos — public route so the
// manifest start_url validates, page itself self-authenticates against
// the `kitchen` permission via /api/auth/me on load.
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

// Restock station shell. Same PWA pattern as /pos and /kitchen — public
// route so the manifest validates; page self-auths against the `restock`
// permission via /api/auth/me. Mobile-first restock-creation flow with
// barcode-gun support, voice input, and search-everywhere-style UX.
app.get('/restock', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'restock.html'));
});
app.get('/restock-manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').sendFile(path.join(__dirname, 'public', 'restock-manifest.webmanifest'));
});
['restock-icon-192.png','restock-icon-512.png','restock-icon-192-maskable.png','restock-icon-512-maskable.png'].forEach(name => {
  app.get('/' + name, (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(__dirname, 'public', name));
  });
});

// Quick Stock — phone-first inventory PWA for shop staff. Per-tenant add-on
// (toggled in the online-store backend under Settings → Quick Stock). Same
// public-route PWA pattern as /pos, /kitchen and /restock so the manifest
// start_url validates on install; the page self-authenticates against
// /api/auth/me and bounces unauthenticated visitors to /login. Editing is
// gated server-side per store (users.retail_store_id) by the stock APIs.
app.get('/stock', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'stock.html'));
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
