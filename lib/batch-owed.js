'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   WHAT TODAY'S BATCH OWES — §84.
   ──────────────────────────────────────────────────────────────────────────
   ONE NUMBER PER (STORE, PRODUCT): how many units are already promised to
   customers and are not on the shelf. It is what the kitchen adds to the batch
   it is about to make, and before this module nothing in the system computed
   it — not as a total, not per product, not for any channel.

   Reported by Ash as the routine the §74/§80 pre-order rule depends on: "in the
   morning when kitchen come to work they already see how many fresh meals and
   wraps need to be prepared and they will add those extra to the batch they are
   about to do." They could not. 厨房制作队列 renders REQUESTS somebody typed,
   `retail_order_items` is read by none of the kitchen's routes, and the
   dashboard's waiting-orders card counts ORDERS rather than units and excludes
   every platform by SQL.

   ── THE DEFINITION, AND WHY IT IS TWO TERMS AND NOT ONE ────────────────────

     owed = how far the shelf has fallen BELOW ZERO
          + units on `awaiting_restock` orders

   They are disjoint, and each covers what the other cannot:

     • A NEGATIVE SHELF is the channels' debt. Since §84 the Meituan and Eleme
       ingests no longer clamp at zero, so an order taken at 08:00 against an
       empty shelf drives the count to −18 — which §39 already established is
       the honest reading: "it says stock was sold that was never held, which
       really happened." Those orders are LIVE on the platform; nothing is
       waiting for our permission, and the units are simply owed.

     • AN `awaiting_restock` ORDER is the mini app's, and it never touches the
       shelf at all. §80 parks it deliberately holding no stock — there is
       nothing on the shelf to reserve — so it can never show up as a negative
       and must be counted from the order lines themselves.

   Adding them cannot double-count precisely BECAUSE of that difference: a
   parked order has no reservation and no ledger row, so it contributes nothing
   to physical_qty, and a channel order contributes nothing to the parked set.

   ── §265: A THIRD TERM, FOR THE ORDER SOLD AS "MADE FRESH" ─────────────────

     owed += fresh lines on PAID orders promised a batch on or before today
             that have not yet come off the shelf

   Found on two out-of-town WeChat orders, 2026-09-25: both read "Paid · Stock
   pending · made fresh · ship Sep 26" and the kitchen was told nothing. The
   checkout TOLD those customers "made fresh, not pulled from stock"
   (computeBatchNotice in routes/retail.js) and stamped promised_ship_date. They
   were paid, not parked, because the shelf had units when they were bought —
   so neither term above could see them: they are not `awaiting_restock`, and
   §58 holds a fresh line back from the shelf until the order goes out, so they
   never dented physical_qty either.

   DISJOINT FROM THE OTHER TWO, by the same argument: the line is counted only
   while it has NO reservation and NO order ledger row for that product — the
   per-line test lib/inventory.js hasUndeductedFreshLine() makes — so it has not
   touched the shelf, and `awaiting_restock` is not in its status list. The
   moment packing or dispatch takes the stock, the line leaves this term; if
   that sends the shelf negative, term one picks it up. Never both.

   THE SHELF IS NOT SUBTRACTED, and that is the ruling rather than a slip: the
   customer was sold a batch made for them, not whatever is in the fridge.

   THE ORDER'S OWN DATE, NOT A CADENCE. `promised_ship_date` is a fact the
   order carries; comparing it to today is not knowing what a batch day is.
   A date in the future is tomorrow's batch's business and is left out, so the
   morning slip and the "To make" list name what is due today. A date in the
   past stays in until the order is packed: a paid customer whose food was
   never made is still owed it.

   ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────

   NO CADENCE. This module does not know what a batch day is, when a batch is
   ready, or whether today is one — the same line §80 drew when it kept
   lib/inventory.js a stock question and resolved the covered ids in
   routes/retail.js instead. Owed units are owed whether or not today is a
   cooking day; a kitchen that is not cooking still wants to know, and deciding
   what to do about it is the caller's business.

   BATCH-MADE PRODUCTS ONLY. `is_batch_made` is the flag §74 and §80 already key
   on, and this screen belongs to the people who cook. A negative shelf on a
   product nobody cooks is a real problem and a DIFFERENT one — it is already on
   the dashboard's out-of-stock row, whose `<= 0` test surfaces exactly these.

   NO FLOOR ON THE WAY OUT, other than per line. A product is listed only when it
   owes something; a healthy shelf simply is not in the result.
   ══════════════════════════════════════════════════════════════════════════ */

const businessDate = require('./business-date');

// The PARKED orders whose lines count as owed (term two). ONE definition,
// exported so a caller cannot quietly widen it: 'awaiting_restock' and nothing
// else. A plain 'paid' order either took its stock at commit or, if it was sold
// as made fresh, is term three's; a 'pending_payment' one is not promised to
// anybody yet, so it is never a debt this batch has to cover.
const OWED_ORDER_STATUS = 'awaiting_restock';

// §265 — the statuses a PROMISED fresh line can still be owed on. 'paid' is the
// common case; 'preparing' and 'dispatched' only ever qualify through the
// per-line test below, when §58 held a fresh line back for a parcel that has
// not been packed yet. The two channels are the ones that run the §58 deferral
// (lib/inventory.js isStockPending); a mirrored platform order decrements the
// shelf on arrival and is term one's.
const PROMISED_ORDER_STATUSES = ['paid', 'preparing', 'dispatched'];
const PROMISED_CHANNELS = ['wechat', 'web'];

/* Every (store, product) that owes units, for one store or all of them.
   Returns [{ store_id, product_id, name_en, name_cn, owed, from_shelf,
   from_parked, from_promised }], heaviest first, with `owed` the sum of the
   three sources so a caller never has to add them and cannot add them
   differently.

   `storeId` null asks about every store — the phone's Home row totals across
   whatever the operator can see, and the queue screen scopes to one.

   `today` ('YYYY-MM-DD') is the business date term three compares against.
   Absent, it is read off the shop's own clock; the morning request passes the
   date it is already raising for, so the slip and its guard read one day. */
function owedAt(db, storeId = null, { today = null } = {}) {
  const scoped = storeId != null;
  const asOf = today || businessDate.zoneParts(businessDate.shopTimezone(db)).ymd;

  // TERM ONE — the shelf below zero. COALESCE on the join, not on the row: a
  // product with NO stock row at that store has never been counted there and is
  // not in debt, which is a different fact from a row reading 0.
  const shelfRows = db.prepare(`
    SELECT s.store_id, s.product_id, -s.physical_qty AS owed
      FROM retail_store_stock s
      JOIN store_products p ON p.id = s.product_id
     WHERE s.physical_qty < 0
       AND COALESCE(p.is_batch_made, 0) = 1
       AND COALESCE(p.is_active, 1) = 1
       ${scoped ? 'AND s.store_id = ?' : ''}
  `).all(...(scoped ? [storeId] : []));

  // TERM TWO — the parked orders. Summed over LINES, because one order can hold
  // several fresh products and the kitchen makes each of them separately.
  const parkedRows = db.prepare(`
    SELECT o.store_id, i.product_id, SUM(i.qty) AS owed
      FROM retail_orders o
      JOIN retail_order_items i ON i.order_id = o.id
      JOIN store_products p     ON p.id = i.product_id
     WHERE o.status = ?
       AND o.store_id IS NOT NULL
       AND COALESCE(p.is_batch_made, 0) = 1
       AND COALESCE(p.is_active, 1) = 1
       ${scoped ? 'AND o.store_id = ?' : ''}
     GROUP BY o.store_id, i.product_id
  `).all(...(scoped ? [OWED_ORDER_STATUS, storeId] : [OWED_ORDER_STATUS]));

  // TERM THREE — §265, the paid order promised a fresh batch. Per LINE, with
  // the same two NOT EXISTS hasUndeductedFreshLine() uses, because §58 can
  // commit an order's grocery half and hold its fresh half: the order-level
  // shape would call that order settled. Order-item deep, not bundle deep —
  // the same stated limit as that function and as term two above.
  const stPh = PROMISED_ORDER_STATUSES.map(() => '?').join(',');
  const chPh = PROMISED_CHANNELS.map(() => '?').join(',');
  const promisedRows = db.prepare(`
    SELECT o.store_id, i.product_id, SUM(i.qty) AS owed
      FROM retail_orders o
      JOIN retail_order_items i ON i.order_id = o.id
      JOIN store_products p     ON p.id = i.product_id
     WHERE o.status IN (${stPh})
       AND COALESCE(o.channel, 'wechat') IN (${chPh})
       AND o.promised_ship_date IS NOT NULL
       AND o.promised_ship_date <= ?
       AND o.store_id IS NOT NULL
       AND COALESCE(p.is_batch_made, 0) = 1
       AND COALESCE(p.is_active, 1) = 1
       AND NOT EXISTS (
             SELECT 1 FROM retail_stock_reservations r
              WHERE r.order_id = o.id AND r.product_id = i.product_id
                AND r.status IN ('active', 'committed'))
       AND NOT EXISTS (
             SELECT 1 FROM retail_stock_ledger l
              WHERE l.ref_table = 'retail_orders' AND l.ref_id = o.id
                AND l.product_id = i.product_id AND l.reason LIKE 'order%')
       ${scoped ? 'AND o.store_id = ?' : ''}
     GROUP BY o.store_id, i.product_id
  `).all(...PROMISED_ORDER_STATUSES, ...PROMISED_CHANNELS, asOf,
    ...(scoped ? [storeId] : []));

  // Merged on (store, product) rather than concatenated: the same wrap can be
  // both oversold on Meituan and parked in the mini app, and the kitchen makes
  // ONE pile of wraps.
  const byKey = new Map();
  const add = (storeIdOf, productId, qty, field) => {
    if (!(Number(qty) > 0)) return;
    const key = `${storeIdOf}:${productId}`;
    let row = byKey.get(key);
    if (!row) {
      row = { store_id: storeIdOf, product_id: productId, from_shelf: 0, from_parked: 0, from_promised: 0 };
      byKey.set(key, row);
    }
    row[field] += Number(qty);
  };
  for (const r of shelfRows)  add(r.store_id, r.product_id, r.owed, 'from_shelf');
  for (const r of parkedRows) add(r.store_id, r.product_id, r.owed, 'from_parked');
  for (const r of promisedRows) add(r.store_id, r.product_id, r.owed, 'from_promised');
  if (!byKey.size) return [];

  // Names come from the product, NOT from the order line's snapshot. A line
  // snapshots the name at order time so history cannot be rewritten under it
  // (see retail_order_items), which is right for a receipt and wrong here: the
  // kitchen is being told what to cook TODAY and should read today's name.
  const ids = [...new Set([...byKey.values()].map((r) => r.product_id))];
  const ph = ids.map(() => '?').join(',');
  const names = new Map(
    db.prepare(`SELECT id, name_en, name_cn FROM store_products WHERE id IN (${ph})`)
      .all(...ids)
      .map((p) => [p.id, p])
  );

  return [...byKey.values()]
    .map((r) => ({
      ...r,
      name_en: names.get(r.product_id)?.name_en || null,
      name_cn: names.get(r.product_id)?.name_cn || null,
      owed: r.from_shelf + r.from_parked + r.from_promised,
    }))
    // Heaviest first: the kitchen reads the top of the list, and the biggest
    // number is the one that decides how the morning is spent.
    .sort((a, b) => b.owed - a.owed || String(a.name_en || '').localeCompare(String(b.name_en || '')));
}

/* The single figure behind the phone's Home row — total units owed, not a count
   of products. "30 to make" is what an operator can act on; "2 products" is not.
   Reads the same function above rather than its own query, so the row and the
   list it opens can never disagree about whether there is anything to do. */
function owedTotal(db, storeId = null, opts = {}) {
  return owedAt(db, storeId, opts).reduce((n, r) => n + r.owed, 0);
}

module.exports = { owedAt, owedTotal, OWED_ORDER_STATUS, PROMISED_ORDER_STATUSES, PROMISED_CHANNELS };
