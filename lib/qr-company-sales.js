// QR menu social proof, decisions §532 and §534. Separate from the location's
// size and option ranking: every recorded retail channel in THIS tenant counts
// here. readUnits / forProduct stay the recorded net units. shownUnits is the
// figure on the menu card only, and nothing writes it back.
'use strict';

const { PAID_O } = require('./finance-window');
const DAYS = 30;
const LIFT_NUM = 13;
const LIFT_DEN = 10;
const QUIET_MIN = 4;
const QUIET_MAX = 12;
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

// Recorded units × 1.3, as a whole number. Zero stays zero so the quiet band
// can tell "sold nothing" from "sold one". A fraction of a unit still shows
// at least 1, because the card does not do decimals.
function liftedUnits(real) {
  const n = Number(real);
  if (!(n > 0)) return 0;
  return Math.max(1, Math.round((n * LIFT_NUM) / LIFT_DEN));
}

// One below the smallest lifted real sale on this menu. No real sales at all
// leaves the full quiet band open.
function quietCeiling(rawUnits) {
  let min = Infinity;
  for (const raw of rawUnits) {
    const lifted = liftedUnits(raw);
    if (lifted > 0 && lifted < min) min = lifted;
  }
  return min === Infinity ? QUIET_MAX : min - 1;
}

// The number the card prints. A dish that sold uses the 30% lift. A dish that
// sold nothing takes a stable 4–12 from its family id, cut so it cannot sit
// above a dish on the same menu that did sell. When even 1 would outrank the
// weakest real sale, it ties that sale at 1 instead of showing 0.
function shownUnits(real, familyId, ceiling = QUIET_MAX) {
  const lifted = liftedUnits(real);
  if (lifted > 0) return lifted;
  const cap = Number(ceiling);
  const hi = Math.max(0, Math.min(QUIET_MAX, Number.isFinite(cap) ? Math.floor(cap) : QUIET_MAX));
  if (hi < 1) return 1;
  const lo = Math.min(QUIET_MIN, hi);
  const span = hi - lo + 1;
  const id = Math.abs(Math.trunc(Number(familyId)) || 0);
  const h = Math.imul(id, 2654435761) >>> 0;
  return lo + (h % span);
}

function topSellers(groups, limit = 6) {
  return groups.flatMap(c => c.sections.flatMap(s => s.items))
    .filter(p => !p.sold_out && p.company_units > 0)
    .sort((a, b) => b.company_units - a.company_units || a.store_product_id - b.store_product_id)
    .slice(0, limit);
}

module.exports = { companyUnits, forProduct, topSellers, readUnits, DAYS,
  liftedUnits, quietCeiling, shownUnits, QUIET_MIN, QUIET_MAX,
  clearMemoForTests() { memo.clear(); } };
