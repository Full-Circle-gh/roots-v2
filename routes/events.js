// Server-Sent Events — gives the dashboard / restock PWA sub-second
// notifications without polling. One persistent HTTP connection per
// open tab, the server keeps a Set of `res` objects per-user and
// fan-outs JSON events with `data: {…}\n\n` framing.
//
// Other route modules call `broadcast(kindOrTarget, payload)` to push
// an event. Targeting is by permission — same model as
// sendPushByPermission (see routes/push.js): the SSE connection
// remembers the user's id + role + perms at subscribe time, and
// broadcast() filters subscribers accordingly.
//
// HTTP-friendly so it works on the current plain-HTTP origin and will
// keep working once HTTPS lands. Auto-reconnect is built into the
// browser's EventSource (default ~3s on disconnect), and we send a
// `:keepalive` comment every 25s so intermediaries don't kill the
// idle socket.

const express = require('express');
// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_batch.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { requireAuth, requireAdmin } = require('../middleware/auth');
const router = express.Router();

// Per-process subscriber registry. Each entry is:
//   { id, res, userId, role, perms }
// Multiple tabs from the same user are independent entries (each tab
// gets its own EventSource). Cleared on `res.on('close')`.
const subs = new Set();
let _sid = 0;

router.get('/api/events', requireAuth, (req, res) => {
  const sub = {
    id: ++_sid,
    res,
    userId: req.user.id,
    username: req.user.username,
    role: req.user.role,
    perms: req.user.permissions || {},
  };
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    // Disable nginx response buffering once we're behind a proxy.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  // Greeting frame so the client knows the channel is live.
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now(), sid: sub.id })}\n\n`);
  subs.add(sub);
  // Keep-alive comment every 25s — well under the typical 60s idle
  // timeout for proxies and Node's default socket timeouts.
  const ka = setInterval(() => {
    try { res.write(':ka\n\n'); } catch {}
  }, 25000);
  req.on('close', () => {
    clearInterval(ka);
    subs.delete(sub);
    try { res.end(); } catch {}
  });
});

// Broadcast helper. `target` is { perm: 'warehouse_inbox' } or
// { perms: ['warehouse_inbox','restock'] } or { userId: 42 } or
// { role: 'admin' } — combined with logical OR. `excludeUserId`
// suppresses delivery to the user who triggered the event so the
// sender doesn't get pinged about their own action. Payload is
// serialised to JSON and emitted as `event: <kind>` so the client can
// route on `evt.type`.
function broadcast(kind, payload, target) {
  target = target || {};
  const exclude = target.excludeUserId;
  const perms   = target.perms || (target.perm ? [target.perm] : null);
  const role    = target.role;
  const userId  = target.userId;
  const data = `event: ${kind}\ndata: ${JSON.stringify(payload || {})}\n\n`;
  for (const s of subs) {
    if (exclude && s.userId === exclude) continue;
    let match = false;
    if (userId && s.userId === userId) match = true;
    if (role   && s.role   === role)   match = true;
    if (perms) {
      if (s.role === 'admin') match = true;
      else if (perms.some(p => s.perms[p])) match = true;
    }
    // Default match — if no targeting given, deliver to everyone.
    if (!perms && !role && !userId && !exclude) match = true;
    if (!match) continue;
    try { s.res.write(data); } catch { /* socket dead — close handler will clean up */ }
  }
}

// ── Diagnostic: who would receive a given event right now? ────────
// Admin-only debug endpoint. Given ?store=Yuexiu (or ?direction=…),
// returns the market match, the users assigned to it, the perms
// matched, and which of those users have a live SSE socket open RIGHT
// NOW. Use it to confirm routing without spamming real users.
//
// Example:
//   GET /api/events/who-is-listening?store=Yuexiu
//   GET /api/events/who-is-listening?perm=kitchen_inbox
router.get('/api/events/who-is-listening', requireAuth, requireAdmin, (req, res) => {
  const out = { subscribers_total: subs.size };
  const liveByUser = new Map();
  for (const s of subs) {
    if (!liveByUser.has(s.userId)) liveByUser.set(s.userId, { count: 0, role: s.role, username: s.username });
    liveByUser.get(s.userId).count += 1;
  }
  // Resolve store → market → users
  const store = (req.query.store || '').trim();
  if (store) {
    const m = db.prepare(`
      SELECT id, name, name_cn, COALESCE(kind,'market') AS kind, is_active
        FROM markets
       WHERE COALESCE(is_active,1) = 1
         AND (LOWER(TRIM(name)) = LOWER(TRIM(?)) OR (name_cn IS NOT NULL AND TRIM(name_cn) = TRIM(?)))
       LIMIT 1
    `).get(store, store);
    out.store_query = store;
    out.matched_market = m || null;
    if (m) {
      const users = db.prepare(`
        SELECT id, username, display_name, role
          FROM users
         WHERE market_id = ? AND COALESCE(is_active,1) = 1
         ORDER BY display_name, username
      `).all(m.id);
      out.assigned_users = users.map(u => ({
        ...u,
        live_sockets: liveByUser.get(u.id)?.count || 0,
        is_listening: !!liveByUser.has(u.id),
      }));
      out.would_receive_user_ids = users
        .filter(u => liveByUser.has(u.id))
        .map(u => u.id);
    } else {
      out.note = 'No active markets row matches this store name. The event would fall back to the perm-broadcast path (legacy free-text routing).';
    }
  }
  // Resolve perm → users (for kitchen_inbox / warehouse_inbox / restock)
  const perm = (req.query.perm || '').trim();
  if (perm) {
    out.perm_query = perm;
    const matched = [];
    for (const s of subs) {
      const isAdmin = s.role === 'admin';
      if (isAdmin || s.perms[perm]) {
        matched.push({ userId: s.userId, username: s.username, role: s.role, sub_id: s.id });
      }
    }
    out.matched_subscribers = matched;
  }
  res.json({ success: true, ...out });
});

module.exports = router;
module.exports.broadcast = broadcast;
module.exports.subscriberCount = () => subs.size;
