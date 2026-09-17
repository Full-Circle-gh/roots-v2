#!/usr/bin/env node
/**
 * §121 — Operations, in eight groups, with three pills.
 *
 *   node scripts/test_mobile_ops_groups.js
 *
 * Option A, chosen by Ash after §118's strip and §119's renames had shipped.
 * The grouping is what disambiguates: every pair that read as one row now sits
 * in a different group from its twin, so no row needed a subtitle.
 *
 * WHAT CAN GO WRONG, and each has a case:
 *
 *   • A CONFUSABLE PAIR DRIFTING BACK INTO ONE GROUP. That is the whole
 *     mechanism. If Purchasing and Ask to buy ever share a heading, the
 *     grouping has stopped doing the only job it was built for.
 *   • A ROW LOST OR DUPLICATED IN THE SPLIT. Twenty-two rows went in; the same
 *     twenty-two, by key, must come out — a regroup is a move, not an edit.
 *   • THE PILL BECOMING A COLUMN. Three values, and no pill is the default. A
 *     pill on most rows is a column and reads as noise.
 *   • A PILL ON A ROW THAT DOES NOT EARN IT, or missing from one that does.
 *   • THE PILL SPENDING A RESERVED COLOUR. Sage means all-clear, Amber warns,
 *     Dusk means the AI did it. A direction is a fact, so it is neutral.
 *
 * READS ONLY — no browser, so this runs in the FAST shard and is part of the
 * gate. Its sibling test_mobile_ask_strip.js covers §118's strip.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MHTML = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');

const ALL = MHTML.slice(MHTML.indexOf('const MORE_GROUPS=['), MHTML.indexOf('function moreGroups()'));
// The eight Operations groups: the first of them through to Marketing.
const OPS = ALL.slice(ALL.indexOf("{h:['Take an order'"), ALL.indexOf("{h:['Marketing'"));
const PILLS = MHTML.slice(MHTML.indexOf('const ROW_PILL={'), MHTML.indexOf('function moreRow(r)'));

/** [heading, [row keys…]] for each Operations group, in file order. */
function groups() {
  const out = [];
  const re = /\{h:\['([^']+)','([^']+)'\],rows:\[/g;
  let m;
  const heads = [];
  while ((m = re.exec(OPS))) heads.push({ en: m[1], zh: m[2], at: m.index });
  heads.forEach((h, i) => {
    const body = OPS.slice(h.at, i + 1 < heads.length ? heads[i + 1].at : OPS.length);
    out.push({ en: h.en, zh: h.zh, keys: [...body.matchAll(/\['([a-z]+)','[a-z-]+',/g)].map((x) => x[1]) });
  });
  return out;
}

let n = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); n++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

console.log('\n§121 — Operations in eight groups, and the three pills');

it('eight groups, each with a heading in both languages', () => {
  const g = groups();
  assert.strictEqual(g.length, 8, `expected eight Operations groups, found ${g.length}`);
  for (const x of g) {
    assert.ok(x.en && x.zh, `group ${x.en} is missing a language`);
    assert.ok(!/^[a-z]/.test(x.en), `group heading "${x.en}" should read as a sentence, not a key`);
    assert.ok(x.keys.length >= 1, `group ${x.en} has no rows`);
  }
});

/* TWENTY-THREE SINCE 2026-09-17, and the count moved for the one reason it may:
   a row was ADDED, not lost, duplicated or swapped. `recipes` (§164's read-only
   screen) joins Making things beside the kitchen queue and the batch log. The
   set below is what actually guards this — a count alone would pass a rename —
   so the number and the names move together or not at all. */
it('the same rows came out as went in — a regroup is a move, not an edit', () => {
  const keys = groups().flatMap((g) => g.keys);
  assert.strictEqual(keys.length, 23, `expected 23 Operations rows, found ${keys.length}`);
  assert.strictEqual(new Set(keys).size, 23, 'a row key appears in two groups');
  /* Named in full rather than counted, so a row SWAPPED for another still
     fails. A count alone would pass a rename of the set. */
  const expected = ['neworder', 'till', 'sales', 'trend', 'invoices', 'pick', 'delivery',
    'purchasing', 'receiving', 'receivexfer', 'stockapp', 'kitchenqueue', 'logbatch',
    'askkitchen', 'askstock', 'askbuy', 'kitchenready', 'waste', 'expense', 'approvals',
    'inbox', 'channelsync', 'recipes'];
  assert.deepStrictEqual([...keys].sort(), [...expected].sort(),
    'the set of Operations rows changed, not just their grouping');
});

it('the three ask-pairs are separated BY THE GROUPING, each one named', () => {
  /* WRITTEN AS "grouping OR pill" FIRST, AND THAT GUARD DID NOT GUARD. Every
     one of these pairs has a pill on one side, so the OR was satisfied by the
     pill every time and the grouping half never bit — moving Ask to buy back
     beside Purchasing passed. Red-proofing is what found it. §119 recorded the
     same lesson about a label-shaped guard; this is its shape for an OR.
     So each pair is now named with the mechanism that actually carries it. */
  const g = groups();
  const groupOf = (k) => {
    const hit = g.find((x) => x.keys.includes(k));
    assert.ok(hit, `${k} is in no group`);
    return hit.en;
  };
  const pairs = [
    ['purchasing', 'askbuy', 'you order from a supplier / the kitchen asks you to'],
    ['stockapp', 'askstock', 'you add what is here / you ask another shop to send some'],
    ['kitchenqueue', 'askkitchen', 'what the kitchen must make / placing the request'],
  ];
  for (const [a, b, why] of pairs) {
    assert.notStrictEqual(groupOf(a), groupOf(b),
      `${a} and ${b} are back under one heading ("${groupOf(a)}") — ${why}`);
  }
});

it('Expense and Approvals stay together, and the pill is their ONLY separator', () => {
  /* The one cluster the grouping deliberately does not carry. They are two ends
     of ONE feature, so a shared heading is right; what separates them is the
     mark saying one of them is somebody else's work. Both halves asserted, so
     neither can go quietly. */
  const g = groups();
  const groupOf = (k) => g.find((x) => x.keys.includes(k)).en;
  const pillOf = (k) => {
    const m = new RegExp(`\\b${k}:\\['([A-Z][a-z]+)'`).exec(PILLS);
    return m ? m[1] : null;
  };
  assert.strictEqual(groupOf('expense'), groupOf('approvals'),
    'these two are ends of one feature and belong under one heading');
  assert.strictEqual(pillOf('approvals'), 'Approve',
    'Approvals has lost its pill — under a shared heading it now reads as a second Expense');
  assert.strictEqual(pillOf('expense'), null,
    'Expense has gained a pill; then both are marked and neither is distinguished');
});

it('the two receiving rows stay together, because their names now differ', () => {
  /* §119 renamed them. Side by side under one heading the two names ARE the
     difference and can be read in one glance — asserted so a later session
     does not "fix" them apart and lose that. */
  const g = groups();
  const groupOf = (k) => g.find((x) => x.keys.includes(k)).en;
  assert.strictEqual(groupOf('receiving'), groupOf('receivexfer'),
    'the two receiving rows have been split apart; §121 keeps them adjacent on purpose');
  assert.strictEqual(groupOf('receiving'), 'Stock coming in',
    'both belong under the heading for goods arriving');
});

it('Ready from the kitchen sits with the asks, where its own gate puts it', () => {
  const g = groups();
  const home = g.find((x) => x.keys.includes('kitchenready'));
  assert.ok(home, 'kitchenready is in no group');
  assert.strictEqual(home.en, 'Ask someone else',
    'kitchenready is the REQUESTER\'s side — ROUTE_CAP gates it on restock:request|pick, '
    + 'not on fulfil — so it does not belong with the kitchen\'s own tools');
  assert.ok(!g.find((x) => x.en === 'Making things').keys.includes('kitchenready'),
    'kitchenready has drifted back into Making things; read ROUTE_CAP\'s note on it first');
});

it('three pill values, and no pill is the default', () => {
  const vals = [...PILLS.matchAll(/\['([A-Z][a-z]+)','([^']+)'\]/g)];
  const en = [...new Set(vals.map((m) => m[1]))].sort();
  assert.deepStrictEqual(en, ['Approve', 'Ask', 'Settings'],
    `expected exactly Approve / Ask / Settings, found ${en.join(' / ')}`);
  const keys = [...PILLS.matchAll(/^\s*([a-z]+):\[/gm)].map((m) => m[1])
    .concat([...PILLS.matchAll(/[,{]\s*([a-z]+):\[/g)].map((m) => m[1]));
  const pilled = new Set(keys);
  assert.ok(pilled.size <= 6,
    `${pilled.size} of 23 rows carry a pill — past a handful it is a column, not a mark`);
});

it('the pill is on the rows that earn it, and on no others', () => {
  for (const k of ['askkitchen', 'askstock', 'askbuy']) {
    assert.ok(new RegExp(`${k}:\\['Ask','申请'\\]`).test(PILLS), `${k} should wear the Ask pill`);
  }
  assert.ok(/approvals:\['Approve','审批'\]/.test(PILLS), 'Approvals should say it is someone else\'s work');
  assert.ok(/delivery:\['Settings','设置'\]/.test(PILLS), 'Delivery settings should say it is not a job');
  /* The rows most likely to be given one next, and the reason not to: each is
     a thing the operator simply does, which is what "no pill" means. */
  for (const k of ['waste', 'expense', 'pick', 'receiving', 'receivexfer', 'kitchenready', 'logbatch']) {
    assert.ok(!new RegExp(`\\b${k}:\\[`).test(PILLS),
      `${k} has gained a pill — a row you simply do wears nothing, or the pill stops being readable`);
  }
});

it('the pill spends no reserved colour', () => {
  const render = MHTML.slice(MHTML.indexOf('${r.pill?'), MHTML.indexOf('${r.pill?') + 400);
  assert.ok(/--surface-raised/.test(render) && /--text-secondary/.test(render),
    'the pill is no longer neutral');
  for (const tok of ['--sage', '--amber', '--brick', '--dusk', '--accent']) {
    assert.ok(!render.includes(tok),
      `the pill spends ${tok}; a direction is a fact about the row, not a state needing attention`);
  }
});

it('moreRow carries the pill, so all three consumers see the same one', () => {
  const fn = MHTML.slice(MHTML.indexOf('function moreRow(r){'), MHTML.indexOf('function moreRowsFlat()'));
  assert.ok(/pill:ROW_PILL\[r\[0\]\]\|\|null/.test(fn),
    'moreRow no longer resolves the pill — the More list, the tab bar and the search index read through it');
});

it('it renders before the unseen dot, which must never be pushed off the edge', () => {
  const row = MHTML.slice(MHTML.indexOf('${groups.map(g=>`<div style="margin-top:14px">'));
  const pill = row.indexOf('${r.pill?');
  const dot = row.indexOf('moreRowDot(r.key)');
  assert.ok(pill > 0 && dot > 0, 'the row no longer renders both a pill and the unseen dot');
  assert.ok(pill < dot, 'the pill must come before the arriving-work dot, not after it');
});

it('§121 — every heading and pill was lifted, and its source is still live', () => {
  /* House rule for a lifted or composed pair: say where its Chinese came from
     and FAIL if that source stops being live, so a rename cannot quietly
     orphan it. Declared in docs/tacet-delivery-vocabulary.md v1.77. None of
     these eleven strings was composed — each is below. */
  const live = (re, what) => assert.ok(re.test(MHTML), `${what} is no longer live where it was lifted from`);

  live(/这家门店可以重新接单/, '接单 (Take an order)');
  live(/T\('in','入库'\)/, '入库 (Stock coming in)');
  live(/登记生产批次/, '生产 (Making things)');
  live(/营收（全渠道）/, '营收 (Money and numbers)');
  live(/实时数据|数据未变动/, '数据 (Money and numbers)');
  live(/无法发起采购申请/, '发起 (Ask someone else)');

  /* Four headings are two live ROW LABELS joined by 与, so the rows are the
     source and a rename of either one must fail this. */
  live(/'Pick','拣货'/, '拣货 (Send it out)');
  live(/'Delivery settings','配送设置'/, '配送设置 (Send it out)');
  live(/'Inbox','消息'/, '消息 (Messages and channels)');
  live(/'Channel sync','渠道同步'/, '渠道同步 (Messages and channels)');
  live(/'Log a batch','登记批次'|'Record waste','记录损耗'/, '登记 (Record and review)');

  /* The three pills are each a row label or its stem, on or beside the row. */
  live(/'Approvals','审批'/, '审批 (the Approve pill)');
  live(/'Ask for stock','申请补货'/, '申请 (the Ask pill)');
  live(/'Settings','设置'/, '设置 (the Settings pill)');

  /* 出货 was rejected for Send it out because it is live in NO UI pair. If that
     ever changes, the rejection in v1.77 is worth re-reading — but a comment
     mentioning it must not count, so this looks for a T() pair only. */
  assert.ok(!/T\('[^']*','[^']*出货[^']*'\)/.test(MHTML),
    '出货 is now live as a UI string; v1.77 rejected it for Send it out on the grounds that it was not');
});

console.log(`\nok — ${n} §121 grouping checks.`);
