// Signup rewards: the welcome vouchers a new customer is granted (and pulled
// back from a returning OUT1N customer, matched by phone), and the one-time
// claim of an OUT1N customer's migrated wallet balance and points. Moved out
// of routes/retail.js unchanged (decisions §477).
'use strict';

const { tdb } = require('./tenant-db');

// Auto-grant every voucher flagged auto_grant_signup to a fresh customer.
// Called from /api/retail/auth right after the INSERT INTO retail_customers.
// Idempotent via INSERT OR IGNORE — the (customer_id, voucher_id) unique key
// on retail_customer_vouchers means a re-run can't double-grant. Expired or
// inactive vouchers are filtered out so we don't gift dead coupons.
function grantSignupVouchers(customerId) {
  if (!customerId) return 0;
  const rows = tdb().prepare(
    `SELECT id FROM retail_vouchers
      WHERE auto_grant_signup = 1
        AND is_active = 1
        AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)`
  ).all();
  if (!rows.length) return 0;
  const ins = tdb().prepare(
    `INSERT OR IGNORE INTO retail_customer_vouchers
       (customer_id, voucher_id, granted_by, granted_note)
     VALUES (?, ?, NULL, 'Auto-granted on signup')`
  );
  let n = 0;
  const tx = tdb().transaction(() => {
    for (const r of rows) {
      const info = ins.run(customerId, r.id);
      if (info.changes) n++;
    }
  });
  tx();
  return n;
}

// Decide signup-voucher eligibility from the customer's PHONE — the only key
// shared with the OUT1N roster. Called at every phone-touch point (auth,
// getPhoneNumber, admin set). Three outcomes:
//   • no phone yet         → no-op; the grant is deferred until a phone is known
//   • returning OUT1N phone → revoke any UNUSED auto-granted signup voucher
//                             (they are NOT a new signup)
//   • brand-new phone       → grant the signup voucher(s)
// retail_migration_credits now holds EVERY OUT1N phone (incl. zero-balance
// customers seeded with 0/0), so "phone present in that table" == "returning
// OUT1N customer", regardless of whether they had money or have claimed yet.
// Returns the number of signup vouchers GRANTED (0 when it pulled them back,
// or when there was no phone to decide on yet) so a caller can tell the
// operator what actually arrived. Callers that don't care can ignore it.
//
// phoneHint closes the mini-app hole: WeChat login yields only an openid, so a
// customer who never taps "bind phone" had NO phone on the account and was
// therefore never eligible — they could browse, order and pay and still never
// receive the welcome coupon. A delivery address always carries a phone, so we
// let the caller pass it in and decide off that. The hint is used ONLY for this
// eligibility question: it is deliberately NOT written to retail_customers.phone,
// because that field also keys claimMigrationCredit — adopting a recipient phone
// (which may be a friend's or a colleague's) would hand this customer someone
// else's OUT1N wallet balance. Read-only here, money-safe.
function reconcileSignupVouchers(customerId, phoneHint) {
  if (!customerId) return 0;
  const c = tdb().prepare('SELECT id, phone FROM retail_customers WHERE id = ?').get(customerId);
  const phone = normalizeMigrationPhone(c && c.phone) || normalizeMigrationPhone(phoneHint);
  if (!phone) return 0;                       // defer — phone not captured yet
  const returning = tdb().prepare(
    'SELECT 1 FROM retail_migration_credits WHERE phone = ? LIMIT 1'
  ).get(phone);
  if (returning) {
    // Pull back only AUTO-granted, still-unused signup vouchers — never an
    // operator's deliberate gift (granted_by / note guard that).
    tdb().prepare(
      `DELETE FROM retail_customer_vouchers
        WHERE customer_id = ?
          AND used_at IS NULL
          AND granted_by IS NULL
          AND granted_note = 'Auto-granted on signup'
          AND voucher_id IN (SELECT id FROM retail_vouchers WHERE auto_grant_signup = 1)`
    ).run(customerId);
    return 0;                                 // returning customer — nothing new
  } else {
    return grantSignupVouchers(customerId);   // genuine new signup
  }
}

// Normalize a phone to bare digits for migration-credit matching. Strips
// spaces, punctuation and a leading +86 / 86 country code so the OUT1N export
// ("18878839078") and a customer-entered "+86 188 7883 9078" land on the same
// key. Returns '' when there's nothing usable.
function normalizeMigrationPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('86')) d = d.slice(2);
  return d;
}

// One-time migration of OUT1N wallet balance + points onto a roots customer,
// matched by phone. Idempotent and race-safe: we CLAIM the staging row first
// (UPDATE ... WHERE claimed_at IS NULL) and only credit the customer if that
// claim won the row, so a phone can never be credited twice even under
// concurrent calls. Safe to call on every login / phone change — it's a cheap
// no-op when there's no unclaimed credit. Returns the applied credit or null.
function claimMigrationCredit(customerId) {
  if (!customerId) return null;
  const c = tdb().prepare('SELECT id, phone FROM retail_customers WHERE id = ?').get(customerId);
  const phone = normalizeMigrationPhone(c && c.phone);
  if (!phone) return null;
  const credit = tdb().prepare(
    'SELECT * FROM retail_migration_credits WHERE phone = ? AND claimed_at IS NULL'
  ).get(phone);
  if (!credit) return null;

  try {
    const applied = tdb().transaction(() => {
      const won = tdb().prepare(
        `UPDATE retail_migration_credits
            SET claimed_at = CURRENT_TIMESTAMP, claimed_customer_id = ?
          WHERE id = ? AND claimed_at IS NULL`
      ).run(customerId, credit.id);
      if (!won.changes) return null;   // another request claimed it first

      if (credit.balance && credit.balance > 0) {
        tdb().prepare('UPDATE retail_customers SET balance = COALESCE(balance, 0) + ? WHERE id = ?')
          .run(credit.balance, customerId);
        // THE LEDGER ROW. Added 2026-08-13; its absence was the first live money
        // inconsistency this project found by measurement (§24, check F). The
        // points branch below has always written its row — this branch credited
        // real money and explained it nowhere, eleven lines apart in one
        // function. Seven customers and ¥3,669.64 got here that way, and 53
        // unclaimed credits carrying ¥17,362.32 were queued to do it again.
        //
        // status = 'success' is load-bearing, not decoration: check F sums only
        // successful rows, so any other value writes a row that exists and still
        // does not explain the balance — the same defect wearing a row.
        //
        // out_trade_no CARRIES THE CLAIMANT, NOT JUST THE CREDIT. Keyed on
        // credit.id alone it would collide the moment a re-imported row is
        // re-armed and claimed by a second customer, which has already happened
        // once (§24, the staging table is not append-only) and which check J
        // would then report as a duplicate when both credits were legitimate.
        // With the claimant in the key the legitimate re-claim is distinct — and
        // the ONE case that does collide, the same customer credited twice from
        // one credit row, is a real double credit that J should report. The key
        // is chosen so J stays quiet on the honest case and loud on the other.
        //
        // bonus_points stays 0 deliberately. The points half is already a row in
        // retail_points_transactions and check E sums that; recording the same
        // points here as well would be inert against every current check and a
        // second record of one event with nothing tying the two together. The
        // count rides in the payload instead, where it explains without counting.
        tdb().prepare(
          `INSERT INTO retail_topup_transactions
             (customer_id, amount, bonus_points, payment_method, status, paid_at, out_trade_no, raw_callback_json)
           VALUES (?, ?, 0, 'migration', 'success', CURRENT_TIMESTAMP, ?, ?)`
        ).run(
          customerId, credit.balance, `migration:${credit.id}:${customerId}`,
          JSON.stringify({
            migration_credit_id: credit.id,
            source_uid: credit.source_uid || null,
            points: credit.points || 0,
          })
        );
      }
      if (credit.points && credit.points > 0) {
        tdb().prepare('UPDATE retail_customers SET points_balance = COALESCE(points_balance, 0) + ? WHERE id = ?')
          .run(credit.points, customerId);
        const after = tdb().prepare('SELECT points_balance FROM retail_customers WHERE id = ?')
          .get(customerId).points_balance;
        // expires_at NULL → migrated points are grandfathered (never auto-swept),
        // matching how legacy NULL-expiry earn rows are treated.
        tdb().prepare(
          `INSERT INTO retail_points_transactions
             (customer_id, delta, balance_after, source, note, expires_at)
           VALUES (?, ?, ?, 'migration', ?, NULL)`
        ).run(customerId, credit.points, after, `Migrated from OUT1N (uid ${credit.source_uid || '?'})`);
      }
      return credit;
    })();
    if (applied) {
      console.log(`[migration] claimed credit for customer ${customerId} phone ${phone}: +¥${credit.balance} +${credit.points}pts`);
    }
    return applied;
  } catch (e) {
    console.error('[claimMigrationCredit]', e.message);
    return null;
  }
}

module.exports = { grantSignupVouchers, reconcileSignupVouchers, normalizeMigrationPhone, claimMigrationCredit };
