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

const router = express.Router();

// Per-process subscriber registry. Each entry is:
//   { id, res, userId, role, perms }
// Multiple tabs from the same user are independent entries (each tab
// gets its own EventSource). Cleared on `res.on('close')`.
const subs = new Set();
let _sid = 0;

// THE /api/events STREAM STOOD HERE (§81). It was the kitchen app's
// EventSource — an SSE feed on the `users` realm, keyed on id, role and perms.
// public/app.html was its only subscriber; both it and the realm are gone.
//
// broadcast() BELOW IS UNTOUCHED AND IS WHY THIS FILE REMAINS: purchases and
// restock both call it. With nothing in `subs`, it is a no-op loop rather than
// an error, which is what makes removing the endpoint safe without touching
// either caller. The counter till's own stream is routes/shop-events.js, on
// the tenant realm, and is unaffected.

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

// A who-is-listening DIAGNOSTIC ALSO STOOD HERE (§81): an admin route that
// answered which subscribers a given store or permission would reach. It was
// requireAuth + requireAdmin on the retired realm, and it reported on the
// subscriber set the deleted stream above was the only filler of.

module.exports = router;
module.exports.broadcast = broadcast;
module.exports.subscriberCount = () => subs.size;
