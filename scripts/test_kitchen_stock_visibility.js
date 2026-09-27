#!/usr/bin/env node
/**
 * The kitchen's count, and the one correction it may make (decisions §46).
 *
 *   node scripts/test_kitchen_stock_visibility.js
 *
 * Add stock has never shown a quantity, enforced in three places rather than
 * merely unimplemented. §46 does not overturn that reasoning — production is
 * request-driven, and a visible shelf number invites a tray nobody asked for —
 * it narrows it: the reasoning assumed the shelf is somewhere the kitchen
 * cannot see, and at Tianhe the kitchen shares the building.
 *
 * So the decision moved from the JOB TITLE onto the `quickstock:recount`
 * capability, and everything below is either that predicate or what the screen
 * does on each side of it. The rules asserted here are all quiet when broken:
 *
 *   • WITHOUT THE GRANT, NOTHING CHANGED. No count, no correction door, and a
 *     delta is still the only write. A regression here is invisible to the
 *     kitchen it affects and visible to nobody else.
 *   • THE GRANT IS AN OPERATOR-REALM GRANT. A store-pinned kitchen-realm
 *     staffer must stay stripped even though the legacy path hands that realm
 *     the full capability set — a capability test alone would open every
 *     kitchen at once, which is the opposite of a per-tenant grant.
 *   • A DROP IS NEVER SAVED UNASKED, and the answer that says something is
 *     actually gone writes NOTHING. The kitchen records no waste; a shelf
 *     figure drops because a loss was recorded by someone entitled to record
 *     one, never instead of that.
 *   • A RISE ASKS NOTHING. Ruled that way against the symmetry argument, so a
 *     question appearing here is a silent reversal of a decision.
 *   • THE TWO WRITES STAY TWO. A correction sends an absolute physical_qty; a
 *     batch sends a delta. The moment one can produce the other, every yield
 *     figure downstream becomes a guess.
 *
 * The predicate pass needs nothing. The render pass needs a Chromium — set
 * CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const failures = [];
const fail = (name, msg) => failures.push([name, msg]);

// ── The predicate, on its own, with no server and no browser ──────────────
// It lives in lib/ for exactly this reason: three routes read it and they must
// agree, and a GET that strips quantities while a PATCH accepts an absolute
// count is not a half-open door but two policies wearing one name.
const grant = require('../lib/quick-stock-grant');

const caps = (...keys) => new Set(keys);
const KITCHEN_OP = { backendUser: { role: 'kitchen', retail_store_id: 1 }, user: { role: 'kitchen' } };
const granted = Object.assign({}, KITCHEN_OP, { caps: caps('quickstock:add', 'quickstock:recount') });
const ungranted = Object.assign({}, KITCHEN_OP, { caps: caps('quickstock:add') });
// The other realm: a plain users row pinned to a store by retail_store_id, with
// no `retail` permission — admitted by requireInventoryRead, and handed the
// FULL capability set by the legacy path in requireRetailAdmin.
const legacyKitchen = { user: { role: 'kitchen' }, caps: caps('quickstock:add', 'quickstock:recount') };
const clerk = { backendUser: { role: 'store_stock', retail_store_id: 1 }, user: { role: 'store_stock' },
  caps: caps('quickstock:recount') };
const owner = { backendUser: { role: 'owner' }, user: { role: 'owner' }, caps: caps('quickstock:recount') };

const P = 'predicate';
if (grant.quickStockMode(ungranted) !== 'add') fail(P, 'a kitchen operator is not in add mode');
if (grant.quickStockMode(granted) !== 'add') fail(P, 'the grant moved a kitchen operator out of add mode');
if (grant.quickStockMode(clerk) !== 'recount') fail(P, 'a store_stock clerk is not in recount mode');
if (grant.quickStockMode(owner) !== 'recount') fail(P, 'an owner is not in recount mode');
if (grant.quickStockMode(legacyKitchen) !== 'add') fail(P, 'a store-pinned kitchen staffer is not in add mode');

if (!grant.addOnlyOperator(ungranted)) fail(P, 'an ungranted kitchen operator is not add-only');
if (grant.addOnlyOperator(granted)) fail(P, 'the grant did not lift add-only');
if (grant.addOnlyOperator(clerk)) fail(P, 'a clerk was treated as add-only');
// The whole point of requiring req.backendUser: this realm holds the capability
// and must still be refused, or the grant stops being per-tenant.
if (!grant.addOnlyOperator(legacyKitchen)) {
  fail(P, 'a kitchen-realm staffer got the grant from the full cap set the legacy path hands out');
}
if (grant.mayRecount(Object.assign({}, KITCHEN_OP, { caps: null }))) {
  fail(P, 'a missing cap set was read as a grant');
}
/* WHO MAY RECORD A BATCH (§59). The mode cannot answer this and never could:
   the owner below is in RECOUNT mode and can post to /api/retail-admin/production
   all day, which is exactly how the kitchen queue's handover came to be shut for
   every operator on /stock except one role. */
const owner2 = { backendUser: { role: 'owner' }, user: { role: 'owner' },
  caps: caps('quickstock:recount', 'production:log') };
const fulfilOnly = Object.assign({}, KITCHEN_OP, { caps: caps('quickstock:add', 'restock:fulfil') });
if (!grant.mayLogProduction(owner2)) {
  fail(P, 'a recount-mode operator holding production:log was refused the record screen');
}
if (grant.quickStockMode(owner2) !== 'recount') fail(P, 'the owner stopped being the recount case');
if (!grant.mayLogProduction(Object.assign({}, KITCHEN_OP, { caps: caps('production:log') }))) {
  fail(P, 'a kitchen operator holding the capability was refused');
}
if (grant.mayLogProduction(fulfilOnly)) {
  fail(P, 'an operator without production:log was offered a screen whose Record 403s');
}
// No backendUser requirement, unlike mayRecount: this realm can genuinely post
// to the endpoint, and refusing it would shut the screen to the very operator
// the flow exists for.
if (!grant.mayLogProduction({ user: { role: 'kitchen' }, caps: caps('production:log') })) {
  fail(P, 'a store-pinned kitchen staffer was refused a write the endpoint accepts');
}
// Fails OPEN, as Tacet Mobile's mCan() does, and for the reason it gives.
if (!grant.mayLogProduction(Object.assign({}, KITCHEN_OP, { caps: null }))) {
  fail(P, 'a resolution hiccup locked an operator out of their own screen');
}

if (grant.RECOUNT_MISCOUNT !== 'miscount') fail(P, 'the fork answer changed name without the client');

// ── What went on the shelf today, and who put it there ────────────────────
// The fold lives in lib/ so these rules can be exercised without a database.
// Every one of them is quiet when broken: a wrong total reads as a plausible
// total, and a missing name reads as an add nobody made.
const { summariseKitchenAdds } = require('../lib/kitchen-adds');
const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-09-06T05:00:00Z');          // 13:00 in Shanghai
const row = (o) => Object.assign(
  { product_id: 7, delta: 1, actor_label: 'Ah Ming', created_at: '2026-09-06 02:00:00' }, o);

const A = 'added-today';
{
  const one = summariseKitchenAdds([row({ delta: 6 })], TZ, NOW);
  if (!one[7] || one[7].qty !== 6) fail(A, `one add should total 6, got ${JSON.stringify(one[7])}`);
  if (String((one[7] || {}).who) !== 'Ah Ming') fail(A, 'the one who added it is not named');

  // TWO PEOPLE ON THE SAME PRODUCT is the case the line exists for: the second
  // needs to see the first already did it, so BOTH are named.
  const two = summariseKitchenAdds([
    row({ delta: 6 }),
    row({ delta: 8, actor_label: 'Lily', created_at: '2026-09-06 03:00:00' }),
    row({ delta: 1, created_at: '2026-09-06 04:00:00' }),
  ], TZ, NOW);
  if (two[7].qty !== 15) fail(A, `two people should total 15, got ${two[7].qty}`);
  if (two[7].who.join(',') !== 'Ah Ming,Lily') {
    fail(A, `expected both names in the order they first added, got ${two[7].who.join(',')}`);
  }

  // AN ADD NOBODY CAN BE NAMED FOR IS STILL AN ADD — dropping it would make the
  // figure disagree with the shelf, which is worse than an unattributed number.
  const anon = summariseKitchenAdds([row({ delta: 5, actor_label: null })], TZ, NOW);
  if (anon[7].qty !== 5) fail(A, 'an unnamed add lost its units');
  if (anon[7].who.length) fail(A, 'an unnamed add invented a name');

  // YESTERDAY IS NOT TODAY, and the day is the STORE's. 2026-09-05 17:00 UTC is
  // already the 6th in Shanghai, so the boundary is the one being tested here
  // rather than UTC midnight.
  const days = summariseKitchenAdds([
    row({ delta: 4, created_at: '2026-09-04 02:00:00' }),
    row({ delta: 3, created_at: '2026-09-05 17:00:00' }),
  ], TZ, NOW);
  if (!days[7] || days[7].qty !== 3) {
    fail(A, `only the store's own today should count, got ${JSON.stringify(days[7])}`);
  }

  // Only what was ADDED. The route refuses a negative delta, but this reads the
  // ledger rather than the route, and a total that could go down is not "added".
  const neg = summariseKitchenAdds([row({ delta: -4 }), row({ delta: 0 })], TZ, NOW);
  if (Object.keys(neg).length) fail(A, 'a non-positive delta reached the figure');

  if (Object.keys(summariseKitchenAdds([], TZ, NOW)).length) fail(A, 'an empty ledger invented a row');
  if (Object.keys(summariseKitchenAdds(null, TZ, NOW)).length) fail(A, 'a missing ledger threw or invented a row');
}

/* ── The screen ────────────────────────────────────────────────────────────
   DELETED WITH THE APP IT RENDERED (§48 step 4). This section drove
   public/stock.html headlessly through eleven states to prove §46's rule — that
   a kitchen operator never sees the shelf total, only their own +N. The page is
   gone; every screen it held is in Tacet Mobile.

   THE PROPERTY IS NOT LOST, WHICH IS THE ONLY REASON THIS COULD GO:
   scripts/test_mobile_addstock.js asserts the same rule on the surface that now
   carries it — "the shelf total never reaches the screen", "the count starts at
   +0", "11 is nowhere on it" — against public/m.html's own Add stock screen.
   What survives HERE is the half that was never about a browser: the predicate
   and today's adds. (The door went with the lockdown, §277.) Both still run. */

if (failures.length) {
  for (const [n, m] of failures) console.log(`FAIL ${n} — ${m}`);
  process.exit(1);
}
console.log("ok — predicate and today's adds.");
