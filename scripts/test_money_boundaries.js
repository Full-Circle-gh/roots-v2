#!/usr/bin/env node
/**
 * test_money_boundaries.js — where SQL's rounding stops (audit I-02).
 *
 *   node scripts/test_money_boundaries.js
 *
 * THE FINDING. Money arithmetic happens inside SQL, outside every helper. The
 * expense a purchase order posts to the books is `SUM(qty * cost_per_unit)`,
 * a customer's lifetime spend is `lifetime_spend + ?`, and the finance summary
 * sums a column of REALs. Their rounding is the DATABASE's, not the product's —
 * and SQLite adds doubles, so a sum of four decimals lands on
 * 45.999999999999996 often enough that lib/channel-settlement.js carries a
 * half-cent tolerance to live with it.
 *
 * WHAT THIS IS NOT. It does not make the storage exact; that is Stage 2 of
 * docs/tacet-money-migration-plan.md and it is a schema change. What it does is
 * stop the drift PROPAGATING: a figure that goes back into the database or onto
 * a screen is a whole number of cents, so the next sum starts from a clean
 * number rather than compounding the last one's dust.
 *
 * The boundaries, and one section each:
 *
 *   §2  a purchase order's expense rows, which are STORED
 *   §3  a customer's lifetime spend, which is ACCUMULATED — the case where
 *       float addition actually loses money over time
 *   §4  the finance summary's fen(), which two cases got wrong
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const M = require('../lib/money');
const { fen } = require('../lib/finance-window');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${e}, got ${a}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

// ── §1 · the two helpers ──────────────────────────────────────────────────
section('1 · the boundary helpers');

is(M.round(45.999999999999996), 46, 'a float sum comes back as the amount it was meant to be');
is(M.round(1.005), 1.01, 'and the wrong penny is not reintroduced on the way');
is(M.round(-1.005), -1.01, 'in both directions, so a refund mirrors its charge');
is(M.round('x'), null, 'a non-amount is null — "nothing" is not "zero"');
is(M.round(0), 0, '…and zero is very much an amount');

is(M.addMajor(0.1, 0.2), 0.3, '0.1 + 0.2 is 0.3, which the language does not agree with');
is(M.addMajor(...new Array(1000).fill(0.01)), 10, 'and a cent added a thousand times is exactly ten');
{
  let f = 0; for (let i = 0; i < 1000; i++) f += 0.01;
  yes(f !== 10, 'which the float version is not — that is the whole finding');
}
is(M.addMajor(12.34, null, undefined, 'x', 5), 17.34, 'anything that is not an amount is skipped');
is(M.addMajor(), 0, 'and nothing at all sums to zero');
is(M.addMajor(1.005, -1.005), 0, 'a charge and its reversal cancel exactly');

// ── §2 · what goes into the books ─────────────────────────────────────────
section('2 · a purchase order posts whole cents');
{
  const src = fs.readFileSync(path.join(ROOT, 'routes/retail-purchasing.js'), 'utf8');
  const fn = src.slice(src.indexOf('function postRetailPOExpenses('), src.indexOf('// A copy pulled out of the kitchen list'));
  yes(/money\.round\(g\.amount\)/.test(fn),
    'the SQL sum is rounded once before it is written');
  yes(/money\.addMajor\(po\.extra_freight/.test(fn),
    'and the landed-cost extras are added exactly, not with +');
  yes(/total: money\.addMajor\(\.\.\.posted\)/.test(fn),
    'the reported total is the sum of what was actually written');
  // A running float beside the rows could disagree with them by a cent, and
  // then nobody can say which of the two is the truth.
  yes(!/total \+= /.test(fn), 'never a float running alongside the rows');
}
{
  // The arithmetic itself, on the numbers that produce the residue. Three lines
  // at 15.333 each is 45.999 in the database and 46.00 in the books.
  const lines = [3 * 5.111, 3 * 5.111, 3 * 5.111];
  const sqlish = lines.reduce((a, b) => a + b, 0);
  yes(sqlish !== 46.0, 'the float sum of three identical lines is not the round figure');
  is(M.round(sqlish), 46, 'and what gets posted is');
}

// ── §3 · what accumulates ─────────────────────────────────────────────────
section('3 · a lifetime total that is added to for years');
{
  const src = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');
  const adds = src.match(/lifetime_spend = COALESCE\(lifetime_spend, 0\) \+ \?/g) || [];
  is(adds.length, 0, 'no lifetime total is added to inside SQL any more');
  const subs = src.match(/lifetime_spend = MAX\(0, COALESCE\(lifetime_spend, 0\) - \?\)/g) || [];
  is(subs.length, 0, 'nor subtracted from');
  is((src.match(/money\.addMajor\(/g) || []).length, 3,
    'all three sites — an order, a refund reversal and an add-on — go through the helper');
  yes(/Math\.max\(0, money\.addMajor/.test(src),
    'and a refund still cannot drive a lifetime total below zero');
  // The read has to be inside the transaction that writes it, or two orders
  // landing together would each add to the same "before".
  const at = src.indexOf("SELECT COALESCE(lifetime_spend, 0) AS s");
  const around = src.slice(at - 900, at);
  yes(/tdb\(\)\.transaction\(/.test(around),
    'the read it adds to happens inside the transaction that writes the result');
}
{
  // What the SQL version actually cost, over a year of small orders.
  let sqlish = 0;
  for (let i = 0; i < 3650; i++) sqlish += 12.34;
  const exact = M.addMajor(...new Array(3650).fill(12.34));
  is(exact, 45041, 'ten years of one order a day comes to a round figure');
  yes(sqlish !== exact, 'and the float version has drifted off it by then');
}

// ── §4 · what reaches the screen ──────────────────────────────────────────
section('4 · the finance summary rounds the way the product does');

is(fen(1.005), 1.01, 'a half-cent goes up, not down — Math.round(1.005 * 100) is 100');
is(fen(-0.005), -0.01, 'and a negative net rounds to mirror the positive it should cancel');
is(fen(45.999999999999996), 46, 'float residue never reaches the screen');
is(fen('x'), 0, 'a non-number still renders as zero, not blank');
is(fen(null), 0, 'and so does nothing at all');
{
  // The case that made this worth changing: net is revenue minus expenses, and
  // this file is where a negative one is computed.
  is(fen(fen(10.005) - fen(10.015)), -0.01, 'a small loss is a small loss, to the cent');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
