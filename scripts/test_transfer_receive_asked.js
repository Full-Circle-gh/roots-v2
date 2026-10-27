#!/usr/bin/env node
/**
 * THE RECEIVE SCREENS SAY WHAT THE SHOP ASKED FOR, BUT ONLY WHERE THE WAREHOUSE
 * SENT SOMETHING ELSE.
 *
 *   node scripts/test_transfer_receive_asked.js
 *
 * Reported as a question: when "Everything arrived" updates the shelf, is that
 * what I asked for or what the warehouse sent? It is what was SENT, and the
 * screen never showed the request, so a line the warehouse cut (asked 20, sent
 * 15) read as a plain "sent 15". And `qty_sent` falls back to `qty_requested`
 * when the warehouse changed nothing, so even "sent 15" could not say whether
 * 15 was loaded or just never touched.
 *
 * WHAT MUST HOLD:
 *   • `asked N` appears only when the request and the sent figure differ; an
 *     equal line stays exactly as it was.
 *   • It sits before `sent`, the order the goods moved (the vocabulary doc's
 *     `申请 · 发出 · 实收`), and uses the LIVE pair asked / 申请 — nothing composed.
 *   • It is on the count row, the finished-delivery receipt and the confirm
 *     screen, and the confirm screen lists a cut line even when it was counted
 *     in at exactly what was sent.
 *
 * Source-reading plus the two helpers run for real, for the reason
 * test_transfer_receive_gate.js gives: every m.html render suite is in the slow
 * shard, which is not run.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const M = fs.readFileSync(path.join(__dirname, '..', 'public', 'm.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };

const grab = (name) => {
  const i = M.indexOf('function ' + name + '(');
  return i < 0 ? '' : M.slice(i, M.indexOf('\n', i));
};

// ── the helpers, run for real ──────────────────────────────────────────────
const src = ['xfrNum', 'xfrSent', 'xfrAskedDiffers', 'xfrAskedTag'].map(grab);
ok(src.every(Boolean), 'the four helpers are found');
const T = (en, cn) => en;
const h = new Function('T', src.join('\n') + '\nreturn { xfrAskedDiffers, xfrAskedTag };')(T);

const cut = { qty_requested: 20, qty_sent: 15 };
const same = { qty_requested: 10, qty_sent: 10 };
const untouched = { qty_requested: 10, qty_sent: null };
const over = { qty_requested: 10, qty_sent: 12 };
ok(h.xfrAskedDiffers(cut) && /asked <span class="num">20<\/span> · $/.test(h.xfrAskedTag(cut)), 'a cut line says asked 20');
ok(h.xfrAskedDiffers(over), 'a line sent over the request says so too');
ok(!h.xfrAskedDiffers(same) && h.xfrAskedTag(same) === '', 'an equal line shows nothing');
ok(!h.xfrAskedDiffers(untouched) && h.xfrAskedTag(untouched) === '', 'an untouched line (sent falls back to asked) shows nothing');
ok(!h.xfrAskedDiffers({ qty_sent: 5 }), 'a line with no request on record shows nothing');

// ── where it is drawn ──────────────────────────────────────────────────────
const SCREEN = (() => {
  const i = M.indexOf('function screenReceiveTransfer(){');
  return i < 0 ? '' : M.slice(i, M.indexOf('\nfunction ', i + 10));
})();
ok(SCREEN.length > 0, 'screenReceiveTransfer is found');

const before = "${xfrAskedTag(it)}${T('sent','发出')}";
const hits = SCREEN.split(before).length - 1;
ok(hits === 3, 'asked precedes sent on the count row, the receipt row and the confirm row (found ' + hits + ')');
ok(/const diff=items\.filter\(it=>xfrCount\(it\)!==xfrSent\(it\)\|\|xfrAskedDiffers\(it\)\)/.test(SCREEN),
   'the confirm screen lists a cut line even when counted in at what was sent');
ok(grab('xfrAskedTag').includes("T('asked','申请')"), 'the label is the live pair asked / 申请');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
