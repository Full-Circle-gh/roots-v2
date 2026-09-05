#!/usr/bin/env node
/**
 * Screenshot every screen of public/m.html at phone size, so the LOOK can be
 * checked rather than only the text.
 *
 *   node scripts/shoot_mobile.js [outDir] [filter]
 *
 * Every other check in this directory asserts strings. None of them can see a
 * row overflowing its card, a pill wrapping to two lines, ink on ink in dark
 * mode, or a Chinese label pushing a number off the edge. This renders each
 * screen into a 390×844 viewport — an iPhone 14's CSS pixels — and writes a
 * PNG per screen per theme per language.
 *
 * It reuses the sweep's own case list so a screen cannot be photographed in a
 * state the sweep never renders, or missed because someone added it to one
 * list and not the other.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { fakeServer } = require('./lib/m-fakeserver');
const { inlineTdDatetime } = require('./lib/m-probe');

const APP = path.join(__dirname, '..', 'public', 'm.html');
const OUT = process.argv[2] || path.join(os.tmpdir(), 'm-shots');
const FILTER = process.argv[3] || '';

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  try { const p = require('playwright').chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch (e) {}
  for (const g of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (fs.existsSync(g)) return g;
  const pw = '/opt/pw-browsers';
  if (fs.existsSync(pw)) for (const d of fs.readdirSync(pw)) {
    const p = path.join(pw, d, 'chrome-linux', 'chrome'); if (fs.existsSync(p)) return p;
  }
  return null;
}

// The sweep owns the case list; this file owns the camera. Pulling the cases
// from there means a screen added to one is photographed by the other.
const sweep = fs.readFileSync(path.join(__dirname, 'test_mobile_screens.js'), 'utf8');
function sliceConst(name) {
  const i = sweep.indexOf(`const ${name} = \``);
  const j = sweep.indexOf('`;', i);
  return sweep.slice(sweep.indexOf('`', i) + 1, j);
}
const ROWS = sliceConst('ROWS');
const SEED = sliceConst('SEED');
const casesSrc = sweep.slice(sweep.indexOf('Object.assign(cases, {'), sweep.indexOf('  });\n  return cases;'));
const CASES = {};
{
  // eslint-disable-next-line no-new-func
  const fn = new Function('ROWS', 'cases', casesSrc.replace('Object.assign(cases, {', 'Object.assign(cases, {') + '  });\n  return cases;');
  fn(ROWS, CASES);
}
const subs = [...sweep.matchAll(/x/g)];   // placeholder, real subs read from the app below
const src0 = fs.readFileSync(APP, 'utf8');
// Both ways SUBS is written: keys of the object literal, and the two assigned
// to it afterwards (inbox and sales). Matching only the literal left Sales
// unphotographed — see the same note in test_mobile_screens.js.
for (const re of [/\n {2}([a-z_0-9]+):\{title:/g, /\nSUBS\.([a-z_0-9]+)\s*=\s*\{title:/g])
  for (const m of src0.matchAll(re)) CASES['push:' + m[1]] = CASES['push:' + m[1]] || `APP.cmd('push','${m[1]}')`;
for (const t of ['home', 'orders', 'customers', 'products', 'more']) CASES['tab:' + t] = CASES['tab:' + t] || `APP.cmd('tab','${t}')`;

function main() {
  const chrome = findChrome();
  if (!chrome) { console.log('SKIP — no Chromium found.'); process.exit(0); }
  fs.mkdirSync(OUT, { recursive: true });
  // Lucide is a CDN script and this container has no network, so ic() found no
  // glyph and emitted an empty <svg> of the right size: every icon in every
  // shot was an invisible hole. The geometry was honest — the box is there and
  // takes its space — but it made a chevron-down dropdown read as a stray word
  // and an overflow button as an empty square, and I chased both as bugs.
  //
  // A stub gives every name the same neutral mark. It is not the real glyph and
  // does not pretend to be; what it shows is that an icon is THERE, at the size
  // and in the colour the layout gives it.
  const ICON_STUB = `<script>window.lucide={icons:new Proxy({},{get:function(){return ['svg',{},[
    ['circle',{cx:12,cy:12,r:8.5}],
    ['circle',{cx:12,cy:12,r:2.25,fill:'currentColor',stroke:'none'}]]];}})};<\/script>`;
  // Entry animations off. tSheetUp and tFade are `both`-filled, so a sheet
  // caught before its animation starts sits at translateY(100%) with a scrim at
  // opacity 0 — entirely below the viewport, in a shot that otherwise looks like
  // a perfectly normal screen with no sheet on it. It is intermittent: the order
  // sheet came up, the customer sheet did not, and I went looking for the state
  // bug that was not there. Every keyframe's `to` is the element's own static
  // CSS, so removing the animation IS the settled frame.
  const STILL = '<style>*,*::before,*::after{animation:none!important;transition:none!important}</style>';
  // The page's one local dependency, inlined — see inlineTdDatetime(). Without
  // it every screen in the shot renders empty, which is a slow way to find out.
  let src = inlineTdDatetime(src0
    .replace(/<script src="https:\/\/unpkg\.com[^>]*><\/script>/, ICON_STUB)
    .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/, '')
    .replace('</head>', STILL + '</head>'));

  const SERVER = process.env.NO_FAKE_SERVER ? '' : fakeServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm-shoot-'));
  const looks = [
    ['light-en', ''],
    ['dark-en', "APP.cmd('toggleTheme');"],
    ['light-zh', "APP.cmd('toggleLang');"],
  ];
  const names = Object.keys(CASES).filter((n) => !FILTER || n.includes(FILTER)).sort();
  let n = 0;
  for (const name of names) {
    for (const [look, pre] of looks) {
      const file = path.join(dir, 'p.html');
      // The look is applied FIRST so the screen renders in it, not into it.
      // The fake server goes in BEFORE the app's own script runs, so its boot
      // fetches are answered and the screenshot shows a populated screen
      // rather than the offline branch every screen falls back to.
      // Split: the server stub must be evaluated before the app's own inline
      // script, and the case boot after the app has defined APP.cmd.
      const withServer = SERVER ? src.replace('<script>', `<script>${SERVER}</script><script>`) : src;
      fs.writeFileSync(file, withServer.replace('</body>',
        `<script>addEventListener("load",function(){try{${SEED}${pre}${ROWS}${CASES[name]}}catch(e){document.title='ERR '+e.message}});</script></body>`));
      // Headless Chrome CLAMPS --window-size to a 500px minimum width, so
      // shooting the app directly renders a 500px layout and then crops it to
      // 390 — every screenshot loses its right-hand 110px and the app looks
      // broken when it is not. The app goes in a 390-wide iframe pinned to the
      // left edge instead: the layout viewport inside it really is 390, and the
      // crop lands exactly on it.
      const host = path.join(dir, 'host.html');
      fs.writeFileSync(host, `<!doctype html><meta charset="utf-8">
        <style>html,body{margin:0;padding:0;background:#888}
          /* height:100vh, not a fixed 844: the HOST viewport is what headless
             Chrome actually gives us (it clamps, so ~500x757), and a taller
             iframe is simply clipped — which cut the bottom nav out of every
             shot. Matching the host's height puts the app's own 100vh shell
             exactly inside the captured area. */
          iframe{position:fixed;left:0;top:0;width:390px;height:100vh;border:0}</style>
        <iframe src="p.html"></iframe>`);
      const png = path.join(OUT, `${name.replace(/[^a-z0-9]/gi, '_')}__${look}.png`);
      try {
        execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox',
          '--hide-scrollbars', '--force-device-scale-factor=2',
          '--window-size=390,844', '--virtual-time-budget=2500',
          '--screenshot=' + png, 'file://' + host],
        { stdio: ['ignore', 'ignore', 'ignore'], timeout: 30000 });
        n++;
      } catch (e) { console.error(`FAILED ${name} ${look}: ${e.message}`); }
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${n} screenshots → ${OUT}`);
}
main();
