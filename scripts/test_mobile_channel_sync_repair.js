#!/usr/bin/env node
'use strict';

// §124 — the phone's Channel sync screen carries the repair §117 part two built.
//
//   node scripts/test_mobile_channel_sync_repair.js
//
// WHAT WENT WRONG, so the suite is read as the fix for something real. §117 part
// two gave the desktop Channel sync page a push and a sync switch; between them
// they clear four of the seven reasons an item needs attention. The phone's copy
// was written against the version before it and went on saying "Read-only" at the
// foot and "Fix this on the desktop: Meituan tab." inside every amber card.
//
// For `push_failed` that was not merely out of date. The daemon picks up only
// `pending` rows (docs/meituan-findings.md #6), so the Meituan tab is the one
// screen that CANNOT clear a failed push — and the phone was pointing at it while
// the push that does clear it had just been built.
//
// WHAT IS LOCKED DOWN, in the order it would hurt to lose:
//
//   1. PARITY OF THE VERB. The phone offers Sync now on exactly the rows the
//      desktop offers it on. Both conditions are SLICED OUT OF THE TWO LIVE FILES
//      and run against one table of states, so neither can be edited alone.
//   2. THE PATH IS GATED. The URL the phone builds resolves through
//      lib/cap-routes.js to {channel}:sync. That file fails OPEN for a mutation it
//      does not recognise, so a path that misses its regex is a write with no gate
//      at all — which is the whole reason to pin the string rather than trust it.
//   3. THE BUTTON IS GATED CLIENT-SIDE TOO, through mCan. Not decoration: an
//      ungated button is a dead end for somebody the server refuses. (It used to
//      log them out — apiWrite sent a 403 to /backend/login like a 401 — until
//      §325; the refusal is now said on the row, through csErrText.)
//   4. THE DESKTOP IS NAMED ONLY WHERE A DESKTOP IS NEEDED — the three reasons
//      that need the channel's own catalogue picker, and no others.
//   5. THE SCREEN NO LONGER CALLS ITSELF READ-ONLY.
//   6. THE WORDS ARE THE DESKTOP'S WORDS. Nothing composed.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PHONE = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public/retail-admin/29-channel-sync.js'), 'utf8');
const { requiredCapFor } = require(path.join(ROOT, 'lib', 'cap-routes'));

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push({ name, message: e.message }); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what || 'expected truthy'); }
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
function section(t) { console.log(`\n${t}`); }

// ── Slicing ──────────────────────────────────────────────────────────────────
// A line, by the name it declares. Throws rather than returning '' — a rename
// that made this silently slice nothing would turn every case below green.
function line(src, starts, where) {
  const hit = src.split('\n').filter((l) => l.trimStart().startsWith(starts));
  if (hit.length !== 1) throw new Error(`${where}: expected exactly one line starting "${starts}", found ${hit.length}`);
  return hit[0];
}
// A brace-balanced function body, from its `function NAME(` to the closing brace.
function fnBlock(src, name, where) {
  const at = src.indexOf('function ' + name + '(');
  if (at === -1) throw new Error(`${where}: no function ${name}`);
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(at, j + 1); }
  }
  throw new Error(`${where}: unbalanced braces in ${name}`);
}

// ── 1 · The two surfaces agree on WHEN Sync now is offered ───────────────────
section('The verb is offered on the same rows on both surfaces');

// The phone's condition, run.
const phoneCtx = { };
vm.runInNewContext(line(PHONE, 'function csCanPush(', 'm.html'), phoneCtx);

// The desktop's, run — `actions` builds the buttons, so "does it offer the verb"
// is asked of the HTML it returns rather than of a condition copied into here.
const deskCtx = {
  _busy: null,
  esc: (v) => String(v),
  cuT: (en) => en,
};
vm.runInNewContext(
  fnBlock(DESK, 'wKey', '29-channel-sync.js') + '\n' + fnBlock(DESK, 'actions', '29-channel-sync.js'),
  deskCtx
);
const deskOffers = (c) => deskCtx.actions('meituan', c, 7, 'Meituan').indexOf('csPushNow') !== -1;

const STATES = [
  { c: { k: 'att', reason: 'push_failed' },  push: true,  why: 'a failed push — the screenshot case' },
  { c: { k: 'att', reason: 'wrong_number' }, push: true,  why: 'the channel holds a different number' },
  { c: { k: 'att', reason: 'never_synced' }, push: true,  why: 'no push has ever landed' },
  { c: { k: 'att', reason: 'no_name' },      push: true,  why: 'no listing name — the push is offered, and so is the desktop' },
  { c: { k: 'ok' },                          push: true,  why: 'green: a push is harmless and the desktop offers it' },
  { c: { k: 'unk' },                         push: true,  why: 'catalogue unread' },
  { c: { k: 'off' },                         push: false, why: 'switched off — nothing would be sent' },
  { c: { k: 'none' },                        push: false, why: 'nothing mapped' },
];

STATES.forEach((s) => {
  check(`phone offers Sync now = ${s.push} — ${s.why}`, () => {
    eq(!!phoneCtx.csCanPush(s.c), s.push, 'csCanPush');
  });
});
check('the desktop agrees on every one of those states', () => {
  STATES.forEach((s) => {
    if (deskOffers(s.c) !== !!phoneCtx.csCanPush(s.c)) {
      throw new Error(`${JSON.stringify(s.c)}: desktop ${deskOffers(s.c)}, phone ${phoneCtx.csCanPush(s.c)}`);
    }
  });
});
check('an absent channel entry is not a row with a button on it', () => {
  eq(!!phoneCtx.csCanPush(null), false, 'csCanPush(null)');
  eq(!!phoneCtx.csCanPush(undefined), false, 'csCanPush(undefined)');
});

// ── 2 · The path the phone posts to is a GATED path ──────────────────────────
section('The push posts to a path lib/cap-routes.js gates');

check('the phone builds the desktop’s own path', () => {
  ok(PHONE.indexOf("'/channel-sync/'+encodeURIComponent(chKey)+'/products/'+Number(pid)+'/push'") !== -1,
    'the push path is not the expected expression — if it moved, move this check with it');
});
check('that path resolves to {channel}:sync for all three channels', () => {
  ['meituan', 'eleme', 'guanyi'].forEach((ch) => {
    const p = '/api/retail-admin/channel-sync/' + ch + '/products/7/push';
    eq(requiredCapFor('POST', p), ch + ':sync', ch);
  });
});
// §326.3 overturned §124's "the switch stays on the desktop" by name; §325 X8b
// built it. What is pinned now is that the phone's switch posts to the gated
// path, is drawn for the key that path asks, and asks before turning off.
// scripts/test_mobile_channel_sync_switch.js asserts the requests themselves.
check('the switch posts to the desktop’s own path, which lib/cap-routes.js gates as {channel}:map (§326.3)', () => {
  ok(PHONE.indexOf("'/channel-sync/'+encodeURIComponent(ch)+'/products/'+Number(pid)+'/sync'") !== -1, 'the phone does not build the /sync path');
  ['meituan', 'eleme', 'guanyi'].forEach((ch) => {
    eq(requiredCapFor('POST', '/api/retail-admin/channel-sync/' + ch + '/products/7/sync'), ch + ':map', ch);
  });
  ok(/mCan\(ch\+':map'\)/.test(fnBlock(PHONE, 'csSwitch', 'm.html')), 'the switch is not drawn through mCan({channel}:map)');
});

// ── 3 · The button carries its own capability: a refused tap is a dead end ──
section('The button is gated where it is drawn');

check('Sync now is drawn through mCan(‘{channel}:sync’)', () => {
  ok(/mCan\(x\.ch\.key\+':sync'\)/.test(PHONE), 'no mCan gate on the push button');
});
check('a refused push is said on the row, never a logout (§325)', () => {
  const w = fnBlock(PHONE, 'apiWrite', 'm.html');
  ok(/r\.status===401\)\{ location\.href='\/backend\/login'/.test(w) && !/status===403\)\{ location/.test(w),
    'apiWrite sends something other than a 401 to the login page');
  ok(/r\.status===403\) throw await apiRefusal\(r\)/.test(w), 'apiWrite no longer throws the refusal');
  const t = fnBlock(PHONE, 'csErrText', 'm.html');
  ok(/e&&e\.refused\) return T\(\.\.\.e\.words\)/.test(t), 'csErrText does not say the refusal');
});
check('the SCREEN’s gate is unchanged — any-of the three views, no write key', () => {
  ok(/channelsync:\['meituan:view','eleme:view','guanyi:view'\]/.test(PHONE),
    'the channelsync row gate moved; a write key here would hide the alarm from somebody who may read it');
});

// ── 4 · The desktop is named only where a desktop is needed ──────────────────
section('The sentence sending somebody to a computer');

vm.runInNewContext(
  line(PHONE, 'const CS_DESKTOP_REASONS=', 'm.html') + '\n' +
  line(PHONE, 'function csNeedsDesktop(', 'm.html') + '\n' +
  // A top-level `const` in a vm script does not attach to the context object the
  // way a function declaration does, so the list is handed out explicitly.
  'this.__reasons = CS_DESKTOP_REASONS;',
  phoneCtx
);

const DESKTOP_CASES = [
  { c: { k: 'att', reason: 'no_name' },        want: true },
  { c: { k: 'att', reason: 'name_not_found' }, want: true },
  { c: { k: 'att', reason: 'no_option' },      want: true },
  { c: { k: 'att', reason: 'push_failed' },    want: false },
  { c: { k: 'att', reason: 'wrong_number' },   want: false },
  { c: { k: 'att', reason: 'never_synced' },   want: false },
  { c: { k: 'off' },                           want: false },
  { c: { k: 'ok', reason: 'no_name' },         want: false },
];
DESKTOP_CASES.forEach((t) => {
  check(`csNeedsDesktop ${JSON.stringify(t.c)} = ${t.want}`, () => {
    eq(!!phoneCtx.csNeedsDesktop(t.c), t.want, 'csNeedsDesktop');
  });
});
check('the sentence is written from that narrower list, not from every amber channel', () => {
  ok(/\$\{deskBad\.length\?/.test(PHONE), 'the desktop sentence is not driven by deskBad');
  ok(!/\$\{bad\.length\?`<div style="color:var\(--text-secondary\)">\$\{T\('Fix this on the desktop/.test(PHONE),
    'the old every-amber-channel version of the sentence is still here');
});
check('the three it names are the three §117 part two did not build', () => {
  eq(phoneCtx.__reasons.slice().sort(), ['name_not_found', 'no_name', 'no_option'], 'the list');
  // The desktop's own note for what it deliberately left to the channel tabs. If
  // it stops naming one of the three, one screen has moved the line and the other
  // has not — which is the drift §117 exists to end.
  ['no_name', 'name_not_found', 'no_option'].forEach((r) => {
    ok(DESK.indexOf(r) !== -1, `the desktop no longer names ${r} as a channel-tab job`);
  });
});

// ── 5 · The screen stops calling itself read-only ────────────────────────────
section('The read-only claim is gone from all three places that made it');

check('the phone’s foot no longer says Read-only', () => {
  ok(PHONE.indexOf('Read-only. A mapping is repaired') === -1, 'the footer note is still in m.html');
  ok(PHONE.indexOf('只读。商品匹配在电脑端') === -1, 'its Chinese half is still in m.html');
});
check('the desktop module header no longer says Read-only', () => {
  ok(!/\(§103\)\. Read-only\./.test(DESK), '29-channel-sync.js still opens by calling itself read-only');
});
check('the desktop section comment no longer says the tabs are where a mapping is repaired', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
  ok(html.indexOf('Read-only: the three channel tabs stay the place a') === -1,
    'retail-admin.html still carries the pre-§117-part-two comment');
});

// ── 6 · The words are lifted, not composed ───────────────────────────────────
section('Chinese: every pair on this button is already live somewhere else');

check('Sync now · 立即同步 is the desktop button’s own pair', () => {
  ok(/T\('Sync now','立即同步'\)/.test(PHONE), 'the phone’s label is not the expected pair');
  ok(DESK.indexOf("cuT('Sync now', '立即同步')") !== -1, 'the desktop’s label moved — the pair is no longer lifted');
});
check('Sending… is this screen’s own word for a push in flight', () => {
  ok(/T\('Sending…','发送中…'\)/.test(PHONE), 'the busy label is not the expected pair');
  // csCellWord's 'sending' case is where it comes from; two of them now.
  ok((PHONE.match(/'发送中…'/g) || []).length >= 2, 'the pair is no longer shared with csCellWord');
});
check('the refusal is 01-core.js’s pair for not_mapped / not_syncing, character for character', () => {
  const core = fs.readFileSync(path.join(ROOT, 'public/retail-admin/01-core.js'), 'utf8');
  const ZH = '该记录已被他人修改,请刷新后重试。';
  ok(core.indexOf(ZH) !== -1, 'the desktop pair moved');
  ok(PHONE.indexOf(ZH) !== -1, 'the phone no longer carries it');
  ok(/not_mapped'\|\|e\.code==='not_syncing'/.test(PHONE), 'csErrText no longer answers both codes');
});
check('no new vocabulary is owed — the doc is untouched by this change', () => {
  const vocab = fs.readFileSync(path.join(ROOT, 'docs/tacet-delivery-vocabulary.md'), 'utf8');
  ok(vocab.indexOf('§124') === -1, '§124 wrote itself into the vocabulary document, which means something WAS composed');
});

// ── 7 · The control is a 44px target on the row whose value it changes ───────
section('The control’s shape');

check('it is `.rowact` — the house class carrying the 44px minimum (§122)', () => {
  ok(/<button class="rowact"\$\{busy\?' disabled':''\}/.test(PHONE), 'the push button is not a .rowact');
  ok(/\.rowact\{min-height:44px/.test(PHONE), '.rowact lost its 44px floor');
});
check('the tap does not also open or close the card underneath it', () => {
  ok(/event\.stopPropagation\(\);APP\.cmd\('csPush'/.test(PHONE), 'the button does not stop the card’s onclick');
});
check('one write at a time, and the busy row is the one that disables', () => {
  ok(/if\(state\.csBusy\) return;/.test(PHONE), 'no single-flight guard');
  ok(/const busy=state\.csBusy===x\.ch\.key\+':'\+p\.id;/.test(PHONE), 'busy is not keyed to channel:product');
});

// ── Result ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  failures.forEach((f) => console.log(`  FAILED: ${f.name} — ${f.message}`));
  process.exit(1);
}
