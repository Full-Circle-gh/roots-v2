// The spec-strip pick lists: offered, never enforced, and never a second writer.
//
// WHY THIS FILE EXISTS. §145 put two dropdowns on every spec-strip cell — one
// for the label, one for the value. Three things about that can go wrong
// silently, and each one would reach a live customer page:
//
//   1. A PICK THAT FILLS ONE LANGUAGE. The whole point of a list is that
//      choosing "Origin" also writes 产地. A list that fills only the English
//      is worse than typing, because the gap is invisible from the English view.
//
//   2. A PICK THAT LANDS IN THE WRONG CELL. A strip has three cells side by
//      side and each carries a k_en. An unscoped query fills the first one
//      every time. This is §144's failure at a smaller scale, and §142's
//      before that — the same mistake has now been made twice on this page, so
//      it is held by a test rather than by care.
//
//   3. A PICK THE REBUILD PAINTS OVER. paSpecPickLabel writes the inputs, then
//      syncs, then rebuilds the document from the model. Syncing FIRST — which
//      is what every other handler on this page does, so it is the natural
//      thing to write — reads the OLD input values into the model and the
//      rebuild puts them straight back. Caught in a browser: choosing
//      "Product Type" left the cell still saying "Net Wt".
//
// HOW IT RUNS WITHOUT A BROWSER. The fast shard has no DOM and the slow shard
// is not run at all. So the list DATA is asserted directly, and the handlers
// are asserted at their source with anchors that fail loudly if renamed.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public/product-editor.html'), 'utf8');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '\n      ' + e : '')); };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { bad(m, e.message); } };
const section = (t) => console.log('\n' + t);

function fnBody(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(SRC);
  if (!m) return '';
  let i = m.index + m[0].length, depth = 1;
  for (; i < SRC.length && depth > 0; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') depth--;
  }
  return SRC.slice(m.index, i);
}
const anchored = (n) => {
  const b = fnBody(n);
  assert.ok(b, `${n}() not found — the anchor moved, so this check proves nothing`);
  return b;
};
// Lift a declared array/object literal out of the page and evaluate it.
function literal(name) {
  const at = SRC.indexOf('const ' + name + ' = ');
  assert.ok(at >= 0, name + ' is gone');
  const open = SRC.indexOf(SRC[at + ('const ' + name + ' = ').length] === '[' ? '[' : '{', at);
  const closer = SRC[open] === '[' ? ']' : '}';
  let i = open, depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === SRC[open]) depth++;
    else if (SRC[i] === closer) { depth--; if (!depth) break; }
  }
  return new Function('return ' + SRC.slice(open, i + 1) + ';')();
}

const LABELS = literal('PA_SPEC_LABELS');
const VALUES = literal('PA_SPEC_VALUES');

section('Every offered answer is a PAIR, or the list is worse than typing');

check('every label carries both languages', () => {
  assert.ok(LABELS.length >= 8, 'the label list has shrunk below the measured set');
  for (const o of LABELS) {
    assert.ok(o.en && o.en.trim(), 'a label has no English: ' + JSON.stringify(o));
    assert.ok(o.cn && o.cn.trim(), 'a label has no 中文: ' + JSON.stringify(o) +
      ' — a pick that fills one language is a gap nobody can see from the English view');
    assert.ok(/[一-鿿]/.test(o.cn), o.en + ' has no CJK in its 中文 half');
  }
});

check('every value carries both languages', () => {
  for (const [label, list] of Object.entries(VALUES)) {
    assert.ok(Array.isArray(list) && list.length, label + ' has an empty value list');
    for (const o of list) {
      assert.ok(o.en && o.en.trim(), label + ': a value has no English');
      assert.ok(o.cn && o.cn.trim(), label + ': "' + o.en + '" has no 中文');
    }
  }
});

check('every value list hangs off a label that is actually offered', () => {
  const offered = new Set(LABELS.map(o => o.en.toLowerCase()));
  for (const label of Object.keys(VALUES)) {
    assert.ok(offered.has(label),
      `values are offered under "${label}" but that label is not in the list — they can never be reached`);
  }
});

check('no duplicate labels, and none of them collide case-insensitively', () => {
  const seen = new Set();
  for (const o of LABELS) {
    const k = o.en.toLowerCase();
    assert.ok(!seen.has(k), 'the label list itself contains "' + o.en + '" twice');
    seen.add(k);
  }
});

section('The decision Ash made: one label for one idea');

check('"Type" is not offered beside "Product Type"', () => {
  /* They are not spellings of each other — they are two labels for one idea,
     66 and 64 cells, holding the same answers. Offering both continues the
     split, which is the entire reason the list exists. */
  const ens = LABELS.map(o => o.en.toLowerCase());
  assert.ok(ens.includes('product type'), 'Product Type is no longer offered');
  assert.ok(!ens.includes('type'), '"Type" is back in the list — the split it was meant to end will resume');
});

check('"Net Weight" is not offered beside "Net Wt"', () => {
  const ens = LABELS.map(o => o.en.toLowerCase());
  assert.ok(ens.includes('net wt'), 'Net Wt is no longer offered');
  assert.ok(!ens.includes('net weight'), '"Net Weight" is back — 163 vs 29 was the split this ends');
});

check('the three that pay for the change are on offer', () => {
  /* Origin "Guangzhou, China" is 109 of 156 cells, Shelf Life "See packaging"
     46 of 57, Diet "100% plant" 28 of 29 — 242 cells typed by hand. If any of
     these three lists goes, the change stops being worth its own screen. */
  for (const [label, want] of [['origin', 'Guangzhou, China'],
                               ['shelf life', 'See packaging'],
                               ['diet', '100% plant']]) {
    const list = VALUES[label];
    assert.ok(list, 'no value list for ' + label);
    assert.ok(list.some(o => o.en === want), `${label} no longer offers "${want}"`);
  }
  assert.strictEqual(VALUES['origin'][0].cn, '中国广州', 'Origin’s first pair lost its 中文');
});

check('a field whose answer is different every time gets NO list', () => {
  /* Net Wt is 67 distinct weights across 163 cells. A list there would be a
     dropdown nobody can find their product in. */
  assert.ok(!VALUES['net wt'], 'Net Wt has grown a value list — 67 distinct weights is not a list');
  assert.ok(!VALUES['certification'], 'Certification has a value list drawn from 13 cells — too thin');
});

section('The pick is a convenience layer, never a second writer');

check('the typed inputs still carry data-bkey, so the sync is untouched', () => {
  const cell = anchored('_paSpecCell');
  for (const k of ['k_en', 'k_cn', 'v_en', 'v_cn']) {
    assert.ok(new RegExp("keyEn: '" + k + "'|keyCn: '" + k + "'").test(cell),
      `${k} no longer rides paPair — it has left the generic sync and needs its own writer`);
  }
  assert.ok(/data-cellidx=/.test(cell), 'the cell index is gone — every cell would write to cells[0]');
});

check('the pick writes the INPUTS, never the block directly', () => {
  /* Two writers for one field is how §142 shipped. The select fills the input;
     the input is what the sync reads. */
  for (const fn of ['paSpecPickLabel', 'paSpecPickValue']) {
    const b = anchored(fn);
    assert.ok(/io\.en\.value = /.test(b), fn + ' does not write the input');
    assert.ok(!/_paBlocks/.test(b),
      fn + ' reaches into the block model — that is a second writer beside the sync');
  }
});

check('the pick is scoped to its own CELL, not to the section', () => {
  const b = anchored('_paSpecInputs');
  assert.ok(/closest\(['"`]\[data-speccell\]['"`]\)/.test(b),
    'the handler does not resolve the cell it sits in — with three cells it will fill the first');
  assert.ok(!/document\.querySelector\(['"`]\[data-bkey/.test(b),
    'an unscoped document query is back — it will fill whichever cell rendered first');
});

check('the label pick writes BEFORE it syncs, or the rebuild paints over it', () => {
  /* The bug this catches was real and was caught in a browser, not in review:
     syncing first read the old input values into the model, and paRenderDoc
     repainted them over the pick. Choosing "Product Type" left the cell saying
     "Net Wt". */
  const b = anchored('paSpecPickLabel');
  const write = b.indexOf('io.en.value =');
  const sync  = b.indexOf('paBlocksSyncFromDOM()');
  const paint = b.indexOf('paRenderDoc()');
  assert.ok(write > 0 && sync > 0 && paint > 0, 'the handler no longer does all three steps');
  assert.ok(write < sync,
    'paSpecPickLabel syncs before it writes — the rebuild will paint the old value back over the pick');
  assert.ok(sync < paint, 'the rebuild runs before the sync — other sections would lose what is typed in them');
});

section('Nothing rewrites a page that is already live');

check('the pick lists are offered; no migration rides along', () => {
  /* 66 cells say "Type" today. They keep saying it. A list that silently
     rewrote them would be changing live customer pages on load, which is the
     §144 refusal in a smaller frame. */
  assert.ok(!/PA_SPEC_LABELS/.test(anchored('peMount')),
    'peMount consults the label list on load — that is a migration, not an offer');
  assert.ok(!/PA_SPEC_LABELS|PA_SPEC_VALUES/.test(anchored('paBlocksCollect')),
    'the save consults the pick lists — it must persist what is in the block, not what is on the list');
});

check('an unlisted answer is shown as typed, not demoted or blanked', () => {
  const b = anchored('paSpecMatch');
  assert.ok(/toLowerCase\(\)/.test(b),
    'the match is case-sensitive — a cell reading "Net wt" would be shown as something unusual');
  assert.ok(/return -1/.test(b), 'no miss path — an unlisted answer has nowhere to land');
  const cell = anchored('_paSpecCell');
  assert.ok(/kCustom \? '' : 'hidden'/.test(cell),
    'the typed boxes are not revealed for an answer that is off the list');
});

check('the match reads the English only, so a good 中文 is never demoted', () => {
  const b = anchored('paSpecMatch');
  assert.ok(!/\.cn/.test(b),
    'the match consults the 中文 — an existing cell with a perfectly good 中文 spelled differently ' +
    'would show as "Something else", inviting somebody to overwrite it');
});

console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
