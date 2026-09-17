// Opening the Product editor must show the product as it is NOW.
//
// THE DEFECT THIS EXISTS TO STOP. Reported by Ash, 2026-09-17: duplicate a
// product, change everything about the copy, press "Auto-fill from text", then
// press "Product editor" — and the editor comes up holding the ORIGINAL
// product's words, after a browser popup saying the page might not be saved.
//
// Three separate faults stacked into that one symptom, and each is asserted
// below because each alone reproduces it.
//
//   1. pdOpenPageDesign() did not flush the pending autosave. The editor
//      re-fetches the product from the server with cache:'no-store', so
//      anything still inside the 800ms debounce is simply not in the row it
//      reads. "Auto-fill from text" ends on pdScheduleAutosave(), so pressing
//      straight through to the editor landed inside that window every time.
//      Every other navigation out of that form — pdOpen(), pdRecipeLinkOpen() —
//      already flushed; this was the one that did not.
//
//   2. openProductEditor() re-pointed the editor's IFRAME src with no word to
//      the editor. That is a navigation, so the editor's own beforeunload guard
//      fired and the browser asked its generic "changes you made may not be
//      saved" — and Cancel there ABORTS the navigation, leaving the PREVIOUS
//      product on screen with nothing said. That is the popup in the report,
//      and it is also why the editor appeared to ignore the edits.
//
//   3. pdMarkDesignStale() gated the "Designed page is out of date" nudge on
//      use_block_design. That flag only decides which of the two descriptions
//      the SHOPFRONT draws; the blocks exist either way and the Product editor
//      shows them either way. A duplicate whose source had Design: Off arrived
//      carrying another product's sections with nothing on screen saying so.
//
// WHY THIS IS A SOURCE TEST AND NOT A BROWSER ONE. Same reason as
// test_product_editor_hide_qr.js: driving Chromium proves more, and a Chromium
// suite belongs in the slow shard — which is not run, here or in CI, by
// standing instruction. A suite that never runs protects nothing, so the
// invariant is asserted where the gate can check it.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PRODUCTS = fs.readFileSync(path.join(REPO, 'public/retail-admin/09-products.js'), 'utf8');
const CORE = fs.readFileSync(path.join(REPO, 'public/retail-admin/01-core.js'), 'utf8');

// Pull one function's body out, brace-balanced. A regex cannot do this: the
// first `}` inside the body would end the match, and the orderings that matter
// are exactly the ones that span the whole body.
function bodyOf(src, name) {
  const at = src.search(new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\('));
  assert.notStrictEqual(at, -1, `function ${name}() not found — did it get renamed?`);
  const open = src.indexOf('{', src.indexOf(')', at));
  assert.notStrictEqual(open, -1, `no body found for ${name}()`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  assert.fail(`unbalanced body for ${name}()`);
}

// ── 1. pdOpenPageDesign flushes the pending autosave BEFORE the editor reads ──
{
  const body = bodyOf(PRODUCTS, 'pdOpenPageDesign');
  const flush = body.indexOf('pdAutoSaveNow');
  const open = body.indexOf('openProductEditor(');
  assert.notStrictEqual(flush, -1,
    'pdOpenPageDesign() must flush the pending autosave (pdAutoSaveNow) — without it the editor reads the pre-edit row');
  assert.notStrictEqual(open, -1, 'pdOpenPageDesign() no longer calls openProductEditor()');
  assert.ok(flush < open,
    'the autosave flush must come BEFORE openProductEditor() — after it, the editor has already fetched');
  assert.ok(/_pdAutoTimer/.test(body),
    'the flush must clear _pdAutoTimer, or the debounce fires a second save over the editor');
  assert.ok(/async\s+function\s+pdOpenPageDesign/.test(PRODUCTS),
    'pdOpenPageDesign() must be async — the flush is awaited');
}

// ── 2. openProductEditor asks its own question and hands the exit over ──
{
  const body = bodyOf(CORE, 'openProductEditor');
  const dirty = body.indexOf('peIsDirty');
  const leave = body.indexOf('peLeaveIntentionally');
  const src = body.indexOf('frame.src');
  assert.notStrictEqual(dirty, -1,
    'openProductEditor() must ask the editor whether it is dirty (peIsDirty) before taking it away');
  assert.notStrictEqual(leave, -1,
    'openProductEditor() must call peLeaveIntentionally() — otherwise the browser asks its own generic question, and Cancel silently aborts the open');
  assert.notStrictEqual(src, -1, 'openProductEditor() no longer sets frame.src');
  assert.ok(dirty < src, 'the dirty check must come BEFORE frame.src is re-pointed');
  assert.ok(leave < src, 'peLeaveIntentionally() must be called BEFORE frame.src is re-pointed');
  assert.ok(/async\s+function\s+openProductEditor/.test(CORE),
    'openProductEditor() must be async — the confirm is awaited');
  // The question is the editor's own two strings, reused rather than composed.
  assert.ok(body.includes('有未保存的更改将会丢失,仍要离开吗?'),
    "the unsaved-changes question must reuse the editor's live pair, not a newly composed one");
}

// ── 3. The stale-design nudge is gated on the blocks existing, not on the flag ──
{
  const body = bodyOf(PRODUCTS, 'pdMarkDesignStale');
  assert.ok(/_pdDesignExists/.test(body),
    'pdMarkDesignStale() must gate on whether designer sections EXIST (_pdDesignExists)');
  assert.ok(!/_pdUseBlockDesign/.test(body),
    'pdMarkDesignStale() must not gate on use_block_design — that flag only decides what the SHOPFRONT draws; the Product editor shows the blocks either way');
  // _pdDesignExists is only true if something keeps it in step with the product
  // on screen; the open path is where that has to happen.
  assert.ok(/_pdDesignExists\s*=\s*_paHasBlocks\(p\)/.test(PRODUCTS),
    'pdOpen() must set _pdDesignExists from _paHasBlocks(p), or the nudge answers about the previous product');
}

// ── 4. Rebuild refreshes the sections without switching the shopfront over ──
//
// Falls out of (3): once the nudge stops gating on use_block_design, its
// Rebuild button is reachable on a product showing its CLASSIC description.
// pdAutoComposeBlocks() hardcoded use_block_design:1, so pressing it there
// would have quietly moved shoppers onto the designed page — a change to what
// the shop shows, from a button that only offered to refresh some words.
{
  const rebuild = bodyOf(PRODUCTS, 'pdRebuildDesign');
  assert.ok(/pdAutoComposeBlocks\(/.test(rebuild), 'pdRebuildDesign() no longer calls pdAutoComposeBlocks()');
  // Matched to the end of the statement rather than to the first ')', because
  // the btn argument is itself a call and a lazy match stops inside it.
  assert.ok(/pdAutoComposeBlocks\([^;]*,\s*true\s*,\s*true\s*\)\s*;/.test(rebuild),
    'pdRebuildDesign() must pass keepFlag (the 4th argument) as true, so a rebuild leaves use_block_design alone');

  const compose = bodyOf(PRODUCTS, 'pdAutoComposeBlocks');
  assert.ok(/async\s+function\s+pdAutoComposeBlocks\s*\([^)]*keepFlag/.test(PRODUCTS),
    'pdAutoComposeBlocks() must take a keepFlag argument');
  assert.ok(!/use_block_design:\s*1\s*\}/.test(compose),
    'pdAutoComposeBlocks() must not hardcode use_block_design:1 in the PATCH body — that is the operator\'s switch, not the builder\'s');
  assert.ok(/keepFlag\s*\?\s*\(_pdUseBlockDesign/.test(compose),
    'with keepFlag set, pdAutoComposeBlocks() must carry the live use_block_design through rather than forcing it on');
  // The two callers that DO mean "turn it on" must keep meaning it.
  const toggle = bodyOf(PRODUCTS, 'pdToggleBlockDesign');
  assert.ok(/pdAutoComposeBlocks\(id,\s*btn\)/.test(toggle),
    'the Design switch must still call pdAutoComposeBlocks() without keepFlag — turning it on is the whole point there');
}

console.log('ok — Product editor opens on the current product (autosave flushed, exit handed over, stale design declared)');
