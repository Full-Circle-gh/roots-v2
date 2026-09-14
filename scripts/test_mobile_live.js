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

still('the Orders list is inside the backstop, not just the counts beside it', () => {
  /* THE COMPLAINT THIS PINS, TAKE TWO. Same words, this time against a
     screenshot of Orders: "I have to refresh the page to see the update."
     The Home fix above wired the 60s tick to the tab counts and the SSE nudge
     to a full refreshOrders() — but left the tick itself blind to the order
     list. An operator whose stream never delivers (a VPN or a proxy sitting on
     the connection is the reported case — EventSource can read as open while
     nothing arrives) watched the "awaiting fulfilment" count move while the
     rows under it sat still, because nothing on a timer ever called
     refreshOrders(). It does now, on the same tick, and only when there is a
     list on screen to repaint. */
  const live = MHTML.slice(MHTML.indexOf('function mLiveTick()'), MHTML.indexOf('function mLiveInit()'));
  assert.ok(/refreshOrders\(\)/.test(live),
    'mLiveTick no longer calls refreshOrders() — the Orders list has lost its 60s backstop again');
  assert.ok(/state\.tab===['"]orders['"]\s*\|\|\s*state\.detailId!=null/.test(live),
    'the guard around refreshOrders() in mLiveTick changed — check it still covers the list AND an open order sheet');
});

still('no single stalled request can switch the refresh off for good', () => {
  /* THE COMPLAINT THIS PINS, TAKE THREE. Same words a third time, against a
     screenshot of Orders taken on a handset with a VPN badge in its status
     bar. The two fixes above were both about REACH — wire the stream, then
     widen the backstop to repaint the rows and not just the counts above them
     — and neither could help, because what had stopped was the machinery.

     Every refresh path holds a latch while it works (state.refreshing by hand,
     _mLive.busy automatically) and mAutoOK() reads either as "already running".
     The only release was the Promise.all beneath it, and fetch() has no
     timeout: a tunnel that drops mid-request leaves its promise pending
     indefinitely, so the latch never lifts, and from that instant every tick,
     every nudge and every return to the app refuses in silence. On the hand
     path state.refreshing ALSO holds the pull gap open with the ring turning
     and stops wirePull() re-arming, so the gesture out is gone too. The only
     cure left was a reload — which is the sentence on the ticket, and which an
     installed app has no button for.

     So every job in every refresh path goes through mSettled(), which gives up
     on the latch (never on the fetch) after M_JOB_MS. A raw
     `Promise.resolve(x).catch()` in any of the three is the bug back. */
  assert.ok(/function mSettled\(/.test(MHTML),
    'mSettled is gone — a stalled fetch can latch the refresh off again');
  for (const fn of ['refreshNow', 'mLiveTick', 'mLiveRefreshAll']) {
    const from = MHTML.indexOf(`function ${fn}(){`);
    assert.ok(from > 0, `${fn} is gone — re-check what clears the refresh latch`);
    const body = MHTML.slice(from, MHTML.indexOf('\n}', from));
    assert.ok(/mSettled\(/.test(body),
      `${fn} no longer time-boxes its jobs — one hung request switches the refresh off for good`);
    assert.ok(!/Promise\.resolve\([^)]*\)\.catch/.test(body),
      `${fn} waits on a raw promise again — that is the latch that never lifted`);
  }
  assert.ok(/_mLive\.busy=false/.test(MHTML) && /state\.refreshing=false/.test(MHTML),
    'a latch is set with nothing shown to clear it');
});

still('a late answer never paints over a newer one', () => {
  /* The price of letting the latch go early is that two refreshOrders() can be
     in the air at once, and an old answer landing second would paint the list
     backwards — on a list of ARRIVING WORK that reads as an order vanishing.
     A ticket, not a race: only the newest read may paint. */
  const from = MHTML.indexOf('async function refreshOrders()');
  assert.ok(from > 0, 'refreshOrders is gone');
  const body = MHTML.slice(from, MHTML.indexOf('\n}', MHTML.indexOf('order-status-counts', from)));
  assert.ok(/const seq=\+\+_ordSeq;/.test(body),
    'refreshOrders no longer takes a ticket — overlapping reads can paint out of order');
  assert.ok((body.match(/seq===_ordSeq|seq!==_ordSeq/g) || []).length >= 3,
    'a paint in refreshOrders is no longer guarded by its ticket — check the detail, the list AND the counts');
});

still('the backstop re-opens a stream the browser gave up on', () => {
  /* EventSource retries by itself only until it gives up for good. Before this
     the only thing that opened a new one was a visibilitychange — the operator
     putting the phone down and picking it up — which a handset parked on the
     Orders list all afternoon never gets. */
  const live = MHTML.slice(MHTML.indexOf('function mLiveTick()'), MHTML.indexOf('function mLiveRefreshAll'));
  assert.ok(/mLiveConnect\(\)/.test(live),
    'mLiveTick no longer re-opens the stream — a mid-session drop leaves the 60s backstop carrying it alone, forever');
  const gate = live.indexOf('if(!mAutoOK()) return;');
  assert.ok(gate > 0 && gate < live.indexOf('mLiveConnect()'),
    'mLiveConnect() moved above mAutoOK() in the tick — that gate is also what keeps a confined role off /stream');
});

still('a deferred nudge is actually spent, not just remembered', () => {
  /* mLiveNudge\'s own note has always said "the next tick spends it". Nothing
     read `dirty` but mLiveRefreshAll, which only cleared it — so a nudge
     refused mid-typing stayed owed forever while the tick beside it did the
     same work anyway. The tick clears it now, which is what makes that
     sentence true. */
  const live = MHTML.slice(MHTML.indexOf('function mLiveTick()'), MHTML.indexOf('function mLiveRefreshAll'));
  assert.ok(/_mLive\.dirty=false/.test(live),
    'mLiveTick never spends the nudge it deferred — `dirty` is written and never read');
});

console.log(`\nok — ${statics} live-refresh wiring checks.`);
