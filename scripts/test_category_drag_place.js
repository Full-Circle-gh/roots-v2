#!/usr/bin/env node
//
// test_category_drag_place.js — dragging a category or subcategory up and down
// on Products → Categories (public/retail-admin/01-core.js, "Drag to reorder").
//
// WHAT WENT WRONG. The row under the cursor decided where a dragged row landed,
// and the line was drawn on that row's FAR edge. Dragging down onto the top
// half of a row drew the line below it, and the row landed one place further
// than the cursor pointed; crossing a row's name or buttons also blinked the
// line off. Ash, 2026-09-29: "not accurate, hard to put it in place".
//
// WHAT MUST HOLD. The cursor picks the nearest gap between rows; the line is
// drawn in that gap; the drop puts the row in that gap. Both directions, the
// very top, the very end, and "no move" when the gap is either side of the
// dragged row itself.
//
// AND, 2026-09-29, the same day: the drop area is the whole box around the
// list, not just the rows. With the area stopping at the last row, moving
// "Snacks & Treats" below "Dry & Pantry" (the last category) only worked by
// letting go on the bottom half of that one row; a little lower did nothing.
//
// The drag section is sliced out of the real file and run in a sandbox, so this
// tests the shipped code, not a copy of it.
//
// USAGE   node scripts/test_category_drag_place.js
// EXIT    0 every assertion held · 1 an assertion failed · 2 could not run

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let src;
try {
  const core = fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', '01-core.js'), 'utf8');
  const a = core.indexOf('// ── Drag to reorder ──');
  const b = core.indexOf('// §288 — a drop in the QR menu');
  if (a < 0 || b < a) throw new Error('drag section anchors not found in 01-core.js — they have drifted');
  src = core.slice(a, b);
} catch (e) { console.error('could not run:', e.message); process.exit(2); }

// ── DOM stub: rows 40px tall, stacked from y=100 ─────────────────────────
const ROW_H = 40, TOP = 100;
function makeRow(k) {
  const cls = new Set(['cat2-row']);
  return {
    k,
    classList: { add: c => cls.add(c), remove: (...c) => c.forEach(x => cls.delete(x)), has: c => cls.has(c) },
    getBoundingClientRect: () => ({ top: TOP + k * ROW_H, height: ROW_H, bottom: TOP + (k + 1) * ROW_H, left: 0 }),
  };
}
let rows = [];
const host = {
  querySelectorAll: () => rows,
  contains: el => el === host || rows.includes(el),
};
const sandbox = {
  window: { matchMedia: () => ({ matches: true }) },   // reduced motion: no FLIP
  document: {
    getElementById: id => (id === 'cat2-rail' || id === 'cat2-subs') ? host : null,
    querySelectorAll: sel => {
      const want = sel.split(',').map(s => s.trim().replace(/^\./, ''));
      return rows.filter(r => want.some(c => r.classList.has(c)));
    },
  },
  setTimeout: () => {}, requestAnimationFrame: () => {},
  catModel: [], catSel: 0, catEdit: null, catMode: 'miniapp',
  catRenderRail() {}, catRenderPane() {}, catUpdateDirty() {}, catQrDrop() { throw new Error('not qr'); },
  WeakMap, Array, Map,
};
vm.createContext(sandbox);
vm.runInContext(src + '\nthis.api = { catDragStart, catDragOver, catDragLeave, catDrop, catDragEnd, catGapAt, catGapToPlace };', sandbox);
const api = sandbox.api;

let fails = 0, passes = 0;
function check(name, fn) {
  try { fn(); passes++; console.log('  ok  ', name); }
  catch (e) { fails++; console.log('  FAIL', name, '—', e.message); }
}
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

const NAMES = ['Yogurts', 'Spreads & Dips', 'Pickles & Olives', 'Plant Protein', 'Cheese'];
function fresh() {
  rows = NAMES.map((_, k) => makeRow(k));
  sandbox.catModel = NAMES.map(n => ({ name: n }));
  sandbox.catSel = 0;
}
function ev(y) { return { clientY: y, currentTarget: host, preventDefault() {}, dataTransfer: { effectAllowed: '', dropEffect: '', setData() {} }, target: { closest: () => null } }; }
// Middle of row k's top half / bottom half.
const topHalf = k => TOP + k * ROW_H + 10;
const botHalf = k => TOP + k * ROW_H + 30;
function drag(from, y) {
  api.catDragStart(ev(0), 'top', from);
  api.catDragOver(ev(y), 'top');
  const cue = rows.map(r => r.classList.has('cat2-drop-before') ? 'before' + r.k : r.classList.has('cat2-drop-after') ? 'after' + r.k : null).filter(Boolean);
  api.catDrop(ev(y), 'top');
  return { cue, order: sandbox.catModel.map(t => t.name) };
}

console.log('\ngap under the cursor');
check('above a row\'s middle is the gap before it', () => { fresh(); eq(api.catGapAt(rows, topHalf(2)), 2, 'gap'); });
check('below a row\'s middle is the gap after it', () => { fresh(); eq(api.catGapAt(rows, botHalf(2)), 3, 'gap'); });
check('above the list is the very top', () => { fresh(); eq(api.catGapAt(rows, 0), 0, 'gap'); });
check('below the list is the very end', () => { fresh(); eq(api.catGapAt(rows, 9999), 5, 'gap'); });

console.log('\ndragging down — the row lands where the line is');
check('Yogurts onto the top half of Pickles lands between Spreads and Pickles', () => {
  fresh();
  const r = drag(0, topHalf(2));
  eq(r.cue, ['before2'], 'line');
  eq(r.order, ['Spreads & Dips', 'Yogurts', 'Pickles & Olives', 'Plant Protein', 'Cheese'], 'order');
});
check('Yogurts onto the bottom half of Pickles lands after Pickles', () => {
  fresh();
  const r = drag(0, botHalf(2));
  eq(r.cue, ['before3'], 'line');
  eq(r.order, ['Spreads & Dips', 'Pickles & Olives', 'Yogurts', 'Plant Protein', 'Cheese'], 'order');
});
check('Yogurts below the last row lands at the end', () => {
  fresh();
  const r = drag(0, botHalf(4));
  eq(r.cue, ['after4'], 'line');
  eq(r.order, ['Spreads & Dips', 'Pickles & Olives', 'Plant Protein', 'Cheese', 'Yogurts'], 'order');
});

console.log('\ndragging up — the row lands where the line is');
check('Plant Protein onto the bottom half of Spreads lands after Spreads', () => {
  fresh();
  const r = drag(3, botHalf(1));
  eq(r.cue, ['before2'], 'line');
  eq(r.order, ['Yogurts', 'Spreads & Dips', 'Plant Protein', 'Pickles & Olives', 'Cheese'], 'order');
});
check('Plant Protein onto the top half of Yogurts lands first', () => {
  fresh();
  const r = drag(3, topHalf(0));
  eq(r.cue, ['before0'], 'line');
  eq(r.order, ['Plant Protein', 'Yogurts', 'Spreads & Dips', 'Pickles & Olives', 'Cheese'], 'order');
});

console.log('\nthe box around the list catches the drop');
check('second-to-last, let go below the list, lands last', () => {
  fresh();
  const r = drag(3, TOP + 5 * ROW_H + 25);    // on the "Add" button under the list
  eq(r.cue, ['after4'], 'line');
  eq(r.order, ['Yogurts', 'Spreads & Dips', 'Pickles & Olives', 'Cheese', 'Plant Protein'], 'order');
});
check('second, let go above the list, lands first', () => {
  fresh();
  const r = drag(1, TOP - 20);                // on the heading above the list
  eq(r.cue, ['before0'], 'line');
  eq(r.order, ['Spreads & Dips', 'Yogurts', 'Pickles & Olives', 'Plant Protein', 'Cheese'], 'order');
});

console.log('\nno move');
check('the gap just above the dragged row draws no line and moves nothing', () => {
  fresh();
  const r = drag(2, botHalf(1));
  eq(r.cue, [], 'line');
  eq(r.order, NAMES, 'order');
});
check('the gap just below the dragged row draws no line and moves nothing', () => {
  fresh();
  const r = drag(2, topHalf(3));
  eq(r.cue, [], 'line');
  eq(r.order, NAMES, 'order');
});

console.log('\nthe line does not blink');
check('crossing into a child of the list keeps the line', () => {
  fresh();
  api.catDragStart(ev(0), 'top', 0);
  api.catDragOver(ev(topHalf(3)), 'top');
  api.catDragLeave({ currentTarget: host, relatedTarget: rows[3] });
  eq(rows[3].classList.has('cat2-drop-before'), true, 'line still drawn');
  api.catDragEnd();
});
check('leaving the list clears the line', () => {
  fresh();
  api.catDragStart(ev(0), 'top', 0);
  api.catDragOver(ev(topHalf(3)), 'top');
  api.catDragLeave({ currentTarget: host, relatedTarget: {} });
  eq(rows.some(r => r.classList.has('cat2-drop-before') || r.classList.has('cat2-drop-after')), false, 'no line');
  api.catDragEnd();
});

console.log('\nthe line is painted on the edge the code names');
// The code can pick the right gap and the page still lie about it: the line is
// an INSET box-shadow, and an inset shadow shows on the edge its offset points
// AWAY from (+y paints the top edge, -y the bottom). With the signs swapped,
// "before" was drawn under the row, so every line sat one row too low. Seen in
// Chromium on the real page, 2026-09-29; checked here from the stylesheet so
// the fast shard catches a flip without a browser.
check('drop-before paints the top edge, drop-after the bottom', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin.css'), 'utf8');
  const y = cls => {
    const m = css.match(new RegExp('\\.' + cls + '\\s*\\{\\s*box-shadow:\\s*0\\s+(-?\\d+)px\\s+0[^;]*inset'));
    if (!m) throw new Error(`.${cls} box-shadow rule not found — the anchor has drifted`);
    return Number(m[1]);
  };
  eq(y('cat2-drop-before') > 0, true, 'drop-before offset is positive (top edge)');
  eq(y('cat2-drop-after') < 0, true, 'drop-after offset is negative (bottom edge)');
});

console.log('\nthe pane follows the category it was showing');
check('the selected category stays selected after moving past it', () => {
  fresh();
  sandbox.catSel = 2;                         // showing Pickles & Olives
  drag(0, botHalf(3));                         // Yogurts to after Plant Protein
  eq(sandbox.catModel[sandbox.catSel].name, 'Pickles & Olives', 'selected');
});

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
