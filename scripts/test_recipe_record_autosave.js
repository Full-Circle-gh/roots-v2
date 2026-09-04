#!/usr/bin/env node
//
// test_recipe_record_autosave.js — the Recipes record's sticky header and its
// autosave, on the shipped files rather than a paraphrase of them.
//
// WHAT THIS IS FOR
// ----------------
// Two behaviours went onto that screen together and depend on each other:
//
//   * The header is STICKY, so which recipe this is, the way back and the save
//     state stay on screen through a recipe several screens tall — and once the
//     summary card has scrolled under the bar, the bar carries a miniature of
//     its figures, because "never let a recipe look free" is a rule about every
//     scroll position and not just the first one.
//
//   * The record SAVES ITSELF, which is only safe because every save files the
//     state it displaced (lib/recipe-versions.js, covered by
//     scripts/test_recipe_versions.js) and the History panel puts one back.
//
// The scheduling rules are where autosave goes wrong quietly, so they are what
// this covers: a plain debounce lets continuous typing postpone the save
// forever (case 2.2), an eligibility check that forgets the unnamed new recipe
// turns the record red on a POST that was always going to 400 (2.4), and a
// version that repainted after a background save would rebuild the inputs
// under a typing operator and eat his caret (3.x).
//
// HOW IT RUNS THE REAL CODE — nothing here is a paraphrase.
//   * scheduleAutosave / autosaveEligible / onRecScroll / agoText are LIFTED
//     OUT of public/retail-admin/19-recipes.js by brace matching and run in a
//     vm against stubs, so a rename or a reformat is reported, not passed.
//   * The markup and CSS assertions read the shipped retail-admin.html and
//     retail-admin.css.
//
// USAGE   node scripts/test_recipe_record_autosave.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const assert = require('assert');

const ROOT       = path.join(__dirname, '..');
const read       = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const RECIPES_JS = read('public', 'retail-admin', '19-recipes.js');
const ADMIN_HTML = read('public', 'retail-admin.html');
const ADMIN_CSS  = read('public', 'retail-admin.css');
const ROUTES_JS  = read('routes', 'retail-recipes.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failures++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
function section(t) { console.log('\n' + t); }

// Slice a named top-level function out of a shipped file, brace-matched, so
// what runs below is the source that ships rather than a copy of it. Anchored
// on the declaration alone — an anchor carrying surrounding lines breaks on a
// reformat and reports it as a missing feature.
function extractFunction(src, decl) {
  const at = src.indexOf(decl);
  assert.notStrictEqual(at, -1, `not found in the shipped file: ${decl}`);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(at, i + 1); }
  }
  throw new Error(`unbalanced braces after ${decl}`);
}
// The two timing constants, read from the file rather than restated here — a
// test that hardcodes 1200 and 8000 keeps passing after somebody changes them.
function extractConst(src, name) {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*(\\d+)').exec(src);
  assert.ok(m, `constant not found in the shipped file: ${name}`);
  return Number(m[1]);
}

// ═══════════════════════════════════════════════════════════════════════════
section('1. The header is sticky, and the page makes room for it being sticky');
// ═══════════════════════════════════════════════════════════════════════════

check('the record header is position:sticky at the top of the scroller', () => {
  const rule = /#tab-recipes-record \.rcp-rechead \{[\s\S]*?\}/.exec(ADMIN_CSS);
  assert.ok(rule, '.rcp-rechead rule missing');
  assert.match(rule[0], /position:\s*sticky/);
  assert.match(rule[0], /top:\s*0/);
});

// The element that actually scrolls is .rcp-scroll — `main` is overflow:hidden
// while the takeover is up. A sticky child of a non-scrolling ancestor pins to
// nothing, so this is the load-bearing half of the rule above.
check('.rcp-scroll is still the scrolling ancestor', () => {
  assert.match(ADMIN_CSS, /body\.rcp-viewing #tab-recipes-record \.rcp-scroll \{[^}]*overflow:\s*auto/);
  assert.match(ADMIN_CSS, /body\.rcp-viewing main \{[^}]*overflow:\s*hidden/);
});

// A gap of page padding sliding past a bar pinned at top:0 is the tell that a
// header was made sticky without anyone looking at it scrolled.
check('the page carries no top padding of its own — the bar carries it', () => {
  const m = /#tab-recipes-record \.rcp-page \{([^}]*)\}/.exec(ADMIN_CSS);
  assert.ok(m, '.rcp-page rule missing');
  assert.match(m[1], /padding:\s*0 /);
});

check('the hairline under the bar only appears once something has scrolled', () => {
  assert.match(ADMIN_CSS, /#tab-recipes-record \.rcp-rechead \{[^}]*border-bottom:\s*1px solid transparent/);
  assert.match(ADMIN_CSS, /#tab-recipes-record \.rcp-rechead\.stuck \{[^}]*border-bottom-color:\s*var\(--td-border\)/);
});

check('the bar carries the save state and the history button', () => {
  assert.match(ADMIN_HTML, /id="rcp-rec-savestate"/);
  assert.match(ADMIN_HTML, /id="rcp-rec-history"[^>]*onclick="rcpHistory\(\)"/);
});

// The pinned block carries the summary CARD itself, condensed. A second copy
// of its figures in the bar directly above it printed the same numbers twice,
// one line apart — which is what the miniature became once the card started
// pinning too. It is gone from the markup, the stylesheet and the painter, and
// this check is what stops it coming back.
check('there is no miniature of the summary card in the bar', () => {
  assert.doesNotMatch(ADMIN_HTML, /rcp-rec-stickyfigs|rcp-recfigs/);
  assert.doesNotMatch(ADMIN_CSS, /rcp-recfigs/);
  assert.doesNotMatch(RECIPES_JS, /paintStickyFigs|rcp-rec-stickyfigs/);
  assert.match(ADMIN_HTML, /class="rcp-summary" id="rcp-rec-summary"/);
});

// ═══════════════════════════════════════════════════════════════════════════
section('2. Autosave schedules the way it says it does');
// ═══════════════════════════════════════════════════════════════════════════

const IDLE = extractConst(RECIPES_JS, 'AUTOSAVE_IDLE_MS');
const MAX  = extractConst(RECIPES_JS, 'AUTOSAVE_MAX_MS');
console.log(`  (idle ${IDLE}ms, ceiling ${MAX}ms — read from the shipped file)`);

// One sandbox per case: the scheduler keeps module state (_autoDeadline) that
// is the whole point of the ceiling, so cases must not share it.
function schedulerSandbox(state) {
  const timers = [];
  const sandbox = {
    // module state the two functions close over
    _autoOff: false, _recOpen: true, _rec: { id: 7 }, _autoTimer: null, _autoDeadline: 0,
    AUTOSAVE_IDLE_MS: IDLE, AUTOSAVE_MAX_MS: MAX,
    can: () => true,
    val: () => 'Choco-Hazel Bars',
    saveNow: () => { sandbox.saved++; },
    saved: 0,
    // a clock and a timer queue the case drives by hand. advance() is a real
    // (if tiny) event loop: without one, a case can only observe what was
    // SCHEDULED and never what actually fired, and the ceiling below is a
    // statement about firing.
    now: 1000000,
    Date: { now: () => sandbox.now },
    setTimeout: (fn, ms) => { timers.push({ fn, at: sandbox.now + ms, ms }); return timers.length; },
    clearTimeout: (h) => { if (h) timers[h - 1] = null; },
    timers,
    firedAt: [],
    console,
  };
  sandbox.advance = (ms) => {
    const until = sandbox.now + ms;
    for (;;) {
      const due = timers.filter(Boolean).filter(t => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers[timers.indexOf(due)] = null;
      sandbox.now = due.at;
      sandbox.firedAt.push(due.at);
      due.fn();
    }
    sandbox.now = until;
  };
  Object.assign(sandbox, state || {});
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(RECIPES_JS, 'function canEdit('), sandbox);
  vm.runInContext(extractFunction(RECIPES_JS, 'function autosaveEligible('), sandbox);
  vm.runInContext(extractFunction(RECIPES_JS, 'function scheduleAutosave('), sandbox);
  vm.runInContext(extractFunction(RECIPES_JS, 'function cancelAutosave('), sandbox);
  return sandbox;
}
const lastTimer = (s) => s.timers.filter(Boolean).slice(-1)[0];

check('2.1 one edit schedules the save for the idle delay', () => {
  const s = schedulerSandbox();
  vm.runInContext('scheduleAutosave()', s);
  assert.strictEqual(lastTimer(s).ms, IDLE);
});

// THE CASE A PLAIN DEBOUNCE FAILS. Somebody typing a long note keeps pushing
// the save out; with a bare debounce the work sits in the browser for as long
// as they keep typing, which is exactly the situation autosave exists for.
check('2.2 continuous typing cannot postpone the save past the ceiling', () => {
  const s = schedulerSandbox();
  const start = s.now;
  vm.runInContext('scheduleAutosave()', s);          // first edit sets the deadline
  for (let i = 0; i < 40; i++) {                     // …then 40 more keystrokes,
    s.advance(500);                                  //    half a second apart
    vm.runInContext('scheduleAutosave()', s);        //    each one rescheduling
  }
  assert.ok(s.saved >= 1, 'the save never fired at all while the operator kept typing');
  assert.ok(s.firedAt[0] - start <= MAX,
    `the first save landed ${s.firedAt[0] - start}ms after the first edit, past the ${MAX}ms ceiling`);
});

// The other half of the same rule: a burst that STOPS is saved on the idle
// delay, not held to the ceiling.
check('2.2b typing that stops is saved one idle delay later', () => {
  const s = schedulerSandbox();
  const start = s.now;
  vm.runInContext('scheduleAutosave()', s);
  s.advance(IDLE - 1);
  assert.strictEqual(s.saved, 0, 'it must not fire before the idle delay is up');
  s.advance(2);
  assert.strictEqual(s.saved, 1);
  assert.strictEqual(s.firedAt[0] - start, IDLE);
});

check('2.3 the deadline is set by the first edit of a burst, not moved by later ones', () => {
  const s = schedulerSandbox();
  vm.runInContext('scheduleAutosave()', s);
  const first = s._autoDeadline;
  s.now += 3000;
  vm.runInContext('scheduleAutosave()', s);
  assert.strictEqual(s._autoDeadline, first);
  vm.runInContext('cancelAutosave()', s);
  assert.strictEqual(s._autoDeadline, 0, 'cancelling must clear the deadline for the next burst');
});

// A POST with no name is a guaranteed 400. Autosaving it would paint the bar
// red over a record whose only fault is that the operator has not finished
// typing the name — and would keep doing it every second.
check('2.4 a new recipe is not autosaved until it has a name', () => {
  const unnamed = schedulerSandbox({ _rec: { id: null }, val: () => '   ' });
  assert.strictEqual(vm.runInContext('autosaveEligible()', unnamed), false);
  vm.runInContext('scheduleAutosave()', unnamed);
  assert.strictEqual(unnamed.timers.filter(Boolean).length, 0, 'nothing should have been scheduled');

  const named = schedulerSandbox({ _rec: { id: null }, val: () => 'Choco-Hazel Bars' });
  assert.strictEqual(vm.runInContext('autosaveEligible()', named), true);
});

check('2.5 nothing autosaves without recipes:edit, or with the record closed', () => {
  assert.strictEqual(vm.runInContext('autosaveEligible()', schedulerSandbox({ can: () => false })), false);
  assert.strictEqual(vm.runInContext('autosaveEligible()', schedulerSandbox({ _recOpen: false })), false);
  // _autoOff is what archive and restore set: neither may have the on-screen
  // draft written back over the state they just established.
  assert.strictEqual(vm.runInContext('autosaveEligible()', schedulerSandbox({ _autoOff: true })), false);
});

// ═══════════════════════════════════════════════════════════════════════════
section('3. A background save never rebuilds the fields');
// ═══════════════════════════════════════════════════════════════════════════
//
// This is the failure that would make autosave unusable rather than merely
// wrong: paintRecord() rewrites host.innerHTML for all four sub-tab bodies, so
// running it on a timer would destroy the caret of whoever is typing. The file
// already keeps that discipline for ingredient edits (renderSubbody /
// paintLineWarns); these assert it for the save path.

check('saveNow repaints from the server only for a MANUAL save', () => {
  const saveNow = extractFunction(RECIPES_JS, 'async function saveNow(');
  assert.match(saveNow, /source === 'auto'\s*\)\s*mergeServerFacts\(/,
    'a background save must go through mergeServerFacts, not paintRecord');
  assert.ok(!/paintRecord\(/.test(saveNow), 'saveNow must not call paintRecord at all');
});

check('mergeServerFacts touches no draft and no input', () => {
  const merge = extractFunction(RECIPES_JS, 'function mergeServerFacts(');
  for (const forbidden of ['_lines', '_steps', 'paintRecord', 'innerHTML']) {
    assert.ok(!merge.includes(forbidden), `mergeServerFacts must not touch ${forbidden}`);
  }
  // What it IS for: the id a create just minted, and the material/products the
  // server derived.
  assert.match(merge, /_rec\.id = fresh\.id/);
  assert.match(merge, /_rec\.backsMaterial/);
});

check('the manual save is the one that repaints, and keeps the sub-tab', () => {
  const save = extractFunction(RECIPES_JS, 'window.rcpSave = async function');
  assert.match(save, /setRecord\(out\.fresh, true\); paintRecord\(\);/,
    'a manual save should repaint from the server and keep the operator on his tab');
});

// ═══════════════════════════════════════════════════════════════════════════
section('4. Every way out of the record puts the work on the wire');
// ═══════════════════════════════════════════════════════════════════════════
//
// There are five, and a save that only survives the Back button is not
// autosave. The rail click and the browser Back cannot await, so they START
// the save (flushSave reads the DOM before its first await) and let the
// takeover come down over it.

check('the Back button flushes and only then asks anything', () => {
  const back = extractFunction(RECIPES_JS, 'window.rcpRecordBack = async function');
  assert.match(back, /await leaveGuard\(\)/);
  const guard = extractFunction(RECIPES_JS, 'async function leaveGuard(');
  assert.match(guard, /await flushSave\(\)/);
  assert.match(guard, /askConfirm/, 'it must still ask when the work genuinely could not be saved');
});

check('a rail-tab click and the browser Back both start a save on the way out', () => {
  assert.match(RECIPES_JS, /data-tab\]'\)\)\s*\{ if \(_dirty\) flushSave\(\); teardown\(false\); \}/);
  assert.match(RECIPES_JS, /function onPop\(\) \{ if \(_dirty\) flushSave\(\); teardown\(true\);/);
});

check('a hidden tab and a closing window are covered too', () => {
  assert.match(RECIPES_JS, /visibilitychange[\s\S]{0,220}flushSave\(\)/);
  assert.match(RECIPES_JS, /beforeunload[\s\S]{0,260}preventDefault\(\)/);
});

check('opening a product from the header goes through the same guard', () => {
  const jump = extractFunction(RECIPES_JS, 'window.rcpOpenProduct = async function');
  assert.match(jump, /await leaveGuard\(\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
section('5. The bar tells the truth about the save, at any moment');
// ═══════════════════════════════════════════════════════════════════════════

function stateSandbox(state) {
  const el = { textContent: '', _cls: new Set(), classList: { toggle: (c, on) => { if (on) el._cls.add(c); else el._cls.delete(c); } } };
  const sandbox = {
    _saveErr: null, _saveInFlight: null, _dirty: false, _savedAt: 0,
    can: () => true,
    T: (en) => en,
    Date: { now: () => 1000000 },
    document: { getElementById: () => el },
    el, console,
  };
  Object.assign(sandbox, state || {});
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(RECIPES_JS, 'function canEdit('), sandbox);
  vm.runInContext(extractFunction(RECIPES_JS, 'function agoText('), sandbox);
  vm.runInContext(extractFunction(RECIPES_JS, 'function paintSaveState('), sandbox);
  vm.runInContext('paintSaveState()', sandbox);
  return sandbox;
}

check('an untouched record says nothing at all', () => {
  assert.strictEqual(stateSandbox().el.textContent, '');
});
check('an edit that has not gone yet says so', () => {
  assert.strictEqual(stateSandbox({ _dirty: true }).el.textContent, 'Unsaved changes');
});
check('a save on the wire says so', () => {
  assert.strictEqual(stateSandbox({ _dirty: true, _saveInFlight: {} }).el.textContent, 'Saving…');
});
check('a landed save says when', () => {
  const s = stateSandbox({ _savedAt: 1000000 - 5000 });
  assert.strictEqual(s.el.textContent, 'Saved · just now');
  const older = stateSandbox({ _savedAt: 1000000 - 4 * 60000 });
  assert.strictEqual(older.el.textContent, 'Saved · 4 min ago');
});
// The one state that must be impossible to miss: work that is NOT on the
// server, on a screen whose whole premise is that it gets there by itself.
check('a failure is named and marked, not swallowed', () => {
  const s = stateSandbox({ _dirty: true, _saveErr: { message: 'SKU already exists' } });
  assert.strictEqual(s.el.textContent, 'Not saved — SKU already exists');
  assert.ok(s.el._cls.has('err'), 'the failed state must carry the error class');
});
check('an operator who cannot edit is told that, not "unsaved"', () => {
  assert.strictEqual(stateSandbox({ _dirty: true, can: () => false }).el.textContent, 'Read only');
});

// ═══════════════════════════════════════════════════════════════════════════
section('6. The pinned block condenses, and publishes its height');
// ═══════════════════════════════════════════════════════════════════════════

// onRecScroll has two jobs left: the hairline and the condense, plus the height
// it publishes for the ingredient list's column header to park on. The summary
// card rides inside the pinned block, so there is no miniature to show or hide
// and no rect comparison to get wrong. These stubs hand it what it reads.
function scrollSandbox({ scrollTop, sumBottom, headBottom, headHeight, pinHeight, pinCondensed, sumHtml }, then = []) {
  // offsetHeight as well as the rect: the PINNED BLOCK's height is what the
  // ingredient list's column header parks on, and onRecScroll publishes it as a
  // custom property on the scroller. Stubbed to the bar's own bottom edge by
  // default, which is what it is while pinned at top 0.
  const head = { getBoundingClientRect: () => ({ bottom: headBottom }), _cls: new Set(),
    offsetHeight: headHeight === undefined ? headBottom : headHeight,
    classList: { toggle: (c, on) => { if (on) head._cls.add(c); else head._cls.delete(c); } } };
  // contains(), remove() and add() as well as toggle(): the condense reads its
  // own state back (it takes less scroll to STAY condensed than to become it),
  // and it takes the class off for one measurement of what the block would be
  // at rest — which is why the stub's height has to answer to the class, the
  // way the real block's does.
  const sc = { scrollTop, _vars: {}, _cls: new Set(),
    classList: { toggle: (c, on) => { if (on) sc._cls.add(c); else sc._cls.delete(c); },
      contains: (c) => sc._cls.has(c),
      add: (c) => sc._cls.add(c), remove: (c) => sc._cls.delete(c) },
    style: { setProperty: (k, v) => { sc._vars[k] = v; } } };
  // The block that actually pins: head + summary card + sub-tabs. Null-able on
  // purpose — onRecScroll falls back to the head, so a DOM without it still
  // publishes a usable offset rather than throwing. Its height is the expanded
  // one until the condensed class is on, exactly like the real one.
  const pin = pinHeight === undefined ? null : {
    get offsetHeight() {
      return (sc._cls.has('is-stuck') && pinCondensed !== undefined) ? pinCondensed : pinHeight;
    } };
  const sum = { getBoundingClientRect: () => ({ bottom: sumBottom }),
    innerHTML: sumHtml === undefined ? '<div/>' : sumHtml };
  const sandbox = {
    document: { getElementById: (id) => ({ 'rcp-rec-scroll': sc, 'rcp-rechead': head, 'rcp-pin': pin }[id] || null) },
    sumRoot: () => sum,
    head, sc, console,
  };
  vm.createContext(sandbox);
  // The at-rest height the handler remembers between calls lives outside the
  // function, so the sandbox has to hold it the way the module does.
  vm.runInContext('let _pinTall = 0;', sandbox);
  vm.runInContext(extractFunction(RECIPES_JS, 'function tallPinHeight('), sandbox);
  vm.runInContext(extractFunction(RECIPES_JS, 'function forgetPinHeight('), sandbox);
  vm.runInContext(extractFunction(RECIPES_JS, 'function onRecScroll('), sandbox);
  vm.runInContext('onRecScroll()', sandbox);
  // Later scroll positions on the SAME sandbox — a gesture, not a fresh page.
  for (const step of then) {
    sc.scrollTop = step.scrollTop;
    if (step.headBottom !== undefined) headBottom = step.headBottom;
    // A resize is the one thing that voids the measurement, so the handler is
    // given the same chance to forget it that the real resize listener has.
    if (step.resize) vm.runInContext('forgetPinHeight()', sandbox);
    vm.runInContext('onRecScroll()', sandbox);
  }
  return sandbox;
}

// The column header of the ingredient list is sticky and parks at the bottom
// edge of the pinned block. It cannot know that offset for itself — the block
// changes height as it condenses — so onRecScroll has to publish it on every
// scroll, in both states.
check('the pinned block publishes its height for the column header to park on', () => {
  const rest = scrollSandbox({ scrollTop: 0, sumBottom: 400, headBottom: 126, pinHeight: 268 });
  assert.strictEqual(rest.sc._vars['--rcp-headh'], '268px');
  // Condensed, the block is shorter, and the header has to move up with it.
  const small = scrollSandbox({ scrollTop: 320, sumBottom: 80, headBottom: 126,
    pinHeight: 268, pinCondensed: 132 });
  assert.strictEqual(small.sc._vars['--rcp-headh'], '132px');
  // No block in the DOM at all: fall back to the head rather than throw.
  assert.strictEqual(scrollSandbox({ scrollTop: 0, sumBottom: 400, headBottom: 126 })
    .sc._vars['--rcp-headh'], '126px');
});

// The block condenses on this class, and nothing else turns it on — so the
// threshold is behaviour, not decoration. 8px of slack keeps a resting
// trackpad's sub-pixel scrolls from flapping it open and shut.
check('the block condenses only once something has gone under it', () => {
  assert.ok(!scrollSandbox({ scrollTop: 0, sumBottom: 400, headBottom: 126, pinHeight: 268 })
    .sc._cls.has('is-stuck'), 'at rest it is not condensed');
  assert.ok(!scrollSandbox({ scrollTop: 6, sumBottom: 394, headBottom: 126, pinHeight: 268 })
    .sc._cls.has('is-stuck'), 'a resting hand\'s few pixels do not condense it');
  assert.ok(scrollSandbox({ scrollTop: 40, sumBottom: 360, headBottom: 126,
    pinHeight: 268, pinCondensed: 132 }).sc._cls.has('is-stuck'), 'scrolled, it is condensed');
});

// THE FLICKER, and why it was one. The block is the first thing in the
// document, so the ~130px it drops on condensing came out of the document: the
// rows below leapt up mid-gesture and, on a short tab, the scroll range went
// with them — the scroller clamped back to the top, the block expanded, the
// wheel crossed the threshold again, and the two states alternated for as long
// as the wheel moved. The give-back is what stops it, and it is MEASURED: a
// constant would be wrong for every recipe whose card carries a warning.
check('the condense hands back exactly what it takes, so the rows below hold still', () => {
  const s = scrollSandbox({ scrollTop: 0, sumBottom: 400, headBottom: 126,
    pinHeight: 268, pinCondensed: 132 }, [{ scrollTop: 40 }]);
  assert.strictEqual(s.sc._vars['--rcp-pinshrink'], '136px', '268 - 132 is what the document lost');
  assert.strictEqual(s.sc._vars['--rcp-headh'], '132px',
    'the column header parks on the bar the operator SEES, not on the space it holds');
});
check('back at the top, nothing is reserved for a state the block is not in', () => {
  const s = scrollSandbox({ scrollTop: 0, sumBottom: 400, headBottom: 126,
    pinHeight: 268, pinCondensed: 132 }, [{ scrollTop: 40 }, { scrollTop: 0 }]);
  assert.strictEqual(s.sc._vars['--rcp-pinshrink'], '0px');
  assert.ok(!s.sc._cls.has('is-stuck'));
});
// The at-rest height is MEASURED — the class comes off for one read and goes
// back on — so a record opened already scrolled (a restored position, a deep
// link) gives back the right space on its very first event, with no earlier
// expanded state to have remembered.
check('the give-back is right on the first event, with no rest state behind it', () => {
  const s = scrollSandbox({ scrollTop: 320, sumBottom: 80, headBottom: 126,
    pinHeight: 268, pinCondensed: 132 });
  assert.strictEqual(s.sc._vars['--rcp-pinshrink'], '136px');
  assert.ok(s.sc._cls.has('is-stuck'), 'the measurement puts the class back where it found it');
});
// A window dragged from wide to narrow rewraps the header row and the card, so
// a height taken at the old width is the wrong one to hand back at the new one.
// Forgetting beats correcting: the next event measures the width it is at.
check('a resize voids the measurement rather than handing back a stale one', () => {
  const s = scrollSandbox({ scrollTop: 0, sumBottom: 400, headBottom: 126,
    pinHeight: 268, pinCondensed: 132 }, [{ scrollTop: 40 }]);
  assert.strictEqual(s.sc._vars['--rcp-pinshrink'], '136px');
  // Narrower: both states grow a wrapped row, and the shrink is 156, not 136.
  const narrow = scrollSandbox({ scrollTop: 0, sumBottom: 400, headBottom: 126,
    pinHeight: 320, pinCondensed: 164 }, [{ scrollTop: 40, resize: true }]);
  assert.strictEqual(narrow.sc._vars['--rcp-pinshrink'], '156px');
});
// One threshold with a resting hand on it is a switch asked to be in two states
// at once. It takes 8px to condense and only 4 to stay condensed.
check('a hand resting just under the threshold does not flap the block', () => {
  const s = scrollSandbox({ scrollTop: 0, sumBottom: 400, headBottom: 126,
    pinHeight: 268, pinCondensed: 132 }, [{ scrollTop: 40 }, { scrollTop: 6 }]);
  assert.ok(s.sc._cls.has('is-stuck'), 'condensed, six pixels do not expand it again');
});
// The height is load-bearing: the give-back is measured from it, and a height
// that eases into place is wrong for as long as the ease lasts. Nothing about
// the block tweens, which is why the scroll that toggles the state lands it.
check('nothing about the pinned block tweens', () => {
  const pin = /#tab-recipes-record \.rcp-pin \{[^}]*\}/.exec(ADMIN_CSS);
  assert.ok(pin, '.rcp-pin rule missing');
  assert.doesNotMatch(pin[0], /transition/);
  const inner = /#tab-recipes-record \.rcp-pin > \.rcp-rechead \{[^}]*\}/.exec(ADMIN_CSS);
  assert.ok(inner, '.rcp-pin > .rcp-rechead rule missing');
  assert.doesNotMatch(inner[0], /transition/);
  assert.doesNotMatch(RECIPES_JS, /pin\.addEventListener\('transitionend'/);
});
// The give-back is margin BELOW the block, never height added back to it: a
// height fed from the height it is measured from is the loop this replaced.
check('the space is held in the stylesheet, on margin, from the measured value', () => {
  assert.match(ADMIN_CSS,
    /#tab-recipes-record \.rcp-pin \{ margin-bottom: var\(--rcp-pinshrink, 0px\); \}/);
  assert.doesNotMatch(ADMIN_CSS, /rcp-pin[^}]*\b(height|min-height):\s*var\(--rcp-pinshrink/);
});

check('at the top of the page there is no hairline under the bar', () => {
  const s = scrollSandbox({ scrollTop: 0, sumBottom: 400, headBottom: 126 });
  assert.strictEqual(s.head._cls.has('stuck'), false);
});
check('scrolled a little, the hairline is there', () => {
  const s = scrollSandbox({ scrollTop: 40, sumBottom: 360, headBottom: 126 });
  assert.strictEqual(s.head._cls.has('stuck'), true);
});
// A record whose summary has not been painted yet is the state onRecScroll used
// to have a branch for. It has none now, and must still publish the height
// rather than throw on the way past.
check('a record with no summary painted yet still publishes the height', () => {
  const s = scrollSandbox({ scrollTop: 900, sumBottom: 0, headBottom: 126, pinHeight: 132, sumHtml: '' });
  assert.strictEqual(s.sc._vars['--rcp-headh'], '132px');
});

// ═══════════════════════════════════════════════════════════════════════════
section('7. Autosave and its history ship together');
// ═══════════════════════════════════════════════════════════════════════════
//
// The one invariant worth failing the build over: a screen that writes to the
// record on a timer, with no filed previous state, is a delete key with no
// confirm. The behaviour of the filing itself is scripts/test_recipe_versions.js.

check('every save route files the state it displaces', () => {
  assert.match(ROUTES_JS, /snapshotRecipe\(db, req\.params\.id, \{ source: saveSourceOf\(req\)/,
    'the recipe update route must file a version before it writes');
  const costRoute = ROUTES_JS.slice(ROUTES_JS.indexOf("router.put('/api/retail-admin/recipes/:id/cost'"));
  assert.match(costRoute.slice(0, 1400), /snapshotRecipe\(/,
    'the cost route must file one too — a cost-only save is a real change');
});

check('the restore route exists, and does what a save does afterwards', () => {
  const at = ROUTES_JS.indexOf("router.post('/api/retail-admin/recipes/:id/versions/:versionId/restore'");
  assert.notStrictEqual(at, -1, 'no restore route');
  const body = ROUTES_JS.slice(at, at + 1600);
  assert.match(body, /restoreVersion\(/);
  assert.match(body, /fireRecompute\(/, 'a restore can move a linked material\'s cost, exactly as a save can');
  assert.match(body, /ensureMaterialized\(/);
});

check('the client offers the history and flushes before reading it', () => {
  const hist = extractFunction(RECIPES_JS, 'window.rcpHistory = async function');
  assert.match(hist, /await flushSave\(\)/, '"now" must really be now before the panel opens');
  assert.match(hist, /\/versions/);
});

check('a restore suspends autosave so the draft cannot be written back over it', () => {
  const modal = extractFunction(RECIPES_JS, 'function openHistoryModal(');
  assert.match(modal, /_autoOff = true;\s*\n\s*cancelAutosave\(\);/);
  assert.match(modal, /_autoOff = false;/, 'and must switch it back on afterwards');
});

console.log(failures === 0
  ? '\nAll assertions held.\n'
  : `\n${failures} assertion(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
