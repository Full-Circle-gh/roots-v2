#!/usr/bin/env node
/**
 * The founder essay is its own screen. The home story card that points at
 * About, and About's "Read the full story" link, both open it. The four
 * facts from About sit under the hero on the front page, and only when
 * this shop wrote them.
 *
 * The web shop and the mini app each have a copy of the insert rule,
 * because the browser block engine cannot require the mini-app file.
 * This suite is what keeps the two copies the same.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

const { withFrontFacts } = require('../miniapp/utils/front-facts');

const sandbox = { console };
vm.createContext(sandbox);
sandbox.window = sandbox;
vm.runInContext(read('public/shop/blocks.js'), sandbox, { filename: 'public/shop/blocks.js' });
const ShopBlocks = sandbox.ShopBlocks;

function sig(blocks) {
  return (blocks || []).map(b => {
    if (!b) return '';
    if (b.type !== 'about_stats') return b.type + ':' + (b.id || '');
    const vals = (b.stats || []).map(s => (s.value_en || '') + '/' + (s.value_cn || '')).join(',');
    return 'about_stats:' + vals + (b.full_bleed ? ':bleed' : '');
  }).join('|');
}

const STATS = {
  stats: [
    { value_en: '2017', label_en: 'EST' },
    { value_en: '广州', label_en: 'MADE IN' },
    { value_en: '250+', label_en: 'PRODUCTS' },
    { value_en: '100%', label_en: 'PLANTS' },
    { value_en: 'EXTRA', label_en: 'FIFTH' },
    { value_en: '   ', label_en: 'BLANK' },
    { value_cn: '保留', label_cn: '中文' },
  ],
};

section('1 · the two insert rules agree');

function agree(layout, about, label) {
  const web = ShopBlocks.withFrontFacts(layout, about);
  const mini = withFrontFacts(layout, about);
  is(sig(web), sig(mini), label);
  return { web, mini };
}

agree([], STATS, 'an empty front page stays empty');
agree(null, STATS, 'a missing layout stays empty');
agree([{ id: 'h', type: 'hero_banner' }], { stats: [] }, 'no numbers, no strip');
agree([{ id: 'h', type: 'hero_banner' }], null, 'no About page, no strip');

{
  const layout = [{ id: 'h', type: 'hero_banner' }, { id: 'r', type: 'recipe_story' }];
  const snap = JSON.stringify(layout);
  const { web, mini } = agree(layout, STATS, 'facts land after the hero');
  is(JSON.stringify(layout), snap, 'the published layout is not rewritten');
  is(web[0].type, 'hero_banner', 'the hero stays first');
  is(web[1].type, 'about_stats', 'the strip is the next block');
  is(web[1].id, 'about-stats', 'the strip has a stable id');
  is(web[1].stats.length, 4, 'four facts, the fifth and the blank dropped');
  is(web[1].stats[3].value_en, '100%', 'the fourth written fact is kept');
  yes(web[1].stats.every(s => String(s.value_en || s.value_cn).trim() !== 'EXTRA'), 'the fifth fact is not on the strip');
  is(mini[1].stats.length, 4, 'the mini app keeps the same four');
  is(web !== layout, true, 'the drawn list is a new array');
}

{
  const layout = [{ id: 'g', type: 'product_grid' }];
  const { web } = agree(layout, STATS, 'no hero, the strip is first');
  is(web[0].type, 'about_stats', 'it sits at the top');
  is(web[1].id, 'g', 'the shop block follows it');
}

{
  const layout = [
    { id: 'h', type: 'hero_banner' },
    { id: 'own', type: 'about_stats', stats: [{ value_en: '9' }] },
  ];
  const { web } = agree(layout, STATS, 'a strip the shop already placed is left alone');
  is(web, layout, 'same array, nothing inserted');
  is(web[1].id, 'own', 'the shop\'s own strip is the one that shows');
}

section('2 · the home story card opens the essay');

ShopBlocks.setContext({ lang: 'en', products: [], categories: [], flashSales: [], config: null });
const storyHtml = ShopBlocks.render([{
  id: 'roots',
  type: 'recipe_story',
  cta_target: 'about',
  cta_label_en: 'READ MORE',
  headline_en: 'The Roots of It All',
  body_en: 'A tiny kitchen.\n\nThat kitchen became Roots.',
}]);
is((storyHtml.match(/data-cta-target="story"/g) || []).length, 1, 'one story target, on the card');
yes(/class="sb-recipe-blk[^"]*"/.test(storyHtml) && storyHtml.indexOf('data-cta-target="story"') < storyHtml.indexOf('sb-recipe-blk'), 'the target is on the card itself');
yes(storyHtml.includes('sb-rcp-paras tease'), 'the phone tease is marked');
yes(storyHtml.includes('sb-rcp-short') && storyHtml.includes('A tiny kitchen. That kitchen became Roots.'), 'the two paragraphs become the short line');
yes(storyHtml.includes('sb-rcp-full') && storyHtml.includes('A tiny kitchen.'), 'the wide screen still has the paragraphs');
yes(!/class="sb-rcp-cta"[^>]*data-cta-target/.test(storyHtml) && !/data-cta-target="story"[^>]*>READ MORE/.test(storyHtml), 'the button is paint, not a second link');

const pointed = ShopBlocks.render([{
  id: 'roots2', type: 'recipe_story', cta_target: 'story', cta_label_en: 'READ MORE', body_en: 'Hello.',
}]);
yes(pointed.includes('data-cta-target="story"') && pointed.includes('tease'), 'a card already aimed at the essay does the same');

ShopBlocks.setContext({
  lang: 'en',
  products: [{ id: 7, name_en: 'Oat milk', sell_price: 12 }],
  categories: [], flashSales: [], config: null,
});
const withProduct = ShopBlocks.render([{
  id: 'roots3', type: 'recipe_story', cta_target: 'about', product_id: 7, body_en: 'Hello.',
}]);
yes(withProduct.includes('data-cta-target="product:7"'), 'the product inside the card still opens the product');
is((withProduct.match(/data-cta-target="story"/g) || []).length, 1, 'the card target stays the essay');

const wild = ShopBlocks.render([{
  id: 'wild', type: 'recipe_story', cta_target: 'shop', cta_label_en: 'SHOP', body_en: 'Out in the field.\n\nStill the full piece.',
}]);
yes(!wild.includes('tease'), 'a story card that does not open the essay is not shortened');
yes(wild.includes('data-cta-target="shop"'), 'its own target is kept');
yes(!wild.includes('data-cta-target="story"'), 'it does not open the essay');

const facts = ShopBlocks.render([{
  id: 'about-stats', type: 'about_stats',
  stats: [
    { value_en: '2017', label_en: 'EST' },
    { value_en: '   ', label_en: 'BLANK' },
    { value_cn: '广州', label_cn: '产地' },
  ],
}]);
yes(facts.includes('sb-facts') && facts.includes('2017') && facts.includes('广州'), 'the strip draws the written facts');
yes(!facts.includes('BLANK'), 'a blank fact is left out');

section('3 · the pages that open the essay');

const shop = read('public/shop.html');
const aboutWxml = read('miniapp/pages/about/about.wxml');
const aboutJs = read('miniapp/pages/about/about.js');
const appJson = read('miniapp/app.json');
const renderer = read('miniapp/components/block-renderer/block-renderer.js');
const wxml = read('miniapp/components/block-renderer/block-renderer.wxml');
const home = read('miniapp/pages/home/home.js');
const site = read('public/site.html');

yes(shop.includes('async function renderStory()'), 'the web shop has the essay page');
yes(shop.includes("seg[0]==='story'") && shop.includes("location.hash='#/story'"), 'the hash and the card target both reach it');
yes(shop.includes('data-go="#/story"'), 'About\'s link opens the essay');
yes(!shop.includes('aboutExpanded') && !shop.includes('SHOW LESS'), 'About no longer unfolds the quote in place');
yes(shop.includes('-webkit-line-clamp:3'), 'the quote on About is three lines');
yes(shop.includes('ShopBlocks.withFrontFacts'), 'the front page draws the strip');
yes(!site.includes('withFrontFacts'), 'the brand website is not the shop front page');

yes(aboutWxml.includes('goStory') && aboutWxml.includes('阅读完整故事 →'), 'the mini app About link is the live pair');
yes(!aboutJs.includes('toggleStory') && !aboutJs.includes('storyExpanded'), 'the quote does not expand in place');
yes(aboutJs.includes("/pages/story/story"), 'the link opens the essay screen');
yes(appJson.includes('"pages/story/story"'), 'the essay screen is a page');
yes(home.includes('withFrontFacts'), 'the mini app home draws the strip');
yes(renderer.includes("rawTarget === 'about' || rawTarget === 'story'") && renderer.includes('case \'about_stats\''), 'the mini app block renderer knows both');
yes(wxml.includes('rcp-tease') && wxml.includes("type === 'about_stats'") && wxml.includes('catchtap="onProductTap"'), 'the card tease, the strip, and the product tap are in the template');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
