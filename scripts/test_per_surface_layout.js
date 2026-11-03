/* §514 — every shape pick wears a phone twin.
 *
 * A shape field (view / layout / card_layout) may carry a <field>_phone
 * twin. Phone surfaces (the site and shop below 768px, the mini app, the
 * editor's phone DOM and phone drawer) read the twin first; computer
 * surfaces read the base. The inspector offers the twin as a second
 * dropdown whose first option, "Same as computer", is the unset state.
 *
 * Fast shard: everything here is sliced out of the pages and RUN in a
 * sandbox, or asserted as source shape. No browser.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
// Assertions match on \n. A Windows checkout (core.autocrlf) hands some of
// these pages over as CRLF, which failed regexes that never meant to ask
// about line endings.
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const CMS = read('public/cms.html');
const BLOCKS = read('public/shop/blocks.js');
const MINI = read('miniapp/components/block-renderer/block-renderer.js');
const STORE = read('public/storefront.html');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

const slice = (src, from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, 'slice bounds not found: ' + from);
  return src.slice(a, b);
};
const count = (src, re) => (src.match(re) || []).length;

// ─────────────────────────────────────────────────────────────────────────
section('1 · the inspector offers the twin on every shape pick');

yes(/function phoneShapeTwin\(b, key, host, optsOverride\) \{/.test(CMS), 'the twin builder exists');
yes(/function shapePhone\(b, key, def\) \{/.test(CMS), '…and the phone-side reader exists');
yes(count(CMS, /phoneShapeTwin\(b, '(view|layout|card_layout)'/g) >= 14,
  'every shape pick in the inspector wears one (13 selects + the hero seg)',
  'found ' + count(CMS, /phoneShapeTwin\(b, '(view|layout|card_layout)'/g));
yes(/updateBlock\(b\.id, \{ \[key \+ '_phone'\]: v === '' \? undefined : v \}\)/.test(CMS),
  'the twin writes <field>_phone, and "Same as computer" clears it back to undefined');
yes(/\{ value: '', label: T\('Same as computer', '与电脑相同'\) \}/.test(CMS),
  'the unset state is the first option, labelled in both languages');
yes(/Array\.from\(base\.options\)\.map\(o => \(\{ value: o\.value, label: o\.textContent \}\)\)/.test(CMS),
  'the twin\'s choices are read off the base control, so the two cannot drift');
yes(/layoutWrap\.appendChild\(phoneShapeTwin\(b, 'view', layoutWrap, \[/.test(CMS),
  'the hero\'s segmented control passes its choices outright (it has no visible select)');

// ─────────────────────────────────────────────────────────────────────────
section('2 · each surface reads the width it is');

const phoneDom = slice(CMS, 'function renderPreview() {', 'function field(label');
yes(!/b\.view \|\| '/.test(phoneDom) && !/b\.layout \|\| 'a'/.test(phoneDom),
  'the editor\'s phone DOM reads no bare shape value any more');
yes(count(phoneDom, /shapePhone\(b, '(view|layout|card_layout)'/g) >= 12,
  '…it reads the twin first, on every shape',
  'found ' + count(phoneDom, /shapePhone\(b, '(view|layout|card_layout)'/g));
yes(!/b\.view \|\| '|b\.layout \|\| 'a'|b\.card_layout ===/.test(BLOCKS),
  'the web engine (shop.html, site.html) reads no bare shape value either');
yes(count(BLOCKS, /shapeOn\(b, '(view|layout|card_layout)'/g) >= 14,
  '…it asks the viewport through shapeOn, on every shape',
  'found ' + count(BLOCKS, /shapeOn\(b, '(view|layout|card_layout)'/g));
yes(/window\.matchMedia\('\(max-width:767px\)'\)/.test(BLOCKS), 'the viewport is the site\'s own breakpoint');
yes(/var _cross = function \(\) \{ fireRerender\(\); \};/.test(BLOCKS),
  'crossing the breakpoint fires the hosts\' rerender, so a resized browser redraws');
yes(/ShopBlocks\.onRerender\(\(\)=>render\(\)\)/.test(read('public/site.html')) &&
    /ShopBlocks\.onRerender\(\(\)=>\{ if\(parseHash\(\)\.seg\.length===0\) renderHome\(\); \}\)/.test(read('public/shop.html')),
  'both hosts already register that rerender');
yes(count(MINI, /\(b\.view_phone \|\| b\.view\)|\(b\.layout_phone \|\| b\.layout\)|\(b\.card_layout_phone \|\| b\.card_layout\)/g) >= 14,
  'the mini app, a phone with no computer width, reads the twin unconditionally',
  'found ' + count(MINI, /\(b\.view_phone \|\| b\.view\)|\(b\.layout_phone \|\| b\.layout\)|\(b\.card_layout_phone \|\| b\.card_layout\)/g));
yes(!/b\.view \|\| '|b\.layout \|\| 'a'|b\.card_layout ===/.test(MINI), '…and no bare shape value survives there');
yes(count(STORE, /\(b\.view_phone \|\| b\.view\)|\(b\.card_layout_phone \|\| b\.card_layout\)/g) >= 6,
  'the editor\'s phone drawer, also a phone, reads the twin first',
  'found ' + count(STORE, /\(b\.view_phone \|\| b\.view\)|\(b\.card_layout_phone \|\| b\.card_layout\)/g));

// ─────────────────────────────────────────────────────────────────────────
section('3 · the readers, run');

const runShapeOn = (phone) => {
  const src = slice(BLOCKS, 'function shapeOn(b, key, def) {', '\n  }') + '\n  }';
  const sandbox = { window: { matchMedia: () => ({ matches: phone, addEventListener() {}, addListener() {} }) } };
  vm.createContext(sandbox);
  vm.runInContext('var _phoneMQ = window.matchMedia("(max-width:767px)");\n' + src + '\nthis.shapeOn = shapeOn;', sandbox);
  return sandbox.shapeOn;
};
const block = { view: 'grid', view_phone: 'scroll', layout: 'a' };
const onPhone = runShapeOn(true);
const onDesk = runShapeOn(false);
yes(onPhone(block, 'view', 'card') === 'scroll', 'on a phone the twin wins');
yes(onDesk(block, 'view', 'card') === 'grid', 'on a computer the base wins');
yes(onPhone(block, 'layout', 'c') === 'a', 'a field with no twin keeps one shape on both widths');
yes(onPhone({ view: 'list' }, 'view', 'grid') === 'list' && onDesk({ view: 'list' }, 'view', 'grid') === 'list',
  'a saved block with no override draws exactly as it did before, at both widths');
yes(onPhone({}, 'view', 'grid') === 'grid', 'a missing value still falls to the type\'s old default');

const phoneSrc = slice(CMS, 'function shapePhone(b, key, def) {', '\n}\n') + '\n}';
const pctx = {};
vm.createContext(pctx);
vm.runInContext(phoneSrc + '\nthis.shapePhone = shapePhone;', pctx);
yes(pctx.shapePhone(block, 'view', 'card') === 'scroll' && pctx.shapePhone({ view: 'grid' }, 'view', 'card') === 'grid',
  'the phone DOM\'s reader agrees: twin first, then base, then default');

// ─────────────────────────────────────────────────────────────────────────
section('4 · nothing else changed shape');

yes(/function showsOnWeb\(b\) \{ return !!b && b\.show_on !== 'miniapp'; \}/.test(BLOCKS), 'show_on still gates the surface, not the shape');
yes(/ALLOWED_BLOCK_TYPES/.test(read('routes/retail.js')), 'the server still whitelists block types, and fields pass through as before');

// ─────────────────────────────────────────────────────────────────────────
section('5 · the spacer\'s gap wears the twin too (§515)');

yes(/phoneNumTwin\(b, 'height_px', secLayout, \{ min: 0, max: 200 \}, null,/.test(CMS) &&
    /num\(b\.height_px, v => updateBlock\(b\.id, \{ height_px: v \}\), \{ min: 0, max: 200 \}\)/.test(CMS),
  'the spacer form carries an On phone height, and zero is allowed on both fields (§517)');
yes(/const raw = el\.value;\n    if \(raw === ''\) \{ updateBlock\(b\.id, \{ \[key \+ '_phone'\]: undefined \}\); return; \}/.test(CMS) &&
    /if \(opts && opts\.min != null && n < opts\.min\) n = opts\.min;/.test(CMS),
  'only a truly empty box clears the override — num()\'s 0-for-empty would eat a zero gap; the clamp still applies');
yes(/d\.style\.height = shapePhone\(b, 'height_px', 24\) \+ 'px';/.test(CMS), 'the editor\'s phone DOM reads the twin gap');
yes(/var h = shapeOn\(b, 'height_px', 24\);/.test(BLOCKS), 'the web engine reads the twin gap at the viewport\'s width');
yes(/style="height: \$\{b\.height_px_phone != null \? b\.height_px_phone : \(b\.height_px != null \? b\.height_px : 24\)}px"/.test(STORE), 'the phone drawer reads the twin gap, zero included');
yes(/out\.height = b\.height_px_phone != null \? b\.height_px_phone : \(b\.height_px != null \? b\.height_px : 24\);/.test(MINI), 'the mini app reads the twin gap, zero included');
yes(onPhone({ height_px: 40, height_px_phone: 12 }, 'height_px', 24) === 12 &&
    onDesk({ height_px: 40, height_px_phone: 12 }, 'height_px', 24) === 40 &&
    onPhone({ height_px: 40 }, 'height_px', 24) === 40 &&
    onPhone({ height_px: 50, height_px_phone: 0 }, 'height_px', 24) === 0,
  'a phone gap of its own when set — including no gap at all — and one shared gap while unset');

// ─────────────────────────────────────────────────────────────────────────
section('6 · every block, and every block to come (§516)');

// The frozen table of layout/spacing/size keys. A block control whose key is
// here MUST wear a phone twin in the same form function; adding a layout-ish
// key to a future block means adding it here, and the gate below then demands
// its twin. Style families and aesthetic variants (cat_style, energy, mood,
// poll_style…) are deliberately out: they dress the block, they do not lay it out.
const SURFACE_KEYS = ['view', 'layout', 'card_layout', 'columns', 'density', 'limit',
  'height_px', 'image_view', 'image_fit', 'divider_style', 'full_bleed'];
yes(/function phoneNumTwin\(b, key, host, opts, xf, hint\) \{/.test(CMS) && /function phoneTickTwin\(b, key, host\) \{/.test(CMS),
  'number and tick controls have twin builders beside the select one');
yes(/function tickOn\(b, key\) \{/.test(BLOCKS), 'the web engine reads tick twins through tickOn');

const chunks = CMS.split(/\nfunction /);
const missing = [];
for (const ch of chunks) {
  for (const key of SURFACE_KEYS) {
    const writes = new RegExp("updateBlock(?:Silent)?\\(b\\.id, \\{[^}]*\\b" + key + ":");
    if (!writes.test(ch)) continue;
    const twinned = new RegExp("phone(?:Shape|Num|Tick)Twin\\(b, '" + key + "'|b\\." + key + "_phone").test(ch);
    if (!twinned) missing.push((ch.match(/^([A-Za-z0-9_]+)/) || ['?'])[1] + ':' + key);
  }
}
yes(missing.length === 0, 'every form that writes a surface key wears the twin for it', missing.join(', '));

const BARE = new RegExp('b\\.(' + SURFACE_KEYS.join('|') + ')\\b(?!_phone)');
const readsClean = (src, cap) => {
  const lines = src.split('\n');
  const c = cap ? lines.findIndex(l => l.startsWith(cap)) : lines.length;
  for (let i = 0; i < c; i++) {
    const l = lines[i].replace(/\/\/.*$/, '');
    if (!BARE.test(l)) continue;
    if (/shapeOn|shapePhone|tickOn|_phone/.test(l)) continue;
    return 'line ' + (i + 1) + ': ' + l.trim().slice(0, 80);
  }
  return null;
};
yes(!readsClean(BLOCKS), 'the web engine reads no bare surface key', readsClean(BLOCKS) || '');
yes(!readsClean(MINI), 'the mini app reads no bare surface key', readsClean(MINI) || '');
yes(!readsClean(STORE), 'the phone drawer reads no bare surface key', readsClean(STORE) || '');
yes(!readsClean(CMS, 'function field(label'), 'the editor\'s phone DOM reads no bare surface key', (readsClean(CMS, 'function field(label') || ''));

const tickSrc = slice(BLOCKS, 'function tickOn(b, key) {', '\n  }') + '\n  }';
const tctx = { window: { matchMedia: () => ({ matches: true, addEventListener() {}, addListener() {} }) } };
vm.createContext(tctx);
vm.runInContext('var _phoneMQ = window.matchMedia("(max-width:767px)");\n' + tickSrc + '\nthis.tickOn = tickOn;', tctx);
yes(tctx.tickOn({ full_bleed: true, full_bleed_phone: false }, 'full_bleed') === false &&
    tctx.tickOn({ full_bleed: true }, 'full_bleed') === true,
  'a tick twin overrides on a phone; unset, the computer\'s answer stands');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
