// The number on a shop card's + — how many of that product are already in the
// cart. Requested by Ash, 2026-10-06: "number only on the +", no extra label.
//
// Pure (no wx, no storage) so scripts/test_shop_plus_qty.js can run it in Node.
//
// items  — cart lines (cart.get().items): { product_id, qty, options }
// repOf  — member product id → the id of the card it is drawn on. A variant
//          card shows one product but stands for every size in its group, so a
//          250g and a 500g in the cart both count on that one card. Products
//          that are their own card need no entry.
//
// Lines of the same product with different choices (two wraps, two dressings)
// are separate cart lines and are summed: the shopper asked "how many of this
// have I got", not "how many with this dressing".
//
// Returns { [cardId]: '3' } with only cards that have something in the cart,
// and '99+' past 99 so the badge never outgrows the button.
function plusQty(items, repOf) {
  const sums = {};
  for (const it of items || []) {
    const pid = Number(it && it.product_id);
    const qty = Number(it && it.qty) || 0;
    if (!pid || qty <= 0) continue;
    const card = (repOf && repOf[pid]) || pid;
    sums[card] = (sums[card] || 0) + qty;
  }
  const out = {};
  for (const id of Object.keys(sums)) out[id] = sums[id] > 99 ? '99+' : String(sums[id]);
  return out;
}

// Shallow equality on two plusQty() results, so the page only calls setData
// when a number actually changed.
function sameQty(a, b) {
  const ka = Object.keys(a || {});
  const kb = Object.keys(b || {});
  if (ka.length !== kb.length) return false;
  return ka.every(k => a[k] === b[k]);
}

module.exports = { plusQty, sameQty };
