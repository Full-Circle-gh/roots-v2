#!/usr/bin/env node
/**
 * §194 — THE PRE-ORDER POPUP IS THE TENANT'S TO EDIT, AND ITS RESTOCK WINDOW
 * IS A NUMBER THEY TYPE.
 *
 *   node scripts/test_preorder_notice_copy.js
 *
 * Ash: *"tenent need to have place where this pop up can be edit and change as
 * he wish"*. It was the one checkout notice of the four with no operator copy
 * behind it — four string literals in routes/retail.js, so changing a word in
 * it meant a deploy. The batch notice has had operator copy since the
 * fresh-batch card shipped; this gives the grocery one the same, plus the one
 * fact it could never state: roughly how long a restock takes.
 *
 * WHAT THIS LOCKS, and each half is a way the change could go wrong:
 *
 *   • BLANK STILL SHIPS TODAY'S SENTENCE, character for character. This is the
 *     whole safety argument for the change: the notice is LIVE, so if blank
 *     meant silence (which is what the store-move notice does) every tenant's
 *     popup would switch off the day it deployed and no screen would say so.
 *
 *   • THE OPERATOR'S COPY WINS, field by field — a tenant who overrides only
 *     the title keeps the built-in message underneath it.
 *
 *   • {window} NEVER SHIPS HALF A SENTENCE. The batch notice's {ship_date} is
 *     computed when the notice fires and always exists; this one is typed and
 *     can be taken away. Copy that asks for a window with no days behind it
 *     falls back to the built-in text WHOLE rather than printing "within .".
 *
 *   • THE ADMIN CARD AND THE SERVER NORMALISE A WINDOW IDENTICALLY. One number
 *     on its own is a one-day window; a reversed pair is swapped. A preview
 *     that rounded differently from the checkout would advertise a promise the
 *     customer never sees.
 *
 * Nothing here touches a network or a real database: the server helpers are
 * lifted out of routes/retail.js and run in a vm sandbox with cfgValue stubbed,
 * which is the same technique the sibling pre-order suites use.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
function section(t) { console.log(`\n${t}`); }

const ROOT = path.join(__dirname, '..');
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const DELIVERY = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '06-delivery.js'), 'utf8');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');

// Lift one top-level `function name(` … `\n}` block out of a source file.
function grab(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at > -1, `${name} not found`);
  const rest = src.slice(at);
  const end = rest.indexOf('\n}');
  assert.ok(end > -1, `${name} has no top-level close`);
  return rest.slice(0, end + 2);
}

/* ── 1 · the server's own normalisation ─────────────────────────────────── */
section('1 · the server — what a stored `notice.preorder` turns into');

// One sandbox, with cfgValue swapped for a settable stub. Everything else
// these three helpers touch is language built-ins.
const srvCtx = { cfgValue: () => null, console };
vm.createContext(srvCtx);
// The field list rides along from the source rather than being retyped here:
// a field added to the server and forgotten in the card should fail section 4,
// not quietly pass because this suite kept its own stale copy of the list.
const FIELDS_DECL = RETAIL.slice(
  RETAIL.indexOf('const PREORDER_NOTICE_COPY_FIELDS ='),
  RETAIL.indexOf(';', RETAIL.indexOf('const PREORDER_NOTICE_COPY_FIELDS =')) + 1);
assert.ok(/kicker_en/.test(FIELDS_DECL), 'the copy-field list moved');
vm.runInContext(
  [FIELDS_DECL,
    grab(RETAIL, 'preorderNoticeCfg'),
    grab(RETAIL, 'preorderWindowLabel'),
    grab(RETAIL, 'preorderMessage')].join('\n'),
  srvCtx);
const stored = (v) => { srvCtx.cfgValue = () => v; return srvCtx.preorderNoticeCfg(); };

// A vm sandbox has its own Object, so deepStrictEqual on a value it built
// fails on the prototype alone. Copy the two fields out into a host object.
const plain = (o) => (o == null ? o : { en: o.en, cn: o.cn });

it('nothing stored → every field blank, no window', () => {
  const c = stored(null);
  assert.strictEqual(c.kicker_en, '');
  assert.strictEqual(c.message_cn, '');
  assert.strictEqual(c.min_days, null);
  assert.strictEqual(c.max_days, null);
});

it('a garbled row is the same as no row — it never throws', () => {
  for (const junk of ['nonsense', 42, [], true]) {
    const c = stored(junk);
    assert.strictEqual(c.min_days, null, String(junk));
    assert.strictEqual(c.title_en, '', String(junk));
  }
});

it('copy is trimmed, so a field of spaces still means "use the default"', () => {
  const c = stored({ title_en: '   ', kicker_cn: '  预订中  ' });
  assert.strictEqual(c.title_en, '');
  assert.strictEqual(c.kicker_cn, '预订中');
});

it('one day typed alone is a one-day window, not half of one', () => {
  assert.deepStrictEqual(
    [stored({ min_days: 3 }).min_days, stored({ min_days: 3 }).max_days], [3, 3]);
  assert.deepStrictEqual(
    [stored({ max_days: 5 }).min_days, stored({ max_days: 5 }).max_days], [5, 5]);
});

it('a reversed pair is swapped, not printed backwards', () => {
  const c = stored({ min_days: 9, max_days: 2 });
  assert.deepStrictEqual([c.min_days, c.max_days], [2, 9]);
});

it('zero days is a real answer and survives; out-of-range is dropped', () => {
  assert.strictEqual(stored({ min_days: 0, max_days: 0 }).min_days, 0);
  assert.strictEqual(stored({ min_days: -1, max_days: -1 }).min_days, null);
  assert.strictEqual(stored({ min_days: 900, max_days: 900 }).min_days, null);
});

it('the window label reads as a customer would say it, in both languages', () => {
  assert.strictEqual(srvCtx.preorderWindowLabel({ min_days: null, max_days: null }), null);
  assert.deepStrictEqual(plain(srvCtx.preorderWindowLabel({ min_days: 2, max_days: 4 })),
    { en: '2-4 days', cn: '2-4 天' });
  assert.deepStrictEqual(plain(srvCtx.preorderWindowLabel({ min_days: 1, max_days: 1 })),
    { en: '1 day', cn: '1 天' });
  assert.deepStrictEqual(plain(srvCtx.preorderWindowLabel({ min_days: 3, max_days: 3 })),
    { en: '3 days', cn: '3 天' });
});

/* ── 2 · {window}, and the half-sentence it must never print ────────────── */
section('2 · the placeholder — a window that is not there');

const DEF = 'the built-in sentence';

it('blank copy takes the default', () => {
  assert.strictEqual(srvCtx.preorderMessage('', '2-4 days', DEF), DEF);
  assert.strictEqual(srvCtx.preorderMessage('   ', null, DEF), DEF);
  assert.strictEqual(srvCtx.preorderMessage(undefined, null, DEF), DEF);
});

it('custom copy with a window gets the window', () => {
  assert.strictEqual(
    srvCtx.preorderMessage('Back within {window}. Thanks!', '2-4 days', DEF),
    'Back within 2-4 days. Thanks!');
});

it('every {window} in the sentence is filled, not just the first', () => {
  assert.strictEqual(
    srvCtx.preorderMessage('{window} — yes, {window}.', '3 days', DEF),
    '3 days — yes, 3 days.');
});

it('custom copy ASKING for a window with no days falls back WHOLE', () => {
  // The failure this exists to stop: "…usually back in stock within ." reaching
  // a paying customer because somebody cleared the two day boxes.
  assert.strictEqual(
    srvCtx.preorderMessage('Back in stock within {window}.', null, DEF), DEF);
});

it('custom copy that names no window is kept as written, window or not', () => {
  assert.strictEqual(srvCtx.preorderMessage('We will be in touch.', null, DEF),
    'We will be in touch.');
  assert.strictEqual(srvCtx.preorderMessage('We will be in touch.', '2-4 days', DEF),
    'We will be in touch.');
});

/* ── 3 · the notice itself ──────────────────────────────────────────────── */
section('3 · computePreorderNotice — the operator first, the built-in behind');

const NOTICE = (() => {
  const at = RETAIL.indexOf('function computePreorderNotice(');
  const rest = RETAIL.slice(at);
  return rest.slice(0, rest.indexOf('\n}') + 2);
})();

it('every field falls back through the operator’s copy', () => {
  for (const f of ['kicker_en', 'kicker_cn', 'title_en', 'title_cn']) {
    assert.ok(new RegExp(`cfg\\.${f}\\s*\\|\\|`).test(NOTICE),
      `${f} must prefer the operator's copy`);
  }
  assert.ok(/message_en: preorderMessage\(cfg\.message_en/.test(NOTICE));
  assert.ok(/message_cn: preorderMessage\(cfg\.message_cn/.test(NOTICE));
});

it('the built-in wording is still the wording that shipped before §194', () => {
  // The exact sentence a tenant who configures nothing keeps seeing. If this
  // ever has to change, it is a copy decision and belongs in the vocabulary
  // document — not a side effect of editing this function.
  assert.ok(NOTICE.includes(
    "const bareEn = 'Some items in your order are currently out of stock. Your order is a pre-order — we’ll ship everything together as soon as they’re back in stock.'"),
  'the no-window English default is untouched');
  assert.ok(NOTICE.includes(
    "const bareCn = '您订单中的部分商品目前缺货。此为预订订单，我们将在补货后尽快为您一并发货。'"),
  'the no-window Chinese default is untouched');
});

it('an unset window leaves the default sentence alone — no dangling token', () => {
  assert.ok(/const defEn = win\s*\n\s*\?/.test(NOTICE) && /: bareEn;/.test(NOTICE),
    'the windowed default is chosen by the window, not patched onto the bare one');
  assert.ok(/: bareCn;/.test(NOTICE));
});

it('it still names no batch — that is the other notice’s job', () => {
  // Carried over from test_fresh_today_label.js: the grocery notice has no
  // batch to name, and an operator field must not become a way to fake one.
  assert.ok(!/\{ship_date\}|\{delivery_date\}|\{make_date\}/.test(NOTICE),
    'no batch-date placeholder leaks into the grocery notice');
});

it('the notice is read through the config on every call, never cached', () => {
  // A cached copy would serve the old wording for as long as the process lived,
  // which is exactly the complaint this change answers.
  assert.ok(/const cfg = preorderNoticeCfg\(\);/.test(NOTICE));
});

/* ── 4 · the admin card ─────────────────────────────────────────────────── */
section('4 · the back office — the place the popup can actually be edited');

it('the Delivery hub offers a Pre-orders card that opens its own view', () => {
  assert.ok(/dlvGo\('preorder'\)/.test(ADMIN_HTML), 'the hub card has a way in');
  assert.ok(/data-dlv="preorder"/.test(ADMIN_HTML), 'and there is a view behind it');
  assert.ok(/id="dlv-st-preorder"/.test(ADMIN_HTML), 'with a status line on the hub');
});

it('every field the server reads has a box on the card', () => {
  for (const id of ['po-kicker-en', 'po-kicker-cn', 'po-title-en', 'po-title-cn',
    'po-msg-en', 'po-msg-cn', 'po-min-days', 'po-max-days']) {
    assert.ok(ADMIN_HTML.includes(`id="${id}"`), `${id} is missing from the card`);
  }
});

// §279: the card saves itself; preorderBody() is what every save sends.
it('the save writes one key, whole, with every field on it', () => {
  const fn = grab(DELIVERY, 'preorderBody');
  assert.ok(/'notice\.preorder': \{/.test(fn), 'one key, matching batch.schedule');
  for (const f of ['kicker_en', 'kicker_cn', 'title_en', 'title_cn',
    'message_en', 'message_cn', 'min_days', 'max_days']) {
    assert.ok(new RegExp(`${f}:`).test(fn), `${f} would be deleted by this save`);
  }
});

it('the load fills the card from the same key the save writes', () => {
  assert.ok(/cfg\.data\.notice && cfg\.data\.notice\.preorder/.test(DELIVERY),
    'the card reads back what it wrote');
  assert.ok(/\$\('#po-min-days'\)\.value  = po\.min_days != null \? po\.min_days : ''/.test(DELIVERY),
    'an unset window shows as empty, never as a number nobody chose');
});

it('the card warns when {window} is typed with no days behind it', () => {
  const at = DELIVERY.indexOf("DLV_CARDS.preorder = autosaveCard(");
  assert.ok(at > -1, 'the pre-order card is an autosaving card');
  const fn = DELIVERY.slice(at, DELIVERY.indexOf('\n});', at));
  assert.ok(/wantsWindow/.test(fn) && /p\.min_days == null/.test(fn),
    'the operator learns it here, not from a customer at a checkout');
});

/* ── 5 · the preview cannot promise a different window ──────────────────── */
section('5 · the preview and the checkout agree, digit for digit');

// Lift the card's own window helper and run it against a stubbed DOM, then
// compare it to the server's answer for the same pair. These are two separate
// implementations on purpose (one in the browser, one on the server); the
// point of the test is that they cannot drift apart unnoticed.
const fields = { '#po-min-days': { value: '' }, '#po-max-days': { value: '' } };
const uiCtx = { $: (sel) => fields[sel] || null, console };
vm.createContext(uiCtx);
vm.runInContext(grab(DELIVERY, 'poWindowLabel'), uiCtx);
const ui = (lo, hi) => {
  fields['#po-min-days'].value = lo == null ? '' : String(lo);
  fields['#po-max-days'].value = hi == null ? '' : String(hi);
  return uiCtx.poWindowLabel();
};

it('the card and the server read the same pair the same way', () => {
  const cases = [[null, null], [2, 4], [3, 3], [9, 2], [0, 1], [5, null], [null, 7]];
  for (const [lo, hi] of cases) {
    const srv = srvCtx.preorderWindowLabel(stored({ min_days: lo, max_days: hi }));
    assert.deepStrictEqual(plain(ui(lo, hi)), plain(srv), `pair ${lo}/${hi} reads differently`);
  }
});

it('the preview resolves {window} only once it has one', () => {
  const fn = grab(DELIVERY, 'poRenderPreview');
  assert.ok(/fb-tok">\{window\}/.test(fn),
    'with no window it shows the token, the way the batch card shows {delivery_date}');
  assert.ok(/isCn \? win\.cn : win\.en/.test(fn),
    'and fills the half the shell is actually showing');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
