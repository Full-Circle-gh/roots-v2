'use strict';

// Sign a Qingyun store back in from a picture of its browser (§484). The rules
// live in lib/qingyun-signin.js; who may is lib/channel-signin.js refusal(),
// the gate every channel sign-in passes (§250).

const path = require('path');
const express = require('express');
const { loadCaller } = require('../lib/require-cap');
const { getTenantDb, ROOTS_TENANT_ID } = require('../lib/tenant-db');
const signin = require('../lib/channel-signin');
const qy = require('../lib/qingyun-signin');

const router = express.Router();

const STATUS = { not_signed_in: 401, wrong_account: 403, no_permission: 403, out_of_scope: 403 };
const CODE = /^[a-z0-9_-]{1,32}$/;

// A store Qingyun is set up for: active, and its sync service has reported
// at least once (the same qingyun_status row Settings reads).
function resolveStore(db, code) {
  if (!CODE.test(String(code || ''))) return null;
  const s = db.prepare('SELECT id, code FROM retail_stores WHERE code = ? AND is_active = 1').get(code);
  if (!s) return null;
  let hb = null;
  try { hb = db.prepare('SELECT store_code FROM qingyun_status WHERE store_code = ?').get(code); } catch (_) { /* no table, no Qingyun */ }
  return hb ? s : null;
}

// The caller and the store, or a response already sent. Refusal first, so a
// caller who may not sign in learns nothing about which stores exist.
function gate(req, res, code) {
  const caller = loadCaller(req);
  const db = getTenantDb(ROOTS_TENANT_ID);
  const store = resolveStore(db, code);
  const why = signin.refusal(caller, req.session && req.session.tenantId, store);
  if (why) { res.status(STATUS[why]).json({ success: false, error: why }); return null; }
  if (!store) { res.status(400).json({ success: false, error: 'unknown_store' }); return null; }
  return { caller, store };
}

function send(res, out) {
  res.set('Cache-Control', 'no-store');
  res.json({
    success: true,
    signedIn: !!out.signedIn,
    noCode: !!out.noCode,
    verify: !!out.verify,
    picture: out.picture ? 'data:image/jpeg;base64,' + out.picture.toString('base64') : null,
  });
}

function failed(res, e) {
  console.error('[qingyun-signin]', e && e.message);
  res.status(503).json({ success: false, error: 'browser_unavailable' });
}

// Start, or Show a new code (fresh: true).
router.post('/api/retail-admin/qingyun-signin/open', express.json(), async (req, res) => {
  const { store: code, fresh } = req.body || {};
  const g = gate(req, res, code);
  if (!g) return;
  try { send(res, await qy.open(g.store.code, fresh === true)); } catch (e) { failed(res, e); }
});

// What the page shows now. Polled every two seconds.
router.get('/api/retail-admin/qingyun-signin/picture', async (req, res) => {
  const g = gate(req, res, req.query.store);
  if (!g) return;
  try { send(res, await qy.picture(g.store.code)); } catch (e) { failed(res, e); }
});

// The page. It authenticates itself through the two calls above.
router.get('/qingyun-signin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'public', 'qingyun-signin.html'));
});

module.exports = router;
module.exports._resolveStore = resolveStore;
