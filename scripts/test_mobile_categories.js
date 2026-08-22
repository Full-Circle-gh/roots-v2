#!/usr/bin/env node
/**
 * The phone's Categories screen, asserted against the desktop's catLoad.
 *
 *   node scripts/test_mobile_categories.js
 *
 * The phone was reading the wrong shelves. /api/retail-admin/categories is a
 * FLAT list out of the legacy `categories` table, counted over the legacy
 * store_products.category column. The shop does not run on that: the storefront
 * renders a two-level TREE held in storefront_config, and every product is
 * tagged with top_category + subcategory from it. So this screen showed a
 * different set of shelves, with different counts, from the ones a shopper sees
 * — and when the flat list came back empty it showed six invented ones
 * ("Fresh produce 24", "Bakery 12", …) that were never in either scheme.
 *
 * The fact this screen exists to carry, and which the phone had no way to
 * state: a shelf with products but none PUBLISHED is invisible in the shop.
 * That is different from a shelf with nothing on it, and only one of them is
 * costing the shop money.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

// Four shelves that cover the distinction: fully published, part published,
// products but none published (hidden — the amber), and nothing at all (empty).
const TREE = `[
  {id:'dry',    name:'Dry & Pantry', name_cn:'干货 & 杂货', subs:[
    {id:'nuts', name:'Nuts & Seeds', name_cn:'坚果 & 籽'},
    {id:'jams', name:'Jams',         name_cn:'果酱'}]},
  {id:'drinks', name:'Drinks',       name_cn:'饮品', subs:[]},
  {id:'ready',  name:'Ready to Eat', name_cn:'即食', subs:[]}
]`;
const COUNTS = `{
  dry:{n:14, published:11}, nuts:{n:9, published:9}, jams:{n:5, published:0},
  drinks:{n:3, published:0}, ready:{n:0, published:0}
}`;

const SEEDED = `state.catsTried=true; state.cats=${TREE}; state.catCounts=${COUNTS}; APP.cmd('push','categories');`;

const CASES = [
  ['the shelves', SEEDED, [
    ['the tree is the source',        `txt('content').includes('Dry & Pantry')`],
    ['tops are counted',              `/3\\s*top categories/.test(txt('content'))`],
    ['subs are counted',              `/2\\s*subcategories/.test(txt('content'))`],
    ['a part-published shelf says so', `txt('content').includes('11 of 14 published')`],
    ['a shelf with nothing on it is empty, not hidden', `txt('content').includes('empty')`],
    ['and the subcategory count rides the row', `txt('content').includes('2 subcategories')`],
    ['no invented shelf survives',    `!txt('content').includes('Fresh produce') && !txt('content').includes('Bakery')`],
  ]],
  ['the fact that costs money', SEEDED, [
    ['hidden shelves are named and counted', `/2 shelves hidden/.test(txt('content'))`],
    ['and the reason is stated',             `txt('content').includes('nothing published on them')`],
  ]],
  ['one hidden shelf gets named', `state.catsTried=true; state.cats=[{id:'drinks',name:'Drinks',subs:[]}];
    state.catCounts={drinks:{n:3,published:0}}; APP.cmd('push','categories');`, [
    ['by name, not by count', `txt('content').includes('“Drinks” is hidden')`],
  ]],
  ['nothing hidden says so', `state.catsTried=true; state.cats=[{id:'dry',name:'Dry & Pantry',subs:[]}];
    state.catCounts={dry:{n:4,published:4}}; APP.cmd('push','categories');`, [
    ['every shelf visible',   `txt('content').includes('every shelf is visible in the shop')`],
    ['and no amber warning',  `!txt('content').includes('hidden')`],
  ]],
  ['drilling into a shelf', SEEDED + `APP.cmd('catTop','dry');`, [
    ['the top is at the head',     `txt('content').includes('Dry & Pantry')`],
    ['its subs are listed',        `txt('content').includes('Nuts & Seeds') && txt('content').includes('Jams')`],
    ['a hidden sub is amber-marked', `txt('content').includes('hidden · nothing published')`],
    ['a way back',                 `txt('content').includes('All categories')`],
    ['other tops are not on this screen', `!txt('content').includes('Ready to Eat')`],
  ]],
  ['a shelf with no subs', SEEDED + `APP.cmd('catTop','drinks');`, [
    ['says so rather than showing an empty list', `txt('content').includes('No subcategories on this shelf')`],
  ]],
  ['what does not move here', SEEDED, [
    ['editing is named as a desktop job', `txt('content').includes('Rename, reorder, add and remove on desktop')`],
    ['and the consequence of a rename is stated', `txt('content').includes('follows a rename')`],
  ]],
  ['no shelves at all', `state.catsTried=true; state.cats=[]; state.catCounts={}; APP.cmd('push','categories');`, [
    ['says there are none', `txt('content').includes('No categories yet')`],
    ['and invents none',    `!txt('content').includes('Fresh produce')`],
  ]],
  ['it would not load', `state.catsTried=true; state.catsErr='Could not load the categories.'; APP.cmd('push','categories');`, [
    ['says so',           `txt('content').includes('Could not load the categories')`],
    ['not "none yet"',    `!txt('content').includes('No categories yet')`],
  ]],
];

run('categories', CASES);
