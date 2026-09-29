#!/usr/bin/env node
//
// test_category_product_order.js — dragging a product up and down its shelf on
// Products → Categories (public/retail-admin/01-core.js, "Products on this
// shelf"), and the write it makes (POST /api/retail-admin/products/reorder,
// whose slot arithmetic lives in lib/reorder-slots.js).
//
// WHAT MUST HOLD.
//   · The list is grouped the way the mini app groups the shelf: the tree's
//     section headings in order, a heading the tree no longer names after
//     them, the products with no heading last.
//   · A variant group is one unit — its sizes stay together and move together.
//   · A drop reorders only its own group and sends that group's ids in the
//     new order; a drop on another group's list does nothing.
//   · The mini app view offers the grip; the QR menu view does not.
//   · The slots handed back are distinct. A new product lands on sort_order 0,
//     so [0, 0, 3] is common, and two equal slots left the drag not sticking.
//
// The shelf section is sliced out of the real file and run in a sandbox, so
// this tests the shipped code, not a copy of it.
//
// USAGE   node scripts/test_category_product_order.js
// EXIT    0 every assertion held · 1 an assertion failed · 2 could not run

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let src, reorderSlots;
try {
  const core = fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', '01-core.js'), 'utf8');
  const cut = (from, to) => {
    const a = core.indexOf(from), b = core.indexOf(to, a);
    if (a < 0 || b < a) throw new Error(`anchors "${from}" … "${to}" not found in 01-core.js — they have drifted`);
    return core.slice(a, b);
  };
  src = cut('// ── Drag to reorder ──', 'function catDragOver(')
    + cut('// ── The products standing on this shelf ──', 'async function catMoveProduct(');
  ({ reorderSlots } = require('../lib/reorder-slots'));
} catch (e) { console.error('could not run:', e.message); process.exit(2); }

let fails = 0, passes = 0;
function check(name, fn) {
  try { fn(); passes++; console.log('  ok  ', name); }
  catch (e) { fails++; console.log('  FAIL', name, '—', e.message); }
}
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// ── 1. The slots ───────────────────────────────────────────────────────────
console.log('\n1. reorderSlots');
check('a sorted set keeps its own slots', () => eq(reorderSlots([7, 3, 5], 3), [3, 5, 7], 'slots'));
check('ties come out distinct, first slot kept', () => eq(reorderSlots([0, 3, 0], 3), [0, 1, 3], 'slots'));
check('a run of ties climbs past what follows', () => eq(reorderSlots([0, 0, 0, 1], 4), [0, 1, 2, 3], 'slots'));
check('a never-sorted set gets 1..n', () => eq(reorderSlots([0, 0, 0], 3), [1, 2, 3], 'slots'));
check('null and text read as numbers', () => eq(reorderSlots([null, '4', 2], 3), [0, 2, 4], 'slots'));

// ── 2. The shelf list ──────────────────────────────────────────────────────
console.log('\n2. the shelf list');

// DOM stub. Each group list holds units 40px tall stacked from y=100.
const ROW_H = 40, TOP = 100;
const hosts = {};
function unitStub(k) {
  const cls = new Set(['cat2-prod-unit']);
  return {
    classList: { add: c => cls.add(c), remove: (...c) => c.forEach(x => cls.delete(x)), has: c => cls.has(c) },
    getBoundingClientRect: () => ({ top: TOP + k * ROW_H, height: ROW_H }),
  };
}
function hostStub(id) {
  const h = {
    id, _html: '', units: [],
    set innerHTML(v) { this._html = v; this.units = (v.match(/class="cat2-prod-unit"/g) || []).map((_, k) => unitStub(k)); },
    get innerHTML() { return this._html; },
    querySelectorAll() { return this.units; },
    contains: () => false,
  };
  hosts[id] = h;
  return h;
}
const prods = hostStub('cat2-prods');
const sent = [];
const sandbox = {
  window: { matchMedia: () => ({ matches: true }) },   // reduced motion: no FLIP
  document: {
    getElementById: id => {
      if (id === 'cat2-prods') return prods;
      const m = /^cat2-pg-(\d+)$/.exec(id);
      if (!m) return null;
      // A group list, carved out of the pane's markup the way the browser would.
      const h = hostStub(id);
      const block = prods.innerHTML.split('id="' + id + '"')[1].split('class="cat2-prod-list"')[0];
      h.innerHTML = block;
      return h;
    },
    querySelectorAll: () => [],
  },
  setTimeout: () => {}, requestAnimationFrame: () => {},
  escapeHtml: s => String(s), escapeAttr: s => String(s),
  cuT: (en) => en, toast() {},
  CAT_ICON: { grip: '<grip>', box: '<box>' },
  catMode: 'miniapp',
  catSel: 0,
  catModel: [{ id: 't1', name: 'Coffee & Milks', subs: [] }],
  catClean: JSON.stringify([{ id: 't1', name: 'Coffee & Milks', subs: [{ name: 'Hot' }, { name: 'Cold' }] }]),
  api: async (url, opts) => { sent.push({ url, ids: opts && opts.body && opts.body.ids }); return { data: [] }; },
  WeakMap, Array, Map, JSON, String, Number,
};
vm.createContext(sandbox);
vm.runInContext(src + `
this.t = {
  load(rows) { _catProdRows = rows; catProdBuildGroups(); catRenderProdList(); },
  groups: () => _catProdGroups.map(g => ({ sub: g.sub, units: g.units.map(u => u.map(p => p.id)) })),
  catProdDragStart, catProdDragOver, catProdDrop,
};`, sandbox);
const t = sandbox.t;

const P = (id, sub, extra) => Object.assign({ id, name_en: 'P' + id, top_category: 'Coffee & Milks', subcategory: sub, is_published: 1 }, extra);
const ROWS = [
  P(1, ''), P(2, 'Cold'), P(3, 'Hot'), P(4, 'Hot', { variant_group_id: 4 }),
  P(5, 'Gone'), P(6, 'Hot'), P(7, 'Hot', { variant_group_id: 4 }), P(8, 'Cold'),
];

check('groups follow the tree, then an unknown heading, then no heading', () => {
  t.load(ROWS);
  eq(t.groups(), [
    { sub: 'Hot', units: [[3], [4, 7], [6]] },
    { sub: 'Cold', units: [[2], [8]] },
    { sub: 'Gone', units: [[5]] },
    { sub: '', units: [[1]] },
  ], 'groups');
});
check('the mini app view draws a grip per unit, none on a second size', () => {
  t.load(ROWS);
  eq((prods.innerHTML.match(/<grip>/g) || []).length, 7, 'grips');
  eq((prods.innerHTML.match(/cat2-grip-sp/g) || []).length, 1, 'spacers');
});
check('the QR menu view draws no grip', () => {
  sandbox.catMode = 'qr';
  t.load(ROWS);
  sandbox.catMode = 'miniapp';
  eq((prods.innerHTML.match(/<grip>|cat2-grip-sp/g) || []).length, 0, 'grips');
});

// A drag within Hot: take unit 0 (id 3) and drop it at the end.
function drag(gi, ui, dropGi, y) {
  t.load(ROWS);
  const host = sandbox.document.getElementById('cat2-pg-' + dropGi);
  const dt = { setData() {}, setDragImage() {} };
  t.catProdDragStart({ target: { closest: () => null }, dataTransfer: dt }, gi, ui);
  const ev = { currentTarget: host, clientY: y, dataTransfer: dt, preventDefault() {} };
  t.catProdDragOver(ev, dropGi);
  t.catProdDrop(ev, dropGi);
}
check('a drop to the end of its group sends that group, reordered', () => {
  sent.length = 0;
  drag(0, 0, 0, TOP + 3 * ROW_H - 1);
  eq(t.groups()[0].units, [[4, 7], [6], [3]], 'Hot');
  eq(sent, [{ url: '/api/retail-admin/products/reorder', ids: [4, 7, 6, 3] }], 'write');
});
check('a variant group moves whole', () => {
  sent.length = 0;
  drag(0, 1, 0, TOP + 1);
  eq(t.groups()[0].units, [[4, 7], [3], [6]], 'Hot');
  eq(sent[0].ids, [4, 7, 3, 6], 'write');
});
check('a drop back into its own place writes nothing', () => {
  sent.length = 0;
  drag(0, 1, 0, TOP + ROW_H + 5);
  eq(sent, [], 'write');
});
check('a drop on another heading does nothing', () => {
  sent.length = 0;
  drag(0, 0, 1, TOP + 1);
  eq(t.groups()[0].units, [[3], [4, 7], [6]], 'Hot');
  eq(sent, [], 'write');
});

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
