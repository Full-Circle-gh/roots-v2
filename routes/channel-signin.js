'use strict';

// Sign a channel back in (§250, §252). The rules live in lib/channel-signin.js;
// this file is the HTTP around them, plus the WebSocket relay that shows the
// private sign-in screen.

const path = require('path');
const net = require('net');
const express = require('express');
const { WebSocketServer } = require('ws');
const { loadCaller } = require('../lib/require-cap');
const { getTenantDb, ROOTS_TENANT_ID } = require('../lib/tenant-db');
const { channelBlock } = require('../lib/channel-block');
const signin = require('../lib/channel-signin');

const router = express.Router();
const SCREEN_PATH = '/api/retail-admin/channel-signin/screen';

const STATUS = { not_signed_in: 401, wrong_account: 403, no_permission: 403, out_of_scope: 403 };

// The caller and the store, or a response already sent. Reads the Roots
// database directly: this feature is Roots-only, and refusal() says so first.
function gate(req, res, channel, code) {
  const caller = loadCaller(req);
  const db = getTenantDb(ROOTS_TENANT_ID);
  const store = signin.resolveStore(db, channel, code);
  const why = signin.refusal(caller, req.session && req.session.tenantId, store);
  if (why) { res.status(STATUS[why]).json({ success: false, error: why }); return null; }
  if (!store) { res.status(400).json({ success: false, error: 'unknown_store' }); return null; }
  return { caller, store, db };
}

router.post('/api/retail-admin/channel-signin/start', express.json(), async (req, res) => {
  const { channel, store: code } = req.body || {};
  const g = gate(req, res, channel, code);
  if (!g) return;
  // What is actually running on the screen decides, never the grant alone: a
  // closed tab keeps its grant for minutes, and on the first live use that grant
  // told the next person "someone is already signing in" when nobody was.
  const st = await signin.trigger('GET', '/api/status');
  if (st.status !== 200 || !st.json) return res.status(503).json({ success: false, error: 'trigger_unavailable' });
  // Decided on the trigger's own job name: for a 闪购 store that is 'shangou',
  // not the 'meituan' the button sent (§260).
  const job = signin.jobChannel(channel, g.store);
  const next = signin.startDecision(st.json.running, job, g.store.code);
  if (next === 'busy') return res.status(409).json({ success: false, error: 'busy', busy: st.json.running });
  if (next === 'join') {
    // The same channel and store is already at its login window: whoever asks
    // now, with the same permission and scope, takes the screen over and
    // finishes it. The previous viewer's relay closes on its next check.
    signin.grantFor(g.caller.user.id, channel, g.store.code);
    return res.json({ success: true, resumed: true, holder: !!g.store.job });
  }
  signin.endGrant();
  const r = await signin.trigger('POST', '/api/start', { channel: job, store: g.store.code, shopId: g.store.shopId || null });
  if (r.status === 409) return res.status(409).json({ success: false, error: 'busy', busy: r.json && r.json.running });
  if (r.status !== 200) return res.status(503).json({ success: false, error: 'trigger_unavailable' });
  signin.grantFor(g.caller.user.id, channel, g.store.code);
  res.json({ success: true, holder: !!g.store.job });
});

// What the page polls: is the login window still open, did it succeed, and has
// the daemon itself reported the channel working again.
router.get('/api/retail-admin/channel-signin/status', async (req, res) => {
  const { channel, store: code } = req.query;
  const g = gate(req, res, channel, code);
  if (!g) return;
  const r = await signin.trigger('GET', '/api/status');
  const st = r.status === 200 && r.json ? r.json : null;
  const job = signin.jobChannel(channel, g.store);
  const mine = (j) => j && j.channel === job && j.store === g.store.code ? j : null;
  const running = st ? mine(st.running) : null;
  const last = st ? mine(st.last) : null;
  if (!running && signin.liveGrant() && signin.liveGrant().userId === g.caller.user.id) signin.endGrant();
  res.json({
    success: true,
    trigger: !!st,
    // §260 — a holder session: the page shows Done, and success is the
    // daemon's own word (blocked clearing), not the session ending.
    holder: !!g.store.job,
    running: !!running,
    last: last ? { ok: !!last.ok, endedAt: last.endedAt || null } : null,
    blocked: channelBlock(g.db, channel, g.store.code),
  });
});

// §260 — the person is done on a holder's screen. Only the person watching it
// may say so: the same gate, and the grant must be theirs.
router.post('/api/retail-admin/channel-signin/finish', express.json(), async (req, res) => {
  const { channel, store: code } = req.body || {};
  const g = gate(req, res, channel, code);
  if (!g) return;
  if (!g.store.job) return res.status(400).json({ success: false, error: 'not_a_holder' });
  if (!signin.mayWatch(g.caller.user.id)) return res.status(409).json({ success: false, error: 'not_running' });
  const r = await signin.trigger('POST', '/api/finish', { channel: g.store.job, store: g.store.code });
  if (r.status === 409) return res.status(409).json({ success: false, error: 'not_running' });
  if (r.status !== 200) return res.status(503).json({ success: false, error: 'trigger_unavailable' });
  signin.endGrant();
  res.json({ success: true });
});

// The page. It authenticates itself through the two calls above, like the
// other self-authing shells (the till, the product editor).
router.get('/channel-signin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'public', 'channel-signin.html'));
});

// noVNC's browser client, served from the package so its version is pinned in
// package-lock.json and reviewed like any other dependency. Only the two
// directories the client imports from.
const NOVNC = path.join(path.dirname(require.resolve('@novnc/novnc')), '..');
router.use('/novnc/core', express.static(path.join(NOVNC, 'core'), { index: false }));
router.use('/novnc/vendor', express.static(path.join(NOVNC, 'vendor'), { index: false }));

// ── The screen relay ────────────────────────────────────────────────────────
// A WebSocket upgrade never passes through Express, so every check the routes
// above get from their gate is made here by hand, in the same order, before a
// single byte reaches the screen. `sessionMiddleware` is server.js's own.
function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch (_) { return false; }
}

function screenRefusal(req) {
  if (!sameOrigin(req)) return 'cross_origin';
  const caller = loadCaller(req);
  const g = signin.liveGrant();
  const db = getTenantDb(ROOTS_TENANT_ID);
  const store = g ? signin.resolveStore(db, g.channel, g.store) : null;
  const why = signin.refusal(caller, req.session && req.session.tenantId, store);
  if (why) return why;
  if (!signin.mayWatch(caller.user.id)) return 'no_sign_in_running';
  return null;
}

function attachScreenRelay(server, sessionMiddleware) {
  const wss = new WebSocketServer({
    noServer: true,
    // noVNC asks for 'binary'; answer it when offered, as websockify does.
    handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url.split('?')[0] !== SCREEN_PATH) return;
    const refuse = (code) => {
      socket.write(code === 'not_signed_in' ? 'HTTP/1.1 401 Unauthorized\r\n' : 'HTTP/1.1 403 Forbidden\r\n');
      socket.write('Connection: close\r\n\r\n');
      socket.destroy();
    };
    sessionMiddleware(req, {}, () => {
      let why;
      try { why = screenRefusal(req); } catch (e) { why = 'error'; }
      if (why) return refuse(why);
      const userId = loadCaller(req).user.id;
      const screen = screenOf(signin.liveGrant());
      wss.handleUpgrade(req, socket, head, (ws) => pipe(ws, userId, screen));
    });
  });
}

// The screen a grant is for: a holder's own (§260), else the sign-in display.
function screenOf(g) {
  const store = g ? signin.resolveStore(getTenantDb(ROOTS_TENANT_ID), g.channel, g.store) : null;
  return signin.screenFor(signin.jobChannel(g && g.channel, store));
}
function pipe(ws, userId, screen) {
  const vnc = net.connect(screen);
  const close = () => {
    try { ws.close(); } catch (_) { /* already closing: both ends call this, and a second close is a no-op we do not need to hear about */ }
    vnc.destroy();
  };
  vnc.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
  vnc.on('error', close);
  vnc.on('close', close);
  ws.on('message', (d) => vnc.write(d));
  ws.on('close', close);
  ws.on('error', close);
  // Watching ends with the sign-in, or when somebody else takes it over:
  // checked every few seconds, so a screen left open in a tab cannot outlive
  // the grant that allowed it, and there is only ever one viewer.
  const t = setInterval(() => { if (!signin.mayWatch(userId)) { clearInterval(t); close(); } }, 5000);
  ws.on('close', () => clearInterval(t));
}

module.exports = router;
module.exports.attachScreenRelay = attachScreenRelay;
module.exports.screenRefusal = screenRefusal;
module.exports.screenOf = screenOf;
module.exports.SCREEN_PATH = SCREEN_PATH;
