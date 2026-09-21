#!/usr/bin/env node
/**
 * COUNTING A DELIVERY IN IS A TAP, NOT A KEYPAD (§209).
 *
 *   node scripts/test_transfer_quick_count.js
 *
 * Reported off the live screen, on a transfer carrying one banana:
 * *"need to write manually ? not efficient"*. Counting one line in took five
 * actions — tap the row, wait for the keypad, type, save, confirm — and a
 * van-load of twenty lines took twenty keypads. §208 opened the screen; this
 * makes it usable once it is open.
 *
 * WHAT MUST HOLD, and each of these has a way of quietly coming undone:
 *
 *   • THE BAND GOES THROUGH THE CONFIRM SCREEN, NEVER AROUND IT. It fills every
 *     line and lands on `confirm`; the last line is HELD rather than sent, the
 *     same rule xfrSaveCount follows, so nothing settles before somebody has
 *     seen counted against sent. A band that posted every line would settle the
 *     delivery on one tap with no totals read — the exact failure the hold was
 *     built to stop.
 *   • A COUNT SOMEBODY TYPED IS NEVER OVERWRITTEN. Correcting a short line and
 *     then tapping the band must leave the correction standing, or the band
 *     silently books the missing stock in.
 *   • NOTHING IS PRE-FILLED. An uncounted line still reads as uncounted. A
 *     stepper starting at qty_sent was the fastest option on the table and was
 *     rejected: it lets Confirm be pressed without a box being opened, and §39
 *     (what the store counts is what the store holds) is worth the taps.
 *   • THE TWO COMPOSED CHINESE STRINGS STAY DECLARED. An undeclared string is
 *     indistinguishable from a locked one to everyone who comes after, which is
 *     how a wrong character survives — CLAUDE.md, and the 2026-09-06 amendment.
 *
 * Source-reading, for the reason test_transfer_receive_gate.js gives: every
 * m.html render suite is in the slow shard, which is not run.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(root, 'public', 'm.html'), 'utf8');
const V = fs.readFileSync(path.join(root, 'docs', 'tacet-delivery-vocabulary.md'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };
const section = t => console.log('\n' + t);

// The whole-delivery function, read once so the assertions below are about IT
// and not about a coincidence elsewhere in a 20,000-line file.
const ALL = (() => {
  const i = M.indexOf('function xfrAllArrived(){');
  return i < 0 ? '' : M.slice(i, M.indexOf('\nfunction ', i + 10));
})();
const slice = (start, from) => {
  const i = M.indexOf(start, from || 0);
  return i < 0 ? '' : M.slice(i, M.indexOf('\n});', i) + 4);
};
const COMMIT = (() => {
  const i = M.indexOf('function xfrTypeCommit(id){');
  return i < 0 ? '' : M.slice(i, M.indexOf('\nfunction ', i + 10));
})();
const TYPE = slice("reg('xfrType', id=>{");

section('1. the two doors exist and are wired');
ok(/onclick="APP\.cmd\('xfrAllArrived'\)"/.test(M), 'the band calls xfrAllArrived');
ok(/onclick="APP\.cmd\('xfrTick',\$\{it\.id\}\)"/.test(M), 'each row has a tick that calls xfrTick with its line');
ok(/reg\('xfrTick',[\s\S]{0,600}?xfrSaveCount\(it\.id, xfrSent\(it\)\)/.test(M),
   'xfrTick counts the line in at what was sent, through the existing save');
ok(/onclick="APP\.cmd\('xfrType',\$\{it\.id\}\)"/.test(M),
   'and the number opens a field — a count that is not qty_sent must stay sayable');

section('2. the band goes through the confirm screen, not around it');
ok(ALL.length > 0, 'xfrAllArrived exists');
ok(/x\.step='confirm'/.test(ALL), 'it lands on the confirm step');
ok(!/x\.step='done'/.test(ALL), 'it never jumps straight to done');
ok(/x\.held=\{item_id:last\.id/.test(ALL), 'the last line is HELD, not sent — nothing settles unread');
ok(/const last=items\[items\.length-1\]/.test(ALL), 'and "last" is a real line off the list');

section('3. a count somebody typed is never overwritten');
ok(/xfrCount\(it\)==null/.test(ALL),
   'only uncounted lines are filled in — a corrected short line stands');
ok(/const val=it=>\{ const c=xfrCount\(it\); return c==null\?xfrSent\(it\):c; \}/.test(ALL),
   'and the held last line keeps its own count when it already has one');
ok(/x\.held&&x\.held\.item_id!==last\.id/.test(ALL),
   'a held line that is no longer last rides along, the rule xfrSaveCount follows');

section('4. nothing is pre-filled');
ok(/\$\{got==null\?'—':got\}/.test(M),
   'an uncounted line still draws as uncounted');
ok(!/xfrCount\(it\)\?\?xfrSent\(it\)/.test(M) && !/qty_received:xfrSent\(it\)\}\)\)$/m.test(M),
   'no row seeds itself with qty_sent');
ok(!/xfrStep|xfrBump|xfrPlus|xfrMinus/.test(M),
   'and no stepper was added — the rejected option stays rejected');

section('5. the number is the field — no sheet around one digit (§210)');
ok(!/state\.ask=\{ title:T\('Count what actually arrived/.test(M),
   'the modal sheet is gone from this screen');
ok(/<input id="xfrnum-\$\{it\.id\}"[\s\S]{0,200}?inputmode="numeric"/.test(M),
   'the number opens an inline field, and it asks for the number pad');
ok(/enterkeyhint="done"/.test(M), "and the phone's own key commits it");
ok(/onblur="APP\.cmd\('xfrTypeCommit',\$\{it\.id\}\)"/.test(M),
   'a thumb landing elsewhere commits too');
// The whole reason this pattern and not a simpler one: a field rebuilt under a
// thumb drops the soft keyboard and reopens on its letter page.
ok(/reg\('xfrTyped', \(id,v\)=>\{ state\.xfr\.typing\[Number\(id\)\]=String\(v==null\?'':v\); \}\);/.test(M),
   'typing stores and nothing else — no render, no state.focus');
ok(/state\.focus=\{id:'xfrnum-'\+it\.id,pos:seed\.length\}/.test(M),
   'opening arms exactly one focus, spent by the render on the next line');
ok(TYPE.indexOf('render()') > -1 && !/render\(\);[\s\S]*render\(\)/.test(TYPE),
   'and opening renders once');

section('6. an empty field is not zero, and a non-number is refused');
ok(/if\(raw===''\)\{ delete x\.typing\[id\]; delete x\.typeErr\[id\]; render\(\); return; \}/.test(COMMIT),
   'clearing the field writes nothing — NULL and 0 are different facts');
ok(/if\(!\/\^\\d\+\$\/\.test\(raw\)\)\{/.test(COMMIT),
   '"1o" is refused rather than stripped to 1');
ok(/Enter what arrived — a whole number, 0 or more\./.test(COMMIT)
   && /请输入到货数量 — 0 或以上的整数。/.test(COMMIT),
   'in the sentence the sheet used to say, word for word, both halves');
ok(/xfrSaveCount\(id, parseInt\(raw,10\)\)/.test(COMMIT),
   'and a real number goes through the existing save, holding rules intact');

section('7. the band is a whole-delivery act, drawn as one');
ok(/const allTicked=items\.length>0&&items\.every\(it=>xfrCount\(it\)===xfrSent\(it\)\)/.test(M),
   'it knows when there is nothing left for it to do');
ok(/x\.busy\|\|allTicked\?' disabled':''/.test(M),
   'and disables itself then, rather than offering a no-op');

section('8. the composed Chinese is declared');
ok(/T\('Everything arrived','全部到货'\)/.test(M), "the band says 'Everything arrived · 全部到货'");
ok(/T\('All here','到齐'\)/.test(M), "the tick says 'All here · 到齐'");
ok(/\|\s*Everything arrived\s*\|\s*全部到货\s*\|/.test(V),
   'and 全部到货 is declared in the vocabulary, with what it was cut from');
ok(/\|\s*All here\s*\|\s*到齐\s*\|/.test(V),
   'and 到齐 is declared there too');
ok(/Composed by[\s\S]{0,400}?§209|§209[\s\S]{0,4000}?Composed by/.test(V),
   'both marked composed, and by whom');

section('9. the tick is reachable without sight or a fine fingertip');
ok(/aria-label="\$\{escAttr\(T\('All here','到齐'\)\+' · '\+xfrName\(it\)\)\}"/.test(M),
   'the icon-only tick carries an accessible name naming its line');
ok(/width:44px;height:44px/.test(M), 'and is a 44px target');

console.log('\n' + (fail ? `FAIL — ${fail} failed, ${pass} passed`
                         : `PASS — ${pass} checks`));
process.exit(fail ? 1 : 0);
