// Staff feedback / bug reports. Anyone logged in can submit; admin sees
// the inbox and drives the status workflow:
//   new → seen → in_progress → done   (or → wont_do)
//
// Submit endpoint accepts attachments inline as base64 data URIs in the
// JSON body (matches the rest of the codebase — product images, supplier
// docs etc. are all stored the same way, keeping .db backups self-contained).
//
// Side effects on submit:  push fan-out to all admins + SSE 'feedback' event.
// Side effect on status=done:  push back to the reporter so they know it
// landed without having to refresh.

const express = require('express');
// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { requireAuth, requireAdmin, logActivity } = require('../middleware/auth');
const router = express.Router();

const VALID_CATEGORIES = new Set(['bug', 'feature', 'question', 'other']);
const VALID_STATUSES   = new Set(['new', 'seen', 'in_progress', 'done', 'wont_do']);

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;  // 5 MB per file (raw)
const MAX_ATTACHMENTS      = 6;
const MAX_TITLE_LEN        = 200;
const MAX_DESC_LEN         = 5000;
const MAX_NOTE_LEN         = 2000;

// Lazy require so a circular pull (feedback → push → … ) can never deadlock.
function _push() { try { return require('./push'); } catch { return null; } }
function _events() { try { return require('./events'); } catch { return null; } }

// ─── Helpers ─────────────────────────────────────────────────────────────
function _isAdmin(req) { return req.user?.role === 'admin'; }

function _rowToOut(row) {
  if (!row) return null;
  return {
    id:            row.id,
    reporter_id:   row.reporter_id,
    reporter_name: row.reporter_name,
    title:         row.title,
    description:   row.description,
    category:      row.category,
    status:        row.status,
    owner_note:    row.owner_note,
    page_context:  row.page_context,
    created_at:    row.created_at,
    updated_at:    row.updated_at,
    seen_at:       row.seen_at,
    done_at:       row.done_at,
    attachment_count: row.attachment_count || 0,
  };
}

// Decode a data URI to bytes count. Returns -1 on a malformed value so we
// can reject without trusting the client-supplied size hint.
function _approxBytes(dataUri) {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(dataUri || '');
  if (!m) return -1;
  const b64 = m[2];
  // base64 length × 3/4 rounded down ≈ raw byte count
  return Math.floor(b64.length * 3 / 4);
}
function _mimeOf(dataUri) {
  const m = /^data:([^;]+);base64,/i.exec(dataUri || '');
  return m ? m[1] : null;
}

// ─── Submit ───────────────────────────────────────────────────────────────
// POST /api/feedback
// body: { title, description?, category?, page_context?, attachments?:[{filename, data}] }
router.post('/api/feedback', requireAuth, async (req, res) => {
  try {
    let { title, description, category, page_context, attachments } = req.body || {};
    title = (title || '').trim();
    if (!title) return res.status(400).json({ error: 'Title required · 标题必填' });
    if (title.length > MAX_TITLE_LEN) title = title.slice(0, MAX_TITLE_LEN);
    description = (description || '').trim().slice(0, MAX_DESC_LEN);
    page_context = (page_context || '').toString().slice(0, 200);
    category = (category || 'bug').toLowerCase();
    if (!VALID_CATEGORIES.has(category)) category = 'other';

    attachments = Array.isArray(attachments) ? attachments.slice(0, MAX_ATTACHMENTS) : [];
    // Validate each attachment up-front so we don't write a partial row.
    for (const a of attachments) {
      const bytes = _approxBytes(a?.data);
      if (bytes < 0)                       return res.status(400).json({ error: 'Bad attachment · 附件格式错误' });
      if (bytes > MAX_ATTACHMENT_BYTES)    return res.status(400).json({ error: `Attachment too large (max ${MAX_ATTACHMENT_BYTES/1024/1024} MB) · 附件过大` });
    }

    const reporterName = req.user.display_name || req.user.username || ('User ' + req.user.id);
    const tx = db.transaction(() => {
      const r = db.prepare(`INSERT INTO feedback
        (reporter_id, reporter_name, title, description, category, status, page_context)
        VALUES (?, ?, ?, ?, ?, 'new', ?)`)
        .run(req.user.id, reporterName, title, description || null, category, page_context || null);
      const id = r.lastInsertRowid;
      if (attachments.length) {
        const ins = db.prepare(`INSERT INTO feedback_attachments
          (feedback_id, filename, mime_type, size_bytes, data) VALUES (?, ?, ?, ?, ?)`);
        for (const a of attachments) {
          ins.run(id, (a.filename || 'image').slice(0, 200), _mimeOf(a.data) || 'image/jpeg', _approxBytes(a.data), a.data);
        }
      }
      return id;
    });
    const id = tx();

    logActivity(req.user.id, req.user.username, 'create', 'feedback', id,
      { title, category, attachments: attachments.length }, req.ip);

    // Real-time fan-out — SSE to anyone listening (admins react instantly).
    try {
      _events()?.broadcast('feedback', {
        kind: 'created',
        id, title, category,
        reporter_id: req.user.id,
        reporter_name: reporterName,
        page_context: page_context || null,
        created_at: new Date().toISOString(),
      }, { excludeUserId: req.user.id });
    } catch {}

    // OS-level push to every admin. Excluded from sender so an admin who
    // submits their own feedback doesn't get pinged for it.
    try {
      const admins = db.prepare("SELECT id FROM users WHERE is_active = 1 AND role = 'admin' AND id != ?").all(req.user.id);
      if (admins.length) {
        _push()?.sendPushToUsers(admins.map(u => u.id), {
          title: '🐞 New feedback · 新反馈',
          body: `${reporterName}: ${title}`,
          url: '/#feedback',
          tag: 'roots-feedback-' + id,
        });
      }
    } catch (e) { console.warn('[feedback] push fan-out failed:', e.message); }

    res.json({ success: true, id });
  } catch (e) {
    console.error('[POST /api/feedback]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── List ─────────────────────────────────────────────────────────────────
// GET /api/feedback?status=new|all&scope=mine|all
// Admin: scope=all (default for admin). Staff: forced to scope=mine.
router.get('/api/feedback', requireAuth, (req, res) => {
  const status = (req.query.status || 'all').toLowerCase();
  const scope  = _isAdmin(req)
    ? ((req.query.scope || 'all').toLowerCase())
    : 'mine';
  const wh = [];
  const args = [];
  if (scope === 'mine') { wh.push('f.reporter_id = ?'); args.push(req.user.id); }
  if (status !== 'all' && VALID_STATUSES.has(status)) { wh.push('f.status = ?'); args.push(status); }
  const sql = `
    SELECT f.*,
      (SELECT COUNT(*) FROM feedback_attachments a WHERE a.feedback_id = f.id) AS attachment_count
      FROM feedback f
      ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
      ORDER BY
        CASE f.status
          WHEN 'new' THEN 0 WHEN 'seen' THEN 1 WHEN 'in_progress' THEN 2
          WHEN 'done' THEN 3 WHEN 'wont_do' THEN 4 ELSE 5 END,
        f.created_at DESC
      LIMIT 500`;
  try {
    const rows = db.prepare(sql).all(...args);
    res.json({ success: true, data: rows.map(_rowToOut) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/feedback/unread-count
// Admin: number of `new` items they haven't acknowledged.
// Staff:  number of THEIR items that flipped to `done` since last check
//         (TODO; for now reports 0 for staff — they see status in the panel).
router.get('/api/feedback/unread-count', requireAuth, (req, res) => {
  try {
    if (_isAdmin(req)) {
      const r = db.prepare("SELECT COUNT(*) AS c FROM feedback WHERE status = 'new'").get();
      return res.json({ success: true, count: r.c || 0 });
    }
    res.json({ success: true, count: 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Get one (with attachments) ──────────────────────────────────────────
router.get('/api/feedback/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Bad id' });
  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!_isAdmin(req) && row.reporter_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const atts = db.prepare(
    'SELECT id, filename, mime_type, size_bytes, uploaded_at FROM feedback_attachments WHERE feedback_id = ? ORDER BY id'
  ).all(id);
  res.json({ success: true, data: { ..._rowToOut(row), attachments: atts } });
});

// GET /api/feedback/:id/attachments/:attId  — binary data (data URI inlined)
router.get('/api/feedback/:id/attachments/:attId', requireAuth, (req, res) => {
  const id    = parseInt(req.params.id, 10);
  const attId = parseInt(req.params.attId, 10);
  if (!id || !attId) return res.status(400).json({ error: 'Bad id' });
  const row = db.prepare('SELECT reporter_id FROM feedback WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!_isAdmin(req) && row.reporter_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const a = db.prepare('SELECT mime_type, data FROM feedback_attachments WHERE id = ? AND feedback_id = ?').get(attId, id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  // Stored as `data:MIME;base64,XXX`. Decode and stream as the actual MIME
  // so <img src="…/attachments/N"> works for clients that want a URL.
  const m = /^data:([^;]+);base64,(.+)$/i.exec(a.data);
  if (!m) return res.status(500).json({ error: 'Corrupt attachment' });
  res.set('Content-Type', m[1]);
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.from(m[2], 'base64'));
});

// ─── Status transitions (admin only) ─────────────────────────────────────
// PATCH /api/feedback/:id/status   { status, owner_note? }
router.patch('/api/feedback/:id/status', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Bad id' });
  const status = (req.body?.status || '').toLowerCase();
  if (!VALID_STATUSES.has(status)) return res.status(400).json({ error: 'Bad status' });
  const owner_note = req.body?.owner_note != null
    ? String(req.body.owner_note).slice(0, MAX_NOTE_LEN)
    : undefined;
  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const sets = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
  const args = [status];
  if (status === 'seen' && !row.seen_at)    sets.push("seen_at = CURRENT_TIMESTAMP");
  if (status === 'done' && !row.done_at)    sets.push("done_at = CURRENT_TIMESTAMP");
  if (owner_note !== undefined)             { sets.push('owner_note = ?'); args.push(owner_note); }
  args.push(id);
  db.prepare(`UPDATE feedback SET ${sets.join(', ')} WHERE id = ?`).run(...args);

  logActivity(req.user.id, req.user.username, 'update', 'feedback', id,
    { status, owner_note_set: owner_note !== undefined }, req.ip);

  // SSE so the staff Sprout panel updates without a manual refresh.
  try {
    _events()?.broadcast('feedback', { kind: 'status', id, status }, {});
  } catch {}

  // Push back to the reporter when their item flips to done — closes
  // the loop so they know it was actually fixed.
  if (status === 'done' && row.reporter_id !== req.user.id) {
    try {
      _push()?.sendPushToUser(row.reporter_id, {
        title: '✅ Feedback resolved · 反馈已处理',
        body: row.title,
        url: '/#feedback',
        tag: 'roots-feedback-done-' + id,
      });
    } catch (e) { console.warn('[feedback] reporter push failed:', e.message); }
  }

  res.json({ success: true });
});

// ─── Comments thread ──────────────────────────────────────────────────────
// Owner ↔ reporter conversation on a single feedback item. Visible to
// the reporter and to admins; nobody else. Each post fans out:
//   * SSE event so the other side's open modal live-appends the bubble
//   * Push notification to the other party (admin → reporter or reverse)
const MAX_COMMENT_LEN = 2000;

router.get('/api/feedback/:id/comments', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Bad id' });
  const fb = db.prepare('SELECT reporter_id, title FROM feedback WHERE id = ?').get(id);
  if (!fb) return res.status(404).json({ error: 'Not found' });
  if (!_isAdmin(req) && fb.reporter_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const rows = db.prepare(
    'SELECT id, author_id, author_name, author_role, body, created_at FROM feedback_comments WHERE feedback_id = ? ORDER BY id ASC'
  ).all(id);
  // Attach photos to each comment (one round-trip; tiny rows).
  const attRows = db.prepare(`
    SELECT a.id, a.comment_id, a.filename, a.mime_type, a.size_bytes
      FROM feedback_comment_attachments a
      JOIN feedback_comments c ON c.id = a.comment_id
     WHERE c.feedback_id = ?
     ORDER BY a.id ASC`).all(id);
  const byComment = new Map();
  for (const a of attRows) {
    if (!byComment.has(a.comment_id)) byComment.set(a.comment_id, []);
    byComment.get(a.comment_id).push({ id: a.id, filename: a.filename, mime_type: a.mime_type, size_bytes: a.size_bytes });
  }
  for (const r of rows) r.attachments = byComment.get(r.id) || [];
  res.json({ success: true, data: rows });
});

// GET /api/feedback/:id/comments/:cid/attachments/:attId — binary stream.
router.get('/api/feedback/:id/comments/:cid/attachments/:attId', requireAuth, (req, res) => {
  const id    = parseInt(req.params.id, 10);
  const cid   = parseInt(req.params.cid, 10);
  const attId = parseInt(req.params.attId, 10);
  if (!id || !cid || !attId) return res.status(400).json({ error: 'Bad id' });
  const fb = db.prepare('SELECT reporter_id FROM feedback WHERE id = ?').get(id);
  if (!fb) return res.status(404).json({ error: 'Not found' });
  if (!_isAdmin(req) && fb.reporter_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const a = db.prepare(`
    SELECT a.mime_type, a.data
      FROM feedback_comment_attachments a
      JOIN feedback_comments c ON c.id = a.comment_id
     WHERE a.id = ? AND c.id = ? AND c.feedback_id = ?`).get(attId, cid, id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const m = /^data:([^;]+);base64,(.+)$/i.exec(a.data);
  if (!m) return res.status(500).json({ error: 'Corrupt attachment' });
  res.set('Content-Type', m[1]);
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.from(m[2], 'base64'));
});

router.post('/api/feedback/:id/comments', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Bad id' });
  const body = (req.body?.body || '').toString().trim();
  let attachments = Array.isArray(req.body?.attachments) ? req.body.attachments.slice(0, MAX_ATTACHMENTS) : [];
  // A reply may be photos-only — accept empty body when at least one image is attached.
  if (!body && !attachments.length) return res.status(400).json({ error: 'Empty comment · 内容必填' });
  const trimmed = body.slice(0, MAX_COMMENT_LEN);
  // Validate each attachment up-front so we don't leave a half-written row.
  for (const a of attachments) {
    const bytes = _approxBytes(a?.data);
    if (bytes < 0)                    return res.status(400).json({ error: 'Bad attachment · 附件格式错误' });
    if (bytes > MAX_ATTACHMENT_BYTES) return res.status(400).json({ error: `Attachment too large (max ${MAX_ATTACHMENT_BYTES/1024/1024} MB) · 附件过大` });
  }
  const fb = db.prepare('SELECT id, reporter_id, reporter_name, title FROM feedback WHERE id = ?').get(id);
  if (!fb) return res.status(404).json({ error: 'Not found' });
  const isAdmin = _isAdmin(req);
  if (!isAdmin && fb.reporter_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const authorName = req.user.display_name || req.user.username || ('User ' + req.user.id);
  const role = isAdmin ? 'admin' : 'staff';
  let savedAtts = [];
  const tx = db.transaction(() => {
    const r = db.prepare(
      'INSERT INTO feedback_comments (feedback_id, author_id, author_name, author_role, body) VALUES (?, ?, ?, ?, ?)'
    ).run(id, req.user.id, authorName, role, trimmed);
    const cid = r.lastInsertRowid;
    if (attachments.length) {
      const ins = db.prepare(`INSERT INTO feedback_comment_attachments
        (comment_id, filename, mime_type, size_bytes, data) VALUES (?, ?, ?, ?, ?)`);
      for (const a of attachments) {
        const filename = (a.filename || 'image').slice(0, 200);
        const mime = _mimeOf(a.data) || 'image/jpeg';
        const bytes = _approxBytes(a.data);
        const ar = ins.run(cid, filename, mime, bytes, a.data);
        savedAtts.push({ id: ar.lastInsertRowid, filename, mime_type: mime, size_bytes: bytes });
      }
    }
    db.prepare("UPDATE feedback SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    return cid;
  });
  const commentId = tx();

  logActivity(req.user.id, req.user.username, 'comment', 'feedback', id,
    { length: trimmed.length, attachments: savedAtts.length }, req.ip);

  // SSE — the other party's open detail panel will refresh.
  try {
    _events()?.broadcast('feedback', {
      kind: 'comment', id,
      comment: { id: commentId, author_id: req.user.id, author_name: authorName, author_role: role, body: trimmed, created_at: new Date().toISOString(), attachments: savedAtts },
    }, { excludeUserId: req.user.id });
  } catch {}

  // Push to the other side. Admin replied → ping the reporter. Reporter
  // replied → ping all admins (except themselves).
  try {
    const attHint = savedAtts.length ? `📎${savedAtts.length} ` : '';
    const previewSource = trimmed || (savedAtts.length ? `(${savedAtts.length} photo${savedAtts.length>1?'s':''})` : '');
    const preview = attHint + (previewSource.length > 80 ? previewSource.slice(0, 80) + '…' : previewSource);
    if (isAdmin && fb.reporter_id !== req.user.id) {
      _push()?.sendPushToUser(fb.reporter_id, {
        title: '💬 Reply on your feedback · 反馈回复',
        body: `${authorName}: ${preview}`,
        url: '/#feedback',
        tag: 'roots-feedback-cm-' + id,
      });
    } else if (!isAdmin) {
      const admins = db.prepare("SELECT id FROM users WHERE is_active = 1 AND role = 'admin' AND id != ?").all(req.user.id);
      if (admins.length) {
        _push()?.sendPushToUsers(admins.map(u => u.id), {
          title: '💬 ' + (fb.title || 'Feedback') + ' · 新回复',
          body: `${authorName}: ${preview}`,
          url: '/#feedback',
          tag: 'roots-feedback-cm-' + id,
        });
      }
    }
  } catch (e) { console.warn('[feedback comment] push failed:', e.message); }

  res.json({ success: true, id: commentId });
});

// ─── Delete (admin only) ──────────────────────────────────────────────────
router.delete('/api/feedback/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Bad id' });
  const r = db.prepare('DELETE FROM feedback WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  logActivity(req.user.id, req.user.username, 'delete', 'feedback', id, null, req.ip);
  try { _events()?.broadcast('feedback', { kind: 'deleted', id }, {}); } catch {}
  res.json({ success: true });
});

module.exports = router;
