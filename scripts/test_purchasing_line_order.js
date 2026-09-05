#!/usr/bin/env node
//
// test_purchasing_line_order.js — putting the lines of a retail PO in an
// order, on Purchasing → build step 2 (public/retail-admin/16-purchasing.js).
//
// WHAT THIS IS ABOUT. A draft order's lines came out in the order they were
// picked and stayed there. On a 30-line order that means the same supplier's
// items are scattered down the sheet, and the sheet is what gets printed and
// sent — so the buyer either re-typed the order or sent it as it fell out.
// Step 2 now carries both halves of an answer, because they are different
// questions: a chip row that puts the WHOLE list in supplier / name / stock /
// value order, and a grip in the left gutter that moves ONE line.
//
// THE THING THAT MUST NOT REGRESS, and why this file is behavioural rather
// than a string check: reordering is only real if it SURVIVES THE SAVE. The
// array position is what becomes po_line_items.sort_order (insertLineItems in
// routes/retail-purchasing.js writes the index), and every read of a PO comes
// back ORDER BY sort_order, id. So the proof is not that the tbody repainted —
// it is that the payload the module PUTs carries the lines in the new order.
// Section 6 is that check; everything before it is what the buyer sees.
//
// Nothing here asserts against what we meant to render. Every check reads the
// HTML back out of the DOM stub, the way test_kitchen_po_picker.js does.
//
// USAGE   node scripts/test_purchasing_line_order.js
// EXIT    0 every assertion held · 1 an assertion failed · 2 could not run

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
// then looks the ids inside it back up. classList is real enough to be read,
// because the drop indicator IS a class and a stub that swallowed it would
// let the indicator rot untested.
const nodes = new Map();
function makeNode(id) {
  const cls = new Set();
  return {
    id, innerHTML: '', value: '', style: {}, tagName: 'DIV',
    classList: {
      add: c => cls.add(c), remove: (...c) => c.forEach(x => cls.delete(x)),
      contains: c => cls.has(c),
      toggle: (c, on) => { if (on === undefined) { cls.has(c) ? cls.delete(c) : cls.add(c); } else if (on) cls.add(c); else cls.delete(c); },
      list: cls,
    },
    focus() {}, blur() {}, addEventListener() {}, setAttribute() {},
    insertAdjacentHTML(_pos, html) { this.innerHTML += html; },
    appendChild(child) { if (child && child.id) nodes.set(child.id, child); return child; },
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
  };
}
function node(id) {
  if (!nodes.has(id)) nodes.set(id, makeNode(id));
  return nodes.get(id);
}
const document = {
  getElementById: node,
  createElement: () => makeNode(''),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  // The materials feature is ON, so the picker can add a MATERIAL line — the
  // one add path that reaches the lines without a product price lookup.
  body: { classList: { contains: c => c === 'feat-production' } },
};

// ── the server, faked ─────────────────────────────────────────────────────
// Four lines, deliberately NOT in any of the orders under test, and carrying
// the three shapes that break a naive comparator: a blank supplier, a material
// line with no shelf stock (current_stock null), and two lines that tie on
// nothing so every key gives a different answer.
const DRAFT = {
  id: 77, po_number: 'RPO-0077', date: '2026-09-01', delivery_date: '2026-09-08',
  status: 'Requested', supplier: '', store_id: 1, notes: '',
  items: [
    { id: 201, store_product_id: 11, ingredient_id: null, name_en: 'Zaatar',   name_cn: '百里香',
      sku: 'B-46', qty: 2, unit: 'pack', cost_per_unit: 35, supplier_name: 'Southeast Asia',
      current_stock: 4,  expense_category: '', purchase_channel: '', note: '' },
    { id: 202, store_product_id: 12, ingredient_id: null, name_en: 'Blender Shaft', name_cn: '搅拌杆',
      sku: 'J-69', qty: 1, unit: 'pcs',  cost_per_unit: 300, supplier_name: '',
      current_stock: 1,  expense_category: '', purchase_channel: '', note: '' },
    { id: 203, store_product_id: 13, ingredient_id: null, name_en: 'Active B12', name_cn: 'B12',
      sku: 'A-540', qty: 3, unit: 'bottle', cost_per_unit: 33.31, supplier_name: 'iHerb',
      current_stock: 9,  expense_category: '', purchase_channel: '', note: '' },
    { id: 204, store_product_id: null, ingredient_id: 5, name_en: 'Circle Bowl', name_cn: '牛皮纸碗',
      sku: 'H-50', qty: 100, unit: 'pcs', cost_per_unit: 0.45, supplier_name: 'Xin Dongsheng',
      current_stock: null, expense_category: '', purchase_channel: '', note: '' },
  ],
};

const sent = [];   // every write the module makes, in order
async function api(p, opts) {
  const q = p.split('?')[0];
  const method = (opts && opts.method) || 'GET';
  if (q === '/api/retail-admin/purchases/77') {
    if (method === 'PUT') { sent.push({ path: q, body: opts.body }); return { success: true }; }
    return { success: true, data: DRAFT };
  }
  if (q === '/api/retail-admin/stores') {
    return { success: true, data: [{ id: 1, name_en: 'Tianhe', name_cn: '天河店', is_active: 1 }] };
  }
  if (q === '/api/retail-admin/stores/1/stock') return { success: true, data: [] };
  if (q === '/api/retail-admin/materials') {
    return { success: true, data: [{ id: 9, name_en: 'Oat Milk', name_cn: '燕麦奶', sku: 'M-9',
                                     buy_unit: 'box', buy_price: 12, supplier: 'Oat Works',
                                     accounting_category: '', is_active: 1 }] };
  }
  return { success: true, data: [] };
}

const sandbox = {
  document, console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Set, Map, Array, Object,
  String, Number, parseFloat, parseInt, isNaN,
  api, toast: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  cuT: en => en,
  tdWhen, tdToday,
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
const ok = (cond, msg, got) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (got === undefined ? '' : ' — got ' + JSON.stringify(got))); }
};
const tick = () => new Promise(r => setTimeout(r, 0));

const linesHtml = () => node('pu2-linebody').innerHTML;
const barHtml   = () => node('pu2-sortbar').innerHTML;
// The order ON SCREEN, read back off the painted rows rather than off _edit —
// a sort that reordered the array but not the repaint would still be a bug.
const shown = () => {
  const names = ['Zaatar', 'Blender Shaft', 'Active B12', 'Circle Bowl'];
  const h = linesHtml();
  return names.map(n => [n, h.indexOf(n)]).filter(([, i]) => i >= 0)
              .sort((a, b) => a[1] - b[1]).map(([n]) => n);
};
// A drag, in the three events the row actually receives.
const dragEvt = () => ({
  preventDefault() {}, dataTransfer: { effectAllowed: '', dropEffect: '', setData() {} },
  target: { closest: () => makeNode('') }, currentTarget: makeNode(''),
});
function drag(from, to) {
  sandbox.puLineDragStart(dragEvt(), from);
  sandbox.puLineDragOver(dragEvt(), to);
  sandbox.puLineDrop(dragEvt(), to);
}

async function main() {
  await sandbox.puInit();
  await tick();
  await sandbox.puOpenPO(77);
  await tick();

  console.log('\n══ 1 · the draft opens in the wizard with its lines as stored ══');
  ok(shown().join(',') === 'Zaatar,Blender Shaft,Active B12,Circle Bowl',
     'all four lines paint, in the order the server sent them', shown());

  console.log('\n══ 2 · every line carries a grip, in its own gutter cell ══');
  ok((linesHtml().match(/class="pu2-grip"/g) || []).length === 4, 'one grip per line, and only per line');
  ok((linesHtml().match(/class="pu2-c-grip"/g) || []).length === 4, 'each sits in the gutter cell');
  ok(/<span class="pu2-grip" draggable="true"/.test(linesHtml()),
     'the GRIP is the draggable thing — a draggable row would eat the drag inside its qty and note boxes');
  ok(/ondragstart="puLineDragStart\(event,0\)"/.test(linesHtml()), 'and it starts the drag on its own index');
  // The gutter is a real column now, so anything that spanned the table has to
  // span one more or the totals slide left under the wrong heading.
  ok(/<tr class="pu2-totrow">\s*<td colspan="5">/.test(linesHtml()),
     'the totals row spans the widened table');

  console.log('\n══ 3 · the sort chips are offered, none of them lit ══');
  ['Supplier', 'Name', 'On shelf', 'Line total'].forEach(k =>
    ok(barHtml().includes(`>${k}`), `a chip for ${k}`));
  ok(!barHtml().includes('pu2-sortchip on'), 'nothing is lit — the list is as it was stored, not sorted');

  console.log('\n══ 4 · a chip sorts the whole list, and says so ══');
  sandbox.puSortLines('supplier');
  ok(shown().join(',') === 'Active B12,Zaatar,Circle Bowl,Blender Shaft',
     'supplier A→Z: iHerb, Southeast Asia, Xin Dongsheng', shown());
  ok(shown()[3] === 'Blender Shaft',
     'and the line with NO supplier sinks — a blank is the absence of a value, not the smallest one');
  ok(/pu2-sortchip on"[^>]*>Supplier/.test(barHtml()), 'the Supplier chip is lit');
  ok(/>Supplier<span class="dir">↑<\/span>/.test(barHtml()), 'showing which way it sorted');

  console.log('\n══ 5 · the same chip again turns it round ══');
  sandbox.puSortLines('supplier');
  ok(shown().join(',') === 'Circle Bowl,Zaatar,Active B12,Blender Shaft',
     'supplier Z→A', shown());
  ok(shown()[3] === 'Blender Shaft', 'the blank stays at the bottom in BOTH directions');
  ok(/>Supplier<span class="dir">↓<\/span>/.test(barHtml()), 'and the arrow turned round with it');

  console.log('\n══ 6 · a money key opens on the big end, an empty one still sinks ══');
  sandbox.puSortLines('total');
  ok(shown().join(',') === 'Blender Shaft,Active B12,Zaatar,Circle Bowl',
     'line total, biggest first — ¥300, ¥99.93, ¥70, ¥45', shown());
  ok(!/pu2-sortchip on"[^>]*>Supplier/.test(barHtml()), 'the Supplier chip went dark — one claim at a time');
  sandbox.puSortLines('stock');
  ok(shown().join(',') === 'Active B12,Zaatar,Blender Shaft,Circle Bowl',
     'on shelf, most first — 9, 4, 1', shown());
  ok(shown()[3] === 'Circle Bowl',
     'the material has no shelf stock at all, so it sinks rather than reading as zero');
  sandbox.puSortLines('name');
  ok(shown().join(',') === 'Active B12,Blender Shaft,Circle Bowl,Zaatar', 'name A→Z', shown());

  console.log('\n══ 7 · the grip moves one line, and unlights the chip ══');
  drag(3, 0);                                    // Zaatar, from the bottom to the top
  ok(shown().join(',') === 'Zaatar,Active B12,Blender Shaft,Circle Bowl',
     'the dragged line landed where it was dropped', shown());
  ok(!barHtml().includes('pu2-sortchip on'),
     'and no chip still claims the list is in its order — it is hand-arranged now');
  drag(0, 2);
  ok(shown().join(',') === 'Active B12,Blender Shaft,Zaatar,Circle Bowl',
     'dragging downward lands AFTER the row dropped on', shown());

  console.log('\n══ 8 · adding a line puts it at the end, so no chip may keep claiming ══');
  sandbox.puSortLines('name');
  ok(barHtml().includes('pu2-sortchip on'), 'a chip is lit again');
  await sandbox.puPickMaterial(9);
  await tick();
  ok(linesHtml().includes('Oat Milk'), 'the picked material joined the order');
  ok(shown().concat('Oat Milk').length === 5 && linesHtml().indexOf('Oat Milk') > linesHtml().indexOf('Zaatar'),
     'appended at the end, where the picker puts it');
  ok(!barHtml().includes('pu2-sortchip on'),
     'and the chip went dark — the list is no longer wholly in name order');

  console.log('\n══ 9 · THE ORDER SURVIVES THE SAVE ══');
  // The whole point. Array position is what insertLineItems writes into
  // po_line_items.sort_order, and every read comes back ORDER BY sort_order —
  // so a repaint that never reached the payload would be a sort that vanished
  // the moment the buyer left the screen.
  sandbox.puSortLines('supplier');
  const onScreen = shown();
  await sandbox.puSaveDraft();
  await tick();
  ok(sent.length === 1 && sent[0].path === '/api/retail-admin/purchases/77', 'one PUT went out for this draft');
  const saved = (sent[0].body.items || []).map(i => i.name_en);
  ok(JSON.stringify(saved.filter(n => onScreen.includes(n))) === JSON.stringify(onScreen),
     'the payload carries the lines in the order the screen is showing', { saved, onScreen });
  ok(sent[0].body.items.every(i => i.id !== undefined),
     'each line still travels with its own row id, so the save UPDATES rather than re-inserts');

  console.log('\n══ 10 · reopening starts hand-arranged, and one line has no order ══');
  // Saving leaves the wizard, so this reopens the draft — which also proves a
  // chip lit on the last draft does not survive into the next one, where it
  // would be describing an array that is gone.
  await sandbox.puOpenPO(77);
  await tick();
  ok(!barHtml().includes('pu2-sortchip on'), 'no chip is lit on a freshly opened draft');
  for (let i = DRAFT.items.length - 1; i > 0; i--) sandbox.puRemoveLine(i);
  ok(barHtml() === '', 'with a single line the sort bar is not drawn at all');
  ok((linesHtml().match(/class="pu2-grip"/g) || []).length === 1,
     'the grip stays — it is per line, and moving one line into itself is a no-op');

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
