'use strict';

// ONE FACT, TWO COLUMNS — reconciled here and nowhere else.
//
// Whether a purchase line will ever have a 发票 is stored twice:
//
//   po_line_items.no_invoice_expected  the mark. THE ONE THING READ — by the
//                                      Invoices tab (routes/retail-purchasing
//                                      lineStatus) and by Finance's awaiting
//                                      report (routes/finance.js).
//   po_line_items.invoice_status       the buyer's note on the receive row,
//                                      'not_received' | 'received' |
//                                      'no_invoice'. Its third value states
//                                      the same fact as the mark.
//
// THE DEFECT THIS CLOSES. Each screen wrote only its own column. The Invoices
// tab's 不开发票 / 恢复 buttons wrote the mark and left the status stale; the
// kitchen report's picker wrote the status and left the mark stale. Nothing
// contradicted anything until a THIRD writer re-derived one from the other —
// database.js re-ran its reconciliation on every boot, and the receive route
// derives the mark from whatever status the row sends. So a buyer's decision
// was silently reversed some time later, with nothing on screen to say why:
//
//   • 恢复 on a line whose status still read 'no_invoice' → the next server
//     start put the mark back, and a line that DOES need chasing sat there
//     marked 不开发票.
//   • 不开发票 from the Invoices tab left the status on 'not_received' → the
//     next save that carried that status cleared the mark, and the line went
//     back to 等待开票.
//
// Both directions are the same bug, and the fix is that no caller writes one
// column alone. Marking sets the status; unmarking clears a status that says
// no_invoice and LEAVES 'received' alone — "the 发票 is in hand" is a different
// fact and is not this toggle's to erase.
//
// Every function takes a line id the caller has already scoped (tenant, PO)
// and returns the driver's run result, so callers keep their own 404s.

const VALID_INVOICE_STATUS = new Set(['not_received', 'received', 'no_invoice']);

// The 不开发票 / 恢复 toggle. flag true → the line will never be invoiced.
function setNoInvoiceMark(db, lineId, flag, poId) {
  const scope = poId == null ? '' : ' AND po_id = ?';
  const args  = poId == null ? [lineId] : [lineId, poId];
  return flag
    ? db.prepare(`UPDATE po_line_items
                     SET no_invoice_expected = 1, invoice_status = 'no_invoice', invoice_received = 0
                   WHERE id = ?${scope}`).run(...args)
    : db.prepare(`UPDATE po_line_items
                     SET no_invoice_expected = 0,
                         invoice_status = CASE WHEN invoice_status = 'no_invoice'
                                               THEN 'not_received' ELSE invoice_status END
                   WHERE id = ?${scope}`).run(...args);
}

// The ORDER-level 不开发票 / 恢复 toggle — the umbrella over every line on one
// buying order.
//
// IT WRITES THE ORDER'S OWN COLUMN AND NOTHING ELSE, in both directions.
//
// 恢复 used to clear the line marks under the order as well, on the reading
// that a buyer who marks the whole order and then lifts it means "all of it".
// That reading cost more than it bought, and the floor found the case that
// disproves it: ONE buying order's lines are attributed line by line
// (po_line_items.supplier_name wins over the order header — SUPPLIER_EXPR in
// routes/retail-purchasing.js), so a single order routinely appears under TWO
// suppliers on the Invoices screen. A 恢复 pressed on the packaging supplier's
// row was silently putting the market stall's cash line — deliberately marked
// 不开发票, by someone who knows that stall issues no 发票 — back on the chase,
// under a supplier group the buyer was not even looking at, with nothing said.
// A line mark is the buyer's own statement about that line. It is not the
// order's to erase, and an order-level press must never reach across a supplier
// boundary to unmake a decision it cannot see.
//
// SO THE ROW THAT STAYS MARKED IS NOT A PRESS THAT DID NOTHING. Every screen
// computes the row's state as `line_no_invoice || po_no_invoice`, so a line
// carrying its own mark still reads 不开发票 after the order's umbrella comes
// off — correctly. What made that look broken before was that nothing said so
// and nothing offered a way out. Both are answered now without touching the
// data: the order row itself visibly changes, the drill offers that line its
// OWN 恢复 the moment po_no_invoice clears (routes/retail-purchasing.js
// lineStatus is the OR; public/retail-admin/16-purchasing.js invLinesHtml
// switches to the line toggle), and the count returned here is said out loud in
// the toast — "整单已恢复待开票 —— N 条明细仍自行标记不开发票".
//
// MARKING likewise stays the order's own column. The umbrella already speaks
// for every line everywhere the state is read, and writing it down onto lines
// that never said it would put words in the buyer's mouth.
function setPONoInvoiceMark(db, poId, flag) {
  db.prepare(`UPDATE purchase_orders SET no_invoice_expected = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`).run(flag ? 1 : 0, poId);
  if (flag) return { lines_still_marked: 0 };
  // Counted, never cleared. These are the rows that will go on reading
  // 不开发票 once the umbrella is off, each on the strength of its own mark.
  const r = db.prepare(`SELECT COUNT(*) AS n FROM po_line_items
                         WHERE po_id = ?
                           AND (COALESCE(no_invoice_expected, 0) = 1 OR invoice_status = 'no_invoice')`)
    .get(poId);
  return { lines_still_marked: (r && r.n) || 0 };
}

// The receive row's / report's three-way picker. 'no_invoice' raises the mark,
// anything else clears it — the picker is the whole statement about this line.
function setLineInvoiceStatus(db, lineId, status, poId) {
  if (!VALID_INVOICE_STATUS.has(status)) throw new Error('invalid_invoice_status');
  const scope = poId == null ? '' : ' AND po_id = ?';
  const args  = poId == null ? [lineId] : [lineId, poId];
  return db.prepare(`UPDATE po_line_items
                        SET invoice_status = ?, no_invoice_expected = ?, invoice_received = ?
                      WHERE id = ?${scope}`)
    .run(status, status === 'no_invoice' ? 1 : 0, status === 'received' ? 1 : 0, ...args);
}

// The column pair as a SET fragment, for the bulk receive route that builds one
// UPDATE out of every field its payload named. Same rule, same place.
function invoiceStatusSets(status) {
  if (!VALID_INVOICE_STATUS.has(status)) return null;
  return {
    sets: ['invoice_status = ?', 'no_invoice_expected = ?', 'invoice_received = ?'],
    vals: [status, status === 'no_invoice' ? 1 : 0, status === 'received' ? 1 : 0],
  };
}

module.exports = { VALID_INVOICE_STATUS, setNoInvoiceMark, setPONoInvoiceMark,
                   setLineInvoiceStatus, invoiceStatusSets };
