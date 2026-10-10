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
 *      keyboard the tap had just opened. AND THAT INCLUDES A FIELD THE TAP
 *      OPENED: the count on Ask to buy, and every control like it, repaints
 *      its row into an <input> and focuses it inside its own onclick, so the
 *      tap target is gone and the focused field is brand new by the time the
 *      rule runs. Blurring there committed and shut the field in the same tap,
 *      which is why free-typing a quantity did nothing at all — "i cant add a
 *      number manually", of a field that opens, focuses and closes correctly
 *      when called directly. That is the shape of this defect: every function
 *      test around it passed, because no click bubbles in a function test.
 *      What the rule closes is a keyboard that was ALREADY OPEN, so it reads
 *      the focus as of touch-down (kbTouchDown) and compares.
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
  get id() { return this._a.id || ''; }   // a real element reflects the attribute
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
/* The one binding the tap rule keeps between touch-down and click. Lifted from
 * the shipped line rather than declared here: a second `let kbWas` in this file
 * would be a copy of the source, and the whole technique of this suite is that
 * there are none. */
function sliceLet(name) {
  const m = SRC.match(new RegExp(`^let ${name}=.*$`, 'm'));
  if (!m) throw new Error(`let ${name} not found in m.html`);
  return m[0];
}
vm.runInContext(sliceLet('kbWas'), sandbox, { filename: 'm.html#kbWas' });
for (const fn of ['kbField', 'kbHints', 'kbEnterDown', 'kbTouchDown', 'kbTapAway']) {
  vm.runInContext(sliceFn(fn), sandbox, { filename: `m.html#${fn}` });
}
const { kbField, kbHints, kbEnterDown, kbTouchDown, kbTapAway } = sandbox;

const input = (attrs) => new El('input', attrs);
/* FOCUS AS OF TOUCH-DOWN, which is what a real tap gives the rule: the browser
 * fires pointerdown before the control's own handler runs, so kbTouchDown() has been
 * and gone by the time anything is clicked. A case that wants the other
 * situation — a tap that moved focus itself — calls kbTouchDown() first and moves
 * focus after, which is the order a real one happens in. */
const focus = (el) => { doc.activeElement = el; kbTouchDown(); return el; };

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

console.log('\n══ 4b · a field the tap itself opened is NOT closed by that tap ══');
/* THE DEFECT, in the state a real tap leaves behind. Nothing was focused when
   the finger went down; the count's own onclick repainted the row, which threw
   the tapped button out of the document, and focused the <input> it had just
   written. The old rule saw a focused field and a target that was neither the
   field nor a field, and blurred — mbTypeCommit then shut the field on the way
   out, so the tap did nothing visible and no quantity could be typed. */
doc.activeElement = body; kbTouchDown();           // finger down on a row at rest
const gone = new El('button'); gone.isConnected = false;   // repainted away by its own handler
const opened = input({ id: 'mbnum-54' }); doc.activeElement = opened;
kbTapAway({ target: gone });
eq(opened.blurs, 0, 'the count field opened by the tap survives the tap that opened it');
eq(doc.activeElement, opened, '...and still has the caret, so the keyboard is up on digits');

/* The same thing where the tap came from a field: a search box focused, and a
   control that opens a number field on the row below it. Focus moved DURING the
   tap, so the rule has nothing to say. */
const searching = focus(input({ id: 'mMbQ' }));
const opened2 = input({ id: 'mbnum-54' }); doc.activeElement = opened2;
kbTapAway({ target: new El('div') });
eq(opened2.blurs, 0, 'a tap that moved focus from one field to another leaves both alone');
eq(searching.blurs, 0, '...and does not reach back for the field it came from');

/* A click with no touch-down before it — a synthetic .click(), a button pressed
   with Enter — closes nothing. The safe direction for a rule that only ever
   takes a keyboard away. */
sandbox.kbWas = null;
const untouched = input({ id: 'mExpNote' }); doc.activeElement = untouched;
kbTapAway({ target: new El('div') });
eq(untouched.blurs, 0, 'a click with no tap behind it takes no keyboard away');

/* AND THE RULE STILL FIRES ON THE ORDINARY TAP. Same field before and after, so
   the tap took nothing from the browser and the keyboard is the tap's to close —
   this is the complaint the whole section was written for. */
const covered = focus(input({ id: 'mExpNote' }));
kbTapAway({ target: new El('div') });
eq(covered.blurs, 1, 'a keyboard that was already open still goes down on a tap on the page');

console.log('\n══ 5 · the rules are wired into the shipped app ══');
ok(/\n\s*kbHints\(\);/.test(SRC.slice(SRC.indexOf('function render('))),
   'render() asks for the Done keys after every paint');
ok(/document\.addEventListener\('keydown',\s*kbEnterDown\)/.test(SRC),
   'Enter is delegated once, for the whole app');
ok(/document\.addEventListener\('click',\s*kbTapAway\)/.test(SRC),
   "the tap rule listens on 'click' — resolved at touch-UP, after the control's own handler");
ok(!/document\.addEventListener\('(pointerdown|touchstart)',\s*kbTapAway/.test(SRC),
   '...and NOT at touch-down, which is the defect the scrim rule above it records');
ok(/document\.addEventListener\('pointerdown',\s*kbTouchDown,\s*true\)/.test(SRC)
   && /document\.addEventListener\('mousedown',\s*kbTouchDown,\s*true\)/.test(SRC),
   'touch-down only RECORDS which field the keyboard was on, in both spellings, in capture');
ok(/function kbTouchDown\(\)\{\s*kbWas=kbField\(document\.activeElement\);\s*\}/.test(SRC),
   '...and records it by reading focus, so a tap that moves focus can be told apart');

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

console.log('\n══ 7 · a keyboard the phone put away lets go of its field ══');
/* "the keyboard sometimes pops up with no reason at all" — Settings → Team, and
   a role. Android's down-arrow hides the keyboard and leaves the field focused,
   and a focused field is one the phone hands the keyboard back to by itself. */
const timers = [];
const vv = { height: 800 };
Object.assign(sandbox, { window: { visualViewport: vv }, setTimeout: (f) => timers.push(f), state: { focus: null } });
const settle = () => { while (timers.length) timers.shift()(); };
const kbVar = (n) => vm.runInContext(n, sandbox);
vm.runInContext(SRC.match(/^const KB_OPEN_PX=.*$/m)[0], sandbox, { filename: 'm.html#KB_OPEN_PX' });
vm.runInContext(sliceLet('kbBase'), sandbox, { filename: 'm.html#kbBase' });
/* kbMark is the html.kb-up toggle these call (§325 K1: the one function of
   that name now). The page element is given a classList to toggle. */
const kbUpClass = new Set();
doc.documentElement = { classList: { toggle: (c, on) => { if (on) kbUpClass.add(c); else kbUpClass.delete(c); } } };
for (const fn of ['kbMark', 'kbFocusIn', 'kbFocusOut', 'kbViewport']) {
  vm.runInContext(sliceFn(fn), sandbox, { filename: `m.html#${fn}` });
}
const { kbFocusIn, kbFocusOut, kbViewport } = sandbox;
const enter = (el) => { doc.activeElement = el; kbFocusIn({ target: el }); return el; };
const leave = (el, to) => { doc.activeElement = to || body; kbFocusOut({ target: el }); settle(); };

const roleName = enter(input({ id: 'mTmRoleEn' }));
eq(kbVar('kbBase'), 800, 'the full height is read when the field takes focus, before the keyboard rises');
kbViewport(480);
eq(roleName.blurs, 0, 'the keyboard rising takes nothing away');
kbViewport(470);
eq(roleName.blurs, 0, '...nor does it changing height while up (a pinyin candidate bar)');
kbViewport(800);
eq(roleName.blurs, 1, 'the keyboard put away by the phone blurs the field it left behind');
leave(roleName);   // the focusout a real blur fires
eq(kbVar('kbBase'), null, '...and with nothing focused there is nothing left to measure');

const noKb = enter(input({ id: 'mTmRoleCn' }));
kbViewport(760);
kbViewport(800);
eq(noKb.blurs, 0, 'a view that never shrank past a keyboard (toolbar, floating keyboard) blurs nothing');
leave(noKb);

vv.height = 800;
const first = enter(input({ id: 'mTmRoleEn' }));
kbViewport(480);
vv.height = 480;
const second = input({ id: 'mTmRoleCn' });
leave(first, second); kbFocusIn({ target: second });
eq(kbVar('kbBase'), 800, 'hopping to the next field keeps the height measured before the keyboard rose');
kbViewport(800);
eq(second.blurs, 1, '...so putting the keyboard away from the second field still lets go of it');
leave(second);

const sel = new El('select'); doc.activeElement = sel; kbFocusIn({ target: sel });
eq(kbVar('kbBase'), null, 'a <select> opens a picker, not a keyboard, and is not measured');
doc.activeElement = body;

console.log('\n══ 8 · a caret request dies with its field ══');
/* Five search boxes arm state.focus on every keystroke and repaint only their
   results. Left armed after the keyboard was put away, the next full paint of
   the screen put the caret back and opened the keyboard. */
const rcpQ = enter(input({ id: 'mRcpQ' }));
sandbox.state.focus = { id: 'mRcpQ', pos: 2 };
leave(rcpQ);
eq(sandbox.state.focus, null, 'leaving the field cancels its caret request');

const wstQ = enter(input({ id: 'mWstQ' }));
sandbox.state.focus = { id: 'mWstQ', pos: 1 };
vm.runInContext('kbPainting=true', sandbox);
kbFocusOut({ target: wstQ });
vm.runInContext('kbPainting=false', sandbox);
eq(JSON.stringify(sandbox.state.focus), '{"id":"mWstQ","pos":1}',
   'render() tearing the field down is NOT leaving it — that is the paint the request exists to survive');
settle();

sandbox.state.focus = { id: 'mOrdNote' };
const other = enter(input({ id: 'mOnwCustQ' }));
leave(other);
eq(JSON.stringify(sandbox.state.focus), '{"id":"mOrdNote"}',
   'leaving a different field leaves a request for a field about to be drawn alone');

console.log('\n══ 9 · both rules are wired into the shipped app ══');
ok(/document\.addEventListener\('focusin',\s*kbFocusIn,\s*true\)/.test(SRC)
   && /document\.addEventListener\('focusout',\s*kbFocusOut,\s*true\)/.test(SRC),
   'focus in and out are watched once, for the whole app');
ok(/visualViewport\.addEventListener\('resize',\s*\(\)=>kbViewport\(/.test(SRC),
   'the visible height is what tells the keyboard went away');
const rsrc = sliceFn('render');
ok(/kbPainting=true;\s*app\.innerHTML = html;[^]*?kbPainting=false;/.test(rsrc),
   "render() flags its own teardown, so the field it rebuilds keeps its caret");

console.log('\n══ 10 · §325 K1 · the touch-down the SHIPPED listeners call is the one that records ══');
/* THE DEFECT THIS SECTION EXISTS FOR. The touch-down was called kbMark, and so
   was the html.kb-up toggle sixty lines below it; two function declarations
   with one name keep only the LATER, so pointerdown ran the toggle, kbWas was
   never set, and a tap away from a field never closed the keyboard. Every case
   above passed the whole time, because sliceFn takes the FIRST declaration of
   a name and drove the dead copy. So here the name is read from the listeners
   themselves and resolved the way the browser resolves it — the LAST
   declaration of that name in the file — and the tap is run through that. */
{
  // Every capture-phase pointerdown listener in the file, each resolved to the
  // declaration the browser would call (the LAST of its name) — the touch-down
  // is the one whose resolved body records kbWas. Under the defect, none did.
  const lastFn = (name) => {
    const at = SRC.lastIndexOf(`function ${name}(`);
    if (at < 0) return '';
    let depth = 0;
    for (let j = SRC.indexOf('{', at); j < SRC.length; j++) {
      if (SRC[j] === '{') depth++;
      else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(at, j + 1); }
    }
    return '';
  };
  const listeners = [...SRC.matchAll(/document\.addEventListener\('pointerdown',\s*([A-Za-z_$][\w$]*),\s*true\)/g)].map((m) => m[1]);
  const recording = listeners.filter((n) => /kbWas\s*=/.test(lastFn(n)));
  eq(recording.length, 1, 'exactly one pointerdown listener, as the browser resolves it, records which field had the keyboard');
  const handler = recording[0];
  ok(!!handler && SRC.includes(`document.addEventListener('mousedown', ${handler}, true)`), `…and mousedown calls the same one (${handler})`);
  eq(SRC.split(`function ${handler}(`).length - 1, 1, `"${handler}" is declared exactly once, so nothing can shadow it`);
  const body = lastFn(handler);
  const box = { document: doc, String, Object };
  vm.createContext(box);
  vm.runInContext(sliceConst('KB_NOT_TYPED'), box);
  vm.runInContext(sliceLet('kbWas'), box);
  for (const fn of ['kbField', 'kbTapAway']) vm.runInContext(sliceFn(fn), box);
  vm.runInContext(body, box);
  const out = input({ id: 'mExpNote' });
  doc.activeElement = out; box[handler]();               // finger down, keyboard open
  box.kbTapAway({ target: new El('div') });             // lifted on the page
  eq(out.blurs, 1, 'a tap OUTSIDE a focused field, through the shipped listener, closes the keyboard');
  const inside = input({ id: 'mExpNote' });
  doc.activeElement = inside; box[handler]();
  box.kbTapAway({ target: inside });
  eq(inside.blurs, 0, 'a tap INSIDE it does not');
}

console.log('\n══ 11 · the expense form keeps its caret when its own reads answer ══');
/* "keyboard going down automatically sometimes when I click on amount"
   (2026-10-09). The form reads its categories and the person's past claims
   AFTER it is on screen, and each answer repainted the whole app — so a tap on
   the amount that beat the network had its field rebuilt under it and the
   keyboard dropped. Both reads now repaint through expRepaint, which asks for
   the caret back when one of the form's typed fields holds it. */
{
  const st = { focus: null };
  let paints = 0;
  const box = { document: doc, state: st, render: () => { paints++; } };
  vm.createContext(box);
  vm.runInContext(sliceFn('expRepaint'), box, { filename: 'm.html#expRepaint' });

  const amt = input({ id: 'mExpAmt' }); amt.selectionStart = 4;
  doc.activeElement = amt;
  box.expRepaint();
  eq(paints, 1, 'it paints');
  eq(JSON.stringify(st.focus), JSON.stringify({ id: 'mExpAmt', pos: 4 }),
     'typing in the amount: the caret is asked back, where it was');

  st.focus = null;
  const note = input({ id: 'mExpNote' }); note.selectionStart = 2;
  doc.activeElement = note;
  box.expRepaint();
  eq(st.focus && st.focus.id, 'mExpNote', 'the note keeps its caret the same way');

  st.focus = null; doc.activeElement = body;
  box.expRepaint();
  eq(st.focus, null, 'nobody typing: no caret is asked for, so no keyboard opens by itself');

  st.focus = null; doc.activeElement = input({ id: 'mExpQ' });
  box.expRepaint();
  eq(st.focus, null, 'a field that is not the form\'s is left to its own rules');

  const armed = { id: 'mExpAmt', pos: 1 };
  st.focus = armed; amt.selectionStart = 3; doc.activeElement = amt;
  box.expRepaint();
  ok(st.focus === armed, 'a caret request already armed is not overwritten');

  const loaders = sliceFn('expLoadMeta') + sliceFn('expLoadMine');
  ok(!/\brender\(\)/.test(loaders) && (loaders.match(/expRepaint\(\)/g) || []).length === 4,
     'both reads, answer and failure alike, repaint through expRepaint and never bare render()');
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
