'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   THE NUMBER WE TELL A PLATFORM — §85.
   ──────────────────────────────────────────────────────────────────────────
   Meituan, Eleme and gzgrocery each show a customer whatever quantity we last
   pushed them. Until §85 that was always the shelf. This is the one place that
   decides otherwise.

     window open  →  max(0, shelf + preorder_qty)
     window shut  →  max(0, shelf)          ← exactly what every channel did before

   THE OFF SWITCH IS EVERY CONDITION. lib/batch-cadence.js opens the window only
   when the schedule is on, an allowance is set, this channel is named, the hour
   is before the lock, and today is a batch day. A tenant that has set none of
   that — which is all of them today — takes the second line every time, and
   this module is a rename of the call they already made.

   ── WHY THE ALLOWANCE IS ADDED BEFORE THE FLOOR AND NOT AFTER ──────────────

   A shelf of −18 means eighteen are already sold and owed (§84). With an
   allowance of 20 the morning has 2 left to give, not 20. Flooring first would
   publish 20 and let the morning sell 38 against a batch of 20 — the exact
   oversell this window is supposed to be incapable of.

   ── AND WHY THAT MAKES IT SELF-CAPPING ─────────────────────────────────────

   Nothing here counts how many pre-orders have been taken, because nothing has
   to. Each one drives the shelf down by one, so the next answer is one lower:
   20, 19, 18 … 0, at which point the platform shows sold out. The shelf IS the
   counter, which is only true because §84 stopped the ingests clamping it at
   zero. The two sections are one mechanism.

   ── ONE ALLOWANCE FOR EVERY PRODUCT, FOR NOW ───────────────────────────────

   `preorder_qty` is tenant-wide (§85). A per-product number is the better
   answer and is not built yet, because the stock-layer fields it would join —
   safety_buffer, wechat_quota, meituan_quota, restock_target — are all API-only
   with no control anywhere in the back office, and a per-product number nobody
   can set is worse than a blunt one they can.
   ══════════════════════════════════════════════════════════════════════════ */

const bundleStock = require('./bundle-stock');
const cadence = require('./batch-cadence');

/* What to push for one (store, product) on one channel, right now.

   `window` may be passed in by a caller that has already resolved it for this
   cycle — the daemons and the enqueue paths do, so a queue run of two hundred
   rows reads the schedule once rather than two hundred times. Omitted, it is
   resolved here.

   A PRODUCT THAT IS NOT BATCH-MADE NEVER GETS THE ALLOWANCE. The window is a
   statement about the kitchen's cooking day; a jar of olive oil is not made by
   it, and offering twenty of something nobody is cooking would be inventing
   stock outright. This is the same `is_batch_made` flag §74 and §80 key on. */
function publishableAt(db, storeId, productId, { channel, now = new Date(), window = null } = {}) {
  const shelf = bundleStock.unflooredSellableAt(db, storeId, productId);
  const w = window || cadence.preorderWindow(db, { channel, now });
  if (!w.open) return Math.max(0, shelf);
  if (!isBatchMade(db, productId)) return Math.max(0, shelf);
  return Math.max(0, shelf + w.qty);
}

// Cheap and uncached on purpose: it is one indexed lookup by primary key, and a
// cache here would hold a flag an operator can flip in the product editor.
function isBatchMade(db, productId) {
  try {
    const row = db.prepare(
      'SELECT COALESCE(is_batch_made, 0) AS b FROM store_products WHERE id = ?'
    ).get(productId);
    return !!(row && row.b);
  } catch (_) { return false; }
}

/* Is this shortfall explained by the window rather than by an oversell?

   A pre-order taken against an empty shelf trips the channel ingests'
   `order_oversold` alert, which is correct in every other circumstance and pure
   noise in this one — and an alert that fires on every pre-order buries the one
   that matters. That alarm exists because 54 undeducted lines accumulated unseen
   from June to September; it is not one to drown.

   TRUE ONLY WHEN THE WINDOW ACTUALLY EXPLAINS IT. A shortfall LARGER than the
   allowance is a real oversell wearing a pre-order's clothes and still pages.
   `have` is the shelf before the deduction, so the debt after it is
   `want − have`, and the allowance is what the window promised to cover.

   THE SYNC-LOG ROW IS WRITTEN EITHER WAY, by the caller. Suppressing the page
   is not the same as forgetting: the log is where the count gets reconciled. */
function oversellExpected({ have, want, window }) {
  if (!window || !window.open) return false;
  const debtAfter = Number(want) - Number(have);
  if (!(debtAfter > 0)) return false;
  return debtAfter <= window.qty;
}

module.exports = { publishableAt, oversellExpected };
