#!/usr/bin/env node
/**
 * The toast that would not leave.
 *
 * Reported from the floor 2026-11-06 as a screenshot: the green "Courier
 * dispatched" pill sitting over the Orders table, permanently. Nothing re-raised
 * it — it was raised once and never hidden, because of an ordering hazard in the
 * two rAF-based toast() implementations (public/retail-admin/01-core.js and the
 * inline script in public/cms.html; every other toast in the product adds
 * `.show` synchronously and never had the hazard):
 *
 *     requestAnimationFrame(() => t.classList.add('show'));
 *     clearTimeout(toast._h);
 *     toast._h = setTimeout(() => t.classList.remove('show'), dur);
 *
 * requestAnimationFrame is PAUSED while a tab is hidden or a window fully
 * occluded; setTimeout is not, it merely throttles. So when the toast() call
 * landed while the operator was elsewhere — typically the Qingyun dispatch
 * round-trip resolving after they had switched to WeChat — the hide timer fired
 * into a toast that was not showing yet, and the frame callback, delivered late
 * on return, added `.show` with no timer left alive to remove it. The pill then
 * stayed until the next toast, which might be hours.
 *
 * The fix shows and arms in the SAME frame callback. This suite runs the shipped
 * source of both implementations against a stub element and a hand-held clock —
 * frames flushed only when the test says the tab is visible — and replays the
 * exact sequence: raise while hidden, let the old hide timer's window pass,
 * come back, and require the toast to leave.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/* Pull the toast() function out of a file by brace-matching, skipping strings
   and comments so braces and quotes inside them do not fool the count. */
function extractToast(src, label) {
  const start = src.indexOf('function toast(');
  if (start < 0) throw new Error(label + ': no toast() found');
  let i = src.indexOf('{', start);
  if (i < 0) throw new Error(label + ': toast() has no body');
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(label + ': toast() body never closed');
}

/* A stub #toast element, a frame queue the test flushes by hand (a hidden tab
   gets no frames), and a clock whose timers run only when advanced. */
function makeWorld() {
  const classes = new Set();
  const el = {
    textContent: '', title: '',
    removeAttribute() { this.title = ''; },
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      contains: c => classes.has(c),
    },
  };
  Object.defineProperty(el, 'className', {
    get: () => Array.from(classes).join(' '),
    set: v => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
  });
  const frames = [];
  let now = 0, nextId = 1;
  const timers = new Map();
  const world = {
    el,
    shown: () => classes.has('show'),
    frame: () => { const q = frames.splice(0, frames.length); q.forEach(fn => fn()); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of timers) if (t.at <= target && (!due || t.at < due.t.at)) due = { id, t };
        if (!due) break;
        timers.delete(due.id);
        now = due.t.at;
        due.t.fn();
      }
      now = target;
    },
    sandbox: null,
  };
  world.sandbox = {
    $: () => el,
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout: id => { timers.delete(id); },
  };
  vm.createContext(world.sandbox);
  return world;
}

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };

function runSuite(label, src, checks) {
  console.log('\n' + label);
  const code = extractToast(src, label);
  ok(/requestAnimationFrame/.test(code) && /classList\.add\('show'\)/.test(code),
    'extracted the shipped toast() that shows through a frame callback');

  // A visible tab: shows on the next frame, leaves after its duration.
  {
    const w = makeWorld();
    vm.runInContext(code, w.sandbox, { filename: label });
    w.sandbox.toast('Saved');
    ok(!w.shown(), 'nothing shows before the frame');
    w.frame();
    ok(w.shown(), 'the frame shows it');
    w.advance(checks.okMs - 1);
    ok(w.shown(), 'still up just inside the duration');
    w.advance(2);
    ok(!w.shown(), 'and it leaves once the duration passes');
  }

  // THE REPORTED BUG: raised while the tab is hidden, so the frame is held;
  // the whole hide window passes with nothing showing; the operator returns.
  {
    const w = makeWorld();
    vm.runInContext(code, w.sandbox, { filename: label });
    w.sandbox.toast('Courier dispatched');
    w.advance(checks.okMs + 5000);   // hidden: no frames, but timers would run
    ok(!w.shown(), 'nothing is showing while the tab is hidden');
    w.frame();                      // the operator comes back
    ok(w.shown(), 'the held frame shows it on return');
    w.advance(checks.okMs + 1);
    ok(!w.shown(), 'and it LEAVES — the pill cannot stick to the screen');
  }

  // A second toast replaces the first and still carries its own hide.
  {
    const w = makeWorld();
    vm.runInContext(code, w.sandbox, { filename: label });
    w.sandbox.toast('First');
    w.frame();
    w.advance(1000);
    w.sandbox.toast('Second');
    ok(w.el.textContent === 'Second', 'the second toast replaces the text');
    w.frame();
    ok(w.shown(), 'still showing across the replacement');
    w.advance(checks.okMs + 1);
    ok(!w.shown(), 'the replacement hides on its own timer');
  }

  if (checks.extra) checks.extra(code, label);
}

runSuite('retail-admin 01-core.js', read('public', 'retail-admin', '01-core.js'), {
  okMs: 2600,
  extra(code, label) {
    // Errors linger 6000; an explicit duration overrides both.
    const w = makeWorld();
    vm.runInContext(code, w.sandbox, { filename: label });
    w.sandbox.toast('Dispatch failed', 'err');
    w.frame();
    w.advance(2600 + 1);
    ok(w.shown(), 'an error outlives the ok duration');
    w.advance(6000 - 2600);
    ok(!w.shown(), 'and leaves at the error duration');
    const w2 = makeWorld();
    vm.runInContext(code, w2.sandbox, { filename: label });
    w2.sandbox.toast('Import done', 'ok', 100);
    w2.frame();
    w2.advance(101);
    ok(!w2.shown(), 'an explicit duration still wins');
  },
});

runSuite('cms.html inline script', read('public', 'cms.html'), { okMs: 2600 });

console.log('\n' + (fail ? 'FAIL ' : 'pass ') + pass + ' assertions, ' + fail + ' failures');
process.exit(fail ? 1 : 0);
