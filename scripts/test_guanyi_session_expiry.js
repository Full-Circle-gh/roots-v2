#!/usr/bin/env node
/**
 * The Guanyi session-expiry notice: what it reads, and how often it may page.
 *
 *   node scripts/test_guanyi_session_expiry.js
 *
 * No network, no DB, no Chromium — a session JSON is written to a temp dir and
 * lib/guanyi-browser.js's sessionExpiry() is run against it, and the on-disk
 * window from lib/alert-latch.js is exercised under its own test-only keys,
 * which it removes afterwards. Safe to run on the box.
 *
 * WHY THIS EXISTS — 2026-08-25, the alert that cried wolf every twenty minutes.
 * The ops WeCom group was paged, over and over, with
 *
 *     🟡 管易 tianhe 登录将在约 0 小时后过期，请在方便时重新登录（现在同步仍正常）
 *
 * while the session was in perfect health and stock was syncing normally. Two
 * independent defects, and BOTH had to be true to produce it:
 *
 *   1. sessionExpiry() took the minimum over every dated *.guanyierp.com cookie.
 *      v2.guanyierp.com sits behind Aliyun's WAF, whose acw_tc cookie is dated
 *      ~30 minutes out and reissued constantly. It was always the minimum, so
 *      the daemon believed the login was permanently minutes from death: the
 *      condition never left the warning window and the notice became standing.
 *   2. The once-per-12h debounce lived in a plain object in process memory. The
 *      daemon was restarting (the box was paging about disk >= 85%, which takes
 *      Chromium with it), and every start re-opened the window inside a minute.
 *
 * So the two things pinned here are: a rolling WAF cookie is not a login
 * expiry, and the window survives a restart.
 *
 * FOLLOW-UP — 2026-08-28, the alert that cried wolf every twelve hours instead.
 * The 08-25 fix (a NON_LOGIN_COOKIE denylist of known WAF/CDN/analytics names)
 * stopped the ~0h pages, but the daemon kept paging "~45h" on a loop. A live
 * dump of tianhe's session cookies showed why: device_id and cid, a device
 * fingerprint reissued roughly daily, dated ~42h out — on nobody's denylist,
 * and past the 6h rolling-cookie window, so they became the new minimum. The
 * jar also carries several Alibaba tracking cookies dated ~360-400 days out
 * (loginAppkey, _ati, tfstk, two 3AB9D23F… hex cookies) that a denylist would
 * equally have missed had they ever been the minimum. And the cookie that
 * actually IS the login, shiroCookie, turned out to carry no expires date at
 * all — a pure session cookie, so its true lifetime was never observable from
 * the jar to begin with.
 *
 * Fix: LOGIN_COOKIE is now an ALLOWLIST of the one cookie known to gate the
 * login, not a denylist of cookies known not to. A denylist only ever knows
 * the junk it has already met; an allowlist can't be fooled by the next
 * rolling cookie that shows up dated a day or two out. Given shiroCookie has
 * no date, sessionExpiry() now returns null in normal operation — there is no
 * reliable forward-looking signal in this cookie jar, and no warning beats a
 * fabricated one. The reactive "🔴 登录已失效" alert (fired when a live API
 * call actually fails) is untouched and remains the trustworthy signal.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'guanyi-expiry-'));
const HOUR = 3600_000;

// A GuanyiBrowser whose only live parts are the ones under test: the session
// file it reads and the mtime helper sessionExpiry() calls. Constructing the
// real class would launch nothing (init() is what touches Playwright), but this
// keeps the test honest about exactly which inputs matter.
const { GuanyiBrowser } = require('../lib/guanyi-browser');

// Writes a session snapshot and back-dates its mtime, so "when were these
// cookies last seen alive" is a value the test controls.
function snapshot(cookies, writtenAgoMs = 0) {
  const b = Object.create(GuanyiBrowser.prototype);
  b.storeCode = 'tianhe';
  b.sessionFile = path.join(TMP, `sess-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(b.sessionFile, JSON.stringify({ cookies }));
  const at = new Date(Date.now() - writtenAgoMs);
  fs.utimesSync(b.sessionFile, at, at);
  return b;
}
const cookie = (name, inMs, domain = '.guanyierp.com') =>
  ({ name, domain, path: '/', expires: Math.floor((Date.now() + inMs) / 1000) });

console.log('sessionExpiry — what counts as the login');

it('the WAF\'s rolling cookie is not the login expiry (the 2026-08-25 page)', () => {
  const b = snapshot([
    cookie('acw_tc', 30 * 60_000),        // Aliyun WAF, ~30 min, reissued for ever
    cookie('shiroCookie', 40 * HOUR),     // the actual login, IF it ever carries a date
  ]);
  const exp = b.sessionExpiry();
  assert.ok(exp, 'expected an expiry from the login cookie');
  assert.strictEqual(exp.name, 'shiroCookie', `read ${exp.name} as the login`);
  const hrs = Math.round((exp.atMs - Date.now()) / HOUR);
  assert.ok(hrs >= 39 && hrs <= 41, `expected ~40h, got ${hrs}h`);
});

it('a non-allowlisted cookie is never the login, however it\'s dated (the 2026-08-28 page)', () => {
  // device_id/cid: a device fingerprint, reissued roughly daily and dated
  // ~42h out on a live tianhe dump — well past the 6h rolling window, so the
  // 2026-08-25 denylist fix let it through and it paged "~45h" on a loop.
  // Not on LOGIN_COOKIE, so the allowlist must ignore it regardless of dating.
  const b = snapshot([
    cookie('device_id', 42 * HOUR),
    cookie('cid', 42 * HOUR),
  ]);
  assert.strictEqual(b.sessionExpiry(), null, 'a non-login cookie must never be read as the login');
});

it('shiroCookie itself carries no expiry, so a real session still reports null', () => {
  // The 2026-08-28 finding: the actual login cookie is a pure session cookie
  // on this tenant (expires -1). No warning is the honest answer here, not a
  // guess borrowed from whichever unrelated cookie happens to be dated soonest.
  const b = snapshot([
    { name: 'shiroCookie', domain: '.guanyierp.com', path: '/', expires: -1 },
    cookie('secToken', 400 * 24 * HOUR),   // ~400d Alibaba-tracking-style dating; not the login
  ]);
  assert.strictEqual(b.sessionExpiry(), null);
});

it('nothing but rolling cookies means NO warning, not a fake one', () => {
  const b = snapshot([cookie('acw_tc', 30 * 60_000), cookie('acw_sc__v2', 20 * 60_000)]);
  assert.strictEqual(b.sessionExpiry(), null);
});

it('other domains and undated session cookies are still ignored', () => {
  const b = snapshot([
    cookie('shiroCookie', 10 * HOUR, '.aliyun.com'),
    { name: 'tmp', domain: '.guanyierp.com', path: '/', expires: -1 },
    cookie('shiroCookie', 60 * HOUR),
  ]);
  const exp = b.sessionExpiry();
  assert.strictEqual(exp.name, 'shiroCookie');
  assert.ok(Math.round((exp.atMs - Date.now()) / HOUR) >= 59);
});

it('a login genuinely near its end is still reported, on a stale snapshot', () => {
  // persistSession has not written for two days (it only writes while logged
  // in), so the rolling filter measures from then — a real 3h-away expiry on a
  // 2-day-old file is news, and must not be filtered away as "reissued".
  const b = snapshot([cookie('shiroCookie', 3 * HOUR)], 2 * 24 * HOUR);
  const exp = b.sessionExpiry();
  assert.ok(exp && exp.name === 'shiroCookie', 'expected the near expiry to survive');
});

it('no session file at all is null, not a throw', () => {
  const b = Object.create(GuanyiBrowser.prototype);
  b.storeCode = 'tianhe';
  b.sessionFile = path.join(TMP, 'does-not-exist.json');
  assert.strictEqual(b.sessionExpiry(), null);
});

console.log('alert-latch — the window survives a restart');

// A fresh module instance per case is what a daemon restart looks like from the
// latch's point of view: memory gone, only the files under data/alert-latch/
// left to tell it what it has already said.
const latch = () => {
  delete require.cache[require.resolve('../lib/alert-latch')];
  return require('../lib/alert-latch');
};
// data/alert-latch/ is where the real one writes; each case uses its own key, so
// nothing here can collide with a running daemon's latch.
const WINDOW_DIR = path.join(__dirname, '..', 'data', 'alert-latch');
const windowFile = (key) => path.join(WINDOW_DIR, `test--${key}.window.json`);
const usedKeys = [];
const testKey = (name) => { const k = `expiry-${name}-${process.pid}`; usedKeys.push(k); return k; };

it('a restarted daemon inside the window does NOT re-page', () => {
  const key = testKey('restart');
  assert.strictEqual(latch().claimWindow('test', key, 12 * HOUR), true, 'the first notice should go');
  for (let restart = 1; restart <= 5; restart++) {
    assert.strictEqual(latch().claimWindow('test', key, 12 * HOUR), false,
      `restart ${restart} re-paged — this is the every-twenty-minutes bug`);
  }
});

it('the window does open again once it has actually elapsed', () => {
  const key = testKey('elapsed');
  latch().claimWindow('test', key, 12 * HOUR);
  const f = windowFile(key);
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  rec.at -= 13 * HOUR;                          // pretend thirteen hours passed
  fs.writeFileSync(f, JSON.stringify(rec));
  assert.strictEqual(latch().claimWindow('test', key, 12 * HOUR), true);
});

it('a re-login clears the window, so the next notice is news', () => {
  const key = testKey('relogin');
  const l = latch();
  l.claimWindow('test', key, 12 * HOUR);
  assert.strictEqual(l.claimWindow('test', key, 12 * HOUR), false);
  l.clearWindow('test', key);
  assert.strictEqual(l.claimWindow('test', key, 12 * HOUR), true);
});

it('a window that cannot be persisted still lets the notice out', () => {
  // Losing restart-survival is the old behaviour; losing the alert is not.
  const key = testKey('unwritable');
  const l = latch();
  const orig = fs.writeFileSync;
  fs.writeFileSync = () => { throw new Error('EROFS: read-only file system'); };
  try { assert.strictEqual(l.claimWindow('test', key, 12 * HOUR), true); }
  finally { fs.writeFileSync = orig; }
});

it('a window it cannot READ holds the advisory back, rather than repeating it', () => {
  // The opposite direction from the latches in the same file, and deliberately:
  // a deferred advisory is offered again next tick, a repeated one is the bug.
  const key = testKey('unreadable');
  const l = latch();
  const orig = fs.statSync;
  fs.statSync = () => { throw new Error('EACCES: permission denied'); };
  try { assert.strictEqual(l.claimWindow('test', key, 12 * HOUR), false); }
  finally { fs.statSync = orig; }
});

console.log('the daemon still routes the notice through the on-disk window');

it('guanyi-daemon warns via claimWindow and clears via clearWindow', () => {
  // A source-level guard, deliberately: scripts/guanyi-daemon.js runs main() on
  // require, so the decision cannot be called from here — and the failure this
  // is protecting against is precisely someone "simplifying" the warn path back
  // to a bare in-memory timestamp, which reads fine and re-pages on every
  // restart.
  const src = fs.readFileSync(path.join(__dirname, 'guanyi-daemon.js'), 'utf8');
  const block = src.slice(src.indexOf('const exp = browser.sessionExpiry();'));
  assert.ok(/claimWindow\('guanyi', key, SESSION_WARN_EVERY_MS/.test(block),
    'the expiry warning no longer goes through the persisted window');
  assert.ok(/clearWindow\('guanyi', key\)/.test(block),
    'the recovery path no longer clears the persisted window');
});

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
// Leave no test keys behind in the real data/alert-latch/ directory.
for (const k of usedKeys) { try { fs.unlinkSync(windowFile(k)); } catch (_) { /* already gone */ } }
process.exit(fail ? 1 : 0);
