#!/usr/bin/env node
// GATE — a catch block that does nothing must say why it does nothing.
//
// WHY THIS EXISTS
// ---------------
// The audit (P-02) found the same shape several hundred times over:
//
//     try { await sendTheCode(...); } catch (e) {}
//
// Read literally, that says "if this fails, carry on as though it had not".
// Sometimes that is exactly right — a thumbnail that would not generate, a
// cache warm-up, a best-effort log. Sometimes it is how an operator ends up
// staring at "we sent you a code" for a text message that was never sent.
//
// The two cases are IMPOSSIBLE TO TELL APART from the code, which is the whole
// problem: nobody reviewing a diff can say whether a silent catch is a decision
// or an oversight, so nobody challenges any of them, and the count only grows.
//
// THE RULE, then, is not "no empty catches" — that would be a lie, because
// hundreds of them are correct and rewriting them all would be a worse change
// than leaving them. The rule is:
//
//     a catch block that swallows must carry a comment saying why.
//
// A comment costs one line, cannot be written without thinking about the case
// for a moment, and turns every one of these from an invisible decision into a
// reviewable one. It is also the cheapest thing that makes the number go down
// instead of up.
//
// THE BUDGET. There were 457 undocumented ones the day this gate was written,
// and fixing them all at once is not a change anybody should review. So the
// gate holds a ceiling and fails when it is EXCEEDED — new code cannot add to
// the pile, and the ceiling is lowered as the backlog is worked through. Run
// with --update to write the current count back into this file when it drops.
//
// Exit 0 = at or under budget. Exit 1 = over.
// Read-only (unless --update). Touches no database.
// Run: node scripts/check-swallowed-errors.js [--list] [--update]

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const ARGS = process.argv.slice(2);
const LIST = ARGS.includes('--list');
const UPDATE = ARGS.includes('--update');

// ── THE BUDGET ────────────────────────────────────────────────────────────
// Lower this when you document or fix some. Never raise it: a diff that needs
// the ceiling lifted is a diff adding an undocumented silent failure, which is
// the thing this exists to stop.
const BUDGET = 457;

const DIRS = ['routes', 'lib', 'middleware', 'public'];
const FILES_EXTRA = ['server.js', 'database.js'];

// Skipped for the same reason the ALS gate skips its own file: this one quotes
// the pattern, and the audit documents write about it at length.
const SKIP = new Set([path.join('scripts', 'check-swallowed-errors.js')]);

function jsFiles(dir) {
  const abs = path.join(REPO, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    if (e.isDirectory()) { out.push(...jsFiles(path.join(dir, e.name))); continue; }
    if (e.name.endsWith('.js')) out.push(path.join(dir, e.name));
  }
  return out.sort();
}

// Find `catch` … `{` … `}` and hand back the body, brace-balanced and
// string-aware. A regex cannot do this: a `}` inside a string or a nested block
// ends the match early, and the bodies that matter most are the short ones
// where an off-by-one swallows the whole finding.
function catchBodies(src) {
  const out = [];
  const re = /\bcatch\b\s*(?:\(([^)]*)\))?\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    let i = open, depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === '`') {           // skip the string whole
        const q = c; i++;
        while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
        continue;
      }
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    out.push({ index: m.index, param: (m[1] || '').trim(), body: src.slice(open + 1, i) });
    re.lastIndex = i;
  }
  return out;
}

// Does the body DO anything? Comments and whitespace do not count as doing;
// they count as SAYING, which is the other half of the test.
function isSilent(body) {
  return !body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/[\s;]/g, '')
    .length;
}

function hasReason(body) {
  const words = (body.match(/\/\*([\s\S]*?)\*\//g) || []).join(' ')
    + ' ' + (body.match(/\/\/[^\n]*/g) || []).join(' ');
  // A word or two is a label, not a reason. Four is a sentence fragment, which
  // is the least that can carry one — "already gone", "best effort, no reader".
  return words.replace(/[\/*]/g, ' ').trim().split(/\s+/).filter(Boolean).length >= 4;
}

const files = [...DIRS.flatMap(jsFiles), ...FILES_EXTRA.filter(f => fs.existsSync(path.join(REPO, f)))];

let silent = 0, documented = 0;
const bare = [];

for (const rel of files) {
  if (SKIP.has(rel)) continue;
  const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
  if (!/\bcatch\b/.test(src)) continue;
  for (const c of catchBodies(src)) {
    if (!isSilent(c.body)) continue;
    silent++;
    if (hasReason(c.body)) { documented++; continue; }
    bare.push({ file: rel, line: src.slice(0, c.index).split('\n').length, param: c.param });
  }
}

console.log('GATE — a catch that swallows must say why\n');
console.log(`  scanned ${files.length} file(s)`);
console.log(`  ${silent} catch block(s) do nothing at all`);
console.log(`    ${documented} of them say why`);
console.log(`    ${bare.length} of them do not`);
console.log(`  budget: ${BUDGET}\n`);

if (LIST) {
  const byFile = new Map();
  for (const b of bare) byFile.set(b.file, (byFile.get(b.file) || []).concat(b.line));
  const rows = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [file, lines] of rows) {
    console.log(`   ${String(lines.length).padStart(3)}  ${file}`);
    console.log(`        ${lines.join(', ')}`);
  }
  console.log('');
}

if (UPDATE && bare.length < BUDGET) {
  const self = path.join(__dirname, 'check-swallowed-errors.js');
  const src = fs.readFileSync(self, 'utf8')
    .replace(/^const BUDGET = \d+;$/m, `const BUDGET = ${bare.length};`)
    .replace(/There were \d+ undocumented/, `There were ${bare.length} undocumented`);
  fs.writeFileSync(self, src);
  console.log(`  budget lowered to ${bare.length}\n`);
}

console.log('═'.repeat(72));
if (bare.length > BUDGET) {
  console.log(`RESULT: FAIL — ${bare.length} undocumented silent catch(es), budget ${BUDGET}.`);
  console.log('        Say why the failure is safe to ignore, in a comment inside the catch.');
  console.log('        Run with --list to see where they are.');
  process.exit(1);
}
console.log(`RESULT: PASS — ${bare.length} undocumented silent catch(es), at or under the budget of ${BUDGET}.`);
if (bare.length < BUDGET) console.log(`        Lower the budget: node scripts/check-swallowed-errors.js --update`);
process.exit(0);
