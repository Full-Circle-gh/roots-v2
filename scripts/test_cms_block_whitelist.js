#!/usr/bin/env node
/**
 * Every block the editor offers, the server accepts — and both renderers draw.
 *
 * Found in the §272 survey: `favorites_block` sat in the editor's palette
 * (BLOCK_META in public/cms.html), in the mini app's block-renderer and in
 * the web shop's blocks.js, but not in routes/retail.js ALLOWED_BLOCK_TYPES —
 * so a merchant who dragged one in had their draft refused on save with
 * block_type_invalid, and nothing said why. The list is hand-kept; this holds
 * it to the palette so the next block added to the palette cannot be refused
 * the same way.
 *
 * What this holds:
 *   §1 every non-hidden palette type is on the server's list
 *   §2 every non-hidden palette type has a web renderer and a mini-app branch
 *   §3 the server's list carries nothing the palette does not, except the
 *      deprecated types the list keeps so old layouts still validate
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const RETAIL = read('routes/retail.js');
const CMS = read('public/cms.html');
const BLOCKS = read('public/shop/blocks.js');
const WXML = read('miniapp/components/block-renderer/block-renderer.wxml');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

function slice(src, open, close) {
  const a = src.indexOf(open);
  if (a < 0) throw new Error(`not found: ${open}`);
  const b = src.indexOf(close, a);
  if (b < 0) throw new Error(`no close after: ${open}`);
  return src.slice(a, b + close.length);
}

/* The server's list, run as shipped. */
const srv = {};
vm.createContext(srv);
vm.runInContext(slice(RETAIL, 'const ALLOWED_BLOCK_TYPES = new Set([', ']);') + '\nthis.ALLOWED = ALLOWED_BLOCK_TYPES;', srv);
const allowed = srv.ALLOWED;

/* The palette: BLOCK_META's keys, minus the ones it hides. */
const metaSrc = slice(CMS, 'const BLOCK_META = {', '\n};');
const palette = [];
const hidden = [];
// §503 — a block marked website_only is drawn by the web engine alone (the
// brand website, public/site.html) and has no mini-app branch by design.
const websiteOnly = new Set();
for (const m of metaSrc.matchAll(/^  ([a-z_]+):\s*\{([^\n]*)/gm)) {
  (/hidden:\s*true/.test(m[2]) ? hidden : palette).push(m[1]);
  if (/website_only:\s*true/.test(m[2])) websiteOnly.add(m[1]);
}
yes(palette.length >= 20, `the palette was read (${palette.length} types, ${hidden.length} hidden)`);

// ─────────────────────────────────────────────────────────────────────────
section('1 · every block the editor offers, the server accepts');

for (const t of palette) {
  yes(allowed.has(t), `${t} is on ALLOWED_BLOCK_TYPES`);
}

// ─────────────────────────────────────────────────────────────────────────
section('2 · …and both customer renderers draw it');

for (const t of palette) {
  yes(new RegExp(`renderers\\.${t} = function`).test(BLOCKS), `${t} has a web renderer`);
  if (websiteOnly.has(t)) {
    yes(!new RegExp(`type === '${t}'`).test(WXML), `${t} is website only, with no mini-app branch`);
  } else {
    yes(new RegExp(`type === '${t}'`).test(WXML), `${t} has a mini-app branch`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
section('3 · the server list carries nothing the palette does not, except what it keeps for old layouts');

const DEPRECATED_KEPT = new Set(['wechat_oa', 'sticker_collage', 'progress_dots']);
for (const t of allowed) {
  yes(palette.includes(t) || hidden.includes(t) || DEPRECATED_KEPT.has(t),
    `${t} is in the palette, hidden there, or a deprecated type kept on purpose`);
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
