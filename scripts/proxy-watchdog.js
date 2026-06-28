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

function describe(channel, ev) {
  const parts = ev.candidates.map(c => `${pm.LABEL_CN[c.label] || c.label}${ev.health[c.label] ? '✓' : '✗'}`);
  return parts.join(' · ');
}

async function tick() {
  const stateOut = pm.readState();
  for (const channel of pm.CHANNELS) {
    let ev;
    try { ev = await pm.evaluate(channel); }
    catch (e) { console.error(`[proxy-watchdog] evaluate ${channel} failed:`, e.message); continue; }

    const cn = pm.CHANNEL_CN[channel] || channel;
    const activeUrl = ev.active.url;
    const activeLbl = ev.active.label;

    // 1) Per-candidate up/down transitions → one alert per flip.
    const prevHealth = lastHealth[channel] || {};
    for (const c of ev.candidates) {
      const now = ev.health[c.label];
      const before = prevHealth[c.label];
      if (before !== undefined && before !== now) {
        const name = pm.LABEL_CN[c.label] || c.label;
        if (now) {
          await pm.sendProxyAlert(`🟢 ${cn}：${name} 恢复可用\n${cn}: ${c.label} proxy back UP`);
        } else {
          await pm.sendProxyAlert(`🟠 ${cn}：${name} 不可达\n${cn}: ${c.label} proxy DOWN (can't reach Meituan)`);
        }
      }
    }
    lastHealth[channel] = ev.health;

    // 2) Active-path change → failover / failback alert + persist for launchers.
    const prevActive = lastActive[channel];
    const changed = prevActive === undefined ? false : prevActive !== activeUrl;
    if (firstRun) {
      await pm.sendProxyAlert(`ℹ️ ${cn}：当前走 ${pm.LABEL_CN[activeLbl] || activeLbl}\n${cn} active proxy: ${activeLbl}\n${describe(channel, ev)}`);
    } else if (changed) {
      const toName = pm.LABEL_CN[activeLbl] || activeLbl;
      await pm.sendProxyAlert(`🔀 ${cn}：切换到 ${toName}\n${cn} FAILOVER → ${activeLbl}\n${describe(channel, ev)}`);
    }
    lastActive[channel] = activeUrl;

    stateOut[channel] = { url: activeUrl, label: activeLbl, ts: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19) };
  }
  pm.writeState(stateOut);
  firstRun = false;
}

async function main() {
  console.log(`[proxy-watchdog] starting — channels: ${pm.CHANNELS.join(', ')}, check every ${CHECK_MS / 1000}s`);
  console.log(`[proxy-watchdog] residential=${pm.residentialUrl() || '(unset)'} gz=${pm.gzUrl() ? 'set' : '(unset)'} webhook=${pm.envVal('PROXY_WATCHDOG_WEBHOOK') ? 'set' : 'MISSING'}`);
  for (;;) {
    try { await tick(); } catch (e) { console.error('[proxy-watchdog] tick error:', e.message); }
    await new Promise(r => setTimeout(r, CHECK_MS));
  }
}

main().catch(err => { console.error('[proxy-watchdog] fatal:', err); process.exit(1); });
