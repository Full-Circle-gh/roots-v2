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

// Hysteresis, applied SYMMETRICALLY. A healthy candidate only goes DOWN after
// FAIL_THRESHOLD consecutive failed probes, and a down one only comes back UP
// after UP_THRESHOLD consecutive successes.
//
// The recovery side is the one that matters for noise: the residential SOCKS5
// exit "flaps for seconds at a time" (see scripts/shangou-daemon.js), and while
// recovery was instant-on-first-success a lossy WireGuard tunnel cycled
// DOWN → FAILOVER → UP → FAILBACK every couple of minutes. That is four bot
// messages per channel per cycle — the 06:17 alert storm — and, far worse, a
// Chrome relaunch on each switch (scripts/shangou-chrome.js), which kills
// in-flight syncs. Requiring a sustained recovery makes a flapping path settle
// on its fallback instead of oscillating.
const FAIL_THRESHOLD = Number(process.env.PROXY_FAIL_THRESHOLD || 2);
const UP_THRESHOLD   = Number(process.env.PROXY_RECOVER_THRESHOLD || 3);
const failCount = {}; // `${channel}:${label}` -> consecutive failed probes
const okCount   = {}; // `${channel}:${label}` -> consecutive successful probes

async function tick() {
  const stateOut = pm.readState();
  // Both channels list the residential exit, so probe each distinct URL once per
  // tick rather than once per channel — a tick was serialising five 10s-timeout
  // probes into a 30s check interval.
  const probed = new Map();
  const probeOnce = async (url) => {
    if (!probed.has(url)) {
      let ok;
      try { ok = await pm.probe(url); } catch (_) { ok = false; }
      probed.set(url, ok);
    }
    return probed.get(url);
  };

  for (const channel of pm.CHANNELS) {
    const cands = pm.candidates(channel);
    const cn = pm.CHANNEL_CN[channel] || channel;

    // Probe every candidate; debounce into a usable/unusable verdict.
    const prevAvail = lastHealth[channel] || {};
    const avail = {};
    for (const c of cands) {
      const ok = await probeOnce(c.url);
      const key = `${channel}:${c.label}`;
      failCount[key] = ok ? 0 : (failCount[key] || 0) + 1;
      okCount[key]   = ok ? (okCount[key] || 0) + 1 : 0;
      const before = prevAvail[c.label];
      // First sighting: trust the probe, so a cold start doesn't spend
      // UP_THRESHOLD ticks pretending a healthy proxy is down.
      if (before === undefined)  avail[c.label] = ok;
      else if (before)           avail[c.label] = failCount[key] < FAIL_THRESHOLD;
      else                       avail[c.label] = okCount[key] >= UP_THRESHOLD;
    }

    // Active = first usable candidate in priority order. 'direct' is the
    // guaranteed backstop: we report its REAL probe result (it used to be
    // hardcoded ✓, so the bot showed 直连(香港)✓ for a path nobody had checked)
    // but still fall back to it when every candidate is down, because a dead
    // last resort is better than no route at all.
    const active = cands.find(c => avail[c.label]) || cands[cands.length - 1];
    const desc = cands.map(c => `${pm.LABEL_CN[c.label] || c.label}${avail[c.label] ? '✓' : '✗'}`).join(' · ');

    // 1) Per-candidate up/down transitions → one alert per flip.
    for (const c of cands) {
      const now = avail[c.label], before = prevAvail[c.label];
      if (before !== undefined && before !== now) {
        const name = pm.LABEL_CN[c.label] || c.label;
        await pm.sendProxyAlert(now
          ? `🟢 ${cn}：${name} 恢复可用\n${cn}: ${c.label} proxy back UP`
          : `🟠 ${cn}：${name} 不可达\n${cn}: ${c.label} proxy DOWN (can't reach Meituan)`);
      }
    }
    lastHealth[channel] = avail;

    // 2) Active-path change → failover/failback alert + persist for the launchers.
    const prevActive = lastActive[channel];
    const toName = pm.LABEL_CN[active.label] || active.label;
    if (firstRun) {
      await pm.sendProxyAlert(`ℹ️ ${cn}：当前走 ${toName}\n${cn} active proxy: ${active.label}\n${desc}`);
    } else if (prevActive !== undefined && prevActive !== active.url) {
      await pm.sendProxyAlert(`🔀 ${cn}：切换到 ${toName}\n${cn} FAILOVER → ${active.label}\n${desc}`);
    }
    lastActive[channel] = active.url;

    stateOut[channel] = { url: active.url, label: active.label, ts: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19) };
  }
  pm.writeState(stateOut);
  firstRun = false;
}

async function main() {
  console.log(`[proxy-watchdog] starting — channels: ${pm.CHANNELS.join(', ')}, check every ${CHECK_MS / 1000}s, down after ${FAIL_THRESHOLD} fails / up after ${UP_THRESHOLD} successes`);
  console.log(`[proxy-watchdog] residential=${pm.residentialUrl() || '(unset)'} gz=${pm.gzUrl() ? 'set' : '(unset)'} webhook=${pm.envVal('PROXY_WATCHDOG_WEBHOOK') ? 'set' : 'MISSING'}`);
  for (;;) {
    try { await tick(); } catch (e) { console.error('[proxy-watchdog] tick error:', e.message); }
    await new Promise(r => setTimeout(r, CHECK_MS));
  }
}

main().catch(err => { console.error('[proxy-watchdog] fatal:', err); process.exit(1); });
