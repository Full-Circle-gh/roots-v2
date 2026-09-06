#!/usr/bin/env node
/**
 * The storefront editor designs in the merchant's own money — audit D-03.
 *
 * public/cms.html is the drag-drop editor every merchant builds their
 * storefront in. It is tenant-scoped — server.js:306 guards `/cms` alongside
 * `/retail-admin` and `/product-editor` — and every price it drew was a
 * hardcoded `¥` with a hardcoded two decimal places. So a shop selling in
 * dollars or baht designed its whole storefront in yuan and discovered what
 * customers would actually see only after publishing.
 *
 * D-03 was fixed on the admin (acCurrency in retail-admin/01-core.js), on the
 * storefront (money/money0 in shop.html), on the till and on the platform
 * screens. This page was the one left, and it is the one where the operator
 * makes the decisions.
 *
 * WHY IT CARRIES ITS OWN COPY OF THE HELPERS rather than importing them:
 * retail-admin loads plain <script> part files with no module system, and
 * cms.html loads none of them. Importing acCurrency() would mean loading a
 * 4000-line part file for four functions. So the two are twins, and §2 holds
 * them to the same defaults field for field — because two copies of a fallback
 * that disagree is worse than one copy that is wrong.
 *
 * §4 IS THE ONE THAT MATTERS LONGEST. It fails if any price is interpolated
 * beside a hardcoded ¥ again, which is how all 58 of them arrived in the first
 * place: nobody was watching, and each one looked fine on its own.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CMS = fs.readFileSync(path.join(ROOT, 'public', 'cms.html'), 'utf8');
const CORE = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '01-core.js'), 'utf8');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

/* The real helpers, lifted out of the shipped page and run — not a copy. */
function slice(src, open, close) {
  const a = src.indexOf(open);
  if (a < 0) throw new Error(`not found: ${open}`);
  const b = src.indexOf(close, a);
  if (b < 0) throw new Error(`no close after: ${open}`);
  return src.slice(a, b + close.length);
}
const ctx = { console, state: { currency: null } };
vm.createContext(ctx);
vm.runInContext(
  slice(CMS, 'const CMS_CURRENCY_FALLBACK', 'return cmsWrap((Number(n) || 0).toFixed(d));\n}')
  + '\nthis.cmsCurrency = cmsCurrency; this.cmsMoney = cmsMoney; this.cmsWrap = cmsWrap; this.cmsSym = cmsSym;',
  ctx,
);
const { cmsCurrency, cmsMoney, cmsWrap, cmsSym } = ctx;
const asShop = (c) => { ctx.state.currency = c; };

// ─────────────────────────────────────────────────────────────────────────
section('1 · a shop that never set a currency renders exactly as it always did');

asShop(null);
is(cmsMoney(12.5), '¥12.50', 'no currency configured → ¥, two places, symbol first');
is(cmsSym(), '¥', 'the bare symbol too');
is(cmsWrap('1,240'), '¥1,240', 'and a pre-formatted number keeps its own digits');
asShop('CNY');
is(cmsMoney(12.5), '¥12.50', 'a bare string rather than an object does not break it');
asShop({});
is(cmsMoney(12.5), '¥12.50', '…nor does an empty object');

// ─────────────────────────────────────────────────────────────────────────
section('2 · every other shop gets its own');

asShop({ code: 'USD', symbol: '$', decimals: 2, position: 'before' });
is(cmsMoney(12.5), '$12.50', 'a dollar shop designs in dollars');
asShop({ code: 'EUR', symbol: '€', decimals: 2, position: 'after' });
is(cmsMoney(12.5), '12.50€', '…and a symbol that belongs after the number goes after it');
asShop({ code: 'JPY', symbol: '¥', decimals: 0, position: 'before' });
is(cmsMoney(1250), '¥1250', 'a zero-decimal currency shows no decimals');
asShop({ code: 'USD', symbol: '$', decimals: 2, position: 'before' });
is(cmsMoney(12.5, 0), '$13', 'an explicit dp still overrides, for the places that want a round number');

/* THE TWO COPIES MUST NOT DISAGREE. cms.html cannot import acCurrency(), so
   the only thing keeping them in step is this. */
{
  const cmsFb = CMS.match(/CMS_CURRENCY_FALLBACK = Object\.freeze\((\{[^}]*\})\)/);
  const acFb = CORE.match(/CURRENCY_FALLBACK = Object\.freeze\((\{[^}]*\})\)/);
  yes(cmsFb && acFb, 'both files declare a frozen fallback');
  if (cmsFb && acFb) {
    is(cmsFb[1].replace(/\s+/g, ' ').trim(), acFb[1].replace(/\s+/g, ' ').trim(),
      "the CMS's fallback is the admin's, character for character");
  }
}

// ─────────────────────────────────────────────────────────────────────────
section('3 · a malformed stored value cannot break the editor');

/* /api/retail-admin/config returns the currency RAW — unlike the storefront's
   /api/retail/config, which normalises it first. So this is the only defence. */
asShop({ code: 'us dollar', symbol: '', decimals: 9, position: 'sideways' });
const messy = cmsCurrency();
is(messy.code, 'US ', 'an over-long code is clamped rather than trusted');
is(messy.symbol, '¥', 'an empty symbol falls back');
is(messy.decimals, 2, 'an absurd decimal count falls back');
is(messy.position, 'before', 'an unknown position falls back');
asShop({ decimals: 2.5 });
is(cmsCurrency().decimals, 2, 'a non-integer decimal count falls back');

// ─────────────────────────────────────────────────────────────────────────
section('4 · no price is drawn beside a hardcoded ¥ any more');

/* THE REGRESSION GUARD, and the one worth keeping. A price that interpolates a
   value next to a literal ¥ is exactly the shape all 58 originals had. */
{
  const lines = CMS.split('\n');
  const offenders = [];
  lines.forEach((l, i) => {
    if (!l.includes('¥')) return;
    // A ¥ next to an interpolation or a toFixed is a rendered amount.
    if (/¥\s*\$\{|\$\{[^}]*\}\s*¥|¥'\s*\+|\+\s*'¥|toFixed[^\n]*¥|¥[^\n]*toFixed/.test(l)) {
      offenders.push(`cms.html:${i + 1}  ${l.trim().slice(0, 100)}`);
    }
  });
  is(offenders.length, 0, 'no rendered amount carries a hardcoded ¥');
  for (const o of offenders.slice(0, 8)) console.log('      ' + o);
  if (offenders.length) console.log('      use cmsMoney() or cmsWrap()');
}

yes(/function cmsMoney\(/.test(CMS) && /function cmsWrap\(/.test(CMS),
  'the helpers exist to be used');
yes(/state\.currency = cfgResp\?\.data\?\.currency \|\| null;/.test(CMS),
  'and the currency is loaded at boot, beside the catalogue');
yes(/api\('\/api\/retail-admin\/config'\)\.catch/.test(CMS),
  '…with a catch, so a config failure does not stop the editor opening');

// ─────────────────────────────────────────────────────────────────────────
section('5 · what still says ¥, and why that is allowed');

/* Two kinds survive, and neither renders a merchant's money.

   EDITOR PROSE — help text ABOUT money: "Spend — total ¥ across paid orders",
   "the ¥ amounts, bonus points and BEST tag come from…". Interpolating a
   symbol into an explanatory sentence makes it read worse, not better, and the
   sentence is read by the operator rather than shown to a customer.

   BLOCK SEED CONTENT — the placeholder copy a new block arrives with, like
   "¥50 off your first order". These ARE customer-facing once published and are
   the D-04 shape rather than D-03: a default nobody wrote. They are recorded
   here rather than fixed, because deciding what a coupon block should say on a
   dollar shop is a content question, not a formatting one. */
{
  const remaining = CMS.split('\n').filter((l) => l.includes('¥')).length;
  yes(remaining > 0, `${remaining} line(s) still mention ¥ — all prose or seed copy`);
  yes(/Free shipping over ¥399/.test(CMS),
    'the block seed copy is still there, unchanged and pinned as a known D-04 item');
  yes(/Spend \(¥\)/.test(CMS) || /total ¥ across paid orders/.test(CMS),
    'and so is the editor prose that talks about money rather than showing it');
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
