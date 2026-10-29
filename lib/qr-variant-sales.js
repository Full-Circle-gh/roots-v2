// Per-size sales on a shop's QR menu — docs/tacet-consolidation-decisions.md §505.
//
// WHAT THIS IS. A map of store_product_id → units sold at one location, over the
// same 30 whole days that ended last night as the till's best-sellers row
// (§499). Each variant size is its own product_id on retail_order_items, so
// the sum is the popularity of that size at that door.
//
// BOTH DOORS COUNT. A size sold on the QR menu and the same size sold at the
// till are the same physical jar; ranking only by QR would ignore the counter
// where most of the shop's volume often sits. Online-store and kitchen channels
// do not count — those are not this location's menu.
//
// TODAY IS LEFT OUT ON PURPOSE, same reason as §499: a window that took in
// today's sales would let a size jump places mid-shift on every scan. Ending at
// yesterday makes the answer the same for the whole day, so it is worked out
// once per location per day and remembered — buildMenu re-runs on every GET.

'use strict';

const { tdb, currentTenantId } = require('./tenant-db');
const financeWindow = require('./finance-window');
const { shopDaysAgo, shopSqlShift } = require('./shop-clock');

const DAYS = 30;
const _memo = new Map(); // tenant:location -> { day, map }

function unitsByProduct(locationId) {
  const day = shopDaysAgo(0);
  const key = `${currentTenantId() || ''}:${locationId}`;
  const hit = _memo.get(key);
  if (hit && hit.day === day) return hit.map;

  const rows = tdb().prepare(`
    SELECT i.product_id AS id, SUM(i.qty) AS units
      FROM retail_order_items i
      JOIN retail_orders o ON o.id = i.order_id
     WHERE o.store_id = ? AND o.channel = 'shop'
       AND o.shop_entry_method IN ('qr', 'till')
       AND ${financeWindow.PAID_O}
       AND date(COALESCE(o.paid_at, o.placed_at), '${shopSqlShift()}') BETWEEN ? AND ?
     GROUP BY i.product_id
    HAVING SUM(i.qty) > 0
  `).all(locationId, shopDaysAgo(DAYS), shopDaysAgo(1));

  const map = new Map();
  for (const r of rows) map.set(r.id, Number(r.units) || 0);
  _memo.set(key, { day, map });
  return map;
}

function clearMemoForTests() { _memo.clear(); }

module.exports = { unitsByProduct, clearMemoForTests, DAYS };
