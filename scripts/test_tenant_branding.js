#!/usr/bin/env node
/**
 * Nothing goes out under another company's name — audit D-04.
 *
 * `tenantBrandLabel()` exists in routes/retail.js and its own note says why:
 * "a shopper's payment screen never reads another company's name. (⑦
 * de-Roots.)" It was written for the WeChat and Alipay descriptions and used
 * there — and twenty-four thousand lines further down the same file, the JD
 * waybill still set `senderName: 'Roots'`, with a comment beside it saying the
 * field was the brand and "user-set". It was neither. Every account's parcels
 * went to their customers with another company in the sender field, printed on
 * the label that comes off the box.
 *
 * That is the shape this check exists for, and it is not really about one
 * literal. A multi-tenant product grows these the way a single-tenant one grew
 * them in the first place: somebody writes the obviously-correct string for the
 * only account there is. It reads fine in review, it is right in production for
 * years, and it becomes wrong on the day a second account does something
 * ordinary. So the literal is banned in the places a customer can see, and the
 * places it legitimately survives are listed here with the reason, because
 * "why is this one still here" is the question that otherwise gets asked once a
 * quarter forever.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

const RETAIL = strip(read('routes/retail.js'));

// ─────────────────────────────────────────────────────────────────────────
section('1 · the helper, and that it is actually reached');

yes(/function tenantBrandLabel\(\)/.test(RETAIL), 'tenantBrandLabel() exists');
yes(/if \(tid === ROOTS_TENANT_ID\) return 'Roots';/.test(RETAIL),
  '…and returns the original name for account #1, so nothing moves for them');
yes(/t\.brand_name \|\| t\.name/.test(RETAIL),
  "…and every other account's own brand for everybody else");
yes(/\|\| 'Store'/.test(RETAIL),
  '…with a neutral last resort rather than a borrowed one');

/* The two paths a stranger reads a company name on. Both must go through the
   helper; neither may hold the literal. */
yes(/senderName:\s+tenantBrandLabel\(\)/.test(RETAIL),
  'the JD waybill sends the merchant as the SENDER — the name on the parcel');
yes(/function payDescription\(orderNo\) \{ return `\$\{tenantBrandLabel\(\)\}/.test(RETAIL),
  'the payment description does too — the name on the payment screen');

// ─────────────────────────────────────────────────────────────────────────
section('2 · no literal left in routes/retail.js where a customer can see it');

/* The whole file, comments stripped. Two legitimate survivors are named
   explicitly below rather than pattern-matched, so adding a third is a
   deliberate act with a sentence attached. */
const ALLOWED = [
  // The helper's own answer for the account it belongs to.
  "if (tid === ROOTS_TENANT_ID) return 'Roots';",
];
let body = RETAIL;
for (const a of ALLOWED) body = body.split(a).join(' ');
const left = (body.match(/'Roots'|"Roots"|`Roots/g) || []).length;
is(left, 0, 'no other Roots literal in the admin API');
if (left) {
  const lines = read('routes/retail.js').split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /'Roots'|"Roots"|`Roots/.test(l) && !/^\s*(\/\/|\*)/.test(l)
      && !ALLOWED.some((a) => l.includes(a)));
  for (const [n, l] of lines.slice(0, 8)) console.log(`      retail.js:${n}  ${l.trim().slice(0, 110)}`);
  console.log('      use tenantBrandLabel()');
}

// ─────────────────────────────────────────────────────────────────────────
section('3 · where the name legitimately survives, and why');

/* SEEDING ACCOUNT #1. backend-auth and billing create the first tenant and
   name it. That is the row tenantBrandLabel() reads back; it has to say Roots
   somewhere or there is no Roots. */
yes(/\.run\('Roots', 'Roots', 'active'\)/.test(strip(read('routes/backend-auth.js'))),
  'the first tenant is still seeded by name — that row is what the helper reads');

/* THE KITCHEN ASSISTANTS. /api/ai/chat and /api/ai/sales-analyze are both
   requireAuth — the kitchen realm, Roots' own app, out of scope for this audit
   by the brief, and the audit says so itself in §8.4. Their prompts describe
   Roots because they are Roots'. The product-copy assistant is the one that is
   ALSO mounted on the merchant realm, and it was fixed (test_compose_prompt). */
{
  const ai = read('routes/ai.js');
  is(/router\.post\('\/api\/retail-admin\/ai\/chat'/.test(ai), false,
    'the chat assistant has no merchant-realm mount, which is why its Roots facts stand');
  is(/router\.post\('\/api\/retail-admin\/ai\/sales-analyze'/.test(ai), false,
    '…and neither does the sales analyst');
  yes(/composeSystem\(shop\)/.test(ai),
    'the copy assistant — the one that IS merchant-reachable — takes the shop');
}

/* THE RIDER DISPATCH. lib/qingyun-payload.js names the goods
   `Roots <order no>`, which a rider reads in their app. It is the same defect
   and it is NOT fixed here: rider and dispatch surfaces are out of scope for
   this audit by the brief that commissioned it, and the builder takes a deps
   object that would need a brand threaded through it from the caller. Pinned
   so it is a known item rather than a missed one — one line in the builder and
   one at routes/retail.js's call site on the day it is in scope. */
yes(/name: `Roots \$\{norm\(order\.order_no\)\}`/.test(read('lib/qingyun-payload.js')),
  'the rider dispatch still names Roots — out of scope by the brief, see the note here');

/* THE DEBUG PUSH. /api/push/test is requireAuth and sends to the caller's own
   device. Nobody else ever sees it. */
yes(/router\.post\('\/api\/push\/test', requireAuth/.test(read('routes/push.js')),
  "the test push is the caller's own device only");

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
