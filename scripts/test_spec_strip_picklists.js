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
//
// AMENDED BY §155 — THE VALUES ARE NO LONGER IN THIS PAGE. They were Roots'
// catalogue compiled into the editor's source, which on a platform offered a
// shop in Shanghai a Guangzhou origin as its default. They are now counted per
// tenant by GET /api/retail-admin/products/spec-usage, so the four checks here
// that read a PA_SPEC_VALUES literal could no longer read anything — and this
// file's `literal()` helper did exactly what it was built to do: it failed on
// the anchor rather than passing against an empty object.
//
// WHAT THOSE FOUR CHECKS CLAIMED IS NOT WITHDRAWN, it moved. Every pair being
// bilingual, values hanging off an offered label, Roots' three measured lists
// surviving, and a field of one-off answers getting no list at all are now
// asserted against the counter that produces them, in
// scripts/test_spec_vocabulary_tenant.js, by running it over fixtures. What
// stays here is everything about the LABEL list (still a literal in the page)
// and every claim about the pick MECHANICS, which §155 did not touch.
//
// The one claim that genuinely changed shape is Net Wt's. §145 gave it no value
// list by naming it; a per-tenant count cannot carry an exception for the words
// "net wt", so the rule is now read off the data — an answer must have been
// used twice before it is offered back. A field of 67 one-off weights still
// collapses to nothing, which was the point.
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
// No VALUES literal any more — see the amendment above.

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

// The three checks that stood here read the PA_SPEC_VALUES literal: every pair
// bilingual, every list hanging off an offered label, and the page never
// consulting a value list on save. They are asserted against the counter now
// (test_spec_vocabulary_tenant.js). What can still be checked HERE is that the
// page holds no value list of its own and knows how to live without one.

check('the page carries no value list of its own', () => {
  assert.ok(!/const PA_SPEC_VALUES = \{/.test(SRC),
    'a compiled value list is back — every tenant would be offered the shop it was measured from');
  assert.ok(/let PA_SPEC_VALUES = null;/.test(SRC),
    'PA_SPEC_VALUES is neither a literal nor the null it should start as');
  /* `See packaging` is deliberately NOT in this list, and the omission is the
     point: it is still in the page, inside PA_STORAGE_UNITS, because §155's
     first pass migrated the spec strip and the colophon and not the storage
     box. Asserting it here would either fail on work that has not been done or
     have to be weakened later — both worse than naming it. The check below
     holds the line instead. */
  for (const roots of ['Guangzhou, China', '100% plant']) {
    assert.ok(!SRC.includes("'" + roots + "'"),
      `the editor still names "${roots}" as an offered answer — that is one shop's data`);
  }
});

// §147's storage-box lists are the SAME fault one section over: PA_STORAGE_HEADS,
// PA_STORAGE_UNITS and PA_STORAGE_NOTES are Roots' measured answers compiled
// into the page, offered to every tenant. §155 migrated the spec strip first
// and named these as next. This check exists so that stays a decision somebody
// made rather than something everyone forgot — it fails the day a FOURTH list
// is added, and it is deleted the day the three are counted like the spec's.
check('the storage box\'s lists are the known remainder, and have not grown', () => {
  const compiled = ['PA_STORAGE_HEADS', 'PA_STORAGE_UNITS', 'PA_STORAGE_NOTES']
    .filter(n => new RegExp('const ' + n + ' = ').test(SRC));
  assert.deepStrictEqual(compiled.sort(),
    ['PA_STORAGE_HEADS', 'PA_STORAGE_NOTES', 'PA_STORAGE_UNITS'],
    'the storage lists changed shape — if they were migrated, delete this check; ' +
    'if one was added, it is a fourth list of one shop\'s answers shown to every shop');
  assert.ok(!/const PA_[A-Z_]*_VALUES = \{/.test(SRC),
    'a new compiled answer list appeared — count it per tenant instead');
});

check('the page asks for the values instead, and asks once', () => {
  assert.ok(/\/api\/retail-admin\/products\/spec-usage/.test(SRC),
    'nothing fetches the counted lists, so no cell will ever be offered a value');
  const mount = anchored('peMount');
  assert.ok(/paLoadSpecUsage\(\)/.test(mount), 'the mount never asks for the counts');
  assert.ok(/_peShopLoaded/.test(mount),
    'the count is re-fetched on every product switch — a request per click for an answer that cannot change');
});

check('a cell is offered nothing at all until the count lands', () => {
  /* Null, not an empty object, and not a leftover from the last shop. A wrong
     list is worse than no list, because nothing on screen says it is wrong —
     the same posture §144's usage percentage takes. */
  const b = anchored('paSpecValuesFor');
  assert.ok(/if \(!PA_SPEC_VALUES\) return null;/.test(b),
    'the lookup reads the bag before it exists');
  assert.ok(/Array\.isArray\(list\) && list\.length/.test(b),
    'an empty list would be handed to the renderer as though it were offered answers');
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

// §145's three measured lists — Origin "Guangzhou, China" 109 of 156, Shelf
// Life "See packaging" 46 of 57, Diet "100% plant" 28 of 29 — are the reason
// that change was worth its own screen, and they are still offered to Roots.
// They are no longer ASSERTED here because they are no longer in this page:
// test_spec_vocabulary_tenant.js proves the counter reproduces all three from
// Roots-shaped rows, which is a stronger claim than a literal ever made.
//
// Net Wt's "no list" rule likewise: §145 named the field, §155 reads it off the
// data, and the same file proves twenty one-off weights still yield nothing.

check('the label list is still the neutral half, and still measured', () => {
  /* The labels stayed in the page ON PURPOSE. They name what a row IS — Net Wt,
     Origin, Shelf Life — and are neutral in any trade, where the ANSWERS never
     are. A label list that started naming answers would be the fault §155
     removed, coming back one entry at a time. */
  const ens = LABELS.map(o => o.en.toLowerCase()).join(' | ');
  for (const answer of ['guangzhou', 'packaging', 'plant', 'vegan', 'china']) {
    assert.ok(!ens.includes(answer),
      `"${answer}" is an answer, not a row name — it does not belong in the label list`);
  }
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
  /* §147 generalised this helper so the storage box's two cards use it too —
     one scoping helper on the page, not two copies drifting apart. The rule it
     enforces did not change: a picker fills the inputs inside its OWN scope. */
  const b = anchored('_paPickInputs');
  assert.ok(/closest\(['"`]\[data-pickscope\]['"`]\)/.test(b),
    'the handler does not resolve the scope it sits in — with three cells it will fill the first');
  assert.ok(!/document\.querySelector\(['"`]\[data-bkey/.test(b),
    'an unscoped document query is back — it will fill whichever scope rendered first');
  assert.ok(/data-pickscope/.test(anchored('_paSpecCell')),
    'the spec cell no longer carries the scope marker, so its pickers resolve to nothing');
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
  /* peMount FETCHES the counted lists now (§155), which is not the same thing
     as consulting them: what it must never do is read a list and rewrite a
     stored cell against it. The check therefore names the list itself, not the
     loader that asks for it. */
  assert.ok(!/PA_SPEC_LABELS\b/.test(anchored('peMount')),
    'peMount consults the label list on load — that is a migration, not an offer');
  assert.ok(!/PA_SPEC_VALUES\b/.test(anchored('peMount')),
    'peMount reads the value bag on load — a pick list must be offered, never applied');
  assert.ok(!/PA_SPEC_LABELS|PA_SPEC_VALUES|paSpecLabels\(\)/.test(anchored('paBlocksCollect')),
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
