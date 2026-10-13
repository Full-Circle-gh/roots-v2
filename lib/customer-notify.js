// The customer's in-app inbox: one row in retail_notifications per event
// (orders, refunds, invoices, replies), unless the operator has muted that
// category on the Broadcasts page. Moved out of routes/retail.js unchanged
// (decisions §477). The WeChat pushes that go with an order's status stay in
// routes/retail.js and move with orders.
'use strict';

const { tdb } = require('./tenant-db');
const { loadConfig } = require('./store-config');

// Operator switch (Broadcasts page → Automatic notifications) that mutes a
// whole category of system-generated notifications. Off means neither the
// in-app row nor the WeChat push is created. Categories with no explicit entry
// — notably 'broadcast', which is always operator-initiated — stay enabled.
function notifCategoryEnabled(cat) {
  try {
    const cats = loadConfig().notifications?.categories;
    if (cats && Object.prototype.hasOwnProperty.call(cats, cat)) return cats[cat] !== false;
  } catch (e) { /* fall through to enabled */ }
  return true;
}

// Persistent per-customer inbox (orders / refunds / invoices for v1), written
// from the same server events that fire the WeChat push. Surfaced in the mini
// app's Notifications page. Best-effort — never throws into the caller.
function notifyCustomer(customerId, n) {
  if (!customerId || !n || !n.category || !n.type) return;
  if (!notifCategoryEnabled(n.category)) return;   // operator muted this category
  try {
    tdb().prepare(
      `INSERT INTO retail_notifications
         (customer_id, category, type, title_en, title_cn, body_en, body_cn, ref_type, ref_id)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      customerId, n.category, n.type,
      n.title_en || '', n.title_cn || '',
      n.body_en || null, n.body_cn || null,
      n.ref_type || null, n.ref_id != null ? String(n.ref_id) : null
    );
  } catch (e) { console.warn('[notify]', e.message); }
}

module.exports = { notifCategoryEnabled, notifyCustomer };
