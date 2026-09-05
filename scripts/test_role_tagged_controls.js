#!/usr/bin/env node
/**
 * test_role_tagged_controls.js — the controls a role cannot use (audit K-01).
 *
 *   node scripts/test_role_tagged_controls.js
 *
 * THE FINDING: "Fifty-eight controls out of nearly two thousand are tagged by
 * role… once a role can open a screen, they see essentially all of it — a
 * shop-floor member of staff opening Orders sees every button an owner sees,
 * including refunds." Its suggested direction is deliberately narrow, and so is
 * this: "tag the actions that matter — refunds, price changes, payouts,
 * deletions — not every control."
 *
 * ── THE ONE RULE THIS SUITE EXISTS TO ENFORCE ─────────────────────────────
 * A TAG MUST NAME THE CAPABILITY THE SERVER ALREADY REQUIRES OF THE ENDPOINT
 * THAT CONTROL CALLS. Not a plausible one, not a stricter one somebody thought
 * would be safer — the one `requiredCapFor(method, path)` answers, computed
 * here from lib/cap-routes.js rather than copied. That is what makes this a
 * change to what is SHOWN and not a change to what is ALLOWED: every button
 * tagged below was already refused by the server for exactly the operators it
 * now hides from, and nothing that was permitted has become forbidden.
 *
 * A gate that hides a control the server would have accepted is the failure
 * mode worth naming: it takes work away from somebody who was entitled to do
 * it, silently, and they have no way to tell it from a bug. The table below is
 * the whole set, each row naming the request its control makes, and the
 * assertion is the pairing.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
 * The ~50 routes `requiredCapFor()` maps to nothing, and the server-side gap
 * this work uncovered: a FULL refund travels through PATCH /orders/:id/status,
 * which answers `orders:edit`, so the server would accept one from a cashier
 * today. Both are decisions about what an account may DO, and this pass was
 * scoped to what it is SHOWN. The refund menu's own comment records the gap
 * where somebody changing it will read it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { requiredCapFor } = require(path.join(ROOT, 'lib', 'cap-routes'));
const { CAPABILITIES } = require(path.join(ROOT, 'lib', 'capabilities'));

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* Each row: the file, a fragment that must appear in it carrying the tag, the
   capability tagged, and the request the control actually makes. The fragment
   is matched literally, so a control that is moved keeps its row and a control
   that is deleted fails loudly rather than leaving a rule nobody enforces. */
const TAGGED = [
  { file: 'public/retail-admin/04-orders.js', cap: 'orders:refund',
    at: 'data-cap="orders:refund" onclick="refundReview(',
    calls: ['POST', '/api/retail-admin/orders/1/refund/review'], srcPath: '/refund/review',
    what: 'Start review, on a refund request' },
  { file: 'public/retail-admin/04-orders.js', cap: 'orders:refund',
    at: 'data-cap="orders:refund" onclick="openRefundApproveDialog(',
    calls: ['POST', '/api/retail-admin/orders/1/refund/approve'], srcPath: '/refund/approve',
    what: 'Approve a refund' },
  { file: 'public/retail-admin/04-orders.js', cap: 'orders:refund',
    at: 'data-cap="orders:refund" onclick="rejectRefund(',
    calls: ['POST', '/api/retail-admin/orders/1/refund/reject'], srcPath: '/refund/reject',
    what: 'Reject a refund' },
  { file: 'public/retail-admin/04-orders.js', cap: 'orders:refund',
    at: 'data-cap="orders:refund" onclick="openRefundPayoutDialog(',
    calls: ['POST', '/api/retail-admin/orders/1/refund/payout'], srcPath: '/refund/payout',
    what: 'Record a payout — money out of the door' },
  { file: 'public/retail-admin.html', cap: 'products:delete',
    at: 'data-cap="products:delete" onclick="pdDelete()',
    calls: ['DELETE', '/api/retail-admin/products/1'], srcPath: "'/api/retail-admin/products/' + id",
    what: 'Delete a product' },
  { file: 'public/retail-admin/06-delivery.js', cap: 'delivery:delete',
    at: 'data-cap="delivery:delete" title="Delete · 删除"',
    calls: ['DELETE', '/api/retail-admin/delivery-zones/1'], srcPath: '/api/retail-admin/delivery-zones/${id}',
    what: 'Delete a delivery zone' },
  { file: 'public/retail-admin/05-marketing.js', cap: 'coupons:grant',
    at: 'data-cap="coupons:grant" onclick="revokeGrant(',
    calls: ['DELETE', '/api/retail-admin/voucher-grants/1'], srcPath: '/api/retail-admin/voucher-grants/',
    what: 'Revoke a coupon somebody already holds' },
];

// ── §1 · every tag is the server's own answer ─────────────────────────────
section('1 · a tag names the capability the server already requires');

const KEYS = new Set(CAPABILITIES.map((c) => c.key));
// Every admin bundle, concatenated once: the paths below are searched in it so
// a row cannot name an endpoint the product does not use.
const TAG_HAYSTACK = fs.readdirSync(path.join(ROOT, 'public/retail-admin'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => read('public/retail-admin/' + f)).join('\n') + read('public/retail-admin.html');
for (const t of TAGGED) {
  const src = read(t.file);
  yes(src.includes(t.at), `${t.what} — the control is there and carries a tag`, t.at);
  yes(KEYS.has(t.cap), `${t.cap} is a real capability, not a name somebody invented`);
  const server = requiredCapFor(t.calls[0], t.calls[1]);
  is(server, t.cap,
     `${t.what} — the tag matches what the server requires of ${t.calls[0]} ${t.calls[1]}`);
  /* …and the path in that row is one this admin actually calls, matched as the
     literal the call site is written with. Without this the pairing above could
     be a tag checked against an endpoint nobody uses, which would pass for ever
     and prove nothing — the way `customers:adjust` looked right until the two
     Adjust buttons turned out to call /points-adjust, which the server maps to
     customers:edit. */
  yes(TAG_HAYSTACK.includes(t.srcPath),
      `${t.what} — and that path is one the admin really calls`, t.srcPath);
}

// ── §2 · the actions that matter, and only those ──────────────────────────
section('2 · the tagged set is the one the audit named');

{
  // Refunds, payouts, deletions and money adjustments — the four the audit
  // listed. Each is a capability lib/capabilities.js itself marks as moving
  // money, or a `:delete`, which is the same idea for records.
  const byKey = new Map(CAPABILITIES.map((c) => [c.key, c]));
  for (const cap of [...new Set(TAGGED.map((t) => t.cap))]) {
    const c = byKey.get(cap);
    yes(c && (c.money === 'moves' || /:delete$/.test(cap)),
        `${cap} is one of the consequential ones — money that moves, or a record that goes`,
        c ? JSON.stringify({ money: c.money }) : 'not a capability');
  }
}

// ── §3 · a tag on a control that never gets gated is decoration ───────────
section('3 · every screen that renders a tag runs the gate afterwards');

{
  // applyCapGates() makes ONE pass over [data-cap] at load. Anything built
  // later — a drawer, a row, a list — is built after that pass, so its tags do
  // nothing unless the render calls the gate again. A tag that never gets
  // applied is worse than no tag: it reads, to the next person, as a control
  // that is already handled.
  const NEEDS_REAPPLY = [
    ['public/retail-admin/04-orders.js', 'the order drawer'],
    ['public/retail-admin/06-delivery.js', 'the delivery-zone table'],
    ['public/retail-admin/05-marketing.js', 'the issued-coupon list'],
  ];
  is(TAGGED.length, 7, 'seven controls carry a tag — the consequential ones, not every control');
  for (const [file, what] of NEEDS_REAPPLY) {
    const src = read(file);
    yes(/applyCapGates\s*===\s*'function'|applyCapGates\(\)/.test(src),
        `${what} re-runs the gate after it renders`);
  }
  // The product delete button is in the shell's own markup, so the load-time
  // pass covers it and no re-run is needed — asserted rather than assumed.
  const shell = read('public/retail-admin.html');
  const at = shell.indexOf('data-cap="products:delete"');
  // Static markup means: in the document, not inside one of the page's inline
  // <script> blocks (where it would be a template literal built at render time
  // and would need the gate re-run like the four above).
  const inScript = (() => {
    let from = 0;
    for (;;) {
      const open = shell.indexOf('<script', from);
      if (open < 0 || open > at) return false;
      const close = shell.indexOf('</script>', open);
      if (close < 0) return true;
      if (at > open && at < close) return true;
      from = close + 1;
    }
  })();
  yes(at > 0 && !inScript,
      'the product delete button is static markup, which the load-time pass already covers');
}

// ── §3b · the capability that is not enforced ─────────────────────────────
section('3b · the one that was NOT tagged, and why');

{
  /* `customers:adjust` looked like the obvious fifth row: it exists, the role
     editor offers it, and lib/capabilities.js marks it `money: 'moves'`. But
     the two Adjust buttons on a customer record call /points-adjust and
     /wallet-adjust, and lib/cap-routes.js maps those to `customers:edit` — so
     the capability is not enforced on them. Tagging them would have hidden a
     control the server accepts, which is the failure this suite's header names.

     Left alone, and pinned here so the day somebody closes the gap on the
     server this fails and the tag can go on. */
  const byKey = new Map(CAPABILITIES.map((c) => [c.key, c]));
  yes(byKey.has('customers:adjust'), 'customers:adjust is a real capability');
  is(byKey.get('customers:adjust').money, 'moves', 'and it is one that moves money');
  is(requiredCapFor('POST', '/api/retail-admin/customers/1/points-adjust'), 'customers:edit',
     'but the endpoint the Adjust button calls is mapped to customers:edit, so nothing enforces it');
  const cust = read('public/retail-admin/08-customers.js');
  yes(!/data-cap="customers:adjust"/.test(cust),
      'so the button is NOT tagged with it — a gate stricter than the server takes work away from somebody entitled to do it');
  yes(/NOT TAGGED, and that is a finding/.test(cust),
      'and the reason is written where the next person will change it');
}

// ── §4 · the gate hides, and never decides ────────────────────────────────
section('4 · nothing here is a security boundary, and the code says so');

{
  const core = read('public/retail-admin/01-core.js');
  yes(/style\.display/.test(core), 'applyCapGates only sets display — it removes nothing and blocks nothing');
  yes(/if \(!CAPS\)/.test(core) || /CAPS === null/.test(core) || /!CAPS\b/.test(core),
      'and fails OPEN while the capability list has not arrived, so a slow read never locks an owner out of their own admin');
  const caps = read('lib/cap-routes.js');
  yes(/security-critical/.test(caps),
      'the server-side map is the boundary, and lib/cap-routes.js says so in its own header');
}

// ── §5 · the two the audit named, refused where they used to render ───────
section('5 · the refund menu the audit used as its example');

{
  const ord = read('public/retail-admin/04-orders.js');
  yes(/const DANGER_CAP = \{ refunded: 'orders:refund', cancelled: 'orders:edit' \}/.test(ord),
      'refunding and cancelling are separated: two actions, two capabilities');
  yes(/\.filter\(\(\[next\]\) => \(typeof can === 'function' \? can\(DANGER_CAP\[next\]\) : true\)\)/.test(ord),
      'and the menu is built from what THIS operator may do, rather than tagged — a wrapper that opens onto nothing is worse than no wrapper');
  const at = ord.indexOf('const DANGER_CAP');
  const note = ord.slice(Math.max(0, at - 1400), at);
  yes(/THIS CHANGES NO SERVER RULE/.test(note),
      'the comment records that this changes nothing about what is allowed');
  yes(/orders:edit/.test(note) && /server-side gap/.test(note),
      'and names the server-side gap it deliberately leaves alone, where somebody changing this will read it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
