// WHO IS IN ADD MODE, AND WHO MAY ALSO COUNT.
//
// The kitchen's Add stock flow and the shelf clerk's recount are the same app
// in two modes. Until decisions §46 the server decided which by JOB TITLE — a
// literal `role === 'kitchen'` repeated in three routes — and that is why the
// behaviour was all-or-nothing: a kitchen operator could never be told anything
// about the shelf, whatever their tenant wanted, because the only lever was the
// role name itself.
//
// §46 moves the decision onto the CAPABILITY. `quickstock:recount` already
// exists, is already held by the `store_stock` preset and is already accepted
// by lib/cap-routes for these routes; a tenant whose kitchen shares a building
// with the shelf — Roots' does, and lib/capabilities says so in the note on
// `restock:fulfil` — ticks it onto the kitchen role and nothing else changes.
// It is absent from the kitchen preset and stays absent, so an off-site
// kitchen, the case the original behaviour was written for, is untouched.
//
// PULLED OUT OF THE ROUTE FILE so it can be tested without booting the server,
// for the reason lib/stock-app-only.js gives for the same move: this predicate
// IS the decision. Three routes read it and they must agree — a GET that strips
// quantities while a PATCH accepts an absolute count is not a half-open door,
// it is two different policies wearing one name.
'use strict';

/* THE FORK'S SAVING ANSWER, and the whole vocabulary a kitchen correction may
   carry (§46). One word, deliberately: the waste codes live on the production
   gap and on the waste screens, and neither is reachable from a correction. */
const RECOUNT_MISCOUNT = 'miscount';

// 'add' (kitchen: log what you made) | 'recount' (warehouse: set the count).
// Mirrors what /quick-stock/context sends the client, and is the same function
// that answers it — one derivation, so the app and the routes cannot disagree
// about which mode an operator is in.
function quickStockMode(req) {
  const backendRole = req.backendUser && req.backendUser.role;
  const kitchenOp = backendRole === 'kitchen';
  const restrictedOp = kitchenOp || backendRole === 'store_stock';
  const fullAccess = !restrictedOp && (
    !!req.backendUser || req.user?.role === 'admin' || !!req.permissions?.retail
  );
  return (kitchenOp || (!fullAccess && req.user?.role === 'kitchen')) ? 'add' : 'recount';
}

/* THE GRANT IS DELIBERATELY NARROWED TO THE OPERATOR REALM.
   `requireInventoryRead` also admits a plain `users` row that merely carries a
   retail_store_id, and the legacy kitchen path in requireRetailAdmin hands that
   realm the FULL capability set — so a capability test alone would open the
   shelf to every kitchen-realm staffer at once, which is the opposite of a
   per-tenant grant. Requiring req.backendUser keeps the grant somewhere the
   tenant can see it and take it away. */
function mayRecount(req) {
  return !!req.backendUser && !!req.caps && req.caps.has('quickstock:recount');
}

// Add mode WITHOUT the grant: quantities are stripped and only a delta is
// accepted. The pre-§46 kitchen contract, now keyed on the grant rather than
// the role — which also closes the hole where a store-pinned kitchen-realm
// staffer received quantities the client merely declined to draw.
function addOnlyOperator(req) {
  return quickStockMode(req) === 'add' && !mayRecount(req);
}

module.exports = { quickStockMode, mayRecount, addOnlyOperator, RECOUNT_MISCOUNT };
