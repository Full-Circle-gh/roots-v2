// Reviews — what a customer writes about a product after delivery, the photos
// on it, the points it can earn, and the admin Reviews tab that moderates and
// answers them. Moved out of routes/retail.js unchanged (decisions §470); the
// code below the line is what it was there, in the same order.
//
// HOW THIS FILE IS WIRED. routes/retail.js mounts it below REVIEW_WAITING_SQL
// and DEFAULT_REVIEW_TAGS, which it hands in with the other helpers it still
// owns: retail.js is still loading when it requires this file, so
// `require('../retail')` here would come back empty. Anything from lib/ or
// middleware/ is required directly, as retail.js does.
//
// WHAT STAYED IN retail.js, AND WHY.
//   • REVIEW_WAITING_SQL: the dashboard's Needs-you fire counts the same clause,
//     and scripts/test_inbox_fires.js holds the two to one string.
//   • DEFAULT_REVIEW_TAGS: the public storefront config serves it too.
//   • synthReviewAgg and mergedRecentReviews: the product detail endpoint reads
//     them for its rating summary and its three latest reviews.
//
// scripts/test_retail_split_routes.js holds this file to its thirteen endpoints
// and fails if one of them could answer a request an endpoint in another file
// also answers.

const express = require('express');
const { logActivity } = require('../../middleware/auth');
const { tdb } = require('../../lib/tenant-db');
const wxSec = require('../../lib/wx-sec-check');   // WeChat 内容安全 — every customer-published surface
const reviewTopup = require('../../lib/review-topup');

const router = express.Router();

// Filled by the mount call at the bottom. The pass-throughs below are what the
// code is written against, so they exist before anything is handed in.
const NEEDS = ['requireRetailAuth', 'requireRetailAdmin', 'synthReviewAgg', 'parseJsonArray',
  'sniffImageMime', 'submitImageSecCheck', 'isRiskyText', 'refuseContent',
  'REVIEW_WAITING_SQL', 'loadConfig', 'nextEarnExpiry'];
const deps = {};
const requireRetailAuth   = (req, res, next) => deps.requireRetailAuth(req, res, next);
const requireRetailAdmin  = (req, res, next) => deps.requireRetailAdmin(req, res, next);
const synthReviewAgg      = (...a) => deps.synthReviewAgg(...a);
const parseJsonArray      = (...a) => deps.parseJsonArray(...a);
const sniffImageMime      = (...a) => deps.sniffImageMime(...a);
const submitImageSecCheck = (...a) => deps.submitImageSecCheck(...a);
const isRiskyText         = (...a) => deps.isRiskyText(...a);
const refuseContent       = (...a) => deps.refuseContent(...a);
const REVIEW_WAITING_SQL  = (...a) => deps.REVIEW_WAITING_SQL(...a);
const loadConfig          = (...a) => deps.loadConfig(...a);
const nextEarnExpiry      = (...a) => deps.nextEarnExpiry(...a);
// Not a function, so not a pass-through: the same array retail.js holds,
// assigned at mount. Only read inside getReviewTags(), at request time.
let DEFAULT_REVIEW_TAGS = null;

// ────────────────────────────────────────────────────────────────────────────
// Items the customer still needs to review — delivered orders' items that
// don't yet have a row in retail_reviews for (customer, order, product).
// Powers the Me-tab Review bucket's dedicated list page.
router.get('/api/retail/reviews/pending', requireRetailAuth, (req, res) => {
  const rows = tdb().prepare(
    `SELECT oi.product_id, oi.name_en, oi.name_cn,
            NULLIF(oi.image_url, '') AS oi_image_url,
            NULLIF(p.image_url, '')  AS p_image_url,
            (p.image_data IS NOT NULL AND p.image_data != '') AS has_image_data,
            p.updated_at AS p_updated_at,
            oi.qty,
            o.id AS order_id, o.order_no, o.delivered_at
       FROM retail_order_items oi
       JOIN retail_orders o ON o.id = oi.order_id
  LEFT JOIN store_products p      ON p.id = oi.product_id
      WHERE o.customer_id = ? AND o.status = 'delivered'
        AND NOT EXISTS (
              SELECT 1 FROM retail_reviews r
               WHERE r.customer_id = o.customer_id
                 AND r.order_id = o.id
                 AND r.product_id = oi.product_id
            )
      ORDER BY o.delivered_at DESC, oi.id ASC`
  ).all(req.customer.id);

  // NEVER ship inline base64 here. When a product's photo lives in
  // products.image_data (a multi-MB data: URI), a few pending rows push the
  // JSON past WeChat's ~1MB setData() cap — setData silently fails, so the
  // list never renders AND `loading` never clears, leaving the page blank
  // (no items, no empty-state). Mirror the shop-list fix (GET /api/retail/
  // products): emit a tiny ABSOLUTE URL to the byte-streaming image endpoint
  // when only base64 exists. Absolute (not /api/...) so the live mini-app
  // renders it directly without an absUrl() pass it doesn't have yet.
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const data = rows.map(r => {
    let image_url = r.oi_image_url || r.p_image_url || '';
    if (!image_url && r.has_image_data) {
      image_url = `${baseUrl}/api/retail/products/${r.product_id}/image?v=${encodeURIComponent(r.p_updated_at || '')}`;
    }
    return {
      product_id: r.product_id,
      name_en: r.name_en,
      name_cn: r.name_cn,
      image_url,
      qty: r.qty,
      order_id: r.order_id,
      order_no: r.order_no,
      delivered_at: r.delivered_at,
    };
  });
  res.json({ success: true, data });
});

const REVIEW_MAX_PHOTOS = 6;

function synthReviewsTableExists() {
  try {
    return !!tdb().prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='retail_synthetic_reviews'"
    ).get();
  } catch { return false; }
}

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
  // Merge real + synthetic reviews via UNION ALL so offset pagination stays
  // correct across both tables. Synthetic ids surface negative (collision-free
  // wx:key); synthetic rows have no photos/avatar.
  let rows, total;
  try {
    rows = tdb().prepare(
      `SELECT id, rating, comment, created_at, tags_json, photos_json, reply, reply_at, customer_name, customer_avatar
         FROM (
           SELECT r.id AS id, r.rating AS rating, r.comment AS comment, r.created_at AS created_at,
                  r.tags_json AS tags_json, r.photos_json AS photos_json,
                  r.reply AS reply, r.reply_at AS reply_at,
                  c.nickname AS customer_name, c.avatar_url AS customer_avatar
             FROM retail_reviews r
        LEFT JOIN retail_customers c ON c.id = r.customer_id
            WHERE r.product_id = ? AND r.is_visible = 1
           UNION ALL
           SELECT -s.id AS id, s.rating, s.comment, s.created_at,
                  s.tags_json, NULL AS photos_json,
                  s.reply, s.reply_at,
                  s.reviewer_name AS customer_name, NULL AS customer_avatar
             FROM retail_synthetic_reviews s
            WHERE s.product_id = ? AND s.is_visible = 1
         )
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`
    ).all(id, id, limit, offset);
    const real = tdb().prepare('SELECT COUNT(*) AS n FROM retail_reviews WHERE product_id = ? AND is_visible = 1').get(id).n;
    total = real + synthReviewAgg(id).n;
  } catch {
    // Synthetic table missing → real reviews only.
    rows = tdb().prepare(
      `SELECT r.id, r.rating, r.comment, r.created_at, r.tags_json, r.photos_json,
              r.reply, r.reply_at,
              c.nickname AS customer_name, c.avatar_url AS customer_avatar
         FROM retail_reviews r
    LEFT JOIN retail_customers c ON c.id = r.customer_id
        WHERE r.product_id = ? AND r.is_visible = 1
        ORDER BY r.created_at DESC
        LIMIT ? OFFSET ?`
    ).all(id, limit, offset);
    total = tdb().prepare('SELECT COUNT(*) AS n FROM retail_reviews WHERE product_id = ? AND is_visible = 1').get(id).n;
  }
  rows = rows.map(r => ({
    ...r,
    tags:   parseJsonArray(r.tags_json),
    photos: parseJsonArray(r.photos_json),
    tags_json: undefined, photos_json: undefined,
  }));
  res.set('Cache-Control', 'public, max-age=30');
  res.json({ success: true, data: rows, meta: { total, limit, offset } });
});

// Customer uploads a single review photo. Same base64-data-URI flow as
// the avatar endpoint — wx.uploadFile's separate AppID whitelist isn't
// provisioned on the preview AppID so we go through wx.request.
router.post('/api/retail/review-photos', requireRetailAuth, express.json({ limit: '8mb' }), async (req, res) => {
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
    // Same content check as the avatar, on the comment scene. The review that
    // carries this photo stays hidden until the verdict says it's fine.
    const secStatus = await submitImageSecCheck(info.lastInsertRowid, req.customer, wxSec.SCENE.COMMENT);
    res.json({
      success: true,
      data: { url: `/api/retail/media/${info.lastInsertRowid}`, sec_status: secStatus },
    });
  } catch (e) {
    console.error('[retail/review-photo] insert failed:', e.message);
    res.status(500).json({ success: false, error: 'db_insert_failed' });
  }
});

// Customer submits a review. Must own a 'delivered' order containing this
// product (anti-spam — only buyers can review). One review per
// (customer, product, order) — UNIQUE constraint catches dupes.
// ── Reward for leaving a review ──────────────────────────────────────────────
// Reviewing currently earns a customer nothing, which is the likeliest reason
// there are far more seeded reviews than real ones. This pays points for the
// act of reviewing.
//
// ⚠️ The reward is deliberately NOT conditional on the rating, and must never
// become so. Paying for 5★ specifically is what turns an incentive into a
// fake-review scheme — it is the thing 电子商务法 art.17 names, and it is also
// how a review corpus stops being worth reading. Any rating earns the same.
//
// Config lives in storefront_config under 'reviews.reward'.
const REVIEW_REWARD_DEFAULTS = Object.freeze({
  enabled: false,      // opt-in; an upgrade never starts paying points on its own
  points: 20,          // per rewarded review
  max_per_order: 1,    // a 10-item order shouldn't be a 10x points farm
});

function getReviewReward() {
  let saved = {};
  try {
    const row = tdb().prepare("SELECT value_json FROM storefront_config WHERE key = 'reviews.reward'").get();
    if (row && row.value_json) saved = JSON.parse(row.value_json) || {};
  } catch { saved = {}; }
  const clampInt = (v, lo, hi, dflt) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  return {
    enabled:       !!saved.enabled,
    points:        clampInt(saved.points,        0, 10000, REVIEW_REWARD_DEFAULTS.points),
    max_per_order: clampInt(saved.max_per_order, 1, 50,    REVIEW_REWARD_DEFAULTS.max_per_order),
  };
}
// Grant the reward for one freshly-inserted review. Returns the points given
// (0 when off, capped, or zero-valued). Best-effort: a failure here must never
// cost the customer the review they just wrote, so it is caught by the caller.
function awardReviewPoints(customerId, orderId, reviewId) {
  const cfg = getReviewReward();
  if (!cfg.enabled || cfg.points <= 0 || !customerId) return 0;
  // Cap per ORDER, counted from the ledger itself so it survives a retry.
  const given = tdb().prepare(
    "SELECT COUNT(*) AS n FROM retail_points_transactions WHERE order_id = ? AND source = 'review_earn'"
  ).get(orderId).n;
  if (given >= cfg.max_per_order) return 0;
  // Same expiry clock as order_earn — a reward is a liability like any other
  // point, and NULL here would mean it never expires.
  const expiresAt = nextEarnExpiry();
  tdb().transaction(() => {
    tdb().prepare('UPDATE retail_customers SET points_balance = COALESCE(points_balance, 0) + ? WHERE id = ?')
      .run(cfg.points, customerId);
    const after = tdb().prepare('SELECT points_balance FROM retail_customers WHERE id = ?')
      .get(customerId).points_balance;
    tdb().prepare(
      `INSERT INTO retail_points_transactions
         (customer_id, delta, balance_after, source, order_id, note, expires_at)
       VALUES (?, ?, ?, 'review_earn', ?, ?, ?)`
    ).run(customerId, cfg.points, after, orderId, 'Review #' + reviewId, expiresAt);
  })();
  return cfg.points;
}

router.post('/api/retail/products/:id/reviews', requireRetailAuth, express.json(), async (req, res) => {
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

  // A review is the most public thing a customer can write here, so both the
  // words and the pictures go past WeChat before anyone else can read them.
  if (comment.trim() && await isRiskyText(req.customer, comment, wxSec.SCENE.COMMENT)) {
    return refuseContent(res);
  }
  // Photos were submitted for checking when they were uploaded. Refuse a
  // review outright if a verdict already came back bad; hold it back (hidden,
  // sec_hold = 1) while any verdict is still outstanding.
  let secHold = 0;
  if (photos.length) {
    const ids = photos.map(p => parseInt(p.split('/').pop(), 10)).filter(Boolean);
    const rows = ids.length ? tdb().prepare(
      `SELECT sec_status FROM retail_media WHERE id IN (${ids.map(() => '?').join(',')})`
    ).all(...ids) : [];
    if (rows.some(r => r.sec_status === 'risky')) return refuseContent(res);
    secHold = rows.some(r => r.sec_status === 'pending') ? 1 : 0;
  }

  try {
    const info = tdb().prepare(
      `INSERT INTO retail_reviews
         (customer_id, product_id, order_id, rating, comment, tags_json, photos_json,
          is_visible, sec_hold)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      req.customer.id, productId, orderId,
      rating, comment || null,
      tags.length   ? JSON.stringify(tags)   : null,
      photos.length ? JSON.stringify(photos) : null,
      secHold ? 0 : 1, secHold,
    );
    // Points for reviewing. A held-back (sec_hold) review still earns — the
    // customer did the work, and the hold is our check running late, not their
    // fault. Never let a reward failure fail the review itself.
    let pointsAwarded = 0;
    try {
      pointsAwarded = awardReviewPoints(req.customer.id, orderId, info.lastInsertRowid);
    } catch (e) {
      console.error('[reviews/reward]', e.message);
    }
    res.json({ success: true, data: { id: info.lastInsertRowid, points_awarded: pointsAwarded } });
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
  // Free-text search over the comment and the product name, so staff can find
  // a review by what it SAYS or what it is about, rather than being asked for
  // a numeric product id nobody knows.
  const q = String(req.query.q || '').trim();
  if (q) {
    where.push('(r.comment LIKE ? OR p.name_en LIKE ? OR p.name_cn LIKE ?)');
    const like = '%' + q.replace(/[%_]/g, (c) => '\\' + c) + '%';
    args.push(like, like, like);
  }
  // Low-rated: the reviews most worth a human reading them.
  const lowOnly = req.query.low === '1';
  if (lowOnly) where.push('r.rating <= 3');
  // "Needs reply" is REAL reviews only, deliberately: a seeded review has no
  // customer waiting on an answer, so letting them into the queue would pad
  // the one number this page exists to drive to zero.
  const needsReply = req.query.needs_reply === '1';
  if (needsReply) where.push('(' + REVIEW_WAITING_SQL('r') + ')');
  // The is_visible/rating/product_id filters apply identically to both the
  // real and synthetic review tables. Build the WHERE for each alias.
  const whereFor = (alias) => where.length
    ? 'WHERE ' + where.map(c => c.replace(/\br\./g, alias + '.')).join(' AND ')
    : '';
  // Reviews moderation list blends real customer reviews and synthetic
  // (seeded) ones into a single feed, tagged by `source` so the UI can show a
  // "seeded" badge + a hard-remove button on synthetic rows only.
  // Real-only when the queue is the filter — see the needs_reply note above.
  const synthOk = synthReviewsTableExists() && !needsReply;
  const realWhere = whereFor('r');
  const synthWhere = whereFor('s');
  const unionSql = synthOk
    ? `UNION ALL
           SELECT 'synthetic' AS source, s.id, s.rating, s.comment, s.is_visible, s.created_at,
                  s.tags_json, NULL AS photos_json, s.reply, s.reply_at, NULL AS dismissed_at,
                  s.product_id, NULL AS order_id, NULL AS customer_id,
                  p.name_en AS product_name_en, p.name_cn AS product_name_cn,
                  s.reviewer_name AS customer_name, NULL AS customer_avatar, NULL AS order_no
             FROM retail_synthetic_reviews s
        LEFT JOIN store_products p ON p.id = s.product_id
                  ${synthWhere}`
    : '';
  const rows = tdb().prepare(
    `SELECT * FROM (
           SELECT 'real' AS source, r.id, r.rating, r.comment, r.is_visible, r.created_at,
                  r.tags_json, r.photos_json, r.reply, r.reply_at, r.dismissed_at,
                  r.product_id, r.order_id, r.customer_id,
                  p.name_en  AS product_name_en, p.name_cn AS product_name_cn,
                  c.nickname AS customer_name, c.avatar_url AS customer_avatar,
                  o.order_no AS order_no
             FROM retail_reviews r
        LEFT JOIN store_products   p ON p.id = r.product_id
        LEFT JOIN retail_customers c ON c.id = r.customer_id
        LEFT JOIN retail_orders    o ON o.id = r.order_id
                  ${realWhere}
           ${unionSql}
         )
     ORDER BY created_at DESC
        LIMIT ? OFFSET ?`
  ).all(...args, ...(synthOk ? args : []), limit, offset).map(r => ({
    ...r,
    tags:   parseJsonArray(r.tags_json),
    photos: parseJsonArray(r.photos_json),
    tags_json: undefined, photos_json: undefined,
  }));
  const realTotal = tdb().prepare(
    `SELECT COUNT(*) AS n FROM retail_reviews r
       LEFT JOIN store_products p ON p.id = r.product_id ${realWhere}`
  ).get(...args).n;
  const synthTotal = synthOk
    ? tdb().prepare(
        `SELECT COUNT(*) AS n FROM retail_synthetic_reviews s
           LEFT JOIN store_products p ON p.id = s.product_id ${synthWhere}`
      ).get(...args).n
    : 0;
  const total = realTotal + synthTotal;
  // Aggregate counts for the filter chips so staff can see "12 hidden"
  // without flipping the filter. Includes synthetic reviews.
  const summary = tdb().prepare(
    `SELECT
       SUM(CASE WHEN is_visible = 1 THEN 1 ELSE 0 END) AS visible,
       SUM(CASE WHEN is_visible = 0 THEN 1 ELSE 0 END) AS hidden,
       COUNT(*) AS total
       FROM retail_reviews`
  ).get();
  // The chip counts describe the WHOLE set, so they cannot be gated on
  // synthOk — that flag also means "this query suppressed the seeded arm".
  // Gated on it, picking the Needs-reply chip made Everything read 21
  // instead of 653: the count followed the filter instead of describing it.
  if (synthReviewsTableExists()) {
    const ss = tdb().prepare(
      `SELECT
         SUM(CASE WHEN is_visible = 1 THEN 1 ELSE 0 END) AS visible,
         SUM(CASE WHEN is_visible = 0 THEN 1 ELSE 0 END) AS hidden,
         COUNT(*) AS total
         FROM retail_synthetic_reviews`
    ).get();
    summary.visible = (summary.visible || 0) + (ss.visible || 0);
    summary.hidden  = (summary.hidden  || 0) + (ss.hidden  || 0);
    summary.total   = (summary.total   || 0) + (ss.total   || 0);
  }
  // Queue counts. Computed here rather than inferred from the rows, because
  // one page of 50 cannot tell you how many of 253 are waiting.
  try {
    const q1 = tdb().prepare(
      `SELECT COUNT(*) AS n, MIN(r.created_at) AS oldest FROM retail_reviews r
        WHERE ${REVIEW_WAITING_SQL('r')}`
    ).get();
    summary.needs_reply = q1.n || 0;
    summary.oldest_unanswered = q1.oldest || null;
    // How many of the WAITING ones are unhappy. The bulk "mark as handled"
    // confirm names this out loud: burying an unread 1-star under a bulk action
    // is the one mistake this queue exists to prevent, so the operator is told
    // before they click, not after.
    summary.waiting_low = tdb().prepare(
      `SELECT COUNT(*) AS n FROM retail_reviews r
        WHERE ${REVIEW_WAITING_SQL('r')} AND r.rating <= 3`
    ).get().n || 0;
    summary.low = tdb().prepare('SELECT COUNT(*) AS n FROM retail_reviews WHERE rating <= 3').get().n || 0;
    summary.new_week = tdb().prepare(
      "SELECT COUNT(*) AS n FROM retail_reviews WHERE datetime(created_at) > datetime('now', '-7 days')"
    ).get().n || 0;
    if (synthReviewsTableExists()) {
      summary.low += tdb().prepare('SELECT COUNT(*) AS n FROM retail_synthetic_reviews WHERE rating <= 3').get().n || 0;
      summary.new_week += tdb().prepare(
        "SELECT COUNT(*) AS n FROM retail_synthetic_reviews WHERE datetime(created_at) > datetime('now', '-7 days')"
      ).get().n || 0;
      summary.seeded = tdb().prepare('SELECT COUNT(*) AS n FROM retail_synthetic_reviews').get().n || 0;
    } else {
      summary.seeded = 0;
    }
  } catch (e) {
    // A missing count degrades the header to fewer numbers; it must never
    // take the list down with it.
    console.error('[reviews summary]', e.message);
  }
  res.json({
    success: true,
    data: rows,
    meta: { total, limit, offset, summary },
  });
});

// Unseen customer reviews since the client's last-seen time — red dot + chime
// on the Inbox › Reviews sub-tab, mirroring the new-order notification.
router.get('/api/retail-admin/reviews/unseen-count', requireRetailAdmin, (req, res) => {
  const since = String(req.query.since || '').trim();
  const sinceSql = since || '1970-01-01T00:00:00.000Z';
  const row = tdb().prepare(
    `SELECT COUNT(*) AS n, MAX(created_at) AS latest
       FROM retail_reviews
      WHERE datetime(created_at) > datetime(?)`
  ).get(sinceSql);
  res.json({ success: true, data: { count: row.n || 0, latest: row.latest || null } });
});

// Staff moderation toggle — currently just is_visible. Keeping the body
// shape PATCH-style so we can grow this without an API rename.
// `source: 'synthetic'` targets a seeded review instead of a real one.
router.patch('/api/retail-admin/reviews/:id', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const synthetic = (req.body && req.body.source) === 'synthetic';
  const table = synthetic ? 'retail_synthetic_reviews' : 'retail_reviews';
  const exists = tdb().prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
  if (!exists) return res.status(404).json({ success: false, error: 'not_found' });
  if ('is_visible' in (req.body || {})) {
    const visible = req.body.is_visible ? 1 : 0;
    tdb().prepare(`UPDATE ${table} SET is_visible = ? WHERE id = ?`).run(visible, id);
    logActivity(req.user.id, req.user.username, visible ? 'show' : 'hide',
      synthetic ? 'retail_synthetic_review' : 'retail_review', id, { is_visible: visible }, req.ip);
  }
  // Merchant reply — a public "seller response" shown under the review on the
  // storefront. Empty/blank string clears the reply.
  if ('reply' in (req.body || {})) {
    const reply = String(req.body.reply || '').trim().slice(0, 1000);
    if (reply) {
      tdb().prepare(`UPDATE ${table} SET reply = ?, reply_at = CURRENT_TIMESTAMP WHERE id = ?`).run(reply, id);
    } else {
      tdb().prepare(`UPDATE ${table} SET reply = NULL, reply_at = NULL WHERE id = ?`).run(id);
    }
    logActivity(req.user.id, req.user.username, reply ? 'reply' : 'reply_clear',
      synthetic ? 'retail_synthetic_review' : 'retail_review', id, { has_reply: !!reply }, req.ip);
  }
  res.json({ success: true });
});

// Clear the triage queue in one action: mark every review that is waiting on a
// reply as HANDLED, without writing a word anywhere a customer can see it.
//
// What it is not: it does not post a reply. `reply` is the public seller
// response under the review in the shop, and a bulk canned answer on reviews
// nobody has read is worse than an empty queue — it tells every one of those
// customers they were answered when they were not.
//
// The set is computed HERE from REVIEW_WAITING_SQL, not taken from the client:
//   • a page of 50 cannot dismiss a queue of 300, and a client-sent id list
//     would silently do half the job while the button said "all";
//   • a review answered by a colleague thirty seconds ago is no longer waiting,
//     so it must not be swept up by an id list built before that happened.
//
// `expect` is the count the button had on it when the operator clicked. If the
// queue has changed since the page was drawn we do NOTHING and report both
// numbers, because "Mark all 6 as handled" quietly dismissing 9 is the button
// lying about its own scope. The client re-reads and asks again.
router.post('/api/retail-admin/reviews/dismiss-waiting', requireRetailAdmin, express.json(), (req, res) => {
  const waiting = tdb().prepare(
    `SELECT r.id, r.rating FROM retail_reviews r WHERE ${REVIEW_WAITING_SQL('r')}`
  ).all();
  const expect = req.body && req.body.expect != null ? parseInt(req.body.expect, 10) : null;
  if (expect != null && !Number.isNaN(expect) && expect !== waiting.length) {
    return res.status(409).json({
      success: false, error: 'queue_changed',
      data: { expected: expect, actual: waiting.length },
    });
  }
  if (!waiting.length) return res.json({ success: true, data: { dismissed: 0, low_rated: 0 } });
  const ids = waiting.map(r => r.id);
  const lowRated = waiting.filter(r => Number(r.rating) <= 3).length;
  // One statement, one transaction — a half-dismissed queue would leave the
  // page and the dashboard disagreeing about a number that was correct a moment
  // ago, which is the failure this whole predicate exists to prevent.
  tdb().prepare(
    `UPDATE retail_reviews SET dismissed_at = CURRENT_TIMESTAMP
      WHERE id IN (${ids.map(() => '?').join(',')})`
  ).run(...ids);
  // Logged as ONE entry naming the count and how many were unhappy, so the
  // audit trail can answer "who cleared 40 reviews, and were any of them
  // complaints" without replaying forty rows.
  logActivity(req.user.id, req.user.username, 'reviews_dismiss_waiting', 'retail_review', null,
    { count: ids.length, low_rated: lowRated }, req.ip);
  res.json({ success: true, data: { dismissed: ids.length, low_rated: lowRated } });
});

// Put one dismissed review BACK in the queue. The bulk action above is the kind
// of click that gets made by accident, and without this the only way back is a
// public reply — the exact thing the dismissal existed to avoid.
router.post('/api/retail-admin/reviews/:id/undismiss', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = tdb().prepare('SELECT id FROM retail_reviews WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  tdb().prepare('UPDATE retail_reviews SET dismissed_at = NULL WHERE id = ?').run(id);
  logActivity(req.user.id, req.user.username, 'review_undismiss', 'retail_review', id, {}, req.ip);
  res.json({ success: true });
});

// Permanently remove a SYNTHETIC (seeded) review. Real customer reviews are
// audit-linked to an order and are never hard-deleted from here (they can only
// be hidden via the PATCH toggle), so this guards source==='synthetic'.
router.delete('/api/retail-admin/reviews/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (req.query.source !== 'synthetic') {
    return res.status(400).json({ success: false, error: 'only_synthetic_deletable' });
  }
  const exists = tdb().prepare('SELECT id FROM retail_synthetic_reviews WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ success: false, error: 'not_found' });
  tdb().prepare('DELETE FROM retail_synthetic_reviews WHERE id = ?').run(id);
  logActivity(req.user.id, req.user.username, 'delete', 'retail_synthetic_review', id, null, req.ip);
  res.json({ success: true });
});

// ── Seeded-review top-up ────────────────────────────────────────────────────
// The operator switch that holds every published product at a floor of N
// visible reviews, seeding the shortfall. Settings live in storefront_config
// under 'reviews.topup' and are saved through the shared config PUT; these two
// routes only report what a run WOULD do and let staff trigger one by hand.
// See lib/review-topup.js for the sweeper that runs this on a timer.
// The review reward settings, for the admin form. The write side rides the
// shared config PUT under 'reviews.reward'.
router.get('/api/retail-admin/reviews/reward', requireRetailAdmin, (req, res) => {
  try {
    const cfg = getReviewReward();
    // How the reward is actually landing, so the operator sees it working
    // rather than trusting the switch.
    const stats = tdb().prepare(
      `SELECT COUNT(*) AS grants, COALESCE(SUM(delta), 0) AS points
         FROM retail_points_transactions WHERE source = 'review_earn'`
    ).get();
    res.json({ success: true, data: { ...cfg, grants: stats.grants, points_given: stats.points } });
  } catch (e) {
    console.error('[reviews/reward GET]', e);
    res.status(500).json({ success: false, error: 'reward_read_failed' });
  }
});

router.get('/api/retail-admin/reviews/topup', requireRetailAdmin, (req, res) => {
  try {
    res.json({ success: true, data: reviewTopup.estimateTopup(tdb()) });
  } catch (e) {
    console.error('[review.topup estimate]', e);
    res.status(500).json({ success: false, error: 'estimate_failed' });
  }
});

// Run one top-up now. `force` so the preview/"Run now" button works while the
// switch is still off — the operator clicking it IS the intent. The feature
// gate inside topUpOnce still applies.
router.post('/api/retail-admin/reviews/topup/run', requireRetailAdmin, express.json(), (req, res) => {
  try {
    const added = reviewTopup.topUpOnce(tdb(), { force: true });
    if (added) {
      logActivity(req.user.id, req.user.username, 'create', 'retail_synthetic_review', null, { seeded: added }, req.ip);
    }
    res.json({ success: true, data: { added } });
  } catch (e) {
    console.error('[review.topup run]', e);
    res.status(500).json({ success: false, error: 'topup_failed' });
  }
});

module.exports = function mountReviews(d) {
  for (const k of NEEDS) {
    if (typeof d[k] !== 'function') throw new Error('routes/retail/reviews: ' + k + ' was not handed in');
  }
  if (!Array.isArray(d.DEFAULT_REVIEW_TAGS)) throw new Error('routes/retail/reviews: DEFAULT_REVIEW_TAGS was not handed in');
  Object.assign(deps, d);
  DEFAULT_REVIEW_TAGS = d.DEFAULT_REVIEW_TAGS;
  return router;
};
