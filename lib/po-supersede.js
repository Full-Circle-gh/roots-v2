// ONE PURCHASE, TWO ROWS: WHICH ONE THE LEDGERS BELIEVE.
//
// "Copy from kitchen" (routes/retail-purchasing.js) brings a kitchen buying
// order — purchase_orders.scope='kitchen', PO-#### — into Tacet as an editable
// retail DRAFT: scope='retail', RPO-####, copied_from_po_id pointing back at
// the original. It is a COPY on purpose. The kitchen keeps its own row, its own
// received counts and its own history, and goes on working for the kitchen.
//
// The price of that choice is that the same real purchase now exists twice, and
// while the copy is a draft the price is zero: a draft posts no expense and
// neither 发票 chase reads anything but placed orders. THE MOMENT THE BUYER
// PLACES THE COPY IT STOPS BEING ZERO. Before this module, marking RPO-0022
// Ordered put the same goods in the expense books a second time and on the
// invoice chase a second time, line for line — ¥388, ¥597, ¥918 under PO-0066
// and ¥388, ¥597, ¥887.40 under RPO-0022, the only difference being the one
// quantity the buyer had corrected. Both rows then asked for the same 发票.
//
// So the rule, which is the one the buyer already had in their head: THE COPY
// IS THE NEW VERSION OF THE ORDER. Once it is placed, the kitchen original is
// SUPERSEDED and stands down from both ledgers.
//
// SUPERSEDED MEANS EXACTLY TWO THINGS AND NOTHING ELSE:
//   • no expense_entries — postPOExpenses() wipes the original's rows and
//     refuses to post while it is superseded, because postRetailPOExpenses()
//     is posting the same money against the copy;
//   • no lines in either 发票 chase — routes/finance.js /outstanding-lines and
//     routes/retail-purchasing.js /invoices/outstanding both drop them.
// The kitchen row itself is untouched: same status, same lines, same qty
// received, still listed, still openable and editable in the kitchen app.
// NOTHING IS DELETED AND NOTHING IS REWRITTEN. A superseded order is stood down
// from two ledgers, not erased.
//
// AND IT IS COMPUTED, NEVER STORED, so it reverses in one step: put the copy
// back to Draft, or cancel it, and the original is live again on the next post
// and the next read. There is no flag to get stuck, and no migration to undo.
//
// WHAT IT DOES NOT DO: it does not move invoice_lines allocations. If a 发票
// was already recorded against the ORIGINAL's lines, that money stays recorded
// where it is — the invoice ledger is unchanged — but it is no longer attached
// to a line the chase shows, so the copy's lines would read "awaiting" for
// goods somebody has already invoiced. Rather than re-point allocations at
// lines whose quantities the buyer has since edited (a guess dressed up as
// bookkeeping), invoicedOnSuperseded() reports the figure and the chase says so
// on the copy: "replaces PO-0066 · 已登记 ¥985.00". Re-attributing line by line
// needs the buyer to say which line covers which, and that is a screen, not a
// silent remap.

// The copy statuses that count as PLACED. Identical to the set both invoice
// chases treat as placed (INV_PO_STATUSES / the literal in finance.js): the
// retail UI only ever writes Ordered/Delivered, 'Confirmed' is carried for the
// kitchen-era rows that still hold it. A Draft ('Requested') supersedes
// nothing — that is the whole reason copies land as drafts — and neither does
// a Cancelled one.
const PLACED_COPY_STATUSES = "('Ordered','Delivered','Confirmed')";

// Only ever called with a literal from this repo, but the alias lands inside
// SQL by interpolation, so it is checked rather than trusted.
function checkAlias(alias) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('po-supersede: bad alias ' + alias);
  return alias;
}

// "This purchase_orders row has a placed retail copy." Tenant-matched on both
// sides: copy-from-kitchen only ever copies inside one tenant, and a predicate
// that ignored tenant_id would let one tenant's copy stand another tenant's
// order down.
function supersededByCopySql(alias = 'po') {
  return `EXISTS (
      SELECT 1 FROM purchase_orders sup_c
       WHERE sup_c.copied_from_po_id = ${checkAlias(alias)}.id
         AND COALESCE(sup_c.scope,'kitchen') = 'retail'
         AND COALESCE(sup_c.tenant_id,1)     = COALESCE(${alias}.tenant_id,1)
         AND sup_c.status IN ${PLACED_COPY_STATUSES})`;
}

// The form every caller actually wants: "…AND this order still counts."
function notSupersededByCopySql(alias = 'po') {
  return `NOT ${supersededByCopySql(alias)}`;
}

// The placed copy standing this order down, or null. Used for the expense guard
// and for saying WHICH order took over rather than just that one did.
function supersedingCopy(db, poId) {
  return db.prepare(`
    SELECT c.id, c.po_number, c.status
      FROM purchase_orders c
      JOIN purchase_orders src ON src.id = c.copied_from_po_id
     WHERE c.copied_from_po_id = ?
       AND COALESCE(c.scope,'kitchen') = 'retail'
       AND COALESCE(c.tenant_id,1)     = COALESCE(src.tenant_id,1)
       AND c.status IN ${PLACED_COPY_STATUSES}
     ORDER BY c.id LIMIT 1`).get(poId) || null;
}

function isSupersededByCopy(db, poId) {
  return !!supersedingCopy(db, poId);
}

// How much 发票 was already recorded against the superseded original's lines,
// so the chase can show it on the copy instead of silently dropping it. 0 for
// the ordinary case — the copy is normally made and placed long before anyone
// has an invoice to record.
function invoicedOnSuperseded(db, sourcePoId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(il.allocated_amount),0) AS amount
      FROM invoice_lines il
      JOIN po_line_items pli ON pli.id = il.line_id
     WHERE pli.po_id = ?`).get(sourcePoId);
  return Math.round((row && row.amount ? row.amount : 0) * 100) / 100;
}

module.exports = {
  PLACED_COPY_STATUSES,
  supersededByCopySql,
  notSupersededByCopySql,
  supersedingCopy,
  isSupersededByCopy,
  invoicedOnSuperseded,
};
