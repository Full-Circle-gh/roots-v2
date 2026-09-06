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
const { stockAppOnlyAllows } = require('../lib/stock-app-only');

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

// ── The door ──────────────────────────────────────────────────────────────
// A screen and its door go in together: the kitchen role is stock-app-only, and
// a route missing from that list is refused before any handler runs.
const D = 'stock-app-only';
if (!stockAppOnlyAllows('GET', '/api/retail-admin/stores/1/stock/added-today')) {
  fail(D, 'the added-today read is not admitted, so the line can never appear');
}
if (stockAppOnlyAllows('POST', '/api/retail-admin/stores/1/stock/added-today')) {
  fail(D, 'added-today is admitted as a write');
}
if (stockAppOnlyAllows('GET', '/api/retail-admin/stores/1/stock/anything-else')) {
  fail(D, 'the added-today line widened the stock pattern to every future segment');
}

// ── The screen ────────────────────────────────────────────────────────────
const APP = path.join(__dirname, '..', 'public', 'stock.html');
/* THE WEBFONT LINK IS STRIPPED, the same way scripts/lib/m-probe.js strips it.
   A headless run has no route to fonts.googleapis.com, the failed stylesheet
   raises a window `error` event with no message, and the uncaught-error check
   below would then fail every case on the environment rather than on the code.
   Nothing asserted here is about type. */
const src = fs.readFileSync(APP, 'utf8')
  .replace(/<link rel="stylesheet"[^>]*fonts\.googleapis\.com[^>]*>/, '')
  .replace(/<link rel="preconnect"[^>]*fonts\.g[^>]*>/g, '');

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  try {
    const p = require('playwright').chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* playwright not installed here */ }
  for (const g of ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome']) if (fs.existsSync(g)) return g;
  const pw = '/opt/pw-browsers';
  if (fs.existsSync(pw)) {
    for (const d of fs.readdirSync(pw)) {
      const p = path.join(pw, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// The shelf as the server sends it on each side of the grant: stripped to
// names and SKUs without it, names plus the count with it. Both shapes come
// from the same route, which is why the client must be told which it is in
// rather than inferring it from whether a quantity happened to arrive.
const STRIPPED = [{ product_id: 7, name_en: 'Hummus Asli', name_cn: '鹰嘴豆泥', sku: '1-10' }];
const WITHQTY = [{ product_id: 7, name_en: 'Hummus Asli', name_cn: '鹰嘴豆泥', sku: '1-10', physical_qty: 11 }];

function stub(o) {
  const ctx = {
    enabled: true, mode: 'add', can_recount: !!o.grant,
    user: { name: 'Asher', full_access: false },
    stores: [{ id: 1, name_en: 'Tianhe', name_cn: '天河店', code: 'TH' }],
  };
  return '<script>\n' +
    'window.__e=[];window.__patch=[];window.__calls=[];\n' +
    'addEventListener("error",function(e){window.__e.push(e.message)},true);\n' +
    'addEventListener("unhandledrejection",function(e){window.__e.push("rejection: "+((e.reason&&e.reason.message)||e.reason))});\n' +
    'var CTX=' + JSON.stringify(ctx) + ';\n' +
    'var STOCK=' + JSON.stringify(o.grant ? WITHQTY : STRIPPED) + ';\n' +
    'var ADDED=' + JSON.stringify(o.added || {}) + ';\n' +
    'window.fetch=function(url,opts){url=String(url);opts=opts||{};\n' +
    '  window.__calls.push(url.split("?")[0]);var body;\n' +
    '  if(url.indexOf("/quick-stock/context")>-1) body={success:true,data:CTX};\n' +
    '  else if(/\\/stock\\/added-today$/.test(url)) body={success:true,data:ADDED};\n' +
    '  else if(/\\/stock$/.test(url)) body={success:true,data:STOCK};\n' +
    '  else if(/\\/stores\\/\\d+\\/stock\\/\\d+$/.test(url)){\n' +
    '    window.__patch.push(Object.assign({product_id:Number(url.match(/stock\\/(\\d+)$/)[1])},\n' +
    '                                      JSON.parse(opts.body||"{}")));\n' +
    '    body={success:true,data:{}};\n' +
    '  }\n' +
    '  else body={success:true,data:{}};\n' +
    '  return Promise.resolve({status:200,json:function(){return Promise.resolve(body)}});};\n' +
    '</scr' + 'ipt>';
}

const HELPERS =
  'window.__click=function(sel,cb){var n=0;var t=setInterval(function(){var b=document.querySelector(sel);' +
  'if(!b){if(++n>60){clearInterval(t);window.__e.push("never appeared: "+sel);cb&&cb()}return}' +
  'clearInterval(t);b.click();setTimeout(cb||function(){},80)},40)};' +
  'window.__seq=function(list,done){(function n(i){if(i>=list.length)return done&&done();' +
  'var s=list[i];if(typeof s==="number")return setTimeout(function(){n(i+1)},s);' +
  'window.__click(s,function(){n(i+1)})})(0)};' +
  'window.__done=function(){setTimeout(function(){window.__ready=1},320)};';

const seq = (items) => 'window.__seq([' + items + '],window.__done);';

const CASES = {
  /* WITHOUT THE GRANT NOTHING CHANGED, and this is the case that matters most:
     every kitchen that has not been granted the capability is every kitchen
     today, and the original behaviour is what they keep. */
  'no-grant-shows-no-count': {
    js: 'window.__done();',
    expect: ['Hummus Asli', '+0'],
    absent: ['On the shelf', 'Correct the count'],
  },
  'no-grant-offers-no-correction-door': {
    js: 'window.__done();',
    check: (out) => /data-hasfix="1"/.test(out) ? 'the correction door is on an ungranted screen' : null,
  },
  // …and it IS there on a granted one, so the case above is failing on the
  // grant rather than on a selector that stopped matching.
  'the-grant-offers-the-correction-door': {
    grant: true, js: 'window.__done();',
    check: (out) => /data-hasfix="1"/.test(out) ? null : 'the granted screen has no correction door',
  },
  // The grant, and the one thing it is for: a number to check the shelf against.
  'the-grant-shows-the-count': {
    grant: true, js: 'window.__done();',
    expect: ['On the shelf', '11', 'Correct the count'],
  },
  /* WHAT HAS ALREADY GONE ON TODAY. The half that needs no grant — it is the
     operator's own work read back — and the answer to the failure the "What you
     made" note could only name: adding the same batch twice. */
  'todays-adds-are-read-back': {
    added: { 7: 6 }, js: 'window.__done();',
    expect: ['Added today', '+6'],
  },
  'the-line-is-absent-when-nothing-went-on': {
    js: 'window.__done();', absent: ['Added today'],
  },
  /* A DROP IS NEVER SAVED UNASKED. 11 on the shelf, 8 counted: the fork opens
     and the wire stays silent until it is answered. */
  'a-drop-asks-before-it-writes': {
    grant: true,
    js: seq('\'[data-fix="7"]\',\'.kp-key[data-k="8"]\',\'#kpSave\''),
    expect: ['Shelf says 11, you counted 8', 'I counted wrong', 'Something is missing or spoiled'],
    checkPatch: (p) => p.length ? `wrote ${JSON.stringify(p)} before the fork was answered` : null,
  },
  /* THE ANSWER THAT WRITES NOTHING. The kitchen records no waste, so a loss
     stops here and goes to somebody who can record one — and the screen says
     so rather than merely refusing. */
  'something-gone-writes-nothing-and-says-where-it-goes': {
    grant: true,
    js: seq('\'[data-fix="7"]\',\'.kp-key[data-k="8"]\',\'#kpSave\',\'#fkGone\''),
    expect: ['The count stays as it is', 'records waste'],
    checkPatch: (p) => p.length ? `a loss wrote ${JSON.stringify(p)}` : null,
  },
  // The answer that does save, and the assertion it carries.
  'counted-wrong-writes-an-absolute-count-with-the-answer': {
    grant: true,
    js: seq('\'[data-fix="7"]\',\'.kp-key[data-k="8"]\',\'#kpSave\',\'#fkMiscount\''),
    checkPatch: (p) => {
      if (p.length !== 1) return `expected one write, got ${JSON.stringify(p)}`;
      const w = p[0];
      if (w.physical_qty !== 8) return `expected physical_qty 8, got ${JSON.stringify(w)}`;
      if (w.recount_reason !== 'miscount') return `expected the fork's answer, got ${JSON.stringify(w)}`;
      if ('delta' in w) return 'a correction went out as a delta — the two writes have become one';
      return null;
    },
  },
  /* A RISE ASKS NOTHING (§46). Ruled against the symmetry argument on the
     friction case, so a fork appearing here is a decision reversed in silence.
     And no answer rides along: an upward correction was never asked, so
     claiming a miscount on one puts words in the operator's mouth. */
  'raising-the-count-asks-nothing': {
    grant: true,
    js: seq('\'[data-fix="7"]\',\'.kp-key[data-k="1"]\',\'.kp-key[data-k="9"]\',\'#kpSave\''),
    absent: ['I counted wrong'],
    checkPatch: (p) => {
      if (p.length !== 1) return `expected one write, got ${JSON.stringify(p)}`;
      if (p[0].physical_qty !== 19) return `expected physical_qty 19, got ${JSON.stringify(p[0])}`;
      if ('recount_reason' in p[0]) return 'a rise carried an answer nobody was asked for';
      return null;
    },
  },
  /* THE BATCH WRITE IS UNTOUCHED BY ALL OF IT. One delta, after the pause, on
     the same screen that now also corrects — which is the arrangement §46 says
     must never let one write become the other. */
  'the-batch-write-is-still-a-delta': {
    grant: true,
    js: seq('\'[data-inc="7"]\',1200'),
    checkPatch: (p) => {
      if (p.length !== 1) return `expected one write, got ${JSON.stringify(p)}`;
      if (p[0].delta !== 1) return `expected a delta of 1, got ${JSON.stringify(p[0])}`;
      if ('physical_qty' in p[0]) return 'a batch went out as an absolute count';
      if (p[0].reason !== 'kitchen_add') return `expected reason kitchen_add, got ${JSON.stringify(p[0])}`;
      return null;
    },
  },
};

function main() {
  const chrome = findChrome();
  if (!chrome) {
    if (failures.length) { for (const [n, m] of failures) console.log(`FAIL ${n} — ${m}`); process.exit(1); }
    console.log('SKIP — no Chromium found. Set CHROME_BIN to run the render pass.');
    process.exit(0);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kstock-'));

  for (const [name, c] of Object.entries(CASES)) {
    const probe = '<script>' + HELPERS + 'addEventListener("load",function(){setTimeout(function(){' +
      (c.js || 'window.__done();') +
      '},260);var t=setInterval(function(){if(!window.__ready)return;clearInterval(t);' +
      'document.body.setAttribute("data-seen",document.body.innerText.replace(/\\s+/g," "));' +
      /* A RENDERED FACT, NOT A SOURCE MATCH. --dump-dom includes the app's own
       <script>, so a regex for `data-fix=` over the dump matches the line that
       WRITES the attribute and passes on every screen, granted or not. Asked of
       the document instead. */
    'document.body.setAttribute("data-hasfix",document.querySelector("[data-fix]")?"1":"0");' +
    'document.body.setAttribute("data-patch",JSON.stringify(window.__patch||[]));' +
      'document.body.setAttribute("data-calls",JSON.stringify(window.__calls||[]));' +
      'document.title=(window.__e.length?"ERR "+window.__e.join(" | "):"OK");},40)});</scr' + 'ipt>';
    /* THE DOOR THE OPERATOR ACTUALLY COMES THROUGH. A bare open paints the
       counting list and then lands the launcher over it, by design — so a case
       that opened bare would assert against the launcher and never see a card.
       `?go=add` is the link the Tacet app's own row carries. location.search
       cannot be set by loading a file:// URL, so it is stamped before boot,
       which is the same thing homeWanted() reads. */
    const q = '<script>try{history.replaceState(null,"","?go=add")}catch(e){}</scr' + 'ipt>';
    const html = src.replace('</head>', q + stub(c) + probe + '</head>');
    const file = path.join(dir, name + '.html');
    fs.writeFileSync(file, html);
    let out;
    try {
      out = execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox',
        '--window-size=402,874', '--virtual-time-budget=20000', '--dump-dom', 'file://' + file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
    } catch (e) { fail(name, 'chrome failed: ' + e.message); continue; }

    const title = (out.match(/<title>([^<]*)<\/title>/) || [])[1] || 'no title';
    if (!title.startsWith('OK')) { fail(name, title); continue; }
    const dec = (x) => String(x).replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
    const seen = dec((out.match(/data-seen="([^"]*)"/) || [])[1] || '');
    for (const want of (c.expect || [])) if (!seen.includes(want)) fail(name, `missing “${want}”`);
    for (const no of (c.absent || [])) if (seen.includes(no)) fail(name, `should not say “${no}”`);
    if (c.check) { const p = c.check(out); if (p) fail(name, p); }
    if (c.checkPatch) {
      const p = c.checkPatch(JSON.parse(dec((out.match(/data-patch="([^"]*)"/) || [])[1] || '[]')));
      if (p) fail(name, p);
    }
    // Every URL this screen touches, named. A new call that nobody listed is a
    // door the stock-app-only gate has not been told about, which fails in
    // production and nowhere else.
    const OK = [/^\/api\/retail-admin\/quick-stock\/context$/,
      /^\/api\/retail-admin\/stores\/\d+\/stock$/,
      /^\/api\/retail-admin\/stores\/\d+\/stock\/added-today$/,
      /^\/api\/retail-admin\/stores\/\d+\/stock\/\d+$/,
      /^\/api\/push\/pref$/, /^\/api\/backend\/push\/pref$/,
      // The launcher probe every open makes, ?go=add included: it is what
      // decides whether there is a home to offer a way back to.
      /^\/api\/restock$/, /^\/api\/restock\/\d+$/];
    const calls = JSON.parse(dec((out.match(/data-calls="([^"]*)"/) || [])[1] || '[]'));
    for (const u of calls) if (!OK.some((re) => re.test(u))) fail(name, `called ${u}`);
    if (!calls.some((u) => /\/stock\/added-today$/.test(u))) {
      fail(name, 'add mode never asked what had already gone on the shelf today');
    }

    if (process.env.KSTOCK_SHOW && (process.env.KSTOCK_SHOW === '1' || process.env.KSTOCK_SHOW === name)) {
      console.log(`\n── ${name}\n${seen}\n   patch=${dec((out.match(/data-patch="([^"]*)"/) || [])[1] || '[]')}`);
    }
  }

  if (failures.length) {
    for (const [n, m] of failures) console.log(`FAIL ${n} — ${m}`);
    console.log(`\n${failures.length} failure(s).`);
    process.exit(1);
  }
  console.log(`ok — predicate, today's adds, door and ${Object.keys(CASES).length} screen states.`);
}

main();
