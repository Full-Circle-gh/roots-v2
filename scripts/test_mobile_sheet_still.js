#!/usr/bin/env node
/**
 * A popup that is already open does not slide up again when the phone repaints.
 *
 *   node scripts/test_mobile_sheet_still.js
 *
 * READS ONE FILE. No browser, so it runs in the FAST shard and is part of the
 * gate — the slow shard is not run (CLAUDE.md, "Tests").
 *
 * THE BUG. render() rewrites the whole app with innerHTML, so every open sheet
 * is rebuilt on every paint and replays `animation:tSheetUp`. Seven sheets had
 * their own guard; eleven, the Menu among them, flickered on every tap inside
 * them and on every background poll. The fix is one guard in render(): each
 * layer goes through layer(key, html), and a layer the last paint also drew
 * gets class `stay`, which switches its entrance off.
 *
 * WHAT THIS HOLDS. (1) keepStill() tags the layer elements and nothing else;
 * (2) no layer in render() bypasses layer(), which is how a new sheet would be
 * born flickering again; (3) every layer has an element keepStill() can find;
 * (4) the .stay rule exists. And layer()'s bookkeeping is run for real over
 * three paints: open, repaint, close-and-reopen.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MHTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'm.html'), 'utf8');

let n = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); n++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

/* The body of a top-level `function name(){…}`, found by brace depth. Template
   literals in m.html hold braces in balanced pairs, which is all this needs. */
function fnSource(name) {
  const at = MHTML.indexOf(`\nfunction ${name}(`);
  assert(at >= 0, `function ${name} not found in m.html`);
  const open = MHTML.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < MHTML.length; i++) {
    if (MHTML[i] === '{') depth++;
    else if (MHTML[i] === '}' && --depth === 0) return MHTML.slice(at + 1, i + 1);
  }
  throw new Error(`function ${name} never closes`);
}

const keepStill = new Function(`${fnSource('keepStill')}; return keepStill;`)();
const RENDER = fnSource('render');

console.log('\n1 · keepStill tags the layers and nothing inside them');

it('tags a sheet and its scrim', () => {
  const out = keepStill('<div class="scrim" style="z-index:40"></div><div class="sheet" style="top:0">x</div>');
  assert.strictEqual(out, '<div class="scrim stay" style="z-index:40"></div><div class="sheet stay" style="top:0">x</div>');
});
it('tags a class list that starts with the layer class', () => {
  assert.strictEqual(keepStill('<div class="scrim fabscrim">'), '<div class="scrim stay fabscrim">');
});
it('tags the overlay, the dial rows and the toast', () => {
  assert.strictEqual(keepStill('<div class="overlay">'), '<div class="overlay stay">');
  assert.strictEqual(keepStill('<button class="dialrow">'), '<button class="dialrow stay">');
  assert.strictEqual(keepStill('<div class="toast">'), '<div class="toast stay">');
});
it('leaves look-alikes and inner content alone — a spinner inside keeps spinning', () => {
  const inner = '<div class="sheet-head"></div><div class="sheets"></div><span class="spin"></span><div class="row sheet"></div>';
  assert.strictEqual(keepStill(inner), inner);
});

console.log('\n2 · every layer in render() goes through layer()');

it('no sheet is appended to the paint without layer()', () => {
  const bare = RENDER.split('\n').filter((l) => /html\s*\+=/.test(l) && !/layer\(/.test(l));
  assert.deepStrictEqual(bare, [], `appended without layer():\n${bare.join('\n')}`);
});
it('the open dial goes through layer()', () => {
  assert(/state\.quickFab\s*\?\s*layer\('dial',\s*fabHtml\(\)\)/.test(RENDER), 'fabHtml() is not wrapped');
});
it('the paint records what it drew, and the boot hold forgets it', () => {
  assert(/app\.innerHTML = html;\s*\n\s*_layersUp=_now;/.test(RENDER), '_layersUp=_now does not follow the paint');
  assert(/bootHold\(\);\s*\n\s*_layersUp=\{\};/.test(RENDER), 'the boot hold does not clear _layersUp');
});

console.log('\n3 · every layer has something keepStill can find');

const layerFns = [...new Set([...RENDER.matchAll(/layer\('[^']*'[^,]*,\s*(\w+)\(\)\)/g)].map((m) => m[1]))];
it('found the layers (the scan itself can go red)', () => {
  assert(layerFns.length >= 15, `only ${layerFns.length} layer functions found: ${layerFns.join(', ')}`);
  assert(layerFns.includes('sheetOverflow'), 'the Menu sheet is not among them');
});
for (const f of layerFns) {
  it(`${f} carries a scrim, sheet, overlay or dial row`, () => {
    assert(/class="(scrim|sheet|overlay|dialrow)[ "]/.test(fnSource(f)), `${f} has no taggable layer element`);
  });
}

console.log('\n4 · the rule, and the bookkeeping run for real');

it('.stay switches the entrance off', () => {
  assert(/\.stay\{animation:none!important\}/.test(MHTML), '.stay rule missing');
});
it('open slides, repaint holds still, close then reopen slides again', () => {
  const src = RENDER.match(/const layer=\(key,out\)=>\{[^\n]*\};/);
  assert(src, 'layer() not found in render()');
  let _layersUp = {};
  const paint = (open) => {
    const _was = _layersUp, _now = {};
    const layer = eval(`(()=>{ ${src[0]} return layer; })()`);
    const html = open ? layer('overflow', '<div class="sheet">') : '';
    _layersUp = _now;
    void _was;
    return html;
  };
  assert.strictEqual(paint(true), '<div class="sheet">', 'first open lost its entrance');
  assert.strictEqual(paint(true), '<div class="sheet stay">', 'repaint replayed the entrance');
  assert.strictEqual(paint(false), '');
  assert.strictEqual(paint(true), '<div class="sheet">', 'reopen lost its entrance');
});

console.log(`\n${n} passed${process.exitCode ? ' — FAILURES above' : ''}`);
