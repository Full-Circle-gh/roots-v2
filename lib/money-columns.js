// Every money column, and what unit it is in (audit A-06, Stage 0).
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
// Three counts of "how many money columns are there" disagreed: the audit said
// 51 of 61 across 32 tables, a source scan said 89 across 37, and the live
// schema says 95 REAL across 37. None of the three could be migrated from,
// because the disagreement was not arithmetic — it was that "money column" was
// being decided by the column's NAME, and a name is not a unit.
//
// This is the reviewed answer, one line per column, and it is the input to
// every later stage. `scripts/check_money_invariants.js --db <path>` scans a
// live database against it and reports anything money-NAMED that is not
// classified here, so a column added next month cannot be silently missed.
//
// ── THE THREE THINGS THE NAMES GOT WRONG ──────────────────────────────────
// Each of these would have been a silent, catastrophic conversion:
//
//   retail_vouchers.value is POLYMORPHIC. It holds yuan for a fixed_amount
//   coupon, a PERCENTAGE for a percent coupon, and nothing meaningful for
//   free_shipping (routes/retail.js:12904, :662-664). Multiplying that column
//   by 100 turns "10% off" into "1000% off" — a coupon that pays the customer.
//
//   recipe_cost_data.target_food_cost is a PERCENTAGE — the field is labelled
//   "Target food cost %" and defaults to 30 (19-recipes.js:1580). It is not
//   money at all; it was caught by the word "cost".
//
//   ingredient_price_history.price is a RATE, not an amount. It is written from
//   `item.cost_per_unit` and carries its own `buy_unit` column
//   (routes/purchases.js:444), which is why it measured 24% sub-cent.
//
// ── THE TWO UNITS, AND WHY IT IS NOT ONE ──────────────────────────────────
// Measured against production on 2026-09-05: 2,381 of 325,091 stored values are
// already not a whole number of cents, and they concentrate in the columns that
// are not amounts — unit_cost_at_sale 93%, cost_per_unit 60%, unit_cost 84%.
// Those are RATES. Oat groats cost 0.042 yuan per gram; in cents that is 4.2,
// and rounding it to 4 moves the cost basis of every recipe by 5%.
//
//   amount  what somebody pays or is paid  → integer cents      (MINOR)
//   rate    a price per unit of something  → integer 1/10,000ths (MICRO)
//
// ── source vs derived ─────────────────────────────────────────────────────
// A DERIVED column is a sum or a rollup of other rows: it can be recomputed and
// checked after conversion, so an error in one is detectable. A SOURCE column is
// the record itself — nothing else in the database can be used to prove it was
// converted correctly. They get different levels of paranoia, which is the whole
// reason the distinction is stored rather than inferred.
//
// ── unresolved ────────────────────────────────────────────────────────────
// Not a cop-out and not a to-do: a column whose unit cannot be settled by
// reading the code, with the exact question written down. Converting one of
// these on a guess is the 5%-wrong-forever failure this file exists to prevent.
// Each carries the question that would settle it.

'use strict';

const A = (kind, note) => ({ unit: 'amount', kind, note });
const R = (kind, note) => ({ unit: 'rate', kind, note });
const NOT = (note) => ({ unit: 'not_money', kind: 'n/a', note });
const ASK = (question) => ({ unit: 'unresolved', kind: 'unknown', note: question });

const COLUMNS = {
  // ── The books ───────────────────────────────────────────────────────────
  'expense_entries.amount':                     A('source'),
  'income_entries.amount':                      A('source'),
  'invoices.amount':                            A('source'),
  'invoice_lines.allocated_amount':             A('derived', 'an allocation of invoices.amount'),
  'invoice_pos.allocated_amount':               A('derived', 'an allocation of invoices.amount'),

  // ── Orders ──────────────────────────────────────────────────────────────
  'retail_orders.subtotal':                     A('derived', 'sum of the line totals'),
  'retail_orders.shipping_fee':                 A('source'),
  'retail_orders.packing_fee':                  A('source'),
  'retail_orders.same_day_surcharge_fee':       A('source'),
  'retail_orders.voucher_amount':               A('source'),
  'retail_orders.points_amount':                A('source', 'a tender — see orderTenders()'),
  'retail_orders.balance_used':                 A('source', 'a tender — see orderTenders()'),
  'retail_orders.total':                        A('derived', 'the CASH tender only, not the gross'),
  'retail_orders.refund_amount_requested':      A('source'),
  'retail_orders.refund_amount_approved':       A('source'),
  'retail_orders.refund_amount_paid':           A('source'),
  'retail_orders.refund_cash_amount':           A('source', 'the cash half of a split refund'),
  'retail_orders.channel_commission':           A('source'),
  'retail_orders.channel_settle_amount':        A('source'),
  'retail_orders.channel_discount':             A('source'),
  'retail_order_items.line_total':              A('derived', 'unit_price × qty'),
  'retail_order_items.unit_price':              ASK('5.4% sub-cent, yet production has ZERO fractional quantities — so it is not weighed goods. Where do the fractions come from? Settle before converting.'),
  'retail_order_items.unit_cost_at_sale':       R('source', '93% sub-cent — a per-unit cost snapshot'),
  'retail_order_addons.amount':                 A('source'),
  'retail_order_addons.addon_subtotal':         A('derived'),
  'retail_checkout_quotes.subtotal':            A('derived', '146k rows, the largest table'),
  'retail_refund_events.amount':                A('source'),
  'retail_payments.amount':                     A('source', 'what actually moved'),
  'retail_payments.refunded_amount':            A('derived', 'rollup of refund events'),

  // ── Customers ───────────────────────────────────────────────────────────
  'retail_customers.lifetime_spend':            A('derived', 'rollup of order subtotals'),
  'retail_customers.balance':                   A('source', 'the wallet — real money held'),
  'retail_migration_credits.balance':           A('source'),
  'retail_migration_unmatched.balance':         A('source'),
  'retail_topup_transactions.amount':           A('source'),
  'retail_topup_packages.amount':               A('source'),
  'retail_referrals.reward_amount':             A('source'),
  'retail_referrals.referee_reward_amount':     A('source'),
  'retail_lifetime_commissions.base_amount':    A('source'),
  'retail_lifetime_commissions.commission_amount': A('derived'),

  // ── The shelf ───────────────────────────────────────────────────────────
  'products.sell_price':                        A('source'),
  'products.compare_at_price':                  A('source'),
  'products.retail_price':                      A('source'),
  'products.flash_price':                       A('source'),
  'store_products.sell_price':                  A('source'),
  'store_products.compare_at_price':            A('source'),
  'store_products.retail_price':                A('source'),
  'store_products.flash_price':                 A('source'),
  'store_products.unit_cost':                   R('source', '84% sub-cent — cost per unit of measure'),
  'retail_product_option_choices.price_delta':  A('source'),
  'packaging_types.cost':                       A('source'),

  // ── Buying ──────────────────────────────────────────────────────────────
  'po_line_items.cost_per_unit':                R('source', 'the rate the SQL SUM multiplies'),
  'po_line_items.total_cost':                   A('derived', 'billable qty × cost_per_unit'),
  'ingredients.cost_per_unit':                  R('source', '60% sub-cent — yuan per gram'),
  'ingredients.buy_price':                      A('source', 'what one pack costs — an amount'),
  'ingredient_price_history.price':             R('source', 'written from item.cost_per_unit, carries its own buy_unit'),
  'ingredient_cost_skips.line_price':           R('source', 'a price per line_unit'),
  'price_alerts.old_price':                     A('source', 'mirrors ingredients.buy_price'),
  'price_alerts.new_price':                     A('source', 'mirrors ingredients.buy_price'),

  // ── Delivery ────────────────────────────────────────────────────────────
  'retail_delivery_zones.base_fee':             A('source'),
  'retail_delivery_zones.max_fee':              A('source'),
  'retail_delivery_zones.free_threshold':       A('source'),
  'retail_delivery_zones.packing_fee_per_item': A('source'),
  'retail_delivery_zones.packing_fee_cap':      A('source'),
  'retail_delivery_zones.same_day_surcharge':   A('source'),
  'retail_delivery_zones.weight_first_kg_fee':  A('source'),
  'retail_delivery_zones.weight_extra_kg_fee':  A('source'),

  // ── Coupons ─────────────────────────────────────────────────────────────
  'retail_vouchers.value':                      ASK('POLYMORPHIC: yuan for fixed_amount, a PERCENTAGE for percent, meaningless for free_shipping. Converting it multiplies every percent coupon by 100. Needs splitting into two columns, or a per-type conversion, before anything touches it.'),
  'retail_vouchers.min_subtotal':               A('source'),

  // ── Channels — deferred, see the plan §7 ────────────────────────────────
  'meituan_orders.product_total':               A('source', 'channel-reported'),
  'meituan_orders.package_fee':                 A('source', 'channel-reported'),
  'meituan_orders.customer_paid':               A('source', 'channel-reported'),
  'meituan_orders.customer_delivery_fee':       A('source', 'channel-reported'),
  'meituan_orders.delivery_fee_paid':           A('source', 'channel-reported'),
  'meituan_orders.delivery_tip_paid':           A('source', 'channel-reported'),
  'meituan_orders.ad_spend':                    A('source', 'channel-reported'),
  'meituan_orders.coupon_subsidy_paid':         A('source', 'channel-reported'),
  'meituan_orders.insurance_fee':               A('source', 'channel-reported'),
  'meituan_orders.commission':                  A('source', 'channel-reported'),
  'meituan_orders.partial_refund':              A('source', 'channel-reported'),
  'meituan_orders.gross_amount':                A('derived', 'channel-reported'),
  'meituan_settlements.bill_amount':            A('source', 'channel-reported'),
  'meituan_balance_flow.amount':                A('source', 'channel-reported'),
  'meituan_balance_flow.balance_after':         A('derived', 'a running balance'),
  'miniapp_orders.product_total':               A('derived'),
  'miniapp_orders.delivery_fee':                A('source'),
  'miniapp_orders.refund_amount':               A('source'),
  'miniapp_orders.coupon_discount':             A('source'),
  'miniapp_order_lines.line_total':             A('derived', 'unit_price × qty'),
  'miniapp_order_lines.unit_price':             ASK('same question as retail_order_items.unit_price'),

  // ── Reporting ───────────────────────────────────────────────────────────
  'sales_entries.unit_price':                   ASK('imported from two channel spreadsheets; whether qty can be fractional there is unverified. 28k rows.'),
  'sales_entries.total':                        A('derived', 'unit_price × qty'),
  'waste_entries.cost_lost':                    A('derived', 'a valuation, not a payment'),
  'waste_entries.retail_value':                 A('derived', 'a valuation, not a payment'),
  'recipe_cost_data.sell_price':                A('source'),
  'recipe_cost_data.target_food_cost':          NOT('a PERCENTAGE — the field is labelled "Target food cost %" and defaults to 30'),

  // ── Already integer, and the convention this migration extends ──────────
  'waste_records.cost_total_cents':             { unit: 'amount', kind: 'source', done: true, note: 'already integer cents' },
};

// Money-NAMED but not money, kept so the scanner stays quiet about them rather
// than reporting the same false positives to every reader for ever.
const NOT_MONEY = new Set([
  'retail_customers.points_balance', 'retail_points_transactions.balance_after',
  'retail_stock_ledger.balance_after', 'retail_stores.low_stock_threshold',
  'store_products.low_stock_threshold', 'store_products.cost_incomplete',
  'retail_polls.total_votes', 'retail_polls.display_min_total',
  'retail_order_items.refunded_qty', 'waste_entries.cost_source',
  'waste_records.is_uncosted', 'suppliers.price_info', 'storefront_config.value_json',
  'ai_memory.value', 'meituan_settlements.settlement_id', 'meituan_settlements.settled_on',
  'tenants.commission_rate_bps',
  // A 0/1 FLAG, not money: "1 = show the 'runs on tacet' credit; only the
  // platform clears it to 0" (routes/backend-auth.js:141). Caught by the word
  // "credit", and found by the scanner on the first live database it saw —
  // which is the argument for the scanner.
  'tenants.brand_credit',
]);

// A column whose name looks like money. Deliberately WIDER than the classified
// set: the scanner's job is to find what nobody has classified yet, so a loose
// match with a quiet-list beats a tight match that misses one.
const MONEY_NAME = /(price|cost|amount|total|fee|subtotal|discount|refund|paid|balance|spend|revenue|settle|payout|commission|charge|tender|deposit|credit|surcharge|threshold|value)/i;

// …but a name alone catches `refund_paid_at` and `refund_reviewer_id`, and a
// scanner that reports thirty timestamps is a scanner nobody reads. A column can
// hold money only if its AFFINITY could: REAL and NUMERIC always, INTEGER unless
// the name says it is an id or a time (the existing `_cents` columns are
// INTEGER, so INTEGER cannot simply be excluded). Anything else — DATETIME,
// DATE, TEXT, BOOLEAN — cannot be an amount whatever it is called.
function couldHoldMoney(name, type) {
  const t = String(type || '').toUpperCase();
  if (/_(at|on)$/.test(name) || /_id$/.test(name)) return false;
  if (/DATE|TIME|BOOL/.test(t)) return false;
  if (/CHAR|TEXT|CLOB|JSON|BLOB/.test(t)) return false;
  return true;                       // REAL, NUMERIC, INTEGER, or untyped
}

function classify(table, column) {
  const key = table + '.' + column;
  if (COLUMNS[key]) return { key, ...COLUMNS[key] };
  if (NOT_MONEY.has(key)) return { key, unit: 'not_money', kind: 'n/a', note: 'known non-money' };

  // THE MIGRATION'S OWN OUTPUT. `retail_payments.amount_cents` is money-named
  // and is not in the list above, so without this the scanner reports every
  // column the migration just created as "nobody has classified this" — on the
  // rehearsal, every time, drowning the one that would actually matter.
  //
  // It is recognised only when the BASE column is classified AND the suffix
  // matches its unit: `_cents` for an amount, `_micro` for a rate. A stray
  // `something_cents` beside a column nobody classified is still reported,
  // which is the case worth keeping.
  //
  // `done: true` — already an integer, so the census leaves it alone rather
  // than scaling an already-scaled number by a hundred a second time. Whether
  // it agrees with its source is migrate_money.js --verify's question, and it
  // asks it row by row rather than in aggregate.
  const m = /^(.*)_(cents|micro)$/.exec(column);
  if (m) {
    const base = COLUMNS[table + '.' + m[1]];
    const wants = m[2] === 'micro' ? 'rate' : 'amount';
    if (base && base.unit === wants) {
      return { key, unit: base.unit, kind: base.kind, done: true, derivedFrom: table + '.' + m[1],
               note: `the integer form of ${m[1]}, added by the money migration` };
    }
  }
  return null;
}

/** Every classified column of a given unit. */
function columnsOfUnit(unit) {
  return Object.entries(COLUMNS)
    .filter(([, v]) => v.unit === unit && !v.done)
    .map(([k, v]) => ({ key: k, table: k.split('.')[0], column: k.split('.')[1], ...v }));
}

/**
 * Scan a LIVE database and report what is not accounted for.
 *
 * Two directions, and both matter:
 *   unclassified — a money-named column on this database that nobody has
 *                  decided about. This is the one that stops a migration.
 *   missing      — classified here but absent from this database. Usually
 *                  harmless (a table an import script creates lazily, like
 *                  guanyi_product_pricing), which is why it is reported
 *                  separately rather than as a failure.
 */
function scan(db) {
  const unclassified = [];
  const seen = new Set();
  let tables = [];
  try {
    tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map((r) => r.name);
  } catch (e) { return { unclassified: [], missing: [], error: e.message }; }
  for (const t of tables) {
    let info = [];
    try { info = db.prepare(`PRAGMA table_info(${t})`).all(); } catch (e) { continue; }
    for (const c of info) {
      if (!MONEY_NAME.test(c.name)) continue;
      if (!couldHoldMoney(c.name, c.type)) continue;
      const key = t + '.' + c.name;
      seen.add(key);
      if (!classify(t, c.name)) unclassified.push({ key, type: c.type || '' });
    }
  }
  const missing = Object.keys(COLUMNS).filter((k) => !seen.has(k));
  return { unclassified, missing, tables: tables.length };
}

module.exports = { COLUMNS, NOT_MONEY, MONEY_NAME, couldHoldMoney, classify, columnsOfUnit, scan };
