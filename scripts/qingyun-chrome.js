// Long-lived genuine Chrome for the qingyun-daemon to attach to over CDP.
//
// Same rationale as scripts/shangou-chrome.js: the 青云聚信 (saas.cyanclouds.com) data
// APIs reject Playwright's automation fingerprint, so we spawn the Chromium BINARY
// directly (no --enable-automation) — navigator.webdriver stays false — and the
// qingyun-daemon connectOverCDP to it. Route through a Guangzhou proxy so Meituan sees
// the store's region (the delivery store is in GZ), not the box's Hong Kong IP.
//
// On the box: run under Xvfb (DISPLAY set) so it's headful.
//   pm2 start scripts/qingyun-chrome.js --name qingyun-chrome
// Then log in ONCE via the QR scan (青云App → 订单 → "…" → 扫码登录电脑端) and leave the
// order page open on a view listing in-flight orders (待取货/配送中) so the daemon can
// harvest the order/list request body. Re-login = same QR scan.
// Env:
//   QINGYUN_CDP_PORT        (default 9343)
//   QINGYUN_PROFILE_DIR     (persistent user-data-dir holding the logged-in session)
//   QINGYUN_PROXY_UPSTREAM   authed upstream proxy URL (default: MEITUAN_PROXY_URL).
//                            Set empty to go DIRECT (no proxy).
//   QINGYUN_PROXY_STORE      proxy-manager store key to follow (default 'tianhe').
//   QINGYUN_PROXY_LOCAL_PORT (default 9354) — local no-auth port Chrome points at.

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const net  = require('net');
const http = require('http');
const { spawn } = require('child_process');

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

const PORT        = process.env.QINGYUN_CDP_PORT        || '9343';
const PROFILE     = process.env.QINGYUN_PROFILE_DIR     || path.join(os.homedir(), '.qingyun-chrome-profile');
const LOCAL_PORT  = Number(process.env.QINGYUN_PROXY_LOCAL_PORT || 9354);
const PROXY_STORE = process.env.QINGYUN_PROXY_STORE     || 'tianhe';
const START_URL   = 'https://saas.cyanclouds.com/aggregator/saas/order';

// Follow the failover watchdog (lib/proxy-manager + scripts/proxy-watchdog): it writes
// the chosen proxy for each store to data/proxy-active.json; we follow it and relaunch
// Chrome whenever it switches. Falls back to the env default when absent. '' = direct.
const pm = (() => { try { return require('../lib/proxy-manager'); } catch (_) { return null; } })();
// Never print proxy credentials: these lines land in pm2 logs that get tailed and
// pasted. (2026-08-08: the GZ proxy password was sitting in plain text in the
// channel daemons' "proxy switch" lines.)
function redactProxy(url) {
  const s = String(url || '');
  if (!s) return '(direct)';
  return s.replace(/\/\/([^/@]*):([^/@]*)@/, '//$1:***@');
}

function desiredUpstream() {
  if (pm) { try { const a = pm.readActive(PROXY_STORE); if (a !== undefined) return a; } catch (_) { /* fall through */ } }
  return process.env.QINGYUN_PROXY_UPSTREAM != null
    ? process.env.QINGYUN_PROXY_UPSTREAM
    : (process.env.MEITUAN_PROXY_URL || '');
}

// ── Local auth-injecting proxy forwarder (authed HTTP upstreams only) ──────────
// Chrome's --proxy-server can't supply BasicAuth, so for an authed HTTP upstream we
// run a tiny local forwarder that injects Proxy-Authorization: Chrome →
// 127.0.0.1:LOCAL_PORT (no auth) → upstream. SOCKS5 upstreams skip this (Chrome speaks
// SOCKS5 directly; the residential proxy needs no auth over the WG tunnel).
function startForwarder(upstream) {
  let u;
  try { u = new URL(upstream); } catch (e) { console.error('[qingyun-chrome] bad upstream:', e.message); return null; }
  const upHost = u.hostname, upPort = Number(u.port) || 8888;
  const auth = (u.username || u.password)
    ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
    : null;

  const server = http.createServer((req, res) => {
    const headers = { ...req.headers };
    if (auth) headers['proxy-authorization'] = auth;
    const fwd = http.request({ host: upHost, port: upPort, method: req.method, path: req.url, headers }, (pr) => {
      res.writeHead(pr.statusCode, pr.headers); pr.pipe(res);
    });
    fwd.on('error', () => { try { res.writeHead(502); res.end(); } catch (e) { /* ignore */ } });
    req.pipe(fwd);
  });

  server.on('connect', (req, client, head) => {
    const up = net.connect(upPort, upHost, () => {
      let line = `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n`;
      if (auth) line += `Proxy-Authorization: ${auth}\r\n`;
      up.write(line + '\r\n');
    });
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i === -1) return;
      up.removeListener('data', onData);
      const ok = /^HTTP\/1\.[01] 200/.test(buf.slice(0, i).toString());
      if (!ok) { try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) { /* ignore */ } up.end(); return; }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = buf.slice(i + 4);
      if (rest.length) client.write(rest);
      if (head && head.length) up.write(head);
      up.pipe(client); client.pipe(up);
    };
    up.on('data', onData);
    up.on('error', () => { try { client.end(); } catch (e) { /* ignore */ } });
    client.on('error', () => { try { up.end(); } catch (e) { /* ignore */ } });
  });

  server.on('error', (e) => console.error('[qingyun-chrome] forwarder error:', e.message));
  server.listen(LOCAL_PORT, '127.0.0.1', () =>
    console.log(`[qingyun-chrome] proxy-auth forwarder 127.0.0.1:${LOCAL_PORT} → ${upHost}:${upPort} (auth ${auth ? 'on' : 'off'})`));
  return server;
}

// Map an upstream URL → { chromeProxy, forwarder }. SOCKS5 (residential) → Chrome
// directly; authed HTTP (GZ) → local forwarder; '' = direct.
function buildProxy(upstream) {
  if (!upstream) return { chromeProxy: null, forwarder: null };
  let u;
  try { u = new URL(upstream); } catch (_) { return { chromeProxy: null, forwarder: null }; }
  if (u.protocol === 'socks5:' || u.protocol === 'socks5h:') {
    return { chromeProxy: `socks5://${u.host}`, forwarder: null };
  }
  const forwarder = startForwarder(upstream);
  return { chromeProxy: forwarder ? `http://127.0.0.1:${LOCAL_PORT}` : null, forwarder };
}

// ── Chrome ────────────────────────────────────────────────────────────────────
function chromeBinary() {
  if (process.platform === 'win32') {
    const p = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    if (fs.existsSync(p)) return p;
  }
  return require('playwright').chromium.executablePath();
}

let currentChild = null;
let currentForwarder = null;
let currentUpstream = null;
let intentionalKill = false;

function startChrome(upstream) {
  if (!fs.existsSync(PROFILE)) fs.mkdirSync(PROFILE, { recursive: true });
  const { chromeProxy, forwarder } = buildProxy(upstream);
  currentForwarder = forwarder;
  currentUpstream = upstream;
  const exe = chromeBinary();
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--disable-features=Translate,OptimizationHints',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-breakpad',
    '--disable-domain-reliability',
    '--no-pings',
    '--disk-cache-size=33554432',
    '--media-cache-size=16777216',
    '--disable-gpu-shader-disk-cache',
    START_URL,
  ];
  if (process.platform !== 'win32') args.push('--no-sandbox', '--disable-gpu');
  if (chromeProxy) args.push(`--proxy-server=${chromeProxy}`);

  console.log(`[qingyun-chrome] launching ${exe}\n  port=${PORT} profile=${PROFILE} upstream=${redactProxy(upstream)} proxy=${redactProxy(chromeProxy)} display=${process.env.DISPLAY || '(none)'}`);
  const child = spawn(exe, args, { stdio: 'inherit', env: process.env });
  currentChild = child;
  child.on('exit', (code) => {
    if (intentionalKill) { intentionalKill = false; return; }
    console.log(`[qingyun-chrome] chrome exited (${code}) — relaunching in 3s`);
    setTimeout(() => startChrome(desiredUpstream()), 3000);
  });
  child.on('error', (e) => console.error('[qingyun-chrome] spawn error:', e.message));
}

function relaunchWith(upstream) {
  console.log(`[qingyun-chrome] proxy switch (${redactProxy(currentUpstream)} → ${redactProxy(upstream)}) — relaunching Chrome`);
  intentionalKill = true;
  try { if (currentForwarder) currentForwarder.close(); } catch (_) { /* ignore */ }
  currentForwarder = null;
  if (currentChild) { try { currentChild.kill('SIGKILL'); } catch (_) { /* ignore */ } }
  setTimeout(() => startChrome(upstream), 1500);
}

const SWITCH_POLL_MS = Number(process.env.QINGYUN_PROXY_POLL_MS || 30_000);
setInterval(() => {
  const want = desiredUpstream();
  if (want !== currentUpstream) relaunchWith(want);
}, SWITCH_POLL_MS);

startChrome(desiredUpstream());
