// Retail mini app — public API consumed by the WeChat native mini program.
// Auth is Bearer-token (Authorization header), NOT the session-cookie scheme
// the staff side uses. Anything under /api/retail/* is intended for end
// customers; rate-limit + CDN-cache assumed at the reverse proxy.
//
// Endpoints in this file:
//   GET  /api/retail/config            — public, storefront config
//   GET  /api/retail/products          — public, list (filters: q, category, sort, limit, offset)
//   GET  /api/retail/products/:id      — public, detail incl. options
//   POST /api/retail/auth              — wx.login code → openid → token
//   GET  /api/retail/customer          — token-auth'd, current profile
//
// Orders / payments routes land in follow-up commits.

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../database');
const inventory = require('../lib/inventory');
const geocode = require('../lib/geocode');
const tracking = require('../lib/tracking');
const flashsales = require('../lib/flashsales');
const { requireAuth, requirePermission, logActivity } = require('../middleware/auth');
const { getTenantDb, ROOTS_TENANT_ID, tenantAls, tdb, currentTenantId, DATA_ISOLATION_READY } = require('../lib/tenant-db');
const { getTenantCreds, setTenantSecrets, KEYS: CRED_KEYS } = require('../lib/tenant-creds');
// Web Push — optional; wrapped so a missing module never breaks order flow.
let _push = null;
try { _push = require('./push'); } catch (e) { console.warn('[retail] push module not available:', e.message); }
const _feie = require('../lib/feie');   // Feie cloud-printer client (order auto-print)
const qrpng = require('../lib/qrpng');  // zero-dep QR→PNG (renders the Alipay qr_code)
const router = express.Router();

// ── Public storefront per-tenant routing (Platform readiness ⑥) ───────────
// The customer mini-app sends its WeChat AppID in `x-wx-appid` on every call
// (see miniapp/utils/api.js). Map it to that tenant and run the rest of the
// request inside the tenant's DB context, so `tdb()` reaches the right data
// and `getTenantCreds(currentTenantId())` reaches the right login/Pay creds.
//
// Scope is ONLY the customer storefront (`/api/retail/`), NEVER the backend
// operator realm (`/api/retail-admin/`, which resolves its tenant via the
// session guard in requireRetailAdmin). Roots' own app sends Roots' AppID →
// tid 1 → getTenantDb(1) === mainDb, so Roots is byte-for-byte unchanged; a
// missing/unknown AppID, or a WeChat server-to-server callback (no header), →
// unscoped (Roots) as well. Gated by the same master switch as the backend
// data cut-over (⑧) so non-isolated environments stay single-tenant.
router.use((req, res, next) => {
  if (!DATA_ISOLATION_READY) return next();
  if (!req.path.startsWith('/api/retail/')) return next();
  const appid = req.get('x-wx-appid');
  if (!appid) return next();
  let row;
  try {
    row = db.prepare("SELECT id FROM tenants WHERE wx_appid = ? AND status = 'active'").get(appid);
  } catch (_) { return next(); }   // control-plane table not ready → unscoped (Roots)
  const tid = row && row.id;
  if (!tid || tid === ROOTS_TENANT_ID) return next();
  req.tenantId = tid;
  req.tenantDb = getTenantDb(tid);
  return tenantAls.run(req.tenantDb, () => next());
});

// Mini App Backend access gate. Two ways in during the single-tenant → SaaS
// transition:
//   (1) a Mini App Backend operator session (tenant_users), or
//   (2) the legacy path — a kitchen user carrying the `retail` permission.
// Backend operator sessions never set req.session.userId, so they're never
// mistaken for kitchen users; the kitchen path below is byte-for-byte the
// old behaviour, so Roots staff access is unchanged.
// Declared as a function (hoisted) so later sections can reference it before
// this point — same reason the previous const needed a comment.
const _retailKitchenPermission = requirePermission('retail');
function requireRetailAdmin(req, res, next) {
  // (1) Mini App Backend operator. Guarded so a not-yet-created tenant_users
  // table can never 500 the kitchen path — on any error we just fall through.
  if (req.session && req.session.backendUserId) {
    try {
      const u = db.prepare('SELECT * FROM tenant_users WHERE id = ? AND is_active = 1').get(req.session.backendUserId);
      if (u) {
        const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(u.tenant_id);
        if (tenant && tenant.status === 'active') {
          req.backendUser = u;
          req.tenant = tenant;
          // Admin write handlers below read req.user.id / req.user.username for
          // activity logging and created_by/updated_by columns. The kitchen path
          // sets req.user via requireAuth; the backend realm has no kitchen user,
          // so without a shim those handlers throw mid-request *after* the DB
          // mutation has already run (e.g. force-logout deletes the tokens, then
          // 500s on req.user.id — the client sees "failed" yet the customer is
          // logged out). Represent the operator faithfully so logging works.
          req.user = { id: u.id, username: u.username, role: u.role, display_name: u.display_name };
          // Per-tenant data connection (Phase 2 slice 2). Roots → global db;
          // other tenants → their own file. The request runs inside a tenant
          // ALS context so handlers reach the right connection via tdb();
          // control-plane reads above + logActivity stay on the global `db`.
          req.tenantDb = getTenantDb(tenant.id);
          return tenantAls.run(req.tenantDb, () => next());
        }
      }
    } catch (e) { /* tables not ready — fall through to the kitchen path */ }
  }
  // (2) legacy kitchen path: must be authed AND hold the `retail` permission.
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    _retailKitchenPermission(req, res, (err2) => {
      if (err2) return next(err2);
      req.tenantDb = getTenantDb(ROOTS_TENANT_ID);   // kitchen staff operate on Roots
      tenantAls.run(req.tenantDb, () => next());
    });
  });
}

// In-memory multer for image uploads — files small enough to base64 inline.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },  // 5MB hard ceiling
  fileFilter: (req, file, cb) => {
    if (!file.mimetype?.startsWith('image/')) return cb(new Error('not_an_image'));
    cb(null, true);
  },
});

// Separate, larger-ceiling uploader for the CMS video_banner block. Clips are
// meant to be short autoplay loops, not long-form video — so the cap stays
// modest (they're stored as a base64 blob in retail_media, same as images).
const uploadVideo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },  // 20MB — short autoplay clips only
  fileFilter: (req, file, cb) => {
    if (!file.mimetype?.startsWith('video/')) return cb(new Error('not_a_video'));
    cb(null, true);
  },
});

// Sniff the real image type from the first bytes instead of trusting the
// client-declared MIME. Returns a canonical mime ('image/jpeg' etc.) or null
// for anything unrecognized. SVG is deliberately NOT recognized: it's an XML
// document that can carry <script>, so we never store/serve it as an image.
function sniffImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'; // GIF8(7|9)a
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'image/bmp';
  if (buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&  // RIFF
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)  // WEBP
    return 'image/webp';
  return null;
}
// Sniff the real container from the first bytes. Only MP4/MOV (ISO-BMFF) is
// accepted: it's the one format the WeChat <video> component plays reliably.
// WebM/MKV is deliberately rejected — the mini app can't decode it, so a clip
// uploaded in that format would just show a black box on customers' phones.
function sniffVideoMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  // ISO Base Media File Format: bytes 4..7 spell 'ftyp'.
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'video/mp4';
  return null;
}
// Content-types the media route is allowed to serve inline. Anything else
// (notably SVG, HTML) is forced to download as an opaque blob so a browser
// can't execute it. PDF is here so issued fapiao render inline for staff.
const MEDIA_INLINE_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'application/pdf',
  'video/mp4',
]);

// ─── Storefront config ──────────────────────────────────────────────────
// Keys whose prefix is in this set are FILTERED OUT of the public
// /api/retail/config response — they hold third-party API secrets
// (kd100 key, JD app_secret, etc.) and must never reach the mini app.
const PRIVATE_CONFIG_PREFIXES = ['integrations.', 'printer.'];

function loadConfig() {
  const rows = tdb().prepare('SELECT key, value_json FROM storefront_config').all();
  const out = { version: 0 };
  for (const { key, value_json } of rows) {
    if (PRIVATE_CONFIG_PREFIXES.some(p => key.startsWith(p))) continue;
    let v; try { v = JSON.parse(value_json); } catch { v = value_json; }
    setPath(out, key.split('.'), v);
  }
  const t = tdb().prepare("SELECT COALESCE(MAX(strftime('%s', updated_at)), 0) AS t FROM storefront_config").get();
  out.version = Number(t?.t || 0);
  return out;
}
function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (cur[seg] == null || typeof cur[seg] !== 'object' || Array.isArray(cur[seg])) cur[seg] = {};
    cur = cur[seg];
  }
  cur[path[path.length - 1]] = value;
}

function parseJsonArray(s) {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

// Light sanitiser for operator-authored rich description HTML. WeChat's
// <rich-text> already ignores scripts/handlers, but we strip them server-side
// too so stored HTML is safe if ever rendered as innerHTML in the admin.
function sanitizeRichHtml(html) {
  if (typeof html !== 'string' || !html) return null;
  let s = html;
  s = s.replace(/<\s*(script|style|iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  s = s.replace(/<\s*(script|style|iframe|object|embed)\b[^>]*>/gi, '');
  s = s.replace(/\son\w+\s*=\s*"[^"]*"/gi, '');
  s = s.replace(/\son\w+\s*=\s*'[^']*'/gi, '');
  s = s.replace(/\son\w+\s*=\s*[^\s>]+/gi, '');
  s = s.replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2');
  s = s.trim();
  return s || null;
}

// Public product categories — same data as /api/categories/product (which
// is staff-only) but unauthenticated so the mini app + public preview can
// render category-tile labels without holding a session token.
router.get('/api/retail/categories', (req, res) => {
  const rows = tdb().prepare("SELECT id, name FROM categories WHERE kind = 'product' ORDER BY sort_order, name").all();
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ success: true, data: rows });
});

router.get('/api/retail/config', (req, res) => {
  try {
    const cfg = loadConfig();
    delete cfg.cms;  // internal namespace — never expose drafts to the mini app
    // ── CMS draft preview ─────────────────────────────────────────────
    // When a valid preview_token is in the query (minted from /cms via
    // POST /api/retail-admin/cms/preview-token), overlay draft layouts on
    // top of the live snapshot before responding. This is what lets the
    // mini app — launched from a preview QR or DevTools custom-compile —
    // render the unpublished draft on a real phone. Token-gated so casual
    // visitors of /api/retail/config never see unannounced drafts.
    const previewToken = req.query?.preview_token;
    if (previewToken && validatePreviewToken(previewToken)) {
      for (const page of ALLOWED_PAGES) {
        const r = tdb().prepare(
          'SELECT value_json FROM storefront_config WHERE key = ?'
        ).get(`cms.draft.${page}_layout`);
        if (!r) continue;
        let draft; try { draft = JSON.parse(r.value_json); } catch { continue; }
        if (!cfg[page] || typeof cfg[page] !== 'object') cfg[page] = {};
        cfg[page].layout = draft;
      }
      cfg._preview = true;
    }
    // Always surface review tags so the mini app's review form + product
    // cards have labels + colours even on fresh installs (before staff
    // has touched the Reviews editor).
    cfg.reviews = cfg.reviews || {};
    if (!Array.isArray(cfg.reviews.tags) || !cfg.reviews.tags.length) {
      cfg.reviews.tags = DEFAULT_REVIEW_TAGS;
    }
    // Same surface-with-defaults treatment for the Roots Club tier ladder.
    // Mini-app reads cfg.roots_club.tiers; we fall back to DEFAULT_ROOTS_CLUB_TIERS
    // so the Membership page always renders even before the admin saves.
    cfg.roots_club = cfg.roots_club || {};
    if (!Array.isArray(cfg.roots_club.tiers) || !cfg.roots_club.tiers.length) {
      cfg.roots_club.tiers = DEFAULT_ROOTS_CLUB_TIERS;
    }
    // Onboarding gating — show_to: 'new' (default, first-launch only),
    // 'version' (re-shows when admin bumps version), 'always' (every launch),
    // 'off' (never auto-redirect). version is the running counter the
    // mini-app stores in `onboarded` so a manual bump invalidates everyone.
    cfg.onboarding = cfg.onboarding || {};
    if (!ONBOARDING_MODES.has(cfg.onboarding.show_to)) cfg.onboarding.show_to = 'new';
    if (!Number.isFinite(cfg.onboarding.version) || cfg.onboarding.version < 1) {
      cfg.onboarding.version = 1;
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ success: true, data: cfg });
  } catch (e) {
    console.error('[retail/config]', e);
    res.status(500).json({ success: false, error: 'config_load_failed' });
  }
});

// Customer-facing location list for the bilingual address-area selector on
// checkout + the addresses page. Returns the SAME full set of cities + GZ
// districts that the admin delivery section lets you choose from (the
// china_regions catalogue), not just the zones added so far — operators add
// the actual deliverable cities over time, and the picker should already
// list them. Pricing is still gated by the zone matcher at /quote, so a city
// that isn't an active zone yet just won't resolve a fee/slot until added.
// Shaped to the columns the picker reads — never the fee/scheduling internals.
router.get('/api/retail/delivery-zones', (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ success: true, data: regionPickerRows() });
  } catch (e) {
    console.error('[retail/delivery-zones]', e);
    res.status(500).json({ success: false, error: 'zones_load_failed' });
  }
});

// Bilingual district list for one city — powers the English-mode address
// picker's city→district step (Chinese mode uses WeChat's native region
// picker, no data needed). Keyed by the catalogue city name_cn, e.g.
// ?city=北京市 → [{ name_cn:'朝阳区', name_en:'Chaoyang' }, ...]. Pricing is
// still gated by the zone matcher at /quote, same as the city list.
router.get('/api/retail/districts', (req, res) => {
  const city = String(req.query.city || '').trim();
  const list = (city && CHINA_DISTRICTS[city]) || [];
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ success: true, data: list });
});

// Store-pickup point list for checkout. Returns only stores flagged
// pickup_enabled AND is_active, plus the single global pickup window the
// storefront uses to build selectable time slots. The checkout Pickup tab
// shows nothing (and falls back to delivery-only) when this is empty.
router.get('/api/retail/pickup-stores', (req, res) => {
  try {
    const stores = tdb().prepare(
      `SELECT id, code, name_en, name_cn, address, city, district, lat, lng, phone
         FROM retail_stores
        WHERE is_active = 1 AND pickup_enabled = 1
        ORDER BY sort_order ASC, id ASC`
    ).all();
    const window = cfgValue('pickup.window', { open: '10:00', close: '20:00' });
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ success: true, data: { stores, window } });
  } catch (e) {
    console.error('[retail/pickup-stores]', e);
    res.status(500).json({ success: false, error: 'pickup_stores_load_failed' });
  }
});

// ─── Products ───────────────────────────────────────────────────────────
// Only published rows show. Customer-facing endpoint pulls from the SAME
// master product fields as the rest of the system — sell_price is the
// price, description_en/cn is the description. No duplicate retail-only
// columns to maintain. is_published is the only retail-specific gate.
const RETAIL_PRODUCT_COLS = `
  p.id, p.name_en, p.name_cn, p.sku, p.category, p.weight AS size, p.barcode,
  p.sell_price AS price,
  p.compare_at_price,
  -- Stock surfaced to the mini-app. Prefer the SUM of per-store physical_qty
  -- across ACTIVE stores (Tianhe + Yuexiu today) — that's the inventory the
  -- /retail-admin per-store grid actually edits. Fall back to the legacy
  -- products.stock_qty column ONLY when no per-store rows exist yet, so
  -- newly-added products that haven't been stocked per-store don't silently
  -- flip to OOS. When BOTH stores show 0 in the grid, this returns 0 →
  -- shop.js marks the row as outOfStock and the "in stock only" filter
  -- hides it.
  COALESCE(
    (SELECT SUM(rss.physical_qty)
       FROM retail_store_stock rss
       JOIN retail_stores      rs ON rs.id = rss.store_id
      WHERE rss.product_id = p.id AND rs.is_active = 1),
    p.stock_qty
  ) AS stock,
  p.sort_order AS display_order,
  p.description_en, p.description_cn, p.description_format,
  p.free_of, p.tags, p.image_data, p.image_url,
  p.nutrition,
  p.keywords_en, p.keywords_cn, p.tagline_en, p.tagline_cn,
  p.description_blocks, p.use_block_design,
  p.colophon_character, p.colophon_tagline_en, p.colophon_tagline_cn,
  p.flash_price, p.flash_starts_at, p.flash_ends_at,
  p.flash_stock_limit, p.flash_sold,
  p.variant_group_id, p.variant_label, p.variant_sort,
  p.updated_at
`;

// Parse JSON-string columns (nutrition, description_blocks) into objects for
// the client. Drops empty values to null so the mini-app can `wx:if` cleanly.
function hydrateNutrition(row) {
  if (!row) return row;
  if (typeof row.nutrition === 'string' && row.nutrition.trim()) {
    try {
      const n = JSON.parse(row.nutrition);
      row.nutrition = (n && (n.basis_en || n.basis_cn || (n.rows || []).length)) ? n : null;
    } catch { row.nutrition = null; }
  } else {
    row.nutrition = null;
  }
  if (typeof row.description_blocks === 'string' && row.description_blocks.trim()) {
    try {
      const b = JSON.parse(row.description_blocks);
      row.description_blocks = (Array.isArray(b) && b.length) ? b : null;
    } catch { row.description_blocks = null; }
  } else {
    row.description_blocks = null;
  }
  return row;
}

// "Buy together" bundle stored on a product. sanitizeBundle → a JSON string for
// the `bundle` column (or null to clear). resolveBundle → the customer shape,
// with each listed product expanded to a lightweight card (published + active
// only, in the operator's chosen order). There is NO bundle SKU: each item is a
// real product, so stock/price live on the items themselves.
function sanitizeBundle(input) {
  let v = input;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const ids = Array.isArray(v.ids) ? [...new Set(v.ids.map(n => parseInt(n, 10)).filter(Number.isFinite))] : [];
  if (!ids.length) return null;
  const title_en = (v.title_en ? String(v.title_en) : '').trim();
  const title_cn = (v.title_cn ? String(v.title_cn) : '').trim();
  const price = Math.max(0, parseFloat(v.price) || 0);
  const voucher = (v.voucher ? String(v.voucher) : '').trim();
  return JSON.stringify({ title_en: title_en || null, title_cn: title_cn || null, ids, price: price || 0, voucher: voucher || null });
}
// Product "badge" — the single NEW/POP/SALE/HOT chip the shop card shows. It
// lives in the products.tags column (the only consumer is pickBadge() in the
// mini-app shop page). The editor offers a fixed dropdown, so we allow-list the
// keyword and store it lowercase; anything unrecognised clears the badge.
const PRODUCT_BADGES = ['new', 'pop', 'sale', 'hot'];
function sanitizeProductBadge(v) {
  const t = String(v == null ? '' : v).trim().toLowerCase();
  return PRODUCT_BADGES.includes(t) ? t : null;
}
function resolveBundle(jsonStr) {
  if (typeof jsonStr !== 'string' || !jsonStr.trim()) return null;
  let b; try { b = JSON.parse(jsonStr); } catch { return null; }
  const ids = Array.isArray(b && b.ids) ? b.ids.map(n => parseInt(n, 10)).filter(Number.isFinite) : [];
  if (!ids.length) return null;
  const ph = ids.map(() => '?').join(',');
  const rows = tdb().prepare(
    `SELECT id, name_en, name_cn, sku, weight AS size, sell_price AS price, stock_qty AS stock,
            image_data, image_url
       FROM products
      WHERE id IN (${ph}) AND is_published = 1 AND COALESCE(is_active, 1) = 1`
  ).all(...ids);
  const byId = new Map(rows.map(r => [r.id, r]));
  const items = ids.map(i => byId.get(i)).filter(Boolean);   // keep chosen order
  if (!items.length) return null;
  return { title_en: b.title_en || null, title_cn: b.title_cn || null, price: Number(b.price) || 0, voucher: b.voucher || null, ids, items };
}

router.get('/api/retail/products', (req, res) => {
  const { q, category, sort } = req.query;
  const limit  = Math.min(parseInt(req.query.limit  || '50', 10) || 50, 100);
  const offset = Math.max(parseInt(req.query.offset || '0',  10) || 0, 0);

  let sql = `SELECT ${RETAIL_PRODUCT_COLS}, p.updated_at FROM products p
             WHERE p.is_published = 1 AND COALESCE(p.is_active, 1) = 1`;
  const params = [];
  if (q) {
    sql += ' AND (p.name_en LIKE ? OR p.name_cn LIKE ? OR p.sku LIKE ?)';
    const s = `%${q}%`; params.push(s, s, s);
  }
  if (category) { sql += ' AND p.category = ?'; params.push(category); }

  // Sort: 'price_asc' | 'price_desc' | 'newest' | 'popular' | 'featured' (default → curated sort_order)
  // 'popular' has no sales metric yet, so it maps to featured for now.
  if (sort === 'price_asc')       sql += ' ORDER BY p.sell_price ASC';
  else if (sort === 'price_desc') sql += ' ORDER BY p.sell_price DESC';
  else if (sort === 'newest')     sql += ' ORDER BY p.created_at DESC';
  else                             sql += ' ORDER BY p.sort_order ASC, p.name_en ASC';

  sql += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const now = Date.now();
  const rows = tdb().prepare(sql).all(...params)
    .map(hydrateNutrition)
    .map(r => flashsales.decorateProduct(r, now));
  // Replace the heavy inline base64 primary photo with a tiny streamed-image
  // URL the mini-app lazy-loads + caches — mirrors the retail-admin grid fix
  // (see GET /api/retail-admin/products). Shipping image_data inline for up to
  // 50 rows made this payload several MB and the shop slow to open. Products
  // that store only a plain image_url keep it untouched; ?v=updated_at busts
  // the cache when the photo changes. The PDP (/products/:id) still ships the
  // full image so the detail page renders without an extra round-trip.
  //
  // We emit ABSOLUTE URLs (not /api/...) so the live mini-app — which doesn't
  // run absUrl() on the image_data fallback yet (that needs a WeChat publish) —
  // still renders thumbnails for products that only have a base64 photo. The
  // mini-app needs an http(s) URL in <image src>; a relative path won't load.
  // trust-proxy is on (server.js) so req.protocol respects X-Forwarded-Proto.
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  for (const r of rows) {
    if (typeof r.image_data === 'string' && /^data:/i.test(r.image_data)) {
      r.image_data = `${baseUrl}/api/retail/products/${r.id}/image?v=${encodeURIComponent(r.updated_at || '')}`;
    }
    delete r.updated_at;
  }
  attachSoldCounts(rows);
  const total = tdb().prepare(`SELECT COUNT(*) AS n FROM products p
                            WHERE p.is_published = 1 AND COALESCE(p.is_active, 1) = 1
                            ${q ? 'AND (p.name_en LIKE ? OR p.name_cn LIKE ? OR p.sku LIKE ?)' : ''}
                            ${category ? 'AND p.category = ?' : ''}`)
    .get(...(q ? [`%${q}%`,`%${q}%`,`%${q}%`] : []), ...(category ? [category] : [])).n;

  // Short cache — flash-sale windows mean the response goes stale in
  // minutes, not the prior 30s used for static catalogue data.
  res.set('Cache-Control', 'public, max-age=10');
  res.json({ success: true, data: rows, meta: { total, limit, offset, server_time_ms: now } });
});

// GET /api/retail/products/:id/image — public: stream a product's primary
// photo as real image bytes so the shop-list payload can ship a tiny URL per
// row instead of an inline base64 blob (see GET /api/retail/products above).
// image_data is a data: URI — decode and send with a long cache window
// (?v=updated_at busts it when the photo changes). Plain-URL images redirect.
// Only published + active products are exposed. This is the public twin of
// /api/retail-admin/products/:id/image (no auth, public cache).
router.get('/api/retail/products/:id/image', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).end();
  const row = tdb().prepare(
    `SELECT image_data FROM products
      WHERE id = ? AND is_published = 1 AND COALESCE(is_active, 1) = 1`
  ).get(id);
  const data = row && row.image_data;
  if (!data) return res.status(404).end();
  const m = /^data:([^;,]*?)(;base64)?,([\s\S]*)$/.exec(data);
  if (!m) return res.redirect(String(data));
  const mime = m[1] || 'application/octet-stream';
  const buf  = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  res.set('Content-Type', mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(buf);
});

// GET /api/retail/products/:productId/substitute-options?store_id=N
// Used by the mini-app's "Replace missing item" sub-screen. Returns
// in-stock candidates at the given store: admin-curated substitutes
// first, then auto-fill from same category. Requires retail-customer
// auth (Bearer token in Authorization).
router.get('/api/retail/products/:productId/substitute-options', requireRetailAuth, (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  const storeId   = parseInt(req.query.store_id, 10);
  if (!productId || !storeId) return res.status(400).json({ success: false, error: 'missing_params' });
  const rows = inventory.substitutesForProduct({ productId, storeId, channel: 'wechat', limit: 20 });
  res.json({ success: true, data: rows });
});

// ─── Top-selling products (homepage / "best sellers" block) ──────────────
// MUST be declared before `/api/retail/products/:id` — Express matches in
// order, and `:id` would otherwise capture `top` and return bad_id.
// Feeds product_grid blocks whose source_type === 'top_selling'.
//
//   ?channel=combined|retail|kitchen  default: combined
//     combined — mini-app retail orders + in-store sales_entries (default)
//     retail   — mini-app orders only
//     kitchen  — in-store POS sales only
//   ?window=7d|30d|90d|all  default: 7d
//   ?limit=N (1..24)        default: 6
//
// 5-min in-process cache keyed by (channel, window, limit).
const TOP_PRODUCT_CACHE = new Map();
const TOP_PRODUCT_TTL_MS = 5 * 60 * 1000;

router.get('/api/retail/products/top', (req, res) => {
  const channel = ['combined', 'retail', 'kitchen'].includes(req.query.channel)
    ? req.query.channel : 'combined';
  const windowSpec = ['7d', '30d', '90d', 'all'].includes(req.query.window)
    ? req.query.window : '7d';
  const limit = Math.max(1, Math.min(24, parseInt(req.query.limit || '6', 10) || 6));

  const cacheKey = `${channel}|${windowSpec}|${limit}`;
  const cached = TOP_PRODUCT_CACHE.get(cacheKey);
  const now = Date.now();
  if (cached && (now - cached.t) < TOP_PRODUCT_TTL_MS) {
    res.set('Cache-Control', 'public, max-age=60');
    return res.json({ success: true, data: cached.data, meta: { ...cached.meta, cached: true } });
  }

  let retailRows = [];
  let kitchenRows = [];
  if (channel === 'retail' || channel === 'combined') {
    try {
      const retailWindow = windowSpec === 'all' ? '' :
        `AND o.paid_at >= datetime('now', '-${parseInt(windowSpec, 10) || 7} days')`;
      retailRows = tdb().prepare(`
        SELECT oi.product_id AS product_id,
               SUM(oi.qty)   AS units_sold,
               SUM(oi.line_total) AS revenue
          FROM retail_order_items oi
          JOIN retail_orders o ON o.id = oi.order_id
         WHERE o.paid_at IS NOT NULL
           AND o.status NOT IN ('cancelled', 'refunded', 'pending_payment')
           AND oi.product_id IS NOT NULL
           ${retailWindow}
         GROUP BY oi.product_id
      `).all();
    } catch (e) {
      console.error('[top-products retail]', e.message);
    }
  }
  if (channel === 'kitchen' || channel === 'combined') {
    try {
      const kitchenWindow = windowSpec === 'all' ? '' :
        `AND s.date >= date('now', '-${parseInt(windowSpec, 10) || 7} days')`;
      kitchenRows = tdb().prepare(`
        SELECT s.product_id AS product_id,
               SUM(s.qty)   AS units_sold,
               SUM(s.total) AS revenue
          FROM sales_entries s
         WHERE s.product_id IS NOT NULL
           ${kitchenWindow}
         GROUP BY s.product_id
      `).all();
    } catch (e) {
      console.error('[top-products kitchen]', e.message);
    }
  }
  // Merge per-product totals across channels.
  const merged = new Map();
  for (const r of retailRows) {
    merged.set(r.product_id, { units: Number(r.units_sold) || 0, revenue: Number(r.revenue) || 0 });
  }
  for (const r of kitchenRows) {
    const prev = merged.get(r.product_id) || { units: 0, revenue: 0 };
    prev.units   += Number(r.units_sold) || 0;
    prev.revenue += Number(r.revenue)    || 0;
    merged.set(r.product_id, prev);
  }

  const ranked = [...merged.entries()]
    .map(([id, v]) => ({ id, units: v.units, revenue: v.revenue }))
    .sort((a, b) => b.units - a.units);

  // Over-fetch products and filter by published/active to handle delistings.
  const candidateIds = ranked.slice(0, limit * 3).map(r => r.id);
  let products = [];
  if (candidateIds.length) {
    const placeholders = candidateIds.map(() => '?').join(',');
    products = tdb().prepare(
      `SELECT ${RETAIL_PRODUCT_COLS} FROM products p
        WHERE p.id IN (${placeholders})
          AND p.is_published = 1 AND COALESCE(p.is_active, 1) = 1`
    ).all(...candidateIds);
  }
  const productsById = new Map(products.map(p => [p.id, p]));
  const out = [];
  for (const r of ranked) {
    if (out.length >= limit) break;
    const p = productsById.get(r.id);
    if (!p) continue;
    const decorated = flashsales.decorateProduct(hydrateNutrition(p), now);
    decorated.units_sold = Math.round(r.units);
    decorated.revenue    = Math.round(r.revenue * 100) / 100;
    out.push(decorated);
  }
  const meta = {
    channel, window: windowSpec, limit,
    total_candidates: ranked.length,
    server_time_ms: now,
    cached: false,
  };
  TOP_PRODUCT_CACHE.set(cacheKey, { t: now, data: out, meta });
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ success: true, data: out, meta });
});

// ── Social proof ("N people bought this …") ────────────────────────────────
// Real-data nudge for the product page. We count DISTINCT buyers (real sales
// only) across widening windows and surface the NARROWEST window that clears a
// minimum bar — so a hot product reads "today", a slower one falls back to
// week / month / all-time, and a product no one has bought shows nothing
// (never a fabricated or zero count). Day boundary is HK-local (+8h) to match
// the retail-admin dashboard. Cached briefly since the product detail route is
// hit on every product open.
const SOCIAL_PROOF_TTL_MS = 90 * 1000;
const SOCIAL_PROOF_CACHE  = new Map();   // product_id → { t, value }
const SOCIAL_PROOF_WINDOWS = [
  ['today', 'c_today'], ['week', 'c_week'], ['month', 'c_month'], ['all', 'c_all'],
];
const SOCIAL_PROOF_PAID =
  "o.status IN ('paid','preparing','dispatched','delivered','awaiting_restock')";

// ── Tenant-tunable social-proof config ─────────────────────────────────────
// Each of the 5 social-proof widgets has an on/off toggle + tuning knobs the
// mini-app backend can edit (retail-admin → Settings → Social proof). Stored as
// a single JSON blob under storefront_config['social_proof']; missing keys fall
// back to the DEFAULTS below (which match the original hardcoded constants, so
// behaviour is identical until an operator changes a value).
// Fake-data overrides per widget. `boost_min`/`boost_max` define a range; each
// product picks a stable value inside it via productHash(id), so no two
// products show identical fake counts. Old single-value `boost` (and
// `fallback_minutes` for last_ordered) is still honoured as a back-compat
// default — operators who saved a flat number before keep the same behaviour
// until they widen the range. All fakes are opt-in and default to 0 / [] —
// leaving them alone preserves the original "real data only" behaviour.
const SOCIAL_PROOF_DEFAULTS = Object.freeze({
  bought_count:  { enabled: true, min_today: 2, min_week: 2, min_month: 1, min_all: 2, boost_min: 0, boost_max: 0 },
  recent_buyers: { enabled: true, window_days: 7, manual: [] },
  viewing_now:   { enabled: true, ttl_sec: 45, boost_min: 0, boost_max: 0 },
  last_ordered:  { enabled: true, max_hours: 24, fallback_min_minutes: 0, fallback_max_minutes: 0 },
  sold_badge:    { enabled: true, min_units: 3, boost_min: 0, boost_max: 0 },
});
function getSocialConfig() {
  let cfg = SOCIAL_PROOF_DEFAULTS;
  try {
    const row = tdb().prepare(
      "SELECT value_json FROM storefront_config WHERE key = 'social_proof'"
    ).get();
    if (row && row.value_json) {
      const p = JSON.parse(row.value_json) || {};
      cfg = {
        bought_count:  { ...SOCIAL_PROOF_DEFAULTS.bought_count,  ...(p.bought_count  || {}) },
        recent_buyers: { ...SOCIAL_PROOF_DEFAULTS.recent_buyers, ...(p.recent_buyers || {}) },
        viewing_now:   { ...SOCIAL_PROOF_DEFAULTS.viewing_now,   ...(p.viewing_now   || {}) },
        last_ordered:  { ...SOCIAL_PROOF_DEFAULTS.last_ordered,  ...(p.last_ordered  || {}) },
        sold_badge:    { ...SOCIAL_PROOF_DEFAULTS.sold_badge,    ...(p.sold_badge    || {}) },
      };
    }
  } catch (e) { console.error('[social-cfg]', e.message); }
  return cfg;
}

// Stable hash for picking per-product fake values. FNV-1a over the stringified
// id — same product always lands on the same number inside a given range, so a
// returning customer sees consistent counts. Returns an unsigned 32-bit int.
function productHash(id) {
  let h = 2166136261;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
// Pick a number in [min, max] using a deterministic seed. min === max → flat.
function pickInRange(seed, min, max) {
  const lo = Math.max(0, Math.floor(min));
  const hi = Math.max(lo, Math.floor(max));
  if (hi === lo) return lo;
  return lo + (seed % (hi - lo + 1));
}
// Pull a range out of a widget config, falling back to the old single-value
// fields so configs saved before the range rollout still work.
function readBoostRange(cfg) {
  const legacy = Number(cfg.boost) || 0;
  const min = Number(cfg.boost_min ?? legacy) || 0;
  const max = Number(cfg.boost_max ?? legacy) || 0;
  return { min: Math.max(0, min), max: Math.max(min, max) };
}
function readFallbackRange(cfg) {
  const legacy = Number(cfg.fallback_minutes) || 0;
  const min = Number(cfg.fallback_min_minutes ?? legacy) || 0;
  const max = Number(cfg.fallback_max_minutes ?? legacy) || 0;
  return { min: Math.max(0, min), max: Math.max(min, max) };
}

// Catalogue "X SOLD" badge. Attaches all-time paid units per product to the
// list response so shop + home cards can flaunt popularity. Gated to a minimum
// so low-sellers stay neutral (no badge) rather than advertising a weak count.
// Threshold + on/off live in storefront_config['social_proof'].sold_badge
// (see getSocialConfig); the constant below is just the fallback default.
function attachSoldCounts(rows) {
  if (!rows || !rows.length) return;
  const sb = getSocialConfig().sold_badge;
  // Feature disabled → zero out so the mini-app hides the "X SOLD" cap on
  // every card without needing a republish.
  if (!sb.enabled) { for (const r of rows) r.units_sold = 0; return; }
  const minUnits = Math.max(1, Number(sb.min_units) || 1);
  const boostR   = readBoostRange(sb);
  try {
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const counts = tdb().prepare(`
      SELECT oi.product_id AS pid, SUM(oi.qty) AS units
        FROM retail_order_items oi
        JOIN retail_orders o ON o.id = oi.order_id
       WHERE oi.product_id IN (${placeholders})
         AND ${SOCIAL_PROOF_PAID}
       GROUP BY oi.product_id
    `).all(...ids);
    const map = new Map(counts.map(c => [c.pid, Math.round(Number(c.units) || 0)]));
    for (const r of rows) {
      // Real + per-product boost from the configured range. Stable hash =
      // same product reads the same number across requests, but two products
      // won't show identical fake counts. Gate by min_units against the
      // COMBINED number so a non-zero boost can lift zero-real products.
      const boost = pickInRange(productHash(r.id), boostR.min, boostR.max);
      const display = (map.get(r.id) || 0) + boost;
      r.units_sold = display >= minUnits ? display : 0;
    }
  } catch (e) {
    console.error('[sold-counts]', e.message);
  }
}

function socialProofForProduct(id) {
  const now = Date.now();
  const cached = SOCIAL_PROOF_CACHE.get(id);
  if (cached && (now - cached.t) < SOCIAL_PROOF_TTL_MS) return cached.value;

  const cfg = getSocialConfig();
  const bc  = cfg.bought_count;
  const lo  = cfg.last_ordered;
  // Both halves of the payload are off → skip the query entirely. The
  // mini-app already hides the product-page nudge when this is null.
  if (!bc.enabled && !lo.enabled) {
    SOCIAL_PROOF_CACHE.set(id, { t: now, value: null });
    return null;
  }
  const mins = {
    today: Math.max(1, Number(bc.min_today) || 1),
    week:  Math.max(1, Number(bc.min_week)  || 1),
    month: Math.max(1, Number(bc.min_month) || 1),
    all:   Math.max(1, Number(bc.min_all)   || 1),
  };
  // Per-product boost from configured range — same product always shows the
  // same fake count, but two products won't collide on the same number.
  const seed = productHash(id);
  const bcRange = readBoostRange(bc);
  const bcBoost = pickInRange(seed, bcRange.min, bcRange.max);
  const maxAgeMs = Math.max(1, Number(lo.max_hours) || 1) * 3600 * 1000;
  // Last-ordered fallback also picks a per-product time inside the range, so
  // every product doesn't read "ordered exactly 15 min ago".
  const loRange = readFallbackRange(lo);
  const loFallbackMin = pickInRange(seed, loRange.min, loRange.max);
  const loFallbackMs = loFallbackMin * 60 * 1000;

  let value = null;
  try {
    const row = tdb().prepare(`
      SELECT
        COUNT(DISTINCT CASE WHEN date(o.placed_at, '+8 hours') = date('now', '+8 hours')
                            THEN o.customer_id END) AS c_today,
        COUNT(DISTINCT CASE WHEN o.placed_at >= datetime('now', '-7 days')
                            THEN o.customer_id END) AS c_week,
        COUNT(DISTINCT CASE WHEN o.placed_at >= datetime('now', '-30 days')
                            THEN o.customer_id END) AS c_month,
        COUNT(DISTINCT o.customer_id) AS c_all,
        MAX(o.placed_at) AS last_order
        FROM retail_order_items oi
        JOIN retail_orders o ON o.id = oi.order_id
       WHERE oi.product_id = ?
         AND ${SOCIAL_PROOF_PAID}
    `).get(id);
    // We still want to evaluate even when the row is empty (boost / fallback
    // can produce a non-empty payload on a zero-real product).
    const safeRow = row || { c_today: 0, c_week: 0, c_month: 0, c_all: 0, last_order: null };
    let count = 0, window = null;
    if (bc.enabled) {
      for (const [w, col] of SOCIAL_PROOF_WINDOWS) {
        // Real + boost, then gate by the min for that window. Boost applies
        // to every window equally, so a high boost lands in "today".
        const effective = (Number(safeRow[col]) || 0) + bcBoost;
        if (effective >= mins[w]) { count = effective; window = w; break; }
      }
    }
    let last_order_ms = null;
    if (lo.enabled) {
      if (safeRow.last_order) {
        const parsed = Date.parse(String(safeRow.last_order).replace(' ', 'T') + 'Z') || null;
        // Cap by max_hours: anything older than the cutoff is dropped so the
        // mini-app's "last ordered X ago" line stays hidden automatically.
        if (parsed && (now - parsed) <= maxAgeMs) last_order_ms = parsed;
      }
      // Fallback fake freshness: if real is missing or older than the
      // configured fallback window, show a synthetic "ordered N min ago".
      // Real wins when it's fresher, so as orders come in the line stays
      // truthful instead of stalling on the fake value.
      if (loFallbackMs > 0) {
        const fake = now - loFallbackMs;
        if (last_order_ms == null || last_order_ms < fake) last_order_ms = fake;
      }
    }
    if (count > 0 || window || last_order_ms != null) {
      value = { count, window, last_order_ms };
    }
  } catch (e) {
    console.error('[social-proof]', e.message);
  }
  SOCIAL_PROOF_CACHE.set(id, { t: now, value });
  return value;
}

router.get('/api/retail/products/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'bad_id' });

  const product = flashsales.decorateProduct(hydrateNutrition(tdb().prepare(
    `SELECT ${RETAIL_PRODUCT_COLS} FROM products p
     WHERE p.id = ? AND p.is_published = 1 AND COALESCE(p.is_active, 1) = 1`
  ).get(id)));
  if (!product) return res.status(404).json({ success: false, error: 'not_found' });

  // Lazy hero image — strip the inline base64 (typically 150–300 KB per row)
  // and replace it with a URL the mini-app fetches separately. The image
  // route is `public, immutable, max-age=1y`, and we cache-bust via
  // ?v=updated_at so editor saves invalidate the cached copy. Mini-app
  // product.js already prefers `image_url || image_data`, so this is
  // transparent for products that already had an external image_url set.
  if (product.image_data && !product.image_url) {
    product.image_url = `/api/retail/products/${id}/image?v=${encodeURIComponent(product.updated_at || '')}`;
  }
  product.image_data = null;

  // Photo gallery — extra images beyond the primary. Fetched here (detail
  // only) so the shop-list payload stays small. [0] mirrors image_data.
  const imgRow = tdb().prepare('SELECT images FROM products WHERE id = ?').get(id);
  product.images = parseJsonArray(imgRow && imgRow.images);

  // Review summary — avg rating + count + 3 most recent visible reviews.
  const summary = tdb().prepare(
    'SELECT AVG(rating) AS avg, COUNT(*) AS count FROM retail_reviews WHERE product_id = ? AND is_visible = 1'
  ).get(id);
  product.review_count = summary.count || 0;
  product.review_avg   = summary.count ? Number((summary.avg || 0).toFixed(2)) : 0;
  product.reviews_recent = tdb().prepare(
    `SELECT r.id, r.rating, r.comment, r.created_at, r.tags_json, r.photos_json,
            c.nickname AS customer_name, c.avatar_url AS customer_avatar
       FROM retail_reviews r
  LEFT JOIN retail_customers c ON c.id = r.customer_id
      WHERE r.product_id = ? AND r.is_visible = 1
      ORDER BY r.created_at DESC LIMIT 3`
  ).all(id).map(r => ({
    ...r,
    tags:   parseJsonArray(r.tags_json),
    photos: parseJsonArray(r.photos_json),
    tags_json: undefined, photos_json: undefined,
  }));

  const options = tdb().prepare(
    `SELECT id, question_en, question_cn, type, is_required, sort_order
       FROM retail_product_options WHERE product_id = ?
      ORDER BY sort_order ASC, id ASC`
  ).all(id);
  // NB: retail_product_options table is still used for per-product Q&A
  // (size, cutlery, etc.) — those aren't price/description duplicates,
  // they're genuinely retail-only customer choices, so they stay.
  const optionIds = options.map(o => o.id);
  const choicesByOpt = {};
  if (optionIds.length) {
    const placeholders = optionIds.map(() => '?').join(',');
    const choices = tdb().prepare(
      `SELECT id, option_id, label_en, label_cn, price_delta, is_default, sort_order
         FROM retail_product_option_choices
        WHERE option_id IN (${placeholders})
        ORDER BY sort_order ASC, id ASC`
    ).all(...optionIds);
    for (const c of choices) (choicesByOpt[c.option_id] ||= []).push(c);
  }
  product.options = options.map(o => ({ ...o, choices: choicesByOpt[o.id] || [] }));

  // Variant siblings — every purchasable product in the same variant_group_id
  // (includes this one, so the app highlights the current pick). Powers the
  // product-page variant switcher. Only published + active members show; the
  // app hides the switcher when there's 0–1 member.
  if (product.variant_group_id) {
    const nowMs = Date.now();
    // Variant siblings: drop inline image_data (each base64 hero adds
    // 150–300 KB to the JSON; 5 variants = ~1 MB wasted on a single
    // product detail load). We only need a flag for whether the row has
    // a stored image so we can emit a lazy URL; the real bytes stream
    // via /api/retail/products/:id/image, same as the main hero above.
    product.variants = tdb().prepare(
      `SELECT p.id, p.variant_label, p.name_en, p.name_cn, p.sku, p.weight AS size,
              p.sell_price AS price,
              p.flash_price, p.flash_starts_at, p.flash_ends_at,
              p.flash_stock_limit, p.flash_sold,
              p.image_url, p.updated_at,
              (p.image_data IS NOT NULL AND p.image_data != '') AS has_image,
              COALESCE(
                (SELECT SUM(rss.physical_qty) FROM retail_store_stock rss
                   JOIN retail_stores rs ON rs.id = rss.store_id
                  WHERE rss.product_id = p.id AND rs.is_active = 1),
                p.stock_qty
              ) AS stock
         FROM products p
        WHERE p.variant_group_id = ? AND p.is_published = 1 AND COALESCE(p.is_active, 1) = 1
        ORDER BY COALESCE(p.variant_sort, 0), COALESCE(p.variant_label, p.name_en), p.id`
    ).all(product.variant_group_id).map(v => {
      if (v.has_image && !v.image_url) {
        v.image_url = `/api/retail/products/${v.id}/image?v=${encodeURIComponent(v.updated_at || '')}`;
      }
      delete v.has_image;
      delete v.updated_at;
      return flashsales.decorateProduct(v, nowMs);
    });
  } else {
    product.variants = [];
  }

  // "Buy together" bundle — resolved to item cards (each its own product/stock).
  const bundleRow = tdb().prepare('SELECT bundle FROM products WHERE id = ?').get(id);
  product.bundle = resolveBundle(bundleRow && bundleRow.bundle);

  product.social_proof = socialProofForProduct(id);

  res.set('Cache-Control', 'public, max-age=10');
  res.json({ success: true, data: product });
});

// ── Recent-buyers ticker feed ──────────────────────────────────────────────
// Powers the live "李** just bought X" toast that cycles on the home page.
// Real recent orders only; buyer names are masked here (first char + dots) so
// no full name leaves the server. One representative product per order, newest
// first, capped to a recent window so the feed reads "live" not stale. 60s
// cache — the feed is identical for every visitor.
function maskBuyerName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const first = [...s][0];
  // CJK given names: keep the surname/first glyph, mask the rest.
  if (/[一-鿿぀-ヿ가-힯]/.test(first)) return first + '**';
  return first.toUpperCase() + '***';
}

const RECENT_BUYERS_TTL_MS = 60 * 1000;
// Cache keyed by window_days so tuning the slider invalidates only the slice
// that changed; default to one bucket per process.
const RECENT_BUYERS_CACHE = new Map();   // window_days → { t, value }

router.get('/api/retail/social/recent-buyers', (req, res) => {
  const cfg = getSocialConfig().recent_buyers;
  // Feature off → return an empty feed immediately so the mini-app ticker
  // collapses to nothing without a republish.
  if (!cfg.enabled) {
    res.set('Cache-Control', 'public, max-age=30');
    return res.json({ success: true, data: [] });
  }
  const windowDays = Math.max(1, Math.min(60, Number(cfg.window_days) || 7));
  const manualEntries = Array.isArray(cfg.manual) ? cfg.manual : [];
  const now = Date.now();
  // Cache key must include the manual list signature so editing fake entries
  // shows up on next reload instead of being shadowed by the cached real-only
  // payload. Cheap fingerprint = count + last-modified-style hash of fields.
  const manualFp = manualEntries.length
    ? manualEntries.length + ':' + manualEntries.map(m => (m.name || '') + '|' + (m.minutes_ago || 0)).join(',')
    : '0';
  const cacheKey = windowDays + '@' + manualFp;
  const cached = RECENT_BUYERS_CACHE.get(cacheKey);
  if (cached && (now - cached.t < RECENT_BUYERS_TTL_MS)) {
    res.set('Cache-Control', 'public, max-age=30');
    return res.json({ success: true, data: cached.value });
  }

  let real = [];
  try {
    const rows = tdb().prepare(`
      SELECT o.id, o.placed_at,
             COALESCE(NULLIF(TRIM(c.nickname), ''), o.recipient_name) AS buyer,
             (SELECT oi.name_en FROM retail_order_items oi
               WHERE oi.order_id = o.id ORDER BY oi.id LIMIT 1) AS p_en,
             (SELECT oi.name_cn FROM retail_order_items oi
               WHERE oi.order_id = o.id ORDER BY oi.id LIMIT 1) AS p_cn
        FROM retail_orders o
        LEFT JOIN retail_customers c ON c.id = o.customer_id
       WHERE ${SOCIAL_PROOF_PAID}
         AND o.placed_at >= datetime('now', '-${windowDays} days')
       ORDER BY o.placed_at DESC
       LIMIT 20
    `).all();
    real = rows
      .filter(r => r.p_en || r.p_cn)
      .map(r => ({
        name:       maskBuyerName(r.buyer),
        product_en: r.p_en || r.p_cn || '',
        product_cn: r.p_cn || r.p_en || '',
        ts: Date.parse(String(r.placed_at).replace(' ', 'T') + 'Z') || null,
      }))
      .filter(r => r.ts);
  } catch (e) {
    console.error('[recent-buyers]', e.message);
  }

  // Merge manual fakes. Each entry: { name, product_en, product_cn, minutes_ago }.
  // Names are pre-masked by the operator (they type "李**") so we don't run them
  // through maskBuyerName. We add a per-entry stable jitter (±4 min) to the
  // configured minutes_ago so two entries the operator set to "5 min ago" don't
  // both render at literally "5 min ago" — that's the dead giveaway. Jitter is
  // seeded by the entry's name+product so a given fake row is consistent
  // across requests (won't flicker), but unique relative to its siblings.
  const fakes = manualEntries
    .filter(m => m && (m.product_en || m.product_cn) && m.name)
    .map(m => {
      const base    = Math.max(0, Math.min(60 * 24 * 60, Number(m.minutes_ago) || 0));
      const seed    = productHash(String(m.name) + '|' + String(m.product_en || m.product_cn || ''));
      const jitter  = (seed % 9) - 4;                     // -4 .. +4 minutes
      const minutes = Math.max(1, base + jitter);
      return {
        name:       String(m.name).slice(0, 40),
        product_en: String(m.product_en || m.product_cn || '').slice(0, 80),
        product_cn: String(m.product_cn || m.product_en || '').slice(0, 80),
        ts: now - minutes * 60 * 1000,
      };
    });

  // Newest first, capped at 20 so the ticker stays snappy.
  const out = [...real, ...fakes]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 20);

  RECENT_BUYERS_CACHE.set(cacheKey, { t: now, value: out });
  res.set('Cache-Control', 'public, max-age=30');
  res.json({ success: true, data: out });
});

// ── "N viewing now" presence ────────────────────────────────────────────────
// Live concurrent-viewer count per product. Pure in-memory (no DB writes): the
// product page heartbeats every ~25s while open and once with { leaving:true }
// on exit; a viewer counts as present if seen within VIEW_TTL_MS. Keyed by the
// mini-app's per-launch session id so repeat pings from one client dedupe.
// Ephemeral by design — a PM2 restart just resets it and clients re-register on
// their next heartbeat. Assumes a single app instance (this PM2 fork is one).
const VIEWING = new Map();   // product_id → Map<viewerKey, lastSeenMs>
const VIEW_TTL_MS = 45 * 1000;
// Hard cap on tracked viewers per product. Bounds memory and stops a client
// spamming distinct viewer_ids from inflating the "N viewing now" badge — past
// the cap we only refresh existing keys, never add new ones.
const MAX_VIEWERS_PER_PRODUCT = 500;

function pruneAllViewers(now) {
  // Read the live TTL so an admin who widens "viewing now" past the 45s
  // default doesn't have entries swept out from under the next heartbeat.
  // Falls back to VIEW_TTL_MS (the safety baseline) if the config call throws.
  let ttlMs = VIEW_TTL_MS;
  try {
    const v = getSocialConfig().viewing_now;
    ttlMs = Math.max(5, Math.min(600, Number(v.ttl_sec) || 45)) * 1000;
  } catch { /* keep default */ }
  for (const [pid, viewers] of VIEWING) {
    for (const [k, ts] of viewers) if (now - ts > ttlMs) viewers.delete(k);
    if (viewers.size === 0) VIEWING.delete(pid);
  }
}
const _viewSweep = setInterval(() => pruneAllViewers(Date.now()), 60 * 1000);
if (_viewSweep.unref) _viewSweep.unref();

router.post('/api/retail/products/:id/viewing', express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'bad_id' });
  const vn = getSocialConfig().viewing_now;
  // Feature off → don't track and don't reveal counts. count:0 forces the
  // mini-app's "N viewing" gate (≥2) to hide the badge automatically.
  if (!vn.enabled) {
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, data: { count: 0 } });
  }
  const ttlMs = Math.max(5, Math.min(600, Number(vn.ttl_sec) || 45)) * 1000;
  const now = Date.now();
  const b = req.body || {};
  // Stable per-client key (the mini-app's per-launch session id); fall back to
  // IP + UA so anonymous clients without one still dedupe roughly.
  const vid = (b.viewer_id ? String(b.viewer_id).slice(0, 64) : '')
            || ((req.ip || '') + '|' + String(req.get('user-agent') || '').slice(0, 40));

  let viewers = VIEWING.get(id);
  if (!viewers) { viewers = new Map(); VIEWING.set(id, viewers); }
  if (b.leaving) viewers.delete(vid);
  // Refresh known viewers always; only admit a NEW key while under the cap.
  else if (viewers.has(vid) || viewers.size < MAX_VIEWERS_PER_PRODUCT) viewers.set(vid, now);
  for (const [k, ts] of viewers) if (now - ts > ttlMs) viewers.delete(k);
  if (viewers.size === 0) VIEWING.delete(id);

  // Per-product boost from the configured range — different products land on
  // different fake counts via productHash(id). On top of that, a slow time
  // jitter (±20% every ~10s) makes the number drift live-style instead of
  // staying glued to a single value across heartbeats. Range collapsed to a
  // single value (min === max) still gets the jitter so it doesn't look static.
  const bRange = readBoostRange(vn);
  let boost = pickInRange(productHash(id), bRange.min, bRange.max);
  if (boost > 0) {
    const timeBucket = Math.floor(now / 10000);            // 10s buckets
    const driftSeed  = (productHash(id) ^ timeBucket) >>> 0;
    const driftPct   = ((driftSeed % 41) - 20) / 100;      // -20% .. +20%
    boost = Math.max(0, Math.round(boost * (1 + driftPct)));
  }
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: { count: viewers.size + boost } });
});

// Active + upcoming flash sales — feeds the flash_sale_strip CMS block and
// any homepage surface that wants "what's on flash right now?". Active
// items come first (sorted by soonest end), then upcoming (sorted by
// soonest start). `?limit=N` clamps the response; default 12.
router.get('/api/retail/flash-sales', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '12', 10) || 12, 50);
  const now = Date.now();
  const rows = tdb().prepare(
    `SELECT ${RETAIL_PRODUCT_COLS} FROM products p
      WHERE p.is_published = 1
        AND COALESCE(p.is_active, 1) = 1
        AND p.flash_price IS NOT NULL
        AND p.flash_price > 0
        AND p.flash_ends_at IS NOT NULL
      ORDER BY p.flash_ends_at ASC`
  ).all()
    .map(hydrateNutrition)
    .map(r => flashsales.decorateProduct(r, now))
    .filter(r => r.flash && (r.flash.state === 'active' || r.flash.state === 'upcoming'))
    .sort((a, b) => {
      // active before upcoming; within each bucket the natural sort
      // (active = soonest ending, upcoming = soonest starting) is what
      // we want — both align with surfacing urgency to the customer.
      if (a.flash.state !== b.flash.state) return a.flash.state === 'active' ? -1 : 1;
      const ka = a.flash.state === 'upcoming' ? a.flash.starts_at : a.flash.ends_at;
      const kb = b.flash.state === 'upcoming' ? b.flash.starts_at : b.flash.ends_at;
      return new Date(ka).getTime() - new Date(kb).getTime();
    })
    .slice(0, limit);
  res.set('Cache-Control', 'public, max-age=10');
  res.json({ success: true, data: rows, meta: { server_time_ms: now } });
});

// ─── Auth handshake ──────────────────────────────────────────────────────
// Flow: mini app calls wx.login → gets `code` → POSTs here → we exchange
// the code with WeChat's jscode2session API → upsert retail_customers row
// → return { token, customer }. Token is opaque random hex, stored as-is
// in retail_auth_tokens (it's session-equivalent — possession = identity).
//
// DEV MODE: if WECHAT_APP_ID/SECRET aren't set, we accept any code and use
// `dev:<code>` as a fake openid. Lets us iterate the mini app without a
// registered AppID. Production: set the two env vars.

const WECHAT_APP_ID     = process.env.WECHAT_APP_ID     || '';
const WECHAT_APP_SECRET = process.env.WECHAT_APP_SECRET || '';
const WECHAT_DEV_MODE   = !WECHAT_APP_ID || !WECHAT_APP_SECRET;
const TOKEN_TTL_MS      = 30 * 24 * 3600 * 1000;  // 30 days

if (WECHAT_DEV_MODE) {
  // Loud at startup — this is unsafe on a public box. Quantify the exposure
  // so the operator sees how much real customer data is currently spoofable.
  try {
    const n = tdb().prepare("SELECT COUNT(*) AS n FROM retail_customers WHERE openid LIKE 'dev:%'").get().n;
    console.error('[security] ⚠️  retail/auth is in DEV MODE (WECHAT_APP_ID/SECRET unset).');
    console.error('[security]    ' + n + ' customer(s) currently authenticate via spoofable dev:* openids.');
    console.error('[security]    Anyone who reaches POST /api/retail/auth with a known code can impersonate that customer.');
    console.error('[security]    Fix: add WECHAT_APP_ID + WECHAT_APP_SECRET to .env, then pm2 restart roots-v2.');
  } catch (_) {
    console.error('[security] ⚠️  retail/auth is in DEV MODE — set WECHAT_APP_ID + WECHAT_APP_SECRET in .env.');
  }
}

async function exchangeCodeForOpenid(code) {
  // Per-tenant login: resolve THIS request's tenant creds. Roots / unscoped
  // requests get the env bundle (identical to the old global consts); a tenant
  // whose mini-app sent its x-wx-appid gets its own AppID + secret. A tenant
  // with no stored creds is in devMode and never borrows Roots' AppID.
  const { appId, appSecret, devMode } = getTenantCreds(currentTenantId()).wechat;
  if (devMode) return { openid: `dev:${code}`, unionid: null };
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appId}&secret=${appSecret}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const resp = await fetch(url);
  const j = await resp.json();
  if (!j.openid) {
    const err = new Error(`wechat_exchange_failed: ${j.errcode || ''} ${j.errmsg || ''}`.trim());
    err.code = 'wechat_exchange_failed';
    throw err;
  }
  return { openid: j.openid, unionid: j.unionid || null };
}

function issueToken(customerId, ua) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  tdb().prepare(
    `INSERT INTO retail_auth_tokens (token, customer_id, expires_at, user_agent)
     VALUES (?, ?, ?, ?)`
  ).run(token, customerId, expiresAt, ua || null);
  return { token, expiresAt };
}

router.post('/api/retail/auth', express.json(), async (req, res) => {
  const { code, nickname, avatar_url } = req.body || {};
  if (!code) return res.status(400).json({ success: false, error: 'code_required' });

  let openid, unionid;
  try {
    ({ openid, unionid } = await exchangeCodeForOpenid(code));
  } catch (e) {
    console.error('[retail/auth] exchange failed:', e.message);
    return res.status(502).json({ success: false, error: e.code || 'wechat_exchange_failed' });
  }

  // Upsert customer. On first login we set nickname/avatar from the body
  // if present (the mini app collects them via wx.getUserProfile separately).
  let customer = tdb().prepare('SELECT * FROM retail_customers WHERE openid = ?').get(openid);
  if (!customer) {
    const info = tdb().prepare(
      `INSERT INTO retail_customers (openid, unionid, nickname, avatar_url, last_login_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(openid, unionid, nickname || null, avatar_url || null);
    customer = tdb().prepare('SELECT * FROM retail_customers WHERE id = ?').get(info.lastInsertRowid);
    // Auto-grant any voucher flagged auto_grant_signup. Best-effort: a failure
    // here must NOT block the auth response. Uses INSERT OR IGNORE so even if
    // the same hook ran twice for the same (customer, voucher) we land on one
    // grant. Filters out expired vouchers so we don't gift a dead coupon.
    try { grantSignupVouchers(customer.id); }
    catch (e) { console.warn('[retail/auth] signup voucher grant failed:', e.message); }
  } else {
    // Refresh last_login_at; opportunistically fill nickname/avatar if we
    // didn't have them before and the client just sent them.
    tdb().prepare(
      `UPDATE retail_customers
          SET last_login_at = CURRENT_TIMESTAMP,
              nickname   = COALESCE(NULLIF(nickname, ''), ?),
              avatar_url = COALESCE(NULLIF(avatar_url, ''), ?)
        WHERE id = ?`
    ).run(nickname || customer.nickname || null,
          avatar_url || customer.avatar_url || null,
          customer.id);
    customer = tdb().prepare('SELECT * FROM retail_customers WHERE id = ?').get(customer.id);
  }

  if (customer.is_blocked) return res.status(403).json({ success: false, error: 'account_blocked' });

  const { token, expiresAt } = issueToken(customer.id, req.headers['user-agent']);
  res.json({
    success: true,
    data: { token, expires_at: expiresAt, customer: publicCustomer(customer) },
  });
});

// ─── Payment ─────────────────────────────────────────────────────────────
// POST /api/retail/payment/create — kicks off payment for an order.
//   • DEV mode (no WECHAT_PAY_MCH_ID env): auto-marks the order 'paid' and
//     returns { dev: true, status: 'paid' }. The mini-app can navigate
//     straight to the success screen.
//   • PROD mode: calls WeChat Pay v3 JSAPI to get a prepay_id, signs the
//     result, returns the params for wx.requestPayment().
//
// Credentials required in .env (none of these are set yet):
//   WECHAT_APP_ID         the new mini-app AppID (after registration)
//   WECHAT_APP_SECRET     mini-app secret
//   WECHAT_PAY_MCH_ID     merchant ID (商户号)
//   WECHAT_PAY_API_V3_KEY APIv3 key set in the merchant platform
//   WECHAT_PAY_PRIVATE_KEY (PEM string) merchant API private key
//   WECHAT_PAY_SERIAL_NO  certificate serial number
//   WECHAT_PAY_NOTIFY_URL https://rootskitchenchina.com/api/retail/payment/wechat/callback

// WECHAT_APP_ID + WECHAT_APP_SECRET are already declared higher up (used
// by /api/retail/auth). The pay-specific creds are unique to this block.
const WECHAT_PAY_MCH_ID        = process.env.WECHAT_PAY_MCH_ID || '';
const WECHAT_PAY_API_V3_KEY    = process.env.WECHAT_PAY_API_V3_KEY || '';
// Stored in .env as a single line with literal \n escapes; normalize back to
// real newlines so crypto.sign() gets a valid PEM. Harmless if the value
// already has real newlines (dotenv multiline) — the replace just no-ops.
const WECHAT_PAY_PRIVATE_KEY   = (process.env.WECHAT_PAY_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const WECHAT_PAY_SERIAL_NO     = process.env.WECHAT_PAY_SERIAL_NO || '';
const WECHAT_PAY_NOTIFY_URL    = process.env.WECHAT_PAY_NOTIFY_URL || 'https://rootskitchenchina.com/api/retail/payment/wechat/callback';
const WECHAT_PAY_REFUND_NOTIFY_URL = process.env.WECHAT_PAY_REFUND_NOTIFY_URL || 'https://rootskitchenchina.com/api/retail/payment/wechat/refund-callback';
const WECHAT_PAY_DEV_MODE = !WECHAT_PAY_MCH_ID || !WECHAT_PAY_PRIVATE_KEY || !WECHAT_APP_ID;

if (WECHAT_PAY_DEV_MODE) {
  console.error('[security] ⚠️  WECHAT PAY is in DEV MODE — /api/retail/payment/create and /api/retail/topup auto-succeed without charging.');
  console.error('[security]    A caller who reaches these endpoints can mark orders paid and credit wallet balances for free.');
  console.error('[security]    Fix: set WECHAT_PAY_MCH_ID + WECHAT_PAY_PRIVATE_KEY + WECHAT_PAY_API_V3_KEY + WECHAT_PAY_SERIAL_NO in .env, then pm2 restart roots-v2.');
}

// Prefix the WeChat out_trade_no so roots-v2's orders can never collide with
// the live OUT1N app's orders on the SHARED merchant ledger (both backends
// use one mch_id). The internal order_no stays unprefixed for display/search;
// only the value sent to WeChat + stored in retail_payments.out_trade_no
// carries this prefix, and the callback echoes it straight back.
const WX_OUT_TRADE_PREFIX = 'FC';
const wxOutTradeNo = (orderNo) => WX_OUT_TRADE_PREFIX + orderNo;

// User-Agent on outbound WeChat Pay v3 API calls. WeChat only requires a
// non-empty UA; it's server-to-server (no customer ever sees it), so we send a
// neutral PLATFORM identifier rather than any one tenant's brand (⑦ de-Roots).
const WX_PAY_USER_AGENT = 'WeChatPay-Node/1.0';

// ── Alipay (支付宝) config ───────────────────────────────────────────────
// Alipay uses the classic OpenAPI gateway (gateway.do) with RSA2 signing
// (SHA256withRSA) — a different scheme from WeChat Pay v3, so it gets its own
// signer/verifier below rather than reusing signMerchantRequest(). We run in
// "public key" mode (not the cert-chain mode): one Alipay public key verifies
// the async-notify signature.
//   ALIPAY_APP_ID       the Alipay open-platform app id
//   ALIPAY_PRIVATE_KEY  our app's RSA private key (PKCS#8). Stored in .env as a
//                       single line with literal \n escapes, OR as bare base64.
//   ALIPAY_PUBLIC_KEY   Alipay's public key (from the merchant console) — used
//                       to verify the async-notify signature. Bare base64 or PEM.
//   ALIPAY_NOTIFY_URL   public callback URL Alipay POSTs the trade result to.
//   ALIPAY_GATEWAY      override the gateway (defaults to production).
const ALIPAY_APP_ID      = process.env.ALIPAY_APP_ID || '';
const ALIPAY_GATEWAY     = process.env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do';
const ALIPAY_NOTIFY_URL  = process.env.ALIPAY_NOTIFY_URL || 'https://rootskitchenchina.com/api/retail/payment/alipay/callback';
const ALIPAY_PRIVATE_KEY = normalizePem(process.env.ALIPAY_PRIVATE_KEY || '', 'PRIVATE KEY');
const ALIPAY_PUBLIC_KEY  = normalizePem(process.env.ALIPAY_PUBLIC_KEY  || '', 'PUBLIC KEY');
const ALIPAY_DEV_MODE    = !ALIPAY_APP_ID || !ALIPAY_PRIVATE_KEY;
// Same FC prefix as WeChat so our orders can never collide with the live OUT1N
// app on a shared Alipay merchant ledger; the async notify echoes it back.
const alipayOutTradeNo = (orderNo) => WX_OUT_TRADE_PREFIX + orderNo;

if (ALIPAY_DEV_MODE) {
  console.error('[security] ⚠️  ALIPAY is not configured — /api/retail/payment/create returns alipay_not_configured for Alipay orders.');
  console.error('[security]    Fix: set ALIPAY_APP_ID + ALIPAY_PRIVATE_KEY + ALIPAY_PUBLIC_KEY in .env, then pm2 restart roots-v2.');
}

// Accept a key as either a ready PEM (with BEGIN/END lines) or as bare base64
// (how the Alipay console hands them out), and return a valid PEM. Also turns
// literal "\n" escapes from a single-line .env value into real newlines.
function normalizePem(raw, label) {
  let s = (raw || '').replace(/\\n/g, '\n').trim();
  if (!s) return '';
  if (s.includes('BEGIN')) return s;
  const body = (s.replace(/\s+/g, '').match(/.{1,64}/g) || []).join('\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

// ── Per-tenant payment resolution (Platform readiness ③) ───────────────────
// Every pay/refund/callback path resolves THIS request's WeChat Pay creds
// instead of the module-level env consts. Roots / unscoped → the env bundle
// (byte-for-byte the old values); a tenant → its OWN merchant, or devMode when
// unconfigured — a tenant NEVER borrows Roots' merchant (that would be the
// cross-tenant money leak this whole layer exists to prevent). The forward
// paths (create / refund / topup) run inside the request's tenant ALS scope,
// so currentTenantId() is the right tenant; the async callbacks instead carry
// the tenant id in the URL path (a WeChat→server POST has no session/header).
function payContext() {
  const c = getTenantCreds(currentTenantId());
  return { appId: c.wechat.appId, ...c.pay };  // {appId,mchId,apiV3Key,privateKey,serialNo,devMode}
}

// The active tenant's third-party integration creds (Platform readiness ⑤).
// Roots/unscoped → env-backed bundle (unchanged); other tenants → their own
// encrypted creds with NO env fallback. Shape:
//   { kd100:{customer,key,secret,callback}, jd:{appKey,appSecret,accessToken,
//     customerCode,env}, feie:{user,ukey} }
// Mirrors payContext() for the courier/printer rail — handlers pass the
// relevant slice into the kd100 / jd / feie lib fns so a tenant operates on
// its OWN accounts and can never clobber Roots' live env.
function integ() { return getTenantCreds(currentTenantId()).integrations; }

// Public origin for tenant async-notify URLs — the same server/domain as Roots
// (single-server SaaS), just a tenant-scoped path. Derived from Roots' notify
// URL so there's no new config to set; WeChat Pay v3 accepts any HTTPS URL.
const PAY_NOTIFY_ORIGIN = (() => {
  try { return new URL(WECHAT_PAY_NOTIFY_URL).origin; } catch { return 'https://rootskitchenchina.com'; }
})();
function wechatNotifyUrl() {
  const tid = currentTenantId();
  return tid === ROOTS_TENANT_ID ? WECHAT_PAY_NOTIFY_URL
    : `${PAY_NOTIFY_ORIGIN}/api/retail/payment/wechat/callback/${tid}`;
}
function wechatRefundNotifyUrl() {
  const tid = currentTenantId();
  return tid === ROOTS_TENANT_ID ? WECHAT_PAY_REFUND_NOTIFY_URL
    : `${PAY_NOTIFY_ORIGIN}/api/retail/payment/wechat/refund-callback/${tid}`;
}

// Per-tenant kd100 creds for subscribe (Platform readiness ⑨). The callback
// URL carries the tenant in its PATH (mirrors wechatNotifyUrl) so kd100's
// async push routes back to the right tenant's books and validates against
// THAT tenant's salt. Roots keeps its env-configured callback URL unchanged;
// for tenants the URL is system-built (they never configure it themselves).
function kd100Creds() {
  const kc = integ().kd100;
  const tid = currentTenantId();
  if (tid === ROOTS_TENANT_ID) return kc;
  return { ...kc, callback: tracking.kd100TenantCallbackUrl(tid) };
}

// Brand label for customer-visible payment strings (WeChat description, Alipay
// subject). Roots → "Roots" (unchanged); a tenant → its own brand_name, so a
// shopper's payment screen never reads another company's name. (⑦ de-Roots.)
function tenantBrandLabel() {
  const tid = currentTenantId();
  if (tid === ROOTS_TENANT_ID) return 'Roots';
  try {
    const t = db.prepare('SELECT brand_name, name FROM tenants WHERE id = ?').get(tid);
    return (t && (t.brand_name || t.name)) || 'Store';
  } catch { return 'Store'; }
}
function payDescription(orderNo) { return `${tenantBrandLabel()} order ${orderNo}`; }

// Validate a callback :tid path param → an active tenant id (or Roots), else
// null so an unknown id 404s instead of silently settling on the wrong books.
function resolveCallbackTid(raw) {
  const id = parseInt(raw, 10);
  if (!id) return null;
  if (id === ROOTS_TENANT_ID) return ROOTS_TENANT_ID;
  try {
    const t = db.prepare("SELECT id FROM tenants WHERE id = ? AND status = 'active'").get(id);
    return t ? id : null;
  } catch { return null; }
}

// Build the wx.requestPayment params from a prepay_id. Signature is over
// the 5-line message: appid, timestamp, nonce, package, signed with the
// merchant private key (RSA-SHA256 → base64). See WeChat Pay v3 docs.
// `p` is the resolved payContext() for this request (appId + privateKey).
function buildWxRequestPaymentParams(prepayId, p) {
  const timeStamp = String(Math.floor(Date.now() / 1000));
  const nonceStr  = crypto.randomBytes(16).toString('hex');
  const pkg       = 'prepay_id=' + prepayId;
  const message   = [p.appId, timeStamp, nonceStr, pkg, ''].join('\n');
  const paySign   = crypto.createSign('RSA-SHA256')
                          .update(message)
                          .sign(p.privateKey, 'base64');
  return { timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign };
}

// Sign an outbound HTTP request to api.mch.weixin.qq.com per the v3 spec.
// Header: Authorization: WECHATPAY2-SHA256-RSA2048 mchid="...",nonce_str="...",
//         timestamp=...,serial_no="...",signature="..."
// `p` is the resolved payContext() (mchId + serialNo + privateKey) for the
// tenant whose merchant this request is signing against.
function signMerchantRequest(method, urlPath, body, p) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonceStr  = crypto.randomBytes(16).toString('hex');
  const bodyStr   = body ? JSON.stringify(body) : '';
  const message   = [method.toUpperCase(), urlPath, timestamp, nonceStr, bodyStr].join('\n') + '\n';
  const signature = crypto.createSign('RSA-SHA256')
                          .update(message)
                          .sign(p.privateKey, 'base64');
  return 'WECHATPAY2-SHA256-RSA2048 ' +
    `mchid="${p.mchId}",nonce_str="${nonceStr}",timestamp="${timestamp}",serial_no="${p.serialNo}",signature="${signature}"`;
}

// Real WeChat Pay JSAPI prepare. Returns { prepay_id }. `p` is the resolved
// payContext() for this request's tenant (own merchant, own AppID).
async function wechatPayCreate(order, openid, p) {
  const url = 'https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi';
  const body = {
    appid:        p.appId,
    mchid:        p.mchId,
    description:  payDescription(order.order_no),
    out_trade_no: wxOutTradeNo(order.order_no),
    notify_url:   wechatNotifyUrl(),
    amount:       { total: Math.round(Number(order.total) * 100), currency: 'CNY' },
    payer:        { openid },
  };
  const auth = signMerchantRequest('POST', '/v3/pay/transactions/jsapi', body, p);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'Authorization': auth,
      'User-Agent':    WX_PAY_USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  const j = await resp.json();
  if (!j.prepay_id) {
    const err = new Error('wechat_pay_failed: ' + (j.message || JSON.stringify(j)));
    err.code = 'wechat_pay_failed';
    throw err;
  }
  return j.prepay_id;
}

// Real WeChat Pay v3 refund. Sends money back to the payer's original method.
// Docs: POST /v3/refund/domestic/refunds. Returns the refund result object
// { refund_id, status: 'SUCCESS'|'PROCESSING'|'CLOSED'|'ABNORMAL', ... }.
// amount.total MUST equal the original transaction total (in cents).
async function wechatPayRefund({ outTradeNo, outRefundNo, refundCents, totalCents, reason }) {
  const p = payContext();   // tenant whose merchant issued the original charge
  const urlPath = '/v3/refund/domestic/refunds';
  const body = {
    out_trade_no:  outTradeNo,
    out_refund_no: outRefundNo,
    notify_url:    wechatRefundNotifyUrl(),
    amount:        { refund: refundCents, total: totalCents, currency: 'CNY' },
  };
  if (reason) body.reason = String(reason).slice(0, 80);
  const auth = signMerchantRequest('POST', urlPath, body, p);
  const resp = await fetch('https://api.mch.weixin.qq.com' + urlPath, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'Authorization': auth,
      'User-Agent':    WX_PAY_USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  const j = await resp.json();
  if (!j.refund_id) {
    const err = new Error('wechat_refund_failed: ' + (j.message || j.code || JSON.stringify(j)));
    err.code = 'wechat_refund_failed';
    throw err;
  }
  return j;
}

// ─── Alipay API helpers ───────────────────────────────────────────────────
// Alipay's timestamp must be Beijing time (GMT+8), formatted "YYYY-MM-DD HH:mm:ss".
function alipayTimestamp() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

// The RSA2 sign base-string for BOTH outbound requests and inbound notify
// verification: drop `sign` + `sign_type` + empty values, sort keys ascending,
// join as k=v pairs with & using the RAW (un-encoded) values.
function alipaySignString(params) {
  return Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] != null)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
}

// Call an Alipay OpenAPI method and return the inner business-response object
// (e.g. alipay_trade_precreate_response). Throws with err.code='alipay_failed'
// on a non-10000 result.
async function alipayApiCall(method, bizContent, { notifyUrl } = {}) {
  const params = {
    app_id:      ALIPAY_APP_ID,
    method,
    format:      'JSON',
    charset:     'utf-8',
    sign_type:   'RSA2',
    timestamp:   alipayTimestamp(),
    version:     '1.0',
    biz_content: JSON.stringify(bizContent),
  };
  if (notifyUrl) params.notify_url = notifyUrl;
  params.sign = crypto.createSign('RSA-SHA256')
                      .update(alipaySignString(params), 'utf8')
                      .sign(ALIPAY_PRIVATE_KEY, 'base64');

  const resp = await fetch(ALIPAY_GATEWAY, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body:    new URLSearchParams(params).toString(),
  });
  const j   = await resp.json();
  const biz = j[method.replace(/\./g, '_') + '_response'];
  if (!biz) {
    const err = new Error('alipay_bad_response: ' + JSON.stringify(j).slice(0, 200));
    err.code = 'alipay_failed';
    throw err;
  }
  if (biz.code && biz.code !== '10000') {
    const err = new Error(`alipay_${method}_failed: ${biz.code}/${biz.sub_code || ''} ${biz.sub_msg || biz.msg || ''}`);
    err.code = 'alipay_failed';
    err.aliCode = biz.code;
    err.aliSubCode = biz.sub_code;
    throw err;
  }
  return biz;
}

// alipay.trade.precreate → returns the qr_code string the customer scans in the
// Alipay app. The FC-prefixed out_trade_no ties the async notify back to us.
async function alipayPrecreate(order) {
  const biz = await alipayApiCall('alipay.trade.precreate', {
    out_trade_no: alipayOutTradeNo(order.order_no),
    total_amount: Number(order.total).toFixed(2),
    subject:      payDescription(order.order_no),
  }, { notifyUrl: ALIPAY_NOTIFY_URL });
  return biz.qr_code;
}

// alipay.trade.query → current trade_status for an out_trade_no. Used as a
// poll-time fallback so a blocked/missed async notify still settles the order.
async function alipayTradeQuery(outTradeNo) {
  try {
    const biz = await alipayApiCall('alipay.trade.query', { out_trade_no: outTradeNo });
    return biz.trade_status || null;   // WAIT_BUYER_PAY | TRADE_SUCCESS | TRADE_FINISHED | TRADE_CLOSED
  } catch (e) {
    if (e.aliSubCode === 'ACQ.TRADE_NOT_EXIST') return null; // nobody has paid yet
    throw e;
  }
}

// Verify an Alipay async-notify signature against Alipay's public key (RSA2).
function alipayVerifyNotify(params) {
  if (!ALIPAY_PUBLIC_KEY || !params || !params.sign) return false;
  try {
    return crypto.createVerify('RSA-SHA256')
                 .update(alipaySignString(params), 'utf8')
                 .verify(ALIPAY_PUBLIC_KEY, params.sign, 'base64');
  } catch (e) {
    console.error('[alipay/verify]', e.message);
    return false;
  }
}

function markOrderPaid(orderId) {
  // "wait_for_restock" orders transition to 'awaiting_restock' on payment,
  // not 'paid'. The kitchen waits, and checkAwaitingRestockForRestock()
  // promotes them to 'paid' once every missing product is restocked. No
  // stock is deducted on payment for these — they have no reservations.
  const meta = tdb().prepare(
    "SELECT fallback_choice, awaiting_restock_pids FROM retail_orders WHERE id = ?"
  ).get(orderId);
  const isWait = meta?.fallback_choice === 'wait_for_restock' && meta?.awaiting_restock_pids;

  const r = isWait
    ? tdb().prepare(
        "UPDATE retail_orders SET status = 'awaiting_restock', paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending_payment'"
      ).run(orderId)
    : tdb().prepare(
        "UPDATE retail_orders SET status = 'paid', paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending_payment'"
      ).run(orderId);

  tdb().prepare(
    "UPDATE retail_payments SET status = 'success', completed_at = CURRENT_TIMESTAMP WHERE order_id = ? AND status = 'pending'"
  ).run(orderId);
  if (r.changes > 0) {
    if (!isWait) {
      // Commit the soft-reservations: physical stock deducts at this point.
      // Idempotent for callers that re-fire (e.g. wechat retry callbacks).
      try { inventory.commitOrderReservations(orderId); }
      catch (e) { console.error('[inventory.commit]', e); }
    }
    // Award earn-points on the actual transition. awardOrderPoints is
    // idempotent so calling it on already-paid orders is safe.
    try { awardOrderPoints(orderId); } catch (e) { console.error('[awardOrderPoints]', e); }
    // Credit referrer if this is the invitee's first paid order. Guarded
    // inside creditReferralReward by status='joined' so retries are safe.
    try { creditReferralReward(orderId); } catch (e) { console.error('[creditReferralReward]', e); }
    // Notify retail operators of the new order via Web Push — reaches their
    // device even when the backend isn't open. Fires once per genuine
    // transition (r.changes>0 guards against wechat retry callbacks).
    try {
      if (_push && _push.sendPushByPermission) {
        const o = tdb().prepare('SELECT order_no, total FROM retail_orders WHERE id = ?').get(orderId);
        if (o) {
          _push.sendPushByPermission('retail', {
            title: isWait ? '🌿 New order · 新订单(待补货)' : '🌿 New paid order · 新订单已付款',
            body: `${o.order_no} · ¥${Number(o.total || 0).toFixed(2)}`,
            url: '/retail-admin?tab=orders',
            tag: 'retail-order-' + orderId,
          });
        }
      }
    } catch (e) { console.warn('[markOrderPaid push]', e.message); }

    // Auto-print to the store's Feie cloud printer. Best-effort: all DB
    // reads happen synchronously inside printOrderById (tenant context is
    // still bound here); the network POST to Feieyun is fired without
    // awaiting so a slow/offline printer never delays the order.
    try {
      const pp = loadPrinterPrefs();
      if (pp.auto_print && _feie.feieEnabled(integ().feie)) {
        printOrderById(orderId, pp)
          .then(r => { if (!r.ok) console.warn('[feie print]', orderId, r.msg); })
          .catch(e => console.warn('[feie print]', e.message));
      }
    } catch (e) { console.warn('[feie print setup]', e.message); }
  }
}

router.post('/api/retail/payment/create', requireRetailAuth, express.json(), async (req, res) => {
  const orderId = parseInt(req.body?.order_id, 10);
  if (!orderId) return res.status(400).json({ success: false, error: 'order_id_required' });
  const order = tdb().prepare(
    'SELECT id, order_no, status, payment_method, total, customer_id FROM retail_orders WHERE id = ? AND customer_id = ?'
  ).get(orderId, req.customer.id);
  if (!order) return res.status(404).json({ success: false, error: 'order_not_found' });
  // THIS request's WeChat Pay creds (Roots → env bundle = unchanged; a tenant →
  // its own merchant, or devMode when unconfigured). Resolved once here.
  const payCtx = payContext();
  if (order.status !== 'pending_payment') {
    return res.json({ success: true, data: { status: order.status, dev: payCtx.devMode } });
  }

  // Points-paid orders settle at order-create (points already deducted
  // inside the create tx). Nothing to charge — just flip status to paid.
  // Same shortcut when partial-points stacking zeroed out the cash total
  // (customer applied enough points to cover the whole order via the
  // wechat/alipay path — wechat/alipay won't accept a ¥0 charge).
  if (order.payment_method === 'points' || Number(order.total) <= 0) {
    markOrderPaid(orderId);
    return res.json({
      success: true,
      data: { status: 'paid', paid_by: 'points', order_no: order.order_no, method: order.payment_method },
    });
  }

  if (payCtx.devMode) {
    // No real merchant — fake the payment and let the customer see "paid".
    markOrderPaid(orderId);
    return res.json({
      success: true,
      data: { dev: true, status: 'paid', order_no: order.order_no, method: order.payment_method },
    });
  }

  // ── PROD path ─────────────────────────────────────────────────────────
  if (order.payment_method === 'wechat') {
    try {
      // Pull the customer's openid for the JSAPI call
      const cust = tdb().prepare('SELECT openid FROM retail_customers WHERE id = ?').get(order.customer_id);
      if (!cust?.openid || cust.openid.startsWith('dev:')) {
        return res.status(409).json({ success: false, error: 'no_real_openid' });
      }
      const prepayId = await wechatPayCreate(order, cust.openid, payCtx);
      const params   = buildWxRequestPaymentParams(prepayId, payCtx);
      // Save the out_trade_no link for the async callback to find this order
      tdb().prepare(
        "UPDATE retail_payments SET out_trade_no = ? WHERE order_id = ? AND status = 'pending'"
      ).run(wxOutTradeNo(order.order_no), orderId);
      return res.json({ success: true, data: { method: 'wechat', ...params } });
    } catch (e) {
      console.error('[wechat-pay/create]', e);
      return res.status(502).json({ success: false, error: e.code || 'wechat_pay_failed' });
    }
  }

  // ── Alipay (支付宝) — precreate a QR the customer scans in the Alipay app ─
  // WeChat blocks jumping to / scanning Alipay in-app, so there's no one-tap
  // flow here: we hand back the qr_code string, the mini-app renders it, and
  // the customer saves it and scans from their Alipay album. Settlement is
  // driven by the async notify (/alipay/callback) with a query fallback in the
  // status poll — both funnel into markOrderPaid(), same as WeChat.
  if (order.payment_method === 'alipay') {
    // Alipay is Roots-only for now: it reads Roots' global env creds, so a
    // tenant's Alipay charge would settle to ROOTS' merchant — a money leak.
    // Non-Roots tenants get alipay_not_configured until per-tenant Alipay is
    // built (Platform readiness ③ decision 2026-05-29). WeChat Pay is the
    // mini-app's primary rail and is fully per-tenant above.
    if (currentTenantId() !== ROOTS_TENANT_ID || ALIPAY_DEV_MODE) {
      return res.status(501).json({ success: false, error: 'alipay_not_configured' });
    }
    try {
      const qrCode = await alipayPrecreate(order);
      if (!qrCode) return res.status(502).json({ success: false, error: 'alipay_no_qr' });
      // Render the qr_code string to a PNG here so the mini-app only has to
      // show an <image> — no QR encoder needs to ship inside the WeChat bundle.
      let qrPng = null;
      try { qrPng = qrpng.qrPngDataUrl(qrCode, { scale: 10, quiet: 4 }); }
      catch (e) { console.error('[alipay/qr-render]', e.message); }
      tdb().prepare(
        "UPDATE retail_payments SET out_trade_no = ?, qr_image_url = ? WHERE order_id = ? AND status = 'pending'"
      ).run(alipayOutTradeNo(order.order_no), qrCode, orderId);
      return res.json({
        success: true,
        data: { method: 'alipay', qr_code: qrCode, qr_png: qrPng, order_no: order.order_no, total: order.total },
      });
    } catch (e) {
      console.error('[alipay/create]', e);
      return res.status(502).json({ success: false, error: e.code || 'alipay_failed' });
    }
  }

  return res.status(400).json({ success: false, error: 'unsupported_payment_method' });
});

// Polling endpoint — mini-app calls this every ~2s while waiting on
// Alipay-QR confirmation, or as a sanity check after wx.requestPayment.
router.get('/api/retail/payment/status/:orderId', requireRetailAuth, async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const sel = 'SELECT id, order_no, status, paid_at, total, payment_method, fulfillment_type, scheduled_for, delivery_slot_label, address_json FROM retail_orders WHERE id = ? AND customer_id = ?';
  let order = tdb().prepare(sel).get(orderId, req.customer.id);
  if (!order) return res.status(404).json({ success: false, error: 'not_found' });

  // Alipay fallback: if the async notify hasn't landed yet, actively query
  // Alipay on each poll so a blocked/missed callback still settles the order.
  // markOrderPaid() is idempotent + guarded by status, so this is safe to
  // re-run; it also fires the auto-print / points / push side effects once.
  if (order.status === 'pending_payment' && order.payment_method === 'alipay' && !ALIPAY_DEV_MODE && currentTenantId() === ROOTS_TENANT_ID) {
    try {
      const pay = tdb().prepare(
        "SELECT out_trade_no FROM retail_payments WHERE order_id = ? AND status = 'pending'"
      ).get(orderId);
      if (pay?.out_trade_no) {
        const st = await alipayTradeQuery(pay.out_trade_no);
        if (st === 'TRADE_SUCCESS' || st === 'TRADE_FINISHED') {
          markOrderPaid(orderId);
          order = tdb().prepare(sel).get(orderId, req.customer.id);
        }
      }
    } catch (e) { console.warn('[alipay/poll-query]', e.message); }
  }
  // Surface pickup store details for the success screen ("collect at <store>").
  if (order.fulfillment_type === 'pickup' && order.address_json) {
    try {
      const a = JSON.parse(order.address_json);
      order.pickup_store_name_en = a.store_name_en || '';
      order.pickup_store_name_cn = a.store_name_cn || '';
      order.pickup_store_address = a.address || '';
    } catch (_) { /* ignore malformed json */ }
  }
  delete order.address_json;
  res.json({ success: true, data: order });
});

// WeChat Pay async notify. Body looks like:
//   { id, create_time, resource_type, event_type, summary,
//     resource: { algorithm, ciphertext, associated_data, nonce, original_type } }
// The resource field is AES-256-GCM encrypted with the MERCHANT's APIv3 key.
//
// Per-tenant routing: WeChat POSTs here with no session/header, so the tenant
// is carried in the URL path (/callback/:tid); Roots keeps the legacy
// unsuffixed path. We resolve THAT tenant's APIv3 key to decrypt and settle
// inside its data scope (tdb() → the tenant's DB). tid=Roots → mainDb, which
// is byte-for-byte the old unscoped behaviour.
//
// Verification flow (PROD only — DEV mode auto-paid in /create):
//   1. Validate request signature with WeChat Pay's public cert (still TODO)
//   2. Decrypt resource → original transaction payload
//   3. Look up retail_payments by out_trade_no, mark order paid
//   4. Return { code: 'SUCCESS', message: 'OK' }
//
// Failure to verify → return non-200 to make WeChat retry.

// Capture the RAW request bytes for WeChat Pay callbacks. The v3 notify
// signature is computed over the exact body WeChat sent; re-serialising the
// parsed JSON would not reproduce it byte-for-byte, so we stash the buffer in
// a non-throwing express.json verify hook (parsing behaviour is otherwise
// unchanged — Roots' existing callbacks keep working identically).
const wxPayJson = express.json({
  limit: '256kb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
});

// WeChat Pay v3 inbound-notify signature verification (Platform readiness ⑩).
// Defense-in-depth ON TOP OF the APIv3-key AES-256-GCM auth tag that already
// authenticates the decrypted payload (a forged body fails decipher.final()).
// The signed message is `timestamp\nnonce\nrawBody\n`; WeChat signs it with its
// PLATFORM key (RSA-SHA256) and sends it base64 in the Wechatpay-Signature
// header. We verify with the merchant's platform PUBLIC key.
//
// Returns:
//   'unconfigured' — no platform key for this tenant → caller keeps the
//                    GCM-only behaviour (so Roots + every current tenant are
//                    unaffected until an operator supplies the key). FAIL-OPEN.
//   'ok'           — signature + timestamp valid.
//   'fail'         — missing headers, stale timestamp (>5 min replay window),
//                    or a bad signature → caller 401s and WeChat retries.
const WXPAY_NOTIFY_MAX_SKEW_MS = 5 * 60 * 1000;
function verifyWxPayNotify(req, platformPubKeyRaw) {
  const key = normalizePem(platformPubKeyRaw || '', 'PUBLIC KEY');
  if (!key) return 'unconfigured';
  const ts    = req.get('Wechatpay-Timestamp');
  const nonce = req.get('Wechatpay-Nonce');
  const sig   = req.get('Wechatpay-Signature');
  if (!ts || !nonce || !sig) return 'fail';
  const skew = Math.abs(Date.now() - Number(ts) * 1000);
  if (!Number.isFinite(skew) || skew > WXPAY_NOTIFY_MAX_SKEW_MS) return 'fail';
  const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
  const message = `${ts}\n${nonce}\n${raw}\n`;
  try {
    const ok = crypto.createVerify('RSA-SHA256').update(message, 'utf8').verify(key, sig, 'base64');
    return ok ? 'ok' : 'fail';
  } catch (e) {
    console.error('[wechat-pay/verify]', e.message);
    return 'fail';
  }
}
function handleWechatPayCallback(req, res, tid) {
  try {
    const body = req.body || {};
    const creds = getTenantCreds(tid).pay;
    if (creds.devMode) {
      console.log('[wechat-pay/callback] DEV MODE — ignored (would have decrypted + marked paid)');
      return res.json({ code: 'SUCCESS', message: 'OK' });
    }
    // Verify WeChat's request signature when this tenant has a platform public
    // key on file (⑩). Fail-open ('unconfigured') leaves the APIv3-key GCM tag
    // as the sole gate — so Roots + every current tenant are unaffected until
    // they paste their key. 'fail' (bad sig / replayed-stale / missing headers)
    // → 401 so WeChat retries with a fresh signature.
    const sigState = verifyWxPayNotify(req, creds.platformPubKey);
    if (sigState === 'fail') {
      console.warn(`[wechat-pay/callback] signature verify FAILED tenant=${tid}`);
      return res.status(401).json({ code: 'SIGN_ERROR', message: 'signature verification failed' });
    }
    if (!body.resource?.ciphertext) {
      return res.status(400).json({ code: 'INVALID', message: 'missing resource' });
    }
    // Decrypt AES-256-GCM. ciphertext is base64 of (encrypted || authtag).
    const cipherBuf = Buffer.from(body.resource.ciphertext, 'base64');
    const authTag   = cipherBuf.slice(-16);
    const data      = cipherBuf.slice(0, -16);
    const decipher  = crypto.createDecipheriv(
      'aes-256-gcm',
      Buffer.from(creds.apiV3Key, 'utf8'),
      Buffer.from(body.resource.nonce, 'utf8')
    );
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from(body.resource.associated_data || '', 'utf8'));
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    const txn = JSON.parse(plain);
    // txn.trade_state === 'SUCCESS' means paid. Settle inside the tenant's data
    // scope so tdb()/markOrderPaid() hit the right DB.
    let amountMismatch = false;
    if (txn.trade_state === 'SUCCESS' && txn.out_trade_no) {
      tenantAls.run(getTenantDb(tid), () => {
        const pay = tdb().prepare(
          'SELECT order_id, amount FROM retail_payments WHERE out_trade_no = ? AND status = ?'
        ).get(txn.out_trade_no, 'pending');
        if (pay) {
          // Parity with the Alipay callback: confirm the paid amount matches what
          // we charged before settling. WeChat Pay v3 reports amount.total in
          // CENTS; our stored amount is yuan. Mismatch/missing → non-200 so
          // WeChat retries (a genuine notify always carries the right amount).
          const paidCents   = Number(txn.amount && txn.amount.total);
          const expectCents = Math.round(Number(pay.amount) * 100);
          if (!Number.isFinite(paidCents) || paidCents !== expectCents) {
            console.warn('[wechat-pay/callback] amount mismatch', txn.out_trade_no, paidCents, expectCents);
            amountMismatch = true;
            return;
          }
          tdb().prepare(
            "UPDATE retail_payments SET status = 'success', transaction_id = ?, raw_callback_json = ?, completed_at = CURRENT_TIMESTAMP WHERE out_trade_no = ?"
          ).run(txn.transaction_id || null, plain, txn.out_trade_no);
          markOrderPaid(pay.order_id);
        }
      });
    }
    if (amountMismatch) return res.status(400).json({ code: 'INVALID', message: 'amount_mismatch' });
    res.json({ code: 'SUCCESS', message: 'OK' });
  } catch (e) {
    console.error('[wechat-pay/callback]', e);
    // Returning non-200 makes WeChat retry the callback (with backoff)
    res.status(500).json({ code: 'FAIL', message: 'internal_error' });
  }
}
// Roots keeps the legacy unsuffixed path (env creds, mainDb). Tenants POST to
// /callback/:tid — the id is validated against the tenants table.
router.post('/api/retail/payment/wechat/callback', wxPayJson, (req, res) => handleWechatPayCallback(req, res, ROOTS_TENANT_ID));
router.post('/api/retail/payment/wechat/callback/:tid', wxPayJson, (req, res) => {
  const tid = resolveCallbackTid(req.params.tid);
  if (!tid) return res.status(404).json({ code: 'INVALID', message: 'unknown_tenant' });
  handleWechatPayCallback(req, res, tid);
});
// WeChat Pay refund-result async notify. Same AES-256-GCM envelope as the
// payment callback, decrypted with the same tenant's APIv3 key (tid in the
// path; Roots = legacy unsuffixed). We already mark the refund 'paid'
// synchronously when the refund API accepts it, so this is confirmatory — log
// the final state and flag anything that didn't settle as SUCCESS.
function handleWechatRefundCallback(req, res, tid) {
  try {
    const creds = getTenantCreds(tid).pay;
    if (creds.devMode) return res.json({ code: 'SUCCESS', message: 'OK' });
    const sigState = verifyWxPayNotify(req, creds.platformPubKey);
    if (sigState === 'fail') {
      console.warn(`[wechat-refund/callback] signature verify FAILED tenant=${tid}`);
      return res.status(401).json({ code: 'SIGN_ERROR', message: 'signature verification failed' });
    }
    const r = req.body?.resource;
    if (!r?.ciphertext) return res.status(400).json({ code: 'INVALID', message: 'missing resource' });
    const buf = Buffer.from(r.ciphertext, 'base64');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      Buffer.from(creds.apiV3Key, 'utf8'),
      Buffer.from(r.nonce, 'utf8')
    );
    decipher.setAuthTag(buf.slice(-16));
    decipher.setAAD(Buffer.from(r.associated_data || '', 'utf8'));
    const info = JSON.parse(Buffer.concat([decipher.update(buf.slice(0, -16)), decipher.final()]).toString('utf8'));
    // Finalize the stored payout reference. The synchronous refund response
    // is usually PROCESSING; this callback fires when WeChat settles it, so we
    // flip the label (e.g. "...(PROCESSING)" → "...(SUCCESS)") instead of
    // leaving it stale. Mapped via the original transaction's out_trade_no, in
    // the tenant's data scope so tdb() hits the right DB.
    if (info.out_trade_no && info.refund_id) {
      tenantAls.run(getTenantDb(tid), () => {
        try {
          const pay = tdb().prepare('SELECT order_id FROM retail_payments WHERE out_trade_no = ?').get(info.out_trade_no);
          if (pay?.order_id) {
            tdb().prepare(
              'UPDATE retail_orders SET refund_payout_ref = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            ).run(info.refund_id + ' (' + (info.refund_status || 'SUCCESS') + ')', pay.order_id);
          }
        } catch (e) { console.error('[wechat-refund/callback db]', e); }
      });
    }
    if (info.refund_status === 'SUCCESS') {
      console.log('[wechat-refund/callback] SUCCESS', info.out_trade_no, info.refund_id);
    } else {
      console.warn('[wechat-refund/callback] non-success', info.out_trade_no, info.refund_status);
    }
    res.json({ code: 'SUCCESS', message: 'OK' });
  } catch (e) {
    console.error('[wechat-refund/callback]', e);
    res.status(500).json({ code: 'FAIL', message: 'internal_error' });
  }
}
router.post('/api/retail/payment/wechat/refund-callback', wxPayJson, (req, res) => handleWechatRefundCallback(req, res, ROOTS_TENANT_ID));
router.post('/api/retail/payment/wechat/refund-callback/:tid', wxPayJson, (req, res) => {
  const tid = resolveCallbackTid(req.params.tid);
  if (!tid) return res.status(404).json({ code: 'INVALID', message: 'unknown_tenant' });
  handleWechatRefundCallback(req, res, tid);
});
// Alipay async notify. Alipay POSTs application/x-www-form-urlencoded with the
// trade result + an RSA2 signature. We verify the signature with Alipay's
// public key, confirm app_id + amount, then mark the order paid — which also
// auto-prints the bill, awards points and commits stock, the same path WeChat
// takes. Alipay retries unless we reply with the literal text "success".
router.post('/api/retail/payment/alipay/callback', express.urlencoded({ extended: true }), (req, res) => {
  try {
    if (ALIPAY_DEV_MODE) { console.log('[alipay/callback] DEV MODE — ignored'); return res.send('success'); }
    const p = req.body || {};
    if (!alipayVerifyNotify(p)) {
      console.warn('[alipay/callback] bad signature', p.out_trade_no);
      return res.send('fail');
    }
    if (p.app_id !== ALIPAY_APP_ID) {
      console.warn('[alipay/callback] app_id mismatch', p.app_id);
      return res.send('fail');
    }
    if (p.trade_status === 'TRADE_SUCCESS' || p.trade_status === 'TRADE_FINISHED') {
      const pay = tdb().prepare(
        'SELECT order_id, amount FROM retail_payments WHERE out_trade_no = ? AND status = ?'
      ).get(p.out_trade_no, 'pending');
      if (pay) {
        // Confirm the paid amount matches what we charged before settling.
        // Reject when total_amount is absent too — a notify without a verifiable
        // amount must not be allowed to settle the order on trust.
        const expect = Number(pay.amount).toFixed(2);
        if (!p.total_amount || String(p.total_amount) !== expect) {
          console.warn('[alipay/callback] amount mismatch', p.out_trade_no, p.total_amount, expect);
          return res.send('fail');
        }
        tdb().prepare(
          "UPDATE retail_payments SET status = 'success', transaction_id = ?, raw_callback_json = ?, completed_at = CURRENT_TIMESTAMP WHERE out_trade_no = ?"
        ).run(p.trade_no || null, JSON.stringify(p), p.out_trade_no);
        markOrderPaid(pay.order_id);
      }
    }
    res.send('success');
  } catch (e) {
    console.error('[alipay/callback]', e);
    res.send('fail');
  }
});

// ─── Subscribe-message (push notifications) ──────────────────────────────
// POST /api/retail/notifications/subscribe — customer taps "Allow" in the
// mini-app after wx.requestSubscribeMessage; that consent gives us ONE
// chance to push them a templated message. Record it so we can fire when
// the order changes status.
router.post('/api/retail/notifications/subscribe', requireRetailAuth, express.json(), (req, res) => {
  const { template_id, order_id } = req.body || {};
  if (!template_id) return res.status(400).json({ success: false, error: 'template_id_required' });
  const orderId = order_id ? parseInt(order_id, 10) : null;
  if (orderId) {
    const order = tdb().prepare('SELECT id FROM retail_orders WHERE id = ? AND customer_id = ?').get(orderId, req.customer.id);
    if (!order) return res.status(404).json({ success: false, error: 'order_not_found' });
  }
  tdb().prepare(
    'INSERT INTO retail_subscriptions (customer_id, template_id, order_id) VALUES (?, ?, ?)'
  ).run(req.customer.id, template_id, orderId);
  res.json({ success: true });
});

// Server-side: cached WeChat access_token. Used for both subscribeMessage
// API and any other server-to-server WeChat calls. Token lives ~2 hours;
// we re-fetch when missing or near-expiry.
//
// Uses /cgi-bin/stable_token (not /cgi-bin/token). stable_token is WeChat's
// multi-server-safe endpoint: it returns a token that does NOT invalidate
// tokens held by other backends on the same AppID. The legacy /cgi-bin/token
// would knock out a co-resident backend's cached token on every fetch — a
// problem when the AppID is shared with another vendor (out1n) whose backend
// also fetches tokens. force_refresh=false lets WeChat reuse a cached token
// across calls, further reducing churn.
// Per-AppID token cache. Each tenant runs its own mini-program (own AppID), so
// the access_token is scoped to the AppID, not the process. Keyed by AppID so
// two tenants (or Roots + a tenant) never clobber each other's token. Roots'
// AppID resolves from env exactly as before — same stable_token semantics.
const _wxTokenCache = new Map();   // appId -> { token, expiresAt }
async function getWeChatAccessToken() {
  const { appId, appSecret } = getTenantCreds(currentTenantId()).wechat;
  if (!appId || !appSecret) return null;
  const hit = _wxTokenCache.get(appId);
  if (hit && Date.now() < hit.expiresAt - 60_000) return hit.token;
  const resp = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credential',
      appid:      appId,
      secret:     appSecret,
      force_refresh: false,
    }),
  });
  const j = await resp.json();
  if (!j.access_token) throw new Error('access_token_fetch_failed: ' + (j.errmsg || j.errcode));
  _wxTokenCache.set(appId, { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 7200) * 1000 });
  return j.access_token;
}

// Push a subscribeMessage to a customer if they have an unused consent for
// the given template. Idempotent — marks consent used after send so it
// can't fire twice. In DEV mode (no WECHAT_APP_ID set), logs only.
async function sendSubscribeMessage(customerId, templateId, data, page = 'pages/me/me') {
  if (!templateId) return { sent: false, reason: 'no_template_id' };
  const sub = tdb().prepare(
    'SELECT id FROM retail_subscriptions WHERE customer_id = ? AND template_id = ? AND used = 0 ORDER BY id DESC LIMIT 1'
  ).get(customerId, templateId);
  if (!sub) return { sent: false, reason: 'no_consent' };

  const cust = tdb().prepare('SELECT openid FROM retail_customers WHERE id = ?').get(customerId);
  if (!cust?.openid) return { sent: false, reason: 'no_openid' };

  // Mark used eagerly — even if the WeChat send fails, the consent is gone
  // either way (one-shot from the customer's perspective).
  tdb().prepare("UPDATE retail_subscriptions SET used = 1, used_at = CURRENT_TIMESTAMP WHERE id = ?").run(sub.id);

  if (getTenantCreds(currentTenantId()).wechat.devMode || cust.openid.startsWith('dev:')) {
    console.log(`[subscribe-message] DEV — would send template=${templateId} to=${cust.openid}, data=${JSON.stringify(data)}`);
    return { sent: false, dev: true };
  }

  try {
    const token = await getWeChatAccessToken();
    if (!token) return { sent: false, reason: 'no_access_token' };
    const url = `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`;
    const body = {
      touser: cust.openid,
      template_id: templateId,
      page,
      data,
      miniprogram_state: 'formal',
      lang: 'zh_CN',
    };
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await resp.json();
    if (j.errcode !== 0) console.warn('[subscribe-message] send failed:', j);
    return { sent: j.errcode === 0, response: j };
  } catch (e) {
    console.error('[subscribe-message]', e);
    return { sent: false, reason: 'exception' };
  }
}

// Bilingual titles for the in-app notification on each order status.
const ORDER_STATUS_NOTIF = {
  paid:       { en: 'Payment confirmed',            cn: '支付成功' },
  preparing:  { en: 'Your order is being prepared', cn: '订单准备中' },
  dispatched: { en: 'Your order has shipped',       cn: '订单已发货' },
  delivered:  { en: 'Your order was delivered',     cn: '订单已送达' },
  cancelled:  { en: 'Your order was cancelled',     cn: '订单已取消' },
  refunded:   { en: 'Your order was refunded',      cn: '订单已退款' },
};

// Helper used by the admin status-transition endpoint — fires the in-app
// notification (always) and, when configured, the WeChat subscribe-message.
function notifyOrderStatusChange(orderId, newStatus) {
  // In-app notification first — independent of WeChat push configuration.
  notifyForOrder(orderId, (o) => {
    const m = ORDER_STATUS_NOTIF[newStatus];
    if (!m) return null;
    return {
      category: 'order', type: 'order_' + newStatus,
      title_en: m.en, title_cn: m.cn,
      body_en: `Order ${o.order_no}`, body_cn: `订单 ${o.order_no}`,
    };
  });
  try {
    const cfg = loadConfig();
    const tplId = cfg.notifications?.order_status_template_id;
    if (!tplId) return;
    const o = tdb().prepare('SELECT order_no, customer_id, total FROM retail_orders WHERE id = ?').get(orderId);
    if (!o) return;
    const labels = {
      paid: '已支付', preparing: '准备中', dispatched: '配送中',
      delivered: '已送达', cancelled: '已取消', refunded: '已退款',
    };
    // WeChat template data shape: { key: { value: '...' } }
    const data = {
      thing1:   { value: o.order_no },
      phrase2:  { value: labels[newStatus] || newStatus },
      amount3:  { value: '¥' + Number(o.total || 0).toFixed(2) },
      time4:    { value: new Date().toISOString().slice(0, 16).replace('T', ' ') },
    };
    sendSubscribeMessage(o.customer_id, tplId, data, `pages/order/order?id=${orderId}`)
      .catch(e => console.warn('[notify-status]', e));
  } catch (e) { console.error('[notify-status]', e); }
}

// Fire a subscribe-message when the delivery scenario changes — i.e.
// the package reaches a pickup point, gets dropped at the door, or the
// courier can't reach the customer. Reuses the existing order-status
// template (`order_status_template_id`) but writes the scenario label
// (e.g. "已送达驿站 · 取件码 1-2-3456") into the phrase2 slot so the
// customer sees the actionable info without opening the mini app.
//
// Idempotency: caller is responsible for skipping repeats (see
// kd100.callback handler — only notifies if scenario != last notified).
function notifyTrackingScenario(orderId, scenario) {
  try {
    const cfg = loadConfig();
    const tplId = cfg.notifications?.order_status_template_id;
    if (!tplId) return;
    const o = tdb().prepare('SELECT order_no, customer_id, total FROM retail_orders WHERE id = ?').get(orderId);
    if (!o) return;
    // Pack the most actionable detail into phrase2. Capped at ~20 CN
    // chars to fit WeChat's phrase-type length limit; pickup_code wins
    // because that's the only piece the customer needs to ACT on.
    let phrase = scenario.label_cn;
    if (scenario.pickup_code) phrase = `${scenario.label_cn}·取件码${scenario.pickup_code}`;
    else if (scenario.signer) phrase = `${scenario.label_cn}·签收人${scenario.signer}`;
    if (phrase.length > 20) phrase = phrase.slice(0, 20);
    const data = {
      thing1:  { value: o.order_no },
      phrase2: { value: phrase },
      amount3: { value: '¥' + Number(o.total || 0).toFixed(2) },
      time4:   { value: new Date().toISOString().slice(0, 16).replace('T', ' ') },
    };
    sendSubscribeMessage(o.customer_id, tplId, data, `pages/order/order?id=${orderId}`)
      .catch(e => console.warn('[notify-scenario]', e));
  } catch (e) { console.error('[notify-scenario]', e); }
}

// ─── In-app notification center ───────────────────────────────────────────
// Persistent per-customer inbox (orders / refunds / invoices for v1), written
// from the same server events that fire the WeChat push. Surfaced in the mini
// app's Notifications page. Best-effort — never throws into the caller.
function notifyCustomer(customerId, n) {
  if (!customerId || !n || !n.category || !n.type) return;
  try {
    tdb().prepare(
      `INSERT INTO retail_notifications
         (customer_id, category, type, title_en, title_cn, body_en, body_cn, ref_type, ref_id)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      customerId, n.category, n.type,
      n.title_en || '', n.title_cn || '',
      n.body_en || null, n.body_cn || null,
      n.ref_type || null, n.ref_id != null ? String(n.ref_id) : null
    );
  } catch (e) { console.warn('[notify]', e.message); }
}

// Resolve an order's customer + order_no, then write a notification. `build`
// receives the order row {customer_id, order_no} and returns the fields.
function notifyForOrder(orderId, build) {
  try {
    const o = tdb().prepare('SELECT customer_id, order_no FROM retail_orders WHERE id = ?').get(orderId);
    if (!o || !o.customer_id) return;
    const n = build(o);
    if (n) notifyCustomer(o.customer_id, { ref_type: 'order', ref_id: orderId, ...n });
  } catch (e) { console.warn('[notify order]', e.message); }
}

// GET /api/retail/notifications — newest-first page + unread count. Cursor by
// `before` (id) for "load more".
router.get('/api/retail/notifications', requireRetailAuth, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit || '30', 10) || 30, 50);
  const before = req.query.before ? parseInt(req.query.before, 10) : null;
  let sql = `SELECT id, category, type, title_en, title_cn, body_en, body_cn,
                    ref_type, ref_id, broadcast_id, read_at, created_at
               FROM retail_notifications WHERE customer_id = ?`;
  const params = [req.customer.id];
  if (before) { sql += ' AND id < ?'; params.push(before); }
  sql += ' ORDER BY id DESC LIMIT ?'; params.push(limit);
  const rows = tdb().prepare(sql).all(...params);
  const unread = tdb().prepare(
    'SELECT COUNT(*) AS n FROM retail_notifications WHERE customer_id = ? AND read_at IS NULL'
  ).get(req.customer.id).n;
  res.json({ success: true, data: rows, meta: { unread: unread || 0, limit } });
});

// GET /api/retail/notifications/unread-count — lightweight badge poll.
// Returns enough to render the greeting-strip preview without a second
// fetch: total count, the latest unread row's title (for the "N=1 preview"
// design), whether any unread row is a broadcast (icon swap), and the
// latest unread timestamp (drives the "fresh" pulse animation).
router.get('/api/retail/notifications/unread-count', requireRetailAuth, (req, res) => {
  const n = tdb().prepare(
    'SELECT COUNT(*) AS n FROM retail_notifications WHERE customer_id = ? AND read_at IS NULL'
  ).get(req.customer.id).n;
  let latest_title_en = '', latest_title_cn = '', has_broadcast = 0, latest_created_at = null;
  if (n > 0) {
    const latest = tdb().prepare(
      `SELECT title_en, title_cn, created_at FROM retail_notifications
        WHERE customer_id = ? AND read_at IS NULL
        ORDER BY id DESC LIMIT 1`
    ).get(req.customer.id);
    if (latest) {
      latest_title_en = latest.title_en || '';
      latest_title_cn = latest.title_cn || '';
      latest_created_at = latest.created_at || null;
    }
    has_broadcast = tdb().prepare(
      `SELECT 1 FROM retail_notifications
        WHERE customer_id = ? AND read_at IS NULL AND category = 'broadcast' LIMIT 1`
    ).get(req.customer.id) ? 1 : 0;
  }
  res.json({ success: true, data: {
    count: n || 0,
    latest_title_en, latest_title_cn,
    has_broadcast: !!has_broadcast,
    latest_created_at,
  } });
});

// POST /api/retail/notifications/read-all — mark every unread one read.
router.post('/api/retail/notifications/read-all', requireRetailAuth, (req, res) => {
  tdb().prepare(
    'UPDATE retail_notifications SET read_at = CURRENT_TIMESTAMP WHERE customer_id = ? AND read_at IS NULL'
  ).run(req.customer.id);
  res.json({ success: true });
});

// POST /api/retail/notifications/:id/read — mark a single one read.
router.post('/api/retail/notifications/:id/read', requireRetailAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  tdb().prepare(
    'UPDATE retail_notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND customer_id = ? AND read_at IS NULL'
  ).run(id, req.customer.id);
  res.json({ success: true });
});

// ─── Broadcasts ───────────────────────────────────────────────────────────
// Operator-composed announcements. fanOutBroadcast() inserts one
// retail_notifications row per active (non-blocked) customer with
// category='broadcast' and broadcast_id pointing back to the authoring row;
// the existing customer notification endpoints surface them automatically.
// Deeplink is carried via the existing ref_type='deeplink' / ref_id=<path>.
function fanOutBroadcast(brd) {
  const db_ = tdb();
  const customers = db_.prepare(
    'SELECT id FROM retail_customers WHERE COALESCE(is_blocked, 0) = 0'
  ).all();
  const insert = db_.prepare(
    `INSERT INTO retail_notifications
       (customer_id, category, type, title_en, title_cn, body_en, body_cn,
        ref_type, ref_id, broadcast_id)
     VALUES (?, 'broadcast', 'announcement', ?, ?, ?, ?, ?, ?, ?)`
  );
  const refType = brd.deeplink ? 'deeplink' : null;
  const refId   = brd.deeplink || null;
  const txn = db_.transaction((rows) => {
    for (const c of rows) {
      insert.run(
        c.id,
        brd.title_en || '', brd.title_cn || '',
        brd.body_en || null, brd.body_cn || null,
        refType, refId,
        brd.id
      );
    }
  });
  txn(customers);
  db_.prepare(
    `UPDATE retail_broadcasts
        SET status = 'sent', sent_at = CURRENT_TIMESTAMP, recipient_count = ?
      WHERE id = ?`
  ).run(customers.length, brd.id);
  return customers.length;
}

// Lightweight string sanity-check for deeplinks. We only allow internal
// mini-app paths (must start with "/pages/") to keep operators from pasting
// http(s) URLs that the mini-app router can't open.
function normalizeDeeplink(raw) {
  const s = (raw == null ? '' : String(raw)).trim();
  if (!s) return '';
  if (!s.startsWith('/pages/')) {
    const err = new Error('deeplink_must_start_with_/pages/');
    err.statusCode = 400;
    throw err;
  }
  return s;
}

// GET /api/retail-admin/broadcasts — list, newest first.
router.get('/api/retail-admin/broadcasts', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(
    `SELECT id, title_en, title_cn, body_en, body_cn, deeplink, audience,
            scheduled_for, sent_at, recipient_count, status, created_by, created_at
       FROM retail_broadcasts
      ORDER BY id DESC
      LIMIT 200`
  ).all();
  res.json({ success: true, data: rows });
});

// GET /api/retail-admin/broadcasts/audience-count — preview "Will send to N".
router.get('/api/retail-admin/broadcasts/audience-count', requireRetailAdmin, (req, res) => {
  const n = tdb().prepare(
    'SELECT COUNT(*) AS n FROM retail_customers WHERE COALESCE(is_blocked, 0) = 0'
  ).get().n;
  res.json({ success: true, data: { count: n || 0 } });
});

// POST /api/retail-admin/broadcasts — create + send-now OR schedule.
router.post('/api/retail-admin/broadcasts', requireRetailAdmin, express.json(), (req, res) => {
  const b = req.body || {};
  const title_en = (b.title_en || '').trim();
  const title_cn = (b.title_cn || '').trim();
  const body_en  = (b.body_en  || '').trim();
  const body_cn  = (b.body_cn  || '').trim();
  if (!title_en && !title_cn) {
    return res.status(400).json({ success: false, error: 'title_required' });
  }
  let deeplink;
  try { deeplink = normalizeDeeplink(b.deeplink); }
  catch (e) { return res.status(e.statusCode || 400).json({ success: false, error: e.message }); }
  // scheduled_for: accept ISO string (e.g. "2026-06-01T18:00:00"); if present
  // and in the future, queue; otherwise send immediately.
  const scheduledRaw = (b.scheduled_for || '').trim();
  let scheduledFor = null;
  let sendNow = true;
  if (scheduledRaw) {
    const t = Date.parse(scheduledRaw);
    if (!Number.isFinite(t)) {
      return res.status(400).json({ success: false, error: 'bad_scheduled_for' });
    }
    if (t > Date.now() + 30 * 1000) {  // >30s in the future = schedule
      scheduledFor = new Date(t).toISOString().slice(0, 19).replace('T', ' ');
      sendNow = false;
    }
  }
  const initialStatus = sendNow ? 'sent' : 'scheduled';
  const info = tdb().prepare(
    `INSERT INTO retail_broadcasts
       (title_en, title_cn, body_en, body_cn, deeplink, audience,
        scheduled_for, status, created_by)
     VALUES (?, ?, ?, ?, ?, 'all_active', ?, ?, ?)`
  ).run(
    title_en, title_cn, body_en, body_cn, deeplink || null,
    scheduledFor, initialStatus, req.user.id
  );
  const id = info.lastInsertRowid;
  let recipient_count = 0;
  if (sendNow) {
    const row = tdb().prepare('SELECT * FROM retail_broadcasts WHERE id = ?').get(id);
    recipient_count = fanOutBroadcast(row);
  }
  res.json({ success: true, data: { id, status: initialStatus, recipient_count } });
});

// POST /api/retail-admin/broadcasts/:id/recall — cancel-if-scheduled or
// delete-fanout-if-sent. Idempotent: recalling an already-recalled row 200s.
router.post('/api/retail-admin/broadcasts/:id/recall', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = tdb().prepare('SELECT * FROM retail_broadcasts WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  if (row.status === 'scheduled') {
    // Conditional cancel: only flips a row that is STILL scheduled. If the 60s
    // scheduler grabbed it between our SELECT and here, changes===0 and we fall
    // through to report the now-current status instead of racing the fanout.
    const cancel = tdb().prepare("UPDATE retail_broadcasts SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'").run(id);
    if (cancel.changes === 1) return res.json({ success: true, data: { status: 'cancelled' } });
    const cur = tdb().prepare('SELECT status FROM retail_broadcasts WHERE id = ?').get(id)?.status;
    if (cur === 'sent') {
      const del = tdb().prepare('DELETE FROM retail_notifications WHERE broadcast_id = ?').run(id);
      tdb().prepare("UPDATE retail_broadcasts SET status = 'recalled' WHERE id = ?").run(id);
      return res.json({ success: true, data: { status: 'recalled', removed: del.changes } });
    }
    return res.json({ success: true, data: { status: cur } });
  }
  if (row.status === 'sent') {
    const del = tdb().prepare('DELETE FROM retail_notifications WHERE broadcast_id = ?').run(id);
    tdb().prepare("UPDATE retail_broadcasts SET status = 'recalled' WHERE id = ?").run(id);
    return res.json({ success: true, data: { status: 'recalled', removed: del.changes } });
  }
  // already recalled/cancelled — no-op
  res.json({ success: true, data: { status: row.status } });
});

// Scheduler — every 60s, walk every tenant's DB and fire any 'scheduled'
// broadcasts whose scheduled_for has arrived. Best-effort: never throws.
function tickBroadcastScheduler() {
  let tenants;
  try { tenants = db.prepare("SELECT id FROM tenants WHERE status = 'active'").all(); }
  catch { return; }   // tenants table not migrated yet
  for (const t of tenants) {
    try {
      const tdb_ = getTenantDb(t.id);
      tenantAls.run(tdb_, () => {
        const due = tdb_.prepare(
          `SELECT * FROM retail_broadcasts
            WHERE status = 'scheduled' AND scheduled_for <= CURRENT_TIMESTAMP`
        ).all();
        for (const brd of due) {
          try { fanOutBroadcast(brd); }
          catch (e) { console.warn('[broadcast scheduler] fanout', brd.id, e.message); }
        }
      });
    } catch (e) { console.warn('[broadcast scheduler]', t.id, e.message); }
  }
}
const _bcSweep = setInterval(tickBroadcastScheduler, 60 * 1000);
if (_bcSweep.unref) _bcSweep.unref();

// Roots Club tier ladder. Editable in /retail-admin → Points/Loyalty; persisted
// in storefront_config under `roots_club.tiers`. The mini-app reads the same
// blob off /api/retail/config, so backend + frontend never drift. These defaults
// seed the editor on a fresh install and are the fallback if the config row is
// missing or malformed. tier_key is auto-derived from lifetime_spend on every
// award/reverse + self-healed in requireRetailAuth (no manual override).
const DEFAULT_ROOTS_CLUB_TIERS = [
  {
    key: 'seed',   name_en: 'Seed',    name_cn: '种子',
    color: 'corn',   threshold: 0, points_mult: 1.0,
    perks_en: ['5% off your first order', 'Member newsletter'],
    perks_cn: ['首单 5% 折扣', '会员通讯'],
  },
  {
    key: 'sprout', name_en: 'Sprout',  name_cn: '幼苗',
    color: 'pea',    threshold: 500, points_mult: 1.2,
    perks_en: ['10% off all orders', 'Early access to drops', 'Free shipping ¥299+'],
    perks_cn: ['全场 10% 折扣', '新品优先购', '满 ¥299 包邮'],
  },
  {
    key: 'root',   name_en: 'Root',    name_cn: '根',
    color: 'forest', threshold: 2000, points_mult: 1.5,
    perks_en: ['15% off all orders', 'Early access to drops', 'Free shipping ¥199+', 'Birthday gift'],
    perks_cn: ['全场 15% 折扣', '新品优先购', '满 ¥199 包邮', '生日礼物'],
  },
  {
    key: 'tree',   name_en: 'Tree',    name_cn: '大树',
    color: 'ink',    threshold: 5000, points_mult: 2.0,
    perks_en: ['20% off all orders', 'Early access to drops', 'Free shipping (no minimum)', 'Birthday gift', 'Exclusive tasting events'],
    perks_cn: ['全场 20% 折扣', '新品优先购', '免邮 (无门槛)', '生日礼物', '专属品鉴活动'],
  },
];

// Look up the points-earn multiplier for a customer's tier. Falls back to 1.0
// (no boost) on unknown keys / malformed config rows. Clamped to [0.1, 10] so
// an editor typo can't zero out earns or blow up the math.
function tierMultiplierFor(tierKey) {
  if (!tierKey) return 1;
  const ladder = loadTierLadder();
  const t = ladder.find(x => x.key === tierKey);
  if (!t) return 1;
  const m = Number(t.points_mult);
  if (!Number.isFinite(m) || m <= 0) return 1;
  return Math.max(0.1, Math.min(10, m));
}
// Cheap in-memory cache so we don't hit storefront_config + reparse on every
// authenticated request. Invalidated by storefront_config.updated_at — any
// admin save bumps the timestamp via the same UPSERT path.
let _tierLadderCache = null;
let _tierLadderVer = -1;
function loadTierLadder() {
  let ver = 0;
  try {
    const t = tdb().prepare("SELECT COALESCE(strftime('%s', updated_at), '0') AS t FROM storefront_config WHERE key = 'roots_club.tiers'").get();
    ver = Number(t?.t || 0);
  } catch {}
  if (_tierLadderCache && ver === _tierLadderVer) return _tierLadderCache;
  let ladder = null;
  try {
    const row = tdb().prepare("SELECT value_json FROM storefront_config WHERE key = 'roots_club.tiers'").get();
    if (row && row.value_json) {
      const parsed = JSON.parse(row.value_json);
      if (Array.isArray(parsed) && parsed.length && parsed.every(t => t && typeof t.key === 'string' && Number.isFinite(Number(t.threshold)))) {
        ladder = parsed;
      }
    }
  } catch {}
  _tierLadderCache = (ladder && ladder.length) ? ladder : DEFAULT_ROOTS_CLUB_TIERS;
  _tierLadderVer = ver;
  return _tierLadderCache;
}
function tierFromSpend(spend) {
  const s = Math.max(0, Number(spend) || 0);
  // Walk the ladder in ascending-threshold order so out-of-order config rows
  // (operator edits) still derive correctly. Lowest tier is the baseline.
  const sorted = loadTierLadder().slice().sort((a, b) => (Number(a.threshold) || 0) - (Number(b.threshold) || 0));
  let tier = sorted[0]?.key || 'seed';
  for (const t of sorted) {
    if (s >= (Number(t.threshold) || 0)) tier = t.key;
  }
  return tier;
}
// Idempotent — only writes when the stored tier differs from the derived one.
// Returns the derived tier (post-reconcile), so callers can use it directly.
function reconcileTier(customerId, spend, storedTier) {
  const want = tierFromSpend(spend);
  if (want !== storedTier) {
    try {
      tdb().prepare('UPDATE retail_customers SET tier_key = ? WHERE id = ?').run(want, customerId);
    } catch (e) { console.warn('[reconcileTier]', e.message); }
  }
  return want;
}

// ─── requireRetailAuth middleware ────────────────────────────────────────
function requireRetailAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+([A-Za-z0-9]+)$/.exec(h);
  if (!m) return res.status(401).json({ success: false, error: 'missing_token' });
  const token = m[1];
  const row = tdb().prepare(
    `SELECT t.*, c.id AS cid FROM retail_auth_tokens t
       JOIN retail_customers c ON c.id = t.customer_id
      WHERE t.token = ? AND datetime(t.expires_at) > CURRENT_TIMESTAMP
        AND c.is_blocked = 0`
  ).get(token);
  if (!row) return res.status(401).json({ success: false, error: 'invalid_or_expired_token' });
  // Best-effort touch (don't block on contention)
  try {
    tdb().prepare('UPDATE retail_auth_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token = ?').run(token);
  } catch {}
  req.customer = tdb().prepare('SELECT * FROM retail_customers WHERE id = ?').get(row.cid);
  // Self-heal tier_key against lifetime_spend in case a past order skipped it
  // (or it was edited externally). Idempotent — UPDATE only fires on mismatch.
  if (req.customer) {
    const want = reconcileTier(req.customer.id, req.customer.lifetime_spend, req.customer.tier_key);
    if (want !== req.customer.tier_key) req.customer.tier_key = want;
  }
  next();
}

// Strip internal/admin-only fields before returning a customer to the app.
function publicCustomer(c) {
  if (!c) return null;
  return {
    id: c.id,
    nickname: c.nickname,
    avatar_url: c.avatar_url,
    phone: c.phone,
    tier_key: c.tier_key,
    lifetime_spend: c.lifetime_spend,
    points_balance: c.points_balance,
    coupon_count: c.coupon_count,
    balance: c.balance,
    created_at: c.created_at,
  };
}

// ─── Visit tracking (public, best-effort) ────────────────────────────────
// The mini app pings this on app open (onShow) and on page views. No auth
// is required — anonymous opens are valuable traffic data. If a Bearer token
// is present we resolve the customer so logged-in sessions get attributed.
// This route never throws to the client: analytics must never break the app,
// so every failure is swallowed and we always answer 200.
// Lightweight per-IP rate limit for the unauthenticated /track insert so a
// script can't flood retail_visits. Fixed 60s window; over-limit pings are
// silently dropped (tracking is best-effort + invisible to the client, so we
// still reply 200). In-memory + per-process — fine for the single PM2 fork; an
// abuser behind the LB lands on one process anyway.
const _TRACK_WINDOW_MS = 60 * 1000;
const _TRACK_MAX_PER_WINDOW = 120;
const _trackHits = new Map();   // ip → { n, resetAt }
const _trackSweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of _trackHits) if (r.resetAt <= now) _trackHits.delete(ip);
}, 5 * 60 * 1000);
if (_trackSweep.unref) _trackSweep.unref();
function trackRateOk(ip) {
  const now = Date.now();
  let r = _trackHits.get(ip);
  if (!r || r.resetAt <= now) { r = { n: 0, resetAt: now + _TRACK_WINDOW_MS }; _trackHits.set(ip, r); }
  r.n++;
  return r.n <= _TRACK_MAX_PER_WINDOW;
}

router.post('/api/retail/track', express.json(), (req, res) => {
  if (!trackRateOk(req.ip || 'unknown')) return res.json({ success: true });
  try {
    const b = req.body || {};
    const clip = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));
    let customerId = null;
    let openid = clip(b.openid, 64);

    // Optional token → attribute to a known customer.
    const m = /^Bearer\s+([A-Za-z0-9]+)$/.exec(req.headers.authorization || '');
    if (m) {
      const row = tdb().prepare(
        `SELECT c.id AS id, c.openid AS openid FROM retail_auth_tokens t
           JOIN retail_customers c ON c.id = t.customer_id
          WHERE t.token = ? AND datetime(t.expires_at) > CURRENT_TIMESTAMP`
      ).get(m[1]);
      if (row) { customerId = row.id; openid = openid || row.openid; }
    }

    const scene = Number.isFinite(+b.scene) ? Math.trunc(+b.scene) : null;
    tdb().prepare(
      `INSERT INTO retail_visits (customer_id, openid, session_id, page, scene, referrer, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      customerId, openid,
      clip(b.session_id, 64), clip(b.page, 128), scene,
      clip(b.referrer, 128), clip(req.headers['user-agent'], 256)
    );
  } catch (e) {
    // Intentionally silent — tracking must be invisible to the client.
  }
  res.json({ success: true });
});

// ─── Addresses ───────────────────────────────────────────────────────────
// Each customer has their own address book. is_default is enforced
// single-row per customer at the route level (we flip all others to 0 in
// the same txn when one is set to 1).
const ADDRESS_PUBLIC_COLS = `id, recipient_name, phone, province, city, district,
                              address, detail, postal_code, is_default,
                              created_at, updated_at`;

// E-bike rider ETA from the nearest active store to a saved address.
// Mirrors the speed assumption used in lib/inventory.js's fallback calc
// (~18 km/h average through GZ traffic with pickup overhead, so ≈3.3 min/km).
// We also add a flat 8 min pickup + handoff buffer so close-in deliveries
// never read as "<5 min" which would set unrealistic customer expectations.
const _RIDER_KM_PER_HR  = 18;
const _RIDER_MIN_PER_KM = 60 / _RIDER_KM_PER_HR;
const _RIDER_PICKUP_MIN = 8;
function computeRiderEta(address, lat, lng) {
  // Pull all active stores once per request; per-address we just pick the
  // nearest by Haversine. Same fallback (district centroid) as routing.
  const stores = tdb().prepare(
    `SELECT id, code, name_en, name_cn, lat, lng FROM retail_stores
      WHERE COALESCE(is_active, 1) = 1`
  ).all();
  if (!stores.length) return null;
  const addr = { ...address, lat, lng };
  let best = null;
  for (const s of stores) {
    const km = inventory.storeDistanceKm(s, addr);
    if (km == null) continue;
    if (!best || km < best.km) best = { km, store: s };
  }
  if (!best) return null;
  const minutes = Math.max(_RIDER_PICKUP_MIN, Math.round(best.km * _RIDER_MIN_PER_KM + _RIDER_PICKUP_MIN));
  return {
    km:           Number(best.km.toFixed(1)),
    min:          Math.round(minutes / 5) * 5, // round to nearest 5 min
    store_code:   best.store.code,
    store_name_en: best.store.name_en,
    store_name_cn: best.store.name_cn,
  };
}

router.get('/api/retail/addresses', requireRetailAuth, (req, res) => {
  const rows = tdb().prepare(
    `SELECT ${ADDRESS_PUBLIC_COLS}, lat, lng FROM retail_customer_addresses
      WHERE customer_id = ? ORDER BY is_default DESC, updated_at DESC`
  ).all(req.customer.id);
  // Stamp each row with the rider ETA from the nearest store. Pure read —
  // no writes — so it's safe to do inline.
  const data = rows.map(r => {
    const eta = computeRiderEta(r, r.lat, r.lng);
    // Hide lat/lng from the client response — internal-only.
    const { lat, lng, ...pub } = r;
    return { ...pub, delivery_eta: eta };
  });
  res.json({ success: true, data });
});

// ─── Chinese address normalization (server-side safety net) ───────────
// The mini-app now forces region selection via the native picker, so this
// helper rarely needs to do anything — but it catches:
//   • province typed without 省 suffix      → "广东"   → "广东省"
//   • city typed without 市 suffix          → "广州"   → "广州市"
//   • province/city accidentally repeated inside the freeform `address`
//     field (e.g. "广东省广州市天河区Apt 4" → strip the prefix)
//   • known city/province pairs reflowed from older WeChat picker payloads
//     that returned bare values, plus a small set of municipalities that
//     don't normally take 省 (北京/上海/天津/重庆 are direct-administered).
const CN_PROVINCES = [
  '北京','上海','天津','重庆',           // direct-administered municipalities (no 省 suffix)
  '广东省','广西壮族自治区','海南省','福建省','浙江省','江苏省','安徽省','江西省',
  '山东省','河南省','湖北省','湖南省','河北省','山西省','内蒙古自治区','辽宁省',
  '吉林省','黑龙江省','四川省','贵州省','云南省','西藏自治区','陕西省','甘肃省',
  '青海省','宁夏回族自治区','新疆维吾尔自治区','台湾省','香港特别行政区','澳门特别行政区',
];
const CN_PROVINCE_STEMS = new Set(CN_PROVINCES.map(p => p.replace(/省$|自治区$|特别行政区$|市$/, '')));

function normalizeChinaAddress(a) {
  const out = { ...a };
  const trim = s => (typeof s === 'string' ? s.trim() : s);
  out.province = trim(out.province) || null;
  out.city     = trim(out.city)     || null;
  out.district = trim(out.district) || null;
  out.address  = trim(out.address)  || '';
  out.detail   = trim(out.detail)   || null;

  // Backfill the province from the city when the picker didn't supply one.
  // Plain 'city' served-zones store only the city; this gives every served
  // city its 省 automatically, the same way Guangzhou districts carry 广东省.
  // Runs before the suffix block below so municipalities normalize too
  // (e.g. derived '北京市' → '北京').
  if (!out.province && out.city) {
    const prov = provinceForCity(out.city);
    if (prov) out.province = prov;
  }

  // Add 省 suffix to bare province names (except direct-administered cities).
  if (out.province) {
    const stem = out.province.replace(/省$|自治区$|特别行政区$|市$/, '');
    const direct = ['北京','上海','天津','重庆'];
    if (direct.includes(stem)) out.province = stem;
    else if (CN_PROVINCE_STEMS.has(stem) && !/省$|自治区$|特别行政区$/.test(out.province)) {
      const match = CN_PROVINCES.find(p => p.replace(/省$|自治区$|特别行政区$/, '') === stem);
      if (match) out.province = match;
    }
  }
  // Add 市 suffix to city if missing. Only skip when the value already ends
  // with a real administrative suffix — 市 / 自治州 / 地区 / 盟. Cities like
  // 广州 / 福州 / 苏州 end in 州 but aren't really "州" administratively, so
  // they still need 市 appended.
  if (out.city && !/(市|自治州|地区|盟)$/.test(out.city)) {
    out.city = out.city + '市';
  }
  // Add 区/县 awareness — keep district as typed (too many shapes to enumerate),
  // just trim trailing punctuation.
  if (out.district) out.district = out.district.replace(/[,，。.\s]+$/, '');

  // Strip a leading "province city district" prefix from the freeform
  // address field when it duplicates the structured fields. People paste
  // full addresses into the street field; this de-duplicates them.
  if (out.address) {
    const prefixes = [out.province, out.city, out.district].filter(Boolean);
    let stripped = out.address;
    for (const p of prefixes) {
      const re = new RegExp('^\\s*' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i');
      stripped = stripped.replace(re, '');
    }
    out.address = stripped.trim();
  }

  return out;
}

router.post('/api/retail/addresses', requireRetailAuth, express.json(), (req, res) => {
  const a = normalizeChinaAddress(req.body || {});
  if (!a.recipient_name || !a.phone || !a.address) {
    return res.status(400).json({ success: false, error: 'missing_required' });
  }
  // Province is auto-derived from the city (normalizeChinaAddress), so a served
  // city always resolves a 省/市. District stays optional: GZ-district zones
  // supply one, plain city zones deliver city-wide and don't need it.
  if (!a.province || !a.city) {
    return res.status(400).json({ success: false, error: 'missing_region' });
  }
  const tx = tdb().transaction(() => {
    if (a.is_default) {
      tdb().prepare('UPDATE retail_customer_addresses SET is_default = 0 WHERE customer_id = ?').run(req.customer.id);
    }
    const info = tdb().prepare(
      `INSERT INTO retail_customer_addresses
         (customer_id, recipient_name, phone, province, city, district,
          address, detail, postal_code, is_default)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      req.customer.id, a.recipient_name, a.phone,
      a.province || null, a.city || null, a.district || null,
      a.address, a.detail || null, a.postal_code || null,
      a.is_default ? 1 : 0
    );
    return info.lastInsertRowid;
  });
  const id = tx();
  // Fire-and-forget: geocode the new address so routing can use real
  // distance. Customer doesn't wait — we respond immediately and write
  // lat/lng back to the row when the API call returns.
  geocodeAddressAsync(id, a);
  res.json({ success: true, data: tdb().prepare(`SELECT ${ADDRESS_PUBLIC_COLS} FROM retail_customer_addresses WHERE id = ?`).get(id) });
});

// Background geocode helper — never throws, writes lat/lng + geocoded_at
// when the Tencent Maps call resolves. Skipped silently if the key isn't
// configured (TENCENT_MAPS_KEY in .env).
function geocodeAddressAsync(addressId, a) {
  if (!geocode.configured()) return;
  setImmediate(async () => {
    try {
      const coords = await geocode.geocodeAddress({
        province: a.province, city: a.city, district: a.district,
        address: [a.address, a.detail].filter(Boolean).join(' '),
      });
      if (!coords) return;
      tdb().prepare(
        'UPDATE retail_customer_addresses SET lat = ?, lng = ?, geocoded_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(coords.lat, coords.lng, addressId);
    } catch (e) { console.warn('[geocodeAddressAsync]', e.message); }
  });
}

router.put('/api/retail/addresses/:id', requireRetailAuth, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = tdb().prepare('SELECT id FROM retail_customer_addresses WHERE id = ? AND customer_id = ?').get(id, req.customer.id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });
  // Normalize only the fields actually present in the body — PUT is partial.
  const incoming = req.body || {};
  const a = (incoming.province || incoming.city || incoming.district || incoming.address)
    ? normalizeChinaAddress(incoming)
    : incoming;
  const tx = tdb().transaction(() => {
    if (a.is_default) {
      tdb().prepare('UPDATE retail_customer_addresses SET is_default = 0 WHERE customer_id = ?').run(req.customer.id);
    }
    tdb().prepare(
      `UPDATE retail_customer_addresses
          SET recipient_name = COALESCE(?, recipient_name),
              phone          = COALESCE(?, phone),
              province       = COALESCE(?, province),
              city           = COALESCE(?, city),
              district       = COALESCE(?, district),
              address        = COALESCE(?, address),
              detail         = COALESCE(?, detail),
              postal_code    = COALESCE(?, postal_code),
              is_default     = COALESCE(?, is_default),
              -- clear stale coordinates so the address gets re-geocoded
              lat            = CASE WHEN ? IS NOT NULL OR ? IS NOT NULL OR ? IS NOT NULL OR ? IS NOT NULL OR ? IS NOT NULL THEN NULL ELSE lat END,
              lng            = CASE WHEN ? IS NOT NULL OR ? IS NOT NULL OR ? IS NOT NULL OR ? IS NOT NULL OR ? IS NOT NULL THEN NULL ELSE lng END,
              updated_at     = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(
      a.recipient_name ?? null, a.phone ?? null,
      a.province ?? null, a.city ?? null, a.district ?? null,
      a.address ?? null, a.detail ?? null, a.postal_code ?? null,
      a.is_default == null ? null : (a.is_default ? 1 : 0),
      // CASE-WHEN params (lat) — clear coords when any address-y field changed
      a.province ?? null, a.city ?? null, a.district ?? null, a.address ?? null, a.detail ?? null,
      // CASE-WHEN params (lng) — same
      a.province ?? null, a.city ?? null, a.district ?? null, a.address ?? null, a.detail ?? null,
      id
    );
  });
  tx();
  // Re-geocode in the background using the row's merged values.
  const merged = tdb().prepare('SELECT province, city, district, address, detail FROM retail_customer_addresses WHERE id = ?').get(id);
  if (merged) geocodeAddressAsync(id, merged);
  res.json({ success: true, data: tdb().prepare(`SELECT ${ADDRESS_PUBLIC_COLS} FROM retail_customer_addresses WHERE id = ?`).get(id) });
});

router.delete('/api/retail/addresses/:id', requireRetailAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = tdb().prepare('DELETE FROM retail_customer_addresses WHERE id = ? AND customer_id = ?').run(id, req.customer.id);
  if (r.changes === 0) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true });
});

// ─── Orders ──────────────────────────────────────────────────────────────
// Order create is the money path — server is the source of truth for ALL
// pricing. The client sends product_id + qty + chosen option_choice_ids;
// the server re-reads the price + computes the line totals + fees so a
// tampered request can't underpay. retail_stock decremented in the same
// transaction; pending_payment status is set, and a payment row is
// created — the actual wechat/alipay integration kicks in from there.

function cfgValue(key, fallback) {
  const row = tdb().prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value_json); } catch { return fallback; }
}

// "HH:MM" → minutes since midnight, or null if malformed.
function hhmmToMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Validate a customer-chosen pickup time against the single global pickup
// window (storefront_config 'pickup.window' = { open:'HH:MM', close:'HH:MM' }).
// Server is the timezone authority (UTC+8 host). Returns { scheduled_for, label }
// on success or { error } so the checkout handler can 400 cleanly. The chosen
// time must be in the future and its time-of-day must fall inside the window.
function resolvePickupTime(raw, now = new Date()) {
  if (!raw) return { error: 'pickup_time_required' };
  const when = new Date(raw);
  if (isNaN(when.getTime())) return { error: 'invalid_pickup_time' };
  if (when.getTime() < now.getTime() - 60_000) return { error: 'pickup_time_past' };
  // Guard against garbage far-future dates (> 30 days out).
  if (when.getTime() > now.getTime() + 30 * 86_400_000) return { error: 'pickup_time_too_far' };

  const win = cfgValue('pickup.window', { open: '10:00', close: '20:00' });
  const open  = hhmmToMinutes(win.open);
  const close = hhmmToMinutes(win.close);
  if (open != null && close != null && close > open) {
    const mins = when.getHours() * 60 + when.getMinutes();
    if (mins < open || mins > close) return { error: 'pickup_time_outside_hours' };
  }

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hh = String(when.getHours()).padStart(2, '0');
  const mm = String(when.getMinutes()).padStart(2, '0');
  const sameDay = when.toDateString() === now.toDateString();
  const dayLabel = sameDay ? 'Today' : `${days[when.getDay()]} ${when.getDate()}/${when.getMonth() + 1}`;
  return {
    scheduled_for: when.toISOString(),
    label: `Pickup ${dayLabel} ${hh}:${mm}`,
  };
}

// ─── Shipping mode + split-shipment helpers ───────────────────────────
// "Outside Guangzhou" detection. Province/city strings can vary —
// 广州 / 广州市 / Guangzhou / GZ. Normalize then match.
function isGuangzhou(city) {
  if (!city) return false;
  const s = String(city).trim().toLowerCase().replace(/市$|省$/g, '');
  return s === '广州' || s === 'guangzhou' || s === 'gz';
}

// Decide which modes a single item is allowed to ship by. csv -> array.
function parseShipModes(csv) {
  if (!csv) return ['air', 'land'];
  const out = String(csv).split(',').map(s => s.trim().toLowerCase()).filter(m => m === 'air' || m === 'land');
  return out.length ? out : ['air', 'land'];
}

// Bucket assignment for one item, purely by its allowed ship modes:
//   Air-only   → air
//   Land-only  → land
//   Any (both) → land (cheaper; admin can override via Apply suggestion)
// (Cold chain is no longer a per-item factor — anything in the air shipment
// is packed with ice anyway, so there's no separate ice flag to force air.)
function bucketForItem(it) {
  const modes = parseShipModes(it.ship_modes);
  const hasAir  = modes.includes('air');
  const hasLand = modes.includes('land');
  if (hasAir && !hasLand) return 'air';
  if (hasLand && !hasAir) return 'land';
  return 'land'; // Any → land
}

// Parse a freeform product weight string ("200g", "1.2kg", "1 pc", "200ml")
// into grams. Returns null when the value isn't a weight we can compute on
// (counts like "1 pc" or volumes like "200ml" → null so the suggestion can
// skip cleanly rather than fabricate savings numbers).
function parseWeightToGrams(s) {
  if (s == null) return null;
  const str = String(s).trim().toLowerCase();
  if (!str) return null;
  // \b after a non-ASCII char doesn't behave (JS regex \w is ASCII-only),
  // so anchor the end of the unit explicitly rather than relying on \b.
  const m = str.match(/^([0-9]+(?:\.[0-9]+)?)\s*(kg|gram[s]?|g|千克|公斤|克)(?:$|[^a-z一-鿿])/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  if (unit === 'kg' || unit === '千克' || unit === '公斤') return Math.round(n * 1000);
  return Math.round(n);
}

// Read shipping rate config with defaults. Admin can override in
// storefront_config under 'shipping.rates'. byCity overrides keyed by
// lowercased city string fall back to the default { base, per_kg }.
function getShippingRates() {
  const cfg = cfgValue('shipping.rates', null) || {};
  const def = {
    air:  { base: 20, per_kg: 8 },
    land: { base: 12, per_kg: 5 },
  };
  const merged = {
    air:  { ...def.air,  ...(cfg.air  || {}) },
    land: { ...def.land, ...(cfg.land || {}) },
    byCity: cfg.byCity || {},
  };
  return merged;
}

// Cost of shipping a single bucket (grams + mode) under the active rates,
// honouring optional per-city overrides.
function bucketCost(grams, mode, rates, city) {
  if (!grams || grams <= 0) return 0;
  const cityKey = String(city || '').trim().toLowerCase();
  const override = rates.byCity?.[cityKey]?.[mode];
  const r = override || rates[mode];
  return Math.round((r.base + r.per_kg * (grams / 1000)) * 100) / 100;
}

// Given a list of order items + destination city, return a plan of
// shipments to create and which items go into each.
//
//   inGZ                 → one 'local' shipment, all items
//   outGZ + single bkt   → one shipment of that mode
//   outGZ + mixed        → split into two: 'air' (Ice + air-only) +
//                          'land' (land-only + Any-mode items)
//
// `items` shape: [{ id, ship_modes, needs_ice_pack }, ...]
// Returns: [{ mode, label, item_ids: [...] }, ...]
function planShipments(items, destCity) {
  if (!items.length) return [];
  if (isGuangzhou(destCity)) {
    return [{ mode: 'local', label: 'Local delivery · 同城配送', item_ids: items.map(i => i.id) }];
  }
  const air  = [];
  const land = [];
  for (const it of items) {
    if (bucketForItem(it) === 'air') air.push(it.id);
    else                             land.push(it.id);
  }
  if (air.length && land.length) {
    return [
      { mode: 'air',  label: 'Air shipment · 空运',  item_ids: air  },
      { mode: 'land', label: 'Land shipment · 陆运', item_ids: land },
    ];
  }
  if (air.length) return [{ mode: 'air',  label: 'Air shipment · 空运',  item_ids: air  }];
  return            [{ mode: 'land', label: 'Land shipment · 陆运', item_ids: land }];
}

// Idempotently materialize shipment rows for an order. If shipments
// already exist, returns them. Otherwise computes the plan from current
// items + address city, inserts the rows, and assigns retail_order_items
// .shipment_id. Used both at order-creation time (fresh rows) and when
// loading an old order in the office UI (lazy-fill).
function ensureShipments(orderId) {
  const existing = tdb().prepare(
    `SELECT * FROM retail_shipments WHERE order_id = ? ORDER BY id ASC`
  ).all(orderId);
  if (existing.length) return existing;

  const o = tdb().prepare(
    `SELECT id, address_json, tracking_carrier, tracking_number, tracking_status,
            tracking_events_json, tracking_synced_at, tracking_last_error,
            tracking_kd100_subscribed, tracking_scenario, tracking_scenario_data_json,
            tracking_scenario_notified, dispatched_at, delivered_at
       FROM retail_orders WHERE id = ?`
  ).get(orderId);
  if (!o) return [];
  let destCity = '';
  try { destCity = JSON.parse(o.address_json || '{}').city || ''; } catch {}

  const items = tdb().prepare(
    `SELECT id,
            COALESCE(ship_modes, 'air,land') AS ship_modes,
            COALESCE(needs_ice_pack, 0)      AS needs_ice_pack
       FROM retail_order_items WHERE order_id = ?`
  ).all(orderId);
  const plan = planShipments(items, destCity);

  const ins = tdb().prepare(
    `INSERT INTO retail_shipments (order_id, mode, label, created_at, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  );
  const assignItem = tdb().prepare(`UPDATE retail_order_items SET shipment_id = ? WHERE id = ?`);
  const created = [];
  const tx = tdb().transaction(() => {
    for (const seg of plan) {
      const r = ins.run(orderId, seg.mode, seg.label);
      const shipmentId = r.lastInsertRowid;
      for (const itemId of seg.item_ids) assignItem.run(shipmentId, itemId);
      created.push(shipmentId);
    }
    // Carry legacy tracking_* across — attach to the first shipment so
    // existing waybills don't appear lost in the new UI. Only if the
    // legacy fields have data.
    if (o.tracking_number && o.tracking_carrier && created.length) {
      tdb().prepare(
        `UPDATE retail_shipments
            SET tracking_carrier = ?, tracking_number = ?, tracking_status = ?,
                tracking_events_json = ?, tracking_synced_at = ?,
                tracking_last_error = ?, tracking_kd100_subscribed = ?,
                tracking_scenario = ?, tracking_scenario_data_json = ?,
                tracking_scenario_notified = ?,
                dispatched_at = ?, delivered_at = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(
        o.tracking_carrier, o.tracking_number, o.tracking_status,
        o.tracking_events_json, o.tracking_synced_at,
        o.tracking_last_error, o.tracking_kd100_subscribed || 0,
        o.tracking_scenario, o.tracking_scenario_data_json,
        o.tracking_scenario_notified,
        o.dispatched_at, o.delivered_at,
        created[0]
      );
    }
  });
  tx();
  return tdb().prepare(
    `SELECT * FROM retail_shipments WHERE order_id = ? ORDER BY id ASC`
  ).all(orderId);
}

// Build a split-package suggestion for one out-of-GZ order. Compares the
// current shipment bucketing against the optimal split (Ice + air-only
// items by air, everything else by land) and reports projected freight
// savings under the active shipping.rates config.
//
// Returns { eligible, reason, current: {plan, cost}, suggested: {plan, cost},
//           savings, threshold, currency }.
// `reason` codes: 'ok' | 'in_guangzhou' | 'asap_paid' | 'holiday_mode_off'
//                 | 'only_one_bucket' | 'savings_below_threshold'
//                 | 'land_bucket_too_small' | 'no_parseable_weight'
//                 | 'already_optimal' | 'no_items'
const SAVINGS_THRESHOLD = 10;       // ¥10 — see project_roots_v2_split_package
const LAND_FLOOR_VALUE  = 50;       // ¥50 — land bucket below this folds back
const LAND_FLOOR_GRAMS  = 2000;     // 2 kg
function buildShipmentSuggestion(orderId) {
  const order = tdb().prepare(
    `SELECT id, address_json, delivery_slot_label, status
       FROM retail_orders WHERE id = ?`
  ).get(orderId);
  if (!order) return null;

  let destCity = '';
  try { destCity = JSON.parse(order.address_json || '{}').city || ''; } catch {}
  if (isGuangzhou(destCity)) {
    return { eligible: false, reason: 'in_guangzhou' };
  }

  // ASAP paid → never suggest splitting; the customer paid for speed.
  const slot = String(order.delivery_slot_label || '').toLowerCase();
  if (/asap|right away|马上|立即/.test(slot)) {
    return { eligible: false, reason: 'asap_paid' };
  }

  const items = tdb().prepare(
    `SELECT id, qty, unit_price, size,
            COALESCE(ship_modes, 'air,land') AS ship_modes,
            COALESCE(needs_ice_pack, 0)      AS needs_ice_pack,
            shipment_id
       FROM retail_order_items WHERE order_id = ?`
  ).all(orderId);
  if (!items.length) return { eligible: false, reason: 'no_items' };

  // Strict weight requirement — if any item lacks a parseable weight, we
  // refuse to fabricate savings numbers.
  const weighed = items.map(it => {
    const grams = parseWeightToGrams(it.size);
    return { ...it, grams_each: grams, grams_line: grams != null ? grams * it.qty : null };
  });
  if (weighed.some(it => it.grams_each == null)) {
    return { eligible: false, reason: 'no_parseable_weight' };
  }

  const rates = getShippingRates();

  // Current bucketing — read from each item's actual shipment row.
  const shipments = tdb().prepare(
    `SELECT id, mode FROM retail_shipments WHERE order_id = ? ORDER BY id ASC`
  ).all(orderId);
  const modeById = new Map(shipments.map(s => [s.id, s.mode]));
  const currentBuckets = { air: { ids: [], grams: 0, value: 0 }, land: { ids: [], grams: 0, value: 0 } };
  for (const it of weighed) {
    const m = it.shipment_id ? modeById.get(it.shipment_id) : null;
    if (m !== 'air' && m !== 'land') continue; // local or unassigned — out of scope
    currentBuckets[m].ids.push(it.id);
    currentBuckets[m].grams += it.grams_line;
    currentBuckets[m].value += Number(it.unit_price) * it.qty;
  }

  // Suggested bucketing — fresh assignment by spec.
  const suggestedBuckets = { air: { ids: [], grams: 0, value: 0 }, land: { ids: [], grams: 0, value: 0 } };
  for (const it of weighed) {
    const b = bucketForItem(it);
    suggestedBuckets[b].ids.push(it.id);
    suggestedBuckets[b].grams += it.grams_line;
    suggestedBuckets[b].value += Number(it.unit_price) * it.qty;
  }

  // Land-floor: if the land bucket is too small to be worth its own
  // waybill, fold it into air and suggest a single air shipment.
  const land = suggestedBuckets.land;
  if (land.ids.length && land.value < LAND_FLOOR_VALUE && land.grams < LAND_FLOOR_GRAMS) {
    suggestedBuckets.air.ids.push(...land.ids);
    suggestedBuckets.air.grams += land.grams;
    suggestedBuckets.air.value += land.value;
    land.ids = []; land.grams = 0; land.value = 0;
  }

  const planToCost = (bk) => {
    let c = 0;
    if (bk.air.ids.length)  c += bucketCost(bk.air.grams,  'air',  rates, destCity);
    if (bk.land.ids.length) c += bucketCost(bk.land.grams, 'land', rates, destCity);
    return c;
  };
  const currentCost   = planToCost(currentBuckets);
  const suggestedCost = planToCost(suggestedBuckets);
  const savings       = Math.round((currentCost - suggestedCost) * 100) / 100;

  const planFromBuckets = (bk) => {
    const out = [];
    if (bk.air.ids.length)  out.push({ mode: 'air',  label: 'Air shipment · 空运',  item_ids: bk.air.ids,  grams: bk.air.grams,  value: bk.air.value,  cost: bucketCost(bk.air.grams,  'air',  rates, destCity) });
    if (bk.land.ids.length) out.push({ mode: 'land', label: 'Land shipment · 陆运', item_ids: bk.land.ids, grams: bk.land.grams, value: bk.land.value, cost: bucketCost(bk.land.grams, 'land', rates, destCity) });
    return out;
  };
  const currentPlan   = planFromBuckets(currentBuckets);
  const suggestedPlan = planFromBuckets(suggestedBuckets);

  const sameAssignment = (a, b) => {
    if (a.length !== b.length) return false;
    const asort = a.map(s => `${s.mode}:${[...s.item_ids].sort((x,y)=>x-y).join(',')}`).sort();
    const bsort = b.map(s => `${s.mode}:${[...s.item_ids].sort((x,y)=>x-y).join(',')}`).sort();
    return asort.every((v, i) => v === bsort[i]);
  };

  const result = {
    eligible: false,
    reason: 'ok',
    current:   { plan: currentPlan,   cost: currentCost   },
    suggested: { plan: suggestedPlan, cost: suggestedCost },
    savings,
    threshold: SAVINGS_THRESHOLD,
    currency: '¥',
  };

  if (suggestedPlan.length === 1) {
    // Only one bucket would have items under the suggestion — nothing to
    // split, suppress.
    result.reason = 'only_one_bucket';
    return result;
  }
  if (sameAssignment(currentPlan, suggestedPlan)) {
    result.reason = 'already_optimal';
    return result;
  }
  if (savings < SAVINGS_THRESHOLD) {
    result.reason = 'savings_below_threshold';
    return result;
  }
  result.eligible = true;
  return result;
}

// Build a customer-friendly tracking view for one shipment row (mirrors
// buildTrackingView but reads from a shipment row instead of the order).
function buildShipmentTrackingView(s) {
  if (!s.tracking_number || !s.tracking_carrier) return null;
  const carrier = tracking.carrierByCode(s.tracking_carrier);
  const statusCode = s.tracking_status || null;
  const statusDef = statusCode ? tracking.statusByCode(statusCode) : null;
  let events = [];
  if (s.tracking_events_json) {
    try {
      const raw = JSON.parse(s.tracking_events_json) || [];
      events = raw.map(ev => ({ ...ev, description_en: tracking.translateEventDescription(ev.description_cn) }));
    } catch { events = []; }
  }
  let scenario = null;
  if (s.tracking_scenario_data_json) {
    try { scenario = JSON.parse(s.tracking_scenario_data_json); } catch { scenario = null; }
  }
  return {
    shipment_id:     s.id,
    mode:            s.mode,
    label:           s.label,
    carrier_code:    s.tracking_carrier,
    carrier_name_en: carrier?.name_en || s.tracking_carrier,
    carrier_name_cn: carrier?.name_cn || s.tracking_carrier,
    number:          s.tracking_number,
    status_code:     statusCode,
    status_label_en: statusDef?.label_en || null,
    status_label_cn: statusDef?.label_cn || null,
    track_url:       tracking.trackingUrl(s.tracking_carrier, s.tracking_number),
    synced_at:       s.tracking_synced_at,
    events,
    scenario,
    kd100_subscribed: !!s.tracking_kd100_subscribed,
    last_error:      s.tracking_last_error,
  };
}

function nextOrderNo() {
  // R{YYMMDD}{6-digit-daily-seq}. Compute next seq by counting today's rows.
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const datePrefix = `R${yy}${mm}${dd}`;
  const last = tdb().prepare(
    `SELECT order_no FROM retail_orders WHERE order_no LIKE ? ORDER BY id DESC LIMIT 1`
  ).get(datePrefix + '%');
  const lastSeq = last ? parseInt(last.order_no.slice(datePrefix.length), 10) || 0 : 0;
  return datePrefix + String(lastSeq + 1).padStart(6, '0');
}

router.post('/api/retail/orders', requireRetailAuth, express.json(), (req, res) => {
  const body = req.body || {};
  const items       = Array.isArray(body.items) ? body.items : [];
  const addressId   = body.address_id;
  const paymentMethod = body.payment_method;
  // delivery_mode: 'standard' (default for everywhere) | 'max' (GZ flat-rate
  // any-distance) | 'sameday' (legacy — falls back to old standard pricing
  // when no zone matches, but real GZ zones own the price now)
  const deliveryMode = body.delivery_mode || body.delivery_method || 'standard';
  const customerNote  = body.customer_note || null;
  const needsCutlery  = body.needs_cutlery ? 1 : 0;
  const needsInvoice  = body.needs_invoice ? 1 : 0;
  const invoiceTitle  = needsInvoice ? (body.invoice_title || null) : null;
  const invoiceTaxId  = needsInvoice ? (body.invoice_tax_id || null) : null;
  const invoiceType   = needsInvoice ? (body.invoice_type === 'company' ? 'company' : 'personal') : null;
  const invoiceEmail  = needsInvoice ? (body.invoice_email || null) : null;
  const voucherCode   = body.voucher_code || null;
  // Client-supplied idempotency key — the mini-app sends a stable per-checkout
  // token so a double-tap / network retry returns the SAME order instead of
  // creating a duplicate (which, for points payment, would double-spend).
  const idempotencyKey = body.idempotency_key ? String(body.idempotency_key).slice(0, 80) : null;
  // Voucher resolution + points redemption happen further down, after pricing:
  // vouchers at the "Resolve voucher" block (ownership/eligibility checked
  // before any discount/free-shipping effect is applied), points just after.

  // Delivery slot — customer picked from /quote's `scheduling.slots` array
  // (or 'right_away'). Server re-resolves it to keep the surcharge & ETA
  // authoritative.
  const deliverySlotId = body.delivery_slot_id || null;

  // Fulfillment fork: 'pickup' (collect from a chosen store, no address/
  // shipping/zone) vs the default 'delivery'. Pickup inputs are validated in
  // the branch below; the delivery-only requirements (address, slot, mode)
  // are skipped for pickup.
  const isPickup        = body.fulfillment_type === 'pickup';
  const pickupStoreId   = isPickup && body.pickup_store_id ? parseInt(body.pickup_store_id, 10) : null;
  const pickupName      = isPickup ? String(body.pickup_name  || '').trim() : null;
  const pickupPhone     = isPickup ? String(body.pickup_phone || '').trim() : null;

  if (!items.length)       return res.status(400).json({ success: false, error: 'no_items' });
  if (!paymentMethod)      return res.status(400).json({ success: false, error: 'payment_method_required' });
  if (!['wechat','alipay','points'].includes(paymentMethod)) {
    return res.status(400).json({ success: false, error: 'invalid_payment_method' });
  }

  // `address` is the source of truth for recipient + region downstream. For
  // delivery it's the customer's saved address row; for pickup we synthesize
  // one from the chosen store + the pickup contact so the INSERT, totals, and
  // order-load code paths stay identical.
  let address, pickupStore = null, pickupScheduledFor = null, pickupSlotLabel = null;
  if (isPickup) {
    if (!pickupStoreId)            return res.status(400).json({ success: false, error: 'pickup_store_required' });
    if (!pickupName || !pickupPhone) return res.status(400).json({ success: false, error: 'pickup_contact_required' });
    pickupStore = tdb().prepare(
      'SELECT * FROM retail_stores WHERE id = ? AND is_active = 1 AND pickup_enabled = 1'
    ).get(pickupStoreId);
    if (!pickupStore) return res.status(400).json({ success: false, error: 'pickup_store_unavailable' });
    const pk = resolvePickupTime(body.pickup_time, new Date());
    if (pk.error) return res.status(400).json({ success: false, error: pk.error });
    pickupScheduledFor = pk.scheduled_for;
    pickupSlotLabel    = pk.label;
    // province left null so address_full reads "<city> <district> <store addr>"
    // without doubling the city; city/district drive store-region display.
    address = {
      recipient_name: pickupName, phone: pickupPhone,
      province: null, city: pickupStore.city || null, district: pickupStore.district || null,
      address: pickupStore.address || null, detail: null, postal_code: null,
    };
  } else {
    if (!addressId)      return res.status(400).json({ success: false, error: 'address_required' });
    if (!['standard','max','sameday'].includes(deliveryMode)) {
      return res.status(400).json({ success: false, error: 'invalid_delivery_method' });
    }
    if (!deliverySlotId) return res.status(400).json({ success: false, error: 'delivery_slot_required' });
    address = tdb().prepare(
      'SELECT * FROM retail_customer_addresses WHERE id = ? AND customer_id = ?'
    ).get(addressId, req.customer.id);
    if (!address) return res.status(400).json({ success: false, error: 'address_not_found' });
  }

  // ── Idempotency replay (fast path) ────────────────────────────────────
  // If this checkout token already produced an order, return it verbatim
  // instead of charging/deducting again. The UNIQUE index below is the
  // race backstop for two truly-simultaneous submits that both miss here.
  if (idempotencyKey) {
    const dup = tdb().prepare(
      'SELECT id FROM retail_orders WHERE customer_id = ? AND idempotency_key = ?'
    ).get(req.customer.id, idempotencyKey);
    if (dup) {
      const existing = loadOrderForCustomer(dup.id, req.customer.id, `${req.protocol}://${req.get('host')}`);
      return res.json({ success: true, data: existing, idempotent_replay: true });
    }
  }

  // ── Resolve + price each item server-side ────────────────────────────
  const orderNowMs = Date.now();
  const resolved = [];
  for (const it of items) {
    const pid = parseInt(it.product_id, 10);
    const qty = Number(it.qty);
    if (!pid || !(qty > 0)) return res.status(400).json({ success: false, error: 'invalid_item' });

    const p = tdb().prepare(
      `SELECT id, name_en, name_cn, sku, weight AS size,
              sell_price AS price, stock_qty AS stock, image_data,
              flash_price, flash_starts_at, flash_ends_at,
              flash_stock_limit, flash_sold,
              ship_modes, needs_ice_pack
         FROM products
        WHERE id = ? AND is_published = 1 AND COALESCE(is_active, 1) = 1`
    ).get(pid);
    if (!p) return res.status(400).json({ success: false, error: 'product_unavailable', product_id: pid });

    let optionDelta = 0;
    const chosenLabels = [];
    if (Array.isArray(it.choices) && it.choices.length) {
      const placeholders = it.choices.map(() => '?').join(',');
      const choices = tdb().prepare(
        `SELECT c.id, c.option_id, c.label_en, c.price_delta, o.product_id, o.type
           FROM retail_product_option_choices c
           JOIN retail_product_options o ON o.id = c.option_id
          WHERE c.id IN (${placeholders})`
      ).all(...it.choices);
      for (const c of choices) {
        if (c.product_id !== pid) {
          return res.status(400).json({ success: false, error: 'choice_wrong_product' });
        }
        optionDelta += Number(c.price_delta) || 0;
        chosenLabels.push({ option_id: c.option_id, choice_id: c.id, label: c.label_en, delta: c.price_delta });
      }
    }

    // Apply flash price when active. Stock-cap enforcement happens inside
    // the order transaction below via a conditional UPDATE so two parallel
    // orders can't oversell. Here we just check the soft snapshot to fail
    // fast — the tx is authoritative.
    const eff = flashsales.effectivePriceFor(p, p.price, orderNowMs);
    if (eff.is_flash && p.flash_stock_limit != null) {
      const remaining = Math.max(0, Number(p.flash_stock_limit) - (Number(p.flash_sold) || 0));
      if (qty > remaining) {
        return res.status(409).json({ success: false, error: 'flash_stock_exceeded', product_id: pid, available: remaining });
      }
    }
    const unitPrice = eff.price + optionDelta;
    if (!(unitPrice >= 0)) return res.status(400).json({ success: false, error: 'price_resolve_failed' });

    resolved.push({
      product: p,
      qty,
      unitPrice,
      lineTotal: unitPrice * qty,
      options: chosenLabels,
      isFlash: eff.is_flash,
    });
  }

  // ── Inventory: route to a store and check soft-reservable stock ───────
  // Customer's fallback_choice (from the 5-option modal):
  //   'cancel_missing'      — drop short items, ship the rest from nearest
  //   'replace_missing'     — body.replacements maps original→substitute
  //   'full_from_fallback'  — same as legacy accept_fallback=true
  //   'wait_for_restock'    — create order with status='awaiting_restock'
  //                           at nearest store; system promotes to 'paid'
  //                           when all missing items are restocked.
  // Empty / null = no shortage expected. Server re-runs the analysis and
  // refuses if the choice doesn't match the situation (anti-tampering).
  // Pickup never runs the address-based shortage/fallback flow — the customer
  // chose the store, so stock is simply checked + reserved there at reserve
  // time. Force the fallback machinery off for pickup.
  const fallbackChoice = isPickup ? null : (body.fallback_choice || (body.accept_fallback ? 'full_from_fallback' : null));
  const VALID_CHOICES = new Set(['cancel_missing','replace_missing','full_from_fallback','wait_for_restock']);
  if (fallbackChoice && !VALID_CHOICES.has(fallbackChoice)) {
    return res.status(400).json({ success: false, error: 'invalid_fallback_choice' });
  }

  // Mutated cart per choice. resolved → mutatedItems.
  let mutatedItems  = resolved.slice();
  let awaitingRestockPids = null;

  if (fallbackChoice === 'cancel_missing' || fallbackChoice === 'replace_missing' || fallbackChoice === 'wait_for_restock') {
    // All three need shortage analysis at the nearest store.
    const a = inventory.analyzeShortage({
      address,
      items: resolved.map(r => ({ product_id: r.product.id, qty: r.qty })),
      deliverySlotId, channel: 'wechat',
    });
    if (a.error === 'no_active_store') {
      return res.status(503).json({ success: false, error: 'no_active_store' });
    }
    if (a.gate === 'none') {
      // No shortage at the nearest store — the customer picked an option
      // they don't need. Refuse with a clear error so the mini-app can
      // re-quote + just place the order normally.
      return res.status(409).json({ success: false, error: 'no_shortage', hint: 'nearest_store_can_fulfill' });
    }
    if (fallbackChoice === 'cancel_missing') {
      const missingIds = new Set(a.missing_items.map(m => m.product_id));
      mutatedItems = resolved.filter(r => !missingIds.has(r.product.id));
      if (!mutatedItems.length) {
        return res.status(409).json({ success: false, error: 'no_items_remaining' });
      }
    } else if (fallbackChoice === 'replace_missing') {
      const replacements = Array.isArray(body.replacements) ? body.replacements : [];
      const repMap = new Map();
      for (const r of replacements) {
        const origId = parseInt(r.original_product_id, 10);
        const subId  = parseInt(r.substitute_product_id, 10);
        const qty    = Number(r.qty);
        if (!origId || !subId || !(qty > 0)) {
          return res.status(400).json({ success: false, error: 'invalid_replacement' });
        }
        repMap.set(origId, { subId, qty });
      }
      // Every missing item must have a replacement.
      for (const m of a.missing_items) {
        if (!repMap.has(m.product_id)) {
          return res.status(400).json({ success: false, error: 'missing_replacement_for', product_id: m.product_id });
        }
      }
      mutatedItems = [];
      for (const r of resolved) {
        if (!repMap.has(r.product.id)) { mutatedItems.push(r); continue; }
        const { subId, qty: subQty } = repMap.get(r.product.id);
        const sub = tdb().prepare(
          `SELECT id, name_en, name_cn, sku, weight AS size, sell_price AS price, image_data,
                  ship_modes, needs_ice_pack
             FROM products WHERE id = ? AND is_published = 1 AND COALESCE(is_active, 1) = 1`
        ).get(subId);
        if (!sub) return res.status(400).json({ success: false, error: 'substitute_not_available', product_id: subId });
        const av = inventory.getAvailable(a.nearest.store.id, subId, 'wechat');
        if (!av.exists || av.available < subQty) {
          return res.status(409).json({ success: false, error: 'substitute_out_of_stock', product_id: subId, available: av.available });
        }
        mutatedItems.push({
          product: sub,
          qty: subQty,
          unitPrice: Number(sub.price),
          lineTotal: Number(sub.price) * subQty,
          options: [],
          replacedForProductId: r.product.id,
          isFlash: false,
        });
      }
      // Merge duplicate line items — if the chosen substitute happens to
      // also be in the cart already (same product + same options), bump
      // the qty on the existing line instead of writing "Nutella Bars ×1
      // + Nutella Bars ×1" as two rows in the admin Orders view. We
      // bucket on (product_id, sorted_choice_ids) so genuinely different
      // option-variants of the same product stay as separate lines.
      const optsKey = (opts) => JSON.stringify((opts || []).map(o => o.choice_id).filter(Boolean).sort());
      const merged = [];
      for (const r of mutatedItems) {
        const key = optsKey(r.options);
        const existing = merged.find(m => m.product.id === r.product.id && optsKey(m.options) === key);
        if (existing) {
          existing.qty += r.qty;
          existing.lineTotal = Number(existing.unitPrice) * existing.qty;
          // Preserve the substitute marker so admin still sees the line was
          // (partially) a replacement for the original missing product.
          if (r.replacedForProductId && !existing.replacedForProductId) {
            existing.replacedForProductId = r.replacedForProductId;
          }
        } else {
          merged.push({ ...r });
        }
      }
      mutatedItems = merged;
    } else if (fallbackChoice === 'wait_for_restock') {
      // Order is placed at the nearest store, status='awaiting_restock'.
      // No stock reservation happens for the WHOLE order until every
      // missing item is restocked. The customer pays normally; stock at
      // the store is checked + deducted by checkAwaitingRestockForRestock.
      awaitingRestockPids = a.missing_items.map(m => m.product_id);
    }
  }

  // Now route the (possibly-mutated) cart.
  const acceptFallback = fallbackChoice === 'full_from_fallback';
  const isWaitFlow     = fallbackChoice === 'wait_for_restock';
  // Stock check only applies to GZ + same-day. For everything else
  // (out-of-GZ, or scheduled-for-later inside GZ) we relax routing so a
  // momentary shortage at the nearest store doesn't refuse the order or
  // bounce the customer into a needs-fallback modal — the kitchen will
  // restock before the scheduled fulfilment date.
  // Pickup always gates stock at the chosen store — the customer expects it
  // ready to collect, so we hard-reserve now rather than relax like a
  // scheduled-for-later delivery.
  const stockGate = isPickup ? true : inventory.requiresStockGate({ address, deliverySlotId });

  let fulfillingStore, routingReason;
  if (isPickup) {
    // Customer picked the store explicitly — no routing. Stock availability
    // is enforced by reserveForOrder below (throws insufficient_stock).
    fulfillingStore = pickupStore;
    routingReason   = 'customer_pickup';
  } else if (isWaitFlow) {
    // Wait flow always uses the nearest store regardless of stock; we
    // know stock is short there and that's the whole point.
    const a = inventory.analyzeShortage({
      address,
      items: resolved.map(r => ({ product_id: r.product.id, qty: r.qty })),
      deliverySlotId, channel: 'wechat',
    });
    if (!a.nearest?.store && !a.resolved?.store) return res.status(503).json({ success: false, error: 'no_active_store' });
    fulfillingStore = a.nearest?.store || a.resolved?.store;
    routingReason   = 'wait_for_restock';
  } else {
    const routing = inventory.routeOrder({
      address,
      items: mutatedItems.map(r => ({ product_id: r.product.id, qty: r.qty })),
      channel: 'wechat',
      acceptFallback,
      ignoreStock: !stockGate,
    });
    if (routing.error === 'no_active_store') {
      return res.status(503).json({ success: false, error: 'no_active_store' });
    }
    if (routing.error === 'needs_fallback_confirmation') {
      // Mini-app didn't pass a fallback_choice; return the rich payload so
      // it can show the right modal (5-option or simple-confirm depending
      // on gate from /quote).
      return res.status(409).json({
        success: false,
        error:   'needs_fallback_confirmation',
        nearest: {
          store_id:      routing.nearest.store.id,
          store_code:    routing.nearest.store.code,
          store_name_en: routing.nearest.store.name_en,
          store_name_cn: routing.nearest.store.name_cn,
          shortages:     routing.nearest.shortages,
        },
        fallback: {
          store_id:      routing.fallback.store.id,
          store_code:    routing.fallback.store.code,
          store_name_en: routing.fallback.store.name_en,
          store_name_cn: routing.fallback.store.name_cn,
          district:      routing.fallback.store.district,
        },
      });
    }
    if (routing.error === 'no_stock') {
      const short = routing.shortages?.[0];
      return res.status(409).json({
        success: false, error: 'insufficient_stock',
        product_id: short?.product_id, available: short?.available ?? 0,
        store_id: routing.store?.id ?? null,
      });
    }
    fulfillingStore = routing.store;
    routingReason   = fallbackChoice === 'cancel_missing'  ? 'cancel_missing'
                    : fallbackChoice === 'replace_missing' ? 'replace_missing'
                    : routing.reason;
  }
  resolved.length = 0; for (const r of mutatedItems) resolved.push(r); // keep `resolved` as the source of truth downstream

  const subtotal = resolved.reduce((s, r) => s + r.lineTotal, 0);
  const totalQty = resolved.reduce((s, r) => s + r.qty, 0);

  // Zone-driven fee model. If no zone matches the address, we currently
  // refuse the order — the office must configure the district/city in
  // /retail-admin → Delivery before this customer can check out.
  // Pickup is free and zone-less — the customer collects from the store, so
  // no shipping/packing fee and no zone match.
  const zone = isPickup ? null : matchDeliveryZone(address);
  let shippingFee = 0, packingFee = 0, deliveryZoneId = null, resolvedMode = isPickup ? 'pickup' : deliveryMode;
  if (isPickup) {
    // fees stay 0; delivery_mode='pickup' marks the order in admin
  } else if (zone) {
    const fees = computeDeliveryAndPacking(zone, subtotal, deliveryMode, totalQty);
    if (fees.error) return res.status(400).json({ success: false, error: fees.error });
    shippingFee    = fees.deliveryFee;
    packingFee     = fees.packingFee;
    deliveryZoneId = zone.id;
  } else {
    // Backwards-compatible fallback while zones are still being configured:
    // legacy 'fees.standardShipping' / 'fees.sameDayDelivery' kick in.
    const freeShipThreshold = Number(cfgValue('fees.freeShippingThreshold', 399));
    const standardShipping  = Number(cfgValue('fees.standardShipping', 12));
    const sameDayDelivery   = Number(cfgValue('fees.sameDayDelivery', 18));
    if (deliveryMode === 'sameday') shippingFee = sameDayDelivery;
    else                            shippingFee = subtotal >= freeShipThreshold ? 0 : standardShipping;
  }

  // Pickup carries the customer-chosen pickup window in the same scheduled_for
  // + delivery_slot_label columns; no zone slot resolution and no surcharge.
  let scheduledFor, sameDaySurcharge = 0, slotLabel;
  if (isPickup) {
    scheduledFor = pickupScheduledFor;
    slotLabel    = pickupSlotLabel;
  } else {
    // Resolve & validate the delivery slot AFTER zone lookup so we can enforce
    // the slot's same-day surcharge, expiry, and zone-allowed rules.
    const slotResolved = resolveDeliverySlot(zone, deliverySlotId, new Date());
    if (slotResolved.error) {
      return res.status(400).json({ success: false, error: slotResolved.error });
    }
    scheduledFor     = slotResolved.scheduled_for;          // ISO string or null
    sameDaySurcharge = Number(slotResolved.surcharge) || 0; // 0 unless same-day + zone-charged
    slotLabel        = body.delivery_slot_label
                        || slotResolved.slot?.label_en
                        || (deliverySlotId === 'right_away' ? 'Right away' : null);
    // Wait-for-restock overrides any time-bound slot with a flexible label
    // and clears scheduled_for + the same-day surcharge. The kitchen
    // shouldn't see "Today 18:00–20:00" on an awaiting_restock order — that
    // window can't be honored if restock lands after 18:00. Customer has
    // already confirmed the trade-off via a modal in the mini-app
    // (fbWaitForRestock) before this POST fires. Same-day surcharge is
    // refunded by clearing it here since we can't promise same-day.
    if (isWaitFlow) {
      scheduledFor      = null;
      sameDaySurcharge  = 0;
      slotLabel         = 'Ships when restocked';
    }
  }
  // Same-day surcharge is added to the shipping line so totals reconcile
  // without a new fee column on retail_orders.
  shippingFee += sameDaySurcharge;

  // ── Voucher resolution ───────────────────────────────────────────────
  // Customer sends voucher_code; server re-validates + computes discount.
  let voucher = null, voucherDiscount = 0;
  if (voucherCode) {
    const candidate = tdb().prepare(
      'SELECT * FROM retail_vouchers WHERE UPPER(code) = ? AND is_active = 1'
    ).get(String(voucherCode).trim().toUpperCase());
    // Eligibility is decided BEFORE applying any effect so a rejected voucher
    // can never leak free_shipping (shippingFee) or a discount. Gates:
    //   1. exists + active (computeVoucherDiscount also checks expiry/pool/min)
    //   2. ownership — a private/granted code requires an unused personal grant
    //      for THIS customer; only is_public codes are open to anyone holding
    //      the code. Without this, any leaked private code is redeemable.
    //   3. per-customer redemption cap
    let ok = !!candidate;
    if (ok && !candidate.is_public) {
      const grant = tdb().prepare(
        `SELECT 1 FROM retail_customer_vouchers
          WHERE customer_id = ? AND voucher_id = ? AND used_at IS NULL LIMIT 1`
      ).get(req.customer.id, candidate.id);
      if (!grant) ok = false;
    }
    if (ok && candidate.per_customer_limit && candidate.per_customer_limit > 0) {
      const used = tdb().prepare(
        `SELECT COUNT(*) AS n FROM retail_orders
          WHERE customer_id = ? AND voucher_code = ?
            AND status NOT IN ('cancelled')`
      ).get(req.customer.id, candidate.code).n;
      if (used >= candidate.per_customer_limit) ok = false;
    }
    if (ok) {
      const result = computeVoucherDiscount(candidate, subtotal, shippingFee);
      if (result.applied) {
        voucher = candidate;
        voucherDiscount = Number(result.discount) || 0;
        if (result.free_shipping) shippingFee = 0;
      }
    }
  }

  const grossTotal = Math.max(0, subtotal + shippingFee + packingFee - voucherDiscount);

  // ── Points redemption ────────────────────────────────────────────────
  // Two modes:
  //   1. payment_method === 'points' — points cover the ENTIRE order. Full
  //      balance check; refuses with insufficient_points if short.
  //   2. payment_method ∈ {wechat, alipay} with body.points_to_use > 0 —
  //      partial stack: deduct N points (cash-valued at configured rate)
  //      from the bill, customer pays the residual with wechat/alipay.
  let pointsUsed = 0, pointsAmount = 0;
  // Cash base points are allowed to redeem against. When the store excludes
  // shipping from points coverage, the residual (shipping) must always be
  // paid in cash — so the legacy points-only payment method can't settle
  // it alone and is rejected for orders that ship.
  const redeemBase = pointsRedeemableBase(subtotal, shippingFee, packingFee, voucherDiscount);
  if (paymentMethod === 'points') {
    sweepExpiredPoints(req.customer.id);
    const cust = tdb().prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(req.customer.id);
    const have = cust?.points_balance || 0;
    if (redeemBase < grossTotal) {
      return res.status(400).json({
        success: false,
        error: 'points_cannot_cover_shipping',
        shipping_due: +(grossTotal - redeemBase).toFixed(2),
      });
    }
    pointsUsed   = pointsRequiredFor(redeemBase);
    pointsAmount = redeemBase;
    if (have < pointsUsed) {
      return res.status(409).json({
        success: false,
        error: 'insufficient_points',
        required: pointsUsed,
        available: have,
      });
    }
  } else if (Number(body.points_to_use) > 0) {
    sweepExpiredPoints(req.customer.id);
    const cust = tdb().prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(req.customer.id);
    const have = cust?.points_balance || 0;
    const requested = Math.floor(Number(body.points_to_use));
    // Cap at the customer's balance AND at the points needed to fully
    // cover the redeemable base — extra points beyond that would just be
    // burned (and can't reach the shipping line when policy excludes it).
    const maxByOrder = pointsRequiredFor(redeemBase);
    pointsUsed = Math.min(requested, have, maxByOrder);
    pointsAmount = pointsCashValue(pointsUsed);
    if (requested > have) {
      return res.status(409).json({
        success: false,
        error: 'insufficient_points',
        requested,
        available: have,
      });
    }
  }
  const total = Math.max(0, grossTotal - pointsAmount);

  // ── Atomic write: order, items, payment intent, stock reservations ───
  // Reservations replace the old "decrement stock_qty on order create"
  // model. Stock at the routed store is soft-held until payment commits
  // (or expiry releases it). See lib/inventory.js for the math.
  const tx = tdb().transaction(() => {
    // Compute the daily order-no INSIDE the (immediate) tx so the count-and-
    // increment is serialized with the INSERT. Computed outside, two
    // concurrent checkouts could read the same daily max and collide on the
    // UNIQUE order_no — one would fail with a spurious order_create_failed.
    const orderNo = nextOrderNo();
    const info = tdb().prepare(
      `INSERT INTO retail_orders (
         order_no, customer_id, status, payment_method,
         recipient_name, recipient_phone, address_full, address_json,
         subtotal, shipping_fee, packing_fee, delivery_mode, delivery_zone_id,
         scheduled_for, delivery_slot_label, same_day_surcharge_fee,
         voucher_code, voucher_amount,
         points_used, points_amount, total,
         customer_note, needs_cutlery, needs_invoice, invoice_title, invoice_tax_id,
         invoice_type, invoice_email,
         store_id, routing_reason, channel,
         fallback_choice, awaiting_restock_pids, idempotency_key,
         fulfillment_type
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      orderNo, req.customer.id, 'pending_payment', paymentMethod,
      address.recipient_name, address.phone,
      [address.province, address.city, address.district, address.address, address.detail].filter(Boolean).join(' '),
      JSON.stringify(isPickup
        ? {
            pickup: true,
            store_id: pickupStore.id, store_code: pickupStore.code,
            store_name_en: pickupStore.name_en, store_name_cn: pickupStore.name_cn,
            store_phone: pickupStore.phone,
            city: address.city, district: address.district, address: address.address,
          }
        : {
            province: address.province, city: address.city, district: address.district,
            address: address.address, detail: address.detail, postal_code: address.postal_code,
          }),
      subtotal, shippingFee, packingFee, resolvedMode, deliveryZoneId,
      scheduledFor, slotLabel, sameDaySurcharge,
      voucher ? voucher.code : null, voucherDiscount,
      pointsUsed, pointsAmount, total,
      customerNote, needsCutlery, needsInvoice, invoiceTitle, invoiceTaxId,
      invoiceType, invoiceEmail,
      fulfillingStore.id, routingReason, 'wechat',
      fallbackChoice, awaitingRestockPids ? JSON.stringify(awaitingRestockPids) : null,
      idempotencyKey,
      isPickup ? 'pickup' : 'delivery'
    );
    const orderId = info.lastInsertRowid;

    // Decrement voucher max_uses pool. Bumps used_count atomically inside
    // the same transaction so two simultaneous orders can't exceed it.
    if (voucher) {
      // Conditional bump: only succeeds while the global pool isn't exhausted
      // (max_uses NULL = unlimited). If 0 rows changed, a concurrent order
      // drained the last use between our eligibility read and here — abort the
      // whole tx so we never overrun the cap or settle the discounted total
      // against an exhausted voucher.
      const vBump = tdb().prepare(
        `UPDATE retail_vouchers
            SET used_count = used_count + 1
          WHERE id = ? AND (max_uses IS NULL OR used_count < max_uses)`
      ).run(voucher.id);
      if (vBump.changes !== 1) {
        const err = new Error('voucher_exhausted');
        err.code = 'voucher_exhausted';
        throw err;
      }
      // If this customer had a personal grant for this voucher, mark the
      // grant used so it disappears from their wallet/checkout list.
      tdb().prepare(
        `UPDATE retail_customer_vouchers
            SET used_at = CURRENT_TIMESTAMP, used_order_id = ?
          WHERE customer_id = ? AND voucher_id = ? AND used_at IS NULL`
      ).run(orderId, req.customer.id, voucher.id);
    }

    const insertItem = tdb().prepare(
      `INSERT INTO retail_order_items
         (order_id, product_id, name_en, name_cn, sku, size, image_url,
          qty, unit_price, line_total, options_json,
          ship_modes, needs_ice_pack, replaced_for_product_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const r of resolved) {
      insertItem.run(
        orderId, r.product.id, r.product.name_en, r.product.name_cn,
        r.product.sku, r.product.size, null,
        r.qty, r.unitPrice, r.lineTotal,
        r.options.length ? JSON.stringify(r.options) : null,
        r.product.ship_modes || 'air,land',
        r.product.needs_ice_pack ? 1 : 0,
        r.replacedForProductId || null
      );
    }
    // Auto-plan shipments based on dest city + per-item ship_modes. For
    // in-GZ orders this is a single 'local' shipment; for outside-GZ it
    // splits into air + land when items have mixed allowed modes. Pickup
    // orders ship nothing (collected at the store), so no shipment is planned.
    if (!isPickup) ensureShipments(orderId);

    // Increment flash_sold atomically for items that were priced at flash
    // rate. The WHERE clause caps the counter at flash_stock_limit (when
    // set) — `changes !== 1` means a concurrent order beat us to the last
    // unit, so we roll back. Items with no stock cap still increment so
    // analytics + admin UI can show how many sold during the window.
    const bumpCapped = tdb().prepare(
      `UPDATE products
          SET flash_sold = COALESCE(flash_sold, 0) + ?
        WHERE id = ?
          AND flash_price IS NOT NULL
          AND (flash_stock_limit IS NULL
               OR COALESCE(flash_sold, 0) + ? <= flash_stock_limit)`
    );
    for (const r of resolved) {
      if (!r.isFlash) continue;
      const upd = bumpCapped.run(r.qty, r.product.id, r.qty);
      if (upd.changes !== 1) {
        const err = new Error('flash_stock_exceeded');
        err.code = 'flash_stock_exceeded';
        err.product_id = r.product.id;
        throw err;
      }
    }

    // Soft-reserve stock at the routed store. Throws insufficient_stock
    // if a concurrent order beat us between routing and reservation —
    // the whole transaction rolls back and the customer retries.
    // Skipped in two cases:
    //   1. 'wait_for_restock' flow — those deliberately park without
    //      reservations until missing items come back in stock.
    //   2. stockGate is off (non-GZ, or scheduled-for-later GZ) — the
    //      kitchen restocks before the fulfilment date, so a same-day
    //      reservation now would just block other same-day orders for
    //      no reason.
    if (!isWaitFlow && stockGate) {
      inventory.reserveForOrder({
        storeId: fulfillingStore.id,
        orderId,
        items: resolved.map(r => ({ product_id: r.product.id, qty: r.qty })),
        channel: 'wechat',
      });
    }

    tdb().prepare(
      `INSERT INTO retail_payments (order_id, method, amount, status, out_trade_no)
       VALUES (?, ?, ?, 'pending', ?)`
    ).run(orderId, paymentMethod, total, orderNo);

    // Consume the customer's points NOW (inside the same tx as the order
    // insert), so simultaneous orders can't double-spend the same balance.
    // The order is still 'pending_payment' at this stage — markOrderPaid()
    // (called from /payment/create) flips it to 'paid' and awards earn-points.
    if (pointsUsed > 0) {
      const upd = tdb().prepare(
        'UPDATE retail_customers SET points_balance = points_balance - ? WHERE id = ? AND points_balance >= ?'
      ).run(pointsUsed, req.customer.id, pointsUsed);
      if (upd.changes !== 1) {
        const err = new Error('insufficient_points');
        err.code = 'insufficient_points';
        throw err;
      }
      const after = tdb().prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(req.customer.id).points_balance;
      tdb().prepare(
        `INSERT INTO retail_points_transactions
           (customer_id, delta, balance_after, source, order_id, note)
         VALUES (?, ?, ?, 'order_redeem', ?, ?)`
      ).run(req.customer.id, -pointsUsed, after, orderId, `Order ${orderId} redeemed ${pointsUsed} pts`);
    }

    return orderId;
  });

  let orderId;
  // .immediate() → BEGIN IMMEDIATE so the write lock is taken at tx start,
  // making nextOrderNo()'s read-then-insert atomic even across processes.
  try { orderId = tx.immediate(); }
  catch (e) {
    if (e.code === 'insufficient_stock' || e.code === 'product_not_stocked_here') {
      return res.status(409).json({
        success: false,
        error: e.code,
        product_id: e.product_id,
        available: e.available ?? 0,
      });
    }
    if (e.code === 'flash_stock_exceeded') {
      return res.status(409).json({ success: false, error: 'flash_stock_exceeded', product_id: e.product_id });
    }
    if (e.code === 'insufficient_points') {
      return res.status(409).json({ success: false, error: 'insufficient_points' });
    }
    if (e.code === 'voucher_exhausted') {
      return res.status(409).json({ success: false, error: 'voucher_exhausted' });
    }
    // Idempotency race backstop: a truly-simultaneous second submit lost the
    // UNIQUE(customer_id, idempotency_key) race. Its whole tx rolled back (no
    // double charge / points spend) — hand back the order the winner created.
    if (idempotencyKey && /UNIQUE constraint failed:.*idempotency_key/i.test(e.message || '')) {
      const dup = tdb().prepare(
        'SELECT id FROM retail_orders WHERE customer_id = ? AND idempotency_key = ?'
      ).get(req.customer.id, idempotencyKey);
      if (dup) {
        const existing = loadOrderForCustomer(dup.id, req.customer.id, `${req.protocol}://${req.get('host')}`);
        return res.json({ success: true, data: existing, idempotent_replay: true });
      }
    }
    console.error('[retail/orders POST]', e);
    return res.status(500).json({ success: false, error: 'order_create_failed' });
  }

  const order = loadOrderForCustomer(orderId, req.customer.id, `${req.protocol}://${req.get('host')}`);
  res.json({ success: true, data: order });
});

function loadOrderForCustomer(orderId, customerId, baseUrl = '') {
  const o = tdb().prepare(
    `SELECT id, order_no, status, payment_method,
            recipient_name, recipient_phone, address_full, address_json,
            subtotal, shipping_fee, packing_fee, delivery_mode, delivery_zone_id,
            voucher_code, voucher_amount,
            points_used, points_amount, points_earned, total,
            customer_note, needs_cutlery, needs_invoice, invoice_title, invoice_tax_id,
            invoice_type, invoice_email,
            invoice_status, invoice_file_url, invoice_number, invoice_issued_at,
            staff_note, cancelled_reason,
            refund_requested_at, refund_reason, refund_status, refund_review_note,
            refund_amount_requested, refund_amount_approved, refund_amount_paid,
            refund_lines_json, refund_payout_method, refund_payout_ref,
            refund_reviewed_at, refund_approved_at, refund_paid_at,
            store_id, routing_reason, channel, fulfillment_type,
            scheduled_for, delivery_slot_label,
            tracking_carrier, tracking_number, tracking_status,
            tracking_events_json, tracking_synced_at,
            tracking_scenario, tracking_scenario_data_json,
            placed_at, paid_at, preparing_at, dispatched_at, delivered_at, cancelled_at, updated_at
       FROM retail_orders WHERE id = ? AND customer_id = ?`
  ).get(orderId, customerId);
  if (!o) return null;
  if (o.address_json) { try { o.address = JSON.parse(o.address_json); } catch {} }
  delete o.address_json;
  if (o.refund_lines_json) {
    try { o.refund_lines = JSON.parse(o.refund_lines_json); } catch { o.refund_lines = null; }
  }
  delete o.refund_lines_json;
  o.tracking = buildTrackingView(o);
  // Items snapshot historical name + price at order time, but image_url
  // was never captured (always null on insert). Fall through to the live
  // product image so order/review thumbnails actually render. The tradeoff
  // is that if staff later swaps the product photo, old orders show the
  // new one — acceptable for "remind me what I bought" UX.
  o.items = tdb().prepare(
    `SELECT oi.id, oi.product_id, oi.name_en, oi.name_cn, oi.sku, oi.size,
            COALESCE(NULLIF(oi.image_url, ''), p.image_url, p.image_data) AS image_url,
            oi.qty, oi.unit_price, oi.line_total, oi.options_json
       FROM retail_order_items oi
  LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ? ORDER BY oi.id ASC`
  ).all(orderId).map(it => {
    if (it.options_json) { try { it.options = JSON.parse(it.options_json); } catch {} }
    delete it.options_json;
    // Same fix as the orders-list endpoint: a data: URI here is the raw
    // base64 photo from products.image_data and can be hundreds of KB per
    // item, blowing past the mini-app's 12s response timeout on orders
    // with several items. Hand back a short URL the client fetches lazily.
    if (baseUrl && typeof it.image_url === 'string' && /^data:/i.test(it.image_url)) {
      it.image_url = `${baseUrl}/api/retail/products/${it.product_id}/image`;
    }
    return it;
  });
  o.timeline = orderTimeline(o);
  return o;
}

// 6-step timeline the order tracking screen renders. Active step = first
// one without a timestamp, or last step if all complete (delivered). For
// cancelled orders we expose a 2-step "placed → cancelled".
//
// "Pending" is the phase between Paid and Preparing — the kitchen has
// received payment but hasn't started cooking yet. It has no dedicated
// timestamp column; it inherits preparing_at as its "done" marker
// (Pending ends the moment Preparing begins). The order detail UI hides
// this timestamp to avoid showing the same time twice in a row.
function orderTimeline(o) {
  if (o.status === 'cancelled') {
    return [
      { key: 'placed',    label: 'Placed',    cn: '已下单',   at: o.placed_at },
      { key: 'cancelled', label: 'Cancelled', cn: '已取消', at: o.cancelled_at },
    ];
  }
  // Pickup orders never dispatch a courier — the same status columns are
  // reused but mean "ready at counter" (dispatched_at) and "collected"
  // (delivered_at). Relabel so the customer reads a collection journey
  // instead of a delivery one.
  if (o.fulfillment_type === 'pickup') {
    return [
      { key: 'placed',    label: 'Placed',          cn: '已下单', at: o.placed_at },
      { key: 'paid',      label: 'Paid',            cn: '已支付', at: o.paid_at },
      { key: 'pending',   label: 'Pending',         cn: '待确认', at: o.preparing_at },
      { key: 'preparing', label: 'Preparing',       cn: '准备中', at: o.preparing_at },
      { key: 'ready',     label: 'Ready to collect', cn: '可取货', at: o.dispatched_at },
      { key: 'collected', label: 'Collected',       cn: '已取货', at: o.delivered_at },
    ];
  }
  return [
    { key: 'placed',     label: 'Placed',          cn: '已下单',     at: o.placed_at },
    { key: 'paid',       label: 'Paid',            cn: '已支付',     at: o.paid_at },
    { key: 'pending',    label: 'Pending',         cn: '待确认',     at: o.preparing_at },
    { key: 'preparing',  label: 'Preparing',       cn: '准备中',     at: o.preparing_at },
    { key: 'dispatched', label: 'Out for delivery', cn: '配送中',    at: o.dispatched_at },
    { key: 'delivered',  label: 'Delivered',       cn: '已送达',     at: o.delivered_at },
  ];
}

// Decorate a raw retail_orders row with the bits the mini app needs to
// render the shipment tracking card: carrier name (EN+CN), normalized
// status label, deep-link to the carrier's own tracking page, parsed
// events list. Step 1 has no live events yet, so the timeline falls back
// to a synthetic "label created → in transit" derived from the order's
// own dispatched_at. Step 2 replaces tracking_status / events_json with
// real data pulled from 快递100.
function buildTrackingView(o) {
  if (!o.tracking_number || !o.tracking_carrier) return null;
  const carrier = tracking.carrierByCode(o.tracking_carrier);
  const statusCode = o.tracking_status || tracking.deriveStatusFromOrder(o.status);
  const statusDef = statusCode ? tracking.statusByCode(statusCode) : null;
  let events = [];
  if (o.tracking_events_json) {
    try {
      const raw = JSON.parse(o.tracking_events_json) || [];
      // Augment each event with an English translation. The original
      // Chinese (description_cn) stays for CN-locale customers; EN-locale
      // sees description_en, which falls back to Chinese when no rule
      // matches so the timestamp never goes empty.
      events = raw.map(ev => ({
        ...ev,
        description_en: tracking.translateEventDescription(ev.description_cn),
      }));
    } catch { events = []; }
  }
  // Hydrate the classified scenario (parsed from the latest event's
  // Chinese context) if we've stored one. This is what the customer
  // banner reads — `scenario`, `pickup_code`, `signer`, `urgency`, etc.
  let scenario = null;
  if (o.tracking_scenario_data_json) {
    try { scenario = JSON.parse(o.tracking_scenario_data_json); } catch { scenario = null; }
  }
  return {
    carrier_code:    o.tracking_carrier,
    carrier_name_en: carrier?.name_en || o.tracking_carrier,
    carrier_name_cn: carrier?.name_cn || o.tracking_carrier,
    number:          o.tracking_number,
    status_code:     statusCode,
    status_label_en: statusDef?.label_en || null,
    status_label_cn: statusDef?.label_cn || null,
    track_url:       tracking.trackingUrl(o.tracking_carrier, o.tracking_number),
    synced_at:       o.tracking_synced_at,
    events,
    scenario,        // { scenario, icon, label_en, label_cn, urgency, pickup_code?, signer?, location_label? } or null
  };
}

router.get('/api/retail/orders', requireRetailAuth, (req, res) => {
  const { status } = req.query;
  const limit  = Math.min(parseInt(req.query.limit  || '20', 10) || 20, 50);
  const offset = Math.max(parseInt(req.query.offset || '0',  10) || 0, 0);

  let sql = `SELECT id, order_no, status, payment_method, total,
                    voucher_code, voucher_amount,
                    store_id, routing_reason, channel,
                    fulfillment_type, scheduled_for, delivery_slot_label,
                    tracking_carrier, tracking_number, tracking_status,
                    placed_at, paid_at, dispatched_at, delivered_at
               FROM retail_orders WHERE customer_id = ?`;
  const params = [req.customer.id];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY placed_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = tdb().prepare(sql).all(...params);

  // Attach a tiny preview of items + item_count so the list can render
  // thumbs without N+1 follow-ups. Batched into two queries regardless of
  // page size — the previous loop fired 2×N round-trips, which made the
  // Pending bucket noticeably slow once a customer had ~20+ orders open.
  for (const r of rows) { r.items_preview = []; r.item_count = 0; }
  if (rows.length) {
    const ids = rows.map(r => r.id);
    const ph = ids.map(() => '?').join(',');
    const byId = new Map(rows.map(r => [r.id, r]));
    const previews = tdb().prepare(
      `SELECT order_id, product_id, name_en, name_cn, qty, image_url FROM (
         SELECT oi.order_id, oi.product_id, oi.name_en, oi.name_cn, oi.qty,
                COALESCE(NULLIF(oi.image_url, ''), p.image_url, p.image_data) AS image_url,
                ROW_NUMBER() OVER (PARTITION BY oi.order_id ORDER BY oi.id ASC) AS rn
           FROM retail_order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id IN (${ph})
       ) WHERE rn <= 3
         ORDER BY order_id, rn`
    ).all(...ids);
    // Rewrite inline data: URIs to the public image endpoint — mirrors the
    // shop-list fix. Inline base64 thumbs for ~50 orders × 3 items each can
    // balloon this payload past a few MB and the mini-app's 12s timeout
    // fires, leaving the page on its empty state.
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    for (const p of previews) {
      const r = byId.get(p.order_id);
      if (!r) continue;
      const img = (typeof p.image_url === 'string' && /^data:/i.test(p.image_url))
        ? `${baseUrl}/api/retail/products/${p.product_id}/image`
        : p.image_url;
      r.items_preview.push({
        product_id: p.product_id, name_en: p.name_en, name_cn: p.name_cn,
        qty: p.qty, image_url: img,
      });
    }
    const counts = tdb().prepare(
      `SELECT order_id, COUNT(*) AS n FROM retail_order_items
        WHERE order_id IN (${ph}) GROUP BY order_id`
    ).all(...ids);
    for (const c of counts) {
      const r = byId.get(c.order_id);
      if (r) r.item_count = c.n;
    }
  }
  res.json({ success: true, data: rows, meta: { limit, offset } });
});

// Customer's fapiao list — powers the "My Invoices 我的发票" section in the
// profile. Lists every order where an invoice was requested, with its derived
// state (issued vs requested) and the fapiao link/number once issued.
router.get('/api/retail/invoices', requireRetailAuth, (req, res) => {
  const rows = tdb().prepare(
    `SELECT id, order_no, total, placed_at,
            invoice_type, invoice_title, invoice_tax_id, invoice_email,
            invoice_number, invoice_file_url, invoice_issued_at,
            CASE WHEN invoice_status = 'issued' THEN 'issued' ELSE 'requested' END AS invoice_state
       FROM retail_orders
      WHERE customer_id = ? AND needs_invoice = 1
      ORDER BY placed_at DESC LIMIT 100`
  ).all(req.customer.id);
  res.json({ success: true, data: rows });
});

// Counts by status — powers the Me-tab bucket icons (Unpaid / Pending /
// Preparing / Sent / Review). `pending` = paid but not yet acknowledged;
// `preparing` = kitchen is actively preparing. `to_ship` is kept for back-
// compat (= pending + preparing). `to_review` = delivered orders that the
// customer hasn't yet reviewed, `total` = lifetime order count.
router.get('/api/retail/orders/stats', requireRetailAuth, (req, res) => {
  const buckets = tdb().prepare(
    `SELECT status, COUNT(*) AS n FROM retail_orders WHERE customer_id = ? GROUP BY status`
  ).all(req.customer.id);
  const counts = {};
  for (const b of buckets) counts[b.status] = b.n;
  const totalRow = tdb().prepare(
    'SELECT COUNT(*) AS n FROM retail_orders WHERE customer_id = ?'
  ).get(req.customer.id);
  // Count items, not orders — the Review bucket on the Me tab opens a
  // per-item list, so the badge number must match the list length.
  const toReviewRow = tdb().prepare(
    `SELECT COUNT(*) AS n
       FROM retail_order_items oi
       JOIN retail_orders o ON o.id = oi.order_id
      WHERE o.customer_id = ? AND o.status = 'delivered'
        AND NOT EXISTS (
              SELECT 1 FROM retail_reviews r
               WHERE r.customer_id = o.customer_id
                 AND r.order_id = o.id
                 AND r.product_id = oi.product_id
            )`
  ).get(req.customer.id);
  res.json({
    success: true,
    data: {
      unpaid:    counts.pending_payment || 0,
      pending:   counts.paid || 0,
      preparing: counts.preparing || 0,
      to_ship:   (counts.paid || 0) + (counts.preparing || 0),
      shipped:   counts.dispatched || 0,
      to_review: toReviewRow.n || 0,
      // After-sales = anything with an active refund process OR fully refunded.
      // Open buckets nudge the customer to check progress; terminal buckets
      // surface their history.
      after_sales: (() => {
        const r = tdb().prepare(
          `SELECT COUNT(*) AS n FROM retail_orders
            WHERE customer_id = ?
              AND (status = 'refunded'
                   OR refund_status IN ('pending','reviewing','approved','paid','rejected'))`
        ).get(req.customer.id);
        return r.n || 0;
      })(),
      total:     totalRow.n || 0,
    },
  });
});

router.get('/api/retail/orders/:id', requireRetailAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const order = loadOrderForCustomer(id, req.customer.id, `${req.protocol}://${req.get('host')}`);
  if (!order) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true, data: order });
});

// Request a fapiao (发票) for an existing PAID order — for shoppers who didn't
// tick "need an invoice" at checkout. Sets the same fields the checkout flow
// stores; the office then issues it (it appears in My Invoices). Re-requesting
// before issuance just updates the details.
router.post('/api/retail/orders/:id/invoice-request', requireRetailAuth, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const order = tdb().prepare(
    'SELECT id, status, invoice_status FROM retail_orders WHERE id = ? AND customer_id = ?'
  ).get(id, req.customer.id);
  if (!order) return res.status(404).json({ success: false, error: 'not_found' });
  if (order.status === 'pending_payment' || order.status === 'cancelled') {
    return res.status(400).json({ success: false, error: 'not_eligible' });   // unpaid / cancelled
  }
  if (order.invoice_status === 'issued') {
    return res.status(400).json({ success: false, error: 'already_issued' });
  }
  const b = req.body || {};
  const type  = b.invoice_type === 'company' ? 'company' : 'personal';
  const title = String(b.invoice_title || '').trim();
  const taxId = type === 'company' ? String(b.invoice_tax_id || '').trim() : null;
  const email = String(b.invoice_email || '').trim();
  if (!title) return res.status(400).json({ success: false, error: 'title_required' });
  if (type === 'company' && !taxId) return res.status(400).json({ success: false, error: 'tax_id_required' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ success: false, error: 'email_invalid' });
  tdb().prepare(
    'UPDATE retail_orders SET needs_invoice = 1, invoice_type = ?, invoice_title = ?, invoice_tax_id = ?, invoice_email = ? WHERE id = ?'
  ).run(type, title, taxId, email, id);
  res.json({ success: true });
});

// Items the customer still needs to review — delivered orders' items that
// don't yet have a row in retail_reviews for (customer, order, product).
// Powers the Me-tab Review bucket's dedicated list page.
router.get('/api/retail/reviews/pending', requireRetailAuth, (req, res) => {
  const rows = tdb().prepare(
    `SELECT oi.product_id, oi.name_en, oi.name_cn,
            COALESCE(NULLIF(oi.image_url, ''), p.image_url, p.image_data) AS image_url,
            oi.qty,
            o.id AS order_id, o.order_no, o.delivered_at
       FROM retail_order_items oi
       JOIN retail_orders o ON o.id = oi.order_id
  LEFT JOIN products p      ON p.id = oi.product_id
      WHERE o.customer_id = ? AND o.status = 'delivered'
        AND NOT EXISTS (
              SELECT 1 FROM retail_reviews r
               WHERE r.customer_id = o.customer_id
                 AND r.order_id = o.id
                 AND r.product_id = oi.product_id
            )
      ORDER BY o.delivered_at DESC, oi.id ASC`
  ).all(req.customer.id);
  res.json({ success: true, data: rows });
});

// ─── Vouchers / coupons ──────────────────────────────────────────────────
// Auto-grant every voucher flagged auto_grant_signup to a fresh customer.
// Called from /api/retail/auth right after the INSERT INTO retail_customers.
// Idempotent via INSERT OR IGNORE — the (customer_id, voucher_id) unique key
// on retail_customer_vouchers means a re-run can't double-grant. Expired or
// inactive vouchers are filtered out so we don't gift dead coupons.
function grantSignupVouchers(customerId) {
  if (!customerId) return 0;
  const rows = tdb().prepare(
    `SELECT id FROM retail_vouchers
      WHERE auto_grant_signup = 1
        AND is_active = 1
        AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)`
  ).all();
  if (!rows.length) return 0;
  const ins = tdb().prepare(
    `INSERT OR IGNORE INTO retail_customer_vouchers
       (customer_id, voucher_id, granted_by, granted_note)
     VALUES (?, ?, NULL, 'Auto-granted on signup')`
  );
  let n = 0;
  const tx = tdb().transaction(() => {
    for (const r of rows) {
      const info = ins.run(customerId, r.id);
      if (info.changes) n++;
    }
  });
  tx();
  return n;
}

// Compute the discount a voucher would apply given the subtotal +
// shipping fee. Returns { discount, free_shipping, applied }.
function computeVoucherDiscount(voucher, subtotal, shippingFee) {
  if (!voucher || !voucher.is_active) return { discount: 0, free_shipping: false, applied: false };
  if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) return { discount: 0, free_shipping: false, applied: false };
  if (voucher.max_uses != null && voucher.used_count >= voucher.max_uses) return { discount: 0, free_shipping: false, applied: false };
  if (Number(subtotal) < Number(voucher.min_subtotal || 0)) return { discount: 0, free_shipping: false, applied: false };
  if (voucher.type === 'fixed_amount') {
    return { discount: Math.min(Number(voucher.value || 0), Number(subtotal)), free_shipping: false, applied: true };
  }
  if (voucher.type === 'percent') {
    const pct = Math.max(0, Math.min(100, Number(voucher.value || 0)));
    return { discount: +(Number(subtotal) * pct / 100).toFixed(2), free_shipping: false, applied: true };
  }
  if (voucher.type === 'free_shipping') {
    return { discount: 0, free_shipping: true, applied: true };
  }
  return { discount: 0, free_shipping: false, applied: false };
}

// Browseable coupons — public list customers can apply without a code.
// Filters out inactive, expired, and exhausted vouchers. Auth optional:
// when a token is present we also strip ones the customer has already
// hit their per_customer_limit on.
router.get('/api/retail/vouchers/public', (req, res) => {
  const rows = tdb().prepare(
    `SELECT id, code, type, value, min_subtotal, max_uses, used_count,
            per_customer_limit, expires_at, title_en, title_cn, description
       FROM retail_vouchers
      WHERE is_active = 1 AND is_public = 1
        AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
        AND (max_uses IS NULL OR used_count < max_uses)
      ORDER BY created_at DESC
      LIMIT 50`
  ).all();

  // Optional customer-specific filtering — if a valid bearer token was sent,
  // drop ones the customer has already redeemed up to their per-customer cap.
  let customer = null;
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+([A-Za-z0-9]+)$/.exec(h);
  if (m) {
    const tokRow = tdb().prepare(
      `SELECT c.id FROM retail_auth_tokens t
         JOIN retail_customers c ON c.id = t.customer_id
        WHERE t.token = ? AND datetime(t.expires_at) > CURRENT_TIMESTAMP
          AND c.is_blocked = 0`
    ).get(m[1]);
    if (tokRow) customer = tokRow;
  }

  const filtered = rows.filter(v => {
    if (!customer || !v.per_customer_limit || v.per_customer_limit <= 0) return true;
    const used = tdb().prepare(
      `SELECT COUNT(*) AS n FROM retail_orders
        WHERE customer_id = ? AND voucher_code = ? AND status NOT IN ('cancelled')`
    ).get(customer.id, v.code).n;
    return used < v.per_customer_limit;
  });

  res.json({ success: true, data: filtered });
});

// Customer's own granted vouchers — admin-granted, unused, still-valid.
// These appear as tappable cards in the wallet + checkout (no code).
router.get('/api/retail/my-vouchers', requireRetailAuth, (req, res) => {
  const rows = tdb().prepare(
    `SELECT v.id, v.code, v.type, v.value, v.min_subtotal, v.expires_at,
            v.title_en, v.title_cn, v.description,
            g.id AS grant_id, g.granted_at, g.granted_note
       FROM retail_customer_vouchers g
       JOIN retail_vouchers v ON v.id = g.voucher_id
      WHERE g.customer_id = ?
        AND g.used_at IS NULL
        AND v.is_active = 1
        AND (v.expires_at IS NULL OR datetime(v.expires_at) > CURRENT_TIMESTAMP)
        AND (v.max_uses IS NULL OR v.used_count < v.max_uses)
      ORDER BY g.granted_at DESC`
  ).all(req.customer.id);
  res.json({ success: true, data: rows });
});

// Customer validates a code at checkout. Returns the discount + voucher
// id without committing — actual increment happens in order create.
router.post('/api/retail/vouchers/validate', requireRetailAuth, express.json(), (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const subtotal = Number(req.body?.subtotal || 0);
  if (!code) return res.status(400).json({ success: false, error: 'code_required' });
  const v = tdb().prepare(
    'SELECT * FROM retail_vouchers WHERE UPPER(code) = ? AND is_active = 1'
  ).get(code);
  if (!v) return res.status(404).json({ success: false, error: 'not_found' });
  // Ownership gate — a private/granted code is only valid for a customer who
  // holds an unused personal grant for it. Return the same not_found as a
  // nonexistent code so private codes can't be enumerated/probed.
  if (!v.is_public) {
    const grant = tdb().prepare(
      `SELECT 1 FROM retail_customer_vouchers
        WHERE customer_id = ? AND voucher_id = ? AND used_at IS NULL LIMIT 1`
    ).get(req.customer.id, v.id);
    if (!grant) return res.status(404).json({ success: false, error: 'not_found' });
  }
  // Per-customer limit check
  if (v.per_customer_limit && v.per_customer_limit > 0) {
    const used = tdb().prepare(
      `SELECT COUNT(*) AS n FROM retail_orders
        WHERE customer_id = ? AND voucher_code = ?
          AND status NOT IN ('cancelled')`
    ).get(req.customer.id, v.code).n;
    if (used >= v.per_customer_limit) {
      return res.status(409).json({ success: false, error: 'per_customer_limit_reached' });
    }
  }
  const result = computeVoucherDiscount(v, subtotal, 0);
  if (!result.applied) {
    return res.status(409).json({ success: false, error: 'not_applicable', detail: { min_subtotal: v.min_subtotal } });
  }
  res.json({
    success: true,
    data: {
      voucher_id: v.id,
      code: v.code,
      type: v.type,
      discount: result.discount,
      free_shipping: result.free_shipping,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DASHBOARD ANALYTICS — channel overview for the mini app backend. Reads
// the LIVE retail_* tables (retail_orders / retail_order_items /
// retail_customers / retail_visits), unlike the legacy /api/miniapp/analytics
// endpoint in routes/sales.js which still reads imported miniapp_orders data.
//
// All time bucketing is shifted to GZ local (+8h) because placed_at /
// created_at are stored as UTC (SQLite CURRENT_TIMESTAMP). Without the shift,
// "today" and the hourly curve would be 8 hours off for the operator.
//
// "Revenue" counts orders that were paid and not refunded/cancelled, i.e.
// status IN (paid, preparing, dispatched, delivered, awaiting_restock).
// Refunded + cancelled are reported separately in the funnel.
// ─────────────────────────────────────────────────────────────────────────
router.get('/api/retail-admin/dashboard', requireRetailAdmin, (req, res) => {
  const TZ    = '+8 hours';
  const PAID  = "status IN ('paid','preparing','dispatched','delivered','awaiting_restock')";
  const PAIDO = "o.status IN ('paid','preparing','dispatched','delivered','awaiting_restock')";

  // ── Resolve window (defaults to trailing 30 days, GZ local) ──
  const nowGz = new Date(Date.now() + 8 * 3600 * 1000);
  const toDefault   = nowGz.toISOString().slice(0, 10);
  const fromDefault = new Date(nowGz.getTime() - 29 * 86400000).toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : fromDefault;
  const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to   || '') ? req.query.to   : toDefault;
  const spanDays = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  const hourly = from === to;  // single-day view → hour-of-day curve

  // Preceding window of equal length, for delta arrows.
  const prevTo   = new Date(new Date(from).getTime() - 86400000).toISOString().slice(0, 10);
  const prevFrom = new Date(new Date(from).getTime() - spanDays * 86400000).toISOString().slice(0, 10);

  // ── Headline KPIs (current + previous window) ──
  const kpiSql = `
    SELECT COUNT(*) AS orders,
           COALESCE(SUM(total), 0) AS revenue,
           COALESCE(AVG(total), 0) AS aov,
           COUNT(DISTINCT customer_id) AS buyers
      FROM retail_orders
     WHERE ${PAID} AND date(placed_at, '${TZ}') BETWEEN ? AND ?`;
  const kpi     = tdb().prepare(kpiSql).get(from, to);
  const kpiPrev = tdb().prepare(kpiSql).get(prevFrom, prevTo);

  const visitsSql = `
    SELECT COUNT(*) AS visits,
           COUNT(DISTINCT session_id) AS sessions,
           COUNT(DISTINCT COALESCE(CAST(customer_id AS TEXT), openid, session_id)) AS visitors
      FROM retail_visits
     WHERE date(created_at, '${TZ}') BETWEEN ? AND ?`;
  const vis     = tdb().prepare(visitsSql).get(from, to);
  const visPrev = tdb().prepare(visitsSql).get(prevFrom, prevTo);

  const newCustSql = `SELECT COUNT(*) AS n FROM retail_customers WHERE date(created_at, '${TZ}') BETWEEN ? AND ?`;
  const newCust     = tdb().prepare(newCustSql).get(from, to).n;
  const newCustPrev = tdb().prepare(newCustSql).get(prevFrom, prevTo).n;

  // ── Status funnel (gross — every status in the window) ──
  const funnel = tdb().prepare(`
    SELECT status, COUNT(*) AS n, COALESCE(SUM(total), 0) AS revenue
      FROM retail_orders
     WHERE date(placed_at, '${TZ}') BETWEEN ? AND ?
     GROUP BY status`).all(from, to);
  const byStatus = {};
  for (const r of funnel) byStatus[r.status] = { n: r.n, revenue: r.revenue };
  const grossOrders = funnel.reduce((s, r) => s + r.n, 0);
  const refundedOrders = byStatus.refunded?.n || 0;
  const cancelledOrders = byStatus.cancelled?.n || 0;

  // ── Trend (zero-filled). Hourly for a single day, else daily. ──
  let trend;
  if (hourly) {
    const o = tdb().prepare(`
      SELECT CAST(strftime('%H', placed_at, '${TZ}') AS INTEGER) AS b,
             COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
        FROM retail_orders
       WHERE ${PAID} AND date(placed_at, '${TZ}') = ?
       GROUP BY b`).all(from);
    const v = tdb().prepare(`
      SELECT CAST(strftime('%H', created_at, '${TZ}') AS INTEGER) AS b,
             COUNT(*) AS visits, COUNT(DISTINCT session_id) AS sessions
        FROM retail_visits
       WHERE date(created_at, '${TZ}') = ?
       GROUP BY b`).all(from);
    const om = Object.fromEntries(o.map(r => [r.b, r]));
    const vm = Object.fromEntries(v.map(r => [r.b, r]));
    trend = Array.from({ length: 24 }, (_, h) => ({
      bucket: String(h).padStart(2, '0') + ':00',
      orders:   om[h]?.orders   || 0,
      revenue:  om[h]?.revenue  || 0,
      visits:   vm[h]?.visits   || 0,
      sessions: vm[h]?.sessions || 0,
    }));
  } else {
    const o = tdb().prepare(`
      SELECT date(placed_at, '${TZ}') AS b,
             COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
        FROM retail_orders
       WHERE ${PAID} AND date(placed_at, '${TZ}') BETWEEN ? AND ?
       GROUP BY b`).all(from, to);
    const v = tdb().prepare(`
      SELECT date(created_at, '${TZ}') AS b,
             COUNT(*) AS visits, COUNT(DISTINCT session_id) AS sessions
        FROM retail_visits
       WHERE date(created_at, '${TZ}') BETWEEN ? AND ?
       GROUP BY b`).all(from, to);
    const om = Object.fromEntries(o.map(r => [r.b, r]));
    const vm = Object.fromEntries(v.map(r => [r.b, r]));
    trend = [];
    for (let i = 0; i < spanDays; i++) {
      const d = new Date(new Date(from).getTime() + i * 86400000).toISOString().slice(0, 10);
      trend.push({
        bucket: d,
        orders:   om[d]?.orders   || 0,
        revenue:  om[d]?.revenue  || 0,
        visits:   vm[d]?.visits   || 0,
        sessions: vm[d]?.sessions || 0,
      });
    }
  }

  // ── Payment-method split ──
  const payments = tdb().prepare(`
    SELECT COALESCE(payment_method, 'unknown') AS method,
           COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
      FROM retail_orders
     WHERE ${PAID} AND date(placed_at, '${TZ}') BETWEEN ? AND ?
     GROUP BY method ORDER BY revenue DESC`).all(from, to);

  // ── Delivery-mode split ──
  const delivery = tdb().prepare(`
    SELECT COALESCE(delivery_mode, 'unknown') AS mode,
           COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
      FROM retail_orders
     WHERE ${PAID} AND date(placed_at, '${TZ}') BETWEEN ? AND ?
     GROUP BY mode ORDER BY orders DESC`).all(from, to);

  // ── Fulfilling store + routing reason ──
  const stores = tdb().prepare(`
    SELECT o.store_id, s.name_en, s.name_cn,
           COUNT(*) AS orders, COALESCE(SUM(o.total), 0) AS revenue
      FROM retail_orders o
      LEFT JOIN retail_stores s ON s.id = o.store_id
     WHERE ${PAIDO} AND date(o.placed_at, '${TZ}') BETWEEN ? AND ?
     GROUP BY o.store_id ORDER BY orders DESC`).all(from, to);
  const routing = tdb().prepare(`
    SELECT COALESCE(routing_reason, 'unknown') AS reason, COUNT(*) AS orders
      FROM retail_orders
     WHERE ${PAID} AND date(placed_at, '${TZ}') BETWEEN ? AND ?
     GROUP BY reason ORDER BY orders DESC`).all(from, to);

  // ── Top products (by revenue) ──
  const topProducts = tdb().prepare(`
    SELECT i.product_id, i.name_en, i.name_cn, i.image_url, i.sku,
           COALESCE(SUM(i.qty), 0) AS units,
           COALESCE(SUM(i.line_total), 0) AS revenue,
           COUNT(DISTINCT i.order_id) AS orders
      FROM retail_order_items i
      JOIN retail_orders o ON o.id = i.order_id
     WHERE ${PAIDO} AND date(o.placed_at, '${TZ}') BETWEEN ? AND ?
     GROUP BY i.product_id ORDER BY revenue DESC LIMIT 15`).all(from, to);

  // ── Top customers (by spend in window) ──
  const topCustomers = tdb().prepare(`
    SELECT o.customer_id, c.nickname, c.phone, c.tier_key,
           COUNT(*) AS orders, COALESCE(SUM(o.total), 0) AS revenue,
           MAX(o.placed_at) AS last_order
      FROM retail_orders o
      JOIN retail_customers c ON c.id = o.customer_id
     WHERE ${PAIDO} AND date(o.placed_at, '${TZ}') BETWEEN ? AND ?
     GROUP BY o.customer_id ORDER BY revenue DESC LIMIT 15`).all(from, to);

  // ── New vs returning buyers (first-ever paid order in window = new) ──
  const nvr = tdb().prepare(`
    SELECT COUNT(DISTINCT o.customer_id) AS buyers,
           COUNT(DISTINCT CASE WHEN fo.first_day BETWEEN ? AND ? THEN o.customer_id END) AS new_buyers
      FROM retail_orders o
      JOIN (SELECT customer_id, MIN(date(placed_at, '${TZ}')) AS first_day
              FROM retail_orders WHERE ${PAID} GROUP BY customer_id) fo
        ON fo.customer_id = o.customer_id
     WHERE ${PAIDO} AND date(o.placed_at, '${TZ}') BETWEEN ? AND ?`).get(from, to, from, to);

  // ── Loyalty-tier distribution (active customer base snapshot) ──
  const tiers = tdb().prepare(`
    SELECT COALESCE(tier_key, 'seed') AS tier, COUNT(*) AS n
      FROM retail_customers WHERE is_blocked = 0
     GROUP BY tier ORDER BY n DESC`).all();

  // ── Geography (address_json snapshot) ──
  const geoCities = tdb().prepare(`
    SELECT json_extract(address_json, '$.city') AS city,
           COUNT(*) AS orders, COUNT(DISTINCT customer_id) AS customers,
           COALESCE(SUM(total), 0) AS revenue
      FROM retail_orders
     WHERE ${PAID} AND date(placed_at, '${TZ}') BETWEEN ? AND ?
       AND address_json IS NOT NULL AND json_extract(address_json, '$.city') IS NOT NULL
     GROUP BY city ORDER BY revenue DESC LIMIT 15`).all(from, to);
  const geoDistricts = tdb().prepare(`
    SELECT json_extract(address_json, '$.city') AS city,
           json_extract(address_json, '$.district') AS district,
           COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
      FROM retail_orders
     WHERE ${PAID} AND date(placed_at, '${TZ}') BETWEEN ? AND ?
       AND address_json IS NOT NULL AND json_extract(address_json, '$.district') IS NOT NULL
     GROUP BY city, district ORDER BY revenue DESC LIMIT 20`).all(from, to);

  // ── Marketing impact ──
  const vouchers = tdb().prepare(`
    SELECT voucher_code AS code, COUNT(*) AS uses,
           COALESCE(SUM(voucher_amount), 0) AS discount,
           COALESCE(SUM(total), 0) AS revenue
      FROM retail_orders
     WHERE ${PAID} AND date(placed_at, '${TZ}') BETWEEN ? AND ?
       AND voucher_code IS NOT NULL AND voucher_code != ''
     GROUP BY voucher_code ORDER BY uses DESC LIMIT 15`).all(from, to);
  const points = tdb().prepare(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(points_used), 0) AS points_used,
           COALESCE(SUM(points_amount), 0) AS points_value
      FROM retail_orders
     WHERE ${PAID} AND date(placed_at, '${TZ}') BETWEEN ? AND ? AND points_used > 0`).get(from, to);

  // ── Traffic: WeChat launch-scene breakdown ──
  const scenes = tdb().prepare(`
    SELECT scene, COUNT(*) AS visits, COUNT(DISTINCT session_id) AS sessions
      FROM retail_visits
     WHERE date(created_at, '${TZ}') BETWEEN ? AND ? AND scene IS NOT NULL
     GROUP BY scene ORDER BY visits DESC LIMIT 12`).all(from, to);

  // ── Demand heatmap (day-of-week × hour-of-day, paid orders) ──
  // dow: 0=Sun … 6=Sat (strftime '%w'); hour: 0–23. Drives the staffing grid.
  const heat = tdb().prepare(`
    SELECT CAST(strftime('%w', placed_at, '${TZ}') AS INTEGER) AS dow,
           CAST(strftime('%H', placed_at, '${TZ}') AS INTEGER) AS hour,
           COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
      FROM retail_orders
     WHERE ${PAID} AND date(placed_at, '${TZ}') BETWEEN ? AND ?
     GROUP BY dow, hour`).all(from, to);

  // ── Cohort retention (monthly, full history — NOT window-clipped) ──
  // cohort_month = the month of a customer's first-ever paid order;
  // active_month = any month they placed a paid order. The frontend pivots
  // these into a cohort × months-since-first retention matrix.
  const cohorts = tdb().prepare(`
    WITH first_order AS (
      SELECT customer_id, strftime('%Y-%m', MIN(placed_at), '${TZ}') AS cohort_month
        FROM retail_orders WHERE ${PAID} GROUP BY customer_id),
         activity AS (
      SELECT DISTINCT customer_id, strftime('%Y-%m', placed_at, '${TZ}') AS active_month
        FROM retail_orders WHERE ${PAID})
    SELECT f.cohort_month, a.active_month,
           COUNT(DISTINCT a.customer_id) AS active_customers
      FROM activity a JOIN first_order f ON f.customer_id = a.customer_id
     GROUP BY f.cohort_month, a.active_month`).all();
  const cohortSizes = tdb().prepare(`
    WITH first_order AS (
      SELECT customer_id, strftime('%Y-%m', MIN(placed_at), '${TZ}') AS cohort_month
        FROM retail_orders WHERE ${PAID} GROUP BY customer_id)
    SELECT cohort_month, COUNT(*) AS size
      FROM first_order GROUP BY cohort_month ORDER BY cohort_month`).all();

  // ── Revenue composition (product subtotal vs delivery vs discounts) ──
  const composition = tdb().prepare(`
    SELECT COALESCE(SUM(subtotal), 0)       AS product_total,
           COALESCE(SUM(shipping_fee), 0)   AS delivery_fee,
           COALESCE(SUM(voucher_amount), 0) AS voucher_total,
           COALESCE(SUM(points_amount), 0)  AS points_total,
           COALESCE(SUM(total), 0)          AS net_total
      FROM retail_orders
     WHERE ${PAID} AND date(placed_at, '${TZ}') BETWEEN ? AND ?`).get(from, to);

  const conversion = vis.sessions > 0 ? (kpi.orders / vis.sessions) * 100 : null;
  const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

  res.json({
    success: true,
    data: {
      window: { from, to, span_days: spanDays, granularity: hourly ? 'hour' : 'day' },
      prev_window: { from: prevFrom, to: prevTo },
      kpis: {
        revenue:       kpi.revenue,
        orders:        kpi.orders,
        aov:           kpi.aov,
        buyers:        kpi.buyers,
        new_customers: newCust,
        visits:        vis.visits,
        sessions:      vis.sessions,
        visitors:      vis.visitors,
        conversion_rate: conversion,
        gross_orders:  grossOrders,
        refunded_orders: refundedOrders,
        cancelled_orders: cancelledOrders,
        refund_rate: kpi.orders + refundedOrders > 0
          ? Math.round((refundedOrders / (kpi.orders + refundedOrders)) * 1000) / 10 : 0,
      },
      deltas: {
        revenue:       pct(kpi.revenue, kpiPrev.revenue),
        orders:        pct(kpi.orders, kpiPrev.orders),
        aov:           pct(kpi.aov, kpiPrev.aov),
        new_customers: pct(newCust, newCustPrev),
        visits:        pct(vis.visits, visPrev.visits),
        sessions:      pct(vis.sessions, visPrev.sessions),
      },
      trend,
      funnel: byStatus,
      new_vs_returning: {
        buyers: nvr.buyers || 0,
        new_buyers: nvr.new_buyers || 0,
        returning_buyers: (nvr.buyers || 0) - (nvr.new_buyers || 0),
      },
      payments, delivery, stores, routing,
      topProducts, topCustomers, tiers,
      geoCities, geoDistricts,
      marketing: { vouchers, points },
      traffic: { scenes },
      heat, cohorts, cohortSizes, composition,
    },
  });
});

// Admin CRUD for vouchers.
router.get('/api/retail-admin/vouchers', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(
    `SELECT v.*,
            (SELECT COUNT(*) FROM retail_customer_vouchers g WHERE g.voucher_id = v.id)              AS grant_count,
            (SELECT COUNT(*) FROM retail_customer_vouchers g WHERE g.voucher_id = v.id AND g.used_at IS NOT NULL) AS grant_used_count
       FROM retail_vouchers v
      ORDER BY v.is_active DESC, v.created_at DESC
      LIMIT 500`
  ).all();
  res.json({ success: true, data: rows });
});

router.post('/api/retail-admin/vouchers', requireRetailAdmin, express.json(), (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ success: false, error: 'code_required' });
  if (!['fixed_amount', 'percent', 'free_shipping'].includes(b.type)) {
    return res.status(400).json({ success: false, error: 'invalid_type' });
  }
  try {
    const info = tdb().prepare(
      `INSERT INTO retail_vouchers
         (code, type, value, min_subtotal, max_uses, per_customer_limit, expires_at,
          is_active, is_public, title_en, title_cn, description, auto_grant_signup, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      code, b.type, Number(b.value) || 0, Number(b.min_subtotal) || 0,
      b.max_uses != null && b.max_uses !== '' ? parseInt(b.max_uses, 10) : null,
      b.per_customer_limit != null ? parseInt(b.per_customer_limit, 10) : 1,
      b.expires_at || null,
      b.is_active === false ? 0 : 1,
      b.is_public ? 1 : 0,
      b.title_en || null,
      b.title_cn || null,
      b.description || null,
      b.auto_grant_signup ? 1 : 0,
      req.user.id
    );
    logActivity(req.user.id, req.user.username, 'create', 'voucher', info.lastInsertRowid, { code, type: b.type }, req.ip);
    res.json({ success: true, data: tdb().prepare('SELECT * FROM retail_vouchers WHERE id = ?').get(info.lastInsertRowid) });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(409).json({ success: false, error: 'code_exists' });
    res.status(500).json({ success: false, error: e.message });
  }
});

router.patch('/api/retail-admin/vouchers/:id', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const v = tdb().prepare('SELECT id FROM retail_vouchers WHERE id = ?').get(id);
  if (!v) return res.status(404).json({ success: false, error: 'not_found' });
  const fields = ['value', 'min_subtotal', 'max_uses', 'per_customer_limit', 'expires_at',
                  'is_active', 'is_public', 'title_en', 'title_cn', 'description',
                  'auto_grant_signup'];
  const updates = {};
  for (const f of fields) if (f in req.body) updates[f] = req.body[f];
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: 'no_fields' });
  if ('is_active' in updates) updates.is_active = updates.is_active ? 1 : 0;
  if ('is_public' in updates) updates.is_public = updates.is_public ? 1 : 0;
  if ('auto_grant_signup' in updates) updates.auto_grant_signup = updates.auto_grant_signup ? 1 : 0;
  if ('expires_at' in updates && !updates.expires_at) updates.expires_at = null;
  // Coerce + bound numeric fields, mirroring POST, so a malformed PATCH can't
  // store a non-numeric or negative discount that breaks computeVoucherDiscount.
  if ('value' in updates)        updates.value        = Math.max(0, Number(updates.value) || 0);
  if ('min_subtotal' in updates) updates.min_subtotal = Math.max(0, Number(updates.min_subtotal) || 0);
  if ('max_uses' in updates) {
    updates.max_uses = (updates.max_uses != null && updates.max_uses !== '')
      ? Math.max(0, parseInt(updates.max_uses, 10) || 0) : null;
  }
  if ('per_customer_limit' in updates) {
    updates.per_customer_limit = Math.max(0, parseInt(updates.per_customer_limit, 10) || 0);
  }
  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  tdb().prepare(`UPDATE retail_vouchers SET ${sets} WHERE id = ?`).run(...Object.values(updates), id);
  res.json({ success: true });
});

router.delete('/api/retail-admin/vouchers/:id', requireRetailAdmin, (req, res) => {
  tdb().prepare('UPDATE retail_vouchers SET is_active = 0 WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ success: true });
});

// Customer search — used by the voucher-grant modal in /retail-admin.
// Matches name, phone, or openid prefix. Returns 20 most recent matches.
// Customers list — used by both the voucher autocomplete (simple ?q) and the
// Customers admin tab (paginated, filterable). Backward compatible: same URL,
// same `data` field shape (plus extra columns), older callers ignore the new
// `page/pageSize/total` fields.
router.get('/api/retail-admin/customers', requireRetailAdmin, (req, res) => {
  const q              = String(req.query.q || '').trim();
  const tier           = String(req.query.tier || '').trim();
  const includeBlocked = req.query.includeBlocked === '1';
  const sort           = String(req.query.sort || 'recent_login');
  const page           = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize       = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const offset         = (page - 1) * pageSize;

  const where  = [];
  const params = [];
  if (!includeBlocked) where.push('is_blocked = 0');
  if (tier)            { where.push('tier_key = ?'); params.push(tier); }

  if (q) {
    const like = '%' + q + '%';
    if (/^\d+$/.test(q)) {
      // numeric → also match as order id
      where.push('(nickname LIKE ? OR phone LIKE ? OR openid LIKE ? OR id IN (SELECT customer_id FROM retail_orders WHERE id = ?))');
      params.push(like, like, like, parseInt(q, 10));
    } else {
      where.push('(nickname LIKE ? OR phone LIKE ? OR openid LIKE ?)');
      params.push(like, like, like);
    }
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  let orderClause;
  if      (sort === 'lifetime_spend') orderClause = 'lifetime_spend DESC, id DESC';
  else if (sort === 'recent_signup')  orderClause = 'created_at DESC, id DESC';
  else if (sort === 'points_balance') orderClause = 'points_balance DESC, id DESC';
  else                                orderClause = 'last_login_at IS NULL, last_login_at DESC, id DESC';

  const total = tdb().prepare(`SELECT COUNT(*) AS n FROM retail_customers ${whereSql}`).get(...params).n;

  const rows = tdb().prepare(
    `SELECT id, nickname, phone, openid, email, tier_key, lifetime_spend,
            points_balance, balance, is_blocked, created_at, last_login_at,
            (SELECT COUNT(*) FROM retail_orders WHERE customer_id = retail_customers.id) AS orders_count
       FROM retail_customers
       ${whereSql}
       ORDER BY ${orderClause}
       LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);

  res.json({ success: true, data: rows, page, pageSize, total });
});

// List grants for a voucher (who has it, who used it).
router.get('/api/retail-admin/vouchers/:id/grants', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = tdb().prepare(
    `SELECT g.id, g.customer_id, g.granted_at, g.granted_note,
            g.used_at, g.used_order_id,
            c.nickname, c.phone
       FROM retail_customer_vouchers g
       LEFT JOIN retail_customers c ON c.id = g.customer_id
      WHERE g.voucher_id = ?
      ORDER BY g.granted_at DESC`
  ).all(id);
  res.json({ success: true, data: rows });
});

// Grant a voucher to one or more customers, or to every non-blocked customer
// (when body.to_all is true). Idempotent per (customer, voucher) via the
// UNIQUE constraint — customers who already have a grant are skipped.
router.post('/api/retail-admin/vouchers/:id/grant', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const v = tdb().prepare('SELECT id, code FROM retail_vouchers WHERE id = ?').get(id);
  if (!v) return res.status(404).json({ success: false, error: 'voucher_not_found' });

  const toAll = req.body?.to_all === true;
  const note  = req.body?.note ? String(req.body.note).slice(0, 200) : null;

  let ids;
  if (toAll) {
    ids = tdb().prepare('SELECT id FROM retail_customers WHERE is_blocked = 0').all().map(r => r.id);
  } else {
    ids = Array.isArray(req.body?.customer_ids) ? req.body.customer_ids : [];
  }
  if (!ids.length) return res.status(400).json({ success: false, error: 'no_customers' });

  const ins = tdb().prepare(
    `INSERT OR IGNORE INTO retail_customer_vouchers
       (customer_id, voucher_id, granted_by, granted_note)
     VALUES (?, ?, ?, ?)`
  );
  let granted = 0, skipped = 0;
  const tx = tdb().transaction(() => {
    for (const cid of ids) {
      const n = parseInt(cid, 10);
      if (!n) continue;
      const info = ins.run(n, id, req.user.id, note);
      if (info.changes) granted++; else skipped++;
    }
  });
  tx();
  logActivity(req.user.id, req.user.username, 'grant', 'voucher', id,
              { code: v.code, granted, skipped, to_all: toAll }, req.ip);
  res.json({ success: true, granted, skipped, to_all: toAll });
});

// Revoke an unused grant.
router.delete('/api/retail-admin/voucher-grants/:grantId', requireRetailAdmin, (req, res) => {
  const gid = parseInt(req.params.grantId, 10);
  const r = tdb().prepare(
    'DELETE FROM retail_customer_vouchers WHERE id = ? AND used_at IS NULL'
  ).run(gid);
  if (!r.changes) return res.status(409).json({ success: false, error: 'already_used_or_missing' });
  res.json({ success: true });
});

// ─── Customer admin (profile, analytics, edits, adjustments) ─────────────
// Full profile + behavioral aggregates for one customer. All counts are
// computed live so the column `lifetime_spend` (currently never written) is
// not used as a source of truth.
router.get('/api/retail-admin/customers/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: 'bad_id' });

  const customer = tdb().prepare('SELECT * FROM retail_customers WHERE id = ?').get(id);
  if (!customer) return res.status(404).json({ success: false, error: 'not_found' });

  const addresses = tdb().prepare(
    'SELECT * FROM retail_customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, id DESC'
  ).all(id);

  const orders = tdb().prepare(
    `SELECT
       COUNT(*) AS orders_count,
       SUM(CASE WHEN status NOT IN ('cancelled','refunded','pending_payment') THEN 1 ELSE 0 END) AS completed_count,
       SUM(CASE WHEN status = 'refunded'  THEN 1 ELSE 0 END) AS refunded_count,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
       COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','refunded','pending_payment') THEN total ELSE 0 END), 0) AS revenue,
       AVG(CASE WHEN status NOT IN ('cancelled','refunded','pending_payment') THEN total ELSE NULL END) AS aov,
       MAX(placed_at) AS last_order_at,
       MIN(placed_at) AS first_order_at
       FROM retail_orders WHERE customer_id = ?`
  ).get(id);

  const points = tdb().prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN delta > 0 AND source IN ('order_earn','topup_bonus') THEN delta ELSE 0 END), 0) AS earned,
       COALESCE(SUM(CASE WHEN delta < 0 AND source = 'order_redeem'                 THEN -delta ELSE 0 END), 0) AS redeemed,
       COALESCE(SUM(CASE WHEN delta < 0 AND source = 'expiry'                       THEN -delta ELSE 0 END), 0) AS expired,
       COALESCE(SUM(CASE WHEN source = 'admin_adjust'                                THEN delta ELSE 0 END), 0) AS admin_adjust
       FROM retail_points_transactions WHERE customer_id = ?`
  ).get(id);

  const expiringSoon = tdb().prepare(
    `SELECT COALESCE(SUM(delta), 0) AS pts
       FROM retail_points_transactions
      WHERE customer_id = ? AND delta > 0
        AND expires_at IS NOT NULL AND expired_at IS NULL
        AND expires_at <= datetime('now', '+30 days')`
  ).get(id).pts;

  const topup = tdb().prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN status='success' AND COALESCE(payment_method,'') != 'admin_adjust' THEN amount       ELSE 0 END), 0) AS topup_total,
       COALESCE(SUM(CASE WHEN status='success' AND COALESCE(payment_method,'') != 'admin_adjust' THEN bonus_points ELSE 0 END), 0) AS bonus_pts_total,
       COALESCE(SUM(CASE WHEN status='success' AND payment_method='admin_adjust'                  THEN amount       ELSE 0 END), 0) AS admin_adjust_total
       FROM retail_topup_transactions WHERE customer_id = ?`
  ).get(id);

  const vouchers = tdb().prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN used_at IS NULL     THEN 1 ELSE 0 END), 0) AS unused,
       COALESCE(SUM(CASE WHEN used_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS used
       FROM retail_customer_vouchers WHERE customer_id = ?`
  ).get(id);

  const reviews = tdb().prepare(
    `SELECT COUNT(*) AS count, AVG(rating) AS avg_rating
       FROM retail_reviews WHERE customer_id = ?`
  ).get(id);

  const sessions = tdb().prepare(
    "SELECT COUNT(*) AS n FROM retail_auth_tokens WHERE customer_id = ? AND expires_at > datetime('now')"
  ).get(id).n;

  const topItems = tdb().prepare(
    `SELECT i.name_en, i.name_cn, SUM(i.qty) AS qty, SUM(i.line_total) AS spend
       FROM retail_order_items i
       JOIN retail_orders o ON o.id = i.order_id
      WHERE o.customer_id = ?
        AND o.status NOT IN ('cancelled','refunded','pending_payment')
      GROUP BY i.name_en, i.name_cn
      ORDER BY qty DESC
      LIMIT 5`
  ).all(id);

  const ordersByMonth = tdb().prepare(
    `SELECT strftime('%Y-%m', placed_at) AS month,
            COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','refunded','pending_payment') THEN total ELSE 0 END), 0) AS revenue
       FROM retail_orders
      WHERE customer_id = ?
        AND placed_at >= datetime('now', '-12 months')
      GROUP BY month
      ORDER BY month`
  ).all(id);

  const recentOrders = tdb().prepare(
    `SELECT id, order_no, status, total, placed_at AS created_at
       FROM retail_orders
      WHERE customer_id = ?
      ORDER BY id DESC LIMIT 10`
  ).all(id);

  const recentPoints = tdb().prepare(
    `SELECT id, delta, balance_after, source, order_id, note, created_at, expires_at
       FROM retail_points_transactions
      WHERE customer_id = ?
      ORDER BY id DESC LIMIT 20`
  ).all(id);

  const recentTopups = tdb().prepare(
    `SELECT id, amount, bonus_points, payment_method, status, created_at, paid_at
       FROM retail_topup_transactions
      WHERE customer_id = ?
      ORDER BY id DESC LIMIT 10`
  ).all(id);

  // Days since last order — handy churn signal.
  let daysSinceLastOrder = null;
  if (orders.last_order_at) {
    const ms = Date.now() - new Date(orders.last_order_at + 'Z').getTime();
    daysSinceLastOrder = Math.max(0, Math.floor(ms / 86400000));
  }

  // Affiliate context: this customer's own invites + their referrer (if any).
  const referrer = customer.referred_by_customer_id ? tdb().prepare(
    'SELECT id, nickname, phone, referral_code FROM retail_customers WHERE id = ?'
  ).get(customer.referred_by_customer_id) : null;
  const referralsByMe = tdb().prepare(
    `SELECT r.id, r.status, r.reward_amount, r.code_used, r.joined_at, r.rewarded_at,
            r.first_paid_order_id,
            ci.id AS invitee_id, ci.nickname AS invitee_nickname, ci.phone AS invitee_phone
       FROM retail_referrals r
       JOIN retail_customers ci ON ci.id = r.invitee_id
      WHERE r.referrer_id = ?
      ORDER BY r.id DESC
      LIMIT 50`
  ).all(id);
  const referralsAgg = tdb().prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status='ordered' THEN 1 ELSE 0 END), 0) AS converted,
            COALESCE(SUM(CASE WHEN status='ordered' THEN reward_amount ELSE 0 END), 0) AS earned
       FROM retail_referrals WHERE referrer_id = ?`
  ).get(id);

  res.json({
    success: true,
    data: {
      customer,
      addresses,
      stats: {
        orders: { ...orders, days_since_last_order: daysSinceLastOrder },
        points: { ...points, expiring_30d: expiringSoon },
        topup: topup,
        vouchers,
        reviews,
        active_sessions: sessions
      },
      top_items: topItems,
      orders_by_month: ordersByMonth,
      recent_orders: recentOrders,
      recent_points: recentPoints,
      recent_topups: recentTopups,
      affiliate: {
        referral_code: customer.referral_code,
        referred_by:   referrer,
        invites:       referralsByMe,
        summary:       referralsAgg,
      }
    }
  });
});

// Edit safe profile fields. Phone is loosely validated; openid/unionid are
// never editable from here (they are WeChat-issued and changing them breaks
// future logins).
router.patch('/api/retail-admin/customers/:id', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: 'bad_id' });
  const c = tdb().prepare('SELECT * FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });

  const b = req.body || {};
  const updates = [];
  const params  = [];
  const changed = {};

  const setStr = (col, max = 100) => {
    if (b[col] === undefined) return;
    const v = b[col] === null || b[col] === '' ? null : String(b[col]).slice(0, max);
    updates.push(`${col} = ?`); params.push(v); changed[col] = v;
  };
  setStr('nickname', 60);
  setStr('email', 120);

  if (b.phone !== undefined) {
    const v = b.phone === null || b.phone === '' ? null : String(b.phone).replace(/\s+/g, '').slice(0, 20);
    if (v && !/^\+?[0-9]{7,15}$/.test(v)) {
      return res.status(400).json({ success: false, error: 'bad_phone' });
    }
    updates.push('phone = ?'); params.push(v); changed.phone = v;
  }
  if (b.gender !== undefined) {
    const v = b.gender === null || b.gender === '' ? null : parseInt(b.gender, 10);
    if (v !== null && ![0, 1, 2].includes(v)) {
      return res.status(400).json({ success: false, error: 'bad_gender' });
    }
    updates.push('gender = ?'); params.push(v); changed.gender = v;
  }
  if (b.birthday !== undefined) {
    const v = b.birthday === null || b.birthday === '' ? null : String(b.birthday).slice(0, 10);
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return res.status(400).json({ success: false, error: 'bad_birthday' });
    }
    updates.push('birthday = ?'); params.push(v); changed.birthday = v;
  }
  // tier_key is intentionally not editable here — it's auto-derived from
  // lifetime_spend (see tierFromSpend / reconcileTier). Any tier_key in the
  // payload is silently ignored so older admin builds don't error.

  if (!updates.length) return res.json({ success: true, changed: {} });

  params.push(id);
  tdb().prepare(`UPDATE retail_customers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  logActivity(req.user.id, req.user.username, 'update', 'retail_customer', id, changed, req.ip);
  res.json({ success: true, changed });
});

// Block / unblock — toggling `is_blocked`. Blocking does not invalidate
// existing tokens; the caller should hit /force-logout if they want that too.
router.post('/api/retail-admin/customers/:id/block', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const reason = req.body?.reason ? String(req.body.reason).slice(0, 200) : null;
  const r = tdb().prepare('UPDATE retail_customers SET is_blocked = 1 WHERE id = ?').run(id);
  if (!r.changes) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'block', 'retail_customer', id, { reason }, req.ip);
  res.json({ success: true });
});
router.post('/api/retail-admin/customers/:id/unblock', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = tdb().prepare('UPDATE retail_customers SET is_blocked = 0 WHERE id = ?').run(id);
  if (!r.changes) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'unblock', 'retail_customer', id, {}, req.ip);
  res.json({ success: true });
});

// Revoke every active auth token for the customer — forces re-login on
// next mini-app open.
router.post('/api/retail-admin/customers/:id/force-logout', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c  = tdb().prepare('SELECT id FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });
  const r = tdb().prepare('DELETE FROM retail_auth_tokens WHERE customer_id = ?').run(id);
  logActivity(req.user.id, req.user.username, 'force_logout', 'retail_customer', id, { revoked: r.changes }, req.ip);
  res.json({ success: true, revoked: r.changes });
});

// Manual points adjustment — writes an `admin_adjust` ledger row and
// updates the cached balance atomically. Reason is required so the audit
// trail is meaningful.
router.post('/api/retail-admin/customers/:id/points-adjust', requireRetailAdmin, express.json(), (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const delta  = parseInt(req.body?.delta, 10);
  const reason = String(req.body?.reason || '').trim().slice(0, 200);
  const MAX_POINTS_ADJUST = 10000000;  // sanity cap: ±10M points per adjustment
  if (!id || !Number.isFinite(delta) || delta === 0 || Math.abs(delta) > MAX_POINTS_ADJUST) {
    return res.status(400).json({ success: false, error: 'bad_delta' });
  }
  if (!reason) return res.status(400).json({ success: false, error: 'reason_required' });

  const c = tdb().prepare('SELECT id FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });

  // Atomic, race-safe adjust: the balance is incremented and floor-checked in
  // a SINGLE conditional UPDATE (not read-then-write), so two concurrent
  // adjustments can't both pass a stale "would_go_negative" check or clobber
  // each other's write.
  let balanceAfter;
  try {
    const tx = tdb().transaction(() => {
      const upd = tdb().prepare(
        'UPDATE retail_customers SET points_balance = COALESCE(points_balance, 0) + ? WHERE id = ? AND COALESCE(points_balance, 0) + ? >= 0'
      ).run(delta, id, delta);
      if (upd.changes !== 1) { const e = new Error('would_go_negative'); e.code = 'WOULD_GO_NEGATIVE'; throw e; }
      balanceAfter = tdb().prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(id).points_balance;
      tdb().prepare(
        `INSERT INTO retail_points_transactions (customer_id, delta, balance_after, source, note)
         VALUES (?, ?, ?, 'admin_adjust', ?)`
      ).run(id, delta, balanceAfter, `[${req.user.username}] ${reason}`);
    });
    tx();
  } catch (e) {
    if (e.code === 'WOULD_GO_NEGATIVE') return res.status(409).json({ success: false, error: 'would_go_negative' });
    throw e;
  }
  logActivity(req.user.id, req.user.username, 'points_adjust', 'retail_customer', id, { delta, reason, balance_after: balanceAfter }, req.ip);
  res.json({ success: true, balance_after: balanceAfter });
});

// Manual wallet adjustment — writes a `payment_method='admin_adjust'` row
// to retail_topup_transactions (amount may be negative for clawback) and
// updates the cached balance atomically.
router.post('/api/retail-admin/customers/:id/wallet-adjust', requireRetailAdmin, express.json(), (req, res) => {
  const id       = parseInt(req.params.id, 10);
  const deltaRaw = Number(req.body?.delta);
  const reason   = String(req.body?.reason || '').trim().slice(0, 200);
  const MAX_WALLET_ADJUST = 1000000;  // sanity cap: ±¥1,000,000 per adjustment
  if (!id || !Number.isFinite(deltaRaw) || deltaRaw === 0 || Math.abs(deltaRaw) > MAX_WALLET_ADJUST) {
    return res.status(400).json({ success: false, error: 'bad_delta' });
  }
  if (!reason) return res.status(400).json({ success: false, error: 'reason_required' });
  const delta = Math.round(deltaRaw * 100) / 100;  // store to cent precision
  if (delta === 0) return res.status(400).json({ success: false, error: 'bad_delta' });

  const c = tdb().prepare('SELECT id FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });

  // Atomic, race-safe adjust: balance is incremented, rounded to cents, and
  // floor-checked in ONE conditional UPDATE, so concurrent adjustments can't
  // both pass a stale negative check or lose a write.
  let balanceAfter;
  try {
    const tx = tdb().transaction(() => {
      const upd = tdb().prepare(
        'UPDATE retail_customers SET balance = ROUND(COALESCE(balance, 0) + ?, 2) WHERE id = ? AND ROUND(COALESCE(balance, 0) + ?, 2) >= 0'
      ).run(delta, id, delta);
      if (upd.changes !== 1) { const e = new Error('would_go_negative'); e.code = 'WOULD_GO_NEGATIVE'; throw e; }
      balanceAfter = tdb().prepare('SELECT balance FROM retail_customers WHERE id = ?').get(id).balance;
      tdb().prepare(
        `INSERT INTO retail_topup_transactions
           (customer_id, amount, bonus_points, payment_method, status, paid_at, out_trade_no, raw_callback_json)
         VALUES (?, ?, 0, 'admin_adjust', 'success', CURRENT_TIMESTAMP, ?, ?)`
      ).run(id, delta, `adminadj:${req.user.id}:${Date.now()}`, JSON.stringify({ reason, by: req.user.username }));
    });
    tx();
  } catch (e) {
    if (e.code === 'WOULD_GO_NEGATIVE') return res.status(409).json({ success: false, error: 'would_go_negative' });
    throw e;
  }
  logActivity(req.user.id, req.user.username, 'wallet_adjust', 'retail_customer', id, { delta, reason, balance_after: balanceAfter }, req.ip);
  res.json({ success: true, balance_after: balanceAfter });
});

// Address admin — create / edit / delete a customer's saved addresses.
// Mirrors the customer-side routes at /api/retail/addresses but scoped by
// path-param customer_id and gated by retail-admin auth.
router.post('/api/retail-admin/customers/:id/addresses', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: 'bad_id' });
  const c = tdb().prepare('SELECT id FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });
  const a = normalizeChinaAddress(req.body || {});
  if (!a.recipient_name || !a.phone || !a.address) {
    return res.status(400).json({ success: false, error: 'missing_required' });
  }
  const tx = tdb().transaction(() => {
    if (a.is_default) {
      tdb().prepare('UPDATE retail_customer_addresses SET is_default = 0 WHERE customer_id = ?').run(id);
    }
    const info = tdb().prepare(
      `INSERT INTO retail_customer_addresses
         (customer_id, recipient_name, phone, province, city, district,
          address, detail, postal_code, is_default)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      String(a.recipient_name).slice(0, 60),
      String(a.phone).slice(0, 20),
      a.province ? String(a.province).slice(0, 40) : null,
      a.city     ? String(a.city).slice(0, 40)     : null,
      a.district ? String(a.district).slice(0, 40) : null,
      String(a.address).slice(0, 200),
      a.detail      ? String(a.detail).slice(0, 200)   : null,
      a.postal_code ? String(a.postal_code).slice(0, 16) : null,
      a.is_default ? 1 : 0
    );
    return info.lastInsertRowid;
  });
  const newId = tx();
  logActivity(req.user.id, req.user.username, 'create', 'retail_customer_address', newId, { customer_id: id }, req.ip);
  const row = tdb().prepare(`SELECT ${ADDRESS_PUBLIC_COLS} FROM retail_customer_addresses WHERE id = ?`).get(newId);
  res.json({ success: true, data: row });
});

router.put('/api/retail-admin/customers/:id/addresses/:addrId', requireRetailAdmin, express.json(), (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const addrId = parseInt(req.params.addrId, 10);
  const existing = tdb().prepare('SELECT id FROM retail_customer_addresses WHERE id = ? AND customer_id = ?').get(addrId, id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });
  const incoming = req.body || {};
  const a = (incoming.province || incoming.city || incoming.district || incoming.address)
    ? normalizeChinaAddress(incoming)
    : incoming;
  const tx = tdb().transaction(() => {
    if (a.is_default) {
      tdb().prepare('UPDATE retail_customer_addresses SET is_default = 0 WHERE customer_id = ?').run(id);
    }
    tdb().prepare(
      `UPDATE retail_customer_addresses
          SET recipient_name = COALESCE(?, recipient_name),
              phone          = COALESCE(?, phone),
              province       = COALESCE(?, province),
              city           = COALESCE(?, city),
              district       = COALESCE(?, district),
              address        = COALESCE(?, address),
              detail         = COALESCE(?, detail),
              postal_code    = COALESCE(?, postal_code),
              is_default     = COALESCE(?, is_default),
              updated_at     = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(
      a.recipient_name == null ? null : String(a.recipient_name).slice(0, 60),
      a.phone          == null ? null : String(a.phone).slice(0, 20),
      a.province       === undefined ? null : (a.province ? String(a.province).slice(0, 40) : ''),
      a.city           === undefined ? null : (a.city     ? String(a.city).slice(0, 40)     : ''),
      a.district       === undefined ? null : (a.district ? String(a.district).slice(0, 40) : ''),
      a.address        == null ? null : String(a.address).slice(0, 200),
      a.detail         === undefined ? null : (a.detail      ? String(a.detail).slice(0, 200)   : ''),
      a.postal_code    === undefined ? null : (a.postal_code ? String(a.postal_code).slice(0, 16) : ''),
      a.is_default     == null ? null : (a.is_default ? 1 : 0),
      addrId
    );
  });
  tx();
  logActivity(req.user.id, req.user.username, 'update', 'retail_customer_address', addrId, { customer_id: id }, req.ip);
  const row = tdb().prepare(`SELECT ${ADDRESS_PUBLIC_COLS} FROM retail_customer_addresses WHERE id = ?`).get(addrId);
  res.json({ success: true, data: row });
});

router.delete('/api/retail-admin/customers/:id/addresses/:addrId', requireRetailAdmin, (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const addrId = parseInt(req.params.addrId, 10);
  const r = tdb().prepare('DELETE FROM retail_customer_addresses WHERE id = ? AND customer_id = ?').run(addrId, id);
  if (!r.changes) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'delete', 'retail_customer_address', addrId, { customer_id: id }, req.ip);
  res.json({ success: true });
});

// ─── Affiliate / refer-a-friend ──────────────────────────────────────────
// Program rules (enabled, ¥reward per first paid order) live in
// storefront_config under `affiliate.*` so the admin Affiliate tab is the
// only place edits happen — customers can VIEW their code + invites
// through /api/retail/affiliate but cannot change settings or reward
// amounts.
//
// Flow:
//   1. Customer opens the mini-app affiliate page → GET /api/retail/affiliate
//      lazily mints a stable referral_code on retail_customers.
//   2. Friend signs up, opens the affiliate page, applies a code via
//      POST /api/retail/affiliate/apply → writes retail_referrals row
//      with status='joined'. One-shot: customers can't change their
//      referrer once set.
//   3. Friend's first paid order triggers creditReferralReward(orderId)
//      inside markOrderPaid — flips the row to 'ordered', credits the
//      referrer's wallet through the existing retail_topup_transactions
//      ledger (payment_method='referral_reward'), updates cached balance.

const AFFILIATE_REWARD_DEFAULT = 30;       // ¥ per first paid order
const REFERRAL_CODE_PREFIX     = 'ROOTS-';
const REFERRAL_CODE_BODY_LEN   = 6;        // 6 alnum chars → ~36^6 ≈ 2B keyspace

function affiliateSettings() {
  return {
    enabled:        cfgValue('affiliate.enabled', true) ? true : false,
    rewardPerOrder: Number(cfgValue('affiliate.rewardPerOrder', AFFILIATE_REWARD_DEFAULT)) || 0,
    codePrefix:     String(cfgValue('affiliate.codePrefix', REFERRAL_CODE_PREFIX)),
  };
}

// 6-char alnum (uppercase, no 0/O/1/I confusables). Re-rolled on collision.
function newReferralCodeBody() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < REFERRAL_CODE_BODY_LEN; i++) {
    s += alphabet[crypto.randomBytes(1)[0] % alphabet.length];
  }
  return s;
}

function ensureReferralCode(customerId) {
  const row = tdb().prepare('SELECT referral_code FROM retail_customers WHERE id = ?').get(customerId);
  if (!row) return null;
  if (row.referral_code) return row.referral_code;
  const prefix = affiliateSettings().codePrefix;
  for (let i = 0; i < 8; i++) {
    const candidate = prefix + newReferralCodeBody();
    try {
      tdb().prepare('UPDATE retail_customers SET referral_code = ? WHERE id = ? AND referral_code IS NULL').run(candidate, customerId);
      const fresh = tdb().prepare('SELECT referral_code FROM retail_customers WHERE id = ?').get(customerId);
      if (fresh.referral_code) return fresh.referral_code;
    } catch (e) { /* UNIQUE collision — retry */ }
  }
  return null;
}

function affiliateInvitesFor(referrerId) {
  return tdb().prepare(
    `SELECT r.id, r.invitee_id, r.code_used, r.status, r.reward_amount,
            r.first_paid_order_id, r.joined_at, r.rewarded_at,
            c.nickname, c.avatar_url
       FROM retail_referrals r
       JOIN retail_customers c ON c.id = r.invitee_id
      WHERE r.referrer_id = ?
      ORDER BY r.id DESC`
  ).all(referrerId);
}

function affiliateStatsFor(referrerId) {
  const agg = tdb().prepare(
    `SELECT
       COUNT(*) AS total_invites,
       COALESCE(SUM(CASE WHEN status IN ('joined','ordered') THEN 1 ELSE 0 END), 0) AS joined,
       COALESCE(SUM(CASE WHEN status = 'ordered' THEN 1 ELSE 0 END), 0) AS converted,
       COALESCE(SUM(CASE WHEN status = 'ordered' THEN reward_amount ELSE 0 END), 0) AS earned
       FROM retail_referrals WHERE referrer_id = ?`
  ).get(referrerId);
  return {
    total_invites: agg.total_invites || 0,
    joined:        agg.joined        || 0,
    converted:     agg.converted     || 0,
    earned:        Number((agg.earned || 0).toFixed(2)),
  };
}

router.get('/api/retail/affiliate', requireRetailAuth, (req, res) => {
  const s = affiliateSettings();
  const code = ensureReferralCode(req.customer.id);
  const referredBy = tdb().prepare(
    `SELECT c.id, c.nickname, c.referral_code
       FROM retail_customers me
       LEFT JOIN retail_customers c ON c.id = me.referred_by_customer_id
      WHERE me.id = ?`
  ).get(req.customer.id);
  res.json({
    success: true,
    data: {
      enabled:          s.enabled,
      reward_per_order: s.rewardPerOrder,
      code,
      referred_by:      referredBy?.id ? { id: referredBy.id, nickname: referredBy.nickname, code: referredBy.referral_code } : null,
      stats:            affiliateStatsFor(req.customer.id),
      invites:          affiliateInvitesFor(req.customer.id),
    },
  });
});

// Apply a referral code. One-shot per customer; rejected if:
//   • affiliate program is disabled
//   • customer already applied a code (regardless of status)
//   • code doesn't match anyone, or matches the same customer
//   • the inviter has themselves been referred BY this customer (would
//     create a 2-cycle; cheap protection against trivial loops)
router.post('/api/retail/affiliate/apply', requireRetailAuth, express.json(), (req, res) => {
  const s = affiliateSettings();
  if (!s.enabled) return res.status(409).json({ success: false, error: 'program_disabled' });
  const raw = String(req.body?.code || '').trim().toUpperCase();
  if (!raw) return res.status(400).json({ success: false, error: 'code_required' });

  const me = tdb().prepare('SELECT id, referred_by_customer_id FROM retail_customers WHERE id = ?').get(req.customer.id);
  if (me.referred_by_customer_id) {
    return res.status(409).json({ success: false, error: 'already_referred' });
  }
  const inviter = tdb().prepare('SELECT id, referred_by_customer_id FROM retail_customers WHERE referral_code = ?').get(raw);
  if (!inviter)         return res.status(404).json({ success: false, error: 'code_not_found' });
  if (inviter.id === me.id) return res.status(409).json({ success: false, error: 'cannot_refer_self' });
  if (inviter.referred_by_customer_id === me.id) {
    return res.status(409).json({ success: false, error: 'mutual_referral' });
  }

  const tx = tdb().transaction(() => {
    tdb().prepare(
      `UPDATE retail_customers
          SET referred_by_customer_id = ?,
              referral_applied_at     = CURRENT_TIMESTAMP
        WHERE id = ? AND referred_by_customer_id IS NULL`
    ).run(inviter.id, me.id);
    tdb().prepare(
      `INSERT OR IGNORE INTO retail_referrals
         (referrer_id, invitee_id, code_used, status, reward_amount)
       VALUES (?, ?, ?, 'joined', ?)`
    ).run(inviter.id, me.id, raw, s.rewardPerOrder);
  });
  tx();

  res.json({
    success: true,
    data: {
      inviter_id:       inviter.id,
      reward_per_order: s.rewardPerOrder,
    },
  });
});

// Credit the referrer when the invitee's FIRST paid order lands.
// Idempotent: keyed on (invitee, first_paid_order_id), and the row's
// status='joined' guard prevents double-pay if markOrderPaid fires twice.
// Crediting goes through the existing wallet ledger (retail_topup_transactions
// with payment_method='referral_reward') so it shows up in the wallet
// history alongside top-ups and admin adjustments.
function creditReferralReward(orderId) {
  const s = affiliateSettings();
  if (!s.enabled) return;
  const o = tdb().prepare('SELECT id, customer_id, status FROM retail_orders WHERE id = ?').get(orderId);
  if (!o || o.status !== 'paid') return;
  const ref = tdb().prepare(
    `SELECT id, referrer_id, invitee_id, reward_amount, status
       FROM retail_referrals
      WHERE invitee_id = ? AND status = 'joined'`
  ).get(o.customer_id);
  if (!ref) return;
  // Only the FIRST paid order counts — if there's already an earlier paid
  // order for this customer, skip (defensive; status='joined' should
  // already block this once the first order rewards).
  const earlier = tdb().prepare(
    "SELECT 1 FROM retail_orders WHERE customer_id = ? AND id < ? AND paid_at IS NOT NULL LIMIT 1"
  ).get(o.customer_id, orderId);
  if (earlier) {
    tdb().prepare("UPDATE retail_referrals SET status = 'void', voided_at = CURRENT_TIMESTAMP, voided_reason = 'not_first_order' WHERE id = ?").run(ref.id);
    return;
  }
  const reward = Number(ref.reward_amount) || 0;
  const tx = tdb().transaction(() => {
    if (reward > 0) {
      const cur = tdb().prepare('SELECT balance FROM retail_customers WHERE id = ?').get(ref.referrer_id);
      const after = Math.round(((cur?.balance || 0) + reward) * 100) / 100;
      tdb().prepare('UPDATE retail_customers SET balance = ? WHERE id = ?').run(after, ref.referrer_id);
      tdb().prepare(
        `INSERT INTO retail_topup_transactions
           (customer_id, amount, bonus_points, payment_method, status, paid_at, out_trade_no, raw_callback_json)
         VALUES (?, ?, 0, 'referral_reward', 'success', CURRENT_TIMESTAMP, ?, ?)`
      ).run(
        ref.referrer_id, reward,
        `referral:${ref.id}:${orderId}`,
        JSON.stringify({ referral_id: ref.id, invitee_id: ref.invitee_id, order_id: orderId })
      );
    }
    tdb().prepare(
      `UPDATE retail_referrals
          SET status = 'ordered',
              first_paid_order_id = ?,
              rewarded_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'joined'`
    ).run(orderId, ref.id);
  });
  try { tx(); } catch (e) { console.error('[creditReferralReward]', e); }
}

// ─── Affiliate admin ─────────────────────────────────────────────────────
router.get('/api/retail-admin/affiliate/settings', requireRetailAdmin, (req, res) => {
  res.json({ success: true, data: affiliateSettings() });
});

router.patch('/api/retail-admin/affiliate/settings', requireRetailAdmin, express.json(), (req, res) => {
  const b = req.body || {};
  const writes = [];
  if (typeof b.enabled === 'boolean') writes.push(['affiliate.enabled', b.enabled]);
  if (b.rewardPerOrder !== undefined) {
    const n = Number(b.rewardPerOrder);
    if (!Number.isFinite(n) || n < 0 || n > 10000) return res.status(400).json({ success: false, error: 'bad_reward' });
    writes.push(['affiliate.rewardPerOrder', Math.round(n * 100) / 100]);
  }
  if (typeof b.codePrefix === 'string') {
    const p = b.codePrefix.trim().toUpperCase().slice(0, 12);
    if (!/^[A-Z0-9-]*$/.test(p)) return res.status(400).json({ success: false, error: 'bad_prefix' });
    writes.push(['affiliate.codePrefix', p || REFERRAL_CODE_PREFIX]);
  }
  if (!writes.length) return res.status(400).json({ success: false, error: 'no_fields' });
  const up = tdb().prepare(
    `INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
     VALUES (?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  );
  const tx = tdb().transaction(() => {
    for (const [k, v] of writes) up.run(k, JSON.stringify(v), req.user.id);
  });
  tx();
  logActivity(req.user.id, req.user.username, 'affiliate_settings_update', 'storefront_config', null, { keys: writes.map(w => w[0]) }, req.ip);
  res.json({ success: true, data: affiliateSettings() });
});

router.get('/api/retail-admin/affiliate/referrals', requireRetailAdmin, (req, res) => {
  const q       = String(req.query.q || '').trim();
  const status  = String(req.query.status || '').trim();
  const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const offset  = (page - 1) * pageSize;

  const where  = [];
  const params = [];
  if (status && ['joined','ordered','void'].includes(status)) { where.push('r.status = ?'); params.push(status); }
  if (q) {
    const like = '%' + q + '%';
    where.push(`(r.code_used LIKE ? OR cr.nickname LIKE ? OR cr.phone LIKE ?
                 OR ci.nickname LIKE ? OR ci.phone LIKE ?)`);
    params.push(like, like, like, like, like);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = tdb().prepare(
    `SELECT COUNT(*) AS n FROM retail_referrals r
       JOIN retail_customers cr ON cr.id = r.referrer_id
       JOIN retail_customers ci ON ci.id = r.invitee_id
       ${whereSql}`
  ).get(...params).n;

  const rows = tdb().prepare(
    `SELECT r.id, r.referrer_id, r.invitee_id, r.code_used, r.status,
            r.reward_amount, r.first_paid_order_id, r.joined_at, r.rewarded_at,
            r.voided_at, r.voided_reason,
            cr.nickname AS referrer_nickname, cr.phone AS referrer_phone,
            ci.nickname AS invitee_nickname,  ci.phone AS invitee_phone
       FROM retail_referrals r
       JOIN retail_customers cr ON cr.id = r.referrer_id
       JOIN retail_customers ci ON ci.id = r.invitee_id
       ${whereSql}
       ORDER BY r.id DESC
       LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);

  const agg = tdb().prepare(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN status = 'joined'  THEN 1 ELSE 0 END), 0) AS joined,
       COALESCE(SUM(CASE WHEN status = 'ordered' THEN 1 ELSE 0 END), 0) AS converted,
       COALESCE(SUM(CASE WHEN status = 'void'    THEN 1 ELSE 0 END), 0) AS voided,
       COALESCE(SUM(CASE WHEN status = 'ordered' THEN reward_amount ELSE 0 END), 0) AS paid_out
       FROM retail_referrals`
  ).get();

  res.json({ success: true, data: rows, page, pageSize, total, summary: agg });
});

// Manual edit: change status (mark void / restore), or override the reward
// amount on a pending referral. Cannot rewind an already-paid 'ordered'
// row from here — that would require reversing the wallet credit; use
// the existing wallet-adjust endpoint to claw back if needed.
router.patch('/api/retail-admin/affiliate/referrals/:id', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = tdb().prepare('SELECT * FROM retail_referrals WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  const b = req.body || {};
  const updates = [];
  const params  = [];
  if (typeof b.status === 'string' && ['joined','void'].includes(b.status)) {
    if (row.status === 'ordered') return res.status(409).json({ success: false, error: 'already_paid' });
    updates.push('status = ?'); params.push(b.status);
    if (b.status === 'void') {
      updates.push("voided_at = CURRENT_TIMESTAMP");
      updates.push("voided_reason = ?"); params.push(String(b.voided_reason || 'admin').slice(0, 200));
    } else {
      updates.push('voided_at = NULL'); updates.push('voided_reason = NULL');
    }
  }
  if (b.reward_amount !== undefined) {
    if (row.status === 'ordered') return res.status(409).json({ success: false, error: 'already_paid' });
    const n = Number(b.reward_amount);
    if (!Number.isFinite(n) || n < 0 || n > 10000) return res.status(400).json({ success: false, error: 'bad_reward' });
    updates.push('reward_amount = ?'); params.push(Math.round(n * 100) / 100);
  }
  if (!updates.length) return res.status(400).json({ success: false, error: 'no_fields' });
  params.push(id);
  tdb().prepare(`UPDATE retail_referrals SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  logActivity(req.user.id, req.user.username, 'update', 'referral', id, b, req.ip);
  res.json({ success: true, data: tdb().prepare('SELECT * FROM retail_referrals WHERE id = ?').get(id) });
});

// Reissue a customer's referral code (e.g., admin wants a new one after a
// public leak). Old code is dropped; existing referrals keep their
// code_used snapshot so history is unaffected.
router.post('/api/retail-admin/customers/:id/referral-code', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = tdb().prepare('SELECT id FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });
  tdb().prepare('UPDATE retail_customers SET referral_code = NULL WHERE id = ?').run(id);
  const code = ensureReferralCode(id);
  logActivity(req.user.id, req.user.username, 'referral_code_reissue', 'retail_customer', id, { code }, req.ip);
  res.json({ success: true, data: { code } });
});

// ─── Reviews ─────────────────────────────────────────────────────────────
// Default tag chips. The admin can override labels / colors / sort order
// via the Reviews tab in /retail-admin — that writes a `reviews.tags`
// blob to storefront_config which both the customer mini-app and the POST
// allow-list below read from. These defaults seed brand-new installs and
// act as a fallback if the config blob is missing or corrupt.
const DEFAULT_REVIEW_TAGS = [
  { id: 'fresh',     en: 'Super fresh',     cn: '很新鲜', color: 'lime'     },
  { id: 'tasty',     en: 'Tastes great',    cn: '味道好', color: 'papaya'   },
  { id: 'fast-ship', en: 'Fast ship',       cn: '发货快', color: 'sky'      },
  { id: 'packed',    en: 'Great packaging', cn: '包装好', color: 'corn'     },
  { id: 'value',     en: 'Worth it',        cn: '值得',   color: 'pea'      },
  { id: 'eco',       en: 'Eco-friendly',    cn: '环保',   color: 'cucumber' },
  { id: 'will-buy',  en: 'Will reorder',    cn: '会回购', color: 'pink'     },
];
const REVIEW_MAX_PHOTOS = 6;

// Read editable tag list out of storefront_config; fall back to defaults
// when the key isn't set (fresh install) or fails to parse.
function getReviewTags() {
  const cfg = loadConfig();
  const list = cfg?.reviews?.tags;
  if (Array.isArray(list) && list.length) {
    return list
      .filter(t => t && typeof t.id === 'string' && t.id)
      .map(t => ({
        id: String(t.id),
        en: String(t.en || ''),
        cn: String(t.cn || ''),
        color: String(t.color || 'lime'),
      }));
  }
  return DEFAULT_REVIEW_TAGS;
}

// Paginated review list per product. Public.
router.get('/api/retail/products/:id/reviews', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'bad_id' });
  const limit  = Math.min(parseInt(req.query.limit  || '20', 10) || 20, 50);
  const offset = Math.max(parseInt(req.query.offset || '0',  10) || 0, 0);
  const rows = tdb().prepare(
    `SELECT r.id, r.rating, r.comment, r.created_at, r.tags_json, r.photos_json,
            c.nickname AS customer_name, c.avatar_url AS customer_avatar
       FROM retail_reviews r
  LEFT JOIN retail_customers c ON c.id = r.customer_id
      WHERE r.product_id = ? AND r.is_visible = 1
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?`
  ).all(id, limit, offset).map(r => ({
    ...r,
    tags:   parseJsonArray(r.tags_json),
    photos: parseJsonArray(r.photos_json),
    tags_json: undefined, photos_json: undefined,
  }));
  const total = tdb().prepare(
    'SELECT COUNT(*) AS n FROM retail_reviews WHERE product_id = ? AND is_visible = 1'
  ).get(id).n;
  res.set('Cache-Control', 'public, max-age=30');
  res.json({ success: true, data: rows, meta: { total, limit, offset } });
});

// Customer uploads a single review photo. Same base64-data-URI flow as
// the avatar endpoint — wx.uploadFile's separate AppID whitelist isn't
// provisioned on the preview AppID so we go through wx.request.
router.post('/api/retail/review-photos', requireRetailAuth, express.json({ limit: '8mb' }), (req, res) => {
  const { data } = req.body || {};
  if (typeof data !== 'string' || !data.startsWith('data:image/')) {
    return res.status(400).json({ success: false, error: 'bad_data_uri' });
  }
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!m) return res.status(400).json({ success: false, error: 'bad_data_uri' });
  const sizeBytes = Math.floor(m[2].length * 3 / 4);
  if (sizeBytes > 5 * 1024 * 1024) {
    return res.status(400).json({ success: false, error: 'too_large' });
  }
  // Verify the bytes are a real raster image (rejects SVG / spoofed mime) and
  // pin the stored mime + data URI to the sniffed type, not the client label.
  let mime, normData;
  try {
    const buf = Buffer.from(m[2], 'base64');
    mime = sniffImageMime(buf);
    if (!mime) return res.status(400).json({ success: false, error: 'bad_data_uri' });
    normData = `data:${mime};base64,${m[2]}`;
  } catch { return res.status(400).json({ success: false, error: 'bad_data_uri' }); }
  try {
    const info = tdb().prepare(
      `INSERT INTO retail_media (filename, mime_type, size_bytes, data, uploaded_by)
       VALUES (?, ?, ?, ?, NULL)`
    ).run('review-photo', mime, sizeBytes, normData);
    res.json({ success: true, data: { url: `/api/retail/media/${info.lastInsertRowid}` } });
  } catch (e) {
    console.error('[retail/review-photo] insert failed:', e.message);
    res.status(500).json({ success: false, error: 'db_insert_failed' });
  }
});

// Customer submits a bug report / feedback from the mini app "Found a bug?"
// form. One-way: it lands read-only in the Mini App Backend → Feedback tab
// (separate from the staff `feedback` table). Photos arrive as already-uploaded
// /api/retail/media/:id URLs (same uploader as reviews: base64 → retail_media).
router.post('/api/retail/feedback', requireRetailAuth, express.json({ limit: '1mb' }), (req, res) => {
  const message = (req.body?.message || '').toString().trim().slice(0, 4000);
  if (!message) return res.status(400).json({ success: false, error: 'message_required' });
  const pageContext = (req.body?.page_context || '').toString().slice(0, 200) || null;
  const appVersion  = (req.body?.app_version  || '').toString().slice(0, 60)  || null;
  // Keep only our own media URLs — drop anything that isn't a /api/retail/media/:id
  // path so a client can't stash arbitrary links in the inbox.
  const photos = Array.isArray(req.body?.photos)
    ? req.body.photos
        .filter(u => typeof u === 'string' && /^\/api\/retail\/media\/\d+$/.test(u))
        .slice(0, 6)
    : [];
  const name = req.customer?.nickname || ('#' + req.customer.id);
  try {
    const info = tdb().prepare(
      `INSERT INTO retail_feedback (customer_id, customer_name, message, photos_json, page_context, app_version)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(req.customer.id, name, message, photos.length ? JSON.stringify(photos) : null, pageContext, appVersion);
    res.json({ success: true, data: { id: info.lastInsertRowid } });
  } catch (e) {
    console.error('[retail/feedback] insert failed:', e.message);
    res.status(500).json({ success: false, error: 'db_insert_failed' });
  }
});

// Customer submits a review. Must own a 'delivered' order containing this
// product (anti-spam — only buyers can review). One review per
// (customer, product, order) — UNIQUE constraint catches dupes.
router.post('/api/retail/products/:id/reviews', requireRetailAuth, express.json(), (req, res) => {
  const productId = parseInt(req.params.id, 10);
  const orderId   = parseInt(req.body?.order_id, 10);
  const rating    = parseInt(req.body?.rating, 10);
  const comment   = (req.body?.comment || '').slice(0, 1000);
  if (!productId || !orderId)             return res.status(400).json({ success: false, error: 'missing_fields' });
  if (!(rating >= 1 && rating <= 5))      return res.status(400).json({ success: false, error: 'invalid_rating' });
  // Allow-list tags; drop anything we don't recognise so a malicious
  // client can't smuggle arbitrary text through this field.
  const tagsIn = Array.isArray(req.body?.tags) ? req.body.tags : [];
  const allowedTagIds = new Set(getReviewTags().map(t => t.id));
  const tags = Array.from(new Set(
    tagsIn.filter(t => typeof t === 'string' && allowedTagIds.has(t))
  ));
  // Photos arrive as URLs already uploaded via /api/retail/review-photos.
  // We only accept our own media paths so the JSON blob can't host arbitrary
  // off-site image URLs.
  const photosIn = Array.isArray(req.body?.photos) ? req.body.photos : [];
  const photos = photosIn
    .filter(p => typeof p === 'string' && /^\/api\/retail\/media\/\d+$/.test(p))
    .slice(0, REVIEW_MAX_PHOTOS);
  // Verify the customer actually bought this product on a delivered order
  const eligible = tdb().prepare(
    `SELECT 1 FROM retail_orders o
       JOIN retail_order_items i ON i.order_id = o.id
      WHERE o.id = ? AND o.customer_id = ?
        AND i.product_id = ?
        AND o.status = 'delivered'`
  ).get(orderId, req.customer.id, productId);
  if (!eligible) return res.status(403).json({ success: false, error: 'not_eligible' });
  try {
    const info = tdb().prepare(
      `INSERT INTO retail_reviews
         (customer_id, product_id, order_id, rating, comment, tags_json, photos_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      req.customer.id, productId, orderId,
      rating, comment || null,
      tags.length   ? JSON.stringify(tags)   : null,
      photos.length ? JSON.stringify(photos) : null,
    );
    res.json({ success: true, data: { id: info.lastInsertRowid } });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) {
      return res.status(409).json({ success: false, error: 'already_reviewed' });
    }
    console.error('[reviews/post]', e);
    res.status(500).json({ success: false, error: 'insert_failed' });
  }
});

// ─── Admin: review moderation ───────────────────────────────────────────
// Paginated list across all products for staff moderation. Filters by
// visibility, rating, product. Joins customer + product so the table can
// show context without the client making N follow-up requests.
// Customer bug reports / feedback from the mini app "Found a bug?" form.
// Read-only inbox — newest first. Separate from the staff `feedback` table.
router.get('/api/retail-admin/feedback', requireRetailAdmin, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '100', 10) || 100, 300);
  const offset = Math.max(parseInt(req.query.offset || '0',   10) || 0, 0);
  const rows = tdb().prepare(
    `SELECT f.id, f.customer_id, f.customer_name, f.message,
            f.photos_json, f.page_context, f.app_version, f.created_at,
            c.nickname AS nickname, c.avatar_url AS customer_avatar
       FROM retail_feedback f
  LEFT JOIN retail_customers c ON c.id = f.customer_id
   ORDER BY f.created_at DESC
      LIMIT ? OFFSET ?`
  ).all(limit, offset).map(f => ({
    ...f,
    photos: parseJsonArray(f.photos_json),
    photos_json: undefined,
  }));
  const total = tdb().prepare('SELECT COUNT(*) AS n FROM retail_feedback').get().n;
  res.json({ success: true, data: rows, meta: { total, limit, offset } });
});

router.get('/api/retail-admin/reviews', requireRetailAdmin, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '50', 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset || '0',  10) || 0, 0);
  const where = [];
  const args  = [];
  if (req.query.visible === '1' || req.query.visible === '0') {
    where.push('r.is_visible = ?');
    args.push(parseInt(req.query.visible, 10));
  }
  const rating = parseInt(req.query.rating, 10);
  if (rating >= 1 && rating <= 5) {
    where.push('r.rating = ?');
    args.push(rating);
  }
  const productId = parseInt(req.query.product_id, 10);
  if (productId) {
    where.push('r.product_id = ?');
    args.push(productId);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = tdb().prepare(
    `SELECT r.id, r.rating, r.comment, r.is_visible, r.created_at,
            r.tags_json, r.photos_json,
            r.product_id, r.order_id, r.customer_id,
            p.name_en  AS product_name_en,
            p.name_cn  AS product_name_cn,
            c.nickname AS customer_name,
            c.avatar_url AS customer_avatar,
            o.order_no AS order_no
       FROM retail_reviews r
  LEFT JOIN products         p ON p.id = r.product_id
  LEFT JOIN retail_customers c ON c.id = r.customer_id
  LEFT JOIN retail_orders    o ON o.id = r.order_id
       ${whereSql}
   ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?`
  ).all(...args, limit, offset).map(r => ({
    ...r,
    tags:   parseJsonArray(r.tags_json),
    photos: parseJsonArray(r.photos_json),
    tags_json: undefined, photos_json: undefined,
  }));
  const total = tdb().prepare(
    `SELECT COUNT(*) AS n FROM retail_reviews r ${whereSql}`
  ).get(...args).n;
  // Aggregate counts for the filter chips so staff can see "12 hidden"
  // without flipping the filter.
  const summary = tdb().prepare(
    `SELECT
       SUM(CASE WHEN is_visible = 1 THEN 1 ELSE 0 END) AS visible,
       SUM(CASE WHEN is_visible = 0 THEN 1 ELSE 0 END) AS hidden,
       COUNT(*) AS total
       FROM retail_reviews`
  ).get();
  res.json({
    success: true,
    data: rows,
    meta: { total, limit, offset, summary },
  });
});

// Staff moderation toggle — currently just is_visible. Keeping the body
// shape PATCH-style so we can grow this without an API rename.
router.patch('/api/retail-admin/reviews/:id', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const exists = tdb().prepare('SELECT id FROM retail_reviews WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ success: false, error: 'not_found' });
  if ('is_visible' in (req.body || {})) {
    const visible = req.body.is_visible ? 1 : 0;
    tdb().prepare('UPDATE retail_reviews SET is_visible = ? WHERE id = ?')
      .run(visible, id);
    logActivity(req.user.id, req.user.username, visible ? 'show' : 'hide', 'retail_review', id, { is_visible: visible }, req.ip);
  }
  res.json({ success: true });
});

// Customer-side REFUND REQUEST — for paid+ orders the customer can't
// just cancel (money already moved). They file a refund request which
// the office processes through a multi-step workflow:
//   requested → reviewing → approved → paid   (terminal happy path)
//             ↘ rejected           (terminal, staff)
//             ↘ withdrawn          (terminal, customer pulled it)
//
// Customer can request a full refund (default) or a partial:
//   body: { reason?, amount?, lines? }
//     amount: number — partial ¥ amount (clamped to order total)
//     lines:  [{ item_id, qty }] — itemized partial (server computes amount)
// Staff transitions live under /api/retail-admin/orders/:id/refund/...
function logRefundEvent({ orderId, event, amount = null, note = null, userId = null, customerId = null, meta = null }) {
  try {
    tdb().prepare(
      `INSERT INTO retail_refund_events (order_id, event, amount, note, user_id, customer_id, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(orderId, event, amount, note, userId, customerId, meta ? JSON.stringify(meta) : null);
  } catch (e) { console.error('[logRefundEvent]', e); }
}

// Resolve a per-line refund spec into a normalized [{item_id, product_id, qty, amount}]
// list + total amount. Validates against the order's actual items + qty caps.
function normalizeRefundLines(orderId, lines) {
  if (!Array.isArray(lines) || !lines.length) return { lines: null, amount: 0 };
  const items = tdb().prepare(
    'SELECT id, product_id, qty, unit_price, line_total FROM retail_order_items WHERE order_id = ?'
  ).all(orderId);
  const byId = new Map(items.map(it => [it.id, it]));
  const out = [];
  let total = 0;
  for (const l of lines) {
    const itemId = parseInt(l.item_id, 10);
    const it = byId.get(itemId);
    if (!it) continue;
    const qty = Math.max(0, Math.min(Number(l.qty) || 0, it.qty));
    if (!(qty > 0)) continue;
    // line_total ÷ qty gives unit price (after option deltas)
    const unit = it.qty > 0 ? (it.line_total / it.qty) : it.unit_price;
    const amount = +(unit * qty).toFixed(2);
    out.push({ item_id: itemId, product_id: it.product_id, qty, amount });
    total += amount;
  }
  return { lines: out.length ? out : null, amount: +total.toFixed(2) };
}

router.post('/api/retail/orders/:id/refund-request', requireRetailAuth, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const order = tdb().prepare(
    'SELECT id, status, refund_status, total FROM retail_orders WHERE id = ? AND customer_id = ?'
  ).get(id, req.customer.id);
  if (!order) return res.status(404).json({ success: false, error: 'not_found' });
  if (!['paid', 'preparing', 'dispatched', 'delivered'].includes(order.status)) {
    return res.status(409).json({ success: false, error: 'not_refundable', status: order.status });
  }
  // Block if there's an active or already-resolved-happy refund.
  // Allow re-request after 'rejected' or 'withdrawn' (customer can retry).
  if (['pending', 'reviewing'].includes(order.refund_status)) {
    return res.status(409).json({ success: false, error: 'already_requested' });
  }
  if (['approved', 'paid'].includes(order.refund_status)) {
    return res.status(409).json({ success: false, error: 'already_refunded' });
  }
  const reason = (req.body?.reason || '').slice(0, 500);
  // Normalize amount + lines. Per-line wins if both are provided.
  let amount = null;
  let linesJson = null;
  const { lines: normLines, amount: linesAmount } = normalizeRefundLines(id, req.body?.lines);
  if (normLines) {
    amount = linesAmount;
    linesJson = JSON.stringify(normLines);
  } else if (req.body?.amount != null) {
    const a = Math.max(0, Math.min(Number(req.body.amount) || 0, Number(order.total) || 0));
    amount = a > 0 ? +a.toFixed(2) : null;
  }
  tdb().prepare(
    `UPDATE retail_orders
        SET refund_requested_at = CURRENT_TIMESTAMP,
            refund_reason = ?,
            refund_status = 'pending',
            refund_amount_requested = ?,
            refund_amount_approved = NULL,
            refund_amount_paid = NULL,
            refund_lines_json = ?,
            refund_review_note = NULL,
            refund_reviewed_at = NULL,
            refund_approved_at = NULL,
            refund_paid_at = NULL,
            refund_reviewer_id = NULL,
            refund_payer_id = NULL,
            refund_payout_method = NULL,
            refund_payout_ref = NULL,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(reason || null, amount, linesJson, id);
  logRefundEvent({
    orderId: id, event: 'pending', amount, note: reason || null,
    customerId: req.customer.id,
    meta: normLines ? { lines: normLines } : null,
  });
  res.json({ success: true });
});

// Customer withdraws an open refund request (only while requested/reviewing).
// Terminal — to re-open they file a fresh request.
router.post('/api/retail/orders/:id/refund-withdraw', requireRetailAuth, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const order = tdb().prepare(
    'SELECT id, refund_status FROM retail_orders WHERE id = ? AND customer_id = ?'
  ).get(id, req.customer.id);
  if (!order) return res.status(404).json({ success: false, error: 'not_found' });
  if (!['pending', 'reviewing'].includes(order.refund_status)) {
    return res.status(409).json({ success: false, error: 'not_open', refund_status: order.refund_status });
  }
  tdb().prepare(
    "UPDATE retail_orders SET refund_status = 'withdrawn', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(id);
  logRefundEvent({ orderId: id, event: 'withdrawn', customerId: req.customer.id });
  res.json({ success: true });
});

// Customer-side cancel — only allowed when the order is still in
// pending_payment status (hasn't been paid for / staff hasn't started
// preparing). Past that point the customer can't self-cancel; they have
// to contact staff who use the admin status-transition endpoint.
router.post('/api/retail/orders/:id/cancel', requireRetailAuth, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const order = tdb().prepare(
    'SELECT id, status FROM retail_orders WHERE id = ? AND customer_id = ?'
  ).get(id, req.customer.id);
  if (!order) return res.status(404).json({ success: false, error: 'not_found' });
  if (order.status !== 'pending_payment') {
    return res.status(409).json({ success: false, error: 'not_cancellable', current: order.status });
  }
  const reason = (req.body?.reason || '').slice(0, 200);
  tdb().prepare(
    "UPDATE retail_orders SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, cancelled_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(reason || 'customer_cancelled', id);
  // Also flip the pending payment row so the admin queue stays consistent
  tdb().prepare(
    "UPDATE retail_payments SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'"
  ).run(id);
  // Release soft-reservations so the stock returns to the available pool.
  try { inventory.releaseOrderReservations(id, { reason: 'customer_cancelled' }); }
  catch (e) { console.error('[inventory.release]', e); }
  res.json({ success: true });
});

// ─── Current customer ────────────────────────────────────────────────────
router.get('/api/retail/customer', requireRetailAuth, (req, res) => {
  // Sweep expired earn batches lazily so the balance the customer sees
  // matches what they'd actually be able to redeem. Cheap when there's
  // nothing due, idempotent when called repeatedly.
  sweepExpiredPoints(req.customer.id);
  const fresh = tdb().prepare('SELECT * FROM retail_customers WHERE id = ?').get(req.customer.id);
  const addresses = tdb().prepare(
    `SELECT id, recipient_name, phone, province, city, district, address, detail,
            postal_code, is_default, created_at, updated_at
       FROM retail_customer_addresses
      WHERE customer_id = ?
      ORDER BY is_default DESC, updated_at DESC`
  ).all(req.customer.id);
  const favoriteCount = tdb().prepare(
    'SELECT COUNT(*) AS n FROM retail_customer_favorites WHERE customer_id = ?'
  ).get(req.customer.id).n;
  res.json({
    success: true,
    data: { ...publicCustomer(fresh), addresses, favorite_count: favoriteCount },
  });
});

// Customer profile update. Used by the WeChat-binding flow on the Me page:
// the user picks an avatar via <button open-type="chooseAvatar"> and types
// their nickname via <input type="nickname"> (both pull real WeChat data
// when granted). Phone update is open for the future getPhoneNumber flow.
router.patch('/api/retail/customer', requireRetailAuth, express.json(), (req, res) => {
  const { nickname, avatar_url, phone } = req.body || {};
  const sets = [];
  const params = [];
  if (typeof nickname === 'string') {
    const trimmed = nickname.trim().slice(0, 40);
    sets.push('nickname = ?'); params.push(trimmed || null);
  }
  if (typeof avatar_url === 'string') {
    sets.push('avatar_url = ?'); params.push(avatar_url.slice(0, 512) || null);
  }
  if (typeof phone === 'string') {
    sets.push('phone = ?'); params.push(phone.slice(0, 32) || null);
  }
  if (!sets.length) return res.status(400).json({ success: false, error: 'no_fields' });
  params.push(req.customer.id);
  tdb().prepare(`UPDATE retail_customers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  const fresh = tdb().prepare('SELECT * FROM retail_customers WHERE id = ?').get(req.customer.id);
  res.json({ success: true, data: publicCustomer(fresh) });
});

// Customer-facing avatar upload. Body is JSON: { data: "data:image/...;base64,..." }.
// Reason: wx.uploadFile has its own AppID whitelist that customers can't
// control on the legacy preview AppID — sending base64 over wx.request
// reuses the request whitelist, which IS already provisioned.
router.post('/api/retail/customer/avatar', requireRetailAuth, express.json({ limit: '8mb' }), (req, res) => {
  const { data } = req.body || {};
  if (typeof data !== 'string' || !data.startsWith('data:image/')) {
    return res.status(400).json({ success: false, error: 'bad_data_uri' });
  }
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!m) return res.status(400).json({ success: false, error: 'bad_data_uri' });
  const sizeBytes = Math.floor(m[2].length * 3 / 4);
  if (sizeBytes > 5 * 1024 * 1024) {
    return res.status(400).json({ success: false, error: 'too_large' });
  }
  // Verify the bytes are a real raster image (rejects SVG / spoofed mime) and
  // pin the stored mime + data URI to the sniffed type, not the client label.
  let mime, normData;
  try {
    const buf = Buffer.from(m[2], 'base64');
    mime = sniffImageMime(buf);
    if (!mime) return res.status(400).json({ success: false, error: 'bad_data_uri' });
    normData = `data:${mime};base64,${m[2]}`;
  } catch { return res.status(400).json({ success: false, error: 'bad_data_uri' }); }
  try {
    const info = tdb().prepare(
      `INSERT INTO retail_media (filename, mime_type, size_bytes, data, uploaded_by)
       VALUES (?, ?, ?, ?, NULL)`
    ).run('avatar', mime, sizeBytes, normData);
    res.json({ success: true, data: { url: `/api/retail/media/${info.lastInsertRowid}` } });
  } catch (e) {
    console.error('[retail/avatar] insert failed:', e.message);
    res.status(500).json({ success: false, error: 'db_insert_failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// STAFF-FACING ADMIN ENDPOINTS (/api/retail-admin/*)
// Session-cookie auth + `retail` permission. Mounted on the same router
// so retail logic stays in one file. Used by /retail-admin standalone page.
// ═══════════════════════════════════════════════════════════════════════

// (requireRetailAdmin hoisted near the top of this file)

// Storefront config — read full + bulk write.
router.get('/api/retail-admin/config', requireRetailAdmin, (req, res) => {
  res.json({ success: true, data: loadConfig() });
});

// Body: { 'fees.freeShippingThreshold': 449, 'theme.accent': 'forest-kale', … }
// Each entry is a dotted key; value is anything JSON-serialisable. Whole
// thing applied in one txn so partial failures roll back.
router.put('/api/retail-admin/config', requireRetailAdmin, express.json(), (req, res) => {
  const body = req.body || {};
  const entries = Object.entries(body);
  if (!entries.length) return res.status(400).json({ success: false, error: 'no_updates' });

  const upsert = tdb().prepare(
    `INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
     VALUES (?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = CURRENT_TIMESTAMP,
       updated_by = excluded.updated_by`
  );
  const tx = tdb().transaction(() => {
    for (const [k, v] of entries) upsert.run(k, JSON.stringify(v), req.user.id);
  });
  try { tx(); }
  catch (e) { console.error('[retail-admin/config PUT]', e); return res.status(500).json({ success: false, error: 'update_failed' }); }
  logActivity(req.user.id, req.user.username, 'update', 'storefront_config', null, { keys: entries.map(e => e[0]) }, req.ip);
  res.json({ success: true, data: loadConfig() });
});

// Mini-app surface for a product — controlled by the office from
// /retail-admin → Products. The kitchen-relevant fields (price, recipe
// link, stock) stay in /products. Allowed fields:
//   is_published                         — show/hide in shop
//   keywords_en / keywords_cn            — green subtitle keywords
//   tagline_en  / tagline_cn             — bold slogan under the subtitle
//   description_blocks                   — JSON array of designer blocks;
//                                          when non-empty, replaces the
//                                          plain description on the mini-app
// Any field absent from the body is left untouched.
router.patch('/api/retail-admin/products/:id', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = tdb().prepare('SELECT id, name_en FROM products WHERE id = ? AND COALESCE(is_active,1) = 1').get(id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });

  const sets = [];
  const params = [];
  const body = req.body || {};
  if ('is_published' in body) { sets.push('is_published = ?'); params.push(body.is_published ? 1 : 0); }
  for (const k of ['keywords_en', 'keywords_cn', 'tagline_en', 'tagline_cn',
                   'colophon_character', 'colophon_tagline_en', 'colophon_tagline_cn']) {
    if (k in body) { sets.push(`${k} = ?`); params.push(body[k] || null); }
  }
  if ('description_blocks' in body) {
    const v = body.description_blocks;
    let arr = null;
    if (v == null || v === '') { arr = null; }
    else if (typeof v === 'string') {
      try { const p = JSON.parse(v); if (Array.isArray(p)) arr = p; } catch {}
    } else if (Array.isArray(v)) { arr = v; }
    sets.push('description_blocks = ?');
    params.push(arr && arr.length ? JSON.stringify(arr) : null);
  }
  // Nutrition panel — stored as its own JSON column, edited from the product
  // editor as a (pseudo) block. Shape: { basis_en, basis_cn, rows:[{label_en,
  // label_cn, value}] }. Sanitised here so we never persist junk. null/empty
  // clears the column (hides the panel on the mini-app).
  if ('nutrition' in body) {
    const v = body.nutrition;
    let obj = null;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const rows = Array.isArray(v.rows) ? v.rows
        .map(r => ({
          label_en: (r && r.label_en ? String(r.label_en) : '').trim(),
          label_cn: (r && r.label_cn ? String(r.label_cn) : '').trim(),
          value:    (r && r.value    ? String(r.value)    : '').trim(),
        }))
        .filter(r => r.label_en || r.label_cn || r.value) : [];
      const basis_en = (v.basis_en ? String(v.basis_en) : '').trim();
      const basis_cn = (v.basis_cn ? String(v.basis_cn) : '').trim();
      if (basis_en || basis_cn || rows.length) {
        obj = { basis_en: basis_en || null, basis_cn: basis_cn || null, rows };
      }
    }
    sets.push('nutrition = ?');
    params.push(obj ? JSON.stringify(obj) : null);
  }
  // ── Core commercial fields (the standalone Mini App Backend product page) ──
  // name_en is NOT NULL — never blank it; fall back to the existing value.
  if ('name_en' in body) { sets.push('name_en = ?'); params.push((body.name_en || '').trim() || existing.name_en); }
  if ('description_format' in body) {
    sets.push('description_format = ?'); params.push(body.description_format === 'rich' ? 'rich' : 'plain');
  }
  const richDesc = body.description_format === 'rich';
  for (const k of ['name_cn', 'sku', 'category', 'weight', 'description_en', 'description_cn', 'image_data', 'image_url']) {
    if (k in body) {
      let val = (body[k] == null || body[k] === '') ? null : body[k];
      // Sanitise formatted description HTML; plain descriptions stored as-is.
      if (val && richDesc && (k === 'description_en' || k === 'description_cn')) val = sanitizeRichHtml(val);
      sets.push(`${k} = ?`); params.push(val);
    }
  }
  if ('sell_price' in body) { sets.push('sell_price = ?'); params.push(Math.max(0, parseFloat(body.sell_price) || 0)); }
  if ('compare_at_price' in body) {
    // 0 / blank / invalid clears the strike-through (stored NULL).
    const v = parseFloat(body.compare_at_price);
    sets.push('compare_at_price = ?'); params.push(Number.isFinite(v) && v > 0 ? v : null);
  }
  if ('stock_qty'  in body) { sets.push('stock_qty = ?');  params.push(Math.max(0, parseInt(body.stock_qty, 10) || 0)); }
  if ('ship_modes' in body) {
    const arr = [...new Set(String(body.ship_modes || '').split(',').map(s => s.trim().toLowerCase()).filter(m => m === 'air' || m === 'land'))];
    sets.push('ship_modes = ?'); params.push(arr.length ? arr.join(',') : 'air,land');
  }
  if ('images' in body) {
    // Ordered gallery (max 8). Keep the primary image_data in sync — shop
    // cards, order items and legacy single-image consumers read image_data,
    // not the gallery. Empty array clears both.
    const arr = (Array.isArray(body.images) ? body.images : []).filter(s => typeof s === 'string' && s).slice(0, 8);
    sets.push('images = ?');     params.push(arr.length ? JSON.stringify(arr) : null);
    sets.push('image_data = ?'); params.push(arr.length ? arr[0] : null);
  }
  if ('bundle' in body) { sets.push('bundle = ?'); params.push(sanitizeBundle(body.bundle)); }
  if ('tags' in body) { sets.push('tags = ?'); params.push(sanitizeProductBadge(body.tags)); }
  if (!sets.length) return res.status(400).json({ success: false, error: 'no_fields' });

  sets.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  try {
    tdb().prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) return res.status(409).json({ success: false, error: 'sku_taken' });
    throw e;
  }

  logActivity(req.user.id, req.user.username, 'update', 'product_retail', id, { fields: Object.keys(body), name: existing.name_en }, req.ip);

  // Return the same shape as GET /api/retail-admin/products row + the
  // hydrated description_blocks JSON, so the page can update its card
  // and re-open the editor with fresh data.
  const row = tdb().prepare(
    `SELECT id, name_en, name_cn, sku, category, weight AS size, sell_price, compare_at_price, stock_qty, ship_modes,
            description_en, description_cn, description_format, image_data, image_url, is_published, sort_order,
            keywords_en, keywords_cn, tagline_en, tagline_cn, description_blocks, nutrition, bundle, tags,
            colophon_character, colophon_tagline_en, colophon_tagline_cn
       FROM products WHERE id = ?`
  ).get(id);
  if (row && typeof row.description_blocks === 'string' && row.description_blocks) {
    try { row.description_blocks = JSON.parse(row.description_blocks); } catch { row.description_blocks = null; }
  } else {
    row.description_blocks = null;
  }
  if (row && typeof row.bundle === 'string' && row.bundle.trim()) {
    try { row.bundle = JSON.parse(row.bundle); } catch { row.bundle = null; }
  } else {
    row.bundle = null;
  }
  if (row && typeof row.nutrition === 'string' && row.nutrition.trim()) {
    try {
      const n = JSON.parse(row.nutrition);
      row.nutrition = (n && (n.basis_en || n.basis_cn || (n.rows || []).length)) ? n : null;
    } catch { row.nutrition = null; }
  } else {
    row.nutrition = null;
  }
  res.json({ success: true, data: row });
});

// GET /api/retail-admin/products/:id — FULL single product, including the
// heavy description_blocks JSON the LIST endpoint deliberately omits. The
// product-page editor MUST hydrate from this (not the list): the list only
// ships a has_blocks flag, so booting the editor off the list left
// _paBlocks=[] and the next save wiped the saved designer sections. Same row
// shape as the PATCH response so peMount can consume either.
router.get('/api/retail-admin/products/:id', requireRetailAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  const id = parseInt(req.params.id, 10);
  const row = tdb().prepare(
    `SELECT id, name_en, name_cn, sku, category, weight AS size, sell_price, compare_at_price, stock_qty, ship_modes,
            description_en, description_cn, description_format, image_data, image_url, is_published, sort_order,
            keywords_en, keywords_cn, tagline_en, tagline_cn, description_blocks, nutrition, bundle, tags,
            variant_group_id, variant_label, variant_sort,
            colophon_character, colophon_tagline_en, colophon_tagline_cn
       FROM products WHERE id = ? AND COALESCE(is_active, 1) = 1`
  ).get(id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  if (typeof row.description_blocks === 'string' && row.description_blocks) {
    try { row.description_blocks = JSON.parse(row.description_blocks); } catch { row.description_blocks = null; }
  } else { row.description_blocks = null; }
  if (typeof row.bundle === 'string' && row.bundle.trim()) {
    try { row.bundle = JSON.parse(row.bundle); } catch { row.bundle = null; }
  } else { row.bundle = null; }
  if (typeof row.nutrition === 'string' && row.nutrition.trim()) {
    try {
      const n = JSON.parse(row.nutrition);
      row.nutrition = (n && (n.basis_en || n.basis_cn || (n.rows || []).length)) ? n : null;
    } catch { row.nutrition = null; }
  } else { row.nutrition = null; }
  res.json({ success: true, data: row });
});

// Create a product straight from the Mini App Backend product page. Standalone
// path (no kitchen needed): name + the basic commercial fields, is_active=1.
router.post('/api/retail-admin/products', requireRetailAdmin, express.json(), (req, res) => {
  const b = req.body || {};
  const name_en = (b.name_en || '').trim();
  const name_cn = (b.name_cn || '').trim();
  if (!name_en && !name_cn) return res.status(400).json({ success: false, error: 'name_required' });
  const ship = [...new Set(String(b.ship_modes || 'air,land').split(',').map(s => s.trim().toLowerCase()).filter(m => m === 'air' || m === 'land'))];
  // Gallery (max 8); primary image_data mirrors the first photo.
  const gallery = (Array.isArray(b.images) ? b.images : []).filter(s => typeof s === 'string' && s).slice(0, 8);
  const primaryImg = gallery.length ? gallery[0] : (b.image_data || null);
  const descFormat = b.description_format === 'rich' ? 'rich' : 'plain';
  const descEn = descFormat === 'rich' ? sanitizeRichHtml(b.description_en) : ((b.description_en || '').trim() || null);
  const descCn = descFormat === 'rich' ? sanitizeRichHtml(b.description_cn) : ((b.description_cn || '').trim() || null);
  let info;
  try {
    info = tdb().prepare(
      `INSERT INTO products
         (name_en, name_cn, sku, category, weight, sell_price, compare_at_price, stock_qty, ship_modes,
          description_en, description_cn, description_format, image_data, images, tags, is_published, is_active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
    ).run(
      name_en || name_cn, name_cn || null,
      (b.sku || '').trim() || null, (b.category || '').trim() || null, (b.weight || '').trim() || null,
      Math.max(0, parseFloat(b.sell_price) || 0),
      (() => { const v = parseFloat(b.compare_at_price); return Number.isFinite(v) && v > 0 ? v : null; })(),
      Math.max(0, parseInt(b.stock_qty, 10) || 0),
      ship.length ? ship.join(',') : 'air,land',
      descEn, descCn, descFormat,
      primaryImg, gallery.length ? JSON.stringify(gallery) : null, sanitizeProductBadge(b.tags),
      b.is_published ? 1 : 0
    );
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) return res.status(409).json({ success: false, error: 'sku_taken' });
    throw e;
  }
  const id = info.lastInsertRowid;
  logActivity(req.user.id, req.user.username, 'create', 'product_retail', id, { name: name_en || name_cn }, req.ip);
  const row = tdb().prepare(
    `SELECT id, name_en, name_cn, sku, category, weight AS size, sell_price, compare_at_price, stock_qty, ship_modes,
            description_en, description_cn, description_format, image_data, image_url, is_published, sort_order,
            keywords_en, keywords_cn, tagline_en, tagline_cn, description_blocks, nutrition, tags,
            colophon_character, colophon_tagline_en, colophon_tagline_cn
       FROM products WHERE id = ?`
  ).get(id);
  row.description_blocks = null;
  row.nutrition = null;
  res.json({ success: true, data: row });
});

// Soft-delete a product from the Mini App Backend (hide from shop + lists).
router.delete('/api/retail-admin/products/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = tdb().prepare('SELECT id, name_en FROM products WHERE id = ? AND COALESCE(is_active,1) = 1').get(id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });
  tdb().prepare('UPDATE products SET is_active = 0, is_published = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  logActivity(req.user.id, req.user.username, 'delete', 'product_retail', id, { name: existing.name_en }, req.ip);
  res.json({ success: true });
});

// Duplicate a product. Copies all commercial fields (name, description, photos,
// price, compare-at, page design, etc.) into a NEW product. SKU is blanked
// (unique), stock reset to 0, and it starts hidden (is_published=0) so a
// half-edited copy never leaks into the shop. body: { as_variant, label }.
// as_variant also joins the copy to the source's variant group (creating one,
// owned by the source, if it doesn't have one yet) with the given label —
// the smooth path for "same product, different size".
router.post('/api/retail-admin/products/:id/duplicate', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const src = tdb().prepare(
    `SELECT name_en, name_cn, category, weight, sell_price, compare_at_price,
            ship_modes, description_en, description_cn, description_format, image_data, images,
            keywords_en, keywords_cn, tagline_en, tagline_cn, free_of, tags, nutrition,
            description_blocks, colophon_character, colophon_tagline_en, colophon_tagline_cn,
            variant_group_id, sort_order
       FROM products WHERE id = ? AND COALESCE(is_active, 1) = 1`
  ).get(id);
  if (!src) return res.status(404).json({ success: false, error: 'not_found' });

  const asVariant = !!(req.body && req.body.as_variant);
  const label = (req.body && req.body.label != null) ? (String(req.body.label).trim() || null) : null;

  const newId = tdb().transaction(() => {
    let groupId = null;
    if (asVariant) {
      // Ensure the source belongs to a group (owner = source id) so the copy joins it.
      groupId = src.variant_group_id || id;
      if (!src.variant_group_id) {
        tdb().prepare('UPDATE products SET variant_group_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(groupId, id);
      }
    }
    const info = tdb().prepare(
      `INSERT INTO products
         (name_en, name_cn, sku, category, weight, sell_price, compare_at_price, stock_qty, ship_modes,
          description_en, description_cn, description_format, image_data, images,
          keywords_en, keywords_cn, tagline_en, tagline_cn, free_of, tags, nutrition,
          description_blocks, colophon_character, colophon_tagline_en, colophon_tagline_cn,
          variant_group_id, variant_label, sort_order, is_published, is_active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
    ).run(
      src.name_en, src.name_cn, null, src.category, src.weight, src.sell_price, src.compare_at_price, 0, src.ship_modes,
      src.description_en, src.description_cn, src.description_format, src.image_data, src.images,
      src.keywords_en, src.keywords_cn, src.tagline_en, src.tagline_cn, src.free_of, src.tags, src.nutrition,
      src.description_blocks, src.colophon_character, src.colophon_tagline_en, src.colophon_tagline_cn,
      asVariant ? groupId : null, asVariant ? label : null, src.sort_order
    );
    return info.lastInsertRowid;
  })();

  logActivity(req.user.id, req.user.username, 'duplicate', 'product_retail', newId, { from: id, as_variant: asVariant }, req.ip);

  const row = tdb().prepare(
    `SELECT id, name_en, name_cn, sku, category, weight AS size, sell_price, compare_at_price, stock_qty, ship_modes,
            description_en, description_cn, description_format, image_data, image_url, is_published, sort_order,
            keywords_en, keywords_cn, tagline_en, tagline_cn, description_blocks, nutrition,
            variant_group_id, variant_label,
            colophon_character, colophon_tagline_en, colophon_tagline_cn
       FROM products WHERE id = ?`
  ).get(newId);
  if (row && typeof row.description_blocks === 'string' && row.description_blocks) {
    try { row.description_blocks = JSON.parse(row.description_blocks); } catch { row.description_blocks = null; }
  } else { row.description_blocks = null; }
  if (row && typeof row.nutrition === 'string' && row.nutrition.trim()) {
    try { const n = JSON.parse(row.nutrition); row.nutrition = (n && (n.basis_en || n.basis_cn || (n.rows || []).length)) ? n : null; } catch { row.nutrition = null; }
  } else { row.nutrition = null; }
  res.json({ success: true, data: row });
});

// ─── Flash sales (秒杀) admin ─────────────────────────────────────────────
// Each product has at most one flash window at a time — to schedule a new
// one, overwrite the four columns via PUT (we reset flash_sold to 0 then).
// DELETE clears the configuration entirely. The public /api/retail/products
// endpoint exposes the active price; the order flow caps flash_sold so two
// concurrent orders can't blow past flash_stock_limit.

router.get('/api/retail-admin/flash-sales', requireRetailAdmin, (req, res) => {
  const now = Date.now();
  const rows = tdb().prepare(
    `SELECT p.id, p.name_en, p.name_cn, p.sku, p.weight AS size,
            p.sell_price, p.image_url, p.image_data, p.is_published,
            p.flash_price, p.flash_starts_at, p.flash_ends_at,
            p.flash_stock_limit, p.flash_sold
       FROM products p
      WHERE COALESCE(p.is_active, 1) = 1
        AND p.flash_price IS NOT NULL
      ORDER BY p.flash_ends_at ASC NULLS LAST, p.id ASC`
  ).all().map(p => {
    const f = flashsales.flashStatus(p, now);
    return {
      id: p.id, name_en: p.name_en, name_cn: p.name_cn, sku: p.sku, size: p.size,
      sell_price: p.sell_price, image_url: p.image_url, image_data: p.image_data,
      is_published: p.is_published,
      flash_price: p.flash_price,
      flash_starts_at: p.flash_starts_at,
      flash_ends_at: p.flash_ends_at,
      flash_stock_limit: p.flash_stock_limit,
      flash_sold: p.flash_sold || 0,
      flash_state: f ? f.state : 'none',
    };
  });
  res.json({ success: true, data: rows, meta: { server_time_ms: now } });
});

router.put('/api/retail-admin/products/:id/flash-sale', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = tdb().prepare('SELECT id, name_en, flash_price, flash_starts_at, flash_ends_at FROM products WHERE id = ? AND COALESCE(is_active, 1) = 1').get(id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });

  const body = req.body || {};
  const price  = Number(body.flash_price);
  const starts = (body.flash_starts_at || '').trim() || null;
  const ends   = (body.flash_ends_at || '').trim() || null;
  const limit  = body.flash_stock_limit == null || body.flash_stock_limit === ''
    ? null : parseInt(body.flash_stock_limit, 10);

  if (!(price > 0)) return res.status(400).json({ success: false, error: 'flash_price_invalid' });
  if (!ends) return res.status(400).json({ success: false, error: 'flash_ends_at_required' });
  const endsMs = new Date(ends).getTime();
  if (!Number.isFinite(endsMs)) return res.status(400).json({ success: false, error: 'flash_ends_at_invalid' });
  if (starts) {
    const startsMs = new Date(starts).getTime();
    if (!Number.isFinite(startsMs)) return res.status(400).json({ success: false, error: 'flash_starts_at_invalid' });
    if (startsMs >= endsMs) return res.status(400).json({ success: false, error: 'flash_starts_after_ends' });
  }
  if (limit != null && (!Number.isFinite(limit) || limit < 0)) {
    return res.status(400).json({ success: false, error: 'flash_stock_limit_invalid' });
  }

  // Reset flash_sold whenever the window OR price changes so a new event
  // doesn't inherit the previous event's count. The admin can also reset
  // manually by re-saving the same values.
  const windowChanged =
    String(existing.flash_starts_at || '') !== String(starts || '') ||
    String(existing.flash_ends_at   || '') !== String(ends   || '');
  const priceChanged = Number(existing.flash_price) !== price;
  const resetNeeded = windowChanged || priceChanged;

  tdb().prepare(
    `UPDATE products
        SET flash_price       = ?,
            flash_starts_at   = ?,
            flash_ends_at     = ?,
            flash_stock_limit = ?,
            flash_sold        = CASE WHEN ? = 1 THEN 0 ELSE flash_sold END,
            updated_at        = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(price, starts, ends, limit, resetNeeded ? 1 : 0, id);

  logActivity(req.user.id, req.user.username, 'update', 'product_flash_sale', id,
    { name: existing.name_en, price, starts, ends, limit, reset: resetNeeded }, req.ip);

  const fresh = tdb().prepare(
    `SELECT id, name_en, flash_price, flash_starts_at, flash_ends_at,
            flash_stock_limit, flash_sold
       FROM products WHERE id = ?`
  ).get(id);
  res.json({ success: true, data: fresh });
});

router.delete('/api/retail-admin/products/:id/flash-sale', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = tdb().prepare('SELECT id, name_en FROM products WHERE id = ? AND COALESCE(is_active, 1) = 1').get(id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });
  tdb().prepare(
    `UPDATE products
        SET flash_price = NULL, flash_starts_at = NULL, flash_ends_at = NULL,
            flash_stock_limit = NULL, flash_sold = 0,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(id);
  logActivity(req.user.id, req.user.username, 'delete', 'product_flash_sale', id, { name: existing.name_en }, req.ip);
  res.json({ success: true });
});

// Product categories for the retail admin — list + reorder + rename + delete.
// These mirror /api/categories/:kind under requireAuth, but the retail-admin
// permission is enough (no need to require the main-app session). Each row
// carries a usage_count so the admin can see how many published products
// reference it before deleting.
router.get('/api/retail-admin/categories', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(`
    SELECT c.id, c.name, c.sort_order,
      (SELECT COUNT(*) FROM products p
        WHERE p.category = c.name AND COALESCE(p.is_active, 1) = 1) AS usage_count
    FROM categories c
    WHERE c.kind = 'product'
    ORDER BY c.sort_order, c.name
  `).all();
  res.json({ success: true, data: rows });
});

// Reorder by passing an array of category IDs in the desired order. We
// assign sort_order = index + 1 in a transaction so a half-failed write
// can't leave the list in a bogus state.
router.post('/api/retail-admin/categories/reorder', requireRetailAdmin, express.json(), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids || !ids.length) return res.status(400).json({ success: false, error: 'ids_required' });
  const stmt = tdb().prepare("UPDATE categories SET sort_order = ? WHERE id = ? AND kind = 'product'");
  const tx = tdb().transaction((ordered) => {
    ordered.forEach((id, i) => stmt.run(i + 1, id));
  });
  try {
    tx(ids.map(n => parseInt(n, 10)).filter(Number.isFinite));
    logActivity(req.user.id, req.user.username, 'update', 'category_order', null,
                { kind: 'product', count: ids.length }, req.ip);
    res.json({ success: true });
  } catch (e) {
    console.error('[retail-admin/categories/reorder]', e);
    res.status(500).json({ success: false, error: 'reorder_failed' });
  }
});

router.patch('/api/retail-admin/categories/:id', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = tdb().prepare("SELECT id, name FROM categories WHERE id = ? AND kind = 'product'").get(id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ success: false, error: 'name_required' });
  if (name === existing.name) return res.json({ success: true, data: existing });
  try {
    // Atomic: the category rename and the product back-propagation must both
    // land or neither — otherwise a mid-flight failure leaves products pointing
    // at a category name that no longer exists.
    tdb().transaction(() => {
      tdb().prepare("UPDATE categories SET name = ? WHERE id = ?").run(name, id);
      // Propagate the rename to products that referenced the old name.
      tdb().prepare("UPDATE products SET category = ? WHERE category = ?").run(name, existing.name);
    })();
    logActivity(req.user.id, req.user.username, 'update', 'category', id,
                { kind: 'product', from: existing.name, to: name }, req.ip);
    res.json({ success: true, data: { id, name } });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(400).json({ success: false, error: 'duplicate_name' });
    res.status(500).json({ success: false, error: 'update_failed' });
  }
});

router.post('/api/retail-admin/categories', requireRetailAdmin, express.json(), (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ success: false, error: 'name_required' });
  // Append to the end so new entries don't reshuffle existing ordering.
  const maxRow = tdb().prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories WHERE kind = 'product'").get();
  try {
    const r = tdb().prepare("INSERT INTO categories (kind, name, sort_order) VALUES ('product', ?, ?)").run(name, (maxRow.m || 0) + 1);
    logActivity(req.user.id, req.user.username, 'create', 'category', r.lastInsertRowid,
                { kind: 'product', name }, req.ip);
    res.json({ success: true, data: { id: r.lastInsertRowid, name, sort_order: (maxRow.m || 0) + 1, usage_count: 0 } });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(400).json({ success: false, error: 'duplicate_name' });
    res.status(500).json({ success: false, error: 'create_failed' });
  }
});

router.delete('/api/retail-admin/categories/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = tdb().prepare("SELECT id, name FROM categories WHERE id = ? AND kind = 'product'").get(id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });
  const usage = tdb().prepare("SELECT COUNT(*) AS n FROM products WHERE category = ? AND COALESCE(is_active, 1) = 1").get(existing.name).n;
  if (usage > 0) return res.status(409).json({ success: false, error: 'in_use', usage_count: usage });
  tdb().prepare('DELETE FROM categories WHERE id = ?').run(id);
  logActivity(req.user.id, req.user.username, 'delete', 'category', id, { kind: 'product', name: existing.name }, req.ip);
  res.json({ success: true });
});

// List products for the CMS picker (Storefront Editor) + the retail-admin
// Products tab. Returns the master fields the picker needs PLUS the
// mini-app surface fields (keywords/tagline/description_blocks) so the
// Products tab can show a "has designer sections?" state in the list and
// open the editor pre-populated.
router.get('/api/retail-admin/products', requireRetailAdmin, (req, res) => {
  // The editor reads this list to populate the inspector with the saved
  // values. Browsers happily cache it (no Cache-Control was set) and on
  // refresh the editor would re-paint with the PRE-SAVE copy, looking like
  // the save didn't persist. Force every refresh to hit the DB.
  res.set('Cache-Control', 'no-store, must-revalidate');
  const { q, published } = req.query;
  // The grid only needs a thumbnail and a "has designer sections" flag — not
  // the full base64 image_data or the description_blocks JSON. Shipping those
  // for every product (up to 500) made the catalogue payload balloon to many
  // MB and the page slow to load. So: omit image_data (send a lazy image URL
  // instead) and description_blocks (send a has_blocks flag). The per-product
  // editor fetches the real image + blocks on demand.
  let sql = `SELECT id, name_en, name_cn, sku, category, weight AS size,
                    sell_price, compare_at_price, stock_qty, ship_modes, image_url,
                    -- Effective stock = what the customer shop actually sees
                    -- (sum of per-store physical_qty, falling back to the legacy
                    -- stock_qty only when a product has no per-store rows). The
                    -- grid's "OUT" badge reads THIS, not raw stock_qty, so a
                    -- product stocked per-store doesn't show a false sold-out.
                    COALESCE(
                      (SELECT SUM(rss.physical_qty)
                         FROM retail_store_stock rss
                         JOIN retail_stores      rs ON rs.id = rss.store_id
                        WHERE rss.product_id = products.id AND rs.is_active = 1),
                      stock_qty
                    ) AS effective_stock,
                    is_published, sort_order, updated_at,
                    description_en, description_cn, description_format,
                    keywords_en, keywords_cn, tagline_en, tagline_cn,
                    nutrition, bundle, tags,
                    variant_group_id, variant_label, variant_sort,
                    colophon_character, colophon_tagline_en, colophon_tagline_cn,
                    (image_data IS NOT NULL AND image_data != '') AS has_image_data,
                    (description_blocks IS NOT NULL AND description_blocks != '' AND description_blocks != '[]') AS has_blocks
               FROM products WHERE COALESCE(is_active, 1) = 1`;
  const params = [];
  if (q) {
    sql += ' AND (name_en LIKE ? OR name_cn LIKE ? OR sku LIKE ?)';
    const s = `%${q}%`; params.push(s, s, s);
  }
  if (published === '1') sql += ' AND is_published = 1';
  if (published === '0') sql += ' AND is_published = 0';
  sql += ' ORDER BY is_published DESC, sort_order ASC, name_en ASC LIMIT 500';
  const rows = tdb().prepare(sql).all(...params).map(r => {
    // Replace the (omitted) base64 image with a tiny URL the browser lazy-loads
    // and caches; ?v=updated_at busts it when the photo changes. Products with
    // only an image_url (no base64) keep falling back to that URL on the card.
    r.image_data = r.has_image_data
      ? `/api/retail-admin/products/${r.id}/image?v=${encodeURIComponent(r.updated_at || '')}`
      : null;
    delete r.has_image_data;
    // has_blocks is a 0/1 from SQLite — normalise to a real boolean.
    r.has_blocks = !!r.has_blocks;
    // Parse the nutrition panel JSON so the editor can pre-fill it.
    if (typeof r.nutrition === 'string' && r.nutrition.trim()) {
      try {
        const n = JSON.parse(r.nutrition);
        r.nutrition = (n && (n.basis_en || n.basis_cn || (n.rows || []).length)) ? n : null;
      } catch { r.nutrition = null; }
    } else {
      r.nutrition = null;
    }
    // Parse the buy-together bundle JSON so the editor can pre-fill it.
    if (typeof r.bundle === 'string' && r.bundle.trim()) {
      try { r.bundle = JSON.parse(r.bundle); } catch { r.bundle = null; }
    } else {
      r.bundle = null;
    }
    return r;
  });
  res.json({ success: true, data: rows });
});

// GET /api/retail-admin/products/:id/image — stream a product's primary photo
// as real image bytes so the catalogue list can ship a small URL per row
// instead of an inline base64 blob. image_data is a data: URI: decode and send
// with a long cache window (?v=updated_at busts it). Plain-URL images redirect.
router.get('/api/retail-admin/products/:id/image', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = tdb().prepare('SELECT image_data FROM products WHERE id = ?').get(id);
  const data = row && row.image_data;
  if (!data) return res.status(404).end();
  const m = /^data:([^;,]*?)(;base64)?,([\s\S]*)$/.exec(data);
  if (!m) return res.redirect(String(data));
  const mime = m[1] || 'application/octet-stream';
  const buf  = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  res.set('Content-Type', mime);
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(buf);
});

// Photo gallery for the editor — returns the ordered image list, falling back
// to the single primary image for legacy products with no gallery yet. Kept
// separate from the product list so list payloads stay light.
router.get('/api/retail-admin/products/:id/images', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = tdb().prepare('SELECT images, image_data, image_url FROM products WHERE id = ? AND COALESCE(is_active,1) = 1').get(id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  let images = parseJsonArray(row.images);
  if (!images.length) { const primary = row.image_data || row.image_url; if (primary) images = [primary]; }
  res.json({ success: true, images });
});

// ── Variant grouping (retail-admin scope) ───────────────────────────────────
// Each variant is its own master-data product; siblings share variant_group_id
// (same model + data shape as the staff /api/products/variants/group and the
// app.html grouping UI). These endpoints let the Product Page Editor manage the
// group under the retail-admin session.
router.get('/api/retail-admin/products/:id/variants', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = tdb().prepare('SELECT id, variant_group_id FROM products WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ success: false, error: 'not_found' });
  let members = [];
  if (p.variant_group_id) {
    members = tdb().prepare(
      `SELECT id, name_en, name_cn, sku, variant_label, weight AS size, sell_price AS price,
              stock_qty AS stock, image_data, image_url, is_published
         FROM products
        WHERE variant_group_id = ? AND COALESCE(is_active, 1) = 1
        ORDER BY COALESCE(variant_sort, 0), COALESCE(variant_label, name_en), id`
    ).all(p.variant_group_id);
  }
  res.json({ success: true, data: { group_id: p.variant_group_id || null, members } });
});

// PUT — set this product's variant group. body: { members: [{ id, label }] }.
// `members` is the FULL desired set; the edited product always belongs and owns
// the group_id. Reconciles: relabel/add listed members, drop any current member
// not listed, and disband (clear all) when fewer than 2 remain.
router.put('/api/retail-admin/products/:id/variants', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const self = tdb().prepare('SELECT id, variant_group_id, variant_label FROM products WHERE id = ?').get(id);
  if (!self) return res.status(404).json({ success: false, error: 'not_found' });
  const raw = Array.isArray(req.body?.members) ? req.body.members : [];
  const byId = new Map();
  for (const m of raw) {
    const mid = parseInt(m && m.id, 10);
    if (Number.isFinite(mid) && mid > 0) byId.set(mid, (m.label || '').toString().trim() || null);
  }
  if (!byId.has(id)) byId.set(id, self.variant_label || null);   // edited product always belongs
  const desired = [...byId.entries()];
  const prevGid = self.variant_group_id;
  const groupId = id;   // edited product owns the group id
  try {
    const count = tdb().transaction(() => {
      if (desired.length < 2) {
        if (prevGid) tdb().prepare('UPDATE products SET variant_group_id=NULL, variant_label=NULL, updated_at=CURRENT_TIMESTAMP WHERE variant_group_id=?').run(prevGid);
        tdb().prepare('UPDATE products SET variant_group_id=NULL, variant_label=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(id);
        return 0;
      }
      if (prevGid) {
        const keep = desired.map(([mid]) => mid);
        const ph = keep.map(() => '?').join(',');
        tdb().prepare(`UPDATE products SET variant_group_id=NULL, variant_label=NULL, updated_at=CURRENT_TIMESTAMP WHERE variant_group_id=? AND id NOT IN (${ph})`).run(prevGid, ...keep);
      }
      const upd = tdb().prepare('UPDATE products SET variant_group_id=?, variant_label=?, variant_sort=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
      desired.forEach(([mid, label], idx) => upd.run(groupId, label, idx, mid));
      return desired.length;
    })();
    res.json({ success: true, group_id: count >= 2 ? groupId : null, count });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Retail orders queue — list + detail + status transitions.
// Lightweight unseen-order counter for the Orders tab notification dot.
// Counts orders placed strictly after `since` (ISO 8601 from the client's
// localStorage "last viewed Orders tab" timestamp). Excludes cancelled and
// pending_payment so the dot only fires for actionable new orders.
// Returns the most-recent placed_at too so the client can advance its
// pointer atomically after marking-as-seen.
router.get('/api/retail-admin/orders/unseen-count', requireRetailAdmin, (req, res) => {
  const since = String(req.query.since || '').trim();
  // SQLite datetime() tolerates ISO strings; default to "epoch" when missing
  // so a fresh client sees a count of every non-cancelled order.
  const sinceSql = since || '1970-01-01T00:00:00.000Z';
  const row = tdb().prepare(
    `SELECT COUNT(*) AS n, MAX(placed_at) AS latest
       FROM retail_orders
      WHERE status NOT IN ('cancelled','pending_payment')
        AND datetime(placed_at) > datetime(?)`
  ).get(sinceSql);
  res.json({ success: true, data: { count: row.n || 0, latest: row.latest || null } });
});

router.get('/api/retail-admin/orders', requireRetailAdmin, (req, res) => {
  const { status, q, from, to, store_id } = req.query;
  const limit  = Math.min(parseInt(req.query.limit  || '100', 10) || 100, 200);
  const offset = Math.max(parseInt(req.query.offset || '0',   10) || 0, 0);

  let sql = `SELECT o.id, o.order_no, o.status, o.payment_method, o.total,
                    o.recipient_name, o.recipient_phone, o.address_full,
                    o.placed_at, o.paid_at, o.dispatched_at, o.delivered_at,
                    o.scheduled_for, o.delivery_slot_label,
                    o.delivery_mode, o.same_day_surcharge_fee,
                    o.updated_at, o.seen_at,
                    o.refund_status, o.refund_amount_requested,
                    o.refund_requested_at,
                    o.customer_id, c.nickname, c.phone AS customer_phone,
                    o.store_id, o.routing_reason, o.channel, o.fulfillment_type,
                    o.scheduled_for, o.delivery_slot_label,
                    o.tracking_carrier, o.tracking_number, o.tracking_status,
                    o.tracking_kd100_subscribed,
                    s.code AS store_code, s.name_en AS store_name_en, s.name_cn AS store_name_cn
               FROM retail_orders o
          LEFT JOIN retail_customers c ON c.id = o.customer_id
          LEFT JOIN retail_stores    s ON s.id = o.store_id
              WHERE 1=1`;
  const params = [];
  // `refunds_open` is a pseudo-status that pulls every order currently in
  // the refund pipeline regardless of primary status — so open requests
  // are reachable from the main orders table, not only the chip view.
  if (status === 'refunds_open') {
    sql += " AND o.refund_status IN ('pending','reviewing','approved')";
  } else if (status) {
    sql += ' AND o.status = ?'; params.push(status);
  }
  if (store_id) { sql += ' AND o.store_id = ?'; params.push(parseInt(store_id, 10)); }
  if (q) {
    sql += ' AND (o.order_no LIKE ? OR o.recipient_name LIKE ? OR o.recipient_phone LIKE ? OR c.nickname LIKE ?)';
    const s = `%${q}%`; params.push(s, s, s, s);
  }
  if (from) { sql += ' AND o.placed_at >= ?'; params.push(from); }
  if (to)   { sql += ' AND o.placed_at <= ?'; params.push(to); }
  sql += ' ORDER BY o.placed_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = tdb().prepare(sql).all(...params);
  for (const r of rows) {
    r.item_count = tdb().prepare('SELECT COUNT(*) AS n FROM retail_order_items WHERE order_id = ?').get(r.id).n;
  }
  res.json({ success: true, data: rows, meta: { limit, offset } });
});

router.get('/api/retail-admin/orders/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const o = tdb().prepare(
    `SELECT o.*, c.nickname, c.avatar_url, c.phone AS customer_phone,
            s.code AS store_code, s.name_en AS store_name_en, s.name_cn AS store_name_cn
       FROM retail_orders o
       LEFT JOIN retail_customers c ON c.id = o.customer_id
       LEFT JOIN retail_stores    s ON s.id = o.store_id
      WHERE o.id = ?`
  ).get(id);
  if (!o) return res.status(404).json({ success: false, error: 'not_found' });
  // Mark the order seen by staff the first time anyone opens it (shared across
  // operators) — clears the "unread" (bold + dot) treatment in the Orders list.
  // Idempotent: only the first open stamps seen_at.
  if (!o.seen_at) {
    const nowIso = new Date().toISOString();
    try { tdb().prepare('UPDATE retail_orders SET seen_at = ? WHERE id = ? AND seen_at IS NULL').run(nowIso, id); } catch {}
    o.seen_at = nowIso;
  }
  if (o.address_json) { try { o.address = JSON.parse(o.address_json); } catch {} }
  delete o.address_json;

  // Lazy-fill shipments for orders predating the split-shipment feature.
  // This is idempotent — if rows already exist, nothing changes. Pickup
  // orders ship nothing (collected at the store), so never plan a shipment.
  const shipmentRows = o.fulfillment_type === 'pickup' ? [] : ensureShipments(id);

  // oi.image_url was never captured at order time (always null on insert),
  // so fall through to the live product photo — same approach as the
  // customer-facing detail endpoint — so the backend can show a thumbnail
  // beside each line item. A data: URI here is the raw base64 photo; swap it
  // for the public streamed-image URL so the drawer payload stays small.
  o.items = tdb().prepare(
    `SELECT oi.id, oi.product_id, oi.name_en, oi.name_cn, oi.sku, oi.size,
            COALESCE(NULLIF(oi.image_url, ''), p.image_url, p.image_data) AS image_url,
            oi.qty, oi.unit_price, oi.line_total, oi.options_json,
            oi.ship_modes, oi.needs_ice_pack, oi.shipment_id
       FROM retail_order_items oi
  LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ? ORDER BY oi.id ASC`
  ).all(id).map(it => {
    if (it.options_json) { try { it.options = JSON.parse(it.options_json); } catch {} }
    delete it.options_json;
    // Normalize csv for the front-end (always an array).
    it.ship_modes_arr = parseShipModes(it.ship_modes);
    if (typeof it.image_url === 'string' && /^data:/i.test(it.image_url)) {
      it.image_url = `/api/retail/products/${it.product_id}/image`;
    }
    return it;
  });
  o.payments = tdb().prepare(
    `SELECT id, method, amount, status, transaction_id, out_trade_no,
            qr_image_url, refunded_amount, created_at, completed_at
       FROM retail_payments WHERE order_id = ? ORDER BY id ASC`
  ).all(id);
  o.reservations = tdb().prepare(
    `SELECT r.id, r.store_id, r.product_id, r.qty, r.channel, r.status,
            r.expires_at, r.created_at, r.committed_at, r.released_at,
            p.name_en AS product_name_en, p.name_cn AS product_name_cn
       FROM retail_stock_reservations r
       LEFT JOIN products p ON p.id = r.product_id
      WHERE r.order_id = ? ORDER BY r.id ASC`
  ).all(id);

  // Destination meta — used by the office UI to decide air/land badges.
  const city = o.address?.city || '';
  o.shipping_city      = city;
  o.outside_guangzhou  = !!city && !isGuangzhou(city);

  // Hydrate each shipment with its assigned items + tracking view.
  o.shipments = shipmentRows.map(s => ({
    id: s.id, order_id: s.order_id, mode: s.mode, label: s.label,
    tracking_carrier: s.tracking_carrier,
    tracking_number:  s.tracking_number,
    tracking_status:  s.tracking_status,
    tracking_kd100_subscribed: !!s.tracking_kd100_subscribed,
    tracking_last_error: s.tracking_last_error,
    tracking_synced_at:  s.tracking_synced_at,
    dispatched_at: s.dispatched_at,
    delivered_at:  s.delivered_at,
    items: o.items.filter(it => it.shipment_id === s.id),
    tracking: buildShipmentTrackingView(s),
  }));

  o.timeline = orderTimeline(o);
  // Keep legacy `o.tracking` populated from the primary shipment so older
  // UI code (the mobile track page) keeps working without changes.
  o.tracking = o.shipments[0]?.tracking || buildTrackingView(o);
  // Split-package suggestion — drives the banner above Items in the drawer.
  try { o.shipment_suggestion = buildShipmentSuggestion(id); } catch (e) { o.shipment_suggestion = null; }
  res.json({ success: true, data: o });
});

// ── Fapiao issuance (Phase 3a) ──────────────────────────────────────────────
// The fapiao is issued at the accounting company; this is the system of record.
// Staff "mark issued" + attach the fapiao (a pasted link or an uploaded PDF),
// which then surfaces in the customer's profile. `unissue` reverts a mistake.
router.put('/api/retail-admin/orders/:id/invoice', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const o = tdb().prepare('SELECT id, needs_invoice FROM retail_orders WHERE id = ?').get(id);
  if (!o) return res.status(404).json({ success: false, error: 'not_found' });
  if (!o.needs_invoice) return res.status(400).json({ success: false, error: 'no_invoice_requested' });
  if (req.body?.action === 'unissue') {
    tdb().prepare("UPDATE retail_orders SET invoice_status = 'requested', invoice_issued_at = NULL WHERE id = ?").run(id);
    return res.json({ success: true });
  }
  const fileUrl = (req.body?.file_url || '').trim() || null;
  const number  = (req.body?.number || '').trim() || null;
  if (!fileUrl && !number) return res.status(400).json({ success: false, error: 'need_file_or_number' });
  tdb().prepare(
    `UPDATE retail_orders
        SET invoice_status = 'issued', invoice_file_url = ?, invoice_number = ?, invoice_issued_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(fileUrl, number, id);
  notifyForOrder(id, (o) => ({
    category: 'invoice', type: 'invoice_issued', ref_type: 'invoice',
    title_en: 'Invoice issued', title_cn: '发票已开具',
    body_en: `The invoice for order ${o.order_no} is ready`,
    body_cn: `订单 ${o.order_no} 的发票已开具`,
  }));
  res.json({ success: true });
});

// Store an uploaded fapiao PDF (base64 data URI) in retail_media; returns a
// servable URL (GET /api/retail/media/:id streams it with the stored mime).
router.post('/api/retail-admin/invoice-file', requireRetailAdmin, express.json({ limit: '12mb' }), (req, res) => {
  const { data } = req.body || {};
  const m = /^data:(application\/pdf|image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(typeof data === 'string' ? data : '');
  if (!m) return res.status(400).json({ success: false, error: 'unsupported_type' });
  const declaredMime = m[1];
  const sizeBytes = Math.floor(m[2].length * 3 / 4);
  if (sizeBytes > 10 * 1024 * 1024) return res.status(400).json({ success: false, error: 'too_large' });
  // Don't trust the data-URL's self-declared MIME — verify the real bytes start
  // with the matching magic number. Decode only the small header, not the whole blob.
  let mime, ext;
  try {
    const head = Buffer.from(m[2].slice(0, 24), 'base64');
    const latin = head.subarray(0, 12).toString('latin1');
    if (head.subarray(0, 5).toString('latin1') === '%PDF-') { mime = 'application/pdf'; ext = 'pdf'; }
    else if (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) { mime = 'image/jpeg'; ext = 'jpg'; }
    else if (latin.startsWith('\x89PNG\r\n\x1a\n')) { mime = 'image/png'; ext = 'png'; }
    else if (latin.startsWith('GIF87a') || latin.startsWith('GIF89a')) { mime = 'image/gif'; ext = 'gif'; }
    else if (latin.startsWith('RIFF') && latin.slice(8, 12) === 'WEBP') { mime = 'image/webp'; ext = 'webp'; }
    else return res.status(400).json({ success: false, error: 'unsupported_type' });
  } catch {
    return res.status(400).json({ success: false, error: 'unsupported_type' });
  }
  if (mime !== declaredMime) return res.status(400).json({ success: false, error: 'type_mismatch' });
  try {
    const info = tdb().prepare(
      `INSERT INTO retail_media (filename, mime_type, size_bytes, data, uploaded_by)
       VALUES (?, ?, ?, ?, NULL)`
    ).run('fapiao.' + ext, mime, sizeBytes, data);
    res.json({ success: true, data: { url: `/api/retail/media/${info.lastInsertRowid}` } });
  } catch (e) {
    console.error('[retail-admin/invoice-file] insert failed:', e.message);
    res.status(500).json({ success: false, error: 'db_insert_failed' });
  }
});

// Invoices tab — every order that requested a fapiao, so staff can issue from
// one list instead of opening each order. ?status=requested (pending, default
// surfaced first) | issued | all. Includes items so the per-row block can copy
// the accounting bundle. `counts` powers the filter chips.
router.get('/api/retail-admin/invoices', requireRetailAdmin, (req, res) => {
  const status = ['requested', 'issued', 'all'].includes(req.query.status) ? req.query.status : 'all';
  let where = 'o.needs_invoice = 1';
  if (status === 'issued')        where += " AND o.invoice_status = 'issued'";
  else if (status === 'requested') where += " AND COALESCE(o.invoice_status, 'requested') <> 'issued'";
  const orders = tdb().prepare(
    `SELECT o.id, o.order_no, o.total, o.shipping_fee, o.placed_at,
            o.invoice_type, o.invoice_title, o.invoice_tax_id, o.invoice_email,
            o.invoice_status, o.invoice_file_url, o.invoice_number, o.invoice_issued_at,
            c.nickname
       FROM retail_orders o
       LEFT JOIN retail_customers c ON c.id = o.customer_id
      WHERE ${where}
      ORDER BY (CASE WHEN o.invoice_status = 'issued' THEN 1 ELSE 0 END) ASC, o.placed_at DESC
      LIMIT 200`
  ).all();
  const itemStmt = tdb().prepare(
    'SELECT product_id, name_en, name_cn, qty, line_total FROM retail_order_items WHERE order_id = ? ORDER BY id ASC'
  );
  for (const o of orders) o.items = itemStmt.all(o.id);
  res.json({
    success: true,
    data: orders,
    counts: {
      requested: tdb().prepare("SELECT COUNT(*) AS n FROM retail_orders WHERE needs_invoice = 1 AND COALESCE(invoice_status, 'requested') <> 'issued'").get().n,
      issued:    tdb().prepare("SELECT COUNT(*) AS n FROM retail_orders WHERE needs_invoice = 1 AND invoice_status = 'issued'").get().n,
    },
  });
});

// Apply the split-package suggestion: re-bucket items between the order's
// air/land shipments to match buildShipmentSuggestion's suggested plan,
// creating a missing shipment if the order currently has only one bucket.
// 422 if the order is no longer eligible (admin clicked an outdated banner).
router.post('/api/retail-admin/orders/:id/shipment-suggestion/apply',
  requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sug = buildShipmentSuggestion(id);
  if (!sug || !sug.eligible) {
    return res.status(422).json({ success: false, error: 'not_eligible', reason: sug?.reason || 'unknown' });
  }
  const shipments = tdb().prepare(
    `SELECT id, mode FROM retail_shipments WHERE order_id = ? ORDER BY id ASC`
  ).all(id);
  const byMode = new Map(shipments.map(s => [s.mode, s.id]));

  const ensureShipmentRow = (mode) => {
    if (byMode.has(mode)) return byMode.get(mode);
    const label = mode === 'air' ? 'Air shipment · 空运' : 'Land shipment · 陆运';
    const r = tdb().prepare(
      `INSERT INTO retail_shipments (order_id, mode, label, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(id, mode, label);
    byMode.set(mode, r.lastInsertRowid);
    return r.lastInsertRowid;
  };

  const reassign = tdb().prepare(
    `UPDATE retail_order_items SET shipment_id = ? WHERE id = ? AND order_id = ?`
  );
  const tx = tdb().transaction(() => {
    for (const bk of sug.suggested.plan) {
      const sid = ensureShipmentRow(bk.mode);
      for (const itemId of bk.item_ids) reassign.run(sid, itemId, id);
    }
    // Delete now-empty shipments (only when the new plan collapses to one
    // bucket — rare here, but covers the land-floor fold-back path).
    const emptyIds = tdb().prepare(
      `SELECT s.id FROM retail_shipments s
        WHERE s.order_id = ?
          AND NOT EXISTS (SELECT 1 FROM retail_order_items i WHERE i.shipment_id = s.id)`
    ).all(id);
    for (const row of emptyIds) {
      // Don't drop a shipment that already has a waybill — admin may have
      // edited it manually after the suggestion was built.
      const s = shipments.find(x => x.id === row.id);
      if (s && (s.tracking_number || s.tracking_carrier)) continue;
      tdb().prepare(`DELETE FROM retail_shipments WHERE id = ?`).run(row.id);
    }
  });
  tx();
  res.json({ success: true });
});

// ─── Integrations admin (kd100 + JD LOP + Feie credentials) ────────────
// Per-tenant (Platform readiness ⑤). Storage splits by tenant:
//
//   • Roots (tenant #1 / unscoped) — UNCHANGED legacy path. Secrets persist
//     in storefront_config under `integrations.<svc>.<field>` AND mirror to
//     process.env on save, so the Roots-global codepaths (sweeper, kd100
//     webhook) keep reading from env. Boot-time hydration in database.js
//     re-syncs DB→env on restart.
//
//   • Any other tenant — secrets persist ENCRYPTED in tenant_secrets via
//     lib/tenant-creds (setTenantSecrets). NO storefront_config row, NO
//     process.env mutation — that shared env is Roots'. Reads come back
//     through getTenantCreds(tenantId).integrations, never env.
//
// Each field carries: `env` (Roots' process.env var), `secret` (mask on GET),
// `cred` (tenant_secrets KEY constant), `bkey` (field name inside the
// getTenantCreds().integrations.<svc> bundle, used for masked reads).
const INTEGRATION_KEYS = {
  kd100: {
    customer: { env: 'KD100_CUSTOMER', secret: false, cred: CRED_KEYS.KD100_CUSTOMER, bkey: 'customer' },
    key:      { env: 'KD100_KEY',      secret: true,  cred: CRED_KEYS.KD100_KEY,      bkey: 'key'      },
    callback: { env: 'KD100_CALLBACK', secret: false, cred: CRED_KEYS.KD100_CALLBACK, bkey: 'callback' },
    secret:   { env: 'KD100_SECRET',   secret: true,  cred: CRED_KEYS.KD100_SECRET,   bkey: 'secret'   },
  },
  jd: {
    app_key:       { env: 'JD_APP_KEY',       secret: false, cred: CRED_KEYS.JD_APP_KEY,       bkey: 'appKey'       },
    app_secret:    { env: 'JD_APP_SECRET',    secret: true,  cred: CRED_KEYS.JD_APP_SECRET,    bkey: 'appSecret'    },
    access_token:  { env: 'JD_ACCESS_TOKEN',  secret: true,  cred: CRED_KEYS.JD_ACCESS_TOKEN,  bkey: 'accessToken'  },
    customer_code: { env: 'JD_CUSTOMER_CODE', secret: false, cred: CRED_KEYS.JD_CUSTOMER_CODE, bkey: 'customerCode' },
    env:           { env: 'JD_API_ENV',       secret: false, cred: CRED_KEYS.JD_ENV,           bkey: 'env'          },
  },
  feie: {
    user: { env: 'FEIE_USER', secret: false, cred: CRED_KEYS.FEIE_USER, bkey: 'user' },  // Feieyun account login
    ukey: { env: 'FEIE_UKEY', secret: true,  cred: CRED_KEYS.FEIE_UKEY, bkey: 'ukey' },  // USERKEY from dev console
    // Printer SNs are per-store — see storefront_config `printer.by_store`.
  },
};

function maskSecret(s) {
  if (!s || typeof s !== 'string') return '';
  if (s.length <= 4) return '••••';
  return '••••' + s.slice(-4);
}

router.get('/api/retail-admin/integrations', requireRetailAdmin, (req, res) => {
  // Each tenant sees its OWN creds. For Roots this resolves to the env
  // bundle (== the old process.env reads); for any other tenant it comes
  // from its encrypted tenant_secrets — never Roots' env.
  const ci = getTenantCreds(currentTenantId()).integrations;
  const out = {};
  for (const [svc, fields] of Object.entries(INTEGRATION_KEYS)) {
    out[svc] = {};
    const svcVals = ci[svc] || {};
    for (const [field, meta] of Object.entries(fields)) {
      const val = svcVals[meta.bkey] || '';
      if (meta.secret) {
        out[svc][field + '_masked'] = maskSecret(val);
      } else {
        out[svc][field] = val;
      }
    }
  }
  // kd100 callback URL is system-built per tenant (⑨), so a tenant is "enabled"
  // on customer+key alone — kd100Creds() injects the path-scoped callback.
  out.kd100.enabled = tracking.kd100Enabled(kd100Creds());
  out.jd.enabled    = jd.jdEnabled(ci.jd);
  out.feie.enabled  = _feie.feieEnabled(ci.feie);
  res.json({ success: true, data: out });
});

router.put('/api/retail-admin/integrations', requireRetailAdmin, express.json(), (req, res) => {
  const body = req.body || {};
  const tid = currentTenantId();
  const isRoots = tid === ROOTS_TENANT_ID;
  const changedKeys = [];

  // Collect the fields the request actually wants to change. `undefined`
  // means "keep current". `null`/'' means "clear". Anything else updates.
  // We build one list and dispatch by tenant so Roots and non-Roots share
  // the same field-walk but write to different stores.
  const edits = [];   // { svc, field, meta, val }
  for (const [svc, fields] of Object.entries(INTEGRATION_KEYS)) {
    const incoming = body[svc];
    if (!incoming || typeof incoming !== 'object') continue;
    for (const [field, meta] of Object.entries(fields)) {
      if (!Object.prototype.hasOwnProperty.call(incoming, field)) continue;
      const val = incoming[field];
      if (val === undefined) continue;
      edits.push({ svc, field, meta, val });
      changedKeys.push(`integrations.${svc}.${field}`);
    }
  }

  if (isRoots) {
    // ── Roots legacy path (UNCHANGED): storefront_config + process.env mirror.
    const upsert = tdb().prepare(
      `INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
         VALUES (?, ?, CURRENT_TIMESTAMP, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = CURRENT_TIMESTAMP,
         updated_by = excluded.updated_by`
    );
    const tx = tdb().transaction(() => {
      for (const { svc, field, meta, val } of edits) {
        const cfgKey = `integrations.${svc}.${field}`;
        if (val === null || val === '') {
          tdb().prepare('DELETE FROM storefront_config WHERE key = ?').run(cfgKey);
          delete process.env[meta.env];
        } else {
          upsert.run(cfgKey, JSON.stringify(String(val)), req.user.id);
          process.env[meta.env] = String(val);
        }
      }
    });
    tx();
  } else {
    // ── Per-tenant path: encrypted tenant_secrets only. No storefront_config
    // row, no process.env touch (that env belongs to Roots). setTenantSecrets
    // treats '' as a clear, so null/'' both delete the row.
    const map = {};
    for (const { meta, val } of edits) {
      map[meta.cred] = (val === null) ? '' : String(val);
    }
    setTenantSecrets(tid, map);
  }

  logActivity(req.user.id, req.user.username, 'integrations_update', 'storefront_config', null,
    { tenant_id: tid, keys: changedKeys.map(k => k.replace(/^integrations\./, '')) }, req.ip);
  res.json({ success: true, changed: changedKeys.length });
});

// Sanity-check JD LOP connectivity — pings JD's server-time endpoint
// which any valid app_key + signature combination can call. Confirms
// the credentials reach JD before the office wires a real waybill.
const jd = require('../lib/jd');
router.post('/api/retail-admin/integrations/jd/test', requireRetailAdmin, async (req, res) => {
  const jc = integ().jd;
  if (!jd.jdEnabled(jc)) return res.json({ ok: false, error: 'not_configured' });
  const r = await jd.pingJd(jc);
  if (r.ok) return res.json({ ok: true, server_time: r.data?.serverTime || null });
  return res.json({ ok: false, error: r.error });
});

// ─── Feie cloud printer (per-store routing) ──────────────────────────────
// Account creds (FEIE_USER / FEIE_UKEY) ride the integrations.* path above.
// Each store has its OWN printer; the SN + template + copies per store live
// in storefront_config `printer.by_store` (private — never exposed to the
// mini app), keyed by store id:
//   printer.by_store = { "<storeId>": { sn, template, copies } }
// A paid order prints only at the store that fulfils it (order.store_id),
// so the right slip lands at the right counter automatically.

// Hoisted: markOrderPaid (defined far earlier) calls these on every paid
// transition, so they must be reachable from there at runtime.
function loadPrinterPrefs() {
  const get = (k, d) => {
    const r = tdb().prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(k);
    if (!r) return d;
    try { return JSON.parse(r.value_json); } catch { return d; }
  };
  const by_store = get('printer.by_store', {});
  return {
    auto_print: get('printer.auto_print', true),
    shop_name:  get('printer.shop_name', tenantBrandLabel()),
    by_store:   (by_store && typeof by_store === 'object') ? by_store : {},
  };
}

// Pick the printer config for an order's fulfilling store. If the order has
// no store_id (rare) but exactly one printer is configured, fall back to it
// so single-store installs still print. Returns null when nothing matches.
function printerForStore(storeId, prefs) {
  const map = prefs.by_store || {};
  if (storeId != null && map[String(storeId)]) return map[String(storeId)];
  const ids = Object.keys(map).filter(k => map[k] && map[k].sn);
  if (storeId == null && ids.length === 1) return map[ids[0]];
  return null;
}

// Render + print one order to its store's printer. All DB reads are
// synchronous (tenant DB stays bound); the returned promise covers only the
// network POST. `pcfg` overrides the resolved store printer (used by tests).
function printOrderById(orderId, prefs, pcfg) {
  const fc = integ().feie;   // the fulfilling tenant's own Feieyun account
  if (!_feie.feieEnabled(fc)) return Promise.resolve({ ok: false, msg: 'not_configured' });
  const order = tdb().prepare('SELECT * FROM retail_orders WHERE id = ?').get(orderId);
  if (!order) return Promise.resolve({ ok: false, msg: 'order_not_found' });
  const p = prefs || loadPrinterPrefs();
  const printer = pcfg || printerForStore(order.store_id, p);
  if (!printer || !printer.sn) return Promise.resolve({ ok: false, msg: 'no_printer_for_store' });
  const items = tdb().prepare('SELECT * FROM retail_order_items WHERE order_id = ? ORDER BY id').all(orderId);
  const tpl = _feie.TEMPLATE_IDS.includes(printer.template) ? printer.template : 'receipt';
  const content = _feie.renderOrder(tpl, order, items, p.shop_name);
  return _feie.printContent(content, { sn: printer.sn, copies: printer.copies || 1 }, fc);
}

router.get('/api/retail-admin/printer', requireRetailAdmin, (req, res) => {
  const prefs = loadPrinterPrefs();
  // Join active stores with their saved printer config so the UI can render
  // one row per store.
  const stores = tdb().prepare(
    'SELECT id, code, name_en, name_cn FROM retail_stores WHERE is_active = 1 ORDER BY sort_order, id'
  ).all().map(s => {
    const cfg = prefs.by_store[String(s.id)] || {};
    return {
      id: s.id, code: s.code, name_en: s.name_en, name_cn: s.name_cn,
      sn: cfg.sn || '', template: cfg.template || 'receipt', copies: cfg.copies || 1,
    };
  });
  res.json({ success: true, data: {
    auto_print: prefs.auto_print,
    shop_name:  prefs.shop_name,
    enabled:    _feie.feieEnabled(integ().feie),
    templates:  _feie.TEMPLATE_IDS,
    stores,
  }});
});

router.put('/api/retail-admin/printer', requireRetailAdmin, express.json(), (req, res) => {
  const b = req.body || {};
  const upsert = tdb().prepare(
    `INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
       VALUES (?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by`
  );
  const tx = tdb().transaction(() => {
    if (b.auto_print !== undefined) upsert.run('printer.auto_print', JSON.stringify(!!b.auto_print), req.user.id);
    if (b.shop_name !== undefined) {
      upsert.run('printer.shop_name', JSON.stringify(String(b.shop_name || '').slice(0, 40)), req.user.id);
    }
    if (b.by_store !== undefined && b.by_store && typeof b.by_store === 'object') {
      const clean = {};
      for (const [sid, cfg] of Object.entries(b.by_store)) {
        if (!/^\d+$/.test(sid) || !cfg || typeof cfg !== 'object') continue;
        const sn = String(cfg.sn || '').trim();
        if (!sn) continue;  // a row with no SN means "no printer at this store"
        clean[sid] = {
          sn,
          template: _feie.TEMPLATE_IDS.includes(cfg.template) ? cfg.template : 'receipt',
          copies: Math.max(1, Math.min(5, parseInt(cfg.copies, 10) || 1)),
        };
      }
      upsert.run('printer.by_store', JSON.stringify(clean), req.user.id);
    }
  });
  tx();
  logActivity(req.user.id, req.user.username, 'printer_settings_update', 'storefront_config', null, {}, req.ip);
  res.json({ success: true, data: loadPrinterPrefs() });
});

// Test print to ONE store's printer. Body: { store_id }. Prints the latest
// real order for that store if there is one, otherwise a sample slip.
router.post('/api/retail-admin/printer/test', requireRetailAdmin, async (req, res) => {
  if (!_feie.feieEnabled(integ().feie)) return res.json({ ok: false, error: 'not_configured' });
  const prefs = loadPrinterPrefs();
  const storeId = parseInt(req.body?.store_id, 10);
  const printer = prefs.by_store[String(storeId)];
  if (!printer || !printer.sn) return res.json({ ok: false, error: 'no_printer_for_store' });
  const tpl = _feie.TEMPLATE_IDS.includes(printer.template) ? printer.template : 'receipt';

  const last = tdb().prepare(
    "SELECT id FROM retail_orders WHERE store_id = ? AND status != 'pending_payment' ORDER BY id DESC LIMIT 1"
  ).get(storeId);
  let r;
  if (last) {
    r = await printOrderById(last.id, prefs, printer);
  } else {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const sample = {
      order_no: 'TEST-0001', placed_at: now, paid_at: now,
      recipient_name: 'Test 测试', recipient_phone: '13800000000',
      subtotal: 18, shipping_fee: 0, total: 18, payment_method: 'wechat',
      address_full: 'Test address 测试地址 1号',
    };
    const items = [{ name_cn: '测试商品', name_en: 'Test item', qty: 1, unit_price: 18, line_total: 18 }];
    const content = _feie.renderOrder(tpl, sample, items, prefs.shop_name);
    r = await _feie.printContent(content, { sn: printer.sn, copies: 1 }, integ().feie);
  }
  if (r.ok) return res.json({ ok: true });
  res.json({ ok: false, error: r.msg || 'print_failed' });
});

// Sanity-check kd100 connectivity. Reads the freshly-saved credentials
// from env and tries a no-op subscribe against a deliberately-bogus
// waybill number — kd100 will respond with an auth/format error rather
// than success, but a network round-trip with a parseable JSON body is
// proof the auth credentials reach kd100.
router.post('/api/retail-admin/integrations/kd100/test', requireRetailAdmin, async (req, res) => {
  const kc = kd100Creds();
  if (!tracking.kd100Enabled(kc)) return res.json({ ok: false, error: 'not_configured' });
  const r = await tracking.subscribeWithKd100({
    orderId: 0, carrierCode: 'jd', trackingNumber: '__TEST__INVALID__', recipientPhone: null,
  }, kc);
  // Either success (kd100 happily accepted the dummy) or a meaningful
  // error string from kd100 = auth reached them. Network/HTTP errors
  // surface as kd100_request_failed.
  if (r.ok || (r.error && !r.error.startsWith('kd100_request_failed'))) {
    return res.json({ ok: true, message: r.ok ? 'subscribed (will auto-shutdown on invalid)' : r.error });
  }
  res.json({ ok: false, error: r.error });
});

// Carrier registry — the admin tracking form's dropdown source.
router.get('/api/retail-admin/tracking/carriers', requireRetailAdmin, (req, res) => {
  res.json({ success: true, data: tracking.CARRIERS.map(c => ({
    code: c.code, name_en: c.name_en, name_cn: c.name_cn,
  })) });
});

// Attach (or update) a tracking number on a shipped order. Allowed for
// orders that are dispatched or delivered — anything earlier wouldn't
// have a waybill yet. Body: { carrier, tracking_number }.
//
// Side effect: if kd100 (快递100) is configured AND the carrier has a
// kd100 mapping, we asynchronously subscribe the waybill for live
// push updates. The subscribe outcome is written back to
// tracking_kd100_subscribed / tracking_last_error so staff can retry
// from the UI if it fails.
router.put('/api/retail-admin/orders/:id/tracking', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const carrier = String(req.body?.carrier || '').trim().toLowerCase();
  const number  = String(req.body?.tracking_number || '').trim();
  const shipmentIdReq = req.body?.shipment_id != null ? parseInt(req.body.shipment_id, 10) : null;
  if (!carrier || !tracking.carrierByCode(carrier)) {
    return res.status(400).json({ success: false, error: 'invalid_carrier' });
  }
  if (!number || number.length > 64 || !/^[A-Za-z0-9\-]+$/.test(number)) {
    return res.status(400).json({ success: false, error: 'invalid_tracking_number' });
  }
  const o = tdb().prepare('SELECT id, status, recipient_phone FROM retail_orders WHERE id = ?').get(id);
  if (!o) return res.status(404).json({ success: false, error: 'not_found' });
  if (!['dispatched', 'delivered'].includes(o.status)) {
    return res.status(409).json({ success: false, error: 'not_shipped', status: o.status });
  }

  // Resolve the shipment row this waybill should attach to. If the
  // caller didn't pass shipment_id, default to the order's primary (first)
  // shipment — preserves the legacy single-waybill UI.
  const shipments = ensureShipments(id);
  if (!shipments.length) return res.status(500).json({ success: false, error: 'no_shipments' });
  const shipment = shipmentIdReq
    ? shipments.find(s => s.id === shipmentIdReq)
    : shipments[0];
  if (!shipment) return res.status(400).json({ success: false, error: 'invalid_shipment_id' });

  const derived = tracking.deriveStatusFromOrder(o.status);
  tdb().prepare(
    `UPDATE retail_shipments
        SET tracking_carrier = ?, tracking_number = ?,
            tracking_status = ?,
            tracking_events_json = NULL,
            tracking_synced_at = CURRENT_TIMESTAMP,
            tracking_last_error = NULL,
            tracking_kd100_subscribed = 0,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(carrier, number, derived, shipment.id);

  // Mirror to retail_orders.tracking_* when this is the primary shipment
  // so legacy callers (mobile track page, customer mini-app order list)
  // keep working. When attaching to a non-primary shipment we don't touch
  // the legacy fields — the new shipments[] array is authoritative.
  if (shipment.id === shipments[0].id) {
    tdb().prepare(
      `UPDATE retail_orders
          SET tracking_carrier = ?, tracking_number = ?,
              tracking_status = ?,
              tracking_events_json = NULL,
              tracking_synced_at = CURRENT_TIMESTAMP,
              tracking_last_error = NULL,
              tracking_kd100_subscribed = 0,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(carrier, number, derived, id);
  }

  logActivity(req.user.id, req.user.username, 'tracking_set', 'retail_order', id,
    { carrier, number, shipment_id: shipment.id, mode: shipment.mode }, req.ip);

  // Fire-and-forget kd100 subscription against the shipment row. Resolve the
  // tenant's kd100 creds synchronously (before the async fire) so the deferred
  // subscribe runs under this tenant's own account.
  const kc = kd100Creds();
  if (tracking.kd100Enabled(kc) && tracking.KD100_CARRIER_MAP[carrier]) {
    tracking.subscribeWithKd100({
      orderId: id, carrierCode: carrier, trackingNumber: number,
      recipientPhone: o.recipient_phone,
    }, kc).then(r => {
      if (r.ok) {
        tdb().prepare("UPDATE retail_shipments SET tracking_kd100_subscribed = 1, tracking_last_error = NULL WHERE id = ?").run(shipment.id);
        if (shipment.id === shipments[0].id) {
          tdb().prepare("UPDATE retail_orders SET tracking_kd100_subscribed = 1, tracking_last_error = NULL WHERE id = ?").run(id);
        }
      } else {
        tdb().prepare("UPDATE retail_shipments SET tracking_kd100_subscribed = 0, tracking_last_error = ? WHERE id = ?").run(r.error, shipment.id);
        console.warn(`[kd100.subscribe] order=${id} shipment=${shipment.id} number=${number}:`, r.error);
      }
    }).catch(e => {
      tdb().prepare("UPDATE retail_shipments SET tracking_last_error = ? WHERE id = ?").run('subscribe_threw: ' + e.message, shipment.id);
      console.error(`[kd100.subscribe] threw for order=${id} shipment=${shipment.id}:`, e);
    });
  }

  const fresh = tdb().prepare('SELECT * FROM retail_shipments WHERE id = ?').get(shipment.id);
  res.json({
    success: true,
    data: {
      id,
      shipment_id: shipment.id,
      tracking: buildShipmentTrackingView(fresh),
      kd100_enabled: tracking.kd100Enabled(kc),
      kd100_supported: !!tracking.KD100_CARRIER_MAP[carrier],
    },
  });
});

// Public mobile-optimized tracking page — rendered as HTML so a WeChat
// mini-app <web-view> can load it inside the app. URL form:
//   /track/:orderNo/:tracking_number?lang=cn|en
// We render the events we already have cached (tracking_events_json)
// plus a "View on carrier app" deep-link list. Bilingual via ?lang.
router.get('/track/:orderNo/:trackingNumber', (req, res) => {
  const orderNo = String(req.params.orderNo || '');
  const number  = String(req.params.trackingNumber || '');
  const lang    = (req.query.lang === 'cn') ? 'cn' : 'en';
  const o = tdb().prepare(
    `SELECT order_no, status, tracking_carrier, tracking_number,
            tracking_status, tracking_events_json, tracking_synced_at,
            tracking_scenario_data_json
       FROM retail_orders
      WHERE order_no = ? AND tracking_number = ?`
  ).get(orderNo, number);
  res.type('html');
  if (!o) {
    return res.send(`<!doctype html><meta charset="utf-8"><title>404</title>
<style>body{font:14px/1.5 -apple-system,sans-serif;padding:40px;text-align:center;color:#666}</style>
<p>${lang === 'cn' ? '未找到该运单 · ' : 'Order not found · '}${escapeHtml(orderNo)}</p>`);
  }
  const carrier  = tracking.carrierByCode(o.tracking_carrier);
  const statusDef = tracking.statusByCode(o.tracking_status || tracking.deriveStatusFromOrder(o.status));
  const events   = (() => {
    try {
      const raw = JSON.parse(o.tracking_events_json) || [];
      // Translate each event when rendering for an English locale; CN
      // locale gets the original carrier text untouched.
      return raw.map(ev => ({
        ...ev,
        description: lang === 'cn'
          ? (ev.description_cn || '')
          : tracking.translateEventDescription(ev.description_cn),
      }));
    } catch { return []; }
  })();
  const scenario = (() => { try { return JSON.parse(o.tracking_scenario_data_json) || null; } catch { return null; } })();
  const trackUrl = tracking.trackingUrl(o.tracking_carrier, o.tracking_number);

  const cName  = lang === 'cn' ? (carrier?.name_cn || o.tracking_carrier) : (carrier?.name_en || o.tracking_carrier);
  const sLabel = lang === 'cn' ? (statusDef?.label_cn || '') : (statusDef?.label_en || '');

  // Scenario banner — bg + border tinted by urgency. Pickup codes get a
  // dedicated copyable block since that's the one thing the customer
  // actually needs to retrieve their package.
  const banner = scenario ? (() => {
    const URG_BG = { urgent: '#FCE3E5', action_needed: '#FBEFC9', info: '#E3EFD3', transit: '#E5EEF8' };
    const URG_BR = { urgent: '#E96174', action_needed: '#E8B53A', info: '#7BBD3B', transit: '#B2CFED' };
    const title  = lang === 'cn' ? scenario.label_cn : scenario.label_en;
    const sub    = scenario.location_label || (scenario.signer ? (lang === 'cn' ? '签收人:' + scenario.signer : 'Signed by ' + scenario.signer) : '');
    const code   = scenario.pickup_code;
    const action = scenario.scenario === 'no_contact'
      ? (lang === 'cn' ? '请尽快回拨快递员电话' : 'Call the courier back ASAP')
      : '';
    return `
      <div class="banner" style="background:${URG_BG[scenario.urgency] || '#eee'};border:2px solid ${URG_BR[scenario.urgency] || '#888'}">
        <div class="b-icon">${escapeHtml(scenario.icon || '')}</div>
        <div class="b-body">
          <div class="b-title">${escapeHtml(title || '')}</div>
          ${sub  ? `<div class="b-sub">${escapeHtml(sub)}</div>` : ''}
          ${code ? `
            <div class="b-code">
              <div class="b-code-label">${lang === 'cn' ? '取件码' : 'PICKUP CODE'}</div>
              <div class="b-code-val">${escapeHtml(code)}</div>
            </div>` : ''}
          ${action ? `<div class="b-action">${escapeHtml(action)} →</div>` : ''}
        </div>
      </div>`;
  })() : '';
  const headEN = 'Shipment tracking';
  const headCN = '物流跟踪';
  const noEventsEN = 'No events from the carrier yet. The first scan usually arrives within a few hours of dispatch.';
  const noEventsCN = '暂无承运商事件。首次扫描通常在发货后几小时内到达。';

  const html = `<!doctype html><html lang="${lang}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>${escapeHtml(o.order_no)} · ${escapeHtml(cName)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;padding:24px 20px 60px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif;color:#1a1a17;background:#FAF7F1}
  .hdr{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#7a7869;margin-bottom:6px}
  h1{font-size:22px;margin:0 0 4px;font-weight:700}
  .num{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#7a7869;font-size:13px}
  .pill{display:inline-block;margin-top:14px;padding:6px 14px;border-radius:999px;font-size:12px;font-weight:600;background:rgba(123,189,59,.16);border:1.5px solid rgba(123,189,59,.4);color:#3a6817}
  .events{position:relative;margin:28px 0 0;padding-left:18px}
  .events::before{content:'';position:absolute;top:12px;bottom:12px;left:8px;width:2px;background:rgba(0,0,0,.12)}
  .ev{position:relative;padding:0 0 22px 32px}
  .ev:last-child{padding-bottom:0}
  .ev .dot{position:absolute;left:-2px;top:4px;width:18px;height:18px;border-radius:999px;background:#FAF7F1;border:2.5px solid rgba(0,0,0,.25)}
  .ev:first-child .dot{background:#2D4A1B;border-color:#2D4A1B}
  .ev:first-child .desc{font-weight:600}
  .ev .desc{line-height:1.4}
  .ev .meta{font-size:11px;color:#7a7869;margin-top:3px}
  .empty{padding:24px;background:#fff;border-radius:10px;text-align:center;color:#7a7869;margin-top:24px}
  .banner{display:flex;gap:14px;align-items:flex-start;padding:18px 18px 20px;border-radius:12px;margin-top:22px}
  .b-icon{font-size:30px;line-height:1;margin-top:2px;flex-shrink:0}
  .b-body{flex:1;min-width:0}
  .b-title{font-size:17px;font-weight:700;line-height:1.2}
  .b-sub{margin-top:5px;font-size:13px;color:#444;line-height:1.4}
  .b-code{margin-top:12px;padding:10px 14px;background:rgba(255,255,255,.65);border-radius:8px}
  .b-code-label{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#7a7869;font-family:ui-monospace,monospace}
  .b-code-val{margin-top:3px;font-size:24px;font-weight:700;letter-spacing:.06em;font-family:ui-monospace,monospace;color:#1a1a17}
  .b-action{margin-top:10px;font-size:12px;font-weight:700;letter-spacing:.04em;color:#9c1f33}
  .cta-row{margin-top:30px;display:flex;gap:10px;flex-wrap:wrap}
  .cta{flex:1;min-width:140px;text-align:center;padding:12px 14px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;background:#fff;color:#1a1a17;border:1.5px solid #1a1a17}
  .cta.primary{background:#E96174;color:#fff;border-color:#E96174}
  .footer{margin-top:30px;font-size:11px;color:#9a988a;text-align:center;line-height:1.6}
  .synced{font-size:11px;color:#7a7869;margin-top:4px}
</style></head><body>
<div class="hdr">${lang === 'cn' ? headCN : headEN}</div>
<h1>${escapeHtml(cName)}</h1>
<div class="num">${escapeHtml(o.tracking_number)}</div>
${sLabel ? `<div class="pill">● ${escapeHtml(sLabel)}</div>` : ''}
${o.tracking_synced_at ? `<div class="synced">${lang === 'cn' ? '最后更新' : 'Last update'} · ${escapeHtml(o.tracking_synced_at.replace('T',' ').slice(0,16))}</div>` : ''}

${banner}

${events.length ? `
<div class="events">
  ${events.map(ev => `
    <div class="ev">
      <span class="dot"></span>
      <div class="desc">${escapeHtml(ev.description || ev.description_cn || '')}</div>
      <div class="meta">${escapeHtml((ev.time || '').slice(0,16))}${ev.location ? ' · ' + escapeHtml(ev.location) : ''}</div>
    </div>`).join('')}
</div>` : `<div class="empty">${lang === 'cn' ? noEventsCN : noEventsEN}</div>`}

<div class="cta-row">
  ${trackUrl ? `<a class="cta primary" href="${escapeHtml(trackUrl)}">${lang === 'cn' ? '在 ' + escapeHtml(cName) + ' 官网打开' : 'Open on ' + escapeHtml(cName)}</a>` : ''}
  <a class="cta" href="javascript:navigator.clipboard?.writeText('${escapeHtml(o.tracking_number)}').then(()=>alert('${lang === 'cn' ? '运单号已复制' : 'Tracking number copied'}'))">${lang === 'cn' ? '复制运单号' : 'Copy tracking number'}</a>
</div>
<div class="footer">${(() => { const brand = escapeHtml(tenantBrandLabel()); return lang === 'cn' ? '该页面由 ' + brand + ' 提供 · 数据来源 ' + escapeHtml(cName) : 'Provided by ' + brand + ' · Data via ' + escapeHtml(cName); })()}</div>
</body></html>`;
  res.send(html);
});

// Tiny escape helper for the HTML above. Kept local to avoid leaking
// a global; the route is the only consumer.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// 快递100 callback — they POST here on every event update for a
// subscribed waybill. Body is form-urlencoded `param=<json>`. We verify
// the salt was one we issued before trusting the payload, look up the
// order by tracking_number, and merge the events.
// Per-tenant routing (Platform readiness ⑨): kd100 POSTs with no header/
// session, so the tenant is carried in the URL PATH (/callback/:tid). We
// settle inside that tenant's data scope (tdb() → the tenant's DB) and verify
// the salt against THAT tenant's secret. Roots keeps the legacy unsuffixed
// path (env creds, mainDb) — byte-for-byte unchanged (getTenantDb(1)===mainDb,
// getTenantCreds(1)===env bundle, so the salt + DB are identical to before).
function handleKd100Callback(req, res, tid) {
  tenantAls.run(getTenantDb(tid), () => {
    try {
      const parsed = tracking.parseKd100Callback(req.body?.param);
      if (!parsed || !parsed.number) {
        return res.json({ result: false, returnCode: '400', message: 'invalid payload' });
      }
      const order = tdb().prepare(
        'SELECT id, status, tracking_number, tracking_status, tracking_scenario_notified FROM retail_orders WHERE tracking_number = ? ORDER BY id DESC LIMIT 1'
      ).get(parsed.number);
      if (!order) {
        // kd100 expects 200 on receipt — otherwise they retry. Log and ack.
        console.warn('[kd100.callback] no order matches tracking_number=', parsed.number);
        return res.json({ result: true, returnCode: '200', message: 'no-op (no matching order)' });
      }
      // Verify salt — kd100 echoes the salt we set on subscribe, derived from
      // THIS tenant's secret (Roots → env secret, identical to before).
      const creds = getTenantCreds(tid).integrations.kd100;
      const expectedSalt = tracking.kd100Salt(order.id, parsed.number, creds);
      let body;
      try { body = JSON.parse(req.body.param); } catch { body = {}; }
      const gotSalt = body?.salt || body?.parameters?.salt || null;
      if (gotSalt && gotSalt !== expectedSalt) {
        console.warn('[kd100.callback] salt mismatch order=', order.id, 'got=', gotSalt);
        return res.status(403).json({ result: false, returnCode: '403', message: 'bad salt' });
      }
      // Classify the latest event's Chinese context into a typed
      // delivery scenario (pickup_point / locker / left_at_door /
      // in_person / proxy / no_contact / out_for_delivery). The mini app
      // renders a banner from this; we push a notification when the
      // scenario changes from the last one we notified for.
      const latestEvent = parsed.events?.[0];
      const scenario = latestEvent ? tracking.classifyDeliveryEvent(latestEvent.description_cn) : null;
      const scenarioCode = scenario?.scenario || null;
      const scenarioJson = scenario ? JSON.stringify(scenario) : null;

      tdb().prepare(
        `UPDATE retail_orders
            SET tracking_status            = ?,
                tracking_events_json       = ?,
                tracking_scenario          = ?,
                tracking_scenario_data_json = ?,
                tracking_synced_at         = CURRENT_TIMESTAMP,
                updated_at                 = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(parsed.state_code, JSON.stringify(parsed.events), scenarioCode, scenarioJson, order.id);
      console.log(`[kd100.callback] tenant=${tid} order=${order.id} number=${parsed.number} state=${parsed.state_code} scenario=${scenarioCode || '-'} events=${parsed.events.length}`);

      // Fire a push notification when the scenario changes to one the
      // customer should know about. Suppresses repeats so a duplicate
      // kd100 push (same scenario) doesn't double-notify.
      if (scenario && scenarioCode !== order.tracking_scenario_notified) {
        notifyTrackingScenario(order.id, scenario);
        tdb().prepare("UPDATE retail_orders SET tracking_scenario_notified = ? WHERE id = ?").run(scenarioCode, order.id);
      }

      // If delivered and the order is still 'dispatched', auto-flip to
      // 'delivered'. This mirrors what staff would do manually and
      // unlocks the review prompt for the customer.
      if (parsed.delivered && order.status === 'dispatched') {
        try {
          tdb().prepare(
            "UPDATE retail_orders SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'dispatched'"
          ).run(order.id);
          notifyOrderStatusChange(order.id, 'delivered');
        } catch (e) { console.error('[kd100.callback] auto-deliver failed:', e); }
      }
      return res.json({ result: true, returnCode: '200', message: 'ok' });
    } catch (e) {
      console.error('[kd100.callback] threw:', e);
      return res.status(500).json({ result: false, returnCode: '500', message: e.message });
    }
  });
}
// Roots keeps the legacy unsuffixed path (env creds, mainDb). Tenants POST to
// /callback/:tid — the id is validated against the active tenants table.
router.post(
  '/api/retail/tracking/kd100/callback',
  express.urlencoded({ extended: false, limit: '256kb' }),
  (req, res) => handleKd100Callback(req, res, ROOTS_TENANT_ID)
);
router.post(
  '/api/retail/tracking/kd100/callback/:tid',
  express.urlencoded({ extended: false, limit: '256kb' }),
  (req, res) => {
    const tid = resolveCallbackTid(req.params.tid);
    if (!tid) return res.status(404).json({ result: false, returnCode: '404', message: 'unknown_tenant' });
    handleKd100Callback(req, res, tid);
  }
);

// Bulk-attach tracking numbers. Body: { entries: [{order_no, tracking_number, carrier}] }.
// Auto-transitions paid/preparing → dispatched since attaching a waybill
// implies the order just shipped. Per-row error reporting; the request
// never aborts midway, so a typo on row 3 doesn't lose rows 1-2.
router.post('/api/retail-admin/orders/bulk-tracking', requireRetailAdmin, express.json(), (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
  if (!entries.length) return res.status(400).json({ success: false, error: 'no_entries' });
  if (entries.length > 200) return res.status(400).json({ success: false, error: 'too_many' });

  const results = [];
  const subscribeQueue = [];   // { orderId, carrier, number, phone } — fired after the response.
  const kc = kd100Creds();    // this tenant's own kd100 account (captured in-scope)

  for (const e of entries) {
    const orderNo = String(e.order_no || '').trim();
    const number  = String(e.tracking_number || '').trim();
    const carrier = String(e.carrier || 'jd').trim().toLowerCase();

    if (!orderNo || !number) {
      results.push({ order_no: orderNo, ok: false, error: 'missing_fields' });
      continue;
    }
    if (!tracking.carrierByCode(carrier)) {
      results.push({ order_no: orderNo, ok: false, error: 'invalid_carrier' });
      continue;
    }
    if (number.length > 64 || !/^[A-Za-z0-9\-]+$/.test(number)) {
      results.push({ order_no: orderNo, ok: false, error: 'invalid_number' });
      continue;
    }

    const o = tdb().prepare('SELECT id, status, recipient_phone FROM retail_orders WHERE order_no = ?').get(orderNo);
    if (!o) {
      results.push({ order_no: orderNo, ok: false, error: 'order_not_found' });
      continue;
    }

    // Promote paid/preparing → dispatched so the act of pasting a
    // waybill = "I shipped this". Skip if already dispatched/delivered;
    // bail with a clear error on any earlier state.
    let autoDispatched = false;
    if (o.status === 'paid' || o.status === 'preparing') {
      tdb().prepare("UPDATE retail_orders SET status = 'dispatched', dispatched_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('paid','preparing')").run(o.id);
      autoDispatched = true;
    } else if (o.status !== 'dispatched' && o.status !== 'delivered') {
      results.push({ order_no: orderNo, ok: false, error: 'wrong_status:' + o.status });
      continue;
    }

    tdb().prepare(
      `UPDATE retail_orders
          SET tracking_carrier = ?, tracking_number = ?,
              tracking_status = ?,
              tracking_events_json = NULL,
              tracking_synced_at = CURRENT_TIMESTAMP,
              tracking_last_error = NULL,
              tracking_kd100_subscribed = 0,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(carrier, number, tracking.deriveStatusFromOrder('dispatched'), o.id);

    logActivity(req.user.id, req.user.username, 'tracking_bulk_set', 'retail_order', o.id, { carrier, number }, req.ip);

    if (autoDispatched) {
      try { notifyOrderStatusChange(o.id, 'dispatched'); } catch (e) { /* best-effort */ }
    }

    if (tracking.kd100Enabled(kc) && tracking.KD100_CARRIER_MAP[carrier]) {
      subscribeQueue.push({ orderId: o.id, carrier, number, phone: o.recipient_phone });
    }

    results.push({ order_no: orderNo, ok: true, order_id: o.id, auto_dispatched: autoDispatched });
  }

  // Fire all kd100 subscriptions after writing the response. They run
  // concurrently and each updates its own row when settled.
  res.json({ success: true, processed: entries.length, succeeded: results.filter(r => r.ok).length, results });
  for (const q of subscribeQueue) {
    tracking.subscribeWithKd100({
      orderId: q.orderId, carrierCode: q.carrier, trackingNumber: q.number, recipientPhone: q.phone,
    }, kc).then(r => {
      if (r.ok) {
        tdb().prepare("UPDATE retail_orders SET tracking_kd100_subscribed = 1, tracking_last_error = NULL WHERE id = ?").run(q.orderId);
      } else {
        tdb().prepare("UPDATE retail_orders SET tracking_kd100_subscribed = 0, tracking_last_error = ? WHERE id = ?").run(r.error, q.orderId);
      }
    }).catch(e => {
      tdb().prepare("UPDATE retail_orders SET tracking_last_error = ? WHERE id = ?").run('subscribe_threw: ' + e.message, q.orderId);
    });
  }
});

// Retry a failed kd100 subscription from the admin tracking card.
router.post('/api/retail-admin/orders/:id/tracking/resubscribe', requireRetailAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const shipmentIdReq = req.query.shipment_id ? parseInt(req.query.shipment_id, 10) : null;
  const o = tdb().prepare('SELECT id, recipient_phone FROM retail_orders WHERE id = ?').get(id);
  if (!o) return res.status(404).json({ success: false, error: 'not_found' });
  const kc = kd100Creds();
  if (!tracking.kd100Enabled(kc)) return res.status(409).json({ success: false, error: 'kd100_not_configured' });
  const shipments = ensureShipments(id);
  const s = shipmentIdReq
    ? shipments.find(x => x.id === shipmentIdReq)
    : shipments.find(x => x.tracking_number) || shipments[0];
  if (!s || !s.tracking_number) return res.status(404).json({ success: false, error: 'no_tracking' });
  const r = await tracking.subscribeWithKd100({
    orderId: id, carrierCode: s.tracking_carrier, trackingNumber: s.tracking_number,
    recipientPhone: o.recipient_phone,
  }, kc);
  if (r.ok) {
    tdb().prepare("UPDATE retail_shipments SET tracking_kd100_subscribed = 1, tracking_last_error = NULL WHERE id = ?").run(s.id);
    if (s.id === shipments[0].id) {
      tdb().prepare("UPDATE retail_orders SET tracking_kd100_subscribed = 1, tracking_last_error = NULL WHERE id = ?").run(id);
    }
  } else {
    tdb().prepare("UPDATE retail_shipments SET tracking_kd100_subscribed = 0, tracking_last_error = ? WHERE id = ?").run(r.error, s.id);
  }
  res.json({ success: r.ok, error: r.error });
});

router.delete('/api/retail-admin/orders/:id/tracking', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const shipmentIdReq = req.query.shipment_id ? parseInt(req.query.shipment_id, 10) : null;
  const o = tdb().prepare('SELECT id FROM retail_orders WHERE id = ?').get(id);
  if (!o) return res.status(404).json({ success: false, error: 'not_found' });
  const shipments = ensureShipments(id);
  const s = shipmentIdReq
    ? shipments.find(x => x.id === shipmentIdReq)
    : shipments[0];
  if (!s) return res.status(400).json({ success: false, error: 'invalid_shipment_id' });
  tdb().prepare(
    `UPDATE retail_shipments
        SET tracking_carrier = NULL, tracking_number = NULL,
            tracking_status = NULL, tracking_events_json = NULL,
            tracking_synced_at = NULL, tracking_last_error = NULL,
            tracking_kd100_subscribed = 0,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(s.id);
  // Mirror clear to legacy fields only when clearing the primary shipment.
  if (s.id === shipments[0].id) {
    tdb().prepare(
      `UPDATE retail_orders
          SET tracking_carrier = NULL, tracking_number = NULL,
              tracking_status = NULL, tracking_events_json = NULL,
              tracking_synced_at = NULL, tracking_last_error = NULL,
              tracking_kd100_subscribed = 0,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(id);
  }
  logActivity(req.user.id, req.user.username, 'tracking_clear', 'retail_order', id, { shipment_id: s.id }, req.ip);
  res.json({ success: true });
});

// Status transitions. Allowed steps and the timestamp column they touch.
// Stays explicit so accidental sql-injection-style status values can't slip in.
const STATUS_TRANSITIONS = {
  paid:       { col: 'paid_at',       prev: ['pending_payment'] },
  preparing:  { col: 'preparing_at',  prev: ['paid'] },
  dispatched: { col: 'dispatched_at', prev: ['preparing', 'paid'] },
  delivered:  { col: 'delivered_at',  prev: ['dispatched'] },
  cancelled:  { col: 'cancelled_at',  prev: ['pending_payment', 'paid', 'preparing'] },
  refunded:   { col: null,            prev: ['paid', 'preparing', 'dispatched', 'delivered'] },
};

router.patch('/api/retail-admin/orders/:id/status', requireRetailAdmin, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status, reason, staff_note } = req.body || {};
  const def = STATUS_TRANSITIONS[status];
  if (!def) return res.status(400).json({ success: false, error: 'invalid_status' });

  const o = tdb().prepare('SELECT id, status FROM retail_orders WHERE id = ?').get(id);
  if (!o) return res.status(404).json({ success: false, error: 'not_found' });
  if (!def.prev.includes(o.status)) {
    return res.status(409).json({ success: false, error: 'invalid_transition', from: o.status, to: status });
  }

  // Refund the customer for real when a paid order is REFUNDED or CANCELLED,
  // so money goes back no matter which control the operator uses (refund
  // button, status chip, or "Cancel" on a paid order). Done BEFORE any DB
  // write: if WeChat rejects we abort, so an order is never marked
  // refunded/cancelled while the money is still held. A cancel from
  // pending_payment took no money, so it's skipped.
  let wechatRefundRef = null;
  const isPaidRefundEvent =
    status === 'refunded' ||
    (status === 'cancelled' && o.status !== 'pending_payment');
  if (isPaidRefundEvent && !payContext().devMode) {
    const already = tdb().prepare('SELECT refund_status FROM retail_orders WHERE id = ?').get(id)?.refund_status;
    // An order that already went through the explicit refund workflow
    // (approved / paying / paid) must NOT be force-refunded at full total via
    // this status shortcut — that would ignore a smaller approved amount and/or
    // double-refund. Route the operator to the auditable payout flow instead.
    if (['approved', 'paying', 'paid'].includes(already)) {
      return res.status(409).json({
        success: false, error: 'use_refund_payout', refund_status: already,
        message: 'This order already has an approved or paid refund — use the refund payout action.',
      });
    }
    const pay = tdb().prepare(
      "SELECT out_trade_no, amount FROM retail_payments WHERE order_id = ? AND status IN ('success','refunded') ORDER BY id DESC LIMIT 1"
    ).get(id);
    if (pay?.out_trade_no) {
      // Atomically claim the refund (→ 'paying') so a double-click or a second
      // operator can't each fire a real WeChat refund. Only the request that
      // wins this transition proceeds; on failure we revert to the prior state.
      const claim = tdb().prepare(
        "UPDATE retail_orders SET refund_status = 'paying' WHERE id = ? AND COALESCE(refund_status, '') NOT IN ('approved', 'paying', 'paid')"
      ).run(id);
      if (claim.changes !== 1) {
        return res.status(409).json({ success: false, error: 'refund_already_processing' });
      }
      const fullTotal   = +(tdb().prepare('SELECT total FROM retail_orders WHERE id = ?').get(id)?.total || 0);
      const totalCents  = Math.round(Number(pay.amount != null ? pay.amount : fullTotal) * 100);
      const refundCents = Math.round(fullTotal * 100);
      const outRefundNo = ('RF' + pay.out_trade_no + Date.now().toString().slice(-6)).slice(0, 63);
      try {
        const r = await wechatPayRefund({ outTradeNo: pay.out_trade_no, outRefundNo, refundCents, totalCents, reason: reason || ((status === 'cancelled' ? 'Cancelled order ' : 'Refund order ') + id) });
        if (r.status === 'ABNORMAL') {
          tdb().prepare("UPDATE retail_orders SET refund_status = ? WHERE id = ? AND refund_status = 'paying'").run(already ?? null, id);
          return res.status(502).json({ success: false, error: 'wechat_refund_abnormal', message: 'WeChat returned ABNORMAL (often insufficient merchant balance) — check the merchant platform.' });
        }
        wechatRefundRef = r.refund_id + (r.status ? ' (' + r.status + ')' : '');
      } catch (e) {
        console.error('[wechat-refund]', e);
        tdb().prepare("UPDATE retail_orders SET refund_status = ? WHERE id = ? AND refund_status = 'paying'").run(already ?? null, id);
        return res.status(502).json({ success: false, error: e.code || 'wechat_refund_failed', message: e.message });
      }
    }
  }

  const sets = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
  const params = [status];
  if (def.col) { sets.push(`${def.col} = CURRENT_TIMESTAMP`); }
  if (status === 'cancelled' && reason) { sets.push('cancelled_reason = ?'); params.push(reason); }
  if (staff_note != null) { sets.push('staff_note = ?'); params.push(staff_note); }
  // The status shortcut completes the refund in one shot (money moved above,
  // paid amount + 'paid' event recorded below), so mark it 'paid' — NOT
  // 'approved', which would leave it re-payable via /refund/payout (double
  // refund). The 'approved'/'paying'/'paid' guard above already blocked orders
  // mid-workflow, so reaching here means this is the terminal refund.
  if (status === 'refunded') {
    sets.push("refund_status = 'paid'");
  }
  params.push(id);
  tdb().prepare(`UPDATE retail_orders SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  logActivity(req.user.id, req.user.username, 'status_change', 'retail_order', id, { from: o.status, to: status, reason }, req.ip);

  // Points side-effects of the transition. Both helpers are idempotent.
  if (status === 'paid') {
    try { awardOrderPoints(id); } catch (e) { console.error('[awardOrderPoints]', e); }
    // Admin-side flip to 'paid' commits the soft-reservations into a real
    // physical stock deduction. markOrderPaid() handles this too, but the
    // admin path bypasses it.
    try { inventory.commitOrderReservations(id, { actorUserId: req.user.id }); }
    catch (e) { console.error('[inventory.commit (admin)]', e); }
    try { creditReferralReward(id); } catch (e) { console.error('[creditReferralReward]', e); }
  }
  // Stock side-effects of cancel / refund. cancelled before payment just
  // releases the active reservation; refund of a paid order reverses
  // committed stock back into the available pool.
  if (status === 'cancelled') {
    if (o.status === 'pending_payment') {
      try { inventory.releaseOrderReservations(id, { reason: 'admin_cancelled' }); }
      catch (e) { console.error('[inventory.release (admin)]', e); }
    } else {
      try { inventory.reverseCommittedOrder(id, { actorUserId: req.user.id, note: reason || null }); }
      catch (e) { console.error('[inventory.reverse (cancel)]', e); }
    }
    // Cancelling a paid order issues a full refund — record the payout +
    // reverse points/redeem so the cancelled order reflects the money returned.
    if (wechatRefundRef) {
      try {
        const fullTotal = +(tdb().prepare('SELECT total FROM retail_orders WHERE id = ?').get(id)?.total || 0);
        tdb().prepare(
          `UPDATE retail_orders
              SET refund_status = 'paid',
                  refund_amount_approved = COALESCE(refund_amount_approved, ?),
                  refund_amount_paid     = COALESCE(refund_amount_paid,     ?),
                  refund_approved_at     = COALESCE(refund_approved_at, CURRENT_TIMESTAMP),
                  refund_paid_at         = COALESCE(refund_paid_at,     CURRENT_TIMESTAMP),
                  refund_payout_method   = 'wechat',
                  refund_payout_ref      = ?,
                  refund_payer_id        = COALESCE(refund_payer_id, ?)
            WHERE id = ?`
        ).run(fullTotal, fullTotal, wechatRefundRef, req.user.id, id);
        tdb().prepare("UPDATE retail_payments SET refunded_amount = amount, status = 'refunded' WHERE order_id = ? AND status = 'success'").run(id);
        logRefundEvent({ orderId: id, event: 'paid', amount: fullTotal, note: 'auto-refund on cancel', userId: req.user.id, meta: { method: 'wechat', reference: wechatRefundRef } });
        try { reverseOrderPoints(id); } catch (e) { console.error('[reverseOrderPoints cancel]', e); }
        try { reverseOrderRedeem(id); } catch (e) { console.error('[reverseOrderRedeem cancel]', e); }
      } catch (e) { console.error('[cancel refund bookkeeping]', e); }
    }
  }
  if (status === 'refunded') {
    // Fast-forward all the way through approve + paid in one shot — legacy
    // path. New flows should use POST /refund/approve + /refund/payout for
    // explicit, auditable steps.
    const fullTotal = +(tdb().prepare('SELECT total FROM retail_orders WHERE id = ?').get(id)?.total || 0);
    tdb().prepare(
      `UPDATE retail_orders
          SET refund_amount_approved = COALESCE(refund_amount_approved, ?),
              refund_amount_paid     = COALESCE(refund_amount_paid,     ?),
              refund_approved_at     = COALESCE(refund_approved_at, CURRENT_TIMESTAMP),
              refund_paid_at         = COALESCE(refund_paid_at,     CURRENT_TIMESTAMP),
              refund_reviewer_id     = COALESCE(refund_reviewer_id, ?),
              refund_payer_id        = COALESCE(refund_payer_id,    ?)
        WHERE id = ?`
    ).run(fullTotal, fullTotal, req.user.id, req.user.id, id);
    logRefundEvent({ orderId: id, event: 'approved', amount: fullTotal, note: reason || null, userId: req.user.id });
    logRefundEvent({ orderId: id, event: 'paid',     amount: fullTotal, note: 'legacy status-transition shortcut', userId: req.user.id });
    try { reverseOrderPoints(id); } catch (e) { console.error('[reverseOrderPoints]', e); }
    try { reverseOrderRedeem(id); } catch (e) { console.error('[reverseOrderRedeem]', e); }
    try { inventory.reverseCommittedOrder(id, { actorUserId: req.user.id, note: reason || null }); }
    catch (e) { console.error('[inventory.reverse (refund)]', e); }
    // Mirror onto retail_payments for the audit trail.
    try {
      tdb().prepare(
        `UPDATE retail_payments SET refunded_amount = amount, status = 'refunded' WHERE order_id = ? AND status = 'success'`
      ).run(id);
    } catch (e) { console.error('[retail_payments refund-mirror]', e); }
    // Stamp the real WeChat refund reference when the quick-refund path
    // actually moved money (wechatRefundRef set above).
    if (wechatRefundRef) {
      try { tdb().prepare("UPDATE retail_orders SET refund_payout_method = 'wechat', refund_payout_ref = ? WHERE id = ?").run(wechatRefundRef, id); }
      catch (e) { console.error('[refund ref]', e); }
    }
  }

  // Fire a subscribe-message notification (no-op in DEV, real send in PROD).
  // Doesn't block the response — push is best-effort.
  notifyOrderStatusChange(id, status);

  res.json({ success: true, data: tdb().prepare('SELECT * FROM retail_orders WHERE id = ?').get(id) });
});

// ─── Refund processing workflow ───────────────────────────────────────
// Workflow: requested → reviewing → approved → paid (or rejected / withdrawn)
//
// review:  acknowledge the request; gather info. Optional, but useful when
//          the customer needs to be contacted before deciding.
// approve: lock in an amount + (optional) line items. Reverses inventory
//          for line-itemized partials. Reverses points only on full refund.
//          Order.status flips to 'refunded' only on full refund.
// payout:  record that money actually moved back. Captures method + reference.
//          Mirrors retail_payments.refunded_amount.
// reject:  terminal. Customer sees the rejection note.
//
// Legacy POST /api/retail-admin/orders/:id/refund-reject kept as an alias
// for /refund/reject so existing UI code keeps working during rollout.

// List endpoint — populates the admin refund queue. status filter accepts
// 'open' (= requested+reviewing+approved, the actionable ones) or any
// single state. Defaults to 'open'.
router.get('/api/retail-admin/refunds', requireRetailAdmin, (req, res) => {
  const filter = (req.query.status || 'open').toString();
  const stateSets = {
    open:      ['pending', 'reviewing', 'approved'],
    actionable:['pending', 'reviewing'],
    pending:   ['pending'],
    requested: ['pending'],   // alias for the externally-shipped name
    reviewing: ['reviewing'],
    approved:  ['approved'],
    paying:    ['paying'],   // transient: claimed for payout, money in flight
    paid:      ['paid'],
    rejected:  ['rejected'],
    withdrawn: ['withdrawn'],
    all:       ['pending', 'reviewing', 'approved', 'paying', 'paid', 'rejected', 'withdrawn'],
  };
  const states = stateSets[filter] || stateSets.open;
  const placeholders = states.map(() => '?').join(',');
  const rows = tdb().prepare(
    `SELECT o.id, o.order_no, o.status, o.total, o.placed_at, o.delivered_at,
            o.refund_requested_at, o.refund_reviewed_at, o.refund_approved_at, o.refund_paid_at,
            o.refund_status, o.refund_reason, o.refund_review_note,
            o.refund_amount_requested, o.refund_amount_approved, o.refund_amount_paid,
            o.refund_lines_json, o.refund_payout_method, o.refund_payout_ref,
            o.customer_id,
            c.nickname AS customer_nickname, c.avatar_url AS customer_avatar, c.phone AS customer_phone
       FROM retail_orders o
       LEFT JOIN retail_customers c ON c.id = o.customer_id
      WHERE o.refund_status IN (${placeholders})
      ORDER BY
        CASE o.refund_status
          WHEN 'pending' THEN 1
          WHEN 'reviewing' THEN 2
          WHEN 'approved'  THEN 3
          ELSE 4
        END,
        o.refund_requested_at DESC`
  ).all(...states).map(r => {
    if (r.refund_lines_json) {
      try { r.refund_lines = JSON.parse(r.refund_lines_json); } catch { r.refund_lines = null; }
    }
    delete r.refund_lines_json;
    return r;
  });
  res.json({ success: true, data: rows });
});

// Step 1: REVIEW — acknowledge the request, mark we're looking at it.
router.post('/api/retail-admin/orders/:id/refund/review', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const note = (req.body?.note || '').slice(0, 500);
  const o = tdb().prepare('SELECT id, refund_status FROM retail_orders WHERE id = ?').get(id);
  if (!o) return res.status(404).json({ success: false, error: 'not_found' });
  if (!['pending', 'reviewing'].includes(o.refund_status)) {
    return res.status(409).json({ success: false, error: 'not_reviewable', refund_status: o.refund_status });
  }
  tdb().prepare(
    `UPDATE retail_orders
        SET refund_status = 'reviewing',
            refund_reviewed_at = COALESCE(refund_reviewed_at, CURRENT_TIMESTAMP),
            refund_reviewer_id = COALESCE(refund_reviewer_id, ?),
            refund_review_note = COALESCE(NULLIF(?, ''), refund_review_note),
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(req.user.id, note, id);
  logRefundEvent({ orderId: id, event: 'reviewing', note: note || null, userId: req.user.id });
  logActivity(req.user.id, req.user.username, 'refund_review', 'retail_order', id, { note }, req.ip);
  res.json({ success: true });
});

// Step 2: APPROVE — lock in amount + lines. Reverses inventory for
// itemized partials and full refunds. Reverses points only on full refund.
// Order.status flips to 'refunded' only on full refund.
// body: { amount?, lines?, note?, reverse_points? }
//   amount: overrides customer's requested amount (staff may approve less)
//   lines:  [{item_id, qty}] overrides for itemized partial
//   reverse_points: explicit override; default = full-refund? then true
router.post('/api/retail-admin/orders/:id/refund/approve', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const o = tdb().prepare(
    'SELECT id, status, total, refund_status, refund_amount_requested, refund_lines_json FROM retail_orders WHERE id = ?'
  ).get(id);
  if (!o) return res.status(404).json({ success: false, error: 'not_found' });
  if (!['pending', 'reviewing'].includes(o.refund_status)) {
    return res.status(409).json({ success: false, error: 'not_approvable', refund_status: o.refund_status });
  }
  const note = (req.body?.note || '').slice(0, 500);

  // Resolve final lines + amount. Staff-supplied wins, then customer's lines, then customer's amount, then full total.
  let lines = null;
  let amount = null;
  const norm = normalizeRefundLines(id, req.body?.lines);
  if (norm.lines) {
    lines = norm.lines;
    amount = norm.amount;
  } else if (req.body?.amount != null) {
    const a = Math.max(0, Math.min(Number(req.body.amount) || 0, Number(o.total) || 0));
    amount = a > 0 ? +a.toFixed(2) : null;
  } else if (o.refund_lines_json) {
    try {
      const customerLines = JSON.parse(o.refund_lines_json);
      // Customer's per-line spec is already normalized (server computed
      // amounts at request time). Re-normalize to be defensive.
      const renorm = normalizeRefundLines(id, customerLines.map(l => ({ item_id: l.item_id, qty: l.qty })));
      lines = renorm.lines;
      amount = renorm.amount;
    } catch {}
  } else if (o.refund_amount_requested != null) {
    amount = +Number(o.refund_amount_requested).toFixed(2);
  } else {
    amount = +Number(o.total).toFixed(2);
  }
  if (!(amount > 0)) return res.status(400).json({ success: false, error: 'invalid_amount' });

  const isFull = amount + 0.005 >= Number(o.total); // tolerance for ¥0.01 rounding
  const reversePoints = req.body?.reverse_points != null ? !!req.body.reverse_points : isFull;

  tdb().prepare(
    `UPDATE retail_orders
        SET refund_status = 'approved',
            refund_amount_approved = ?,
            refund_lines_json = ?,
            refund_review_note = COALESCE(NULLIF(?, ''), refund_review_note),
            refund_approved_at = CURRENT_TIMESTAMP,
            refund_reviewer_id = COALESCE(refund_reviewer_id, ?),
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(amount, lines ? JSON.stringify(lines) : null, note, req.user.id, id);

  // Side effects
  try {
    if (isFull) {
      inventory.reverseCommittedOrder(id, { actorUserId: req.user.id, note: 'refund approved (full)' });
    } else if (lines) {
      inventory.reverseCommittedLines(id, lines, { actorUserId: req.user.id, note: 'refund approved (partial lines)' });
    }
  } catch (e) { console.error('[inventory.reverse (approve)]', e); }
  if (reversePoints) {
    try { reverseOrderPoints(id); }  catch (e) { console.error('[reverseOrderPoints]', e); }
    try { reverseOrderRedeem(id); }  catch (e) { console.error('[reverseOrderRedeem]', e); }
  }
  // Full refund flips the order's main status too.
  if (isFull && o.status !== 'refunded' && o.status !== 'cancelled') {
    tdb().prepare("UPDATE retail_orders SET status = 'refunded' WHERE id = ?").run(id);
  }

  logRefundEvent({
    orderId: id, event: 'approved', amount, note: note || null, userId: req.user.id,
    meta: { is_full: isFull, lines, reverse_points: reversePoints },
  });
  logActivity(req.user.id, req.user.username, 'refund_approve', 'retail_order', id, { amount, is_full: isFull, lines }, req.ip);
  notifyOrderStatusChange(id, isFull ? 'refunded' : null);
  notifyForOrder(id, (o) => ({
    category: 'refund', type: 'refund_approved',
    title_en: 'Refund approved', title_cn: '退款已通过',
    body_en: `Your ¥${Number(amount).toFixed(2)} refund for order ${o.order_no} was approved`,
    body_cn: `订单 ${o.order_no} 的 ¥${Number(amount).toFixed(2)} 退款已通过`,
  }));
  res.json({ success: true, is_full: isFull, amount, lines });
});

// Step 3: PAYOUT — money has actually moved back. Records method + ref.
// body: { method, reference?, amount?, note? }
router.post('/api/retail-admin/orders/:id/refund/payout', requireRetailAdmin, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const o = tdb().prepare(
    'SELECT id, total, refund_status, refund_amount_approved FROM retail_orders WHERE id = ?'
  ).get(id);
  if (!o) return res.status(404).json({ success: false, error: 'not_found' });
  if (o.refund_status !== 'approved') {
    return res.status(409).json({ success: false, error: 'not_payable', refund_status: o.refund_status });
  }
  const method = (req.body?.method || '').toString().trim().toLowerCase();
  const allowedMethods = new Set(['wechat', 'alipay', 'bank', 'wallet', 'store_credit', 'cash', 'other']);
  if (!allowedMethods.has(method)) {
    return res.status(400).json({ success: false, error: 'invalid_method', allowed: [...allowedMethods] });
  }
  const reference = (req.body?.reference || '').slice(0, 200);
  const note = (req.body?.note || '').slice(0, 500);
  const amount = req.body?.amount != null
    ? Math.max(0, Math.min(Number(req.body.amount) || 0, Number(o.refund_amount_approved) || 0))
    : Number(o.refund_amount_approved) || 0;
  if (!(amount > 0)) return res.status(400).json({ success: false, error: 'invalid_amount' });

  // For a real WeChat refund we need the original transaction. Check it exists
  // BEFORE claiming the order so a missing txn never leaves it stuck in the
  // transient 'paying' state.
  let pay = null;
  if (method === 'wechat' && !payContext().devMode) {
    pay = tdb().prepare(
      "SELECT out_trade_no, amount FROM retail_payments WHERE order_id = ? AND status IN ('success','refunded') ORDER BY id DESC LIMIT 1"
    ).get(id);
    if (!pay?.out_trade_no) {
      return res.status(409).json({ success: false, error: 'no_wechat_transaction', message: 'No WeChat transaction on this order to refund against.' });
    }
  }

  // Atomically claim the approved → paying transition. THIS is the guard that
  // makes payout safe under a double-click or two operators acting at once:
  // only the request that flips 'approved' → 'paying' proceeds past here, so a
  // second real refund can never be issued. On any failure below we revert the
  // claim back to 'approved' so the payout can be retried.
  const claim = tdb().prepare(
    "UPDATE retail_orders SET refund_status = 'paying', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND refund_status = 'approved'"
  ).run(id);
  if (claim.changes !== 1) {
    const cur = tdb().prepare('SELECT refund_status FROM retail_orders WHERE id = ?').get(id)?.refund_status;
    return res.status(409).json({ success: false, error: 'not_payable', refund_status: cur });
  }

  // WeChat method → actually push the money back to the customer via the v3
  // refund API (real refund, original payment route). Other methods stay as
  // manual bookkeeping records. In DEV mode (no creds) this falls back to a
  // plain record too. A failed WeChat refund reverts the claim, so the order
  // returns to 'approved' and the operator sees it didn't go through.
  let payoutRef = reference;
  if (method === 'wechat' && !payContext().devMode) {
    const totalCents  = Math.round(Number(pay.amount != null ? pay.amount : o.total) * 100);
    const refundCents = Math.round(amount * 100);
    const outRefundNo = ('RF' + pay.out_trade_no + Date.now().toString().slice(-6)).slice(0, 63);
    try {
      const r = await wechatPayRefund({ outTradeNo: pay.out_trade_no, outRefundNo, refundCents, totalCents, reason: note || ('Refund order ' + id) });
      if (r.status === 'ABNORMAL') {
        tdb().prepare("UPDATE retail_orders SET refund_status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND refund_status = 'paying'").run(id);
        return res.status(502).json({ success: false, error: 'wechat_refund_abnormal', message: 'WeChat returned ABNORMAL (often insufficient merchant balance) — check the merchant platform.' });
      }
      payoutRef = r.refund_id + (r.status ? ' (' + r.status + ')' : '');
    } catch (e) {
      console.error('[wechat-refund]', e);
      tdb().prepare("UPDATE retail_orders SET refund_status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND refund_status = 'paying'").run(id);
      return res.status(502).json({ success: false, error: e.code || 'wechat_refund_failed', message: e.message });
    }
  }

  tdb().prepare(
    `UPDATE retail_orders
        SET refund_status = 'paid',
            refund_amount_paid = ?,
            refund_payout_method = ?,
            refund_payout_ref = ?,
            refund_paid_at = CURRENT_TIMESTAMP,
            refund_payer_id = ?,
            refund_review_note = COALESCE(NULLIF(?, ''), refund_review_note),
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND refund_status = 'paying'`
  ).run(amount, method, payoutRef || null, req.user.id, note, id);

  // Mirror onto retail_payments so reconciliation reports see it.
  try {
    tdb().prepare(
      `UPDATE retail_payments
          SET refunded_amount = MIN(amount, COALESCE(refunded_amount, 0) + ?),
              status = CASE WHEN amount <= COALESCE(refunded_amount, 0) + ? THEN 'refunded' ELSE status END
        WHERE order_id = ? AND status IN ('success', 'refunded')`
    ).run(amount, amount, id);
  } catch (e) { console.error('[retail_payments refund-mirror]', e); }

  logRefundEvent({
    orderId: id, event: 'paid', amount, note: note || null, userId: req.user.id,
    meta: { method, reference: reference || null },
  });
  logActivity(req.user.id, req.user.username, 'refund_payout', 'retail_order', id, { amount, method, reference }, req.ip);
  notifyOrderStatusChange(id, null);
  notifyForOrder(id, (o) => ({
    category: 'refund', type: 'refund_paid',
    title_en: 'Refund paid', title_cn: '退款已到账',
    body_en: `¥${Number(amount).toFixed(2)} has been refunded for order ${o.order_no}`,
    body_cn: `订单 ${o.order_no} 的 ¥${Number(amount).toFixed(2)} 退款已退回`,
  }));
  res.json({ success: true, amount, method, reference });
});

// REJECT — terminal. Customer sees the note. Works at requested OR reviewing.
function rejectRefundHandler(req, res) {
  const id = parseInt(req.params.id, 10);
  const note = (req.body?.note || '').slice(0, 500);
  const o = tdb().prepare('SELECT id, refund_status FROM retail_orders WHERE id = ?').get(id);
  if (!o) return res.status(404).json({ success: false, error: 'not_found' });
  if (!['pending', 'reviewing'].includes(o.refund_status)) {
    return res.status(409).json({ success: false, error: 'no_pending_request', refund_status: o.refund_status });
  }
  tdb().prepare(
    `UPDATE retail_orders
        SET refund_status = 'rejected',
            refund_review_note = ?,
            refund_reviewer_id = COALESCE(refund_reviewer_id, ?),
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(note || null, req.user.id, id);
  logRefundEvent({ orderId: id, event: 'rejected', note: note || null, userId: req.user.id });
  logActivity(req.user.id, req.user.username, 'refund_reject', 'retail_order', id, { note }, req.ip);
  notifyOrderStatusChange(id, null);
  notifyForOrder(id, (o) => ({
    category: 'refund', type: 'refund_rejected',
    title_en: 'Refund declined', title_cn: '退款未通过',
    body_en: `Your refund for order ${o.order_no} was declined` + (note ? `: ${note}` : ''),
    body_cn: `订单 ${o.order_no} 的退款申请未通过` + (note ? `:${note}` : ''),
  }));
  res.json({ success: true });
}
router.post('/api/retail-admin/orders/:id/refund/reject', requireRetailAdmin, express.json(), rejectRefundHandler);
// Back-compat alias for existing admin UI button:
router.post('/api/retail-admin/orders/:id/refund-reject', requireRetailAdmin, express.json(), rejectRefundHandler);

// Event log — show the audit trail for one order's refund history.
router.get('/api/retail-admin/orders/:id/refund/events', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const events = tdb().prepare(
    `SELECT e.id, e.event, e.amount, e.note, e.user_id, e.customer_id, e.meta_json, e.created_at,
            u.username AS user_username,
            c.nickname AS customer_nickname
       FROM retail_refund_events e
       LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN retail_customers c ON c.id = e.customer_id
      WHERE e.order_id = ?
      ORDER BY e.created_at ASC, e.id ASC`
  ).all(id).map(ev => {
    if (ev.meta_json) { try { ev.meta = JSON.parse(ev.meta_json); } catch { ev.meta = null; } }
    delete ev.meta_json;
    return ev;
  });
  res.json({ success: true, data: events });
});

// ═══════════════════════════════════════════════════════════════════════
// CMS — block-based home-layout editor (drag-drop visual composer)
// `home.layout`             = live, served to the mini app via /config
// `cms.draft.home_layout`   = draft being edited (admin-only)
// Save → writes draft. Publish → atomic copy draft → live.
// ═══════════════════════════════════════════════════════════════════════

const ALLOWED_BLOCK_TYPES = new Set([
  'announcement_bar', 'hero_banner', 'category_tabs',
  'featured_item', 'product_grid', 'spacer',
  // Generic countdown (manual ends_at) and the live flash-sale strip
  // (auto-binds to the next-ending active flash sale)
  'countdown_timer', 'flash_sale_strip',
  // Promo + trust blocks — completes the original 10-block spec
  'coupon_block', 'points_widget', 'review_card', 'store_info',
  // Voting teaser — links to /pages/voting/voting (polls managed in retail-admin → Voting)
  'voting_block',
  // Affiliate / refer-a-friend card with live invite code + share
  'affiliate_block',
  // Retention / personalization blocks
  'greeting',         // time-of-day "Good morning, {name} · pts"
  'kitchen_status',   // open / closed dot · hours · ETA
  'recipe_story',     // editorial image + serif headline + paragraphs + product
  'bundle',           // 3–5 products with one-tap add-all-to-cart
  // Add-us-on-WeCom card: <button open-type="contact"> + 联系我 QR fallback
  'wecom_contact',
  // Top members ranked by spend / points / orders — masked names, cached
  'leaderboard',
  // Autoplaying muted clip — in-page banner or full-screen onboarding splash
  'video_banner',
  // Live order tracker — customer's latest in-flight order; hides when none.
  // Data fetched client-side from /api/retail/orders.
  'order_tracker',
  // ── Deprecated types kept on the whitelist so existing drafts/layouts
  // still validate. The CMS palette hides them; clients ignore them.
  'wechat_oa',                        // replaced 2026-05-19 by wecom_contact
  'sticker_collage', 'progress_dots', // decorative gimmicks, removed 2026-05-30
]);

// CMS-editable pages. Each has its own `<page>.layout` (live) and
// `cms.draft.<page>_layout` (draft) entries in storefront_config. Add a
// new page by appending to this whitelist — no schema change needed.
// `about` is a hardcoded mini app page (/pages/about/about), not CMS-driven —
// brand identity, intentionally pinned in code.
const ALLOWED_PAGES = new Set(['home', 'promotions', 'membership', 'categories', 'onboarding']);

// Onboarding gating modes. See /api/retail/config surfacing above + the
// /onboarding-settings admin endpoints below.
const ONBOARDING_MODES = new Set(['new', 'version', 'always', 'off']);
function pageKey(req, fallback = 'home') {
  const p = String(req.query?.page || req.body?.page || fallback);
  return ALLOWED_PAGES.has(p) ? p : null;
}

// Upper bound on blocks per layout — well above any real page, but stops a
// pathological draft from bloating storefront_config / the /config response.
const MAX_BLOCKS = 60;
// Block layouts are stored verbatim and served to the mini app via /config,
// where several props (image_url, link, rich text) get rendered. A
// javascript:/vbscript:/data:text/html value in any prop is therefore a
// stored-XSS vector, so reject blocks that carry one anywhere in their tree.
const DANGEROUS_URL_RE = /(?:^|[\s"'`(])\s*(?:javascript|vbscript)\s*:|data\s*:\s*text\/html/i;
function blockHasDangerousString(val, depth = 0) {
  if (depth > 8) return true; // pathologically deep → treat as hostile
  if (typeof val === 'string') return DANGEROUS_URL_RE.test(val);
  if (Array.isArray(val)) return val.some(v => blockHasDangerousString(v, depth + 1));
  if (val && typeof val === 'object') return Object.values(val).some(v => blockHasDangerousString(v, depth + 1));
  return false;
}

function validateBlocks(blocks) {
  if (!Array.isArray(blocks)) return { error: 'blocks_not_array' };
  if (blocks.length > MAX_BLOCKS) return { error: 'too_many_blocks', details: { max: MAX_BLOCKS } };
  const ids = new Set();
  for (const b of blocks) {
    if (!b || typeof b !== 'object') return { error: 'block_not_object' };
    if (typeof b.id !== 'string' || !b.id) return { error: 'block_missing_id' };
    if (ids.has(b.id)) return { error: 'block_id_duplicate', details: { id: b.id } };
    ids.add(b.id);
    if (!ALLOWED_BLOCK_TYPES.has(b.type)) {
      return { error: 'block_type_invalid', details: { id: b.id, type: b.type } };
    }
    if (blockHasDangerousString(b)) {
      return { error: 'block_unsafe_value', details: { id: b.id } };
    }
  }
  return {};
}

function readLayout(key) {
  const row = tdb().prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
  if (!row) return [];
  try { const v = JSON.parse(row.value_json); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
// Per-call (not a module-level prepared statement) so it binds to the
// request's tenant connection via tdb(), not whatever db existed at load.
function writeLayout(key, json, by) {
  tdb().prepare(
    `INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
     VALUES (?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = CURRENT_TIMESTAMP,
       updated_by = excluded.updated_by`
  ).run(key, json, by);
}

// ── CMS preview tokens ──────────────────────────────────────────────────
// Short-lived bearer (string) tokens that gate the mini app's "preview
// the unpublished draft" mode. Minted only by /cms (staff-auth required),
// in-memory store, TTL 30 min. After expiry the mini app falls back to
// the published layouts on its next config.load(), so a leaked token
// can leak the current draft for at most half an hour.
const PREVIEW_TOKEN_TTL_MS = 30 * 60 * 1000;
const _previewTokens = new Map();    // token (string) → expires_at_ms

function mintPreviewToken() {
  // 8 hex chars = 32 bits. Fine for office-only use and fits inside the
  // wxacode scene-string 32-char budget alongside `dp=1&t=...&p=...`.
  const token = crypto.randomBytes(4).toString('hex');
  _previewTokens.set(token, Date.now() + PREVIEW_TOKEN_TTL_MS);
  // Opportunistic cleanup so the map doesn't grow unbounded.
  if (_previewTokens.size > 64) {
    const now = Date.now();
    for (const [k, exp] of _previewTokens) {
      if (exp < now) _previewTokens.delete(k);
    }
  }
  return token;
}

function validatePreviewToken(token) {
  if (!token || typeof token !== 'string') return false;
  const exp = _previewTokens.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { _previewTokens.delete(token); return false; }
  return true;
}

router.post('/api/retail-admin/cms/preview-token', requireRetailAdmin, (req, res) => {
  const token = mintPreviewToken();
  res.json({
    success: true,
    data: {
      token,
      expires_at: new Date(Date.now() + PREVIEW_TOKEN_TTL_MS).toISOString(),
      ttl_seconds: PREVIEW_TOKEN_TTL_MS / 1000,
    },
  });
});

// Admin: generate a mini-app QR (wxacode/getUnlimited) that boots the
// real mini program at pages/index/index with `dp=1&t=TOKEN&p=PAGE` in
// the scene. Mini-app reads the scene on launch and passes `preview_token`
// through to /api/retail/config so the draft layouts are returned.
// Falls back to 501 in DEV mode (no merchant cert / app secret); the /cms
// modal then just shows the DevTools custom-compile path instead.
router.get('/api/retail-admin/cms/preview-qr', requireRetailAdmin, async (req, res) => {
  if (getTenantCreds(currentTenantId()).wechat.devMode) {
    return res.status(501).json({ success: false, error: 'wechat_creds_not_configured' });
  }
  const page = (req.query.page || 'home').toString().slice(0, 32);
  const previewToken = mintPreviewToken();
  try {
    const token = await getWeChatAccessToken();
    if (!token) return res.status(503).json({ success: false, error: 'no_access_token' });
    const url = `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${token}`;
    const scene = `dp=1&t=${previewToken}&p=${page}`;       // ≤ 32 chars
    const body = {
      scene,
      // Home page in miniapp/app.json — was incorrectly 'pages/index/index'
      // (causing "page not found" when scanning). Mini-app on launch reads
      // the scene string and may route from here to the requested page.
      page:     'pages/home/home',
      check_path: false,
      env_version: 'trial',                 // 'release' once published
      width: 280,
    };
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const j = await resp.json();
      return res.status(502).json({ success: false, error: 'wxacode_failed', detail: j });
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Preview-Token', previewToken);   // for clients that want the token directly
    res.send(buf);
  } catch (e) {
    console.error('[cms/preview-qr]', e);
    res.status(500).json({ success: false, error: 'qr_failed', message: e.message });
  }
});

// Admin-only "config-with-drafts" endpoint. Mirrors /api/retail/config
// shape exactly, but swaps every `<page>.layout` for its `cms.draft.<page>_layout`
// when one exists. Powers the /storefront?draft=1 live mirror inside /cms:
// the same renderer can preview what the customer will see once we publish,
// without us forking the renderer or pre-committing the draft.
router.get('/api/retail-admin/storefront/preview-config', requireRetailAdmin, (req, res) => {
  const live = loadConfig();
  // Walk the allowed-pages list and overlay any existing draft.
  for (const page of ALLOWED_PAGES) {
    const draftRow = tdb().prepare(
      'SELECT value_json FROM storefront_config WHERE key = ?'
    ).get(`cms.draft.${page}_layout`);
    if (!draftRow) continue;
    let draft;
    try { draft = JSON.parse(draftRow.value_json); } catch { continue; }
    // The shape /api/retail/config emits for layout is `<page>.layout` nested
    // under the page bucket — e.g. `home.layout`, `promotions.layout`. Mirror
    // that structure when overlaying.
    if (!live[page] || typeof live[page] !== 'object') live[page] = {};
    live[page].layout = draft;
  }
  // Bump the version so the front-end cache-busts when the draft changes.
  // (loadConfig() returns version = max updated_at across the table; that
  // already moves whenever a draft is saved, so no extra work needed.)
  live._preview = true;
  res.json({ success: true, data: live });
});

// Single bootstrap call — gives the editor both versions + the dirty flag
// for the requested page. ?page=home|promotions|about (default home).
router.get('/api/retail-admin/cms/layout', requireRetailAdmin, express.json(), (req, res) => {
  const page = pageKey(req);
  if (!page) return res.status(400).json({ success: false, error: 'invalid_page' });
  const draft = readLayout(`cms.draft.${page}_layout`);
  const live  = readLayout(`${page}.layout`);
  res.json({
    success: true,
    data: {
      page,
      draft, live,
      dirty: JSON.stringify(draft) !== JSON.stringify(live),
      allowed_block_types: [...ALLOWED_BLOCK_TYPES],
      allowed_pages: [...ALLOWED_PAGES],
    },
  });
});

router.put('/api/retail-admin/cms/layout/draft', requireRetailAdmin, express.json({ limit: '2mb' }), (req, res) => {
  const page = pageKey(req);
  if (!page) return res.status(400).json({ success: false, error: 'invalid_page' });
  const blocks = req.body?.blocks;
  const v = validateBlocks(blocks);
  if (v.error) return res.status(400).json({ success: false, error: v.error, details: v.details });
  writeLayout(`cms.draft.${page}_layout`, JSON.stringify(blocks), req.user.id);
  res.json({ success: true, data: { page } });
});

router.post('/api/retail-admin/cms/publish', requireRetailAdmin, express.json(), (req, res) => {
  const page = pageKey(req);
  if (!page) return res.status(400).json({ success: false, error: 'invalid_page' });
  const draft = readLayout(`cms.draft.${page}_layout`);
  // Re-validate in case the draft was somehow written outside the editor
  const v = validateBlocks(draft);
  if (v.error) return res.status(400).json({ success: false, error: 'draft_invalid', details: v });
  writeLayout(`${page}.layout`, JSON.stringify(draft), req.user.id);
  logActivity(req.user.id, req.user.username, 'publish', `${page}_layout`, null, { blocks: draft.length, page }, req.ip);
  res.json({ success: true, data: { page, live: draft } });
});

// ── Onboarding gating settings ──────────────────────────────────────────
// Controls whether the mini app's first-launch onboarding page is shown,
// and to whom. show_to: 'new' (only first-time visitors — default),
// 'version' (re-shows on manual version bump), 'always' (every launch),
// 'off' (never auto-redirect; the Tour link on Me still reaches it).
// Stored as flat `onboarding.show_to` / `onboarding.version` keys in
// storefront_config — loadConfig() nests them into cfg.onboarding for
// the public /api/retail/config response.
// Footer button label defaults — mirror the mini-app fallback. Stored as
// nested JSON so the mini-app reads cfg.onboarding.next_label.{en,cn}.
const DEFAULT_ONBOARDING_LABELS = {
  next_label: { en: 'GET STARTED', cn: '开始' },
};

function readLabelKey(key, fallback) {
  const en = tdb().prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(`${key}.en`);
  const cn = tdb().prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(`${key}.cn`);
  const parse = (row, fb) => {
    if (!row) return fb;
    try { const v = JSON.parse(row.value_json); return typeof v === 'string' && v.trim() ? v : fb; }
    catch { return fb; }
  };
  return {
    en: parse(en, fallback.en),
    cn: parse(cn, fallback.cn),
  };
}

function readOnboardingSettings() {
  const showRow = tdb().prepare('SELECT value_json FROM storefront_config WHERE key = ?').get('onboarding.show_to');
  const verRow  = tdb().prepare('SELECT value_json FROM storefront_config WHERE key = ?').get('onboarding.version');
  let show_to = 'new';
  let version = 1;
  if (showRow) {
    try { const v = JSON.parse(showRow.value_json); if (ONBOARDING_MODES.has(v)) show_to = v; } catch {}
  }
  if (verRow) {
    try { const v = JSON.parse(verRow.value_json); if (Number.isFinite(v) && v >= 1) version = v; } catch {}
  }
  return {
    show_to, version,
    next_label: readLabelKey('onboarding.next_label', DEFAULT_ONBOARDING_LABELS.next_label),
  };
}

router.get('/api/retail-admin/cms/onboarding-settings', requireRetailAdmin, (req, res) => {
  res.json({ success: true, data: readOnboardingSettings() });
});

router.put('/api/retail-admin/cms/onboarding-settings', requireRetailAdmin, express.json(), (req, res) => {
  const body = req.body || {};
  // show_to is optional — only validate when present so the label-only save
  // path doesn't need to re-send the mode every time.
  if (body.show_to !== undefined) {
    if (!ONBOARDING_MODES.has(body.show_to)) {
      return res.status(400).json({ success: false, error: 'invalid_show_to' });
    }
    writeLayout('onboarding.show_to', JSON.stringify(body.show_to), req.user.id);
  }
  const node = body.next_label;
  if (node && typeof node === 'object') {
    for (const lang of ['en', 'cn']) {
      if (node[lang] === undefined) continue;
      const v = String(node[lang] || '').slice(0, 40).trim();
      // Blank value clears the row so the default reasserts; otherwise upsert.
      if (!v) {
        tdb().prepare('DELETE FROM storefront_config WHERE key = ?').run(`onboarding.next_label.${lang}`);
      } else {
        writeLayout(`onboarding.next_label.${lang}`, JSON.stringify(v), req.user.id);
      }
    }
  }
  res.json({ success: true, data: readOnboardingSettings() });
});

// Manual "Re-show to all returning users now" — bumps the version counter.
// The mini-app's stored `onboarded=<version>` flag no longer matches, so
// the next launch redirects everyone whose mode is 'version'.
router.post('/api/retail-admin/cms/onboarding-settings/bump', requireRetailAdmin, (req, res) => {
  const cur = readOnboardingSettings();
  const next = cur.version + 1;
  writeLayout('onboarding.version', JSON.stringify(next), req.user.id);
  logActivity(req.user.id, req.user.username, 'bump', 'onboarding_version', null, { from: cur.version, to: next }, req.ip);
  res.json({ success: true, data: { show_to: cur.show_to, version: next } });
});

// ── Media library ────────────────────────────────────────────────────────
// Public GET. Cached aggressively — once an image is uploaded its bytes
// don't change; if you re-upload, the editor stores a new id and updates
// the block reference, so cache invalidation is a non-issue.
router.get('/api/retail/media/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = tdb().prepare('SELECT mime_type, data FROM retail_media WHERE id = ?').get(id);
  if (!row) return res.status(404).end();
  // data is "data:image/jpeg;base64,..." — strip prefix and stream bytes
  const m = /^data:[^;]+;base64,(.+)$/.exec(row.data);
  if (!m) return res.status(500).end();
  // Never let the browser MIME-sniff our blob into something executable, and
  // only serve known-safe types inline. Anything else (legacy SVG, mislabeled
  // upload) is handed back as an opaque download so it can't run as a page.
  res.set('X-Content-Type-Options', 'nosniff');
  if (MEDIA_INLINE_MIME.has(row.mime_type)) {
    res.set('Content-Type', row.mime_type);
    res.set('Content-Disposition', 'inline');
  } else {
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment');
  }
  res.set('Cache-Control', 'public, max-age=2592000, immutable');  // 30d
  const buf = Buffer.from(m[1], 'base64');
  res.set('Accept-Ranges', 'bytes');
  // Honour HTTP Range — the WeChat <video> component issues range requests and
  // expects a 206 it can stream/seek against. Images never send Range, so they
  // keep the plain full-body path below.
  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [rawStart, rawEnd] = range.replace('bytes=', '').split('-');
    const start = rawStart ? parseInt(rawStart, 10) : 0;
    const end   = rawEnd   ? parseInt(rawEnd, 10)   : buf.length - 1;
    if (start <= end && start < buf.length) {
      const slice = buf.slice(start, end + 1);
      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${buf.length}`);
      res.set('Content-Length', String(slice.length));
      return res.end(slice);
    }
  }
  res.set('Content-Length', String(buf.length));
  res.end(buf);
});

// List for the picker UI. Lightweight — no `data` column so the response
// stays small even with many uploads.
router.get('/api/retail-admin/cms/media', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(
    `SELECT id, filename, mime_type, size_bytes, width, height, uploaded_at
       FROM retail_media ORDER BY uploaded_at DESC LIMIT 200`
  ).all();
  res.json({ success: true, data: rows });
});

router.post('/api/retail-admin/cms/media', requireRetailAdmin, (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) {
      const code = err.message === 'not_an_image' ? 'not_an_image'
                 : err.code === 'LIMIT_FILE_SIZE' ? 'too_large'
                 : 'upload_failed';
      return res.status(400).json({ success: false, error: code });
    }
    if (!req.file) return res.status(400).json({ success: false, error: 'no_file' });
    // Sniff real bytes — reject SVG / non-raster, pin mime to the sniffed type.
    const sniffed = sniffImageMime(req.file.buffer);
    if (!sniffed) return res.status(400).json({ success: false, error: 'not_an_image' });
    const dataUri = `data:${sniffed};base64,${req.file.buffer.toString('base64')}`;
    const info = tdb().prepare(
      `INSERT INTO retail_media (filename, mime_type, size_bytes, data, uploaded_by)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      req.file.originalname || null,
      sniffed,
      req.file.size,
      dataUri,
      req.user.id
    );
    res.json({
      success: true,
      data: {
        id: info.lastInsertRowid,
        url: `/api/retail/media/${info.lastInsertRowid}`,
        filename: req.file.originalname,
        mime_type: sniffed,
        size_bytes: req.file.size,
      },
    });
  });
});

// Video upload for the CMS video_banner block. Same retail_media blob store as
// images, but routed through the larger-cap `uploadVideo` and pinned to MP4
// (the only container the WeChat <video> component plays). Served back via the
// shared /api/retail/media/:id route, which now answers Range requests.
router.post('/api/retail-admin/cms/media/video', requireRetailAdmin, (req, res) => {
  uploadVideo.single('file')(req, res, err => {
    if (err) {
      const code = err.message === 'not_a_video' ? 'not_a_video'
                 : err.code === 'LIMIT_FILE_SIZE' ? 'too_large'
                 : 'upload_failed';
      return res.status(400).json({ success: false, error: code });
    }
    if (!req.file) return res.status(400).json({ success: false, error: 'no_file' });
    const sniffed = sniffVideoMime(req.file.buffer);
    if (!sniffed) return res.status(400).json({ success: false, error: 'not_a_video' });
    const dataUri = `data:${sniffed};base64,${req.file.buffer.toString('base64')}`;
    const info = tdb().prepare(
      `INSERT INTO retail_media (filename, mime_type, size_bytes, data, uploaded_by)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      req.file.originalname || null,
      sniffed,
      req.file.size,
      dataUri,
      req.user.id
    );
    res.json({
      success: true,
      data: {
        id: info.lastInsertRowid,
        url: `/api/retail/media/${info.lastInsertRowid}`,
        filename: req.file.originalname,
        mime_type: sniffed,
        size_bytes: req.file.size,
      },
    });
  });
});

router.delete('/api/retail-admin/cms/media/:id', requireRetailAdmin, (req, res) => {
  const r = tdb().prepare('DELETE FROM retail_media WHERE id = ?').run(parseInt(req.params.id, 10));
  if (r.changes === 0) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true });
});

// ── Full media library API — used by /retail-admin → Media tab ──────────
// Same `retail_media` table as the CMS picker, but exposes filtering,
// tags, alt text, usage scan, and bulk ops.

function parseTags(v) {
  if (!v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.map(s => String(s).trim().toLowerCase()).filter(Boolean) : []; }
  catch { return []; }
}
function normalizeTagList(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const t of arr) {
    const k = String(t || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    if (k && !seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out.slice(0, 20);
}

router.get('/api/retail-admin/media/list', requireRetailAdmin, (req, res) => {
  const q   = (req.query.q || '').toString().trim().toLowerCase();
  const tag = (req.query.tag || '').toString().trim().toLowerCase();
  const mime= (req.query.mime || '').toString().trim().toLowerCase();   // "image", "image/png", ""
  const folder = (req.query.folder || '').toString().trim();            // "" = all, "unsorted" = NULL, "<id>" = that folder
  const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 60, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const where = []; const params = [];
  if (q)    { where.push("(LOWER(COALESCE(filename,'')) LIKE ? OR LOWER(COALESCE(alt_text,'')) LIKE ?)"); params.push('%'+q+'%','%'+q+'%'); }
  if (tag)  { where.push("EXISTS (SELECT 1 FROM json_each(COALESCE(tags,'[]')) je WHERE je.value = ?)"); params.push(tag); }
  if (mime) { where.push("LOWER(mime_type) LIKE ?"); params.push(mime.includes('/') ? mime : mime+'/%'); }
  if (folder === 'unsorted') { where.push('folder_id IS NULL'); }
  else if (folder && /^\d+$/.test(folder)) { where.push('folder_id = ?'); params.push(parseInt(folder, 10)); }

  const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = tdb().prepare(`SELECT COUNT(*) AS n FROM retail_media ${sqlWhere}`).get(...params).n;
  const rows = tdb().prepare(
    `SELECT id, filename, mime_type, size_bytes, width, height, alt_text, tags, folder_id, uploaded_at, uploaded_by
       FROM retail_media ${sqlWhere}
       ORDER BY uploaded_at DESC, id DESC
       LIMIT ? OFFSET ?`
  ).all(...params, limit, offset).map(r => ({ ...r, tags: parseTags(r.tags) }));
  res.json({ success: true, data: { rows, total, limit, offset } });
});

// ── Folders ─────────────────────────────────────────────────────────
router.get('/api/retail-admin/media/folders', requireRetailAdmin, (req, res) => {
  const folders = tdb().prepare(
    `SELECT f.id, f.name, f.parent_id, f.sort_order,
            (SELECT COUNT(*) FROM retail_media m WHERE m.folder_id = f.id) AS count
       FROM retail_media_folders f
       ORDER BY f.sort_order ASC, LOWER(f.name) ASC, f.id ASC`
  ).all();
  const unsorted = tdb().prepare('SELECT COUNT(*) AS n FROM retail_media WHERE folder_id IS NULL').get().n;
  const total    = tdb().prepare('SELECT COUNT(*) AS n FROM retail_media').get().n;
  res.json({ success: true, data: { folders, unsorted_count: unsorted, total_count: total } });
});

router.post('/api/retail-admin/media/folders', requireRetailAdmin, express.json(), (req, res) => {
  const name = (req.body?.name || '').toString().trim().slice(0, 80);
  if (!name) return res.status(400).json({ success: false, error: 'name_required' });
  const parent_id = req.body?.parent_id ? parseInt(req.body.parent_id, 10) : null;
  if (parent_id != null) {
    const ok = tdb().prepare('SELECT 1 FROM retail_media_folders WHERE id = ?').get(parent_id);
    if (!ok) return res.status(400).json({ success: false, error: 'parent_not_found' });
  }
  const info = tdb().prepare(
    `INSERT INTO retail_media_folders (name, parent_id) VALUES (?, ?)`
  ).run(name, parent_id);
  res.json({ success: true, data: { id: info.lastInsertRowid } });
});

router.patch('/api/retail-admin/media/folders/:id', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sets = [], params = [];
  if ('name' in (req.body || {})) {
    const n = (req.body.name || '').toString().trim().slice(0, 80);
    if (!n) return res.status(400).json({ success: false, error: 'name_required' });
    sets.push('name = ?'); params.push(n);
  }
  if ('parent_id' in (req.body || {})) {
    const p = req.body.parent_id == null ? null : parseInt(req.body.parent_id, 10);
    if (p === id) return res.status(400).json({ success: false, error: 'self_parent' });
    sets.push('parent_id = ?'); params.push(p);
  }
  if ('sort_order' in (req.body || {})) {
    sets.push('sort_order = ?'); params.push(Number(req.body.sort_order) || 0);
  }
  if (!sets.length) return res.status(400).json({ success: false, error: 'no_fields' });
  sets.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  const r = tdb().prepare(`UPDATE retail_media_folders SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (r.changes === 0) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true });
});

// Deleting a folder unsorts its media (folder_id → NULL) — never deletes
// images. Nested children become top-level (parent_id → NULL via ON DELETE
// SET NULL).
router.delete('/api/retail-admin/media/folders/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tx = tdb().transaction(() => {
    tdb().prepare('UPDATE retail_media SET folder_id = NULL WHERE folder_id = ?').run(id);
    tdb().prepare('DELETE FROM retail_media_folders WHERE id = ?').run(id);
  });
  tx();
  res.json({ success: true });
});

router.post('/api/retail-admin/media/bulk-move', requireRetailAdmin, express.json(), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ success: false, error: 'no_ids' });
  const folder_id = req.body?.folder_id == null ? null : parseInt(req.body.folder_id, 10);
  if (folder_id != null) {
    const ok = tdb().prepare('SELECT 1 FROM retail_media_folders WHERE id = ?').get(folder_id);
    if (!ok) return res.status(400).json({ success: false, error: 'folder_not_found' });
  }
  const stmt = tdb().prepare('UPDATE retail_media SET folder_id = ? WHERE id = ?');
  let moved = 0;
  const tx = tdb().transaction(() => { for (const id of ids) moved += stmt.run(folder_id, id).changes; });
  tx();
  res.json({ success: true, data: { moved } });
});

router.get('/api/retail-admin/media/tags', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(
    `SELECT je.value AS tag, COUNT(*) AS n
       FROM retail_media m, json_each(COALESCE(m.tags,'[]')) je
       GROUP BY je.value
       ORDER BY n DESC, tag ASC`
  ).all();
  res.json({ success: true, data: rows });
});

// Scans storefront_config (CMS layouts, FAQ, snippets, etc.) for any
// reference to `/api/retail/media/<id>`. Cheap — only text scanning, no
// per-row JSON parse — and gives the admin a "safe to delete?" hint.
router.get('/api/retail-admin/media/usage', requireRetailAdmin, (req, res) => {
  const counts = {};
  const re = /\/api\/retail\/media\/(\d+)/g;
  const sources = [];
  try { sources.push(...tdb().prepare(`SELECT value_json AS txt FROM storefront_config`).all()); } catch {}
  try { sources.push(...tdb().prepare(`SELECT image_url AS txt FROM products WHERE image_url LIKE '%/api/retail/media/%'`).all()); } catch {}
  try { sources.push(...tdb().prepare(`SELECT label_url AS txt FROM products WHERE label_url LIKE '%/api/retail/media/%'`).all()); } catch {}
  try { sources.push(...tdb().prepare(`SELECT description_blocks AS txt FROM products WHERE description_blocks LIKE '%/api/retail/media/%'`).all()); } catch {}
  for (const { txt } of sources) {
    if (!txt) continue;
    let m;
    while ((m = re.exec(txt)) !== null) {
      const id = parseInt(m[1], 10);
      counts[id] = (counts[id] || 0) + 1;
    }
  }
  res.json({ success: true, data: counts });
});

router.patch('/api/retail-admin/media/:id', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const sets = [], params = [];
  if ('filename'  in b) { sets.push('filename = ?');  params.push(b.filename == null ? null : String(b.filename).slice(0, 200)); }
  if ('alt_text'  in b) { sets.push('alt_text = ?');  params.push(b.alt_text == null ? null : String(b.alt_text).slice(0, 500)); }
  if ('tags'      in b) { sets.push('tags = ?');      params.push(JSON.stringify(normalizeTagList(b.tags))); }
  if ('folder_id' in b) { sets.push('folder_id = ?'); params.push(b.folder_id == null ? null : parseInt(b.folder_id, 10)); }
  if (!sets.length) return res.status(400).json({ success: false, error: 'no_fields' });
  params.push(id);
  const r = tdb().prepare(`UPDATE retail_media SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (r.changes === 0) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true });
});

router.post('/api/retail-admin/media/bulk-delete', requireRetailAdmin, express.json(), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ success: false, error: 'no_ids' });
  const stmt = tdb().prepare('DELETE FROM retail_media WHERE id = ?');
  let deleted = 0;
  const tx = tdb().transaction(() => { for (const id of ids) deleted += stmt.run(id).changes; });
  tx();
  res.json({ success: true, data: { deleted } });
});

router.post('/api/retail-admin/media/bulk-tag', requireRetailAdmin, express.json(), (req, res) => {
  const ids    = Array.isArray(req.body?.ids) ? req.body.ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
  const add    = normalizeTagList(req.body?.add || []);
  const remove = normalizeTagList(req.body?.remove || []);
  if (!ids.length) return res.status(400).json({ success: false, error: 'no_ids' });
  if (!add.length && !remove.length) return res.status(400).json({ success: false, error: 'no_changes' });
  const get = tdb().prepare('SELECT tags FROM retail_media WHERE id = ?');
  const upd = tdb().prepare('UPDATE retail_media SET tags = ? WHERE id = ?');
  const tx = tdb().transaction(() => {
    for (const id of ids) {
      const row = get.get(id); if (!row) continue;
      const cur = new Set(parseTags(row.tags));
      for (const t of add) cur.add(t);
      for (const t of remove) cur.delete(t);
      upd.run(JSON.stringify(normalizeTagList([...cur])), id);
    }
  });
  tx();
  res.json({ success: true });
});

// Upload entry point for the /retail-admin Media tab. Identical to the
// CMS picker upload, but accepts optional alt_text + tags up front and
// returns the full row metadata for the grid.
router.post('/api/retail-admin/media/upload', requireRetailAdmin, (req, res) => {
  upload.single('file')(req, res, err => {
    if (err) {
      const code = err.message === 'not_an_image' ? 'not_an_image'
                 : err.code === 'LIMIT_FILE_SIZE' ? 'too_large'
                 : 'upload_failed';
      return res.status(400).json({ success: false, error: code });
    }
    if (!req.file) return res.status(400).json({ success: false, error: 'no_file' });
    // Don't trust the multipart-declared mime — sniff the real bytes. Rejects
    // SVG (XSS vector) and anything that isn't a recognized raster image, and
    // pins the stored/served mime to the sniffed value.
    const sniffed = sniffImageMime(req.file.buffer);
    if (!sniffed) return res.status(400).json({ success: false, error: 'not_an_image' });
    const altText = (req.body?.alt_text || '').toString().slice(0, 500) || null;
    let tags = [];
    try { tags = normalizeTagList(JSON.parse(req.body?.tags || '[]')); } catch {}
    const dataUri = `data:${sniffed};base64,${req.file.buffer.toString('base64')}`;
    const info = tdb().prepare(
      `INSERT INTO retail_media (filename, mime_type, size_bytes, data, alt_text, tags, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      req.file.originalname || null,
      sniffed,
      req.file.size,
      dataUri,
      altText,
      JSON.stringify(tags),
      req.user.id,
    );
    res.json({
      success: true,
      data: {
        id: info.lastInsertRowid,
        url: `/api/retail/media/${info.lastInsertRowid}`,
        filename: req.file.originalname,
        mime_type: req.file.mimetype,
        size_bytes: req.file.size,
        alt_text: altText,
        tags,
      },
    });
  });
});

router.post('/api/retail-admin/cms/revert-draft', requireRetailAdmin, express.json(), (req, res) => {
  const page = pageKey(req);
  if (!page) return res.status(400).json({ success: false, error: 'invalid_page' });
  const live = readLayout(`${page}.layout`);
  writeLayout(`cms.draft.${page}_layout`, JSON.stringify(live), req.user.id);
  res.json({ success: true, data: { page, draft: live } });
});

// ═══════════════════════════════════════════════════════════════════════
// DELIVERY FEE, PACKING FEE, POINTS, TOP-UP
// All money is REAL (¥, 2dp); points are INTEGER.
// Delivery model — two zone types:
//   • gz_district: match_district within Guangzhou. base_fee for normal
//     delivery, optional max_fee for "MAX (any-distance flat)" option.
//   • city: match_city for non-Guangzhou cities. base_fee is the flat
//     delivery; packing_fee_per_item × total_qty (capped) adds on top.
// Free delivery applies when subtotal ≥ zone.free_threshold (else falls
// back to delivery.defaultFreeThreshold config).
// ═══════════════════════════════════════════════════════════════════════

const GZ_CITY_ALIASES = new Set(['广州', '广州市', 'guangzhou', 'gz']);
function normalizeAreaName(s) {
  if (!s) return '';
  return String(s)
    .trim()
    .toLowerCase()
    // strip common Chinese suffixes so '天河' matches '天河区'
    .replace(/(市|区|县|省)$/u, '');
}
function isGuangzhou(city) {
  if (!city) return false;
  const norm = String(city).trim().toLowerCase();
  return GZ_CITY_ALIASES.has(norm) || normalizeAreaName(city) === 'guangzhou' || normalizeAreaName(city) === '广州';
}

// Returns the best-matching zone row for an address. Falls back to null
// if nothing matches — checkout should then refuse with an explanatory
// error rather than guessing.
function matchDeliveryZone(address) {
  if (!address) return null;
  const wantDistrict = normalizeAreaName(address.district);
  const wantCity     = normalizeAreaName(address.city);
  const wantProvince = normalizeAreaName(address.province);
  // Free-text fallback: WeChat-imported addresses often dump the entire
  // string (province + city + district + street) into the `address`
  // field and leave the structured city/district slots blank. Also scan
  // the concatenated blob so "广州市 ... 天河区 ..." still matches the
  // Tianhe row even when address.district is empty. Province is included so
  // a province-named zone (match_city = '江苏省') still resolves when the
  // WeChat region picker fills structured 省/市/区 but not the street text.
  const blob = [address.province, address.address, address.detail, address.city, address.district]
                 .filter(Boolean).join(' ');
  // Strip the suffix-stripped form of a configured name (天河区 → 天河) so
  // both forms substring-match.
  const stripSuffix = (s) => String(s || '').replace(/(市|区|县|省)$/u, '');

  const inGuangzhou = isGuangzhou(address.city) || /广州/.test(blob) || /guangzhou/i.test(blob);

  if (inGuangzhou) {
    const rows = tdb().prepare(
      `SELECT * FROM retail_delivery_zones WHERE zone_type = 'gz_district' AND is_active = 1`
    ).all();
    for (const r of rows) {
      if (wantDistrict && normalizeAreaName(r.match_district) === wantDistrict) return r;
      const full = r.match_district || '';
      if (full && blob.includes(full)) return r;
      const stripped = stripSuffix(full);
      if (stripped && stripped.length >= 2 && blob.includes(stripped)) return r;
    }
    return null;
  }
  const rows = tdb().prepare(
    `SELECT * FROM retail_delivery_zones WHERE zone_type = 'city' AND is_active = 1`
  ).all();
  // 1) Exact city match wins — most specific (e.g. a 太原市 zone beats a
  //    broader 山西省 zone for a Taiyuan address).
  for (const r of rows) {
    if (wantCity && normalizeAreaName(r.match_city) === wantCity) return r;
  }
  // 2) Province-level zone: the address's 省 equals a province-named row.
  for (const r of rows) {
    if (wantProvince && normalizeAreaName(r.match_city) === wantProvince) return r;
  }
  // 3) Free-text fallback for WeChat-imported / blank-structured addresses.
  for (const r of rows) {
    const full = r.match_city || '';
    if (full && blob.includes(full)) return r;
    const stripped = stripSuffix(full);
    if (stripped && stripped.length >= 2 && blob.includes(stripped)) return r;
  }
  return null;
}

// ─── Delivery-slot enumerator ────────────────────────────────────────────
// Given a matched zone (or null) + the current server time, produce the
// list of slots the customer can pick from on the checkout page.
//
// Rules baked in (matching the product spec):
//   • Inside GZ districts (same_day_surcharge = 0, default): "right away"
//     is the natural default while the kitchen is open. Future days +
//     2-hour slots are also offered.
//   • Panyu-style override (same_day_surcharge > 0): the customer can pick
//     a same-day slot ONLY by paying the surcharge; without it they must
//     start from tomorrow.
//   • Outside GZ (zone_type = 'city', min_lead_days = 3 by default):
//     earliest selectable day is today + min_lead_days.
//   • "Right away" is suppressed whenever the kitchen is not running this
//     minute — before slot_start_hour AND after slot_end_hour.
//   • Today's time-slot chips show every future slot up to slot_end_hour,
//     including pre-opening hours: ordering at 7am with kitchen opening at
//     10am still offers Today 10–12 / 12–14 / etc. Only after slot_end_hour
//     do today's chips empty out and the system rolls forward to Tomorrow.
//
// Returns: {
//   right_away_available, same_day_surcharge, min_lead_days,
//   slots: [{ slot_id, date_iso, start_hour, end_hour, is_same_day,
//             requires_surcharge, label_en, label_cn }],
//   kitchen_open_now,
// }
function computeDeliverySlots(zone, now) {
  const cfg = {
    same_day_allowed:      1,
    same_day_surcharge:    0,
    min_lead_days:         0,
    max_lead_days:         14,
    slot_start_hour:       10,
    slot_end_hour:         20,
    slot_duration_minutes: 120,
    day_only:              0,
  };
  if (zone) {
    for (const k of Object.keys(cfg)) {
      if (zone[k] != null) cfg[k] = Number(zone[k]);
    }
  }
  // Holiday mode: orders still flow but all same-day options are suppressed
  // and the mini app shows a banner with the admin-configured message. The
  // schedule-for-later calendar remains pickable so customers can book a
  // future day.
  const holidayMode = !!cfgValue('delivery.holidayMode', false);
  const holidayMessage = cfgValue('delivery.holidayMessage', { en: '', cn: '' });
  if (holidayMode) {
    cfg.same_day_allowed = 0;
  }
  // Clamp pathological admin input so we never spin forever.
  if (!(cfg.slot_duration_minutes > 0))         cfg.slot_duration_minutes = 120;
  if (cfg.slot_start_hour >= cfg.slot_end_hour) cfg.slot_end_hour = cfg.slot_start_hour + 1;
  if (cfg.min_lead_days < 0)                    cfg.min_lead_days = 0;
  if (cfg.max_lead_days < cfg.min_lead_days)    cfg.max_lead_days = cfg.min_lead_days + 7;

  const tzNow      = now || new Date();
  const startHour  = cfg.slot_start_hour;
  const endHour    = cfg.slot_end_hour;
  const slotMins   = cfg.slot_duration_minutes;
  const isDayOnly  = cfg.day_only === 1;
  const kitchenOpenNow =
        tzNow.getHours() >= startHour &&
        tzNow.getHours() <  endHour;

  // "Right away" only applies in time-slot mode. Day-only zones express
  // the same-day option as a "Today (+¥X)" day-chip instead.
  const rightAwayAvailable = !isDayOnly &&
        cfg.same_day_allowed === 1 &&
        kitchenOpenNow &&
        cfg.min_lead_days === 0 &&
        cfg.same_day_surcharge === 0;

  // Simplified slot model (rewritten 2026-05-17):
  //   • Today: in time-slot mode, the remaining 2-hour windows that fit
  //     before kitchen close. In day-only mode, one "Today" chip (the
  //     Panyu surcharge option). Both gated by same_day_allowed +
  //     kitchen_open_now.
  //   • Schedule-for-later: a date-only calendar with bounds
  //     [today + SCHEDULE_MIN_LEAD, today + max_lead_days]. SCHEDULE_MIN_LEAD
  //     defaults to 3 (i.e. earliest scheduled day is the 3rd day from
  //     order placement) so the calendar never overlaps Today/Tomorrow,
  //     which are handled by the same-day option above.
  // The legacy `slots` array is kept (as a flat list of today's slots) for
  // backward-compat with anything still reading scheduling.slots; new
  // callers should prefer `today_slots` + `schedule`.
  const SCHEDULE_MIN_LEAD = 3;
  const fmtDateIso = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const fmtHour = (h) => {
    const mer = h < 12 ? 'AM' : 'PM';
    const dispH = h % 12 === 0 ? 12 : h % 12;
    return `${dispH}${mer}`;
  };
  const hhmm = (h, m) => `${h}:${String(m).padStart(2, '0')}`;

  const startOfDay = new Date(tzNow.getFullYear(), tzNow.getMonth(), tzNow.getDate());
  const todayIso     = fmtDateIso(startOfDay);
  const tomorrowDate = new Date(startOfDay.getTime() + 86400000);
  const tomorrowIso  = fmtDateIso(tomorrowDate);
  const todaySlots = [];
  let   todayDayChip = null;
  // Which day we ended up populating chips for: 'today' when kitchen is
  // open right now AND at least one slot still fits before close; otherwise
  // we roll forward to 'tomorrow' so the customer always has a soonest-day
  // option (they shouldn't have to fall back to the calendar just because
  // the kitchen happens to be closed at the moment).
  let slotDayKind = null;  // 'today' | 'tomorrow' | null

  // Helper: emit the time-slot chips for a given day, given the absolute
  // start-of-day timestamp + a label prefix. `filterElapsed=true` skips
  // slots that have already ended (only meaningful when day === today).
  function emitTimeSlots(startOfTargetDay, isoDate, prefixEn, prefixCn, filterElapsed) {
    const out = [];
    let hourCursor = startHour * 60;
    const endCursor = endHour * 60;
    while (hourCursor + slotMins <= endCursor + 1) {
      const slotStartH = Math.floor(hourCursor / 60);
      const slotStartM = hourCursor % 60;
      const slotEndCursor = Math.min(hourCursor + slotMins, endCursor);
      const slotEndH = Math.floor(slotEndCursor / 60);
      const slotEndM = slotEndCursor % 60;
      if (filterElapsed) {
        const slotEndsAt = new Date(startOfTargetDay.getTime() + slotEndCursor * 60000);
        if (slotEndsAt.getTime() <= tzNow.getTime()) { hourCursor += slotMins; continue; }
      }
      const requiresSurcharge = (isoDate === todayIso) && cfg.same_day_surcharge > 0;
      out.push({
        slot_id:    `${isoDate}T${hhmm(slotStartH, slotStartM)}`,
        date_iso:   isoDate,
        start_hour: slotStartH,  start_minute: slotStartM,
        end_hour:   slotEndH,    end_minute:   slotEndM,
        is_same_day: isoDate === todayIso,
        is_day_only: false,
        requires_surcharge: requiresSurcharge,
        surcharge:          requiresSurcharge ? cfg.same_day_surcharge : 0,
        label_en: `${prefixEn} ${fmtHour(slotStartH)}–${fmtHour(slotEndH)}`,
        label_cn: `${prefixCn} ${hhmm(slotStartH, slotStartM)}–${hhmm(slotEndH, slotEndM)}`,
      });
      hourCursor += slotMins;
    }
    return out;
  }

  // ── Today's options ─────────────────────────────────────────────────
  // Gate on same_day_allowed only — NOT kitchenOpenNow. Pre-opening hours
  // (e.g. ordering at 7am with kitchen opening at 10am) must still offer
  // today's future slots; emitTimeSlots(filterElapsed=true) naturally
  // returns [] post-close, so the fallback to tomorrow still kicks in.
  if (cfg.same_day_allowed === 1) {
    if (isDayOnly) {
      // Day-only zones don't have per-slot times, so we need an explicit
      // "is today still fulfillable" check — kitchen must not be past
      // close. Ordering after kitchen close → no Today chip.
      const todayStillFulfillable = tzNow.getHours() < endHour;
      if (todayStillFulfillable) {
        const requiresSurcharge = cfg.same_day_surcharge > 0;
        todayDayChip = {
          slot_id: todayIso,
          date_iso: todayIso,
          is_same_day: true,
          is_day_only: true,
          requires_surcharge: requiresSurcharge,
          surcharge: requiresSurcharge ? cfg.same_day_surcharge : 0,
          label_en: 'Today',
          label_cn: '今天',
        };
        slotDayKind = 'today';
      }
    } else {
      const emitted = emitTimeSlots(startOfDay, todayIso, 'Today', '今天', /*filterElapsed=*/true);
      if (emitted.length) {
        todaySlots.push(...emitted);
        slotDayKind = 'today';
      }
    }
  }

  // ── Fallback: if no same-day options qualified (kitchen closed, all of
  // today's slots elapsed, or same_day_allowed=0), roll forward to
  // tomorrow's full slot list so the customer can still pick a time-slot
  // window without dropping into the calendar. Day-only zones don't get
  // a tomorrow-chip fallback — the Express option already routes to the
  // earliest available day from the schedule window.
  if (!isDayOnly && todaySlots.length === 0) {
    const emitted = emitTimeSlots(tomorrowDate, tomorrowIso, 'Tomorrow', '明天', /*filterElapsed=*/false);
    if (emitted.length) {
      todaySlots.push(...emitted);
      slotDayKind = 'tomorrow';
    }
  }

  // ── Schedule-for-later (calendar) ───────────────────────────────────
  // Earliest selectable day = max(SCHEDULE_MIN_LEAD, zone.min_lead_days).
  // Latest = today + max_lead_days. If max < min, the calendar is empty.
  const scheduleStartDays = Math.max(SCHEDULE_MIN_LEAD, cfg.min_lead_days);
  const scheduleEndDays   = cfg.max_lead_days;
  let schedule = null;
  if (scheduleEndDays >= scheduleStartDays) {
    const startDate = new Date(startOfDay.getTime() + scheduleStartDays * 86400000);
    const endDate   = new Date(startOfDay.getTime() + scheduleEndDays   * 86400000);
    schedule = {
      min_date: fmtDateIso(startDate),
      max_date: fmtDateIso(endDate),
      surcharge: 0,
    };
  }

  return {
    mode: isDayOnly ? 'day_only' : 'time_slots',
    right_away_available: rightAwayAvailable,
    same_day_surcharge:   cfg.same_day_surcharge,
    same_day_allowed:     cfg.same_day_allowed === 1,
    min_lead_days:        cfg.min_lead_days,
    max_lead_days:        cfg.max_lead_days,
    kitchen_open_now:     kitchenOpenNow,
    kitchen_hours:        { start: startHour, end: endHour },
    slot_duration_minutes: slotMins,
    holiday_mode:         holidayMode,
    holiday_message:      holidayMode ? holidayMessage : null,
    today_slots:          todaySlots,
    today_day_chip:       todayDayChip,
    // 'today' when the chips above are today's, 'tomorrow' when we rolled
    // forward because the kitchen is closed. Drives the chip-strip header.
    slot_day_kind:        slotDayKind,
    schedule,
    // Legacy flat slot list — only TODAY's options now. Anything reading
    // `slots` and trusting it spans multiple days will need to migrate
    // to today_slots + schedule (the mini app does this in the same release).
    //
    // Day-only zones MUST seed at least one Express slot whenever a schedule
    // window exists — otherwise the mini-app's day-only handler bails on
    // an empty `slots` array and renders the Express radio with no label
    // (visible as an empty box). This synth slot is the "ship as soon as
    // possible" option, anchored to schedule.min_date. resolveDeliverySlot
    // accepts any date inside the schedule window so the synth slot_id is
    // valid on /orders POST.
    slots: isDayOnly
      ? (todayDayChip
          ? [todayDayChip]
          : (schedule
              ? [{
                  slot_id:    schedule.min_date,
                  date_iso:   schedule.min_date,
                  is_same_day: false,
                  is_day_only: true,
                  requires_surcharge: false,
                  surcharge:  0,
                  label_en:   `Earliest ${schedule.min_date}`,
                  label_cn:   `最早 ${schedule.min_date}`,
                }]
              : []))
      : todaySlots,
  };
}

// Resolve a slot_id back into a Date + validated metadata. Used by the
// orders POST to confirm the customer's pick before persisting.
// Returns { scheduled_for: ISO string, slot, surcharge } or { error }.
function resolveDeliverySlot(zone, slotId, now) {
  if (!slotId) return { scheduled_for: null, slot: null, surcharge: 0 };
  if (slotId === 'right_away') {
    const enumed = computeDeliverySlots(zone, now);
    if (!enumed.right_away_available) return { error: 'right_away_unavailable' };
    return { scheduled_for: null, slot: { slot_id: 'right_away' }, surcharge: 0 };
  }
  const enumed = computeDeliverySlots(zone, now);
  // Two slot-id shapes: 'YYYY-MM-DDTHH:MM' (today's time-slot pick) or
  // 'YYYY-MM-DD' (today's day-only chip OR any schedule-for-later calendar
  // pick). For the latter, the day need not be in `slots` (the calendar
  // covers an open range) — we just validate it falls inside the
  // schedule window or matches the today_day_chip.
  let dt, found;
  const mTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(slotId);
  const mDay  = /^(\d{4})-(\d{2})-(\d{2})$/.exec(slotId);
  if (mTime) {
    found = enumed.slots.find(s => s.slot_id === slotId);
    if (!found) return { error: 'slot_unavailable' };
    dt = new Date(Number(mTime[1]), Number(mTime[2]) - 1, Number(mTime[3]), Number(mTime[4]), Number(mTime[5]));
  } else if (mDay) {
    // Same-day day-only chip first (Panyu).
    found = enumed.slots.find(s => s.slot_id === slotId);
    if (!found) {
      // Otherwise it must fall inside the schedule-for-later window.
      const sch = enumed.schedule;
      if (!sch || slotId < sch.min_date || slotId > sch.max_date) {
        return { error: 'slot_unavailable' };
      }
      found = {
        slot_id: slotId,
        date_iso: slotId,
        is_same_day: false,
        is_day_only: true,
        requires_surcharge: false,
        surcharge: 0,
        label_en: slotId,
        label_cn: slotId,
      };
    }
    dt = new Date(Number(mDay[1]), Number(mDay[2]) - 1, Number(mDay[3]), 0, 0);
  } else {
    return { error: 'slot_invalid' };
  }
  return {
    scheduled_for: dt.toISOString(),
    slot: found,
    surcharge: found.requires_surcharge ? Number(found.surcharge) || 0 : 0,
  };
}

// Given the matched zone + cart state, compute delivery + packing fee.
// deliveryMode is the customer's requested option:
//   • 'standard' — base_fee (free if subtotal hits threshold)
//   • 'max'      — flat max_fee (Guangzhou only). free_threshold does NOT apply.
// Packing fee applies to any zone that configures one (per-item × qty, capped).
function computeDeliveryAndPacking(zone, subtotal, deliveryMode, totalQty) {
  if (!zone) {
    return { error: 'no_zone_match', deliveryFee: 0, packingFee: 0, freeShipping: false };
  }
  const defaultFreeThreshold = Number(cfgValue('delivery.defaultFreeThreshold', 399));
  const freeThreshold = zone.free_threshold != null ? Number(zone.free_threshold) : defaultFreeThreshold;
  const freeEligible  = freeThreshold > 0 && subtotal >= freeThreshold;

  let deliveryFee = 0;
  if (zone.zone_type === 'gz_district' && deliveryMode === 'max') {
    if (zone.max_fee == null) return { error: 'max_not_offered', deliveryFee: 0, packingFee: 0, freeShipping: false };
    deliveryFee = Number(zone.max_fee);
  } else {
    deliveryFee = freeEligible ? 0 : Number(zone.base_fee || 0);
  }

  let packingFee = 0;
  if (zone.packing_fee_per_item > 0 && totalQty > 0) {
    packingFee = Number(zone.packing_fee_per_item) * totalQty;
    if (zone.packing_fee_cap != null && packingFee > Number(zone.packing_fee_cap)) {
      packingFee = Number(zone.packing_fee_cap);
    }
  }

  return {
    deliveryFee: Math.round(deliveryFee * 100) / 100,
    packingFee:  Math.round(packingFee  * 100) / 100,
    freeShipping: freeEligible && !(zone.zone_type === 'gz_district' && deliveryMode === 'max'),
  };
}

// Re-prices a cart's items the same way order-create does, so /quote and
// /orders agree to the cent. Returns { subtotal, totalQty, error? }.
// Flash-sale prices apply when active — same window check as the public
// product API, so what the customer sees IS what they pay.
function priceCart(items, customerId) {
  if (!Array.isArray(items) || !items.length) return { error: 'no_items', subtotal: 0, totalQty: 0 };
  const now = Date.now();
  let subtotal = 0, totalQty = 0;
  const lines = [];
  for (const it of items) {
    const pid = parseInt(it.product_id, 10);
    const qty = Number(it.qty);
    if (!pid || !(qty > 0)) return { error: 'invalid_item', subtotal: 0, totalQty: 0 };
    const p = tdb().prepare(
      `SELECT id, sell_price AS price,
              flash_price, flash_starts_at, flash_ends_at,
              flash_stock_limit, flash_sold
         FROM products
        WHERE id = ? AND is_published = 1 AND COALESCE(is_active, 1) = 1`
    ).get(pid);
    if (!p) return { error: 'product_unavailable', subtotal: 0, totalQty: 0 };
    let optionDelta = 0;
    if (Array.isArray(it.choices) && it.choices.length) {
      const placeholders = it.choices.map(() => '?').join(',');
      const choices = tdb().prepare(
        `SELECT c.price_delta, o.product_id
           FROM retail_product_option_choices c
           JOIN retail_product_options o ON o.id = c.option_id
          WHERE c.id IN (${placeholders})`
      ).all(...it.choices);
      for (const c of choices) {
        if (c.product_id !== pid) return { error: 'choice_wrong_product', subtotal: 0, totalQty: 0 };
        optionDelta += Number(c.price_delta) || 0;
      }
    }
    const eff = flashsales.effectivePriceFor(p, p.price, now);
    const unit = eff.price + optionDelta;
    subtotal += unit * qty;
    totalQty += qty;
    // Per-line breakdown so the checkout page can re-price its cart display
    // to the CURRENT effective price (flash sales that started/ended while
    // an item sat in the cart). choice_ids is normalised (numeric, sorted)
    // so the client can key-match each line to its cart row.
    lines.push({
      product_id: pid,
      choice_ids: (Array.isArray(it.choices) ? it.choices : []).map(Number).filter(Boolean).sort((a, b) => a - b),
      unit_price: Math.round(unit * 100) / 100,
      is_flash: !!eff.is_flash,
      regular_price: eff.is_flash ? Math.round((Number(p.price) + optionDelta) * 100) / 100 : null,
    });
  }
  return { subtotal: Math.round(subtotal * 100) / 100, totalQty, lines };
}

// POST /api/retail/cart/price — lightweight cart re-pricing with NO address
// or delivery context. The cart page calls this on open so it can show the
// CURRENT effective (flash) prices + savings: cart unit_prices are frozen at
// add-time, so a flash sale that started/ended since would otherwise show a
// stale price. Returns the same per-line breakdown the checkout quote does.
router.post('/api/retail/cart/price', requireRetailAuth, express.json(), (req, res) => {
  const priced = priceCart(req.body && req.body.items, req.customer.id);
  if (priced.error) return res.status(400).json({ success: false, error: priced.error });
  res.json({ success: true, data: { subtotal: priced.subtotal, total_qty: priced.totalQty, lines: priced.lines || [] } });
});

// Earn rule: admin configures "earn N points per ¥M spent" via the two
// config keys points.earnPoints and points.earnSpend (default 1 per ¥100).
// Legacy single-sided points.earnRate (= yuan per point) is still read as
// a fallback so old databases keep working until the backfill migration
// stamps the new pair.
function pointsEarnedFor(subtotal, tierMult = 1) {
  const pts   = Number(cfgValue('points.earnPoints', 1));
  const spend = Number(cfgValue('points.earnSpend', null));
  // Fall back to the legacy key on databases that haven't been migrated yet.
  const denom = spend > 0 ? spend : Number(cfgValue('points.earnRate', 100));
  if (!(pts > 0) || !(denom > 0)) return 0;
  // tierMult comes from tierMultiplierFor(customer.tier_key); callers that
  // don't know the tier (anonymous quote, fallback paths) pass the default 1.
  // We floor once at the end so 1.5× on a sub-threshold subtotal still rounds
  // toward zero — matches the historical no-multiplier behaviour for Seed.
  const m = Number.isFinite(tierMult) && tierMult > 0 ? tierMult : 1;
  return Math.floor((Number(subtotal || 0) * pts * m) / denom);
}

// SQLite ISO datetime N months from now, or NULL if expiry disabled. Used
// to stamp expires_at on new earn rows at insert time so each batch knows
// its own TTL (admin can change the global later without affecting old rows).
function nextEarnExpiry() {
  const months = Number(cfgValue('points.expiryMonths', 12));
  if (!(months > 0)) return null;
  // SQLite computes the date — pass as ISO string to keep TZ consistent
  // with CURRENT_TIMESTAMP (UTC).
  const row = tdb().prepare(`SELECT datetime('now', ?) AS dt`).get(`+${months} months`);
  return row?.dt || null;
}

// Sweep expired earn batches for a single customer. Idempotent: only
// touches rows whose expires_at < now AND have not yet been swept
// (expired_at IS NULL). Writes a negative 'expiry' ledger row per batch
// and rebases points_balance to match. Cheap enough to call inline before
// any balance-affecting operation (award / redeem / customer read).
function sweepExpiredPoints(customerId) {
  if (!customerId) return 0;
  const due = tdb().prepare(
    `SELECT id, delta, expires_at FROM retail_points_transactions
      WHERE customer_id = ?
        AND delta > 0
        AND expires_at IS NOT NULL
        AND expired_at IS NULL
        AND datetime(expires_at) <= datetime('now')`
  ).all(customerId);
  if (!due.length) return 0;
  // Mark the original earn rows as swept so we don't re-process them.
  const markSwept = tdb().prepare(
    `UPDATE retail_points_transactions SET expired_at = CURRENT_TIMESTAMP WHERE id = ?`
  );
  const insertExpiry = tdb().prepare(
    `INSERT INTO retail_points_transactions
       (customer_id, delta, balance_after, source, note, created_at)
     VALUES (?, ?, ?, 'expiry', ?, CURRENT_TIMESTAMP)`
  );
  let totalExpired = 0;
  const tx = tdb().transaction(() => {
    for (const b of due) {
      // Only deduct what's still on the books — clamp at the current
      // balance so we don't drive it negative for batches the customer
      // already redeemed away (we accept that an already-spent batch
      // expiring is a no-op from the customer's view).
      const cur = tdb().prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(customerId).points_balance;
      const take = Math.min(b.delta, cur);
      if (take > 0) {
        tdb().prepare(
          'UPDATE retail_customers SET points_balance = points_balance - ? WHERE id = ?'
        ).run(take, customerId);
        const after = tdb().prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(customerId).points_balance;
        insertExpiry.run(customerId, -take, after, `Expired batch from ${b.expires_at}`);
        totalExpired += take;
      }
      markSwept.run(b.id);
    }
  });
  try { tx(); } catch (e) { console.error('[sweepExpiredPoints]', e); return 0; }
  return totalExpired;
}

// points.redeemRate = points needed per ¥1 of discount (default 100).
function pointsRedeemRate() {
  const r = Number(cfgValue('points.redeemRate', 100));
  return r > 0 ? r : 100;
}
// Cash a customer must put on the table when redeeming N points.
function pointsCashValue(pts) {
  return Math.floor((Number(pts || 0) / pointsRedeemRate()) * 100) / 100;
}
// Points required to fully cover a cash amount (round up — so we never
// under-charge ourselves on the wallet side).
function pointsRequiredFor(cash) {
  return Math.ceil(Number(cash || 0) * pointsRedeemRate());
}
// Store policy: are points allowed to pay the shipping fee? Default OFF —
// points cover product subtotal + packing only; customer always pays
// shipping in cash. Admin can flip this on per store.
function pointsCoverShipping() {
  return !!cfgValue('points.coverShipping', false);
}
// Cash base that points are allowed to redeem against. When shipping is
// excluded by policy, the residual (shipping) is always paid in cash.
function pointsRedeemableBase(subtotal, shippingFee, packingFee, voucherDiscount = 0) {
  const ship = pointsCoverShipping() ? Number(shippingFee || 0) : 0;
  return Math.max(0, Number(subtotal || 0) + ship + Number(packingFee || 0) - Number(voucherDiscount || 0));
}

// Reverse a redemption when an order is refunded. Idempotent — checks for
// an existing 'refund_reverse' row tagged to this order's redeem.
function reverseOrderRedeem(orderId) {
  const redeem = tdb().prepare(
    "SELECT customer_id, delta FROM retail_points_transactions WHERE order_id = ? AND source = 'order_redeem'"
  ).get(orderId);
  if (!redeem || redeem.delta >= 0) return 0;
  const refundedPts = -redeem.delta;
  const already = tdb().prepare(
    "SELECT id FROM retail_points_transactions WHERE order_id = ? AND source = 'refund_reverse' AND delta > 0"
  ).get(orderId);
  if (already) return 0;
  const tx = tdb().transaction(() => {
    tdb().prepare(
      'UPDATE retail_customers SET points_balance = points_balance + ? WHERE id = ?'
    ).run(refundedPts, redeem.customer_id);
    const after = tdb().prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(redeem.customer_id).points_balance;
    tdb().prepare(
      `INSERT INTO retail_points_transactions
         (customer_id, delta, balance_after, source, order_id, note)
       VALUES (?, ?, ?, 'refund_reverse', ?, 'Redemption returned on refund')`
    ).run(redeem.customer_id, refundedPts, after, orderId);
  });
  try { tx(); } catch (e) { console.error('[reverseOrderRedeem]', e); }
  return refundedPts;
}

// Award earn-points on payment success. Idempotent — checks the ledger
// for an existing order_earn row for this order before inserting.
function awardOrderPoints(orderId) {
  const o = tdb().prepare(
    'SELECT id, customer_id, subtotal, points_earned FROM retail_orders WHERE id = ?'
  ).get(orderId);
  if (!o) return 0;
  // Sweep first so the awarded balance is based on a clean (post-expiry) state.
  sweepExpiredPoints(o.customer_id);
  const already = tdb().prepare(
    "SELECT id FROM retail_points_transactions WHERE order_id = ? AND source = 'order_earn'"
  ).get(orderId);
  if (already) return o.points_earned || 0;
  // Use the customer's tier_key at the moment of award. We pulled it directly
  // (not via reconcileTier) — by the time award fires the tier is either
  // already accurate from the previous order or it's about to be reconciled
  // in the same transaction below.
  const c = tdb().prepare('SELECT tier_key FROM retail_customers WHERE id = ?').get(o.customer_id);
  const tierMult = tierMultiplierFor(c?.tier_key);
  const pts   = pointsEarnedFor(o.subtotal, tierMult);
  const spend = Math.max(0, Number(o.subtotal) || 0);
  const expiresAt = pts > 0 ? nextEarnExpiry() : null;
  // We always insert the order_earn row (even at delta=0) so the row is the
  // single idempotency marker for both points-award AND lifetime_spend bump
  // — otherwise sub-rate orders (subtotal below points.earnRate) would be
  // double-counted on retries.
  const tx = tdb().transaction(() => {
    tdb().prepare(
      'UPDATE retail_customers SET lifetime_spend = COALESCE(lifetime_spend, 0) + ?, points_balance = points_balance + ? WHERE id = ?'
    ).run(spend, pts, o.customer_id);
    const fresh = tdb().prepare('SELECT lifetime_spend, points_balance, tier_key FROM retail_customers WHERE id = ?').get(o.customer_id);
    // Auto-promote tier_key off the new lifetime_spend in the same transaction
    // so leaderboards / admin lists / next reads all agree without waiting on
    // the requireRetailAuth self-heal.
    reconcileTier(o.customer_id, fresh.lifetime_spend, fresh.tier_key);
    const after = fresh.points_balance;
    const note  = pts > 0
      ? `Order ${orderId} earned ${pts} pts`
      : `Order ${orderId} (subtotal ¥${spend.toFixed(2)}, below earn threshold)`;
    tdb().prepare(
      `INSERT INTO retail_points_transactions
         (customer_id, delta, balance_after, source, order_id, note, expires_at)
       VALUES (?, ?, ?, 'order_earn', ?, ?, ?)`
    ).run(o.customer_id, pts, after, orderId, note, expiresAt);
    tdb().prepare('UPDATE retail_orders SET points_earned = ? WHERE id = ?').run(pts, orderId);
  });
  try { tx(); } catch (e) { console.error('[awardOrderPoints]', e); return 0; }
  return pts;
}

// Reverse earn-points AND lifetime_spend when an order is refunded.
// Best-effort — leaves a refund_reverse marker even if the customer has
// already spent the points (points_balance may briefly go negative).
// The refund_reverse row is the idempotency marker; it is always inserted
// so a sub-rate order (earn delta=0) still gets its spend reversed exactly once.
function reverseOrderPoints(orderId) {
  const earn = tdb().prepare(
    "SELECT customer_id, delta FROM retail_points_transactions WHERE order_id = ? AND source = 'order_earn'"
  ).get(orderId);
  if (!earn) return 0;
  const already = tdb().prepare(
    "SELECT id FROM retail_points_transactions WHERE order_id = ? AND source = 'refund_reverse'"
  ).get(orderId);
  if (already) return 0;
  const o = tdb().prepare('SELECT subtotal FROM retail_orders WHERE id = ?').get(orderId);
  const spend = Math.max(0, Number(o?.subtotal) || 0);
  const tx = tdb().transaction(() => {
    tdb().prepare(
      'UPDATE retail_customers SET lifetime_spend = MAX(0, COALESCE(lifetime_spend, 0) - ?), points_balance = points_balance - ? WHERE id = ?'
    ).run(spend, earn.delta, earn.customer_id);
    const fresh = tdb().prepare('SELECT lifetime_spend, points_balance, tier_key FROM retail_customers WHERE id = ?').get(earn.customer_id);
    // Refunds reduce lifetime_spend, so the tier may need to demote in the
    // same transaction. Sticky-upward semantics would skip this — current
    // policy is recompute always.
    reconcileTier(earn.customer_id, fresh.lifetime_spend, fresh.tier_key);
    const after = fresh.points_balance;
    tdb().prepare(
      `INSERT INTO retail_points_transactions
         (customer_id, delta, balance_after, source, order_id, note)
       VALUES (?, ?, ?, 'refund_reverse', ?, 'Reversed on refund')`
    ).run(earn.customer_id, -earn.delta, after, orderId);
  });
  try { tx(); } catch (e) { console.error('[reverseOrderPoints]', e); }
  return earn.delta;
}

// POST /api/retail/checkout/quote
// Body: { address_id, items:[{product_id,qty,choices:[]}], delivery_mode }
// Returns the same numbers the actual order-create will use — so the
// mini-app can show a faithful breakdown before the customer commits.
router.post('/api/retail/checkout/quote', requireRetailAuth, express.json(), (req, res) => {
  const body = req.body || {};
  const addressId    = body.address_id;
  const items        = body.items;
  const deliveryMode = body.delivery_mode || 'standard';
  // Accept either address_id (saved address) OR an inline {city,district,…}
  // payload so the new-address form can preview fees before saving.
  let address;
  if (addressId) {
    address = tdb().prepare(
      'SELECT * FROM retail_customer_addresses WHERE id = ? AND customer_id = ?'
    ).get(addressId, req.customer.id);
    if (!address) return res.status(400).json({ success: false, error: 'address_not_found' });
  } else if (body.address && typeof body.address === 'object') {
    address = {
      province: body.address.province || null,
      city:     body.address.city     || null,
      district: body.address.district || null,
    };
  } else {
    return res.status(400).json({ success: false, error: 'address_required' });
  }

  const priced = priceCart(items, req.customer.id);
  if (priced.error) return res.status(400).json({ success: false, error: priced.error });

  const zone = matchDeliveryZone(address);
  const fees = computeDeliveryAndPacking(zone, priced.subtotal, deliveryMode, priced.totalQty);
  if (fees.error) {
    return res.json({
      success: false,
      error: fees.error,
      data: {
        subtotal: priced.subtotal,
        zone: null,
        kitchen_address: cfgValue('delivery.kitchenAddress', ''),
      },
    });
  }

  const grossTotal = Math.max(0, priced.subtotal + fees.deliveryFee + fees.packingFee);

  // Points preview — two modes the client uses:
  //   • payment_method='points' (full redeem): pointsRequired / pointsAffordable
  //     gate the radio; total → 0 when affordable.
  //   • Partial stack: client passes points_to_use along with a cash
  //     payment_method ('wechat'/'alipay'). Server clamps and returns
  //     pointsToUseApplied + pointsDiscount; total = grossTotal − discount.
  // The always-on fields (balance / rate / max usable) let the mini-app
  // render the "Use my points" toggle even before a payment method is set.
  sweepExpiredPoints(req.customer.id);
  const _c = tdb().prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(req.customer.id);
  const pointsBalance = _c?.points_balance || 0;
  const redeemRate = pointsRedeemRate();
  const paymentMethodPreview = body.payment_method || null;
  // When the store excludes shipping from points coverage, the redeemable
  // base is subtotal + packing only; the customer always pays shipping in
  // cash (so residual = shipping when the points side is "full").
  const redeemBase       = pointsRedeemableBase(priced.subtotal, fees.deliveryFee, fees.packingFee);
  const pointsRequired   = pointsRequiredFor(redeemBase);
  const pointsAffordable = pointsBalance >= pointsRequired;
  const pointsMaxUsable  = Math.min(pointsBalance, pointsRequired);

  let pointsToUseApplied = 0;
  let pointsDiscount     = 0;
  let total;
  if (paymentMethodPreview === 'points') {
    // Legacy points-only path. When shipping isn't covered there's a cash
    // residual the points method can't settle — the mini-app no longer
    // exposes this radio, but report the residual so any old client sees
    // the right number.
    total = pointsAffordable ? Math.max(0, grossTotal - redeemBase) : grossTotal;
  } else {
    const reqPts = Math.max(0, Math.floor(Number(body.points_to_use) || 0));
    pointsToUseApplied = Math.min(reqPts, pointsMaxUsable);
    pointsDiscount     = pointsCashValue(pointsToUseApplied);
    total = Math.max(0, grossTotal - pointsDiscount);
  }

  // Routing preview — runs the rich shortage analysis used by the new
  // 5-option modal (GZ + non-excluded district + right-away slot). For
  // every other case the legacy yes/no fallback is what the mini-app
  // gets. `gate` tells the mini-app which modal to render.
  let routingPreview = null;
  try {
    const cleanItems = (items || []).map(i => ({ product_id: parseInt(i.product_id, 10), qty: Number(i.qty) }));
    const analysis = inventory.analyzeShortage({
      address, items: cleanItems,
      deliverySlotId: body.delivery_slot_id || null,
      channel: 'wechat',
    });
    if (analysis.error === 'no_active_store') {
      routingPreview = { ok: false, error: 'no_active_store' };
    } else if (analysis.gate === 'none') {
      // Nearest can fulfill — happy path. Surface the chosen store.
      const r = analysis.resolved;
      if (r && !r.error) {
        routingPreview = {
          ok: true,
          gate: 'none',
          store_id:        r.store.id,
          store_code:      r.store.code,
          store_name_en:   r.store.name_en,
          store_name_cn:   r.store.name_cn,
          store_district:  r.store.district,
          routing_reason:  r.reason,
          distance_km:     analysis.nearest?.distance_km ?? null,
          items:           r.items,
        };
      } else if (r?.error === 'no_stock') {
        routingPreview = { ok: false, error: 'no_stock', shortages: r.shortages || [] };
      }
    } else {
      // gate = 'options_5' or 'simple_confirm'. Mini-app picks the right
      // modal. The payload is identical either way; the gate is the hint.
      routingPreview = {
        ok: false,
        gate: analysis.gate,
        nearest: {
          store_id:      analysis.nearest.store.id,
          store_code:    analysis.nearest.store.code,
          store_name_en: analysis.nearest.store.name_en,
          store_name_cn: analysis.nearest.store.name_cn,
          district:      analysis.nearest.store.district,
          distance_km:   analysis.nearest.distance_km,
        },
        fallback: analysis.fallback ? {
          store_id:           analysis.fallback.store.id,
          store_code:         analysis.fallback.store.code,
          store_name_en:      analysis.fallback.store.name_en,
          store_name_cn:      analysis.fallback.store.name_cn,
          district:           analysis.fallback.store.district,
          distance_km:        analysis.fallback.distance_km,
          extra_km:           analysis.fallback.extra_km,
          extra_min_estimate: analysis.fallback.extra_min_estimate,
        } : null,
        missing_items: analysis.missing_items,
      };
    }
  } catch (e) {
    console.error('[checkout/quote routing]', e);
  }

  res.json({
    success: true,
    data: {
      subtotal: priced.subtotal,
      lines: priced.lines || [],
      total_qty: priced.totalQty,
      delivery_fee: fees.deliveryFee,
      packing_fee:  fees.packingFee,
      free_shipping: fees.freeShipping,
      total,
      gross_total: grossTotal,
      payment_method: paymentMethodPreview,
      points_required: pointsRequired,
      points_balance:  pointsBalance,
      points_affordable: pointsAffordable,
      points_redeem_rate: redeemRate,
      points_max_usable:  pointsMaxUsable,
      points_to_use_applied: pointsToUseApplied,
      points_discount: pointsDiscount,
      points_cover_shipping: pointsCoverShipping(),
      points_earned_preview: pointsEarnedFor(priced.subtotal, tierMultiplierFor(req.customer?.tier_key)),
      delivery_mode: deliveryMode,
      zone: {
        id: zone.id,
        zone_type: zone.zone_type,
        name_en: zone.name_en,
        name_cn: zone.name_cn,
        supports_max: zone.zone_type === 'gz_district' && zone.max_fee != null,
        max_fee: zone.max_fee,
        free_threshold: zone.free_threshold,
      },
      scheduling: computeDeliverySlots(zone, new Date()),
      routing: routingPreview,
    },
  });
});

// ─── Top-up packages (customer-facing) ──────────────────────────────────
router.get('/api/retail/topup-packages', requireRetailAuth, (req, res) => {
  const rows = tdb().prepare(
    `SELECT id, amount, bonus_points, title_en, title_cn, description_en, description_cn
       FROM retail_topup_packages WHERE is_active = 1
      ORDER BY sort_order ASC, amount ASC`
  ).all();
  res.json({ success: true, data: rows });
});

// POST /api/retail/topup/create
// Initiates a top-up payment. In DEV mode immediately marks success +
// credits wallet + awards bonus points (mirrors the existing
// retail/payment/create dev-mode flow). In PROD this would hand off to
// the WeChat Pay / Alipay merchant SDK and let the async callback finalize.
router.post('/api/retail/topup/create', requireRetailAuth, express.json(), (req, res) => {
  const packageId    = parseInt(req.body?.package_id, 10);
  const paymentMethod = req.body?.payment_method || 'wechat';
  if (!packageId) return res.status(400).json({ success: false, error: 'package_id_required' });
  if (!['wechat','alipay'].includes(paymentMethod)) return res.status(400).json({ success: false, error: 'invalid_payment_method' });

  const pkg = tdb().prepare('SELECT * FROM retail_topup_packages WHERE id = ? AND is_active = 1').get(packageId);
  if (!pkg) return res.status(404).json({ success: false, error: 'package_not_found' });

  const outTradeNo = `TU${Date.now()}${req.customer.id}`;
  const info = tdb().prepare(
    `INSERT INTO retail_topup_transactions
       (customer_id, package_id, amount, bonus_points, payment_method, status, out_trade_no)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  ).run(req.customer.id, pkg.id, pkg.amount, pkg.bonus_points, paymentMethod, outTradeNo);
  const topupId = info.lastInsertRowid;

  if (payContext().devMode) {
    finalizeTopup(topupId);
    return res.json({
      success: true,
      data: { dev: true, status: 'success', topup_id: topupId, out_trade_no: outTradeNo },
    });
  }

  // PROD: hand off to the merchant SDK. Stub for now — the office can
  // approve the row manually in admin until the merchant cert lands.
  res.json({
    success: true,
    data: { status: 'pending', topup_id: topupId, out_trade_no: outTradeNo, method: paymentMethod },
  });
});

// Marks a top-up successful: credits wallet (amount), awards bonus points,
// writes a points-ledger row. Idempotent. Used both from DEV-mode auto-pay
// and from the real WeChat/Alipay async callbacks.
function finalizeTopup(topupId) {
  const t = tdb().prepare('SELECT * FROM retail_topup_transactions WHERE id = ?').get(topupId);
  if (!t || t.status === 'success') return false;
  sweepExpiredPoints(t.customer_id);
  const expiresAt = nextEarnExpiry();
  const tx = tdb().transaction(() => {
    tdb().prepare(
      "UPDATE retail_topup_transactions SET status = 'success', paid_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'"
    ).run(topupId);
    tdb().prepare(
      'UPDATE retail_customers SET balance = balance + ?, points_balance = points_balance + ? WHERE id = ?'
    ).run(t.amount, t.bonus_points || 0, t.customer_id);
    if (t.bonus_points && t.bonus_points > 0) {
      const after = tdb().prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(t.customer_id).points_balance;
      tdb().prepare(
        `INSERT INTO retail_points_transactions
           (customer_id, delta, balance_after, source, topup_id, note, expires_at)
         VALUES (?, ?, ?, 'topup_bonus', ?, ?, ?)`
      ).run(t.customer_id, t.bonus_points, after, topupId, `Top-up ¥${t.amount} bonus`, expiresAt);
    }
  });
  try { tx(); return true; } catch (e) { console.error('[finalizeTopup]', e); return false; }
}

// Lightweight ledger read for the customer's points/wallet history screens.
router.get('/api/retail/points/transactions', requireRetailAuth, (req, res) => {
  sweepExpiredPoints(req.customer.id);
  const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const rows = tdb().prepare(
    `SELECT id, delta, balance_after, source, order_id, topup_id, note, created_at,
            expires_at, expired_at
       FROM retail_points_transactions WHERE customer_id = ?
      ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(req.customer.id, limit, offset);
  res.json({ success: true, data: rows });
});

router.get('/api/retail/topup/transactions', requireRetailAuth, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const rows = tdb().prepare(
    `SELECT id, amount, bonus_points, payment_method, status, out_trade_no, created_at, paid_at
       FROM retail_topup_transactions WHERE customer_id = ?
      ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(req.customer.id, limit, offset);
  res.json({ success: true, data: rows });
});

// ═══════════════════════════════════════════════════════════════════════
// ADMIN — Delivery zones + Top-up packages CRUD
// ═══════════════════════════════════════════════════════════════════════

// Bilingual catalogue of all GZ districts + all prefecture-level Chinese
// cities, served to the admin UI to populate the delivery-zone dropdowns.
// Static dataset (loaded once at boot from reference/china_regions.json).
const CHINA_REGIONS = require('../reference/china_regions.json');
// Bilingual districts per city (current/complete CN + EN), for the English-mode
// address picker's city→district step. See scripts/build-regions-dataset.js.
const CHINA_DISTRICTS = require('../lib/china_districts.json');

// City → canonical Chinese province, built once from the same dataset. The
// served-zone picker stores only a city for plain 'city' zones, so couriers +
// address records lose the 省. This lets normalizeChinaAddress() backfill the
// province for ANY served city automatically — the same way Guangzhou
// districts already carry 广东省 — without an admin field. Keyed on the city
// name minus its 市/自治州/地区/盟 suffix so '北京市' and '北京' both match.
let _cityProvinceMap = null;
function provinceForCity(city) {
  if (!city) return null;
  if (!_cityProvinceMap) {
    _cityProvinceMap = new Map();
    for (const c of (CHINA_REGIONS.cities || [])) {
      const key = String(c.name_cn || '').replace(/(市|自治州|地区|盟)$/u, '');
      if (key && c.province_cn) _cityProvinceMap.set(key, c.province_cn);
    }
  }
  const key = String(city).replace(/(市|自治州|地区|盟)$/u, '');
  return _cityProvinceMap.get(key) || null;
}

// The full set of locations choosable in the admin delivery section, shaped
// like retail_delivery_zones rows so the customer address picker (which reads
// zone_type / name_* / match_*) can render them unchanged. Built once. The
// customer can pick any of these; pricing is still gated server-side by the
// zone matcher, so a city not yet added in the delivery section resolves no
// fee/slots until the operator adds it. GZ districts first (the live area),
// then all mainland cities A→Z by English name. Hong Kong / Macau are dropped:
// they're 特别行政区 (cross-border customs), not standard domestic SF/JD —
// and SF/JD reach every mainland prefecture city, so nothing else is excluded.
let _regionPickerRows = null;
function regionPickerRows() {
  if (_regionPickerRows) return _regionPickerRows;
  const gz = (CHINA_REGIONS.guangzhou_districts || []).map(d => ({
    id: 'gz:' + d.code,
    zone_type: 'gz_district',
    name_en: d.name_en,
    name_cn: d.name_cn,
    match_city: '广州市',
    match_district: d.name_cn,
  }));
  const cities = (CHINA_REGIONS.cities || [])
    .filter(c => !/特别行政区/.test(c.province_cn || ''))
    .map(c => ({
      id: 'city:' + c.name_cn,
      zone_type: 'city',
      name_en: c.name_en,
      name_cn: c.name_cn,
      match_city: c.name_cn,
      match_district: null,
    }))
    .sort((a, b) => a.name_en.localeCompare(b.name_en));
  _regionPickerRows = [...gz, ...cities];
  return _regionPickerRows;
}

router.get('/api/retail-admin/china-regions', requireRetailAdmin, (req, res) => {
  res.json({
    success: true,
    data: {
      guangzhou_districts: CHINA_REGIONS.guangzhou_districts,
      cities: CHINA_REGIONS.cities,
    },
  });
});

router.get('/api/retail-admin/delivery-zones', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(
    `SELECT * FROM retail_delivery_zones ORDER BY zone_type ASC, sort_order ASC, id ASC`
  ).all();
  res.json({ success: true, data: rows });
});

router.post('/api/retail-admin/delivery-zones', requireRetailAdmin, express.json(), (req, res) => {
  const b = req.body || {};
  if (!['gz_district','city'].includes(b.zone_type)) {
    return res.status(400).json({ success: false, error: 'invalid_zone_type' });
  }
  if (b.zone_type === 'gz_district' && !b.match_district) {
    return res.status(400).json({ success: false, error: 'match_district_required' });
  }
  if (b.zone_type === 'city' && !b.match_city) {
    return res.status(400).json({ success: false, error: 'match_city_required' });
  }
  // Defaults are GZ-friendly: same-day allowed, no surcharge, 10am–8pm
  // 2-hour slots. City zones override min_lead_days to 3 below.
  const defaultMinLead = b.zone_type === 'city' ? 3 : 0;
  const info = tdb().prepare(
    `INSERT INTO retail_delivery_zones
       (zone_type, name_en, name_cn, match_city, match_district, base_fee, max_fee,
        free_threshold, packing_fee_per_item, packing_fee_cap, is_active, sort_order,
        same_day_allowed, same_day_surcharge, min_lead_days, max_lead_days,
        slot_start_hour, slot_end_hour, slot_duration_minutes, day_only)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    b.zone_type, b.name_en || null, b.name_cn || null,
    b.match_city || null, b.match_district || null,
    Number(b.base_fee) || 0,
    b.max_fee != null && b.max_fee !== '' ? Number(b.max_fee) : null,
    b.free_threshold != null && b.free_threshold !== '' ? Number(b.free_threshold) : null,
    Number(b.packing_fee_per_item) || 0,
    b.packing_fee_cap != null && b.packing_fee_cap !== '' ? Number(b.packing_fee_cap) : null,
    b.is_active === 0 ? 0 : 1,
    Number(b.sort_order) || 0,
    b.same_day_allowed === 0 ? 0 : 1,
    Number(b.same_day_surcharge) || 0,
    b.min_lead_days != null ? Number(b.min_lead_days) : defaultMinLead,
    b.max_lead_days != null ? Number(b.max_lead_days) : 14,
    Number(b.slot_start_hour) || 10,
    Number(b.slot_end_hour) || 20,
    Number(b.slot_duration_minutes) || 120,
    // Cities default to day-only; GZ districts default to time-slots unless flipped.
    b.day_only === 1 ? 1 : (b.zone_type === 'city' ? 1 : 0),
  );
  logActivity(req.user.id, req.user.username, 'create', 'delivery_zone', info.lastInsertRowid, b, req.ip);
  res.json({ success: true, data: { id: info.lastInsertRowid } });
});

router.patch('/api/retail-admin/delivery-zones/:id', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const fields = ['name_en','name_cn','match_city','match_district','base_fee','max_fee',
                  'free_threshold','packing_fee_per_item','packing_fee_cap','is_active','sort_order',
                  'same_day_allowed','same_day_surcharge','min_lead_days','max_lead_days',
                  'slot_start_hour','slot_end_hour','slot_duration_minutes','day_only'];
  const numericFields = ['base_fee','max_fee','free_threshold','packing_fee_per_item','packing_fee_cap',
                         'sort_order','same_day_surcharge','min_lead_days','max_lead_days',
                         'slot_start_hour','slot_end_hour','slot_duration_minutes'];
  const sets = [], params = [];
  for (const f of fields) {
    if (!(f in b)) continue;
    sets.push(`${f} = ?`);
    let v = b[f];
    if (numericFields.includes(f)) {
      v = (v == null || v === '') ? null : Number(v);
    }
    if (f === 'is_active' || f === 'same_day_allowed' || f === 'day_only') v = v ? 1 : 0;
    if (['base_fee','packing_fee_per_item','sort_order','same_day_surcharge','min_lead_days','max_lead_days',
         'slot_start_hour','slot_end_hour','slot_duration_minutes'].includes(f) && v == null) v = 0;
    params.push(v);
  }
  if (!sets.length) return res.status(400).json({ success: false, error: 'no_fields' });
  sets.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  const r = tdb().prepare(`UPDATE retail_delivery_zones SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (r.changes === 0) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'update', 'delivery_zone', id, b, req.ip);
  res.json({ success: true });
});

router.delete('/api/retail-admin/delivery-zones/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = tdb().prepare('DELETE FROM retail_delivery_zones WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'delete', 'delivery_zone', id, null, req.ip);
  res.json({ success: true });
});

// Top-up packages CRUD
router.get('/api/retail-admin/topup-packages', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(
    `SELECT * FROM retail_topup_packages ORDER BY sort_order ASC, amount ASC`
  ).all();
  res.json({ success: true, data: rows });
});

router.post('/api/retail-admin/topup-packages', requireRetailAdmin, express.json(), (req, res) => {
  const b = req.body || {};
  if (!(Number(b.amount) > 0)) return res.status(400).json({ success: false, error: 'amount_required' });
  const info = tdb().prepare(
    `INSERT INTO retail_topup_packages
       (amount, bonus_points, title_en, title_cn, description_en, description_cn, is_active, sort_order)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    Number(b.amount),
    Math.max(0, parseInt(b.bonus_points, 10) || 0),
    b.title_en || null, b.title_cn || null,
    b.description_en || null, b.description_cn || null,
    b.is_active === 0 ? 0 : 1,
    Number(b.sort_order) || 0,
  );
  logActivity(req.user.id, req.user.username, 'create', 'topup_package', info.lastInsertRowid, b, req.ip);
  res.json({ success: true, data: { id: info.lastInsertRowid } });
});

router.patch('/api/retail-admin/topup-packages/:id', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const fields = ['amount','bonus_points','title_en','title_cn','description_en','description_cn','is_active','sort_order'];
  const sets = [], params = [];
  for (const f of fields) {
    if (!(f in b)) continue;
    sets.push(`${f} = ?`);
    let v = b[f];
    if (['amount','sort_order'].includes(f)) v = Number(v) || 0;
    if (f === 'bonus_points') v = Math.max(0, parseInt(v, 10) || 0);
    if (f === 'is_active') v = v ? 1 : 0;
    params.push(v);
  }
  if (!sets.length) return res.status(400).json({ success: false, error: 'no_fields' });
  sets.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  const r = tdb().prepare(`UPDATE retail_topup_packages SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (r.changes === 0) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'update', 'topup_package', id, b, req.ip);
  res.json({ success: true });
});

router.delete('/api/retail-admin/topup-packages/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = tdb().prepare('DELETE FROM retail_topup_packages WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'delete', 'topup_package', id, null, req.ip);
  res.json({ success: true });
});

// Top-up transactions view (read-only for support)
router.get('/api/retail-admin/topup-transactions', requireRetailAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const rows = tdb().prepare(
    `SELECT t.id, t.customer_id, c.nickname, c.phone, t.amount, t.bonus_points,
            t.payment_method, t.status, t.out_trade_no, t.created_at, t.paid_at
       FROM retail_topup_transactions t
       LEFT JOIN retail_customers c ON c.id = t.customer_id
      ORDER BY t.id DESC LIMIT ?`
  ).all(limit);
  res.json({ success: true, data: rows });
});

// Manually finalize a stuck top-up (when WeChat callback doesn't fire — e.g.
// the cert/merchant config isn't in place yet). Idempotent.
router.post('/api/retail-admin/topup-transactions/:id/finalize', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ok = finalizeTopup(id);
  logActivity(req.user.id, req.user.username, 'finalize', 'topup_transaction', id, null, req.ip);
  res.json({ success: true, data: { ok } });
});

// ─── Leaderboard ────────────────────────────────────────────────────────
// Customer-facing ranked list of top members, driven entirely by config
// in `storefront_config` under the `leaderboard.config` key. The mini app
// shows the leaderboard read-only; staff build / edit the config from the
// retail-admin "Leaderboard" tab.

const LEADERBOARD_DEFAULTS = {
  enabled:         false,
  title_en:        'Top growers',
  title_cn:        '排行榜',
  kicker_en:       'ROOTS CLUB · LEADERBOARD',
  kicker_cn:       'ROOTS 会员 · 排行榜',
  subhead_en:      'The members who keep our garden growing.',
  subhead_cn:      '让花园持续生长的会员们。',
  metric:          'lifetime_spend',           // lifetime_spend | points_balance | orders_count
  period:          'all',                      // all | year | month | week
  top_n:           20,
  reveal_mode:     'first_char',               // full | first_char | masked
  reward_top1_en:  '',
  reward_top1_cn:  '',
  reward_top3_en:  '',
  reward_top3_cn:  '',
  reward_top10_en: '',
  reward_top10_cn: '',
};

function loadLeaderboardConfig() {
  const row = tdb().prepare("SELECT value_json FROM storefront_config WHERE key = 'leaderboard.config'").get();
  if (!row) return { ...LEADERBOARD_DEFAULTS };
  let parsed;
  try { parsed = JSON.parse(row.value_json); }
  catch { parsed = {}; }
  return { ...LEADERBOARD_DEFAULTS, ...(parsed || {}) };
}

function periodCutoffSqlExpr(period) {
  // SQLite date math against placed_at. Returns null if period is 'all'.
  if (period === 'year')  return "datetime('now', '-1 year')";
  if (period === 'month') return "datetime('now', '-1 month')";
  if (period === 'week')  return "datetime('now', '-7 days')";
  return null;
}

// Orders that count toward the leaderboard — paid, not cancelled, not refunded.
const LEADERBOARD_ORDER_FILTER = "status NOT IN ('pending_payment', 'cancelled', 'refunded')";

function computeLeaderboard(cfg) {
  const topN = Math.max(1, Math.min(100, parseInt(cfg.top_n, 10) || 20));
  const period = cfg.period || 'all';
  const cutoff = periodCutoffSqlExpr(period);

  let rows;
  if (cfg.metric === 'lifetime_spend') {
    if (cutoff) {
      rows = tdb().prepare(
        `SELECT c.id, c.nickname, c.avatar_url, c.tier_key,
                COALESCE(SUM(o.total), 0) AS value
           FROM retail_customers c
      LEFT JOIN retail_orders o
             ON o.customer_id = c.id
            AND ${LEADERBOARD_ORDER_FILTER}
            AND o.placed_at >= ${cutoff}
          WHERE c.is_blocked = 0
          GROUP BY c.id
         HAVING value > 0
          ORDER BY value DESC, c.id ASC
          LIMIT ?`
      ).all(topN);
    } else {
      rows = tdb().prepare(
        `SELECT id, nickname, avatar_url, tier_key, lifetime_spend AS value
           FROM retail_customers
          WHERE is_blocked = 0 AND lifetime_spend > 0
          ORDER BY lifetime_spend DESC, id ASC
          LIMIT ?`
      ).all(topN);
    }
  } else if (cfg.metric === 'orders_count') {
    rows = tdb().prepare(
      `SELECT c.id, c.nickname, c.avatar_url, c.tier_key,
              COUNT(o.id) AS value
         FROM retail_customers c
    LEFT JOIN retail_orders o
           ON o.customer_id = c.id
          AND ${LEADERBOARD_ORDER_FILTER}
          ${cutoff ? `AND o.placed_at >= ${cutoff}` : ''}
        WHERE c.is_blocked = 0
        GROUP BY c.id
       HAVING value > 0
        ORDER BY value DESC, c.id ASC
        LIMIT ?`
    ).all(topN);
  } else { // points_balance — point-in-time, period is ignored
    rows = tdb().prepare(
      `SELECT id, nickname, avatar_url, tier_key, points_balance AS value
         FROM retail_customers
        WHERE is_blocked = 0 AND points_balance > 0
        ORDER BY points_balance DESC, id ASC
        LIMIT ?`
    ).all(topN);
  }

  return rows.map((r, i) => ({
    rank: i + 1,
    customer_id: r.id,
    nickname: r.nickname || '',
    avatar_url: r.avatar_url || '',
    tier_key: r.tier_key || 'seed',
    value: Number(r.value) || 0,
  }));
}

function maskNickname(nickname, mode) {
  const s = String(nickname || '').trim();
  if (!s) return mode === 'masked' ? '会员' : 'Member';
  if (mode === 'full') return s;
  if (mode === 'first_char') {
    // Show first character + asterisks (CJK-friendly — counts code points).
    const chars = Array.from(s);
    if (chars.length <= 1) return chars[0] + '*';
    return chars[0] + '*'.repeat(Math.min(3, chars.length - 1));
  }
  // masked: hide entirely
  return '**';
}

function applyRevealMode(entry, mode) {
  return {
    rank: entry.rank,
    name: maskNickname(entry.nickname, mode),
    avatar_url: mode === 'full' ? entry.avatar_url : '',
    tier_key: entry.tier_key,
    value: entry.value,
  };
}

// Customer-facing leaderboard. Token-auth so the response can include the
// caller's own rank. Disabled config returns 404 so the mini app hides the
// entry point cleanly.
router.get('/api/retail/leaderboard', requireRetailAuth, (req, res) => {
  const cfg = loadLeaderboardConfig();
  if (!cfg.enabled) return res.status(404).json({ success: false, error: 'leaderboard_disabled' });

  const board = computeLeaderboard(cfg);
  const mine = board.find(b => b.customer_id === req.customer.id);
  // If the caller isn't in the top N, compute their absolute rank for the
  // "you are #N" footer — only when there's a value to rank against.
  let myRank = mine ? mine.rank : null;
  let myValue = mine ? mine.value : 0;
  if (!mine) {
    if (cfg.metric === 'lifetime_spend') {
      myValue = Number(req.customer.lifetime_spend) || 0;
      if (myValue > 0) {
        const ahead = tdb().prepare(
          `SELECT COUNT(*) AS n FROM retail_customers
            WHERE is_blocked = 0 AND lifetime_spend > ?`
        ).get(myValue).n;
        myRank = ahead + 1;
      }
    } else if (cfg.metric === 'points_balance') {
      myValue = Number(req.customer.points_balance) || 0;
      if (myValue > 0) {
        const ahead = tdb().prepare(
          `SELECT COUNT(*) AS n FROM retail_customers
            WHERE is_blocked = 0 AND points_balance > ?`
        ).get(myValue).n;
        myRank = ahead + 1;
      }
    }
    // orders_count rank-when-not-in-top-N would need an extra aggregate;
    // skip for now — UI shows "Not ranked yet" in that case.
  }

  res.set('Cache-Control', 'private, max-age=30');
  res.json({
    success: true,
    data: {
      config: {
        title_en:        cfg.title_en,
        title_cn:        cfg.title_cn,
        kicker_en:       cfg.kicker_en,
        kicker_cn:       cfg.kicker_cn,
        subhead_en:      cfg.subhead_en,
        subhead_cn:      cfg.subhead_cn,
        metric:          cfg.metric,
        period:          cfg.period,
        reward_top1_en:  cfg.reward_top1_en,
        reward_top1_cn:  cfg.reward_top1_cn,
        reward_top3_en:  cfg.reward_top3_en,
        reward_top3_cn:  cfg.reward_top3_cn,
        reward_top10_en: cfg.reward_top10_en,
        reward_top10_cn: cfg.reward_top10_cn,
      },
      entries: board.map(b => applyRevealMode(b, cfg.reveal_mode)),
      me: {
        rank: myRank,
        value: myValue,
        in_top_n: !!mine,
      },
      generated_at: new Date().toISOString(),
    },
  });
});

// Admin: load config (returns defaults if not yet set so the form is
// pre-filled).
router.get('/api/retail-admin/leaderboard/config', requireRetailAdmin, (req, res) => {
  res.json({ success: true, data: loadLeaderboardConfig() });
});

// Admin: save config. Full replace (no PATCH) — the form posts every field.
router.put('/api/retail-admin/leaderboard/config', requireRetailAdmin, express.json(), (req, res) => {
  const body = req.body || {};
  const allowedMetrics = ['lifetime_spend', 'points_balance', 'orders_count'];
  const allowedPeriods = ['all', 'year', 'month', 'week'];
  const allowedReveal  = ['full', 'first_char', 'masked'];

  const next = {
    enabled:         !!body.enabled,
    title_en:        String(body.title_en || '').slice(0, 80) || LEADERBOARD_DEFAULTS.title_en,
    title_cn:        String(body.title_cn || '').slice(0, 80) || LEADERBOARD_DEFAULTS.title_cn,
    kicker_en:       String(body.kicker_en || '').slice(0, 80),
    kicker_cn:       String(body.kicker_cn || '').slice(0, 80),
    subhead_en:      String(body.subhead_en || '').slice(0, 240),
    subhead_cn:      String(body.subhead_cn || '').slice(0, 240),
    metric:          allowedMetrics.includes(body.metric) ? body.metric : LEADERBOARD_DEFAULTS.metric,
    period:          allowedPeriods.includes(body.period) ? body.period : LEADERBOARD_DEFAULTS.period,
    top_n:           Math.max(3, Math.min(100, parseInt(body.top_n, 10) || LEADERBOARD_DEFAULTS.top_n)),
    reveal_mode:     allowedReveal.includes(body.reveal_mode) ? body.reveal_mode : LEADERBOARD_DEFAULTS.reveal_mode,
    reward_top1_en:  String(body.reward_top1_en  || '').slice(0, 240),
    reward_top1_cn:  String(body.reward_top1_cn  || '').slice(0, 240),
    reward_top3_en:  String(body.reward_top3_en  || '').slice(0, 240),
    reward_top3_cn:  String(body.reward_top3_cn  || '').slice(0, 240),
    reward_top10_en: String(body.reward_top10_en || '').slice(0, 240),
    reward_top10_cn: String(body.reward_top10_cn || '').slice(0, 240),
  };

  tdb().prepare(
    `INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
     VALUES (?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = CURRENT_TIMESTAMP,
       updated_by = excluded.updated_by`
  ).run('leaderboard.config', JSON.stringify(next), req.user.id);

  logActivity(req.user.id, req.user.username, 'update', 'leaderboard_config', null, { enabled: next.enabled, metric: next.metric, period: next.period }, req.ip);
  res.json({ success: true, data: next });
});

// Admin: preview leaderboard data (uses current config, ignores enabled
// flag, returns full nicknames + reveal applied separately so the editor
// can preview the mini-app view at any reveal mode).
router.get('/api/retail-admin/leaderboard/preview', requireRetailAdmin, (req, res) => {
  const cfg = loadLeaderboardConfig();
  const board = computeLeaderboard(cfg);
  res.json({
    success: true,
    data: {
      config: cfg,
      raw_entries: board,
      revealed_entries: board.map(b => applyRevealMode(b, cfg.reveal_mode)),
    },
  });
});

// Public storefront leaderboard — feeds the CMS `leaderboard` block. Params
// come from the block itself (metric/period/top_n/reveal_mode), so an admin
// can drop multiple leaderboards onto a page with different shapes. No auth
// (storefront blocks render anonymously); the response omits the per-user
// "my rank" footer that /api/retail/leaderboard returns.
//
// Cached 10 min in-process, keyed on (metric, period, top_n) — reveal mode
// is applied AFTER the cache so changing names-only doesn't blow it away.
const _leaderboardBlockCache = new Map();   // key -> { t, entries }
const LEADERBOARD_BLOCK_TTL_MS = 10 * 60 * 1000;

router.get('/api/retail/storefront/leaderboard', (req, res) => {
  const allowedMetrics = ['lifetime_spend', 'points_balance', 'orders_count'];
  const allowedPeriods = ['all', 'year', 'month', 'week'];
  const allowedReveal  = ['full', 'first_char', 'masked'];

  const metric = allowedMetrics.includes(req.query.metric) ? req.query.metric : 'lifetime_spend';
  const period = allowedPeriods.includes(req.query.period) ? req.query.period : 'month';
  const top_n  = Math.max(3, Math.min(10, parseInt(req.query.top_n, 10) || 5));
  const reveal_mode = allowedReveal.includes(req.query.reveal_mode) ? req.query.reveal_mode : 'first_char';

  const key = `${metric}|${period}|${top_n}`;
  const now = Date.now();
  let cached = _leaderboardBlockCache.get(key);
  if (!cached || (now - cached.t) > LEADERBOARD_BLOCK_TTL_MS) {
    const raw = computeLeaderboard({ metric, period, top_n });
    cached = { t: now, entries: raw };
    _leaderboardBlockCache.set(key, cached);
  }

  const revealed = cached.entries.map(e => applyRevealMode(e, reveal_mode));
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    success: true,
    data: {
      metric, period, top_n, reveal_mode,
      entries: revealed,
      generated_at: new Date(cached.t).toISOString(),
    },
  });
});

// ─── Voting / community polls ───────────────────────────────────────────
// Mini-app design page #23. Customers vote one option per poll, earn
// `reward_points` (default 5) once per (poll, customer). Admin builds and
// closes polls from the retail-admin Voting tab.

function loadPollOptions(pollId) {
  return tdb().prepare(
    `SELECT id, label_en, label_cn, color_hex, image_url, sort_order, votes
       FROM retail_poll_options
      WHERE poll_id = ?
      ORDER BY sort_order, id`
  ).all(pollId);
}

// Hydrate a poll row with options + caller's vote (if any).
function hydratePoll(poll, customerId) {
  if (!poll) return null;
  const options = loadPollOptions(poll.id);
  let myVoteOptionId = null;
  if (customerId) {
    const v = tdb().prepare('SELECT option_id FROM retail_poll_votes WHERE poll_id = ? AND customer_id = ?')
      .get(poll.id, customerId);
    if (v) myVoteOptionId = v.option_id;
  }
  return { ...poll, options, my_vote_option_id: myVoteOptionId };
}

// Customer-facing list — only `open` and `closed` polls (drafts hidden).
router.get('/api/retail/polls', requireRetailAuth, (req, res) => {
  const rows = tdb().prepare(
    `SELECT * FROM retail_polls
      WHERE status IN ('open', 'closed')
      ORDER BY
        CASE status WHEN 'open' THEN 0 WHEN 'closed' THEN 1 ELSE 2 END,
        is_featured DESC,
        sort_order,
        id DESC
      LIMIT 50`
  ).all();
  const hydrated = rows.map(p => hydratePoll(p, req.customer.id));
  res.json({ success: true, data: hydrated });
});

// Single poll detail — useful for share-link landing pages.
router.get('/api/retail/polls/:id', requireRetailAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const poll = tdb().prepare(
    `SELECT * FROM retail_polls
      WHERE id = ? AND status IN ('open', 'closed')`
  ).get(id);
  if (!poll) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true, data: hydratePoll(poll, req.customer.id) });
});

// Cast a vote. Idempotent on (poll, customer) — second call returns the
// existing vote without double-awarding points.
router.post('/api/retail/polls/:id/vote', requireRetailAuth, express.json(), (req, res) => {
  const pollId   = parseInt(req.params.id, 10);
  const optionId = parseInt(req.body?.option_id, 10);
  if (!pollId || !optionId) return res.status(400).json({ success: false, error: 'bad_request' });

  const poll = tdb().prepare('SELECT id, status, reward_points FROM retail_polls WHERE id = ?').get(pollId);
  if (!poll) return res.status(404).json({ success: false, error: 'not_found' });
  if (poll.status !== 'open') return res.status(409).json({ success: false, error: 'poll_not_open' });

  const opt = tdb().prepare('SELECT id FROM retail_poll_options WHERE id = ? AND poll_id = ?').get(optionId, pollId);
  if (!opt) return res.status(400).json({ success: false, error: 'bad_option' });

  const existing = tdb().prepare('SELECT id, option_id FROM retail_poll_votes WHERE poll_id = ? AND customer_id = ?')
    .get(pollId, req.customer.id);
  if (existing) {
    // Already voted — return current state, do NOT re-award.
    return res.json({
      success: true,
      data: { already_voted: true, poll: hydratePoll(tdb().prepare('SELECT * FROM retail_polls WHERE id = ?').get(pollId), req.customer.id) },
    });
  }

  const reward = Math.max(0, parseInt(poll.reward_points, 10) || 0);
  const tx = tdb().transaction(() => {
    tdb().prepare(
      `INSERT INTO retail_poll_votes (poll_id, option_id, customer_id, awarded_points)
       VALUES (?, ?, ?, ?)`
    ).run(pollId, optionId, req.customer.id, reward);
    tdb().prepare('UPDATE retail_poll_options SET votes = votes + 1 WHERE id = ?').run(optionId);
    tdb().prepare('UPDATE retail_polls SET total_votes = total_votes + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(pollId);
    if (reward > 0) {
      tdb().prepare('UPDATE retail_customers SET points_balance = points_balance + ? WHERE id = ?')
        .run(reward, req.customer.id);
      const after = tdb().prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(req.customer.id).points_balance;
      tdb().prepare(
        `INSERT INTO retail_points_transactions (customer_id, delta, balance_after, source, note)
         VALUES (?, ?, ?, 'poll_vote', ?)`
      ).run(req.customer.id, reward, after, 'Poll #' + pollId);
    }
  });
  try { tx(); }
  catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.json({ success: true, data: { already_voted: true } });
    }
    throw e;
  }

  const updatedPoll = tdb().prepare('SELECT * FROM retail_polls WHERE id = ?').get(pollId);
  const updatedCust = tdb().prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(req.customer.id);
  res.json({
    success: true,
    data: {
      poll: hydratePoll(updatedPoll, req.customer.id),
      awarded_points: reward,
      points_balance: updatedCust.points_balance,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════
// FAVORITES — saved / wishlisted products. Backs the Favorites page
// (NO. 21) and the home "favorites" block. All endpoints require a
// retail-auth token; UNIQUE(customer, product) keeps add/remove
// idempotent. ─────────────────────────────────────────────────────────
router.get('/api/retail/favorites', requireRetailAuth, (req, res) => {
  const now = Date.now();
  const rows = tdb().prepare(
    `SELECT ${RETAIL_PRODUCT_COLS}, f.created_at AS favorited_at
       FROM retail_customer_favorites f
       JOIN products p ON p.id = f.product_id
      WHERE f.customer_id = ?
        AND p.is_published = 1
        AND COALESCE(p.is_active, 1) = 1
      ORDER BY f.created_at DESC`
  ).all(req.customer.id)
    .map(hydrateNutrition)
    .map(r => flashsales.decorateProduct(r, now));
  res.json({ success: true, data: rows, meta: { count: rows.length, server_time_ms: now } });
});

// Lightweight version — just the product ids. Used by the Product page
// to render the heart pip in its filled/empty state without paying for
// the full product columns. Cached briefly per-customer.
router.get('/api/retail/favorites/ids', requireRetailAuth, (req, res) => {
  const ids = tdb().prepare(
    `SELECT product_id FROM retail_customer_favorites WHERE customer_id = ?`
  ).all(req.customer.id).map(r => r.product_id);
  res.json({ success: true, data: ids });
});

router.post('/api/retail/favorites/:productId', requireRetailAuth, (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  if (!productId) return res.status(400).json({ success: false, error: 'bad_request' });
  const prod = tdb().prepare('SELECT id FROM products WHERE id = ? AND is_published = 1 AND COALESCE(is_active, 1) = 1').get(productId);
  if (!prod) return res.status(404).json({ success: false, error: 'product_not_found' });
  try {
    tdb().prepare(
      `INSERT OR IGNORE INTO retail_customer_favorites (customer_id, product_id)
       VALUES (?, ?)`
    ).run(req.customer.id, productId);
  } catch (e) {
    return res.status(500).json({ success: false, error: 'db_insert_failed' });
  }
  const count = tdb().prepare('SELECT COUNT(*) AS n FROM retail_customer_favorites WHERE customer_id = ?').get(req.customer.id).n;
  res.json({ success: true, data: { favorited: true, count } });
});

router.delete('/api/retail/favorites/:productId', requireRetailAuth, (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  if (!productId) return res.status(400).json({ success: false, error: 'bad_request' });
  tdb().prepare('DELETE FROM retail_customer_favorites WHERE customer_id = ? AND product_id = ?')
    .run(req.customer.id, productId);
  const count = tdb().prepare('SELECT COUNT(*) AS n FROM retail_customer_favorites WHERE customer_id = ?').get(req.customer.id).n;
  res.json({ success: true, data: { favorited: false, count } });
});

// ─── Voting · Admin ─────────────────────────────────────────────────────

// Allowed status values (kept narrow so the UI's chip filters can map 1:1).
const POLL_STATUSES = new Set(['draft', 'open', 'closed']);

router.get('/api/retail-admin/polls', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(
    `SELECT * FROM retail_polls
      ORDER BY
        CASE status WHEN 'open' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
        is_featured DESC,
        sort_order,
        id DESC`
  ).all();
  const out = rows.map(p => ({ ...p, options: loadPollOptions(p.id) }));
  res.json({ success: true, data: out });
});

router.get('/api/retail-admin/polls/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const poll = tdb().prepare('SELECT * FROM retail_polls WHERE id = ?').get(id);
  if (!poll) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true, data: { ...poll, options: loadPollOptions(id) } });
});

// Validate + normalize an options array from the admin form. Returns an
// array of clean { label_en, label_cn, color_hex, image_url, sort_order }.
function normalizePollOptions(rawOpts) {
  const arr = Array.isArray(rawOpts) ? rawOpts : [];
  const out = [];
  arr.forEach((o, i) => {
    const label_en = String(o?.label_en || '').trim().slice(0, 60);
    if (!label_en) return;                 // skip blank rows
    out.push({
      label_en,
      label_cn:   String(o?.label_cn || '').trim().slice(0, 60),
      color_hex:  String(o?.color_hex || '').trim().slice(0, 16),
      image_url:  String(o?.image_url || '').trim().slice(0, 500),
      sort_order: Number.isFinite(Number(o?.sort_order)) ? parseInt(o.sort_order, 10) : i,
    });
  });
  return out;
}

router.post('/api/retail-admin/polls', requireRetailAdmin, express.json(), (req, res) => {
  const b = req.body || {};
  const question_en = String(b.question_en || '').trim();
  if (!question_en) return res.status(400).json({ success: false, error: 'question_required' });
  const status = POLL_STATUSES.has(b.status) ? b.status : 'draft';
  const options = normalizePollOptions(b.options);
  if (options.length < 2) return res.status(400).json({ success: false, error: 'need_at_least_two_options' });

  const tx = tdb().transaction(() => {
    const r = tdb().prepare(
      `INSERT INTO retail_polls
        (question_en, question_cn, explainer_en, explainer_cn, category_en, category_cn,
         status, closes_at, reward_points, is_featured, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      question_en,
      String(b.question_cn || '').trim() || null,
      String(b.explainer_en || '').trim() || null,
      String(b.explainer_cn || '').trim() || null,
      String(b.category_en || '').trim() || null,
      String(b.category_cn || '').trim() || null,
      status,
      b.closes_at || null,
      Math.max(0, parseInt(b.reward_points, 10) || 5),
      b.is_featured ? 1 : 0,
      parseInt(b.sort_order, 10) || 0,
    );
    const pollId = r.lastInsertRowid;
    const insOpt = tdb().prepare(
      `INSERT INTO retail_poll_options (poll_id, label_en, label_cn, color_hex, image_url, sort_order)
       VALUES (?,?,?,?,?,?)`
    );
    for (const o of options) {
      insOpt.run(pollId, o.label_en, o.label_cn || null, o.color_hex || null, o.image_url || null, o.sort_order);
    }
    return pollId;
  });
  const pollId = tx();
  logActivity(req.user.id, req.user.username, 'create', 'retail_poll', pollId, { question_en, status }, req.ip);
  const poll = tdb().prepare('SELECT * FROM retail_polls WHERE id = ?').get(pollId);
  res.json({ success: true, data: { ...poll, options: loadPollOptions(pollId) } });
});

router.put('/api/retail-admin/polls/:id', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const poll = tdb().prepare('SELECT * FROM retail_polls WHERE id = ?').get(id);
  if (!poll) return res.status(404).json({ success: false, error: 'not_found' });

  const b = req.body || {};
  const updates = {};
  const fields = ['question_en','question_cn','explainer_en','explainer_cn',
                  'category_en','category_cn','closes_at'];
  for (const f of fields) {
    if (f in b) updates[f] = (b[f] === '' || b[f] == null) ? null : String(b[f]);
  }
  if ('status' in b) {
    if (!POLL_STATUSES.has(b.status)) return res.status(400).json({ success: false, error: 'bad_status' });
    updates.status = b.status;
  }
  if ('reward_points' in b)  updates.reward_points = Math.max(0, parseInt(b.reward_points, 10) || 0);
  if ('is_featured' in b)    updates.is_featured   = b.is_featured ? 1 : 0;
  if ('sort_order' in b)     updates.sort_order    = parseInt(b.sort_order, 10) || 0;
  if ('winner_option_id' in b) {
    const wid = parseInt(b.winner_option_id, 10);
    if (wid) {
      const own = tdb().prepare('SELECT id FROM retail_poll_options WHERE id = ? AND poll_id = ?').get(wid, id);
      if (!own) return res.status(400).json({ success: false, error: 'bad_winner_option' });
      updates.winner_option_id = wid;
    } else {
      updates.winner_option_id = null;
    }
  }

  // Options replace-all. Editing existing options renames them in place if
  // their id is sent back; otherwise we drop + reinsert. To keep this
  // simple AND preserve vote counts, only do a full reset when the caller
  // explicitly says `replace_options: true`. Otherwise we update labels /
  // colors / order on the existing rows by id.
  const incomingOptions = Array.isArray(b.options) ? b.options : null;

  const tx = tdb().transaction(() => {
    if (Object.keys(updates).length) {
      const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      tdb().prepare(`UPDATE retail_polls SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(...Object.values(updates), id);
    }
    if (incomingOptions) {
      if (b.replace_options) {
        // Hard reset — clears votes! Confirms required from the UI.
        tdb().prepare('DELETE FROM retail_poll_options WHERE poll_id = ?').run(id);
        tdb().prepare('UPDATE retail_polls SET total_votes = 0 WHERE id = ?').run(id);
        const normalized = normalizePollOptions(incomingOptions);
        const insOpt = tdb().prepare(
          `INSERT INTO retail_poll_options (poll_id, label_en, label_cn, color_hex, image_url, sort_order)
           VALUES (?,?,?,?,?,?)`
        );
        for (const o of normalized) {
          insOpt.run(id, o.label_en, o.label_cn || null, o.color_hex || null, o.image_url || null, o.sort_order);
        }
      } else {
        // In-place edit / add — preserve vote counts on existing rows.
        const existingIds = new Set(tdb().prepare('SELECT id FROM retail_poll_options WHERE poll_id = ?').all(id).map(r => r.id));
        const seenIds = new Set();
        const upd = tdb().prepare(
          `UPDATE retail_poll_options SET
             label_en = ?, label_cn = ?, color_hex = ?, image_url = ?, sort_order = ?
           WHERE id = ? AND poll_id = ?`
        );
        const ins = tdb().prepare(
          `INSERT INTO retail_poll_options (poll_id, label_en, label_cn, color_hex, image_url, sort_order)
           VALUES (?,?,?,?,?,?)`
        );
        incomingOptions.forEach((o, i) => {
          const labelEn = String(o?.label_en || '').trim().slice(0, 60);
          if (!labelEn) return;
          const labelCn = String(o?.label_cn || '').trim().slice(0, 60) || null;
          const color   = String(o?.color_hex || '').trim().slice(0, 16) || null;
          const img     = String(o?.image_url || '').trim().slice(0, 500) || null;
          const sortVal = Number.isFinite(Number(o?.sort_order)) ? parseInt(o.sort_order, 10) : i;
          const oid     = parseInt(o?.id, 10);
          if (oid && existingIds.has(oid)) {
            upd.run(labelEn, labelCn, color, img, sortVal, oid, id);
            seenIds.add(oid);
          } else {
            ins.run(id, labelEn, labelCn, color, img, sortVal);
          }
        });
        // Remove options the caller dropped from the form.
        for (const oldId of existingIds) {
          if (!seenIds.has(oldId)) {
            // Refuse to delete an option that has votes — admin must
            // either close the poll (winner pick) or hard-reset.
            const votes = tdb().prepare('SELECT votes FROM retail_poll_options WHERE id = ?').get(oldId)?.votes || 0;
            if (votes > 0) continue;
            tdb().prepare('DELETE FROM retail_poll_options WHERE id = ?').run(oldId);
          }
        }
      }
    }
  });
  try { tx(); }
  catch (e) {
    // Don't leak raw SQLite text to the client — log it, return a stable code.
    console.error('[poll update]', id, e);
    return res.status(500).json({ success: false, error: 'update_failed' });
  }

  logActivity(req.user.id, req.user.username, 'update', 'retail_poll', id, { updates: Object.keys(updates), replaced_options: !!(incomingOptions && b.replace_options) }, req.ip);
  const fresh = tdb().prepare('SELECT * FROM retail_polls WHERE id = ?').get(id);
  res.json({ success: true, data: { ...fresh, options: loadPollOptions(id) } });
});

router.delete('/api/retail-admin/polls/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = tdb().prepare('DELETE FROM retail_polls WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'delete', 'retail_poll', id, null, req.ip);
  res.json({ success: true });
});

module.exports = router;
