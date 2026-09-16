// The QR-menu switch, and the one rule that makes it safe.
//
// THE DEFECT THIS EXISTS TO STOP, because it shipped and it wrote to live data.
//
// public/product-editor.html syncs its inspector into the block model with one
// generic mechanism, paBlocksSyncFromDOM(), whose whole contract is:
//
//     b[el.dataset.bkey] = (el.type === 'checkbox' ? el.checked : el.value)
//
// "The field equals the input." The QR switch is INVERTED — it is ticked when
// the block SHOWS, and the stored flag says HIDDEN — so wiring it into that
// mechanism made it write hide_qr = true for a visible block. The flip was
// handled correctly in the change handler and then clobbered a moment later,
// because that sync runs on every selection, on every live preview, on the
// unsaved-changes fingerprint (so: on load, with no click at all), and inside
// paBlocksCollect() — which is how it reached the database.
//
// Ash reported the surface of it exactly: *"i cant really click hide/unhide the
// same block, i have to click on one block to hide and another block to
// unhide"* — selecting block B re-synced the form still showing block A.
//
// THE RULE: AN INVERTED CONTROL CANNOT CARRY data-bkey. Not "must also be
// inverted in the sync" — the sync is a general mechanism and teaching it about
// one field's polarity would put the trap back for the next inverted control.
// It stays out, and one function owns the write.
//
// WHY THIS IS A SOURCE TEST AND NOT A BROWSER ONE. Driving Chromium proves more,
// and a Chromium suite belongs in the slow shard — which is not run, here or in
// CI, by standing instruction. A suite that never runs protects nothing, so the
// invariant is asserted where it can be checked in the gate. The browser pass
// was run by hand against this change and against the shipped code before it;
// the harness is not committed because it stubs the admin API.
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

// The body of a top-level `function name(...) { ... }`, brace-matched.
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return null;
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(open + 1, k);
  }
  return null;
}

section('The inverted control stays out of the generic sync');
check('the generic sync still is what this rule is about', () => {
  /* §144 split the sweep in two: paBlocksSyncFromDOM walks the sections and
     _paSyncOneSection does the copying. The rule is about the COPYING, so this
     follows it there rather than relaxing. */
  const body = fnBody(SRC, '_paSyncOneSection');
  assert.ok(body, '_paSyncOneSection is gone — re-read this file before trusting it');
  assert.ok(/\[data-bkey\]/.test(body), 'the sync no longer keys on data-bkey');
  assert.ok(/el\.checked/.test(body),
    'the sync no longer copies a checkbox verbatim — if it now inverts, this whole file needs rewriting, not relaxing');
});
check('THE QR SWITCH CARRIES NO data-bkey', () => {
  assert.ok(!/data-bkey=["']hide_qr["']/.test(SRC),
    'hide_qr is wired into paBlocksSyncFromDOM again. It is INVERTED — ticked means SHOWN — ' +
    'so the sync will write hide_qr=true for a visible block, on load, before anyone clicks.');
});
check('...and no OTHER control smuggles an inverted meaning in there', () => {
  /* The trap generalises: any data-bkey whose CHECKED STATE IS NOT THE FIELD'S
     VALUE hits it. Two checkboxes ride the generic sync and both are honest:
       lead — the hero ingredient chip; ticked means lead.
       alt  — the storage card's inverted style; ticked means alt. Its LABEL
              reads "Inverted", which is about how the card is PAINTED, not
              about the control's polarity. Worth saying, because a word like
              that sitting beside a checkbox in this exact list is the kind of
              thing a later reader trips over.
     A NEW name here is worth a human look, not an auto-pass: ask whether
     ticked means the field is true, and if it does not, keep it out. */
  const boxes = [...SRC.matchAll(/data-bkey="([a-z_]+)"[^>]*type="checkbox"/g)].map(m => m[1]);
  assert.deepStrictEqual([...new Set(boxes)].sort(), ['alt', 'lead'],
    'a new checkbox joined the generic sync: ' + boxes.join(', ') +
    ' — check it is not inverted before adding it here');
});

section('One writer owns the flag');
check('every write to hide_qr happens inside paSetHideQr', () => {
  const owner = fnBody(SRC, 'paSetHideQr');
  assert.ok(owner, 'paSetHideQr is gone — the flag has no single owner any more');
  assert.ok(/hide_qr\s*=\s*true/.test(owner) && /delete\s+b\.hide_qr/.test(owner),
    'paSetHideQr no longer sets and clears the flag');
  // Count writes across the whole file; only the owner's may remain. The
  // normaliser in paBlocksCollect is a delete-when-falsy, not a write, and is
  // named explicitly rather than matched loosely.
  const writes = [...SRC.matchAll(/\b[a-z]+\.hide_qr\s*=\s*(?!=)/g)].length;
  const inOwner = [...owner.matchAll(/\b[a-z]+\.hide_qr\s*=\s*(?!=)/g)].length;
  const normaliser = /if \(!b\.hide_qr\) delete b\.hide_qr; else b\.hide_qr = true;/.test(SRC) ? 1 : 0;
  assert.strictEqual(writes - inOwner - normaliser, 0,
    `${writes - inOwner - normaliser} write(s) to hide_qr sit outside paSetHideQr — ` +
    'two opinions about one flag is how the first bug happened');
});
check('it syncs the form BEFORE it mutates, like its siblings', () => {
  const owner = fnBody(SRC, 'paSetHideQr');
  assert.ok(/paBlocksSyncFromDOM\(\)/.test(owner),
    'paSetHideQr mutates without syncing first, so a half-typed field is dropped when the eye is clicked');
});

section('The eye on the row can actually be used');
check('IT IS RENDERED ON EVERY ROW, not only on hidden ones', () => {
  /* The first version drew the eye only when a block was already hidden, which
     is a mark you cannot click to hide with — Ash went to use it and there was
     nothing there. The row markup must emit the button unconditionally and vary
     only its state. */
  /* §144 moved the row into the section head; the rule did not move. */
  const head = fnBody(SRC, '_paSecHead');
  assert.ok(head, '_paSecHead is gone');
  assert.ok(/<button[^>]*class="pa-sec-eye/.test(head),
    'the section head no longer renders the QR eye');
  assert.ok(!/\$\{b\.hide_qr \? `<(?:button|div)[^>]*pa-sec-eye/.test(head),
    'the eye is drawn only when the block is already hidden — it cannot be used to hide one');
});
check('clicking it does not also open the block', () => {
  const row = fnBody(SRC, 'paRowHideQr');
  assert.ok(row, 'paRowHideQr is gone');
  assert.ok(/stopPropagation\(\)/.test(row),
    'the eye lets its click reach the row, which selects the block — the office asked to hide one, not open it');
  assert.ok(/paSetHideQr\(/.test(row), 'the eye does not go through the single writer');
});
check('and the two controls cannot disagree, on the section they belong to', () => {
  /* The head's eye and the fold's checkbox now sit in the SAME section, and
     nine sections are on screen at once — so the write-back must be scoped to
     the section it changed. A global querySelector here would re-tick whichever
     section rendered first, which is the §142 failure with a new address. */
  const owner = fnBody(SRC, 'paSetHideQr');
  assert.ok(/checked\s*=/.test(owner),
    "clicking the eye leaves that section's own switch saying the opposite");
  assert.ok(/\.pa-sec\[data-blockid=/.test(owner),
    'the write-back is not scoped to a section — with nine on screen it will hit the wrong one');
  assert.ok(!/document\.querySelector\(['"`]#pa-block-editor-mount/.test(owner),
    'still reaching for the retired single-block inspector');
});
check('and so is the checkbox handler that writes it', () => {
  const flip = fnBody(SRC, 'paChannelFlip');
  assert.ok(flip, 'paChannelFlip is gone');
  assert.ok(/closest\(['"`]\[data-blockid\]['"`]\)/.test(flip),
    'paChannelFlip does not resolve the section it sits inside — it will flip the wrong block');
});

section('The flag still means what the QR menu reads');
check('an absent flag is still "shows" — nothing is written by default', () => {
  const collect = fnBody(SRC, 'paBlocksCollect');
  assert.ok(collect, 'paBlocksCollect is gone');
  assert.ok(/if \(!b\.hide_qr\) delete b\.hide_qr;/.test(collect),
    'a falsy hide_qr is persisted instead of deleted — every product would carry a field nobody set');
});

console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
