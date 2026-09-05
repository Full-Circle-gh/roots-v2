#!/usr/bin/env node
// The Re-match screen — the one lib/po-supersede.js says the decision needs.
//
// A 发票 recorded against a kitchen order that a placed RPO copy has since
// replaced is counted nowhere on Purchasing → Invoices (see
// scripts/test_invoice_recorded_off_chase.js). The strip names that money;
// this modal is where the buyer moves it onto the copy.
//
// WHAT THIS FILE IS FOR, and why it is separate from
// scripts/test_invoice_rematch.js: that one drives the REAL routers against a
// real database and proves the server plans and applies correctly. This one
// drives the SHIPPED module in a vm against a stubbed server and proves the
// screen shows the buyer what they are agreeing to before it writes — the
// pairing, the lines it cannot pair, and the credit a corrected quantity
// leaves behind. A re-match that moved money without showing its work would
// pass every assertion in the other file and still be the silent remap
// lib/po-supersede.js refuses.
//
// Nothing here asserts against what we meant to render — every check reads the
// HTML back out of the DOM stub, as test_invoice_supplier_search.js does, whose
// stub this borrows.
//
// USAGE   node scripts/test_invoice_rematch_screen.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
// The REAL date module, not a stub. Every admin part renders through tdWhen
// and asks tdToday() for the store's day; a sandbox without them throws on
// the first row that carries a date. Stubbing them would let a format drift
// past every suite in this directory at once.
const { tdWhen, tdToday } = require('../public/td-datetime.js');

// ── DOM stub ──────────────────────────────────────────────────────────────
// getElementById hands back a node for ANY id: the module paints a shell and
// then looks the ids inside it back up. appendChild registers whatever it is
// given under its own id, which is how the modal host and the search menu —
// both created at runtime — become findable.
const nodes = new Map();
function makeNode(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', style: {}, hidden: false, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    focus() {}, scrollIntoView() {}, addEventListener() {}, setAttribute() {},
    getBoundingClientRect: () => ({ left: 40, top: 300, right: 340, bottom: 330, width: 300, height: 30 }),
    insertAdjacentHTML(_pos, html) { this.innerHTML += html; },
    appendChild(child) { if (child && child.id) nodes.set(child.id, child); this.children.push(child); return child; },
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
  };
}
function node(id) {
  if (!nodes.has(id)) nodes.set(id, makeNode(id));
  return nodes.get(id);
}
const document = {
  getElementById: id => (nodes.has(id) ? nodes.get(id) : node(id)),
  createElement: () => makeNode(''),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  body: makeNode('body'),
};

// ── the server, faked ─────────────────────────────────────────────────────
// Two suppliers whose names are the two live shapes: one glued bilingual
// string, and one English-only name.
const SUPPLIERS = [
  { id: 1, name: 'Dry Fruit 果干', name_cn: '果干', is_active: 1 },
  { id: 2, name: 'Nut House 坚果屋', is_active: 1 },
  { id: 3, name: 'Retired Ltd', is_active: 0 },
];
const UNSPEC = '未指定 Unspecified';
const LINES = [
  { line_id: 11, po_id: 5, po_number: 'RPO-0001', date: '2026-08-27', name_en: 'Apple Banana', name_cn: '苹果蕉',
    sku: 'A-3', qty: 1, cost_per_unit: 19, amount: 19, covered: 0, outstanding: 19, status: 'awaiting',
    line_no_invoice: false, po_no_invoice: false },
  { line_id: 12, po_id: 5, po_number: 'RPO-0001', date: '2026-08-27', name_en: 'Sesame Banana', name_cn: '芝麻蕉',
    sku: 'A-4', qty: 1, cost_per_unit: 25, amount: 25, covered: 0, outstanding: 25, status: 'awaiting',
    line_no_invoice: false, po_no_invoice: false },
];
const OUTSTANDING = {
  month: null,
  groups: [{
    supplier: UNSPEC, supplier_cn: null, total: 44, fully_invoiced: 0, partially_invoiced: 0,
    awaiting: 44, no_invoice_expected: 0, line_count: 2, po_numbers: ['RPO-0001'], reach: null, lines: LINES,
  }],
  totals: { total: 44, fully_invoiced: 0, partially_invoiced: 0, awaiting: 44, no_invoice_expected: 0, line_count: 2 },
  aging: { notDue: 0, dueSoon: 0, overdue: 0, overdueCount: 0 },
  recorded_elsewhere: { amount: 1285.02, order_count: 2, by_reason: { superseded: 1285.02 },
    orders: [
      { po_number: 'PO-0049', reason: 'superseded', amount: 1225.02, status: 'Ordered', copy_po_number: 'RPO-0005', po_id: 49 },
      { po_number: 'PO-0052', reason: 'superseded', amount: 60.00,   status: 'Ordered', copy_po_number: 'RPO-0008', po_id: 52 },
    ] },
};
const PLANS = {
  49: { source: { po_number: 'PO-0049' }, copy: { po_number: 'RPO-0005' }, total: 1225.02, movable: 1225.02,
        unmatched: [], moves: [ { amount: 1225.02, basis: 'sku', credit_due: 0,
          from: { name_en: 'Coconut Cream', name_cn: '椰浆', sku: 'F-6' },
          to:   { name_en: 'Coconut Cream', name_cn: '椰浆', sku: 'F-6' } } ] },
  52: { source: { po_number: 'PO-0052' }, copy: { po_number: 'RPO-0008' }, total: 60, movable: 40,
        unmatched: [ { amount: 20, from: { name_en: 'Oat Flour', name_cn: '燕麦粉', sku: 'D-9' } } ],
        moves: [ { amount: 40, basis: 'name', credit_due: 5,
          from: { name_en: 'Pea Protein', name_cn: '豌豆蛋白粉', sku: '' },
          to:   { name_en: 'Pea Protein', name_cn: '豌豆蛋白粉', sku: '' } } ] },
};
const sent = [];
async function api(p, opts) {
  const q = p.split('?')[0];
  if (q === '/api/retail-admin/purchasing/lines/supplier') { sent.push(opts.body); return { success: true, updated: opts.body.line_ids.length }; }
  if (q === '/api/retail-admin/stores') return { success: true, data: [{ id: 1, code: 'TH', name_en: 'Tianhe', is_active: 1 }] };
  if (q.startsWith('/api/retail-admin/suppliers')) return { success: true, data: SUPPLIERS };
  if (q === '/api/retail-admin/purchasing/invoices/outstanding') return { success: true, data: OUTSTANDING };
  if (q.startsWith('/api/retail-admin/purchasing/invoices/rematch/')) {
    const id = Number(q.split('/').pop());
    if (opts && opts.method === 'POST') { sent.push({ post: id }); return { success: true, data: { moved: 1, amount: PLANS[id].movable, unmatched: PLANS[id].unmatched.length, to_po_number: PLANS[id].copy.po_number } }; }
    return { success: true, data: PLANS[id] };
  }
  if (q === '/api/retail-admin/purchasing/invoices') { if (opts && opts.method) { sent.push(opts.body); return { success: true, id: 7 }; } return { success: true, data: [] }; }
  return { success: true, data: [] };
}

const toasts = [];
const sandbox = {
  document, console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Set, Map, Array, Object, isFinite, String,
  URLSearchParams,
  api, toast: (msg, kind) => toasts.push({ msg, kind }),
  addEventListener: () => {}, removeEventListener: () => {},
  innerHeight: 900, innerWidth: 1200,
  escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  cuT: en => en,                       // the suite reads the English side
  tdWhen, tdToday,
  fmt: n => String(n),
  acMoney: n => '¥' + n,
  acCurrencySymbol: () => '¥',
  applyCapGates: () => {},
  askConfirm: async () => true,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
// Resolved from this file, not from an absolute path. It used to read
// '/home/user/roots-v2/public/…', so the suite passed on exactly one machine
// and threw ENOENT anywhere else — a CI runner, a second checkout, anybody
// else's laptop. Nothing caught it because nothing ran these files.
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', '16-purchasing.js'), 'utf8'),
                sandbox, { filename: '16-purchasing.js' });

let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;console.log('  OK  '+m);} else {fail++;console.log('  XX  '+m);} };
const modal=()=>node('pu2-modal-host').innerHTML;
const settle=()=>new Promise(r=>setTimeout(r,0));
async function main(){
  await sandbox.puInit(); sandbox.puTab('invoices');
  await settle(); await settle();
  ok(node('pu2-inv-body').innerHTML.includes('puInvRematchOpen()'), 'the strip offers a Re-match button');

  sandbox.puInvRematchOpen();
  await settle(); await settle(); await settle();
  const m = modal();
  ok(m.includes('Re-match recorded'), 'the modal opens');
  ok(m.includes('PO-0049 → RPO-0005'), 'it names the order pair');
  ok(m.includes('PO-0052 → RPO-0008'), 'and the second');
  ok(m.includes('can’t be paired'), 'it flags the line it cannot pair');
  ok(m.includes('credit due'), 'and the credit due on the corrected line');
  ok(m.includes('1 of 2 orders'), 'only the cleanly-pairing order is ticked by default');
  ok(m.includes('¥1225.02'), 'the footer sums what is ticked');

  sandbox.puInvRematchLines(52);
  const d = modal();
  ok(d.includes('Pea Protein'), 'Show lines reveals the pairing');
  ok(d.includes('matched on'), 'and names the basis it paired on');
  ok(d.includes('nothing on the copy matches'), 'and says what stays put');

  sent.length = 0; toasts.length = 0;
  sandbox.puInvRematchToggle(52);
  await sandbox.puInvRematchSave();
  await settle();
  ok(sent.filter(x=>x && x.post).length === 2, 'Move posts once per ticked order');
  ok(sent.some(x=>x.post===49) && sent.some(x=>x.post===52), 'for both orders');
  ok(modal() === '', 'and the modal closes');
  ok(toasts.some(t=>t.kind==='ok'), 'with a confirmation toast');
  console.log('  toast: ' + toasts.map(t=>t.msg).join(' | '));

  console.log(`\n${fail?'FAIL':'PASS'} ${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
}
main().catch(e=>{console.error(e);process.exit(2);});
