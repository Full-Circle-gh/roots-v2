#!/usr/bin/env node
/**
 * test_po_order_date_field.js — the new-order header asks when it was ORDERED.
 *
 *   node scripts/test_po_order_date_field.js
 *
 * THE FINDING, in Ash's words: "我想这里可以更改为下单日期，而不是到货日期。因为
 * 物品到货的时间都不一样。" The first step of 新建采购单 asked for 预计到货 — one
 * expected arrival date for the whole order — and promised to flag the order
 * 逾期 once it passed. On an order carrying seventeen suppliers that date is not
 * a fact about anything: the goods arrive on seventeen different days, and the
 * badge built on it calls the whole order late while sixteen suppliers were on
 * time. The date that IS one value for the whole order is the day it was placed.
 *
 * What has to stay true afterwards, and each is a way to get it wrong:
 *
 *   - The box writes the ORDER date (`_edit.date`), the field the server has
 *     always stored and the list has always shown under the order number.
 *   - It is never left empty. The create route refuses a PO with no date
 *     (`date_required`) and the update route keeps the stored one, so a box
 *     cleared by hand must fall back rather than save a blank.
 *   - The two recap strips echo the header. They read the delivery date before
 *     this change, so leaving them would print "预计 —" on every new order.
 *   - delivery_date is NOT wiped. Orders already carrying one — kitchen copies
 *     bring theirs across — still show it in the list's 到货 column and on the
 *     order page, and reopening such a draft must not blank it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const no  = (c, m, extra) => (!c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

const PU  = fs.readFileSync(path.join(ROOT, 'public/retail-admin/16-purchasing.js'), 'utf8');
const RTE = fs.readFileSync(path.join(ROOT, 'routes/retail-purchasing.js'), 'utf8');

// The step-1 header, on its own, so a match anywhere else in a 4000-line file
// cannot stand in for one inside the card this is about.
const step1 = PU.slice(PU.indexOf('function wizStep1()'), PU.indexOf('function grabStep1()'));
const grab1 = PU.slice(PU.indexOf('function grabStep1()'), PU.indexOf('window.puWizNext'));

section('1. the header asks for the order date');
yes(/T\('Order date', '下单日期'\)/.test(step1), 'labelled Order date · 下单日期');
yes(/id="pu2-w-date"[^>]*value="\$\{esc\(e\.date \|\| ''\)\}"/.test(step1)
    || /value="\$\{esc\(e\.date \|\| ''\)\}"[^>]*id="pu2-w-date"/.test(step1),
  'the box is filled from the order date');
yes(/type="date"/.test(step1), 'it is a date input');

section('2. the expected-arrival box is gone from this step');
no(/预计到货/.test(step1), 'no 预计到货 label');
no(/pu2-w-delivery/.test(PU), 'no pu2-w-delivery anywhere — no orphan reader');
no(/标记逾期/.test(step1), 'the overdue promise it could not keep is gone');

section('3. the box can never save a blank date');
yes(/_edit\.date = g\('pu2-w-date'\)\.value \|\| _edit\.date \|\| todayShop\(\)/.test(grab1),
  'a cleared box falls back to the order date, then to today');
yes(/date: _edit\.date \|\| todayShop\(\)/.test(PU), 'wizBody() still sends a date');
yes(/error: 'date_required'/.test(RTE), 'the server still refuses a PO with no date — the reason for the fallback');

section('4. the recaps echo the header, not the old field');
const step2  = PU.slice(PU.indexOf('function wizStep2()'), PU.indexOf('function wizStep3') > 0
  ? PU.indexOf('function wizStep3') : PU.indexOf('function wizStep2()') + 4000);
no(/pu2-recap/.test(step2),
  'the lines no longer recap the header: on one page the date box is right above them');
yes(/T\('placed', '下单'\)\)\} <b class="pu2-num">\$\{esc\(e\.date/.test(PU),
  'the review line shows the order date');
no(/T\('Expected', '预计'\)\)\}: <b class="pu2-num">\$\{esc\(e\.delivery_date/.test(PU),
  'neither recap still reads the delivery date');

section('5. delivery_date is kept, not wiped');
yes(/delivery_date: _edit\.delivery_date \|\| null/.test(PU),
  'a reopened draft still sends the delivery date it arrived with');
yes(/delivery_date: po\.delivery_date \|\| ''/.test(PU), 'and still loads it into the wizard');
yes(/esc\(p\.delivery_date \|\| '—'\)/.test(PU), "the list's 到货 column still shows it");
yes(/T\('expected', '预计'\)\)\} \$\{esc\(p\.delivery_date\)\}/.test(PU),
  'the order page still shows it when an order has one');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
