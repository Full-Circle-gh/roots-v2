#!/usr/bin/env node
/**
 * The facts strip and the founder essay on the brand website are blocks
 * the Website page can edit. The strip used to be invented from About at
 * draw time. The essay used to be About's founder quote, so the story
 * block's own words never reached the popup.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  withEditableFacts, withEditableStory, isWebsiteStory, FOUNDER_KICKER_EN,
} = require('../lib/website-editor-blocks');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

const ABOUT = {
  stats: [
    { value_en: '2017', value_cn: '2017', label_en: 'EST.', label_cn: '成立' },
    { value_en: '广州', value_cn: '广州', label_en: 'MADE IN', label_cn: '产地' },
    { value_en: '   ', label_en: 'BLANK' },
    { value_en: '250+', value_cn: '250+', label_en: 'PRODUCTS', label_cn: '产品' },
    { value_en: '100%', value_cn: '100%', label_en: 'PLANTS', label_cn: '植物' },
    { value_en: 'EXTRA', label_en: 'FIFTH' },
  ],
  founder_quote_en: 'The long essay.',
  founder_quote_cn: '长文',
  outro_en: 'From soil to soul.',
  outro_cn: '从土壤到灵魂',
};

section('1 · the facts strip becomes a block after the first hero');

{
  const layout = [{ id: 'h', type: 'hero_banner' }, { id: 'f', type: 'fact_band' }];
  const snap = JSON.stringify(layout);
  const next = withEditableFacts(layout, ABOUT);
  is(JSON.stringify(layout), snap, 'the layout handed in is not rewritten');
  is(next[0].id, 'h', 'the hero stays first');
  is(next[1].type, 'about_stats', 'the strip is the next block');
  is(next[1].id, 'about-stats', 'the strip keeps the id the page already used');
  is(next[1].stats.length, 4, 'four facts, the blank and the fifth dropped');
  is(next[1].stats[2].value_en, '250+', 'a blank cell is skipped, not counted');
  is(next[1].full_bleed, true, 'the strip is full width, as the page draws it');
  is(next[2].id, 'f', 'the promise band follows the strip');
}
is(withEditableFacts([], ABOUT).length, 0, 'an empty page stays empty');
is(withEditableFacts([{ id: 'h', type: 'hero_banner' }], { stats: [] }).length, 1, 'no numbers, no strip');
{
  const layout = [{ id: 'g', type: 'product_grid' }];
  is(withEditableFacts(layout, ABOUT)[0].type, 'about_stats', 'no hero, the strip is first');
}
{
  const layout = [{ id: 'own', type: 'about_stats', stats: [{ value_en: '9' }] }];
  is(withEditableFacts(layout, ABOUT), layout, 'a strip already on the page is left alone');
}
{
  const layout = [{ id: 'about-stats', type: 'spacer' }];
  is(withEditableFacts(layout, ABOUT)[0].id, 'about-stats-2', 'a taken id is not reused');
}

section('2 · the founder essay is copied onto the story card, and the card body stays');

{
  const card = {
    id: 'story', type: 'recipe_story', kicker_en: 'OUR STORY', kicker_cn: '',
    body_en: 'Short card.', body_cn: '短', cta_target: '',
  };
  const layout = [{ id: 'h', type: 'hero_banner' }, card];
  const next = withEditableStory(layout, ABOUT);
  is(next[0], layout[0], 'other blocks are not copied');
  is(next[1].body_en, 'Short card.', 'the card text is not replaced by the essay');
  is(next[1].essay_en, 'The long essay.', 'the popup text is now a field on the card');
  is(next[1].essay_cn, '长文', 'the Chinese essay comes with it');
  is(next[1].signoff_en, 'From soil to soul.', 'the sign-off comes with it');
  is(next[1].kicker_en, FOUNDER_KICKER_EN, 'the kicker visitors see is the one stored');
  is(next[1].kicker_cn, '创始人故事', 'the Chinese kicker is stored too');
  is(next[1].cta_target, 'story', 'the button opens the essay');
  is(withEditableStory(next, ABOUT), next, 'a second pass leaves the card alone');
}
{
  const card = { id: 'notes', type: 'recipe_story', kicker_en: 'KITCHEN NOTES', body_en: 'A recipe.', cta_target: '' };
  const layout = [card];
  is(isWebsiteStory(card), false, 'an ordinary story is not the founder card');
  is(withEditableStory(layout, ABOUT), layout, 'an ordinary story is not given an essay');
  is(card.essay_en, undefined, 'no essay field is added');
}
{
  const card = { id: 's', type: 'recipe_story', kicker_en: 'A custom line', cta_target: 'story', body_en: 'Card.' };
  const out = withEditableStory([card], { founder_quote_en: 'Essay.' });
  is(out[0].kicker_en, 'A custom line', 'a kicker someone already wrote is kept');
  is(out[0].essay_en, 'Essay.', 'the essay is still filled in');
}

section('3 · the editor offers the strip, and the website reads the card');

const cms = read('public/cms.html');
const site = read('public/site.html');
const retail = read('routes/retail.js');
const shop = read('public/shop.html');
const home = read('miniapp/pages/home/home.js');

yes(/about_stats:\s*\{\s*website_only:\s*true/.test(cms), 'the strip is a website-only block in the palette');
yes(cms.includes("case 'about_stats':"), 'the inspector has a form for it');
yes(cms.includes('function buildAboutStatsForm'), 'that form is the facts list');
yes(cms.includes('essay_en') && cms.includes("T('Sign-off', '结尾')"), 'the story form edits the essay and the sign-off');
yes(/v:\s*'story'/.test(cms), 'the button can point at the essay');
yes(retail.includes("'about_stats'"), 'the server accepts the strip on save');
yes(site.includes('essay_en') && site.includes('signoff_en'), 'the popup reads the card');
yes(/const clicked=blockId&&cards\.find\(b=>b&&b\.id===blockId\);\s*const card=\(clicked&&isOurStory\(clicked\)\)\?clicked:\(cards\.find\(isOurStory\)\|\|null\);/.test(site),
  'a button on another block still opens the story card');
yes(!site.includes('withFrontFacts'), 'the website does not invent the strip at draw time');
yes(!site.includes('kicker_en:FOUNDER_STORY_KICKER_EN'), 'the saved kicker is the one that shows');
yes(!shop.includes('withFrontFacts'), 'the web shop does not draw the strip');
yes(!home.includes('withFrontFacts'), 'the mini app home does not draw the strip');
yes(read('database.js').includes('website_facts_and_essay_editable_v1'), 'boot copies the strip and the essay onto the saved layout once');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
