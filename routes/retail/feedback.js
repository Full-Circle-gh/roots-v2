// Feedback — the mini app's "Found a bug?" form and its reply thread, and the
// admin Feedback inbox. Moved out of routes/retail.js unchanged (decisions
// §470); the code below the line is byte for byte what it was there.
//
// HOW THIS FILE IS WIRED. routes/retail.js mounts it at the spot this section
// used to start, so express tries these endpoints in the same order relative to
// everything that could match the same request. What it needs from retail.js is
// handed in rather than required: retail.js is still loading when it requires
// this file, so `require('../retail')` here would come back empty. Anything from
// lib/ or middleware/ is required directly, as retail.js does.
//
// FEEDBACK_WAITING_SQL stays in retail.js: the dashboard's "Feedback to answer"
// count reads the same clause, and scripts/test_inbox_fires.js holds the two to
// one string. /api/retail-admin/customers/:id/message also writes a feedback
// thread, but it sits under customers and moves with them.
//
// scripts/test_retail_split_routes.js holds this file to its ten endpoints and
// fails if one of them could answer a request an endpoint in another file also
// answers.

const express = require('express');
const { logActivity } = require('../../middleware/auth');
const { tdb } = require('../../lib/tenant-db');
const wxSec = require('../../lib/wx-sec-check');   // WeChat 内容安全 — every customer-published surface

const router = express.Router();

// Filled by the mount call at the bottom. The pass-throughs below are what the
// code is written against, so they exist before anything is handed in.
const NEEDS = ['requireRetailAuth', 'requireRetailAdmin', 'isRiskyText', 'refuseContent',
  'parseJsonArray', 'FEEDBACK_WAITING_SQL', 'notifyCustomer'];
const deps = {};
const requireRetailAuth    = (req, res, next) => deps.requireRetailAuth(req, res, next);
const requireRetailAdmin   = (req, res, next) => deps.requireRetailAdmin(req, res, next);
const isRiskyText          = (...a) => deps.isRiskyText(...a);
const refuseContent        = (...a) => deps.refuseContent(...a);
const parseJsonArray       = (...a) => deps.parseJsonArray(...a);
const FEEDBACK_WAITING_SQL = (...a) => deps.FEEDBACK_WAITING_SQL(...a);
const notifyCustomer       = (...a) => deps.notifyCustomer(...a);

// ────────────────────────────────────────────────────────────────────────────
// Customer submits a bug report / feedback from the mini app "Found a bug?"
// form. One-way: it lands read-only in the Mini App Backend → Feedback tab
// (separate from the staff `feedback` table). Photos arrive as already-uploaded
// /api/retail/media/:id URLs (same uploader as reviews: base64 → retail_media).
router.post('/api/retail/feedback', requireRetailAuth, express.json({ limit: '1mb' }), async (req, res) => {
  const message = (req.body?.message || '').toString().trim().slice(0, 4000);
  if (!message) return res.status(400).json({ success: false, error: 'message_required' });
  // Staff read this, and staff reply to it in a thread the customer sees back,
  // so it counts as published content for the audit. Photos were already
  // submitted by the uploader they share with reviews.
  if (await isRiskyText(req.customer, message, wxSec.SCENE.COMMENT)) return refuseContent(res);
  const pageContext = (req.body?.page_context || '').toString().slice(0, 200) || null;
  const appVersion  = (req.body?.app_version  || '').toString().slice(0, 60)  || null;
  // Keep only our own media URLs — drop anything that isn't a /api/retail/media/:id
  // path so a client can't stash arbitrary links in the inbox.
  const photos = Array.isArray(req.body?.photos)
    ? req.body.photos
        .filter(u => typeof u === 'string' && /^\/api\/retail\/media\/\d+$/.test(u))
        .slice(0, 6)
    : [];
  const name = req.customer?.nickname || ('#' + req.customer.id);
  try {
    const info = tdb().prepare(
      `INSERT INTO retail_feedback (customer_id, customer_name, message, photos_json, page_context, app_version, last_customer_msg_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(req.customer.id, name, message, photos.length ? JSON.stringify(photos) : null, pageContext, appVersion);
    res.json({ success: true, data: { id: info.lastInsertRowid } });
  } catch (e) {
    console.error('[retail/feedback] insert failed:', e.message);
    res.status(500).json({ success: false, error: 'db_insert_failed' });
  }
});

// Shape one feedback report + its reply turns into a thread the mini app and
// the backend drawer both render. The root row is presented as the customer's
// first message; retail_feedback_messages carry every later turn.
function buildFeedbackThread(row) {
  const msgs = tdb().prepare(
    `SELECT id, author, author_name, body, created_at
       FROM retail_feedback_messages
      WHERE feedback_id = ? ORDER BY id ASC`
  ).all(row.id);
  return {
    id: row.id,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    page_context: row.page_context,
    app_version: row.app_version,
    created_at: row.created_at,
    photos: parseJsonArray(row.photos_json),
    kind: row.kind || 'bug',
    initiated_by: row.initiated_by || 'customer',
    // Read and judged to need no answer. Sent as plain state rather than
    // re-derived on the client: the client cannot see handled_at, and guessing
    // it from the turn list gets a staff-initiated thread wrong every time.
    //
    // The drawer's footer button flips on this one fact and nothing else.
    // Deliberately NOT paired with a "is it still waiting" flag: this route
    // stamps admin_read_at on the way past, so by the time anything here is
    // computed the thread is no longer waiting BECAUSE IT WAS JUST OPENED — a
    // flag read after that would say "handled" about every thread anyone looks
    // at, which is the exact confusion handled_at exists to end.
    handled: !!row.handled_at,
    messages: [
      // The root turn, normalised into the same shape as a reply turn. It's the
      // customer's first message on a bug report, or the operator's opener on an
      // admin-initiated direct message — initiated_by/root_author_name say which.
      {
        id: 0,
        author: row.initiated_by === 'admin' ? 'admin' : 'customer',
        author_name: row.initiated_by === 'admin' ? (row.root_author_name || null) : null,
        body: row.message,
        created_at: row.created_at,
      },
      ...msgs,
    ],
  };
}

// Customer lists their own reports (newest activity first) so they can find a
// thread the store replied to without hunting through the notification inbox.
// `unread` flags a thread with an operator reply newer than their last read.
router.get('/api/retail/feedback', requireRetailAuth, (req, res) => {
  const rows = tdb().prepare(
    `SELECT id, message, photos_json, created_at, last_admin_msg_at,
            (SELECT COUNT(*) FROM retail_feedback_messages m WHERE m.feedback_id = f.id) AS reply_count,
            (last_admin_msg_at IS NOT NULL
               AND (customer_read_at IS NULL
                    OR datetime(last_admin_msg_at) > datetime(customer_read_at))) AS unread
       FROM retail_feedback f
      WHERE customer_id = ?
   ORDER BY COALESCE(last_admin_msg_at, last_customer_msg_at, created_at) DESC
      LIMIT 50`
  ).all(req.customer.id).map(f => ({
    id: f.id,
    message: f.message,
    photos: parseJsonArray(f.photos_json),
    created_at: f.created_at,
    reply_count: f.reply_count,
    last_admin_msg_at: f.last_admin_msg_at,
    unread: !!f.unread,
  }));
  res.json({ success: true, data: rows });
});

// Customer opens one of their threads. Stamps customer_read_at so the "new
// reply" dot clears. 404 (not 403) for someone else's report — don't leak
// that the id exists.
router.get('/api/retail/feedback/:id', requireRetailAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = tdb().prepare('SELECT * FROM retail_feedback WHERE id = ? AND customer_id = ?').get(id, req.customer.id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  // Stamp only when a store reply is still unread. Opening an already-read
  // thread used to write customer_read_at every time, and the page now
  // re-reads while it stays open so a reply from the other device appears.
  // A write on every re-read would be a write per poll for a dot that had
  // already gone out. The unread test is the same one the list uses.
  const unread = row.last_admin_msg_at && (!row.customer_read_at
    || String(row.last_admin_msg_at) > String(row.customer_read_at));
  if (unread) tdb().prepare('UPDATE retail_feedback SET customer_read_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  res.json({ success: true, data: buildFeedbackThread(row) });
});

// Customer adds a follow-up turn to their own thread.
router.post('/api/retail/feedback/:id/reply', requireRetailAuth, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = (req.body?.message || '').toString().trim().slice(0, 4000);
  if (!body) return res.status(400).json({ success: false, error: 'message_required' });
  const row = tdb().prepare('SELECT id FROM retail_feedback WHERE id = ? AND customer_id = ?').get(id, req.customer.id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  try {
    tdb().prepare(
      `INSERT INTO retail_feedback_messages (feedback_id, author, body) VALUES (?, 'customer', ?)`
    ).run(id, body);
    tdb().prepare('UPDATE retail_feedback SET last_customer_msg_at = CURRENT_TIMESTAMP, customer_read_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (e) {
    console.error('[retail/feedback reply] insert failed:', e.message);
    res.status(500).json({ success: false, error: 'db_insert_failed' });
  }
});

// Customer bug reports / feedback from the mini app "Found a bug?" form.
// Read-only inbox — newest first. Separate from the staff `feedback` table.
router.get('/api/retail-admin/feedback', requireRetailAdmin, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '100', 10) || 100, 300);
  const offset = Math.max(parseInt(req.query.offset || '0',   10) || 0, 0);
  const rows = tdb().prepare(
    `SELECT f.id, f.customer_id, f.customer_name, f.message,
            f.photos_json, f.page_context, f.app_version, f.created_at, f.kind,
            f.initiated_by, f.root_author_name,
            f.last_customer_msg_at, f.last_admin_msg_at, f.admin_read_at, f.handled_at,
            c.nickname AS nickname, c.avatar_url AS customer_avatar,
            (SELECT COUNT(*) FROM retail_feedback_messages m WHERE m.feedback_id = f.id) AS reply_count,
            -- The newest turn in the thread. Without this the row can only show
            -- the root message, which on a staff-initiated thread is the
            -- operator's own opener — replaying their words back at them and
            -- hiding the customer's answer. NULL until somebody replies.
            (SELECT m.body        FROM retail_feedback_messages m WHERE m.feedback_id = f.id ORDER BY m.id DESC LIMIT 1) AS last_body,
            (SELECT m.author      FROM retail_feedback_messages m WHERE m.feedback_id = f.id ORDER BY m.id DESC LIMIT 1) AS last_author,
            (SELECT m.author_name FROM retail_feedback_messages m WHERE m.feedback_id = f.id ORDER BY m.id DESC LIMIT 1) AS last_author_name,
            (SELECT m.created_at  FROM retail_feedback_messages m WHERE m.feedback_id = f.id ORDER BY m.id DESC LIMIT 1) AS last_at,
            -- FEEDBACK_WAITING_SQL, the same clause the dashboard's fire counts
            -- and the Inbox reads. Covers a brand-new report, a fresh follow-up,
            -- and the thread an operator marked handled without replying.
            (${FEEDBACK_WAITING_SQL('f')}) AS needs_reply
       FROM retail_feedback f
  LEFT JOIN retail_customers c ON c.id = f.customer_id
   ORDER BY COALESCE(f.last_customer_msg_at, f.last_admin_msg_at, f.created_at) DESC
      LIMIT ? OFFSET ?`
  ).all(limit, offset).map(f => {
    // No replies yet → the newest turn is the root. initiated_by says who wrote
    // it: the customer on a bug report, an operator on a direct message.
    const rootIsAdmin = (f.initiated_by || 'customer') === 'admin';
    const hasReply = f.last_author != null;
    return {
      ...f,
      photos: parseJsonArray(f.photos_json),
      photos_json: undefined,
      initiated_by: f.initiated_by || 'customer',
      last_body: hasReply ? f.last_body : f.message,
      last_author: hasReply ? f.last_author : (rootIsAdmin ? 'admin' : 'customer'),
      last_author_name: hasReply ? f.last_author_name : (rootIsAdmin ? f.root_author_name : null),
      last_at: hasReply ? f.last_at : f.created_at,
      replied: !!f.last_admin_msg_at,
      needs_reply: !!f.needs_reply,
      // Read and judged to need no answer. The row decides what to DO with that
      // — needs_reply and replied both outrank it in the status pill, so this
      // only ever surfaces on a thread that left the queue without an answer.
      handled: !!f.handled_at,
    };
  });
  const total = tdb().prepare('SELECT COUNT(*) AS n FROM retail_feedback').get().n;
  res.json({ success: true, data: rows, meta: { total, limit, offset } });
});

// Unseen bug reports since the client's last-seen time — red dot + chime on
// the Inbox › Feedback sub-tab, mirroring the new-order notification.
router.get('/api/retail-admin/feedback/unseen-count', requireRetailAdmin, (req, res) => {
  const since = String(req.query.since || '').trim();
  const sinceSql = since || '1970-01-01T00:00:00.000Z';
  // New reports AND customer follow-up replies both count — either is a turn
  // waiting on the operator.
  // Only customer-authored turns count toward the operator's "waiting" dot: a
  // brand-new customer report (initiated_by='customer') or any customer reply.
  // An admin-initiated direct message must not ping the admin's own counter.
  const row = tdb().prepare(
    `SELECT
       (SELECT COUNT(*) FROM retail_feedback
          WHERE COALESCE(initiated_by, 'customer') = 'customer'
            AND datetime(created_at) > datetime(?))
       + (SELECT COUNT(*) FROM retail_feedback_messages
          WHERE author = 'customer' AND datetime(created_at) > datetime(?)) AS n,
       (SELECT MAX(t) FROM (
          SELECT MAX(created_at) AS t FROM retail_feedback
            WHERE COALESCE(initiated_by, 'customer') = 'customer'
          UNION ALL
          SELECT MAX(created_at) AS t FROM retail_feedback_messages WHERE author = 'customer'
       )) AS latest`
  ).get(sinceSql, sinceSql);
  res.json({ success: true, data: { count: row.n || 0, latest: row.latest || null } });
});

// Operator opens one report's thread. Stamps admin_read_at so the "needs
// reply" flag clears once it's been looked at.
router.get('/api/retail-admin/feedback/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = tdb().prepare('SELECT * FROM retail_feedback WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  tdb().prepare('UPDATE retail_feedback SET admin_read_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  res.json({ success: true, data: buildFeedbackThread(row) });
});

// Operator read the thread and decided it needs no answer. Stamps handled_at,
// which takes it out of FEEDBACK_WAITING_SQL — off the dashboard's "Feedback to
// answer" row, off the Inbox's "Needs reply" pill, off the phone.
//
// NOTHING IS SENT. That is the whole point of the column: the only other way to
// clear this queue was to write a reply, and a reply goes into the customer's
// in-app inbox with a push behind it. Clearing a worklist should not put words
// in front of someone who is owed none.
//
// Single-thread only, and there is deliberately no bulk version. Reviews have
// one because that queue arrives 300 at a time and is mostly five-star
// thank-yous. A feedback thread is one person writing to the shop directly; a
// sweep across those is how a real complaint gets buried under a click nobody
// remembers making.
//
// Logged with the thread id so "who decided this needed no answer" has an
// answer that is not a shrug.
router.post('/api/retail-admin/feedback/:id/handled', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = tdb().prepare('SELECT id FROM retail_feedback WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  // admin_read_at moves too. Whoever clicked this has, by definition, read the
  // thread, and leaving the read stamp behind would mean the two clauses tell
  // different stories about the same click.
  tdb().prepare(
    'UPDATE retail_feedback SET handled_at = CURRENT_TIMESTAMP, admin_read_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(id);
  logActivity(req.user.id, req.user.username, 'feedback_handled', 'retail_feedback', id, {}, req.ip);
  res.json({ success: true });
});

// Put one back in the queue. Pairs with the action above for the same reason
// review undismiss does: without it, an accidental click could only be undone by
// writing a reply to the customer — the exact thing marking it handled exists to
// avoid.
//
// Clearing admin_read_at as well is what actually puts it back. handled_at alone
// is not what holds the thread out of the queue; the LATER of the two stamps is,
// and on a thread just marked handled that is whichever of them we leave behind.
router.post('/api/retail-admin/feedback/:id/unhandle', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = tdb().prepare('SELECT id FROM retail_feedback WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  tdb().prepare(
    'UPDATE retail_feedback SET handled_at = NULL, admin_read_at = NULL WHERE id = ?'
  ).run(id);
  logActivity(req.user.id, req.user.username, 'feedback_unhandle', 'retail_feedback', id, {}, req.ip);
  res.json({ success: true });
});

// Operator replies to a report. Writes the turn, stamps the thread, and drops
// an in-app notification into the customer's inbox (the same channel order /
// refund updates use) so they see it next time they open the mini app.
router.post('/api/retail-admin/feedback/:id/reply', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = (req.body?.message || '').toString().trim().slice(0, 4000);
  if (!body) return res.status(400).json({ success: false, error: 'message_required' });
  const row = tdb().prepare('SELECT id, customer_id FROM retail_feedback WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  const authorName = (req.user && (req.user.display_name || req.user.username)) || null;
  try {
    tdb().prepare(
      `INSERT INTO retail_feedback_messages (feedback_id, author, author_name, body)
       VALUES (?, 'admin', ?, ?)`
    ).run(id, authorName, body);
    tdb().prepare(
      'UPDATE retail_feedback SET last_admin_msg_at = CURRENT_TIMESTAMP, admin_read_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(id);
    // Notify the customer (in-app inbox; deep-links to the thread page).
    const snippet = body.length > 120 ? body.slice(0, 119) + '…' : body;
    notifyCustomer(row.customer_id, {
      category: 'feedback',
      type: 'feedback_reply',
      title_en: 'We replied to your report',
      title_cn: '我们回复了你的反馈',
      body_en: snippet,
      body_cn: snippet,
      ref_type: 'feedback',
      ref_id: id,
    });
    res.json({ success: true });
  } catch (e) {
    console.error('[retail-admin/feedback reply] insert failed:', e.message);
    res.status(500).json({ success: false, error: 'db_insert_failed' });
  }
});

module.exports = function mountFeedback(d) {
  for (const k of NEEDS) {
    if (typeof d[k] !== 'function') throw new Error('routes/retail/feedback: ' + k + ' was not handed in');
  }
  Object.assign(deps, d);
  return router;
};
