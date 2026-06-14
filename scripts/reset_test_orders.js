#!/usr/bin/env node
/**
 * Reset MINI-APP test orders + their fake test customer accounts.
 *
 * Context: during build-out we placed many test orders under fake customers
 * (e.g. "asher", "mimi dedham"). This wipes those specific accounts and ALL of
 * their order + transactional rows from the new mini-app (retail_*) tables,
 * leaving the product catalog, stores, vouchers, config and PHYSICAL INVENTORY
 * untouched.
 *
 * It does NOT touch other order channels (miniapp_orders / meituan_orders /
 * kitchen sales_entries) and it does NOT delete real customers — you choose
 * exactly which accounts go by id / name / phone.
 *
 * SAFE BY DEFAULT:
 *   • No selector             → LIST every retail_customer (id, name, phone,
 *                               #orders, spend) so you can spot the test ones.
 *   • Selector, no --apply    → PREVIEW: shows the chosen accounts + a per-table
 *                               count of what WOULD be deleted. No writes.
 *   • Selector + --apply      → backs up data/roots.db, then deletes in one txn.
 *
 * Run ON THE SERVER, against data/roots.db:
 *   node scripts/reset_test_orders.js                          # list everyone
 *   node scripts/reset_test_orders.js --names asher,mimi,dedham   # preview
 *   node scripts/reset_test_orders.js --ids 3,4,7                 # preview
 *   node scripts/reset_test_orders.js --names asher,mimi --apply  # do it
 *
 * Selectors (combine freely; a customer matches if ANY selector hits):
 *   --ids 3,4,7            explicit retail_customers.id list
 *   --names asher,mimi     case-insensitive substring match on nickname
 *   --phones 1380000,138   substring match on phone
 *
 * Inventory note: these test orders deducted physical stock at checkout. This
 * script leaves retail_store_stock / retail_stock_ledger ALONE (deleting them
 * blindly would desync your real counts). It prints how much stock the deleted
 * orders consumed so you can re-count by hand if you care.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
function listArg(flag) {
  const i = argv.indexOf(flag);
  if (i === -1 || !argv[i + 1]) return [];
  return argv[i + 1].split(',').map(s => s.trim()).filter(Boolean);
}
const idSel    = listArg('--ids').map(Number).filter(n => Number.isInteger(n) && n > 0);
const nameSel  = listArg('--names').map(s => s.toLowerCase());
const phoneSel = listArg('--phones');
const hasSelector = idSel.length || nameSel.length || phoneSel.length;

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
if (!fs.existsSync(DB_PATH)) {
  console.error(`[reset] DB not found: ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const fmt = n => (Math.round((n || 0) * 100) / 100).toFixed(2);

// ── LIST MODE: no selector → show all customers so you can pick ──────────────
if (!hasSelector) {
  const rows = db.prepare(`
    SELECT c.id, c.nickname, c.phone, c.email, c.balance, c.points_balance,
           c.lifetime_spend, c.created_at,
           (SELECT COUNT(*) FROM retail_orders o WHERE o.customer_id = c.id) AS orders
      FROM retail_customers c
     ORDER BY c.id
  `).all();
  console.log(`\n${rows.length} customer account(s) in retail_customers:\n`);
  console.log('  id  | orders | spend     | bal      | pts   | phone         | name');
  console.log('  ----+--------+-----------+----------+-------+---------------+--------------------');
  for (const r of rows) {
    console.log(
      `  ${String(r.id).padStart(3)} | ${String(r.orders).padStart(6)} | ` +
      `${fmt(r.lifetime_spend).padStart(9)} | ${fmt(r.balance).padStart(8)} | ` +
      `${String(r.points_balance).padStart(5)} | ${String(r.phone || '-').padEnd(13)} | ` +
      `${r.nickname || '(no name)'}`
    );
  }
  console.log(`\nNext: pick the test accounts and PREVIEW, e.g.`);
  console.log(`  node scripts/reset_test_orders.js --names asher,mimi,dedham`);
  console.log(`  node scripts/reset_test_orders.js --ids 3,4,7\n`);
  db.close();
  process.exit(0);
}

// ── RESOLVE selected customers ───────────────────────────────────────────────
const all = db.prepare(`SELECT id, nickname, phone, lifetime_spend FROM retail_customers`).all();
const picked = all.filter(c => {
  if (idSel.includes(c.id)) return true;
  const nk = (c.nickname || '').toLowerCase();
  if (nameSel.some(n => nk.includes(n))) return true;
  const ph = c.phone || '';
  if (phoneSel.some(p => ph.includes(p))) return true;
  return false;
});

if (!picked.length) {
  console.log('\nNo customers matched your selectors. Nothing to do.');
  console.log('Run with no arguments to list all accounts.\n');
  db.close();
  process.exit(0);
}

const cIds = picked.map(c => c.id);
const cList = cIds.join(',');
const orderIds = db.prepare(`SELECT id FROM retail_orders WHERE customer_id IN (${cList})`).all().map(r => r.id);
const oList = orderIds.length ? orderIds.join(',') : '-1';

console.log(`\n${APPLY ? 'APPLYING' : 'PREVIEW'} — deleting ${picked.length} account(s) + their mini-app data:\n`);
for (const c of picked) {
  console.log(`  • id ${c.id}  ${c.nickname || '(no name)'}  ${c.phone || ''}  (spend ¥${fmt(c.lifetime_spend)})`);
}

// ── count what will be removed, per table ────────────────────────────────────
const countCustomer = [
  'retail_customer_addresses', 'retail_auth_tokens', 'retail_notifications',
  'retail_customer_vouchers', 'retail_customer_favorites', 'retail_points_transactions',
  'retail_topup_transactions', 'retail_poll_votes', 'retail_reviews',
  'retail_feedback', 'retail_subscriptions', 'retail_visits', 'retail_checkout_quotes',
];
const countOrder = [
  'retail_order_items', 'retail_payments', 'retail_refund_events',
  'retail_shipments', 'retail_stock_reservations',
];
console.log(`\n  Rows to delete:`);
console.log(`    retail_orders                ${orderIds.length}`);
for (const t of countOrder) {
  const n = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE order_id IN (${oList})`).get().n;
  console.log(`    ${t.padEnd(28)} ${n}`);
}
for (const t of countCustomer) {
  const n = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE customer_id IN (${cList})`).get().n;
  console.log(`    ${t.padEnd(28)} ${n}`);
}
const refN = db.prepare(`SELECT COUNT(*) n FROM retail_referrals WHERE referrer_id IN (${cList}) OR invitee_id IN (${cList})`).get().n;
console.log(`    retail_referrals             ${refN}`);
console.log(`    retail_customers             ${picked.length}`);

// reference fix-ups (kept, not deleted)
const credN = db.prepare(`SELECT COUNT(*) n FROM retail_migration_credits WHERE claimed_customer_id IN (${cList})`).get().n;
const unmN  = db.prepare(`SELECT COUNT(*) n FROM retail_migration_unmatched WHERE credited_customer_id IN (${cList})`).get().n;
const refByN = db.prepare(`SELECT COUNT(*) n FROM retail_customers WHERE referred_by_customer_id IN (${cList}) AND id NOT IN (${cList})`).get().n;
console.log(`\n  Reference resets (rows KEPT, links cleared):`);
console.log(`    migration credits re-staged  ${credN}`);
console.log(`    migration unmatched re-staged ${unmN}`);
console.log(`    surviving customers un-referred ${refByN}`);

// inventory impact (reported only — NOT changed)
const stockHit = db.prepare(`
  SELECT COALESCE(SUM(qty),0) units, COUNT(DISTINCT product_id) skus
    FROM retail_order_items WHERE order_id IN (${oList})
`).get();
console.log(`\n  Inventory NOT changed. These orders consumed ${fmt(stockHit.units)} unit(s) across ${stockHit.skus} product(s).`);
console.log(`  (retail_store_stock / retail_stock_ledger left intact — re-count by hand if needed.)`);

if (!APPLY) {
  console.log(`\nPREVIEW only — nothing written. Re-run with --apply to delete.\n`);
  db.close();
  process.exit(0);
}

// ── APPLY: back up, then delete in one transaction ───────────────────────────
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(path.dirname(DB_PATH), `roots-pretestreset-${ts}.db`);
db.pragma('wal_checkpoint(TRUNCATE)');
fs.copyFileSync(DB_PATH, backup);
console.log(`\n[reset] backup written: ${backup}`);

const run = db.transaction(() => {
  // 1) decrement cached poll tallies for votes we're about to remove
  const votes = db.prepare(`SELECT poll_id, option_id FROM retail_poll_votes WHERE customer_id IN (${cList})`).all();
  const decOpt  = db.prepare(`UPDATE retail_poll_options SET votes = MAX(0, votes - 1) WHERE id = ?`);
  const decPoll = db.prepare(`UPDATE retail_polls SET total_votes = MAX(0, total_votes - 1) WHERE id = ?`);
  for (const v of votes) { decOpt.run(v.option_id); decPoll.run(v.poll_id); }

  // 2) order-scoped children
  for (const t of countOrder) db.prepare(`DELETE FROM ${t} WHERE order_id IN (${oList})`).run();

  // 3) customer-scoped children
  for (const t of countCustomer) db.prepare(`DELETE FROM ${t} WHERE customer_id IN (${cList})`).run();
  db.prepare(`DELETE FROM retail_referrals WHERE referrer_id IN (${cList}) OR invitee_id IN (${cList})`).run();

  // 4) reference fix-ups on rows we keep
  db.prepare(`UPDATE retail_migration_credits SET claimed_at = NULL, claimed_customer_id = NULL WHERE claimed_customer_id IN (${cList})`).run();
  db.prepare(`UPDATE retail_migration_unmatched SET credited_at = NULL, credited_customer_id = NULL WHERE credited_customer_id IN (${cList})`).run();
  db.prepare(`UPDATE retail_customers SET referred_by_customer_id = NULL, referral_applied_at = NULL WHERE referred_by_customer_id IN (${cList}) AND id NOT IN (${cList})`).run();

  // 5) the orders, then the accounts
  db.prepare(`DELETE FROM retail_orders WHERE customer_id IN (${cList})`).run();
  db.prepare(`DELETE FROM retail_customers WHERE id IN (${cList})`).run();
});
run();

// integrity sanity check
const fk = db.pragma('foreign_key_check');
if (fk.length) {
  console.error(`\n[reset] WARNING: foreign_key_check reported ${fk.length} issue(s):`, fk.slice(0, 5));
} else {
  console.log(`[reset] foreign_key_check clean.`);
}

const left = db.prepare(`SELECT COUNT(*) n FROM retail_customers`).get().n;
const leftOrders = db.prepare(`SELECT COUNT(*) n FROM retail_orders`).get().n;
console.log(`\n[reset] DONE. ${picked.length} account(s) + ${orderIds.length} order(s) removed.`);
console.log(`[reset] Remaining: ${left} customer(s), ${leftOrders} order(s).`);
console.log(`[reset] Restore if needed:  cp "${backup}" "${DB_PATH}"  (then restart the app)\n`);
db.close();
