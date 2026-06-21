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

module.exports = router;
