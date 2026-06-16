#!/usr/bin/env node
/**
 * Backfill add-on payments + find stranded add-on refunds.
 *
 * Context: a WeChat "add to this order" add-on was settled only in
 * retail_order_addons — it never got a retail_payments row. Two consequences,
 * both now fixed in code (finalizeOrderAddon writes the row; every refund path
 * walks all gateway payment rows):
 *
 *   1) REPORTING — the add-on amount was folded into order.total but the order
 *      kept its original tender (e.g. cash), so the payment-method split booked
 *      the WeChat add-on money to cash.
 *   2) REFUNDS  — refunds only ever touched the order's original payment, so an
 *      add-on's WeChat money was never returned even when the order was fully
 *      "refunded". The screen said "refund complete" but the customer kept being
 *      owed the add-on amount.
 *
 * This script handles the orders that already exist (the code fix only helps new
 * ones):
 *
 *   A) BACKFILL  — for every successful add-on with no matching retail_payments
 *      row, insert one (method=wechat, the FCAO out_trade_no, transaction_id,
 *      status='success'). Idempotent (out_trade_no is UNIQUE). With --write.
 *
 *   B) STRANDED  — list orders that were already marked refunded/cancelled whose
 *      add-on WeChat money was never returned, with the FCAO out_trade_no +
 *      transaction_id so the operator can refund that amount in the WeChat
 *      商户平台 (Merchant Platform). This script does NOT call the gateway — it
 *      reports, the operator refunds, same as a manual cash refund.
 *
 * Read-only by default (prints what it WOULD do). Run ON THE SERVER:
 *   node scripts/backfill_addon_payments.js            # dry run / report
 *   node scripts/backfill_addon_payments.js --write    # create missing payment rows
 */
const path = require('path');
const Database = require('better-sqlite3');

const WRITE = process.argv.includes('--write');
const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH);

const money = (n) => '¥' + (Number(n) || 0).toFixed(2);

// ── A) Successful add-ons missing a retail_payments row ──────────────────────
const orphanAddons = db.prepare(`
  SELECT ad.id, ad.order_id, ad.amount, ad.payment_method, ad.out_trade_no,
         ad.transaction_id, ad.paid_at, o.order_no, o.payment_method AS order_method,
         o.status AS order_status, o.refund_status
    FROM retail_order_addons ad
    JOIN retail_orders o ON o.id = ad.order_id
   WHERE ad.status = 'success'
     AND NOT EXISTS (
       SELECT 1 FROM retail_payments p
        WHERE p.order_id = ad.order_id
          AND p.out_trade_no IS NOT NULL
          AND p.out_trade_no = ad.out_trade_no
     )
   ORDER BY ad.order_id, ad.id
`).all();

console.log('\n=== A) Successful add-ons with NO retail_payments row ===');
console.log(`Found ${orphanAddons.length} add-on(s) needing a payment row.\n`);
const insPay = db.prepare(`
  INSERT OR IGNORE INTO retail_payments
    (order_id, method, amount, status, out_trade_no, transaction_id, completed_at)
  VALUES (?, ?, ?, 'success', ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
`);
let inserted = 0;
for (const a of orphanAddons) {
  console.log(
    `  order ${a.order_no} (#${a.order_id}, ${a.order_status}/${a.refund_status || 'no-refund'}) ` +
    `add-on #${a.id} ${money(a.amount)} via ${a.payment_method || 'wechat'} ` +
    `out_trade_no=${a.out_trade_no || '(none)'} txn=${a.transaction_id || '(none)'}`
  );
  if (WRITE) {
    const r = insPay.run(a.order_id, a.payment_method || 'wechat', a.amount, a.out_trade_no || null, a.transaction_id || null, a.paid_at || null);
    if (r.changes) inserted++;
  }
}
console.log(WRITE ? `\n  → inserted ${inserted} payment row(s).` : '\n  (dry run — pass --write to insert these rows)');

// ── B) Already-refunded orders whose add-on WeChat money was never returned ──
// An order is "refunded" if its fulfilment status is refunded/cancelled OR the
// refund workflow paid out. The add-on is "stranded" if its gateway payment row
// is not (now) fully refunded.
const stranded = db.prepare(`
  SELECT o.id, o.order_no, o.status, o.refund_status, o.refund_amount_paid, o.total,
         ad.id AS addon_id, ad.amount AS addon_amount, ad.out_trade_no, ad.transaction_id, ad.paid_at,
         (SELECT COALESCE(p.refunded_amount, 0)
            FROM retail_payments p
           WHERE p.order_id = o.id AND p.out_trade_no = ad.out_trade_no
           LIMIT 1) AS already_refunded
    FROM retail_order_addons ad
    JOIN retail_orders o ON o.id = ad.order_id
   WHERE ad.status = 'success'
     AND (o.status IN ('refunded', 'cancelled') OR o.refund_status = 'paid')
   ORDER BY o.id, ad.id
`).all().filter(r => (Number(r.already_refunded) || 0) + 0.005 < Number(r.addon_amount));

console.log('\n=== B) Refunded/cancelled orders whose WeChat ADD-ON was NOT returned ===');
if (!stranded.length) {
  console.log('  None. 🎉');
} else {
  console.log(`  ${stranded.length} add-on payment(s) still owed to customers.`);
  console.log('  Refund each in the WeChat 商户平台 (Merchant Platform) against the transaction below:\n');
  let owed = 0;
  for (const s of stranded) {
    owed += Number(s.addon_amount) || 0;
    console.log(
      `  order ${s.order_no} (#${s.id}, ${s.status}/${s.refund_status || '-'})  ` +
      `OWED ${money(Number(s.addon_amount) - (Number(s.already_refunded) || 0))}  ` +
      `out_trade_no=${s.out_trade_no || '(none)'}  txn=${s.transaction_id || '(none)'}  ` +
      `paid_at=${s.paid_at || '?'}`
    );
  }
  console.log(`\n  TOTAL still owed across add-ons: ${money(owed)}`);
  console.log('  (This script does not call the gateway — refund these manually, then it stops listing them once their payment row shows refunded_amount = amount.)');
}

console.log('');
db.close();
