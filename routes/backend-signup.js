// Mini App Backend — tenant signup / provisioning (Phase 2).
//
// Gated during Phase 2: open to the public only when BACKEND_SIGNUP_OPEN=1,
// otherwise a kitchen `admin` may provision (so you can create test tenants).
// Public signup stays closed until per-tenant data isolation is cut over
// (TENANT_DATA_ISOLATION=1) — see tenant-db.js — so no leaky tenant can exist.

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../database');
const { provisionTenant } = require('../lib/provision-tenant');
const router = express.Router();

const SIGNUP_OPEN = () => process.env.BACKEND_SIGNUP_OPEN === '1';

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
  res.json({ open: SIGNUP_OPEN(), canProvision: canProvision(req) });
});

router.post('/api/backend/signup', signupLimiter, express.json(), (req, res) => {
  if (!canProvision(req)) {
    return res.status(403).json({ success: false, error: 'Signup is invite-only right now · 暂为邀请制,敬请期待' });
  }
  const { company, brand, username, password, owner_name } = req.body || {};
  try {
    const r = provisionTenant({ company, brand, ownerUsername: username, ownerPassword: password, ownerName: owner_name });
    res.json({ success: true, tenantId: r.tenantId, username: r.ownerUsername });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

module.exports = router;
