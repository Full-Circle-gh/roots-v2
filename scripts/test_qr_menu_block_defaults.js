#!/usr/bin/env node
/**
 * §228 — THE QR MENU DRAWS THE BLOCKS QUINOA SALAD DRAWS, AND NOTHING ELSE.
 *
 *   node scripts/test_qr_menu_block_defaults.js
 *
 * Ash, 2026-09-22: *"check which blocks available to view of the quinoa salad
 * in the QR code menu and have all the product of the main menu QR code show
 * the same blocks for each product."* Read live the same morning, Quinoa Salad
 * (#196) carried ten blocks with two switched off; the eight that remain are
 * the rule.
 *
 * THE FIRST IMPLEMENTATION GOT THE DIRECTION WRONG and this file exists mostly
 * to stop that coming back. It read the ask as a BLOCK-LIST — take the two
 * types #196 has switched off and switch those off everywhere. That is a
 * weaker rule with a hole in the middle of it: it says nothing about a type
 * #196 does not carry at all, so `pull_quote` (11 products, 4 listed),
 * `recipe_steps` (8) and `ingredients_line` (1) kept drawing, and every block
 * type the editor gains next year would arrive on the counter menu switched
 * on. Ash rejected it in those terms. The rule is an ALLOW-LIST.
 *
 * WHAT THIS HOLDS THAT READING THE FILES CANNOT.
 *
 *  1. THE DIRECTION ITSELF. A block-list and an allow-list agree on every
 *     product in today's catalogue that happens to carry only the nine common
 *     types — which is most of them — so the difference is invisible in a
 *     spot check and shows up on the first product that carries something
 *     unusual, or the first new block type.
 *
 *  2. THREE EMPTY STATES THAT ARE NOT THE SAME. No config row means the seed.
 *     A stored `[]` means allow nothing. A caller passing no list at all means
 *     no rule in force. Conflating any two of them either blanks every detail
 *     sheet in the shop or silently ships nothing.
 *
 *  3. THE THREE READERS RESOLVE ONE RULE. lib/product-blocks-read.js decides
 *     what the menu draws, routes/shop-menu.js supplies the list, and
 *     public/product-editor.html draws the eye that claims to describe the
 *     result. A fourth opinion, or a seed copied into any of them, is how the
 *     editor comes to show an open eye on a block the customer cannot see.
 *
 *  4. THE MENU READS IT ONCE PER REQUEST. Every product on a menu resolves
 *     against the same list; a read inside the per-product renderer would put
 *     one identical query behind all 117 cards, which is the §179 mistake with
 *     a new address.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const D = require('../lib/qr-menu-block-defaults');
const R = require('../lib/product-blocks-read');

const MENU_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes/shop-menu.js'), 'utf8');
const EDITOR_SRC = fs.readFileSync(path.join(__dirname, '..', 'public/product-editor.html'), 'utf8');
const ADMIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes/retail.js'), 'utf8');

let pass = 0, fail = 0;
const section = (t) => console.log('\n' + t);
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

// A handle just real enough to answer the one query the module makes.
function fakeDb(answer) {
  return {
    prepare() {
      return { get() { if (answer instanceof Error) throw answer; return answer; } };
    },
  };
}

const SEED = ['spec_strip', 'hero_intro', 'big_stat', 'why',
              'ingredients_chips', 'allergen_card', 'how_to_use', 'nutrition_facts'];

section('The seed is what Quinoa Salad DRAWS, stated once');
check('exactly the eight blocks that product shows, in its own order', () => {
  assert.deepStrictEqual([...D.SEED_SHOWN], SEED,
    'the seed no longer matches what was read off product #196 on 2026-09-22 — ' +
    'if that is deliberate, the live read that justified it has to be redone');
});
check('THE TWO IT SWITCHED OFF ARE ABSENT, and so are the three it never had', () => {
  /* The two are the office's own choice. The three are the correction: a
     block-list would have left them drawing, because nobody ever switched
     them off — they simply are not on that product. */
  for (const t of ['storage_box', 'notes_callout']) {
    assert.ok(D.SEED_SHOWN.indexOf(t) < 0, t + ' is allowed, but #196 has it switched off');
  }
  for (const t of ['pull_quote', 'recipe_steps', 'ingredients_line']) {
    assert.ok(D.SEED_SHOWN.indexOf(t) < 0,
      t + ' is allowed, but #196 does not carry it — this is the block-list reading coming back');
  }
});
check('it cannot be edited out from under a caller', () => {
  assert.throws(() => { D.SEED_SHOWN.push('pull_quote'); },
    'SEED_SHOWN is mutable — one caller pushing to it changes the rule for every other');
});

section('Three empty states, and they are three different answers');
check('NO CONFIG ROW means the seed', () => {
  assert.deepStrictEqual(D.readShownTypes(fakeDb(undefined)), SEED,
    'an unset tenant gets no rule — the change would look shipped and do nothing');
});
check('no storefront_config table at all (an older account database)', () => {
  assert.deepStrictEqual(D.readShownTypes(fakeDb(new Error('no such table'))), SEED,
    'a missing table threw instead of falling back');
});
check('A STORED [] means allow nothing, and it is honoured', () => {
  assert.deepStrictEqual(D.readShownTypes(fakeDb({ value_json: '[]' })), [],
    'a tenant who deliberately allowed nothing got the seed back instead');
});
check('NO LIST PASSED TO THE READER means no rule in force', () => {
  const b = [{ type: 'pull_quote', text_en: 'Best soup in town.' }];
  assert.strictEqual(R.pageBlocks(b).length, 1, 'a caller passing nothing had its blocks filtered');
  assert.strictEqual(R.pageBlocks(b, []).length, 0, '…and an empty list failed to filter');
});

section('A malformed row falls back to the seed, never to a blank menu');
check('unparseable JSON', () => {
  assert.deepStrictEqual(D.readShownTypes(fakeDb({ value_json: '{oops' })), SEED,
    'a malformed row read as "allow nothing" — that empties every detail sheet in the shop');
});
check('something that is not a list', () => {
  for (const v of ['"hero_intro"', '{"hero_intro":true}', 'null', '7']) {
    assert.deepStrictEqual(D.readShownTypes(fakeDb({ value_json: v })), SEED,
      'a malformed row (' + v + ') read as "allow nothing"');
  }
});

section('A tenant that has answered is obeyed');
check('a stored list replaces the seed outright', () => {
  assert.deepStrictEqual(D.readShownTypes(fakeDb({ value_json: '["why","faq"]' })), ['why', 'faq'],
    'the stored list was merged with the seed rather than replacing it');
});
check('blanks and duplicates are dropped, and entries are not renamed', () => {
  assert.deepStrictEqual(
    D.readShownTypes(fakeDb({ value_json: '["  why  ","why","","faq",null]' })), ['why', 'faq'],
    'the list is not normalised, so a stray space makes a type undrawable');
});

section('One rule, resolved the same way by everything that resolves it');
check('the menu reads the list ONCE PER REQUEST, not per product', () => {
  assert.ok(/qrBlockDefaults\.readShownTypes\(/.test(MENU_SRC),
    'routes/shop-menu.js never reads the allow-list — the page still draws every block');
  const reads = [...MENU_SRC.matchAll(/readShownTypes\(/g)].length;
  assert.strictEqual(reads, 1,
    `${reads} reads of the allow-list in routes/shop-menu.js — one per card is one query per tile`);
  const at = MENU_SRC.indexOf('function detailBody(');
  assert.ok(!/readShownTypes\(/.test(MENU_SRC.slice(at, at + 4000)),
    'detailBody reads the list itself — that is one query per product on the page');
});
check('the menu hands the list to pageBlocks rather than dropping it', () => {
  assert.ok(/pageBlocks\(it\.description_blocks,\s*qrShown\)/.test(MENU_SRC),
    'the list is read and then not passed — pageBlocks would apply no rule at all');
});
check('the admin config endpoint answers with the EFFECTIVE list', () => {
  assert.ok(/shownBlockTypes:\s*qrBlockDefaults\.readShownTypes\(/.test(ADMIN_SRC),
    'GET /api/retail-admin/config does not compute the effective list, so an unset ' +
    'tenant hands the product editor nothing and the editor must invent it');
});
check('NOBODY CARRIES A SECOND COPY OF THE SEED', () => {
  /* The list may be named once, in the module that owns it. A copy in the
     menu, the admin route or the editor agrees on the day it is written and
     drifts the first time somebody edits one of them — and the failure is
     invisible: the editor's eye says shown, the customer sees nothing.
     PA_SPINE in the editor is the section ORDER, not an allow-list, and is
     excised by name rather than skipped by shape. */
  for (const [name, src] of [['routes/shop-menu.js', MENU_SRC],
                             ['public/product-editor.html', EDITOR_SRC]]) {
    const scrubbed = src.replace(/const PA_SPINE = \[[^\]]*\];/, '');
    const offenders = scrubbed.split('\n')
      .filter(l => /['"]ingredients_chips['"]/.test(l) && /['"]allergen_card['"]/.test(l));
    assert.strictEqual(offenders.length, 0,
      name + ' carries its own copy of the seed list: ' + offenders.join(' | '));
  }
});
check('the editor resolves a block exactly as lib/product-blocks-read does', () => {
  /* Both are three-state and both must rank the states the same way. The
     editor's copy is a copy — it runs in a browser and cannot require this
     module — so the shape is asserted rather than shared. */
  assert.ok(/function paQrHidden\(/.test(EDITOR_SRC), 'the editor has no single resolver');
  const fn = EDITOR_SRC.slice(EDITOR_SRC.indexOf('function paQrHidden('));
  const head = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(head.indexOf('hide_qr === true') < head.indexOf('hide_qr === false'),
    'the editor checks false before true — the two states can both be claimed');
  assert.ok(/!paQrTypeShownByDefault\(b\.type\)/.test(head),
    'the editor does not invert the allow-list — an allowed type would read as hidden, or worse');
});
check('THE EDITOR STARTS AT null, NOT AT AN EMPTY LIST', () => {
  /* An empty list means "allow nothing", so an editor that started there would
     paint every eye shut for one frame and, if the config read failed, keep
     saying so. null is "no rule in force yet" and paints the old behaviour. */
  assert.ok(/let PA_QR_SHOWN_TYPES = null;/.test(EDITOR_SRC),
    'PA_QR_SHOWN_TYPES does not start null — an empty start claims every block is hidden');
  const load = EDITOR_SRC.slice(EDITOR_SRC.indexOf('async function paLoadQrDefaults('));
  const loadBody = load.slice(0, load.indexOf('\n}'));
  assert.ok(/retail-admin\/config/.test(loadBody), 'the list does not come from the config endpoint');
  const fills = [...EDITOR_SRC.matchAll(/PA_QR_SHOWN_TYPES\s*=\s*(?!=)/g)].length;
  const inLoader = [...loadBody.matchAll(/PA_QR_SHOWN_TYPES\s*=\s*(?!=)/g)].length;
  assert.strictEqual(fills - inLoader, 1,
    'the list is written somewhere other than its declaration and its loader');
});

section('The rule the whole change turns on, end to end');
check('an untouched product draws Quinoa Salad’s eight and nothing else', () => {
  const untouched = [
    { type: 'hero_intro', body_en: 'Brewed slowly' },
    { type: 'ingredients_chips', items: [{ name_en: 'Oats' }] },
    { type: 'storage_box', left: { head_en: 'Chill', num_en: '0–4°' } },
    { type: 'notes_callout', text_en: 'Stir before use.' },
    { type: 'pull_quote', text_en: 'Best soup in town.' },
    { type: 'recipe_steps', steps: [{ text_en: 'Warm gently.' }] },
  ];
  const shown = D.readShownTypes(fakeDb(undefined));
  assert.deepStrictEqual(R.pageBlocks(untouched, shown).map(b => b.type),
    ['hero_intro', 'ingredients_chips'],
    'the seed and the reader disagree — the two halves of the change do not meet');
});

console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
