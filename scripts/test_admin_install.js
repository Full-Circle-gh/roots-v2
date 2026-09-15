#!/usr/bin/env node
/**
 * The back office as an installed app — the contract that makes a browser
 * offer it, and the things that must not come with it.
 *
 *   node scripts/test_admin_install.js
 *
 * Reported from a shop tablet: the installed "Tacet" app showed the phone
 * companion, letterboxed into a portrait column on a landscape screen, and
 * nothing made it show the desktop back office.
 *
 * NOTHING COULD. That app is public/m-manifest.webmanifest — start_url '/m',
 * orientation 'portrait' — and '/m' IS Tacet Mobile, with no device detection
 * anywhere near it. Meanwhile public/retail-admin.html linked no manifest at
 * all, so the desktop back office was not installable by anything. There was
 * no app to install; that is the hole this fills.
 *
 * The contract spans four files — the shell, the manifest, the worker and the
 * route — and breaking any one removes the offer SILENTLY: nothing throws,
 * nothing 404s, no test goes red, the install option simply stops appearing.
 * That is what this suite is for.
 *
 * NO BROWSER, so it runs in the FAST shard — the gate — rather than the shard
 * the house does not run. The behavioural half needs a session (the shell
 * navigates to the login page without one) and would land where it would never
 * execute, and a check that does not run protects nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const P = (...a) => path.join(ROOT, ...a);
const read = (...a) => fs.readFileSync(P(...a), 'utf8');

const SHELL = read('public', 'retail-admin.html');
const MODULE = read('public', 'retail-admin', '30-install.js');
const SERVER = read('server.js');
const SW = read('public', 'sw.js');
const RAW = read('public', 'admin-manifest.webmanifest');
/* The comments in that module describe the very calls under test — including
   the 'sw-updated' it deliberately does NOT listen for — so the behavioural
   checks below read the CODE, not the prose around it. */
const MODULE_JS = MODULE
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1 ');
const PHONE = JSON.parse(read('public', 'm-manifest.webmanifest'));

let pass = 0;
const bad = [];
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { bad.push(name); console.log('  ✗ ' + name); }
}

// ── 1. The manifest Chrome reads ─────────────────────────────────────────
console.log('\nthe manifest');
let mf = null;
try { mf = JSON.parse(RAW); } catch (e) { /* reported below */ }
ok('it is valid JSON — a manifest that does not parse is one that is not there', !!mf);

if (mf) {
  ok('it has a name', !!(mf.name && mf.short_name));
  ok('it asks to leave the browser behind',
    ['standalone', 'fullscreen', 'minimal-ui'].indexOf(mf.display) > -1);

  const icons = Array.isArray(mf.icons) ? mf.icons : [];
  const anyAt = (n) => icons.some((i) =>
    String(i.sizes || '').split(/\s+/).indexOf(n + 'x' + n) > -1
    && (!i.purpose || String(i.purpose).split(/\s+/).indexOf('any') > -1));
  ok('a 192 icon Chrome will accept', anyAt(192));
  ok('a 512 icon Chrome will accept', anyAt(512));
  const missing = icons.map((i) => String(i.src || ''))
    .filter((s) => s.indexOf('/') === 0 && !fs.existsSync(P('public', s.slice(1))));
  ok('every icon it names is on disk' + (missing.length ? ' — missing ' + missing.join(', ') : ''),
    missing.length === 0);

  /* THE BUG THIS WAS WRITTEN FOR. The phone app locks itself to portrait,
     which is right for a phone and is exactly what put blue bars down both
     sides of a landscape tablet. Absent means any. */
  ok('it does NOT lock an orientation — that lock is what letterboxed the tablet',
    !('orientation' in mf));
  ok('and the phone app still keeps its portrait lock, which is right for a phone',
    PHONE.orientation === 'portrait');

  /* A PWA start_url has to resolve WITHOUT a redirect, and /retail-admin is a
     pure 302 forwarder to this host's root (app.get('/retail-admin')). */
  ok("start_url is '/' — the back office's only non-redirecting address", mf.start_url === '/');
  ok('and server.js still forwards /retail-admin, which is why it cannot be the start_url',
    /app\.get\('\/retail-admin',[\s\S]{0,260}?res\.redirect\(302/.test(SERVER));

  /* Two installed apps sharing an id is one overwriting the other. The id
     must differ from the phone app's AND from the §78-retired kitchen
     manifest, whose id defaults to its start_url of '/'. */
  const kitchen = JSON.parse(read('public', 'manifest.webmanifest'));
  ok('it declares an explicit id', typeof mf.id === 'string' && mf.id.length > 0);
  ok('its id differs from the phone app’s', mf.id !== PHONE.id);
  ok('its id is not the start_url the retired kitchen app already answers to',
    mf.id !== (kitchen.id || kitchen.start_url));

  /* Scope must cover where the app actually goes — it signs out to
     /backend/login — or the operator is dropped into a browser mid-session. */
  ok('its scope covers the /backend pages it signs out through', mf.scope === '/');
}

// ── 2. The shell asks for it ─────────────────────────────────────────────
console.log('\nwhat the back office does');
ok('the shell links the manifest', /<link rel="manifest" href="\/admin-manifest\.webmanifest">/.test(SHELL));
ok('the install row is in the account menu', SHELL.indexOf('id="acctInstall"') > -1);
ok('the row is hidden until a browser offers the install',
  /id="acctInstall"[^>]*\shidden/.test(SHELL));
ok('the row is bilingual in one clean text node, as the house rule requires',
  /<span>Install app · 安装应用<\/span>/.test(SHELL));
ok('the module is loaded', /<script src="\/assets\/retail-admin\/30-install\.js"><\/script>/.test(SHELL));

// THE LOAD-BEARING LINE. Without it no browser offers the install at all.
ok('it registers the service worker — the half without which nothing is offered',
  /navigator\.serviceWorker\.register\(\s*'\/sw\.js'\s*,\s*\{\s*scope:\s*'\/'\s*\}/.test(MODULE));
ok('and only where a worker can run (isSecureContext)', /window\.isSecureContext/.test(MODULE));
ok('it keeps the install event — it cannot be conjured later',
  /addEventListener\('beforeinstallprompt'/.test(MODULE));
ok("it suppresses Chrome's own mini-infobar", /beforeinstallprompt'[\s\S]{0,260}?preventDefault\(\)/.test(MODULE));
ok('it notices when the app is installed', /addEventListener\('appinstalled'/.test(MODULE));
ok('it raises the browser dialog rather than imitating one', /\.prompt\(\)/.test(MODULE));
ok('it offers nothing once already installed', /display-mode: standalone/.test(MODULE));

// ── 3. The server sends both halves ──────────────────────────────────────
console.log('\nwhat the server has to send');
ok('the manifest has a route', /app\.get\('\/admin-manifest\.webmanifest'/.test(SERVER));
ok('it is sent as a manifest, not as text', /admin-manifest[\s\S]{0,200}?application\/manifest\+json/.test(SERVER));
ok('the worker has a route', /app\.get\('\/sw\.js'/.test(SERVER));
ok("and is allowed the '/' scope the module registers it at", /Service-Worker-Allowed/.test(SERVER));
ok('the worker handles fetch, which is what Chrome actually checks for',
  /addEventListener\('fetch'/.test(SW));

// ── 4. What an installed back office must never do ───────────────────────
console.log('\nwhat it must never do');
/* The worker posts 'sw-updated' to every client when a deploy lands and /m
   answers by reloading. This page must not: it is full of half-filled forms,
   unsaved rows and open composers. */
ok("the module never reloads the page — this shell is full of unsaved work",
  !/location\.reload\(/.test(MODULE_JS));
ok("and it does not listen for the worker's 'sw-updated', which is how /m earns its reload",
  MODULE_JS.indexOf('sw-updated') === -1);

console.log('');
if (bad.length) {
  console.log(bad.length + ' failed of ' + (pass + bad.length) + ':');
  for (const b of bad) console.log('  ✗ ' + b);
  process.exit(1);
}
console.log('ok — ' + pass + ' back-office install assertions.');
