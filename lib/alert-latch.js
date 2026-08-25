'use strict';

// Restart-surviving latches for the channel daemons' ops alerts.
//
// Every 🔴 alert is latched so it fires once on the transition, not every tick, and
// the matching ✅ fires when the latch clears. The latches used to live in the
// daemon's memory — which meant a restart silently swallowed the recovery message:
// the process came up with every latch false, the channel read clean, and the
// "recovered" branch never ran. The ops group kept a red alert for a channel that
// was already fine, and the only way to know was to go look.
//
// That is what happened to the 18:23 闪购 yuexiu disconnect on 2026-07-25. The
// 18:52 deploy bounced shangou-sync while it was still inside the risk-control
// cool-down, the fresh process had no idea it owed anyone an all-clear, and the
// group never got one. Note the shape of it: the more channel fixes we deploy, the
// more likely a deploy lands mid-incident and eats its resolution.
//
// So latches live on disk now — one small file per key under data/alert-latch/,
// written by whichever daemon owns that key. The in-memory Map stays authoritative
// for the running process (same semantics and cost as the plain object it
// replaces); the file is what a restarted daemon reads to learn it was mid-incident
// and still owes a ✅. A failed write degrades to exactly the old behaviour rather
// than to alert spam.
//
// AND A FAILED READ DEGRADES TOWARDS STILL-LATCHED, which is the half this note
// used to leave out. fs.existsSync() answers false for "no such file" AND for
// "cannot read this directory", so an unreadable data/alert-latch/ made every
// latch read as CLEAR — the restarted daemon concluded it owed nobody an all-clear
// and the ✅ was swallowed. That is precisely the 2026-07-25 闪购 failure this file
// was written to stop, reintroduced through the error path. statSync with
// throwIfNoEntry:false separates the two: undefined is genuinely-absent, a throw
// is cannot-see, and cannot-see is treated as STILL LATCHED so the recovery
// message survives. The cost is narrow and worth naming: if the directory is
// unreadable on a cold start, keys that were never latched read as latched and
// their channels each emit one spurious ✅. Noisy, visible, self-limiting — and
// the opposite mistake is silent.
//
// Usage — a drop-in for the `const fooFlagged = {}` latches:
//   const alerts = latchStore('shangou');
//   if (!alerts['verify:' + storeCode]) { alerts['verify:' + storeCode] = true; ... }
//   if (alerts['proxy_down']) { alerts['proxy_down'] = false; sendOpsAlert('✅ …'); }

const fs   = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'alert-latch');

const safe = (s) => String(s).replace(/[^\w.-]+/g, '_');
const fileFor = (name, key) => path.join(DIR, `${safe(name)}--${safe(key)}.json`);

function latchStore(name) {
  const mem = new Map(); // authoritative for this process; the file is the restart bridge

  const read = (key) => {
    if (mem.has(key)) return mem.get(key);
    let v;
    try {
      // throwIfNoEntry:false => undefined for ENOENT, THROW for a real fault.
      // The normal first-run case (no directory yet) is ENOENT and reads false.
      v = fs.statSync(fileFor(name, key), { throwIfNoEntry: false }) !== undefined;
    } catch (e) {
      // Cannot see. Fail towards STILL LATCHED, never towards clear: a wrong
      // "latched" costs one spurious ✅, a wrong "clear" silently eats a real one.
      console.error(`[alert-latch] ${name}/${key} read failed (${e.message}) — `
        + 'assuming STILL LATCHED so a recovery ✅ cannot be swallowed.');
      v = true;
    }
    mem.set(key, v);
    return v;
  };

  const write = (key, value) => {
    const on = !!value;
    mem.set(key, on);
    const f = fileFor(name, key);
    try {
      if (on) {
        fs.mkdirSync(DIR, { recursive: true });
        fs.writeFileSync(f, JSON.stringify({ latched_at: new Date().toISOString() }));
      } else if (fs.existsSync(f)) {
        fs.unlinkSync(f);
      }
    } catch (e) {
      // In-memory state already updated: we lose only restart-survival, never the
      // once-per-transition guarantee that keeps the group from being flooded.
      console.error(`[alert-latch] ${name}/${key} persist failed:`, e.message);
    }
  };

  return new Proxy({}, {
    get(_t, prop) { return typeof prop === 'string' ? read(prop) : undefined; },
    set(_t, prop, value) { if (typeof prop === 'string') write(prop, value); return true; },
    deleteProperty(_t, prop) { if (typeof prop === 'string') write(prop, false); return true; },
    has(_t, prop) { return typeof prop === 'string' ? read(prop) : false; },
  });
}

// ── Windows: for the alerts that are not transitions ─────────────────────────
//
// A latch answers "is this condition still flagged?" — right for everything the
// daemons page about that has a moment: the channel just went down, the proxy
// just came back. It is the wrong question for an ADVISORY, which has no moment
// at all. "This login expires on Thursday, re-login when convenient" is true all
// week; what it needs is not a flag but a WINDOW — say it at most once every N
// hours, and mean it across restarts.
//
// Guanyi's session-expiry notice was held back by a plain `lastWarnedAt` object
// in process memory, so the window it promised (12 hours) was really "12 hours,
// or until this daemon next starts, whichever comes first". On 2026-08-25 the
// daemon was restarting often enough — the box was simultaneously paging about
// disk >= 85%, which is what takes Chromium down — that the SAME "expires soon,
// at your convenience" advisory reached the ops group roughly every twenty
// minutes for hours. A channel that does that stops being read, including for
// the alerts that mean the push has actually stopped.
//
// FAILS TOWARDS QUIET, and unlike the latches above that is the safe direction
// here. A latch read that fails towards clear SILENTLY EATS a recovery message —
// nothing else will ever say it. A window read that fails towards quiet only
// defers an advisory that will be offered again at the next tick and the next
// window, and whose underlying condition, if it ever becomes real, is announced
// by its own 🔴 alert. Absent is still absent: a first run (ENOENT) is DUE and
// sends, exactly like a latch that has never been set.
const windowFileFor = (name, key) => path.join(DIR, `${safe(name)}--${safe(key)}.window.json`);

// True when `key` has not been sent within `everyMs` — and STAMPS it in the same
// call, so the caller sends exactly when this returns true.
function claimWindow(name, key, everyMs, meta) {
  const f = windowFileFor(name, key);
  let prev = null;
  try {
    // throwIfNoEntry:false => undefined for ENOENT (never sent — due), THROW for
    // a real fault (cannot see — stay quiet).
    if (fs.statSync(f, { throwIfNoEntry: false }) !== undefined) {
      prev = JSON.parse(fs.readFileSync(f, 'utf8'));
    }
  } catch (e) {
    console.error(`[alert-latch] ${name}/${key} window read failed (${e.message}) — `
      + 'holding the advisory back rather than repeating it; the 🔴 alert for this condition is unaffected.');
    return false;
  }
  const now = Date.now();
  if (prev && typeof prev.at === 'number' && now - prev.at < everyMs) return false;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    // temp + rename: a reader never sees half a file, and two daemons writing the
    // same key cannot interleave.
    const tmp = `${f}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(Object.assign({ at: now, sent_at: new Date(now).toISOString() }, meta || {})));
    fs.renameSync(tmp, f);
  } catch (e) {
    // The alert still goes out — we lose only restart-survival for this one
    // window, which is the behaviour that existed before this file. Say so: it
    // is the difference between "sent once" and "sent once per restart".
    console.error(`[alert-latch] ${name}/${key} window persist failed (${e.message}) — `
      + 'this advisory will repeat after a restart.');
  }
  return true;
}

// Forget the window, so the next claim sends immediately. For the edge where the
// condition genuinely cleared (a re-login) and the next notice is news again.
function clearWindow(name, key) {
  const f = windowFileFor(name, key);
  try { if (fs.existsSync(f)) fs.unlinkSync(f); }
  catch (e) { console.error(`[alert-latch] ${name}/${key} window clear failed:`, e.message); }
}

module.exports = { latchStore, claimWindow, clearWindow };
