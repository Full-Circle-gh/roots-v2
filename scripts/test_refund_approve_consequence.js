#!/usr/bin/env node
/**
 * Approve says what it will do, before it is pressed.
 *
 *   node scripts/test_refund_approve_consequence.js
 *
 * No network, no DB, no browser. The real dialog is evaluated in a vm against a
 * minimal DOM, so this drives the shipped renderer rather than a copy of it.
 *
 * WHY THIS EXISTS
 * ---------------
 * A customer with no other way to ask for a different delivery day files a
 * REFUND asking for one. Live order TC000823, 2026-09-22: the refund reason read
 * "I wnat to get it tomorrow", and a staff member answered it with the note
 * "deliver tomorrow".
 *
 * Reject was pressed, which was right. Approve was one button along, and it
 * would have refunded the order — and on a full amount flipped it to `refunded`
 * and pulled the same-city rider (qingyunDropCopyForClosedOrder) — while
 * changing the delivery date by exactly nothing.
 *
 * The dialog's only account of itself was one line of developer language at the
 * top ("order.status flips to refunded + inventory + points reverse") which did
 * not mention the courier at all. So the one consequence an operator could not
 * undo was the one the screen never named.
 *
 * WHAT IS LOCKED
 *   1. the courier drop is named, and named only when a full refund would cause
 *      it — a partial keeps the delivery and must not claim otherwise;
 *   2. a rider actually on the order is called out, in bold, and only then;
 *   3. "full" is decided the way the SERVER decides it — against remaining GROSS
 *      tenders, not the order total, which differ on a points/wallet order — so
 *      the sentence cannot promise one thing while the endpoint does another;
 *   4. an operator who picks "Partial — amount" and types the whole total is
 *      shown the FULL consequences, because that is what the server will do;
 *   5. the line that addresses the actual trap — refunding never moves the day —
 *      is present in every mode;
 *   6. every sentence carries its Chinese.
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

const ROOT = path.join(__dirname, '..');
const ORDERS_JS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
const RETAIL_JS = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');

function slice(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  const open = src.indexOf('{', start + anchor.length);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces after ${anchor}`);
}

const DIALOG = slice(ORDERS_JS, 'function openRefundApproveDialog(orderId)');

// ── A DOM small enough to read and big enough for this dialog ────────────────
// Only what the renderer touches: innerHTML as a string, querySelector over the
// handful of ids and classes it asks for, and listeners that can be fired.
function makeDom() {
  const registry = new Map();     // selector → node
  const listeners = [];
  const node = (extra = {}) => Object.assign({
    style: {}, innerHTML: '', value: '', checked: false, dataset: {}, textContent: '',
    addEventListener(ev, fn) { listeners.push(fn); },
    closest() { return { remove() {} }; },
  }, extra);
  return { registry, listeners, node };
}

// Render the real dialog for one order + one set of operator choices, then read
// the consequence box back.
function consequence({ order, mode = 'full', amount = null, lines = null, lang = 'en' }) {
  const dom = makeDom();
  const consequenceBox = dom.node();
  const amtInput = dom.node({ value: amount == null ? '' : String(amount) });
  const modeNodes = ['full', 'amount', 'lines'].map(v => dom.node({ value: v, checked: v === mode }));
  const lineChks = (lines || []).map(l => dom.node({ dataset: { item: String(l.item_id), unit: String(l.unit) }, checked: !!l.checked }));
  const lineQtys = (lines || []).map(l => dom.node({ dataset: { item: String(l.item_id) }, value: String(l.qty) }));
  const lineAmts = new Map((lines || []).map(l => [String(l.item_id), dom.node()]));

  const bg = {
    className: '', style: {}, innerHTML: '',
    querySelector(sel) {
      if (sel === '#rf-consequence') return consequenceBox;
      if (sel === '#rf-amt') return amtInput;
      if (sel === 'input[name="rf-mode"]:checked') return modeNodes.find(n => n.checked) || null;
      if (sel === '#rf-amt-wrap' || sel === '#rf-lines-wrap' || sel === '#rf-points-wrap') return dom.node();
      if (sel === '#rf-points' || sel === '#rf-submit' || sel === '#rf-note') return dom.node();
      if (sel === '#rf-lines-total') return dom.node();
      let m = /^\.rf-line-qty\[data-item="(.+)"\]$/.exec(sel);
      if (m) return lineQtys.find(n => n.dataset.item === m[1]) || dom.node({ value: '0' });
      m = /^#rf-line-amt-(.+)$/.exec(sel);
      if (m) return lineAmts.get(m[1]) || dom.node();
      return dom.node();
    },
    querySelectorAll(sel) {
      if (sel.includes('rf-mode')) return modeNodes;
      if (sel === '.rf-line-chk') return lineChks;
      if (sel === '.rf-line-qty') return lineQtys;
      if (sel === '.rf-line-chk, .rf-line-qty') return [...lineChks, ...lineQtys];
      if (sel.includes('rf-mode') || sel.includes('#rf-amt')) return [...modeNodes, amtInput, ...lineChks, ...lineQtys];
      return [...modeNodes, amtInput, ...lineChks, ...lineQtys];
    },
  };

  const ctx = {
    _OPEN_ORDER: order,
    document: { createElement: () => bg },
    toast: () => {},
    cuT: (en, cn) => (lang === 'cn' ? cn : en),
    escapeHtml: (s) => String(s == null ? '' : s),
    acMoney: (n) => '¥' + Number(n || 0).toFixed(2),
    acCurrencySymbol: () => '¥',
    itemThumb: () => '', itemSkuHtml: () => '',
    mountFloatingPuModal: () => {},
    api: async () => ({}),
    openOrder: () => {},
  };
  vm.createContext(ctx);
  new vm.Script(`${DIALOG}\nopenRefundApproveDialog(${order.id});`).runInContext(ctx);
  return consequenceBox.innerHTML;
}

// A plain cash order with a rider on the way. Each test changes one thing.
const baseOrder = (over = {}) => Object.assign({
  id: 823, total: 104.5, items: [], refund_lines_json: null,
  refund_amount_requested: null, refund_amount_approved: null,
  points_amount: 0, balance_used: 0,
  courier: { stage: 'heading_to_pickup' },
}, over);

console.log('\nThe consequence line above the Approve button\n');

it('a full refund names the courier cancellation', () => {
  const html = consequence({ order: baseOrder(), mode: 'full' });
  assert.ok(/same-city delivery is cancelled/.test(html),
    'the one consequence an operator cannot undo is still unnamed');
});

it('…and a partial one says the delivery is KEPT', () => {
  const html = consequence({ order: baseOrder(), mode: 'amount', amount: 10 });
  assert.ok(/keeps its status and its delivery/.test(html), 'the partial wording is missing');
  assert.ok(!/delivery is cancelled/.test(html), 'a partial refund claims to cancel the delivery');
});

it('a rider actually on it is called out', () => {
  const html = consequence({ order: baseOrder(), mode: 'full' });
  assert.ok(/A rider is on this order right now/.test(html), 'the live rider is not mentioned');
  assert.ok(/<b>A rider is on this order/.test(html), 'it is not emphasised');
});

it('…and is NOT called out when no rider is on it', () => {
  const html = consequence({ order: baseOrder({ courier: null }), mode: 'full' });
  assert.ok(!/A rider is on this order/.test(html), 'a rider was announced over an order with none');
});

it('…nor when the courier job is already cancelled', () => {
  // §218's stage. Nothing is there to cancel.
  const html = consequence({ order: baseOrder({ courier: { stage: 'cancelled' } }), mode: 'full' });
  assert.ok(!/A rider is on this order/.test(html), 'a cancelled rider counted as one on the road');
});

it('…nor on a partial, which does not touch the delivery', () => {
  const html = consequence({ order: baseOrder(), mode: 'amount', amount: 10 });
  assert.ok(!/A rider is on this order/.test(html), 'a partial refund warned about the rider');
});

it('"Partial — amount" typed up to the full total shows the FULL consequences', () => {
  // The trap inside the trap: the server reads isFull off the AMOUNT, not the
  // radio, so this IS a full refund however the operator labelled it.
  const html = consequence({ order: baseOrder(), mode: 'amount', amount: 104.5 });
  assert.ok(/same-city delivery is cancelled/.test(html),
    'an amount covering the whole order was described as a partial refund');
});

it('the threshold is the SERVER\'s — gross tenders, not the order total', () => {
  // ¥104.50 cash + ¥30 wallet + ¥10 points = ¥144.50 gross. Refunding ¥104.50
  // is NOT full here, and a line keyed on o.total would have said it was.
  const o = baseOrder({ balance_used: 30, points_amount: 10 });
  const html = consequence({ order: o, mode: 'amount', amount: 104.5 });
  assert.ok(/keeps its status and its delivery/.test(html),
    'the order total was used as the full-refund threshold instead of gross tenders');
  const full = consequence({ order: o, mode: 'amount', amount: 144.5 });
  assert.ok(/same-city delivery is cancelled/.test(full), 'the gross total does not read as full');
});

it('an earlier partial refund moves the threshold down, as the server does', () => {
  const o = baseOrder({ refund_amount_approved: 50 });   // ¥54.50 still owed
  const html = consequence({ order: o, mode: 'amount', amount: 54.5 });
  assert.ok(/same-city delivery is cancelled/.test(html),
    'the already-approved slice was not deducted, so the remainder did not read as full');
});

it('the client and the server use the same comparison', () => {
  // Pinned as a pair: a change to either side alone is silent otherwise, and
  // its failure mode is the sentence promising what the endpoint will not do.
  assert.ok(/const isFull = amount \+ 0\.005 >= remainingGross;/.test(RETAIL_JS),
    'the server changed how it decides a full refund');
  assert.ok(/\(amt \+ 0\.005\) >= remainingGross/.test(DIALOG),
    'the dialog changed how it predicts a full refund');
});

it('the line that addresses the actual trap is in every mode', () => {
  for (const args of [{ mode: 'full' }, { mode: 'amount', amount: 10 }, { mode: 'lines' }]) {
    const html = consequence(Object.assign({ order: baseOrder() }, args));
    assert.ok(/Refunding never changes the delivery day/.test(html), `missing in mode ${args.mode}`);
    assert.ok(/reject this and change the date instead/.test(html), `no alternative offered in mode ${args.mode}`);
  }
});

it('every sentence carries its Chinese', () => {
  const full = consequence({ order: baseOrder(), mode: 'full', lang: 'cn' });
  assert.ok(/同城配送将被取消/.test(full), 'the full-refund Chinese is missing');
  assert.ok(/当前已有骑手接单/.test(full), 'the rider warning has no Chinese');
  assert.ok(/退款不会更改配送日期/.test(full), 'the delivery-day line has no Chinese');
  const part = consequence({ order: baseOrder(), mode: 'amount', amount: 10, lang: 'cn' });
  assert.ok(/订单状态与配送均不变/.test(part), 'the partial Chinese is missing');
});

it('the old developer-language subtitle is gone from the dialog', () => {
  // The phrase survives in ONE place on purpose — the comment explaining why the
  // line was replaced — so this asserts it is no longer anywhere it could render,
  // rather than that the file never mentions it. A whole-file check would go
  // green the day somebody deletes the comment and red the day somebody quotes
  // it, neither of which is the thing worth knowing.
  const hits = ORDERS_JS.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => l.includes('order.status flips to refunded'));
  for (const [line, text] of hits) {
    assert.ok(text.trim().startsWith('//'),
      `the jargon subtitle still renders at 04-orders.js:${line}`);
  }
  assert.ok(/Lock in the amount\. What each mode does is spelled out above the button\./.test(DIALOG),
    'the replacement subtitle is missing');
  assert.ok(/确认退款金额。各模式的具体影响见按钮上方说明。/.test(DIALOG),
    'the replacement subtitle has no Chinese');
});

it('the full-refund box is marked as the dangerous one', () => {
  assert.ok(/borderLeftColor = full \? 'var\(--danger\)'/.test(DIALOG),
    'full and partial look identical');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
