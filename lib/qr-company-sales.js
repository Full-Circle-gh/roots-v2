// QR menu social proof, decisions §532. Separate from the location's size and
// option ranking: every recorded retail channel in THIS tenant counts here.
'use strict';

const { PAID_O } = require('./finance-window');
const DAYS = 30;
const memo = new Map();

// Accept a handle so the same SQL can be exercised against isolated fixtures.
function readUnits(db, from, to, shift) {
  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(p.variant_group_id, 0), p.id) AS family_id,
           SUM(MAX(0, i.qty - COALESCE(i.refunded_qty, 0))) AS units
      FROM retail_order_items i
      JOIN retail_orders o ON o.id = i.order_id
      JOIN store_products p ON p.id = i.product_id
     WHERE ${PAID_O}
       AND date(COALESCE(o.paid_at, o.placed_at), '${shift}') BETWEEN ? AND ?
     GROUP BY COALESCE(NULLIF(p.variant_group_id, 0), p.id)
    HAVING units > 0
  `).all(from, to);
  return new Map(rows.map(r => [r.family_id, Number(r.units) || 0]));
}

function companyUnits() {
  const { tdb, currentTenantId } = require('./tenant-db');
  const { shopDaysAgo, shopSqlShift } = require('./shop-clock');
  const day = shopDaysAgo(0);
  const shift = shopSqlShift();
  const key = `${currentTenantId()}:${shift}`;
  const hit = memo.get(key);
  if (hit && hit.day === day) return hit.units;
  const units = readUnits(tdb(), shopDaysAgo(DAYS), shopDaysAgo(1), shift);
  memo.set(key, { day, units });
  return units;
}

function forProduct(units, product) {
  return units.get(product.variant_group_id || product.store_product_id) || 0;
}

function topSellers(groups, limit = 6) {
  return groups.flatMap(c => c.sections.flatMap(s => s.items))
    .filter(p => !p.sold_out && p.company_units > 0)
    .sort((a, b) => b.company_units - a.company_units || a.store_product_id - b.store_product_id)
    .slice(0, limit);
}

module.exports = { companyUnits, forProduct, topSellers, readUnits, DAYS,
  clearMemoForTests() { memo.clear(); } };
