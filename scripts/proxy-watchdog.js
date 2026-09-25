#!/usr/bin/env node
'use strict';

// Proxy failover watchdog — see lib/proxy-manager.js for the model.
//
// Every CHECK_MS it health-probes each Meituan channel's ordered proxy list,
// writes the winning choice to data/proxy-active.json (the meituan + shangou
// launchers read it and relaunch their browser when it changes), and pages the
// DEDICATED WeCom proxy bot (PROXY_WATCHDOG_WEBHOOK) on EVERY state change:
//   • a proxy path going DOWN or recovering UP (per channel, per candidate)
//   • a channel FAILING OVER to a different proxy (and failing back)
// First run announces the initial active path per channel so the operator can see
// the baseline in the bot group.
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
    const cn = pm.CHANNEL_CN[channel] || channel;

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
    // The same list for the English half. It used to print `desc` — the CHINESE
    // labels — inside an English sentence, so the English reader got the raw key
    // in one place and Chinese in the other, and neither said what a path is.
    const descEn = cands.map(c => `${pm.LABEL_EN[c.label] || c.label}${avail[c.label] ? ' ✓' : ' ✗'}`).join(' · ');

    // 1) Per-candidate up/down transitions → one alert per flip.
    const prevHealth = lastHealth[channel] || {};
    for (const c of cands) {
      const now = avail[c.label], before = prevHealth[c.label];
      if (before !== undefined && before !== now) {
        const name = pm.LABEL_CN[c.label] || c.label;
        const nameEn = pm.LABEL_EN[c.label] || c.label;
        await announce(now
          ? `🟢 ${cn}：${name} 恢复可用\n${cn}: ${nameEn} can reach Meituan again. Nothing to do.`
          : `🟠 ${cn}：${name} 不可达\n${cn}: ${nameEn} cannot reach Meituan. Another route is being used instead — nothing to do.`,
          `${channel}: ${c.label} ${now ? 'back UP' : "DOWN (can't reach Meituan)"}`, quiet);
      }
    }
    lastHealth[channel] = avail;

    // 2) Active-path change → failover/failback alert + persist for the launchers.
    const prevActive = lastActive[channel];
    const toName = pm.LABEL_CN[active.label] || active.label;
    const toNameEn = pm.LABEL_EN[active.label] || active.label;
    if (firstRun) {
      // A cold start used to page the bot with this baseline EVERY time, and this
      // process restarts on every deploy that ships anything under lib/ (see
      // bounce_daemon in scripts/deploy-apply.sh — it fires on SHARED_TOUCHED, and
      // nearly every ship touches lib/). Eight deploys on 2026-08-23 meant sixteen
      // bot messages, all of them saying nothing is wrong; that is how a channel
      // the operator is supposed to read gets tuned out.
      // So the baseline now always goes to the pm2 log, and pages the group only
      // when the process comes up ALREADY degraded — some path failed its probe, or
      // we are not on the top-priority candidate. Read `probed`, not `avail`: see
      // above, the debounce makes every candidate look healthy on tick one.
      const rawDesc = cands.map(c => `${pm.LABEL_CN[c.label] || c.label}${probed[c.label] ? '✓' : '✗'}`).join(' · ');
      const rawDescEn = cands.map(c => `${pm.LABEL_EN[c.label] || c.label}${probed[c.label] ? ' ✓' : ' ✗'}`).join(' · ');
      const line = `${channel}: active=${active.label} — ${rawDesc}`;
      if (cands.some(c => !probed[c.label]) || active.label !== cands[0].label) {
        await announce(`⚠️ ${cn}：启动时已降级，当前走 ${toName}\n${cn} started up on a backup route, not the usual one. It is now using ${toNameEn}. Selling carries on; tell whoever looks after the box.\n${rawDescEn}`, line, quiet);
      } else {
        say(line);   // all green on boot — the log remembers it, the group does not need to
      }
      lastLogged[channel] = Date.now();
    } else if (prevActive !== undefined && prevActive !== active.url) {
      await announce(`🔀 ${cn}：切换到 ${toName}\n${cn} switched itself to ${toNameEn} because the one before it stopped working. Selling carries on — nothing to do.\n${descEn}`,
        `${channel}: FAILOVER ${prevActive || 'direct'} → ${active.label} — ${desc}`, quiet);
      lastLogged[channel] = Date.now();
    } else if (Date.now() - (lastLogged[channel] || 0) >= LOG_EVERY_MS) {
      // Quiet-period heartbeat — no alert, just proof the loop is still deciding.
      say(`${channel}: active=${active.label} — ${desc}`);
      lastLogged[channel] = Date.now();
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

main().catch(err => { console.error('[proxy-watchdog] fatal:', err); process.exit(1); });
