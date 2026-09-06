#!/usr/bin/env node
/**
 * Two capabilities that existed, were offered in the role editor, and gated
 * nothing — audit K-01.
 *
 * Both were recorded as findings rather than omissions and deliberately left
 * open, because closing either changes what an account may DO rather than what
 * it is shown. Ash ruled on 2026-09-06 that both should close. This suite is
 * what holds them closed.
 *
 * §1 · `customers:adjust` NEVER MATCHED ITS OWN ENDPOINTS. The rule read
 * `/(points|wallet|credit|balance|adjust)(\/|$)/` — a slash or the end of the
 * path after the word. The two endpoints that move a customer's money are
 * `/customers/:id/points-adjust` and `/customers/:id/wallet-adjust`, where a
 * HYPHEN follows, so neither matched and both fell through to `customers:edit`.
 * Anyone who could edit a customer could add store credit or points to any
 * account. It is the same hyphen bug the refund rule in the same file already
 * carries a note about — "the old /refund(\/|$) missed the hyphen form" — found
 * once, fixed once, and left in the line above it.
 *
 * §2 · A FULL REFUND WAS `orders:edit`. It travels through PATCH
 * /orders/:id/status with `refunded` in the body, and that path maps to
 * orders:edit — what a cashier holds to work the till. The capability cannot be
 * read from the path, so the choke point, which is given (method, path) and
 * nothing else, could not see it. The client hid the button correctly; the
 * server accepted the request.
 *
 * §3 IS THE HALF THAT MATTERS MOST. A permission change is only safe if it
 * refuses the right people and NOBODY ELSE. Enforcement is per-tenant and
 * off by default, owners bypass entirely, and an unresolved capability set
 * fails OPEN — so a shop that has not switched RBAC on sees no change at all
 * from this commit. Each of those is asserted rather than assumed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { requiredCapFor, capDenied } = require(path.join(ROOT, 'lib', 'cap-routes'));
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const CAPS = fs.readFileSync(path.join(ROOT, 'lib', 'capabilities.js'), 'utf8');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

// ─────────────────────────────────────────────────────────────────────────
section('1 · moving a customer\'s money needs the capability that means that');

is(requiredCapFor('POST', '/api/retail-admin/customers/12/points-adjust'), 'customers:adjust',
  'points-adjust — the hyphen form the old rule missed');
is(requiredCapFor('POST', '/api/retail-admin/customers/12/wallet-adjust'), 'customers:adjust',
  'wallet-adjust — the same');

/* AND NOTHING ELSE MOVED. Widening a pattern is how a fix becomes a lockout:
   every other customer route must answer exactly what it answered before. */
for (const [p, want] of [
  ['/api/retail-admin/customers/12', 'customers:edit'],
  ['/api/retail-admin/customers/12/message', 'customers:edit'],
  ['/api/retail-admin/customers/12/addresses', 'customers:edit'],
  ['/api/retail-admin/customers/12/referral-code', 'customers:edit'],
  ['/api/retail-admin/customers/12/block', 'customers:block'],
  ['/api/retail-admin/customers/12/unblock', 'customers:block'],
]) {
  is(requiredCapFor('POST', p), want, `${p.replace('/api/retail-admin', '')} still answers ${want}`);
}

/* The capability is real and is marked as money in the role editor — if it
   were not, gating on it would hide the control from people the editor never
   offered it to. */
yes(/'customers:adjust'[^\n]*money: 'moves'/.test(CAPS),
  "customers:adjust is declared, and marked money:'moves'");

// ─────────────────────────────────────────────────────────────────────────
section('2 · a full refund needs orders:refund, whichever control issues it');

const staff = { tenant: { rbac_enforce: 1 }, backendUser: { role: 'staff' }, caps: new Set(['orders:view', 'orders:edit', 'till:use']) };
yes(capDenied(staff, 'orders:refund'), 'a cashier holding orders:edit is refused orders:refund');
is(capDenied(staff, 'orders:edit'), false, '…and is NOT refused the capability they do hold');

yes(/status === 'refunded' && capRoutes\.capDenied\(req, 'orders:refund'\)/.test(RETAIL),
  'the status handler asks before it refunds');
yes(/forbidden_capability[^\n]*orders:refund/.test(RETAIL),
  '…and refuses with the same error shape the choke point uses');

/* CANCELLED IS DELIBERATELY STILL orders:edit. A cashier cancels all day, and
   narrowing that would take a daily task from the role that exists to do it.
   Asserted so the choice is visible rather than looking like an oversight. */
{
  const h = RETAIL.slice(RETAIL.indexOf("router.patch('/api/retail-admin/orders/:id/status'"));
  const gate = h.slice(0, h.indexOf('const o = tdb()'));
  is(/status === 'cancelled' && capRoutes\.capDenied/.test(gate), false,
    'cancelling is NOT newly gated — that would be a different decision');
}

/* The path-based rule is unchanged: it still answers orders:edit, because it is
   right for every other transition on this route. The body check is additive. */
is(requiredCapFor('PATCH', '/api/retail-admin/orders/12/status'), 'orders:edit',
  'the path rule still answers orders:edit for the route as a whole');
is(requiredCapFor('POST', '/api/retail-admin/orders/12/refund'), 'orders:refund',
  '…and the dedicated refund route is unchanged');

// ─────────────────────────────────────────────────────────────────────────
section('3 · and it refuses nobody it should not');

/* Every one of these is a shop that must see NO change from this commit. */
is(capDenied({ tenant: { rbac_enforce: 0 }, backendUser: { role: 'staff' }, caps: new Set() }, 'orders:refund'), false,
  'a tenant that has not switched RBAC on is untouched — which is every tenant by default');
is(capDenied({ tenant: { rbac_enforce: 1 }, backendUser: { role: 'owner' }, caps: new Set() }, 'orders:refund'), false,
  'the owner bypasses, exactly as they do at the choke point');
is(capDenied({ tenant: { rbac_enforce: 1 }, backendUser: { role: 'staff' }, caps: null }, 'orders:refund'), false,
  'an unresolved capability set fails OPEN — a resolution failure must not lock out a working operator');
is(capDenied({ caps: new Set() }, 'orders:refund'), false,
  'the kitchen path, which carries no tenant row, is unaffected');
is(capDenied(null, 'orders:refund'), false, 'a missing request is not a denial');
is(capDenied({ tenant: { rbac_enforce: 1 }, backendUser: { role: 'staff' }, caps: new Set(['orders:refund']) }, 'orders:refund'), false,
  'and an operator who HOLDS the capability is allowed through');

/* capDenied must mirror the choke point rather than restate it loosely — two
   almost-identical rules is how the two come to disagree. */
{
  const choke = RETAIL.slice(RETAIL.indexOf('RBAC ENFORCEMENT (Phase 2)'), RETAIL.indexOf('Store scope —'));
  yes(/tenant\.rbac_enforce && u\.role !== 'owner' && req\.caps/.test(choke),
    'the choke point still gates on enforce-on + not-owner + caps-resolved');
}

// ─────────────────────────────────────────────────────────────────────────
section('4 · the same hyphen bug, one line further down, NOT fixed here');

/* Found by grepping the pattern rather than the finding, per the house rule
   that a file:line is where a problem was found and not its extent.

   `/customers/:id/affiliate-block` and `/affiliate-unblock` miss the
   `(block|unblock|logout|force-logout)(\/|$)` rule for exactly the reason the
   adjust rule missed its own: a hyphen precedes the word. They fall through to
   `customers:edit`.

   NOT CLOSED, because it was not part of what was ruled on, it moves no money,
   and narrowing it would newly refuse operators who can do it today. Pinned
   here so it is a known item with a test naming it rather than a rediscovery. */
is(requiredCapFor('POST', '/api/retail-admin/customers/12/affiliate-block'), 'customers:edit',
  'affiliate-block still answers customers:edit — the same hyphen bug, deliberately left');
is(requiredCapFor('POST', '/api/retail-admin/customers/12/affiliate-unblock'), 'customers:edit',
  '…and so does affiliate-unblock');

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
