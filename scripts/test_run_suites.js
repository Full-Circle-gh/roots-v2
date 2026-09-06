#!/usr/bin/env node
/**
 * The runner has to say WHICH case failed.
 *
 * scripts/run-suites.js prints a failing suite's output through tail(), and
 * tail() used to be the last 14 lines and nothing else. The reasoning was
 * written down — "the last few lines of a failure, which is where these suites
 * put their tally" — and it is true of a suite that ends in a summary block.
 *
 * IT IS NOT TRUE OF A SUITE THAT PRINTS `✗` INLINE AS IT GOES. On 2026-09-06
 * test_mobile_home.js failed its tenth case of twenty-six on CI. The runner
 * kept the twelve later `✓` lines and the bare count `1 of 26 home cases
 * failed.`, and discarded the one line naming the case. The job log was the
 * only copy of that output and it had already been thrown away, so the failure
 * could not be read from CI at all — it took five local runs and a concurrency
 * experiment to establish that it did not reproduce, and the actual failing
 * case is still unknown.
 *
 * A test runner that loses the failure is worse than one that prints too much:
 * the whole reason to read CI is to find out what broke. So this suite holds
 * the property directly — a failure ANYWHERE in the output must survive to the
 * report — and §2 rebuilds that exact 26-case shape as the regression case.
 *
 * IT IMPORTS THE REAL tail(). A copy here would prove nothing about the
 * function that ships, and the two would drift the first time either changed.
 * Same rule test_money_invariants.js states for the same reason.
 */
'use strict';

const { tail, FAIL_MARK } = require('./run-suites');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

// ─────────────────────────────────────────────────────────────────────────
section('1 · a failure early in a long run still reaches the report');

/* The shape that lost the diagnosis: many passing cases, one failing case well
   above the tail window, a bare count at the end. */
function homeShaped(failAt, total = 26) {
  const out = [];
  for (let i = 1; i <= total; i++) {
    out.push(i === failAt
      ? '  ✗ the picker offers what this role can reach — expected 7, got 6'
      : `  ✓ case ${i} — some checks`);
  }
  out.push('', `1 of ${total} home cases failed.`);
  return out.join('\n');
}

{
  const t = tail(homeShaped(10));
  yes(t.includes('the picker offers what this role can reach'),
    'the failing case is named, though it happened 16 lines above the tail');
  yes(t.includes('expected 7, got 6'), '…with its message, which is the part worth reading');
  yes(t.includes('1 of 26 home cases failed.'), 'and the tally still arrives');
}

/* The first case failing is the worst position for a tail — nothing but the
   failure is above it and everything below is noise. */
{
  const t = tail(homeShaped(1));
  yes(t.includes('the picker offers what this role can reach'),
    'a failure in the FIRST case survives too');
}

// ─────────────────────────────────────────────────────────────────────────
section('2 · a suite that fails late reads as it always did');

/* The old behaviour was correct for this shape and must not regress into
   printing the same line twice. */
{
  const t = tail(homeShaped(25));
  const hits = (t.match(/the picker offers what this role can reach/g) || []).length;
  is(hits, 1, 'a failure already inside the tail is shown once, not lifted and repeated');
}

// ─────────────────────────────────────────────────────────────────────────
section('3 · a suite with many failures does not bury the run');

{
  const many = [];
  for (let i = 1; i <= 300; i++) many.push(`  ✗ assertion ${i} failed`);
  many.push('', '300 failed.');
  const t = tail(many.join('\n'));
  const printed = (t.match(/assertion \d+ failed/g) || []).length;
  yes(printed < 40, `capped at ${printed} lines rather than printing all 300`);
  yes(/more failing line\(s\) above the tail/.test(t),
    '…and says how many it did not print, rather than trimming silently');
}

// ─────────────────────────────────────────────────────────────────────────
section('4 · what counts as a failing line');

/* Several suites in this repo mark failures differently, and a marker set that
   only knows one of them would lose the others. These are the forms actually
   in use, plus node:assert's own. */
for (const [line, why] of [
  ['  ✗ a thing that broke', 'the ✗ these suites print'],
  ['  ✘ another form', 'the ✘ variant'],
  ['FAIL scripts/thing.js', 'a bare FAIL prefix'],
  ['not ok 3 - the third thing', 'TAP output'],
  ['AssertionError [ERR_ASSERTION]: 1 !== 2', "node:assert's own throw"],
]) {
  yes(FAIL_MARK.test(line), `${why} is recognised`);
}

/* And what must NOT be, or every passing suite gets lifted into the report. */
for (const [line, why] of [
  ['  ✓ a thing that passed', 'a passing line'],
  ['  156 passed, 0 failed', 'a tally mentioning failures'],
  ['  writing failed.log for later', 'prose containing the word failed'],
]) {
  is(FAIL_MARK.test(line), false, `${why} is not treated as a failure`);
}

// ─────────────────────────────────────────────────────────────────────────
section('5 · the ordinary cases still behave');

is(tail('').trim(), '', 'empty output produces nothing rather than throwing');
{
  const t = tail('  ✓ one\n  ✓ two\n2 passed, 0 failed');
  yes(t.includes('2 passed, 0 failed'), 'a clean run is just its tail');
  is(/⋮/.test(t), false, '…with no lifted-lines marker when nothing was lifted');
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
