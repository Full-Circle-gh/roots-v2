#!/usr/bin/env node
/**
 * A block says where it shows — §271.
 *
 * One layout feeds two customer surfaces, the WeChat mini app and the web
 * shop. `show_on` on a block ('both' | 'miniapp' | 'web') says which of them
 * draw it. Four types default to the mini app because the web shop answers
 * their tap with "coming soon" (wallet, notifications, orders).
 *
 * What this holds:
 *   §1 the server's default table and read-time fill (routes/retail.js)
 *   §2 the server refuses a value it does not know, and keeps the field
 *   §3 the web shop keeps 'both' + 'web' and drops 'miniapp' (shop/blocks.js)
 *   §4 the mini app keeps 'both' + 'miniapp' and drops 'web' (utils/config.js)
 *   §5 the editor's copy of the default table is the server's, key for key
 *   §6 the two other renderers (storefront.html, the editor canvas) read it
 *
 * The helpers are lifted out of the shipped files and run, not re-typed here.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const RETAIL = read('routes/retail.js');
const BLOCKS = read('public/shop/blocks.js');
const MINI_CONFIG = read('miniapp/utils/config.js');
const CMS = read('public/cms.html');
const STOREFRONT = read('public/storefront.html');
const SHOP = read('public/shop.html');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is = (a, e, m) => (JSON.stringify(a) === JSON.stringify(e) ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

function slice(src, open, close) {
  const a = src.indexOf(open);
  if (a < 0) throw new Error(`not found: ${open}`);
  const b = src.indexOf(close, a);
  if (b < 0) throw new Error(`no close after: ${open}`);
  return src.slice(a, b + close.length);
}

/* ── the server's helpers, run as shipped ─────────────────────────────── */
const srv = { console };
vm.createContext(srv);
vm.runInContext(
  slice(RETAIL, "const ALLOWED_BLOCK_TYPES = new Set([", "]);")
  + '\n' + slice(RETAIL, 'const SHOW_ON_VALUES = new Set(', 'return layout.map(b => (b && typeof b === \'object\') ? { ...b, show_on: showOnFor(b) } : b);\n}')
  + '\n' + slice(RETAIL, 'const MAX_BLOCKS = ', 'function validateBlocks(blocks) {')
  + slice(RETAIL, '\n  if (!Array.isArray(blocks)) return { error: \'blocks_not_array\' };', '\n  return {};\n}')
  + '\nthis.showOnFor = showOnFor; this.withShowOn = withShowOn; this.validateBlocks = validateBlocks; this.SHOW_ON_DEFAULTS = SHOW_ON_DEFAULTS;',
  srv,
);

// ─────────────────────────────────────────────────────────────────────────
section('1 · the server fills show_on on read, from one table');

is(srv.SHOW_ON_DEFAULTS, { order_tracker: 'miniapp', notification_bar: 'miniapp', points_widget: 'miniapp', top_up: 'miniapp' },
  'exactly the four types the web shop answers with "coming soon" default to the mini app');
is(srv.showOnFor({ type: 'hero_banner' }), 'both', 'an ordinary block with no field shows on both');
is(srv.showOnFor({ type: 'order_tracker' }), 'miniapp', 'an order tracker with no field is mini app only');
is(srv.showOnFor({ type: 'order_tracker', show_on: 'both' }), 'both', '…unless the merchant turned it on for the website');
is(srv.showOnFor({ type: 'hero_banner', show_on: 'web' }), 'web', 'a stored value wins over the type default');
is(srv.showOnFor({ type: 'hero_banner', show_on: 'phone' }), 'both', 'a value the table does not know falls back to the default, never leaks through');

{
  const out = srv.withShowOn([{ id: 'a', type: 'hero_banner' }, { id: 'b', type: 'points_widget' }, null]);
  is(out.map(b => b && b.show_on), ['both', 'miniapp', null], 'every block leaves the server with the field explicit');
  const src = [{ id: 'a', type: 'hero_banner' }];
  srv.withShowOn(src);
  is(src[0].show_on, undefined, 'the stored layout is not mutated — the default is applied on the way out');
  is(srv.withShowOn('nope'), 'nope', 'a non-array passes through untouched');
}

/* Every read path the two surfaces and the editor use runs the fill. */
yes(/return Array\.isArray\(v\) \? withShowOn\(v\) : \[\];/.test(RETAIL), 'readLayout (editor GET, publish) fills it');
yes(/out\[page\]\.layout = withShowOn\(out\[page\]\.layout\)/.test(RETAIL), 'loadConfig (public /api/retail/config) fills it');
is((RETAIL.match(/\.layout = withShowOn\(draft\)/g) || []).length, 2, 'both draft overlays (preview token, preview-config) fill it');

// ─────────────────────────────────────────────────────────────────────────
section('2 · the server refuses a value it does not know');

is(srv.validateBlocks([{ id: 'a', type: 'hero_banner', show_on: 'web' }]), {}, 'a known value saves');
is(srv.validateBlocks([{ id: 'a', type: 'hero_banner' }]), {}, 'no value saves (old drafts, the editor before a first change)');
is(srv.validateBlocks([{ id: 'a', type: 'hero_banner', show_on: 'phone' }]).error, 'block_show_on_invalid', 'an unknown value is refused, naming the field');
is(srv.validateBlocks([{ id: 'a', type: 'hero_banner', show_on: null }]).error, 'block_show_on_invalid', '…null too (undefined is the only "not set")');

// ─────────────────────────────────────────────────────────────────────────
section('3 · the web shop draws what the web shop shows');

const win = { console, setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0 };
win.window = win;
win.document = { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), querySelector: () => null, querySelectorAll: () => [], body: {} };
vm.createContext(win);
vm.runInContext(BLOCKS, win);
const SB = win.ShopBlocks;
yes(SB && typeof SB.forSurface === 'function', 'ShopBlocks.forSurface is exported for hosts that walk the layout first');
{
  const layout = [
    { id: 'a', type: 'hero_banner', show_on: 'both' },
    { id: 'b', type: 'order_tracker', show_on: 'miniapp' },
    { id: 'c', type: 'spacer', show_on: 'web' },
    { id: 'd', type: 'spacer' },
  ];
  is(SB.forSurface(layout).map(b => b.id), ['a', 'c', 'd'], 'keeps both + web, drops miniapp; a missing field reads as both');
  is(SB.forSurface(null), [], 'a non-array is an empty layout');
  SB.setContext({ lang: 'en', products: [], categories: [], flashSales: [], config: {} });
  const html = SB.render([{ id: 'x', type: 'spacer', show_on: 'miniapp', height: 40 }, { id: 'y', type: 'spacer', show_on: 'web', height: 40 }]);
  yes(!/data-block-id="x"|"x"/.test(html) && (html.match(/sb-blk-outer/g) || []).length === 1, 'render() itself skips a mini-app-only block, so a host that forgets forSurface is still right');
}
yes(/ShopBlocks\.forSurface\(published\)/.test(SHOP), 'shop.html filters the home layout before it pre-fetches the products a block names');

// ─────────────────────────────────────────────────────────────────────────
section('4 · the mini app draws what the mini app shows');

const mini = { console };
vm.createContext(mini);
vm.runInContext(slice(MINI_CONFIG, 'function forMiniApp(blocks) {', '\n}') + '\nthis.forMiniApp = forMiniApp;', mini);
{
  const layout = [
    { id: 'a', type: 'hero_banner', show_on: 'both' },
    { id: 'b', type: 'order_tracker', show_on: 'miniapp' },
    { id: 'c', type: 'spacer', show_on: 'web' },
    { id: 'd', type: 'spacer' },
  ];
  is(mini.forMiniApp(layout).map(b => b.id), ['a', 'b', 'd'], 'keeps both + miniapp, drops web; a missing field reads as both');
  is(mini.forMiniApp(undefined), [], 'no layout is an empty layout');
}
yes(/module\.exports = \{[^}]*forMiniApp[^}]*\}/.test(MINI_CONFIG), 'forMiniApp is exported');
yes(/return forMiniApp\(_cache\?\.\[page\]\?\.layout\)/.test(MINI_CONFIG), 'config.layout(page) filters too');
for (const page of ['home/home.js', 'layout/layout.js', 'onboarding/onboarding.js']) {
  const src = read('miniapp/pages/' + page);
  yes(/config\.forMiniApp\(cfg\?\./.test(src) && !/\.layout \|\| \[\];/.test(src),
    `pages/${page} reads its layout through forMiniApp and nowhere else`);
}

// ─────────────────────────────────────────────────────────────────────────
section('5 · the editor\'s copy of the default table is the server\'s');

{
  const cmsTable = CMS.match(/const SHOW_ON_DEFAULTS = Object\.freeze\((\{[^}]*\})\)/);
  const srvTable = RETAIL.match(/const SHOW_ON_DEFAULTS = Object\.freeze\((\{[^}]*\})\)/);
  yes(cmsTable && srvTable, 'both files declare the frozen table');
  if (cmsTable && srvTable) {
    is(cmsTable[1].replace(/\s+/g, ' ').trim(), srvTable[1].replace(/\s+/g, ' ').trim(),
      "the editor's table is the server's, character for character");
  }
  const ed = { console, state: { lang: 'en' } };
  vm.createContext(ed);
  vm.runInContext(slice(CMS, 'const SHOW_ON_DEFAULTS = Object.freeze(', "return (b && SHOW_ON_DEFAULTS[b.type]) || 'both';\n}") + '\nthis.showOnFor = showOnFor;', ed);
  is(ed.showOnFor({ type: 'top_up' }), 'miniapp', 'a top-up block just added to the canvas already reads as mini app only');
  is(ed.showOnFor({ type: 'top_up', show_on: 'both' }), 'both', '…and the stored value wins, same as the server');
}
yes(/inspectorSection\(body, b\.type, 'show', T\('Show on', '显示位置'\)\)/.test(CMS), 'every block\'s inspector carries the Show on section');
yes(/value: 'both'[^\n]*\n[^\n]*value: 'miniapp'[^\n]*\n[^\n]*value: 'web'/.test(CMS), 'the select offers exactly both / miniapp / web');
yes(/updateBlock\(b\.id, \{ show_on: v \}\)/.test(CMS), 'picking one writes show_on on the block (and so into the draft)');
yes(/tag\.className = 'show-on-tag'/.test(CMS) && /showOn !== 'both'/.test(CMS), 'the canvas tags a block one surface skips');

// ─────────────────────────────────────────────────────────────────────────
section('6 · the phone preview stands in for the mini app');

yes(/blocks = \(blocks \|\| \[\]\)\.filter\(b => b && b\.show_on !== 'web'\);/.test(STOREFRONT),
  'storefront.html (the editor\'s phone drawer) drops web-only blocks, like the mini app');

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
