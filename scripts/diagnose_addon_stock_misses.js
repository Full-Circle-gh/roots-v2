#!/usr/bin/env node
/**
 * READ-ONLY. Which paid add-ons took stock off the ticket but never off the shelf?
 *
 * Context. The "Forgot something?" add-on flow (POST /orders/:id/addon/create →
 * finalizeOrderAddon) used to check stock in exactly one place: AFTER the WeChat
 * charge settled. That check called inventory.reserveForOrder, which is
 * all-or-nothing — it throws on the first short line and its transaction rolls
 * back every reservation in the batch. finalizeOrderAddon caught the throw and
 * logged a console warning, because the money was already taken and the sale
 * could not be refused.
 *
 * Two consequences, both now fixed in code:
 *
 *   1) The customer could add units the fulfilling store did not have — nothing
 *      gated availability before the charge, and the picker capped against
 *      stock SUMMED across active stores rather than the one store the order
 *      was pinned to. (TC000112: 3 Tabbouleh Bowls on an order fulfilled by
 *      Tianhe, which held 2.)
 *   2) Worse, the rollback meant NOTHING in that add-on deducted — including
 *      the lines the store could cover. Those units left the shelf physically
 *      but never left retail_store_stock.physical_qty, and no ledger row was
 *      written. The shelf has been reading high ever since, silently.
 *
 * This script finds (2) — the orders whose stock is still overstated. For every
 * successful add-on it rebuilds the component demand the way the reserve path
 * does (bundles expanded, stock-backed paid extras folded in) and compares it to
 * the reservations actually recorded against the order. A miss is an add-on on a
 * stock-TRACKED order (one that committed reservations at checkout) with fewer
 * committed units than its lines called for.
 *
 * Output is per (store, product): the units to subtract to make physical_qty
 * honest again. It does NOT write — correcting stock is an operator decision and
 * should go through the admin stock screen so it lands in the ledger with a
 * reason and an actor.
 *
 *   node scripts/diagnose_addon_stock_misses.js               # all history
 *   node scripts/diagnose_addon_stock_misses.js --since 2026-06-01
 *   node scripts/diagnose_addon_stock_misses.js --order 112   # one order
 *
 * Mutates nothing.
 */
const path = require('path');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const SINCE = argOf('--since');
const ONLY_ORDER = argOf('--order') ? parseInt(argOf('--order'), 10) : null;

const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH, { readonly: true });

const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const lpad = (s, n) => String(s == null ? '' : s).padStart(n);

console.log(`DB    : ${DB_PATH}`);
console.log(`Scope : ${ONLY_ORDER ? `order #${ONLY_ORDER}` : (SINCE ? `add-ons paid since ${SINCE}` : 'all history')}\n`);

// ── Mirror of expandStockLines() in routes/retail.js ────────────────────────
// Bundles contribute their components; stock-backed paid extras contribute
// their own product; supplier-direct items contribute nothing (we hold no
// inventory for them). Keep this in step with the route if that changes.
function parseBundleItems(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.map(c => ({ id: parseInt(c.id ?? c.product_id, 10), qty: Math.max(1, Number(c.qty) || 1) }))
            .filter(c => c.id);
  } catch { return []; }
}

const productById = db.prepare(
  'SELECT id, name_en, name_cn, sku, bundle_items, ship_from_supplier FROM store_products WHERE id = ?'
);

function expandStockLines(lines) {
  const agg = new Map();
  const add = (id, qty) => { const pid = parseInt(id, 10); if (pid) agg.set(pid, (agg.get(pid) || 0) + qty); };
  for (const r of lines) {
    const p = r.product_id ? productById.get(r.product_id) : null;
    if (!p) continue;
    if (p.ship_from_supplier) continue;
    const comps = parseBundleItems(p.bundle_items);
    if (comps.length) for (const c of comps) add(c.id, c.qty * r.qty);
    else add(p.id, r.qty);
    for (const o of (r.options || [])) if (o.stock_product_id) add(o.stock_product_id, r.qty);
  }
  return [...agg.entries()].map(([product_id, qty]) => ({ product_id, qty }));
}

// ── Walk every settled add-on ───────────────────────────────────────────────
let sql = `
  SELECT ad.id AS addon_id, ad.order_id, ad.items_json, ad.amount, ad.paid_at,
         o.order_no, o.store_id, o.status,
         s.code AS store_code, s.name_en AS store_name
    FROM retail_order_addons ad
    JOIN retail_orders  o ON o.id = ad.order_id
    LEFT JOIN retail_stores s ON s.id = o.store_id
   WHERE ad.status = 'success'`;
const params = [];
if (ONLY_ORDER) { sql += ' AND ad.order_id = ?'; params.push(ONLY_ORDER); }
if (SINCE)      { sql += ' AND ad.paid_at >= ?'; params.push(SINCE); }
sql += ' ORDER BY ad.paid_at';

const addons = db.prepare(sql).all(...params);
if (!addons.length) { console.log('No settled add-ons in scope.'); process.exit(0); }

// An order is stock-tracked when it committed reservations at checkout. Add-ons
// on untracked orders (out-of-GZ / scheduled) were never meant to deduct, so a
// zero deduction there is correct, not a miss.
const committedFor = db.prepare(
  `SELECT product_id, COALESCE(SUM(qty), 0) AS qty
     FROM retail_stock_reservations
    WHERE order_id = ? AND status = 'committed'
    GROUP BY product_id`
);
const orderItemDemand = db.prepare(
  `SELECT product_id, qty, options_json, addon_id FROM retail_order_items WHERE order_id = ?`
);

const misses = [];       // one row per (order, product) still overstated
const perStore = new Map();

for (const a of addons) {
  if (!a.store_id) continue;
  const committed = committedFor.all(a.order_id);
  if (!committed.length) continue;   // untracked order — deduction never applied by design

  // Demand for the WHOLE order (original lines + every settled add-on), then
  // compare against what was actually committed. Doing it per-order rather than
  // per-add-on absorbs the fact that reservations aren't tagged by add-on.
  let items;
  try { items = orderItemDemand.all(a.order_id); } catch { continue; }
  const lines = items.map(it => {
    let options = [];
    try { const oj = JSON.parse(it.options_json || '[]'); if (Array.isArray(oj)) options = oj; } catch { /* none */ }
    return { product_id: it.product_id, qty: Number(it.qty) || 0, options };
  });
  const demand = expandStockLines(lines);
  const have = new Map(committed.map(c => [c.product_id, c.qty]));

  for (const d of demand) {
    const got = have.get(d.product_id) || 0;
    if (got >= d.qty) continue;
    const p = productById.get(d.product_id);
    misses.push({
      order_no: a.order_no, order_id: a.order_id, addon_id: a.addon_id,
      paid_at: a.paid_at, store_id: a.store_id,
      store: a.store_code || a.store_name || `#${a.store_id}`,
      product_id: d.product_id, sku: p?.sku || '', name: p?.name_en || p?.name_cn || `#${d.product_id}`,
      needed: d.qty, committed: got, missing: d.qty - got,
    });
    const key = `${a.store_id}|${d.product_id}`;
    const cur = perStore.get(key) || {
      store: a.store_code || a.store_name || `#${a.store_id}`, store_id: a.store_id,
      product_id: d.product_id, sku: p?.sku || '', name: p?.name_en || p?.name_cn || `#${d.product_id}`,
      missing: 0, orders: [],
    };
    cur.missing += d.qty - got;
    cur.orders.push(a.order_no);
    perStore.set(key, cur);
  }
}

// Dedupe: one order can carry several add-ons, and the per-order demand compare
// above would count the same gap once per add-on row.
const seen = new Set();
const uniqueMisses = misses.filter(m => {
  const k = `${m.order_id}|${m.product_id}`;
  if (seen.has(k)) return false;
  seen.add(k); return true;
});
if (uniqueMisses.length !== misses.length) {
  for (const [, v] of perStore) v.missing = 0;
  for (const m of uniqueMisses) {
    const v = perStore.get(`${m.store_id}|${m.product_id}`);
    if (v) v.missing += m.missing;
  }
}

if (!uniqueMisses.length) {
  console.log(`Checked ${addons.length} settled add-on(s). No undeducted stock found. ✓`);
  process.exit(0);
}

console.log(`── Orders whose add-on stock never left the shelf (${uniqueMisses.length}) ──\n`);
console.log(pad('ORDER', 14) + pad('PAID', 21) + pad('STORE', 10) + pad('SKU', 10) +
            pad('PRODUCT', 30) + lpad('NEED', 5) + lpad('GOT', 5) + lpad('SHORT', 7));
for (const m of uniqueMisses) {
  console.log(pad(m.order_no, 14) + pad(m.paid_at, 21) + pad(m.store, 10) + pad(m.sku, 10) +
              pad(m.name.slice(0, 29), 30) + lpad(m.needed, 5) + lpad(m.committed, 5) + lpad(m.missing, 7));
}

console.log(`\n── Correction to apply per (store, product) ──\n`);
console.log(pad('STORE', 10) + pad('SKU', 10) + pad('PRODUCT', 30) + lpad('SUBTRACT', 9) + '  ORDERS');
const rows = [...perStore.values()].filter(v => v.missing > 0).sort((a, b) => b.missing - a.missing);
for (const v of rows) {
  console.log(pad(v.store, 10) + pad(v.sku, 10) + pad(v.name.slice(0, 29), 30) +
              lpad(v.missing, 9) + '  ' + [...new Set(v.orders)].join(', '));
}

console.log(
  `\nphysical_qty at these (store, product) pairs is overstated by the SUBTRACT column.\n` +
  `Apply the correction through the admin stock screen (Products → Stock → adjust) so it\n` +
  `lands in retail_stock_ledger with a reason and an actor — this script deliberately\n` +
  `does not write. Verify the shelf first: some of these may have been counted by hand\n` +
  `already, in which case the ledger correction is a no-op and the count stands.`
);
