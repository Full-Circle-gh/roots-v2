// Customer basics shared across the retail code: the email clean-up, how a
// customer is shown to the app, who recorded a voucher grant, the
// manual-customer creator, and the account a customer-history row is written
// under. Moved out of routes/retail.js unchanged (decisions §477).
'use strict';

const crypto = require('crypto');
const { tdb, currentTenantId, ROOTS_TENANT_ID } = require('./tenant-db');
const { SQL_GRANT_IS_STANDING } = require('./vouchers');
const { pointsRedeemRate } = require('./loyalty');

function normEmail(e) {
  e = String(e || '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : '';
}

// Strip internal/admin-only fields before returning a customer to the app.
function publicCustomer(c) {
  if (!c) return null;
  // coupon_count is computed LIVE from the customer's granted vouchers — the
  // old retail_customers.coupon_count column was never maintained (claims,
  // signup grants and redemptions all wrote retail_customer_vouchers without
  // touching it), so it always read 0. Mirror the /api/retail/my-vouchers
  // "active" definition exactly: unused, voucher still active + not expired +
  // not maxed-out — so "N active" on the Me page matches the Coupons list.
  let couponCount = 0;
  try {
    couponCount = tdb().prepare(
      `SELECT COUNT(*) AS n
         FROM retail_customer_vouchers g
         JOIN retail_vouchers v ON v.id = g.voucher_id
        WHERE g.customer_id = ?
          AND (g.used_at IS NULL OR ${SQL_GRANT_IS_STANDING})
          AND v.is_active = 1
          AND (v.expires_at IS NULL OR datetime(v.expires_at) > CURRENT_TIMESTAMP)
          AND (v.max_uses IS NULL OR v.used_count < v.max_uses)
          AND (COALESCE(v.per_customer_limit, 0) <= 0
               OR (SELECT COUNT(*) FROM retail_orders o
                    WHERE o.customer_id = g.customer_id AND o.voucher_code = v.code
                      AND o.status NOT IN ('cancelled')) < v.per_customer_limit)`
    ).get(c.id).n;
  } catch (e) { console.warn('[publicCustomer coupon_count]', e.message); }
  return {
    id: c.id,
    nickname: c.nickname,
    avatar_url: c.avatar_url,
    phone: c.phone,
    tier_key: c.tier_key,
    lifetime_spend: c.lifetime_spend,
    points_balance: c.points_balance,
    // point_value_yuan (= 1 / points.redeemRate) lets every screen that shows
    // this customer object (greeting block, Me page…) value points at the
    // store's REAL redeem rate instead of a hardcoded ¥0.01. Without it the
    // home greeting showed "2 pts · ¥0.02" even after Roots flipped to 1pt=¥1.
    point_value_yuan: 1 / pointsRedeemRate(),
    coupon_count: couponCount,
    balance: c.balance,
    created_at: c.created_at,
  };
}

// §428 — retail_customer_vouchers.granted_by has a FK to users(id): a KITCHEN
// user. A Mini App Backend operator's req.user.id is a tenant_users id, which
// is not in users, so writing it tripped "FOREIGN KEY constraint failed" and
// every grant an operator made answered 500 — the same trap voucher create
// already steps around (see its createdBy). NULL for operators; the person is
// named in granted_by_name instead, which is what the holder list reads.
function grantedById(req) {
  return req && req.backendUser ? null : ((req && req.user && req.user.id) || null);
}

// §428 — the name a grant is recorded under: the operator's display name, else
// their username. Never empty for a person; null only when no one is signed in.
function grantedByName(req) {
  const u = (req && (req.backendUser || req.user)) || null;
  if (!u) return null;
  return String(u.display_name || u.username || '').slice(0, 80) || null;
}

// The create-or-reuse itself, lifted out of the handler 2026-07-31 so the
// ORDER-create path can run it inside its own transaction.
//
// Why it had to move: the old New-order modal POSTed this endpoint and then
// POSTed the order. A failure between the two — an unavailable product, a bad
// phone, a store that no longer resolves, a dropped connection — left a customer
// nobody asked for, indistinguishable from a deliberate creation. And the row
// was not the whole cost: create runs claimMigrationCredit and
// reconcileSignupVouchers, so a failed order could move real balance and points
// and grant vouchers onto it.
//
// ONE implementation, two callers, deliberately: this function's reuse query is
// the same `phone = ?` equality the by-phone warning reads, so what the form
// warns, what the order attaches to, and what the Customers page shows can never
// disagree. A second copy inside the order handler would be a mirror, and a
// mirror that has drifted is worse than none.
//
// It does NOT run the post-create hooks. They are best-effort, they touch money,
// and they must run only once the caller's transaction has COMMITTED — the same
// shape markOrderPaid() already has in the order handler. `created` tells the
// caller whether it owes them.
//
// Returns { id, reused, created } or { error } — it never throws for a validation
// problem, so a caller inside a transaction chooses whether to roll back.
//
// TAKES THE HANDLE (Path A step 2, decisions §24). The trailing `h = tdb()` is a
// DEFAULT PARAMETER, evaluated on every call that omits it, so a caller that
// passes nothing still binds to the request's tenant connection at call time —
// exactly as the ambient tdb() calls it replaces did. That is what lets the
// other call site, POST /api/retail-admin/customers, stay unedited and
// synchronous while POST /api/retail-admin/orders passes its transaction handle.
//
// IT STAYS SYNCHRONOUS. Taking a handle is not going async, so §24's rule that a
// helper may go async only when every caller is async does not bind here — and
// must not be read as satisfied by this change. Its READS matter as much as its
// writes: the reuse-by-phone SELECT has to see rows the caller's open
// transaction has written but not yet committed, and on the wrong handle it
// would miss them and create a duplicate customer instead of reusing one.
function createOrReuseManualCustomer({ nickname, email, phone, userId }, h = tdb()) {
  const nick = nickname == null ? '' : String(nickname).trim().slice(0, 60);
  const mail = normEmail(email);
  const tel  = phone == null ? '' : String(phone).replace(/\s+/g, '').slice(0, 20);

  if (tel && !/^\+?[0-9]{7,15}$/.test(tel)) return { error: 'bad_phone' };
  if (email && !mail) return { error: 'bad_email' };
  // Need at least one way to identify the person — a phone or a name.
  if (!tel && !nick) return { error: 'name_or_phone_required' };

  // Reuse-by-phone — link to the existing record rather than duplicate it.
  // No is_blocked filter, matching the by-phone lookup: a blocked customer still
  // owns the number, and the form has already said so in Brick.
  if (tel) {
    const existing = h.prepare(
      'SELECT id FROM retail_customers WHERE phone = ? ORDER BY id LIMIT 1'
    ).get(tel);
    if (existing) {
      // Backfill only blanks — never overwrite what the customer set themselves.
      h.prepare(
        `UPDATE retail_customers
            SET nickname = COALESCE(NULLIF(nickname, ''), ?),
                email    = COALESCE(NULLIF(email, ''), ?)
          WHERE id = ?`
      ).run(nick || null, mail || null, existing.id);
      return { id: existing.id, reused: true, created: false };
    }
  }

  const synthetic = 'manual:' + crypto.randomBytes(12).toString('hex');
  const info = h.prepare(
    `INSERT INTO retail_customers (openid, nickname, phone, email, source, created_by, last_login_at)
     VALUES (?, ?, ?, ?, 'manual', ?, NULL)`
  ).run(synthetic, nick || null, tel || null, mail || null, userId);
  return { id: info.lastInsertRowid, reused: false, created: true };
}

function historyTenantId() {
  try { return currentTenantId() || ROOTS_TENANT_ID; } catch (e) { return ROOTS_TENANT_ID; }
}

module.exports = {
  normEmail, publicCustomer, grantedById, grantedByName, createOrReuseManualCustomer, historyTenantId,
};
