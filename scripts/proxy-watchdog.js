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

// Hysteresis: a candidate is only treated as DOWN after FAIL_THRESHOLD
// consecutive failed probes (and UP again on the first success). Without this a
// single transient blip on the WireGuard tunnel would flap the active proxy —
// thrashing browser relaunches and spamming the bot. ~2 × CHECK_MS of sustained
// failure before a failover.
const FAIL_THRESHOLD = Number(process.env.PROXY_FAIL_THRESHOLD || 2);
const failCount = {}; // `${channel}:${label}` -> consecutive failed probes

// Everything this process decides used to go to the WeCom bot and NOWHERE else,
// so `pm2 logs proxy-watchdog` was empty — and sendProxyAlert returns false and
// says nothing when PROXY_WATCHDOG_WEBHOOK is unset or the send fails, which the
// startup line already admits is possible ("webhook=MISSING"). The process that
// decides which exit every Meituan channel uses kept no local record of having
// decided anything. Every alert is now mirrored to stdout, where pm2 keeps it.
function say(msg) { console.log(`[proxy-watchdog] ${new Date().toISOString()} ${msg}`); }
async function announce(text, line) { say(line); await pm.sendProxyAlert(text); }

// …and a periodic line even when nothing changes, so the log distinguishes "no
// failovers" from "this loop stopped running hours ago". Bounded: once per
// window per channel, not once per tick.
const LOG_EVERY_MS = Number(process.env.PROXY_WATCHDOG_LOG_MS || 1_800_000); // 30 min
const lastLogged = {}; // channel -> epoch ms

async function tick() {
  const stateOut = pm.readState();
  for (const channel of pm.CHANNELS) {
    const cands = pm.candidates(channel);
    const cn = pm.CHANNEL_CN[channel] || channel;

    // Probe every candidate; debounce into a usable/unusable verdict.
    const avail = {};
    for (const c of cands) {
      let ok;
      try { ok = await pm.probe(c.url); } catch (_) { ok = false; }
      const key = `${channel}:${c.label}`;
      failCount[key] = ok ? 0 : (failCount[key] || 0) + 1;
      // 'direct' is the last resort and always usable; proxies need < threshold fails.
      avail[c.label] = c.label === 'direct' ? true : (failCount[key] < FAIL_THRESHOLD);
    }

    // Active = first usable candidate in priority order (direct always backstops).
    const active = cands.find(c => avail[c.label]) || cands[cands.length - 1];
    const desc = cands.map(c => `${pm.LABEL_CN[c.label] || c.label}${avail[c.label] ? '✓' : '✗'}`).join(' · ');

    // 1) Per-candidate up/down transitions → one alert per flip.
    const prevHealth = lastHealth[channel] || {};
    for (const c of cands) {
      const now = avail[c.label], before = prevHealth[c.label];
      if (before !== undefined && before !== now) {
        const name = pm.LABEL_CN[c.label] || c.label;
        await announce(now
          ? `🟢 ${cn}：${name} 恢复可用\n${cn}: ${c.label} proxy back UP`
          : `🟠 ${cn}：${name} 不可达\n${cn}: ${c.label} proxy DOWN (can't reach Meituan)`,
          `${channel}: ${c.label} ${now ? 'back UP' : "DOWN (can't reach Meituan)"}`);
      }
    }
    lastHealth[channel] = avail;

    // 2) Active-path change → failover/failback alert + persist for the launchers.
    const prevActive = lastActive[channel];
    const toName = pm.LABEL_CN[active.label] || active.label;
    if (firstRun) {
      await announce(`ℹ️ ${cn}：当前走 ${toName}\n${cn} active proxy: ${active.label}\n${desc}`,
        `${channel}: active=${active.label} — ${desc}`);
      lastLogged[channel] = Date.now();
    } else if (prevActive !== undefined && prevActive !== active.url) {
      await announce(`🔀 ${cn}：切换到 ${toName}\n${cn} FAILOVER → ${active.label}\n${desc}`,
        `${channel}: FAILOVER ${prevActive || 'direct'} → ${active.label} — ${desc}`);
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
