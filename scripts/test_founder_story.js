#!/usr/bin/env node
/**
 * The founder essay and the four About facts belong on the Yuexiu brand
 * website only. The mini app and the web shop do not open that essay and
 * do not draw the strip.
 *
 * The story card stores cta_target "story". The block engine shortens
 * that card on a phone and makes the read line the link. A card aimed
 * at About stays a normal card.
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
is((storyHtml.match(/data-cta-target="story"/g) || []).length, 1, 'one story target, on the read link');
yes(!/class="sb-recipe-blk[^"]*"[^>]*data-cta-target/.test(storyHtml), 'the card itself is not a link');
yes(storyHtml.includes('sb-rcp-paras tease'), 'the phone tease is marked');
yes(storyHtml.includes('sb-rcp-short sb-rcp-para">A tiny kitchen.'), 'the short line is the first paragraph only');
yes(storyHtml.includes('sb-rcp-full') && storyHtml.includes('That kitchen became Roots.'), 'later paragraphs stay in the full block');
yes(storyHtml.includes('sb-rcp-read') && storyHtml.includes('READ MORE'), 'the read link is labelled');
const defaultRead = ShopBlocks.render([{ id: 'd', type: 'recipe_story', cta_target: 'story', body_en: 'One para.' }]);
yes(defaultRead.includes('READ THE FULL STORY'), 'default read label when cta_label is empty');

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

yes(site.includes('function showFounderStory'), 'the Yuexiu website has the essay');
yes(site.includes('siteStoryScrim') && site.includes('closeSiteStoryPopup'), 'the essay opens in a popup');
yes(!site.includes('site-story-cta') && !/if\(cta&&menu\)/.test(site),
  'the essay has no Shop now button');
yes(site.includes('essay_en') && !site.includes('withFrontFacts'), 'the website reads a saved essay and does not invent the facts strip');
yes(site.includes("t==='story'"), 'the story link opens the essay');
yes(!shop.includes('function renderStory') && !shop.includes('withFrontFacts'), 'the web shop does not');
yes(!appJson.includes('pages/story/story'), 'the mini app has no essay screen');
yes(!aboutWxml.includes('goStory'), 'About on the mini app does not open one');
yes(!home.includes('withFrontFacts'), 'the mini app home does not draw the strip');
yes(!fs.existsSync(path.join(ROOT, 'miniapp/utils/front-facts.js')), 'the mini app copy of the strip rule is gone');

section('4 · the strip is a thin attached cap, full-bleed on a computer (§503 rule 56)');

ShopBlocks.setContext({ lang: 'en', products: [], categories: [], flashSales: [], config: null });
const factsHtml = ShopBlocks.render([{
  id: 'about-stats', type: 'about_stats', full_bleed: true, stats: STATS.stats,
}]);
yes(factsHtml.includes('class="sb-facts"'), 'the strip is the facts bar');
yes(factsHtml.includes('class="sb-facts-cell"'), 'each number is a facts cell');
yes(!/<div class="sb-fact">/.test(factsHtml), 'the strip does not reuse the promise band class');
yes(factsHtml.includes('sb-fact-v') && factsHtml.includes('2017'), 'values are drawn');

const bandHtml = ShopBlocks.render([{
  id: 'fb', type: 'fact_band',
  items: [{ title_en: 'Since 2017', body_en: 'Guangzhou' }],
}]);
yes(/class="sb-fact"/.test(bandHtml), 'the promise band still uses sb-fact');
yes(!bandHtml.includes('sb-facts-cell'), 'the promise band is not a facts cell');

const css = read('public/shop/blocks.css');
yes(!/\.sb-facts\s*\{[^}]*max-width:\s*70%/.test(css), 'the strip is not a 70% island');
yes(/\.sb-facts\s*\{[^}]*margin:\s*0/.test(css), 'the strip has no beige gap under it');
yes(/data-block-type="about_stats"[\s\S]{0,180}max-width:\s*none/.test(css),
  'on a computer the strip is the full window, like the green band');
yes(/data-block-type="fact_band"[\s\S]{0,180}max-width:\s*none/.test(css),
  'the promise band still runs the full window');
yes(!/data-block-type="about_stats"[\s\S]{0,80}max-width:\s*1240px/.test(css),
  'the strip is no longer capped at 1240px with the story block');

yes(/body \.shop-blocks \.sb-facts\{/.test(site), 'the phone sizes the black bar on its own');
yes(/body \.shop-blocks \.sb-fact\{padding:36px 22px 32px;\}/.test(site),
  'the phone padding on sb-fact still belongs to the green band');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
