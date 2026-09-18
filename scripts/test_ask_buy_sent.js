#!/usr/bin/env node
/**
 * "A cook whose ask is struck off is never told." (§173)
 *
 *   node scripts/test_ask_buy_sent.js
 *
 * §172 gave the buyer a way to refuse one line of a kitchen request. It did not
 * create the silence around that refusal — the kitchen has never had a screen
 * for its own sent requests at all — but it made the silence worth fixing: a
 * cook could be refused, ordered and withdrawn all week and learn none of it.
 *
 * WHAT THIS FILE LOCKS, and it is the property that is easy to lose later:
 * THE STATE IS ON THE LINE, NOT ON THE REQUEST. One request can be part ordered,
 * part waiting and part struck off at the same time, so any single word printed
 * on the request as a whole is wrong about at least one of its lines. A later
 * tidy-up that "simplifies" this screen to one status per request would pass a
 * render test and lie to the kitchen; case 2 is what refuses it.
 *
 * It also locks the two things §86 and §173 keep OFF this screen — a price and a
 * purchase order number — at the render, not only at the route. The route test
 * (scripts/test_material_requests.js case 13) proves the server sends neither;
 * this proves the screen would not print them if it ever did.
 *
 * No browser and no network: the real functions are SLICED OUT OF THE SHIPPED
 * public/m.html and evaluated against stubs — the technique
 * scripts/test_ask_to_buy_keyboard.js uses on the screen next door, and for its
 * reason: nothing here is asserted against a copy of the markup.
 *
 * Cases:
 *   1. an unread list, a failed read and an empty list are three different screens
 *   2. three lines of ONE request can read ordered, waiting and removed at once
 *   3. a removed line names who removed it
 *   4. a withdrawn request says so once, on the request, not on every line
 *   5. no price and no purchase order number can reach the screen
 *   6. the screen is wired in: registry, menu row, capability, and a reopen re-reads
 *   7. painting reads the list once, and painting again does not re-read it
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'm.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)})`);

/* Brace-matched, not a regex: these functions are full of template literals and
   a lazy match would take half of one. Same slicer as the keyboard suite. */
function sliceFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in m.html`);
  let depth = 0;
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    const c = SRC[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces slicing ${name}`);
}

let renderCalls = 0, loaded = 0;
const sandbox = {
  state: { mbs: { list: null, tried: false, err: '' } },
  render: () => { renderCalls++; },
  // The English half, so an assertion reads in the language this file is in.
  T: (en) => en,
  escAttr: (s) => String(s == null ? '' : s),
  rqName: (p) => p.name_en || p.name_cn || '',
  fmtDay: (v) => String(v || ''),
  nothingYet: (title, msg) => `[EMPTY]${title}|${msg}`,
  PILL: { clear: ['CLEARBG', 'CLEARFG'], success: ['OKBG', 'OKFG'],
          danger: ['BADBG', 'BADFG'], muted: ['MUTEBG', 'MUTEFG'] },
  // loadMbSent is the screen's first line; it must not fetch in here.
  api: () => { loaded++; return { then: () => ({ catch: () => {} }) }; },
  console, Number, String, Array, Object, JSON, Boolean,
};
vm.createContext(sandbox);
// The loader is sliced in rather than stubbed: the screen calls it on every
// paint, and its `tried` guard is what stops a repaint re-fetching.
vm.runInContext(sliceFn('loadMbSent'), sandbox, { filename: 'm.html#loadMbSent' });
vm.runInContext(sliceFn('mbsWord'), sandbox, { filename: 'm.html#mbsWord' });
vm.runInContext(sliceFn('screenAskBuySent'), sandbox, { filename: 'm.html#screenAskBuySent' });
// MBS_PILL is a const beside them, not a function — taken by its own line so the
// map under test is the shipped one rather than a copy written here.
const pillLine = SRC.split('\n').find(l => l.indexOf('const MBS_PILL=') === 0);
if (!pillLine) throw new Error('MBS_PILL not found in m.html');
vm.runInContext(pillLine, sandbox, { filename: 'm.html#MBS_PILL' });

const paint = (mbs) => {
  sandbox.state.mbs = Object.assign({ list: null, tried: true, err: '' }, mbs);
  renderCalls = 0;
  return vm.runInContext('screenAskBuySent()', sandbox);
};

console.log('\n══ 1 · unread, unreadable and empty are three different screens ══');
let html = paint({ list: null });
ok(html.indexOf('Loading…') !== -1, 'a list not read yet says so');
ok(html.indexOf('[EMPTY]') === -1, 'and is NOT drawn as an empty list');
html = paint({ list: [], err: 'That list could not be read. Try again.' });
ok(html.indexOf('could not be read') !== -1, 'a failed read says the read failed');
// TELLING A COOK THEY HAVE ASKED FOR NOTHING, WHEN THE READ FAILED, is the
// wrong thing to be told and the wrong thing to act on — mbBodyHtml on the
// screen next door records the same distinction being learned.
ok(html.indexOf('[EMPTY]') === -1, 'and never as "you have asked for nothing"');
html = paint({ list: [] });
ok(html.indexOf('[EMPTY]') === 0, 'a genuinely empty list gets the empty state');
ok(html.indexOf('shows up here') !== -1, 'which says what will appear there');

console.log('\n══ 2 · ONE request, three lines, three different states ══');
const MIXED = [{
  id: 5, mr_number: 'MR-0007', sent_at: '2026-09-18', withdrawn: false,
  items: [
    { id: 51, name_en: 'Flour', qty: 4, unit: 'bag', state: 'ordered' },
    { id: 52, name_en: 'Olive Oil', qty: 2, unit: 'bottle', state: 'waiting' },
    { id: 53, name_en: 'Dry Desiccant', qty: 1, unit: 'pcs', state: 'removed',
      declined_by_name: 'Mei' },
  ],
}];
html = paint({ list: MIXED });
eq(html.indexOf('MR-0007') !== -1, true, 'the request wears its number');
ok(html.indexOf('Ordered') !== -1 && html.indexOf('Waiting') !== -1 && html.indexOf('Removed') !== -1,
   'all three words appear on the ONE request');
// The colours are the claim, not the words: an ordered line and a removed line
// reading the same tone would be the screen saying nothing happened.
ok(html.indexOf('OKFG') !== -1, 'ordered is drawn as a success');
ok(html.indexOf('BADFG') !== -1, 'removed is drawn as a refusal');
ok(html.indexOf('CLEARFG') !== -1, 'waiting is drawn as neither');
eq(html.split('MR-0007').length - 1, 1, 'and the number is printed ONCE, not per line');

console.log('\n══ 3 · a removed line names who removed it ══');
ok(html.indexOf('Mei') !== -1, '"removed" with nobody attached is an event with no one to ask');
// Only the refused line carries a name: a waiting line has nobody to name, and
// printing the buyer on one would say somebody had acted.
const oilRow = html.slice(html.indexOf('Olive Oil'), html.indexOf('Dry Desiccant'));
ok(oilRow.indexOf('Mei') === -1, 'and a line nobody has touched names nobody');

console.log('\n══ 4 · a withdrawn request says so once, on the request ══');
html = paint({ list: [{ id: 6, mr_number: 'MR-0008', sent_at: '2026-09-18', withdrawn: true,
  items: [{ id: 61, name_en: 'Flour', qty: 1, unit: 'bag', state: 'removed' }] }] });
ok(html.indexOf('Withdrawn') !== -1, 'the withdrawal is shown');
eq(html.split('Withdrawn').length - 1, 1, 'once — it is the one genuinely request-level fact');
html = paint({ list: MIXED });
ok(html.indexOf('Withdrawn') === -1, 'and a live request is not labelled withdrawn');

console.log('\n══ 5 · no price and no purchase order number can reach the kitchen ══');
// The route sends neither (test_material_requests.js case 13). This is the
// second lock: even handed them, the screen prints nothing.
// The figures are deliberately unlike anything else the row prints — a price of
// 26 beside a date of 2026-09-18 passes this test for the wrong reason.
html = paint({ list: [{ id: 7, mr_number: 'MR-0009', sent_at: '2026-09-18', withdrawn: false,
  items: [{ id: 71, name_en: 'Flour', qty: 1, unit: 'bag', state: 'ordered',
            buy_price: 987654, cost_per_unit: 987654, sourced_po_id: 555111, po_number: 'RPO-0042' }] }] });
ok(html.indexOf('987654') === -1, 'a price handed to the screen is not drawn');
ok(html.indexOf('555111') === -1 && html.indexOf('RPO-0042') === -1, 'nor a purchase order');
ok(html.indexOf('Ordered') !== -1, 'the cook is still told it is on order');

console.log('\n══ 6 · the screen is wired in ══');
ok(/SUBS\.askbuysent\s*=/.test(SRC), 'it is registered as a screen');
ok(/\['askbuysent','[a-z-]+','Your buying requests','我的采购申请',null,'production'\]/.test(SRC),
   'it has a menu row, born gated on the same feature switch askbuy carries');
ok(/askbuysent:'production:request'/.test(SRC),
   'and the REQUESTER\'s capability, not a purchasing key');
// Reopening must re-read. Every other request screen in this file resets so the
// BASKET survives; this one resets so the ANSWER does not go stale — a cook
// comes back precisely because something may have changed.
ok(/route==='askbuysent'\)\{[^}]*tried=false/.test(SRC), 'and a reopen re-reads the list');
ok(/askbuysent[^\n]*\n/.test(SRC), 'the row exists in the shipped source');

console.log('\n══ 7 · painting reads once, and painting again does not ══');
// The screen calls its loader on every paint, so the `tried` guard is the only
// thing between a repaint and a second fetch. A list that re-reads on every
// render is a phone on kitchen wifi fetching in a loop.
loaded = 0; renderCalls = 0;
sandbox.state.mbs = { list: null, tried: false, err: '' };
vm.runInContext('screenAskBuySent()', sandbox);
eq(loaded, 1, 'the first paint reads the list');
vm.runInContext('screenAskBuySent()', sandbox);
eq(loaded, 1, 'and a second paint does not read it again');
// Drawing must never render(): render() replaces the whole app, so a screen
// that calls it while painting is a loop — the lesson the keyboard suite next
// door locks for the screen that raises these requests.
eq(renderCalls, 0, 'and drawing never calls render()');

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
