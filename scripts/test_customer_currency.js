#!/usr/bin/env node
/**
 * The web storefront prices in the MERCHANT's currency — audit D-03, D-04.
 *
 * D-03 was recorded as fixed: "188 hardcoded ¥ conversions across twelve files.
 * Every amount now renders in the merchant's currency." The twelve files were
 * all `public/retail-admin/*.js` — the merchant-facing admin. `public/shop.html`,
 * the CUSTOMER-facing web storefront, was never in that pass and still carried
 * THIRTY-FOUR of them: every wallet balance, the top-up screen end to end, the
 * coupon stubs, the free-shipping nudge, the membership ladder, the
 * leaderboard, the referral programme, the favourites card, and the shop
 * listing's own third money helper.
 *
 * The page has had a correct money() — reading symbol, decimals and position
 * from /api/retail/config — the whole time. Thirty-four places did not call it.
 * So a merchant trading in dollars had their own admin showing dollars while
 * the storefront their customers actually see showed yuan, on the same order.
 *
 * D-04 is the same shape one field over: the membership hero read "ROOTS CLUB"
 * — the first tenant's loyalty programme — to every merchant's customers.
 *
 * Two more surfaces turned up the same way: the counter till hardcoded the
 * symbol in a helper actually CALLED yuan(), and the phone had one amount
 * written as a literal.
 *
 * This check is STATIC and it is a ban, because that is what the defect needs.
 * A hardcoded symbol is never wrong on the screen of the account it was written
 * for, and this product had exactly one account for years. It only becomes
 * visible on an account nobody has opened yet, which is to say: after it
 * matters.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHOP = path.join(ROOT, 'public', 'shop.html');
const src = fs.readFileSync(SHOP, 'utf8');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

/* Comments stripped: this file's subject is the symbol itself, and the fixed
   helpers carry notes that name it. */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CODE = strip(src);

// ─────────────────────────────────────────────────────────────────────────
section('1 · the symbol lives in exactly one place');

/* THE FALLBACK IS ALLOWED, and only as a fallback. `c.symbol || '¥'` is the
   deliberate default for an account whose config has not arrived yet — the
   first tenant's value, not the platform's, exactly as td-datetime's timezone
   fallback works. Every OTHER appearance is a price nobody chose. */
const FALLBACK = /c\.symbol\s*\|\|\s*'¥'/g;
const fallbacks = (CODE.match(FALLBACK) || []).length;
yes(fallbacks >= 1 && fallbacks <= 3,
  `the ¥ fallback appears ${fallbacks} time(s), inside the money helpers only`);

const stray = CODE.replace(FALLBACK, ' ').split('¥').length - 1;
is(stray, 0, 'no other ¥ anywhere in the storefront');
if (stray) {
  const lines = src.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => l.includes('¥') && !FALLBACK.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l));
  for (const [n, l] of lines.slice(0, 12)) console.log(`      shop.html:${n}  ${l.trim().slice(0, 100)}`);
  console.log('      use money() for an exact amount, money0() for whole units');
}

// ─────────────────────────────────────────────────────────────────────────
section('2 · two helpers, and both read the merchant');

/* The pair mirrors the admin's acMoney / acMoneyCompact (I-01): one exact, one
   for the places where a fen would be noise. A THIRD is how this started —
   slMoney(), the shop listing's own, was the one that hardcoded yuan while the
   two beside it were correct. */
for (const [fn, what] of [['money', 'an exact amount'], ['money0', 'whole units']]) {
  yes(new RegExp(`function ${fn}\\(n\\)\\{`).test(CODE), `${fn}() exists — ${what}`);
  const body = (CODE.split(`function ${fn}(n){`)[1] || '').slice(0, 400);
  yes(/state\.config\s*&&\s*state\.config\.currency/.test(body),
    `${fn}() reads the merchant's currency from config`);
  yes(/c\.position\s*===\s*'after'/.test(body),
    `${fn}() honours symbol POSITION — a symbol that only ever prefixes is half a fix`);
}
yes(/function slMoney\(v\)\{return Number\.isInteger\(Number\(v\)\)\?money0\(v\):money\(v\);\}/.test(CODE),
  'the shop listing delegates to the pair rather than being a third format');

/* Called at RENDER time, never at module load. The currency arrives with
   /api/retail/config after boot, so a helper evaluated in a module-level
   constant would freeze the fallback and read as a whole fix — the exact trap
   the D-03 commit recorded when it skipped RCTIER_DEFAULTS. */
{
  /* The earliest of the two definitions — money0 sits just above money — and
     then any CALL before it. `function money0(` is a definition, not a call,
     so the two declarations themselves are excluded by the lookbehind. */
  const firstDef = Math.min(
    ...['function money0(n){', 'function money(n){'].map((d) => CODE.indexOf(d)).filter((i) => i >= 0),
  );
  const head = CODE.slice(0, firstDef);
  const early = head.match(/(?<!function\s)\bmoney0?\s*\(/g) || [];
  is(early.length, 0,
    'no money helper is called above its own definition, where config has not arrived');
}

// ─────────────────────────────────────────────────────────────────────────
section("3 · the club belongs to the shop whose customers are reading it");

is((CODE.match(/ROOTS CLUB|ROOTS 会员/g) || []).length, 0,
  'the membership hero no longer names the first tenant');
yes(/mb-kicker">\$\{esc\(cn\?\(state\.brand \+ ' 会员'\)/.test(src)
  || /mb-kicker">\$\{esc\(cn\?\(state\.brand\+' 会员'\)/.test(src),
'…it is built from state.brand, which every page title already uses');

// ─────────────────────────────────────────────────────────────────────────
section('4 · the counter till and the phone');

/* THE TILL rang up every sale in yuan. Its money helper was called yuan() and
   hardcoded the symbol, on sixteen call sites and on the printed receipt — so a
   merchant trading in anything else quoted the customer a figure in a currency
   neither of them uses, on the glass they are both looking at. It already read
   /api/retail/config for the tax settings (I-03), so the currency was one field
   away the whole time. */
{
  const till = fs.readFileSync(path.join(ROOT, 'public', 'till.html'), 'utf8');
  const code = till.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  is((code.match(/\byuan\s*\(/g) || []).length, 0,
    'the till has no yuan() — the helper is money() and reads the shop');
  yes(/S\.cur\s*=\s*curCfg/.test(code) || /if \(curCfg && typeof curCfg/.test(code),
    'the till seeds its currency from the config read it already makes');
  yes(/c\.position === 'after'/.test(code),
    '…and honours symbol position, like every other surface');
  const stray = code.split('¥').length - 1;
  /* One fallback in the state default, one in the helper. Nothing else. */
  yes(stray <= 2, `the till carries ${stray} ¥ fallback(s) and no hardcoded price`);
}

/* THE PHONE was already correct — money(cur, n) and money0(cur, n) both take
   the currency — with exactly one amount written as a literal instead. */
{
  const m = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
  const code = m.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const literals = code.match(/¥\d/g) || [];
  is(literals.length, 0, 'no amount on the phone is written as a yuan literal');
  if (literals.length) console.log('      ' + literals.join(', ') + ' — use money0(CUR, n)');
}

// ─────────────────────────────────────────────────────────────────────────
section("5 · the platform's own screens print the merchant's money");

/* store-admin.html shows many shops' money side by side — their customers'
   lifetime spend and wallet, their GMV, the commission billed on that GMV — and
   printed all of it in ¥ regardless, because the payloads carried no currency
   to print it in. A merchant trading in dollars had their GMV read as yuan on
   the one screen the platform bills them from. */
{
  const sa = strip(read('public/store-admin.html'));
  yes(/const sym = cur => \{/.test(sa),
    'store-admin has a symbol helper that takes the shop, not a constant');
  /* Every call, not every call that looked like one: the arguments here are
     `c.lifetimeSpend` and `p.gmvThisMonth`, so a \\w+ pattern walks past the
     ones that matter. Match the whole call and require a comma in it. */
  const calls = sa.match(/\byuan\([^)]*\)/g) || [];
  const bare = calls.filter((c) => !c.includes(','));
  is(bare.length, 0, `every one of the ${calls.length} yuan() calls passes a currency`);
  if (bare.length) console.log('      ' + bare.join(', '));
  yes(!/Setup fee ¥|Price ¥|Amount ¥|Internal · ¥0/.test(sa),
    'the four labels no longer name the symbol in their own words');

  /* And the server has to send it, or the client falls back forever and the
     whole pass is decorative — the same trap as the timezone key. */
  const admin = strip(read('routes/store-admin.js'));
  yes(/function tenantCurrency\(tdb\)/.test(admin),
    'routes/store-admin reads each tenant\'s own currency');
  yes(/normalizeCurrency/.test(admin),
    "…through the one function that defines that shape, not a second copy");
  for (const field of ['customers.push', 'orders.push']) {
    yes(new RegExp(field.replace('.', '\\.') + '\\([^)]*currency: cur').test(admin),
      `${field} carries it`);
  }
  yes(/rateBps: rate, currency,/.test(admin), 'so does every GMV row');
  yes(/currency: tenantCurrency\(tdb\)/.test(admin), 'and the customer detail');
  yes(/currency: tenantCurrency\(t\.id\)/.test(strip(read('routes/saas-admin.js'))),
    'and the onboarding screen, where the setup fee is typed');
}

// ─────────────────────────────────────────────────────────────────────────
section('6 · nobody inherits another shop\'s story');

/* ABOUT_DEFAULTS was the first tenant's own brand copy — the manifesto, EST.
   2017, MADE IN 广州, the founder's quote, the in/out list — handed to every
   merchant who had not written an About page, and merged FIELD BY FIELD, so a
   merchant who wrote half a page published the other half of somebody else's
   story to their own customers. The phone admin always had the right answer for
   the same config key: no content, no page. */
{
  const shop = strip(read('public/shop.html'));
  is(/const ABOUT_DEFAULTS\s*=/.test(shop), false,
    'the storefront carries no default About content at all');
  is(/Object\.assign\(\{\}, *ABOUT_DEFAULTS/.test(shop), false,
    '…and merges nothing under what the shop wrote');
  is(/welcome-roots\.jpg/.test(shop), false,
    "the hero is the shop's own picture, not a hardcoded brand asset");
  yes(/hero_image_url/.test(shop), '…read from their content like every other field');

  const mini = strip(read('miniapp/pages/about/about.js'));
  is(/const DEFAULTS = \{/.test(mini), false, 'nor does the mini app');
  is(/Object\.assign\(\{\}, DEFAULTS, stored\)/.test(mini), false, '…nor merge them');
  const wxml = read('miniapp/pages/about/about.wxml');
  is(/src="\/assets\/brand\/welcome-roots\.jpg"/.test(wxml), false,
    'and its hero is the shop\'s own too');
  yes(/wx:if="\{\{manifestoSegments\.length\}\}"/.test(wxml),
    'every mini-app section renders only if the shop wrote it');

  /* The copy is not lost — it moves to the account it belongs to, as content
     they can edit, so their page renders exactly as it did. */
  const seed = read('scripts/seed_about_account1.js');
  yes(/never overwrites/.test(seed) || /already has/.test(seed),
    'the seed refuses to overwrite an About page a shop actually wrote');
}

// ─────────────────────────────────────────────────────────────────────────
section('7 · what is deliberately still there');

/* ABOUT_DEFAULTS is the first tenant's own brand copy — manifesto, founding
   year, city, founder quote, the in/out list — handed to every merchant who
   has not written an About page, and merged field by field so a merchant who
   wrote HALF a page gets the other half from Roots. It is D-04 at full
   strength and it is NOT fixed here, because what an unwritten About page
   should show instead (nothing? neutral prompts?) is a product decision and
   not mine to take. Pinned so it cannot be forgotten, and so the day it is
   answered this check is the thing that fails. */
/* ABOUT_DEFAULTS used to be pinned here as an OPEN item. It was answered:
   nothing until they write it. §6 above is what that decision became. */
is(/founder_quote_en:'I started Roots because/.test(src), false,
  "the first tenant's founder quote is no longer the storefront's default");

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
