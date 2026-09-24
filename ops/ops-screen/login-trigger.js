// Box-only control server for the ops-screen. Loopback only; nginx fronts it
// with TLS + basic auth under /ops-screen/ctl/ on system.rootskitchenchina.com.
// Serves a tiny phone page and one-tap triggers that launch a HEADED channel
// login on Xvfb :99 (visible in noVNC at /ops-screen/). Each login script
// auto-uses the active failover proxy and writes its session file on success.
//
// DEPLOYED TO /opt/ops-screen/login-trigger.js — it does NOT run from the repo:
//   scp ops/ops-screen/login-trigger.js root@<box>:/opt/ops-screen/login-trigger.js
//   pm2 restart ops-screen-ctl
// It lives here so it is version-controlled and reviewable; it used to exist
// only on the box, where a rebuild would have lost it and no change to it was
// visible to anyone.
//
// Why this page matters: the login scripts are headed Playwright, so they need
// a display. Run from a laptop that means installing Node + Playwright and then
// scp'ing the session to the box — on 2026-08-25 that turned a two-minute
// re-login into a forty-minute one, most of it spent on a Windows toolchain.
// Run HERE, the browser renders on the display noVNC already exposes, and the
// session file lands straight in the daemon's data/ directory. No laptop, no
// scp. GZ Grocery's browser layer notices a newer session file on its own;
// Meituan's and Eleme's do not, so a successful login restarts their daemon.
//
// §252 — Tacet's Sign in button drives this too, through the JSON API at the
// bottom (/api/start, /api/status). Those logins run on a PRIVATE display
// (:98, its own loopback x11vnc) that shows nothing but the one login window —
// display :99 carries every channel's logged-in browser, and a person signing
// in to one channel must not see or type into the others.
"use strict";
const http = require("http");
const fs = require("fs");
const { spawn } = require("child_process");

const REPO = "/root/roots-v2";
// Where a launched login's own output goes. It used to go to /dev/null, which
// is fine right up until a login does not appear and there is nothing whatever
// to look at: the page reports success as soon as spawn() returns, so a child
// that dies a second later is indistinguishable from one that worked. Beside
// the pm2 logs, because that is where somebody debugging this already is.
const LOG_FILE = "/root/.pm2/logs/ops-screen-login.log";

// Every login this screen can start. Adding a channel is one entry: the script
// must be a HEADED login that self-closes and writes its own session file.
const JOBS = {
  "meituan-tianhe": { label: "美团外卖 · 天河", script: "scripts/meituan-login.js", args: ["tianhe"],
                      channel: "meituan", store: "tianhe",
                      hint: "扫码登录 / QR scan, then re-select the store." },
  "meituan-yuexiu": { label: "美团外卖 · 越秀", script: "scripts/meituan-login.js", args: ["yuexiu"],
                      channel: "meituan", store: "yuexiu",
                      hint: "扫码登录 / QR scan, then re-select the store." },
  "guanyi-tianhe":  { label: "管易 Guanyi · 天河", script: "scripts/guanyi-login.js", args: ["tianhe"],
                      channel: "guanyi", store: "tianhe",
                      hint: "账号 + 密码 / account + password (SMS code if asked)." },
};

// The shared screen, and the private one Tacet's Sign in uses (§252).
const SHARED_DISPLAY = ":99";
const SIGNIN_DISPLAY = process.env.SIGNIN_DISPLAY || ":98";

// Which login script signs each channel in, and which daemon must be restarted
// afterwards because it does not pick a new session file up by itself. GZ
// Grocery does (lib/guanyi-browser.js), so it has none.
const CHANNEL_LOGIN = {
  meituan: { script: "scripts/meituan-login.js", daemon: "meituan-sync" },
  eleme:   { script: "scripts/eleme-login.js",   daemon: "eleme-sync" },
  guanyi:  { script: "scripts/guanyi-login.js",  daemon: null },
};
const PM2 = process.env.PM2_BIN || "pm2";

// One login window at a time: they all share the single Xvfb display, and two
// browsers stacked on it is how an operator ends up typing into the wrong one.
let running = null; // { id, label, pid, startedAt, channel, store }
let last = null;    // { channel, store, ok, exitCode, endedAt } — the most recent login to end
const LOCK_MS = 7 * 60 * 1000; // login scripts self-close at ~6 min

function launch(id, job = JOBS[id], display = SHARED_DISPLAY) {
  if (!job) return { ok: false, msg: `Unknown login "${id}".` };
  if (running) {
    const mins = Math.round((Date.now() - running.startedAt) / 60000);
    return { ok: false, msg: `${running.label} is already open (${mins} min ago). Finish or wait for it to close.` };
  }
  // Keep the child's output. Falls back to discarding it rather than refusing to
  // launch — a login with no log beats no login.
  let out = "ignore";
  try {
    out = fs.openSync(LOG_FILE, "a");
    fs.writeSync(out, `\n=== ${new Date().toISOString()} ${id} (${job.script} ${job.args.join(" ")})\n`);
  } catch (e) {
    console.error(`[ops-screen] cannot open ${LOG_FILE} (${e.message}) — launching without a log`);
  }

  // process.execPath, not "node": spawn() would resolve that off PATH, and a pm2
  // daemon's PATH is whatever shell started it — often a different, older Node
  // than the one an operator gets interactively. The script would then die on
  // syntax it cannot parse, instantly and (before the log above) invisibly. This
  // is by definition the interpreter already running this server.
  const child = spawn(process.execPath, [job.script, ...job.args], {
    cwd: REPO,
    env: { ...process.env, DISPLAY: display },
    detached: true,
    stdio: out === "ignore" ? "ignore" : ["ignore", out, out],
  });
  // A ChildProcess 'error' (REPO path gone, interpreter unusable) with no listener
  // is an uncaught exception — it would take this control server down with it, and
  // the one thing it must never do is be unavailable when a channel needs a re-login.
  const release = () => { if (running && running.pid === child.pid) running = null; };
  child.on("error", (e) => {
    console.error(`[ops-screen] launch failed for ${id}: ${e.message}`);
    release();
  });
  // And free the screen the moment the login is actually over. Without this the
  // lock ran for its full seven minutes no matter what, so a child that died two
  // seconds in left the operator locked out of retrying — while the page went on
  // insisting a window was open, which is the worst possible thing to be told
  // when you are standing there looking at an empty screen.
  child.on("exit", (code, signal) => {
    if (out !== "ignore") { try { fs.closeSync(out); } catch (_) { /* already gone */ } }
    if (code !== 0) console.error(`[ops-screen] ${id} exited ${signal || code} — see ${LOG_FILE}`);
    last = { channel: job.channel || null, store: job.store || null, ok: code === 0,
             exitCode: code, endedAt: new Date().toISOString() };
    if (code === 0) restartDaemon(job.channel);
    release();
  });
  child.unref();
  running = { id, label: job.label, pid: child.pid, startedAt: Date.now(),
              channel: job.channel || null, store: job.store || null };
  const me = running;
  setTimeout(() => { if (running === me) running = null; }, LOCK_MS);
  return { ok: true, msg: `${job.label} login window opening on the screen (~5s). ${job.hint}` };
}

// A new session file is only read by the Meituan and Eleme daemons at start-up,
// so the login is not finished until the daemon has been bounced. Best-effort:
// a failed restart is logged, and the channel's card simply stays red until
// someone restarts it, which is the honest state.
function restartDaemon(channel) {
  const d = CHANNEL_LOGIN[channel] && CHANNEL_LOGIN[channel].daemon;
  if (!d) return;
  const p = spawn(PM2, ["restart", d], { stdio: "ignore" });
  p.on("error", (e) => console.error(`[ops-screen] pm2 restart ${d} failed: ${e.message}`));
  p.on("exit", (c) => { if (c !== 0) console.error(`[ops-screen] pm2 restart ${d} exited ${c}`); });
}

// The one job Tacet may ask for: a channel, a store code, and for Eleme its
// numeric shop id. Everything is checked against a fixed shape before it gets
// anywhere near spawn(), because the arguments come over a socket.
const CODE = /^[a-z0-9_-]{1,32}$/;
function signinJob(body) {
  const b = body || {};
  const c = CHANNEL_LOGIN[b.channel];
  if (!c || !CODE.test(String(b.store || ""))) return null;
  const args = [b.store];
  if (b.channel === "eleme") {
    if (!/^\d{1,20}$/.test(String(b.shopId || ""))) return null;
    args.push(String(b.shopId));
  }
  return { label: `${b.channel} · ${b.store}`, script: c.script, args,
           channel: b.channel, store: b.store, hint: "" };
}

function readJson(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { buf += c; if (buf.length > 4096) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); } });
  });
}

function page() {
  const buttons = Object.entries(JOBS).map(([id, j]) =>
    `<button class="go" onclick="go('${id}')">${j.label}</button>`).join("\n");
  return `<!doctype html><html><head><meta charset=utf8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Ops Screen</title><style>
body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:24px;background:#1a1a1a;color:#eee}
h1{font-size:18px;margin:0 0 4px}p{color:#aaa;font-size:14px;line-height:1.5}
a.btn,button{display:block;width:100%;box-sizing:border-box;margin:14px 0;padding:16px;
border-radius:12px;border:0;font-size:16px;font-weight:600;text-align:center;text-decoration:none}
a.vnc{background:#2d6cdf;color:#fff}button.go{background:#1f9d55;color:#fff}
#msg{font-size:14px;color:#7fd;min-height:1.4em}</style></head><body>
<h1>Ops Screen</h1>
<p>Re-login a channel from your phone. <b>Tap the channel first</b>, then open the screen and log in there.</p>
${buttons}
<div id=msg></div>
<a class="btn vnc" href="../vnc.html?resize=scale&reconnect=true">Open screen (VNC)</a>
<p>The window closes itself once the dashboard loads. Sync picks the new session
up within a minute — Meituan's and Eleme's sync are restarted for you.</p>
<script>
async function go(id){
  document.getElementById("msg").textContent="starting…";
  try{const r=await fetch("start/"+id,{method:"POST"});
    document.getElementById("msg").textContent=await r.text();}
  catch(e){document.getElementById("msg").textContent="error: "+e}
}
</script></body></html>`;
}

const srv = http.createServer(async (req, res) => {
  const url = req.url.replace(/\?.*$/, "");
  const text = (code, s) => { res.writeHead(code, { "content-type": "text/plain; charset=utf-8" }); res.end(s); };
  const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const pub = (r) => r && { channel: r.channel, store: r.store, startedAt: new Date(r.startedAt).toISOString() };

  // §252 — Tacet's API, for the Tacet process on this box and nothing else.
  // nginx's /ops-screen/ctl/ block strips its prefix, so /ops-screen/ctl/api/…
  // WOULD land here; every request nginx forwards carries X-Real-IP (see the
  // README's block), and Tacet's direct loopback call never does, so that
  // header is what refuses the outside path.
  if (url.startsWith("/api/") && (req.headers["x-real-ip"] || req.headers["x-forwarded-for"])) {
    return json(404, { ok: false, error: "not_here" });
  }
  if (url === "/api/status" && req.method === "GET") {
    return json(200, { running: pub(running), last });
  }
  if (url === "/api/start" && req.method === "POST") {
    const job = signinJob(await readJson(req));
    if (!job) return json(400, { ok: false, error: "bad_job" });
    if (running) return json(409, { ok: false, error: "busy", running: pub(running) });
    const r = launch(`signin-${job.channel}-${job.store}`, job, SIGNIN_DISPLAY);
    return json(r.ok ? 200 : 409, { ok: r.ok, running: pub(running) });
  }

  if (req.method === "POST") {
    const m = url.match(/\/start\/([a-z0-9-]+)$/i);
    // Legacy path from the Meituan-only version of this page — kept so an old
    // bookmark or tab still works.
    const id = m ? m[1] : (url.endsWith("/tianhe-login") ? "meituan-tianhe" : null);
    if (id) { const r = launch(id); return text(r.ok ? 200 : 409, r.msg); }
    return text(404, "no such action");
  }
  if (url.endsWith("/status")) {
    return text(200, running
      ? `${running.label} open since ${new Date(running.startedAt).toISOString()}`
      : "idle");
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page());
});
const PORT = Number(process.env.OPS_SCREEN_CTL_PORT || 6090);
srv.listen(PORT, "127.0.0.1", () => console.log(`ops-screen control on 127.0.0.1:${PORT}`));
