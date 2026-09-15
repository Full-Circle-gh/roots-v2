#!/usr/bin/env node
/**
 * The counter till as an installed app — the contract that makes the browser
 * offer it, and the two things that must never come with it.
 *
 *   node scripts/test_till_install.js
 *
 * Reported as: the counter runs in a browser tab, with tabs and an address bar
 * over it, and nothing ever offers to make it an app.
 *
 * public/till-manifest.webmanifest had been right the whole time — it names
 * the app, ships four icons and asks for standalone landscape — and the head
 * of public/till.html carries the apple-* tags iOS reads. THE MISSING HALF WAS
 * A SERVICE WORKER. Chrome and Edge will not fire beforeinstallprompt, and
 * will not draw the omnibox install button, for a page that has none —
 * whatever its manifest says — so /till qualified in every other respect and
 * was a browser tab for good.
 *
 * That is a contract spread over four files (the page, the manifest, the
 * worker and the two routes in server.js) where breaking any one part removes
 * the offer SILENTLY: nothing throws, nothing 404s, no test goes red, the
 * install option simply stops appearing and nobody finds out until a shop
 * asks. This is the check that holds all four together.
 *
 * NO BROWSER. This suite reads files, so it runs in the FAST shard — the gate
 * — rather than the shard the house does not run. The behavioural half (a tap
 * on Add raises the browser's own dialog) needs a real browser and would land
 * where it would never execute, and a check that does not run protects
 * nothing.
 *
 * Two guards here are not about installing at all:
 *
 *   • NOTHING NEW WAS MINTED. Every Chinese half on the till's install strip
 *     must appear, byte for byte, in public/m.html — the phone companion has
 *     been asking this same question in these same words since it shipped.
 *     CLAUDE.md's rule for composed strings, made executable.
 *   • A TILL NEVER RELOADS ITSELF. The worker posts 'sw-updated' to every
 *     client when a deploy lands and /m answers by reloading when it is safe.
 *     A till must not: a basket lives in S.lines and nowhere else, so a reload
 *     behind a cashier with eight lines rung up throws the sale on the floor.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const P = (...a) => path.join(ROOT, ...a);
const read = (...a) => fs.readFileSync(P(...a), 'utf8');

const TILL = read('public', 'till.html');
const M = read('public', 'm.html');
const SERVER = read('server.js');
const SW = read('public', 'sw.js');
const MANIFEST_RAW = read('public', 'till-manifest.webmanifest');

// Comments in this file describe the very strings and calls under test, so the
// checks below read the CODE, not the prose around it.
const TILL_JS = TILL
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1 ');

let pass = 0;
const bad = [];
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { bad.push(name); console.log('  ✗ ' + name); } }

// ── 1. The manifest is the shape Chrome requires ─────────────────────────
console.log('\nthe manifest Chrome reads');
let mf = null;
try { mf = JSON.parse(MANIFEST_RAW); } catch (e) { /* reported below */ }
ok('it is valid JSON — a manifest that does not parse is a manifest that is not there', !!mf);

if (mf) {
  ok('it has a name', !!(mf.name || mf.short_name));
  ok('it has a start_url', typeof mf.start_url === 'string' && mf.start_url.length > 0);
  // Chrome installs only for a display mode that leaves the browser behind.
  // "browser" is the one value that disqualifies it, and it is the default.
  ok('it asks to leave the browser behind',
    ['standalone', 'fullscreen', 'minimal-ui'].indexOf(mf.display) > -1);

  const icons = Array.isArray(mf.icons) ? mf.icons : [];
  // 192 AND 512 are both required, and "any" is the purpose Chrome counts —
  // a manifest carrying only maskable icons does not qualify.
  const anyAt = (size) => icons.some((i) =>
    String(i.sizes || '').split(/\s+/).indexOf(size + 'x' + size) > -1
    && (!i.purpose || String(i.purpose).split(/\s+/).indexOf('any') > -1));
  ok('a 192 icon Chrome will accept', anyAt(192));
  ok('a 512 icon Chrome will accept', anyAt(512));

  // An icon the browser cannot fetch fails the install check as surely as a
  // missing one, and a 404 here is invisible until somebody tries.
  const missing = icons
    .map((i) => String(i.src || ''))
    .filter((s) => s.indexOf('/') === 0 && !fs.existsSync(P('public', s.slice(1))));
  ok('every icon it names is on disk' + (missing.length ? ' — missing ' + missing.join(', ') : ''),
    missing.length === 0);

  // The worker must control the start_url, or the page is not installable
  // however well it is registered. Both live at the root, so this holds — the
  // check is here so that moving either one says so.
  ok('the start_url sits inside the worker scope the page registers',
    String(mf.start_url).indexOf('/') === 0);
}

// ── 2. The page asks for it ──────────────────────────────────────────────
console.log('\nwhat the till itself does');
ok('the till links its manifest', /<link rel="manifest" href="\/till-manifest\.webmanifest">/.test(TILL));

// THE LOAD-BEARING LINE. Without it Chrome never offers the install at all.
ok('it registers the service worker — the half that was missing',
  /navigator\.serviceWorker\.register\(\s*'\/sw\.js'\s*,\s*\{\s*scope:\s*'\/'\s*\}/.test(TILL_JS));
ok('and only where a worker can run (isSecureContext, not a hand-rolled protocol check)',
  /window\.isSecureContext/.test(TILL_JS));

ok('it keeps the install event — it cannot be conjured later',
  /addEventListener\('beforeinstallprompt'/.test(TILL_JS));
ok("it suppresses Chrome's own mini-infobar, which lands over Mark paid",
  /beforeinstallprompt'[\s\S]{0,200}?preventDefault\(\)/.test(TILL_JS));
ok('it notices when the app is installed', /addEventListener\('appinstalled'/.test(TILL_JS));
ok('it raises the browser dialog rather than imitating one', /\.prompt\(\)/.test(TILL_JS));

for (const id of ['hd-install', 'inst-bar', 'inst-go', 'inst-off']) {
  ok('the ask has its ' + id, TILL.indexOf('id="' + id + '"') > -1);
}
// The dismiss must be remembered, or the strip is a nag at the top of a
// screen somebody stares at all day.
ok('a dismissal is remembered', /INSTALL_KEY/.test(TILL_JS) && /localStorage\.setItem\(INSTALL_KEY/.test(TILL_JS));
// ...and must not be the end of it: the header control is the way back.
ok("and it is not the end of it — the header control outlives the strip",
  /\$\('hd-install'\)/.test(TILL_JS));

// ── 3. The server serves both halves ─────────────────────────────────────
console.log('\nwhat the server has to send');
ok('the manifest has a route', /app\.get\('\/till-manifest\.webmanifest'/.test(SERVER));
ok('the worker has a route', /app\.get\('\/sw\.js'/.test(SERVER));
ok("and it is allowed the '/' scope the till registers it at",
  /Service-Worker-Allowed/.test(SERVER));
// A worker with no fetch handler does not qualify the page, however well it
// is registered — this is the property Chrome actually tests for.
ok('the worker handles fetch, which is what Chrome checks for',
  /addEventListener\('fetch'/.test(SW));

// ── 4. Nothing new was minted ────────────────────────────────────────────
console.log('\nthe Chinese');
// Each install row in the till's STRINGS table, as [key, cn].
const rows = [];
const table = (TILL.match(/var STRINGS = \{[\s\S]*?\n  \};/) || [''])[0];
for (const m of table.matchAll(/^\s*(install\w*):\s*\[\s*'((?:[^'\\]|\\.)*)'\s*,\s*\n?\s*'((?:[^'\\]|\\.)*)'\s*\]/gm)) {
  rows.push([m[1], m[3]]);
}
ok('the install strings are declared in STRINGS like every other string here', rows.length >= 3);
for (const [key, cn] of rows) {
  ok(key + ' is quoted from a live pair in m.html, not composed', M.indexOf(cn) > -1);
}

// ── 5. The two things that must not come with it ─────────────────────────
console.log('\nwhat a till must never do');
// A reload mid-sale throws a basket that exists nowhere else on the floor.
ok('the till never reloads itself — a basket lives in S.lines and nowhere else',
  !/location\.reload\(/.test(TILL_JS));
ok("and it does not listen for the worker's 'sw-updated', which is how /m earns its reload",
  !/serviceWorker\.addEventListener\('message'/.test(TILL_JS) && TILL_JS.indexOf('sw-updated') === -1);
// §1: a decision belongs in the page. e.prompt() is the browser's own install
// dialog and is the one exception — it is not ours to draw — but the page must
// not reach for the system's generic three.
for (const d of ['window.confirm(', 'window.alert(', 'window.prompt(']) {
  ok(d + ' is not how this page asks anything', TILL_JS.indexOf(d) === -1);
}

console.log('');
if (bad.length) {
  console.log(bad.length + ' failed of ' + (pass + bad.length) + ':');
  for (const b of bad) console.log('  ✗ ' + b);
  process.exit(1);
}
console.log('ok — ' + pass + ' counter-till install assertions.');
