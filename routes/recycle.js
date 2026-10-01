// Recently deleted — the reading and undoing surface for lib/recycle.js
// (audit E-07).
//
// Two endpoints, and no more: what was removed in the last sixty days, and put
// one back. There is deliberately no "empty the bin" — a control whose only
// effect is to destroy the one copy of something, on a screen whose whole
// purpose is recovering from a mistake, is a mistake waiting to be made. The
// sweep does it on time instead.

'use strict';

const express = require('express');
const router = express.Router();
const { tdb } = require('../lib/tenant-db');
const { requireRetailAdmin } = require('./retail');
const { logActivity } = require('../middleware/auth');
const recycle = require('../lib/recycle');
const capRoutes = require('../lib/cap-routes');

router.get('/api/retail-admin/deleted', requireRetailAdmin, (req, res) => {
  try {
    res.json({ success: true, data: recycle.list(tdb()), days: recycle.RETENTION_DAYS });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/api/retail-admin/deleted/:id/restore', requireRetailAdmin, (req, res) => {
  const who = (req.user && req.user.username) || null;
  const deletedId = parseInt(req.params.id, 10);
  /* §325 — THE KEY FOR THIS KIND OF RECORD. The choke point let any of the
     kinds' keys through (it cannot see which kind this copy is); here the copy
     is read and the operator must hold the key that edits ITS kind — a
     delivery zone is delivery:edit, a ledger row finance:record, a coupon
     coupons:edit or coupons:delete, a draft purchase order purchasing:edit.
     Before anything is written, in the choke point's shape. A copy that does
     not exist falls through to restore(), which answers not_found. */
  let rec = null;
  try { rec = tdb().prepare('SELECT kind FROM deleted_records WHERE id = ?').get(deletedId); } catch (e) { rec = null; }
  if (rec) {
    const need = capRoutes.restoreKindCap(rec.kind);
    if (capRoutes.capDenied(req, need)) {
      return res.status(403).json({ success: false, error: 'forbidden_capability', need });
    }
  }
  const r = recycle.restore(tdb(), deletedId, who);
  if (!r.ok) {
    // `taken` and `gone` are the two an operator can act on, so they get their
    // own status rather than a 500: nothing failed, the world moved.
    const status = r.error === 'not_found' ? 404
      : (r.error === 'taken' || r.error === 'gone' || r.error === 'already_restored') ? 409 : 500;
    return res.status(status).json({ success: false, error: r.error });
  }
  logActivity(req.user?.id || null, who, 'restore', r.kind, r.record_id, null, req.ip);
  res.json({ success: true, kind: r.kind, record_id: r.record_id });
});

module.exports = router;
