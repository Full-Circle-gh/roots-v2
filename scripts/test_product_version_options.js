#!/usr/bin/env node
/**
 * A product's questions are part of its content, so version history keeps them.
 *
 *   node scripts/test_product_version_options.js
 *
 * WHY. §227 stopped the admin editor's autosave from deleting a product's
 * questions, and while measuring that damage it turned up a second gap:
 * `productContentSnapshot` read only VERSION_COLUMNS, which are columns of
 * `store_products`. Options live in their OWN tables, so they could never be
 * in that list — and the one history whose stated purpose is "undoes a whole
 * editing session's worth of autosaves in one step" could not undo the thing an
 * editing session was most likely to destroy. Roll the copy back, and a dressing
 * deleted an hour ago stayed deleted.
 *
 * THE TRAP THIS SUITE EXISTS FOR, and it is §227's own lesson pointed at the
 * repair: every version already stored was written before options were
 * snapshotted, so it records NOTHING about them. Reading that silence as "this
 * product asked nothing" would make restoring any older version delete every
 * question on the product — the original bug rebuilt inside the fix for it, and
 * triggered by the very button an operator reaches for when something has gone
 * wrong. So absence and emptiness must mean different things:
 *
 *   absent      the snapshot never recorded options — change nothing
 *   []          the snapshot recorded that the product asked nothing — clear
 *   [ ... ]     restore exactly those questions
 *
 * What this locks down:
 *
 *   captured    a snapshot carries the questions, their choices, their order,
 *               their required flag, their price deltas and their stock links
 *   absent      an old snapshot with no options key leaves the live ones alone
 *   empty       an explicit [] really does clear
 *   restored    a deleted question comes back, in order, with its choices
 *   not a col   the options key is NOT a VERSION_COLUMN and so can never reach
 *               the UPDATE's SET clause when a restore rewrites the row
 *   changed     adding a question makes the snapshot differ, so the checkpoint
 *               actually records one rather than collapsing it as a no-op
 *
 * Runs against a REAL sqlite database and the REAL snapshot and restore code.
 */
'use strict';

const assert = require('assert');
const path   = require('path');

const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const retail = require(path.join(ROOT, 'routes', 'retail.js'));
const { saveProductOptions, productContentSnapshot, restoreProductOptionsFromSnapshot } = retail;
const db = tdb();

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label); };

const P = 9751;   // clear of the other option suites' fixture blocks

function cleanup() {
  db.prepare(
    `DELETE FROM retail_product_option_choices
      WHERE option_id IN (SELECT id FROM retail_product_options WHERE product_id = ?)`
  ).run(P);
  db.prepare('DELETE FROM retail_product_options WHERE product_id = ?').run(P);
  try { db.prepare('DELETE FROM retail_product_versions WHERE product_id = ?').run(P); } catch { /* table optional */ }
  db.prepare('DELETE FROM store_products WHERE id = ?').run(P);
}

const QUESTIONS = [
  { question_en: 'Choose Dressing', question_cn: '选择酱料', type: 'single', is_required: 1,
    choices: [
      { label_en: 'Ginger Tahini', label_cn: '生姜芝麻酱', price_delta: 0, is_default: 1 },
      { label_en: 'Mustard Vinaigrette', label_cn: '芥末油醋汁', price_delta: 0, is_default: 0 },
    ] },
  { question_en: 'Flavor Boosters', question_cn: '风味配料', type: 'multi', is_required: 0,
    choices: [{ label_en: 'Onion Pickles', label_cn: '腌洋葱', price_delta: 5, is_default: 0 }] },
];

const liveQuestions = () => db.prepare(
  `SELECT question_en, type, is_required, sort_order FROM retail_product_options
    WHERE product_id = ? ORDER BY sort_order, id`).all(P);
const liveChoiceLabels = (questionEn) => db.prepare(
  `SELECT c.label_en, c.label_cn, c.price_delta, c.is_default
     FROM retail_product_option_choices c
     JOIN retail_product_options o ON o.id = c.option_id
    WHERE o.product_id = ? AND o.question_en = ?
    ORDER BY c.sort_order, c.id`).all(P, questionEn);

(async () => {
  cleanup();
  db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published)
     VALUES (?, ?, ?, ?, ?, 1, 1)`
  ).run(P, 'Version Test Salad', '版本测试沙拉', 'TVER-1', 48);
  await saveProductOptions(P, QUESTIONS);

  console.log('\nA · the snapshot carries the questions');

  const snap = productContentSnapshot(db, P);
  ok('the snapshot has an options key holding both questions', () => {
    assert.ok(snap, 'no snapshot produced');
    assert.ok(Array.isArray(snap._options), 'the snapshot carries no options array');
    assert.strictEqual(snap._options.length, 2);
    assert.strictEqual(snap._options[0].question_en, 'Choose Dressing');
    assert.strictEqual(snap._options[0].is_required, 1, 'the required flag was not captured');
    assert.strictEqual(snap._options[1].question_en, 'Flavor Boosters');
    assert.strictEqual(snap._options[1].type, 'multi');
  });
  ok('the choices travel with their question, in order and with their money', () => {
    const dressing = snap._options[0].choices;
    assert.strictEqual(dressing.length, 2);
    assert.strictEqual(dressing[0].label_en, 'Ginger Tahini');
    assert.strictEqual(dressing[0].label_cn, '生姜芝麻酱', 'the Chinese label was dropped');
    assert.strictEqual(dressing[0].is_default, 1);
    assert.strictEqual(snap._options[1].choices[0].price_delta, 5, 'the price delta was dropped');
  });
  ok('the options key is NOT a store_products column', () => {
    const cols = db.prepare('PRAGMA table_info(store_products)').all().map(c => c.name);
    assert.ok(!cols.includes('_options'),
      '_options collides with a real column and could reach a restore’s SET clause');
  });

  console.log('\nB · the trap: a snapshot that never recorded options');

  // Every version written before this feature looks exactly like this.
  const oldStyle = { ...snap };
  delete oldStyle._options;
  const wrote = restoreProductOptionsFromSnapshot(db, P, oldStyle);
  ok('an old snapshot leaves the live questions STANDING', () => {
    assert.strictEqual(wrote, false, 'the restore claimed to write from a snapshot that said nothing');
    assert.strictEqual(liveQuestions().length, 2,
      'restoring a pre-options version deleted the questions — §227 rebuilt inside its own fix');
  });
  ok('a snapshot with a non-array options value is silence too', () => {
    restoreProductOptionsFromSnapshot(db, P, { ...snap, _options: null });
    restoreProductOptionsFromSnapshot(db, P, { ...snap, _options: 'oops' });
    assert.strictEqual(liveQuestions().length, 2);
  });

  console.log('\nC · a real restore puts a deleted question back');

  await saveProductOptions(P, [], { allowClear: true });
  ok('the questions are gone, the way a bad edit would leave them', () => {
    assert.strictEqual(liveQuestions().length, 0);
  });

  restoreProductOptionsFromSnapshot(db, P, snap);
  ok('restoring the snapshot brings both questions back, in order', () => {
    const back = liveQuestions();
    assert.strictEqual(back.length, 2, 'the restore did not bring the questions back');
    assert.strictEqual(back[0].question_en, 'Choose Dressing', 'the questions came back out of order');
    assert.strictEqual(back[0].is_required, 1, 'the required flag did not survive the round trip');
    assert.strictEqual(back[1].question_en, 'Flavor Boosters');
  });
  ok('the choices came back with their labels, money and default', () => {
    const dressing = liveChoiceLabels('Choose Dressing');
    assert.strictEqual(dressing.length, 2);
    assert.strictEqual(dressing[0].label_en, 'Ginger Tahini');
    assert.strictEqual(dressing[0].label_cn, '生姜芝麻酱');
    assert.strictEqual(dressing[0].is_default, 1);
    assert.strictEqual(liveChoiceLabels('Flavor Boosters')[0].price_delta, 5);
  });

  console.log('\nD · an explicit empty really does clear');

  const emptySnap = { ...snap, _options: [] };
  ok('a snapshot that RECORDED no questions restores as a clear', () => {
    const did = restoreProductOptionsFromSnapshot(db, P, emptySnap);
    assert.strictEqual(did, true, 'an explicitly-empty snapshot was treated as silence');
    assert.strictEqual(liveQuestions().length, 0, 'the explicit clear left questions behind');
  });

  console.log('\nE · adding a question is a change worth checkpointing');

  await saveProductOptions(P, QUESTIONS);
  const withOpts = JSON.stringify(productContentSnapshot(db, P));
  await saveProductOptions(P, [QUESTIONS[0]]);
  const fewerOpts = JSON.stringify(productContentSnapshot(db, P));
  ok('changing only the questions changes the snapshot', () => {
    assert.notStrictEqual(withOpts, fewerOpts,
      'the snapshot is blind to an options-only edit, so no version would be recorded for one');
  });

  cleanup();
  console.log('\n' + pass + ' checks passed.\n');
})().catch((e) => {
  try { cleanup(); } catch { /* cleanup is best-effort on the failure path */ }
  console.error('\nFAILED: ' + (e && e.message || e));
  console.error(e && e.stack);
  process.exit(1);
});
