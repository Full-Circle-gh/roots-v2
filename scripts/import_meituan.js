#!/usr/bin/env node
/**
 * Meituan import. Reads a JSON snapshot built by the Python converter
 * and writes:
 *   - meituan_stores       (upsert by source_store_id)
 *   - meituan_orders       (upsert by source_order_no)
 *   - meituan_settlements  (upsert by store_id + settlement_id + bill_date)
 *   - meituan_balance_flow (upsert by txn_id)
 *   - sales_entries        (one row per order, channel='meituan',
 *                            total = order's product revenue,
 *                            notes carry [meituan:store_id:order_no])
 *
 * Idempotent — re-running with the same file replaces nothing.
 *
 * Usage:
 *   node scripts/import_meituan.js --src=scripts/meituan_yuexiu_2026_01.json --dry-run
 *   node scripts/import_meituan.js --src=scripts/meituan_yuexiu_2026_01.json
 */
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DRY = process.argv.includes('--dry-run');
const srcArg = process.argv.find(a => a.startsWith('--src='));
if (!srcArg) { console.error('Usage: --src=path/to/meituan_*.json [--dry-run]'); process.exit(1); }
const SRC = path.resolve(srcArg.slice('--src='.length));
const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');

const snap = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Confirm schema is migrated.
const ok = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meituan_orders'").get();
if (!ok) { console.error('meituan_orders missing — restart the app once to migrate, then retry.'); process.exit(1); }

// ── Stage 0: store upsert
const findStore = db.prepare('SELECT id FROM meituan_stores WHERE source_store_id = ?');
const insStore  = db.prepare('INSERT INTO meituan_stores (source_store_id, name, nickname) VALUES (?, ?, ?)');
const updStore  = db.prepare("UPDATE meituan_stores SET name = ?, nickname = COALESCE(NULLIF(?,''), nickname) WHERE id = ?");

const stats = { storeAction: '', ordersInserted: 0, ordersUpdated: 0,
                settlements: 0, balanceFlow: 0, salesProjected: 0 };

const tx = db.transaction(() => {
  // store
  let storeRow = findStore.get(snap.store.source_store_id);
  let storeDbId;
  if (storeRow) {
    updStore.run(snap.store.name, snap.store.nickname, storeRow.id);
    storeDbId = storeRow.id;
    stats.storeAction = `updated id=${storeDbId}`;
  } else {
    const r = insStore.run(snap.store.source_store_id, snap.store.name, snap.store.nickname);
    storeDbId = r.lastInsertRowid;
    stats.storeAction = `inserted id=${storeDbId}`;
  }

  // ── Stage 1: orders
  const findOrder = db.prepare('SELECT id FROM meituan_orders WHERE source_order_no = ?');
  const insOrder  = db.prepare(`INSERT INTO meituan_orders (
    store_id, source_order_no, ordered_at, completed_at, refunded_at, status,
    delivery_method, customer_payment, product_total, package_fee, customer_paid,
    customer_delivery_fee, merchant_subsidy, platform_subsidy,
    delivery_fee_paid, delivery_tip_paid, ad_spend, coupon_subsidy_paid,
    insurance_fee, commission, partial_refund,
    gross_amount, net_to_merchant, item_count
  ) VALUES (?,?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?, ?,?,?)`);
  // The UPDATE mirrors the INSERT column order (incl. source_order_no as
  // a no-op write) so the args array from orderArgs() can be reused.
  const updOrder  = db.prepare(`UPDATE meituan_orders SET
    store_id=?, source_order_no=?, ordered_at=?, completed_at=?, refunded_at=?, status=?,
    delivery_method=?, customer_payment=?, product_total=?, package_fee=?, customer_paid=?,
    customer_delivery_fee=?, merchant_subsidy=?, platform_subsidy=?,
    delivery_fee_paid=?, delivery_tip_paid=?, ad_spend=?, coupon_subsidy_paid=?,
    insurance_fee=?, commission=?, partial_refund=?,
    gross_amount=?, net_to_merchant=?, item_count=?,
    imported_at=CURRENT_TIMESTAMP
    WHERE id=?`);

  const orderArgs = (o) => [
    storeDbId, o.source_order_no, o.ordered_at, o.completed_at, o.refunded_at, o.status,
    o.delivery_method, o.customer_payment, o.product_total||0, o.package_fee||0, o.customer_paid||0,
    o.customer_delivery_fee||0, o.merchant_subsidy||0, o.platform_subsidy||0,
    o.delivery_fee_paid||0, o.delivery_tip_paid||0, o.ad_spend||0, o.coupon_subsidy_paid||0,
    o.insurance_fee||0, o.commission||0, o.partial_refund||0,
    o.gross_amount||0, o.net_to_merchant||0, o.item_count||0,
  ];

  for (const o of snap.orders) {
    const existing = findOrder.get(o.source_order_no);
    if (existing) { updOrder.run(...orderArgs(o), existing.id); stats.ordersUpdated++; }
    else          { insOrder.run(...orderArgs(o)); stats.ordersInserted++; }
  }

  // ── Stage 2: settlements
  const insSettle = db.prepare(`INSERT OR REPLACE INTO meituan_settlements
    (store_id, settlement_id, bill_date, bill_amount, status, period, settled_on)
    VALUES (?,?,?,?,?,?,?)`);
  for (const s of snap.settlements) {
    insSettle.run(storeDbId, s.settlement_id, s.bill_date, s.bill_amount, s.status, s.period, s.settled_on);
    stats.settlements++;
  }

  // ── Stage 3: balance flow
  const insFlow = db.prepare(`INSERT OR REPLACE INTO meituan_balance_flow
    (store_id, txn_id, occurred_at, type, amount, balance_after, status)
    VALUES (?,?,?,?,?,?,?)`);
  for (const f of snap.balance_flow) {
    insFlow.run(storeDbId, f.txn_id, f.occurred_at, f.type, f.amount, f.balance_after, f.status);
    stats.balanceFlow++;
  }

  // ── Stage 4: sales_entries projection (one row per order)
  // Uses product_total + package_fee as `total` — this is what the
  // customer paid for products (comparable to mini-app's `Income`).
  // The fee waterfall lives in the dedicated Meituan tab.
  // Idempotent: each order's existing sales row (matched by its tag in
  // notes) is deleted first, then re-inserted. Wiping per-order — NOT
  // store-wide — so importing one month doesn't blow away data from
  // other months for the same store.
  const wipeOneSale = db.prepare(`DELETE FROM sales_entries WHERE channel = 'meituan' AND notes LIKE ?`);
  const insSale = db.prepare(`INSERT INTO sales_entries
    (date, product_id, product_name, channel, qty, unit_price, total, notes)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (const o of snap.orders) {
    if (!o.ordered_at) continue;
    // Skip cancelled orders — they have product_total ≤ 0 and shouldn't
    // count as revenue. (Status = '订单取消' rows still get into
    // meituan_orders for the order list view, but we don't project them
    // into the channel-mix dashboard.)
    if (o.status === '订单取消') continue;
    const tag = `[meituan:${snap.store.source_store_id}:${o.source_order_no}]`;
    const date = (o.ordered_at || '').slice(0, 10);
    const total = (o.product_total || 0) + (o.package_fee || 0);
    if (total <= 0) continue;
    // Wipe the prior projection for THIS specific order before inserting
    // so re-runs don't duplicate. Uses LIKE 'tag%' to match the tag at
    // the start of notes regardless of trailing extras.
    wipeOneSale.run(tag + '%');
    const name = `Meituan ${snap.store.nickname || snap.store.name || ''} order`;
    const extras = [`Items: ${o.item_count || 0}`];
    if (o.delivery_method) extras.push(o.delivery_method);
    if (o.net_to_merchant != null) extras.push(`Net: ¥${(o.net_to_merchant).toFixed(2)}`);
    insSale.run(date, null, name.trim(), 'meituan', o.item_count || 1, 0, total,
                `${tag} ${extras.join(' · ')}`);
    stats.salesProjected++;
  }
});

if (DRY) {
  console.log(`DRY-RUN — would import from ${path.basename(SRC)}:`);
  console.log(`  Store: ${snap.store.name} (source_id=${snap.store.source_store_id})`);
  console.log(`  Orders:       ${snap.orders.length}`);
  console.log(`  Settlements:  ${snap.settlements.length}`);
  console.log(`  Balance flow: ${snap.balance_flow.length}`);
  const grossSum = snap.orders.reduce((s, o) => s + (o.gross_amount || 0), 0);
  const netSum   = snap.orders.reduce((s, o) => s + (o.net_to_merchant || 0), 0);
  console.log(`  Gross sum:    ¥${grossSum.toFixed(2)}`);
  console.log(`  Net sum:      ¥${netSum.toFixed(2)}`);
  process.exit(0);
}

tx();
console.log(`✅ Meituan import complete (${path.basename(SRC)})`);
console.log(`  Store:               ${stats.storeAction}`);
console.log(`  Orders inserted:     ${stats.ordersInserted}`);
console.log(`  Orders updated:      ${stats.ordersUpdated}`);
console.log(`  Settlements:         ${stats.settlements}`);
console.log(`  Balance flow:        ${stats.balanceFlow}`);
console.log(`  Sales rows projected:${stats.salesProjected}`);
