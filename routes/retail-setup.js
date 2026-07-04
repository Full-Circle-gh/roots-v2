'use strict';

// New-tenant setup guide — tenant-facing "Open your store" checklist.
//
// A brand-new store lands on a dashboard of zeros next to 30+ nav tabs and has
// no idea what to do first. This endpoint powers a single guided checklist that
// routes the operator through the five things that actually block selling, in
// shopkeeper order: store info → products → get paid → hand over orders → open.
//
// The guide is a ROUTER, not a new set of forms: every step opens the real page
// or wizard that already exists. So the ONLY server job here is to report, from
// real data, which steps are already satisfied — the operator never ticks a box
// by hand, and the list can never lie about work that's already done.
//
// Two kinds of signal:
//   • derived      — computed live from tenant data (a store row with an address,
//                    a product count, WeChat-Pay / Alipay readiness, delivery on)
//   • flag         — a small set of confirm-actions with no data of their own
//                    (pickup confirmed, store opened, welcome seen), stored as
//                    booleans under the `setup.*` storefront_config namespace.
//
// Nothing here is Roots-specific: it reads whatever the tenant's own DB holds,
// so a second tenant with a different catalog / payment mix gets the same guide.

const express = require('express');
const router = express.Router();

const { requireRetailAdmin } = require('./retail');
const { tdb } = require('../lib/tenant-db');
const { credsStatus } = require('../lib/tenant-creds');

function tenantId(req) { return (req.tenant && req.tenant.id) || 1; }

// Read one storefront_config value (parsed) with a default; defensive against a
// fresh DB that predates the row.
function cfg(db, key, dflt) {
  try {
    const row = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
    return row ? JSON.parse(row.value_json) : dflt;
  } catch (_) { return dflt; }
}
function count(db, sql) {
  try { return db.prepare(sql).get()?.n || 0; } catch (_) { return 0; }
}

// The `setup.*` flags live in a single JSON blob so one read covers them all and
// the namespace stays out of the public /api/retail/config surface anyway.
const FLAGS_KEY = 'setup.flags';
function readFlags(db) {
  const f = cfg(db, FLAGS_KEY, {}) || {};
  return {
    welcomeSeen:     f.welcomeSeen === true,
    pickupConfirmed: f.pickupConfirmed === true,
    storeOpened:     f.storeOpened === true,
  };
}
function writeFlags(db, next) {
  db.prepare(
    `INSERT INTO storefront_config (key, value_json, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP`
  ).run(FLAGS_KEY, JSON.stringify(next));
}

// Build the full status object from live data + flags.
function buildStatus(req) {
  const db = tdb();
  const tid = tenantId(req);
  const flags = readFlags(db);

  // ── derived signals ──
  // A store the shopper could actually be sent to = active + has an address.
  const storesWithAddr = count(db,
    "SELECT COUNT(*) AS n FROM retail_stores WHERE is_active = 1 AND address IS NOT NULL AND TRIM(address) <> ''");
  const anyStore = count(db, 'SELECT COUNT(*) AS n FROM retail_stores WHERE is_active = 1');
  const productCount = count(db, 'SELECT COUNT(*) AS n FROM store_products WHERE is_active = 1');

  // Can the store take money? WeChat Pay live, OR the manual-Alipay QR switched on.
  let payReady = false, wechatLoginReady = false;
  try { const cs = credsStatus(tid); payReady = !!cs.payReady; wechatLoginReady = !!cs.wechatLoginReady; } catch (_) {}
  const alipayManual = cfg(db, 'integrations.alipayManual', {}) || {};
  const alipayOn = alipayManual.enabled === true;
  const paymentReady = payReady || alipayOn;
  const paymentMethod = payReady && alipayOn ? 'both' : payReady ? 'wechat' : alipayOn ? 'alipay' : null;

  // Handover: delivery switched on, OR the operator confirmed pickup-only.
  const deliveryOn = cfg(db, 'delivery.enabled', false) === true;
  const fulfillmentReady = deliveryOn || flags.pickupConfirmed;

  // Nice-to-have: brand touched (a logo uploaded or the accent changed off-seed).
  const footer = cfg(db, 'brand.me_footer', {}) || {};
  const accent = cfg(db, 'theme.accent', 'forest-kale');
  const brandDone = !!footer.wordmark_image || (accent && accent !== 'forest-kale');

  const steps = [
    { key: 'store',       done: storesWithAddr > 0, count: anyStore },
    { key: 'products',    done: productCount > 0,   count: productCount },
    { key: 'payment',     done: paymentReady,       method: paymentMethod },
    { key: 'fulfillment', done: fulfillmentReady,   delivery: deliveryOn, pickup: flags.pickupConfirmed },
    { key: 'open',        done: flags.storeOpened === true },
  ];
  const optional = [
    { key: 'wechat', done: wechatLoginReady && payReady },
    { key: 'brand',  done: brandDone },
  ];

  const requiredTotal = steps.length;
  const requiredDone = steps.filter(s => s.done).length;
  const allDone = requiredDone === requiredTotal;
  // Percent counts required steps only — optional items never gate "open".
  const percent = Math.round((requiredDone / requiredTotal) * 100);

  return {
    firstLogin: !flags.welcomeSeen,
    steps, optional,
    requiredDone, requiredTotal, percent, allDone,
    flags,
  };
}

// GET current setup status.
router.get('/api/retail-admin/setup', requireRetailAdmin, (req, res) => {
  try { res.json({ success: true, data: buildStatus(req) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST a flag change. Body accepts any of the confirm-action booleans:
//   { welcomeSeen:true } | { pickupConfirmed:true } | { storeOpened:true }
// Only these three keys are writable; anything else is ignored. Returns the
// fresh status so the client repaints from one round-trip.
router.post('/api/retail-admin/setup', requireRetailAdmin, express.json(), (req, res) => {
  try {
    const db = tdb();
    const cur = readFlags(db);
    const body = req.body || {};
    const next = { ...cur };
    for (const k of ['welcomeSeen', 'pickupConfirmed', 'storeOpened']) {
      if (k in body) next[k] = body[k] === true;
    }
    writeFlags(db, next);
    res.json({ success: true, data: buildStatus(req) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
