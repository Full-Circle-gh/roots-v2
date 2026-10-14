// Who a broadcast reaches: the audience filter (activity, tiers, cities) and
// the SQL that picks the customers. Moved out of routes/retail.js unchanged
// (decisions §477); the broadcast routes stay there.
// scripts/test_broadcast_audience.js holds its behaviour.
'use strict';

// ─── Broadcast audience targeting ───────────────────────────────────────────
// An audience filter is a small JSON object stored on the broadcast row:
//   { activity, tiers: [...], cities: [...] }
// "activity" folds has-ordered + recency into one dimension. Blocked customers
// are always excluded. Legacy rows store the literal 'all_active' string, which
// parses to the empty (= everyone active) filter.
const BC_PAID_STATUSES = ['paid', 'preparing', 'dispatched', 'delivered'];
const BC_TIER_KEYS = ['seed', 'sprout', 'root', 'tree'];
const BC_ACTIVITIES = ['all', 'buyers', 'never', 'active', 'lapsed'];

function normalizeAudience(raw) {
  let a = raw;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (_) { a = {}; } }
  if (!a || typeof a !== 'object') a = {};
  const activity = BC_ACTIVITIES.includes(a.activity) ? a.activity : 'all';
  const tiers = Array.isArray(a.tiers) ? a.tiers.filter(t => BC_TIER_KEYS.includes(t)) : [];
  const cities = Array.isArray(a.cities)
    ? [...new Set(a.cities.map(c => String(c).trim()).filter(Boolean))].slice(0, 100)
    : [];
  return { activity, tiers, cities };
}

// Build a WHERE clause (+ bound params) against retail_customers aliased "c".
function audienceWhere(raw) {
  const a = normalizeAudience(raw);
  const clauses = ['COALESCE(c.is_blocked, 0) = 0'];
  const params = [];
  const paidIn = BC_PAID_STATUSES.map(() => '?').join(',');
  const paidExists =
    `SELECT 1 FROM retail_orders o WHERE o.customer_id = c.id AND o.status IN (${paidIn})`;
  if (a.activity === 'buyers') {
    clauses.push(`EXISTS (${paidExists})`); params.push(...BC_PAID_STATUSES);
  } else if (a.activity === 'never') {
    clauses.push(`NOT EXISTS (${paidExists})`); params.push(...BC_PAID_STATUSES);
  } else if (a.activity === 'active') {
    clauses.push(`EXISTS (${paidExists} AND o.placed_at >= datetime('now', '-30 days'))`);
    params.push(...BC_PAID_STATUSES);
  } else if (a.activity === 'lapsed') {
    clauses.push(`EXISTS (${paidExists})`); params.push(...BC_PAID_STATUSES);
    clauses.push(`NOT EXISTS (${paidExists} AND o.placed_at >= datetime('now', '-60 days'))`);
    params.push(...BC_PAID_STATUSES);
  }
  if (a.tiers.length) {
    clauses.push(`c.tier_key IN (${a.tiers.map(() => '?').join(',')})`);
    params.push(...a.tiers);
  }
  if (a.cities.length) {
    clauses.push(
      `EXISTS (SELECT 1 FROM retail_customer_addresses ad
                WHERE ad.customer_id = c.id AND ad.city IN (${a.cities.map(() => '?').join(',')}))`
    );
    params.push(...a.cities);
  }
  return { where: clauses.join(' AND '), params, normalized: a };
}

module.exports = { BC_PAID_STATUSES, BC_TIER_KEYS, BC_ACTIVITIES, normalizeAudience, audienceWhere };
