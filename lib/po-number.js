// The next kitchen buying-order number.
//
// This used to be COUNT(*) + 1 over the whole purchase_orders table, which is
// only ever right while nothing is deleted and nothing else shares the table.
// Both stopped being true: retail orders (RPO-nnnn) live here too and were
// inflating the count, and clearing out test orders drops the count below
// numbers that are still in use — the next order would then reissue a
// po_number an existing one already carries. MAX over the PO- series only
// keeps numbering monotonic no matter what is removed.
//
// The retail twin (nextRetailPONumber in routes/retail-purchasing.js) has
// always worked this way; this is the kitchen catching up.
function nextKitchenPONumber(db) {
  const row = db.prepare(
    "SELECT MAX(CAST(SUBSTR(po_number, 4) AS INTEGER)) AS n FROM purchase_orders WHERE po_number LIKE 'PO-%'"
  ).get();
  return 'PO-' + String((row && row.n ? row.n : 0) + 1).padStart(4, '0');
}

module.exports = { nextKitchenPONumber };
