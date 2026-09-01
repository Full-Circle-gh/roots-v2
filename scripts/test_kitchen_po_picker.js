#!/usr/bin/env node
// The Tacet-side half of "Copy from kitchen": the picker modal in
// public/retail-admin/16-purchasing.js.
//
// The module is a plain IIFE over one shared global scope, so it runs inside a
// `vm` context with the handful of globals 01-core.js normally supplies
// (escapeHtml, cuT, fmt, acMoney, api, toast) and a DOM stub that records what
// each innerHTML assignment produced. Nothing is asserted against what we meant
// to render — every check reads the HTML back out.
//
// Run:  node scripts/test_kitchen_po_picker.js
//
// Cases:
//   1. the Orders toolbar offers the copy entry at all
//   2. the picker lists the kitchen orders the server offered
//   3. an order that already has a copy is shown as copied and is NOT tickable
//   4. the Copy button is dead until something is ticked AND a store is chosen
//   5. "Select all shown" ticks only what the search is showing
//   6. copying POSTs the ticked ids + the chosen store, and reloads the ledger

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ── DOM stub: enough of a document for the module's innerHTML writes ──────
// getElementById hands back a node for ANY id, because the module paints a
// shell and then looks up the ids inside it. Assigning to the modal host's
// innerHTML clears the nodes that shell owns, the way a real replacement does
// — otherwise a stale body would keep answering after the modal closed.
const nodes = new Map();
const OWNED = ['pu2-kmodal', 'pu2-kbody', 'pu2-kfoot'];
function node(id) {
  if (!nodes.has(id)) {
    let html = '';
    const n = {
      id, style: {}, value: '', className: '',
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild(c) { this.child = c; }, querySelectorAll: () => [],
      addEventListener() {}, closest: () => null,
    };
    Object.defineProperty(n, 'innerHTML', {
      get: () => html,
      set: v => {
        html = v;
        if (id === 'pu2-modal-host') OWNED.forEach(o => nodes.delete(o));
      },
    });
    nodes.set(id, n);
  }
  return nodes.get(id);
}
const document = {
  getElementById: node,
  createElement: () => node('pu2-modal-host'),
  querySelectorAll: () => [],
  addEventListener() {},
  body: { classList: { contains: () => false } },
};

// ── the server, faked ─────────────────────────────────────────────────────
const KITCHEN = [
  { id: 48, po_number: 'PO-0048', date: '2026-08-01', status: 'Ordered', supplier: 'Fresh Co.',
    warehouse: 'Main', line_count: 2, total_cost: 125, copy_id: null, copy_po_number: null },
  { id: 49, po_number: 'PO-0049', date: '2026-08-02', status: 'Requested', supplier: 'Oat Works',
    warehouse: null, line_count: 1, total_cost: 27, copy_id: null, copy_po_number: null },
  { id: 50, po_number: 'PO-0050', date: '2026-08-03', status: 'Ordered', supplier: 'Fresh Co.',
    warehouse: null, line_count: 3, total_cost: 300, copy_id: 91, copy_po_number: 'RPO-0009' },
];
const posted = [];
let poListLoads = 0;
async function api(p, opts) {
  if (p.startsWith('/api/retail-admin/purchases/kitchen-source')) return { success: true, data: KITCHEN };
  if (p === '/api/retail-admin/purchases/copy-from-kitchen') {
    posted.push(opts.body);
    return { success: true, data: [{ id: 92, po_number: 'RPO-0010' }] };
  }
  if (p === '/api/retail-admin/purchases') { poListLoads++; return { success: true, data: [] }; }
  if (p === '/api/retail-admin/stores') {
    return { success: true, data: [{ id: 1, name_en: 'Tianhe', name_cn: '天河店', is_active: 1 },
                                   { id: 2, name_en: 'Zhujiang', name_cn: '珠江店', is_active: 1 }] };
  }
  if (p.startsWith('/api/retail-admin/suppliers')) return { success: true, data: [] };
  return { success: true, data: [] };
}

const sandbox = {
  document, console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Set, Map, Array, Object,
  api, toast: () => {},
  // The module registers document- and window-level listeners at load time
  // (picker dismissal, the suggestion popover's resize handler). They only have
  // to exist; nothing here fires them.
  addEventListener: () => {}, removeEventListener: () => {},
  escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  cuT: en => en,
  fmt: n => String(n),
  acMoney: n => '¥' + n,
  acCurrencySymbol: () => '¥',
  applyCapGates: () => {},
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', '16-purchasing.js'), 'utf8'),
                sandbox, { filename: '16-purchasing.js' });

// ── assert harness ────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };
// What the buyer actually sees: the shell plus the two panels painted into it.
const modalHtml = () => OWNED.concat('pu2-modal-host')
  .map(id => (nodes.has(id) ? nodes.get(id).innerHTML : '')).join('\n');
const hostHtml = () => node('pu2-modal-host').innerHTML;
const tick = () => new Promise(r => setTimeout(r, 0));

async function main() {
  await sandbox.puInit();
  await tick();

  console.log('\n══ 1 · the Orders toolbar offers the copy entry ══');
  const orders = node('pu2-root').innerHTML;
  ok(orders.includes('puKitchenOpen()'), 'a "Copy from kitchen" button is on the toolbar');
  ok(orders.indexOf('puKitchenOpen()') < orders.indexOf('puNewOrder()'),
     'it sits before "New order" — the primary action stays last');

  console.log('\n══ 2 · the picker lists what the kitchen has ══');
  await sandbox.puKitchenOpen();
  await tick();
  const h = modalHtml();
  ok(h.includes('PO-0048') && h.includes('PO-0049') && h.includes('PO-0050'), 'all three kitchen orders render');
  ok(h.includes('Fresh Co.'), 'the supplier renders');
  ok(h.includes('¥125'), 'the order total renders');
  ok(h.includes('Main'), 'the kitchen warehouse renders under the supplier');

  console.log('\n══ 3 · an already-copied order is shown, not offered ══');
  const row50 = h.slice(h.indexOf('PO-0050') - 400, h.indexOf('PO-0050') + 400);
  ok(row50.includes('RPO-0009'), 'it names the copy it already has');
  ok(!row50.includes('puKitchenToggle(50)'), 'and its row cannot be ticked');
  ok(h.includes('puKitchenToggle(48)'), 'while an uncopied one can be');

  console.log('\n══ 4 · the Copy button waits for a choice ══');
  ok(/puKitchenCopy\(\)/.test(modalHtml()), 'the copy button is rendered');
  ok(/disabled[^>]*onclick="puKitchenCopy\(\)"/.test(modalHtml()), 'disabled with nothing ticked');
  sandbox.puKitchenToggle(48);
  ok(!/disabled[^>]*onclick="puKitchenCopy\(\)"/.test(modalHtml()), 'live once an order is ticked');
  ok(modalHtml().includes('Copy 1 order'), 'and the button counts what is ticked');
  sandbox.puKitchenToggle(49);
  ok(modalHtml().includes('Copy 2 orders'), 'the count follows a second tick');
  // The note used to warn that a copy is "a second row for the same purchase"
  // whose cost posts again. It no longer does post again — placing the copy
  // hands the books and the 发票 chase over from the kitchen original
  // (lib/po-supersede.js) — so the note now says what actually happens, and
  // this asserts the handover is on the SCREEN and not only in a route comment.
  ok(modalHtml().includes('takes over the books'),
     'the handover note is on the screen, not only in the code');

  console.log('\n══ 5 · "select all" never reaches past the search ══');
  sandbox.puKitchenToggle(48); sandbox.puKitchenToggle(49);   // clear
  sandbox.puKitchenSearch('Oat');
  ok(!modalHtml().includes('PO-0048'), 'the search narrowed the list');
  sandbox.puKitchenAll();
  ok(modalHtml().includes('Copy 1 order'), 'select-all ticked only the shown order');
  sandbox.puKitchenSearch('');
  ok(modalHtml().includes('Copy 1 order'), 'clearing the search did not tick the rest');

  console.log('\n══ 6 · copying sends the ticked ids and the chosen store ══');
  sandbox.puKitchenStore('2');
  const loadsBefore = poListLoads;
  await sandbox.puKitchenCopy();
  await tick();
  ok(posted.length === 1, 'one request went out');
  ok(JSON.stringify(posted[0].po_ids) === '[49]', 'carrying the ticked kitchen po id');
  ok(posted[0].store_id === 2, 'and the store the buyer picked');
  ok(poListLoads > loadsBefore, 'the retail ledger reloaded afterwards');
  ok(hostHtml() === '', 'and the picker closed');

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
