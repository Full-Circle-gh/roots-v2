// Web Push (VAPID) — true OS-level notifications that survive the
// browser being closed. Fires on the server, delivered by the user's
// push service (FCM for Chrome/Edge, APNs for Safari, etc.). The
// browser hands the payload to the service worker (public/sw.js),
// which renders the notification.
//
// Setup:
//   1. VAPID keys in .env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
//      VAPID_CONTACT (mailto:owner@example.com).
//   2. Client subscribes via /api/push/subscribe, server stores the
//      endpoint + keys in `push_subscriptions`.
//   3. Anywhere we want to send a push: require this module and call
//      sendPushToUser(userId, payload) or sendPushToAll(payload).
//
// Failed sends (410/404) prune the offending subscription so we don't
// retry indefinitely.

const express = require('express');
const webPush = require('web-push');
// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { requireAuth, logActivity } = require('../middleware/auth');
const router = express.Router();

// ─── Mute list ──────────────────────────────────────────
// A row here means "this subject has switched notifications off". No row
// means on, so nothing needs backfilling and anyone who never touched the
// toggle behaves exactly as before.
//
// Two identity spaces share the table because two subscription stores do:
// `push_subscriptions` is keyed to kitchen `users`, `tenant_operator_push_subs`
// to backend `tenant_users`. They are unrelated logins that still land on the
// SAME browser push endpoint (one service worker at scope '/'), so switching
// push off in one has to be able to mute the other. `linked_user_id` records
// the kitchen user muted alongside an operator so switching back on reverses
// both halves.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS push_optouts (
    scope          TEXT    NOT NULL,       -- 'user' | 'operator'
    subject_id     INTEGER NOT NULL,
    linked_user_id INTEGER,                -- operator scope only
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (scope, subject_id)
  )`);
} catch (e) {
  console.warn('[push] could not create push_optouts: ' + e.message);
}

function isMuted(scope, subjectId) {
  try {
    return !!db.prepare('SELECT 1 FROM push_optouts WHERE scope = ? AND subject_id = ?').get(scope, subjectId);
  } catch { return false; }
}
function setMuted(scope, subjectId, muted, linkedUserId) {
  if (muted) {
    db.prepare(`INSERT INTO push_optouts (scope, subject_id, linked_user_id) VALUES (?, ?, ?)
                ON CONFLICT(scope, subject_id) DO UPDATE SET
                  linked_user_id = COALESCE(excluded.linked_user_id, push_optouts.linked_user_id)`)
      .run(scope, subjectId, linkedUserId == null ? null : linkedUserId);
  } else {
    db.prepare('DELETE FROM push_optouts WHERE scope = ? AND subject_id = ?').run(scope, subjectId);
  }
}
function mutedLink(scope, subjectId) {
  try {
    const r = db.prepare('SELECT linked_user_id FROM push_optouts WHERE scope = ? AND subject_id = ?').get(scope, subjectId);
    return r ? r.linked_user_id : null;
  } catch { return null; }
}

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_CONTACT = process.env.VAPID_CONTACT     || 'mailto:owner@rootskitchen.cn';
const ENABLED = !!(VAPID_PUBLIC && VAPID_PRIVATE);
if (ENABLED) {
  webPush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn('[push] VAPID keys not set in .env — Web Push disabled.');
}

// GET /api/push/vapid-key — public key for the client to subscribe.
// No auth: any user about to subscribe needs this. Returns empty when
// push isn't configured so the client can fall back gracefully.
router.get('/api/push/vapid-key', (req, res) => {
  res.json({ enabled: ENABLED, publicKey: VAPID_PUBLIC });
});

// POST /api/push/subscribe — client sends its PushSubscription JSON.
// We store endpoint + keys keyed by user. If the same endpoint shows
// up again (page reload), we just refresh last_seen_at.
router.post('/api/push/subscribe', requireAuth, (req, res) => {
  if (!ENABLED) return res.status(503).json({ error: 'push not configured' });
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'invalid subscription' });
  }
  const ua = (req.headers['user-agent'] || '').slice(0, 200);
  try {
    db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(endpoint) DO UPDATE SET
                  user_id = excluded.user_id,
                  p256dh  = excluded.p256dh,
                  auth    = excluded.auth,
                  user_agent = excluded.user_agent,
                  last_seen_at = CURRENT_TIMESTAMP`)
      .run(req.user.id, endpoint, keys.p256dh, keys.auth, ua);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/push/unsubscribe — client tells us its endpoint went away.
router.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id);
  res.json({ success: true });
});

// GET /api/push/pref — does this signed-in user want push at all? The
// client checks this BEFORE silently re-enrolling a device. Without it,
// browser permission staying 'granted' after a switch-off was enough for
// the next page load to mint a fresh subscription and bring the pushes back.
router.get('/api/push/pref', requireAuth, (req, res) => {
  res.json({ enabled: !isMuted('user', req.user.id) });
});

// POST /api/push/pref — record the intent. Only ever called from an explicit
// user action. Sign-out uses /unsubscribe, which must NOT mute, or signing
// out would silently disable notifications for good.
router.post('/api/push/pref', requireAuth, (req, res) => {
  const enabled = !(req.body && req.body.enabled === false);
  try {
    setMuted('user', req.user.id, !enabled);
    if (!enabled) db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(req.user.id);
    res.json({ success: true, enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/push/test — debug endpoint: send a test push to the
// current user's subscriptions. Useful while validating the setup.
router.post('/api/push/test', requireAuth, async (req, res) => {
  if (!ENABLED) return res.status(503).json({ error: 'push not configured' });
  const result = await sendPushToUser(req.user.id, {
    title: '🌿 Roots test · 测试推送',
    body: 'If you see this, push is working. · 收到这条说明推送已生效',
    url: '/',
  });
  res.json({ success: true, ...result });
});

// ─── Helpers (exported) ────────────────────────────────────────────
async function _send(sub, payload) {
  try {
    await webPush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return { ok: true };
  } catch (e) {
    // 404/410 → subscription is dead, prune it. Other errors we keep
    // and log so a transient outage doesn't lose the device.
    const code = e.statusCode;
    if (code === 404 || code === 410) {
      try { db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint); } catch {}
      return { ok: false, pruned: true, code };
    }
    console.warn('[push send] endpoint=' + sub.endpoint.slice(0, 60) + ' code=' + code + ' msg=' + (e.body || e.message));
    return { ok: false, code };
  }
}

async function sendPushToUser(userId, payload) {
  if (!ENABLED) return { sent: 0, pruned: 0, skipped: 'disabled' };
  const subs = db.prepare('SELECT id, endpoint, p256dh, auth, user_id AS subject_id FROM push_subscriptions WHERE user_id = ?').all(userId);
  return _sendMany(subs, payload, 'user');
}

async function sendPushToUsers(userIds, payload) {
  if (!ENABLED || !userIds || !userIds.length) return { sent: 0, pruned: 0 };
  const placeholders = userIds.map(() => '?').join(',');
  const subs = db.prepare(`SELECT id, endpoint, p256dh, auth, user_id AS subject_id FROM push_subscriptions WHERE user_id IN (${placeholders})`).all(...userIds);
  return _sendMany(subs, payload, 'user');
}

async function sendPushToAll(payload) {
  if (!ENABLED) return { sent: 0, pruned: 0, skipped: 'disabled' };
  const subs = db.prepare('SELECT id, endpoint, p256dh, auth, user_id AS subject_id FROM push_subscriptions').all();
  return _sendMany(subs, payload, 'user');
}

// Send to all users who have a given permission flag (e.g. 'purchases').
// Admins always pass. Used to scope a notification to "everyone who can
// see this module" — e.g. only managers + admins see new-PO pushes.
async function sendPushByPermission(permKey, payload) {
  if (!ENABLED) return { sent: 0, pruned: 0, skipped: 'disabled' };
  // Schema check: the column might not exist for newer perms (e.g.
  // warehouse_inbox is added via addColumn). Wrap so a missing column
  // doesn't blow up the whole notification fan-out.
  let users;
  try {
    users = db.prepare(
      `SELECT u.id FROM users u
         LEFT JOIN permissions p ON p.user_id = u.id
        WHERE u.is_active = 1
          AND (u.role = 'admin' OR COALESCE(p.${permKey}, 0) = 1)`
    ).all();
  } catch (e) {
    console.warn('[push] perm column missing: ' + permKey + ' — falling back to admin only');
    users = db.prepare("SELECT id FROM users WHERE is_active = 1 AND role = 'admin'").all();
  }
  return sendPushToUsers(users.map(u => u.id), payload);
}

// The one place every send funnels through, which is why the mute is
// enforced HERE rather than in each caller: a sender added later cannot
// forget it. Every SELECT above aliases its owner column to `subject_id`
// for this filter. A row without one, or a call without a scope, passes
// through unfiltered and behaves exactly as before.
async function _sendMany(subs, payload, scope) {
  let sent = 0, pruned = 0, muted = 0;
  let live = subs;
  if (scope && subs.length) {
    const ids = [...new Set(subs.map(s => s.subject_id).filter(v => v != null))];
    if (ids.length) {
      let mutedIds = new Set();
      try {
        const ph = ids.map(() => '?').join(',');
        mutedIds = new Set(db.prepare(
          `SELECT subject_id FROM push_optouts WHERE scope = ? AND subject_id IN (${ph})`
        ).all(scope, ...ids).map(r => r.subject_id));
      } catch { /* table missing — nobody is muted */ }
      if (mutedIds.size) {
        live = subs.filter(s => !mutedIds.has(s.subject_id));
        muted = subs.length - live.length;
      }
    }
  }
  await Promise.all(live.map(async (s) => {
    const r = await _send(s, payload);
    if (r.ok) sent++;
    if (r.pruned) pruned++;
  }));
  return { sent, pruned, muted, total: subs.length };
}

// ─── Backend-operator push (tenant_users) ──────────────────────────────────
// A separate subscription store from push_subscriptions (which is keyed to
// kitchen `users`). Backing table `tenant_operator_push_subs` is created in
// routes/backend-auth.js. Same VAPID setup + send/prune machinery.
function operatorSubscribe({ tenantUserId, tenantId, endpoint, keys, ua }) {
  if (!ENABLED) return { ok: false, error: 'push not configured' };
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) return { ok: false, error: 'invalid subscription' };
  db.prepare(`INSERT INTO tenant_operator_push_subs (endpoint, tenant_user_id, tenant_id, p256dh, auth, user_agent)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(endpoint) DO UPDATE SET
                tenant_user_id = excluded.tenant_user_id,
                tenant_id      = excluded.tenant_id,
                p256dh         = excluded.p256dh,
                auth           = excluded.auth,
                user_agent     = excluded.user_agent,
                last_seen_at   = CURRENT_TIMESTAMP`)
    .run(endpoint, tenantUserId, tenantId || null, keys.p256dh, keys.auth, String(ua || '').slice(0, 300));
  return { ok: true };
}
// The Tacet toggle (Profile → Notifications) writes this. Because the
// operator and the kitchen user are different logins on the SAME device,
// muting also takes out the kitchen subscription sharing this browser's
// endpoint — otherwise app.html re-enrols on the next load and the pushes
// come back. The kitchen user id is remembered on the operator row so
// switching back on reverses both halves.
function operatorPref(tenantUserId) {
  return { enabled: !isMuted('operator', tenantUserId) };
}
function operatorSetPref(tenantUserId, enabled, endpoint) {
  if (enabled) {
    const linked = mutedLink('operator', tenantUserId);
    if (linked != null) setMuted('user', linked, false);
    setMuted('operator', tenantUserId, false);
    return { ok: true, enabled: true, linkedUserId: linked };
  }
  let linked = null;
  if (endpoint) {
    try {
      const row = db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
      if (row) linked = row.user_id;
    } catch { /* no kitchen subscription on this device */ }
  }
  setMuted('operator', tenantUserId, true, linked);
  if (linked != null) setMuted('user', linked, true);
  if (endpoint) {
    try { db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint); } catch {}
  }
  return { ok: true, enabled: false, linkedUserId: linked };
}
function operatorUnsubscribe(endpoint, tenantUserId) {
  if (!endpoint) return { ok: false };
  db.prepare('DELETE FROM tenant_operator_push_subs WHERE endpoint = ? AND tenant_user_id = ?').run(endpoint, tenantUserId);
  return { ok: true };
}
async function sendPushToOperator(tenantUserId, payload) {
  if (!ENABLED) return { sent: 0, pruned: 0, skipped: 'disabled' };
  const subs = db.prepare('SELECT endpoint, p256dh, auth, tenant_user_id AS subject_id FROM tenant_operator_push_subs WHERE tenant_user_id = ?').all(tenantUserId);
  return _sendMany(subs, payload, 'operator');
}
// FAN OUT TO THE OPERATORS WHO CAN ACT ON THIS, AND ONLY THEM.
//
// sendPushToTenantOperators (below) tells EVERYONE in the tenant, which is right
// for a new customer order and wrong for everything with an audience. The other
// sender, sendPushByPermission, reads `permissions` on the kitchen `users`
// table — a different realm entirely, and the one the transfer notifications
// were written against before the screens moved to Tacet. A tenant operator is
// a tenant_users row with CAPABILITIES, so neither sender could reach the
// warehouse clerk who has to pick a run or the kitchen hand who has to make what
// was asked for. They got nothing, on every event.
//
//   needCaps : capability key or list — an operator holding ANY of them is told.
//   opts.storeId : the location the work is at. An operator pinned to a set of
//                  stores (scope_all = 0) is not told about work at a store they
//                  cannot act on; an unscoped operator hears about all of it.
//   opts.excludeTenantUserId : the person who just pressed the button. They know.
//
// Caps are resolved per operator through lib/operator-caps — the same read the
// request middleware does — and memoised for the call, so a fan-out costs one
// resolution per distinct operator rather than one per device.
async function sendPushToOperatorsWithCaps(tenantId, needCaps, payload, opts = {}) {
  if (!ENABLED || !tenantId) return { sent: 0, pruned: 0, skipped: 'disabled' };
  const need = (Array.isArray(needCaps) ? needCaps : [needCaps]).filter(Boolean);
  if (!need.length) return { sent: 0, pruned: 0, total: 0 };
  let subs = [];
  try {
    subs = db.prepare(`SELECT endpoint, p256dh, auth, tenant_user_id AS subject_id
                         FROM tenant_operator_push_subs WHERE tenant_id = ?`).all(tenantId);
  } catch (e) { return { sent: 0, pruned: 0, error: e.message }; }
  if (!subs.length) return { sent: 0, pruned: 0, total: 0 };

  let tenant = null;
  try { tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId); } catch { tenant = null; }
  const exclude = opts.excludeTenantUserId == null ? null : Number(opts.excludeTenantUserId);
  const storeId = opts.storeId == null ? null : Number(opts.storeId);
  const seen = new Map();
  const eligible = (tenantUserId) => {
    if (seen.has(tenantUserId)) return seen.get(tenantUserId);
    let ok = false;
    try {
      const u = db.prepare('SELECT * FROM tenant_users WHERE id = ? AND is_active = 1').get(tenantUserId);
      if (u) {
        const r = require('../lib/operator-caps').resolveOperator(db, u, tenant);
        const held = new Set(r.caps || []);
        ok = need.some(k => held.has(k));
        // null scopeStores = unscoped = every location.
        if (ok && storeId && Array.isArray(r.scopeStores) && r.scopeStores.indexOf(storeId) === -1) ok = false;
      }
    } catch (e) { ok = false; }
    seen.set(tenantUserId, ok);
    return ok;
  };
  const live = subs.filter(s => s.subject_id != null && s.subject_id !== exclude && eligible(s.subject_id));
  if (!live.length) return { sent: 0, pruned: 0, total: subs.length };
  return _sendMany(live, payload, 'operator');
}

// Fan out to every operator of a tenant (used for new-order alerts). Failed
// endpoints are pruned by _send. Best-effort; callers wrap in try/catch.
async function sendPushToTenantOperators(tenantId, payload) {
  if (!ENABLED || !tenantId) return { sent: 0, pruned: 0, skipped: 'disabled' };
  const subs = db.prepare('SELECT endpoint, p256dh, auth, tenant_user_id AS subject_id FROM tenant_operator_push_subs WHERE tenant_id = ?').all(tenantId);
  return _sendMany(subs, payload, 'operator');
}

module.exports = router;
module.exports.vapidPublicKey = VAPID_PUBLIC;
module.exports.operatorSubscribe = operatorSubscribe;
module.exports.operatorUnsubscribe = operatorUnsubscribe;
module.exports.operatorPref       = operatorPref;
module.exports.operatorSetPref    = operatorSetPref;
module.exports.isMuted            = isMuted;
module.exports.sendPushToOperator = sendPushToOperator;
module.exports.sendPushToTenantOperators = sendPushToTenantOperators;
module.exports.sendPushToOperatorsWithCaps = sendPushToOperatorsWithCaps;
module.exports.sendPushToUser     = sendPushToUser;
module.exports.sendPushToUsers    = sendPushToUsers;
module.exports.sendPushToAll      = sendPushToAll;
module.exports.sendPushByPermission = sendPushByPermission;
module.exports.ENABLED            = ENABLED;
