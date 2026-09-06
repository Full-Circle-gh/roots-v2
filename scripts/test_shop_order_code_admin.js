#!/usr/bin/env node
/**
 * test_shop_order_code_admin.js — the number a shop calls, on the admin screens.
 *
 *   node scripts/test_shop_order_code_admin.js
 *
 * §49 gives a QR order a plain daily number — 1, 2, 3 through the shop's day and
 * back to 1 tomorrow — and it is what staff hear a customer say. It reaches the
 * printed ticket already (scripts/test_shop_menu.js). This is the other half:
 * the operator working off a screen rather than off the paper.
 *
 * WHAT IS HELD HERE THAT READING THE CODE CANNOT PROVE
 *
 *  1. THE HELPER RENDERS NOTHING FOR AN ORDER WITHOUT A CODE. Every order in
 *     this system that is not a QR order has none, so a helper that emitted an
 *     empty chip — or the string "null" — would put a mark on every row of
 *     every tenant. Driven with real values rather than read.
 *  2. IT IS ACTUALLY CALLED, from both the list row and the order drawer. A
 *     renderer nobody calls is the failure this file exists to catch: the code
 *     reviews fine and the screen shows nothing.
 *  3. THE API SENDS THE COLUMNS. The drawer's endpoint selects `o.*` and would
 *     have carried them anyway; the LIST endpoint names every column it
 *     returns, so without an edit there the chip is dead on the busiest screen.
 *  4. THE CHIP HAS A STYLE. Unstyled it renders as a bare numeral run together
 *     with the order number — legible in a test, unreadable on a counter.
 *  5. §49's OWN CONSTRAINT: the number is NOT unique and must never be shown
 *     alone. Both callers are asserted to sit beside the shop and the date.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

const ORDERS_JS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/04-orders.js'), 'utf8');
const RETAIL_JS = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');
const CSS       = fs.readFileSync(path.join(ROOT, 'public/retail-admin.css'), 'utf8');

// Lift the named function out of the browser bundle and run it for real. The
// bundle is not requireable (no module system, and it touches the DOM at load),
// so the function is extracted by name and given only what it uses.
function fnSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

section('The helper');
const src = fnSource(ORDERS_JS, 'ordShopCode');
yes(!!src, 'ordShopCode is still in 04-orders.js under that name',
  'renamed or removed — every check below is now testing nothing');

const sandbox = {
  escapeHtml: (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  // The admin's bilingual picker, as app.html defines it. Driven in BOTH
  // languages below, because a pair that renders one half is the failure this
  // whole vocabulary lock exists for.
  _lang: 'en',
  cuT: function (en, cn) { return sandboxLang() === 'cn' ? cn : en; },
};
let LANG = 'en';
function sandboxLang() { return LANG; }
vm.createContext(sandbox);
vm.runInContext(`${src}; this.ordShopCode = ordShopCode;`, sandbox);
const render = sandbox.ordShopCode;

is(render({ shop_order_code: 7 }).includes('>7<'), true, 'a QR order renders its number');
yes(/class="ord-shopno"/.test(render({ shop_order_code: 7 })), 'the chip carries the class the stylesheet targets');

// The whole point of point 1. Four shapes an order without a code can arrive in.
is(render({ shop_order_code: null }), '', 'null renders NOTHING, not an empty chip');
is(render({ shop_order_code: undefined }), '', 'undefined renders nothing');
is(render({}), '', 'a column the API never sent renders nothing');
is(render(null), '', 'no order at all renders nothing rather than throwing');

// 1 is the first number of every shop's day and the one a falsy test loses.
is(render({ shop_order_code: 1 }).includes('>1<'), true, "the day's FIRST order still renders — 1 is not absence");
// 0 is not a code this system issues (§49 counts from 1), but a zero that
// arrived from anywhere must not vanish silently while looking like a number.
yes(render({ shop_order_code: 0 }).includes('>0<'), 'a zero renders rather than being swallowed as falsy');

yes(render({ shop_order_code: '<b>7</b>' }).includes('&lt;b&gt;'),
  'the value is escaped, so a bad column can never inject markup');

section('It is actually called, on both screens');
const callSites = (ORDERS_JS.match(/\$\{ordShopCode\(o(?:,\s*true)?\)\}/g) || []).length;
yes(callSites >= 2, `ordShopCode is called from the list row AND the drawer (found ${callSites})`,
  'a renderer nobody calls reviews fine and shows nothing');
yes(/<td class="oc-ord">\$\{ordShopCode\(o\)\}/.test(ORDERS_JS),
  'the list row calls it, in the order-number cell');
yes(/\$\{ordShopCode\(o,\s*true\)\}<b>\$\{escapeHtml\(o\.order_no\)\}<\/b>/.test(ORDERS_JS),
  'the order drawer calls it WITH the visible label, before the order number');

section('The API sends the columns the list needs');
// The list endpoint names every column it returns. Narrowed to the query that
// actually feeds the list, so a stray mention elsewhere in a 35k-line file
// cannot make this pass.
const listStart = RETAIL_JS.indexOf("router.get('/api/retail-admin/orders'");
yes(listStart > 0, 'the list endpoint is still at that path');
const listSql = RETAIL_JS.slice(listStart, listStart + 6000);
yes(/o\.shop_order_code/.test(listSql), 'the list query selects shop_order_code');
yes(/o\.shop_order_date/.test(listSql), 'the list query selects shop_order_date');
// The drawer's endpoint takes o.*, so it needs no edit — asserted so that a
// later narrowing of that SELECT is caught here rather than on a counter.
const oneStart = RETAIL_JS.indexOf("router.get('/api/retail-admin/orders/:id'");
yes(/SELECT o\.\*/.test(RETAIL_JS.slice(oneStart, oneStart + 600)),
  'the drawer endpoint still selects o.*, which is why it needed no edit');

section('The chip has a style, and the number is never shown alone (§49)');
yes(/\.ord-shopno\s*\{/.test(CSS), 'retail-admin.css styles .ord-shopno',
  'unstyled it runs together with the order number and reads as one string');
yes(/tabular-nums/.test(CSS.slice(CSS.indexOf('.ord-shopno'), CSS.indexOf('.ord-shopno') + 500)),
  'the figures are tabular, so a column of numbers lines up');
// §49: not unique, so never shown without its shop and its day. The list row
// carries a Store column and a Placed column; this is the assertion that they
// are still there beside it.
yes(/class="oc-store"/.test(ORDERS_JS) && /class="muted oc-placed"/.test(ORDERS_JS),
  'the list row still carries the shop and the date the number needs to be read with');

section('The label, and it is declared where the lock lives');
// Rule 4's standing delegation (docs/tacet-delivery-vocabulary.md v1.19, Ash
// 2026-09-06) lets this be composed. What it does NOT allow is composing it
// silently, so the pair must exist in that document as well as in the code —
// that is the whole substance of the amendment and the only part a test can
// hold. A label in the code that is not in the lock is the failure.
const VOCAB = fs.readFileSync(path.join(ROOT, 'docs/tacet-delivery-vocabulary.md'), 'utf8');
const inCode = (src || '').match(/cuT\('([^']+)',\s*'([^']+)'\)/);
yes(!!inCode, 'the helper labels the chip with a bilingual pair');
if (inCode) {
  const [, en, cn] = inCode;
  yes(VOCAB.includes(cn), `the CN half (${cn}) is declared in the vocabulary lock`,
    'composed and undeclared — indistinguishable from a locked string to everyone after');
  yes(VOCAB.includes(en), `the EN half (${en}) is declared beside it`);
  // The TABLE ROW, not the version banner — the row is what a later reader
  // copying a string will land on, and it is the row that has to say composed.
  const row = VOCAB.split('\n').find(l => l.includes(cn) && l.includes(en) && l.trim().startsWith('|'));
  yes(!!row && /COMPOSED/.test(row),
    'the vocabulary table row marks the pair COMPOSED rather than locked-by-Ash',
    row ? `row reads: ${row.trim()}` : 'no table row carries both halves');
}

section('Both halves actually render');
LANG = 'en';
yes(render({ shop_order_code: 7 }, true).includes('Pick-up number'),
  'the English half renders in the drawer');
LANG = 'cn';
const cnOut = render({ shop_order_code: 7 }, true);
yes(/取餐号/.test(cnOut), 'the Chinese half renders in the drawer');
yes(!/Pick-up number/.test(cnOut), 'the two halves do not both render at once');
// The list is the tooltip register: numeral visible, label in the title.
const listOut = render({ shop_order_code: 7 });
yes(/title="[^"]*取餐号/.test(listOut), 'the list row carries the label as a tooltip');
yes(!/ord-shopno-lbl/.test(listOut), 'the list row does NOT print the label beside the number');
LANG = 'en';
yes(/\.ord-shopno-lbl\s*\{/.test(CSS), 'retail-admin.css styles the drawer label');

console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
