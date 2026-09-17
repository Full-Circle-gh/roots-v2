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
//
// AMENDED BY §159 — THE FOUR LISTS ARE NO LONGER IN THIS PAGE. They were Roots'
// catalogue compiled into the editor, offered to every tenant on the platform
// including shops that sell nothing perishable. They are counted per tenant now
// by GET /api/retail-admin/products/storage-usage, so the checks here that read
// a literal could no longer read anything — and this file's `literal()` helper
// did what it was built to do: it failed on the anchor rather than passing
// against an empty object.
//
// THE CLAIMS DID NOT GO AWAY, THEY MOVED, and the snowflake is the reason this
// mattered more than a tidy-up. A count keyed on the exact string would tally
// ❄ and ❄️ as two answers and offer BOTH — extending the very drift this file
// was written to end. lib/pair-usage.js therefore folds a variation selector
// before counting and returns the commonest exact spelling, and
// scripts/test_storage_vocabulary_tenant.js proves it over real rows. What
// stays HERE is every claim about the pick MECHANICS — the scoping, the second
// writer, the name-not-source rule — none of which §159 touched.
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

// No literals to read any more — see the amendment above. `literal()` is kept
// because the check below uses it to prove they are GONE rather than moved to a
// new name, and because deleting a helper a future list might need again is a
// deletion somebody has to undo.


section('The invisible drift — the reason this exists');

// Every check that used to stand here read a compiled list: that each icon
// carried its variation selector, that no icon was offered twice in two
// spellings, that the snowflake matched across both cards, that every head and
// unit was a pair, that a losing twin was not also offered, that no two entries
// differed only by case, and that the note list stayed short. All seven were
// claims about DATA the editor no longer holds.
//
// They are asserted against the counter that now produces that data, over rows
// rather than over a literal, in scripts/test_storage_vocabulary_tenant.js —
// including the snowflake case, which is the one that could have been silently
// undone: a tally keyed on the exact string would offer ❄ AND ❄️.

check('the page carries no storage list of its own', () => {
  for (const name of ['PA_STORAGE_ICONS', 'PA_STORAGE_HEADS', 'PA_STORAGE_UNITS', 'PA_STORAGE_NOTES']) {
    assert.ok(!new RegExp('const ' + name + ' = ').test(SRC),
      `${name} is a compiled list again — every tenant would be offered the shop it was measured from`);
    assert.ok(new RegExp('let ' + name + ' = ').test(SRC),
      `${name} is neither a literal nor the empty list it should start as`);
  }
  /* The answers themselves, spot-checked in LIST SHAPE — `en: '…'`, which is
     how an offered pair is written. Deliberately not a bare substring search:
     the same words appear in PA_TEMPLATES and in the preview/thumbnail samples
     as `num_en: 'Refrigerate'`, and those are a different thing. A template is
     a starting design the office PICKS and previews before applying; a pick
     list is an answer offered as though it were measured. §159 moved the
     second and left the first, which §156 already recorded as the food-shaped
     part of this editor that is not solved and is not pretended to be. */
  for (const roots of ['Refrigerate', 'See packaging', '开封后请密封保存。', '冷藏保存']) {
    // The property boundary is load-bearing: `num_en: 'Refrigerate'` ENDS with
    // `en: 'Refrigerate'`, so a plain substring search reports the template
    // samples as list entries. A list pair is written `{ en: …` or `, en: …`.
    const asListEntry = new RegExp("[{,]\\s*en: '" + roots.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'");
    assert.ok(!asListEntry.test(SRC),
      `the editor still offers "${roots}" as a list answer — that is one shop's data`);
  }
});

check('the page asks for them instead, beside the other shop-wide counts', () => {
  assert.ok(/\/api\/retail-admin\/products\/storage-usage/.test(SRC),
    'nothing fetches the counted lists, so no storage field will ever be offered one');
  const mount = anchored('peMount');
  assert.ok(/paLoadStorageUsage\(\)/.test(mount), 'the mount never asks for the counts');
  assert.ok(/_peShopLoaded/.test(mount),
    'the count is re-fetched on every product switch — a request per click for an answer that cannot change');
});

check('a field with nothing to offer shows no control, not an empty one', () => {
  /* A select whose only entry is "Something else" is a dropdown that cannot be
     used, sitting above the boxes it would have filled. On a shop's first
     product every one of these lists is empty, so this is the NORMAL state for
     a new tenant rather than a corner. */
  const f = anchored('_paPickField');
  assert.ok(/!Array\.isArray\(list\) \|\| !list\.length/.test(f),
    '_paPickField renders a select before checking it has anything to put in it');
  const chips = anchored('_paIconChips');
  assert.ok(/!icons\.length/.test(chips),
    'an empty icon row is still drawn — a gap under a label with no control in it');
});

check('the lists stay let-bound so the pickers see them once they land', () => {
  /* _PA_PICK_LISTS resolves a NAME to an array through a closure. That is what
     makes an async fill work with no re-wiring — and it only works while these
     are bindings the closure can re-read. */
  const map = SRC.slice(SRC.indexOf('const _PA_PICK_LISTS = {'));
  const body = map.slice(0, map.indexOf('};') + 2);
  for (const name of ['PA_STORAGE_HEADS.left', 'PA_STORAGE_HEADS.right',
                      'PA_STORAGE_UNITS.left', 'PA_STORAGE_UNITS.right', 'PA_STORAGE_NOTES']) {
    assert.ok(body.includes("'" + name + "'"), `${name} has left the pick-list map`);
  }
  assert.ok(/\(\) =>/.test(body),
    'the map holds values rather than getters — a list filled after load would never be seen');
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
  /* 218 storage boxes say what they say today. They keep saying it. A list that
     silently rewrote them would be changing live customer pages on load, which
     is the §144 refusal in a smaller frame — and it is the reason the counted
     lists are an OFFER and never a migration. */
  for (const fn of ['peMount', 'paBlocksCollect']) {
    const b = anchored(fn);
    for (const name of ['PA_STORAGE_ICONS', 'PA_STORAGE_HEADS', 'PA_STORAGE_UNITS', 'PA_STORAGE_NOTES']) {
      assert.ok(!new RegExp(name + '\\b').test(b),
        `${fn} consults ${name} — a pick list must be offered, never applied`);
    }
  }
});

console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
