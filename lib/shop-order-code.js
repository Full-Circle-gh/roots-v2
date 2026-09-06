// The short code a shop calls across its counter — §44, shape ruled by Ash on
// 2026-09-06: plain numbers, restarting each day.
//
// WHY THIS EXISTS. order_no is R2026090601234. Nobody shouts that over a coffee
// machine. §44 asks for "a short order code … what staff use to retrieve the
// order", and this is it: 1, 2, 3 through the shop's day, back to 1 tomorrow.
//
// THE DAY IS THE SHOP'S, NOT UTC's. lib/business-date.js resolves the trading
// day from the LOCATION's timezone (§32's addendum), so a shop still serving at
// half past midnight is still on the same day's numbers and does not restart at
// 1 in front of a queue.
//
// SCOPED PER SHOP. Two shops both calling "14" on the same day are both right —
// a customer only ever hears the counter they are standing at.
//
// ALLOCATED INSIDE THE CALLER'S TRANSACTION. The next number is MAX + 1 over
// the same (store, day), which is only safe if the read and the insert cannot
// interleave. better-sqlite3 serialises transactions, so a caller that allocates
// and inserts inside one transaction cannot hand two customers the same number;
// a caller that does not, can. That is why this takes a handle rather than
// reaching for tdb() itself — it must run on the transaction the order is
// written in, not beside it.

'use strict';

const { businessDateForLocation } = require('./business-date');

// The next code for this shop's location today, and the day it belongs to.
// Returns { code, date }. `h` MUST be the caller's open transaction handle.
function allocateShopOrderCode(h, locationId, at = new Date()) {
  const date = businessDateForLocation(h, locationId, at);
  const row = h.prepare(
    `SELECT MAX(shop_order_code) AS n
       FROM retail_orders
      WHERE store_id = ? AND shop_order_date = ?`
  ).get(locationId, date);
  const next = (row && Number.isFinite(row.n) ? row.n : 0) + 1;
  return { code: next, date };
}

module.exports = { allocateShopOrderCode };
