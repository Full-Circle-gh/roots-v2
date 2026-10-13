// Loyalty: points (earn, expiry, redeem, award and reverse on an order) and
// the Roots Club tier ladder that sets the earn multiplier. Moved out of
// routes/retail.js unchanged (decisions §477). Awarding points reads the
// customer's tier, so the two travel together. The tier-ladder cache lives
// here, so there is still exactly one.
'use strict';

const { tdb } = require('./tenant-db');
const money = require('./money');
const { sendOpsAlert } = require('./ops-alert');
const { cfgValue } = require('./store-config');

// Roots Club tier ladder. Editable in /retail-admin → Points/Loyalty; persisted
// in storefront_config under `roots_club.tiers`. The mini-app reads the same
// blob off /api/retail/config, so backend + frontend never drift. These defaults
// seed the editor on a fresh install and are the fallback if the config row is
// missing or malformed. tier_key is auto-derived from lifetime_spend on every
// award/reverse + self-healed in requireRetailAuth (no manual override).
// The thresholds and multipliers below mirror the live stored ladder, so a
// missing config row cannot silently move every customer onto a different
// ladder. The perks copy is the product's own placeholder, not Roots' — it is
// deliberately NOT mirrored.
const DEFAULT_ROOTS_CLUB_TIERS = [
  {
    key: 'seed',   name_en: 'Seed',    name_cn: '种子',
    color: 'corn',   threshold: 0, points_mult: 1.0,
    perks_en: ['5% off your first order', 'Member newsletter'],
    perks_cn: ['首单 5% 折扣', '会员通讯'],
  },
  {
    key: 'sprout', name_en: 'Sprout',  name_cn: '幼苗',
    color: 'pea',    threshold: 4000, points_mult: 1.1,
    perks_en: ['10% off all orders', 'Early access to drops', 'Free shipping ¥299+'],
    perks_cn: ['全场 10% 折扣', '新品优先购', '满 ¥299 包邮'],
  },
  {
    key: 'root',   name_en: 'Root',    name_cn: '根',
    color: 'forest', threshold: 6000, points_mult: 1.2,
    perks_en: ['15% off all orders', 'Early access to drops', 'Free shipping ¥199+', 'Birthday gift'],
    perks_cn: ['全场 15% 折扣', '新品优先购', '满 ¥199 包邮', '生日礼物'],
  },
  {
    key: 'tree',   name_en: 'Tree',    name_cn: '大树',
    color: 'ink',    threshold: 10000, points_mult: 1.3,
    perks_en: ['20% off all orders', 'Early access to drops', 'Free shipping (no minimum)', 'Birthday gift', 'Exclusive tasting events'],
    perks_cn: ['全场 20% 折扣', '新品优先购', '免邮 (无门槛)', '生日礼物', '专属品鉴活动'],
  },
];

// Look up the points-earn multiplier for a customer's tier. Falls back to 1.0
// (no boost) on unknown keys / malformed config rows. Clamped to [0.1, 10] so
// an editor typo can't zero out earns or blow up the math.
function tierMultiplierFor(tierKey) {
  if (!tierKey) return 1;
  const ladder = loadTierLadder();
  const t = ladder.find(x => x.key === tierKey);
  if (!t) return 1;
  const m = Number(t.points_mult);
  if (!Number.isFinite(m) || m <= 0) return 1;
  return Math.max(0.1, Math.min(10, m));
}
// Cheap in-memory cache so we don't hit storefront_config + reparse on every
// authenticated request. Invalidated by storefront_config.updated_at — any
// admin save bumps the timestamp via the same UPSERT path.
let _tierLadderCache = null;
let _tierLadderVer = -1;
function loadTierLadder() {
  let ver = 0;
  try {
    const t = tdb().prepare("SELECT COALESCE(strftime('%s', updated_at), '0') AS t FROM storefront_config WHERE key = 'roots_club.tiers'").get();
    ver = Number(t?.t || 0);
  } catch {}
  if (_tierLadderCache && ver === _tierLadderVer) return _tierLadderCache;
  let ladder = null;
  try {
    const row = tdb().prepare("SELECT value_json FROM storefront_config WHERE key = 'roots_club.tiers'").get();
    if (row && row.value_json) {
      const parsed = JSON.parse(row.value_json);
      if (Array.isArray(parsed) && parsed.length && parsed.every(t => t && typeof t.key === 'string' && Number.isFinite(Number(t.threshold)))) {
        ladder = parsed;
      }
    }
  } catch {}
  _tierLadderCache = (ladder && ladder.length) ? ladder : DEFAULT_ROOTS_CLUB_TIERS;
  _tierLadderVer = ver;
  return _tierLadderCache;
}
function tierFromSpend(spend) {
  const s = Math.max(0, Number(spend) || 0);
  // Walk the ladder in ascending-threshold order so out-of-order config rows
  // (operator edits) still derive correctly. Lowest tier is the baseline.
  const sorted = loadTierLadder().slice().sort((a, b) => (Number(a.threshold) || 0) - (Number(b.threshold) || 0));
  let tier = sorted[0]?.key || 'seed';
  for (const t of sorted) {
    if (s >= (Number(t.threshold) || 0)) tier = t.key;
  }
  return tier;
}
// Idempotent — only writes when the stored tier differs from the derived one.
// Returns the derived tier (post-reconcile), so callers can use it directly.
//
// THE CATCH IS DELIBERATE AND STAYS NON-FATAL. Three of the four call sites are
// inside a money transaction, and letting this throw would roll that whole
// transaction back with nothing anywhere to retry it:
//
//   * awardOrderPoints    — the order's points AND its lifetime_spend are lost.
//     The `order_earn` row is the idempotency marker and it is written AFTER
//     this call, so nothing re-attempts the award. The customer is permanently
//     short, and the understated lifetime_spend then makes the self-heal below
//     compute and persist the WRONG tier — a permanent wrong answer replacing a
//     temporary one.
//   * reverseOrderPoints  — a refund's points reversal and spend reduction never
//     happen; the customer keeps points from an order they were refunded for.
//   * finalizeOrderAddon  — worst of the three: the add-on's item injection and
//     its `retail_payments` row are in the same transaction, so the customer
//     pays for an add-on and does not receive it.
//
// Against that, a stale tier_key is cosmetic. Its only functional effect is the
// points-earn multiplier on FUTURE orders; the tier perks are display copy and
// are enforced nowhere in pricing or shipping. And it self-heals — requireRetailAuth
// calls this again on every authenticated request, against the committed
// lifetime_spend. Permanent silent loss is worse than self-healing staleness.
//
// WHAT CHANGED 2026-08-11, AND IT IS NOT A LOG LEVEL. The old line was
// `console.warn('[reconcileTier]', e.message)`, which named NO customer. A
// failure you cannot attribute is a failure you cannot repair — that was the
// defect that mattered, not the severity of the word "warn".
//
// ORDER INSIDE THE CATCH IS LOAD-BEARING: log first, alert second. The log is
// the durable record on local disk; the alert is best-effort delivery over a
// network to a WeCom group. The unreliable one never runs before the reliable
// one, and it can neither mask nor replace it.
function reconcileTier(customerId, spend, storedTier) {
  const want = tierFromSpend(spend);
  if (want !== storedTier) {
    try {
      tdb().prepare('UPDATE retail_customers SET tier_key = ? WHERE id = ?').run(want, customerId);
    } catch (e) {
      // 1. DURABLE AND ATTRIBUTABLE, FIRST. Names the customer and both tiers,
      //    so an occurrence can be repaired rather than merely noticed.
      console.error(`[reconcileTier] customer=${customerId} want=${want} stored=${storedTier} failed: ${e.message}`);
      // 2. BEST-EFFORT DELIVERY, SECOND.
      //
      //    THE ALERT TEXT IS DELIBERATELY CUSTOMER-FREE, and that is a flood
      //    guard rather than an oversight. sendOpsAlert de-duplicates on EXACT
      //    message text for 60s; a per-customer message would defeat that dedup
      //    completely, and this runs on every authenticated request via
      //    requireRetailAuth — so a broken column would page the group once per
      //    request, and grow ops-alert's `lastSent` map without bound. Coarse
      //    text collapses to one alert per minute and one map key. The log
      //    names the victims; the alert only says to go and read it.
      //
      //    Wrapped both ways on the file's existing idiom (see
      //    maybeFlagUncallablePhone): the try/catch takes a synchronous throw,
      //    the .catch takes a rejected promise. Either way the console.error
      //    above has already happened and `want` is still returned.
      try {
        Promise.resolve(sendOpsAlert(
          // Names the FEATURE, not the first merchant's version of it — this is
          // shared code that fires for any account (audit D-04, same class).
          // Stays on sendOpsAlert: it points at a server log, which is the
          // platform's to read.
          '⚠️ 会员等级写入失败 — 积分与消费额记录正常，仅等级暂时未更新，会员下次登录时会自动修正。\n'
          + '受影响的会员 ID 见 roots-v2 错误日志中的 [reconcileTier] 行。\n'
          + 'Tacet: the membership tier UPDATE is failing. Points and lifetime spend are still recorded correctly; '
          + 'only tier_key is stale, and it self-heals at the next customer sign-in. '
          + 'Affected customer ids are on the [reconcileTier] lines in roots-v2-error.log.'
        )).catch(err => console.warn('[reconcileTier] ops alert failed:', err && err.message));
      } catch (err) {
        console.warn('[reconcileTier] ops alert failed:', err && err.message);
      }
    }
  }
  return want;
}

// Earn rule: admin configures "earn N points per ¥M spent" via the two
// config keys points.earnPoints and points.earnSpend (default 1 per ¥100).
// Legacy single-sided points.earnRate (= yuan per point) is still read as
// a fallback so old databases keep working until the backfill migration
// stamps the new pair.
function pointsEarnedFor(subtotal, tierMult = 1) {
  const pts   = Number(cfgValue('points.earnPoints', 1));
  const spend = Number(cfgValue('points.earnSpend', null));
  // Fall back to the legacy key on databases that haven't been migrated yet.
  const denom = spend > 0 ? spend : Number(cfgValue('points.earnRate', 100));
  if (!(pts > 0) || !(denom > 0)) return 0;
  // tierMult comes from tierMultiplierFor(customer.tier_key); callers that
  // don't know the tier (anonymous quote, fallback paths) pass the default 1.
  // We floor once at the end so 1.5× on a sub-threshold subtotal still rounds
  // toward zero — matches the historical no-multiplier behaviour for Seed.
  const m = Number.isFinite(tierMult) && tierMult > 0 ? tierMult : 1;
  return Math.floor((Number(subtotal || 0) * pts * m) / denom);
}

// Which monetary amount earns points, set by `points.earnBase`:
//   'paid'     → the net total the customer actually paid, after voucher AND
//                points discounts (the default — points track real spend).
//   'subtotal' → the goods value BEFORE any discount (the legacy behaviour;
//                more generous, rewards order size rather than net spend).
// Absent key defaults to 'paid'. Callers pass the order's stored subtotal and
// total; the result feeds pointsEarnedFor() as the earn base.
function pointsEarnBaseAmount(subtotal, total) {
  const mode = String(cfgValue('points.earnBase', 'paid'));
  const base = mode === 'subtotal' ? subtotal : total;
  return Math.max(0, Number(base) || 0);
}

// SQLite ISO datetime N months from now, or NULL if expiry disabled. Used
// to stamp expires_at on new earn rows at insert time so each batch knows
// its own TTL (admin can change the global later without affecting old rows).
function nextEarnExpiry() {
  const months = Number(cfgValue('points.expiryMonths', 12));
  if (!(months > 0)) return null;
  // SQLite computes the date — pass as ISO string to keep TZ consistent
  // with CURRENT_TIMESTAMP (UTC).
  const row = tdb().prepare(`SELECT datetime('now', ?) AS dt`).get(`+${months} months`);
  return row?.dt || null;
}

// Sweep expired earn batches for a single customer. Idempotent: only
// touches rows whose expires_at < now AND have not yet been swept
// (expired_at IS NULL). Writes a negative 'expiry' ledger row per batch
// and rebases points_balance to match. Cheap enough to call inline before
// any balance-affecting operation (award / redeem / customer read).
function sweepExpiredPoints(customerId) {
  if (!customerId) return 0;
  const due = tdb().prepare(
    `SELECT id, delta, expires_at FROM retail_points_transactions
      WHERE customer_id = ?
        AND delta > 0
        AND expires_at IS NOT NULL
        AND expired_at IS NULL
        AND datetime(expires_at) <= datetime('now')`
  ).all(customerId);
  if (!due.length) return 0;
  // Mark the original earn rows as swept so we don't re-process them.
  const markSwept = tdb().prepare(
    `UPDATE retail_points_transactions SET expired_at = CURRENT_TIMESTAMP WHERE id = ?`
  );
  const insertExpiry = tdb().prepare(
    `INSERT INTO retail_points_transactions
       (customer_id, delta, balance_after, source, note, created_at)
     VALUES (?, ?, ?, 'expiry', ?, CURRENT_TIMESTAMP)`
  );
  let totalExpired = 0;
  const tx = tdb().transaction(() => {
    for (const b of due) {
      // Only deduct what's still on the books — clamp at the current
      // balance so we don't drive it negative for batches the customer
      // already redeemed away (we accept that an already-spent batch
      // expiring is a no-op from the customer's view).
      const cur = tdb().prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(customerId).points_balance;
      const take = Math.min(b.delta, cur);
      if (take > 0) {
        tdb().prepare(
          'UPDATE retail_customers SET points_balance = points_balance - ? WHERE id = ?'
        ).run(take, customerId);
        const after = tdb().prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(customerId).points_balance;
        insertExpiry.run(customerId, -take, after, `Expired batch from ${b.expires_at}`);
        totalExpired += take;
      }
      markSwept.run(b.id);
    }
  });
  try { tx(); } catch (e) { console.error('[sweepExpiredPoints]', e); return 0; }
  return totalExpired;
}

// points.redeemRate = points needed per ¥1 of discount. The fallback mirrors the
// live stored value (1 point = ¥1) so a missing config row cannot silently change
// what a point is worth — a fallback of 100 would make every redemption 1/100th.
function pointsRedeemRate() {
  const r = Number(cfgValue('points.redeemRate', 1));
  return r > 0 ? r : 1;
}
// Cash a customer must put on the table when redeeming N points.
function pointsCashValue(pts) {
  return Math.floor((Number(pts || 0) / pointsRedeemRate()) * 100) / 100;
}
// Points required to fully cover a cash amount (round up — so we never
// under-charge ourselves on the wallet side).
function pointsRequiredFor(cash) {
  return Math.ceil(Number(cash || 0) * pointsRedeemRate());
}
// Store policy: are points allowed to pay the shipping fee? Default OFF —
// points cover product subtotal + packing only; customer always pays
// shipping in cash. Admin can flip this on per store.
function pointsCoverShipping() {
  return !!cfgValue('points.coverShipping', false);
}
// Cash base that points are allowed to redeem against. When shipping is
// excluded by policy, the residual (shipping) is always paid in cash.
/* `taxAdded` is the tax CHARGED ON TOP (audit I-03) — zero on a shop whose
   prices already contain it, and zero on every shop that charges none.

   IT IS INSIDE THE BASE, and that is a decision rather than an oversight.
   Points are a TENDER, not a discount: the audit's own note on orderTenders()
   says the gross a customer pays is `points_amount + balance_used + total`, and
   a tender settles the bill it is offered against — tax included. Shipping is
   excluded only because a shop can say so (pointsCoverShipping), and no such
   switch exists for tax; defaulting to "points may not pay the tax" would be
   inventing one.

   Leaving it out was tried first and is worse than untidy: `payment_method:
   'points'` refuses outright when the redeemable base is short of the gross, so
   every points-only order on a tax-charging shop would have been rejected —
   with `points_cannot_cover_shipping`, naming a fee that was not the problem. */
function pointsRedeemableBase(subtotal, shippingFee, packingFee, voucherDiscount = 0, taxAdded = 0) {
  const ship = pointsCoverShipping() ? Number(shippingFee || 0) : 0;
  return Math.max(0, Number(subtotal || 0) + ship + Number(packingFee || 0)
    - Number(voucherDiscount || 0) + Number(taxAdded || 0));
}

// Award earn-points on payment success. Idempotent — checks the ledger
// for an existing order_earn row for this order before inserting.
function awardOrderPoints(orderId) {
  const o = tdb().prepare(
    'SELECT id, customer_id, subtotal, total, points_earned FROM retail_orders WHERE id = ?'
  ).get(orderId);
  if (!o) return 0;
  // A guest order has nobody to award to. The same guard sweepExpiredPoints
  // carries one line below (:28647) — without it the transaction reads
  // retail_customers WHERE id = NULL, gets undefined back, and throws on
  // `fresh.lifetime_spend`. That throw was caught and logged on every walk-in
  // sale: harmless, but an exception on a normal path is noise that hides the
  // next real one.
  if (!o.customer_id) return 0;
  // Sweep first so the awarded balance is based on a clean (post-expiry) state.
  sweepExpiredPoints(o.customer_id);
  const already = tdb().prepare(
    "SELECT id FROM retail_points_transactions WHERE order_id = ? AND source = 'order_earn'"
  ).get(orderId);
  if (already) return o.points_earned || 0;
  // Use the customer's tier_key at the moment of award. We pulled it directly
  // (not via reconcileTier) — by the time award fires the tier is either
  // already accurate from the previous order or it's about to be reconciled
  // in the same transaction below.
  const c = tdb().prepare('SELECT tier_key FROM retail_customers WHERE id = ?').get(o.customer_id);
  const tierMult = tierMultiplierFor(c?.tier_key);
  // Earn on the configured base (net paid by default; pre-discount subtotal if
  // the operator picked 'subtotal'). lifetime_spend still tracks the goods
  // subtotal so tier progression is unaffected by the earn-base choice.
  const base  = pointsEarnBaseAmount(o.subtotal, o.total);
  const pts   = pointsEarnedFor(base, tierMult);
  const spend = Math.max(0, Number(o.subtotal) || 0);
  const expiresAt = pts > 0 ? nextEarnExpiry() : null;
  // We always insert the order_earn row (even at delta=0) so the row is the
  // single idempotency marker for both points-award AND lifetime_spend bump
  // — otherwise sub-rate orders (subtotal below points.earnRate) would be
  // double-counted on retries.
  const tx = tdb().transaction(() => {
    // The NEW TOTAL, added exactly, rather than `lifetime_spend + ?` in SQL
    // (audit I-02). Inside the transaction, so the read it adds to cannot move
    // between the read and the write.
    const before = tdb().prepare('SELECT COALESCE(lifetime_spend, 0) AS s FROM retail_customers WHERE id = ?').get(o.customer_id);
    tdb().prepare(
      'UPDATE retail_customers SET lifetime_spend = ?, points_balance = points_balance + ? WHERE id = ?'
    ).run(money.addMajor(before ? before.s : 0, spend), pts, o.customer_id);
    const fresh = tdb().prepare('SELECT lifetime_spend, points_balance, tier_key FROM retail_customers WHERE id = ?').get(o.customer_id);
    // Auto-promote tier_key off the new lifetime_spend in the same transaction
    // so leaderboards / admin lists / next reads all agree without waiting on
    // the requireRetailAuth self-heal.
    reconcileTier(o.customer_id, fresh.lifetime_spend, fresh.tier_key);
    const after = fresh.points_balance;
    const note  = pts > 0
      ? `Order ${orderId} earned ${pts} pts`
      : `Order ${orderId} (earn base ¥${base.toFixed(2)}, below earn threshold)`;
    tdb().prepare(
      `INSERT INTO retail_points_transactions
         (customer_id, delta, balance_after, source, order_id, note, expires_at)
       VALUES (?, ?, ?, 'order_earn', ?, ?, ?)`
    ).run(o.customer_id, pts, after, orderId, note, expiresAt);
    tdb().prepare('UPDATE retail_orders SET points_earned = ? WHERE id = ?').run(pts, orderId);
  });
  try { tx(); } catch (e) { console.error('[awardOrderPoints]', e); return 0; }
  return pts;
}

// Reverse earn-points AND lifetime_spend when an order is refunded.
// Best-effort — leaves a refund_reverse marker even if the customer has
// already spent the points (points_balance may briefly go negative).
// The refund_reverse row is the idempotency marker; it is always inserted
// so a sub-rate order (earn delta=0) still gets its spend reversed exactly once.
function reverseOrderPoints(orderId) {
  const earn = tdb().prepare(
    "SELECT customer_id, delta FROM retail_points_transactions WHERE order_id = ? AND source = 'order_earn'"
  ).get(orderId);
  if (!earn) return 0;
  const already = tdb().prepare(
    "SELECT id FROM retail_points_transactions WHERE order_id = ? AND source = 'refund_reverse'"
  ).get(orderId);
  if (already) return 0;
  // "Add to this order" add-ons earn their own points (source order_addon_earn).
  // A full refund reverses those too. lifetime_spend already covers them — the
  // add-on bumped subtotal at finalize, so o.subtotal below is the FULL spend.
  const addonPts = tdb().prepare(
    "SELECT COALESCE(SUM(delta), 0) AS pts FROM retail_points_transactions WHERE order_id = ? AND source = 'order_addon_earn'"
  ).get(orderId).pts || 0;
  const reverseDelta = (earn.delta || 0) + addonPts;
  const o = tdb().prepare('SELECT subtotal FROM retail_orders WHERE id = ?').get(orderId);
  const spend = Math.max(0, Number(o?.subtotal) || 0);
  const tx = tdb().transaction(() => {
    // Subtracted exactly, and still floored at zero — a refund must not be able
    // to drive a lifetime total negative (audit I-02).
    const before = tdb().prepare('SELECT COALESCE(lifetime_spend, 0) AS s FROM retail_customers WHERE id = ?').get(earn.customer_id);
    tdb().prepare(
      'UPDATE retail_customers SET lifetime_spend = ?, points_balance = points_balance - ? WHERE id = ?'
    ).run(Math.max(0, money.addMajor(before ? before.s : 0, -spend)), reverseDelta, earn.customer_id);
    const fresh = tdb().prepare('SELECT lifetime_spend, points_balance, tier_key FROM retail_customers WHERE id = ?').get(earn.customer_id);
    // Refunds reduce lifetime_spend, so the tier may need to demote in the
    // same transaction. Sticky-upward semantics would skip this — current
    // policy is recompute always.
    reconcileTier(earn.customer_id, fresh.lifetime_spend, fresh.tier_key);
    const after = fresh.points_balance;
    tdb().prepare(
      `INSERT INTO retail_points_transactions
         (customer_id, delta, balance_after, source, order_id, note)
       VALUES (?, ?, ?, 'refund_reverse', ?, 'Reversed on refund')`
    ).run(earn.customer_id, -reverseDelta, after, orderId);
  });
  try { tx(); } catch (e) { console.error('[reverseOrderPoints]', e); }
  return reverseDelta;
}

module.exports = {
  DEFAULT_ROOTS_CLUB_TIERS, tierMultiplierFor, reconcileTier,
  pointsEarnedFor, pointsEarnBaseAmount, nextEarnExpiry, sweepExpiredPoints, pointsRedeemRate,
  pointsCashValue, pointsRequiredFor, pointsCoverShipping, pointsRedeemableBase,
  awardOrderPoints, reverseOrderPoints,
};
