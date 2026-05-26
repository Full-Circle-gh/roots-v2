const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

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
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// Body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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

// Routes
app.use(require('./routes/auth'));
app.use(require('./routes/backend-auth'));   // Mini App Backend operator realm (separate from kitchen auth)
app.use(require('./routes/billing'));        // Mini App Backend billing control plane (plans / subscriptions / invoices)
app.use(require('./routes/billing-pay'));    // Mini App Backend billing payments & lifecycle (select-plan / checkout / mark-paid)
app.use(require('./routes/backend-signup')); // Mini App Backend tenant signup / provisioning (gated in Phase 2)
app.use(require('./routes/saas-admin'));     // Platform owner console — tenants / subscriptions / branding (kitchen-admin gated)
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
app.use(require('./routes/retail'));
app.use(require('./routes/retail-inventory'));

// Login page
app.get('/login', (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Mini App Backend login — separate branded sign-in for backend operators
// (tenant_users realm). Self-redirects to /retail-admin if already signed in.
app.get('/backend/login', (req, res) => {
  if (req.session?.backendUserId) return res.redirect('/retail-admin');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'backend-login.html'));
});

// Mini App Backend account — change password / sign out for backend operators.
app.get('/backend/account', (req, res) => {
  if (!req.session?.backendUserId) return res.redirect('/backend/login');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'backend-account.html'));
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
  if (req.session?.backendUserId) return res.redirect('/retail-admin');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'backend-signup.html'));
});

// Mini App Backend billing — plans / subscription / invoices for the tenant.
app.get('/backend/billing', (req, res) => {
  if (!req.session?.backendUserId) return res.redirect('/backend/login');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'backend-billing.html'));
});

// Main app - serves the SPA shell
const { requireAuth } = require('./middleware/auth');
app.get('/', requireAuth, (req, res) => {
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

// Storefront / retail admin shell. Page self-auths via /api/auth/me.
app.get('/retail-admin', (req, res) => {
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
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'retail-admin.html'));
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
  res.sendFile(path.join(__dirname, 'public', 'cms.html'));
});

// Public storefront preview — renders the LIVE home.layout in a phone
// frame for any visitor. No auth, no editor chrome. Used by the team to
// share the current published layout via a link, and by stakeholders to
// see the mini app's home page without installing WeChat.
app.get('/storefront', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'storefront.html'));
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
const SERVER_BOOT_MS = Date.now();
app.get('/api/version', (req, res) => {
  let appMtime = 0;
  try { appMtime = fsCore.statSync(APP_HTML_PATH).mtimeMs | 0; } catch {}
  // version = appHtmlMtime-bootEpoch — changes on file replace OR pm2 restart.
  res.json({
    success: true,
    version: `${appMtime}-${SERVER_BOOT_MS|0}`,
    app_mtime: appMtime,
    server_boot: SERVER_BOOT_MS,
  });
});

// 404
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
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
  try { require('./lib/tracking').startKd100Sweeper(require('./database')); }
  catch (e) { console.warn('[kd100.sweeper] start failed:', e.message); }
});
