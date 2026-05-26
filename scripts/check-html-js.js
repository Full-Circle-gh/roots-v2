#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// check-html-js.js — syntax-check the inline <script> blocks of an HTML file
// WITHOUT executing them. Exit 0 if every inline script parses, 1 if any has a
// syntax error, 2 on usage/read error.
//
// Why: the deploy gate already runs `node --check` on staged .js, but almost
// all of this app's logic lives in inline <script> inside .html (app.html is
// ~26k lines). An unbalanced brace or stray token there takes down the WHOLE
// page's JS, yet shipped unchecked. This closes that gap.
//
// Scope note: this catches SYNTAX errors only (compile via vm.Script, no
// execution). It does NOT catch runtime bugs like an undefined-variable
// reference — those need a linter (ESLint no-undef) and/or browser testing.
//
//   node scripts/check-html-js.js public/app.html
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const vm = require('vm');

const file = process.argv[2];
if (!file) { console.error('usage: check-html-js.js <file.html>'); process.exit(2); }

let html;
try { html = fs.readFileSync(file, 'utf8'); }
catch (e) { console.error('cannot read ' + file + ': ' + e.message); process.exit(2); }

// Match <script>…</script> blocks, skipping any with a src= attribute (those
// are external — no inline body to check). Non-greedy: stops at the first
// literal </script>. Valid HTML escapes any in-string closer as <\/script>,
// so each real block is captured whole even when its body builds HTML that
// contains the word "script".
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

let m, count = 0, bad = 0;
while ((m = re.exec(html)) !== null) {
  const code = m[1];
  if (!code.trim()) continue;
  count++;
  const startLine = html.slice(0, m.index).split('\n').length;
  try {
    // Compile only — never run. lineOffset maps reported lines back to the
    // real file so an error points at the right spot.
    new vm.Script(code, { filename: file, lineOffset: startLine - 1 });
  } catch (e) {
    bad++;
    const where = (e.stack || '').split('\n').slice(0, 4).join('\n    ');
    console.error('✗ ' + file + ': inline <script> starting at line ' + startLine + ' has a syntax error:');
    console.error('    ' + (where || e.message));
  }
}

if (bad) { console.error(file + ': ' + bad + ' of ' + count + ' inline script(s) FAILED'); process.exit(1); }
console.log(file + ': ' + count + ' inline script(s) OK');
process.exit(0);
