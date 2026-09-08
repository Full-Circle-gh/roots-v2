#!/usr/bin/env node
/**
 * diagnose_server_hotfix_diff.js — show WHAT the hand-edited server files say.
 *
 *   dispatched via .github/workflows/ro-query.yml
 *
 * WHY THIS EXISTS
 * ---------------
 * diagnose_deployed_tree.js answers WHICH files on the box differ from the
 * repository. On 2026-09-07 it answered: eleven, and for every one checked the
 * deployed bytes MATCH NO COMMIT IN THE HISTORY — `git cat-file -e` says those
 * blobs have never existed in this repository. Three of them are live
 * application code: lib/geocode.js, lib/po-returns.js, lib/qingyun-payload.js.
 *
 * deploy.yml only ever COPIES files it computes as changed, so anything that
 * reaches the box by another route sits there indefinitely. This prints the
 * difference so the change can be read and judged rather than guessed at.
 *
 * ── AND THE FIRST THING IT PRINTED WAS MISREAD, WHICH IS WHY THE CHECK BELOW
 *    EXISTS ────────────────────────────────────────────────────────────────
 * Run #94 (2026-09-07) diffed those three and rendered every line of each as
 * removed-and-re-added with identical text. That reads exactly like a wholesale
 * rewrite, and it was recorded as one: production running code main does not
 * contain, the box holding the only copy, urgent.
 *
 * It was a LINE-ENDING CONVERSION. The box's copies are main's own bytes with
 * CRLF terminators — one extra byte per line, +720 / +257 / +1081 against files
 * of 720 / 257 / 1081 lines, and each predicted size reproduces the reported one
 * to the byte. The content is identical. Nothing was hand-edited and nothing was
 * ever at risk of being lost.
 *
 * TWO THINGS CONSPIRED, and neither announces itself:
 *   1. This script split both sides on '\n', so every box line kept a trailing
 *      '\r' and NO line compared equal. The LCS correctly found zero common
 *      lines and emitted a full rewrite.
 *   2. A CI log viewer eats a lone '\r', so the two sides printed identically.
 *      The evidence that they differed was the very character being swallowed.
 *
 * `git cat-file -e` was right and misleading at once: .gitattributes opens with
 * `* text=auto`, so this repository stores LF and only LF. A CRLF copy of ANY
 * tracked file can never match a committed blob however faithful its content, so
 * "these bytes were never committed" is what a pure line-ending change looks
 * like, and says nothing whatever about the code.
 *
 * So: classify the difference BEFORE diffing it. A file that matches once line
 * endings are normalised is reported as exactly that, in one line, and its
 * content diff is not printed — there is nothing in it to read.
 *
 * READ-ONLY
 * ---------
 * fs.readFileSync and fs.readdirSync, nothing else. It opens no database, binds
 * no port, spawns no process, writes no file and restarts nothing.
 *
 * WHAT IT COMPARES
 * ----------------
 * ro-query.yml stages THIS CHECKOUT's lib/ beside the script, and the deployed
 * tree lives at /root/roots-v2. So `<stage>/lib/x.js` is what main says and
 * `/root/roots-v2/lib/x.js` is what production runs. Every staged lib/ file is
 * compared, not just the three — the three are what was known, not necessarily
 * the extent of it.
 *
 * SECRETS ARE REDACTED BEFORE THE DIFF IS BUILT, because this prints to a CI
 * log. A hand-edit on a production box is exactly where a pasted key would be.
 * Redaction substitutes `<redacted:xxxxxxxx>` — a short digest of the value, not
 * the value — so two DIFFERENT secrets still read as a difference and the diff
 * never silently hides a change it is masking.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BOX = '/root/roots-v2';
const STAGE = __dirname;
const MAX_DIFF_LINES = 400;   // per file, so one rewritten file cannot bury the rest

if (!fs.existsSync(BOX)) {
  console.log(`FATAL: ${BOX} does not exist — this is not the live box.`);
  process.exit(1);
}

// ── Redaction ──────────────────────────────────────────────────────────────
const tag = (v) => '<redacted:' + crypto.createHash('sha1').update(v).digest('hex').slice(0, 8) + '>';
function redact(text) {
  let t = text;
  // key: 'value' / KEY = "value" for anything named like a credential
  t = t.replace(
    /(['"`]?(?:api[_-]?key|secret|token|password|passwd|app[_-]?id|app[_-]?secret|private[_-]?key|mch[_-]?id|access[_-]?key|auth)['"`]?\s*[:=]\s*['"`])([^'"`\n]{4,})(['"`])/gi,
    (_, a, v, b) => a + tag(v) + b);
  // bare long hex / base64 runs, which is what a pasted credential looks like
  t = t.replace(/\b[A-Fa-f0-9]{32,}\b/g, (m) => tag(m));
  t = t.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, (m) => tag(m));
  return t;
}

// ── Line endings ───────────────────────────────────────────────────────────
// Normalise CRLF and lone CR to LF. Every comparison below runs on normalised
// text, so a terminator change can never masquerade as a content change — and
// the terminators themselves are reported separately, as their own finding.
const toLF = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

// How a file's lines are terminated, said in words rather than left to arithmetic.
function eol(raw) {
  const crlf = (raw.match(/\r\n/g) || []).length;
  const cr = (raw.match(/\r(?!\n)/g) || []).length;
  const lf = (raw.match(/(?<!\r)\n/g) || []).length;
  const parts = [];
  if (lf) parts.push(`${lf} LF`);
  if (crlf) parts.push(`${crlf} CRLF`);
  if (cr) parts.push(`${cr} CR`);
  return parts.length ? parts.join(' + ') : 'no line terminator';
}

// ── A minimal unified diff (LCS), so no process is spawned ─────────────────
function diff(aLines, bLines) {
  const n = aLines.length, m = bLines.length;
  // Guard: the DP table is O(n*m); these are source files, but be safe.
  if (n * m > 4_000_000) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) { out.push([' ', aLines[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(['-', aLines[i]]); i++; }
    else { out.push(['+', bLines[j]]); j++; }
  }
  while (i < n) out.push(['-', aLines[i++]]);
  while (j < m) out.push(['+', bLines[j++]]);
  return out;
}

/** Print only changed regions, with 3 lines of context. */
function render(ops, label) {
  const keep = new Set();
  ops.forEach(([k], idx) => {
    if (k === ' ') return;
    for (let d = -3; d <= 3; d++) if (idx + d >= 0 && idx + d < ops.length) keep.add(idx + d);
  });
  const idxs = [...keep].sort((a, b) => a - b);
  let printed = 0, last = -99;
  for (const idx of idxs) {
    if (printed >= MAX_DIFF_LINES) {
      console.log(`      … diff truncated at ${MAX_DIFF_LINES} lines — ${idxs.length - printed} more`);
      break;
    }
    if (idx !== last + 1) console.log('      ┄┄┄');
    const [k, line] = ops[idx];
    console.log('      ' + k + ' ' + line);
    last = idx; printed++;
  }
  if (!idxs.length) console.log(`      (no textual difference after redaction — see the note under ${label})`);
}

// ── Walk the staged lib/ ───────────────────────────────────────────────────
function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

console.log('server hotfix diff');
console.log('   box      : ' + BOX);
console.log('   repo copy: ' + STAGE + '/lib  (staged from this checkout by ro-query.yml)');
console.log('   secrets are redacted to <redacted:digest> before diffing\n');

const stagedLib = path.join(STAGE, 'lib');
if (!fs.existsSync(stagedLib)) {
  console.log('FATAL: lib/ was not staged beside this script — cannot compare.');
  process.exit(1);
}

const files = walk(stagedLib).sort();
console.log(`comparing ${files.length} staged lib/*.js file(s) against the box\n`);

let differing = 0, missing = 0, identical = 0, eolOnly = 0;
for (const rel of files) {
  const repoPath = path.join(stagedLib, rel);
  const boxPath = path.join(BOX, 'lib', rel);
  if (!fs.existsSync(boxPath)) { missing++; console.log(`MISSING ON BOX  lib/${rel}`); continue; }

  const repoRaw = fs.readFileSync(repoPath, 'utf8');
  const boxRaw = fs.readFileSync(boxPath, 'utf8');
  if (repoRaw === boxRaw) { identical++; continue; }

  const repoLF = toLF(repoRaw), boxLF = toLF(boxRaw);

  console.log('═'.repeat(72));
  console.log(`DIFFERS  lib/${rel}`);
  console.log(`   repo ${repoRaw.length} bytes, ${repoLF.split('\n').length - 1} lines, ${eol(repoRaw)}`);
  console.log(`   box  ${boxRaw.length} bytes, ${boxLF.split('\n').length - 1} lines, ${eol(boxRaw)}`);

  // CLASSIFY BEFORE DIFFING. A terminator change makes every line differ, so a
  // content diff of one is 100% noise and reads like a rewrite. See the header.
  if (repoLF === boxLF) {
    eolOnly++;
    console.log('   LINE ENDINGS ONLY — identical once normalised to LF. The content is');
    console.log('   byte-for-byte main\'s. Nothing was edited; no diff is printed because');
    console.log('   there is nothing in it. .gitattributes is `* text=auto`, so this repo');
    console.log('   stores LF: a CRLF copy matches no commit yet contains no change.');
    console.log(`   Delta is ${boxRaw.length - repoRaw.length} bytes over ${boxLF.split('\n').length - 1} lines.`);
    continue;
  }

  differing++;
  const repoTxt = redact(repoLF), boxTxt = redact(boxLF);
  if (repoTxt === boxTxt) {
    console.log('   ⚠ IDENTICAL AFTER REDACTION — the ONLY difference is inside a redacted');
    console.log('     value. That is a credential edited in place on the server.');
    continue;
  }
  console.log('   ("-" is what main says · "+" is what production runs)');
  const ops = diff(repoTxt.split('\n'), boxTxt.split('\n'));
  if (!ops) { console.log('      (file too large to diff in-process)'); continue; }
  render(ops, `lib/${rel}`);
}

console.log('\n' + '═'.repeat(72));
console.log(`summary: ${identical} identical, ${eolOnly} line-endings-only, ` +
            `${differing} differ in content, ${missing} missing on box`);
if (differing) {
  console.log('RESULT: production is running lib/ code that main does not contain.');
} else if (eolOnly) {
  console.log(`RESULT: no content difference anywhere. ${eolOnly} file(s) differ only in`);
  console.log('        line endings — a transfer converted them, nobody edited them.');
  console.log('        A full_sync restores LF and costs nothing.');
} else {
  console.log('RESULT: every staged lib/ file on the box matches this checkout.');
}
process.exit(0);
