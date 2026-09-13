#!/usr/bin/env node
// THE ONE QUESTION THE EXPENSE FORM ASKS — §111 part two, on the screen
// (public/retail-admin/22-finance.js: finTxSave, finTxAskOrdered,
// finTxToPurchasing, finTxNeedsPo).
//
// The server half is scripts/test_finance_po_question.js. This is the half it
// cannot see: WHEN the question is put, what each answer does, and — the case
// that matters most — what happens when nobody answers it.
//
// WHY DISMISSAL HAS ITS OWN CASE. The question has three outcomes and only two
// of them are answers. A dialog whose dismissal fell through to either answer
// would mean pressing Escape either wrote a row the operator had not committed
// to or threw them into another tab; the form must be exactly where they left
// it, with what they typed still in it. That is why this is askChoice rather
// than a two-button confirm, and this suite is what holds it.
//
// THE MONEY MUST NEVER DEPEND ON THE PREFERENCE. Recording the answer is a
// convenience — it saves asking twice — so a failure to store it is swallowed
// and the row is still written. Case 8.
//
// USAGE   node scripts/test_finance_po_question_client.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { tdWhen, tdToday } = require('../public/td-datetime.js');

// ── DOM stub ──────────────────────────────────────────────────────────────
// Enough of a document for the form to be filled in and saved: every id answers,
// and a node remembers what was typed into it.
const nodes = new Map();
function makeNode(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', style: {}, hidden: false, disabled: false,
    dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    focus() {}, scrollIntoView() {}, addEventListener() {}, setAttribute() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }),
    insertAdjacentHTML(_p, html) { this.innerHTML += html; },
    appendChild(c) { if (c && c.id) nodes.set(c.id, c); this.children.push(c); return c; },
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
  };
}
const node = (id) => { if (!nodes.has(id)) nodes.set(id, makeNode(id)); return nodes.get(id); };
const body = makeNode('body');
const document = {
  getElementById: (id) => node(id),
  createElement: () => makeNode(''),
  querySelectorAll: () => [],
  addEventListener() {},
  body,
};

// ── the server, faked ─────────────────────────────────────────────────────
// One of each state, which is the whole matrix: four categories nobody has been
// asked about, one answered "not ordered", one answered "ordered".
//
// EACH UNASKED CASE TAKES ITS OWN CATEGORY, because the answers STICK — that is
// the feature. Reusing one across two cases would mean the second was really
// testing what the first had just recorded, which is a suite that passes while
// describing something else.
let LEDGER = {
  window: { from: '2026-08-01', to: '2026-09-13', span_days: 44 },
  rows: [], totals: { in: 0, out: 0 }, counts: { all: 0, in: 0, out: 0 },
  income_categories: [],
  expense_categories: ['原料 Ingredients', '包装 Packaging', '杂项 Sundries', '维修 Repairs',
                      '租金 Rent', '物料 Materials'],
  category_needs_po: { '租金 Rent': 0, '物料 Materials': 1 },
};
const calls = [];
let answerFails = false;
async function api(p, opts) {
  const q = p.split('?')[0];
  calls.push({ path: q, method: (opts && opts.method) || 'GET', body: opts && opts.body });
  if (q === '/api/retail-admin/finance/categories/answer') {
    if (answerFails) throw new Error('nope');
    return { success: true, recorded: true };
  }
  // BRANCH ON THE METHOD, not the path. The ledger read and the ledger write are
  // the same URL — the query string is stripped above — so a path-only stub
  // answers the reload with the write's response and the screen's payload
  // silently becomes undefined.
  if (q === '/api/retail-admin/finance/transactions') {
    return (opts && opts.method === 'POST') ? { success: true, id: 5 } : { success: true, data: LEDGER };
  }
  if (q.startsWith('/api/retail-admin/finance/transactions')) return { success: true, data: LEDGER };
  return { success: true, data: [] };
}

const toasts = [];
const opened = [];          // every jump into Purchasing, with its seed
const tabs = [];
let choice = null;          // what the operator picks in the dialog
const asked = [];           // every time the question was actually put

const sandbox = {
  document, console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Set, Map, Array, Object,
  Number, String, isFinite, encodeURIComponent,
  api, toast: (msg, kind) => toasts.push({ msg, kind }),
  addEventListener: () => {}, removeEventListener: () => {},
  escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  cuT: en => en,
  cuLang: () => 'en',
  tdWhen, tdToday,
  acWrap: s => '¥' + String(s),
  acMoney: n => '¥' + Number(n || 0).toFixed(2),
  applyCapGates: () => {},
  askConfirm: async () => true,
  askChoice: async (opts) => { asked.push(opts); return choice; },
  goTab: (t) => tabs.push(t),
  puNewOrderFrom: (seed) => opened.push(seed),
  tdShowTruncation: () => {},
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', '22-finance.js'), 'utf8'),
                sandbox, { filename: '22-finance.js' });

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)})`);

const posts = () => calls.filter(c => c.path === '/api/retail-admin/finance/transactions' && c.method === 'POST');
const answers = () => calls.filter(c => c.path === '/api/retail-admin/finance/categories/answer');

/* Fill the form the way a person does, then press Save. */
async function type({ kind = 'out', date = '2026-09-13', amount = '120', cat = '', note = '', edit = null }) {
  calls.length = 0; toasts.length = 0; opened.length = 0; tabs.length = 0; asked.length = 0;
  // finTxForm is what sets the module's own FIN_TX_EDIT — a `let` at the top of
  // 22-finance.js, which a VM global cannot reach. Opening the form the way the
  // screen opens it is also the only honest way to drive this.
  sandbox.finTxForm(edit || kind, edit || undefined);
  node('fin-tx-date').value = date;
  node('fin-tx-amount').value = amount;
  node('fin-tx-cat').value = cat;
  node('fin-tx-note').value = note;
  node('fin-tx-cat-row').hidden = false;
  await sandbox.finTxSave();
}

async function main() {
  calls.length = 0;
  await sandbox.finTxLoad();
  ok(calls.some(c => c.method === 'GET' && /transactions/.test(c.path)), 'the ledger payload loaded');

  console.log('\n1. an unasked category is asked about');
  choice = 'expense';
  await type({ cat: '原料 Ingredients', note: 'sesame' });
  eq(asked.length, 1, 'the question was put once');
  ok(asked[0] && /supplier/i.test(asked[0].title), 'and it asks about a supplier');
  ok(asked[0].options.length === 2, 'with exactly two answers');
  ok(asked[0].options.some(o => o.value === 'po') && asked[0].options.some(o => o.value === 'expense'),
     'a purchase order, or an expense');

  console.log('\n2. "expense" writes the row, exactly as before');
  eq(posts().length, 1, 'the transaction was posted');
  eq(posts()[0].body.amount, '120', 'with what was typed');
  eq(opened.length, 0, 'and Purchasing was NOT opened');
  eq(answers().length, 1, 'the answer was remembered');
  eq(answers()[0].body.needs_po, false, 'as "not ordered"');

  console.log('\n3. "purchase order" writes NOTHING and opens the wizard');
  choice = 'po';
  await type({ cat: '包装 Packaging', note: 'black sesame', amount: '680' });
  eq(posts().length, 0, 'NO ledger row was written');
  eq(tabs[0], 'purchasing', 'the Purchasing tab was opened');
  eq(opened.length, 1, 'on a new order');
  eq(opened[0].name, 'black sesame', 'carrying the description as the line name');
  eq(opened[0].amount, '680', 'the amount as its price');
  eq(opened[0].category, '包装 Packaging', 'and the category it was being filed under');
  eq(opened[0].date, '2026-09-13', 'dated as typed');
  eq(answers()[0].body.needs_po, true, 'and the answer was remembered as "ordered"');

  console.log('\n4. dismissing it does NOTHING AT ALL');
  choice = null;
  await type({ cat: '杂项 Sundries', note: 'unsure', amount: '50' });
  eq(posts().length, 0, 'no row was written');
  eq(opened.length, 0, 'no wizard was opened');
  eq(answers().length, 0, 'and nothing was remembered');
  eq(node('fin-tx-modal').hidden, false, 'the form is still open, with what was typed still in it');
  eq(node('fin-tx-amount').value, '50', 'the amount is untouched');

  console.log('\n5. a category already answered "not ordered" is not asked again');
  choice = 'po';   // would be taken if the question were put — it must not be
  await type({ cat: '租金 Rent', note: 'September', amount: '9000' });
  eq(asked.length, 0, 'no question');
  eq(posts().length, 1, 'the row is written straight away');
  eq(opened.length, 0, 'and Purchasing is not opened');
  eq(answers().length, 0, 'nothing is re-recorded');

  console.log('\n6. a category already answered "ordered" goes straight to Purchasing');
  choice = null;   // no dialog should be consulted at all
  await type({ cat: '物料 Materials', note: 'gloves', amount: '48' });
  eq(asked.length, 0, 'no question');
  eq(posts().length, 0, 'no ledger row');
  eq(opened.length, 1, 'the wizard opens');
  ok(toasts.some(t => /purchase order/i.test(t.msg)),
     'and a toast says where it went — a screen that changed with no word would be a worse silence');

  console.log('\n7. money IN is never asked, and neither is an edit');
  choice = 'po';
  sandbox.finTxKind('in');
  await type({ kind: 'in', cat: '', note: 'refund', amount: '20' });
  eq(asked.length, 0, 'there is no such thing as ordering revenue');
  eq(posts().length, 1, 'money in is written as always');
  sandbox.finTxKind('out');
  await type({ cat: '原料 Ingredients', amount: '12',
               edit: { kind: 'out', id: 3, source: 'manual', date: '2026-09-01', amount: 12,
                       category: '原料 Ingredients', note: 'x' } });
  eq(asked.length, 0, 'a row already in the books is not re-asked');
  eq(calls.filter(c => c.method === 'PUT' && /transactions/.test(c.path)).length, 1, 'it is simply saved');

  console.log('\n8. the money never depends on the preference');
  // The answer write is a convenience. If it fails, the row must still be
  // recorded — an expense that could not be typed because a flag could not be
  // stored would be the feature doing harm.
  answerFails = true;
  choice = 'expense';
  await type({ cat: '维修 Repairs', note: 'oil', amount: '31' });
  eq(posts().length, 1, 'the transaction was posted anyway');
  answerFails = false;

  console.log('\n9. an uncategorised row is still asked, and answered for itself');
  // The answer has nowhere to live without a category, so nothing is remembered
  // — but the question is still the right one to ask about the money.
  choice = 'expense';
  await type({ cat: '', note: 'one-off', amount: '15' });
  eq(asked.length, 1, 'the question is still put');
  eq(posts().length, 1, 'and the answer is honoured for this row');
  eq(answers().length, 0, 'with nothing recorded, because there is no category to record it on');

  console.log('\n10. if Purchasing cannot be opened, the money is still recorded');
  // The "purchase order" answer is the one path that writes NOTHING, so a
  // half-working jump would close the form on a cost that then exists nowhere.
  // An expense in the books is recoverable; an expense nobody typed twice is not.
  const savedOpen = sandbox.puNewOrderFrom;
  sandbox.puNewOrderFrom = undefined;
  choice = 'po';
  await type({ cat: '原料 Ingredients', note: 'sesame again', amount: '77' });
  eq(posts().length, 1, 'the row was written after all');
  eq(posts()[0].body.amount, '77', 'with what was typed');
  sandbox.puNewOrderFrom = savedOpen;

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
