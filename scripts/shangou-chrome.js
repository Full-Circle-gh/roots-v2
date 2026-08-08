// Long-lived genuine Chrome for the 闪购 daemon to attach to over CDP.
//
// Why a separate process, not Playwright launch: the 闪购 data APIs 403 any browser
// with Playwright's automation fingerprint. We sidestep that by spawning the Chromium
// BINARY DIRECTLY (no --enable-automation), so navigator.webdriver stays false and
// Meituan treats it as a real user. The shangou-daemon then connectOverCDP to it.
//
// Proxy: route through the GZ proxy so Meituan sees a Guangzhou IP (the store's
// region) instead of the box's Hong Kong datacenter IP. The GZ proxy needs BasicAuth,
// which Chrome's --proxy-server can't supply (it would prompt a dialog the headless
// box can't answer), so this process also runs a tiny LOCAL forwarder that injects
// the Proxy-Authorization header: Chrome → 127.0.0.1:LOCAL (no auth) → GZ proxy.
//
// On the box: run under Xvfb (DISPLAY set) so it's headful (sheds headless tells).
//   pm2 start scripts/shangou-chrome.js --name shangou-chrome
// Env:
//   SHANGOU_CDP_PORT       (default 9333)
//   SHANGOU_PROFILE_DIR    (persistent user-data-dir holding the logged-in session)
//   SHANGOU_PROXY_UPSTREAM  authed upstream proxy URL (default: MEITUAN_PROXY_URL).
//                           Set empty to go DIRECT (no proxy).
//   SHANGOU_PROXY_LOCAL_PORT (default 9344) — local no-auth port Chrome points at.

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

const PORT       = process.env.SHANGOU_CDP_PORT        || '9333';
const PROFILE    = process.env.SHANGOU_PROFILE_DIR     || path.join(os.homedir(), '.shangou-chrome-profile');
const LOCAL_PORT = Number(process.env.SHANGOU_PROXY_LOCAL_PORT || 9344);
const START_URL  = 'https://shangoue.meituan.com/';

// The failover watchdog (lib/proxy-manager + scripts/proxy-watchdog) decides which
// proxy 闪购 (yuexiu) should use and writes it to data/proxy-active.json. We follow
// that choice and relaunch Chrome whenever it switches. Falls back to the env
// default when the manager / state file is absent. '' = direct.
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
  if (pm) { try { const a = pm.readActive('yuexiu'); if (a !== undefined) return a; } catch (_) { /* fall through */ } }
  return process.env.SHANGOU_PROXY_UPSTREAM != null
    ? process.env.SHANGOU_PROXY_UPSTREAM
    : (process.env.MEITUAN_PROXY_URL || '');
}

// ── Local auth-injecting proxy forwarder (authed HTTP upstreams only) ──────────
// Chrome's --proxy-server can't supply BasicAuth, so for an authed HTTP upstream
// (the GZ proxy) we run a tiny local forwarder that injects Proxy-Authorization:
// Chrome → 127.0.0.1:LOCAL_PORT (no auth) → upstream. Returns the http.Server
// (close it on a proxy switch) or null. SOCKS5 upstreams skip this entirely —
// Chrome speaks SOCKS5 directly, and the residential proxy needs no auth over WG.
function startForwarder(upstream) {
  let u;
  try { u = new URL(upstream); } catch (e) { console.error('[shangou-chrome] bad upstream:', e.message); return null; }
  const upHost = u.hostname, upPort = Number(u.port) || 8888;
  const auth = (u.username || u.password)
    ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
    : null;

  const server = http.createServer((req, res) => {
    // Plain HTTP request → forward to upstream proxy (absolute-URI form) with auth.
    const headers = { ...req.headers };
    if (auth) headers['proxy-authorization'] = auth;
    const fwd = http.request({ host: upHost, port: upPort, method: req.method, path: req.url, headers }, (pr) => {
      res.writeHead(pr.statusCode, pr.headers); pr.pipe(res);
    });
    fwd.on('error', () => { try { res.writeHead(502); res.end(); } catch (e) {} });
    req.pipe(fwd);
  });

  // HTTPS: Chrome sends CONNECT host:port → open CONNECT to upstream (with auth), splice.
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
      if (!ok) { try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) {} up.end(); return; }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = buf.slice(i + 4);
      if (rest.length) client.write(rest);
      if (head && head.length) up.write(head);
      up.pipe(client); client.pipe(up);
    };
    up.on('data', onData);
    up.on('error', () => { try { client.end(); } catch (e) {} });
    client.on('error', () => { try { up.end(); } catch (e) {} });
  });

  server.on('error', (e) => console.error('[shangou-chrome] forwarder error:', e.message));
  server.listen(LOCAL_PORT, '127.0.0.1', () =>
    console.log(`[shangou-chrome] proxy-auth forwarder 127.0.0.1:${LOCAL_PORT} → ${upHost}:${upPort} (auth ${auth ? 'on' : 'off'})`));
  return server;
}

// Map an upstream URL → { chromeProxy, forwarder }. SOCKS5 (residential) goes
// straight to Chrome (no auth over the WG tunnel); authed HTTP (GZ) goes via the
// local forwarder; '' = direct (no proxy).
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
let currentUpstream = null;   // upstream URL Chrome is currently running with
let intentionalKill = false;  // set when WE kill Chrome for a proxy switch

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

  console.log(`[shangou-chrome] launching ${exe}\n  port=${PORT} profile=${PROFILE} upstream=${redactProxy(upstream)} proxy=${redactProxy(chromeProxy)} display=${process.env.DISPLAY || '(none)'}`);
  const child = spawn(exe, args, { stdio: 'inherit', env: process.env });
  currentChild = child;
  child.on('exit', (code) => {
    if (intentionalKill) { intentionalKill = false; return; } // a proxy-switch relaunch handles it
    console.log(`[shangou-chrome] chrome exited (${code}) — relaunching in 3s`);
    setTimeout(() => startChrome(desiredUpstream()), 3000); // re-pick proxy on crash relaunch
  });
  child.on('error', (e) => console.error('[shangou-chrome] spawn error:', e.message));
}

// Apply a new upstream by relaunching Chrome (and swapping/closing the forwarder).
function relaunchWith(upstream) {
  console.log(`[shangou-chrome] proxy switch (${redactProxy(currentUpstream)} → ${redactProxy(upstream)}) — relaunching Chrome`);
  intentionalKill = true;
  try { if (currentForwarder) currentForwarder.close(); } catch (_) {}
  currentForwarder = null;
  if (currentChild) { try { currentChild.kill('SIGKILL'); } catch (_) {} }
  setTimeout(() => startChrome(upstream), 1500);
}

// Follow the failover watchdog: when it switches yuexiu's proxy in
// data/proxy-active.json, relaunch Chrome onto the new exit.
const SWITCH_POLL_MS = Number(process.env.SHANGOU_PROXY_POLL_MS || 30_000);
setInterval(() => {
  const want = desiredUpstream();
  if (want !== currentUpstream) relaunchWith(want);
}, SWITCH_POLL_MS);

startChrome(desiredUpstream());
