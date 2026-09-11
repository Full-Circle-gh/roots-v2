#!/usr/bin/env node
/**
 * Tacet Mobile keeps its own board current, and knows when not to.
 *
 *   node scripts/test_mobile_live.js
 *
 * THE COMPLAINT THIS PINS. Sent from the phone against a screenshot of Home:
 * "I have to refresh to see updates." Home is a board of arriving work — orders
 * to start, a channel that has stopped syncing, the day's takings — and it was
 * painted once at boot and then held still until somebody pulled it down. The
 * app shell said so in as many words: "nothing here polls".
 *
 * The fix is the desktop's own mechanism moved across: the live SSE stream
 * routes/retail.js already serves, plus a 60s backstop poll, both stopped while
 * the app is off screen. So the first thing asserted here is that it really is
 * the same mechanism — one endpoint, one interval, checked against the desktop
 * and the server rather than against a number typed twice.
 *
 * READS ONLY — no browser, so this one runs in the FAST shard and is part of
 * the gate. Its twin, test_mobile_live_guards.js, drives Chromium to prove the
 * refresh keeps its hands off an operator mid-count, and lives in the slow
 * shard with the other 30-odd render passes. The split is deliberate: these
 * checks are the ones that catch the two clients drifting apart, they cost
 * milliseconds, and burying them behind a browser would have put them in the
 * shard this repo does not run.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MHTML = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const CORE = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '01-core.js'), 'utf8');
const DASH = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '03-dashboard.js'), 'utf8');
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');

let statics = 0;
function still(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); statics++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

console.log('\nIt is the desktop\'s mechanism, not a phone-shaped reinvention');

/* THE POINT OF THESE THREE. A phone that polled its own endpoint on its own
   schedule would drift from the desktop the first time either moved, and the
   drift would show up as "the phone is a minute behind the office screen" —
   a complaint nobody could place. Each of these reads the OTHER file rather
   than restating what it should say. */
still('the phone subscribes to the endpoint the server actually serves', () => {
  assert.ok(/new EventSource\(apiURL\('\/stream'\)\)/.test(MHTML),
    'the phone does not open /stream through apiURL — re-check what it subscribes to');
  assert.ok(/const API='\/api\/retail-admin'/.test(MHTML), 'the API base moved');
  assert.ok(RETAIL.includes("router.get('/api/retail-admin/stream'"),
    'the server no longer serves the stream the phone now depends on');
});

still('and it is the same one the desktop subscribes to', () => {
  assert.ok(CORE.includes("new EventSource('/api/retail-admin/stream')"),
    'the desktop subscribes somewhere else now — the two clients have drifted');
});

still('the backstop poll runs at the desktop\'s interval', () => {
  const phone = /const M_LIVE_POLL_MS=(\d+)/.exec(MHTML);
  assert.ok(phone, 'the phone has no backstop interval');
  const desk = /const DASH_HERO_INTERVALS = \{[^}]*today: (\d+)/.exec(DASH);
  assert.ok(desk, 'the desktop interval table moved — re-check what this is matching');
  assert.strictEqual(phone[1], desk[1],
    `the phone polls every ${phone[1]}ms and the desktop every ${desk[1]}ms`);
});

still('the frame carries no data, so a nudge cannot leak a row', () => {
  /* The whole reason this is safe to wire to a handset. The server sends {ts}
     and the client re-reads under its own auth, so a role that may not see an
     order cannot be handed one by a broadcast aimed at the tenant. */
  assert.ok(/event: activity\\ndata: \$\{JSON\.stringify\(\{ ts: Date\.now\(\) \}\)\}/.test(RETAIL),
    'the activity frame carries a payload now — a phone must not be told what it may not read');
});

still('the Recap is left out of it on purpose', () => {
  /* "Recently · since 7:22 AM" is a SNAPSHOT of what happened while you were
     away, and loadRecap stamps the window closed the moment it reads it. An
     auto-refresh that re-ran it would move the window to now and empty the card
     — the one thing on Home that is supposed to hold still. The desktop leaves
     its recap out of the polled set for the same reason. */
  assert.ok(/if\(state\.recapTried\) return; state\.recapTried=true;/.test(MHTML),
    'the Recap latch is gone — an automatic refresh would now erase the card it refreshes');
  const live = MHTML.slice(MHTML.indexOf('function mLiveTick()'), MHTML.indexOf('function mLiveInit()'));
  assert.ok(!/loadRecap|recapTried/.test(live),
    'the automatic refresh touches the Recap — it would blank itself every 60 seconds');
});

console.log(`\nok — ${statics} live-refresh wiring checks.`);
