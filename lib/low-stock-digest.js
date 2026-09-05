// The daily "you are running out of these" digest (audit E-06).
//
// A low-stock threshold has existed per merchant and per shop for a long time,
// and the dashboard has shown "N running low" whenever somebody opened it. No
// notification of any kind was ever sent — not a push, not an email, not a
// digest — so a merchant who did not open the admin did not find out. The
// notification catalogue held twenty entries and none was about stock.
//
// WHY A DAILY DIGEST AND NOT AN ALERT PER PRODUCT. A shop that sells through a
// busy Saturday crosses the threshold on a dozen lines at once; twelve pushes
// arriving in ten minutes is how a merchant learns to turn notifications off,
// and the notification that then goes unread is the refund one. Restocking is
// also a once-a-day job in almost every shop: the useful message is "here is
// today's shopping list", not "one more thing just went low".
//
// SHAPE COPIED FROM lib/delivery-reminders.js on purpose — the same boot-time
// sweeper, the same per-tenant fan-out, the same two-realm send, the same
// best-effort "never throw" contract. A second scheduling idea in the same
// codebase is a second thing to get wrong.
//
// WHAT IT COUNTS is the dashboard's own low-stock predicate, character for
// character: stock above zero and at or below the threshold, on a product that
// is Active, not archived and published. It must be, or the push and the screen
// it sends the merchant to would disagree about the number — which is worse
// than not sending anything.

let _push = null;
try { _push = require('../routes/push'); }
catch (e) { console.warn('[lowstock.digest] push module not available:', e.message); }

// The tenant's own setting lives here; these are what an account gets before it
// has an opinion. ON by default, because a stock warning nobody switched on is
// the case this exists to fix.
const DEFAULT_ENABLED = true;
const DEFAULT_HOUR    = 9;      // 09:00, shop-local — before the day's ordering
const DEFAULT_LOW     = 5;      // matches lowStockDefault() in routes/retail.js
const MAX_NAMED       = 5;      // how many products the message names by name

const CFG_KEY  = 'inventory.lowStockDigest';
// A SIBLING key, not a child of CFG_KEY, and that is deliberate. loadConfig()
// nests storefront_config keys by their dots, so 'inventory.lowStockDigest.lastSent'
// and 'inventory.lowStockDigest' would both write the same object in the API
// payload, and which one survived would depend on the row order SQLite happened
// to return. Two rows fighting over one path is a bug waiting for a slow week.
const SENT_KEY = 'inventory.lowStockDigestLastSent';

function readCfg(db, key, fallback) {
  try {
    const row = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
    if (!row) return fallback;
    return JSON.parse(row.value_json);
  } catch (e) { return fallback; }
}

function writeCfg(db, key, value) {
  db.prepare(
    `INSERT INTO storefront_config (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
  ).run(key, JSON.stringify(value));
}

// The account's digest settings, normalised. A malformed stored value falls
// back rather than throwing: a typo in one config row must not stop the sweeper
// for every other account in the same tick.
function digestSettings(db) {
  const raw = readCfg(db, CFG_KEY, null);
  const c = (raw && typeof raw === 'object') ? raw : {};
  const hour = Number.isInteger(c.hour) && c.hour >= 0 && c.hour <= 23 ? c.hour : DEFAULT_HOUR;
  return { enabled: c.enabled === undefined ? DEFAULT_ENABLED : !!c.enabled, hour };
}

function lowThresholdDefault(db) {
  const n = parseInt(readCfg(db, 'inventory.lowStockThreshold', DEFAULT_LOW), 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LOW;
}

// The real balance on the shelves: the sum across active stores, falling back
// to the legacy per-product column only when the product has no per-store rows
// at all. Same rule as the dashboard, the grid and the shop.
const REAL_STOCK = `COALESCE(
    (SELECT SUM(rss.physical_qty)
       FROM retail_store_stock rss
       JOIN retail_stores      rs ON rs.id = rss.store_id
      WHERE rss.product_id = p.id AND rs.is_active = 1),
    p.stock_qty, 0)`;

/**
 * What is running low right now. Returns { count, items } where items are the
 * shortest-stocked few, for naming in the message.
 *
 * `> 0` STAYS, for the reason the dashboard states: a zero or negative balance
 * is a different condition ("sold out", or "the record was already wrong") with
 * a different fix, and a product must never be counted by both.
 */
function lowStockNow(db) {
  const lowDefault = lowThresholdDefault(db);
  const WHERE = `
     WHERE ${REAL_STOCK} > 0
       AND ${REAL_STOCK} <= COALESCE(p.low_stock_threshold, @low_default)
       AND p.status = 'Active' AND COALESCE(p.is_active,1) = 1 AND p.is_published = 1`;
  const count = db.prepare(
    `SELECT COUNT(*) AS n FROM store_products p ${WHERE}`
  ).get({ low_default: lowDefault }).n;
  if (!count) return { count: 0, items: [] };
  const items = db.prepare(
    `SELECT p.id, p.name_en, p.name_cn, ${REAL_STOCK} AS qty
       FROM store_products p ${WHERE}
      ORDER BY qty ASC, p.name_en ASC LIMIT @named`
  ).all({ low_default: lowDefault, named: MAX_NAMED });
  return { count, items };
}

// The message. Names the shortest few and counts the rest, because "12 products
// are running low" is a number to go and look up, while "Oat milk (2), Tofu (3)
// and 10 more" is already half the shopping list.
function digestBody(low) {
  const names = low.items
    .map(i => `${(i.name_en || i.name_cn || '').trim()} (${i.qty})`)
    .filter(s => s && !s.startsWith('('));
  const rest = low.count - names.length;
  if (!names.length) return `${low.count} products are running low.`;
  const head = names.join(', ');
  return rest > 0 ? `${head}, and ${rest} more.` : `${head}.`;
}

// Who is told. Same two-realm shape, and for the same reason, as
// lib/delivery-reminders.js: the capability send reaches an account's own
// operators (who are `tenant_users`, not kitchen `users`), and the legacy
// permission send is what the first account's staff already receive.
//
// Two capabilities, either of which is enough: whoever edits products sets the
// stock figures, and whoever raises a restock request is the person who acts on
// this. `products:view` is deliberately NOT in the list — being able to read the
// catalogue is not a reason to be woken about it.
function notifyStockOwners(tenantId, payload) {
  if (tenantId != null && _push && _push.sendPushToOperatorsWithCaps) {
    Promise.resolve(_push.sendPushToOperatorsWithCaps(tenantId, ['products:edit', 'restock:request'], payload))
      .catch(e => console.warn('[lowstock.digest operator push]', e.message));
  }
  if (_push && _push.sendPushByPermission) {
    Promise.resolve(_push.sendPushByPermission('retail', payload))
      .catch(e => console.warn('[lowstock.digest permission push]', e.message));
  }
}

// Local calendar day as YYYY-MM-DD. The host runs at the business's timezone
// (the same assumption every other sweeper in this service makes and states),
// so the local Date getters read the shop's wall clock.
function localDay(d) {
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

/**
 * One account, one tick. Sends at most one digest per local day, and only once
 * the configured hour has arrived.
 *
 * The guard is a stored day string, claimed BEFORE the send: if the write says
 * today is already claimed, this tick does nothing. That is what makes an
 * overlapping tick, a restart, or a slow push harmless — the alternative is a
 * merchant getting the same list four times because the process bounced.
 *
 * Returns 1 if a digest went out, 0 otherwise. Never throws.
 */
function sweepDbOnce(db, now, tenantId = null) {
  try {
    const { enabled, hour } = digestSettings(db);
    if (!enabled) return 0;
    if (now.getHours() < hour) return 0;            // too early today
    const today = localDay(now);
    if (readCfg(db, SENT_KEY, null) === today) return 0;

    const low = lowStockNow(db);
    // Nothing is low. Claim the day anyway: without this the sweeper re-runs the
    // count every tick for the rest of the day, and — worse — a product dipping
    // low at 16:00 would fire a digest hours after the ordering was done, which
    // is the per-product alert this deliberately is not.
    writeCfg(db, SENT_KEY, today);
    if (!low.count) return 0;

    notifyStockOwners(tenantId, {
      title: `${low.count} ${low.count === 1 ? 'product is' : 'products are'} running low · ${low.count} 件商品库存偏低`,
      body: digestBody(low),
      // Straight to the Products list already filtered to what is low, so the
      // push lands on the work rather than on a home page.
      url: '/?tab=products&filter=low',
      tag: 'low-stock-digest',
    });
    return 1;
  } catch (e) {
    console.error('[lowstock.digest] sweep error', e.message);
    return 0;
  }
}

/**
 * Start the sweeper. ctx = { mainDb, getTenantDb } fans out across active
 * accounts; a bare better-sqlite3 handle, or no ctx, falls back to a single-DB
 * sweep. Identical to startDeliveryReminderSweeper's contract.
 *
 * Ten minutes, not one: the send is once a day and the day-claim makes a missed
 * tick cost nothing, so a minute-resolution sweep would be 1,440 scans of the
 * catalogue to place one message. The worst case is a digest up to ten minutes
 * after the configured hour, which no merchant will ever notice.
 */
function startLowStockDigestSweeper(ctx = {}, { intervalMs = 10 * 60_000 } = {}) {
  const legacyDb = (ctx && typeof ctx.prepare === 'function') ? ctx : null;
  const { mainDb, getTenantDb } = legacyDb ? {} : ctx;
  const tick = () => {
    try {
      const now = new Date();
      let total = 0;
      if (legacyDb) {
        total += sweepDbOnce(legacyDb, now);
      } else if (mainDb && getTenantDb) {
        let tenants;
        try { tenants = mainDb.prepare("SELECT id FROM tenants WHERE status = 'active'").all(); }
        catch { tenants = null; }                 // tenants table not migrated yet
        if (!tenants) {
          total += sweepDbOnce(mainDb, now);
        } else {
          for (const t of tenants) {
            try { total += sweepDbOnce(getTenantDb(t.id), now, t.id); }
            catch (e) { console.error('[lowstock.digest] tenant ' + t.id + ' failed', e.message); }
          }
        }
      } else if (mainDb) {
        total += sweepDbOnce(mainDb, now);
      }
      if (total > 0) console.log(`[lowstock.digest] sent=${total}`);
    } catch (e) {
      console.error('[lowstock.digest] tick error', e);
    }
  };
  // A minute after boot, then on interval. Later than the delivery sweeper's 15
  // seconds on purpose: a restart at 09:05 should not race the other sweepers
  // for the first tick, and nothing here is time-critical to the second.
  setTimeout(tick, 60_000);
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  return handle;
}

module.exports = {
  startLowStockDigestSweeper,
  sweepDbOnce,
  lowStockNow,
  digestSettings,
  digestBody,
  CFG_KEY,
  SENT_KEY,
};
