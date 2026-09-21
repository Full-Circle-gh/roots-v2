#!/usr/bin/env node
/**
 * Every state key the phone touches is declared in the literal, exactly once.
 *
 *   node scripts/test_mobile_state_keys.js
 *
 * READS ONE FILE. No browser, no database, no fixture — so it runs in the FAST
 * shard and is part of the gate. That is the whole reason this file exists.
 *
 * THE CHECK IS NOT NEW; ITS REACHABILITY IS. It has lived inside
 * test_mobile_screens.js since it was written, and that suite drives Chromium
 * through 157 screens, which puts it in the slow shard — the shard this repo
 * does not run, by Ash's standing instruction (CLAUDE.md; .github/workflows/
 * tests.yml is manual-only for the same reason). On 2026-09-18 §181 added three
 * state keys without declaring them. The check caught all three, correctly, that
 * day. Nobody heard it for three days, and it was found by a session running the
 * slow suite by hand for an unrelated reason. A check that costs milliseconds
 * has no business being reachable only through one that costs twelve minutes.
 *
 * WHAT IT PROTECTS, which is not what it looks like. Neither problem below
 * breaks anything today — writing to `state.whatever` simply creates the key.
 * What it protects against is the collision that announces itself to nobody:
 * `state.pos` was the operator's ROLE (loadMe writes it; the money gate reads
 * it) and a later edit reused it for the purchase-order list. Nothing threw; the
 * two took turns clobbering each other, and the symptom would have been revenue
 * appearing for a warehouse operator, which no render test looks for.
 *
 * THE PARSER IS PROVEN ABLE TO GO RED BEFORE IT IS BELIEVED. A checker of this
 * shape fails in one direction only — it stops finding things — and a silent
 * "0 problems" is indistinguishable from a healthy file. So every fixture below
 * that should FAIL is asserted to fail, and the two ways the check can be
 * unable to run at all are asserted to report themselves rather than pass.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { stateKeyProblems, stateLiteral } = require('./lib/m-state-keys');

const ROOT = path.join(__dirname, '..');
const MHTML = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');

let n = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); n++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

/* A miniature app: a script block, a state literal with the two shapes that
   defeat a regex (several keys on one line, and a nested object whose inner
   keys are NOT state keys), and some code that reads state. */
const app = (literalBody, body) =>
  `<html><style>:root{}</style><script>\nconst state = {\n${literalBody}\n};\n${body}\n</script></html>`;

console.log('\n1 · the parser can tell a declaration from everything that looks like one');

it('a clean file has nothing to report', () => {
  const r = stateKeyProblems(app("  a:null, b:0,\n  sw:{fapiao:true, affiliate:false},", 'state.a=1; if(state.b){} state.sw.fapiao=false;'));
  assert.strictEqual(r.error, null, r.error || '');
  assert.deepStrictEqual(r.dupes, []);
  assert.deepStrictEqual(r.undeclared, []);
});

it('a nested object\'s keys are not state keys', () => {
  // `sw:{fapiao:…}` is a map of feature flags. If the walker counted `fapiao`
  // as a top-level key, a real `state.fapiao` added tomorrow would be accepted.
  const r = stateKeyProblems(app('  sw:{fapiao:true},', 'state.fapiao=1;'));
  assert.deepStrictEqual(r.undeclared, ['fapiao'],
    'a key one level down was counted as declared at the top');
});

it('a colon inside a quoted string is not a declaration', () => {
  const r = stateKeyProblems(app("  tab:'home:x',", 'state.home=1;'));
  assert.deepStrictEqual(r.undeclared, ['home'],
    'text inside a string was read as a key');
});

console.log('\n2 · it is proven able to go red, in both directions');

it('a key used but never declared is reported', () => {
  const r = stateKeyProblems(app('  a:null,', 'state.a=1; state.ghost=2;'));
  assert.deepStrictEqual(r.undeclared, ['ghost']);
});

it('a key declared twice is reported', () => {
  const r = stateKeyProblems(app('  a:null,\n  a:false,', 'state.a=1;'));
  assert.deepStrictEqual(r.dupes, ['a']);
});

it('a comment does not hide a use — and a MIME wildcard does not hide the file', () => {
  /* The naive block-comment strip reads the slash-star in `image/*` as a
     comment OPENING and eats everything up to the next real comment close. On
     the orphan-command pass that was loud and wrong. HERE it would be silent
     and one-directional: source eaten is uses not counted, which can only hide
     an undeclared key. This fixture is that exact shape. */
  const body = `<input accept="image/*" onchange="x()">\nstate.ghost=1;\n/* a later comment */`;
  const r = stateKeyProblems(app('  a:null,', body));
  assert.deepStrictEqual(r.undeclared, ['ghost'],
    'an attribute wildcard swallowed the code after it, and the check went quiet');
});

console.log('\n3 · being unable to look never reads as having looked');

it('no script block is an error, not a pass', () => {
  const r = stateKeyProblems('<html><p>nothing here</p></html>');
  assert.ok(r.error, 'a file with no app in it reported no problems');
});

it('no state literal is an error, not a pass', () => {
  const r = stateKeyProblems('<html><script>\nconst notState = {a:1};\nstate.a=1;\n</script></html>');
  assert.ok(r.error, 'a file whose literal could not be found reported no problems');
});

console.log('\n4 · and the real file');

it('public/m.html declares every key it uses, once', () => {
  const r = stateKeyProblems(MHTML);
  assert.strictEqual(r.error, null, r.error || '');
  assert.deepStrictEqual(r.dupes, [],
    `declared twice: ${r.dupes.join(', ')} — two screens are sharing one name and taking turns clobbering it`);
  assert.deepStrictEqual(r.undeclared, [],
    `used but never declared: ${r.undeclared.join(', ')} — invisible in the literal, so the name is free for the next author to take`);
});

it('and there are enough of them that the check is actually looking', () => {
  // A parser that silently stopped matching would report zero problems over
  // zero keys. The floor is well under the ~300 the file carries today, so it
  // is a tripwire on the check breaking, not on the app growing or shrinking.
  const r = stateKeyProblems(MHTML);
  assert.ok(r.declaredCount > 200, `only ${r.declaredCount} keys declared — the walker has stopped reading the literal`);
  assert.ok(r.usedCount > 200, `only ${r.usedCount} keys used — the scan has stopped reading the app`);
});

it('the literal is handed over whole, so nobody has to guess a byte window', () => {
  // test_mobile_ask_strip.js asserts a key is declared a particular WAY. It
  // used to slice a fixed 6000 characters from `tab:'home'` and broke when a
  // comment was added above the key it wanted. Callers get the real bounds.
  const lit = stateLiteral(MHTML);
  assert.ok(lit.length > 10000, `the literal came back ${lit.length} characters long`);
  assert.ok(/\btab\s*:/.test(lit) && /\bcaps\s*:/.test(lit),
    'the literal is truncated — keys known to be in it are missing');
});

if (process.exitCode) {
  console.log('\nFAILED');
} else {
  console.log(`\nok — ${n} state-key checks, no browser, in the gate.`);
}
