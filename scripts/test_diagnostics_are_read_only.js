// Every scripts/diagnose_*.js is trusted to be read-only. This checks it.
//
// WHY. .github/workflows/ro-query.yml — "Read-only prod query" — will run ANY
// file matching scripts/diagnose_*.js against the LIVE database, and its only
// gate is that file-name shape:
//
//     case "$S" in
//       scripts/diagnose_*.js) ;;
//       *) echo "::error::Only scripts/diagnose_*.js may be run here"; exit 1 ;;
//     esac
//
// The name is the whole of the permission. Nothing else stops a script called
// diagnose_something.js from holding a writable handle to production, and the
// workflow's own header promises the opposite: *"The script it runs opens
// SQLite with `readonly: true` and PROVES that on the connection by attempting
// a write and aborting if the write is accepted."* That promise lived in a
// comment and in each author's care, which is not a mechanism.
//
// IT HAD ALREADY BEEN BROKEN TWICE when this was written, 2026-09-15:
//   diagnose_hide_qr_flags.js       opened the database through
//     `require('../database.js')` — the APPLICATION'S handle, opened
//     READ-WRITE. Written by this session earlier the same day. It never wrote
//     anything and failed on the box for an unrelated reason (the workflow
//     stages the script alone and stubs database.js), so the mistake surfaced
//     as MODULE_NOT_FOUND rather than as what it was.
//   diagnose_variant_descriptions.js  opened data/roots.db with no options at
//     all, so read-write by default.
// Both are fixed. A convention this load-bearing needs a test, not a comment.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SCRIPTS = __dirname;
const files = fs.readdirSync(SCRIPTS).filter(f => /^diagnose_.*\.js$/.test(f)).sort();

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '\n      ' + e : '')); };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { bad(m, e.message); } };

console.log(`\nThe ${files.length} scripts the prod-query workflow will run against the live database`);

check('the workflow still gates on the name alone, so this is the right set', () => {
  assert.ok(files.length > 0, 'no diagnose_*.js found — has the convention been renamed?');
  const wf = fs.readFileSync(path.join(SCRIPTS, '..', '.github/workflows/ro-query.yml'), 'utf8');
  assert.ok(/scripts\/diagnose_\*\.js/.test(wf),
    'ro-query.yml no longer gates on scripts/diagnose_*.js — this test is checking the wrong set');
});

/* NOT EVERY DIAGNOSTIC TOUCHES A DATABASE. Several read the deployed file tree,
   a diff, or an HTTP response and never open SQLite — there is nothing for them
   to be read-only about, and failing them would be this test being wrong rather
   than those scripts. Counted, not scored. */
/* A SCRATCH DATABASE IS NOT THE LIVE ONE, and three of these deliberately open
   a writable throwaway — the seam audits create s.db / scratch.db in a temp
   directory and WRITE to it, which is the whole point of auditing the seam.
   Failing them would be this test misreading what it is looking at, which it
   did on its first run. So the question asked of each `new Database(...)` is
   not "is it readonly" but "is this the LIVE database": the one opened on
   DB_PATH, ROOTS_DB, or a literal roots.db. */
/* THE CALL HAS NESTED PARENTHESES, and a character class cannot see past them.
   The first draft of this used /new Database\([^)]*\)/, which on
       new Database(path.join(__dirname, '..', 'data', 'roots.db'), { readonly: true })
   matches only as far as the ) that closes path.join — so it never sees the
   options object and reported five perfectly correct scripts as writable. The
   scan below balances parentheses instead. Worth the twelve lines: a checker
   that cries wolf is one whose next real finding gets waved through. */
function databaseOpens(code) {
  const out = [];
  const re = /new Database\(/g;
  let m;
  while ((m = re.exec(code))) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')' && --depth === 0) break;
    }
    out.push(code.slice(m.index, i + 1));
  }
  return out;
}
// Which of those opens the LIVE database rather than a scratch file.
const isLive = (call) => /\bDB_PATH\b|\bROOTS_DB\b|roots\.db/.test(call);
const opensLive = [], scratchOnly = [], noDb = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
  // Comments explain the rule; only code can break it.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const live = databaseOpens(code).filter(isLive);
  const borrows = /require\([^)]*database\.js[^)]*\)/.test(code);
  if (live.length || borrows) opensLive.push({ f, code, live, borrows });
  else if (/new Database\(/.test(code)) scratchOnly.push({ f, code });
  else noDb.push({ f });
}
console.log(`  ${opensLive.length} open the LIVE database; ${scratchOnly.length} open only a scratch one; ` +
            `${noDb.length} read files or HTTP and never open one.\n`);

check('NONE borrows the application’s writable handle', () => {
  const borrowers = opensLive.filter(x => x.borrows).map(x => x.f);
  assert.deepStrictEqual(borrowers, [],
    'these require database.js, which opens the live database READ-WRITE: ' + borrowers.join(', ') +
    '. Open it directly with { readonly: true } instead.');
});

check('EVERY open of the LIVE database is readonly', () => {
  // Asked per OPEN, not per file: seam_batch opens the live one readonly and a
  // scratch one writable, and asking it of the whole file would either clear it
  // wrongly or fail it wrongly.
  const writable = [];
  for (const { f, live } of opensLive) {
    for (const call of live) if (!/readonly:\s*true/.test(call)) writable.push(`${f}: ${call.trim()}`);
  }
  assert.deepStrictEqual(writable, [],
    'the workflow will run these against production with a writable handle:\n      ' + writable.join('\n      '));
});

/* THE PROBE IS REPORTED, NOT ENFORCED, and the difference is deliberate.
   `readonly: true` is the load-bearing rule and is enforced above. The probe —
   attempting a write and aborting if it succeeds — is what turns that flag into
   a fact at run time, and the workflow's header promises it. Most of these
   scripts predate the promise. Failing them would make this suite red on a main
   that is not actually unsafe, and a suite that is red for a reason nobody
   intends to fix is a suite people learn to ignore. So: counted here, where the
   number is visible and can be driven down, and asked of new work at review. */
const probed   = opensLive.filter(({ code }) => /CREATE TABLE __ro_probe__/.test(code));
const unprobed = opensLive.filter(({ code }) => !/CREATE TABLE __ro_probe__/.test(code));
console.log(`\n  ${probed.length} of ${opensLive.length} also PROVE it at run time by attempting a write first.`);
if (unprobed.length) {
  console.log(`  ${unprobed.length} do not — not a failure (see the note in this file), but the number to watch:`);
  for (const { f } of unprobed.slice(0, 6)) console.log(`    ${f}`);
  if (unprobed.length > 6) console.log(`    …and ${unprobed.length - 6} more`);
}

check('the ones that DO probe, probe before the live handle reads anything', () => {
  /* Measured from where the LIVE handle is opened, not from the first
     `.prepare(` anywhere in the file — seam_batch writes a scratch database
     hundreds of lines earlier and would fail a naive reading of "reads first". */
  const late = probed.filter(({ code }) => {
    const firstLive = databaseOpens(code).find(isLive);
    const openAt  = firstLive ? code.indexOf(firstLive) : -1;
    const probeAt = code.indexOf('__ro_probe__');
    if (openAt < 0 || probeAt < 0) return false;
    return /\.prepare\(|\.pragma\(/.test(code.slice(openAt, probeAt));
  }).map(x => x.f);
  assert.deepStrictEqual(late, [],
    'these read from the live handle before proving it cannot write: ' + late.join(', '));
});

console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
