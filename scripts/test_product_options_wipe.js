#!/usr/bin/env node
/**
 * A save that does not mention a product's questions must not delete them.
 *
 *   node scripts/test_product_options_wipe.js
 *
 * WHAT WENT WRONG, because the shape of it is the reason every case below
 * exists. `saveProductOptions` is replace-all: it deletes every option row for
 * a product and re-inserts whatever it was handed. An EMPTY list therefore did
 * not mean "change nothing", it meant "delete everything and put nothing back",
 * and the product went on asking nothing until a human noticed and retyped the
 * questions by hand.
 *
 * The admin editor handed it that empty list by accident. `OPT` starts empty and
 * is filled by an async fetch, the editor AUTOSAVES on a debounce, and the send
 * was gated on OPT_ID — which is set the instant the product opens, before the
 * fetch lands. Open a product, type one character, and the autosave could carry
 * `options: []` for a product whose questions had simply not arrived yet. A
 * failed fetch was worse: `.catch(() => {})` swallowed it, so OPT stayed empty
 * for the whole editing session and every save wiped again.
 *
 * THE DAMAGE IS MEASURED, NOT FEARED. Of the 157 option rows customers have
 * answered on a real order, 134 no longer exist, across 39 products. Beet Salad's
 * "Choose Dressing" was destroyed and rebuilt SEVEN times. Tabbouleh Bowl lost
 * its paid extras on 16 August and did not get them back until 21 September —
 * 43 paid lines went out in that window with nobody ever offered the extras.
 *
 * What this locks down:
 *
 *   the refusal    an empty list against a product that HAS questions is a
 *                  no-op, not a deletion — the guard is at the writer, so it
 *                  holds for every caller and not just the one that broke
 *   the intent     options_clear is the way to mean it, and it still works;
 *                  removing your last question is a decision and must stay
 *                  possible, it just has to be said rather than implied
 *   the create     a product with no questions falls straight through, because
 *                  there is nothing to protect and a create must not have to
 *                  ask permission to write nothing
 *   the normal     a non-empty list still replaces wholesale, unchanged
 *   the route      the PATCH handler forwards options_clear rather than
 *                  hard-coding either answer
 *   the editor     the client gates on OPT_LOADED, resets it per product, and
 *                  will not open the panel over options it has not read — the
 *                  server guard alone would leave the editor still sending
 *                  empties, which is a fixed symptom and a live cause
 *
 * Runs against a REAL sqlite database and the REAL writer.
 */
'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const retail = require(path.join(ROOT, 'routes', 'retail.js'));
const { saveProductOptions } = retail;
const db = tdb();

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label); };

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids, clear of the other option suites' fixture blocks.
const P_ASKS  = 9741;   // carries two questions throughout
const P_BARE  = 9742;   // never has any — the create case

const IDS = [P_ASKS, P_BARE];

function cleanup() {
  const ph = IDS.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM retail_product_option_choices
      WHERE option_id IN (SELECT id FROM retail_product_options WHERE product_id IN (${ph}))`
  ).run(...IDS);
  db.prepare(`DELETE FROM retail_product_options WHERE product_id IN (${ph})`).run(...IDS);
  db.prepare(`DELETE FROM store_products WHERE id IN (${ph})`).run(...IDS);
}

function seedProducts() {
  const ins = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published)
     VALUES (?, ?, ?, ?, ?, 1, 1)`);
  ins.run(P_ASKS, 'Wipe Test Salad', '测试沙拉', 'TWIPE-1', 48);
  ins.run(P_BARE, 'Wipe Test Shelf Item', '测试货架品', 'TWIPE-2', 12);
}

// The two questions the salad asks, in the shape the editor posts.
const TWO_QUESTIONS = [
  { question_en: 'Choose Dressing', question_cn: '选择酱料', type: 'single', is_required: 1,
    choices: [
      { label_en: 'Ginger Tahini', label_cn: '生姜芝麻酱', price_delta: 0, is_default: 1 },
      { label_en: 'Mustard Vinaigrette', label_cn: '芥末油醋汁', price_delta: 0, is_default: 0 },
    ] },
  { question_en: 'Flavor Boosters', question_cn: '风味配料', type: 'multi', is_required: 0,
    choices: [{ label_en: 'Onion Pickles', label_cn: '腌洋葱', price_delta: 5, is_default: 0 }] },
];

const liveOptions = (pid) => db.prepare(
  'SELECT id, question_en, type, is_required FROM retail_product_options WHERE product_id = ? ORDER BY id'
).all(pid);
const liveChoices = (pid) => db.prepare(
  `SELECT COUNT(*) AS n FROM retail_product_option_choices
    WHERE option_id IN (SELECT id FROM retail_product_options WHERE product_id = ?)`
).get(pid).n;

(async () => {
  cleanup();
  seedProducts();

  console.log('\nA · the writer');

  await saveProductOptions(P_ASKS, TWO_QUESTIONS);
  const seeded = liveOptions(P_ASKS);
  ok('a real list writes both questions', () => {
    assert.strictEqual(seeded.length, 2, 'expected two questions after the seeding save');
    assert.strictEqual(seeded[0].question_en, 'Choose Dressing');
    assert.strictEqual(seeded[0].is_required, 1);
    assert.strictEqual(liveChoices(P_ASKS), 3, 'expected three choices across the two questions');
  });

  // THE CASE THAT COST THE MONEY. An autosave from an editor whose fetch had not
  // landed posted exactly this, and it used to delete both rows.
  await saveProductOptions(P_ASKS, []);
  ok('an empty list leaves existing questions STANDING', () => {
    const after = liveOptions(P_ASKS);
    assert.strictEqual(after.length, 2, 'an empty list deleted the questions — the wipe is back');
    assert.deepStrictEqual(after.map(o => o.id), seeded.map(o => o.id),
      'the rows were replaced rather than left alone; ids must not churn on a no-op');
    assert.strictEqual(liveChoices(P_ASKS), 3, 'the choices were destroyed under surviving questions');
  });

  // Same for the shapes that arrive as "nothing" without being an array.
  await saveProductOptions(P_ASKS, null);
  await saveProductOptions(P_ASKS, undefined);
  ok('null and undefined are silence too, not deletion', () => {
    assert.strictEqual(liveOptions(P_ASKS).length, 2);
  });

  // A list whose entries are all junk sanitises down to empty, and empty is
  // still silence — a payload of blank rows is not a decision to delete.
  await saveProductOptions(P_ASKS, [{ question_en: '', question_cn: '', choices: [] }]);
  ok('a list that sanitises down to nothing is silence, not deletion', () => {
    assert.strictEqual(liveOptions(P_ASKS).length, 2);
  });

  console.log('\nB · clearing, which must stay possible');

  await saveProductOptions(P_ASKS, [], { allowClear: true });
  ok('options_clear really does clear', () => {
    assert.strictEqual(liveOptions(P_ASKS).length, 0, 'an explicit clear left questions behind');
    assert.strictEqual(liveChoices(P_ASKS), 0, 'an explicit clear left orphan choices behind');
  });

  console.log('\nC · the create case');

  await saveProductOptions(P_BARE, []);
  ok('an empty list against a product with none is a harmless no-op', () => {
    assert.strictEqual(liveOptions(P_BARE).length, 0);
  });

  console.log('\nD · a real list still replaces wholesale');

  await saveProductOptions(P_ASKS, TWO_QUESTIONS);
  const first = liveOptions(P_ASKS).map(o => o.id);
  await saveProductOptions(P_ASKS, [TWO_QUESTIONS[0]]);
  ok('a non-empty list replaces, and the replaced rows are gone', () => {
    const after = liveOptions(P_ASKS);
    assert.strictEqual(after.length, 1, 'expected the single posted question');
    assert.strictEqual(after[0].question_en, 'Choose Dressing');
    assert.ok(!first.includes(after[0].id) || first.length === 1,
      'replace-all should have written a fresh row');
    assert.strictEqual(liveChoices(P_ASKS), 2, 'expected only the dressing choices to survive');
  });

  console.log('\nE · the route forwards the intent');

  const routeSrc = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
  ok('the PATCH handler passes options_clear through rather than deciding for itself', () => {
    assert.ok(
      /saveProductOptions\(\s*id,\s*body\.options,\s*\{\s*allowClear:\s*body\.options_clear\s*===\s*true\s*\}\s*\)/.test(routeSrc),
      'the product PATCH no longer forwards options_clear to saveProductOptions');
  });
  ok('the writer still refuses an unintended empty list', () => {
    assert.ok(/if \(!clean\.length && !allowClear\)/.test(routeSrc),
      'the refusal guard in saveProductOptions is gone');
  });

  console.log('\nF · the editor, which is where the empty list came from');

  const adminSrc = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '09-products.js'), 'utf8');
  ok('the save gates on OPT_LOADED, not on OPT_ID alone', () => {
    assert.ok(/OPT_ID === Number\(id\) && OPT_LOADED/.test(adminSrc),
      'the options send is gated on OPT_ID alone again — the autosave race is back');
  });
  ok('OPT_LOADED is reset per product, with the list', () => {
    assert.ok(/OPT_LOADED = false; OPT_LOADED_N = 0; OPT_LOAD_FAILED = false;/.test(adminSrc),
      'optLoad no longer resets the loaded flag, so one product can be saved under another’s state');
  });
  ok('OPT_LOADED is set only when the payload really parsed', () => {
    assert.ok(/OPT_LOADED = !!\(j && j\.success && j\.data\);/.test(adminSrc),
      'the loaded flag no longer keys on the response parsing');
  });
  ok('a failed load is recorded rather than swallowed', () => {
    assert.ok(/OPT_LOAD_FAILED = true;[\s\S]{0,80}optRender\(\);[\s\S]{0,20}\}\);/.test(adminSrc),
      'the options fetch swallows its error again, so a failed load looks like "no options"');
  });
  ok('options_clear is sent only when the load found some and they were removed', () => {
    assert.ok(/if \(!body\.options\.length && OPT_LOADED_N > 0\) body\.options_clear = true;/.test(adminSrc),
      'the editor no longer distinguishes "I removed the last one" from "there were never any"');
  });
  ok('the panel will not open over options that were never read', () => {
    assert.ok(/function optToggle\(\) \{ if \(!OPT_LOADED\) return;/.test(adminSrc),
      'the options panel opens before the load lands, inviting edits the save cannot send');
  });

  cleanup();
  console.log('\n' + pass + ' checks passed.\n');
})().catch((e) => {
  try { cleanup(); } catch { /* cleanup is best-effort on the failure path */ }
  console.error('\nFAILED: ' + (e && e.message || e));
  console.error(e && e.stack);
  process.exit(1);
});
