// Merchant-facing notices — the read side of the platform's broadcast + the
// impersonation indicator. Consumed by the retail-admin shell banner.
//
// Lives on the MERCHANT-backend surface (/api/backend/*) and is scoped to the
// signed-in tenant_users session: it returns only broadcasts addressed to "all"
// or to this operator's own tenant, plus the impersonation state stamped on the
// session by server.js GET /impersonate. No auth gate beyond "is a backend
// operator signed in" — a logged-out request just gets empty results.

const express = require('express');
const db = require('../database');
const router = express.Router();

function within(startsAt, endsAt) {
  const now = Date.now();
  if (startsAt) { const s = Date.parse(String(startsAt).replace(' ', 'T')); if (!isNaN(s) && s > now) return false; }
  if (endsAt)   { const e = Date.parse(String(endsAt).replace(' ', 'T'));   if (!isNaN(e) && e < now) return false; }
  return true;
}

router.get('/api/backend/notices', (req, res) => {
  if (!req.session || !req.session.backendUserId) return res.json({ impersonation: null, broadcasts: [] });
  const tenantId = req.session.tenantId || null;

  let impersonation = null;
  if (req.session.impersonatedBy) {
    const ib = req.session.impersonatedBy;
    const tenant = tenantId ? db.prepare('SELECT name, brand_name FROM tenants WHERE id = ?').get(tenantId) : null;
    impersonation = { by: ib.name || 'platform staff', since: ib.at || null, store: tenant ? (tenant.brand_name || tenant.name) : null };
  }

  let broadcasts = [];
  try {
    const rows = db.prepare(`
      SELECT id, title_en, title_cn, body_en, body_cn, level, starts_at, ends_at
      FROM platform_broadcasts
      WHERE active = 1 AND (audience = 'all' OR (audience = 'tenant' AND tenant_id = ?))
      ORDER BY (level = 'critical') DESC, id DESC LIMIT 5`).all(tenantId);
    broadcasts = rows.filter(r => within(r.starts_at, r.ends_at)).map(r => ({
      id: r.id, titleEn: r.title_en, titleCn: r.title_cn, bodyEn: r.body_en, bodyCn: r.body_cn, level: r.level,
    }));
  } catch (e) { /* platform_broadcasts not present yet → none */ }

  res.json({ impersonation, broadcasts });
});

// ── Support tickets (merchant side) ───────────────────────────────────────
// A merchant operator raises and reads support tickets from their backend; the
// platform triages them in the store-admin Support inbox. Scoped to the signed-
// in operator's own tenant. Tables are created by routes/store-admin.js.
function requireBackend(req, res, next) {
  if (!req.session || !req.session.backendUserId) return res.status(401).json({ error: 'Not signed in · 未登录' });
  next();
}
function operatorName(id) {
  try { const u = db.prepare('SELECT display_name, username FROM tenant_users WHERE id = ?').get(id); return u ? (u.display_name || u.username) : null; }
  catch (e) { return null; }
}

router.get('/api/backend/support', requireBackend, (req, res) => {
  const tenantId = req.session.tenantId || null;
  let tickets = [];
  try {
    const rows = db.prepare("SELECT id, subject, status, last_sender, created_at, updated_at FROM platform_tickets WHERE tenant_id = ? ORDER BY (status = 'resolved') ASC, updated_at DESC LIMIT 50").all(tenantId);
    tickets = rows.map(t => {
      const messages = db.prepare('SELECT sender_kind, sender_name, body, created_at FROM platform_ticket_messages WHERE ticket_id = ? ORDER BY id ASC').all(t.id)
        .map(m => ({ senderKind: m.sender_kind, senderName: m.sender_name, body: m.body, at: m.created_at }));
      return { id: t.id, subject: t.subject, status: t.status, lastSender: t.last_sender, createdAt: t.created_at, updatedAt: t.updated_at, messages };
    });
  } catch (e) { /* tables not present yet → none */ }
  res.json({ success: true, tickets });
});

router.post('/api/backend/support', requireBackend, express.json(), (req, res) => {
  const tenantId = req.session.tenantId || null;
  if (!tenantId) return res.status(400).json({ error: 'No store on this session · 会话缺少店铺' });
  const subject = String((req.body && req.body.subject) || '').trim().slice(0, 160);
  const message = String((req.body && req.body.message) || '').trim();
  if (!message) return res.status(400).json({ error: 'Enter your message · 请输入内容' });
  const name = operatorName(req.session.backendUserId);
  try {
    const info = db.prepare("INSERT INTO platform_tickets (tenant_id, operator_id, operator_name, subject, status, last_sender) VALUES (?,?,?,?,'open','merchant')")
      .run(tenantId, req.session.backendUserId, name, subject || '(no subject)');
    db.prepare("INSERT INTO platform_ticket_messages (ticket_id, sender_kind, sender_name, body) VALUES (?, 'merchant', ?, ?)")
      .run(info.lastInsertRowid, name, message.slice(0, 4000));
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (e) { res.status(503).json({ error: 'Support is not available right now · 客服暂不可用' }); }
});

router.post('/api/backend/support/:id/reply', requireBackend, express.json(), (req, res) => {
  const tenantId = req.session.tenantId || null;
  const k = db.prepare('SELECT id, tenant_id FROM platform_tickets WHERE id = ?').get(req.params.id);
  if (!k || k.tenant_id !== tenantId) return res.status(404).json({ error: 'Ticket not found · 未找到工单' });
  const message = String((req.body && req.body.message) || '').trim();
  if (!message) return res.status(400).json({ error: 'Enter your message · 请输入内容' });
  const name = operatorName(req.session.backendUserId);
  db.prepare("INSERT INTO platform_ticket_messages (ticket_id, sender_kind, sender_name, body) VALUES (?, 'merchant', ?, ?)").run(k.id, name, message.slice(0, 4000));
  db.prepare("UPDATE platform_tickets SET status = 'open', last_sender = 'merchant', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(k.id);
  res.json({ success: true });
});

module.exports = router;
