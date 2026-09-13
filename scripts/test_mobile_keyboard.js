#!/usr/bin/env node
/**
 * "keyboard doesn't go down."
 *
 *   node scripts/test_mobile_keyboard.js
 *
 * THE COMPLAINT, with two photographs of it: the expense claim with a note half
 * typed, and Add someone with a password in it. On both the soft keyboard
 * covered the button the person had come to press, and nothing on the screen
 * would put it down.
 *
 * WHY. A keyboard follows FOCUS, and public/m.html gave a field no ordinary way
 * to lose it. There is no <form> in the file, so the keyboard's action key has
 * nothing to submit, and with no `enterkeyhint` on the field Gboard draws that
 * key as **Go** — which on a formless page does nothing at all. Two rows above
 * the note field, mExpAmt closes cleanly, because somebody wrote
 * `enterkeyhint="done"` and an onkeydown that blurs on that one field. Fifty
 * inputs, six rescues.
 *
 * WHAT IS LOCKED HERE is the rule that replaced the rescues — kbField, kbHints,
 * kbEnterDown, kbTapAway in m.html, under "PUTTING THE KEYBOARD AWAY". Three
 * properties, and the third is the one that costs something if it goes wrong:
 *
 *   1. every typed field is given a Done key, on the paint that drew it, and
 *      a field that already declares its key (the search boxes) is left alone;
 *   2. Enter blurs an <input> — but NEVER a textarea, where Enter is a new
 *      line, and NEVER mid-composition, where Enter belongs to a Chinese
 *      operator choosing a pinyin candidate;
 *   3. a tap puts the keyboard down ONLY where the tap did not move focus
 *      itself. A tap on another field, or on a <label> that hands focus to
 *      one, must leave the browser alone — blurring there would shut the
 *      keyboard the tap had just opened.
 *
 * No browser and no network: the real functions are SLICED OUT OF THE SHIPPED
 * public/m.html and driven against a hand-built DOM, the technique
 * scripts/test_ask_to_buy_keyboard.js uses on the same file. Nothing is
 * asserted against a copy of the source — every check runs the shipped code.
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

/* Slice a top-level `function NAME(` out of the shipped file by matching
 * braces. Deliberately not a regex over the body: this file's functions are
 * full of template literals, and a lazy match would take half of one. */
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
/* The one const the rules read. Sliced too, so the list of "not a keyboard"
 * types under test is the shipped list and not a second copy of it. */
function sliceConst(name) {
  const start = SRC.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`const ${name} not found in m.html`);
  const end = SRC.indexOf('};', start);
  return SRC.slice(start, end + 2);
}

// ── A DOM, by hand ────────────────────────────────────────────────────────
// Only what the four functions actually touch. A fake that answered more than
// they ask is a fake that can pass while the real page does not.
class El {
  constructor(tag, attrs = {}) {
    this.tagName = String(tag).toUpperCase();
    this._a = { ...attrs };
    this.isContentEditable = false;
    this.parentEl = null;
    this.blurs = 0;
  }
  getAttribute(k) { return k in this._a ? this._a[k] : null; }
  setAttribute(k, v) { this._a[k] = String(v); }
  hasAttribute(k) { return k in this._a; }
  // Only 'label' is ever asked for, and it is asked of the tap target and its
  // ancestors — a field inside a wrapping <label> is the case that matters.
  closest(sel) {
    for (let n = this; n; n = n.parentEl) {
      if (String(sel).toLowerCase().split(',').some((s) => n.tagName === s.trim().toUpperCase())) return n;
    }
    return null;
  }
  blur() { this.blurs++; if (doc.activeElement === this) doc.activeElement = body; }
}
const body = new El('body');
const doc = { activeElement: body };

// The app root. querySelectorAll answers the ONE selector kbHints passes, and
// throws on anything else so a changed selector cannot pass unnoticed.
let painted = [];
const app = {
  querySelectorAll(sel) {
    if (sel !== 'input:not([enterkeyhint])') throw new Error('unexpected selector: ' + sel);
    return painted.filter((el) => el.tagName === 'INPUT' && !el.hasAttribute('enterkeyhint'));
  },
};

const sandbox = { document: doc, app, console, String, Number, Object };
vm.createContext(sandbox);
vm.runInContext(sliceConst('KB_NOT_TYPED'), sandbox, { filename: 'm.html#KB_NOT_TYPED' });
for (const fn of ['kbField', 'kbHints', 'kbEnterDown', 'kbTapAway']) {
  vm.runInContext(sliceFn(fn), sandbox, { filename: `m.html#${fn}` });
}
const { kbField, kbHints, kbEnterDown, kbTapAway } = sandbox;

const input = (attrs) => new El('input', attrs);
const focus = (el) => { doc.activeElement = el; return el; };

console.log('\n══ 1 · what a soft keyboard belongs to ══');
ok(kbField(input({})) !== null, 'a bare <input> is a typed field');
ok(kbField(input({ type: 'text' })) !== null, 'so is type=text');
ok(kbField(input({ type: 'TEL' })) !== null, 'and type=TEL — the type is read case-insensitively');
ok(kbField(new El('textarea')) !== null, 'a textarea is one too');
const ce = new El('div'); ce.isContentEditable = true;
ok(kbField(ce) !== null, 'and so is anything contenteditable');
for (const t of ['date', 'datetime-local', 'file', 'checkbox', 'radio', 'button', 'submit', 'range', 'color']) {
  ok(kbField(input({ type: t })) === null, `type=${t} opens no keyboard, so it is not one`);
}
ok(kbField(new El('div')) === null, 'a plain div is not a field');
ok(kbField(new El('select')) === null,
   'nor is a <select> — it has a picker, not a keyboard, and blurring it would close that');
ok(kbField(null) === null, 'and nothing is not a field');

console.log('\n══ 2 · every typed field is given a Done key, on the paint that drew it ══');
const bare = input({ id: 'mExpNote' });
const search = input({ id: 'mExpQ', inputmode: 'search', enterkeyhint: 'search' });
const date = input({ id: 'mExpDate', type: 'date' });
const file = input({ type: 'file', accept: 'image/*' });
const area = new El('textarea');
painted = [bare, search, date, file, area];
kbHints();
eq(bare.getAttribute('enterkeyhint'), 'done', 'the note field gets Done');
eq(search.getAttribute('enterkeyhint'), 'search',
   'a field that already says what its key is keeps it');
eq(date.getAttribute('enterkeyhint'), null, 'a date field is left alone');
eq(file.getAttribute('enterkeyhint'), null, 'and so is a file field');
eq(area.getAttribute('enterkeyhint'), null,
   'a textarea is never given Done — its Enter is a new line');
kbHints();
eq(bare.getAttribute('enterkeyhint'), 'done', 'a second paint changes nothing');

console.log('\n══ 3 · Enter blurs ══');
const typed = focus(input({ id: 'mTmPass' }));
kbEnterDown({ key: 'Enter', target: typed });
eq(typed.blurs, 1, 'Enter in a field puts the keyboard down');
kbEnterDown({ key: 'a', target: typed });
eq(typed.blurs, 1, 'an ordinary letter does not');
kbEnterDown({ key: 'Enter', target: typed, metaKey: true });
eq(typed.blurs, 1, 'and neither does a modified Enter');
const mid = input({});
kbEnterDown({ key: 'Enter', target: mid, isComposing: true });
eq(mid.blurs, 0, 'MID-PINYIN Enter is the operator choosing a candidate, not a request to leave');
kbEnterDown({ key: 'Enter', target: mid, keyCode: 229 });
eq(mid.blurs, 0, '...including the keyCode 229 spelling of the same thing');
const ta = new El('textarea');
kbEnterDown({ key: 'Enter', target: ta });
eq(ta.blurs, 0, 'Enter in a textarea is a new line and is left alone');
const btn = new El('button');
kbEnterDown({ key: 'Enter', target: btn });
eq(btn.blurs, 0, 'Enter on a button is how a button is pressed');
kbEnterDown({ key: 'Enter', target: null });
ok(true, 'and a keydown with no target does not throw');

console.log('\n══ 4 · a tap that is not on a field puts the keyboard down ══');
const note = focus(input({ id: 'mExpNote' }));
kbTapAway({ target: new El('div') });
eq(note.blurs, 1, 'a tap on the page closes the keyboard');
eq(doc.activeElement, body, 'and the field is no longer focused');

const still = focus(input({ id: 'mExpNote' }));
kbTapAway({ target: still });
eq(still.blurs, 0, 'a tap INSIDE the field keeps it — that is where the caret goes');

const moved = focus(input({ id: 'mTmUser' }));
kbTapAway({ target: input({ id: 'mTmPass' }) });
eq(moved.blurs, 0,
   'a tap on ANOTHER field leaves the browser alone — it has already moved focus');

const viaLabel = focus(input({ id: 'mTmName' }));
const label = new El('label');
const inner = new El('span'); inner.parentEl = label;
kbTapAway({ target: inner });
eq(viaLabel.blurs, 0, 'a tap inside a <label> hands focus on, so nothing is taken away');

doc.activeElement = body;
const idle = input({});
kbTapAway({ target: new El('div') });
eq(idle.blurs, 0, 'with nothing focused there is nothing to close');
doc.activeElement = focus(new El('select'));
kbTapAway({ target: new El('div') });
eq(doc.activeElement.blurs, 0, 'a tap beside an open <select> does not reach in and close it');
doc.activeElement = focus(input({}));
kbTapAway({});
eq(doc.activeElement.blurs, 0, 'and an event with no target does nothing rather than throwing');

console.log('\n══ 5 · the rules are wired into the shipped app ══');
ok(/\n\s*kbHints\(\);/.test(SRC.slice(SRC.indexOf('function render('))),
   'render() asks for the Done keys after every paint');
ok(/document\.addEventListener\('keydown',\s*kbEnterDown\)/.test(SRC),
   'Enter is delegated once, for the whole app');
ok(/document\.addEventListener\('click',\s*kbTapAway\)/.test(SRC),
   "the tap rule listens on 'click' — resolved at touch-UP, after the control's own handler");
ok(!/document\.addEventListener\('(pointerdown|touchstart)',\s*kbTapAway/.test(SRC),
   '...and NOT at touch-down, which is the defect the scrim rule above it records');

console.log('\n══ 6 · the two screens the complaint came from ══');
// Read off the shipped markup: neither field declares a key of its own, so both
// depend on the paint-time pass above. If somebody hand-writes one later this
// still passes — what must not happen is the field going back to having no key
// at all, which is what these two ids are here to notice.
for (const [id, what] of [['mExpNote', 'the expense claim note'], ['mTmPass', 'the Add someone password']]) {
  const m = SRC.indexOf(`id="${id}"`);
  ok(m > 0, `${what} (#${id}) is still on the screen it was photographed on`);
  const tag = SRC.slice(SRC.lastIndexOf('<input', m), SRC.indexOf('>', m) + 1);
  ok(!/type="(date|file|checkbox|radio)"/.test(tag),
     `...and is a typed field, so the Done-key pass reaches it`);
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
