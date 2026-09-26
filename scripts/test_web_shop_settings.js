#!/usr/bin/env node
/**
 * The web Shop tab obeys the same Shop-tab settings as the mini app — §274.
 *
 * miniapp/pages/shop/shop.js reads cfg.shop (Mini App Backend → Shop tab):
 * layout + lockLayout, defaultSort + showSort, showDietary, hideOutOfStock.
 * public/shop.html kept its own switcher, its own sort menu and its own chips
 * and read none of it. Now one setting governs both surfaces.
 *
 * What this holds:
 *   §1 the helpers, lifted out of the shipped page and run: the office's
 *      layout in the page's names, the default sort, the out-of-stock rule
 *      (the mini app's, exactly)
 *   §2 the phone list: layout locked / defaulted / chosen, the sort control
 *      only when the office shows one, the dietary chips off when it hides
 *      them, out-of-stock rows dropped, the sort sent to the API
 *   §3 the PC grid: the default sort, the sort menu only when shown, the count
 *      honest when rows were hidden
 *   §4 the three filters the web has no control for are not read
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SHOP = read('public/shop.html');
const MINI = read('miniapp/pages/shop/shop.js');

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

// ─────────────────────────────────────────────────────────────────────────
section('1 · the helpers, run as shipped');

const ctx = { state: { config: {}, lang: 'en' }, console };
vm.createContext(ctx);
vm.runInContext(
  slice(SHOP, 'const SL_VIEWS=[', '];')
  + '\n' + slice(SHOP, 'function shopCfg(){', "function shopSortOptions(current){ return Object.keys(SHOP_SORT_LABELS).map(k=>`<option value=\"${k}\"${(current||'featured')===k?' selected':''}>${SHOP_SORT_LABELS[k][state.lang==='cn'?1:0]}</option>`).join(''); }")
  + '\nthis.shopDefaultSort=shopDefaultSort; this.shopHideOos=shopHideOos; this.shopAdminLayout=shopAdminLayout; this.shopSortOptions=shopSortOptions; this.SHOP_SORTS=SHOP_SORTS;',
  ctx,
);
const withShop = (shop) => { ctx.state.config = { shop }; };

withShop(undefined);
is(ctx.shopDefaultSort(), '', 'no settings saved → no default sort (Featured)');
is(ctx.shopAdminLayout(), '', '…and no office layout');
is(ctx.shopHideOos([{ id: 1, stock: 0 }]).length, 1, '…and nothing hidden');

withShop({ layout: 'grid' });
is(ctx.shopAdminLayout(), 'grid-2col', "'grid', the old name, is the two-column grid");
withShop({ layout: 'gallery' });
is(ctx.shopAdminLayout(), 'grid-2col', "'gallery' has no web twin and reads as the two-column grid");
withShop({ layout: 'list-compact' });
is(ctx.shopAdminLayout(), 'list-compact', 'a layout the page has is used as is');
withShop({ layout: 'carousel' });
is(ctx.shopAdminLayout(), '', 'a layout the page does not know is ignored');

withShop({ defaultSort: 'price_desc' });
is(ctx.shopDefaultSort(), 'price_desc', 'a known default sort is used');
withShop({ defaultSort: 'random' });
is(ctx.shopDefaultSort(), '', 'an unknown one is ignored');
is(ctx.SHOP_SORTS, ['newest', 'price_asc', 'price_desc', 'popular'], 'the sorts are the mini app\'s four');
{
  const mini = slice(MINI, 'const SORT_OPTIONS = [', '];');
  for (const v of ctx.SHOP_SORTS) yes(mini.includes(`'${v}'`), `…${v} is one the mini app offers`);
}

withShop({ hideOutOfStock: true });
is(ctx.shopHideOos([{ id: 1, stock: 0 }, { id: 2, stock: 3 }, { id: 3 }, { id: 4, stock: null }]).map(p => p.id), [2, 3, 4],
  'hide out of stock drops a zero, keeps a figure, and keeps a product with no stock figure — the mini app\'s rule');
yes(/raw = raw\.filter\(p => p\.stock == null \|\| Number\(p\.stock\) > 0\);/.test(MINI), '…which is what the mini app does, character for character');

ctx.state.lang = 'cn';
withShop({});
yes(/<option value="popular">热门<\/option>/.test(ctx.shopSortOptions('')) && /<option value="featured" selected>推荐<\/option>/.test(ctx.shopSortOptions('')),
  'the sort labels are the mini app\'s own words in Chinese');
ctx.state.lang = 'en';
yes(/<option value="price_asc" selected>Price ↑<\/option>/.test(ctx.shopSortOptions('price_asc')), '…and in English, with the current one selected');

// ─────────────────────────────────────────────────────────────────────────
section('2 · the phone list');

const LIST = slice(SHOP, 'async function renderShopList(params){', 'slFit();');
yes(/if\(adminLayout\) SL\.layout=adminLayout;/.test(LIST), 'the office\'s layout is the default');
yes(/if\(!layoutLocked\)\{ try\{const sv=localStorage\.getItem\('shop_layout_pref'\)/.test(LIST), 'the shopper\'s own choice wins only while the layout is not locked');
yes(/id="slVs"\$\{layoutLocked\?' hidden':''\}/.test(LIST), 'a locked layout hides the switcher');
yes(/\$\{scfg\.showSort\?`<div class="sl-sort"><select id="slSort"/.test(LIST), 'the sort control shows only when the office shows one');
yes(/id="slDiet"\$\{scfg\.showDietary===false\?' hidden':''\}/.test(LIST), 'the dietary chips go when the office hides them (on by default, as in the app)');
yes(/SL\.sort=shopDefaultSort\(\);/.test(LIST), 'the list starts on the default sort');
const REFRESH = slice(SHOP, 'async function slRefresh(){', 'SL.prods=raw;');
yes(/if\(SL\.sort\)qp\.set\('sort',SL\.sort\);/.test(REFRESH), 'the sort goes to the API, which orders the rows');
yes(/raw=shopHideOos\(raw\);/.test(REFRESH), 'out-of-stock rows are dropped from the list');
yes(/\.sl-vs\[hidden\],\.sl-diet\[hidden\],\.toolbar \.sort\[hidden\]\{display:none;\}/.test(SHOP), 'hidden wins over the rows\' own flex display (§199)');

// ─────────────────────────────────────────────────────────────────────────
section('3 · the PC grid');

const GRID = slice(SHOP, 'async function renderShop(params){', "$('#shopGrid').innerHTML=prods.length");
yes(/const sort=params\.get\('sort'\)\|\|shopDefaultSort\(\)\|\|'featured';/.test(GRID), 'no sort in the address → the office\'s default, then Featured');
yes(/<select class="sort" id="sortSel"\$\{shopCfg\(\)\.showSort\?'':' hidden'\}>\$\{shopSortOptions\(sort\)\}<\/select>/.test(GRID),
  'the sort menu shows only when the office shows one, with the same five choices');
yes(/const prods=shopHideOos\(r&&r\.data\|\|\[\]\);/.test(GRID), 'out-of-stock rows are dropped from the grid');
yes(/const total=shopCfg\(\)\.hideOutOfStock\?prods\.length:\(\(r&&r\.meta&&r\.meta\.total\)\|\|prods\.length\);/.test(GRID), 'the count is honest when rows were hidden');

// ─────────────────────────────────────────────────────────────────────────
section('4 · what is not read, on purpose');

for (const k of ['showStockFilter', 'showBadgeFilter', 'showPriceFilter']) {
  yes(!new RegExp(`shopCfg\\(\\)\\.${k}|scfg\\.${k}`).test(SHOP), `${k} is not read — the web has no such control yet`);
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
