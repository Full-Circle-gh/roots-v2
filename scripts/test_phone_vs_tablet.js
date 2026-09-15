#!/usr/bin/env node
/**
 * A tablet is not a phone.
 *
 *   node scripts/test_phone_vs_tablet.js
 *
 * Two shells in server.js choose a phone build over a desktop one: the backend
 * (serveRetailAdmin → public/m.html) and the storefront editor (/cms →
 * public/cms-mobile.html). Both used to carry their own copy of the same
 * user-agent test, and both tested for the token `Android`.
 *
 * `Android` is in EVERY Android user-agent there is, tablets included. So a
 * shop tablet in landscape was served the one-column phone companion — the app
 * floating in the middle of the screen with empty margins either side — and
 * there was no route to the desktop back office short of knowing `?desktop=1`.
 *
 * Reported from a counter tablet, 2026-09-15: Back out of the counter till
 * landed on the phone app. The till's own door was right — it sends the
 * operator to `/?tab=dashboard`, the desktop dashboard they came in from — and
 * the shell at the other end turned it into a phone.
 *
 * The one signal that separates the two: Chrome, Firefox, Samsung Internet and
 * Edge put `Mobile` in an Android PHONE's user-agent and leave it out of a
 * TABLET's. That is the whole difference, and it is what isPhoneUA reads.
 *
 * This suite reads the real strings real devices send. It does not boot a
 * server: what is under test is a classification, and a table of devices is a
 * better statement of it than a live request would be.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Lift the shipped function out of server.js and run THAT — not a copy of it.
// A copy here would go on passing after the real one changed, which is the one
// failure a suite like this must not have.
const m = SERVER.match(/function isPhoneUA\(ua\) \{[\s\S]*?\n\}/);
if (!m) {
  console.log('  ✗ server.js no longer defines isPhoneUA — the shells are choosing a shell some other way');
  process.exit(1);
}
const isPhoneUA = new Function(m[0] + '; return isPhoneUA;')();

// [what it is, user-agent, is it a phone?]
const DEVICES = [
  // ── Phones: these must keep getting the phone build ────────────────────
  ['Android phone — Chrome (Pixel 8)', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', true],
  ['Android phone — Samsung Internet', 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36', true],
  ['Android phone — Firefox', 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0', true],
  ['Android phone — Edge', 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 EdgA/120.0.0.0', true],
  ['iPhone — Safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', true],
  ['iPod touch', 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1', true],
  // WeChat's in-app browser is a phone-shaped webview wherever it runs, which
  // both shells said before the shared function did.
  ['WeChat in-app browser (Android)', 'Mozilla/5.0 (Linux; Android 13; V2145A Build/TP1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.0.0 Mobile Safari/537.36 MMWEBID/1234 MicroMessenger/8.0.42.2460(0x28002A35)', true],

  // ── Tablets: THE BUG. Every one of these was called a phone ────────────
  ['Android tablet — Galaxy Tab, Chrome', 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36', false],
  ['Android tablet — Pixel Tablet', 'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', false],
  ['Android tablet — Lenovo, Chrome', 'Mozilla/5.0 (Linux; Android 12; Lenovo TB-J616F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36', false],
  ['Android tablet — Firefox', 'Mozilla/5.0 (Android 13; Tablet; rv:126.0) Gecko/126.0 Firefox/126.0', false],
  // iPadOS 13+ Safari sends a Macintosh string by default, so an iPad has
  // always reached the desktop shell. Named so it stays that way.
  ['iPad — iPadOS 13+ Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', false],

  // ── Desktops ───────────────────────────────────────────────────────────
  ['Windows — Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', false],
  ['macOS — Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15', false],
  ['Linux — Firefox', 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0', false],

  // ── Nothing at all. A missing user-agent is not a phone: the desktop shell
  //    is the one that works on every screen, so it is the safe default.
  ['no user-agent header', '', false],
  ['undefined user-agent', undefined, false],
];

let pass = 0;
const bad = [];
console.log('\nwhich shell each device gets');
for (const [name, ua, wantPhone] of DEVICES) {
  const got = isPhoneUA(ua);
  const label = (wantPhone ? 'phone  ' : 'desktop') + '  ' + name;
  if (got === wantPhone) { pass++; console.log('  ✓ ' + label); }
  else { bad.push(label + ' — got ' + (got ? 'phone' : 'desktop')); console.log('  ✗ ' + label); }
}

// ── The two shells must both go through it ───────────────────────────────
console.log('\nboth shells ask the same question');
const calls = (SERVER.match(/isPhoneUA\(/g) || []).length;
// One definition + two callers.
ok('the backend shell and the storefront editor both call isPhoneUA', calls >= 3);
// The old test must not survive anywhere: a second copy is how one gets fixed
// and the other does not.
ok('no copy of the old Android-catches-tablets test is left',
  !/\/Android\|iPhone\|iPod\|Windows Phone\|Mobile\|MicroMessenger\//.test(SERVER));
// The escape hatch stays: a phone that genuinely wants the desktop shell says so.
ok('?desktop=1 still forces the desktop shell', /desktop.*!==\s*'1'|desktop\s*===\s*'1'/.test(SERVER));

function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { bad.push(name); console.log('  ✗ ' + name); }
}

console.log('');
if (bad.length) {
  console.log(bad.length + ' failed of ' + (pass + bad.length) + ':');
  for (const b of bad) console.log('  ✗ ' + b);
  process.exit(1);
}
console.log('ok — ' + pass + ' phone-versus-tablet assertions.');
