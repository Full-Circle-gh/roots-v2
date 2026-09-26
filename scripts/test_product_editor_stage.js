#!/usr/bin/env node
/**
 * The product page editor gets the same stage as the Mini App Editor — §273.
 *
 * public/product-editor.html previewed a product on a phone only. Now a
 * Desktop ⇄ Phone switch sits above the preview, Desktop first, and the
 * desktop stage is the real web shop's product page (public/shop.html in
 * stage mode) fed this editor's unsaved draft.
 *
 * What this holds:
 *   §1 the editor: Desktop first, the frame on this product's route, the draft
 *      posted on every preview render, a click in the frame selecting the block
 *   §2 the web shop: the product draft laid over the published product, an
 *      unchanged draft a highlight only, product blocks click targets
 *   §3 the web block engine puts each block's id in the DOM
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PE = read('public/product-editor.html');
const SHOP = read('public/shop.html');
const PB = read('public/shop/product-blocks.js');

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

// ─────────────────────────────────────────────────────────────────────────
section('1 · the editor: Desktop first, the phone second');

yes(/let PE_STAGE = 'desktop';/.test(PE) && /localStorage\.getItem\(PE_STAGE_KEY\) \|\| 'desktop'/.test(PE), 'the stage defaults to desktop and is read back as desktop when nothing was chosen');
yes(/if \(PE_STAGE !== 'phone'\) PE_STAGE = 'desktop';/.test(PE), 'an unknown stored value falls back to desktop');
yes(/id="pe-stage-seg"/.test(PE) && /data-stage="desktop"/.test(PE) && /data-stage="phone"/.test(PE), 'the switch is in the preview bar');
yes(/Desktop · 电脑<\/button>/.test(PE) && /Phone · 手机<\/button>/.test(PE), 'its labels are EN · 中文 pairs the global pass splits');
yes(/ifr\.src = '\/shop-preview\?draft=1&stage=1' \+ \(PA_CURRENT && PA_CURRENT\.id \? '#\/product\/' \+ encodeURIComponent\(PA_CURRENT\.id\) : '#\/'\);/.test(PE),
  'the desktop stage is the real web shop, in stage mode, on this product\'s route');
yes(/width: 1280px;/.test(PE) && /const scale = Math\.min\(1, w \/ 1280\);/.test(PE), 'rendered 1280px wide and scaled to the canvas');
yes(/if \(!_peStageApplied\) peApplyStage\(\); else pePushStage\(\);/.test(slice(PE, 'function paRenderPreview() {', 'const p = PA_CURRENT;')),
  'every preview render feeds the stage; the first applies it');
yes(/type: 'cms:product-draft',/.test(PE) && /description_blocks: blocks,/.test(PE) && /use_block_design: blocks\.length > 0,/.test(PE),
  'the draft carries the unsaved blocks and turns the block design on when there are any');
yes(/tagline_en: v\('pa-edit-tagline-en'\), tagline_cn: v\('pa-edit-tagline-cn'\),/.test(PE), 'the tagline is read from the form, unsaved');
yes(/selectedId: PA_SELECTED_BLOCK_ID,/.test(PE) && /lang: _paPreviewLang \|\| 'en',/.test(PE), 'the selected block and the preview language ride along');
yes(/ev\.data\.type === 'cms:select'\) \{ if \(ev\.data\.id\) paBlocksSelect\(ev\.data\.id\); \}/.test(PE), 'a click in the frame selects the block, as a click on the phone does');
yes(/ev\.source !== _peStageIframe\.contentWindow\) return;/.test(PE), '…and only the stage frame is listened to');
yes(/\.pa-edit-canvas\.stage-desktop \.pa-prev-frame \{ display: none; \}/.test(PE), 'the phone frame hides under the desktop stage');
yes(PE.indexOf("let PE_STAGE = 'desktop';") < PE.indexOf('function paRenderPreview() {'), 'the stage state is declared before the render that reads it');

// ─────────────────────────────────────────────────────────────────────────
section('2 · the web shop: the draft over the published product');

yes(/ev\.data\.type==='cms:product-draft'&&STAGE_MODE/.test(SHOP), 'stage mode takes the product draft');
yes(/stageProduct=\{id, fields:\(d\.fields&&typeof d\.fields==='object'\)\?d\.fields:\{\}\};/.test(SHOP), 'the draft is kept by product id');
yes(/if\(STAGE_MODE&&stageProduct&&String\(stageProduct\.id\)===String\(id\)&&p\)\{ p=\{\.\.\.p,\.\.\.stageProduct\.fields\}; \}/.test(SHOP),
  'renderProduct lays the draft over the published product, only for that product');
yes(/if\(key===stageKey&&!langChanged&&onIt\)\{ stageHighlight\(true\); return; \}/.test(SHOP), 'an unchanged draft is a highlight, not a re-render');
yes(/location\.hash='#\/product\/'\+encodeURIComponent\(id\);/.test(SHOP), 'the stage moves to the product\'s route when it is elsewhere');
yes(/ev\.target\.closest\('\.sb-blk-outer,\.spb\[data-block-id\]'\)/.test(SHOP), 'a product block is a click target like a home block');
yes(/\.spb\[data-block-id="'\+CSS\.escape\(stageSel\)\+'"\]/.test(SHOP), 'the highlight finds a product block by its id');
yes(/\.cms-stage \.spb\.cms-selected\{outline:2px solid #6E67AF/.test(SHOP), 'the selected product block wears the editor\'s ring');
yes(/refreshBar\(\);\n  \}\)\(\);\n  stageHighlight\(true\);\n\}/.test(SHOP), 'the product page highlights after it renders');

// ─────────────────────────────────────────────────────────────────────────
section('3 · the web block engine');

yes(/\(b\.id \? ' data-block-id="' \+ attr\(b\.id\) \+ '"' : ''\)/.test(PB), 'every product block with an id carries it in the DOM');

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
