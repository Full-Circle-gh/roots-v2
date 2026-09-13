#!/usr/bin/env node
// THE TYPED LINE IN THE ORDER WIZARD — ordering something that is in neither
// catalogue (public/retail-admin/16-purchasing.js: puPickerInput, puPickTyped,
// renderLines, the `expcats` menu).
//
// WHAT THIS COVERS. §111 part one. The picker searched store products and
// materials and ended at "No match", so a box of gloves, an office chair or a
// repair call-out had no way onto a purchase order at all — the cost went into
// Finance as a bare typed row instead, with no supplier on it, no receiving, no
// 发票 to match and nothing to return it against. The storage was never the
// problem: `po_line_items` has always accepted a line carrying neither id
// (scripts/test_retail_po_typed_line.js proves that end). THE DOOR WAS MISSING,
// and this suite is the door.
//
// The server half is that sibling suite's. This one is the half it cannot see:
// that the picker offers the row, that taking it builds a line with no ids and
// the name split into its two halves, that the line renders the three fields
// only a typed line may have — name, unit, expense category — that a CATALOGUE
// line renders none of them, and that the category menu's pick actually lands on
// the line rather than sitting in a box that the next repaint wipes.
//
// Nothing here asserts against what we meant to render — every check reads the
// HTML back out of the DOM stub, the way test_wizard_line_supplier.js does, and
// its stub is this one's.
//
// USAGE   node scripts/test_wizard_typed_line.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { tdWhen, tdToday } = require('../public/td-datetime.js');

// ── DOM stub ──────────────────────────────────────────────────────────────
const nodes = new Map();
function makeNode(id) {
  return {
    id, innerHTML: '', value: '', style: {}, hidden: false, children: [],
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
const body = makeNode('body');
body.classList = { add() {}, remove() {}, toggle() {}, contains: c => c === 'feat-production' };
const document = {
  getElementById: (id) => node(id),
  createElement: () => makeNode(''),
  querySelectorAll: () => [],
  addEventListener() {},
  body,
};

// ── the server, faked ─────────────────────────────────────────────────────
const STOCK = [
  { product_id: 340, name_en: 'Almonds (Raw)', name_cn: '杏仁（生）', sku: '2-340', physical_qty: 82, safety_buffer: 0 },
];
const MATERIALS = [
  { id: 20, name_en: 'Black Bean Tempeh', name_cn: '黑豆天贝', sku: 'G-20', is_active: 1,
    supplier: 'Precious Soe', buy_unit: 'pack', buy_price: 18 },
];
// The tenant's own kind='accounting' list, as the materials meta endpoint serves
// it: stored as ONE bilingual string per row, which is the shape the category
// box must keep — half of one is a category the ledger has never heard of.
const EXP_CATS = ['办公用品 Office supplies', '设备 Equipment', '门店进货 Retail stock'];
let catCalls = 0;
const saved = [];
let saving = false;
async function api(p, opts) {
  const q = p.split('?')[0];
  if (saving && opts && opts.method) { saved.push({ path: q, body: opts.body }); return { success: true, id: 9, data: [] }; }
  if (q === '/api/retail-admin/stores') return { success: true, data: [{ id: 1, code: 'TH', name_en: 'Tianhe', is_active: 1 }] };
  if (q.startsWith('/api/retail-admin/suppliers')) return { success: true, data: [] };
  if (q === '/api/retail-admin/stores/1/stock') return { success: true, data: STOCK };
  if (q === '/api/retail-admin/materials') return { success: true, data: MATERIALS };
  if (q === '/api/retail-admin/materials/meta/accounting-categories') {
    catCalls++; return { success: true, data: EXP_CATS };
  }
  return { success: true, data: [] };
}

const toasts = [];
const sandbox = {
  document, console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Set, Map, Array, Object, isFinite,
  innerHeight: 900, innerWidth: 1200,
  api, toast: (msg, kind) => toasts.push({ msg, kind }),
  addEventListener: () => {}, removeEventListener: () => {},
  escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  cuT: en => en,
  // The refusal the save reuses rather than writing a second sentence for it.
  tdErrorText: (code) => (code === 'name_required' ? 'Give it a name first.' : code),
  tdWhen, tdToday,
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
const lines  = () => node('pu2-linebody').innerHTML;
const list   = () => node('pu2-picker-list').innerHTML;
const menuEl = () => (nodes.has('pu2-suggest-menu') ? nodes.get('pu2-suggest-menu') : null);
const menu   = () => { const m = menuEl(); return m && !m.hidden ? m.innerHTML : ''; };
// puPickerInput debounces 150ms; type then wait it out, the way a person does.
const search = async (q) => {
  node('pu2-picker').value = q;
  sandbox.puPickerInput();
  await new Promise(r => setTimeout(r, 220));
};

async function main() {
  await sandbox.puInit();
  sandbox.puNewOrder();
  sandbox.puWizNext(2);

  console.log('\n1. the picker offers to order what was typed');
  await search('office chair');
  ok(list().includes('No match'), 'nothing in either catalogue matches');
  ok(list().includes('puPickTyped()'), 'and the list offers to order it anyway');
  ok(list().includes('office chair'), 'naming what was typed');
  // The fallback is the LAST row, never the first: a buyer searching for
  // something they already stock must meet the real one first.
  await search('almond');
  ok(list().includes('Almonds (Raw)'), 'a real match is still offered');
  ok(list().indexOf('puPick(340)') < list().indexOf('puPickTyped()'),
     'and the typed row sits BELOW it');

  console.log('\n2. taking it puts a line on the order');
  await search('Desk chair 办公椅');
  sandbox.puPickTyped();
  ok(lines().includes('Desk chair'), 'the line is on the order');
  ok(node('pu2-picker').value === '', 'and the search box is cleared');
  ok(node('pu2-picker-list').style.display === 'none', 'the picker list is put away');

  console.log('\n3. a bilingual name splits; a one-language name does not double');
  ok(/value="Desk chair 办公椅"/.test(lines()),
     'the box shows both halves as one string, the way the name was typed');
  // An empty box adds nothing: puPickTyped is reachable from a row that was
  // painted against a query the buyer has since cleared.
  const before = lines().split('<tr').length;
  sandbox.puPickTyped();
  ok(lines().split('<tr').length === before, 'an empty search box adds no line');
  await search('Gloves');
  sandbox.puPickTyped();
  ok(!/Gloves · Gloves/.test(lines()), 'an English-only name is NOT rendered twice');

  console.log('\n4. a typed line gets the three fields only it may have');
  ok(/puLineName\(0,this.value\)/.test(lines()), 'its name is editable');
  ok(/id="pu2-cat-0"/.test(lines()), 'it carries an expense-category box');
  ok(/puLine\(0,'unit',this.value\)/.test(lines()), 'and its unit is a control');

  console.log('\n5. a catalogue line gets none of them');
  await sandbox.puPick(340);
  const prodRow = lines().split('<tr').find(r => r.includes('Almonds'));
  ok(!!prodRow, 'the product line is on the order');
  ok(!/puLineName/.test(prodRow), 'a product’s name is NOT editable here');
  ok(!/pu2-cat-/.test(prodRow), 'it carries no category box — it has a default');
  ok(!/'unit'/.test(prodRow), 'and its unit is a label, not a control');
  // A material's unit is the one that MUST stay put: firePriceAlertsForPO
  // refuses to write a price back when the line unit stops matching buy_unit.
  await sandbox.puPickMaterial(20);
  const matRow = lines().split('<tr').find(r => r.includes('Tempeh'));
  ok(!!matRow && !/'unit'/.test(matRow), 'a material’s unit is a label too');

  console.log('\n6. the category box offers the tenant’s own list');
  ok(catCalls > 0, 'the list was loaded when the line editor painted');
  sandbox.puSuggestOpen('pu2-cat-0', 'expcats');
  ok(menu().includes('Office supplies'), 'the tenant’s categories are offered');
  ok(menu().includes('Equipment'), 'all of them');
  node('pu2-cat-0').value = 'office';
  sandbox.puSuggestOpen('pu2-cat-0', 'expcats');
  ok(menu().includes('Office supplies') && !menu().includes('Equipment'), 'typing narrows it');

  console.log('\n7. picking one LANDS ON THE LINE, not just in the box');
  // Setting an input's value from script leaves its dirty flag clear, so the
  // onchange that would normally store it never fires. Without `commit` the
  // pick would sit on screen and be lost on the next repaint.
  sandbox.puSuggestPick('办公用品 Office supplies');
  saving = true; saved.length = 0;
  await sandbox.puSaveDraft();
  const items = saved.length ? saved[0].body.items : [];
  const chair = items.find(x => String(x.name_en || '').includes('Desk chair'));
  ok(!!chair, 'the typed line is on the wire');
  ok(chair && chair.expense_category === '办公用品 Office supplies',
     'carrying the WHOLE stored category, not one language half of it');
  ok(chair && !chair.store_product_id && !chair.ingredient_id,
     'and naming neither catalogue');
  ok(chair && chair.name_en === 'Desk chair' && chair.name_cn === '办公椅',
     'with its two name halves kept apart');
  const gloves = items.find(x => String(x.name_en || '').includes('Gloves'));
  ok(gloves && gloves.name_en === 'Gloves' && !gloves.name_cn,
     'a one-language name goes whole into name_en and leaves name_cn empty');
  saving = false;

  console.log('\n8. renaming a typed line re-splits it');
  sandbox.puNewOrder();
  sandbox.puWizNext(2);
  await search('Chair');
  sandbox.puPickTyped();
  sandbox.puLineName(0, 'Desk chair 办公椅');
  ok(/value="Desk chair 办公椅"/.test(lines()), 'the corrected name shows both halves');

  console.log('\n9. rubbing the name out is refused BEFORE the request');
  sandbox.puLineName(0, '   ');
  toasts.length = 0; saving = true; saved.length = 0;
  await sandbox.puSaveDraft();
  ok(saved.length === 0, 'nothing was sent');
  ok(toasts.some(t => /name/i.test(t.msg)), 'and the buyer is told to name it');
  saving = false;

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
