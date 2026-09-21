#!/usr/bin/env node
/**
 * SHORT IS A NUMBER, NOT A SHEET (§213).
 *
 *   node scripts/test_pick_short_inline.js
 *
 * Ash, off the live Pick screen: *"once clicking short no need pop up screen .
 * it just need to turn into a numbers keyboards, taping a number and enter .
 * once tap enter that's the number selected"*. The same complaint as §210 one
 * screen along, and the same answer: the row already prints the number, so the
 * row can take it.
 *
 * WHY THIS IS NOT §210 COPIED. A pick line can carry SEVERAL DESTINATIONS — one
 * product two shops asked for on the same run — and two shops short by
 * different amounts is two numbers that no single field can say. A single-part
 * line turns its own figure into the field; a multi-part line opens one per
 * destination, each labelled with the shop.
 *
 * WHAT MUST HOLD:
 *
 *   • TYPING RENDERS NEVER. §210's rule, learned on the Ask-to-buy screen: a
 *     field rebuilt under a thumb drops the soft keyboard and reopens on its
 *     letter page.
 *   • THE COMMIT READS THE WHOLE LINE, not the field that lost focus. One
 *     destination answered is not an answer, and committing per field would
 *     write half a line to the server.
 *   • EMPTY IS THE WAY OUT. The sheet had a Cancel; this has no button, so a
 *     blur with nothing typed closes and writes nothing.
 *   • THE THREE REFUSALS ARE THE SHEET'S OWN, word for word, both halves. A
 *     picker being told something new because a container changed is the kind
 *     of drift nobody notices until the Chinese is wrong.
 *
 * Source-reading, for the reason test_transfer_receive_gate.js gives: every
 * m.html render suite lives in the slow shard, which is not run.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const M = fs.readFileSync(path.join(__dirname, '..', 'public', 'm.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };
const section = t => console.log('\n' + t);
const fn = name => {
  const i = M.indexOf('function ' + name + '(');
  return i < 0 ? '' : M.slice(i, M.indexOf('\nfunction ', i + 10));
};
const OPEN = fn('pikShortOpen'), TYPED = fn('pikShortTyped'), COMMIT = fn('pikShortCommit');

section('1. the sheet is gone and the row takes the number');
ok(!/pikAskShort/.test(M), 'pikAskShort no longer exists — neither defined nor called');
ok(!/state\.ask=\{[\s\S]{0,200}?How many did you find/.test(M), 'and nothing opens a sheet for it');
ok(/reg\('pikShort', key=>pikShortOpen\(String\(key\)\)\)/.test(M), 'Short opens the field instead');
ok(/<input id="pikshort-\$\{p\.itemId\}"[\s\S]{0,160}?inputmode="numeric"/.test(M),
   'one numeric field per destination, keyed by its line');
ok(/enterkeyhint="done"/.test(M) && /if\(event\.key==='Enter'\)\{event\.preventDefault\(\);this\.blur\(\)\}/.test(M),
   "Enter finishes it — \"once tap enter that's the number selected\"");
ok(/onblur="APP\.cmd\('pikShortCommit'\)"/.test(M), 'and so does a thumb landing elsewhere');

section('2. typing renders never');
ok(/^function pikShortTyped\(itemId,v\)\{[\s\S]*?\}$/.test(TYPED.trim()) && !/render\(\)/.test(TYPED),
   'pikShortTyped stores and nothing else — no render, no state.focus');
ok(/state\.focus=\{id:'pikshort-'\+L\.parts\[0\]\.itemId,pos:0\}/.test(OPEN),
   'opening arms one focus, on the first destination');

section('3. the commit reads the whole line');
ok(/L\.parts\.every\(p=>raw\(p\)===''\)/.test(COMMIT),
   'nothing typed anywhere → close, write nothing (the sheet\'s Cancel, without a button)');
ok(/L\.parts\.some\(p=>raw\(p\)===''\)/.test(COMMIT) && /\{ render\(\); return; \}/.test(COMMIT),
   'one destination still blank → stay open, write nothing');
ok(/pikWriteLine\(L,per\)/.test(COMMIT), 'and a complete answer goes through the existing write');
ok(COMMIT.indexOf('k.short=null') < COMMIT.indexOf('pikWriteLine'),
   'the field closes before the write, so a slow save cannot be typed into');

section('4. the three refusals are the sheet\'s own, both halves');
ok(/Enter a whole number for each store, 0 or more\./.test(COMMIT)
   && /每家门店请输入 0 或以上的整数。/.test(COMMIT), 'not a whole number');
ok(/More than was asked for\./.test(COMMIT) && /超过申请数量。/.test(COMMIT), 'more than was asked');
ok(/Nothing to send\./.test(COMMIT) && /没有可发出的数量。/.test(COMMIT), 'nothing to send');
ok(/n>p\.asked/.test(COMMIT) && /sum<=0/.test(COMMIT),
   'and each is still reached by the condition it was written for');

section('5. drawn so a picker can tell the two shapes apart');
ok(/const solo=L\.parts\.length===1;/.test(M), 'a one-shop line knows it is one');
ok(/\$\{shorting&&solo\?'':`<span class="num"/.test(M),
   'and on that line the figure BECOMES the field rather than sitting beside it');
ok(/solo\?'':`<span style="font-size:11\.5px[^`]*>\$\{escAttr\(p\.dest\)\}/.test(M),
   'a multi-shop line labels each field with its shop');
ok(/aria-label="\$\{escAttr\(T\('How many did you find\?','找到多少？'\)\+' · '\+p\.dest\+' · '\+L\.name\)\}"/.test(M),
   "each field is named with the sheet's own live title, its shop and its product");
ok(/height:44px/.test(M.slice(M.indexOf('id="pikshort-'), M.indexOf('id="pikshort-') + 700)),
   'and is a 44px target');

section('6. the error lands on the line it belongs to');
ok(/shorting&&k\.shortErr\?`<span[^`]*var\(--brick-ink\)/.test(M),
   'the refusal is drawn under that row, not as a screen-wide banner');

console.log('\n' + (fail ? `FAIL — ${fail} failed, ${pass} passed`
                         : `PASS — ${pass} checks`));
process.exit(fail ? 1 : 0);
