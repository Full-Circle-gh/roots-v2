#!/usr/bin/env node
// The supplier field in Purchasing → Invoices → "Set supplier"
// (public/retail-admin/16-purchasing.js, renderAssignModal + the puSuggest*
// menu it borrows from the payment fields).
//
// THE DEFECT THIS COVERS. The field was a native <select> carrying every
// supplier the tenant has — 78 groups on the live one. There is no way to type
// at a <select>: finding a name meant scrolling a popup drawn by the OS, which
// is also the popup the payment fields moved away from because the chat-app
// webview positions it against the wrong edge of the window entirely. It is a
// search box now, drawn by us, matching the stored name and BOTH language
// halves — a supplier is stored as one string with both glued together
// ("Dry Fruit 果干"), so neither half alone would ever match it.
//
// Nothing here asserts against what we meant to render — every check reads the
// HTML back out of the DOM stub, the way test_wizard_line_supplier.js does.
// The menu is built with createElement and hung off <body>, so the stub carries
// enough of a document for the real code to do exactly that.
//
// USAGE   node scripts/test_invoice_supplier_search.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

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
};
const sent = [];
async function api(p, opts) {
  const q = p.split('?')[0];
  if (q === '/api/retail-admin/purchasing/lines/supplier') { sent.push(opts.body); return { success: true, updated: opts.body.line_ids.length }; }
  if (q === '/api/retail-admin/stores') return { success: true, data: [{ id: 1, code: 'TH', name_en: 'Tianhe', is_active: 1 }] };
  if (q.startsWith('/api/retail-admin/suppliers')) return { success: true, data: SUPPLIERS };
  if (q === '/api/retail-admin/purchasing/invoices/outstanding') return { success: true, data: OUTSTANDING };
  if (q === '/api/retail-admin/purchasing/invoices') return { success: true, data: [] };
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
  fmt: n => String(n),
  acMoney: n => '¥' + n,
  acCurrencySymbol: () => '¥',
  applyCapGates: () => {},
  askConfirm: async () => true,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', '16-purchasing.js'), 'utf8'),
                sandbox, { filename: '16-purchasing.js' });

// ── assert harness ────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };

const modal = () => node('pu2-modal-host').innerHTML;
const field = () => node('pu2-assign-sup');
const menuEl = () => (nodes.has('pu2-suggest-menu') ? nodes.get('pu2-suggest-menu') : null);
const menu = () => { const m = menuEl(); return m && !m.hidden ? m.innerHTML : ''; };
// Typing, as the field itself does it: set the value, then fire what the
// markup's oninput fires — in that order, so the menu filters on the new text.
const type = (v) => {
  field().value = v;
  sandbox.puInvAssignTyped();
  sandbox.puSuggestOpen('pu2-assign-sup', 'suppliers');
};

async function main() {
  await sandbox.puInit();
  sandbox.puTab('invoices');
  // paintInvoices loads in the background; let its promises settle.
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));

  console.log('\n1. the field is a search box, not a dropdown');
  sandbox.puInvAssign();
  ok(modal().includes('id="pu2-assign-sup"'), 'the modal opens with the supplier field');
  ok(!/<select[^>]*puInvAssign/.test(modal()) && !modal().includes('<option'), 'no <select> is rendered any more');
  ok(modal().includes('role="combobox"'), 'it is a combobox');
  ok(modal().includes('puSuggestOpen(\'pu2-assign-sup\',\'suppliers\')'), 'wired to the same menu the payment fields use');
  ok(modal().includes('Type to search your suppliers'), 'and says so in the placeholder');

  console.log('\n2. focus offers the whole book; typing narrows it');
  sandbox.puSuggestOpen('pu2-assign-sup', 'suppliers');
  ok(menu().includes('Dry Fruit') && menu().includes('Nut House'), 'every active supplier is offered');
  ok(!menu().includes('Retired Ltd'), 'a disabled supplier is not');
  type('nut');
  ok(menu().includes('Nut House') && !menu().includes('Dry Fruit'), 'typing narrows the list to what matches');
  type('NUT');
  ok(menu().includes('Nut House'), 'the match is case-insensitive');

  console.log('\n3. 中文 finds the same rows — the half a stored name hides');
  type('果干');
  ok(menu().includes('Dry Fruit') || menu().includes('果干'), 'the Chinese half of a glued name matches');
  type('坚果');
  ok(menu().includes('Nut House') || menu().includes('坚果屋'), 'including a supplier with no separate name_cn');
  type('zzz');
  ok(menu() === '', 'a search that matches nothing closes the menu rather than showing an empty box');

  console.log('\n4. picking a row fills the field and remembers the STORED name');
  type('dry');
  const opt = menu().match(/data-v="([^"]*)"[^>]*data-label="([^"]*)"/);
  ok(!!opt, 'the row carries both the stored value and the label to show');
  ok(opt && opt[1] === 'Dry Fruit 果干', 'the value is the name the server groups on');
  ok(opt && opt[2] === 'Dry Fruit', 'the label is one language, never both at once');
  sandbox.puSuggestPick(opt[1], opt[2]);
  ok(field().value === 'Dry Fruit', 'the field shows the label');
  ok(menu() === '', 'and the menu closes behind the pick');

  console.log('\n5. ticking a line does not throw away what is in the field');
  sandbox.puInvAssignToggle(11);
  ok(field().value === 'Dry Fruit', 'the field survives an untick');
  ok(node('pu2-assignbadge').innerHTML.includes('1'), 'the footer still counts what is ticked');
  sandbox.puInvAssignToggle(11);

  console.log('\n6. what Save sends');
  await sandbox.puInvAssignSave();
  ok(sent.length === 1 && sent[0].supplier === 'Dry Fruit 果干',
     'the STORED name goes on the wire, not the label the field showed');
  ok(sent[0].line_ids.length === 2, 'with every ticked line');

  console.log('\n7. a name typed out in full and never picked still counts');
  sandbox.puInvAssign();
  type('Nut House');            // the English half, no pick
  await sandbox.puInvAssignSave();
  ok(sent.length === 2 && sent[1].supplier === 'Nut House 坚果屋',
     'it resolves to the stored name');

  console.log('\n8. a name that is nobody is refused at the field');
  sandbox.puInvAssign();
  type('Totally Made Up Co');
  toasts.length = 0;
  await sandbox.puInvAssignSave();
  ok(sent.length === 2, 'nothing is sent');
  ok(toasts.length === 1 && toasts[0].kind === 'err' && /pick one from the list/i.test(toasts[0].msg),
     'and the operator is told to pick from the list');

  console.log('\n9. an empty field is the plain "choose one" case');
  sandbox.puInvAssign();
  type('');
  toasts.length = 0;
  await sandbox.puInvAssignSave();
  ok(sent.length === 2 && toasts.length === 1 && /choose a supplier/i.test(toasts[0].msg),
     'no request, and a different message from the typo case');

  console.log('\n10. closing the modal takes the menu with it');
  sandbox.puInvAssign();
  sandbox.puSuggestOpen('pu2-assign-sup', 'suppliers');
  ok(menu() !== '', 'the menu is open');
  sandbox.puInvCloseModal();
  ok(menu() === '', 'and does not outlive the modal it belonged to (it hangs off <body>)');

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
