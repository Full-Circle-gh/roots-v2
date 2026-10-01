#!/usr/bin/env node
/**
 * §325 T1 — EVERY PAGE'S INLINE SCRIPT COMPILES, AND NOTHING IS DECLARED TWICE.
 *
 *   node scripts/test_phone_scripts_compile.js
 *
 * Every phone suite tests a SLICE of public/m.html. So a merge that left the
 * whole script unable to run — a `const` and a `function` with one name, from
 * two lanes — passed every fast suite, and only the slow, browser-driven
 * test_mobile_screens (not run, standing rule) would have seen it. This suite
 * is the cheap whole-file check the fast shard was missing.
 *
 * For every public/*.html page (the phone's m.html, cms-mobile.html and
 * cms.html first, and every other page, because the check costs nothing):
 *   1. each inline <script> (not src=, not a non-JS type) COMPILES — through
 *      vm.Script, or acorn as a module for type="module" — and a failure names
 *      the file, the script's index and the error;
 *   2. no top-level name is declared twice across the page's scripts. Classic
 *      scripts share one global scope, so a let/const/class that meets any
 *      other declaration of its name throws when the page loads, and two
 *      `function`s with one name silently keep only the LATER one — the other
 *      is dead code that its own lane still believes runs. (`var` twice is
 *      legal and not flagged.)
 *   3. in m.html, no command is registered twice with reg('<name>', …): the
 *      later registration silently replaces the earlier.
 * Found ones that are known and decided are pinned in ALLOWED, each with why;
 * the list may only shrink — a pinned entry that is no longer duplicated
 * fails too, so it is removed rather than left to excuse a future one.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const section = (t) => console.log('\n' + t);

/* PINNED, each investigated (docs: §325 T1).
   m.html · function kbMark — TWO DIFFERENT FUNCTIONS under one name, from two
   lanes on 2026-09-27. The first (touch-down: remember which field had the
   keyboard) is registered on pointerdown/mousedown for kbTapAway; the second
   (toggle html.kb-up) wins, being later, so kbWas is never set and the
   tap-away keyboard close never fires. Not fixed here: renaming either
   switches a dead phone behaviour back on, which is a phone change, not a
   test step's. Reported to the coordinator. */
const ALLOWED = new Set([
  'm.html|function|kbMark',
]);

const PHONE = ['m.html', 'cms-mobile.html', 'cms.html'];
const pages = fs.readdirSync(PUB).filter((f) => f.endsWith('.html')).sort((a, b) =>
  (PHONE.indexOf(a) === -1 ? 99 : PHONE.indexOf(a)) - (PHONE.indexOf(b) === -1 ? 99 : PHONE.indexOf(b)) || a.localeCompare(b));
const JS_TYPE = /^(text|application)\/(javascript|ecmascript)$/i;

const seenAllowed = new Set();
section('1 · every inline script compiles, and declares nothing twice');
for (const page of pages) {
  const src = fs.readFileSync(path.join(PUB, page), 'utf8');
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, idx = 0, compiled = 0, bad = 0;
  const decls = new Map();   // name -> [{kind, script, line}]
  const regs = new Map();    // command -> [line]
  while ((m = re.exec(src))) {
    idx++;
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    const isModule = type && type.toLowerCase() === 'module';
    if (type && !isModule && !JS_TYPE.test(type)) continue;
    const code = m[2];
    const lineAt = src.slice(0, m.index).split('\n').length;
    try {
      if (isModule) acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
      else new vm.Script(code, { filename: `${page} <script #${idx}>`, lineOffset: lineAt - 1 });
      compiled++;
    } catch (e) {
      bad++;
      ok(false, `${page} script #${idx} (from line ${lineAt}) compiles`, String(e && e.message));
      continue;
    }
    const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: isModule ? 'module' : 'script', locations: true });
    for (const n of ast.body) {
      const add = (name, kind) => {
        if (!decls.has(name)) decls.set(name, []);
        decls.get(name).push({ kind, script: idx, line: lineAt + n.loc.start.line - 1 });
      };
      if (n.type === 'FunctionDeclaration' && n.id) add(n.id.name, 'function');
      else if (n.type === 'ClassDeclaration' && n.id) add(n.id.name, 'class');
      else if (n.type === 'VariableDeclaration') {
        for (const d of n.declarations) if (d.id.type === 'Identifier') add(d.id.name, n.kind);
      } else if (n.type === 'ExpressionStatement' && n.expression.type === 'CallExpression'
        && n.expression.callee.type === 'Identifier' && n.expression.callee.name === 'reg'
        && n.expression.arguments[0] && n.expression.arguments[0].type === 'Literal') {
        const cmd = String(n.expression.arguments[0].value);
        if (!regs.has(cmd)) regs.set(cmd, []);
        regs.get(cmd).push(lineAt + n.loc.start.line - 1);
      }
    }
  }
  if (!bad) ok(true, `${page}: ${compiled} inline script${compiled === 1 ? '' : 's'} compile`);
  for (const [name, list] of decls) {
    if (list.length < 2 || list.every((d) => d.kind === 'var')) continue;
    const kind = list.some((d) => d.kind !== 'function' && d.kind !== 'var')
      ? list.find((d) => d.kind !== 'function' && d.kind !== 'var').kind : 'function';
    const key = `${page}|${kind}|${name}`;
    const where = list.map((d) => `${d.kind} at line ${d.line} (script #${d.script})`).join(', ');
    if (ALLOWED.has(key)) { seenAllowed.add(key); console.log(`  · pinned: ${name} in ${page} — ${where}`); continue; }
    ok(false, `${page}: top-level "${name}" is declared once`, where);
  }
  if (page === 'm.html') {
    const dup = [...regs].filter(([, l]) => l.length > 1);
    for (const [cmd, lines] of dup) {
      const key = `m.html|reg|${cmd}`;
      if (ALLOWED.has(key)) { seenAllowed.add(key); continue; }
      ok(false, `m.html: reg('${cmd}') is registered once`, 'at lines ' + lines.join(', '));
    }
    ok(regs.size > 100, `m.html: ${regs.size} commands registered, each once`);
  }
}

section('2 · the pinned list only shrinks');
for (const key of ALLOWED) ok(seenAllowed.has(key), `pinned ${key} is still a duplicate (remove the pin once it is fixed)`);
ok(pages.includes('m.html') && pages.includes('cms-mobile.html') && pages.includes('cms.html'), 'the three phone pages were checked');

section('3 · the checks themselves catch what they are for');
{
  const clash = 'const cfgMerge=1;\nfunction cfgMerge(){}';
  let threw = false;
  try { new vm.Script(clash); } catch (e) { threw = /already been declared/.test(e.message); }
  ok(threw, 'a const and a function of one name in one script fail to compile');
  const ctx = vm.createContext({});
  new vm.Script('const a=1;').runInContext(ctx);
  let crossThrew = false;
  try { new vm.Script('function a(){}').runInContext(ctx); } catch (e) { crossThrew = true; }
  ok(crossThrew, '…and across two scripts of one page it throws on load, which is why names are checked page-wide');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
