// How many of a product THIS shopper can be sold — decisions §481.
//
// A product row carries `stock`, the shelves of every open shop added together,
// and `stock_by_store`, the same shelves one shop at a time ({ code: count }).
// An order on the same-day local run is packed at ONE shop — the one checkout
// calls nearest — so for that shopper the honest number is that shop's count.
// The sum promised TC001259 six bottles of a kombucha no single shop had five
// of, and the order parked.
//
// So: a shopper whose chosen address is on the run (utils/delivery
// localStoreCode) reads their own shop's count; everyone else — out-of-city,
// the outer ship-districts, signed out, no saved address — reads `stock` as
// before. A row with no per-shop map (never stocked per-shop, a bundle, an
// older server) also reads `stock`. Nothing here asks the network: the store
// code rides on the saved address and the counts on the row.

const delivery = require('./delivery');

// The per-shop counts off a row, or null. The server sends an object; a row
// cached from elsewhere may carry it as the JSON text SQLite produced.
function byStore(p) {
  let m = p && p.stock_by_store;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch (e) { m = null; } }
  return (m && typeof m === 'object' && !Array.isArray(m)) ? m : null;
}

// The stock number every surface reads in place of `p.stock`: null means
// untracked (treat as in stock), exactly as `p.stock == null` did.
function of(p) {
  if (!p) return null;
  const total = p.stock == null ? null : Number(p.stock);
  const code = delivery.localStoreCode();
  if (!code) return total;
  const m = byStore(p);
  if (!m) return total;
  return Math.max(0, Number(m[code]) || 0);
}

// The most of this product the cart may hold, or null for no limit. Only on
// the local run, and only for a row the shelf actually governs there: a row
// the shopper may reserve on the run (a 'backorder_all' pre-order, a dated
// fresh batch) parks at checkout instead of going short, and a supplier-direct
// row is not on our shelves at all.
function cap(p) {
  if (!p || p.ship_from_supplier) return null;
  const code = delivery.localStoreCode();
  if (!code) return null;
  if (p.oos_preorder && (p.oos_preorder_local || p.local_fresh_date)) return null;
  const m = byStore(p);
  if (!m) return null;
  return Math.max(0, Number(m[code]) || 0);
}

// Is a per-shop limit in force for this shopper at all? False off the run, so
// a cap a cart line picked up while they were on it stops binding the moment
// they switch to an address that is not.
function limited() { return !!delivery.localStoreCode(); }

module.exports = { of, cap, limited, byStore };
