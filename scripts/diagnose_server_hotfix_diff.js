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
 * They were edited directly on the server. deploy.yml only ever COPIES files it
 * computes as changed, so a hand-edit sits there indefinitely — production runs
 * code that is in no branch, no commit and no backup.
 *
 * THE BYTES ON THE BOX ARE THE ONLY COPY. A full-sync, or any future deploy
 * that happens to touch one of these three, overwrites them and whatever was
 * fixed is gone with no record it existed. This prints the difference so the
 * change can be read, judged, and either committed properly or discarded on
 * purpose rather than by accident.
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

let differing = 0, missing = 0, identical = 0;
for (const rel of files) {
  const repoPath = path.join(stagedLib, rel);
  const boxPath = path.join(BOX, 'lib', rel);
  if (!fs.existsSync(boxPath)) { missing++; console.log(`MISSING ON BOX  lib/${rel}`); continue; }

  const repoRaw = fs.readFileSync(repoPath, 'utf8');
  const boxRaw = fs.readFileSync(boxPath, 'utf8');
  if (repoRaw === boxRaw) { identical++; continue; }

  differing++;
  const repoTxt = redact(repoRaw), boxTxt = redact(boxRaw);
  console.log('═'.repeat(72));
  console.log(`DIFFERS  lib/${rel}`);
  console.log(`   repo ${repoRaw.length} bytes, ${repoRaw.split('\n').length} lines`);
  console.log(`   box  ${boxRaw.length} bytes, ${boxRaw.split('\n').length} lines`);
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
console.log(`summary: ${identical} identical, ${differing} differ, ${missing} missing on box`);
console.log(differing
  ? 'RESULT: production is running lib/ code that main does not contain.'
  : 'RESULT: every staged lib/ file on the box matches this checkout.');
process.exit(0);
