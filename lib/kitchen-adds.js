// WHAT WENT ON A STORE'S SHELF TODAY, AND WHO PUT IT THERE.
//
// The screen's answer to a failure the "What you made" flow could only name:
// an add leaves nothing behind, so a few minutes later nobody can tell whether
// a batch went in, and the honest guess — add it again — is the one that costs.
//
// PULLED OUT OF THE ROUTE so it can be tested without a database, for the same
// reason lib/stock-app-only.js and lib/quick-stock-grant.js were: the rules
// here are small, they are the whole answer, and every one of them is quiet
// when broken. A wrong total reads as a plausible total.
'use strict';

const { businessDate } = require('./business-date');

/**
 * Fold ledger rows into { [productId]: { qty, who: [names] } } for the store's
 * business date.
 *
 * @param {Array} rows  {product_id, delta, actor_label, created_at} — created_at
 *                      as SQLite writes it, UTC, 'YYYY-MM-DD HH:MM:SS'
 * @param {string|null} tz  the store's timezone; the business date is ITS day
 * @param {Date} [now]  the moment "today" is measured from
 */
function summariseKitchenAdds(rows, tz, now = new Date()) {
  const today = businessDate(tz, now);
  const added = {};
  for (const r of rows || []) {
    /* The stored string is UTC and Node parses a bare 'YYYY-MM-DD HH:MM:SS' as
       LOCAL time, so the Z is not decoration: without it every row shifts by
       the runner's offset and a shift that ran near midnight lands on the
       wrong day. */
    const at = new Date(String(r.created_at).replace(' ', 'T') + 'Z');
    if (isNaN(at.getTime()) || businessDate(tz, at) !== today) continue;
    const n = r.delta | 0;
    // Only what was ADDED. A kitchen_add is additive by construction — the
    // route refuses a negative delta — but this reads the ledger rather than
    // the route, and a total that could go down would not be "added today".
    if (n <= 0) continue;
    const e = added[r.product_id] || (added[r.product_id] = { qty: 0, who: [] });
    e.qty += n;
    /* DISTINCT, IN THE ORDER THEY FIRST ADDED. Two people putting the same
       product on is exactly the case this line exists for — the second needs
       to see the first already did it — so both names appear rather than the
       last write winning.

       A row with no label contributes its units and no name: an add nobody can
       be named for is still an add, and dropping it would make the figure
       disagree with the shelf, which is worse than an unattributed number. */
    const who = String(r.actor_label || '').trim();
    if (who && e.who.indexOf(who) === -1) e.who.push(who);
  }
  return added;
}

module.exports = { summariseKitchenAdds };
