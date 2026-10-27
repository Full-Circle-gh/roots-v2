// A DELIVERY IS NOT ADDED TWICE (§504).
//
// Yuexiu's ledger showed the same goods going on the shelf twice: raised by hand
// on the phone as the boxes came in, then counted in again on Receive. Nothing
// on either screen could see the other. These are the two facts that let each
// screen say so:
//
//   incomingByProduct  — what is on a van to this location right now, for the
//                        stock screen's card ("On its way 5").
//   handAddedSince     — the net of this location's hand-written stock rows for
//                        each product since a moment, for a Receive line
//                        ("Already added by hand +10 · Ash").
//
// BOTH ARE DERIVED, NEVER STORED, for the reason §39 and the stock-movement
// schema's B3 give for in-transit: a stored figure and the rows behind it can
// disagree, and a derivation cannot.
//
// PULLED OUT OF THE ROUTES so they can be tested against a real database with
// nothing else loaded, as lib/kitchen-adds.js was. A wrong figure here reads as
// a plausible figure, which is the kind of mistake only a test catches.
'use strict';

// The reasons a person writes by hand, from either stock screen. `adjust` is the
// phone's recount and the default; `manual` the desktop grid; `count` the old
// name; `kitchen_add` the add-stock taps; `kitchen_recount` a kitchen correction.
// Receipts, sales, waste and transfers are deliberately absent: they are the
// movements this is trying to tell apart from a hand add.
const HAND_REASONS = ['adjust', 'manual', 'count', 'kitchen_add', 'kitchen_recount'];

/**
 * Units on their way to this location, per product.
 * @returns {Object<number, number>} { [productId]: qty } — products with nothing
 *          incoming are absent, never 0.
 */
function incomingByProduct(conn, storeId) {
  const out = {};
  if (!storeId) return out;
  try {
    const rows = conn.prepare(`
      SELECT ri.product_id, SUM(COALESCE(ri.qty_sent, ri.qty_requested, 0)) AS qty
        FROM restock_items ri
        JOIN restock_orders ro ON ro.id = ri.restock_id
       WHERE ro.goods_state = 'in_transit' AND ro.to_store_id = ?
         AND ri.product_id IS NOT NULL
       GROUP BY ri.product_id
      HAVING SUM(COALESCE(ri.qty_sent, ri.qty_requested, 0)) > 0`).all(storeId);
    for (const r of rows) out[r.product_id] = Number(r.qty) || 0;
  } catch (_) { /* best-effort: a card without the line still adds stock */ }
  return out;
}

/**
 * What was added to this location's shelf by hand since `since`, per product.
 * NET, so a +2 then −1 run of taps reads +1, and a hand fix that took units off
 * cancels one that put them on. Only a positive net is reported: a net decrease
 * is somebody correcting down, which is not a delivery added twice.
 *
 * @param {string} since  'YYYY-MM-DD HH:MM:SS' UTC, as SQLite writes
 *                        CURRENT_TIMESTAMP — compared as a string, which is what
 *                        that shape is for.
 * @returns {Object<number, {qty:number, who:string[]}>}
 */
function handAddedSince(conn, storeId, since, productIds) {
  const out = {};
  if (!storeId || !since) return out;
  const ids = [...new Set((productIds || []).map(n => parseInt(n, 10)).filter(Boolean))];
  if (!ids.length) return out;
  try {
    const rows = conn.prepare(`
      SELECT product_id, delta, actor_label
        FROM retail_stock_ledger
       WHERE store_id = ? AND created_at >= ?
         AND reason IN (${HAND_REASONS.map(() => '?').join(',')})
         AND product_id IN (${ids.map(() => '?').join(',')})
       ORDER BY id`).all(storeId, since, ...HAND_REASONS, ...ids);
    const acc = {};
    for (const r of rows) {
      const a = acc[r.product_id] || (acc[r.product_id] = { qty: 0, who: [] });
      a.qty += Number(r.delta) || 0;
      const name = String(r.actor_label || '').trim();
      if (Number(r.delta) > 0 && name && !a.who.includes(name)) a.who.push(name);
    }
    for (const [pid, a] of Object.entries(acc)) if (a.qty > 0) out[pid] = a;
  } catch (_) { /* best-effort: a Receive line without the note still counts in */ }
  return out;
}

/**
 * Decorate a transfer's lines with `hand_added` / `hand_added_by`, while it is
 * on its way. Any other state — not yet sent, already counted in, a kitchen
 * request — gets nulls: the question only means something while goods are
 * between the two shelves.
 */
function attachHandAdded(conn, order, items) {
  const blank = () => (items || []).map(it => ({ ...it, hand_added: null, hand_added_by: null }));
  if (!order || order.goods_state !== 'in_transit' || !order.to_store_id || !order.dispatched_at) return blank();
  const since = String(order.dispatched_at).replace('T', ' ').replace(/\.\d+Z?$|Z$/, '');
  const found = handAddedSince(conn, order.to_store_id, since, (items || []).map(it => it.product_id));
  return (items || []).map(it => {
    const f = found[it.product_id];
    return { ...it, hand_added: f ? f.qty : null, hand_added_by: f ? f.who : null };
  });
}

module.exports = { HAND_REASONS, incomingByProduct, handAddedSince, attachHandAdded };
