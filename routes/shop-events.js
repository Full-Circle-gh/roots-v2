// Server-Sent Events for the counter till — "an order just arrived at your
// shop", pushed the moment it does.
//
// WHY THIS IS NOT routes/events.js. That module already does SSE well and is
// the obvious place to put this, and it cannot be, for two reasons that are
// both about who is listening:
//
//   1. A DIFFERENT AUTHENTICATED PRINCIPAL. /api/events is behind requireAuth,
//      which keys on `req.session.userId` — a row in the global `users` table.
//      The till's operator is a BACKEND/TENANT operator on `session.
//      backendUserId` and has no `users` row at all, so it would be handed a
//      401 and quietly fall back to polling forever.
//   2. NO TENANT IN THAT REGISTRY. Its subscriber records carry id, role and
//      perms, and `broadcast()` with no targeting delivers to EVERY open
//      socket. Adding a tenant dimension to a registry four other features
//      already depend on is a wide change to make for one screen, and getting
//      it wrong leaks one tenant's counter traffic to another's.
//
// So: a second, deliberately small registry with tenant isolation built in
// rather than bolted on. The framing, the keepalive interval and the
// fan-out-over-a-Set shape are all copied from routes/events.js, because two
// SSE implementations that behave differently would be the real cost here.
//
// THE EVENT CARRIES NO ORDER DATA, AND THAT IS THE POINT. It says only "store
// N has something new". The till then re-reads its pending list through
// /api/retail-admin/orders, which already enforces the tenant scope and the
// capability. So this channel cannot leak an order even if the targeting below
// is wrong one day: there is nothing on it to leak. It is a doorbell, not a
// delivery.
//
// THE POLL IN THE TILL STAYS. A dropped socket behind a hotel's proxy is
// silent, and a counter that has quietly stopped seeing orders is worse than
// one that is fifteen seconds behind. This makes the common case instant; the
// poll remains the floor under it.

'use strict';

const express = require('express');
const router = express.Router();

// requireRetailAdmin lives in routes/retail.js, which is mounted before this
// module is used. Required lazily inside the handler on the same reasoning
// routes/feedback.js uses for its own events import: a load-order change must
// degrade to "no live updates", never to a route that throws on boot.
function retailMw(name) {
  try { return require('./retail')[name]; } catch (e) { return null; }
}

// Per-process subscriber registry. Each entry is:
//   { id, res, tenantId, storeId }
// storeId is the shop the till is locked to. A till that has not picked one
// yet subscribes with null and is sent nothing — it has no list to refresh.
const subs = new Set();
let _sid = 0;

router.get('/api/retail-admin/shop-events', (req, res, next) => {
  const guard = retailMw('requireRetailAdmin');
  if (!guard) return res.status(503).end();
  return guard(req, res, next);
}, (req, res) => {
  let tenantId = null;
  try { tenantId = require('../lib/tenant-db').currentTenantId(); } catch (e) { tenantId = null; }
  // No resolvable tenant means no way to scope the fan-out, and an unscoped
  // subscriber is exactly the leak this file exists to avoid. Refuse instead.
  if (tenantId == null) return res.status(409).end();

  const storeId = parseInt(req.query.store_id, 10);
  const sub = { id: ++_sid, res, tenantId, storeId: Number.isFinite(storeId) ? storeId : null };

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    // Nginx buffers text/event-stream by default and the first event then
    // arrives minutes late or never. routes/events.js carries the same header
    // for the same reason.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  // An immediate comment so the browser's EventSource resolves `open` rather
  // than sitting in CONNECTING behind a proxy that waits for first bytes.
  res.write(': connected\n\n');

  subs.add(sub);

  const keep = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* close handler cleans up */ }
  }, 25000);

  req.on('close', () => { clearInterval(keep); subs.delete(sub); });
});

// Fired when a QR order is placed. `storeId` is the shop it landed at.
//
// Delivered ONLY to sockets on the same tenant, and only to those watching
// that store (or watching none in particular). Never a global fan-out: a
// broadcast that matched everything would put one shop's doorbell on every
// other shop's counter, and on every other tenant's.
function shopOrderPlaced(tenantId, storeId) {
  if (tenantId == null) return;
  const data = `event: shop-order\ndata: ${JSON.stringify({ store_id: storeId == null ? null : Number(storeId) })}\n\n`;
  for (const s of subs) {
    if (s.tenantId !== tenantId) continue;
    if (s.storeId != null && storeId != null && s.storeId !== Number(storeId)) continue;
    try { s.res.write(data); } catch { /* socket dead — close handler will clean up */ }
  }
}

module.exports = router;
module.exports.shopOrderPlaced = shopOrderPlaced;
module.exports.subscriberCount = () => subs.size;
