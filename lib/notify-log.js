// What was sent, to whom, and whether it landed (audit P-03, and half of P-02).
//
// Twenty kinds of notification can leave this service — a push to an operator's
// phone, a one-time code by email, a delivery reminder, a WeChat subscribe
// message to a customer — and there was no screen anywhere listing what went
// out. A merchant asking "did the customer get told?" had no way to find out,
// and a merchant whose staff had stopped receiving orders had no way to notice.
//
// P-02 is the other half of the same gap: nine of those paths end in silence
// when they FAIL. `lib/email-sender.js` returns `{ok:false}` and the caller
// drops it; `lib/aliyun-sms.js` does the same; a dead push subscription is
// pruned without a word. Every one of those is a row here now, with its reason.
//
// ── THE MODEL ─────────────────────────────────────────────────────────────
// One row per SEND ATTEMPT, not per recipient. A push to eleven operator phones
// is one row saying eleven were tried, nine reached, one muted and one pruned —
// because the question an operator asks is "did this go out", and eleven rows
// answers a question nobody asked while burying the one that matters.
//
// The exception is a send to ONE named person (an email code, an SMS), where
// the recipient IS the fact worth recording; those carry it in `recipient`.
//
// ── WHAT IT IS NOT ────────────────────────────────────────────────────────
// Not a queue and not a retry store. Nothing reads these rows to decide whether
// to send again — writing one must never change what the sender does, which is
// why every call is wrapped and swallowed. A log that can break the thing it is
// logging is worse than no log.
//
// Not `retail_notifications` either: that table holds customer-facing in-app
// messages, which are a product feature. This is the record of what the system
// tried to deliver.

'use strict';

const { tdb, currentTenantId, ROOTS_TENANT_ID } = require('./tenant-db');

// Retention. These rows exist to answer "what happened last week", not to be an
// archive; the sweep is in database.js beside the activity_log one.
const RETENTION_DAYS = 90;

/**
 * Record one send attempt. Never throws, never returns anything the caller has
 * to check — a logging call inside a send path must be invisible to it.
 *
 * @param {object} row
 *   channel    'push' | 'email' | 'sms' | 'wechat' | 'wecom' | 'webhook'
 *   kind       what it was about — 'order_paid', 'ship_reminder',
 *              'low_stock_digest', 'signin_code'. The screen groups on this.
 *   subject    a short human line: the title that was sent, or what it was for.
 *   recipient  who, when it was one person (an email, a phone, a customer id).
 *              Null for a broadcast — see the model note above.
 *   entityType / entityId  what it was ABOUT, so the record can be found from
 *              the order or the customer it concerns.
 *   ok         did it land
 *   error      the reason when it did not — the provider's code, or ours
 *   detail     an object; counts for a broadcast (tried/sent/pruned/muted)
 */
function logNotification(row) {
  try {
    const r = row || {};
    const db = tdb();
    db.prepare(
      `INSERT INTO notification_log
         (tenant_id, channel, kind, subject, recipient, entity_type, entity_id,
          ok, error, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      _tenant(),
      String(r.channel || 'unknown').slice(0, 24),
      String(r.kind || 'unknown').slice(0, 64),
      r.subject == null ? null : String(r.subject).slice(0, 300),
      r.recipient == null ? null : String(r.recipient).slice(0, 200),
      r.entityType == null ? null : String(r.entityType).slice(0, 40),
      r.entityId == null ? null : (parseInt(r.entityId, 10) || null),
      r.ok ? 1 : 0,
      r.error == null ? null : String(r.error).slice(0, 300),
      r.detail == null ? null : JSON.stringify(r.detail).slice(0, 2000)
    );
  } catch (e) {
    // Deliberately silent past one line. This is called from inside send paths,
    // several of them in a Promise.all, and a throw here would turn a failed
    // LOG into a failed SEND.
    console.warn('[notify-log]', e.message);
  }
}

// Which account this belongs to. Reads the request's tenant scope where there is
// one; a background sweeper that knows its own account passes it in instead.
function _tenant() {
  try { return currentTenantId() || ROOTS_TENANT_ID; }
  catch (e) { return ROOTS_TENANT_ID; }
}

/**
 * The same thing from outside a request scope — the sweepers, which hold a
 * tenant id and a database handle of their own and are not inside an ALS
 * context. Same row, same silence.
 */
function logNotificationOn(db, tenantId, row) {
  try {
    const r = row || {};
    db.prepare(
      `INSERT INTO notification_log
         (tenant_id, channel, kind, subject, recipient, entity_type, entity_id,
          ok, error, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      parseInt(tenantId, 10) || ROOTS_TENANT_ID,
      String(r.channel || 'unknown').slice(0, 24),
      String(r.kind || 'unknown').slice(0, 64),
      r.subject == null ? null : String(r.subject).slice(0, 300),
      r.recipient == null ? null : String(r.recipient).slice(0, 200),
      r.entityType == null ? null : String(r.entityType).slice(0, 40),
      r.entityId == null ? null : (parseInt(r.entityId, 10) || null),
      r.ok ? 1 : 0,
      r.error == null ? null : String(r.error).slice(0, 300),
      r.detail == null ? null : JSON.stringify(r.detail).slice(0, 2000)
    );
  } catch (e) { console.warn('[notify-log]', e.message); }
}

module.exports = { logNotification, logNotificationOn, RETENTION_DAYS };
