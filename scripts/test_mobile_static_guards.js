#!/usr/bin/env node
/**
 * §325 T2 — THE PHONE'S STATIC GUARDS, IN THE FAST SHARD.
 *
 *   node scripts/test_mobile_static_guards.js
 *
 * scripts/test_mobile_screens.js renders every phone screen in Chromium, so it
 * is in the slow shard, which this repo does not run. Before it renders it runs
 * a set of checks that read public/m.html and need no browser — and those are
 * the checks that catch real phone breakage:
 *   • a mapX / loadX / screenX / sheetX helper used but never defined;
 *   • a T(en, zh) pair whose Chinese half is English;
 *   • APP.cmd called with extra arguments a non-variadic dispatcher drops;
 *   • a control wired to the 'noop' command;
 *   • a reg('<name>') command nothing can reach (with its comment stripper
 *     checked against its own trap first);
 *   • a tint or ink token defined for the light theme only, or a hue used as
 *     text on its own tint;
 *   • a DB.x read that the DB literal does not define.
 * (The state-key check already has its own fast suite, test_mobile_state_keys.)
 *
 * This suite runs exactly those, against the real m.html, through
 * scripts/lib/m-static-guards.js — the same module test_mobile_screens.js now
 * calls, so the two cannot disagree. Each guard is also run on a small
 * fixture that breaks it, so a guard that stops finding anything fails here
 * instead of passing quietly.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const g = require('./lib/m-static-guards');
const { inlineTdDatetime } = require('./lib/m-probe');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

/* PINNED, and each must disappear.
   `loadErr` — not a helper: it is the Delivery zones screen's error FIELD
   (state.zn.loadErr, s.loadErr, t.loadErr), and the helper pass reads any bare
   `load` + Capital as a loader. The orders lane is renaming the field in O11;
   once it lands this pin fails ("no longer reported") and must be removed. */
const PINNED_HELPERS = ['loadErr'];

// The page as test_mobile_screens.js reads it: the icon CDN and fonts out, the
// one local dependency inlined (with an attribute, so the app's own <script>
// is still the first bare one).
let src = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
src = src.replace(/<script src="\/assets\/vendor\/lucide[^>]*><\/script>/, '')
  .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/, '');
src = inlineTdDatetime(src);

section('1 · the real m.html');
ok(g.appScript(src).length > 100000, 'the app script is found (the first bare <script>)');
{
  const missing = g.missingHelpers(src);
  is(missing.filter((n) => !PINNED_HELPERS.includes(n)), [], 'every map/load/screen/sheet helper used is defined');
  for (const p of PINNED_HELPERS) ok(missing.includes(p), `pinned "${p}" is still reported (remove the pin once O11 renames it)`);
}
is(g.englishOnlyPairs(src), [], 'every T(en, zh) pair has a Chinese half');
is(g.droppedArguments(src), [], 'APP.cmd forwards every argument a call passes');
is(g.noopReferences(src), 0, "no control is wired to 'noop'");
is(g.stripperProblems(), [], 'the comment stripper passes its own traps');
is(g.unreachableCommands(src), [], 'every registered command can be reached');
{
  const t = g.themeProblems(src);
  is(t.error, null, 'the theme blocks are found');
  is(t.lightOnly, [], 'every tint and ink is defined for the dark theme too');
  is(t.textOnTint, [], 'no hue is used as text on its own tint');
}
{
  const d = g.dbKeyGaps(src);
  is(d.error, null, 'the DB literal is found');
  is(d.gone, [], 'every DB.x read is in the DB literal');
}

section('2 · each guard still catches what it is for');
const app = (js, css = '') =>
  `<style>@font-face{font-family:x}</style><style>${css}</style><script>${js}</script>`;
const theme = ':root{--sage-tint:#eee;--sage-ink:#111;--accent-tint:var(--dusk-tint);--ink:#000}\n' +
  ':root[data-theme="dark"]{--sage-tint:#222;--sage-ink:#ddd}';
{
  is(g.missingHelpers(app('function loadA(){} loadA(); rows.map(mapGone);')), ['mapGone'],
    'a helper passed by reference and never defined is found');
  is(g.missingHelpers(app("el.accept='image/*';\nfunction screenX(){}\n/* later */ screenX();")), [],
    "…and a definition after an `image/*` string is not eaten (the §325 T2 fix)");
  is(g.englishOnlyPairs(app("T('Save the order','Save the order'); T('Done','完成');")), ['Save the order'],
    'a pair whose Chinese half is English is found');
  is(g.droppedArguments(app("window.APP={cmd:(n,a)=>CMD[n](a)}; APP.cmd('x',1,'y');")), ['x'],
    'an extra argument a one-argument dispatcher drops is found');
  is(g.droppedArguments(app("window.APP={cmd:(n,...a)=>CMD[n](...a)}; APP.cmd('x',1,'y');")), [],
    '…and a variadic dispatcher is fine');
  is(g.noopReferences(app("x=`<b onclick=\"APP.cmd('noop')\">`;")), 1, "a control wired to 'noop' is found");
  is(g.unreachableCommands(app("reg('ghost',()=>{}); reg('used',()=>{}); x=\"APP.cmd('used')\";")), ['ghost'],
    'a command nothing can reach is found');
  is(g.unreachableCommands(app(`x=\`<input accept="image/*" onchange="APP.cmd('kept',this)">\`;\n/* c */ reg('kept',()=>{});`)), [],
    "…and one wired after an `image/*` attribute is not");
  const t = g.themeProblems(app('', theme.replace('--sage-ink:#ddd', '') + '\n') +
    '<b style="background:var(--sage-tint);color:var(--sage)">');
  is([t.error, t.lightOnly, t.textOnTint], [null, ['--sage-ink'], ['sage']],
    'a light-only ink and a hue on its own tint are found, from the style block that holds the theme');
  is(g.themeProblems(app('', ':root{--a-tint:#fff}')).error, 'cannot find the theme blocks', 'no theme block is an error, not a pass');
  is(g.dbKeyGaps(app('const DB = {\n  orders: [],\n};\nDB.orders; DB.gone;')).gone, ['gone'], 'a DB key read but not defined is found');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
