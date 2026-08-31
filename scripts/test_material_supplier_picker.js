#!/usr/bin/env node
//
// test_material_supplier_picker.js — the Supplier field on a material record
// (public/retail-admin/18-materials.js).
//
// THE DEFECT THIS COVERS. The field was a native <select> carrying the whole
// supplier book — 80+ names on the live tenant, ordered by name, with no way
// to type at it. Finding "Kosher salt's" supplier meant scrolling a popup
// drawn by the OS combobox widget, which is also the popup both Purchasing
// screens moved away from because some embedding webviews (chat-app browser
// panes) position it against the wrong edge of the window entirely. And a
// supplier you had not added yet was a dead end: the only way to add one was
// to leave the material, go to Purchasing → Suppliers, add it, and come back.
//
// It is a search box now, drawn by us: it scrolls, it filters as you type
// over BOTH language halves of a stored name, it takes the keyboard, and it
// carries a "New supplier" button plus an in-menu create row that writes to
// the shared supplier book and fills the field with what it made.
//
// Nothing here asserts against what we meant to render — every check reads
// the HTML back out of the DOM stub, the way test_invoice_supplier_search.js
// does. The menu is built with createElement and hung off <body>, so the stub
// carries enough of a document for the real code to do exactly that.
//
// THE ONE THING THAT MUST NOT REGRESS. A supplier is stored as ONE free-text
// name that usually glues both languages together ("Dry Fruit 果干"), and
// every supplier screen joins on that exact string. The menu shows the halves
// apart so a name is readable in one language; the field must still receive
// the WHOLE name, or the material files itself under a supplier that owns
// nothing. Sections 4 and 8 are that check.
//
// USAGE   node scripts/test_material_supplier_picker.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ── DOM stub ──────────────────────────────────────────────────────────────
// getElementById hands back a node for ANY id: the module paints a shell and
// then looks the ids inside it back up. appendChild registers whatever it is
// given under its own id, which is how the combo menu — created at runtime —
// becomes findable.
const nodes = new Map();
function makeNode(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', style: {}, hidden: false, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    focus() {}, blur() {}, scrollIntoView() {}, addEventListener() {}, setAttribute() {},
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
// Three suppliers in the two live shapes — one glued bilingual name, one
// English-only, one with a separate name_cn — plus an archived one, which the
// list endpoint never returns.
const SUPPLIERS = [
  { id: 1, name: 'Dry Fruit 果干', name_cn: null, is_active: 1 },
  { id: 2, name: 'Nut House 坚果屋', name_cn: null, is_active: 1 },
  { id: 3, name: 'Baker Supply Co', name_cn: '烘焙用品', is_active: 1 },
];
const MATERIAL = {
  id: 55, name_en: 'Kosher Flake Sea Salt', name_cn: '海盐 453克', sku: 'E-55',
  category: 'Spices, Herbs & Salt 香草和盐', unit: 'g', buy_unit: 'bag', buy_pack_size: 1,
  pack_contents_qty: 453, pack_contents_unit: 'g', buy_price: 30, cost_per_unit: 0.066,
  free_by_design: 0, supplier: '', allergens: '', notes: '',
  accounting_category: 'Ingredients(Kitchen+Retail Use) 原材料（厨房及零售通用）',
  item_kind: 'food', is_active: 1,
};

const sent = [];       // every write the module makes, in order
let supPostFails = null;  // set to an error code to make the next POST fail
async function api(p, opts) {
  const q = p.split('?')[0];
  const method = (opts && opts.method) || 'GET';
  if (q === '/api/retail-admin/suppliers' && method === 'POST') {
    sent.push({ path: q, body: opts.body });
    if (supPostFails) {
      const code = supPostFails; supPostFails = null;
      const err = new Error(code); err.code = code; err.data = { error: code }; err.status = 409;
      throw err;
    }
    return { success: true, id: 99 };
  }
  if (q === '/api/retail-admin/suppliers') return { success: true, data: SUPPLIERS };
  if (q === '/api/retail-admin/materials/meta/kinds') return { success: true, data: ['food', 'packaging'] };
  if (q === '/api/retail-admin/materials/meta/categories') return { success: true, data: [MATERIAL.category] };
  if (q === '/api/retail-admin/materials/meta/accounting-categories') return { success: true, data: [MATERIAL.accounting_category] };
  if (q === '/api/retail-admin/materials') {
    if (method === 'POST') { sent.push({ path: q, body: opts.body }); return { success: true, id: 55 }; }
    return { success: true, data: [MATERIAL], counts: {} };
  }
  if (q === '/api/retail-admin/materials/55') {
    if (method === 'PUT') { sent.push({ path: q, body: opts.body }); return { success: true }; }
    return { success: true, data: MATERIAL, priceHistory: [], purchases: [], derived: {} };
  }
  return { success: true, data: [] };
}

const toasts = [];
let promptAnswer = null;   // what the New-supplier dialog "types" back
const prompts = [];
const sandbox = {
  document, console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Set, Map, Array, Object,
  isFinite, String, Number, URLSearchParams, RegExp,
  api, toast: (msg, kind) => toasts.push({ msg, kind }),
  addEventListener: () => {}, removeEventListener: () => {},
  innerHeight: 900, innerWidth: 1200,
  history: { pushState() {}, back() {} },
  escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  cuT: en => en,                       // the suite reads the English side
  fmt: n => String(n),
  acMoney: n => '¥' + n,
  applyCapGates: () => {},
  goTab: () => {},
  askConfirm: async () => true,
  askPrompt: async (opts) => { prompts.push(opts); return promptAnswer; },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', '18-materials.js'), 'utf8'),
                sandbox, { filename: '18-materials.js' });

// ── assert harness ────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };

const record = () => node('mat-rec-body').innerHTML;
const field = () => node('mat-f-supplier');
const menuEl = () => (nodes.has('mat-combo-menu') ? nodes.get('mat-combo-menu') : null);
const menu = () => { const m = menuEl(); return m && !m.hidden ? m.innerHTML : ''; };
// Typing, as the field itself does it: set the value, then fire what the
// markup's oninput fires — in that order, so the menu filters on the new text.
const type = (v) => { field().value = v; sandbox.matComboOpen('supplier'); };
const key = (k) => sandbox.matComboKey({ key: k, preventDefault() {} }, 'supplier');

async function main() {
  await sandbox.matInit();
  await sandbox.matRecordOpen(55);

  console.log('\n1. the field is a search box, not a dropdown');
  ok(record().includes('id="mat-f-supplier"'), 'the record paints a supplier field');
  ok(!/<select[^>]*id="mat-f-supplier"/.test(record()), 'it is no longer a <select>');
  ok(!record().includes('Dry Fruit 果干</option>'), 'the whole book is not dumped into the markup as <option>s');
  ok(record().includes('role="combobox"'), 'it is a combobox');
  ok(record().includes("matComboOpen('supplier')"), 'typing in it opens the menu');
  ok(record().includes("matComboToggle(event,'supplier')"), 'and a caret opens it without typing');

  console.log('\n2. opening it offers the whole book, scrollable, None first');
  sandbox.matComboOpen('supplier');
  ok(menu().includes('Dry Fruit') && menu().includes('Nut House') && menu().includes('Baker Supply Co'),
     'every active supplier is offered at once — the list scrolls rather than truncating');
  ok(menu().indexOf('None') >= 0 && menu().indexOf('None') < menu().indexOf('Dry Fruit'),
     'None leads the list, so clearing a supplier stays one click');

  console.log('\n3. typing narrows it — over both halves of a glued name');
  type('nut');
  ok(menu().includes('Nut House') && !menu().includes('Dry Fruit'), 'typing narrows the list to what matches');
  type('NUT');
  ok(menu().includes('Nut House'), 'the match is case-insensitive');
  type('果干');
  ok(menu().includes('Dry Fruit') || menu().includes('果干'), 'the Chinese half of a glued name matches');
  type('烘焙');
  ok(menu().includes('Baker Supply Co'), 'and a separate name_cn matches too');

  console.log('\n4. picking a row fills the field with the STORED name');
  type('dry');
  key('ArrowDown');    // None
  key('ArrowDown');    // Dry Fruit 果干
  key('Enter');
  ok(field().value === 'Dry Fruit 果干',
     'the field takes the whole stored name, not the half the row showed');
  ok(menu() === '', 'and the menu closes behind the pick');
  ok(node('mat-supnote').innerHTML === '', 'a name that is in the book carries no warning');

  console.log('\n5. Escape closes it; None clears the field');
  sandbox.matComboOpen('supplier');
  key('Escape');
  ok(menu() === '', 'Escape closes the menu');
  sandbox.matComboOpen('supplier');
  key('ArrowDown');    // None, the first row
  key('Enter');
  ok(field().value === '', 'None empties the field');

  console.log('\n6. a name that is nobody says so, rather than looking filed');
  type('Totally Made Up Co');
  sandbox.matSupNote();
  ok(/not in your supplier book/i.test(node('mat-supnote').innerHTML),
     'the field warns that purchasing will not group orders under it');
  ok(/add “Totally Made Up Co” as a new supplier/i.test(menu()),
     'and the menu offers to add it, right where you are looking');

  console.log('\n7. the New supplier button');
  ok(record().includes('matSupNew()'), 'the card carries a New supplier button');
  ok(/<button[^>]*data-cap="purchasing:edit"[^>]*onclick="matSupNew\(\)"/.test(record()),
     'gated on the same capability that owns suppliers in Purchasing');

  console.log('\n8. adding one writes to the shared book and fills the field');
  sent.length = 0; toasts.length = 0;
  promptAnswer = 'Sea Salt Works 海盐工坊';
  await sandbox.matSupNew();
  ok(sent.length === 1 && sent[0].path === '/api/retail-admin/suppliers',
     'it POSTs to the supplier master — the same one Purchasing keeps');
  ok(sent[0].body.name === 'Sea Salt Works 海盐工坊', 'with the name as typed, both halves');
  ok(field().value === 'Sea Salt Works 海盐工坊', 'the new supplier lands in the field');
  ok(node('mat-supnote').innerHTML === '', 'and the "not in your book" warning is gone');
  sandbox.matComboOpen('supplier');
  ok(menu().includes('Sea Salt Works'), 'the menu offers it from now on without a reload');

  console.log('\n9. the dialog opens prefilled with what was typed');
  type('Half Typed Co');
  prompts.length = 0; promptAnswer = null;
  await sandbox.matSupNew();
  ok(prompts.length === 1 && prompts[0].value === 'Half Typed Co',
     'so a name half-typed into the field is not typed twice');
  ok(field().value === 'Half Typed Co', 'cancelling the dialog changes nothing');

  console.log('\n10. a name the book already holds is used, not duplicated');
  sent.length = 0; toasts.length = 0;
  promptAnswer = 'Nut House 坚果屋';
  await sandbox.matSupNew();
  ok(sent.length === 0, 'no second row is created for a supplier that exists');
  ok(field().value === 'Nut House 坚果屋', 'it is simply set on the material');

  console.log('\n11. an ARCHIVED supplier of the same name (the server\'s 409) is not an error');
  sent.length = 0; toasts.length = 0;
  supPostFails = 'name_taken';
  promptAnswer = 'Retired Ltd';
  await sandbox.matSupNew();
  ok(sent.length === 1, 'the POST was attempted');
  ok(field().value === 'Retired Ltd', 'and the name still lands on the material');
  ok(!toasts.some(t => t.kind === 'err'), 'without an error the operator can do nothing about');

  console.log('\n12. Save carries the supplier through');
  sent.length = 0;
  // The stub parses no markup, so the other inputs read back empty — give the
  // save the one field it refuses to go without.
  node('mat-f-name_en').value = MATERIAL.name_en;
  field().value = 'Dry Fruit 果干';
  await sandbox.matSave();
  const put = sent.find(s => s.path === '/api/retail-admin/materials/55');
  ok(!!put && put.body.supplier === 'Dry Fruit 果干', 'the stored name goes on the wire');

  console.log('\n13. leaving the record takes the menu with it');
  sandbox.matComboOpen('supplier');
  ok(menu() !== '', 'the menu is open');
  await sandbox.matRecordBack();
  ok(menu() === '', 'and does not outlive the record it belonged to (it hangs off <body>)');

  console.log('\n14. the Finance category field kept its own menu through the rewrite');
  await sandbox.matRecordOpen(55);
  ok(record().includes("matComboOpen('accounting_category')"), 'it reads from the same combo');
  node('mat-f-accounting_category').value = 'ingredients';
  sandbox.matComboOpen('accounting_category');
  ok(menu().includes('Ingredients(Kitchen+Retail Use)'), 'and still filters as you type');
  ok(!menu().includes('None'), 'without a None row it never had');

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
