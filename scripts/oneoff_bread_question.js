#!/usr/bin/env node
/**
 * The bread question asks one thing in English and another in Chinese, and
 * accepts two answers to a question with one right answer.
 *
 *   node scripts/oneoff_bread_question.js          # prints the plan, writes nothing
 *   node scripts/oneoff_bread_question.js --apply  # write
 *
 * ── WHAT IS WRONG ──────────────────────────────────────────────────────────
 * Found while building §129 and confirmed by Ash — *"fix"* — after being
 * reported to him three times. On Garlic Dill Sour Cream Toast:
 *
 *   1. type = 'multi' under the question "Choose your bread", so a customer can
 *      tick BOTH breads for one toast. Reported by Ash from the live menu:
 *      "it let me choose both options." The picker was obeying the data.
 *   2. question_cn = 加点配料? — "Add extras?" — copied from the Apple Pie
 *      Overnight Oats question. A Chinese customer is asked a different
 *      question from the English one.
 *   3. Both answers have label_cn = NULL, so 中文 falls back to English and a
 *      Chinese customer reads "whole wheat rye" in Latin script.
 *
 * ── IT IS NOT KEYED ON THE OPTION ID, AND THAT IS THE WHOLE POINT ──────────
 * This repair was first written against option id 1346, which is what
 * scripts/diagnose_qr_menu_option_types.js read at 02:27. By 03:52 that id DID
 * NOT EXIST and the same question was id 1362 — the product editor deletes and
 * re-inserts a product's option rows when it saves, so every save renumbers
 * them. An UPDATE ... WHERE id = 1346 would have matched nothing, reported
 * success, and left the menu exactly as it was.
 *
 * So the target is the QUESTION, on the PRODUCT: an option group whose
 * question_en is "Choose your bread" belonging to a product named "Garlic Dill
 * Sour Cream Toast". Both are checked, the script REFUSES unless exactly one
 * group matches, and it refuses again unless that group's answers are the two
 * it expects. A repair that cannot find precisely what it was written for must
 * stop rather than improvise on whatever it did find.
 *
 * ── THE CHINESE ────────────────────────────────────────────────────────────
 * CLAUDE.md's 2026-09-06 amendment: copy a live pair, lift from the source,
 * then compose — and declare anything composed. scripts/diagnose_bread_question_strings.js
 * read the live catalogue for all three strings:
 *
 *   whole wheat rye       -> 全麦黑麦面包   COPIED. Product #352 "Hearty Rye &
 *                            Whole Wheat Bread", and option answers #1334,
 *                            #1795, #2240, #2545, #2953 carry it verbatim.
 *   gluten free buckwheat -> 无麸 荞麦面包   COPIED. Products #255 and #353
 *                            "Buckwheat Bread (GF, Sliced & Frozen)", and
 *                            option answers #1332, #1793, #2238, #2543, #2951.
 *   Choose your bread     -> 选择面包       COMPOSED, and declared in
 *                            docs/tacet-delivery-vocabulary.md v1.83 with the
 *                            candidates it beat.
 *
 * The two answers are the tenant's own names for these exact two breads, so
 * nothing is minted for either: a customer who has bought the loaf reads the
 * same words choosing it on a toast.
 *
 * ── IDEMPOTENT ─────────────────────────────────────────────────────────────
 * A second run finds the values already in place and reports nothing to do.
 *
 * NO BACKUP IS TAKEN HERE, DELIBERATELY. .github/workflows/oneoff.yml takes one
 * first on the apply path, through SQLite's online .backup API with an
 * integrity_check that aborts the run if it is not "ok". A byte copy from in
 * here would be torn — roots.db carries a live WAL.
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const WRITE = process.argv.includes('--apply');

const dbPath = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
if (!fs.existsSync(dbPath)) { console.error('DB not found at', dbPath); process.exit(1); }
const db = new Database(dbPath);

const Q_EN = 'Choose your bread';
const PRODUCT = 'Garlic Dill Sour Cream Toast';
const Q_CN = '选择面包';
const ANSWERS = [
  { en: 'whole wheat rye', cn: '全麦黑麦面包' },
  { en: 'gluten free buckwheat', cn: '无麸 荞麦面包' },
];

const q = (v) => JSON.stringify(v == null ? null : String(v));
const rule = (t) => console.log('\n' + '─'.repeat(78) + (t ? '\n' + t : ''));
const die = (m) => { console.error('\nREFUSED: ' + m); process.exit(1); };

console.log(`db: ${dbPath}`);
console.log(`mode: ${WRITE ? 'APPLY — this will write' : 'DRY RUN — nothing will be written'}`);

// ── find it by what it ASKS, never by an id ────────────────────────────────
const groups = db.prepare(`
  SELECT o.id, o.product_id, o.question_en, o.question_cn, o.type, o.is_required,
         COALESCE(p.name_en, p.name_cn) AS product
    FROM retail_product_options o
    LEFT JOIN store_products p ON p.id = o.product_id
   WHERE o.question_en = ?
     AND COALESCE(p.name_en, p.name_cn) = ?
`).all(Q_EN, PRODUCT);

rule('1 · what matched');
if (!groups.length) die(`no option group asks ${q(Q_EN)} on a product named ${q(PRODUCT)}. ` +
  'Nothing was written. If the question or the product has been renamed, this script must be ' +
  'updated rather than loosened.');
if (groups.length > 1) die(`${groups.length} option groups match, and this repair is written for ` +
  `one: ${groups.map(g => '#' + g.id).join(', ')}. Nothing was written.`);

const g = groups[0];
console.log(`  option #${g.id} on "${g.product}" (product #${g.product_id})`);
console.log(`    question_en ${q(g.question_en)}`);
console.log(`    question_cn ${q(g.question_cn)}`);
console.log(`    type        ${q(g.type)}   required=${g.is_required}`);

const choices = db.prepare(
  `SELECT id, label_en, label_cn, sort_order FROM retail_product_option_choices
    WHERE option_id = ? ORDER BY sort_order, id`).all(g.id);
console.log('  answers:');
for (const c of choices) console.log(`    #${c.id} en=${q(c.label_en)} cn=${q(c.label_cn)}`);

// ── refuse unless the answers are the two this was written for ─────────────
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
if (choices.length !== ANSWERS.length) {
  die(`the question has ${choices.length} answers and this repair names ${ANSWERS.length}. ` +
    'The Chinese below was chosen for these two breads specifically. Nothing was written.');
}
for (const a of ANSWERS) {
  if (!choices.some(c => norm(c.label_en) === norm(a.en))) {
    die(`no answer reads ${q(a.en)}. The answers have changed since the Chinese was chosen for ` +
      'them, and a translation applied to a different bread is worse than none. Nothing was written.');
  }
}

// ── the plan ───────────────────────────────────────────────────────────────
rule('2 · the plan');
const plan = [];
if (g.type !== 'single') {
  plan.push({
    what: `option #${g.id} type`, from: g.type, to: 'single',
    why: 'one toast has one bread; multi is what let a customer tick both',
  });
}
if (g.question_cn !== Q_CN) {
  plan.push({
    what: `option #${g.id} question_cn`, from: g.question_cn, to: Q_CN,
    why: 'it currently asks a different question from the English one',
  });
}
for (const a of ANSWERS) {
  const c = choices.find(x => norm(x.label_en) === norm(a.en));
  if (c.label_cn !== a.cn) {
    plan.push({
      what: `answer #${c.id} label_cn`, from: c.label_cn, to: a.cn,
      why: 'the tenant\'s own name for this exact bread, copied from the catalogue',
    });
  }
}
if (!plan.length) {
  console.log('  nothing to do — every value is already what this repair would set.');
  process.exit(0);
}
for (const p of plan) console.log(`  ${p.what}\n      ${q(p.from)}  ->  ${q(p.to)}\n      (${p.why})`);

if (!WRITE) {
  rule('');
  console.log('DRY RUN — nothing was written. Re-run with --apply to make these changes.');
  process.exit(0);
}

// ── write ──────────────────────────────────────────────────────────────────
rule('3 · writing');
const upOpt = db.prepare('UPDATE retail_product_options SET type = ?, question_cn = ? WHERE id = ?');
const upCh = db.prepare('UPDATE retail_product_option_choices SET label_cn = ? WHERE id = ?');
const run = db.transaction(() => {
  upOpt.run('single', Q_CN, g.id);
  for (const a of ANSWERS) {
    const c = choices.find(x => norm(x.label_en) === norm(a.en));
    upCh.run(a.cn, c.id);
  }
});
run();

// ── read it back, because a write that was not checked is a claim ──────────
rule('4 · read back');
const after = db.prepare('SELECT type, question_en, question_cn FROM retail_product_options WHERE id = ?').get(g.id);
console.log(`  option #${g.id} type=${q(after.type)} en=${q(after.question_en)} cn=${q(after.question_cn)}`);
let bad = 0;
if (after.type !== 'single') { console.error('  !! type did not take'); bad++; }
if (after.question_cn !== Q_CN) { console.error('  !! question_cn did not take'); bad++; }
for (const c of db.prepare(
  `SELECT id, label_en, label_cn FROM retail_product_option_choices
    WHERE option_id = ? ORDER BY sort_order, id`).all(g.id)) {
  console.log(`    #${c.id} en=${q(c.label_en)} cn=${q(c.label_cn)}`);
  const want = ANSWERS.find(a => norm(a.en) === norm(c.label_en));
  if (want && c.label_cn !== want.cn) { console.error(`    !! #${c.id} label_cn did not take`); bad++; }
}
rule('');
if (bad) { console.error(`FAILED — ${bad} value(s) did not take.`); process.exit(1); }
console.log('APPLIED — every value read back as written.');
