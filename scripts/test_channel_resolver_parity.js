// The two channel resolvers do not drift apart unnoticed
// (npm run test:resolver-parity).
//
// WHY THIS EXISTS
// ---------------
// routes/eleme-internal.js and routes/meituan-internal.js are parallel copies of
// each other, deliberately: the two platforms word their statuses and shape their
// payloads differently, and a shared implementation would make one channel's fix
// a risk to the other. Both files say so in their own headers.
//
// The cost of that choice, paid twice and both times in stock:
//
//   • THE SKU TOKEN. meituan-internal has always dug an "N-N" code out of a
//     listing title when the platform sent no 货号. eleme-internal had no such
//     step, so those lines fell through to the name match and died there.
//     EL20260907878862 deducted nothing at all. Fixed in PR #393.
//   • THE OVERSELL. meituan-internal has flagged a line the shelf could not
//     cover since it was written. eleme-internal never did, so six Eleme
//     oversells were recorded as Δ0 ledger rows and nothing else.
//
// Both were invisible for months, and neither was found by a test — they were
// found by a person noticing the stock numbers were wrong. THIS is the test that
// would have caught them on the day the gap opened.
//
// WHAT IT ASSERTS, and what it deliberately does not
// --------------------------------------------------
// It does NOT demand the two files be identical, or that they agree on statuses,
// payload keys, or wording — those are the differences the copies exist for.
// It asserts only that a short list of STOCK-AFFECTING CAPABILITIES is present in
// both. Each entry names one behaviour, and a pattern per channel that evidences
// it. When a future change adds a matching step to one resolver and not the
// other, this suite says so, by name, in the failure.
//
// A capability that genuinely should live in only one channel is not a bug — it
// is an entry to delete from this list, in a commit that says why.
//
// Run: node scripts/test_channel_resolver_parity.js

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const eleme = fs.readFileSync(path.join(REPO, 'routes', 'eleme-internal.js'), 'utf8');
const meituan = fs.readFileSync(path.join(REPO, 'routes', 'meituan-internal.js'), 'utf8');

// One entry per stock-affecting behaviour both ingests must have. The patterns
// are evidence, not implementation: each is the smallest thing that is true of a
// file which HAS the behaviour and false of one that does not.
const CAPABILITIES = [
  {
    what: 'reads an inline "N-N" SKU token out of the listing title',
    why: 'the gap that made EL20260907878862 deduct nothing (PR #393)',
    eleme: /match\(\/\\d\+-\\d\+\/\)/,
    meituan: /match\(\/\\d\+-\\d\+\/\)/,
  },
  {
    what: 'falls back from an unresolved SKU rather than stranding the line',
    why: 'a stale or mistyped code must not stop the map and name branches running',
    eleme: /sku_unknown/,
    meituan: /sku_unknown/,
  },
  {
    what: 'resolves a claimed 规格 before anything else, so a pack keeps its size',
    why: "a pack option's code is a variant of the base one; resolving on the code alone loses which pack it was",
    eleme: /claimForLine\(/,
    meituan: /claimForLine\(/,
  },
  {
    what: 'lends a pack size to a non-claim match when the product has exactly one claim',
    why: 'otherwise a six-pack sold by name takes one unit off the shelf instead of six',
    eleme: /fallbackUnits\(/,
    meituan: /fallbackUnits\(/,
  },
  {
    what: 'deducts through the ledgered adjuster, per matched line',
    why: 'the ledger row and the channel re-push both hang off this call',
    eleme: /inventory\.adjustStock\(/,
    meituan: /inventory\.adjustStock\(/,
  },
  {
    what: 'converts a pack option into units off the shelf',
    why: 'one six-pack is one line of one, and six off the shelf',
    eleme: /packDeduct\(/,
    meituan: /packDeduct\(/,
  },
  {
    what: 'surfaces the lines that resolved to no product',
    why: 'an unmatched line is a silent non-deduction unless it is written down',
    eleme: /'order_unsynced'/,
    meituan: /'order_unsynced'/,
  },
  {
    what: 'surfaces a line the shelf could not cover',
    why: 'the gap that hid six Eleme oversells as Δ0 ledger rows',
    eleme: /'order_oversold'/,
    meituan: /'order_oversold'/,
  },
  {
    what: 'tells the merchant when an order left stock untaken',
    why: 'a sync-log row with no index, no screen and nothing watching it is not a record',
    eleme: /notifyStockGaps\(/,
    meituan: /notifyStockGaps\(/,
  },
  {
    what: 'skips the deduction on an order whose first sighting is already void',
    why: 'deducting for an order nobody was charged for drifts the count low permanently',
    eleme: /bornVoid/,
    meituan: /bornVoid/,
  },
  {
    what: 'returns the stock exactly once when a void is confirmed',
    why: 'without it every cancel drifts the count low; with it twice, high',
    eleme: /channel_stock_restored/,
    meituan: /channel_stock_restored/,
  },
  {
    what: 're-deducts when a voided order comes back to life',
    why: 'a rejected refund or a revived order otherwise leaves stock we no longer have',
    eleme: /uncancel/,
    meituan: /uncancel/,
  },
  {
    what: 'stamps what one unit cost at the time of sale',
    why: 'margin on a channel order is unrecoverable afterwards',
    eleme: /unitCostAtSale/,
    meituan: /unitCostAtSale/,
  },
];

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) failures++;
};

console.log('\nStock-affecting capabilities present in BOTH channel ingests\n');
for (const c of CAPABILITIES) {
  const inEleme = c.eleme.test(eleme);
  const inMeituan = c.meituan.test(meituan);
  const both = inEleme && inMeituan;
  check(c.what, both,
    both ? '' :
    `present in ${inEleme ? 'eleme' : 'meituan'} only — missing from ` +
    `${inEleme ? 'routes/meituan-internal.js' : 'routes/eleme-internal.js'}.\n` +
    `        Why it matters: ${c.why}\n` +
    `        If this capability genuinely belongs to one channel only, delete the\n` +
    `        entry from CAPABILITIES in this file, in a commit that says why.`);
}

// A guard on the guard. If both files stopped matching a pattern — a rename, a
// refactor — every check above would pass while asserting nothing at all, which
// is the failure mode a presence test has. So at least one capability must also
// be shown ABSENT from a file that genuinely lacks it.
console.log('\nThe patterns still discriminate\n');
{
  const nothing = '// a file with none of this in it\n';
  const anyMatches = CAPABILITIES.some(c => c.eleme.test(nothing) || c.meituan.test(nothing));
  check('no capability pattern matches an empty file', !anyMatches,
    'a pattern matches anything, so the checks above prove nothing');
}

console.log(failures ? `\n${failures} capability gap(s)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
