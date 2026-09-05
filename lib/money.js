// Money, exactly (audit A-06, Stage 1 of docs/tacet-money-migration-plan.md).
//
// ── WHAT IS WRONG ─────────────────────────────────────────────────────────
// Ninety-three money columns are SQLite REAL — binary floating point. 0.1 has no
// exact binary form, so sums of many small amounts drift and two figures that
// should be equal differ by a fraction of a cent. The codebase already says so
// out loud, in lib/channel-settlement.js:
//
//     // a float sum of four decimals lands on 45.999999999999996 often enough
//     // to matter.
//     const CENT = 0.005;
//     const sameMoney = (a, b) => Math.abs(a - b) < CENT;
//
// Somebody hit it, diagnosed it exactly, and wrote a half-cent tolerance rather
// than fix the storage. There are about twenty such tolerances now, including in
// the refund path, where `amount + 0.005 >= remainingGross` decides whether a
// customer is refunded in full.
//
// ── WHAT THIS IS, AND WHAT IT IS NOT ──────────────────────────────────────
// This is Stage 1: one module, no schema change, no behaviour change. It exists
// so that new arithmetic has somewhere correct to happen, and so the storage
// migration (Stage 2, several ships per table family) has a settled vocabulary
// to migrate INTO rather than inventing one halfway through.
//
// It does NOT convert any column. Nothing here reads or writes a database.
//
// ── AMOUNTS ARE NOT RATES, AND THE DATA PROVED IT ─────────────────────────
// Measured against production on 2026-09-05: 2,381 of 325,091 stored money
// values are already not a whole number of cents, and they are concentrated in
// exactly the columns that are not amounts —
//
//     retail_order_items.unit_cost_at_sale   93% sub-cent
//     ingredients.cost_per_unit              60% sub-cent
//     store_products.unit_cost               84% sub-cent
//
// — because those are RATES. Oat groats cost 0.042 yuan per gram; in cents that
// is 4.2, and rounding it to 4 moves the cost basis of every recipe by 5%. The
// amounts a customer actually pays are the CLEANEST columns in the database
// (retail_orders.total is 1.5% sub-cent), which is what you would expect.
//
// So there are two units here, not one:
//
//     MINOR   an amount somebody pays or is paid. Integer cents. Exact.
//     MICRO   a rate — a price per gram, a cost per unit. Integer ten-thousandths
//             of a major unit, i.e. 100× finer than a cent. `0.042` is 420 micro.
//
// Four decimal places is not arbitrary: it is what the measured data needs.
// 1,293 of the sub-cent values differ at four decimal places too ("deep" in the
// diagnostic), so anything coarser would still be rounding real cost data — and
// anything finer buys precision nobody has evidence of needing.

'use strict';

const MINOR_PER_MAJOR = 100;        // cents in a yuan/pound/dollar
const MICRO_PER_MAJOR = 10000;      // ten-thousandths, for rates

// Beyond this an integer stops being exact in a double, and every value here
// passes through JavaScript numbers. 2^53 minor units is ~90 trillion major —
// far past any real amount, and a bound that is checked rather than assumed.
const MAX_SAFE_MINOR = Number.MAX_SAFE_INTEGER;

/** A value that cannot be money, distinguished from zero — which very much can. */
function isMoneyish(v) {
  if (v == null || v === '') return false;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n);
}

/**
 * Major units → integer minor units. `12.34` → `1234`.
 *
 * ROUNDS HALF AWAY FROM ZERO, not JavaScript's half-up. Math.round(-0.5) is 0
 * and Math.round(0.5) is 1, so a refund and a charge of the same half-cent round
 * in opposite directions and a pair that should cancel does not. Away-from-zero
 * is symmetric, which is the property that matters when the same number appears
 * on both sides of a ledger.
 *
 * The multiply is done on a value nudged by Number.EPSILON, because 1.005 * 100
 * is 100.49999999999999 and would round to 100 — the classic wrong penny.
 */
function toMinor(major) {
  if (!isMoneyish(major)) return null;
  const n = Number(major);
  const scaled = n * MINOR_PER_MAJOR;
  const nudged = scaled >= 0
    ? scaled + Math.abs(scaled) * Number.EPSILON
    : scaled - Math.abs(scaled) * Number.EPSILON;
  const r = nudged >= 0 ? Math.floor(nudged + 0.5) : Math.ceil(nudged - 0.5);
  if (!Number.isSafeInteger(r)) throw new RangeError('amount is too large to hold exactly: ' + major);
  return r;
}

/** Integer minor units → major units, as a NUMBER for display only. */
function fromMinor(minor) {
  const n = Number(minor);
  if (!Number.isFinite(n)) return null;
  return n / MINOR_PER_MAJOR;
}

/** Major units → integer micro units (ten-thousandths). For rates, not amounts. */
function toMicro(major) {
  if (!isMoneyish(major)) return null;
  const n = Number(major);
  const scaled = n * MICRO_PER_MAJOR;
  const nudged = scaled >= 0
    ? scaled + Math.abs(scaled) * Number.EPSILON
    : scaled - Math.abs(scaled) * Number.EPSILON;
  const r = nudged >= 0 ? Math.floor(nudged + 0.5) : Math.ceil(nudged - 0.5);
  if (!Number.isSafeInteger(r)) throw new RangeError('rate is too large to hold exactly: ' + major);
  return r;
}

/** Integer micro units → major units, as a NUMBER for display only. */
function fromMicro(micro) {
  const n = Number(micro);
  if (!Number.isFinite(n)) return null;
  return n / MICRO_PER_MAJOR;
}

/** Exact sum of integer minor units. Skips nulls; throws on a non-integer. */
function sumMinor(list) {
  let t = 0;
  for (const v of (list || [])) {
    if (v == null) continue;
    if (!Number.isInteger(v)) throw new TypeError('sumMinor takes integer minor units, got: ' + v);
    t += v;
    if (!Number.isSafeInteger(t)) throw new RangeError('sum has left the exact range');
  }
  return t;
}

/**
 * A rate × a quantity, as an exact amount in minor units.
 *
 * `microRate` is a price per unit in micro; `qty` may be fractional (0.35 kg).
 * The product is computed in micro and rounded ONCE, at the end — rounding the
 * rate to cents first is how a per-gram price becomes 5% wrong.
 */
function extendMicro(microRate, qty) {
  if (!Number.isInteger(microRate)) throw new TypeError('extendMicro takes an integer micro rate');
  const q = Number(qty);
  if (!Number.isFinite(q)) return null;
  const micro = microRate * q;
  const nudged = micro >= 0
    ? micro + Math.abs(micro) * Number.EPSILON
    : micro - Math.abs(micro) * Number.EPSILON;
  const inMinor = nudged / (MICRO_PER_MAJOR / MINOR_PER_MAJOR);
  const r = inMinor >= 0 ? Math.floor(inMinor + 0.5) : Math.ceil(inMinor - 0.5);
  if (!Number.isSafeInteger(r)) throw new RangeError('extended amount has left the exact range');
  return r;
}

/**
 * Split `totalMinor` across `weights`, losing nothing.
 *
 * THIS IS WHERE THE FRACTIONS COME FROM. Dividing money is what the half-cent
 * tolerances are compensating for: a discount spread over three lines, a
 * delivery fee prorated, a refund allocated across the tenders it was paid on.
 * "Divide and hope" leaves a stray cent somewhere, and a stray cent in a refund
 * is a customer who was paid the wrong amount.
 *
 * LARGEST REMAINDER, and DETERMINISTIC: 100 across equal thirds is 34/33/33 and
 * always the same 34 — the first index, on a tie. A split that moved the spare
 * cent around between runs would make the same order reconcile differently
 * twice, which is worse than any particular choice of where it lands.
 *
 * The parts always sum EXACTLY to the total. That is the whole contract.
 */
function splitMinor(totalMinor, weights) {
  if (!Number.isInteger(totalMinor)) throw new TypeError('splitMinor takes integer minor units');
  const w = (weights || []).map((x) => {
    const n = Number(x);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  const n = w.length;
  if (!n) return [];
  const totalWeight = w.reduce((a, b) => a + b, 0);
  // Nothing to weigh by: give it all to the first part rather than dropping it.
  // Losing the money is never the right answer to an ambiguous split.
  if (totalWeight <= 0) {
    const out = new Array(n).fill(0);
    out[0] = totalMinor;
    return out;
  }
  // COMPUTED ON THE ABSOLUTE VALUE, THEN SIGNED. A refund must mirror the
  // charge it reverses, part for part: split(+100) over equal thirds is
  // [34,33,33], so split(-100) has to be [-34,-33,-33]. Working on the signed
  // total directly does NOT do that — Math.floor(-33.33) is -34, so the spare
  // cent lands on the LAST part instead of the first, and refunding a
  // three-way split returns 33 to the tender that was charged 34.
  //
  // That is not a rounding curiosity. It is a customer paid the wrong amount,
  // by the function whose entire job is that this cannot happen.
  const sign = totalMinor < 0 ? -1 : 1;
  const abs = Math.abs(totalMinor);
  const exact = w.map((x) => (abs * x) / totalWeight);
  const floors = exact.map((x) => Math.floor(x));
  let spare = abs - floors.reduce((a, b) => a + b, 0);
  // Order by remainder, descending; ties go to the earlier index, which is what
  // makes this reproducible.
  const order = exact
    .map((x, i) => ({ i, rem: x - Math.floor(x) }))
    .sort((a, b) => (b.rem - a.rem) || (a.i - b.i));
  const out = floors.slice();
  for (let k = 0; spare > 0; k++) { out[order[k % n].i] += 1; spare -= 1; }
  // `|| 0` collapses -0, which -(0) produces and which JSON, SQLite and a
  // strict comparison all treat as a small surprise waiting to happen.
  return sign < 0 ? out.map((v) => -v || 0) : out;
}

/**
 * An amount as the product means it: exact to the minor unit, back as a number.
 *
 * THIS IS THE BOUNDARY FIX (audit I-02). Money arithmetic happens inside SQL in
 * a dozen places — `SUM(qty * cost_per_unit)`, `lifetime_spend + ?` — and the
 * rounding there is the DATABASE's, not the product's. SQLite adds doubles, so
 * a sum of four decimals lands on 45.999999999999996 often enough that
 * lib/channel-settlement.js carries a half-cent tolerance to cope with it.
 *
 * Rounding the RESULT once, here, does not make the storage exact — that is
 * Stage 2 of docs/tacet-money-migration-plan.md, and this is not it. What it
 * does is stop the drift PROPAGATING: a figure that goes back into the database
 * or onto a screen is a whole number of cents, so the next sum starts from a
 * clean number instead of compounding the last one's dust.
 *
 * Returns null for a non-amount, so a caller can tell "nothing" from "zero".
 */
function round(major) {
  const m = toMinor(major);
  return m == null ? null : fromMinor(m);
}

/**
 * Add amounts in major units EXACTLY, by going through minor units.
 *
 * `0.1 + 0.2` is 0.30000000000000004 and `lifetime_spend + 0.01`, applied a
 * thousand times, is 9.999999999999831 rather than 10. Every value is rounded
 * to the cent on the way in, so this is addition of integers wearing a decimal
 * point. Non-amounts are skipped, exactly as sumMinor skips nulls.
 */
function addMajor(...amounts) {
  let total = 0;
  for (const a of amounts) {
    const m = toMinor(a);
    if (m != null) total += m;
  }
  return fromMinor(total);
}

/** Do these two amounts agree to the cent? For comparing a stored REAL today. */
function sameMoney(a, b) {
  if (!isMoneyish(a) || !isMoneyish(b)) return false;
  return toMinor(a) === toMinor(b);
}

module.exports = {
  MINOR_PER_MAJOR, MICRO_PER_MAJOR, MAX_SAFE_MINOR,
  isMoneyish, toMinor, fromMinor, toMicro, fromMicro,
  sumMinor, extendMicro, splitMinor, sameMoney, round, addMajor,
};
