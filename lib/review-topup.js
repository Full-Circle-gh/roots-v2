//
// Seeded-review TOP-UP sweeper.
//
// Keeps every published product at a floor of N visible reviews by generating
// seeded (synthetic) ones for whatever is short. Operators turn it on and set N
// from Mini App Backend → Inbox → Reviews; it is OFF by default and an upgrade
// never switches it on, because turning it on publishes fabricated reviews to
// shoppers and that has to be a deliberate act by the operator, not a default.
//
// Naturally idempotent: a run brings each product UP TO the floor, so a second
// run over an unchanged catalogue inserts nothing.
//
// It is still THROTTLED, which the first version was not. The tick fires 120s
// after boot, so with the interval measured from process start every deploy
// bought another full run and "50 per run" meant "50 per deploy". The last
// productive run is recorded in the database so the gap is wall-clock.
//
// Everything it writes lands in retail_synthetic_reviews under a made-up
// reviewer name. It never reads, writes or references retail_customers,
// retail_orders or retail_reviews beyond COUNTing the real reviews a product
// already has, so no real customer is ever attributed an opinion.
//
const seeder = require('./review-seeder');

// Operator-facing config, stored as ONE storefront_config row under the dotted
// key 'reviews.topup' (loadConfig() expands it to cfg.reviews.topup).
const TOPUP_DEFAULTS = Object.freeze({
  enabled: false,      // off unless an operator deliberately turns it on
  min_reviews: 3,      // the floor every published product is held at
  max_per_run: 50,     // stops a first-enable run flooding the whole catalogue
  span_days: 45,       // how far back generated reviews are dated
});
// A product listed minutes ago that already has three reviews is the tell that
// gives a seeded feed away, so leave new listings alone for a day. Internal —
// deliberately not operator-tunable, there is no good reason to lower it.
const MIN_AGE_HOURS = 24;

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function getTopupConfig(db) {
  let saved = {};
  try {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'reviews.topup'").get();
    if (row && row.value_json) saved = JSON.parse(row.value_json) || {};
  } catch { saved = {}; }
  return {
    enabled:     !!saved.enabled,
    min_reviews: clampInt(saved.min_reviews, 1, 20,  TOPUP_DEFAULTS.min_reviews),
    max_per_run: clampInt(saved.max_per_run, 1, 500, TOPUP_DEFAULTS.max_per_run),
    span_days:   clampInt(saved.span_days,   1, 365, TOPUP_DEFAULTS.span_days),
  };
}

// The Product reviews feature switch (storefront_config 'features.reviews').
// Off = reviews are hidden from shoppers entirely, so topping them up would be
// writing rows nobody can see.
function reviewsFeatureOn(db) {
  try {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'features.reviews'").get();
    if (!row || row.value_json == null) return true;      // absent = default on
    return JSON.parse(row.value_json) !== false;
  } catch { return true; }
}

// When the last sweep actually seeded something. Persisted, because the
// sweeper's interval was measured from process start: it ticks 120s after
// boot, so every deploy fired a fresh run and "50 per run" quietly became
// "50 per deploy". Twelve deploys in an afternoon is twelve runs. Recording
// it in the database makes the gap wall-clock, which is what the operator
// setting means.
//
// Kept under 'reviews.topup*', which PRIVATE_CONFIG_PREFIXES already covers,
// so it never reaches the public config.
const TOPUP_STATE_KEY = 'reviews.topup_state';

function lastTopUpRun(db) {
  try {
    const row = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(TOPUP_STATE_KEY);
    if (!row || !row.value_json) return 0;
    const t = Date.parse(String((JSON.parse(row.value_json) || {}).last_run_at || ''));
    return Number.isFinite(t) ? t : 0;
  } catch { return 0; }
}

// Only called when a run actually inserted rows. A run that finds nothing to
// do costs one query, so there is nothing to throttle — and not recording it
// keeps the config's version (and every mini-app config cache) still.
function markTopUpRun(db) {
  try {
    db.prepare(
      `INSERT INTO storefront_config (key, value_json, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                      updated_at = CURRENT_TIMESTAMP`
    ).run(TOPUP_STATE_KEY, JSON.stringify({ last_run_at: new Date().toISOString() }));
  } catch (e) {
    // Losing the stamp costs an extra run, never correctness.
    console.error('[review.topup] could not record the run:', e.message);
  }
}

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch { return false; }
}

// Published + active products whose visible review count (real + seeded) is
// below the floor. Flag columns are probed rather than assumed so a tenant DB
// that predates one of them still sweeps instead of throwing.
function productsBelowFloor(db, floor) {
  const cols = db.prepare("PRAGMA table_info('store_products')").all().map(c => c.name);
  const has = (c) => cols.includes(c);
  const filt = [
    has('is_published') ? 'p.is_published = 1' : null,
    has('is_active')    ? 'COALESCE(p.is_active, 1) = 1' : null,
    has('created_at')   ? "datetime(p.created_at) <= datetime('now', '-" + MIN_AGE_HOURS + " hours')" : null,
  ].filter(Boolean);
  const sql = `
    SELECT * FROM (
      SELECT p.id, p.name_en, p.name_cn,
             ${has('category')    ? 'p.category'    : "''"} AS category,
             ${has('subcategory') ? 'p.subcategory' : "''"} AS subcategory,
             ${has('created_at')  ? 'p.created_at'  : 'NULL'} AS created_at,
             (SELECT COUNT(*) FROM retail_reviews r
               WHERE r.product_id = p.id AND r.is_visible = 1)
           + (SELECT COUNT(*) FROM retail_synthetic_reviews s
               WHERE s.product_id = p.id AND s.is_visible = 1) AS have
        FROM store_products p
        ${filt.length ? 'WHERE ' + filt.join(' AND ') : ''}
    ) WHERE have < ?
      ORDER BY have ASC, id ASC`;
  return db.prepare(sql).all(floor);
}

// What a run would do right now, without doing it. Powers the admin status line.
function estimateTopup(db) {
  const cfg = getTopupConfig(db);
  if (!tableExists(db, 'retail_synthetic_reviews') || !tableExists(db, 'store_products')) {
    return { ...cfg, products: 0, reviews: 0, uncapped: 0, available: false };
  }
  const rows = productsBelowFloor(db, cfg.min_reviews);
  const uncapped = rows.reduce((n, r) => n + (cfg.min_reviews - r.have), 0);
  return {
    ...cfg,
    products: rows.length,
    reviews: Math.min(uncapped, cfg.max_per_run),
    uncapped,
    available: true,
  };
}

// One sweep over a single tenant DB. Returns the number of reviews inserted.
// `force` runs even when the operator switch is off — used only by the admin
// "Run now" button, where the operator is asking for it explicitly.
function topUpOnce(db, { force = false } = {}) {
  const cfg = getTopupConfig(db);
  if (!cfg.enabled && !force) return 0;
  if (!reviewsFeatureOn(db)) return 0;
  if (!tableExists(db, 'retail_synthetic_reviews') || !tableExists(db, 'store_products')) return 0;

  const targets = productsBelowFloor(db, cfg.min_reviews);
  if (!targets.length) return 0;

  const namesFor = db.prepare(
    'SELECT reviewer_name FROM retail_synthetic_reviews WHERE product_id = ?'
  );
  const rows = [];
  for (const p of targets) {
    if (rows.length >= cfg.max_per_run) break;
    // Don't repeat a reviewer already sitting on this product.
    const used = new Set(namesFor.all(p.id).map(r => r.reviewer_name));
    const want = cfg.min_reviews - p.have;
    for (let i = 0; i < want && rows.length < cfg.max_per_run; i++) {
      const r = seeder.makeReview(p, {
        avoidNames: used,
        spanDays: cfg.span_days,
        notBefore: p.created_at,
      });
      used.add(r.reviewer_name);
      rows.push(r);
    }
  }
  if (!rows.length) return 0;

  const insert = db.prepare(
    `INSERT INTO retail_synthetic_reviews
       (product_id, reviewer_name, rating, comment, lang, tags_json, created_at)
     VALUES (@product_id, @reviewer_name, @rating, @comment, @lang, @tags_json, @created_at)`
  );
  db.transaction((items) => { for (const r of items) insert.run(r); })(rows);
  markTopUpRun(db);
  return rows.length;
}

// Boot-time sweeper, same shape as lib/delivery-reminders. Ticks a few minutes
// after boot and then every `intervalMs`; each tick is a no-op once the
// catalogue sits at the floor, so the cadence only decides how quickly a newly
// published product picks up its reviews.
function startReviewTopupSweeper(ctx = {}, { intervalMs = 6 * 60 * 60_000 } = {}) {
  const legacyDb = (ctx && typeof ctx.prepare === 'function') ? ctx : null;
  const { mainDb, getTenantDb } = legacyDb ? {} : ctx;
  const tick = () => {
    try {
      let total = 0;
      const sweep = (db, label) => {
        try {
          // The gap is wall-clock, not uptime: a redeploy must not buy the
          // catalogue another 50 rows.
          const since = Date.now() - lastTopUpRun(db);
          if (since < intervalMs) return;
          total += topUpOnce(db);
        } catch (e) { console.error('[review.topup] ' + label + ' failed:', e.message); }
      };
      if (legacyDb) {
        sweep(legacyDb, 'db');
      } else if (mainDb && getTenantDb) {
        let tenants;
        try { tenants = mainDb.prepare("SELECT id FROM tenants WHERE status = 'active'").all(); }
        catch { tenants = null; }                 // tenants table not migrated yet
        if (!tenants) sweep(mainDb, 'main');
        else for (const t of tenants) sweep(getTenantDb(t.id), 'tenant ' + t.id);
      } else if (mainDb) {
        sweep(mainDb, 'main');
      }
      if (total > 0) console.log(`[review.topup] seeded=${total}`);
    } catch (e) {
      console.error('[review.topup] tick error', e);
    }
  };
  setTimeout(tick, 120_000);
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
}

module.exports = {
  TOPUP_DEFAULTS, MIN_AGE_HOURS, TOPUP_STATE_KEY,
  getTopupConfig, estimateTopup, topUpOnce, startReviewTopupSweeper,
  lastTopUpRun, markTopUpRun,
};
