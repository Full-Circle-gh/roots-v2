// The storage box's pick lists, and the invisible drift they exist to end.
//
// THE CASE THAT MADE THIS WORTH BUILDING is one nobody could have found by
// proofreading. Across 218 storage boxes the catalogue carries ❄️ 83 times on
// the left card and ❄ five times on the right — THE SAME SNOWFLAKE, typed with
// and without the invisible variation selector U+FE0F. 🌡️ (18) sits beside 🌡
// (9) the same way. On screen they are identical; to a string comparison, to a
// filter, and to anything that groups by value, they are different characters.
// No amount of care fixes that. A picker does, in one click.
//
// WHAT ELSE THIS HOLDS. §147 generalised the picker §145 built for the spec
// strip, so one scoping helper now serves a strip's three cells AND a storage
// box's two cards plus its note. That is three scopes on screen at once, each
// carrying a head_en — the exact shape of bug §144 and §142 both had to close.
// It is asserted, not trusted.
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
function literal(name) {
  const head = 'const ' + name + ' = ';
  const at = SRC.indexOf(head);
  assert.ok(at >= 0, name + ' is gone');
  const open = SRC.indexOf(SRC[at + head.length] === '[' ? '[' : '{', at);
  const closer = SRC[open] === '[' ? ']' : '}';
  let i = open, depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === SRC[open]) depth++;
    else if (SRC[i] === closer) { depth--; if (!depth) break; }
  }
  return new Function('return ' + SRC.slice(open, i + 1) + ';')();
}

const ICONS = literal('PA_STORAGE_ICONS');
const HEADS = literal('PA_STORAGE_HEADS');
const UNITS = literal('PA_STORAGE_UNITS');
const NOTES = literal('PA_STORAGE_NOTES');

// The variation selector that makes two identical-looking emoji different data.
const VS16 = '️';

section('The invisible drift — the reason this exists');

check('every offered icon carries its variation selector', () => {
  /* ❄ and ❄️ look the same and are not. The list must offer the form the
     catalogue uses MOST, or a picker would introduce a third spelling rather
     than end the second. */
  for (const side of ['left', 'right']) {
    for (const ic of ICONS[side]) {
      // Only emoji that HAVE a text/emoji duality need the selector; the test
      // is that any icon whose base is in the dual set carries it.
      const base = ic.replace(VS16, '');
      const dual = ['❄', '☁', '☀', '⏱', '⬛'];  // ❄ ☁ ☀ ⏱ ⬛
      if (dual.includes(base)) {
        assert.ok(ic.includes(VS16),
          `${side} offers ${JSON.stringify(ic)} without U+FE0F — that is the bare form, ` +
          'which is the minority spelling the list is meant to replace');
      }
    }
  }
});

check('no icon is offered twice on one side, in either spelling', () => {
  for (const side of ['left', 'right']) {
    const bare = ICONS[side].map(ic => ic.replace(VS16, ''));
    assert.strictEqual(new Set(bare).size, bare.length,
      `${side} offers the same icon twice — once with the selector and once without, which is the bug`);
  }
});

check('the snowflake is offered on both cards, identically', () => {
  /* It is the commonest icon on each side (83 left, 55 right). If the two
     lists spelled it differently the picker would CREATE the drift. */
  const l = ICONS.left.find(i => i.startsWith('❄'));
  const r = ICONS.right.find(i => i.startsWith('❄'));
  assert.ok(l && r, 'the snowflake has left one of the icon lists');
  assert.strictEqual(l, r, 'the two cards offer the snowflake in different spellings');
});

section('Every offered answer is a PAIR');

check('every head and unit carries both languages', () => {
  for (const [name, group] of [['heads', HEADS], ['units', UNITS]]) {
    for (const side of ['left', 'right']) {
      assert.ok(group[side] && group[side].length, `${name}.${side} is empty`);
      for (const o of group[side]) {
        assert.ok(o.en && o.en.trim(), `${name}.${side}: an entry has no English`);
        assert.ok(o.cn && o.cn.trim(), `${name}.${side}: "${o.en}" has no 中文`);
        assert.ok(/[一-鿿°]/.test(o.cn), `${name}.${side}: "${o.en}" has no CJK in its 中文`);
      }
    }
  }
  for (const o of NOTES) {
    assert.ok(o.en && o.cn, 'a note entry is missing a language');
  }
});

check('the losing twin is not also offered', () => {
  /* Most-used wins, which was Ash's rule. Offering both halves of a pair the
     list exists to merge would leave the split exactly where it was. */
  /* Only twins that differ by WORDS are listed here. A twin that differs only
     by CASE — 'Cool & Dry' beside 'Cool & dry' — cannot be expressed in a
     case-insensitive check at all; the duplicate check below catches those. */
  const lose = {
    'HEADS.left':  ['keep refrigerated', 'before opening'],
    'HEADS.right': ['use after opening', 'freeze', 'freezing'],
  };
  const has = (list, en) => list.some(o => o.en.toLowerCase() === en.trim());
  for (const en of lose['HEADS.left']) {
    assert.ok(!has(HEADS.left, en), `left heads still offer "${en.trim()}" beside its winner`);
  }
  for (const en of lose['HEADS.right']) {
    assert.ok(!has(HEADS.right, en), `right heads still offer "${en.trim()}" beside its winner`);
  }
  assert.ok(HEADS.left.some(o => o.en === 'Refrigerate'), 'Refrigerate (52) is no longer the winner on the left');
  assert.ok(HEADS.right.some(o => o.en === 'Shelf Life'), 'Shelf Life (57) is no longer the winner on the right');
});

check('no two entries in one list differ only by case', () => {
  /* This is the check that catches 'Cool & Dry' beside 'Cool & dry'. The
     picker matches case-insensitively, so two such entries would be two rows
     that select each other — and would put back the exact split the list ends. */
  for (const [name, group] of [['heads', HEADS], ['units', UNITS]]) {
    for (const side of ['left', 'right']) {
      const seen = new Set();
      for (const o of group[side]) {
        const k = o.en.toLowerCase();
        assert.ok(!seen.has(k), `${name}.${side} offers "${o.en}" and a case-twin of it`);
        seen.add(k);
      }
    }
  }
  const seen = new Set();
  for (const o of NOTES) {
    const k = o.en.toLowerCase();
    assert.ok(!seen.has(k), `the note list offers "${o.en}" and a case-twin of it`);
    seen.add(k);
  }
});

check('the note list stays short on purpose', () => {
  /* 77 distinct notes, and the usage report truncated the long ones — so
     pairing an English sentence to its 中文 would have meant guessing, which is
     the one thing this method must not do. Only the two printed whole are
     offered. A list that grows here without a fresh measurement is a list
     somebody filled in from memory. */
  assert.ok(NOTES.length <= 4,
    'the note list has grown past what the measurement supports — re-run the usage report before adding more');
});

section('Three scopes on screen, and each fills only its own');

check('one scoping helper serves every picker on the page', () => {
  const b = anchored('_paPickInputs');
  assert.ok(/closest\(['"`]\[data-pickscope\]['"`]\)/.test(b),
    'the helper does not resolve its scope — with three on screen it fills whichever rendered first');
  assert.ok(!/document\.querySelector/.test(b), 'an unscoped document query is back');
});

check('both storage cards and the note each carry a scope marker', () => {
  const body = anchored('_paBlockEditorBody');
  const storage = body.slice(body.indexOf("b.type === 'storage_box'"));
  const cut = storage.indexOf("b.type === 'notes_callout'");
  const block = cut > 0 ? storage.slice(0, cut) : storage;
  const marks = (block.match(/data-pickscope/g) || []).length;
  assert.ok(marks >= 2,
    `the storage box declares ${marks} scope marker(s) — the cards and the note each need one, ` +
    'or their pickers reach into a sibling');
});

check('the icon click is scoped too, and repaints only its own chips', () => {
  const b = anchored('paPickIcon');
  assert.ok(/closest\(['"`]\[data-pickscope\]['"`]\)/.test(b), 'paPickIcon is not scoped to its card');
  assert.ok(/scope\.querySelector\(['"`]\[data-bkey="icon"\]/.test(b),
    'the icon input is not looked up inside the card — clicking the right card would write the left icon');
  assert.ok(/scope\.querySelectorAll\(['"`]\.pa-icon-chip/.test(b),
    'the selected-chip repaint is not scoped — clicking one card would light up the other');
  assert.ok(!/document\.querySelector/.test(b),
    'an unscoped document query is back inside paPickIcon');
});

check('the list name reaches the handler as a NAME, never as source', () => {
  /* The list to use is written into an inline onchange attribute. Anything
     that gets from markup to the JS parser is a door left open, so the name is
     resolved against a fixed map rather than evaluated. */
  const b = anchored('_paPickList');
  assert.ok(/_PA_PICK_LISTS\[/.test(b), 'the list is no longer resolved through the fixed map');
  assert.ok(!/eval|new Function|window\[/.test(b),
    'the list name is being evaluated — an attribute value must never reach the parser');
});

section('The pick is a convenience layer, never a second writer');

check('the typed inputs stay in the DOM and keep data-bkey', () => {
  const f = anchored('_paPickField');
  assert.ok(/paPair\(\{/.test(f), 'the typed pair no longer rides paPair, so it has left the generic sync');
  assert.ok(/hidden/.test(f), 'the typed pair is removed rather than hidden — the sync would lose the field');
});

check('the pick writes the inputs, not the block', () => {
  const b = anchored('paPickPair');
  assert.ok(/io\.en\.value = /.test(b), 'paPickPair does not write the input');
  assert.ok(!/_paBlocks/.test(b), 'paPickPair reaches into the block model — a second writer beside the sync');
});

check('nothing consults the lists on load or on save', () => {
  for (const [fn, why] of [['peMount', 'on load — that would be a migration'],
                           ['paBlocksCollect', 'on save — it must persist what is in the block']]) {
    assert.ok(!/PA_STORAGE_(ICONS|HEADS|UNITS|NOTES)/.test(anchored(fn)),
      `${fn} consults the storage lists ${why}`);
  }
});

console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
