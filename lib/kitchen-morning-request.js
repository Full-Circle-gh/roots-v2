'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   THE NIGHT'S ORDERS RAISE THEIR OWN KITCHEN REQUEST — §101.
   ──────────────────────────────────────────────────────────────────────────
   §84 computes what the batch owes and draws it above the kitchen queue's
   "To make" tab. §51 and §71 built the push, the printed slip, the deep link
   and the card that closes a line and hands over to "What you made".

   EVERY PART OF THAT SECOND LIST KEYS ON A `restock_orders` ROW, and a night
   of `awaiting_restock` pre-orders creates none. So eighteen owed wraps pushed
   nothing and printed nothing, and the number existed in exactly one place,
   behind a tap nobody is prompted to make. Ash: "we need it to be push,
   print". This raises the row, and the six mechanisms that already exist carry
   it from there.

   ── WHAT THIS FILE IS NOT ALLOWED TO BECOME ────────────────────────────────

   THE DERIVATION RUNS ONE WAY. `lib/batch-owed.js` is the one definition of
   owed and is not touched, does not learn a request vocabulary, and never
   reads back from what this file writes. §84 refused to write orders into the
   request table; that refusal stands in the direction it was made, and this
   crosses it only by DERIVING a request from the number once a day — which is
   what keeps the slip and the screen unable to disagree.

   NO CADENCE HERE EITHER, for §84's own reason: units are owed whether or not
   the kitchen is cooking today, and a file that learned what a batch day is
   would be the fourth copy of arithmetic `lib/batch-cadence.js` owns.

   ── THE ONCE-A-DAY GUARD IS THE DATABASE, NOT A FILE ───────────────────────

   `lib/alert-latch`'s claimWindow was the obvious reach and is deliberately
   not used: it is per-box file state, so a rebuilt container forgets it and
   raises a second request. What is guarded here is not an advisory that can
   repeat harmlessly — it is a row somebody cooks from. `auto_source` + `date`
   is also the right answer after a restart, a redeploy, and on a second app
   server.

   A ROW THAT WAS ARCHIVED OR DELETED STILL COUNTS. "Once a day" means once,
   and re-raising what somebody has just cleared away is the opposite of what
   clearing it away meant.

   ── WHY IT CATCHES UP AND THEN STOPS ───────────────────────────────────────

   A box down at 06:00 must still print at 07:10, so the window is the hour and
   the two after it. An order landing at 15:00 must NOT raise a surprise
   request for food wanted tomorrow morning, so the window ends. It never
   crosses midnight: the `date` the guard reads would roll with it, and a
   window spanning two dates can fire twice.
   ══════════════════════════════════════════════════════════════════════════ */

const owedLib     = require('./batch-owed');
const businessDate = require('./business-date');

// Written on every row this file raises; NULL on every row a person raised,
// which is true of every row already in the table. The marker is a column
// rather than an inferred `created_by IS NULL` because that is also true of
// rows predating drop_created_by_user_fk_v1 — and a guard that is usually
// right raises a second request on the morning it is wrong.
const AUTO_SOURCE = 'morning_owed';

// The hour when the tenant has never said. §101: default on, because a tenant
// with no fresh products owes nothing and the job is inert for them anyway.
const DEFAULT_HOUR = 6;

// The hour, and the two after it. See the header.
const CATCH_UP_HOURS = 3;

// The note the slip prints under 备注. LIFTED VERBATIM from §84's own block on
// the same screen (public/m.html kqOwed), where it already means exactly this —
// docs/tacet-delivery-vocabulary.md v1.60. Nothing is composed for this row:
// `purpose='order'` already prints "For an order · 用于发货" and the slip's own
// header is already 厨房新请求.
const NOTE = 'Customer orders waiting · 有客户订单等待';

// The kitchen counts jars. `pcs` is what the phone's own request picker sends
// (rqItems in public/m.html), so a line raised here and a line typed there
// print identically.
const UNIT = 'pcs';

/* The configured hour, or null for "off".

   ABSENT ROW IS THE DEFAULT, BLANK ROW IS OFF, and the two must not be
   conflated: a tenant who has never opened the setting gets 06:00, and one who
   cleared the field meant to stop it.

   A READ FAULT IS OFF, not the default. The table is missing on an
   un-migrated account, and an account whose schema is not ready is not one to
   start raising production requests for. */
function configuredHour(db) {
  let row;
  try {
    row = db.prepare(
      "SELECT value_json FROM storefront_config WHERE key = 'fresh.morningRequestHour'"
    ).get();
  } catch (e) {
    return null;
  }
  if (!row) return DEFAULT_HOUR;
  let v;
  try { v = JSON.parse(row.value_json); } catch (e) { v = row.value_json; }
  if (v === '' || v == null) return null;
  const h = Number(v);
  return (Number.isInteger(h) && h >= 0 && h <= 23) ? h : null;
}

/* Is `nowHour` inside the window this `hour` opens? Clamped to the same
   calendar day on purpose — see the header. */
function inWindow(hour, nowHour) {
  return nowHour >= hour && nowHour < Math.min(hour + CATCH_UP_HOURS, 24);
}

/* Has today already had one? Counts archived and deleted rows — see the
   header. A read fault answers YES: not raising is recoverable next morning,
   raising a duplicate is a tray of food. */
function alreadyRaisedToday(db, ymd) {
  try {
    return !!db.prepare(
      'SELECT 1 FROM restock_orders WHERE auto_source = ? AND date = ? LIMIT 1'
    ).get(AUTO_SOURCE, ymd);
  } catch (e) {
    return true;
  }
}

/* The lines, summed per PRODUCT across every shop.

   A kitchen request carries no locations at all (§51), so there is nowhere for
   a per-shop split to live — and which shop gets the wraps is a transfer's
   question, asked once they exist.

   SKU AND BOTH NAMES, AND NO `product_id` — the shape every live kitchen
   request has, because §61 derives whether a line has been recorded by
   matching SKU first and exact name second. A line carrying an id that
   derivation does not read would look identical on screen and silently fail to
   tick off.

   CEIL, NEVER FLOOR. A fractional owed quantity is possible on a weighed line,
   and the rounding direction for "how many to prepare" is the one that does
   not leave a paid customer short. */
function owedLines(db) {
  const rows = owedLib.owedAt(db);
  if (!rows.length) return [];

  const byProduct = new Map();
  for (const r of rows) {
    let cur = byProduct.get(r.product_id);
    if (!cur) {
      cur = { product_id: r.product_id, name_en: r.name_en, name_cn: r.name_cn, qty: 0 };
      byProduct.set(r.product_id, cur);
    }
    cur.qty += Number(r.owed) || 0;
  }

  // The SKU is not on an owed row — batch-owed answers a stock question and
  // has no business carrying the key a slip matches on. One query for the
  // handful of products in the answer, the same shape restock.js's own reads
  // take.
  let skus = new Map();
  try {
    const ids = [...byProduct.keys()];
    const ph = ids.map(() => '?').join(',');
    skus = new Map(
      db.prepare(`SELECT id, sku FROM store_products WHERE id IN (${ph})`)
        .all(...ids)
        .map((p) => [p.id, p.sku || null])
    );
  } catch (e) { /* a line without a SKU still cooks; §61 falls back to the name */ }

  return [...byProduct.values()]
    .filter((r) => r.qty > 0)
    .sort((a, b) => b.qty - a.qty
      || String(a.name_en || '').localeCompare(String(b.name_en || '')))
    .map((r) => ({
      product_id: null,
      product_name: r.name_en || r.name_cn || ('#' + r.product_id),
      product_cn: r.name_cn || null,
      sku: skus.get(r.product_id) || null,
      qty_requested: Math.ceil(r.qty),
      unit: UNIT,
    }));
}

/* Raise it, or say why not.

   Returns { id, rs_number, lines } on a raise and { skipped: <reason> }
   otherwise — a reason rather than a bare null so the sweeper can log the one
   case that matters (`nothing_owed` is the normal morning) and a test can tell
   "off" from "already done".

   `genRsNumber` IS INJECTED, NOT COPIED. §80's copy rule: a second
   implementation of the per-prefix daily sequence is how two requests end up
   called PR-260911-002. routes/restock.js owns it and passes it in, which also
   keeps this file free of any dependency on a router.

   `force` skips the clock only. The once-a-day guard and the owed check are
   not skippable, because those are the two that protect the kitchen. */
function raiseMorningRequest(db, opts = {}) {
  const { now = new Date(), tz = null, genRsNumber, force = false } = opts;
  const zone  = tz || businessDate.shopTimezone(db);
  const parts = businessDate.zoneParts(zone, now);

  const hour = configuredHour(db);
  if (hour == null) return { skipped: 'off' };
  if (!force && !inWindow(hour, parts.hour)) return { skipped: 'not_due' };
  if (alreadyRaisedToday(db, parts.ymd)) return { skipped: 'already_raised' };

  const lines = owedLines(db);
  if (!lines.length) return { skipped: 'nothing_owed' };
  if (typeof genRsNumber !== 'function') return { skipped: 'no_numberer' };

  const rsNumber = genRsNumber('PR');
  const sentAt = new Date().toISOString();

  // Both locations NULL and no store name: a kitchen request is production,
  // not a transfer, and routes/restock.js nulls the same two ends on create.
  const insertOrder = db.prepare(`INSERT INTO restock_orders
    (rs_number, date, status, store_name, store_cn, notes, sent_at, created_by,
     from_role, to_role, purpose, from_store_id, to_store_id, auto_source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertItem = db.prepare(`INSERT INTO restock_items
    (restock_id, product_id, product_name, product_cn, sku, qty_requested, unit, notes)
    VALUES (?,?,?,?,?,?,?,?)`);

  const tx = db.transaction(() => {
    const r = insertOrder.run(
      rsNumber, parts.ymd, 'sent', null, null, NOTE, sentAt, null,
      'warehouse', 'kitchen', 'order', null, null, AUTO_SOURCE);
    const id = r.lastInsertRowid;
    for (const line of lines) {
      insertItem.run(id, null, line.product_name, line.product_cn, line.sku,
        line.qty_requested, line.unit, null);
    }
    return id;
  });

  const id = tx();
  return { id, rs_number: rsNumber, lines };
}

/* ── The sweeper ───────────────────────────────────────────────────────────
   Every minute, because the window it is looking for is an hour and the clock
   it reads is the tenant's. The common tick is one config read and an integer
   comparison; nothing is queried past that unless the hour has arrived.

   THE SIDE EFFECTS ARE INJECTED AND RUN INSIDE THE TENANT'S SCOPE. Push, the
   broadcast and the printer all resolve their database through `tdb()`, which
   in a bare timer callback answers the MAIN handle — so a request raised for
   tenant 7 would have printed from Roots' printer config. `tenantAls.run` is
   the same wrapper lib/inventory.js's own sweeper uses, for the same reason.

   `onRaised(result)` is called exactly once per raised request, and its throw
   is caught: a failed push must not cost the row, which is already committed
   and already visible in the queue. */
function startMorningKitchenRequestSweeper(ctx = {}, { intervalMs = 60_000 } = {}) {
  const { tdb, tenantAls, rawTenantDb, getTenantDb, ROOTS_TENANT_ID, DATA_ISOLATION_READY }
    = require('./tenant-db');
  const { genRsNumber, onRaised } = ctx;

  const sweepScope = (label) => {
    try {
      const res = raiseMorningRequest(tdb(), { genRsNumber });
      if (!res || res.skipped) return;
      console.log(`[kitchen.morning] ${label} raised ${res.rs_number} lines=${res.lines.length}`);
      if (typeof onRaised === 'function') {
        try { onRaised(res); }
        catch (e) { console.error(`[kitchen.morning] ${label} notify failed`, e.message); }
      }
    } catch (e) {
      console.error(`[kitchen.morning] ${label} error`, e.message);
    }
  };

  // The control-plane `tenants` table lives on the main/Roots db. Empty on any
  // error so the sweep still runs for Roots — lib/inventory.js's own helper,
  // same query and same failure direction.
  const activeNonRootsTenantIds = () => {
    try {
      return getTenantDb(ROOTS_TENANT_ID)
        .prepare("SELECT id FROM tenants WHERE status = 'active' AND id != ?")
        .all(ROOTS_TENANT_ID)
        .map((r) => Number(r.id))
        .filter(Boolean);
    } catch (e) {
      console.error('[kitchen.morning] tenant list failed', e.message);
      return [];
    }
  };

  const tick = () => {
    sweepScope('roots');
    if (DATA_ISOLATION_READY) {
      for (const id of activeNonRootsTenantIds()) {
        try { tenantAls.run(rawTenantDb(id), () => sweepScope('tenant ' + id)); }
        catch (e) { console.error('[kitchen.morning] tenant ' + id + ' failed', e.message); }
      }
    }
  };

  // Not at boot: a deploy inside the window would raise the request the moment
  // the process came up, which is indistinguishable from the schedule working
  // and hides a mis-set hour. One minute in is soon enough for a job whose
  // window is three hours wide.
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  return handle;
}

module.exports = {
  AUTO_SOURCE,
  DEFAULT_HOUR,
  CATCH_UP_HOURS,
  NOTE,
  UNIT,
  configuredHour,
  inWindow,
  alreadyRaisedToday,
  owedLines,
  raiseMorningRequest,
  startMorningKitchenRequestSweeper,
};
