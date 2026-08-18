#!/usr/bin/env node
//
// repair_sweep_cancel_reversals.js — return what the reservation sweeper took.
//
// sweepExpiredReservations cancelled pending_payment orders without calling any
// of the reversal helpers, so customers lost points, balance and vouchers spent
// at order-create. The code fix stops it recurring; this returns what is already
// gone. Measured against every order the sweeper ever cancelled (26 orders, 9
// customers, 2026-06-17 to 2026-08-12) — exactly two customers are short:
//
//   302  6 points, redeemed on orders 363 (2 pts) and 571 (4 pts)
//   506  the SPROUT voucher grant (¥20.00) consumed by order 397
//
// NOT IN THIS SCRIPT, DELIBERATELY. The tester account 233 carries ¥899.00 of
// phantom lifetime_spend and ¥0.49 of unreturned wallet balance from the
// separate item-44 defect. Nobody is owed it, no tier is affected by it, and the
// only reason to touch it at all is that check M reads lifetime_spend and M is a
// cutover input. That is a different job with a different justification and it
// does not belong in a customer repair.
//
// WHAT IT WRITES, AND WHY IN THAT SHAPE
// -------------------------------------
// Each repair mirrors the helper that should have run, so a later legitimate
// call to that helper is a no-op rather than a second return:
//
//   points   reverseOrderRedeem's shape — credit the balance and INSERT the
//            'refund_redeem' ledger row. That row is what the helper's own
//            cumulative cap reads, so once it exists the helper returns 0.
//   voucher  reverseOrderVoucher's shape — clear the personal grant (used_at,
//            used_order_id) and decrement the global pool. NOTE: SPROUT has
//            max_uses NULL, so the pool figure gates nothing and the decrement
//            is bookkeeping; what actually returns the voucher to the customer
//            is the grant clear, against per_customer_limit.
//
// SAFETY
//   • DRY RUN BY DEFAULT. --apply is required to write, and it fails closed.
//   • Every target is re-checked at write time against the same precondition
//     that selected it, inside one transaction. A target already repaired by
//     hand is skipped, not doubled.
//   • Checksums of every touched row are taken BEFORE and AFTER and printed.
//   • An UNDO FILE is written before the transaction commits, carrying the row
//     ids and their prior values.
//
// ACCEPTANCE TEST — not optional, and not this script's own output:
//   node scripts/check_ledger_invariants.js
// Checks E (points balance vs ledger) and G (ledger continuity) are the ones
// this touches. They must be no worse after than before; run it BEFORE too, so
// "was it already failing" is a fact rather than a guess.
//
// USAGE
//   node scripts/repair_sweep_cancel_reversals.js                 # dry run
//   node scripts/repair_sweep_cancel_reversals.js --apply         # write
//   node scripts/repair_sweep_cancel_reversals.js --db <path>     # target a copy
//
// EXIT  0 done (or nothing to do) · 1 refused / failed

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const WRITE = argv.includes('--apply');
const dbFlag = argv.indexOf('--db');
const DB_PATH = dbFlag >= 0 && argv[dbFlag + 1]
  ? path.resolve(argv[dbFlag + 1])
  : path.join(__dirname, '..', 'data', 'roots.db');

if (!fs.existsSync(DB_PATH)) { console.error('DB not found at', DB_PATH); process.exit(1); }
const db = new Database(DB_PATH);

// ── the targets, named rather than discovered ────────────────────────────
// Deliberately a fixed list. A query that re-derives "who is short" would also
// pick up anything a future defect creates, and this script's justification —
// two customers, measured, on one dead code path — would not extend to it.
const POINT_REPAIRS = [
  { customerId: 302, orderId: 363, points: 2 },
  { customerId: 302, orderId: 571, points: 4 },
];
const VOUCHER_REPAIRS = [
  { customerId: 506, orderId: 397, grantId: 87, code: 'SPROUT' },
];

const money = (n) => Number(n || 0).toFixed(2);
const digest = (rows) => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);

// ── checksum surface: every row this script can touch ────────────────────
function snapshot() {
  const customers = db.prepare(
    'SELECT id, points_balance FROM retail_customers WHERE id IN (302, 506) ORDER BY id'
  ).all();
  const ledger = db.prepare(
    "SELECT id, customer_id, delta, balance_after, source, order_id FROM retail_points_transactions WHERE order_id IN (363, 571) ORDER BY id"
  ).all();
  const grants = db.prepare(
    'SELECT id, customer_id, voucher_id, used_at, used_order_id FROM retail_customer_vouchers WHERE id IN (87) ORDER BY id'
  ).all();
  const vouchers = db.prepare(
    "SELECT id, code, used_count FROM retail_vouchers WHERE UPPER(code) IN ('SPROUT') ORDER BY id"
  ).all();
  return { customers, ledger, grants, vouchers };
}
const stamp = (s) => ({
  customers: digest(s.customers), ledger: digest(s.ledger),
  grants: digest(s.grants), vouchers: digest(s.vouchers),
});

// ── plan: re-check each target's precondition ────────────────────────────
const plan = { points: [], vouchers: [], skipped: [] };

for (const t of POINT_REPAIRS) {
  const spend = db.prepare(
    "SELECT id, customer_id, delta FROM retail_points_transactions WHERE order_id = ? AND source = 'order_redeem'"
  ).get(t.orderId);
  const returned = db.prepare(
    `SELECT COALESCE(SUM(delta), 0) AS s FROM retail_points_transactions
      WHERE order_id = ? AND (source = 'refund_redeem' OR (source = 'refund_reverse' AND delta > 0))`
  ).get(t.orderId).s;
  const order = db.prepare('SELECT id, status, cancelled_reason, customer_id FROM retail_orders WHERE id = ?').get(t.orderId);

  if (!spend) { plan.skipped.push(`order ${t.orderId}: no order_redeem row — nothing was spent`); continue; }
  if (!order || order.status !== 'cancelled') { plan.skipped.push(`order ${t.orderId}: not cancelled (${order && order.status}) — refusing`); continue; }
  if (order.cancelled_reason !== 'reservation_expired') { plan.skipped.push(`order ${t.orderId}: cancelled_reason is '${order && order.cancelled_reason}', not the sweeper — refusing`); continue; }
  if (spend.customer_id !== t.customerId || order.customer_id !== t.customerId) { plan.skipped.push(`order ${t.orderId}: customer mismatch — refusing`); continue; }
  const owed = (-spend.delta) - returned;
  if (owed <= 0) { plan.skipped.push(`order ${t.orderId}: already returned (${returned} pts) — nothing owed`); continue; }
  if (owed !== t.points) { plan.skipped.push(`order ${t.orderId}: owed ${owed} pts but the measured figure was ${t.points} — data moved, refusing`); continue; }
  plan.points.push({ ...t, owed });
}

for (const t of VOUCHER_REPAIRS) {
  const grant = db.prepare('SELECT id, customer_id, voucher_id, used_at, used_order_id FROM retail_customer_vouchers WHERE id = ?').get(t.grantId);
  const order = db.prepare('SELECT id, status, cancelled_reason, customer_id, voucher_code FROM retail_orders WHERE id = ?').get(t.orderId);
  const voucher = db.prepare('SELECT id, code, used_count FROM retail_vouchers WHERE UPPER(code) = ?').get(t.code.toUpperCase());

  if (!grant) { plan.skipped.push(`grant ${t.grantId}: missing — refusing`); continue; }
  if (!grant.used_at || grant.used_order_id !== t.orderId) { plan.skipped.push(`grant ${t.grantId}: not consumed by order ${t.orderId} — already returned`); continue; }
  if (grant.customer_id !== t.customerId) { plan.skipped.push(`grant ${t.grantId}: customer mismatch — refusing`); continue; }
  if (!order || order.status !== 'cancelled' || order.cancelled_reason !== 'reservation_expired') { plan.skipped.push(`order ${t.orderId}: not a sweeper cancel — refusing`); continue; }
  if (!voucher) { plan.skipped.push(`voucher ${t.code}: missing — refusing`); continue; }
  plan.vouchers.push({ ...t, voucherId: voucher.id, usedCount: voucher.used_count });
}

// ── report ───────────────────────────────────────────────────────────────
const before = snapshot();
console.log('DB:', DB_PATH);
console.log('\nCHECKSUMS BEFORE');
for (const [k, v] of Object.entries(stamp(before))) console.log(`  ${k.padEnd(10)} ${v}`);

console.log('\nPLAN');
if (!plan.points.length && !plan.vouchers.length) console.log('  (nothing to do)');
// Two repairs can land on the same customer (302 has both), and each write is a
// relative increment — points_balance = points_balance + N. So the plan carries a
// running balance. Reading the stored balance fresh per line would print every
// repair starting from the same figure, which reads as if the last one wins.
const running = new Map();
for (const p of plan.points) {
  const from = running.has(p.customerId)
    ? running.get(p.customerId)
    : db.prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(p.customerId).points_balance;
  const to = from + p.owed;
  running.set(p.customerId, to);
  console.log(`  customer ${p.customerId}: +${p.owed} pts for order ${p.orderId} (balance ${from} -> ${to}), plus a refund_redeem ledger row`);
}
// State the end figure for anyone getting more than one repair, so the total is
// read off the plan rather than added up by hand.
for (const [cid, end] of running) {
  const rows = plan.points.filter((p) => p.customerId === cid);
  if (rows.length < 2) continue;
  const owed = rows.reduce((s, p) => s + p.owed, 0);
  console.log(`    = customer ${cid} ends at ${end} pts (${end - owed} + ${owed} across ${rows.length} orders)`);
}
for (const v of plan.vouchers) {
  console.log(`  customer ${v.customerId}: return voucher ${v.code} (grant ${v.grantId}, order ${v.orderId}); global used_count ${v.usedCount} -> ${Math.max(0, v.usedCount - 1)}`);
}
for (const s of plan.skipped) console.log(`  SKIP  ${s}`);

if (!plan.points.length && !plan.vouchers.length) { console.log('\nNothing to apply.'); process.exit(0); }

if (!WRITE) {
  console.log('\nDRY RUN — nothing was written. Re-run with --apply.');
  console.log('Run scripts/check_ledger_invariants.js before AND after, and compare.');
  process.exit(0);
}

// ── undo file, written BEFORE the transaction commits ────────────────────
const undo = {
  script: 'repair_sweep_cancel_reversals.js',
  db: DB_PATH,
  written_at: new Date().toISOString(),
  checksums_before: stamp(before),
  prior_state: before,
  planned: { points: plan.points, vouchers: plan.vouchers },
  how_to_undo: [
    'For each points repair: DELETE the refund_redeem row this script inserted for that order_id,',
    'then restore retail_customers.points_balance to prior_state.customers.',
    'For each voucher repair: restore retail_customer_vouchers.used_at/used_order_id from',
    'prior_state.grants, and retail_vouchers.used_count from prior_state.vouchers.',
    'The ledger rows this script inserted carry the note prefix [repair sweep-cancel].',
  ],
};
const undoPath = path.join(path.dirname(DB_PATH), `undo-repair-sweep-cancel-${Date.now()}.json`);
fs.writeFileSync(undoPath, JSON.stringify(undo, null, 2));
console.log('\nUNDO FILE:', undoPath);

// ── apply ────────────────────────────────────────────────────────────────
let pointsCredited = 0, vouchersReturned = 0;
const tx = db.transaction(() => {
  for (const p of plan.points) {
    // Re-check inside the transaction — the same precondition, not a weaker one.
    const already = db.prepare(
      `SELECT COALESCE(SUM(delta), 0) AS s FROM retail_points_transactions
        WHERE order_id = ? AND (source = 'refund_redeem' OR (source = 'refund_reverse' AND delta > 0))`
    ).get(p.orderId).s;
    if (already > 0) continue;
    db.prepare('UPDATE retail_customers SET points_balance = points_balance + ? WHERE id = ?').run(p.owed, p.customerId);
    const after = db.prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(p.customerId).points_balance;
    db.prepare(
      `INSERT INTO retail_points_transactions (customer_id, delta, balance_after, source, order_id, note)
       VALUES (?, ?, ?, 'refund_redeem', ?, ?)`
    ).run(p.customerId, p.owed, after, p.orderId,
      `[repair sweep-cancel] Redemption returned (${p.owed} pts) — reservation_expired cancel reversed nothing`);
    pointsCredited += p.owed;
  }
  for (const v of plan.vouchers) {
    const g = db.prepare('SELECT used_at, used_order_id FROM retail_customer_vouchers WHERE id = ?').get(v.grantId);
    if (!g || !g.used_at || g.used_order_id !== v.orderId) continue;
    db.prepare('UPDATE retail_vouchers SET used_count = used_count - 1 WHERE id = ? AND used_count > 0').run(v.voucherId);
    db.prepare('UPDATE retail_customer_vouchers SET used_at = NULL, used_order_id = NULL WHERE id = ? AND used_at IS NOT NULL').run(v.grantId);
    vouchersReturned++;
  }
});
tx();

const after = snapshot();
console.log('\nAPPLIED');
console.log(`  points credited:   ${pointsCredited}`);
console.log(`  vouchers returned: ${vouchersReturned}`);
console.log('\nCHECKSUMS AFTER');
const sb = stamp(before), sa = stamp(after);
for (const k of Object.keys(sa)) console.log(`  ${k.padEnd(10)} ${sa[k]}${sa[k] === sb[k] ? '  (unchanged)' : '  (was ' + sb[k] + ')'}`);
console.log('\nNOW RUN THE ACCEPTANCE TEST:  node scripts/check_ledger_invariants.js');
console.log('Compare against the run you took before this one. Nothing may be worse.');
console.log('Amount of money moved: ¥' + money(0) + ' — this repair returns points and a voucher, not cash.');
process.exit(0);
