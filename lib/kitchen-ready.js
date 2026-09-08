'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   "THE KITCHEN FINISHED IT" — ONE DEFINITION, THREE READERS.
   ──────────────────────────────────────────────────────────────────────────
   warehouse→kitchen is the one direction with no second leg: nothing travels,
   so 'prepared' IS the closure. The kitchen puts what it makes straight on the
   shelf and records the stock itself — nobody collects anything, and the only
   thing the warehouse needs is to KNOW.

   Three surfaces now say so, and they must never disagree about which requests
   count:

     • GET /api/restock/kitchen-ready          — the phone's dot (routes/restock.js)
     • GET .../dashboard/ops → kitchen_ready   — the Needs-you row on the PC
                                                 dashboard AND on the phone's
                                                 Home (routes/retail.js)
     • the list itself, at /stock?go=ready     — which stamps `seen_at`

   A fire that disagrees with the queue it opens means one of the two is lying,
   which is the rule routes/retail.js already states for the Reviews row
   (REVIEW_WAITING_SQL, shared rather than copied). Same rule, same reason: this
   clause is required by both routes, never retyped in either.

   WHY EACH LINE OF IT IS THERE — the reasoning lives with the SQL, because the
   next person to touch it will be reading this and not the route:

     to_role = 'kitchen'   this direction only. A warehouse→store transfer marked
                           prepared means the goods are packed and about to move,
                           which is a different sentence entirely.
     status = 'prepared'   the closure for this direction.
     archived_at IS NULL   archiving HIDES a row, and that is a different fact
                           from having read it.
     seen_at IS NULL       somebody has looked. Server-side rather than a
                           per-device stamp, so one person opening the list puts
                           it out for the whole warehouse — the property the
                           Orders dot has and the Inbox dot has never had.
   ══════════════════════════════════════════════════════════════════════════ */
const KITCHEN_READY_WHERE = `
       COALESCE(to_role, 'warehouse') = 'kitchen'
   AND status = 'prepared'
   AND archived_at IS NULL
   AND seen_at IS NULL`;

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

module.exports = { KITCHEN_READY_WHERE, kitchenScopedSession, canSeeKitchenReady };
