#!/usr/bin/env node
/**
 * §118 — the Operations menu is entered by the job, in the operator's own words.
 *
 *   node scripts/test_mobile_ask_strip.js
 *
 * THE BRIEF THIS PINS, from Ash: "it's not clear for any account every feature
 * of operation." Twenty-two rows under one heading, labelled with bare nouns.
 * Two options were drawn (docs/tacet-operations-clarity-options.md); Ash chose
 * B — plain questions above the list — over A, the grouping.
 *
 * WHAT CAN GO WRONG HERE IS ALL QUIET, and each has a case:
 *
 *   • THE STRIP MUST NOT BECOME A SECOND MENU. It resolves each destination
 *     through the More row, so it can never offer a screen the list below does
 *     not, and a later rename moves both. A question carrying its own copy of a
 *     label is the drift this whole file exists to stop.
 *   • A QUESTION WHOSE SCREEN WOULD 403 IS A TRAP, not a shortcut. The gate is
 *     the row's presence in moreRowsFlat() — already capability-filtered — plus
 *     the Features switch, which presence alone does not cover.
 *   • IT MUST BE PUTTABLE-BACK, FOR GOOD. Seven questions above twenty-two rows
 *     pushes the list a screen down for somebody who has known it for a year.
 *   • THE TWO ARRIVING-GOODS QUESTIONS MUST STAY TWO. Collapsing them to one
 *     "Something arrived" reintroduces a chooser between two rows that both
 *     read 收货 — the one pair this strip exists to separate.
 *   • THE ROWS BELOW MUST NOT HAVE MOVED. B adds a way in; option A is still
 *     undecided, and MORE_GROUPS is read here, never rewritten.
 *
 * READS ONLY — no browser, so this runs in the FAST shard and is part of the
 * gate. A render pass would belong in the slow shard, which this repo does not
 * run, and a test that cannot run protects nothing.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const MHTML = read('public', 'm.html');

// The strip's own source, sliced out so a match cannot come from elsewhere.
// Bounded to the strip's OWN source. An end marker of `function screenMore()`
// was tried and is wrong: seven hundred lines of other screens sit between the
// two, and the icon case passed a `rowico` it found in one of them.
const STRIP = MHTML.slice(MHTML.indexOf('const M_ASK_KEY'),
  MHTML.indexOf('/* One source for setup progress'));
const TASKS = MHTML.slice(MHTML.indexOf('const ASK_TASKS=['), MHTML.indexOf('function askTasks()'));
const MORE = MHTML.slice(MHTML.indexOf('function screenMore()'), MHTML.indexOf('/* ====', MHTML.indexOf('function screenMore()')));

let n = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); n++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

console.log('\n§118 — the questions above the Operations list');

it('seven questions, and every one names a row MORE_GROUPS actually has', () => {
  const keys = [...TASKS.matchAll(/\['([a-z]+)',\s*\[/g)].map(m => m[1]);
  assert.strictEqual(keys.length, 7, `expected seven questions, found ${keys.length}`);
  const groups = MHTML.slice(MHTML.indexOf('const MORE_GROUPS=['), MHTML.indexOf('function moreGroups()'));
  for (const k of keys) {
    assert.ok(new RegExp(`\\['${k}','`).test(groups),
      `${k} is asked about but has no MORE_GROUPS row — the strip would offer a screen the list does not`);
  }
});

it('the destination label is READ FROM THE ROW, never copied into the table', () => {
  /* The load-bearing assertion in this file. If a question carried its own
     label, adopting option A's renames later would leave the strip saying
     "Receiving" over a row that now says "Receive from a supplier". */
  assert.match(STRIP, /rows\[t\[0\]\]/,
    'askTasks no longer resolves the row — a question may be carrying its own label');
  assert.match(STRIP, /T\(t\.dest\.en,\s*t\.dest\.zh\)/,
    'the second line no longer renders the ROW\'s label');
  // And no question in the table may carry an English row name of its own.
  for (const label of ['Receiving', 'Receive delivery', 'Ask for stock', 'Waste', 'Expense',
                       'Ask the kitchen', 'Ask to buy']) {
    assert.ok(!TASKS.includes(`'${label}'`),
      `the table restates the row label "${label}" instead of reading it`);
  }
});

it('the gate is the row\'s presence, plus the Features switch presence cannot cover', () => {
  assert.match(STRIP, /moreRowsFlat\(\)/,
    'the strip no longer builds from moreRowsFlat — its capability filter is gone');
  assert.match(STRIP, /!t\[2\]\|\|featOn\(t\[2\]\)/,
    'the Features gate is gone: a row can be reachable while its module is off');
  assert.match(TASKS, /'askbuy',.*'production'/s,
    'askbuy must keep the `production` gate its own MORE_GROUPS row carries');
});

it('askbuy is the only question with a module gate, as only its row has one', () => {
  const gated = [...TASKS.matchAll(/\['([a-z]+)',\s*\[[^\]]*\],\s*'([a-z]+)'\]/g)].map(m => m[1]);
  assert.deepStrictEqual(gated, ['askbuy'],
    `only askbuy's row is Features-gated; these questions claim a gate: ${gated.join(', ')}`);
});

it('the two arriving-goods questions stay two, and say which is which', () => {
  assert.ok(/Something arrived from a supplier/.test(TASKS),
    'the supplier half is gone — one "Something arrived" needs a chooser between two 收货 rows');
  assert.ok(/Something arrived from another shop/.test(TASKS),
    'the transfer half is gone');
  assert.ok(/receiving/.test(TASKS) && /receivexfer/.test(TASKS),
    'both destinations must be named, or the distinction is not actually offered');
});

it('it collapses, and the choice outlives the launch', () => {
  assert.match(STRIP, /const M_ASK_KEY='tacet-m-ask'/, 'the preference key moved');
  assert.match(STRIP, /localStorage\.getItem\(M_ASK_KEY\)/, 'the choice is no longer read back');
  assert.match(STRIP, /localStorage\.setItem\(M_ASK_KEY/, 'the choice is no longer stored');
  assert.match(STRIP, /reg\('toggleAsk'/, 'there is no way to collapse it');
  // A failed read must leave it OPEN: a new account is who this is for.
  const fn = STRIP.slice(STRIP.indexOf('function askOpen()'), STRIP.indexOf("reg('toggleAsk'"));
  assert.match(fn, /let v=true/, 'a phone that cannot read localStorage must still be shown the questions');
  assert.match(fn, /catch\(e\)\{\}/, 'an unreadable localStorage must not throw out of the render');
});

it('state.askOpen is declared in the state literal, not conjured at runtime', () => {
  /* THIS CASE EXISTS BECAUSE THE FAST SHARD MISSED IT. `askOpen()` set
     state.askOpen lazily without the literal declaring it; the only thing that
     caught it was test_mobile_screens.js's static state-key guard — which lives
     in the slow shard, and this repo does not run the slow shard. A defect
     findable only there is a defect that ships. */
  /* The literal runs well past `stack:[]`, and askOpen sits beside `quick`
     some sixty keys in, so the window has to be wide enough to reach it. */
  const wider = MHTML.slice(MHTML.indexOf('tab:\'home\''), MHTML.indexOf('tab:\'home\'') + 6000);
  assert.ok(/\baskOpen\s*:/.test(wider),
    'state.askOpen is read but never declared in the state literal — the slow shard would fail on this');
  assert.ok(/askOpen:null/.test(wider),
    'declared, but not as null — the lazy read in askOpen() depends on it being nullish at boot');
});

it('a question row carries no icon — two layers must not read as one list', () => {
  const row = STRIP.slice(STRIP.indexOf('function askStripHtml()'));
  assert.ok(!/rowico/.test(row), 'a question row has gained an icon well');
  assert.ok(/ic\('chevron-right'\)/.test(row), 'the chevron is the one glyph it should have');
  assert.ok(/<div class="sep"><\/div>/.test(row),
    'the separator must run full width here; the inset 62px one belongs to the icon rows');
});

it('it mounts above the groups and below the setup card', () => {
  const strip = MORE.indexOf('${askStripHtml()}');
  const groups = MORE.indexOf('${groups.map(');
  const setup = MORE.indexOf('Open your store');
  assert.ok(strip > 0, 'screenMore no longer renders the strip');
  assert.ok(strip < groups, 'the questions must come before the twenty-two rows');
  assert.ok(setup > 0 && setup < strip, 'the owner\'s setup checklist still comes first');
});

it('B moved no row, and the 收货 collision it left open is now CLOSED', () => {
  /* When this case was written the collision was open and this assertion was a
     reminder to re-read §118. §119 closed it — the rename option A proposed,
     adopted on its own — so the guard is inverted: what it protects now is that
     the two flows never share a name again, in either language. */
  const groups = MHTML.slice(MHTML.indexOf('const MORE_GROUPS=['), MHTML.indexOf('function moreGroups()'));
  /* §121 split the one Operations entry into eight, so "the Operations rows"
     is now everything from the first of them to Marketing. Sliced by the FIRST
     GROUP'S HEADING rather than by a count of groups, so adding a ninth does
     not silently narrow what this counts. */
  const ops = groups.slice(groups.indexOf("h:['Take an order'"), groups.indexOf("h:['Marketing'"));
  /* TWENTY-THREE SINCE 2026-09-17: `recipes` (§164's read-only screen) was added
     to Making things. This assertion is a guard against §118's strip QUIETLY
     MOVING a row, so it moves when a row is deliberately added and not
     otherwise. scripts/test_mobile_ops_groups.js holds the set by name. */
  assert.strictEqual((ops.match(/\['[a-z]+','[a-z-]+',/g) || []).length, 23,
    'the Operations rows no longer number twenty-three across the eight groups (§121)');

  const row = (k) => {
    const m = new RegExp(`\\['${k}','[a-z-]+','([^']+)','([^']+)'`).exec(ops);
    assert.ok(m, `no ${k} row in Operations`);
    return { en: m[1], zh: m[2] };
  };
  const sup = row('receiving'), xfr = row('receivexfer');
  assert.notStrictEqual(sup.en, xfr.en, 'the two receiving rows share an English name again');
  assert.notStrictEqual(sup.zh, xfr.zh, 'the two receiving rows share a Chinese name again — this is the 收货 collision');
  assert.strictEqual(sup.zh, '收货', '收货 stays with the supplier flow, where 48 other uses put it');
  assert.strictEqual(xfr.zh, '调拨收货', 'the transfer flow keeps the pair live in its own error copy');

  /* The extent, not just the row: both screen titles and the three buttons
     where the transfer screen wore the supplier row's name. A finding filed as
     one line is where it was found, not how far it went. */
  assert.ok(/SUBS\.receiving=\{title:\['Receive from a supplier','收货'\]/.test(MHTML),
    'the supplier screen title no longer matches its row');
  assert.ok(/SUBS\.receivexfer=\{title:\['Receive from another shop','调拨收货'\]/.test(MHTML),
    'the transfer screen title no longer matches its row');
  const xs = MHTML.slice(MHTML.indexOf('function screenReceiveTransfer()'), MHTML.indexOf('function screenPick()'));
  assert.ok(!/T\('Receiving','收货'\)/.test(xs),
    'the transfer screen is calling itself by the supplier row\'s name again');
  assert.strictEqual((xs.match(/调拨收货/g) || []).length, 2,
    'both of the transfer screen\'s back rows should name the transfer flow');
  assert.ok(/T\('Back to the count','返回清点'\)/.test(xs),
    'the step-back button should name the step it returns to, not the screen');
});

it('Delivery says it is settings, because that is what it is', () => {
  const groups = MHTML.slice(MHTML.indexOf('const MORE_GROUPS=['), MHTML.indexOf('function moreGroups()'));
  assert.ok(/\['delivery','truck','Delivery settings','配送设置'\]/.test(groups),
    'the Delivery row no longer says settings — it is zones, holiday mode and a printer, the one config screen in the list');
  assert.ok(/delivery:\{title:\['Delivery settings','配送设置'\]/.test(MHTML),
    'the row and the screen it opens must not disagree');
});

it('§118 — the terms the composed questions were built from are still live', () => {
  /* House rule for a composed pair: say where its Chinese came from and FAIL if
     that source stops being live, so a rename cannot quietly orphan it.
     Declared in docs/tacet-delivery-vocabulary.md v1.75. */
  assert.ok(/'Restock needed','需要补货'/.test(MHTML),
    '需要补货 is taken WHOLE from this pair — it must stay live');
  assert.ok(/其他地点发来的货会显示在这里/.test(MHTML),
    '其他地点发来的货 is lifted from the transfer screen\'s empty state');
  assert.ok(/'My own money','个人支付'/.test(MHTML),
    '个人支付 is lifted from the expense screen\'s who-paid row');
  assert.ok(/'Kitchen queue','厨房制作队列'/.test(MHTML), '厨房制作 is lifted from this row label');
  assert.ok(/'Record waste','记录损耗'/.test(MHTML), '损耗 is lifted from the waste screen');
  assert.ok(/'Purchasing','采购'/.test(MHTML) && /供应商/.test(MHTML),
    '采购 and 供应商 are both live, and the buying question is built from them');
  assert.ok(/'Hide the work ▴','收起明细 ▴'/.test(MHTML),
    '收起 / 查看 and the ▴▾ convention are copied from this live collapse pair');
});

console.log(`\nok — ${n} §118 ask-strip checks.`);
