#!/usr/bin/env node
/**
 * THE SKU RIDES UNDER EACH LINE OF A DELIVERY BEING COUNTED IN.
 *
 *   node scripts/test_transfer_receive_sku.js
 *
 * Reported off the live Receive screen with three coconut yoghurts on it —
 * 纯素椰子酸奶-香草味, the same in 冷藏, and a peach one — and the ask was
 * *"need sku here"*. Names that close are told apart by the code on the box,
 * so the code sits after the sent figure: `发出 2 · <sku>`.
 *
 * WHAT MUST HOLD:
 *   • Both rows carry it — the counting row and the finished-delivery receipt,
 *     because the receipt is where somebody checks a line weeks later.
 *   • A line with no SKU shows nothing extra, not an empty `· `.
 *   • The SKU is escaped. It is typed by people.
 *   • No label is minted for it. A code needs no word in front of it, so there
 *     is no Chinese string to declare (CLAUDE.md, Chinese strings).
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

const LINE = "${T('sent','发出')} <span class=\"num\">${xfrSent(it)}</span>"
           + "${it.sku?` · <span class=\"num\">${escAttr(it.sku)}</span>`:''}</span>";
const hits = SCREEN.split(LINE).length - 1;
ok(hits === 2, 'the sent line carries the SKU on both the count row and the receipt row (found ' + hits + ')');

const bare = SCREEN.split("${T('sent','发出')} <span class=\"num\">${xfrSent(it)}</span></span>").length - 1;
ok(bare === 0, 'no sent line is left without the SKU');

ok(!/\$\{it\.sku\}/.test(SCREEN), 'the SKU is never written unescaped');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
