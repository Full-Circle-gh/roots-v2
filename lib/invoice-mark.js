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
// WHY 恢复 HAS TO REACH THE LINES. Every reader computes the row's state as an
// OR of the two levels — `line_no_invoice || po_no_invoice` (routes/
// retail-purchasing.js lineStatus, routes/finance.js). So lifting the order's
// mark alone leaves any line that carries its own still reading 不开发票, and
// the row does not move. That is the 恢复 button that "does nothing": the press
// lands, the server answers 200, and the screen repaints exactly as it was,
// with nothing on it to say a second mark one level down is still holding the
// row where it is. Pressing it on the ORDER means "this order is back to being
// chased for a 发票", so it clears the marks that would contradict that, and
// reports how many lines went with it so the screen can say so out loud.
//
// MARKING stays the order's own column only. The umbrella already speaks for
// every line everywhere the state is read, and writing it down onto lines that
// never said it would put words in the buyer's mouth.
function setPONoInvoiceMark(db, poId, flag) {
  db.prepare(`UPDATE purchase_orders SET no_invoice_expected = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`).run(flag ? 1 : 0, poId);
  if (flag) return { lines_restored: 0 };
  const r = db.prepare(`UPDATE po_line_items
                           SET no_invoice_expected = 0,
                               invoice_status = CASE WHEN invoice_status = 'no_invoice'
                                                     THEN 'not_received' ELSE invoice_status END
                         WHERE po_id = ?
                           AND (COALESCE(no_invoice_expected, 0) = 1 OR invoice_status = 'no_invoice')`)
    .run(poId);
  return { lines_restored: r.changes || 0 };
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
