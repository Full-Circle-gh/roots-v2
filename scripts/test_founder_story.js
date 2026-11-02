#!/usr/bin/env node
/**
 * The founder essay and the four About facts belong on the Yuexiu brand
 * website only. The mini app and the web shop do not open that essay and
 * do not draw the strip.
 *
 * The website marks its Our story card with cta_target "story" at draw
 * time. The block engine shortens that card on a phone and makes the card
 * the link. A card aimed at About stays a normal card.
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
  ],
};

section('1 · facts are inserted only when the site asks');

{
  const layout = [{ id: 'h', type: 'hero_banner' }, { id: 'r', type: 'recipe_story' }];
  const snap = JSON.stringify(layout);
  const web = ShopBlocks.withFrontFacts(layout, STATS);
  is(JSON.stringify(layout), snap, 'the published layout is not rewritten');
  is(web[0].type, 'hero_banner', 'the hero stays first');
  is(web[1].type, 'about_stats', 'the strip is the next block');
  is(web[1].stats.length, 4, 'four facts, the fifth and the blank dropped');
  is(web !== layout, true, 'the drawn list is a new array');
}
is(sig(ShopBlocks.withFrontFacts([], STATS)), '', 'an empty page stays empty');
is(sig(ShopBlocks.withFrontFacts([{ id: 'h', type: 'hero_banner' }], { stats: [] })), 'hero_banner:h', 'no numbers, no strip');
{
  const layout = [{ id: 'g', type: 'product_grid' }];
  is(ShopBlocks.withFrontFacts(layout, STATS)[0].type, 'about_stats', 'no hero, the strip is first');
}
{
  const layout = [{ id: 'h', type: 'hero_banner' }, { id: 'own', type: 'about_stats', stats: [{ value_en: '9' }] }];
  is(ShopBlocks.withFrontFacts(layout, STATS), layout, 'a strip already on the page is left alone');
}

section('2 · only a story target opens the essay');

ShopBlocks.setContext({ lang: 'en', products: [], categories: [], flashSales: [], config: null });
const storyHtml = ShopBlocks.render([{
  id: 'roots',
  type: 'recipe_story',
  cta_target: 'story',
  cta_label_en: 'READ MORE',
  headline_en: 'The Roots of It All',
  body_en: 'A tiny kitchen.\n\nThat kitchen became Roots.',
}]);
is((storyHtml.match(/data-cta-target="story"/g) || []).length, 1, 'one story target, on the card');
yes(storyHtml.includes('sb-rcp-paras tease'), 'the phone tease is marked');
yes(storyHtml.includes('A tiny kitchen. That kitchen became Roots.'), 'the short line joins the paragraphs');

const aboutCard = ShopBlocks.render([{
  id: 'shop', type: 'recipe_story', cta_target: 'about', cta_label_en: 'READ MORE', body_en: 'Full shop copy.',
}]);
yes(!aboutCard.includes('tease'), 'a card aimed at About is not shortened');
yes(aboutCard.includes('data-cta-target="about"'), 'its About target is kept');
yes(!aboutCard.includes('data-cta-target="story"'), 'it does not open the essay');

section('3 · the website has it, the shop and the mini app do not');

const site = read('public/site.html');
const shop = read('public/shop.html');
const appJson = read('miniapp/app.json');
const aboutWxml = read('miniapp/pages/about/about.wxml');
const home = read('miniapp/pages/home/home.js');

yes(site.includes('function showFounderStory()'), 'the Yuexiu website has the essay');
yes(site.includes('layoutForSite') && site.includes('ShopBlocks.withFrontFacts'), 'the website draws the facts strip');
yes(site.includes("t==='story'"), 'the story card opens the essay');
yes(!shop.includes('function renderStory') && !shop.includes('withFrontFacts'), 'the web shop does not');
yes(!appJson.includes('pages/story/story'), 'the mini app has no essay screen');
yes(!aboutWxml.includes('goStory'), 'About on the mini app does not open one');
yes(!home.includes('withFrontFacts'), 'the mini app home does not draw the strip');
yes(!fs.existsSync(path.join(ROOT, 'miniapp/utils/front-facts.js')), 'the mini app copy of the strip rule is gone');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
