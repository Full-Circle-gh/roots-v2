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
const db = require('../database');
const { requireAuth, logActivity } = require('../middleware/auth');
const router = express.Router();

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
  const subs = db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId);
  return _sendMany(subs, payload);
}

async function sendPushToUsers(userIds, payload) {
  if (!ENABLED || !userIds || !userIds.length) return { sent: 0, pruned: 0 };
  const placeholders = userIds.map(() => '?').join(',');
  const subs = db.prepare(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${placeholders})`).all(...userIds);
  return _sendMany(subs, payload);
}

async function sendPushToAll(payload) {
  if (!ENABLED) return { sent: 0, pruned: 0, skipped: 'disabled' };
  const subs = db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions').all();
  return _sendMany(subs, payload);
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

async function _sendMany(subs, payload) {
  let sent = 0, pruned = 0;
  await Promise.all(subs.map(async (s) => {
    const r = await _send(s, payload);
    if (r.ok) sent++;
    if (r.pruned) pruned++;
  }));
  return { sent, pruned, total: subs.length };
}

module.exports = router;
module.exports.sendPushToUser     = sendPushToUser;
module.exports.sendPushToUsers    = sendPushToUsers;
module.exports.sendPushToAll      = sendPushToAll;
module.exports.sendPushByPermission = sendPushByPermission;
module.exports.ENABLED            = ENABLED;
