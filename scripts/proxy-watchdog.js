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
const lastSwitchAt = {};          // channel -> epochMs of the last path change
let firstRun = true;

// Hysteresis. Going DOWN needs FAIL_THRESHOLD consecutive failures; coming back
// UP used to need a single success, and that asymmetry is what let a marginal
// WireGuard tunnel oscillate for hours (2026-08-08: 天河 ping-ponged
// residential↔gz↔direct every couple of minutes, and every switch relaunches the
// browser on a different exit IP — which is what cost the Meituan session its
// 门店 binding).
//
// The two directions are not the same decision and no longer share a threshold:
//   • leaving a path that is DOWN is forced — the current one doesn't work;
//   • returning to a higher-priority path is ELECTIVE — the current one is fine,
//     so it has to be worth the cost of moving a live session's IP.
// So a failback additionally needs sustained health (RECOVER_THRESHOLD clean
// probes in a row) and a minimum dwell on the current path.
const FAIL_THRESHOLD    = Number(process.env.PROXY_FAIL_THRESHOLD || 2);
const RECOVER_THRESHOLD = Number(process.env.PROXY_RECOVER_THRESHOLD || 4);
const MIN_DWELL_MS      = Number(process.env.PROXY_MIN_DWELL_MIN || 15) * 60_000;
const failCount = {}; // `${channel}:${label}` -> consecutive failed probes
const okCount   = {}; // `${channel}:${label}` -> consecutive clean probes

// Flap damper. Hysteresis narrows the window for oscillation but can't close it:
// a path that is genuinely up and down all day will still switch on schedule. If
// a channel switches more than FLAP_MAX times in FLAP_WINDOW, stop electing new
// paths for FLAP_FREEZE and say so — a stable mediocre exit beats a rotating
// good one, because a session that keeps changing IP is guaranteed to break.
// A link that is flapping at 09:00 is usually still flapping at 13:00, so each
// re-freeze doubles (capped), the way the daemons' verify cool-down escalates.
// Without that, every freeze expiry pays the full re-detection cost — several
// more session-breaking switches — just to rediscover what we already knew.
// Strikes decay after a genuinely quiet spell.
const FLAP_WINDOW_MS     = Number(process.env.PROXY_FLAP_WINDOW_MIN || 60) * 60_000;
const FLAP_MAX           = Number(process.env.PROXY_FLAP_MAX || 4);
const FLAP_FREEZE_MS     = Number(process.env.PROXY_FLAP_FREEZE_MIN || 120) * 60_000;
const FLAP_FREEZE_MAX_MS = Number(process.env.PROXY_FLAP_FREEZE_MAX_MIN || 1440) * 60_000;
const FLAP_CALM_MS       = Number(process.env.PROXY_FLAP_CALM_MIN || 360) * 60_000;
const switchLog    = {}; // channel -> [epochMs, …] within the window
const frozen       = {}; // channel -> { until: epochMs, url, label } | undefined
const flapStrikes  = {}; // channel -> consecutive freezes (escalation counter)

function freezeMsFor(channel) {
  const n = flapStrikes[channel] || 0;
  return Math.min(FLAP_FREEZE_MS * 2 ** Math.max(0, n - 1), FLAP_FREEZE_MAX_MS);
}

async function tick() {
  const stateOut = pm.readState();
  for (const channel of pm.CHANNELS) {
    const cands = pm.candidates(channel);
    const cn = pm.CHANNEL_CN[channel] || channel;

    // Probe every candidate; debounce into a usable/unusable verdict.
    const now = Date.now();
    const avail = {};
    for (const c of cands) {
      let ok;
      try { ok = await pm.probe(c.url); } catch (_) { ok = false; }
      const key = `${channel}:${c.label}`;
      failCount[key] = ok ? 0 : (failCount[key] || 0) + 1;
      okCount[key]   = ok ? (okCount[key] || 0) + 1 : 0;
      // 'direct' is the last resort and always usable; proxies need < threshold fails.
      avail[c.label] = c.label === 'direct' ? true : (failCount[key] < FAIL_THRESHOLD);
    }

    // Elect the path. Staying put is the default — every switch costs a live
    // session its exit IP, so a move has to earn itself.
    const curUrl = lastActive[channel];
    const curIdx = cands.findIndex(c => c.url === curUrl);
    let active;
    if (curIdx < 0 || !avail[cands[curIdx].label]) {
      // Forced: no current path, or the current one is down. Take the best usable.
      active = cands.find(c => avail[c.label]) || cands[cands.length - 1];
    } else {
      // The current path works. Only a HIGHER-priority path can displace it, and
      // only once it has proven itself and we haven't just moved.
      const dwellOk = now - (lastSwitchAt[channel] || 0) >= MIN_DWELL_MS;
      const better = cands.slice(0, curIdx).find(c =>
        avail[c.label] && (okCount[`${channel}:${c.label}`] || 0) >= RECOVER_THRESHOLD);
      active = (better && dwellOk) ? better : cands[curIdx];
    }

    // Frozen after a flap: hold the path we're on. The one exception is the path
    // going hard down — being stuck on a dead exit is worse than the flapping we
    // were trying to stop.
    const fz = frozen[channel];
    if (fz && now < fz.until) {
      const held = cands.find(c => c.url === fz.url);
      if (held && avail[held.label]) {
        active = held;
      } else {
        // The path we froze on has died. Move — a dead exit is worse than the
        // flapping we were damping — but re-pin the freeze to where we land, so
        // the freeze keeps meaning "stop electing" instead of decaying into a
        // bounce between the frozen path and its replacement.
        fz.url = active.url; fz.label = active.label;
      }
    } else if (fz) {
      frozen[channel] = undefined;
      await pm.sendProxyAlert(`🟢 ${cn}：线路冻结已解除，恢复自动选路\n${cn}: flap freeze lifted — automatic path selection resumed`);
    }
    // Forgive the escalation only after a real calm spell, so a link that
    // behaves for one freeze window doesn't reset itself back to a 2h hold.
    if (flapStrikes[channel] && now - (lastSwitchAt[channel] || 0) >= FLAP_CALM_MS) {
      flapStrikes[channel] = 0;
    }

    const desc = cands.map(c => `${pm.LABEL_CN[c.label] || c.label}${avail[c.label] ? '✓' : '✗'}`).join(' · ');

    // 1) Per-candidate up/down transitions → one alert per flip.
    const prevHealth = lastHealth[channel] || {};
    for (const c of cands) {
      const now = avail[c.label], before = prevHealth[c.label];
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

    // Record the switch and check for flapping. Each entry here is one browser
    // relaunch on a new exit IP, so this counter is a direct measure of how much
    // churn the channel's live sessions are being put through.
    if (prevActive !== undefined && prevActive !== active.url) {
      lastSwitchAt[channel] = now;
      const recent = (switchLog[channel] || []).filter(t => now - t < FLAP_WINDOW_MS);
      recent.push(now);
      switchLog[channel] = recent;
      if (recent.length >= FLAP_MAX && !frozen[channel]) {
        flapStrikes[channel] = (flapStrikes[channel] || 0) + 1;
        const holdMs = freezeMsFor(channel);
        frozen[channel] = { until: now + holdMs, url: active.url, label: active.label };
        const mins = Math.round(holdMs / 60000);
        await pm.sendProxyAlert(
          `🟠 ${cn}：线路来回切换 ${recent.length} 次/${Math.round(FLAP_WINDOW_MS / 60000)}分钟，已冻结在 ${toName} ${mins} 分钟（第 ${flapStrikes[channel]} 次）。\n`
          + `每次切换都会让渠道会话换出口 IP，美团会因此掉门店绑定 —— 请检查 ${pm.LABEL_CN.residential} 的 WireGuard 链路。\n`
          + `${cn}: path flapped ${recent.length}× in ${Math.round(FLAP_WINDOW_MS / 60000)} min — frozen on ${active.label} for ${mins} min (strike ${flapStrikes[channel]}). `
          + `Every switch moves a live session to a new exit IP, which is what makes Meituan drop its store binding. Check the residential WireGuard link.`);
      }
    }
    lastActive[channel] = active.url;

    stateOut[channel] = { url: active.url, label: active.label, ts: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19) };
  }
  pm.writeState(stateOut);
  firstRun = false;
}

async function main() {
  // Adopt the persisted choice as "current" before the first tick. Without this a
  // restart starts from no current path, takes the forced branch, and re-elects
  // the highest-priority candidate on a single clean probe — turning every
  // watchdog bounce into exactly the failback the hysteresis exists to prevent.
  const persisted = pm.readState();
  for (const channel of pm.CHANNELS) {
    const e = persisted && persisted[channel];
    if (e && typeof e.url === 'string') {
      lastActive[channel] = e.url;
      console.log(`[proxy-watchdog] ${channel}: adopting persisted path ${e.label || pm.redactProxy(e.url)}`);
    }
  }
  console.log(`[proxy-watchdog] starting — channels: ${pm.CHANNELS.join(', ')}, check every ${CHECK_MS / 1000}s`);
  console.log(`[proxy-watchdog] residential=${pm.residentialUrl() || '(unset)'} gz=${pm.gzUrl() ? 'set' : '(unset)'} webhook=${pm.envVal('PROXY_WATCHDOG_WEBHOOK') ? 'set' : 'MISSING'}`);
  for (;;) {
    try { await tick(); } catch (e) { console.error('[proxy-watchdog] tick error:', e.message); }
    await new Promise(r => setTimeout(r, CHECK_MS));
  }
}

main().catch(err => { console.error('[proxy-watchdog] fatal:', err); process.exit(1); });
