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

module.exports = { latchStore };
