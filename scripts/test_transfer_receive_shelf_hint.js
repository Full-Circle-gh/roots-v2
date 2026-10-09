#!/usr/bin/env node
/**
 * THE COUNT SCREEN SAYS WHEN THE SHELF MOVES.
 *
 *   node scripts/test_transfer_receive_shelf_hint.js
 *
 * Reported off the live Receive screen: one line ticked, a green 5 beside it,
 * and *"stock didn't update after I mark it 5"*. The tick saves the count;
 * nothing goes on the shelf until every line is counted and the receipt is
 * confirmed. The confirm screen said so and the count screen did not.
 *
 * WHAT MUST HOLD:
 *   • The count screen carries the confirm screen's sentence, word for word —
 *     the same live pair, so no Chinese is composed for it.
 *   • It sits under "Count what actually arrived.", not in place of it.
 *
 * Source-reading, for the reason test_transfer_receive_gate.js gives: every
 * m.html render suite is in the slow shard, which is not run.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const M = fs.readFileSync(path.join(__dirname, '..', 'public', 'm.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };

const SCREEN = (() => {
  const i = M.indexOf('function screenReceiveTransfer(){');
  return i < 0 ? '' : M.slice(i, M.indexOf('\nfunction ', i + 10));
})();
ok(SCREEN.length > 0, 'screenReceiveTransfer is found');

const HINT = "T('Confirming puts these counts on the shelf.','确认后将按此数量入库。')";
const COUNT = "T('Count what actually arrived.','清点实际到货数量。')";

// The confirm step returns first; the count screen is what follows it.
const confirmAt = SCREEN.indexOf("if(x.step==='confirm')");
const countScreen = confirmAt < 0 ? '' : SCREEN.slice(SCREEN.indexOf('const allTicked=', confirmAt));
ok(countScreen.length > 0, 'the count screen is found');

ok(SCREEN.split(HINT).length - 1 === 2,
   'the hint is on both the confirm screen and the count screen');

const c = countScreen.indexOf(COUNT), h = countScreen.indexOf(HINT);
ok(c >= 0 && h > c, 'the hint sits under "Count what actually arrived."');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
