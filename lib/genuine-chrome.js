'use strict';

// A genuine Chrome, started as a plain process rather than through Playwright.
//
// Why: platform risk-control flags any browser Playwright LAUNCHES — the
// automation switches and the driver's own CDP session are visible to the page.
// scripts/shangou-chrome.js found this first (闪购's APIs 403 a Playwright
// browser) and fixed it by spawning the Chromium binary directly; on 2026-09-24
// Alibaba's slider on the Eleme login rejected every human drag inside a
// Playwright-launched window for the same reason (§256). Nothing attaches to a
// browser started here until the caller chooses to, after the human is done.
//
// The authed-proxy forwarder is the one scripts/shangou-chrome.js runs: Chrome's
// --proxy-server cannot supply BasicAuth, so an authed HTTP upstream is reached
// through a local no-auth forwarder that adds Proxy-Authorization. That script
// keeps its own copy for now because it holds the live 越秀 session and is not
// touched by this change.

const fs = require('fs');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

function startForwarder(upstream, localPort, tag) {
  let u;
  try { u = new URL(upstream); } catch (e) { console.error(`[${tag}] bad upstream: ${e.message}`); return null; }
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
    fwd.on('error', () => { try { res.writeHead(502); res.end(); } catch (_) { /* the client is already gone */ } });
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
      if (!/^HTTP\/1\.[01] 200/.test(buf.slice(0, i).toString())) {
        try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (_) { /* the client is already gone */ }
        up.end(); return;
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = buf.slice(i + 4);
      if (rest.length) client.write(rest);
      if (head && head.length) up.write(head);
      up.pipe(client); client.pipe(up);
    };
    up.on('data', onData);
    up.on('error', () => { try { client.end(); } catch (_) { /* the client is already gone */ } });
    client.on('error', () => { try { up.end(); } catch (_) { /* the upstream is already gone */ } });
  });
  server.on('error', (e) => console.error(`[${tag}] forwarder error: ${e.message}`));
  server.listen(localPort, '127.0.0.1');
  return server;
}

// upstream '' / null → direct. SOCKS5 goes straight to Chrome; authed HTTP goes
// through the local forwarder.
function buildProxy(upstream, localPort, tag) {
  if (!upstream) return { chromeProxy: null, forwarder: null };
  let u;
  try { u = new URL(upstream); } catch (_) { return { chromeProxy: null, forwarder: null }; }
  if (u.protocol === 'socks5:' || u.protocol === 'socks5h:') return { chromeProxy: `socks5://${u.host}`, forwarder: null };
  const forwarder = startForwarder(upstream, localPort, tag);
  return { chromeProxy: forwarder ? `http://127.0.0.1:${localPort}` : null, forwarder };
}

function chromeBinary() {
  if (process.platform === 'win32') {
    const p = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    if (fs.existsSync(p)) return p;
  }
  return require('playwright').chromium.executablePath();
}

// Start it. Returns { child, port, close() }. `profileDir` should be fresh for a
// login, so nothing half-signed-in from an earlier attempt is carried over.
function launchGenuineChrome({ startUrl, profileDir, port, proxyPort, upstream, tag = 'genuine-chrome' }) {
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
  const { chromeProxy, forwarder } = buildProxy(upstream, proxyPort, tag);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--disable-features=Translate,OptimizationHints',
    '--disable-sync', '--disable-default-apps', '--disable-breakpad', '--no-pings',
    '--window-position=0,0', '--window-size=1280,800',
    '--lang=zh-CN',
  ];
  if (process.platform !== 'win32') args.push('--no-sandbox', '--disable-gpu');
  if (chromeProxy) args.push(`--proxy-server=${chromeProxy}`);
  args.push(startUrl);
  console.log(`[${tag}] launching genuine Chrome on port ${port}, proxy ${chromeProxy || '(direct)'}, display ${process.env.DISPLAY || '(none)'}`);
  const child = spawn(chromeBinary(), args, { stdio: process.env.GENUINE_CHROME_DEBUG ? 'inherit' : 'ignore', env: process.env });
  child.on('error', (e) => console.error(`[${tag}] spawn error: ${e.message}`));
  return {
    child, port,
    close() {
      try { child.kill('SIGKILL'); } catch (_) { /* Chrome has already exited, which is the state close() wants */ }
      try { if (forwarder) forwarder.close(); } catch (_) { /* the forwarder was never listening or is already closed; nothing is left to release */ }
    },
  };
}

// The open tabs, read from Chrome's own HTTP listing. No CDP session is opened,
// so watching the URL is invisible to the page.
function listTabs(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 3000 }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve([]); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve([]));
  });
}

module.exports = { launchGenuineChrome, listTabs, buildProxy, chromeBinary };
