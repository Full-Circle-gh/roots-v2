'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   "THE KITCHEN FINISHED IT" — ONE DEFINITION, THREE READERS.
   ──────────────────────────────────────────────────────────────────────────
   warehouse→kitchen is the one direction with no second leg: nothing travels,
   so 'prepared' IS the closure. The kitchen puts what it makes straight on the
   shelf and records the stock itself — nobody collects anything, and the only
   thing the warehouse needs is to KNOW.

   Three surfaces now say so, and they must never disagree about which lines
   count:

     • GET /api/restock/kitchen-ready          — the phone's dot (routes/restock.js)
     • GET .../dashboard/ops → kitchen_ready   — the Needs-you row on the PC
                                                 dashboard AND on the phone's
                                                 Home (routes/retail.js)
     • the list itself — which stamps `seen_at`. TWO surfaces render it now:
       Tacet Mobile's `kitchenready` screen and the desktop admin's own drawer
       (§73). It was one, at /stock?go=ready, until §48 step 4 deleted that app

   A fire that disagrees with the queue it opens means one of the two is lying,
   which is the rule routes/retail.js already states for the Reviews row
   (REVIEW_WAITING_SQL, shared rather than copied). Same rule, same reason: this
   clause is required by both routes, never retyped in either.

   THE GRAIN IS THE LINE, NOT THE REQUEST (decisions §69). It was the request
   until 2026-09-08, and that was §61 half-carried: §61 split the kitchen's WORK
   to the line, `restock_orders.status` staying a rollup that only catches up
   once every line is done — so a request with one of three products made sat at
   `sent`, and every surface above stayed silent about a jar that was already on
   the shelf. Ash, from the queue screen showing one made of three: *"if only 1
   product marked as made, it wont show it on dashboard, thats a problem."* A
   finished product is news on its own, so the news is counted per product.

   WHY EACH LINE OF IT IS THERE — the reasoning lives with the SQL, because the
   next person to touch it will be reading this and not the route:

     to_role = 'kitchen'   this direction only. A warehouse→store transfer marked
                           prepared means the goods are packed and about to move,
                           which is a different sentence entirely.
     i.status prepared     the closure for this direction, read off the LINE.
     OR r.status prepared  THE LEGACY ARM, and it is what makes this clause a
                           strict superset of the order-level one it replaces
                           rather than a different set. §61's backfill copied
                           each line's status from its parent order on the MAIN
                           database only; a tenant file got the columns with
                           their plain 'sent' default and no data migration
                           (database.js restock_item_status_backfill_v1 says so
                           in full). Reading the rollup as well means a request
                           that closed before §61 shipped — or on a tenant that
                           never ran the backfill — still counts, because
                           _advanceOrderStatus guarantees an order at 'prepared'
                           has every line at 'prepared' whether or not the row
                           says so.
     archived_at IS NULL   archiving HIDES a row, and that is a different fact
                           from having read it.
     i.seen_at IS NULL     somebody has looked. Server-side rather than a
                           per-device stamp, so one person opening the list puts
                           it out for the whole warehouse — the property the
                           Orders dot has and the Inbox dot has never had.
     r.seen_at IS NULL     THE SECOND LEGACY ARM, and it is why nothing re-lights
                           on the deploy that ships this. Under the order-level
                           clause `seen_at` could only ever be stamped on a
                           request whose every line was done, so an order the
                           warehouse already acknowledged means all of its lines
                           were acknowledged with it. Dropping this arm would
                           relight months of read history as unread news.
     qty_requested > 0     a zero line is not a product. Both UIs already filter
                           these out of the lists they draw, and a fire counting
                           what neither screen shows is the same lie as a fire
                           that disagrees with its queue.
   ══════════════════════════════════════════════════════════════════════════ */

/* The FROM both clauses below are written against — named here rather than in
 * each caller, so a reader of one clause can see the aliases it uses. */
const KITCHEN_READY_FROM = `
  restock_items i JOIN restock_orders r ON r.id = i.restock_id`;

/* What the kitchen has finished, whether or not anybody has read it. The LIST
 * behind the fire — a record of what was made, which must still read that way
 * the day after somebody glanced at it. */
const KITCHEN_READY_MADE_WHERE = `
       COALESCE(r.to_role, 'warehouse') = 'kitchen'
   AND r.archived_at IS NULL
   AND (i.status IN ('prepared','delivered') OR r.status IN ('prepared','delivered'))
   AND COALESCE(i.qty_requested, 0) > 0`;

/* …and nobody has acknowledged. The COUNT behind the dot and the fire. */
const KITCHEN_READY_WHERE = `${KITCHEN_READY_MADE_WHERE}
   AND i.seen_at IS NULL
   AND r.seen_at IS NULL`;

/* WHEN THE NEWS BROKE — the line's own stamp, falling back to the order's.
 * A line carried no `prepared_at` of its own before §61, and one worked on a
 * tenant database that never ran the backfill still may not; the order's stamp
 * is then the only true thing anybody knows about when it was finished. Ages
 * on the fires read this, so it is defined once here rather than three times.
 */
const KITCHEN_READY_MADE_AT = `COALESCE(i.prepared_at, r.prepared_at)`;

/* THE MAKER IS NOT THE AUDIENCE.
 *
 * A fulfil-only operator is the person who marked it made. Telling them their
 * own work is waiting is telling them about themselves, so every surface that
 * reads the clause above answers them an honest zero rather than a 403 — these
 * are polled in the background, and a refusal there costs the client a bounce
 * to the login screen out of a pocket.
 *
 * Holding `restock:pick` as well means the operator is not confined to the
 * making side (routes/restock.js says the same about the warehouse preset), so
 * they are back in the audience.
 */
function kitchenScopedSession(req) {
  if (!req) return false;
  if (req.restockRealm === 'kitchen') return true;
  if (!req.caps) return false;
  return req.caps.has('restock:fulfil') && !req.caps.has('restock:pick');
}

/* WHO IS ASKED — the same pair routes/restock.js addresses the 'prepared' push
 * to, which is the people who raise these requests. Fails OPEN on unresolved
 * caps, matching every other cap read in this codebase's view layer: a null
 * caps set is "not resolved", not "denied".
 */
function canSeeKitchenReady(req) {
  if (!req || !req.caps) return true;
  return req.caps.has('restock:request') || req.caps.has('restock:pick');
}

module.exports = {
  KITCHEN_READY_FROM,
  KITCHEN_READY_MADE_WHERE,
  KITCHEN_READY_WHERE,
  KITCHEN_READY_MADE_AT,
  kitchenScopedSession,
  canSeeKitchenReady,
};
