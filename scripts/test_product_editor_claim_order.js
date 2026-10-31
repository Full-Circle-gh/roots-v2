// A claim in "Why people choose it" can be dragged to a new place.
//
// The order on the customer's page IS the order of block.rows. This file runs
// the function that decides where a dropped claim lands, lifted out of the
// page, so a change to the arithmetic is caught here rather than on a product
// a customer is reading. The fast shard has no browser; the drag gesture
// itself is checked by hand in the editor.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public/product-editor.html'), 'utf8');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '\n      ' + e : '')); };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { bad(m, e.message); } };

function fnBody(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(SRC);
  if (!m) return '';
  let i = m.index + m[0].length, depth = 1;
  for (; i < SRC.length && depth > 0; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') depth--;
  }
  return SRC.slice(m.index, i);
}
function load(name) {
  const src = fnBody(name);
  assert.ok(src, name + '() not found');
  return new Function(src + '\nreturn ' + name + ';')();
}

const paMoveWithin = load('paMoveWithin');
const claim = (en) => ({ claim_en: en, claim_cn: en });
const words = (rows) => rows.map(r => r.claim_en).join(',');

check('dropping a claim on the lower half of another puts it below that one', () => {
  const rows = [claim('A'), claim('B'), claim('C'), claim('D')];
  const next = paMoveWithin(rows, 0, 2, true);
  assert.strictEqual(words(next), 'B,C,A,D');
  assert.strictEqual(words(rows), 'A,B,C,D', 'the source list was mutated');
});

check('dropping a claim on the upper half of the first puts it first', () => {
  const rows = [claim('A'), claim('B'), claim('C'), claim('D')];
  assert.strictEqual(words(paMoveWithin(rows, 3, 0, false)), 'D,A,B,C');
});

check('a drop that would not change the order returns the same list', () => {
  const rows = [claim('A'), claim('B'), claim('C')];
  assert.strictEqual(paMoveWithin(rows, 0, 1, false), rows, 'already sitting just above the target');
  assert.strictEqual(paMoveWithin(rows, 1, 2, false), rows, 'already sitting just above the next');
  assert.strictEqual(paMoveWithin(rows, 1, 1, true), rows, 'dropped on itself');
  assert.strictEqual(paMoveWithin(rows, -1, 0, false), rows);
  assert.strictEqual(paMoveWithin(rows, 0, 9, true), rows);
  assert.strictEqual(paMoveWithin(null, 0, 1, true), null);
});

check('indexes arriving as strings from data-rowidx still move the right claim', () => {
  const rows = [claim('A'), claim('B'), claim('C')];
  assert.strictEqual(words(paMoveWithin(rows, '2', '0', false)), 'C,A,B');
});

check('the claim keeps the words that were typed into it', () => {
  const rows = [claim('Sweet'), claim('No dairy'), claim('Protein')];
  const next = paMoveWithin(rows, 2, 0, false);
  assert.strictEqual(next[0].claim_en, 'Protein');
  assert.strictEqual(next[0].claim_cn, 'Protein');
});

check('the editor syncs the open fields before it moves anything', () => {
  const src = fnBody('paClaimReorder');
  assert.ok(src, 'paClaimReorder() not found');
  const syncAt = src.indexOf('paBlocksSyncFromDOM');
  const moveAt = src.indexOf('paMoveWithin');
  assert.ok(syncAt >= 0 && moveAt > syncAt, 'a move that skips the sync would drop whatever was just typed');
  assert.ok(/b\.type !== 'why'/.test(src), 'a claim drag must not reorder some other block\'s rows');
  assert.ok(/paRenderAll\(/.test(src), 'the phone preview would keep the old order');
});

check('each claim is a drag handle, and the grip uses the live reorder wording', () => {
  const body = fnBody('_paBlockEditorBody');
  const why = body.slice(body.indexOf("b.type === 'why'"), body.indexOf("b.type === 'ingredients_chips'"));
  assert.ok(/class="pa-claim"/.test(why), 'the claim card is not marked as a drag row');
  assert.ok(/class="pa-claim" draggable="true"/.test(why), 'the card cannot be picked up');
  assert.ok(/class="pa-claim-grip" draggable="true"/.test(why), 'the grip is not the drag source');
  assert.ok(/data-claim-block=/.test(why), 'a drop cannot tell which section the claim belongs to');
  assert.ok(/data-rowidx="\$\{i\}"/.test(why), 'the card lost its index');
  assert.ok(/Drag to reorder · 拖动排序/.test(why), 'the grip title is a new string — reuse the live pair');
  assert.ok(/paInitClaimDnd\(\)/.test(SRC), 'the drag listeners are never wired');
});

console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
