#!/usr/bin/env node
/**
 * "can't manually enter a number" — Ask for stock, a pita at 2.
 *
 *   node scripts/test_ask_stock_typed_qty.js
 *
 * Ask for stock and Ask the kitchen share one row (rqBodyHtml): −, a number,
 * +. The number was a plain <span>, so forty of something was forty taps. It
 * is now the Ask to buy control (mbCountCell): tap the number, type, done.
 *
 * WHAT THIS FILE LOCKS, beyond "a field appears":
 *   • typing moves the quantity AND the foot (tally, Send) in place, and never
 *     calls render() — a render rebuilds the field and drops the keypad, and
 *     on blur it would eat the tap heading for Send;
 *   • whole numbers only; junk keeps the field open, says why, and shuts Send;
 *   • + on a row being typed in folds what was typed (24 then + is 25);
 *   • a fresh request and Clear forget any half-typed figure.
 *
 * No browser: the real functions are SLICED OUT OF THE SHIPPED public/m.html
 * and run against a small fake document, the technique
 * scripts/test_ask_to_buy_keyboard.js uses.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'm.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)})`);

function sliceFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in m.html`);
  let depth = 0;
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    const c = SRC[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces slicing ${name}`);
}

/* A FAKE PAGE just big enough for what these functions touch: elements by id,
   attributes, text, and an outerHTML setter that replaces the element with a
   new one parsed from the markup's own id/value. Every swap is counted, so a
   test can say WHICH nodes were replaced — the whole point of the change. */
function makeDoc() {
  const els = {};
  const swaps = [];
  let focused = null;
  function el(id, html) {
    const e = {
      id, html: html || '', attrs: {}, textContent: '', style: {},
      tag: /^\s*<input/.test(html || '') ? 'input' : 'button',
      value: ((html || '').match(/value="([^"]*)"/) || [])[1],
      setAttribute(k, v) { this.attrs[k] = String(v); },
      removeAttribute(k) { delete this.attrs[k]; },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      hasAttribute(k) { return k in this.attrs; },
      focus() { focused = this.id; },
      setSelectionRange() {},
    };
    const base = ((html || '').match(/data-base="([^"]*)"/) || [])[1];
    if (base != null) e.attrs['data-base'] = base;
    if (/\sdisabled(?=[\s>])/.test((html || '').replace(/\$\{[^}]*\}/g, ''))) e.attrs.disabled = '';
    Object.defineProperty(e, 'outerHTML', {
      get() { return this.html; },
      set(v) {
        const nid = (v.match(/id="([^"]+)"/) || [])[1];
        swaps.push(this.id);
        delete els[this.id];
        if (nid) els[nid] = el(nid, v);
      },
    });
    return e;
  }
  return {
    els, swaps, el,
    focused: () => focused,
    add(id, html) { els[id] = el(id, html); return els[id]; },
    getElementById: (id) => els[id] || null,
  };
}

const PRODUCTS = [
  { id: 7, name_en: 'Whole-Wheat Pita (Frozen)', sku: '3-251' },
  { id: 8, name_en: 'Whole-Wheat Pita (Frozen)', sku: 'S(3-251)' },
];

function sandbox(rqOver, withDom) {
  const doc = makeDoc();
  const calls = { render: 0, sync: 0, send: 0 };
  const sb = {
    state: {
      rq: Object.assign({ products: PRODUCTS.slice(), tried: true, fromShelf: false, q: '', kind: 'all',
        qty: {}, typing: {}, typeErr: {}, busy: false, err: '', sent: null,
        purpose: null, from: 2, to: 1 }, rqOver || {}),
      stack: [{ route: 'askstock' }], focus: null,
    },
    document: doc,
    T: (en) => en,
    escAttr: (s) => String(s == null ? '' : s),
    ic: (n) => `[icon:${n}]`,
    searchBox: (input) => input,
    rqName: (p) => p.name_en || '',
    render: () => { calls.render++; },
    askDraftSync: () => { calls.sync++; },
    rqItems: () => [],
    rqSend: () => { calls.send++; },
    console, Number, String, Array, Object, JSON, Math, parseInt,
  };
  vm.createContext(sb);
  for (const n of ['rcvSkuKey', 'rcvSkuCmp', 'rqKindOf', 'rqLines', 'rqChosen', 'rqUnits', 'rqTypeOk', 'rqTypeBad', 'rqCountCell',
                   'rqBodyHtml', 'rqTypeOpen', 'rqTyped', 'rqTypeCommit', 'rqSync', 'rqBump',
                   'rqFootReady', 'rqFoot', 'rqSendStock', 'rqSendKitchen', 'rqReset', 'askDraftClear']) {
    vm.runInContext(sliceFn(n), sb, { filename: `slice#${n}` });
  }
  if (withDom) {
    // What the painted screen holds: each row's count and − key, its error
    // line, and the foot's three moving parts.
    for (const p of PRODUCTS) {
      doc.add('rqnum-' + p.id, vm.runInContext(`rqCountCell(state.rq.products.find(x=>x.id===${p.id}))`, sb));
      doc.add('rqless-' + p.id, '<button id="rqless-' + p.id + '" disabled>');
      doc.add('rqerr-' + p.id, '<span>');
    }
    const foot = vm.runInContext(`rqFoot('rqSendStock', !!state.rq.from)`, sb);
    doc.add('mRqChosen', '<b>'); doc.add('mRqUnits', '<span>');
    doc.add('mRqSend', foot.slice(foot.indexOf('<button id="mRqSend"')));
  }
  return { sb, doc, calls, run: (js) => vm.runInContext(js, sb) };
}

console.log('\n══ 1. the number is a control ══');
{
  const { run } = sandbox({ qty: { 7: 2 } });
  const body = run('rqBodyHtml()');
  ok(/<button id="rqnum-7"[^>]*onclick="APP\.cmd\('rqType',7\)"/.test(body), 'the count is a button that opens typing');
  ok(/<button id="rqnum-7"[\s\S]*?>2<\/button>/.test(body), '…and shows the quantity');
  ok(!/<span class="num" style="width:44px;text-align:center;font-size:18px;font-weight:500">/.test(body),
    'the old plain-text number is gone');
  ok(/aria-label="How many\?"/.test(body), 'it says what it is to a screen reader');
  ok(/id="rqless-7"/.test(body) && /id="rqerr-7"/.test(body), 'the row carries the − key and error line the patch needs');
}

console.log('\n══ 2. opening it ══');
{
  const { run, doc, calls } = sandbox({ qty: { 7: 2 } }, true);
  run('rqTypeOpen(7)');
  eq(run('state.rq.typing[7]'), '2', 'a row at 2 opens holding 2');
  eq(doc.els['rqnum-7'].tag, 'input', 'the cell is now a field');
  ok(/inputmode="numeric"/.test(doc.els['rqnum-7'].html), '…on the number keypad');
  eq(doc.focused(), 'rqnum-7', '…and focused, so the keypad opens');
  eq(calls.render, 0, 'no render — only this cell was swapped');
  ok(doc.swaps.length === 1 && doc.swaps[0] === 'rqnum-7', 'exactly one node replaced');

  run('rqTypeOpen(8)');
  eq(run('state.rq.typing[8]'), '', 'a row at zero opens EMPTY, not "0"');
}
{
  const { run, calls } = sandbox({});
  run('rqTypeOpen(7)');
  eq(calls.render, 1, 'with nothing painted it falls back to render()');
  eq(run('state.focus.id'), 'rqnum-7', '…with the focus armed for the field');
}

console.log('\n══ 3. typing moves the amount and the foot, and nothing else ══');
{
  const { run, doc, calls } = sandbox({}, true);
  eq(doc.els.mRqSend.hasAttribute('disabled'), true, 'Send starts shut: nothing chosen');
  run('rqTypeOpen(7)');
  const swapsBefore = doc.swaps.length;
  run(`rqTyped(7,'2')`); run(`rqTyped(7,'24')`);
  eq(run('state.rq.qty[7]'), 24, 'qty follows the keys: 24');
  eq(doc.els.mRqUnits.textContent, 24, 'the tally reads 24 units');
  eq(doc.els.mRqChosen.textContent, 1, '…1 item');
  eq(doc.els.mRqSend.hasAttribute('disabled'), false, 'Send opens as soon as there is something to send');
  eq(doc.els['rqless-7'].hasAttribute('disabled'), false, 'the − key opens too');
  eq(calls.render, 0, 'render() never called while typing');
  eq(doc.swaps.length, swapsBefore, 'no node replaced while typing — the field and Send survive');
  ok(calls.sync >= 2, 'the draft is saved as it changes');

  run(`rqTyped(7,'')`);
  eq(run('state.rq.qty[7]'), 0, 'an empty field is zero');
  eq(doc.els.mRqSend.hasAttribute('disabled'), true, '…and Send shuts again');
}

console.log('\n══ 4. leaving the field ══');
{
  const { run, doc, calls } = sandbox({}, true);
  run('rqTypeOpen(7)'); run(`rqTyped(7,'40')`);
  run('rqTypeCommit(7)');
  eq(run('state.rq.typing[7]'), undefined, 'the field closes');
  eq(doc.els['rqnum-7'].tag, 'button', '…back to a button');
  ok(/>40<\/button>$/.test(doc.els['rqnum-7'].html), '…showing 40');
  eq(run('state.rq.qty[7]'), 40, 'qty kept');
  eq(calls.render, 0, 'still no render — the tap that blurred it still lands');
  ok(doc.els.mRqSend && !doc.swaps.includes('mRqSend'), 'Send is the same element it was');
  run('rqTypeCommit(7)');
  eq(run('state.rq.qty[7]'), 40, 'reaching commit twice (blur after Enter) is harmless');
}

console.log('\n══ 5. junk is refused, not stripped ══');
{
  const { run, doc, calls } = sandbox({}, true);
  run('rqTypeOpen(7)'); run(`rqTyped(7,'13')`); run(`rqTyped(7,'13o')`);
  eq(run('state.rq.qty[7]'), 13, 'a bad keystroke does not move the amount');
  run('rqTypeCommit(7)');
  eq(run('state.rq.typing[7]'), '13o', 'the field stays open with what was typed');
  eq(doc.els['rqnum-7'].tag, 'input', '…still a field');
  eq(doc.els['rqerr-7'].textContent, 'Enter a whole number, 0 or more', 'and says why');
  eq(doc.els['rqerr-7'].style.display, 'block', '…visibly');
  eq(doc.els.mRqSend.hasAttribute('disabled'), true, 'Send shuts while it is wrong');
  run('rqSendStock()');
  eq(calls.send, 0, 'and Send refuses even if reached');
  run(`rqTyped(7,'2.5')`); run('rqTypeCommit(7)');
  ok(!!run('state.rq.typeErr[7]'), 'a decimal is refused: these are pieces');

  run(`rqTyped(7,'13')`); run('rqTypeCommit(7)');
  eq(run('state.rq.typeErr[7]'), undefined, 'fixing it clears the error');
  eq(doc.els['rqerr-7'].style.display, 'none', '…and hides the line');
  eq(doc.els.mRqSend.hasAttribute('disabled'), false, '…and Send opens');
  run('rqSendStock()');
  eq(calls.send, 1, 'and sends');
}
{
  const { run, calls } = sandbox({ purpose: 'shelf', qty: { 7: 3 }, typing: { 7: 'x' }, typeErr: { 7: 'e' } });
  run('rqSendKitchen()');
  eq(calls.send, 0, 'Ask the kitchen refuses to send over a bad figure too');
}

console.log('\n══ 6. + and − on a row being typed in ══');
{
  const { run, calls } = sandbox({}, true);
  run('rqTypeOpen(7)'); run(`rqTyped(7,'24')`);
  run('rqBump(7,1)');
  eq(run('state.rq.qty[7]'), 25, 'typing 24 then + is 25');
  eq(run('state.rq.typing[7]'), undefined, 'the field is folded and closed');
  eq(calls.render, 1, 'a step repaints as it always did');
}
{
  const { run } = sandbox({}, true);
  run('rqTypeOpen(7)'); run(`rqTyped(7,'2')`); run(`rqTyped(7,'2x')`);
  run('rqBump(7,1)');
  eq(run('state.rq.qty[7]'), 2, 'junk is never folded in by the + key');
  ok(!!run('state.rq.typeErr[7]'), '…it says why instead');
}

console.log('\n══ 7. the foot ══');
{
  const { run } = sandbox({ qty: { 7: 2 } });
  const f = run(`rqFoot('rqSendStock', true)`);
  ok(/id="mRqSend" data-base="1"/.test(f), 'Send carries the screen\'s own answer for the in-place patch');
  ok(/id="mRqChosen"/.test(f) && /id="mRqUnits"/.test(f), 'the tally has its patch targets');
  ok(!/id="mRqSend"[^>]*disabled/.test(f), 'open with a location chosen and a line on it');
  ok(/id="mRqSend"[^>]*disabled/.test(run(`rqFoot('rqSendStock', false)`)), 'shut with no location chosen');
  const screens = sliceFn('screenAskStock') + sliceFn('screenAskKitchen');
  ok(/rqFoot\('rqSendStock', !!r\.from\)/.test(screens) && /rqFoot\('rqSendKitchen', !!r\.purpose\)/.test(screens),
    'each screen hands the foot only its own question');
}

console.log('\n══ 8. a fresh request and Clear forget a half-typed figure ══');
{
  const { run } = sandbox({ typing: { 7: '9' }, typeErr: { 8: 'e' }, qty: { 7: 9 } });
  run('rqReset()');
  eq(JSON.stringify([run('state.rq.typing'), run('state.rq.typeErr')]), '[{},{}]', 'rqReset');
  run(`state.rq.typing={7:'9'}; state.rq.typeErr={8:'e'}`);
  run('askDraftClear()');
  eq(JSON.stringify([run('state.rq.typing'), run('state.rq.typeErr'), run('state.rq.qty')]), '[{},{},{}]', 'Clear');
  ok(/typing:\{\},typeErr:\{\}/.test(SRC.slice(SRC.indexOf('  rq:{products:null'), SRC.indexOf('  rq:{products:null') + 600)),
    'the boot state has both maps');
}

console.log('\n══ 9. wiring and words ══');
{
  for (const c of ['rqType', 'rqTyped', 'rqTypeCommit']) ok(SRC.includes(`reg('${c}'`), `command ${c} is registered`);
  // Nothing composed: both pairs are live elsewhere in the app already.
  const live = (pair) => SRC.split(pair).length - 1;
  ok(live(`T('Enter a whole number, 0 or more','请输入 0 或以上的整数')`) >= 2, 'the error pair is a live string, reused');
  ok(live(`T('How many?','数量')`) >= 2, 'the label pair is a live string, reused');
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
