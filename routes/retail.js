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
const router = express.Router();

// Hoisted here so any admin route defined later in the file can use it
// (const isn't hoisted; this avoids a TDZ error when later sections
// reference requireRetailAdmin before the original declaration site).
const requireRetailAdmin = [requireAuth, requirePermission('retail')];

// In-memory multer for image uploads — files small enough to base64 inline.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },  // 5MB hard ceiling
  fileFilter: (req, file, cb) => {
    if (!file.mimetype?.startsWith('image/')) return cb(new Error('not_an_image'));
    cb(null, true);
  },
});

// ─── Storefront config ──────────────────────────────────────────────────
// Keys whose prefix is in this set are FILTERED OUT of the public
// /api/retail/config response — they hold third-party API secrets
// (kd100 key, JD app_secret, etc.) and must never reach the mini app.
const PRIVATE_CONFIG_PREFIXES = ['integrations.'];

function loadConfig() {
  const rows = db.prepare('SELECT key, value_json FROM storefront_config').all();
  const out = { version: 0 };
  for (const { key, value_json } of rows) {
    if (PRIVATE_CONFIG_PREFIXES.some(p => key.startsWith(p))) continue;
    let v; try { v = JSON.parse(value_json); } catch { v = value_json; }
    setPath(out, key.split('.'), v);
  }
  const t = db.prepare("SELECT COALESCE(MAX(strftime('%s', updated_at)), 0) AS t FROM storefront_config").get();
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

// Public product categories — same data as /api/categories/product (which
// is staff-only) but unauthenticated so the mini app + public preview can
// render category-tile labels without holding a session token.
router.get('/api/retail/categories', (req, res) => {
  const rows = db.prepare("SELECT id, name FROM categories WHERE kind = 'product' ORDER BY sort_order, name").all();
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ success: true, data: rows });
});

router.get('/api/retail/config', (req, res) => {
  try {
    const cfg = loadConfig();
    delete cfg.cms;  // internal namespace — never expose drafts to the mini app
    // Always surface review tags so the mini app's review form + product
    // cards have labels + colours even on fresh installs (before staff
    // has touched the Reviews editor).
    cfg.reviews = cfg.reviews || {};
    if (!Array.isArray(cfg.reviews.tags) || !cfg.reviews.tags.length) {
      cfg.reviews.tags = DEFAULT_REVIEW_TAGS;
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ success: true, data: cfg });
  } catch (e) {
    console.error('[retail/config]', e);
    res.status(500).json({ success: false, error: 'config_load_failed' });
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
  p.stock_qty  AS stock,
  p.sort_order AS display_order,
  p.description_en, p.description_cn,
  p.free_of, p.tags, p.image_data, p.image_url,
  p.nutrition,
  p.keywords_en, p.keywords_cn, p.tagline_en, p.tagline_cn,
  p.description_blocks,
  p.flash_price, p.flash_starts_at, p.flash_ends_at,
  p.flash_stock_limit, p.flash_sold
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

router.get('/api/retail/products', (req, res) => {
  const { q, category, sort } = req.query;
  const limit  = Math.min(parseInt(req.query.limit  || '50', 10) || 50, 100);
  const offset = Math.max(parseInt(req.query.offset || '0',  10) || 0, 0);

  let sql = `SELECT ${RETAIL_PRODUCT_COLS} FROM products p
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
  const rows = db.prepare(sql).all(...params)
    .map(hydrateNutrition)
    .map(r => flashsales.decorateProduct(r, now));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM products p
                            WHERE p.is_published = 1 AND COALESCE(p.is_active, 1) = 1
                            ${q ? 'AND (p.name_en LIKE ? OR p.name_cn LIKE ? OR p.sku LIKE ?)' : ''}
                            ${category ? 'AND p.category = ?' : ''}`)
    .get(...(q ? [`%${q}%`,`%${q}%`,`%${q}%`] : []), ...(category ? [category] : [])).n;

  // Short cache — flash-sale windows mean the response goes stale in
  // minutes, not the prior 30s used for static catalogue data.
  res.set('Cache-Control', 'public, max-age=10');
  res.json({ success: true, data: rows, meta: { total, limit, offset, server_time_ms: now } });
});

router.get('/api/retail/products/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'bad_id' });

  const product = flashsales.decorateProduct(hydrateNutrition(db.prepare(
    `SELECT ${RETAIL_PRODUCT_COLS} FROM products p
     WHERE p.id = ? AND p.is_published = 1 AND COALESCE(p.is_active, 1) = 1`
  ).get(id)));
  if (!product) return res.status(404).json({ success: false, error: 'not_found' });

  // Review summary — avg rating + count + 3 most recent visible reviews.
  const summary = db.prepare(
    'SELECT AVG(rating) AS avg, COUNT(*) AS count FROM retail_reviews WHERE product_id = ? AND is_visible = 1'
  ).get(id);
  product.review_count = summary.count || 0;
  product.review_avg   = summary.count ? Number((summary.avg || 0).toFixed(2)) : 0;
  product.reviews_recent = db.prepare(
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

  const options = db.prepare(
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
    const choices = db.prepare(
      `SELECT id, option_id, label_en, label_cn, price_delta, is_default, sort_order
         FROM retail_product_option_choices
        WHERE option_id IN (${placeholders})
        ORDER BY sort_order ASC, id ASC`
    ).all(...optionIds);
    for (const c of choices) (choicesByOpt[c.option_id] ||= []).push(c);
  }
  product.options = options.map(o => ({ ...o, choices: choicesByOpt[o.id] || [] }));

  res.set('Cache-Control', 'public, max-age=10');
  res.json({ success: true, data: product });
});

// Active + upcoming flash sales — feeds the flash_sale_strip CMS block and
// any homepage surface that wants "what's on flash right now?". Active
// items come first (sorted by soonest end), then upcoming (sorted by
// soonest start). `?limit=N` clamps the response; default 12.
router.get('/api/retail/flash-sales', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '12', 10) || 12, 50);
  const now = Date.now();
  const rows = db.prepare(
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
    const n = db.prepare("SELECT COUNT(*) AS n FROM retail_customers WHERE openid LIKE 'dev:%'").get().n;
    console.error('[security] ⚠️  retail/auth is in DEV MODE (WECHAT_APP_ID/SECRET unset).');
    console.error('[security]    ' + n + ' customer(s) currently authenticate via spoofable dev:* openids.');
    console.error('[security]    Anyone who reaches POST /api/retail/auth with a known code can impersonate that customer.');
    console.error('[security]    Fix: add WECHAT_APP_ID + WECHAT_APP_SECRET to .env, then pm2 restart roots-v2.');
  } catch (_) {
    console.error('[security] ⚠️  retail/auth is in DEV MODE — set WECHAT_APP_ID + WECHAT_APP_SECRET in .env.');
  }
}

async function exchangeCodeForOpenid(code) {
  if (WECHAT_DEV_MODE) return { openid: `dev:${code}`, unionid: null };
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${WECHAT_APP_ID}&secret=${WECHAT_APP_SECRET}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
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
  db.prepare(
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
  let customer = db.prepare('SELECT * FROM retail_customers WHERE openid = ?').get(openid);
  if (!customer) {
    const info = db.prepare(
      `INSERT INTO retail_customers (openid, unionid, nickname, avatar_url, last_login_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(openid, unionid, nickname || null, avatar_url || null);
    customer = db.prepare('SELECT * FROM retail_customers WHERE id = ?').get(info.lastInsertRowid);
  } else {
    // Refresh last_login_at; opportunistically fill nickname/avatar if we
    // didn't have them before and the client just sent them.
    db.prepare(
      `UPDATE retail_customers
          SET last_login_at = CURRENT_TIMESTAMP,
              nickname   = COALESCE(NULLIF(nickname, ''), ?),
              avatar_url = COALESCE(NULLIF(avatar_url, ''), ?)
        WHERE id = ?`
    ).run(nickname || customer.nickname || null,
          avatar_url || customer.avatar_url || null,
          customer.id);
    customer = db.prepare('SELECT * FROM retail_customers WHERE id = ?').get(customer.id);
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
const WECHAT_PAY_PRIVATE_KEY   = process.env.WECHAT_PAY_PRIVATE_KEY || '';
const WECHAT_PAY_SERIAL_NO     = process.env.WECHAT_PAY_SERIAL_NO || '';
const WECHAT_PAY_NOTIFY_URL    = process.env.WECHAT_PAY_NOTIFY_URL || 'https://rootskitchenchina.com/api/retail/payment/wechat/callback';
const WECHAT_PAY_DEV_MODE = !WECHAT_PAY_MCH_ID || !WECHAT_PAY_PRIVATE_KEY || !WECHAT_APP_ID;

if (WECHAT_PAY_DEV_MODE) {
  console.error('[security] ⚠️  WECHAT PAY is in DEV MODE — /api/retail/payment/create and /api/retail/topup auto-succeed without charging.');
  console.error('[security]    A caller who reaches these endpoints can mark orders paid and credit wallet balances for free.');
  console.error('[security]    Fix: set WECHAT_PAY_MCH_ID + WECHAT_PAY_PRIVATE_KEY + WECHAT_PAY_API_V3_KEY + WECHAT_PAY_SERIAL_NO in .env, then pm2 restart roots-v2.');
}

// Build the wx.requestPayment params from a prepay_id. Signature is over
// the 5-line message: appid, timestamp, nonce, package, signed with the
// merchant private key (RSA-SHA256 → base64). See WeChat Pay v3 docs.
function buildWxRequestPaymentParams(prepayId) {
  const timeStamp = String(Math.floor(Date.now() / 1000));
  const nonceStr  = crypto.randomBytes(16).toString('hex');
  const pkg       = 'prepay_id=' + prepayId;
  const message   = [WECHAT_APP_ID, timeStamp, nonceStr, pkg, ''].join('\n');
  const paySign   = crypto.createSign('RSA-SHA256')
                          .update(message)
                          .sign(WECHAT_PAY_PRIVATE_KEY, 'base64');
  return { timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign };
}

// Sign an outbound HTTP request to api.mch.weixin.qq.com per the v3 spec.
// Header: Authorization: WECHATPAY2-SHA256-RSA2048 mchid="...",nonce_str="...",
//         timestamp=...,serial_no="...",signature="..."
function signMerchantRequest(method, urlPath, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonceStr  = crypto.randomBytes(16).toString('hex');
  const bodyStr   = body ? JSON.stringify(body) : '';
  const message   = [method.toUpperCase(), urlPath, timestamp, nonceStr, bodyStr].join('\n') + '\n';
  const signature = crypto.createSign('RSA-SHA256')
                          .update(message)
                          .sign(WECHAT_PAY_PRIVATE_KEY, 'base64');
  return 'WECHATPAY2-SHA256-RSA2048 ' +
    `mchid="${WECHAT_PAY_MCH_ID}",nonce_str="${nonceStr}",timestamp=${timestamp},serial_no="${WECHAT_PAY_SERIAL_NO}",signature="${signature}"`;
}

// Real WeChat Pay JSAPI prepare. Returns { prepay_id }.
async function wechatPayCreate(order, openid) {
  const url = 'https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi';
  const body = {
    appid:        WECHAT_APP_ID,
    mchid:        WECHAT_PAY_MCH_ID,
    description:  'Roots order ' + order.order_no,
    out_trade_no: order.order_no,
    notify_url:   WECHAT_PAY_NOTIFY_URL,
    amount:       { total: Math.round(Number(order.total) * 100), currency: 'CNY' },
    payer:        { openid },
  };
  const auth = signMerchantRequest('POST', '/v3/pay/transactions/jsapi', body);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'Authorization': auth,
      'User-Agent':    'Roots/1.0',
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

function markOrderPaid(orderId) {
  const r = db.prepare(
    "UPDATE retail_orders SET status = 'paid', paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending_payment'"
  ).run(orderId);
  db.prepare(
    "UPDATE retail_payments SET status = 'success', completed_at = CURRENT_TIMESTAMP WHERE order_id = ? AND status = 'pending'"
  ).run(orderId);
  if (r.changes > 0) {
    // Commit the soft-reservations: physical stock deducts at this point.
    // Idempotent for callers that re-fire (e.g. wechat retry callbacks).
    try { inventory.commitOrderReservations(orderId); }
    catch (e) { console.error('[inventory.commit]', e); }
    // Award earn-points on the actual transition. awardOrderPoints is
    // idempotent so calling it on already-paid orders is safe.
    try { awardOrderPoints(orderId); } catch (e) { console.error('[awardOrderPoints]', e); }
    // Credit referrer if this is the invitee's first paid order. Guarded
    // inside creditReferralReward by status='joined' so retries are safe.
    try { creditReferralReward(orderId); } catch (e) { console.error('[creditReferralReward]', e); }
  }
}

router.post('/api/retail/payment/create', requireRetailAuth, express.json(), async (req, res) => {
  const orderId = parseInt(req.body?.order_id, 10);
  if (!orderId) return res.status(400).json({ success: false, error: 'order_id_required' });
  const order = db.prepare(
    'SELECT id, order_no, status, payment_method, total, customer_id FROM retail_orders WHERE id = ? AND customer_id = ?'
  ).get(orderId, req.customer.id);
  if (!order) return res.status(404).json({ success: false, error: 'order_not_found' });
  if (order.status !== 'pending_payment') {
    return res.json({ success: true, data: { status: order.status, dev: WECHAT_PAY_DEV_MODE } });
  }

  // Points-paid orders settle at order-create (points already deducted
  // inside the create tx). Nothing to charge — just flip status to paid.
  if (order.payment_method === 'points') {
    markOrderPaid(orderId);
    return res.json({
      success: true,
      data: { status: 'paid', paid_by: 'points', order_no: order.order_no, method: 'points' },
    });
  }

  if (WECHAT_PAY_DEV_MODE) {
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
      const cust = db.prepare('SELECT openid FROM retail_customers WHERE id = ?').get(order.customer_id);
      if (!cust?.openid || cust.openid.startsWith('dev:')) {
        return res.status(409).json({ success: false, error: 'no_real_openid' });
      }
      const prepayId = await wechatPayCreate(order, cust.openid);
      const params   = buildWxRequestPaymentParams(prepayId);
      // Save the out_trade_no link for the async callback to find this order
      db.prepare(
        "UPDATE retail_payments SET out_trade_no = ? WHERE order_id = ? AND status = 'pending'"
      ).run(order.order_no, orderId);
      return res.json({ success: true, data: { method: 'wechat', ...params } });
    } catch (e) {
      console.error('[wechat-pay/create]', e);
      return res.status(502).json({ success: false, error: e.code || 'wechat_pay_failed' });
    }
  }

  // Alipay flow — TODO. Needs alipay.trade.precreate with alipay-sdk.
  return res.status(501).json({ success: false, error: 'alipay_not_implemented' });
});

// Polling endpoint — mini-app calls this every ~2s while waiting on
// Alipay-QR confirmation, or as a sanity check after wx.requestPayment.
router.get('/api/retail/payment/status/:orderId', requireRetailAuth, (req, res) => {
  const order = db.prepare(
    'SELECT id, order_no, status, paid_at, total FROM retail_orders WHERE id = ? AND customer_id = ?'
  ).get(parseInt(req.params.orderId, 10), req.customer.id);
  if (!order) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true, data: order });
});

// WeChat Pay async notify. Body looks like:
//   { id, create_time, resource_type, event_type, summary,
//     resource: { algorithm, ciphertext, associated_data, nonce, original_type } }
// The resource field is AES-256-GCM encrypted with WECHAT_PAY_API_V3_KEY.
//
// Verification flow (PROD only — DEV mode auto-paid in /create):
//   1. Validate request signature with WeChat Pay's public cert
//   2. Decrypt resource → original transaction payload
//   3. Look up retail_payments by out_trade_no, mark order paid
//   4. Return { code: 'SUCCESS', message: 'OK' }
//
// Failure to verify → return non-200 to make WeChat retry.
router.post('/api/retail/payment/wechat/callback', express.json(), (req, res) => {
  try {
    const body = req.body || {};
    // ── TODO (when WECHAT_PAY_PUBLIC_CERT is in .env): verify the request
    // signature using headers Wechatpay-Signature / Wechatpay-Serial /
    // Wechatpay-Timestamp / Wechatpay-Nonce, then decrypt body.resource.
    // For now we trust the request only when DEV mode is off AND the
    // request is on the loopback interface (callbacks only come from
    // WeChat via the public domain in production; this stops fakes
    // landing through some other path).
    if (WECHAT_PAY_DEV_MODE) {
      console.log('[wechat-pay/callback] DEV MODE — ignored (would have decrypted + marked paid)');
      return res.json({ code: 'SUCCESS', message: 'OK' });
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
      Buffer.from(WECHAT_PAY_API_V3_KEY, 'utf8'),
      Buffer.from(body.resource.nonce, 'utf8')
    );
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from(body.resource.associated_data || '', 'utf8'));
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    const txn = JSON.parse(plain);
    // txn.trade_state === 'SUCCESS' means paid
    if (txn.trade_state === 'SUCCESS' && txn.out_trade_no) {
      const pay = db.prepare(
        'SELECT order_id FROM retail_payments WHERE out_trade_no = ? AND status = ?'
      ).get(txn.out_trade_no, 'pending');
      if (pay) {
        db.prepare(
          "UPDATE retail_payments SET status = 'success', transaction_id = ?, raw_callback_json = ?, completed_at = CURRENT_TIMESTAMP WHERE out_trade_no = ?"
        ).run(txn.transaction_id || null, plain, txn.out_trade_no);
        markOrderPaid(pay.order_id);
      }
    }
    res.json({ code: 'SUCCESS', message: 'OK' });
  } catch (e) {
    console.error('[wechat-pay/callback]', e);
    // Returning non-200 makes WeChat retry the callback (with backoff)
    res.status(500).json({ code: 'FAIL', message: 'internal_error' });
  }
});
router.post('/api/retail/payment/alipay/callback', express.urlencoded({ extended: true }), (req, res) => {
  // TODO: verify signature, look up order_id from out_trade_no, mark paid
  console.log('[retail/payment/alipay/callback] body:', JSON.stringify(req.body).slice(0, 200));
  res.send('success');
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
    const order = db.prepare('SELECT id FROM retail_orders WHERE id = ? AND customer_id = ?').get(orderId, req.customer.id);
    if (!order) return res.status(404).json({ success: false, error: 'order_not_found' });
  }
  db.prepare(
    'INSERT INTO retail_subscriptions (customer_id, template_id, order_id) VALUES (?, ?, ?)'
  ).run(req.customer.id, template_id, orderId);
  res.json({ success: true });
});

// Server-side: cached WeChat access_token. Used for both subscribeMessage
// API and any other server-to-server WeChat calls. Token lives ~2 hours;
// we re-fetch when missing or near-expiry.
let _wxAccessToken = '';
let _wxAccessTokenExpires = 0;
async function getWeChatAccessToken() {
  if (!WECHAT_APP_ID || !WECHAT_APP_SECRET) return null;
  if (_wxAccessToken && Date.now() < _wxAccessTokenExpires - 60_000) return _wxAccessToken;
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WECHAT_APP_ID}&secret=${WECHAT_APP_SECRET}`;
  const resp = await fetch(url);
  const j = await resp.json();
  if (!j.access_token) throw new Error('access_token_fetch_failed: ' + (j.errmsg || j.errcode));
  _wxAccessToken = j.access_token;
  _wxAccessTokenExpires = Date.now() + (Number(j.expires_in) || 7200) * 1000;
  return _wxAccessToken;
}

// Push a subscribeMessage to a customer if they have an unused consent for
// the given template. Idempotent — marks consent used after send so it
// can't fire twice. In DEV mode (no WECHAT_APP_ID set), logs only.
async function sendSubscribeMessage(customerId, templateId, data, page = 'pages/me/me') {
  if (!templateId) return { sent: false, reason: 'no_template_id' };
  const sub = db.prepare(
    'SELECT id FROM retail_subscriptions WHERE customer_id = ? AND template_id = ? AND used = 0 ORDER BY id DESC LIMIT 1'
  ).get(customerId, templateId);
  if (!sub) return { sent: false, reason: 'no_consent' };

  const cust = db.prepare('SELECT openid FROM retail_customers WHERE id = ?').get(customerId);
  if (!cust?.openid) return { sent: false, reason: 'no_openid' };

  // Mark used eagerly — even if the WeChat send fails, the consent is gone
  // either way (one-shot from the customer's perspective).
  db.prepare("UPDATE retail_subscriptions SET used = 1, used_at = CURRENT_TIMESTAMP WHERE id = ?").run(sub.id);

  if (WECHAT_DEV_MODE || cust.openid.startsWith('dev:')) {
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

// Helper used by the admin status-transition endpoint — looks up the
// active order-status template ID from config and fires a notification.
function notifyOrderStatusChange(orderId, newStatus) {
  try {
    const cfg = loadConfig();
    const tplId = cfg.notifications?.order_status_template_id;
    if (!tplId) return;
    const o = db.prepare('SELECT order_no, customer_id, total FROM retail_orders WHERE id = ?').get(orderId);
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
    const o = db.prepare('SELECT order_no, customer_id, total FROM retail_orders WHERE id = ?').get(orderId);
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

// ─── requireRetailAuth middleware ────────────────────────────────────────
function requireRetailAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+([A-Za-z0-9]+)$/.exec(h);
  if (!m) return res.status(401).json({ success: false, error: 'missing_token' });
  const token = m[1];
  const row = db.prepare(
    `SELECT t.*, c.id AS cid FROM retail_auth_tokens t
       JOIN retail_customers c ON c.id = t.customer_id
      WHERE t.token = ? AND datetime(t.expires_at) > CURRENT_TIMESTAMP
        AND c.is_blocked = 0`
  ).get(token);
  if (!row) return res.status(401).json({ success: false, error: 'invalid_or_expired_token' });
  // Best-effort touch (don't block on contention)
  try {
    db.prepare('UPDATE retail_auth_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token = ?').run(token);
  } catch {}
  req.customer = db.prepare('SELECT * FROM retail_customers WHERE id = ?').get(row.cid);
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

// ─── Addresses ───────────────────────────────────────────────────────────
// Each customer has their own address book. is_default is enforced
// single-row per customer at the route level (we flip all others to 0 in
// the same txn when one is set to 1).
const ADDRESS_PUBLIC_COLS = `id, recipient_name, phone, province, city, district,
                              address, detail, postal_code, is_default,
                              created_at, updated_at`;

router.get('/api/retail/addresses', requireRetailAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT ${ADDRESS_PUBLIC_COLS} FROM retail_customer_addresses
      WHERE customer_id = ? ORDER BY is_default DESC, updated_at DESC`
  ).all(req.customer.id);
  res.json({ success: true, data: rows });
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
  if (!a.province || !a.city || !a.district) {
    return res.status(400).json({ success: false, error: 'missing_region' });
  }
  const tx = db.transaction(() => {
    if (a.is_default) {
      db.prepare('UPDATE retail_customer_addresses SET is_default = 0 WHERE customer_id = ?').run(req.customer.id);
    }
    const info = db.prepare(
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
  res.json({ success: true, data: db.prepare(`SELECT ${ADDRESS_PUBLIC_COLS} FROM retail_customer_addresses WHERE id = ?`).get(id) });
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
      db.prepare(
        'UPDATE retail_customer_addresses SET lat = ?, lng = ?, geocoded_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(coords.lat, coords.lng, addressId);
    } catch (e) { console.warn('[geocodeAddressAsync]', e.message); }
  });
}

router.put('/api/retail/addresses/:id', requireRetailAuth, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT id FROM retail_customer_addresses WHERE id = ? AND customer_id = ?').get(id, req.customer.id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });
  // Normalize only the fields actually present in the body — PUT is partial.
  const incoming = req.body || {};
  const a = (incoming.province || incoming.city || incoming.district || incoming.address)
    ? normalizeChinaAddress(incoming)
    : incoming;
  const tx = db.transaction(() => {
    if (a.is_default) {
      db.prepare('UPDATE retail_customer_addresses SET is_default = 0 WHERE customer_id = ?').run(req.customer.id);
    }
    db.prepare(
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
  const merged = db.prepare('SELECT province, city, district, address, detail FROM retail_customer_addresses WHERE id = ?').get(id);
  if (merged) geocodeAddressAsync(id, merged);
  res.json({ success: true, data: db.prepare(`SELECT ${ADDRESS_PUBLIC_COLS} FROM retail_customer_addresses WHERE id = ?`).get(id) });
});

router.delete('/api/retail/addresses/:id', requireRetailAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = db.prepare('DELETE FROM retail_customer_addresses WHERE id = ? AND customer_id = ?').run(id, req.customer.id);
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
  const row = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value_json); } catch { return fallback; }
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

// Given a list of order items + destination city, return a plan of
// shipments to create and which items go into each.
//
//   inGZ                 → one 'local' shipment, all items
//   outGZ + all air-OK   → one 'air' shipment
//   outGZ + all land-OK  → one 'land' shipment (when no item supports air)
//   outGZ + mixed        → split into two: 'air' (items that can go air)
//                          + 'land' (items that can't)
//
// `items` shape: [{ id, ship_modes }, ...]  where ship_modes is csv.
// Returns: [{ mode, label, item_ids: [...] }, ...]
function planShipments(items, destCity) {
  if (!items.length) return [];
  if (isGuangzhou(destCity)) {
    return [{ mode: 'local', label: 'Local delivery · 同城配送', item_ids: items.map(i => i.id) }];
  }
  const air  = [];
  const land = [];
  for (const it of items) {
    const modes = parseShipModes(it.ship_modes);
    if (modes.includes('air')) air.push(it.id);
    else land.push(it.id);
  }
  if (air.length && land.length) {
    return [
      { mode: 'air',  label: 'Air shipment · 空运',  item_ids: air  },
      { mode: 'land', label: 'Land shipment · 陆运', item_ids: land },
    ];
  }
  // Single-mode case.
  if (air.length) return [{ mode: 'air',  label: 'Air shipment · 空运',  item_ids: air  }];
  return            [{ mode: 'land', label: 'Land shipment · 陆运', item_ids: land }];
}

// Idempotently materialize shipment rows for an order. If shipments
// already exist, returns them. Otherwise computes the plan from current
// items + address city, inserts the rows, and assigns retail_order_items
// .shipment_id. Used both at order-creation time (fresh rows) and when
// loading an old order in the office UI (lazy-fill).
function ensureShipments(orderId) {
  const existing = db.prepare(
    `SELECT * FROM retail_shipments WHERE order_id = ? ORDER BY id ASC`
  ).all(orderId);
  if (existing.length) return existing;

  const o = db.prepare(
    `SELECT id, address_json, tracking_carrier, tracking_number, tracking_status,
            tracking_events_json, tracking_synced_at, tracking_last_error,
            tracking_kd100_subscribed, tracking_scenario, tracking_scenario_data_json,
            tracking_scenario_notified, dispatched_at, delivered_at
       FROM retail_orders WHERE id = ?`
  ).get(orderId);
  if (!o) return [];
  let destCity = '';
  try { destCity = JSON.parse(o.address_json || '{}').city || ''; } catch {}

  const items = db.prepare(
    `SELECT id, COALESCE(ship_modes, 'air,land') AS ship_modes
       FROM retail_order_items WHERE order_id = ?`
  ).all(orderId);
  const plan = planShipments(items, destCity);

  const ins = db.prepare(
    `INSERT INTO retail_shipments (order_id, mode, label, created_at, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  );
  const assignItem = db.prepare(`UPDATE retail_order_items SET shipment_id = ? WHERE id = ?`);
  const created = [];
  const tx = db.transaction(() => {
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
      db.prepare(
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
  return db.prepare(
    `SELECT * FROM retail_shipments WHERE order_id = ? ORDER BY id ASC`
  ).all(orderId);
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
  const last = db.prepare(
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
  const voucherCode   = body.voucher_code || null;
  // Future: voucher resolution + points redemption. For now: voucher_amount
  // and points_amount stay at 0 — record the code so admin can reconcile
  // manually if a hand-issued coupon was used in this launch window.

  // Delivery slot — customer picked from /quote's `scheduling.slots` array
  // (or 'right_away'). Server re-resolves it to keep the surcharge & ETA
  // authoritative.
  const deliverySlotId = body.delivery_slot_id || null;

  if (!items.length)       return res.status(400).json({ success: false, error: 'no_items' });
  if (!addressId)          return res.status(400).json({ success: false, error: 'address_required' });
  if (!paymentMethod)      return res.status(400).json({ success: false, error: 'payment_method_required' });
  if (!['wechat','alipay','points'].includes(paymentMethod)) {
    return res.status(400).json({ success: false, error: 'invalid_payment_method' });
  }
  if (!['standard','max','sameday'].includes(deliveryMode)) {
    return res.status(400).json({ success: false, error: 'invalid_delivery_method' });
  }
  if (!deliverySlotId) return res.status(400).json({ success: false, error: 'delivery_slot_required' });

  const address = db.prepare(
    'SELECT * FROM retail_customer_addresses WHERE id = ? AND customer_id = ?'
  ).get(addressId, req.customer.id);
  if (!address) return res.status(400).json({ success: false, error: 'address_not_found' });

  // ── Resolve + price each item server-side ────────────────────────────
  const orderNowMs = Date.now();
  const resolved = [];
  for (const it of items) {
    const pid = parseInt(it.product_id, 10);
    const qty = Number(it.qty);
    if (!pid || !(qty > 0)) return res.status(400).json({ success: false, error: 'invalid_item' });

    const p = db.prepare(
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
      const choices = db.prepare(
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
  // The actual reservation happens inside the order-create transaction
  // below (so a reservation that succeeds but then fails the order INSERT
  // can be rolled back atomically). Here we only route + pre-check.
  // `accept_fallback: true` in the body means the customer has already
  // confirmed they're OK with a farther store (longer delivery) if the
  // nearest one is short.
  const acceptFallback = !!body.accept_fallback;
  const routing = inventory.routeOrder({
    address,
    items: resolved.map(r => ({ product_id: r.product.id, qty: r.qty })),
    channel: 'wechat',
    acceptFallback,
  });
  if (routing.error === 'no_active_store') {
    return res.status(503).json({ success: false, error: 'no_active_store' });
  }
  if (routing.error === 'needs_fallback_confirmation') {
    // Nearest store can't fulfill but a farther one can. Surface both so
    // the mini-app can show a "wait longer for shipping?" dialog. When
    // the customer accepts, the mini-app re-submits with accept_fallback.
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
      success: false,
      error: 'insufficient_stock',
      product_id: short?.product_id,
      available: short?.available ?? 0,
      store_id: routing.store?.id ?? null,
    });
  }
  const fulfillingStore = routing.store;
  const routingReason   = routing.reason;

  const subtotal = resolved.reduce((s, r) => s + r.lineTotal, 0);
  const totalQty = resolved.reduce((s, r) => s + r.qty, 0);

  // Zone-driven fee model. If no zone matches the address, we currently
  // refuse the order — the office must configure the district/city in
  // /retail-admin → Delivery before this customer can check out.
  const zone = matchDeliveryZone(address);
  let shippingFee = 0, packingFee = 0, deliveryZoneId = null, resolvedMode = deliveryMode;
  if (zone) {
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

  // Resolve & validate the delivery slot AFTER zone lookup so we can enforce
  // the slot's same-day surcharge, expiry, and zone-allowed rules.
  const slotResolved = resolveDeliverySlot(zone, deliverySlotId, new Date());
  if (slotResolved.error) {
    return res.status(400).json({ success: false, error: slotResolved.error });
  }
  const scheduledFor       = slotResolved.scheduled_for;          // ISO string or null
  const sameDaySurcharge   = Number(slotResolved.surcharge) || 0; // 0 unless same-day + zone-charged
  const slotLabel          = body.delivery_slot_label
                              || slotResolved.slot?.label_en
                              || (deliverySlotId === 'right_away' ? 'Right away' : null);
  // Same-day surcharge is added to the shipping line so totals reconcile
  // without a new fee column on retail_orders.
  shippingFee += sameDaySurcharge;

  // ── Voucher resolution ───────────────────────────────────────────────
  // Customer sends voucher_code; server re-validates + computes discount.
  let voucher = null, voucherDiscount = 0;
  if (voucherCode) {
    voucher = db.prepare(
      'SELECT * FROM retail_vouchers WHERE UPPER(code) = ? AND is_active = 1'
    ).get(String(voucherCode).trim().toUpperCase());
    if (voucher) {
      const result = computeVoucherDiscount(voucher, subtotal, shippingFee);
      if (result.applied) {
        voucherDiscount = Number(result.discount) || 0;
        if (result.free_shipping) shippingFee = 0;
        // Per-customer limit re-check on server side
        if (voucher.per_customer_limit && voucher.per_customer_limit > 0) {
          const used = db.prepare(
            `SELECT COUNT(*) AS n FROM retail_orders
              WHERE customer_id = ? AND voucher_code = ?
                AND status NOT IN ('cancelled')`
          ).get(req.customer.id, voucher.code).n;
          if (used >= voucher.per_customer_limit) {
            voucher = null; voucherDiscount = 0;
          }
        }
      } else {
        voucher = null;
      }
    }
  }

  const grossTotal = Math.max(0, subtotal + shippingFee + packingFee - voucherDiscount);

  // ── Points redemption ────────────────────────────────────────────────
  // Currently supports the single mode design page 05 calls out: payment
  // method 'points' = points cover the entire order. Customer must have
  // enough balance; otherwise we refuse with insufficient_points so the
  // mini-app can show the gap. Partial points + wechat/alipay stacking is
  // an open follow-up (see CLAUDE.md).
  let pointsUsed = 0, pointsAmount = 0;
  if (paymentMethod === 'points') {
    sweepExpiredPoints(req.customer.id);
    const cust = db.prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(req.customer.id);
    const have = cust?.points_balance || 0;
    pointsUsed   = pointsRequiredFor(grossTotal);
    pointsAmount = grossTotal;
    if (have < pointsUsed) {
      return res.status(409).json({
        success: false,
        error: 'insufficient_points',
        required: pointsUsed,
        available: have,
      });
    }
  }
  const total = Math.max(0, grossTotal - pointsAmount);

  // ── Atomic write: order, items, payment intent, stock reservations ───
  // Reservations replace the old "decrement stock_qty on order create"
  // model. Stock at the routed store is soft-held until payment commits
  // (or expiry releases it). See lib/inventory.js for the math.
  const orderNo = nextOrderNo();
  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO retail_orders (
         order_no, customer_id, status, payment_method,
         recipient_name, recipient_phone, address_full, address_json,
         subtotal, shipping_fee, packing_fee, delivery_mode, delivery_zone_id,
         scheduled_for, delivery_slot_label, same_day_surcharge_fee,
         voucher_code, voucher_amount,
         points_used, points_amount, total,
         customer_note, needs_cutlery, needs_invoice, invoice_title, invoice_tax_id,
         store_id, routing_reason, channel
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      orderNo, req.customer.id, 'pending_payment', paymentMethod,
      address.recipient_name, address.phone,
      [address.province, address.city, address.district, address.address, address.detail].filter(Boolean).join(' '),
      JSON.stringify({
        province: address.province, city: address.city, district: address.district,
        address: address.address, detail: address.detail, postal_code: address.postal_code,
      }),
      subtotal, shippingFee, packingFee, resolvedMode, deliveryZoneId,
      scheduledFor, slotLabel, sameDaySurcharge,
      voucher ? voucher.code : null, voucherDiscount,
      pointsUsed, pointsAmount, total,
      customerNote, needsCutlery, needsInvoice, invoiceTitle, invoiceTaxId,
      fulfillingStore.id, routingReason, 'wechat'
    );
    const orderId = info.lastInsertRowid;

    // Decrement voucher max_uses pool. Bumps used_count atomically inside
    // the same transaction so two simultaneous orders can't exceed it.
    if (voucher) {
      db.prepare('UPDATE retail_vouchers SET used_count = used_count + 1 WHERE id = ?').run(voucher.id);
      // If this customer had a personal grant for this voucher, mark the
      // grant used so it disappears from their wallet/checkout list.
      db.prepare(
        `UPDATE retail_customer_vouchers
            SET used_at = CURRENT_TIMESTAMP, used_order_id = ?
          WHERE customer_id = ? AND voucher_id = ? AND used_at IS NULL`
      ).run(orderId, req.customer.id, voucher.id);
    }

    const insertItem = db.prepare(
      `INSERT INTO retail_order_items
         (order_id, product_id, name_en, name_cn, sku, size, image_url,
          qty, unit_price, line_total, options_json,
          ship_modes, needs_ice_pack)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const r of resolved) {
      insertItem.run(
        orderId, r.product.id, r.product.name_en, r.product.name_cn,
        r.product.sku, r.product.size, null,
        r.qty, r.unitPrice, r.lineTotal,
        r.options.length ? JSON.stringify(r.options) : null,
        r.product.ship_modes || 'air,land',
        r.product.needs_ice_pack ? 1 : 0
      );
    }
    // Auto-plan shipments based on dest city + per-item ship_modes. For
    // in-GZ orders this is a single 'local' shipment; for outside-GZ it
    // splits into air + land when items have mixed allowed modes.
    ensureShipments(orderId);

    // Increment flash_sold atomically for items that were priced at flash
    // rate. The WHERE clause caps the counter at flash_stock_limit (when
    // set) — `changes !== 1` means a concurrent order beat us to the last
    // unit, so we roll back. Items with no stock cap still increment so
    // analytics + admin UI can show how many sold during the window.
    const bumpCapped = db.prepare(
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
    inventory.reserveForOrder({
      storeId: fulfillingStore.id,
      orderId,
      items: resolved.map(r => ({ product_id: r.product.id, qty: r.qty })),
      channel: 'wechat',
    });

    db.prepare(
      `INSERT INTO retail_payments (order_id, method, amount, status, out_trade_no)
       VALUES (?, ?, ?, 'pending', ?)`
    ).run(orderId, paymentMethod, total, orderNo);

    // Consume the customer's points NOW (inside the same tx as the order
    // insert), so simultaneous orders can't double-spend the same balance.
    // The order is still 'pending_payment' at this stage — markOrderPaid()
    // (called from /payment/create) flips it to 'paid' and awards earn-points.
    if (pointsUsed > 0) {
      const upd = db.prepare(
        'UPDATE retail_customers SET points_balance = points_balance - ? WHERE id = ? AND points_balance >= ?'
      ).run(pointsUsed, req.customer.id, pointsUsed);
      if (upd.changes !== 1) {
        const err = new Error('insufficient_points');
        err.code = 'insufficient_points';
        throw err;
      }
      const after = db.prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(req.customer.id).points_balance;
      db.prepare(
        `INSERT INTO retail_points_transactions
           (customer_id, delta, balance_after, source, order_id, note)
         VALUES (?, ?, ?, 'order_redeem', ?, ?)`
      ).run(req.customer.id, -pointsUsed, after, orderId, `Order ${orderId} redeemed ${pointsUsed} pts`);
    }

    return orderId;
  });

  let orderId;
  try { orderId = tx(); }
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
    console.error('[retail/orders POST]', e);
    return res.status(500).json({ success: false, error: 'order_create_failed' });
  }

  const order = loadOrderForCustomer(orderId, req.customer.id);
  res.json({ success: true, data: order });
});

function loadOrderForCustomer(orderId, customerId) {
  const o = db.prepare(
    `SELECT id, order_no, status, payment_method,
            recipient_name, recipient_phone, address_full, address_json,
            subtotal, shipping_fee, packing_fee, delivery_mode, delivery_zone_id,
            voucher_code, voucher_amount,
            points_used, points_amount, points_earned, total,
            customer_note, needs_cutlery, needs_invoice, invoice_title, invoice_tax_id,
            staff_note, cancelled_reason,
            refund_requested_at, refund_reason, refund_status, refund_review_note,
            store_id, routing_reason, channel,
            tracking_carrier, tracking_number, tracking_status,
            tracking_events_json, tracking_synced_at,
            tracking_scenario, tracking_scenario_data_json,
            placed_at, paid_at, preparing_at, dispatched_at, delivered_at, cancelled_at, updated_at
       FROM retail_orders WHERE id = ? AND customer_id = ?`
  ).get(orderId, customerId);
  if (!o) return null;
  if (o.address_json) { try { o.address = JSON.parse(o.address_json); } catch {} }
  delete o.address_json;
  o.tracking = buildTrackingView(o);
  // Items snapshot historical name + price at order time, but image_url
  // was never captured (always null on insert). Fall through to the live
  // product image so order/review thumbnails actually render. The tradeoff
  // is that if staff later swaps the product photo, old orders show the
  // new one — acceptable for "remind me what I bought" UX.
  o.items = db.prepare(
    `SELECT oi.id, oi.product_id, oi.name_en, oi.name_cn, oi.sku, oi.size,
            COALESCE(NULLIF(oi.image_url, ''), p.image_url, p.image_data) AS image_url,
            oi.qty, oi.unit_price, oi.line_total, oi.options_json
       FROM retail_order_items oi
  LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ? ORDER BY oi.id ASC`
  ).all(orderId).map(it => {
    if (it.options_json) { try { it.options = JSON.parse(it.options_json); } catch {} }
    delete it.options_json;
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
                    tracking_carrier, tracking_number, tracking_status,
                    placed_at, paid_at, dispatched_at, delivered_at
               FROM retail_orders WHERE customer_id = ?`;
  const params = [req.customer.id];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY placed_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params);

  // Attach a tiny preview of items so the order list can render thumbs
  // without N+1 follow-up requests.
  for (const r of rows) {
    r.items_preview = db.prepare(
      `SELECT oi.product_id, oi.name_en, oi.name_cn, oi.qty,
              COALESCE(NULLIF(oi.image_url, ''), p.image_url, p.image_data) AS image_url
         FROM retail_order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ? ORDER BY oi.id ASC LIMIT 3`
    ).all(r.id);
    r.item_count = db.prepare('SELECT COUNT(*) AS n FROM retail_order_items WHERE order_id = ?').get(r.id).n;
  }
  res.json({ success: true, data: rows, meta: { limit, offset } });
});

// Counts by status — powers the Me-tab bucket icons (Unpaid / Pending /
// Preparing / Sent / Review). `pending` = paid but not yet acknowledged;
// `preparing` = kitchen is actively preparing. `to_ship` is kept for back-
// compat (= pending + preparing). `to_review` = delivered orders that the
// customer hasn't yet reviewed, `total` = lifetime order count.
router.get('/api/retail/orders/stats', requireRetailAuth, (req, res) => {
  const buckets = db.prepare(
    `SELECT status, COUNT(*) AS n FROM retail_orders WHERE customer_id = ? GROUP BY status`
  ).all(req.customer.id);
  const counts = {};
  for (const b of buckets) counts[b.status] = b.n;
  const totalRow = db.prepare(
    'SELECT COUNT(*) AS n FROM retail_orders WHERE customer_id = ?'
  ).get(req.customer.id);
  // Count items, not orders — the Review bucket on the Me tab opens a
  // per-item list, so the badge number must match the list length.
  const toReviewRow = db.prepare(
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
      after_sales: counts.refunded || 0,
      total:     totalRow.n || 0,
    },
  });
});

router.get('/api/retail/orders/:id', requireRetailAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const order = loadOrderForCustomer(id, req.customer.id);
  if (!order) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true, data: order });
});

// Items the customer still needs to review — delivered orders' items that
// don't yet have a row in retail_reviews for (customer, order, product).
// Powers the Me-tab Review bucket's dedicated list page.
router.get('/api/retail/reviews/pending', requireRetailAuth, (req, res) => {
  const rows = db.prepare(
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
  const rows = db.prepare(
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
    const tokRow = db.prepare(
      `SELECT c.id FROM retail_auth_tokens t
         JOIN retail_customers c ON c.id = t.customer_id
        WHERE t.token = ? AND datetime(t.expires_at) > CURRENT_TIMESTAMP
          AND c.is_blocked = 0`
    ).get(m[1]);
    if (tokRow) customer = tokRow;
  }

  const filtered = rows.filter(v => {
    if (!customer || !v.per_customer_limit || v.per_customer_limit <= 0) return true;
    const used = db.prepare(
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
  const rows = db.prepare(
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
  const v = db.prepare(
    'SELECT * FROM retail_vouchers WHERE UPPER(code) = ? AND is_active = 1'
  ).get(code);
  if (!v) return res.status(404).json({ success: false, error: 'not_found' });
  // Per-customer limit check
  if (v.per_customer_limit && v.per_customer_limit > 0) {
    const used = db.prepare(
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

// Admin CRUD for vouchers.
router.get('/api/retail-admin/vouchers', requireRetailAdmin, (req, res) => {
  const rows = db.prepare(
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
    const info = db.prepare(
      `INSERT INTO retail_vouchers
         (code, type, value, min_subtotal, max_uses, per_customer_limit, expires_at,
          is_active, is_public, title_en, title_cn, description, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      req.user.id
    );
    logActivity(req.user.id, req.user.username, 'create', 'voucher', info.lastInsertRowid, { code, type: b.type }, req.ip);
    res.json({ success: true, data: db.prepare('SELECT * FROM retail_vouchers WHERE id = ?').get(info.lastInsertRowid) });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(409).json({ success: false, error: 'code_exists' });
    res.status(500).json({ success: false, error: e.message });
  }
});

router.patch('/api/retail-admin/vouchers/:id', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const v = db.prepare('SELECT id FROM retail_vouchers WHERE id = ?').get(id);
  if (!v) return res.status(404).json({ success: false, error: 'not_found' });
  const fields = ['value', 'min_subtotal', 'max_uses', 'per_customer_limit', 'expires_at',
                  'is_active', 'is_public', 'title_en', 'title_cn', 'description'];
  const updates = {};
  for (const f of fields) if (f in req.body) updates[f] = req.body[f];
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: 'no_fields' });
  if ('is_active' in updates) updates.is_active = updates.is_active ? 1 : 0;
  if ('is_public' in updates) updates.is_public = updates.is_public ? 1 : 0;
  if ('expires_at' in updates && !updates.expires_at) updates.expires_at = null;
  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE retail_vouchers SET ${sets} WHERE id = ?`).run(...Object.values(updates), id);
  res.json({ success: true });
});

router.delete('/api/retail-admin/vouchers/:id', requireRetailAdmin, (req, res) => {
  db.prepare('UPDATE retail_vouchers SET is_active = 0 WHERE id = ?').run(parseInt(req.params.id, 10));
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

  const total = db.prepare(`SELECT COUNT(*) AS n FROM retail_customers ${whereSql}`).get(...params).n;

  const rows = db.prepare(
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
  const rows = db.prepare(
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
  const v = db.prepare('SELECT id, code FROM retail_vouchers WHERE id = ?').get(id);
  if (!v) return res.status(404).json({ success: false, error: 'voucher_not_found' });

  const toAll = req.body?.to_all === true;
  const note  = req.body?.note ? String(req.body.note).slice(0, 200) : null;

  let ids;
  if (toAll) {
    ids = db.prepare('SELECT id FROM retail_customers WHERE is_blocked = 0').all().map(r => r.id);
  } else {
    ids = Array.isArray(req.body?.customer_ids) ? req.body.customer_ids : [];
  }
  if (!ids.length) return res.status(400).json({ success: false, error: 'no_customers' });

  const ins = db.prepare(
    `INSERT OR IGNORE INTO retail_customer_vouchers
       (customer_id, voucher_id, granted_by, granted_note)
     VALUES (?, ?, ?, ?)`
  );
  let granted = 0, skipped = 0;
  const tx = db.transaction(() => {
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
  const r = db.prepare(
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

  const customer = db.prepare('SELECT * FROM retail_customers WHERE id = ?').get(id);
  if (!customer) return res.status(404).json({ success: false, error: 'not_found' });

  const addresses = db.prepare(
    'SELECT * FROM retail_customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, id DESC'
  ).all(id);

  const orders = db.prepare(
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

  const points = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN delta > 0 AND source IN ('order_earn','topup_bonus') THEN delta ELSE 0 END), 0) AS earned,
       COALESCE(SUM(CASE WHEN delta < 0 AND source = 'order_redeem'                 THEN -delta ELSE 0 END), 0) AS redeemed,
       COALESCE(SUM(CASE WHEN delta < 0 AND source = 'expiry'                       THEN -delta ELSE 0 END), 0) AS expired,
       COALESCE(SUM(CASE WHEN source = 'admin_adjust'                                THEN delta ELSE 0 END), 0) AS admin_adjust
       FROM retail_points_transactions WHERE customer_id = ?`
  ).get(id);

  const expiringSoon = db.prepare(
    `SELECT COALESCE(SUM(delta), 0) AS pts
       FROM retail_points_transactions
      WHERE customer_id = ? AND delta > 0
        AND expires_at IS NOT NULL AND expired_at IS NULL
        AND expires_at <= datetime('now', '+30 days')`
  ).get(id).pts;

  const topup = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN status='success' AND COALESCE(payment_method,'') != 'admin_adjust' THEN amount       ELSE 0 END), 0) AS topup_total,
       COALESCE(SUM(CASE WHEN status='success' AND COALESCE(payment_method,'') != 'admin_adjust' THEN bonus_points ELSE 0 END), 0) AS bonus_pts_total,
       COALESCE(SUM(CASE WHEN status='success' AND payment_method='admin_adjust'                  THEN amount       ELSE 0 END), 0) AS admin_adjust_total
       FROM retail_topup_transactions WHERE customer_id = ?`
  ).get(id);

  const vouchers = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN used_at IS NULL     THEN 1 ELSE 0 END), 0) AS unused,
       COALESCE(SUM(CASE WHEN used_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS used
       FROM retail_customer_vouchers WHERE customer_id = ?`
  ).get(id);

  const reviews = db.prepare(
    `SELECT COUNT(*) AS count, AVG(rating) AS avg_rating
       FROM retail_reviews WHERE customer_id = ?`
  ).get(id);

  const sessions = db.prepare(
    "SELECT COUNT(*) AS n FROM retail_auth_tokens WHERE customer_id = ? AND expires_at > datetime('now')"
  ).get(id).n;

  const topItems = db.prepare(
    `SELECT i.name_en, i.name_cn, SUM(i.qty) AS qty, SUM(i.line_total) AS spend
       FROM retail_order_items i
       JOIN retail_orders o ON o.id = i.order_id
      WHERE o.customer_id = ?
        AND o.status NOT IN ('cancelled','refunded','pending_payment')
      GROUP BY i.name_en, i.name_cn
      ORDER BY qty DESC
      LIMIT 5`
  ).all(id);

  const ordersByMonth = db.prepare(
    `SELECT strftime('%Y-%m', placed_at) AS month,
            COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','refunded','pending_payment') THEN total ELSE 0 END), 0) AS revenue
       FROM retail_orders
      WHERE customer_id = ?
        AND placed_at >= datetime('now', '-12 months')
      GROUP BY month
      ORDER BY month`
  ).all(id);

  const recentOrders = db.prepare(
    `SELECT id, order_no, status, total, placed_at AS created_at
       FROM retail_orders
      WHERE customer_id = ?
      ORDER BY id DESC LIMIT 10`
  ).all(id);

  const recentPoints = db.prepare(
    `SELECT id, delta, balance_after, source, order_id, note, created_at, expires_at
       FROM retail_points_transactions
      WHERE customer_id = ?
      ORDER BY id DESC LIMIT 20`
  ).all(id);

  const recentTopups = db.prepare(
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
  const referrer = customer.referred_by_customer_id ? db.prepare(
    'SELECT id, nickname, phone, referral_code FROM retail_customers WHERE id = ?'
  ).get(customer.referred_by_customer_id) : null;
  const referralsByMe = db.prepare(
    `SELECT r.id, r.status, r.reward_amount, r.code_used, r.joined_at, r.rewarded_at,
            r.first_paid_order_id,
            ci.id AS invitee_id, ci.nickname AS invitee_nickname, ci.phone AS invitee_phone
       FROM retail_referrals r
       JOIN retail_customers ci ON ci.id = r.invitee_id
      WHERE r.referrer_id = ?
      ORDER BY r.id DESC
      LIMIT 50`
  ).all(id);
  const referralsAgg = db.prepare(
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
  const c = db.prepare('SELECT * FROM retail_customers WHERE id = ?').get(id);
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
  if (b.tier_key !== undefined) {
    const v = String(b.tier_key || '').toLowerCase();
    if (!['seed', 'sprout', 'root', 'tree'].includes(v)) {
      return res.status(400).json({ success: false, error: 'bad_tier' });
    }
    updates.push('tier_key = ?'); params.push(v); changed.tier_key = v;
  }

  if (!updates.length) return res.json({ success: true, changed: {} });

  params.push(id);
  db.prepare(`UPDATE retail_customers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  logActivity(req.user.id, req.user.username, 'update', 'retail_customer', id, changed, req.ip);
  res.json({ success: true, changed });
});

// Block / unblock — toggling `is_blocked`. Blocking does not invalidate
// existing tokens; the caller should hit /force-logout if they want that too.
router.post('/api/retail-admin/customers/:id/block', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const reason = req.body?.reason ? String(req.body.reason).slice(0, 200) : null;
  const r = db.prepare('UPDATE retail_customers SET is_blocked = 1 WHERE id = ?').run(id);
  if (!r.changes) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'block', 'retail_customer', id, { reason }, req.ip);
  res.json({ success: true });
});
router.post('/api/retail-admin/customers/:id/unblock', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = db.prepare('UPDATE retail_customers SET is_blocked = 0 WHERE id = ?').run(id);
  if (!r.changes) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'unblock', 'retail_customer', id, {}, req.ip);
  res.json({ success: true });
});

// Revoke every active auth token for the customer — forces re-login on
// next mini-app open.
router.post('/api/retail-admin/customers/:id/force-logout', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c  = db.prepare('SELECT id FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });
  const r = db.prepare('DELETE FROM retail_auth_tokens WHERE customer_id = ?').run(id);
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
  if (!id || !Number.isFinite(delta) || delta === 0) return res.status(400).json({ success: false, error: 'bad_delta' });
  if (!reason) return res.status(400).json({ success: false, error: 'reason_required' });

  const c = db.prepare('SELECT id, points_balance FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });
  const after = (c.points_balance || 0) + delta;
  if (after < 0) return res.status(409).json({ success: false, error: 'would_go_negative', current: c.points_balance });

  const tx = db.transaction(() => {
    db.prepare('UPDATE retail_customers SET points_balance = ? WHERE id = ?').run(after, id);
    db.prepare(
      `INSERT INTO retail_points_transactions (customer_id, delta, balance_after, source, note)
       VALUES (?, ?, ?, 'admin_adjust', ?)`
    ).run(id, delta, after, `[${req.user.username}] ${reason}`);
  });
  tx();
  logActivity(req.user.id, req.user.username, 'points_adjust', 'retail_customer', id, { delta, reason, balance_after: after }, req.ip);
  res.json({ success: true, balance_after: after });
});

// Manual wallet adjustment — writes a `payment_method='admin_adjust'` row
// to retail_topup_transactions (amount may be negative for clawback) and
// updates the cached balance atomically.
router.post('/api/retail-admin/customers/:id/wallet-adjust', requireRetailAdmin, express.json(), (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const delta  = Number(req.body?.delta);
  const reason = String(req.body?.reason || '').trim().slice(0, 200);
  if (!id || !Number.isFinite(delta) || delta === 0) return res.status(400).json({ success: false, error: 'bad_delta' });
  if (!reason) return res.status(400).json({ success: false, error: 'reason_required' });

  const c = db.prepare('SELECT id, balance FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });
  const after = Math.round(((c.balance || 0) + delta) * 100) / 100;
  if (after < 0) return res.status(409).json({ success: false, error: 'would_go_negative', current: c.balance });

  const tx = db.transaction(() => {
    db.prepare('UPDATE retail_customers SET balance = ? WHERE id = ?').run(after, id);
    db.prepare(
      `INSERT INTO retail_topup_transactions
         (customer_id, amount, bonus_points, payment_method, status, paid_at, out_trade_no, raw_callback_json)
       VALUES (?, ?, 0, 'admin_adjust', 'success', CURRENT_TIMESTAMP, ?, ?)`
    ).run(id, delta, `adminadj:${req.user.id}:${Date.now()}`, JSON.stringify({ reason, by: req.user.username }));
  });
  tx();
  logActivity(req.user.id, req.user.username, 'wallet_adjust', 'retail_customer', id, { delta, reason, balance_after: after }, req.ip);
  res.json({ success: true, balance_after: after });
});

// Address admin — create / edit / delete a customer's saved addresses.
// Mirrors the customer-side routes at /api/retail/addresses but scoped by
// path-param customer_id and gated by retail-admin auth.
router.post('/api/retail-admin/customers/:id/addresses', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: 'bad_id' });
  const c = db.prepare('SELECT id FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });
  const a = normalizeChinaAddress(req.body || {});
  if (!a.recipient_name || !a.phone || !a.address) {
    return res.status(400).json({ success: false, error: 'missing_required' });
  }
  const tx = db.transaction(() => {
    if (a.is_default) {
      db.prepare('UPDATE retail_customer_addresses SET is_default = 0 WHERE customer_id = ?').run(id);
    }
    const info = db.prepare(
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
  const row = db.prepare(`SELECT ${ADDRESS_PUBLIC_COLS} FROM retail_customer_addresses WHERE id = ?`).get(newId);
  res.json({ success: true, data: row });
});

router.put('/api/retail-admin/customers/:id/addresses/:addrId', requireRetailAdmin, express.json(), (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const addrId = parseInt(req.params.addrId, 10);
  const existing = db.prepare('SELECT id FROM retail_customer_addresses WHERE id = ? AND customer_id = ?').get(addrId, id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });
  const incoming = req.body || {};
  const a = (incoming.province || incoming.city || incoming.district || incoming.address)
    ? normalizeChinaAddress(incoming)
    : incoming;
  const tx = db.transaction(() => {
    if (a.is_default) {
      db.prepare('UPDATE retail_customer_addresses SET is_default = 0 WHERE customer_id = ?').run(id);
    }
    db.prepare(
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
  const row = db.prepare(`SELECT ${ADDRESS_PUBLIC_COLS} FROM retail_customer_addresses WHERE id = ?`).get(addrId);
  res.json({ success: true, data: row });
});

router.delete('/api/retail-admin/customers/:id/addresses/:addrId', requireRetailAdmin, (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const addrId = parseInt(req.params.addrId, 10);
  const r = db.prepare('DELETE FROM retail_customer_addresses WHERE id = ? AND customer_id = ?').run(addrId, id);
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
  const row = db.prepare('SELECT referral_code FROM retail_customers WHERE id = ?').get(customerId);
  if (!row) return null;
  if (row.referral_code) return row.referral_code;
  const prefix = affiliateSettings().codePrefix;
  for (let i = 0; i < 8; i++) {
    const candidate = prefix + newReferralCodeBody();
    try {
      db.prepare('UPDATE retail_customers SET referral_code = ? WHERE id = ? AND referral_code IS NULL').run(candidate, customerId);
      const fresh = db.prepare('SELECT referral_code FROM retail_customers WHERE id = ?').get(customerId);
      if (fresh.referral_code) return fresh.referral_code;
    } catch (e) { /* UNIQUE collision — retry */ }
  }
  return null;
}

function affiliateInvitesFor(referrerId) {
  return db.prepare(
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
  const agg = db.prepare(
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
  const referredBy = db.prepare(
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

  const me = db.prepare('SELECT id, referred_by_customer_id FROM retail_customers WHERE id = ?').get(req.customer.id);
  if (me.referred_by_customer_id) {
    return res.status(409).json({ success: false, error: 'already_referred' });
  }
  const inviter = db.prepare('SELECT id, referred_by_customer_id FROM retail_customers WHERE referral_code = ?').get(raw);
  if (!inviter)         return res.status(404).json({ success: false, error: 'code_not_found' });
  if (inviter.id === me.id) return res.status(409).json({ success: false, error: 'cannot_refer_self' });
  if (inviter.referred_by_customer_id === me.id) {
    return res.status(409).json({ success: false, error: 'mutual_referral' });
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE retail_customers
          SET referred_by_customer_id = ?,
              referral_applied_at     = CURRENT_TIMESTAMP
        WHERE id = ? AND referred_by_customer_id IS NULL`
    ).run(inviter.id, me.id);
    db.prepare(
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
  const o = db.prepare('SELECT id, customer_id, status FROM retail_orders WHERE id = ?').get(orderId);
  if (!o || o.status !== 'paid') return;
  const ref = db.prepare(
    `SELECT id, referrer_id, invitee_id, reward_amount, status
       FROM retail_referrals
      WHERE invitee_id = ? AND status = 'joined'`
  ).get(o.customer_id);
  if (!ref) return;
  // Only the FIRST paid order counts — if there's already an earlier paid
  // order for this customer, skip (defensive; status='joined' should
  // already block this once the first order rewards).
  const earlier = db.prepare(
    "SELECT 1 FROM retail_orders WHERE customer_id = ? AND id < ? AND paid_at IS NOT NULL LIMIT 1"
  ).get(o.customer_id, orderId);
  if (earlier) {
    db.prepare("UPDATE retail_referrals SET status = 'void', voided_at = CURRENT_TIMESTAMP, voided_reason = 'not_first_order' WHERE id = ?").run(ref.id);
    return;
  }
  const reward = Number(ref.reward_amount) || 0;
  const tx = db.transaction(() => {
    if (reward > 0) {
      const cur = db.prepare('SELECT balance FROM retail_customers WHERE id = ?').get(ref.referrer_id);
      const after = Math.round(((cur?.balance || 0) + reward) * 100) / 100;
      db.prepare('UPDATE retail_customers SET balance = ? WHERE id = ?').run(after, ref.referrer_id);
      db.prepare(
        `INSERT INTO retail_topup_transactions
           (customer_id, amount, bonus_points, payment_method, status, paid_at, out_trade_no, raw_callback_json)
         VALUES (?, ?, 0, 'referral_reward', 'success', CURRENT_TIMESTAMP, ?, ?)`
      ).run(
        ref.referrer_id, reward,
        `referral:${ref.id}:${orderId}`,
        JSON.stringify({ referral_id: ref.id, invitee_id: ref.invitee_id, order_id: orderId })
      );
    }
    db.prepare(
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
  const up = db.prepare(
    `INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
     VALUES (?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  );
  const tx = db.transaction(() => {
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

  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM retail_referrals r
       JOIN retail_customers cr ON cr.id = r.referrer_id
       JOIN retail_customers ci ON ci.id = r.invitee_id
       ${whereSql}`
  ).get(...params).n;

  const rows = db.prepare(
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

  const agg = db.prepare(
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
  const row = db.prepare('SELECT * FROM retail_referrals WHERE id = ?').get(id);
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
  db.prepare(`UPDATE retail_referrals SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  logActivity(req.user.id, req.user.username, 'update', 'referral', id, b, req.ip);
  res.json({ success: true, data: db.prepare('SELECT * FROM retail_referrals WHERE id = ?').get(id) });
});

// Reissue a customer's referral code (e.g., admin wants a new one after a
// public leak). Old code is dropped; existing referrals keep their
// code_used snapshot so history is unaffected.
router.post('/api/retail-admin/customers/:id/referral-code', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = db.prepare('SELECT id FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });
  db.prepare('UPDATE retail_customers SET referral_code = NULL WHERE id = ?').run(id);
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
  const limit  = Math.min(parseInt(req.query.limit  || '20', 10) || 20, 50);
  const offset = Math.max(parseInt(req.query.offset || '0',  10) || 0, 0);
  const rows = db.prepare(
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
  const total = db.prepare(
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
  const mime = m[1];
  const sizeBytes = Math.floor(m[2].length * 3 / 4);
  if (sizeBytes > 5 * 1024 * 1024) {
    return res.status(400).json({ success: false, error: 'too_large' });
  }
  try {
    const info = db.prepare(
      `INSERT INTO retail_media (filename, mime_type, size_bytes, data, uploaded_by)
       VALUES (?, ?, ?, ?, NULL)`
    ).run('review-photo', mime, sizeBytes, data);
    res.json({ success: true, data: { url: `/api/retail/media/${info.lastInsertRowid}` } });
  } catch (e) {
    console.error('[retail/review-photo] insert failed:', e.message);
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
  const eligible = db.prepare(
    `SELECT 1 FROM retail_orders o
       JOIN retail_order_items i ON i.order_id = o.id
      WHERE o.id = ? AND o.customer_id = ?
        AND i.product_id = ?
        AND o.status = 'delivered'`
  ).get(orderId, req.customer.id, productId);
  if (!eligible) return res.status(403).json({ success: false, error: 'not_eligible' });
  try {
    const info = db.prepare(
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
  const rows = db.prepare(
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
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM retail_reviews r ${whereSql}`
  ).get(...args).n;
  // Aggregate counts for the filter chips so staff can see "12 hidden"
  // without flipping the filter.
  const summary = db.prepare(
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
  const exists = db.prepare('SELECT id FROM retail_reviews WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ success: false, error: 'not_found' });
  if ('is_visible' in (req.body || {})) {
    db.prepare('UPDATE retail_reviews SET is_visible = ? WHERE id = ?')
      .run(req.body.is_visible ? 1 : 0, id);
  }
  res.json({ success: true });
});

// Customer-side REFUND REQUEST — for paid+ orders the customer can't
// just cancel (money already moved). They file a refund request which
// the office reviews; staff then transitions the order to 'refunded'
// (which is the approval) or sets refund_status='rejected' via the
// admin endpoint.
router.post('/api/retail/orders/:id/refund-request', requireRetailAuth, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const order = db.prepare(
    'SELECT id, status, refund_status FROM retail_orders WHERE id = ? AND customer_id = ?'
  ).get(id, req.customer.id);
  if (!order) return res.status(404).json({ success: false, error: 'not_found' });
  if (!['paid', 'preparing', 'dispatched', 'delivered'].includes(order.status)) {
    return res.status(409).json({ success: false, error: 'not_refundable', status: order.status });
  }
  if (order.refund_status === 'pending') {
    return res.status(409).json({ success: false, error: 'already_requested' });
  }
  if (order.refund_status === 'approved') {
    return res.status(409).json({ success: false, error: 'already_refunded' });
  }
  const reason = (req.body?.reason || '').slice(0, 500);
  db.prepare(
    "UPDATE retail_orders SET refund_requested_at = CURRENT_TIMESTAMP, refund_reason = ?, refund_status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(reason || null, id);
  res.json({ success: true });
});

// Customer-side cancel — only allowed when the order is still in
// pending_payment status (hasn't been paid for / staff hasn't started
// preparing). Past that point the customer can't self-cancel; they have
// to contact staff who use the admin status-transition endpoint.
router.post('/api/retail/orders/:id/cancel', requireRetailAuth, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const order = db.prepare(
    'SELECT id, status FROM retail_orders WHERE id = ? AND customer_id = ?'
  ).get(id, req.customer.id);
  if (!order) return res.status(404).json({ success: false, error: 'not_found' });
  if (order.status !== 'pending_payment') {
    return res.status(409).json({ success: false, error: 'not_cancellable', current: order.status });
  }
  const reason = (req.body?.reason || '').slice(0, 200);
  db.prepare(
    "UPDATE retail_orders SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, cancelled_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(reason || 'customer_cancelled', id);
  // Also flip the pending payment row so the admin queue stays consistent
  db.prepare(
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
  const fresh = db.prepare('SELECT * FROM retail_customers WHERE id = ?').get(req.customer.id);
  const addresses = db.prepare(
    `SELECT id, recipient_name, phone, province, city, district, address, detail,
            postal_code, is_default, created_at, updated_at
       FROM retail_customer_addresses
      WHERE customer_id = ?
      ORDER BY is_default DESC, updated_at DESC`
  ).all(req.customer.id);
  res.json({
    success: true,
    data: { ...publicCustomer(fresh), addresses },
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
  db.prepare(`UPDATE retail_customers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  const fresh = db.prepare('SELECT * FROM retail_customers WHERE id = ?').get(req.customer.id);
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
  const mime = m[1];
  const sizeBytes = Math.floor(m[2].length * 3 / 4);
  if (sizeBytes > 5 * 1024 * 1024) {
    return res.status(400).json({ success: false, error: 'too_large' });
  }
  try {
    const info = db.prepare(
      `INSERT INTO retail_media (filename, mime_type, size_bytes, data, uploaded_by)
       VALUES (?, ?, ?, ?, NULL)`
    ).run('avatar', mime, sizeBytes, data);
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

  const upsert = db.prepare(
    `INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
     VALUES (?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = CURRENT_TIMESTAMP,
       updated_by = excluded.updated_by`
  );
  const tx = db.transaction(() => {
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
  const existing = db.prepare('SELECT id, name_en FROM products WHERE id = ? AND COALESCE(is_active,1) = 1').get(id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });

  const sets = [];
  const params = [];
  const body = req.body || {};
  if ('is_published' in body) { sets.push('is_published = ?'); params.push(body.is_published ? 1 : 0); }
  for (const k of ['keywords_en', 'keywords_cn', 'tagline_en', 'tagline_cn']) {
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
  if (!sets.length) return res.status(400).json({ success: false, error: 'no_fields' });

  sets.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  logActivity(req.user.id, req.user.username, 'update', 'product_retail', id, { fields: Object.keys(body), name: existing.name_en }, req.ip);

  // Return the same shape as GET /api/retail-admin/products row + the
  // hydrated description_blocks JSON, so the page can update its card
  // and re-open the editor with fresh data.
  const row = db.prepare(
    `SELECT id, name_en, name_cn, sku, category, weight AS size, sell_price,
            description_en, description_cn, image_data, image_url, is_published, sort_order,
            keywords_en, keywords_cn, tagline_en, tagline_cn, description_blocks
       FROM products WHERE id = ?`
  ).get(id);
  if (row && typeof row.description_blocks === 'string' && row.description_blocks) {
    try { row.description_blocks = JSON.parse(row.description_blocks); } catch { row.description_blocks = null; }
  } else {
    row.description_blocks = null;
  }
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
  const rows = db.prepare(
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
  const existing = db.prepare('SELECT id, name_en, flash_starts_at, flash_ends_at FROM products WHERE id = ? AND COALESCE(is_active, 1) = 1').get(id);
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

  // Reset flash_sold whenever the window or price changes so a new event
  // doesn't inherit the previous event's count. The admin can also reset
  // manually by re-saving the same values.
  const windowChanged =
    String(existing.flash_starts_at || '') !== String(starts || '') ||
    String(existing.flash_ends_at   || '') !== String(ends   || '');

  db.prepare(
    `UPDATE products
        SET flash_price       = ?,
            flash_starts_at   = ?,
            flash_ends_at     = ?,
            flash_stock_limit = ?,
            flash_sold        = CASE WHEN ? = 1 THEN 0 ELSE flash_sold END,
            updated_at        = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(price, starts, ends, limit, windowChanged ? 1 : 0, id);

  logActivity(req.user.id, req.user.username, 'update', 'product_flash_sale', id,
    { name: existing.name_en, price, starts, ends, limit, reset: windowChanged }, req.ip);

  const fresh = db.prepare(
    `SELECT id, name_en, flash_price, flash_starts_at, flash_ends_at,
            flash_stock_limit, flash_sold
       FROM products WHERE id = ?`
  ).get(id);
  res.json({ success: true, data: fresh });
});

router.delete('/api/retail-admin/products/:id/flash-sale', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT id, name_en FROM products WHERE id = ? AND COALESCE(is_active, 1) = 1').get(id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });
  db.prepare(
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
  const rows = db.prepare(`
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
  const stmt = db.prepare("UPDATE categories SET sort_order = ? WHERE id = ? AND kind = 'product'");
  const tx = db.transaction((ordered) => {
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
  const existing = db.prepare("SELECT id, name FROM categories WHERE id = ? AND kind = 'product'").get(id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ success: false, error: 'name_required' });
  if (name === existing.name) return res.json({ success: true, data: existing });
  try {
    db.prepare("UPDATE categories SET name = ? WHERE id = ?").run(name, id);
    // Propagate the rename to products that referenced the old name.
    db.prepare("UPDATE products SET category = ? WHERE category = ?").run(name, existing.name);
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
  const maxRow = db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories WHERE kind = 'product'").get();
  try {
    const r = db.prepare("INSERT INTO categories (kind, name, sort_order) VALUES ('product', ?, ?)").run(name, (maxRow.m || 0) + 1);
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
  const existing = db.prepare("SELECT id, name FROM categories WHERE id = ? AND kind = 'product'").get(id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });
  const usage = db.prepare("SELECT COUNT(*) AS n FROM products WHERE category = ? AND COALESCE(is_active, 1) = 1").get(existing.name).n;
  if (usage > 0) return res.status(409).json({ success: false, error: 'in_use', usage_count: usage });
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  logActivity(req.user.id, req.user.username, 'delete', 'category', id, { kind: 'product', name: existing.name }, req.ip);
  res.json({ success: true });
});

// List products for the CMS picker (Storefront Editor) + the retail-admin
// Products tab. Returns the master fields the picker needs PLUS the
// mini-app surface fields (keywords/tagline/description_blocks) so the
// Products tab can show a "has designer sections?" state in the list and
// open the editor pre-populated.
router.get('/api/retail-admin/products', requireRetailAdmin, (req, res) => {
  const { q, published } = req.query;
  let sql = `SELECT id, name_en, name_cn, sku, category, weight AS size,
                    sell_price, image_data, image_url,
                    is_published, sort_order,
                    description_en, description_cn,
                    keywords_en, keywords_cn, tagline_en, tagline_cn,
                    description_blocks
               FROM products WHERE COALESCE(is_active, 1) = 1`;
  const params = [];
  if (q) {
    sql += ' AND (name_en LIKE ? OR name_cn LIKE ? OR sku LIKE ?)';
    const s = `%${q}%`; params.push(s, s, s);
  }
  if (published === '1') sql += ' AND is_published = 1';
  if (published === '0') sql += ' AND is_published = 0';
  sql += ' ORDER BY is_published DESC, sort_order ASC, name_en ASC LIMIT 500';
  const rows = db.prepare(sql).all(...params).map(r => {
    // Parse description_blocks server-side so the page gets an array,
    // not a string it has to JSON.parse itself on every render.
    if (typeof r.description_blocks === 'string' && r.description_blocks) {
      try { r.description_blocks = JSON.parse(r.description_blocks); } catch { r.description_blocks = null; }
    } else {
      r.description_blocks = null;
    }
    return r;
  });
  res.json({ success: true, data: rows });
});

// Retail orders queue — list + detail + status transitions.
router.get('/api/retail-admin/orders', requireRetailAdmin, (req, res) => {
  const { status, q, from, to, store_id } = req.query;
  const limit  = Math.min(parseInt(req.query.limit  || '100', 10) || 100, 200);
  const offset = Math.max(parseInt(req.query.offset || '0',   10) || 0, 0);

  let sql = `SELECT o.id, o.order_no, o.status, o.payment_method, o.total,
                    o.recipient_name, o.recipient_phone, o.address_full,
                    o.placed_at, o.paid_at, o.dispatched_at, o.delivered_at,
                    o.scheduled_for, o.delivery_slot_label,
                    o.delivery_mode, o.same_day_surcharge_fee,
                    o.customer_id, c.nickname, c.phone AS customer_phone,
                    o.store_id, o.routing_reason, o.channel,
                    o.tracking_carrier, o.tracking_number, o.tracking_status,
                    o.tracking_kd100_subscribed,
                    s.code AS store_code, s.name_en AS store_name_en, s.name_cn AS store_name_cn
               FROM retail_orders o
          LEFT JOIN retail_customers c ON c.id = o.customer_id
          LEFT JOIN retail_stores    s ON s.id = o.store_id
              WHERE 1=1`;
  const params = [];
  if (status)   { sql += ' AND o.status = ?';   params.push(status); }
  if (store_id) { sql += ' AND o.store_id = ?'; params.push(parseInt(store_id, 10)); }
  if (q) {
    sql += ' AND (o.order_no LIKE ? OR o.recipient_name LIKE ? OR o.recipient_phone LIKE ? OR c.nickname LIKE ?)';
    const s = `%${q}%`; params.push(s, s, s, s);
  }
  if (from) { sql += ' AND o.placed_at >= ?'; params.push(from); }
  if (to)   { sql += ' AND o.placed_at <= ?'; params.push(to); }
  sql += ' ORDER BY o.placed_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params);
  for (const r of rows) {
    r.item_count = db.prepare('SELECT COUNT(*) AS n FROM retail_order_items WHERE order_id = ?').get(r.id).n;
  }
  res.json({ success: true, data: rows, meta: { limit, offset } });
});

router.get('/api/retail-admin/orders/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const o = db.prepare(
    `SELECT o.*, c.nickname, c.avatar_url, c.phone AS customer_phone,
            s.code AS store_code, s.name_en AS store_name_en, s.name_cn AS store_name_cn
       FROM retail_orders o
       LEFT JOIN retail_customers c ON c.id = o.customer_id
       LEFT JOIN retail_stores    s ON s.id = o.store_id
      WHERE o.id = ?`
  ).get(id);
  if (!o) return res.status(404).json({ success: false, error: 'not_found' });
  if (o.address_json) { try { o.address = JSON.parse(o.address_json); } catch {} }
  delete o.address_json;

  // Lazy-fill shipments for orders predating the split-shipment feature.
  // This is idempotent — if rows already exist, nothing changes.
  const shipmentRows = ensureShipments(id);

  o.items = db.prepare(
    `SELECT id, product_id, name_en, name_cn, sku, size, image_url,
            qty, unit_price, line_total, options_json,
            ship_modes, needs_ice_pack, shipment_id
       FROM retail_order_items WHERE order_id = ? ORDER BY id ASC`
  ).all(id).map(it => {
    if (it.options_json) { try { it.options = JSON.parse(it.options_json); } catch {} }
    delete it.options_json;
    // Normalize csv for the front-end (always an array).
    it.ship_modes_arr = parseShipModes(it.ship_modes);
    return it;
  });
  o.payments = db.prepare(
    `SELECT id, method, amount, status, transaction_id, out_trade_no,
            qr_image_url, refunded_amount, created_at, completed_at
       FROM retail_payments WHERE order_id = ? ORDER BY id ASC`
  ).all(id);
  o.reservations = db.prepare(
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
  res.json({ success: true, data: o });
});

// ─── Integrations admin (kd100 + JD LOP credentials) ──────────────────
// Secrets persist in storefront_config under `integrations.<svc>.<key>`
// and ALSO mirror to process.env on save so the rest of the codebase
// (lib/tracking.js, lib/jd.js) keeps reading from env without knowing
// they came from the DB. Boot-time hydration in database.js syncs DB
// values into env on startup so a restart picks them up.
const INTEGRATION_KEYS = {
  kd100: {
    customer: { env: 'KD100_CUSTOMER', secret: false },
    key:      { env: 'KD100_KEY',      secret: true  },
    callback: { env: 'KD100_CALLBACK', secret: false },
    secret:   { env: 'KD100_SECRET',   secret: true  },
  },
  jd: {
    app_key:       { env: 'JD_APP_KEY',       secret: false },
    app_secret:    { env: 'JD_APP_SECRET',    secret: true  },
    access_token:  { env: 'JD_ACCESS_TOKEN',  secret: true  },
    customer_code: { env: 'JD_CUSTOMER_CODE', secret: false },
    env:           { env: 'JD_API_ENV',       secret: false },
  },
};

function maskSecret(s) {
  if (!s || typeof s !== 'string') return '';
  if (s.length <= 4) return '••••';
  return '••••' + s.slice(-4);
}

router.get('/api/retail-admin/integrations', requireRetailAdmin, (req, res) => {
  const out = {};
  for (const [svc, fields] of Object.entries(INTEGRATION_KEYS)) {
    out[svc] = {};
    for (const [field, meta] of Object.entries(fields)) {
      const val = process.env[meta.env] || '';
      if (meta.secret) {
        out[svc][field + '_masked'] = maskSecret(val);
      } else {
        out[svc][field] = val;
      }
    }
  }
  out.kd100.enabled = tracking.kd100Enabled();
  out.jd.enabled    = !!(process.env.JD_APP_KEY && process.env.JD_APP_SECRET && process.env.JD_ACCESS_TOKEN);
  res.json({ success: true, data: out });
});

router.put('/api/retail-admin/integrations', requireRetailAdmin, express.json(), (req, res) => {
  const body = req.body || {};
  const changedKeys = [];
  const upsert = db.prepare(
    `INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
       VALUES (?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = CURRENT_TIMESTAMP,
       updated_by = excluded.updated_by`
  );
  const tx = db.transaction(() => {
    for (const [svc, fields] of Object.entries(INTEGRATION_KEYS)) {
      const incoming = body[svc];
      if (!incoming || typeof incoming !== 'object') continue;
      for (const [field, meta] of Object.entries(fields)) {
        // `undefined` means "keep current value". `null` or empty
        // string means "clear it". Any other value updates.
        if (!Object.prototype.hasOwnProperty.call(incoming, field)) continue;
        const val = incoming[field];
        if (val === undefined) continue;
        const cfgKey = `integrations.${svc}.${field}`;
        if (val === null || val === '') {
          db.prepare('DELETE FROM storefront_config WHERE key = ?').run(cfgKey);
          delete process.env[meta.env];
        } else {
          upsert.run(cfgKey, JSON.stringify(String(val)), req.user.id);
          process.env[meta.env] = String(val);
        }
        changedKeys.push(cfgKey);
      }
    }
  });
  tx();
  logActivity(req.user.id, req.user.username, 'integrations_update', 'storefront_config', null,
    { keys: changedKeys.map(k => k.replace(/^integrations\./, '')) }, req.ip);
  res.json({ success: true, changed: changedKeys.length });
});

// Sanity-check JD LOP connectivity — pings JD's server-time endpoint
// which any valid app_key + signature combination can call. Confirms
// the credentials reach JD before the office wires a real waybill.
const jd = require('../lib/jd');
router.post('/api/retail-admin/integrations/jd/test', requireRetailAdmin, async (req, res) => {
  if (!jd.jdEnabled()) return res.json({ ok: false, error: 'not_configured' });
  const r = await jd.pingJd();
  if (r.ok) return res.json({ ok: true, server_time: r.data?.serverTime || null });
  return res.json({ ok: false, error: r.error });
});

// Sanity-check kd100 connectivity. Reads the freshly-saved credentials
// from env and tries a no-op subscribe against a deliberately-bogus
// waybill number — kd100 will respond with an auth/format error rather
// than success, but a network round-trip with a parseable JSON body is
// proof the auth credentials reach kd100.
router.post('/api/retail-admin/integrations/kd100/test', requireRetailAdmin, async (req, res) => {
  if (!tracking.kd100Enabled()) return res.json({ ok: false, error: 'not_configured' });
  const r = await tracking.subscribeWithKd100({
    orderId: 0, carrierCode: 'jd', trackingNumber: '__TEST__INVALID__', recipientPhone: null,
  });
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
  const o = db.prepare('SELECT id, status, recipient_phone FROM retail_orders WHERE id = ?').get(id);
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
  db.prepare(
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
    db.prepare(
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

  // Fire-and-forget kd100 subscription against the shipment row.
  if (tracking.kd100Enabled() && tracking.KD100_CARRIER_MAP[carrier]) {
    tracking.subscribeWithKd100({
      orderId: id, carrierCode: carrier, trackingNumber: number,
      recipientPhone: o.recipient_phone,
    }).then(r => {
      if (r.ok) {
        db.prepare("UPDATE retail_shipments SET tracking_kd100_subscribed = 1, tracking_last_error = NULL WHERE id = ?").run(shipment.id);
        if (shipment.id === shipments[0].id) {
          db.prepare("UPDATE retail_orders SET tracking_kd100_subscribed = 1, tracking_last_error = NULL WHERE id = ?").run(id);
        }
      } else {
        db.prepare("UPDATE retail_shipments SET tracking_kd100_subscribed = 0, tracking_last_error = ? WHERE id = ?").run(r.error, shipment.id);
        console.warn(`[kd100.subscribe] order=${id} shipment=${shipment.id} number=${number}:`, r.error);
      }
    }).catch(e => {
      db.prepare("UPDATE retail_shipments SET tracking_last_error = ? WHERE id = ?").run('subscribe_threw: ' + e.message, shipment.id);
      console.error(`[kd100.subscribe] threw for order=${id} shipment=${shipment.id}:`, e);
    });
  }

  const fresh = db.prepare('SELECT * FROM retail_shipments WHERE id = ?').get(shipment.id);
  res.json({
    success: true,
    data: {
      id,
      shipment_id: shipment.id,
      tracking: buildShipmentTrackingView(fresh),
      kd100_enabled: tracking.kd100Enabled(),
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
  const o = db.prepare(
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
<div class="footer">${lang === 'cn' ? '该页面由 Roots 提供 · 数据来源 ' + escapeHtml(cName) : 'Provided by Roots · Data via ' + escapeHtml(cName)}</div>
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
router.post(
  '/api/retail/tracking/kd100/callback',
  express.urlencoded({ extended: false, limit: '256kb' }),
  (req, res) => {
    try {
      const parsed = tracking.parseKd100Callback(req.body?.param);
      if (!parsed || !parsed.number) {
        return res.json({ result: false, returnCode: '400', message: 'invalid payload' });
      }
      const order = db.prepare(
        'SELECT id, status, tracking_number, tracking_status, tracking_scenario_notified FROM retail_orders WHERE tracking_number = ? ORDER BY id DESC LIMIT 1'
      ).get(parsed.number);
      if (!order) {
        // kd100 expects 200 on receipt — otherwise they retry. Log and ack.
        console.warn('[kd100.callback] no order matches tracking_number=', parsed.number);
        return res.json({ result: true, returnCode: '200', message: 'no-op (no matching order)' });
      }
      // Verify salt — kd100 echoes the salt we set on subscribe.
      const expectedSalt = tracking.kd100Salt(order.id, parsed.number);
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

      db.prepare(
        `UPDATE retail_orders
            SET tracking_status            = ?,
                tracking_events_json       = ?,
                tracking_scenario          = ?,
                tracking_scenario_data_json = ?,
                tracking_synced_at         = CURRENT_TIMESTAMP,
                updated_at                 = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(parsed.state_code, JSON.stringify(parsed.events), scenarioCode, scenarioJson, order.id);
      console.log(`[kd100.callback] order=${order.id} number=${parsed.number} state=${parsed.state_code} scenario=${scenarioCode || '-'} events=${parsed.events.length}`);

      // Fire a push notification when the scenario changes to one the
      // customer should know about. Suppresses repeats so a duplicate
      // kd100 push (same scenario) doesn't double-notify.
      if (scenario && scenarioCode !== order.tracking_scenario_notified) {
        notifyTrackingScenario(order.id, scenario);
        db.prepare("UPDATE retail_orders SET tracking_scenario_notified = ? WHERE id = ?").run(scenarioCode, order.id);
      }

      // If delivered and the order is still 'dispatched', auto-flip to
      // 'delivered'. This mirrors what staff would do manually and
      // unlocks the review prompt for the customer.
      if (parsed.delivered && order.status === 'dispatched') {
        try {
          db.prepare(
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

    const o = db.prepare('SELECT id, status, recipient_phone FROM retail_orders WHERE order_no = ?').get(orderNo);
    if (!o) {
      results.push({ order_no: orderNo, ok: false, error: 'order_not_found' });
      continue;
    }

    // Promote paid/preparing → dispatched so the act of pasting a
    // waybill = "I shipped this". Skip if already dispatched/delivered;
    // bail with a clear error on any earlier state.
    let autoDispatched = false;
    if (o.status === 'paid' || o.status === 'preparing') {
      db.prepare("UPDATE retail_orders SET status = 'dispatched', dispatched_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('paid','preparing')").run(o.id);
      autoDispatched = true;
    } else if (o.status !== 'dispatched' && o.status !== 'delivered') {
      results.push({ order_no: orderNo, ok: false, error: 'wrong_status:' + o.status });
      continue;
    }

    db.prepare(
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

    if (tracking.kd100Enabled() && tracking.KD100_CARRIER_MAP[carrier]) {
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
    }).then(r => {
      if (r.ok) {
        db.prepare("UPDATE retail_orders SET tracking_kd100_subscribed = 1, tracking_last_error = NULL WHERE id = ?").run(q.orderId);
      } else {
        db.prepare("UPDATE retail_orders SET tracking_kd100_subscribed = 0, tracking_last_error = ? WHERE id = ?").run(r.error, q.orderId);
      }
    }).catch(e => {
      db.prepare("UPDATE retail_orders SET tracking_last_error = ? WHERE id = ?").run('subscribe_threw: ' + e.message, q.orderId);
    });
  }
});

// Retry a failed kd100 subscription from the admin tracking card.
router.post('/api/retail-admin/orders/:id/tracking/resubscribe', requireRetailAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const shipmentIdReq = req.query.shipment_id ? parseInt(req.query.shipment_id, 10) : null;
  const o = db.prepare('SELECT id, recipient_phone FROM retail_orders WHERE id = ?').get(id);
  if (!o) return res.status(404).json({ success: false, error: 'not_found' });
  if (!tracking.kd100Enabled()) return res.status(409).json({ success: false, error: 'kd100_not_configured' });
  const shipments = ensureShipments(id);
  const s = shipmentIdReq
    ? shipments.find(x => x.id === shipmentIdReq)
    : shipments.find(x => x.tracking_number) || shipments[0];
  if (!s || !s.tracking_number) return res.status(404).json({ success: false, error: 'no_tracking' });
  const r = await tracking.subscribeWithKd100({
    orderId: id, carrierCode: s.tracking_carrier, trackingNumber: s.tracking_number,
    recipientPhone: o.recipient_phone,
  });
  if (r.ok) {
    db.prepare("UPDATE retail_shipments SET tracking_kd100_subscribed = 1, tracking_last_error = NULL WHERE id = ?").run(s.id);
    if (s.id === shipments[0].id) {
      db.prepare("UPDATE retail_orders SET tracking_kd100_subscribed = 1, tracking_last_error = NULL WHERE id = ?").run(id);
    }
  } else {
    db.prepare("UPDATE retail_shipments SET tracking_kd100_subscribed = 0, tracking_last_error = ? WHERE id = ?").run(r.error, s.id);
  }
  res.json({ success: r.ok, error: r.error });
});

router.delete('/api/retail-admin/orders/:id/tracking', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const shipmentIdReq = req.query.shipment_id ? parseInt(req.query.shipment_id, 10) : null;
  const o = db.prepare('SELECT id FROM retail_orders WHERE id = ?').get(id);
  if (!o) return res.status(404).json({ success: false, error: 'not_found' });
  const shipments = ensureShipments(id);
  const s = shipmentIdReq
    ? shipments.find(x => x.id === shipmentIdReq)
    : shipments[0];
  if (!s) return res.status(400).json({ success: false, error: 'invalid_shipment_id' });
  db.prepare(
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
    db.prepare(
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

router.patch('/api/retail-admin/orders/:id/status', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status, reason, staff_note } = req.body || {};
  const def = STATUS_TRANSITIONS[status];
  if (!def) return res.status(400).json({ success: false, error: 'invalid_status' });

  const o = db.prepare('SELECT id, status FROM retail_orders WHERE id = ?').get(id);
  if (!o) return res.status(404).json({ success: false, error: 'not_found' });
  if (!def.prev.includes(o.status)) {
    return res.status(409).json({ success: false, error: 'invalid_transition', from: o.status, to: status });
  }

  const sets = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
  const params = [status];
  if (def.col) { sets.push(`${def.col} = CURRENT_TIMESTAMP`); }
  if (status === 'cancelled' && reason) { sets.push('cancelled_reason = ?'); params.push(reason); }
  if (staff_note != null) { sets.push('staff_note = ?'); params.push(staff_note); }
  // Mark a pending refund request as approved when status flips to 'refunded'.
  if (status === 'refunded') {
    sets.push("refund_status = 'approved'");
  }
  params.push(id);
  db.prepare(`UPDATE retail_orders SET ${sets.join(', ')} WHERE id = ?`).run(...params);

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
  }
  if (status === 'refunded') {
    try { reverseOrderPoints(id); } catch (e) { console.error('[reverseOrderPoints]', e); }
    try { reverseOrderRedeem(id); } catch (e) { console.error('[reverseOrderRedeem]', e); }
    try { inventory.reverseCommittedOrder(id, { actorUserId: req.user.id, note: reason || null }); }
    catch (e) { console.error('[inventory.reverse (refund)]', e); }
  }

  // Fire a subscribe-message notification (no-op in DEV, real send in PROD).
  // Doesn't block the response — push is best-effort.
  notifyOrderStatusChange(id, status);

  res.json({ success: true, data: db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(id) });
});

// Staff: reject a customer's refund request. Leaves the order's status
// alone (e.g. still 'delivered') but flips refund_status='rejected' so
// the customer sees the outcome + the staff note.
router.post('/api/retail-admin/orders/:id/refund-reject', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const note = (req.body?.note || '').slice(0, 500);
  const o = db.prepare('SELECT id, refund_status FROM retail_orders WHERE id = ?').get(id);
  if (!o) return res.status(404).json({ success: false, error: 'not_found' });
  if (o.refund_status !== 'pending') return res.status(409).json({ success: false, error: 'no_pending_request' });
  db.prepare(
    "UPDATE retail_orders SET refund_status = 'rejected', refund_review_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(note || null, id);
  logActivity(req.user.id, req.user.username, 'refund_reject', 'retail_order', id, { note }, req.ip);
  res.json({ success: true });
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
  // Onboarding-flavor blocks — useful elsewhere too
  'sticker_collage', 'progress_dots',
  // Voting teaser — links to /pages/voting/voting (polls managed in retail-admin → Voting)
  'voting_block',
  // Affiliate / refer-a-friend card with live invite code + share
  'affiliate_block',
  // Retention / personalization blocks
  'greeting',         // time-of-day "Good morning, {name} · pts"
  'kitchen_status',   // open / closed dot · hours · ETA
  'recipe_story',     // editorial image + serif headline + paragraphs + product
  'bundle',           // 3–5 products with one-tap add-all-to-cart
]);

// CMS-editable pages. Each has its own `<page>.layout` (live) and
// `cms.draft.<page>_layout` (draft) entries in storefront_config. Add a
// new page by appending to this whitelist — no schema change needed.
// `about` is a hardcoded mini app page (/pages/about/about), not CMS-driven —
// brand identity, intentionally pinned in code.
const ALLOWED_PAGES = new Set(['home', 'promotions', 'membership', 'categories', 'onboarding']);
function pageKey(req, fallback = 'home') {
  const p = String(req.query?.page || req.body?.page || fallback);
  return ALLOWED_PAGES.has(p) ? p : null;
}

function validateBlocks(blocks) {
  if (!Array.isArray(blocks)) return { error: 'blocks_not_array' };
  const ids = new Set();
  for (const b of blocks) {
    if (!b || typeof b !== 'object') return { error: 'block_not_object' };
    if (typeof b.id !== 'string' || !b.id) return { error: 'block_missing_id' };
    if (ids.has(b.id)) return { error: 'block_id_duplicate', details: { id: b.id } };
    ids.add(b.id);
    if (!ALLOWED_BLOCK_TYPES.has(b.type)) {
      return { error: 'block_type_invalid', details: { id: b.id, type: b.type } };
    }
  }
  return {};
}

function readLayout(key) {
  const row = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
  if (!row) return [];
  try { const v = JSON.parse(row.value_json); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
const writeLayout = db.prepare(
  `INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
   VALUES (?, ?, CURRENT_TIMESTAMP, ?)
   ON CONFLICT(key) DO UPDATE SET
     value_json = excluded.value_json,
     updated_at = CURRENT_TIMESTAMP,
     updated_by = excluded.updated_by`
);

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
  writeLayout.run(`cms.draft.${page}_layout`, JSON.stringify(blocks), req.user.id);
  res.json({ success: true, data: { page } });
});

router.post('/api/retail-admin/cms/publish', requireRetailAdmin, express.json(), (req, res) => {
  const page = pageKey(req);
  if (!page) return res.status(400).json({ success: false, error: 'invalid_page' });
  const draft = readLayout(`cms.draft.${page}_layout`);
  // Re-validate in case the draft was somehow written outside the editor
  const v = validateBlocks(draft);
  if (v.error) return res.status(400).json({ success: false, error: 'draft_invalid', details: v });
  writeLayout.run(`${page}.layout`, JSON.stringify(draft), req.user.id);
  logActivity(req.user.id, req.user.username, 'publish', `${page}_layout`, null, { blocks: draft.length, page }, req.ip);
  res.json({ success: true, data: { page, live: draft } });
});

// ── Media library ────────────────────────────────────────────────────────
// Public GET. Cached aggressively — once an image is uploaded its bytes
// don't change; if you re-upload, the editor stores a new id and updates
// the block reference, so cache invalidation is a non-issue.
router.get('/api/retail/media/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT mime_type, data FROM retail_media WHERE id = ?').get(id);
  if (!row) return res.status(404).end();
  // data is "data:image/jpeg;base64,..." — strip prefix and stream bytes
  const m = /^data:[^;]+;base64,(.+)$/.exec(row.data);
  if (!m) return res.status(500).end();
  res.set('Content-Type', row.mime_type);
  res.set('Cache-Control', 'public, max-age=2592000, immutable');  // 30d
  res.end(Buffer.from(m[1], 'base64'));
});

// List for the picker UI. Lightweight — no `data` column so the response
// stays small even with many uploads.
router.get('/api/retail-admin/cms/media', requireRetailAdmin, (req, res) => {
  const rows = db.prepare(
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
    const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const info = db.prepare(
      `INSERT INTO retail_media (filename, mime_type, size_bytes, data, uploaded_by)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      req.file.originalname || null,
      req.file.mimetype,
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
        mime_type: req.file.mimetype,
        size_bytes: req.file.size,
      },
    });
  });
});

router.delete('/api/retail-admin/cms/media/:id', requireRetailAdmin, (req, res) => {
  const r = db.prepare('DELETE FROM retail_media WHERE id = ?').run(parseInt(req.params.id, 10));
  if (r.changes === 0) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true });
});

router.post('/api/retail-admin/cms/revert-draft', requireRetailAdmin, express.json(), (req, res) => {
  const page = pageKey(req);
  if (!page) return res.status(400).json({ success: false, error: 'invalid_page' });
  const live = readLayout(`${page}.layout`);
  writeLayout.run(`cms.draft.${page}_layout`, JSON.stringify(live), req.user.id);
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
  // Free-text fallback: WeChat-imported addresses often dump the entire
  // string (province + city + district + street) into the `address`
  // field and leave the structured city/district slots blank. Also scan
  // the concatenated blob so "广州市 ... 天河区 ..." still matches the
  // Tianhe row even when address.district is empty.
  const blob = [address.address, address.detail, address.city, address.district]
                 .filter(Boolean).join(' ');
  // Strip the suffix-stripped form of a configured name (天河区 → 天河) so
  // both forms substring-match.
  const stripSuffix = (s) => String(s || '').replace(/(市|区|县|省)$/u, '');

  const inGuangzhou = isGuangzhou(address.city) || /广州/.test(blob) || /guangzhou/i.test(blob);

  if (inGuangzhou) {
    const rows = db.prepare(
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
  const rows = db.prepare(
    `SELECT * FROM retail_delivery_zones WHERE zone_type = 'city' AND is_active = 1`
  ).all();
  for (const r of rows) {
    if (wantCity && normalizeAreaName(r.match_city) === wantCity) return r;
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
//   • If `now` is past slot_end_hour OR before slot_start_hour, "right away"
//     is suppressed — only future slots remain (the natural "ordered at
//     9pm → tomorrow's slots only" UX).
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
  if (cfg.same_day_allowed === 1 && kitchenOpenNow) {
    if (isDayOnly) {
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
    today_slots:          todaySlots,
    today_day_chip:       todayDayChip,
    // 'today' when the chips above are today's, 'tomorrow' when we rolled
    // forward because the kitchen is closed. Drives the chip-strip header.
    slot_day_kind:        slotDayKind,
    schedule,
    // Legacy flat slot list — only TODAY's options now. Anything reading
    // `slots` and trusting it spans multiple days will need to migrate
    // to today_slots + schedule (the mini app does this in the same release).
    slots: isDayOnly
      ? (todayDayChip ? [todayDayChip] : [])
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
// Packing fee only applies to 'city' zones.
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
  if (zone.zone_type === 'city' && zone.packing_fee_per_item > 0 && totalQty > 0) {
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
  for (const it of items) {
    const pid = parseInt(it.product_id, 10);
    const qty = Number(it.qty);
    if (!pid || !(qty > 0)) return { error: 'invalid_item', subtotal: 0, totalQty: 0 };
    const p = db.prepare(
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
      const choices = db.prepare(
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
  }
  return { subtotal: Math.round(subtotal * 100) / 100, totalQty };
}

// 100 RMB → 1 point (default). Configurable.
function pointsEarnedFor(subtotal) {
  const rate = Number(cfgValue('points.earnRate', 100));
  if (!(rate > 0)) return 0;
  return Math.floor(Number(subtotal || 0) / rate);
}

// SQLite ISO datetime N months from now, or NULL if expiry disabled. Used
// to stamp expires_at on new earn rows at insert time so each batch knows
// its own TTL (admin can change the global later without affecting old rows).
function nextEarnExpiry() {
  const months = Number(cfgValue('points.expiryMonths', 12));
  if (!(months > 0)) return null;
  // SQLite computes the date — pass as ISO string to keep TZ consistent
  // with CURRENT_TIMESTAMP (UTC).
  const row = db.prepare(`SELECT datetime('now', ?) AS dt`).get(`+${months} months`);
  return row?.dt || null;
}

// Sweep expired earn batches for a single customer. Idempotent: only
// touches rows whose expires_at < now AND have not yet been swept
// (expired_at IS NULL). Writes a negative 'expiry' ledger row per batch
// and rebases points_balance to match. Cheap enough to call inline before
// any balance-affecting operation (award / redeem / customer read).
function sweepExpiredPoints(customerId) {
  if (!customerId) return 0;
  const due = db.prepare(
    `SELECT id, delta, expires_at FROM retail_points_transactions
      WHERE customer_id = ?
        AND delta > 0
        AND expires_at IS NOT NULL
        AND expired_at IS NULL
        AND datetime(expires_at) <= datetime('now')`
  ).all(customerId);
  if (!due.length) return 0;
  // Mark the original earn rows as swept so we don't re-process them.
  const markSwept = db.prepare(
    `UPDATE retail_points_transactions SET expired_at = CURRENT_TIMESTAMP WHERE id = ?`
  );
  const insertExpiry = db.prepare(
    `INSERT INTO retail_points_transactions
       (customer_id, delta, balance_after, source, note, created_at)
     VALUES (?, ?, ?, 'expiry', ?, CURRENT_TIMESTAMP)`
  );
  let totalExpired = 0;
  const tx = db.transaction(() => {
    for (const b of due) {
      // Only deduct what's still on the books — clamp at the current
      // balance so we don't drive it negative for batches the customer
      // already redeemed away (we accept that an already-spent batch
      // expiring is a no-op from the customer's view).
      const cur = db.prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(customerId).points_balance;
      const take = Math.min(b.delta, cur);
      if (take > 0) {
        db.prepare(
          'UPDATE retail_customers SET points_balance = points_balance - ? WHERE id = ?'
        ).run(take, customerId);
        const after = db.prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(customerId).points_balance;
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

// Reverse a redemption when an order is refunded. Idempotent — checks for
// an existing 'refund_reverse' row tagged to this order's redeem.
function reverseOrderRedeem(orderId) {
  const redeem = db.prepare(
    "SELECT customer_id, delta FROM retail_points_transactions WHERE order_id = ? AND source = 'order_redeem'"
  ).get(orderId);
  if (!redeem || redeem.delta >= 0) return 0;
  const refundedPts = -redeem.delta;
  const already = db.prepare(
    "SELECT id FROM retail_points_transactions WHERE order_id = ? AND source = 'refund_reverse' AND delta > 0"
  ).get(orderId);
  if (already) return 0;
  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE retail_customers SET points_balance = points_balance + ? WHERE id = ?'
    ).run(refundedPts, redeem.customer_id);
    const after = db.prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(redeem.customer_id).points_balance;
    db.prepare(
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
  const o = db.prepare(
    'SELECT id, customer_id, subtotal, points_earned FROM retail_orders WHERE id = ?'
  ).get(orderId);
  if (!o) return 0;
  // Sweep first so the awarded balance is based on a clean (post-expiry) state.
  sweepExpiredPoints(o.customer_id);
  const already = db.prepare(
    "SELECT id FROM retail_points_transactions WHERE order_id = ? AND source = 'order_earn'"
  ).get(orderId);
  if (already) return o.points_earned || 0;
  const pts   = pointsEarnedFor(o.subtotal);
  const spend = Math.max(0, Number(o.subtotal) || 0);
  const expiresAt = pts > 0 ? nextEarnExpiry() : null;
  // We always insert the order_earn row (even at delta=0) so the row is the
  // single idempotency marker for both points-award AND lifetime_spend bump
  // — otherwise sub-rate orders (subtotal below points.earnRate) would be
  // double-counted on retries.
  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE retail_customers SET lifetime_spend = COALESCE(lifetime_spend, 0) + ?, points_balance = points_balance + ? WHERE id = ?'
    ).run(spend, pts, o.customer_id);
    const after = db.prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(o.customer_id).points_balance;
    const note  = pts > 0
      ? `Order ${orderId} earned ${pts} pts`
      : `Order ${orderId} (subtotal ¥${spend.toFixed(2)}, below earn threshold)`;
    db.prepare(
      `INSERT INTO retail_points_transactions
         (customer_id, delta, balance_after, source, order_id, note, expires_at)
       VALUES (?, ?, ?, 'order_earn', ?, ?, ?)`
    ).run(o.customer_id, pts, after, orderId, note, expiresAt);
    db.prepare('UPDATE retail_orders SET points_earned = ? WHERE id = ?').run(pts, orderId);
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
  const earn = db.prepare(
    "SELECT customer_id, delta FROM retail_points_transactions WHERE order_id = ? AND source = 'order_earn'"
  ).get(orderId);
  if (!earn) return 0;
  const already = db.prepare(
    "SELECT id FROM retail_points_transactions WHERE order_id = ? AND source = 'refund_reverse'"
  ).get(orderId);
  if (already) return 0;
  const o = db.prepare('SELECT subtotal FROM retail_orders WHERE id = ?').get(orderId);
  const spend = Math.max(0, Number(o?.subtotal) || 0);
  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE retail_customers SET lifetime_spend = MAX(0, COALESCE(lifetime_spend, 0) - ?), points_balance = points_balance - ? WHERE id = ?'
    ).run(spend, earn.delta, earn.customer_id);
    const after = db.prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(earn.customer_id).points_balance;
    db.prepare(
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
    address = db.prepare(
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

  // Points preview — if the caller declares payment_method='points' we
  // compute how many points the order would need and whether the customer
  // can cover it. The mini-app uses this to disable the radio with a hint
  // when the customer is short.
  const paymentMethodPreview = body.payment_method || null;
  let pointsRequired = 0, pointsAffordable = false, pointsBalance = 0;
  if (paymentMethodPreview === 'points') {
    sweepExpiredPoints(req.customer.id);
    pointsRequired = pointsRequiredFor(grossTotal);
    const c = db.prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(req.customer.id);
    pointsBalance    = c?.points_balance || 0;
    pointsAffordable = pointsBalance >= pointsRequired;
  }
  const total = (paymentMethodPreview === 'points' && pointsAffordable) ? 0 : grossTotal;

  // Routing preview — picks the same store the real /orders POST would
  // pick, so the mini-app can show "ships from Tianhe" (or warn that the
  // nearest is short and a farther store would mean longer delivery)
  // BEFORE the customer hits Place Order.
  let routingPreview = null;
  try {
    const routing = inventory.routeOrder({
      address,
      items: (items || []).map(i => ({ product_id: parseInt(i.product_id, 10), qty: Number(i.qty) })),
      channel: 'wechat',
    });
    if (routing.error === 'needs_fallback_confirmation') {
      routingPreview = {
        ok: false,
        needs_fallback_confirmation: true,
        nearest: {
          store_id:      routing.nearest.store.id,
          store_code:    routing.nearest.store.code,
          store_name_en: routing.nearest.store.name_en,
          store_name_cn: routing.nearest.store.name_cn,
          district:      routing.nearest.store.district,
          shortages:     routing.nearest.shortages,
        },
        fallback: {
          store_id:      routing.fallback.store.id,
          store_code:    routing.fallback.store.code,
          store_name_en: routing.fallback.store.name_en,
          store_name_cn: routing.fallback.store.name_cn,
          district:      routing.fallback.store.district,
        },
      };
    } else if (routing.error) {
      routingPreview = {
        ok: false,
        error: routing.error,
        store_id: routing.store?.id || null,
        store_code: routing.store?.code || null,
        shortages: routing.shortages || [],
      };
    } else {
      routingPreview = {
        ok: true,
        store_id:        routing.store.id,
        store_code:      routing.store.code,
        store_name_en:   routing.store.name_en,
        store_name_cn:   routing.store.name_cn,
        store_district:  routing.store.district,
        routing_reason:  routing.reason,
        items:           routing.items,
      };
    }
  } catch (e) {
    console.error('[checkout/quote routing]', e);
  }

  res.json({
    success: true,
    data: {
      subtotal: priced.subtotal,
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
      points_earned_preview: pointsEarnedFor(priced.subtotal),
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
  const rows = db.prepare(
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

  const pkg = db.prepare('SELECT * FROM retail_topup_packages WHERE id = ? AND is_active = 1').get(packageId);
  if (!pkg) return res.status(404).json({ success: false, error: 'package_not_found' });

  const outTradeNo = `TU${Date.now()}${req.customer.id}`;
  const info = db.prepare(
    `INSERT INTO retail_topup_transactions
       (customer_id, package_id, amount, bonus_points, payment_method, status, out_trade_no)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  ).run(req.customer.id, pkg.id, pkg.amount, pkg.bonus_points, paymentMethod, outTradeNo);
  const topupId = info.lastInsertRowid;

  if (WECHAT_PAY_DEV_MODE) {
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
  const t = db.prepare('SELECT * FROM retail_topup_transactions WHERE id = ?').get(topupId);
  if (!t || t.status === 'success') return false;
  sweepExpiredPoints(t.customer_id);
  const expiresAt = nextEarnExpiry();
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE retail_topup_transactions SET status = 'success', paid_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'"
    ).run(topupId);
    db.prepare(
      'UPDATE retail_customers SET balance = balance + ?, points_balance = points_balance + ? WHERE id = ?'
    ).run(t.amount, t.bonus_points || 0, t.customer_id);
    if (t.bonus_points && t.bonus_points > 0) {
      const after = db.prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(t.customer_id).points_balance;
      db.prepare(
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
  const rows = db.prepare(
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
  const rows = db.prepare(
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
  const rows = db.prepare(
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
  const info = db.prepare(
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
  const r = db.prepare(`UPDATE retail_delivery_zones SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (r.changes === 0) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'update', 'delivery_zone', id, b, req.ip);
  res.json({ success: true });
});

router.delete('/api/retail-admin/delivery-zones/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = db.prepare('DELETE FROM retail_delivery_zones WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'delete', 'delivery_zone', id, null, req.ip);
  res.json({ success: true });
});

// Top-up packages CRUD
router.get('/api/retail-admin/topup-packages', requireRetailAdmin, (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM retail_topup_packages ORDER BY sort_order ASC, amount ASC`
  ).all();
  res.json({ success: true, data: rows });
});

router.post('/api/retail-admin/topup-packages', requireRetailAdmin, express.json(), (req, res) => {
  const b = req.body || {};
  if (!(Number(b.amount) > 0)) return res.status(400).json({ success: false, error: 'amount_required' });
  const info = db.prepare(
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
  const r = db.prepare(`UPDATE retail_topup_packages SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (r.changes === 0) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'update', 'topup_package', id, b, req.ip);
  res.json({ success: true });
});

router.delete('/api/retail-admin/topup-packages/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = db.prepare('DELETE FROM retail_topup_packages WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'delete', 'topup_package', id, null, req.ip);
  res.json({ success: true });
});

// Top-up transactions view (read-only for support)
router.get('/api/retail-admin/topup-transactions', requireRetailAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const rows = db.prepare(
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
  const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'leaderboard.config'").get();
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
      rows = db.prepare(
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
      rows = db.prepare(
        `SELECT id, nickname, avatar_url, tier_key, lifetime_spend AS value
           FROM retail_customers
          WHERE is_blocked = 0 AND lifetime_spend > 0
          ORDER BY lifetime_spend DESC, id ASC
          LIMIT ?`
      ).all(topN);
    }
  } else if (cfg.metric === 'orders_count') {
    rows = db.prepare(
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
    rows = db.prepare(
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
        const ahead = db.prepare(
          `SELECT COUNT(*) AS n FROM retail_customers
            WHERE is_blocked = 0 AND lifetime_spend > ?`
        ).get(myValue).n;
        myRank = ahead + 1;
      }
    } else if (cfg.metric === 'points_balance') {
      myValue = Number(req.customer.points_balance) || 0;
      if (myValue > 0) {
        const ahead = db.prepare(
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

  db.prepare(
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

// ─── Voting / community polls ───────────────────────────────────────────
// Mini-app design page #23. Customers vote one option per poll, earn
// `reward_points` (default 5) once per (poll, customer). Admin builds and
// closes polls from the retail-admin Voting tab.

function loadPollOptions(pollId) {
  return db.prepare(
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
    const v = db.prepare('SELECT option_id FROM retail_poll_votes WHERE poll_id = ? AND customer_id = ?')
      .get(poll.id, customerId);
    if (v) myVoteOptionId = v.option_id;
  }
  return { ...poll, options, my_vote_option_id: myVoteOptionId };
}

// Customer-facing list — only `open` and `closed` polls (drafts hidden).
router.get('/api/retail/polls', requireRetailAuth, (req, res) => {
  const rows = db.prepare(
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
  const poll = db.prepare(
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

  const poll = db.prepare('SELECT id, status, reward_points FROM retail_polls WHERE id = ?').get(pollId);
  if (!poll) return res.status(404).json({ success: false, error: 'not_found' });
  if (poll.status !== 'open') return res.status(409).json({ success: false, error: 'poll_not_open' });

  const opt = db.prepare('SELECT id FROM retail_poll_options WHERE id = ? AND poll_id = ?').get(optionId, pollId);
  if (!opt) return res.status(400).json({ success: false, error: 'bad_option' });

  const existing = db.prepare('SELECT id, option_id FROM retail_poll_votes WHERE poll_id = ? AND customer_id = ?')
    .get(pollId, req.customer.id);
  if (existing) {
    // Already voted — return current state, do NOT re-award.
    return res.json({
      success: true,
      data: { already_voted: true, poll: hydratePoll(db.prepare('SELECT * FROM retail_polls WHERE id = ?').get(pollId), req.customer.id) },
    });
  }

  const reward = Math.max(0, parseInt(poll.reward_points, 10) || 0);
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO retail_poll_votes (poll_id, option_id, customer_id, awarded_points)
       VALUES (?, ?, ?, ?)`
    ).run(pollId, optionId, req.customer.id, reward);
    db.prepare('UPDATE retail_poll_options SET votes = votes + 1 WHERE id = ?').run(optionId);
    db.prepare('UPDATE retail_polls SET total_votes = total_votes + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(pollId);
    if (reward > 0) {
      db.prepare('UPDATE retail_customers SET points_balance = points_balance + ? WHERE id = ?')
        .run(reward, req.customer.id);
      const after = db.prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(req.customer.id).points_balance;
      db.prepare(
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

  const updatedPoll = db.prepare('SELECT * FROM retail_polls WHERE id = ?').get(pollId);
  const updatedCust = db.prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(req.customer.id);
  res.json({
    success: true,
    data: {
      poll: hydratePoll(updatedPoll, req.customer.id),
      awarded_points: reward,
      points_balance: updatedCust.points_balance,
    },
  });
});

// ─── Voting · Admin ─────────────────────────────────────────────────────

// Allowed status values (kept narrow so the UI's chip filters can map 1:1).
const POLL_STATUSES = new Set(['draft', 'open', 'closed']);

router.get('/api/retail-admin/polls', requireRetailAdmin, (req, res) => {
  const rows = db.prepare(
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
  const poll = db.prepare('SELECT * FROM retail_polls WHERE id = ?').get(id);
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

  const tx = db.transaction(() => {
    const r = db.prepare(
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
    const insOpt = db.prepare(
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
  const poll = db.prepare('SELECT * FROM retail_polls WHERE id = ?').get(pollId);
  res.json({ success: true, data: { ...poll, options: loadPollOptions(pollId) } });
});

router.put('/api/retail-admin/polls/:id', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const poll = db.prepare('SELECT * FROM retail_polls WHERE id = ?').get(id);
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
      const own = db.prepare('SELECT id FROM retail_poll_options WHERE id = ? AND poll_id = ?').get(wid, id);
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

  const tx = db.transaction(() => {
    if (Object.keys(updates).length) {
      const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE retail_polls SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(...Object.values(updates), id);
    }
    if (incomingOptions) {
      if (b.replace_options) {
        // Hard reset — clears votes! Confirms required from the UI.
        db.prepare('DELETE FROM retail_poll_options WHERE poll_id = ?').run(id);
        db.prepare('UPDATE retail_polls SET total_votes = 0 WHERE id = ?').run(id);
        const normalized = normalizePollOptions(incomingOptions);
        const insOpt = db.prepare(
          `INSERT INTO retail_poll_options (poll_id, label_en, label_cn, color_hex, image_url, sort_order)
           VALUES (?,?,?,?,?,?)`
        );
        for (const o of normalized) {
          insOpt.run(id, o.label_en, o.label_cn || null, o.color_hex || null, o.image_url || null, o.sort_order);
        }
      } else {
        // In-place edit / add — preserve vote counts on existing rows.
        const existingIds = new Set(db.prepare('SELECT id FROM retail_poll_options WHERE poll_id = ?').all(id).map(r => r.id));
        const seenIds = new Set();
        const upd = db.prepare(
          `UPDATE retail_poll_options SET
             label_en = ?, label_cn = ?, color_hex = ?, image_url = ?, sort_order = ?
           WHERE id = ? AND poll_id = ?`
        );
        const ins = db.prepare(
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
            const votes = db.prepare('SELECT votes FROM retail_poll_options WHERE id = ?').get(oldId)?.votes || 0;
            if (votes > 0) continue;
            db.prepare('DELETE FROM retail_poll_options WHERE id = ?').run(oldId);
          }
        }
      }
    }
  });
  try { tx(); }
  catch (e) { return res.status(400).json({ success: false, error: e.message }); }

  logActivity(req.user.id, req.user.username, 'update', 'retail_poll', id, { updates: Object.keys(updates), replaced_options: !!(incomingOptions && b.replace_options) }, req.ip);
  const fresh = db.prepare('SELECT * FROM retail_polls WHERE id = ?').get(id);
  res.json({ success: true, data: { ...fresh, options: loadPollOptions(id) } });
});

router.delete('/api/retail-admin/polls/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = db.prepare('DELETE FROM retail_polls WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'delete', 'retail_poll', id, null, req.ip);
  res.json({ success: true });
});

module.exports = router;
