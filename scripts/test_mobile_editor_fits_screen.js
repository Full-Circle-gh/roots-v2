#!/usr/bin/env node
/**
 * THE PHONE EDITOR'S BOTTOM BAR STAYS ON THE SCREEN.
 *
 *   node scripts/test_mobile_editor_fits_screen.js
 *
 * cms-mobile.html was one 100dvh box with Add block / Design / Save as its
 * last row. For the frame or two after a page opens a phone reports 100dvh
 * as the viewport before it settled, so the box came out taller than the
 * glass and the bar sat below it — seen 2026-10-02 opening the editor from
 * the phone app. m.html had met this already and measures the height
 * instead (its data-boot="viewport" script); the editor now does the same.
 *
 * No browser: the boot script is RUN against a stand-in window.
 *   1. it writes window.innerHeight to --app-h, and again when that changes;
 *   2. a zero (a browser mid-launch) never overwrites a good answer;
 *   3. it re-measures on resize, the visual viewport, and after launch;
 *   4. .device takes its height from --app-h, and the desktop phone frame
 *      still sets its own fixed height after it.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CM = fs.readFileSync(path.join(ROOT, 'public/cms-mobile.html'), 'utf8');

let passed = 0, failed = 0;
function it(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

function bootScript() {
  const m = CM.match(/<script data-boot="viewport">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no <script data-boot="viewport"> in cms-mobile.html');
  return m[1];
}

// Run the boot script against a stand-in window; hand back its listeners and
// what it wrote, so a test can move innerHeight and fire them.
function boot(h0) {
  const props = {};
  const win = {}, vv = {}, timers = [], frames = [];
  const on = (o) => (e, fn) => { (o[e] = o[e] || []).push(fn); };
  const ctx = {
    document: { documentElement: { style: { setProperty: (k, v) => { props[k] = v; } } } },
    window: {
      innerHeight: h0,
      addEventListener: on(win),
      visualViewport: { addEventListener: on(vv) },
      requestAnimationFrame: (fn) => frames.push(fn),
    },
    setTimeout: (fn, ms) => timers.push([ms, fn]),
  };
  // In a page, window is the global: the script calls requestAnimationFrame bare.
  ctx.requestAnimationFrame = ctx.window.requestAnimationFrame;
  vm.runInNewContext(bootScript(), ctx);
  return { props, win, vv, timers, frames, setH: (h) => { ctx.window.innerHeight = h; } };
}

console.log('\nphone editor fits the screen');

it('writes the measured height to --app-h on load', () => {
  const b = boot(780);
  assert.strictEqual(b.props['--app-h'], '780px');
});

it('re-measures when the window resizes', () => {
  const b = boot(844);
  b.setH(780);
  b.win.resize.forEach((fn) => fn());
  assert.strictEqual(b.props['--app-h'], '780px');
});

it('re-measures when only the visual viewport changes', () => {
  const b = boot(844);
  b.setH(800);
  b.vv.resize.forEach((fn) => fn());
  assert.strictEqual(b.props['--app-h'], '800px');
});

it('re-measures after launch has settled (frame and timers)', () => {
  const b = boot(900);
  assert.ok(b.frames.length >= 1, 'no animation-frame re-measure');
  assert.ok(b.timers.some(([ms]) => ms >= 500), 'no late re-measure after launch');
  b.setH(780);
  b.timers.forEach(([, fn]) => fn());
  assert.strictEqual(b.props['--app-h'], '780px');
});

it('a zero height never overwrites a good answer', () => {
  const b = boot(780);
  b.setH(0);
  b.win.resize.forEach((fn) => fn());
  assert.strictEqual(b.props['--app-h'], '780px');
});

it('listens for pageshow (back from the app switcher) and rotation', () => {
  const b = boot(780);
  assert.ok(b.win.pageshow && b.win.orientationchange, 'pageshow / orientationchange not handled');
});

it('.device takes its height from --app-h', () => {
  const rule = CM.match(/\.device\{position:fixed;[^}]*\}/);
  assert.ok(rule, '.device rule not found');
  assert.ok(/height:var\(--app-h,\s*100dvh\)/.test(rule[0]), '.device does not use --app-h: ' + rule[0]);
  // The measured height must come last, or a later height:100dvh wins.
  const last = [...rule[0].matchAll(/height:([^;]+);/g)].pop()[1].trim();
  assert.ok(/^var\(--app-h/.test(last), 'a later height overrides --app-h: ' + last);
});

it('the desktop phone frame still sets its own height after it', () => {
  const base = CM.indexOf('.device{position:fixed;');
  const frame = CM.indexOf('.device{ position:relative;');
  assert.ok(base >= 0 && frame > base, 'desktop frame rule missing or before the phone rule');
  assert.ok(/\.device\{ position:relative;[^}]*height:880px/.test(CM), 'desktop frame height changed');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
