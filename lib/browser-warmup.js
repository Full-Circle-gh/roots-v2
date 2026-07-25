'use strict';

// Cold-Chrome warm-up guard for the CDP-attached channel bridges (闪购 / 青云).
//
// The 2026-07-25 incident: a column-only `database.js` migration deployed at 18:22
// bounced the browser HOLDER processes along with the daemons (fixed separately in
// scripts/deploy-apply.sh). The damage wasn't the restart itself — it was what
// happened next: the daemon reattached over CDP within seconds and fired a 闪购 data
// API call from a brand-new Chrome. Meituan answered 403 验证中心 one second in,
// 闪购 yuexiu stock sync paused for the 30-minute cool-down, and the ops group got a
// red "needs re-login" alert for a session that was never logged out.
//
// The deploy fix stops ONE cause of a cold browser. It can't stop the others: the
// holder relaunches Chrome by itself on a crash (3s later) and on every proxy
// failover switch (1.5s later), and an operator can always `pm2 restart` it. So the
// daemon needs its own guard, and it must not depend on the holder telling it
// anything.
//
// How we detect a relaunch WITHOUT touching the holder: Chrome's CDP endpoint
// serves /json/version, whose `webSocketDebuggerUrl` carries a GUID minted fresh on
// every launch. We remember the last GUID (on disk, so a daemon restart doesn't
// misread a long-running Chrome as fresh) and the wall-clock time we first saw it.
// A changed GUID = a new Chrome = hold off all channel calls for the warm-up
// window, so the first thing the channel sees from that browser is a human-paced
// request and not an API burst.
//
// A first-ever sighting records the GUID with an UNKNOWN launch time (at: 0) and
// counts as warm — we genuinely don't know when that Chrome started, and pausing a
// healthy channel on a guess is worse than not pausing.

const fs   = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'chrome-warmup');

// 90s: long enough that the channel sees a settled browser (the 18:23 challenge
// landed ~1s after launch), short enough that a crash-relaunch costs at most one
// order-poll cycle. Override with CHROME_WARMUP_MS (0 disables the guard).
const WARMUP_MS = Number(process.env.CHROME_WARMUP_MS ?? 90_000);

// A challenge this soon after a relaunch is the cold browser, not a real flag —
// the daemons word the ops alert differently for it (auto-recovers, no re-login).
const COLD_CHALLENGE_WINDOW_MS = WARMUP_MS + 5 * 60_000;

function keyFor(cdpUrl) {
  try { const u = new URL(cdpUrl); return `${u.hostname}-${u.port || '80'}`; }
  catch (_) { return String(cdpUrl).replace(/[^\w.-]/g, '_'); }
}
function fileFor(cdpUrl) { return path.join(DIR, `${keyFor(cdpUrl)}.json`); }

function readRec(cdpUrl) {
  try { return JSON.parse(fs.readFileSync(fileFor(cdpUrl), 'utf8')); } catch (_) { return null; }
}
function writeRec(cdpUrl, rec) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(fileFor(cdpUrl), JSON.stringify(rec));
  } catch (e) { console.error('[browser-warmup] state write failed:', e.message); }
}

// The launch-unique browser GUID, or null when Chrome isn't answering (the caller's
// own connect/error path already owns "Chrome is down" — we never invent coldness
// from an unreachable endpoint).
async function browserId(cdpUrl, timeoutMs = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${String(cdpUrl).replace(/\/+$/, '')}/json/version`, { signal: ctl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    return j.webSocketDebuggerUrl || j['WebKit-Version'] || null;
  } catch (_) { return null; }
  finally { clearTimeout(t); }
}

// Milliseconds of warm-up left for the Chrome behind `cdpUrl` (0 = go ahead).
// Call it once per daemon cycle: it both detects the relaunch and reports the wait.
async function coldMsRemaining(cdpUrl, warmupMs = WARMUP_MS) {
  if (!warmupMs) return 0;
  const id = await browserId(cdpUrl);
  if (!id) return 0;
  const prev = readRec(cdpUrl);
  if (!prev || !prev.id) { writeRec(cdpUrl, { id, at: 0 }); return 0; }  // first sighting: launch time unknown
  if (prev.id !== id) { writeRec(cdpUrl, { id, at: Date.now() }); return warmupMs; }
  if (!prev.at) return 0;
  return Math.max(0, prev.at + warmupMs - Date.now());
}

// Sync read for the alert path: how long ago this Chrome was last seen to relaunch
// (Infinity when it hasn't relaunched under our watch).
function msSinceRelaunch(cdpUrl) {
  const rec = readRec(cdpUrl);
  return rec && rec.at ? Date.now() - rec.at : Infinity;
}

// True when a risk-control challenge right now is explainable by a recent relaunch.
function isColdStartChallenge(cdpUrl) {
  return msSinceRelaunch(cdpUrl) < COLD_CHALLENGE_WINDOW_MS;
}

module.exports = { coldMsRemaining, msSinceRelaunch, isColdStartChallenge, WARMUP_MS, COLD_CHALLENGE_WINDOW_MS };
