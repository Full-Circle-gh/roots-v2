// gzgrocery billing — what gzgrocery took, and what they owe for it, over a
// range of business days. One reader, used by the Billing panel
// (GET /api/retail-admin/guanyi/analytics) and by anything that checks their
// statement against ours. docs/tacet-consolidation-decisions.md §429.
//
// ── WHERE THE UNITS AND THE PRICE COME FROM ────────────────────────────────
// The order copies the order reader writes (retail_orders channel='gzgrocery',
// order_no 'GZ-…', and their retail_order_items). Each line carries the
// gzgrocery price AS IT WAS WHEN THE ORDER WAS READ (`unit_price`). §184/§186
// moved Reports, Sales and Finance onto this record for exactly the two faults
// the Billing panel still had until §429:
//   • the stock ledger carries no price, so every past day was re-valued at
//     TODAY's gzgrocery price — change one price and last month's bill moved;
//   • the ledger row is dated by when the daemon wrote it, in UTC, not by when
//     the customer ordered, in the shop's day — an order at 07:00 Guangzhou
//     landed on the day before.
//
// A cancelled order is not billed. The order reader flips its copy to
// 'cancelled' when gzgrocery voids it, so the paid allow-list drops it.
//
// ── THE DORMANT DRIFT LOG ──────────────────────────────────────────────────
// Before the order reader existed, sales were inferred from stock drops in
// their ERP (guanyi_pickup_log). §186: dormant, not vestigial. Those rows have
// no order and no stored price, so they are still valued at today's price —
// there is nothing better to read — but they are now dated by the shop's day
// like everything else. No time overlap with the order copies: drift was
// parked in shadow when the order reader went live.

'use strict';

const { paidWhere, odateFor } = require('./finance-window');

function hasTable(db, name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

/**
 * One row per (business day, product): units and the yuan owed for them.
 *
 * @param db     tenant DB handle
 * @param from   'YYYY-MM-DD', inclusive
 * @param to     'YYYY-MM-DD', inclusive
 * @param shift  SQLite day modifier from lib/business-date.js
 *               sqlDayShiftForShop(), e.g. '+480 minutes'
 * @returns [{ day, product_id, sku, name_cn, name_en, units, owed,
 *             sell_price, disc, xretail, xgz, orders }]
 *   `orders` is the GZ-… order numbers the units came from, comma-joined
 *   (null for drift-log units, which have none).
 */
function billingRows(db, { from, to, shift }) {
  const hasPricing = hasTable(db, 'guanyi_product_pricing');
  const hasDrift = hasTable(db, 'guanyi_pickup_log');
  // The order date, written once in lib/finance-window.js. Its columns are
  // unqualified; only retail_orders has paid_at/placed_at, so the join is safe.
  const day = odateFor(shift);
  const driftDay = `date(pl.created_at, '${shift}')`;   // odateFor above has refused a missing shift (§82)

  const parts = [`
    SELECT ${day} AS day,
           oi.product_id, oi.sku AS line_sku,
           oi.qty * COALESCE(oi.pack_units, 1) AS units,
           oi.line_total AS owed,
           o.order_no
      FROM retail_order_items oi
      JOIN retail_orders o ON o.id = oi.order_id
     WHERE o.channel = 'gzgrocery' AND ${paidWhere('o')}`];
  if (hasDrift) parts.push(`
    SELECT ${driftDay} AS day, pl.product_id, NULL AS line_sku,
           CASE WHEN pl.action='decremented' OR (pl.action='capped' AND pl.resolution='applied') THEN pl.inferred_pickup
                WHEN pl.action='drift_up' THEN -ABS(COALESCE(pl.drift,0)) ELSE 0 END AS units,
           NULL AS owed,
           NULL AS order_no
      FROM guanyi_pickup_log pl
     WHERE pl.action IN ('decremented','drift_up') OR (pl.action='capped' AND pl.resolution='applied')`);

  const pricingCols = hasPricing
    ? 'pp.discount_pct AS disc, pp.excel_retail AS xretail, pp.excel_gz_price AS xgz'
    : 'NULL AS disc, NULL AS xretail, NULL AS xgz';
  const pricingJoin = hasPricing ? 'LEFT JOIN guanyi_product_pricing pp ON pp.product_id = src.product_id' : '';
  // Drift units carry no price, so they are valued at today's gzgrocery price
  // (the order line's own fallback chain: gz price → sheet retail → sell price).
  const todayPrice = hasPricing
    ? 'COALESCE(pp.excel_gz_price, pp.excel_retail, sp.sell_price, 0)'
    : 'COALESCE(sp.sell_price, 0)';

  return db.prepare(`
    SELECT src.day, src.product_id,
           COALESCE(sp.sku, MAX(src.line_sku)) AS sku, sp.name_cn, sp.name_en,
           SUM(src.units) AS units,
           SUM(COALESCE(src.owed, src.units * ${todayPrice})) AS owed,
           COALESCE(sp.sell_price, 0) AS sell_price,
           ${pricingCols},
           GROUP_CONCAT(DISTINCT src.order_no) AS orders
      FROM (${parts.join('\n UNION ALL \n')}) src
      LEFT JOIN store_products sp ON sp.id = src.product_id
      ${pricingJoin}
     WHERE src.day BETWEEN ? AND ?
     GROUP BY src.day, src.product_id
     ORDER BY src.day, src.product_id
  `).all(from, to);
}

module.exports = { billingRows };
