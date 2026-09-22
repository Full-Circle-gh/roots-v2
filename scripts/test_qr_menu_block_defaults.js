#!/usr/bin/env node
/**
 * §228 — THE QR MENU HAS A DEFAULT, AND IT IS THE SAME ONE EVERYWHERE.
 *
 *   node scripts/test_qr_menu_block_defaults.js
 *
 * Ash, 2026-09-22: *"the blocks of quinoa salad that now show on the qr code
 * menu will be the default for all products."* Read live the same morning,
 * Quinoa Salad (#196) carried ten blocks with exactly two switched off — the
 * storage card and the notes callout — and it and Almond Banana Berry were the
 * only two products in a 287-product catalogue carrying any flag at all. The
 * rule below is that arrangement stated once.
 *
 * WHAT THIS HOLDS THAT READING THE FILES CANNOT.
 *
 *  1. AN ABSENT CONFIG ROW MEANS THE SEED, NOT SILENCE. The whole design is
 *     that nothing is written to the database: the default lives in code and a
 *     tenant overrides it by storing the key. If an absent row ever came back
 *     as "hide nothing", the change would look shipped, every test that passes
 *     a list would still pass, and 216 products would quietly go back to
 *     printing the storage card on the counter menu.
 *
 *  2. AN EMPTY ARRAY IS A REAL ANSWER and a malformed one is not. Those are
 *     opposite outcomes from values that look similar in a config table, and
 *     the difference decides whether a tenant who asked for everything to show
 *     gets it, or gets the seed back without being told.
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

section('The seed is Quinoa Salad’s arrangement, stated once');
check('the two blocks that product had switched off, and no others', () => {
  assert.deepStrictEqual([...D.SEED_HIDDEN].sort(), ['notes_callout', 'storage_box'],
    'the seed no longer matches what was read off product #196 on 2026-09-22 — ' +
    'if that is deliberate, the live read that justified it has to be redone');
});
check('it cannot be edited out from under a caller', () => {
  assert.throws(() => { D.SEED_HIDDEN.push('hero_intro'); },
    'SEED_HIDDEN is mutable — one caller pushing to it changes the default for every other');
});

section('An unset tenant gets the seed, not silence');
check('no config row at all', () => {
  assert.deepStrictEqual(D.readHiddenTypes(fakeDb(undefined)), ['storage_box', 'notes_callout'],
    'an unset tenant hides nothing — the change would look shipped and do nothing');
});
check('no storefront_config table at all (an older account database)', () => {
  assert.deepStrictEqual(D.readHiddenTypes(fakeDb(new Error('no such table'))),
    ['storage_box', 'notes_callout'], 'a missing table threw instead of falling back');
});
check('a row holding unparseable JSON', () => {
  assert.deepStrictEqual(D.readHiddenTypes(fakeDb({ value_json: '{oops' })),
    ['storage_box', 'notes_callout'], 'a malformed row read as "hide nothing"');
});
check('a row holding something that is not a list', () => {
  for (const v of ['"storage_box"', '{"storage_box":true}', 'null', '7']) {
    assert.deepStrictEqual(D.readHiddenTypes(fakeDb({ value_json: v })),
      ['storage_box', 'notes_callout'], 'a malformed row (' + v + ') read as "hide nothing"');
  }
});

section('A tenant that has answered is obeyed, including when the answer is none');
check('AN EMPTY LIST IS HONOURED — it is not a malformed row', () => {
  assert.deepStrictEqual(D.readHiddenTypes(fakeDb({ value_json: '[]' })), [],
    'a tenant who asked for every block to show got the seed back instead');
});
check('a stored list replaces the seed outright', () => {
  assert.deepStrictEqual(D.readHiddenTypes(fakeDb({ value_json: '["why","faq"]' })), ['why', 'faq'],
    'the stored list was merged with the seed rather than replacing it');
});
check('blanks and duplicates are dropped, and entries are not renamed', () => {
  assert.deepStrictEqual(
    D.readHiddenTypes(fakeDb({ value_json: '["  why  ","why","","faq",null]' })), ['why', 'faq'],
    'the list is not normalised, so a stray space makes a type unhideable');
});

section('One rule, resolved the same way by everything that resolves it');
check('the menu reads the list ONCE PER REQUEST, not per product', () => {
  assert.ok(/qrBlockDefaults\.readHiddenTypes\(/.test(MENU_SRC),
    'routes/shop-menu.js never reads the default — the page still draws every block');
  const reads = [...MENU_SRC.matchAll(/readHiddenTypes\(/g)].length;
  assert.strictEqual(reads, 1,
    `${reads} reads of the default in routes/shop-menu.js — one per card is one query per tile`);
  // …and it is not read inside the per-product body.
  const body = MENU_SRC.slice(MENU_SRC.indexOf('function detailBody('),
                              MENU_SRC.indexOf('function detailBody(') + 4000);
  assert.ok(!/readHiddenTypes\(/.test(body),
    'detailBody reads the default itself — that is one query per product on the page');
});
check('the menu hands the list to pageBlocks rather than dropping it', () => {
  assert.ok(/pageBlocks\(it\.description_blocks,\s*qrHidden\)/.test(MENU_SRC),
    'the list is read and then not passed — pageBlocks would apply no default at all');
});
check('the admin config endpoint answers with the EFFECTIVE list', () => {
  assert.ok(/hiddenBlockTypes:\s*qrBlockDefaults\.readHiddenTypes\(/.test(ADMIN_SRC),
    'GET /api/retail-admin/config does not compute the effective default, so an unset ' +
    'tenant hands the product editor nothing and the editor must invent it');
});
check('NOBODY CARRIES A SECOND COPY OF THE SEED', () => {
  /* The list may be named once, in the module that owns it. A copy in the
     menu, the admin route or the editor agrees on the day it is written and
     drifts the first time somebody edits one of them — and the failure is
     invisible: the editor's eye says shown, the customer sees nothing. */
  const seedRe = /['"]notes_callout['"]/;
  for (const [name, src] of [['routes/shop-menu.js', MENU_SRC],
                             ['public/product-editor.html', EDITOR_SRC]]) {
    /* PA_SPINE in the editor is the section ORDER — the nine types the form
       lays out, which happens to contain both seed names. It is excised by
       NAME rather than skipped by shape, so a genuine copy that happened to
       sit on the same line as one of its entries still fails this. */
    const scrubbed = src.replace(/const PA_SPINE = \[[^\]]*\];/, '');
    const offenders = scrubbed.split('\n')
      .filter(l => seedRe.test(l) && /storage_box/.test(l));
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
  assert.ok(/paQrTypeHiddenByDefault\(b\.type\)/.test(head),
    'the editor falls back to something other than the default list');
});

section('The rule the whole change turns on, end to end');
check('a product nobody has touched follows the tenant default', () => {
  const untouched = [
    { type: 'hero_intro', body_en: 'Brewed slowly' },
    { type: 'storage_box', left: { head_en: 'Chill', num_en: '0–4°' } },
    { type: 'notes_callout', text_en: 'Stir before use.' },
  ];
  const hidden = D.readHiddenTypes(fakeDb(undefined));
  assert.deepStrictEqual(R.pageBlocks(untouched, hidden).map(b => b.type), ['hero_intro'],
    'the seed and the reader disagree — the two halves of the change do not meet');
});

console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
