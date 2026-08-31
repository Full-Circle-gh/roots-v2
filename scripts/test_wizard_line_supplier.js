#!/usr/bin/env node
// The per-line supplier chip in the order wizard's "what to buy" step
// (public/retail-admin/16-purchasing.js, renderLines + puLineSup).
//
// THE DEFECT THIS COVERS. The chip under each line opened the product's retail
// PO price list and nothing else, so it had nothing to open in the two cases
// the operator hit most:
//
//   * a product nobody had bought before — the price list comes back empty and
//     puPick fell through to addOrSetLine() with the ORDER HEADER's supplier,
//     which on a mixed or one-off order is blank. The chip read "Choose
//     supplier", was clicked, and visibly did nothing; and
//   * a material line — materials carry no retail PO history at all, so the
//     supplier rendered as plain text with no control on it whatsoever.
//
// A second defect sat behind the first: the picker painted into #pu2-suppop,
// the slot near the TOP of the wizard card. On an order of any length that is
// most of a screen above the line whose chip was clicked, so even once the
// picker had something to show it opened out of sight and the chip still read
// as dead. It now paints into the clicked line's own row.
//
// SECTIONS 9-11 cover the ORDER's own supplier on step 1, and sections 1-2 the
// line box, over the change that made both search boxes. Each was a native
// control carrying the whole book — a <select> on step 1, an <input list=…> +
// <datalist> on the line — with no way to type at either, and both popups drawn
// by the OS combobox widget, which some embedding webviews position against the
// wrong edge of the window. They are the menu the Invoices fields already use:
// drawn by us, scrollable, filtered over the stored name and both language
// halves. Where they differ from Invoices is what lands in the box — the whole
// stored name, because these two are read straight back off the DOM into the
// order, and half a name names nobody the supplier screens can group with.
//
// Nothing here asserts against what we meant to render — every check reads the
// HTML back out of the DOM stub, the way test_kitchen_po_picker.js does.
//
// USAGE   node scripts/test_wizard_line_supplier.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ── DOM stub ──────────────────────────────────────────────────────────────
// getElementById hands back a node for ANY id: the module paints a shell and
// then looks the ids inside it back up. The one behaviour that matters beyond
// recording innerHTML is the supplier box — the module reads its .value back,
// so a test can type into it.
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
// The body carries 'feat-production' (the tenant switch that puts materials in
// the picker) AND takes appendChild: both supplier boxes hang their search menu
// straight off <body>, so a stub that cannot receive it cannot see the list.
const body = makeNode('body');
body.classList = { add() {}, remove() {}, toggle() {}, contains: c => c === 'feat-production' };
// Closing the picker takes its input out of the DOM with it, so the next
// lookup finds NOTHING and the paint that follows makes it again. The stub
// keeps every node it ever made, so `gone` models that one absent lookup —
// which is the whole difference between "the box is empty" and "there is no
// box", and renderLines' half-typed-name capture reads it.
const gone = new Set();
const document = {
  getElementById: (id) => { if (gone.delete(id)) return null; return node(id); },
  createElement: () => makeNode(''),
  querySelectorAll: () => [],
  addEventListener() {},
  body,
};

// ── the server, faked ─────────────────────────────────────────────────────
const SUPPLIERS = [
  { id: 1, name: 'Nut House 坚果屋', name_cn: '坚果屋', is_active: 1 },
  { id: 2, name: 'Precious Soe', is_active: 1 },
  { id: 3, name: 'Retired Ltd', is_active: 0 },
];
const STOCK = [
  { product_id: 340, name_en: 'Almonds (Raw)', name_cn: '杏仁（生）', sku: '2-340', physical_qty: 82, safety_buffer: 0 },
  { product_id: 341, name_en: 'Walnuts', name_cn: '核桃', sku: '2-341', physical_qty: 4, safety_buffer: 10 },
];
const MATERIALS = [
  { id: 20, name_en: 'Black Bean Tempeh', name_cn: '黑豆天贝', sku: 'G-20', is_active: 1,
    supplier: 'Precious Soe', buy_unit: 'pack', buy_price: 18 },
];
// 340 has never been bought — the empty price list that started all this.
// 341 has two suppliers on file.
const PRICE_LISTS = {
  340: { suppliers: [] },
  341: { suppliers: [
    { supplier: 'Nut House 坚果屋', last_cost: 31, avg_cost: 33, order_count: 4, last_date: '2026-08-01' },
    { supplier: 'Bean Bros', last_cost: 29, avg_cost: 30, order_count: 1, last_date: '2026-05-02' },
  ] },
};
const saved = [];
let saving = false;
async function api(p, opts) {
  const q = p.split('?')[0];
  if (saving && opts && opts.method) { saved.push({ path: q, body: opts.body }); return { success: true, id: 9, data: [] }; }
  if (q === '/api/retail-admin/stores') return { success: true, data: [{ id: 1, code: 'TH', name_en: 'Tianhe', is_active: 1 }] };
  if (q.startsWith('/api/retail-admin/suppliers')) return { success: true, data: SUPPLIERS };
  if (q === '/api/retail-admin/stores/1/stock') return { success: true, data: STOCK };
  if (q === '/api/retail-admin/materials') return { success: true, data: MATERIALS };
  const m = q.match(/^\/api\/retail-admin\/products\/(\d+)\/suppliers$/);
  if (m) return { success: true, data: PRICE_LISTS[m[1]] || { suppliers: [] } };
  return { success: true, data: [] };
}

const toasts = [];
const sandbox = {
  document, console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Set, Map, Array, Object, isFinite,
  innerHeight: 900, innerWidth: 1200,
  api, toast: (msg, kind) => toasts.push({ msg, kind }),
  // The module registers document- and window-level listeners at load.
  addEventListener: () => {}, removeEventListener: () => {},
  escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  cuT: en => en,
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
const lines   = () => node('pu2-linebody').innerHTML;
const topSlot = () => node('pu2-suppop').innerHTML;
// The picker, as it actually reaches the operator: a row of the lines table.
const picker  = () => { const m = lines().match(/<tr class="pu2-supedit">[\s\S]*?<\/tr>/); return m ? m[0] : ''; };
const type    = v => { node('pu2-supname').value = v; };
// The search menu both supplier boxes draw for themselves, hung off <body>.
const menuEl  = () => (nodes.has('pu2-suggest-menu') ? nodes.get('pu2-suggest-menu') : null);
const menu    = () => { const m = menuEl(); return m && !m.hidden ? m.innerHTML : ''; };
// Stand where the browser stands after the picker closed: its box is gone, so
// the next lookup finds nothing (see `gone` above).
const forgetBox = id => { node(id).value = ''; gone.add(id); };

async function main() {
  await sandbox.puInit();
  sandbox.puNewOrder();
  sandbox.puWizNext(2);

  console.log('\n1. a product with no purchase history — the reported defect');
  await sandbox.puPick(340);
  ok(lines().includes('Almonds (Raw)'), 'the line is on the order');
  ok(/pu2-supchip[^"]*" onclick="puLineSup\(0\)/.test(lines()), 'its supplier chip is wired to the picker');
  ok(picker() === '', 'nothing is open before the chip is clicked');
  await sandbox.puLineSup(0);
  ok(picker().includes('pu2-supname'), 'the chip opens a picker even with no history to show');
  ok(topSlot() === '', 'and it opens in the line, not in the slot at the top of the card');
  // The book used to be dumped into the row as a <datalist>, whose popup the
  // OS draws — the same popup the Invoices fields moved away from. It is the
  // search menu now: nothing in the row until the box is opened, and then the
  // whole book, filtered by what is typed.
  ok(!picker().includes('<datalist'), 'the row no longer carries a native datalist');
  ok(picker().includes('role="combobox"'), 'the box is a combobox');
  sandbox.puSuggestOpen('pu2-supname', 'linesuppliers');
  ok(menu().includes('Nut House') && menu().includes('Precious Soe'), 'the supplier book is offered');
  ok(!menu().includes('Retired Ltd'), 'a disabled supplier is not offered');
  type('preci');
  sandbox.puSuggestOpen('pu2-supname', 'linesuppliers');
  ok(menu().includes('Precious Soe') && !menu().includes('Nut House'), 'typing narrows it');
  type('坚果');
  sandbox.puSuggestOpen('pu2-supname', 'linesuppliers');
  ok(menu().includes('Nut House'), 'and the Chinese half of a glued name finds it');
  // A pick has to leave the WHOLE stored name in the box: puLineSupSave writes
  // whatever the box holds straight onto the line, and half a name names
  // nobody the supplier screens can group with.
  const opt = menu().match(/data-v="([^"]*)"[^>]*data-label="([^"]*)"/);
  ok(!!opt && opt[1] === 'Nut House 坚果屋' && opt[2] === 'Nut House 坚果屋',
     'the row carries the whole stored name as both value and label');
  sandbox.puSuggestPick(opt[1], opt[2]);
  ok(node('pu2-supname').value === 'Nut House 坚果屋', 'and picking puts it in the box whole');
  type('  Nut House 坚果屋  ');
  sandbox.puLineSupSave();
  ok(lines().includes('>Nut House 坚果屋 <'), 'a typed name lands on the line, trimmed');
  ok(picker() === '', 'and the picker closes behind it');
  ok(/value="0"/.test(lines()), 'a typed name sets no price — we have no figure for a supplier we never bought from');

  console.log('\n2. the chip is a toggle, and the name can be taken off again');
  forgetBox('pu2-supname');
  await sandbox.puLineSup(0);
  ok(picker().includes('value="Nut House 坚果屋"'), 'reopening prefills the name the line carries');
  await sandbox.puLineSup(0);
  ok(picker() === '', 'a second click on the same chip puts it away');
  await sandbox.puLineSup(0);
  type('');
  sandbox.puLineSupSave();
  ok(lines().includes('Choose supplier'), 'saving it empty clears the line back to the order’s own supplier');

  console.log('\n3. a half-typed name survives the repaint a qty edit triggers');
  await sandbox.puLineSup(0);
  type('Half Typed Co');
  sandbox.puQty(0, 1);
  ok(picker().includes('pu2-supname'), 'the picker is still open after the tbody repaint');
  ok(picker().includes('value="Half Typed Co"'), 'and still holds what was typed into it');
  sandbox.puLineSupSave();
  ok(lines().includes('Half Typed Co'), 'which then saves from where it left off');

  console.log('\n4. a material line — it had no control on it at all');
  await sandbox.puPickMaterial(20);
  ok(lines().includes('Black Bean Tempeh'), 'the material is on the order');
  ok(/pu2-supchip[^"]*" onclick="puLineSup\(1\)/.test(lines()), 'its supplier is a chip now, not dead text');
  ok(lines().includes('Precious Soe'), 'defaulted from the material master, as before');
  await sandbox.puLineSup(1);
  ok(picker().includes('pu2-supname'), 'the picker opens for a material too');
  ok(!picker().includes('puPriceHistory'), 'without a price-history link it has no data for');
  type('Bean Bros');
  sandbox.puLineSupSave();
  ok(lines().includes('Bean Bros'), 'and the material’s supplier can be changed');

  console.log('\n5. a product WITH history — the price list is still the point');
  await sandbox.puPick(341);
  sandbox.puChooseSupplier(0);
  ok(lines().includes('Walnuts'), 'the line came in through the add-time popover');
  ok(lines().includes('value="31"'), 'carrying the preferred supplier’s last price');
  await sandbox.puLineSup(2);
  ok(picker().includes('Preferred') && picker().includes('Bean Bros'), 'the history rows render in the line picker');
  ok(picker().includes('In use'), 'the supplier the line already carries is marked, not offered again');
  ok(picker().includes('cheapest'), 'the cheapest of them is flagged');
  ok(picker().includes('puPriceHistory(341)'), 'and price history is one click away');
  sandbox.puLineSupUse(1);
  ok(lines().includes('>Bean Bros <'), 'taking another supplier retargets the line');
  ok(lines().includes('value="29"'), 'and brings their last price with it');

  console.log('\n6. the picker is addressed by line index, so a removal must close it');
  await sandbox.puLineSup(2);
  ok(picker().includes('pu2-supname'), 'open on the walnut line');
  sandbox.puRemoveLine(0);
  ok(picker() === '', 'removing an earlier line puts it away rather than pointing it at another product');
  ok(!lines().includes('Almonds'), 'and the line that went is the one that was asked for');

  console.log('\n7. leaving the step closes it too');
  await sandbox.puLineSup(0);
  sandbox.puWizStep(3);
  sandbox.puWizStep(2);
  ok(picker() === '', 'no picker is left hanging open across a step change');

  console.log('\n8. what the order actually sends');
  saving = true;
  await sandbox.puSaveDraft();
  const items = saved.length ? saved[0].body.items : [];
  ok(items.length === 2 && items[0].supplier_name === 'Bean Bros' && items[1].supplier_name === 'Bean Bros',
     'each line carries its own supplier_name onto the wire');

  // ── the ORDER's own supplier, on step 1 ─────────────────────────────────
  // Same defect as the line box and the two Invoices fields: it was a <select>
  // carrying the whole book, unsearchable, drawn by the OS. Its rule differs
  // in one way — empty is a real answer here ("mixed / one-off"), and a name
  // that is nobody is not, because the <select> it replaced could never say
  // one and every supplier screen groups on the stored string.
  console.log('\n9. the order’s own supplier is a search box too');
  // A fresh order with a line on it — section 8 placed the last one, and an
  // order with nothing on it would be refused by the save for that instead.
  sandbox.puNewOrder();
  sandbox.puWizNext(2);
  await sandbox.puPick(340);
  sandbox.puWizStep(1);
  const step1 = () => node('pu2-wizbody').innerHTML;
  ok(!/<select[^>]*id="pu2-w-supplier"/.test(step1()), 'it is no longer a <select>');
  ok(!step1().includes('<option value="Nut House 坚果屋"'), 'the book is not dumped into the markup');
  ok(/id="pu2-w-supplier"[\s\S]*?role="combobox"/.test(step1()), 'it is a combobox');
  node('pu2-w-supplier').value = '';
  sandbox.puSuggestOpen('pu2-w-supplier', 'posuppliers');
  ok(menu().includes('Nut House') && menu().includes('Precious Soe'), 'the book is offered');
  ok(!menu().includes('Retired Ltd'), 'a disabled supplier is not');
  node('pu2-w-supplier').value = '坚果';
  sandbox.puSuggestOpen('pu2-w-supplier', 'posuppliers');
  ok(menu().includes('Nut House') && !menu().includes('Precious Soe'), 'and 中文 narrows it');
  const poOpt = menu().match(/data-v="([^"]*)"[^>]*data-label="([^"]*)"/);
  sandbox.puSuggestPick(poOpt[1], poOpt[2]);
  ok(node('pu2-w-supplier').value === 'Nut House 坚果屋', 'a pick fills the box with the whole stored name');
  sandbox.puWizNext(2);
  ok(node('pu2-wizbody').innerHTML.includes('<b>Nut House 坚果屋</b>'), 'and step 2 recaps the order under it');

  console.log('\n10. a name that is nobody stops there rather than being written as one');
  sandbox.puWizStep(1);
  node('pu2-w-supplier').value = 'Totally Made Up Co';
  toasts.length = 0;
  sandbox.puWizNext(2);
  ok(toasts.length === 1 && toasts[0].kind === 'err' && /pick one from the list/i.test(toasts[0].msg),
     'the operator is told to pick from the list');
  ok(step1().includes('id="pu2-w-supplier"'), 'and the wizard stays on step 1');
  saved.length = 0;
  await sandbox.puSaveDraft();
  ok(saved.length === 0, 'saving from there is refused too — no order goes out under a supplier nobody has');

  console.log('\n11. empty still means mixed / one-off');
  node('pu2-w-supplier').value = '';
  toasts.length = 0;
  sandbox.puWizNext(2);
  ok(!toasts.length, 'an empty box is not an error');
  ok(node('pu2-wizbody').innerHTML.includes('<b>none</b>'), 'the recap says the order has no supplier');

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
