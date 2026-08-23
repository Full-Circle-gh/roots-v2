#!/usr/bin/env node
/**
 * Is Tacet Mobile still an APP?
 *
 *   node scripts/test_mobile_pwa.js
 *
 * public/m.html is meant to be installed — home-screen icon, its own window,
 * no address bar. That is not one feature but a chain, and every link is
 * invisible when it breaks: a manifest that stops being served, an icon
 * regenerated at the wrong size, a service worker that never registers, and
 * Chrome simply stops offering Install. Nothing throws, nothing looks wrong,
 * and the operator goes on looking at a browser.
 *
 * So this checks the chain, in two passes:
 *
 *   • static  — the manifest is valid and complete, every icon it names exists
 *               at the size it claims, server.js actually serves each of those
 *               paths from the root, m.html links the manifest, sw.js carries
 *               the /m shell.
 *   • browser — over real HTTP, with the sweep's fake backend behind it: the
 *               service worker activates, theme and language survive a
 *               relaunch, Back closes a sheet instead of quitting, the install
 *               strip appears only when the browser offers an install, the
 *               pull-to-refresh that replaces pull-to-reload fires, and the
 *               manifest's home-screen shortcuts land where they say.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { fakeServer } = require('./lib/m-fakeserver');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const fails = [];
const ok = (m) => console.log('  ok   ' + m);
const bad = (m) => { fails.push(m); console.log('  FAIL ' + m); };

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  try { const p = require('playwright').chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch (e) {}
  for (const g of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (fs.existsSync(g)) return g;
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (fs.existsSync(pw)) for (const d of fs.readdirSync(pw)) {
    const p = path.join(pw, d, 'chrome-linux', 'chrome'); if (fs.existsSync(p)) return p;
  }
  return null;
}

// A PNG says its own dimensions in the IHDR chunk, bytes 16-23. Cheaper than a
// decoder and enough to catch the failure that matters: an icon regenerated at
// the wrong size still loads, and Chrome silently drops it from the install.
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.toString('hex', 1, 4) !== '504e47') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

// ── Static pass ────────────────────────────────────────────────────────────
const MF_PATH = path.join(PUB, 'm-manifest.webmanifest');
let MF = null;
console.log('\nstatic');
try { MF = JSON.parse(fs.readFileSync(MF_PATH, 'utf8')); ok('m-manifest.webmanifest parses'); }
catch (e) { bad('m-manifest.webmanifest does not parse: ' + e.message); }

if (MF) {
  // Chrome's install criteria, the ones a manifest can fail on its own.
  for (const k of ['name', 'short_name', 'start_url', 'icons']) {
    if (MF[k]) ok(`manifest has ${k}`); else bad(`manifest is missing ${k}`);
  }
  MF.display === 'standalone'
    ? ok('display is standalone — no address bar')
    : bad(`display is "${MF.display}", so the installed app keeps browser chrome`);
  // start_url must be inside scope or the install is refused outright.
  const scope = MF.scope || '/';
  String(MF.start_url || '').startsWith(scope)
    ? ok(`start_url ${MF.start_url} is inside scope ${scope}`)
    : bad(`start_url ${MF.start_url} is outside scope ${scope}`);

  const icons = MF.icons || [];
  for (const i of icons) {
    const f = path.join(PUB, i.src.replace(/^\//, ''));
    if (!fs.existsSync(f)) { bad(`icon ${i.src} is declared but not on disk`); continue; }
    if (!/\.png$/.test(i.src)) { ok(`icon ${i.src} present`); continue; }
    const [w, h] = String(i.sizes).split('x').map(Number);
    const got = pngSize(f);
    (got && got.w === w && got.h === h)
      ? ok(`icon ${i.src} is really ${w}×${h}`)
      : bad(`icon ${i.src} claims ${i.sizes} but is ${got ? got.w + '×' + got.h : 'not a PNG'}`);
  }
  // Android needs a maskable icon or it draws the square one inside a circle.
  icons.some((i) => String(i.purpose || '').includes('maskable'))
    ? ok('a maskable icon is offered')
    : bad('no maskable icon — Android will letterbox the launcher icon');
  // Every path the manifest names has to answer from the HOST ROOT, which for
  // this app means an explicit route: only /assets is served statically.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const routed = (p) => server.includes(`'${p}'`) || server.includes(`'${p.replace(/^\//, '')}'`);
  for (const p of ['/m', '/m-manifest.webmanifest', '/sw.js'].concat(icons.map((i) => i.src))) {
    routed(p) ? ok(`server.js serves ${p}`) : bad(`server.js has no route for ${p}`);
  }
  for (const s of MF.shortcuts || []) {
    /^\/m(\?|$)/.test(s.url) ? ok(`shortcut "${s.name}" points into /m`) : bad(`shortcut "${s.name}" points at ${s.url}`);
  }
}

const html = fs.readFileSync(path.join(PUB, 'm.html'), 'utf8');
html.includes('rel="manifest" href="/m-manifest.webmanifest"')
  ? ok('m.html links its manifest') : bad('m.html does not link /m-manifest.webmanifest');
html.includes("navigator.serviceWorker.register('/sw.js'")
  ? ok('m.html registers the service worker') : bad('m.html never registers a service worker — Chrome will not offer Install');
html.includes('apple-mobile-web-app-capable')
  ? ok('iOS standalone meta present') : bad('no apple-mobile-web-app-capable — iOS opens it in Safari chrome');
const sw = fs.readFileSync(path.join(PUB, 'sw.js'), 'utf8');
/const SHELL = \[[^\]]*'\/m'/.test(sw)
  ? ok("sw.js pre-caches the /m shell") : bad("sw.js SHELL does not include '/m' — the app has no offline shell");

// ── Browser pass ───────────────────────────────────────────────────────────
const CHROME = findChrome();
if (!CHROME) {
  console.log('\nbrowser — skipped, no Chromium found (set CHROME_BIN)');
  finish();
} else {
  run().then(finish, (e) => { console.error(e); process.exit(1); });
}

function finish() {
  console.log(fails.length ? `\n${fails.length} problem${fails.length === 1 ? '' : 's'}.` : '\nok — Tacet Mobile still installs like an app.');
  process.exit(fails.length ? 1 : 0);
}

// A stand-in for server.js: the same paths, from the same files. Booting the
// real app would drag a database and a session realm into a test about a
// manifest — the static pass above is what holds server.js to these routes.
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = req.url.split('?')[0];
      // The extensionless routes server.js hands to a file: '/' and '/m' are
      // both the app, and '/login' is a page the service worker pre-caches —
      // miss that one and install() rejects, the worker never activates, and
      // the whole browser pass hangs waiting for a worker that will never come.
      const named = { '/': 'm.html', '/m': 'm.html', '/login': 'login.html' };
      const file = named[p] || p.replace(/^\//, '');
      const abs = path.join(PUB, file);
      // Never let a request climb out of public/.
      if (!abs.startsWith(PUB) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        res.writeHead(404).end('no'); return;
      }
      const h = { 'Content-Type': TYPES[path.extname(abs)] || 'text/plain' };
      if (file === 'sw.js') h['Service-Worker-Allowed'] = '/';
      res.writeHead(200, h).end(fs.readFileSync(abs));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port }));
  });
}

async function run() {
  const { chromium, devices } = require('playwright');
  const { srv, base } = await serve();
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ ...devices['Pixel 7'], hasTouch: true, isMobile: true });
  // Without it every /api/retail-admin call 401s and the app bounces to login.
  await ctx.addInitScript(fakeServer());
  // Nothing leaves the machine. The app pulls Inter and the Lucide icon set off
  // public CDNs, and a test that waits on them is a test that fails whenever a
  // build box has no route out — which is most of them. Icons come out empty and
  // nothing here is about icons.
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    return (u.hostname === '127.0.0.1') ? route.continue() : route.abort();
  });
  const page = await ctx.newPage();
  // The app is up when its tab bar is on the glass — 'load' says nothing about
  // a page whose entire UI is written by a script.
  const open = async (url) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tabbar', { timeout: 15000 });
  };
  const reopen = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tabbar', { timeout: 15000 });
  };
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  console.log('\nbrowser');
  await open(base + '/m');

  const active = await page.evaluate(() =>
    navigator.serviceWorker.ready.then((r) => !!r.active).catch(() => false));
  active ? ok('service worker registers and activates') : bad('service worker never activated');

  // Theme + language survive being closed — an app remembers, a page forgets.
  await page.evaluate(() => window.APP.cmd('toggleTheme'));
  const meta = await page.getAttribute('#mThemeColor', 'content');
  meta === '#111A2B' ? ok('theme-color follows the theme into dark') : bad('theme-color stayed ' + meta);
  await reopen();
  (await page.getAttribute('html', 'data-theme')) === 'dark'
    ? ok('theme survives a relaunch') : bad('theme reset on relaunch');
  await page.evaluate(() => window.APP.cmd('toggleTheme'));
  await page.evaluate(() => window.APP.cmd('toggleLang'));
  await reopen();
  (await page.getAttribute('html', 'lang')) === 'zh'
    ? ok('language survives a relaunch') : bad('language reset on relaunch');
  await page.evaluate(() => window.APP.cmd('toggleLang'));

  // Back closes the top layer. In a standalone window the alternative is quitting.
  await page.evaluate(() => window.APP.cmd('overflow'));
  await page.waitForTimeout(120);
  if (!(await page.locator('.sheet').count())) bad('overflow sheet would not open');
  await page.goBack();
  await page.waitForTimeout(250);
  (!(await page.locator('.sheet').count()) && (await page.locator('.tabbar').count()))
    ? ok('Back closes a sheet and stays in the app') : bad('Back did not close the sheet');
  await page.evaluate(() => window.APP.cmd('push', 'settings'));
  await page.waitForTimeout(120);
  await page.goBack();
  await page.waitForTimeout(250);
  (await page.locator('.tabbar').count())
    ? ok('Back pops a pushed screen and stays in the app') : bad('Back from a pushed screen killed the app');

  // The install strip is the browser's offer, relayed — never our own guess.
  (await page.locator('text=/home screen/i').count()) === 0
    ? ok('no install strip until the browser offers one') : bad('install strip showed unprompted');
  await page.evaluate(() => {
    const e = new Event('beforeinstallprompt');
    e.prompt = () => {}; e.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(e);
  });
  await page.waitForTimeout(150);
  (await page.locator('text=/home screen/i').count())
    ? ok('install strip appears on beforeinstallprompt') : bad('install strip never appeared');
  await page.evaluate(() => window.APP.cmd('installOff'));
  await page.waitForTimeout(120);
  (await page.locator('text=/home screen/i').count()) === 0
    ? ok('install strip can be dismissed') : bad('install strip would not dismiss');

  // Pull to refresh — the replacement for the pull-to-reload we switched off.
  await page.evaluate(() => {
    const el = document.getElementById('content');
    el.scrollTop = 0;
    const T = (y) => ({ clientY: y, clientX: 100, identifier: 1, target: el });
    const fire = (type, y) => el.dispatchEvent(Object.assign(new Event(type, { bubbles: true }),
      { touches: type === 'touchend' ? [] : [T(y)], changedTouches: [T(y)] }));
    fire('touchstart', 100); fire('touchmove', 180); fire('touchmove', 300); fire('touchend', 300);
  });
  await page.waitForTimeout(150);
  (await page.locator('#pullSpin.spin').count()) ? ok('pull-to-refresh fires') : bad('pull-to-refresh did not fire');
  await page.waitForTimeout(1600);
  (await page.locator('#pullSpin.spin').count()) === 0 ? ok('the spinner clears when it is done') : bad('refresh spinner stuck');

  // A shortcut is a promise about where the app opens.
  for (const [to, want] of [['orders', /order|订单/i], ['products', /product|商品/i]]) {
    await open(base + '/m?from=app&to=' + to);
    const h1 = (await page.locator('h1').first().innerText()).trim();
    want.test(h1) ? ok(`shortcut ?to=${to} opens ${h1}`) : bad(`?to=${to} opened "${h1}"`);
  }
  await open(base + '/m?from=app&to=nowhere');
  (await page.locator('.tabbar').count()) ? ok('an unknown ?to= falls back to Home') : bad('an unknown ?to= broke the app');

  errs.length ? bad('uncaught page errors: ' + errs.join(' | ')) : ok('no uncaught page errors');
  await browser.close();
  srv.close();
}
