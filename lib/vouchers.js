// Vouchers: what a voucher takes off an order, who may use it and where, the
// per-customer cap, the best auto-apply promo for a cart, and the counter's own
// vouchers (found by phone, priced, and counted against a sale). Moved out of
// routes/retail.js unchanged (decisions §477). The till, the checkout and the
// QR menu (routes/shop-menu.js, through routes/retail.js) all price a voucher
// with this one copy, so they cannot give two answers about the same voucher.
'use strict';

const { tdb } = require('./tenant-db');
const phoneCn = require('./phone-cn');

// Compute the discount a voucher would apply given the subtotal +
// shipping fee. Returns { discount, free_shipping, applied }.
//
// `couponableSubtotal` (defaults to the full subtotal) is the slice of the
// order the discount is actually allowed to reduce — it equals `subtotal`
// minus the line totals of any items excluded from coupons (e.g. products on
// an active flash sale flagged no_coupon_on_flash). The min-spend gate still
// reads the FULL subtotal (the customer genuinely spent it), but the ¥/%
// discount is computed off the couponable slice so a sitewide coupon can't
// pile onto a deep flash price the operator ring-fenced.
function computeVoucherDiscount(voucher, subtotal, shippingFee, couponableSubtotal = subtotal) {
  if (!voucher || !voucher.is_active) return { discount: 0, free_shipping: false, applied: false };
  if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) return { discount: 0, free_shipping: false, applied: false };
  if (voucher.max_uses != null && voucher.used_count >= voucher.max_uses) return { discount: 0, free_shipping: false, applied: false };
  if (Number(subtotal) < Number(voucher.min_subtotal || 0)) return { discount: 0, free_shipping: false, applied: false };
  const couponable = Math.max(0, Number(couponableSubtotal ?? subtotal) || 0);
  if (voucher.type === 'fixed_amount') {
    return { discount: Math.min(Number(voucher.value || 0), couponable), free_shipping: false, applied: true };
  }
  if (voucher.type === 'percent') {
    const pct = Math.max(0, Math.min(100, Number(voucher.value || 0)));
    return { discount: +(couponable * pct / 100).toFixed(2), free_shipping: false, applied: true };
  }
  if (voucher.type === 'free_shipping') {
    return { discount: 0, free_shipping: true, applied: true };
  }
  return { discount: 0, free_shipping: false, applied: false };
}

// A personal grant is normally ONE-SHOT: checkout stamps used_at and the coupon
// leaves the customer's wallet for good. That's right for a gift ("¥20 off, once")
// but it made a standing per-customer discount impossible — hand someone "8% off"
// and they'd get it on exactly one order, with no way to re-issue it (all three
// grant INSERTs are INSERT OR IGNORE against a UNIQUE(customer_id, voucher_id),
// so a spent row permanently blocks a re-grant).
//
// So when the coupon lets a customer redeem more than once (per_customer_limit
// 0 = no limit, or > 1) the grant STAYS in their wallet and per_customer_limit
// alone does the counting — off order history, which is the honest source since
// it drops cancelled orders. per_customer_limit = 1, the schema default and what
// nearly every existing coupon carries, keeps the old burn-on-use behaviour.
function voucherGrantIsStanding(v) {
  return !!v && Number(v.per_customer_limit || 0) !== 1;
}
// SQL twin of voucherGrantIsStanding, for queries that filter grants directly.
const SQL_GRANT_IS_STANDING = 'COALESCE(v.per_customer_limit, 0) <> 1';

// Does this customer hold a personal grant that's still good? One-shot coupons
// need an UNUSED grant row; a standing coupon accepts any grant row it issued —
// the per-customer cap is enforced separately by every caller.
function customerHoldsVoucher(customerId, v) {
  if (!customerId || !v) return false;
  return !!tdb().prepare(
    voucherGrantIsStanding(v)
      ? 'SELECT 1 FROM retail_customer_vouchers WHERE customer_id = ? AND voucher_id = ? LIMIT 1'
      : `SELECT 1 FROM retail_customer_vouchers
          WHERE customer_id = ? AND voucher_id = ? AND used_at IS NULL LIMIT 1`
  ).get(customerId, v.id);
}

// ── §426 · WHERE a voucher may apply ─────────────────────────────────────
// A voucher with a location (retail_vouchers.store_id) is an IN-PERSON discount
// at that location and nothing else. `place` describes the order being priced:
//   null / undefined                           an online order the caller did
//                                              not describe — every delivery,
//                                              and every client that predates
//                                              located vouchers;
//   { storeId, inPerson: true }                a mini-app pickup at storeId;
//   { storeId, inPerson: true, counter: true } a till sale or QR order there.
// A voucher with NO location keeps its old reach exactly: online, and still not
// at the counter — opening every existing coupon to the till was not decided.
// A delivery sent from the located store does NOT qualify: the test is how the
// customer receives the goods, never retail_orders.store_id.
function voucherPlaceOk(v, place) {
  if (!v) return false;
  if (v.store_id == null) return !(place && place.counter);
  return !!(place && place.inPerson && Number(place.storeId) === Number(v.store_id));
}

// A mini-app pickup, as a place. Anything that is not a positive id is "not
// described", which is the online answer.
function pickupPlaceFrom(raw) {
  const id = parseInt(raw, 10);
  return id > 0 ? { storeId: id, inPerson: true } : null;
}

// The counter's vouchers: the ones these customers HOLD (a personal grant)
// that are located at this store and still good. Percent and amount-off only —
// free shipping means nothing at a counter. Returns [{ voucher, customerId }].
// Several customer ids because one phone can sit on more than one account
// (mini app and web); the till passes the one it attached.
function counterVouchersFor(customerIds, storeId) {
  const ids = (customerIds || []).map(Number).filter(n => n > 0);
  if (!ids.length || !storeId) return [];
  const rows = tdb().prepare(
    `SELECT v.*, g.customer_id AS _holder, g.used_at AS _used_at
       FROM retail_customer_vouchers g
       JOIN retail_vouchers v ON v.id = g.voucher_id
      WHERE g.customer_id IN (${ids.map(() => '?').join(',')})
        AND v.store_id = ? AND v.is_active = 1
        AND v.type IN ('percent', 'fixed_amount')
        AND (v.expires_at IS NULL OR datetime(v.expires_at) > CURRENT_TIMESTAMP)
        AND (v.max_uses IS NULL OR v.used_count < v.max_uses)
      ORDER BY v.id`
  ).all(...ids, Number(storeId));
  const out = [];
  for (const r of rows) {
    const { _holder, _used_at, ...v } = r;
    if (!voucherGrantIsStanding(v) && _used_at) continue;   // a spent one-shot
    if (voucherCapReached(_holder, v)) continue;
    out.push({ voucher: v, customerId: _holder });
  }
  return out;
}

// The best of those for this subtotal. Same "best one wins" as the checkout.
// Returns { voucher, customerId, discount } or null.
function bestCounterVoucher(customerIds, storeId, subtotal) {
  let best = null;
  for (const c of counterVouchersFor(customerIds, storeId)) {
    const r = computeVoucherDiscount(c.voucher, subtotal, 0, subtotal);
    if (!r.applied || !(r.discount > 0)) continue;
    if (!best || r.discount > best.discount) best = { ...c, discount: Number(r.discount) || 0 };
  }
  return best;
}

// Count a counter voucher's use against an order, inside the caller's
// transaction (`h`). The same two writes the checkout makes: the pool, bumped
// only while it has room, and a one-shot grant stamped spent. A standing grant
// stays in the wallet. Throws code 'voucher_exhausted' when the pool ran dry
// between the read and the write. reverseOrderVoucher undoes both.
function consumeCounterVoucher(h, cv, orderId) {
  const bump = h.prepare(
    `UPDATE retail_vouchers SET used_count = used_count + 1
      WHERE id = ? AND (max_uses IS NULL OR used_count < max_uses)`
  ).run(cv.voucher.id);
  if (bump.changes !== 1) {
    const err = new Error('voucher_exhausted');
    err.code = 'voucher_exhausted';
    throw err;
  }
  if (!voucherGrantIsStanding(cv.voucher)) {
    h.prepare(
      `UPDATE retail_customer_vouchers SET used_at = CURRENT_TIMESTAMP, used_order_id = ?
        WHERE customer_id = ? AND voucher_id = ? AND used_at IS NULL`
    ).run(orderId, cv.customerId, cv.voucher.id);
  }
}

// §428 — the vouchers limited to THIS store that this customer could be given
// at its counter: active, unexpired, pool not drained, percent or amount off.
// Held ones are left out unless asked for (the give route accepts a voucher the
// customer already holds, as a no-op). The till offers exactly this list, and
// the give route checks against exactly this list — one rule, one place.
function counterGivable(customerId, storeId, { includeHeld = false } = {}) {
  if (!(Number(storeId) > 0)) return [];
  return tdb().prepare(
    `SELECT v.* FROM retail_vouchers v
      WHERE v.store_id = ? AND v.is_active = 1
        AND v.type IN ('percent', 'fixed_amount')
        AND (v.expires_at IS NULL OR datetime(v.expires_at) > CURRENT_TIMESTAMP)
        AND (v.max_uses IS NULL OR v.used_count < v.max_uses)
        ${includeHeld ? '' : `AND NOT EXISTS (SELECT 1 FROM retail_customer_vouchers g
                                              WHERE g.voucher_id = v.id AND g.customer_id = ?)`}
      ORDER BY v.id`
  ).all(...(includeHeld ? [Number(storeId)] : [Number(storeId), Number(customerId)]));
}

// What a screen is told about a counter voucher: enough to show the line and
// work out the figure, and NOT the code — the QR menu is public, and a private
// code is a thing that can be typed somewhere else.
function counterVoucherTerms(v) {
  return {
    id: v.id, type: v.type, value: Number(v.value) || 0,
    min_subtotal: Number(v.min_subtotal) || 0,
    title_en: v.title_en || null, title_cn: v.title_cn || null,
  };
}

// The customers holding a voucher at this store whose phone is this number.
// Compared in phone-cn's canonical form, so '+86 138…', '138 …' and '138…'
// are the same number. Read off the holders, not off every customer: the set
// is the people somebody chose to give a located voucher to, which is small.
// A blocked account is never found.
function counterHoldersByPhone(phone, storeId) {
  const want = phoneCn.normalize(phone);
  if (!want || want.replace(/\D/g, '').length < 7 || !storeId) return [];
  return tdb().prepare(
    `SELECT DISTINCT c.id, c.phone
       FROM retail_customer_vouchers g
       JOIN retail_vouchers v  ON v.id = g.voucher_id
       JOIN retail_customers c ON c.id = g.customer_id
      WHERE v.store_id = ? AND v.is_active = 1
        AND c.phone IS NOT NULL AND c.phone <> ''
        AND COALESCE(c.is_blocked, 0) = 0`
  ).all(Number(storeId))
    .filter(c => phoneCn.normalize(c.phone) === want)
    .map(c => c.id);
}

// How many times this customer has already redeemed a code, off order history
// (cancelled orders don't count — cancelling hands the use back).
function voucherRedemptionsBy(customerId, code) {
  return tdb().prepare(
    `SELECT COUNT(*) AS n FROM retail_orders
      WHERE customer_id = ? AND voucher_code = ? AND status NOT IN ('cancelled')`
  ).get(customerId, code).n;
}
// Has this customer hit the coupon's per-customer ceiling? limit 0/null = none.
function voucherCapReached(customerId, v) {
  if (!customerId || !v.per_customer_limit || v.per_customer_limit <= 0) return false;
  return voucherRedemptionsBy(customerId, v.code) >= v.per_customer_limit;
}

// Pick the single best auto-apply voucher for this customer + cart. Auto-apply
// means "no code, no tap" — it does NOT mean store-wide. The coupon's own
// audience decides who it reaches: a public promo applies to everyone, a PRIVATE
// one only to the customers it was handed to. We still honour expiry / usage
// pool / min-subtotal / per-customer cap. A free-shipping voucher is valued at
// the live shipping fee so it can be compared like-for-like against a ¥/%
// discount. Returns { voucher, discount, free_shipping } or null.
//
// Signup vouchers used to be excluded here outright (auto_grant_signup = 0), so
// a welcome coupon with "Apply it for them" switched ON silently never applied —
// the admin toggle was dead and the customer had to find and tap the coupon. The
// exclusion existed to stop a returning/migrated customer silently redeeming one,
// but the GRANT already enforces exactly that: reconcileSignupVouchers withholds
// (and revokes) the grant for any returning OUT1N phone, and the audience gate
// below requires a held grant for every signup voucher — public or not, matching
// the code-entry gate at order time. So honour the flag and let it apply itself.
function bestAutoVoucher(customerId, subtotal, shippingFee, couponableSubtotal = subtotal, place = null) {
  const rows = tdb().prepare(
    `SELECT * FROM retail_vouchers
      WHERE is_active = 1 AND auto_apply = 1
        AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
        AND (max_uses IS NULL OR used_count < max_uses)`
  ).all();
  let best = null, bestValue = 0;
  for (const v of rows) {
    // Audience gate. A private coupon auto-applies ONLY for the customers it was
    // handed to. Without this the auto_apply flag was read on its own — blind to
    // is_public and to who actually held the coupon — so a private coupon granted
    // to nobody still discounted every checkout in the store. A signup voucher is
    // grant-gated even when public (same rule as the checkout code path), so a
    // customer who was never granted one — or had it revoked as returning — can
    // never have it applied for them.
    if ((!v.is_public || v.auto_grant_signup) && !customerHoldsVoucher(customerId, v)) continue;
    // §426 — a located voucher only where the caller says the order is there.
    if (!voucherPlaceOk(v, place)) continue;
    if (voucherCapReached(customerId, v)) continue;
    const r = computeVoucherDiscount(v, subtotal, shippingFee, couponableSubtotal);
    if (!r.applied) continue;
    const value = (Number(r.discount) || 0) + (r.free_shipping ? (Number(shippingFee) || 0) : 0);
    if (value > bestValue) {
      best = { voucher: v, discount: Number(r.discount) || 0, free_shipping: !!r.free_shipping };
      bestValue = value;
    }
  }
  return best;
}

// The best auto-apply promo the customer is JUST short of unlocking — active,
// in-pool, within the per-customer cap, but blocked solely by an unmet spend
// threshold (subtotal < min_subtotal). Used to show a "locked" coupon at
// checkout so the customer sees the reward for adding a little more to the cart.
// Ranked by smallest shortfall (closest to unlocking wins). Display only.
function nearMissAutoVoucher(customerId, subtotal, couponableSubtotal = subtotal, place = null) {
  const rows = tdb().prepare(
    `SELECT * FROM retail_vouchers
      WHERE is_active = 1 AND auto_apply = 1
        AND min_subtotal > 0 AND ? < min_subtotal
        AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
        AND (max_uses IS NULL OR used_count < max_uses)`
  ).all(subtotal);
  let best = null, bestGap = Infinity;
  for (const v of rows) {
    // Same audience gate as bestAutoVoucher — never tease a private or signup
    // coupon to a customer who doesn't hold it (that would leak both its
    // existence and its code).
    if ((!v.is_public || v.auto_grant_signup) && !customerHoldsVoucher(customerId, v)) continue;
    if (!voucherPlaceOk(v, place)) continue;
    if (voucherCapReached(customerId, v)) continue;
    const gap = Number(v.min_subtotal) - Number(subtotal);
    if (gap > 0 && gap < bestGap) {
      // Value the promo AT its threshold so the teaser figure is honest even
      // though the cart hasn't reached it yet.
      const r = computeVoucherDiscount(v, v.min_subtotal, 0,
        Math.max(Number(couponableSubtotal) || 0, Number(v.min_subtotal) || 0));
      best = {
        voucher: v,
        shortfall: +gap.toFixed(2),
        wouldDiscount: Number(r.discount) || 0,
        wouldFreeShipping: !!r.free_shipping,
      };
      bestGap = gap;
    }
  }
  return best;
}

module.exports = {
  computeVoucherDiscount, voucherGrantIsStanding, SQL_GRANT_IS_STANDING,
  customerHoldsVoucher, voucherPlaceOk, pickupPlaceFrom,
  counterVouchersFor, bestCounterVoucher, consumeCounterVoucher, counterGivable,
  counterVoucherTerms, counterHoldersByPhone,
  voucherRedemptionsBy, voucherCapReached, bestAutoVoucher, nearMissAutoVoucher,
};
