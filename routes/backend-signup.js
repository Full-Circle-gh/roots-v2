// Mini App Backend — tenant signup / provisioning (Phase 2).
//
// Gated during Phase 2: open to the public only when BACKEND_SIGNUP_OPEN=1,
// otherwise a kitchen `admin` may provision (so you can create test tenants).
// Public signup stays closed until per-tenant data isolation is cut over
// (TENANT_DATA_ISOLATION=1) — see tenant-db.js — so no leaky tenant can exist.

const express = require('express');
const rateLimit = require('express-rate-limit');
// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_batch.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { provisionTenant } = require('../lib/provision-tenant');
const { requirePlatformAdmin, logAudit } = require('../lib/platform-admin');
const router = express.Router();

const SIGNUP_OPEN = () => process.env.BACKEND_SIGNUP_OPEN === '1';

// Public company self-signup is intentionally NOT open: business data is not yet
// tenant-scoped (see backend-auth.js / tenant-db.js), so an unvetted tenant could
// share another's data. Until TENANT_DATA_ISOLATION is cut over, the public
// /backend/signup page is a WAITLIST: it captures the lead here and provisions
// nothing. The platform owner reviews requests in saas-admin and provisions by
// hand. When isolation lands, flip BACKEND_SIGNUP_OPEN=1 to auto-provision.
db.exec(`
  CREATE TABLE IF NOT EXISTS tenant_signup_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    company      TEXT NOT NULL,
    contact_name TEXT,
    contact      TEXT,                              -- email or phone, free text
    note         TEXT,
    status       TEXT NOT NULL DEFAULT 'new',       -- new | contacted | provisioned | declined
    ip           TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// The leads list / lead actions are platform-owner only. Accepts a platform-staff
// session (or a kitchen admin as implicit super); the lead actions additionally
// require the `signup.write` capability (super + support roles).
const requireLeadsView = requirePlatformAdmin('view');
const requireLeadsWrite = requirePlatformAdmin('signup.write');

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many signups from this IP, try later · 注册过于频繁,请稍后再试' },
});

function canProvision(req) {
  if (SIGNUP_OPEN()) return true;
  if (req.session?.userId) {
    const u = db.prepare('SELECT role FROM users WHERE id = ? AND is_active = 1').get(req.session.userId);
    if (u && u.role === 'admin') return true;
  }
  return false;
}

router.get('/api/backend/signup/status', (req, res) => {
  // The country list, and what each one IMPLIES. Sent together so the sign-up
  // page can show the merchant their currency, time zone and shop language as
  // they pick — the three questions it is not asking. A consequence shown is a
  // consequence they can disagree with; the previous behaviour was to decide
  // all three in silence (audit D-08).
  const locales = require('../lib/locale-defaults');
  const options = locales.countries().map((cc) => {
    const L = locales.resolveLocale({ country: cc });
    return { code: cc, currency: L.currency.code, symbol: L.currency.symbol,
             timezone: L.timezone, language: L.language };
  });
  res.json({ open: SIGNUP_OPEN(), canProvision: canProvision(req), countries: options });
});

router.post('/api/backend/signup', signupLimiter, express.json(), (req, res) => {
  if (!canProvision(req)) {
    return res.status(403).json({ success: false, error: 'Signup is invite-only right now · 暂为邀请制,敬请期待' });
  }
  // Audit D-08 / H-01. `country` is the one new question on the form; currency,
  // time zone and language follow from it and are all editable afterwards. The
  // three are accepted here as well so a caller that knows better — an import,
  // a platform staffer setting an account up — can say so directly.
  const { company, brand, username, password, owner_name,
          country, currency, timezone, language } = req.body || {};
  try {
    const r = provisionTenant({
      company, brand, ownerUsername: username, ownerPassword: password, ownerName: owner_name,
      country, currency, timezone, language,
    });
    res.json({
      success: true, tenantId: r.tenantId, username: r.ownerUsername,
      // What they were actually given, so the page can show it back rather than
      // leaving the merchant to discover their currency on the pricing screen.
      locale: r.locale,
      // Audit H-03: null when no address could be issued. The page must say so
      // rather than implying a shop somebody can visit.
      storefront: r.storefrontHost || null,
      storefrontWhy: r.storefrontHost ? null : (r.storefrontWhy || null),
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ── Waitlist capture (PUBLIC) ────────────────────────────────────────────
// Open to anyone; rate-limited. Stores the lead and provisions nothing.
const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests from this IP, try later · 请求过于频繁,请稍后再试' },
});

router.post('/api/backend/signup/request', requestLimiter, express.json(), (req, res) => {
  const b = req.body || {};
  const company = String(b.company || '').trim();
  const contactName = String(b.contact_name || '').trim();
  const contact = String(b.contact || '').trim();
  const note = String(b.note || '').trim();
  if (!company) return res.status(400).json({ success: false, error: 'Company name required · 公司名称必填' });
  if (!contact) return res.status(400).json({ success: false, error: 'An email or phone is required · 请留下邮箱或电话' });
  if (company.length > 120 || contactName.length > 80 || contact.length > 120 || note.length > 600) {
    return res.status(400).json({ success: false, error: 'One of the fields is too long · 某个字段过长' });
  }
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64);
  const ins = db.prepare('INSERT INTO tenant_signup_requests (company, contact_name, contact, note, ip) VALUES (?,?,?,?,?)')
    .run(company, contactName || null, contact, note || null, ip || null);
  console.log('[signup-request] new lead — ' + company + ' (' + contact + ')');

  // Ping the platform owner(s) so a lead doesn't sit unseen in saas-admin.
  // Same web-push fan-out the feedback inbox uses; audience = kitchen admins,
  // exactly who requireSaasAdmin lets view the leads list. Lazy require so a
  // circular pull can never deadlock; failures must not break the response.
  try {
    let push = null;
    try { push = require('./push'); } catch {}
    if (push) {
      const admins = db.prepare("SELECT id FROM users WHERE is_active = 1 AND role = 'admin'").all();
      if (admins.length) {
        push.sendPushToUsers(admins.map(u => u.id), {
          title: '📨 New signup request · 新开通申请',
          body: company + (contact ? ' — ' + contact : ''),
          url: '/saas-admin',
          tag: 'fc-signup-' + ins.lastInsertRowid,
        });
      }
    }
  } catch (e) { console.warn('[signup-request] push fan-out failed:', e.message); }

  res.json({ success: true });
});

// ── Leads list + status (platform owner / kitchen admin only) ────────────
router.get('/api/backend/signup/requests', requireLeadsView, (req, res) => {
  const rows = db.prepare('SELECT * FROM tenant_signup_requests ORDER BY (status = \'new\') DESC, created_at DESC').all();
  res.json({ success: true, requests: rows });
});

router.post('/api/backend/signup/requests/:id/status', requireLeadsWrite, express.json(), (req, res) => {
  const allowed = ['new', 'contacted', 'provisioned', 'declined'];
  const status = String((req.body && req.body.status) || '').trim();
  if (!allowed.includes(status)) return res.status(400).json({ success: false, error: 'Unknown status · 未知状态' });
  const r = db.prepare('UPDATE tenant_signup_requests SET status = ? WHERE id = ?').run(status, Number(req.params.id));
  if (!r.changes) return res.status(404).json({ success: false, error: 'Request not found · 未找到请求' });
  logAudit(req, { action: 'lead.status', targetType: 'lead', targetId: req.params.id, meta: { status } });
  res.json({ success: true });
});

module.exports = router;
