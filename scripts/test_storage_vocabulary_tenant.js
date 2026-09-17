#!/usr/bin/env node
//
// test_storage_vocabulary_tenant.js — the storage box's words belong to the
// shop that typed them.
//
// WHAT THIS IS FOR (§159)
// -----------------------
// §147 gave the storage box four pick lists the way §145 gave two to the spec
// strip, and for the same measured reason: across 218 storage boxes the same
// answer had been typed several ways. But the lists it offered were ROOTS'
// CATALOGUE COMPILED INTO THE EDITOR — `Refrigerate · 冷藏保存`, `See packaging
// · 见包装标示`, `开封后请密封保存。` — so every tenant on the platform, including
// one selling nothing perishable, was offered a vegan grocer's storage
// vocabulary in the same control that elsewhere carries measured fact. §156
// moved the spec strip's values out and recorded these four as the remainder.
//
// THE CLAIM THIS FILE KEEPS HONEST is not "the lists moved". It is:
//
//  1. THE SNOWFLAKE STILL COLLAPSES. This is the one that could have been
//     silently undone. ❄ and ❄️ look identical and are not — the second carries
//     U+FE0F — and §147 exists because the catalogue holds both. A count keyed
//     on the exact string would tally them as TWO answers and offer BOTH,
//     extending the drift the picker was built to end. The fold is asserted
//     here, over rows, not assumed from a comment.
//  2. ROOTS' MEASURED LISTS COME BACK when counted rather than typed —
//     otherwise this is a regression dressed as a principle.
//  3. A SHOP WITH NO HISTORY IS OFFERED NOTHING, and a left answer is never
//     offered on the right.
//
// HOW IT RUNS THE REAL CODE — nothing here is a paraphrase. The handler is
// lifted out of routes/retail.js by its route registration and executed against
// fixture rows shaped exactly like description_blocks, with the REAL counting
// module and the REAL block reader in scope.
//
// USAGE   node scripts/test_storage_vocabulary_tenant.js
// EXIT    0 every assertion held · 1 an assertion failed
'use strict';

const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const assert = require('assert');

const ROOT      = path.join(__dirname, '..');
const RETAIL_JS = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failures++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
function section(t) { console.log('\n' + t); }

// Read a brace-balanced block out of the shipped route file, anchored so a
// rename fails loudly rather than passing against nothing.
function balanced(from, label) {
  const at = RETAIL_JS.indexOf(from);
  assert.notStrictEqual(at, -1, `${label} is not in routes/retail.js`);
  let i = RETAIL_JS.indexOf('{', at), depth = 0;
  for (; i < RETAIL_JS.length; i++) {
    if (RETAIL_JS[i] === '{') depth++;
    else if (RETAIL_JS[i] === '}') { depth--; if (!depth) break; }
  }
  return { at, src: RETAIL_JS.slice(at, i + 1), openAt: RETAIL_JS.indexOf('{', at), closeAt: i };
}

const BLOCKS_OF_TYPE = balanced('function* blocksOfType(', 'blocksOfType').src;
const HANDLER = (() => {
  const b = balanced(
    "router.get('/api/retail-admin/products/storage-usage', requireRetailAdmin, (req, res) => {",
    'the storage-usage route');
  // The handler body only — the arrow function's braces, not the router call's.
  const open = RETAIL_JS.indexOf('{', RETAIL_JS.indexOf('(req, res) =>', b.at));
  let i = open, depth = 0;
  for (; i < RETAIL_JS.length; i++) {
    if (RETAIL_JS[i] === '{') depth++;
    else if (RETAIL_JS[i] === '}') { depth--; if (!depth) break; }
  }
  return RETAIL_JS.slice(open + 1, i);
})();

function countStorage(rows) {
  let out = null;
  const sandbox = {
    console,
    pairUsage: require(path.join(ROOT, 'lib', 'pair-usage.js')),
    tdb: () => ({ prepare: () => ({ all: () => rows }) }),
    res: { set() {}, json(v) { out = v; }, status() { return this; } },
    req: {},
    JSON, Map, Set, Array, String, Object,
  };
  vm.createContext(sandbox);
  vm.runInContext(BLOCKS_OF_TYPE + "\nconst storageBoxBlocks = (db) => blocksOfType(db, 'storage_box');",
                  sandbox, { filename: 'blocksOfType' });
  vm.runInContext(HANDLER, sandbox, { filename: 'storage-usage handler' });
  assert.ok(out, 'the handler answered nothing');
  return out;
}

// One product carrying one storage box.
const box = (left, right, noteEn, noteCn) => ({
  description_blocks: JSON.stringify([{
    type: 'storage_box', left, right,
    note_en: noteEn || '', note_cn: noteCn || '',
  }]),
});
const card = (icon, headEn, headCn, unitEn, unitCn) => ({
  icon, head_en: headEn, head_cn: headCn, unit_en: unitEn, unit_cn: unitCn,
});
const many = (n, row) => Array.from({ length: n }, () => row);

const VS16 = '️';

// ═══════════════════════════════════════════════════════════════════════════
section('1. The snowflake still collapses — the case this all exists for');
// ═══════════════════════════════════════════════════════════════════════════

check('the two spellings tally as ONE icon, not two', () => {
  const rows = [
    ...many(83, box(card('❄' + VS16, 'Refrigerate', '冷藏保存', '', ''), null)),
    ...many(5,  box(card('❄',        'Refrigerate', '冷藏保存', '', ''), null)),
  ];
  const out = countStorage(rows);
  const flakes = out.icons.left.filter(i => i.replace(VS16, '') === '❄');
  assert.strictEqual(flakes.length, 1,
    `the picker offers ${flakes.length} snowflakes — ${JSON.stringify(flakes)}. ` +
    'That is the drift §147 ended, re-entering through the list.');
});

check('and the offered spelling is the one the catalogue uses MOST', () => {
  const out = countStorage([
    ...many(83, box(card('❄' + VS16, 'Refrigerate', '冷藏保存', '', ''), null)),
    ...many(5,  box(card('❄',        'Refrigerate', '冷藏保存', '', ''), null)),
  ]);
  assert.strictEqual(out.icons.left[0], '❄' + VS16,
    'the bare form won — a picker offering the minority spelling CREATES a third');
});

check('the minority spelling wins when it is actually the majority', () => {
  /* Not a mirror of the check above for its own sake: it proves the rule is
     "most used", not a hard-coded preference for the selector. */
  const out = countStorage([
    ...many(9, box(card('🌡', 'Room Temperature', '常温保存', '', ''), null)),
    ...many(2, box(card('🌡' + VS16, 'Room Temperature', '常温保存', '', ''), null)),
  ]);
  assert.strictEqual(out.icons.left[0], '🌡');
});

// ═══════════════════════════════════════════════════════════════════════════
section('2. Roots\' measured lists come back when counted');
// ═══════════════════════════════════════════════════════════════════════════

check('the heads, units and notes reproduce from Roots-shaped rows', () => {
  // §147's own measurements, in miniature.
  const rows = [
    ...many(52, box(card('❄' + VS16, 'Refrigerate', '冷藏保存', '°C at all times', '°C 全程冷藏'),
                    card('📅', 'Shelf Life', '保质期', 'See packaging', '见包装标示'),
                    'Reseal tightly after opening.', '开封后请密封保存。')),
    ...many(41, box(card('🫙', 'Cool & Dry', '阴凉干燥', 'Away from direct sunlight', '避免阳光直射'),
                    card('🔒', 'After Opening', '开封后', 'days in the fridge', '天内（冷藏）'),
                    'Shelf life: see packaging.', '保质期：见包装标示。')),
  ];
  const out = countStorage(rows);
  assert.strictEqual(out.heads.left[0].en, 'Refrigerate');
  assert.strictEqual(out.heads.left[0].cn, '冷藏保存');
  assert.strictEqual(out.heads.right[0].en, 'Shelf Life');
  assert.strictEqual(out.units.left[0].en, '°C at all times');
  assert.strictEqual(out.units.right[0].cn, '见包装标示');
  assert.strictEqual(out.notes[0].en, 'Reseal tightly after opening.');
  assert.strictEqual(out.notes[0].n, 52);
});

check('a losing twin is folded in, not offered beside its winner', () => {
  /* `Cool & Dry` 55 and `Cool & dry` — one answer typed two ways. §147 recorded
     the loser rather than offering it; the count has to do the same or the
     split it ended resumes. */
  const out = countStorage([
    ...many(55, box(card('🫙', 'Cool & Dry', '阴凉干燥', '', ''), null)),
    ...many(9,  box(card('🫙', 'Cool & dry', '阴凉干燥', '', ''), null)),
  ]);
  assert.strictEqual(out.heads.left.length, 1, 'both spellings are offered');
  assert.strictEqual(out.heads.left[0].en, 'Cool & Dry');
  assert.strictEqual(out.heads.left[0].n, 64, 'the twin was not counted toward the winner');
});

// ═══════════════════════════════════════════════════════════════════════════
section('3. Each side answers its own question');
// ═══════════════════════════════════════════════════════════════════════════

check('a left answer is never offered on the right', () => {
  /* `Refrigerate` is a LEFT head and `Shelf Life` is a RIGHT one. Offering
     either on the wrong card is offering an answer to a question nobody asked. */
  const out = countStorage(many(4, box(
    card('❄' + VS16, 'Refrigerate', '冷藏保存', '', ''),
    card('📅', 'Shelf Life', '保质期', '', ''))));
  assert.deepStrictEqual(out.heads.left.map(h => h.en), ['Refrigerate']);
  assert.deepStrictEqual(out.heads.right.map(h => h.en), ['Shelf Life']);
  assert.deepStrictEqual(out.icons.left, ['❄' + VS16]);
  assert.deepStrictEqual(out.icons.right, ['📅']);
});

check('a shop with no history is offered nothing at all', () => {
  const out = countStorage([]);
  for (const side of ['left', 'right']) {
    assert.strictEqual(out.icons[side].length, 0);
    assert.strictEqual(out.heads[side].length, 0);
    assert.strictEqual(out.units[side].length, 0);
  }
  assert.strictEqual(out.notes.length, 0);
  assert.ok(!JSON.stringify(out).includes('冷藏'),
    'a brand-new tenant was handed a vocabulary it never typed');
});

// ═══════════════════════════════════════════════════════════════════════════
section('4. The rules the spec strip already lives by');
// ═══════════════════════════════════════════════════════════════════════════

check('half a pair is not an answer', () => {
  const out = countStorage([
    ...many(6, box(card('❄', 'Refrigerate', '', '', ''), null)),          // no Chinese
    ...many(3, box(card('❄', 'Keep Frozen', '冷冻保存', '', ''), null)),
  ]);
  assert.deepStrictEqual(out.heads.left.map(h => h.en), ['Keep Frozen'],
    'a head with no Chinese reached the list — a pick that fills one language');
  // The ICON on those six rows is still a perfectly good icon, and is counted:
  // rule 1 is about pairs, and an emoji has no second half to be missing.
  assert.strictEqual(out.icons.left.length, 1);
});

check('an answer used once is not a list', () => {
  const out = countStorage([
    box(card('❄', 'Refrigerate', '冷藏保存', '', '')),
    box(card('🧊', 'Keep Frozen', '冷冻保存', '', '')),
    box(card('🫙', 'Cool & Dry', '阴凉干燥', '', '')),
  ]);
  assert.strictEqual(out.heads.left.length, 0,
    'three one-off answers became a dropdown — that is the list §145 refused');
  assert.strictEqual(out.icons.left.length, 0, 'three one-off icons became a chip row');
});

check('a missing card does not break the count', () => {
  /* A storage box may carry only one side, and the column is operator JSON —
     null, a string and a missing key all have to be survivable, because a throw
     here empties every list on the page. */
  const out = countStorage([
    box(card('❄', 'Refrigerate', '冷藏保存', '', ''), null),
    box(null, card('📅', 'Shelf Life', '保质期', '', '')),
    { description_blocks: JSON.stringify([{ type: 'storage_box' }]) },
    { description_blocks: JSON.stringify([{ type: 'storage_box', left: 'nonsense' }]) },
    { description_blocks: 'not json at all' },
    { description_blocks: JSON.stringify([{ type: 'spec_strip', cells: [] }]) },
    box(card('❄', 'Refrigerate', '冷藏保存', '', ''), null),
  ]);
  assert.strictEqual(out.heads.left.length, 1);
  assert.strictEqual(out.heads.left[0].en, 'Refrigerate');
});

console.log(failures ? `\n${failures} check(s) failed.` : `\nAll checks passed.`);
process.exit(failures ? 1 : 0);
