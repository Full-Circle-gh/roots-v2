#!/usr/bin/env node
/**
 * §457 — the till can hold a bill and open the next one.
 *
 *   node scripts/test_till_hold.js
 *
 * A customer eating now pays later; the next one is already at the counter.
 * Hold sets the bill aside on the tablet (localStorage, per business and shop),
 * the Held face lists what is set aside, and a tap brings one back to be added
 * to and paid. It stays stored until it is paid or emptied.
 *
 * No browser. The shipped functions are cut out of public/till.html and run in
 * a vm against a fake storage and a fake clock — the technique
 * scripts/test_till_new_customer_kept.js uses on the same file.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'till.html'), 'utf8');
const problems = [];
let checks = 0;
function ok(name, v) { checks++; if (!v) problems.push(name); }

// A function as shipped: a one-line body, or everything to the closing brace
// at the function's own indent.
function fn(name) {
  const at = src.indexOf('\n  function ' + name + '(');
  if (at < 0) throw new Error('till.html has no function ' + name + '()');
  const lineEnd = src.indexOf('\n', at + 1);
  const first = src.slice(at, lineEnd);
  if (/\}\s*$/.test(first) && (first.match(/\{/g) || []).length === (first.match(/\}/g) || []).length) {
    return first + '\n';
  }
  const end = src.indexOf('\n  }\n', at);
  return src.slice(at, end + 5);
}
function line(re) {
  const m = src.match(re);
  if (!m) throw new Error('till.html has no ' + re);
  return m[0] + '\n';
}

// ---- a storage that can be made to fail, and counts writes
function makeStorage() {
  const data = {};
  return {
    data, writes: 0, fail: false,
    getItem(k) { return k in data ? data[k] : null; },
    setItem(k, v) { if (this.fail) throw new Error('quota'); this.writes++; data[k] = String(v); },
    removeItem(k) { if (this.fail) throw new Error('quota'); this.writes++; delete data[k]; },
  };
}

// ---- elements the render functions write to
function el() {
  return {
    hidden: false, innerHTML: '', attrs: {}, value: '',
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
  };
}

const NOW = new Date(2026, 9, 11, 14, 32).getTime();

function setup() {
  const els = { 'pane-held': el(), seg: el(), holdpick: el() };
  const ctx = {
    localStorage: makeStorage(),
    Date: class extends Date {
      constructor(...a) { if (a.length) super(...a); else super(NOW); }
      static now() { return NOW; }
    },
    Math, JSON, String, Number, Array,
    _lang: 'en',
    S: {
      tid: 7, storeId: 3, view: 'till', recall: null, done: null,
      lines: [], sel: null, customer: null, wallet: 'cash', useP: true, useB: true,
      moreOpen: true, err: '', busy: false, held: [], heldId: null, heldLast: '',
      holdOpen: false, pane: 'menu', paneTouched: false, sheetOpen: false,
      heldSent: {}, heldBusy: {}, stock: {},
      pend: [], cxArm: false, tax: null,
      products: [
        { id: 11, name_en: 'Hummus Toast', name_cn: 'Hummus Toast', sku: 'TS-80', price: 30, on_menu: true },
        { id: 12, name_en: 'Latte', name_cn: 'Latte', sku: 'C-1', price: 25, on_menu: true },
      ],
    },
    T: (k) => k, cuT: (en) => en, esc: (s) => String(s), money: (n) => 'Y' + Number(n).toFixed(2),
    $: (id) => els[id] || null,
    loaded: [], recallCalls: 0, holdCalls: [], holdReply: null,
    loadCounterVouchers(c) { ctx.loaded.push(c.id); },
    // §461 — the held-bill stock call answers like the server (a real promise,
    // because heldStockPush chains on it); everything else is the recall fake.
    api(path, opts) {
      if (String(path).indexOf('/api/retail-admin/orders/till-held/') === 0) {
        ctx.holdCalls.push({ path, body: JSON.parse(opts.body) });
        return Promise.resolve(ctx.holdReply || { success: true, data: { taken: {} } });
      }
      ctx.recallCalls++; return { then() { return { catch() {} }; } };
    },
    render() { ctx.renders = (ctx.renders || 0) + 1; vm.runInContext('heldSync()', ctx); },
  };
  vm.createContext(ctx);
  vm.runInContext(line(/\n  var HELD_PREFIX = [^\n]*/), ctx);
  vm.runInContext(line(/\n  var TAX_MAX_MICRO = [^\n]*/), ctx);
  vm.runInContext(line(/\n  var HELD_PAID = [^\n]*/), ctx);
  ['heldKey', 'heldRead', 'heldWrite', 'heldLoad', 'heldFind', 'heldShown', 'canHold',
   'heldSnap', 'heldPut', 'heldDrop', 'holdNow', 'openHeld', 'heldSync', 'twoDigit',
   'heldDay', 'heldTime', 'renderHeld', 'renderHoldAsk', 'renderSeg', 'normalisePane',
   'lineKey', 'optsDelta', 'fullName', 'pname', 'vlabel', 'custRow', 'dueNow', 'taxOn',
   'recall', 'commitHold', 'heldStockKey', 'heldStockPush', 'heldTook', 'heldOwn', 'stockOf']
    .forEach((n) => vm.runInContext(fn(n), ctx));
  ctx.els = els;
  return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);
const stored = (ctx, store) => JSON.parse(ctx.localStorage.getItem('tacet-till-held:7:' + (store || 3)) || '[]');

function bill(ctx) {
  ctx.S.lines = [
    { key: '11|', id: 11, name: 'Hummus Toast', sku: 'TS-80', base: 30, price: 30, qty: 1, menu: true,
      choices: [], opts: [] },
    { key: '12|5', id: 12, name: 'Latte', sku: 'C-1', base: 25, price: 28, qty: 2, menu: true,
      choices: [5], opts: [{ option_id: 1, choice_id: 5, label: 'Oat', delta: 3 }] },
  ];
  ctx.S.customer = { id: 40, nickname: 'Mei', points: 120, balance: 5 };
}

// ---- 1. no business id: Hold is not offered and nothing is touched
{
  const c = setup();
  c.S.tid = null; bill(c);
  ok('no business id: Hold is not offered', run(c, 'canHold()') === false);
  ok('no business id: no storage key', run(c, 'heldKey()') === null);
  ok('no business id: a write reports failure', run(c, 'heldWrite([])') === false);
  ok('no business id: nothing written', c.localStorage.writes === 0);
}

// ---- 2. hold: saved with its note, rail cleared
{
  const c = setup(); bill(c);
  ok('a bill with lines can be held', run(c, 'canHold()') === true);
  c.S.recall = { id: 1 };
  ok('a recalled QR order cannot be held', run(c, 'canHold()') === false);
  c.S.recall = null;
  ok('holding returns true', run(c, "holdNow('window table')") === true);
  const s = stored(c);
  ok('one bill stored for this business and shop', s.length === 1);
  ok('the note is kept', s[0].note === 'window table');
  ok('the time held is kept', s[0].at === NOW);
  ok('the lines are kept whole, answers included',
     s[0].lines.length === 2 && s[0].lines[1].choices[0] === 5 && s[0].lines[1].opts[0].delta === 3
     && s[0].lines[1].qty === 2 && s[0].lines[1].menu === true);
  ok('the customer is kept by id', s[0].customer && s[0].customer.id === 40);
  ok('the rail is cleared', c.S.lines.length === 0 && c.S.customer === null);
  ok('wallet and credit toggles are not carried', c.S.wallet === null && !c.S.useP && !c.S.useB);
  ok('the list mirrors storage', c.S.held.length === 1);
}

// ---- 3. a failed write keeps the bill on screen
{
  const c = setup(); bill(c);
  c.localStorage.fail = true;
  ok('a failed write reports failure', run(c, "holdNow('x')") === false);
  ok('...and the bill stays on screen', c.S.lines.length === 2 && c.S.customer.id === 40);
  ok('...and says so', c.S.err === 'didNotSave');
}

// ---- 4. the Held list
{
  const c = setup(); bill(c);
  run(c, "holdNow('window table')");
  run(c, 'renderHeld()');
  const h = c.els['pane-held'].innerHTML;
  ok('the row shows the time held', h.indexOf('>14:32<') > -1);
  ok('the row is titled by the note', h.indexOf('<b>window table</b>') > -1);
  ok('the row lists what is on it', h.indexOf('Hummus Toast, Latte ×2') > -1);
  ok('the row shows the total', h.indexOf('Y86.00') > -1);
  ok('a bill from today carries no date and no warning', h.indexOf('class="old"') === -1);

  // A bill from yesterday, written as an earlier shift would have left it.
  const list = stored(c);
  list.push({ id: 'hold1', at: NOW - 86400000, note: '', customer: null,
              lines: [{ id: 12, name: 'Latte', price: 25, qty: 1, choices: [], opts: [] }] });
  c.localStorage.setItem('tacet-till-held:7:3', JSON.stringify(list));
  run(c, 'heldLoad(); renderHeld()');
  const h2 = c.els['pane-held'].innerHTML;
  ok('yesterday\'s bill is still listed', h2.indexOf('data-held="hold1"') > -1);
  ok('...with its date, marked', h2.indexOf('<i class="old">2026-10-10</i>') > -1);
  ok('...titled by its items when it has no note or customer', h2.indexOf('<b>Latte</b>') > -1);
}

// ---- 5. switching shop shows that shop's list
{
  const c = setup(); bill(c);
  run(c, "holdNow('a')");
  c.S.storeId = 4; run(c, 'heldLoad()');
  ok('another shop has its own (empty) list', c.S.held.length === 0);
  c.S.storeId = 3; run(c, 'heldLoad()');
  ok('back at the first shop, its bill is there', c.S.held.length === 1);
}

// ---- 6. opening a held bill
{
  const c = setup(); bill(c);
  run(c, "holdNow('window table')");
  const id = c.S.held[0].id;
  c.S.products[1].price = 26;          // the latte went up a yuan since
  run(c, "openHeld('" + id + "')");
  ok('the lines come back', c.S.lines.length === 2);
  ok('re-priced from today: base plus the answer', c.S.lines[1].base === 26 && c.S.lines[1].price === 29);
  ok('an unchanged price stays', c.S.lines[0].price === 30);
  ok('the customer comes back', c.S.customer && c.S.customer.id === 40 && c.S.customer.points === 120);
  ok('their vouchers are read again', c.loaded.indexOf(40) > -1);
  ok('credit stays off until tapped', !c.S.useP && !c.S.useB && c.S.wallet === null);
  ok('it is the held bill on screen', c.S.heldId === id);
  ok('it stays stored while on screen', stored(c).length === 1);
  ok('the list no longer shows it', run(c, 'heldShown().length') === 0);
  ok('the rail goes back to the menu', c.S.pane === 'menu');

  // ---- 7. changes are written back; nothing written when nothing changed
  run(c, 'heldSync()');
  const w = c.localStorage.writes;
  run(c, 'heldSync(); heldSync()');
  ok('a repaint that changed nothing writes nothing', c.localStorage.writes === w);
  c.S.lines.push({ key: '12|', id: 12, name: 'Latte', base: 26, price: 26, qty: 1, menu: true, choices: [], opts: [] });
  run(c, 'heldSync()');
  ok('a coffee added to the held bill is saved', stored(c)[0].lines.length === 3);
  ok('...under the same bill, note and time', stored(c)[0].id === id
     && stored(c)[0].note === 'window table' && stored(c)[0].at === NOW);

  // ---- 8. held again keeps its place, note offered back
  ok('holding it again succeeds', run(c, 'holdNow()') === true);
  ok('still one bill, same id', stored(c).length === 1 && stored(c)[0].id === id);
  ok('its note is kept when none is given', stored(c)[0].note === 'window table');
  run(c, "openHeld('" + id + "')");
  run(c, "holdNow('table 4')");
  ok('a new note replaces it', stored(c)[0].note === 'table 4');

  // ---- 9. emptied line by line, it is over
  run(c, "openHeld('" + id + "')");
  c.S.lines = [];
  run(c, 'heldSync()');
  ok('an emptied held bill is removed', stored(c).length === 0 && c.S.heldId === null);
}

// ---- 10. opening one while another bill is on screen holds that one first
{
  const c = setup(); bill(c);
  run(c, "holdNow('first')");
  const first = c.S.held[0].id;
  c.S.lines = [{ key: '12|', id: 12, name: 'Latte', base: 25, price: 25, qty: 1, menu: true, choices: [], opts: [] }];
  run(c, "openHeld('" + first + "')");
  const s = stored(c);
  ok('the bill that was on screen is held, not dropped', s.length === 2);
  ok('...as a new bill with no note', s.some((b) => b.id !== first && b.note === '' && b.lines[0].id === 12));
  ok('and the chosen bill is up', c.S.heldId === first && c.S.lines.length === 2);
}

// ---- 11. opening a QR order holds the till's own bill instead of wiping it
{
  const c = setup(); bill(c);
  c.S.pend = [{ id: 501, order_no: 'TC1', shop_order_code: 12, recipient_name: '', total: 40 }];
  run(c, 'recall(501)');
  ok('the till\'s bill is held', stored(c).length === 1 && stored(c)[0].lines.length === 2);
  ok('and the QR order opens', c.S.recall && c.S.recall.id === 501 && c.recallCalls === 1);
  // and a held bill opened over a recalled order just puts the order back
  const back = stored(c)[0];
  if (back) run(c, "openHeld('" + back.id + "')");
  ok('a recalled order is put back, not held', !!back && c.S.recall === null && stored(c).length === 1);
}

// ---- 12. the note sheet keeps what is typed across repaints
{
  const c = setup(); bill(c);
  c.S.holdOpen = true;
  c.els['hold-note'] = null;
  const note = { value: '' };
  c.$ = (id) => (id === 'hold-note' ? note : c.els[id] || null);
  run(c, 'renderHoldAsk()');
  ok('the sheet is drawn once', c.els.holdpick.attrs['data-built'] === 'en');
  note.value = 'window ta';
  c.els.holdpick.innerHTML = 'UNCHANGED';
  run(c, 'renderHoldAsk()');
  ok('a repaint leaves the half-typed note alone', c.els.holdpick.innerHTML === 'UNCHANGED' && note.value === 'window ta');
  note.value = '  window table  ';
  run(c, 'commitHold()');
  ok('Hold in the sheet saves the trimmed note', stored(c)[0].note === 'window table' && c.S.holdOpen === false);
}

// ---- 13. storage that holds something else reads as nothing held
{
  const c = setup();
  c.localStorage.setItem('tacet-till-held:7:3', '{"not":"a list"}');
  ok('a non-list reads as empty', run(c, 'heldRead().length') === 0);
  c.localStorage.setItem('tacet-till-held:7:3', JSON.stringify([
    { id: '"><b>x', at: NOW, lines: [{ id: 1 }] }, { id: 'hgood', at: NOW, lines: [] }, null]));
  ok('a bad id or an empty bill is ignored', run(c, 'heldRead().length') === 0);
  c.localStorage.setItem('tacet-till-held:7:3', 'not json');
  ok('unreadable storage reads as empty', run(c, 'heldRead().length') === 0);
}

// ---- 14. the switch shows Held, and only when something is held
{
  const c = setup();
  run(c, 'renderSeg()');
  ok('nothing pending, nothing held: no switch', c.els.seg.hidden === true);
  bill(c); run(c, "holdNow('a')");
  run(c, 'renderSeg()');
  ok('a held bill brings the switch up', c.els.seg.hidden === false);
  ok('...with Held and its count', /data-pane="held">held<span class="b">1</.test(c.els.seg.innerHTML));
  ok('...and no empty Pending', c.els.seg.innerHTML.indexOf('data-pane="pend"') === -1);
  c.S.pane = 'held';
  run(c, "openHeld(S.held[0].id)");
  c.S.pane = 'held';
  run(c, 'normalisePane()');
  ok('a Held face with nothing to show falls back to the menu', c.S.pane === 'menu');
}

// ---- 15. the wiring that is not a function on its own
{
  const confirmSrc = fn('confirm');
  ok('Mark paid succeeding removes the held bill',
     /S\.view = 'done';[\s\S]{0,900}heldDrop\(S\.heldId\)/.test(confirmSrc));
  ok('every paint syncs the held bill first', /function render\(\) \{\n    if \(!S\.storeId\) return;\n    heldSync\(\);/.test(src));
  ok('the store change loads that shop\'s bills', /function setStore[\s\S]{0,600}heldLoad\(\);/.test(src));
  ok('the business id is read from /api/backend/me', /S\.tid = \(tn && tn\.id != null\)/.test(src));
  ok('a held bill on screen leaves without the unsaved question',
     /if \(S\.lines\.length && !S\.heldId\) \{ S\.leaveOpen = true;/.test(src));
  ok('reset forgets the bill on screen', /function reset\(\) \{\n[^\n]*S\.heldId = null/.test(src));
  ok('Hold sits under Mark paid', /id="pay"[^\n]*\n\s*<button class="hold" id="hold"[^>]*data-hold="ask"/.test(src));
  ok('taps reach Hold and the held rows', /\[data-hold\],\[data-held\][\],\[a-z-]*'\)/.test(src));
}

// ---- 16. §461 — a held bill takes its shelf lines on the server while it is held
(async () => {
  const tick = () => new Promise((r) => setImmediate(r));
  {
    const c = setup(); bill(c);
    c.S.stock = { 12: 5 };
    c.holdReply = { success: true, data: { taken: { 12: 2, 77: 2 } } };
    run(c, "holdNow('window table')");
    ok('§461: holding sends the bill to the server once', c.holdCalls.length === 1);
    const call = c.holdCalls[0];
    const id = c.S.held[0].id;
    ok('§461: ...addressed by the bill\'s own id', call.path === '/api/retail-admin/orders/till-held/' + id);
    ok('§461: ...with the shop and every line, answers as ids',
       call.body.store_id === 3 && call.body.lines.length === 2
       && call.body.lines[1].product_id === 12 && call.body.lines[1].qty === 2
       && call.body.lines[1].choices[0] === 5 && call.body.lines[0].choices === undefined);
    await tick();
    ok('§461: what the server took is kept on the bill', stored(c)[0].taken && stored(c)[0].taken[12] === 2);
    ok('§461: the grid drops by what was taken', c.S.stock[12] === 3);

    run(c, 'render()');
    ok('§461: a paint with nothing changed sends nothing', c.holdCalls.length === 1);

    // Brought back: the bill counts its own two lattes as still there for it.
    run(c, `openHeld('${id}')`);
    ok('§461: the bill on screen sees its own held units', run(c, 'stockOf(12)') === 5);
    ok('§461: ...and nothing it does not hold', run(c, 'stockOf(99)') === null);

    // One more latte goes on the same bill: the whole bill is sent again.
    c.holdReply = { success: true, data: { taken: { 12: 3, 77: 3 } } };
    c.S.lines[1].qty = 3;
    run(c, 'render()');
    ok('§461: adding to a held bill sends it again', c.holdCalls.length === 2
       && c.holdCalls[1].body.lines[1].qty === 3);
    await tick();
    ok('§461: ...and the grid moves by the difference only', c.S.stock[12] === 2);
    ok('§461: ...while the bill still sees all of its own', run(c, 'stockOf(12)') === 5);

    // Emptied line by line: the bill is over and gives everything back.
    c.holdReply = { success: true, data: { taken: {} } };
    c.S.lines = [];
    run(c, 'render()');
    ok('§461: an emptied bill sends no lines', c.holdCalls.length === 3 && c.holdCalls[2].body.lines.length === 0);
    await tick();
    ok('§461: ...and the grid gets its lattes back', c.S.stock[12] === 5);
  }
  {
    // A change made while a send is out waits for it, then goes.
    const c = setup(); bill(c);
    let release;
    c.api = (path, opts) => {
      c.holdCalls.push({ path, body: JSON.parse(opts.body) });
      return new Promise((r) => { release = () => r({ success: true, data: { taken: {} } }); });
    };
    run(c, "holdNow('a')");
    const id = c.S.held[0].id;
    run(c, `openHeld('${id}')`);
    c.S.lines[1].qty = 4;
    run(c, 'render()');
    ok('§461: a second send waits while the first is out', c.holdCalls.length === 1);
    release(); await tick(); await tick();
    ok('§461: ...and goes when it is back', c.holdCalls.length === 2 && c.holdCalls[1].body.lines[1].qty === 4);
    release(); await tick(); await tick();
    run(c, `S.heldSent['${id}'] = HELD_PAID; heldStockPush('${id}', [])`);
    ok('§461: a paid bill sends nothing more', c.holdCalls.length === 2);
  }
  {
    // A failed send is quiet: the bill stays held, and the next load sends again.
    const c = setup(); bill(c);
    c.holdReply = { success: false };
    run(c, "holdNow('a')");
    await tick();
    ok('§461: a refused send leaves the bill held', c.S.held.length === 1 && !stored(c)[0].taken);
    c.holdReply = null;
    run(c, 'heldLoad()');
    ok('§461: loading the shop\'s bills sends it again', c.holdCalls.length === 2);
  }
  {
    const confirmSrc = fn('confirm');
    ok('§461: Mark paid names the held bill', /body\.held_bill_id = S\.heldId/.test(confirmSrc));
    ok('§461: Mark paid waits for a send that is out',
       /S\.heldBusy\[S\.heldId\]\.after = confirm/.test(confirmSrc));
    ok('§461: a paid bill is marked so nothing is sent after it',
       /S\.heldSent\[S\.heldId\] = HELD_PAID/.test(confirmSrc));
  }
  finish();
})();

function finish() {
  if (problems.length) {
    console.error(`${problems.length} of ${checks} failed:`);
    for (const p of problems) console.error('  ✗ ' + p);
    process.exit(1);
  }
  console.log(`test_till_hold: ${checks} checks passed`);
}
