#!/usr/bin/env node
'use strict';

// Proxy failover watchdog — see lib/proxy-manager.js for the model.
//
// Every CHECK_MS it health-probes each Meituan channel's ordered proxy list,
// writes the winning choice to data/proxy-active.json (the meituan + shangou
// launchers read it and relaunch their browser when it changes), and logs every
// state change to pm2:
//   • a proxy path going DOWN or recovering UP (per channel, per candidate)
//   • a channel FAILING OVER to a different proxy (and failing back)
//   • the baseline on start
// It pages the DEDICATED WeCom proxy bot (PROXY_WATCHDOG_WEBHOOK) only when a
// person is needed — see pm.nextPage (§263). It used to page every change above,
// each one ending "nothing to do".
//
// Start:  pm2 start scripts/proxy-watchdog.js --name proxy-watchdog
// Logs:   pm2 logs proxy-watchdog

const path = require('path');
const fs   = require('fs');

// Load .env so PROXY_WATCHDOG_WEBHOOK / GUANYI_PROXY_URL / PROXY_RESIDENTIAL are
// present even when pm2 didn't inject them (mirrors the channel daemons).
const envFile = path.join(__dirname, '../.env');
try { require('dotenv').config({ path: envFile }); }
catch {
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

const pm = require('../lib/proxy-manager');

const CHECK_MS = Number(process.env.PROXY_WATCHDOG_CHECK_MS || 30_000);

// In-memory last-known state for transition detection.
const lastActive = {};            // channel -> url ('' direct), '' is valid so use a sentinel
const lastHealth = {};            // channel -> { label: bool }
let firstRun = true;
const pageState = {};             // channel -> pm.nextPage state { since, paged }

// Hysteresis, both ways (pm.nextPathHealth, §262): a candidate is DOWN after
// PROXY_FAIL_THRESHOLD failed probes in a row (default 2, ~1 min), and once down
// is UP again only after PROXY_UP_THRESHOLD good probes in a row (default 4,
// ~2 min). It used to come back on the first good probe, so a marginal tunnel
// rang back and forth — each ring a failover page, a failback page and two
// browser relaunches.
const pathHealth = {}; // `${channel}:${label}` -> { fails, oks, down }

// Everything this process decides used to go to the WeCom bot and NOWHERE else,
// so `pm2 logs proxy-watchdog` was empty — and sendProxyAlert returns false and
// says nothing when PROXY_WATCHDOG_WEBHOOK is unset or the send fails, which the
// startup line already admits is possible ("webhook=MISSING"). The process that
// decides which exit every Meituan channel uses kept no local record of having
// decided anything. Every alert is now mirrored to stdout, where pm2 keeps it.
function say(msg) { console.log(`[proxy-watchdog] ${new Date().toISOString()} ${msg}`); }
async function announce(text, line, quiet = false) {
  say(quiet ? `${line} (location closed — not paged)` : line);
  if (!quiet) await pm.sendProxyAlert(text);
}

// …and a periodic line even when nothing changes, so the log distinguishes "no
// failovers" from "this loop stopped running hours ago". Bounded: once per
// window per channel, not once per tick.
const LOG_EVERY_MS = Number(process.env.PROXY_WATCHDOG_LOG_MS || 1_800_000); // 30 min
const lastLogged = {}; // channel -> epoch ms

// A closed location pages nobody (§217, and pm.routeTrading for why). 越秀 was
// closed until further notice and this loop kept paging the group about its
// broadband: every blink of the shop's own internet was a 🔀 "switched… nothing
// to do" about a shop that is not selling.
// The route is still probed and still failed over — only the page is dropped.
// Stopping the probes instead would pin 闪购's Chrome to whatever route it was on
// when the shop closed; if that route died, shangou-daemon's own gate would page
// 代理掉线, and the reopen would start from a dead exit. Every decision still
// goes to the pm2 log through say().
// The DB is opened lazily and only for this question; if it cannot be opened,
// routeTrading answers "trading" and the route pages as before.
let _db;
function getDb() {
  if (_db === undefined) {
    try { _db = require('../database'); }
    catch (e) { _db = null; say(`database unavailable (${e.message}) — every route pages`); }
  }
  return _db;
}
const closedNow = {}; // channel -> true while its location is closed

async function tick() {
  const stateOut = pm.readState();
  for (const channel of pm.CHANNELS) {
    const cands = pm.candidates(channel);

    const quiet = !pm.routeTrading(getDb(), channel);
    if (quiet !== !!closedNow[channel]) {
      say(quiet ? `${channel}: location closed — route still kept working, nothing paged until it reopens`
                : `${channel}: location reopened — route changes page the group again`);
      closedNow[channel] = quiet;
    }

    // Probe every candidate; debounce into a usable/unusable verdict.
    const avail = {};
    // Raw, undebounced probe results. `avail` is what the failover DECIDES on and
    // must stay debounced, but on a cold start pathHealth is empty, so every
    // candidate reads usable no matter what curl said — the first tick literally
    // cannot express "this path is down". The cold-start report below needs the
    // truth, so keep both.
    const probed = {};
    for (const c of cands) {
      let ok;
      try { ok = await pm.probe(c.url); } catch (_) { ok = false; }
      probed[c.label] = ok;
      const key = `${channel}:${c.label}`;
      pathHealth[key] = pm.nextPathHealth(pathHealth[key], ok);
      // 'direct' is the last resort and always usable.
      avail[c.label] = c.label === 'direct' ? true : !pathHealth[key].down;
    }

    // Active = first usable candidate in priority order (direct always backstops).
    const active = cands.find(c => avail[c.label]) || cands[cands.length - 1];
    const desc = cands.map(c => `${pm.LABEL_CN[c.label] || c.label}${avail[c.label] ? '✓' : '✗'}`).join(' · ');

    // 1) Per-candidate up/down transitions → the log (§263: no longer paged).
    const prevHealth = lastHealth[channel] || {};
    for (const c of cands) {
      const now = avail[c.label], before = prevHealth[c.label];
      if (before !== undefined && before !== now) {
        say(`${channel}: ${c.label} ${now ? 'back UP' : "DOWN (can't reach Meituan)"}`);
      }
    }
    lastHealth[channel] = avail;

    // 2) Active-path change → the log (§263: no longer paged).
    const prevActive = lastActive[channel];
    if (firstRun) {
      // The baseline goes to the log only. It used to page the group on every
      // cold start, and this process restarts on nearly every deploy (see
      // bounce_daemon in scripts/deploy-apply.sh) — sixteen "nothing is wrong"
      // messages on 2026-08-23 alone. Coming up ALREADY degraded paged too, until
      // §263: a degraded channel now pages through nextPage below, on the same
      // half-hour rule as any other. Read `probed`, not `avail`: the debounce makes
      // every candidate look healthy on tick one.
      const rawDesc = cands.map(c => `${pm.LABEL_CN[c.label] || c.label}${probed[c.label] ? '✓' : '✗'}`).join(' · ');
      say(`${channel}: active=${active.label} — ${rawDesc}`);
      lastLogged[channel] = Date.now();
    } else if (prevActive !== undefined && prevActive !== active.url) {
      // By label, not URL: the GZ relay's URL carries its password.
      const from = (cands.find(c => c.url === prevActive) || {}).label || 'unknown';
      say(`${channel}: FAILOVER ${from} → ${active.label} — ${desc}`);
      lastLogged[channel] = Date.now();
    } else if (Date.now() - (lastLogged[channel] || 0) >= LOG_EVERY_MS) {
      // Quiet-period heartbeat — no alert, just proof the loop is still deciding.
      say(`${channel}: active=${active.label} — ${desc}`);
      lastLogged[channel] = Date.now();
    }

    // 3) Page only when a person is needed (pm.nextPage, §263): off the first
    // choice for half an hour, on the Hong Kong line, or back after either.
    const onFirst = active.label === cands[0].label;
    const onDirect = !onFirst && active.label === 'direct';
    const { state, page } = pm.nextPage(pageState[channel], { onFirst, onDirect });
    pageState[channel] = state;
    if (page) {
      const down = cands.filter(c => c.label !== 'direct' && !avail[c.label]).map(c => c.label);
      await announce(pm.pageText(page, channel, { cands, active, down }),
        `${channel}: PAGE ${page} — active=${active.label} — ${desc}`, quiet);
    }
    lastActive[channel] = active.url;

    // `at` (epoch ms) is stamped by writeState — it is what readers date the
    // entry by, so a watchdog that stops writing stops being obeyed.
    stateOut[channel] = { url: active.url, label: active.label, ts: pm.shStamp() };
  }
  pm.writeState(stateOut);
  firstRun = false;
}

async function main() {
  console.log(`[proxy-watchdog] starting — channels: ${pm.CHANNELS.join(', ')}, check every ${CHECK_MS / 1000}s`);
  console.log(`[proxy-watchdog] residential=${pm.residentialUrl() || '(unset)'} gz=${pm.gzUrl() ? 'set' : '(unset)'} webhook=${pm.envVal('PROXY_WATCHDOG_WEBHOOK') ? 'set' : 'MISSING'}`);
  for (;;) {
    try { await tick(); } catch (e) { console.error('[proxy-watchdog] tick error:', e.message); }
    // A tick that throws writes no state, so the entry ages — which is now the
    // signal a reader acts on (lib/proxy-manager STATE_TTL_MS). Nothing to do
    // here but keep looping; the daemons re-elect around a watchdog that has
    // stopped producing decisions.
    await new Promise(r => setTimeout(r, CHECK_MS));
  }
}

// scripts/test_proxy_failover.js loads this file with PROXY_WATCHDOG_NO_LOOP=1 to
// drive single ticks, so the paging rules are tested on the real loop. Keyed on a
// flag the test sets, NOT on require.main: pm2 loads scripts through its own
// container, and a check that read "not main" there would start nothing, silently.
if (process.env.PROXY_WATCHDOG_NO_LOOP === '1') {
  module.exports = { tick };
} else {
  main().catch(err => { console.error('[proxy-watchdog] fatal:', err); process.exit(1); });
}
