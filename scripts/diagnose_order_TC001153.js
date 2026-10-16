#!/usr/bin/env node
/**
 * Read-only: why is TC001153 on "Delivery needs a call"?
 *
 * Ash, 2026-10-16, off the live phone: the land parcel was delivered at 13:26
 * after the courier's missed calls, yet the order still says it needs a call.
 * The card ORs five rules (lib/delivery-alerts.js alertFilter). This runs
 * each one against this order alone, with THIS checkout's lib/, and prints the
 * columns each rule reads, so the answer is a fact rather than a guess.
 *
 * No names, phones or addresses are printed.
 *
 *   Run through .github/workflows/ro-query.yml (manual dispatch).
 */
'use strict';

const path = require('path');

const ORDER_NO = 'TC001153';
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';

function loadSqlite() {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require('/root/roots-v2/node_modules/better-sqlite3'); }
}
const Database = loadSqlite();
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// ── Prove read-only, do not assume it ───────────────────────────────────────
let proven = false;
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
} catch (e) {
  proven = true;
  console.log('read-only PROVEN — write rejected: ' + e.message);
}
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting without reading anything.');
  process.exit(2);
}

const alerts = require(path.join(HOME, 'lib', 'delivery-alerts'));
const delayCase = require(path.join(HOME, 'lib', 'delay-case'));
const businessDate = require(path.join(HOME, 'lib', 'business-date'));

const J = (x) => JSON.stringify(x, null, 2);
const one = (sql, ...p) => { try { return db.prepare(sql).get(...p); } catch (e) { return { ERROR: e.message }; } };
const all = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch (e) { return { ERROR: e.message }; } };

const o = one('SELECT id FROM retail_orders WHERE order_no = ?', ORDER_NO);
if (!o || o.ERROR) { console.log('NOT FOUND / ' + J(o)); process.exit(1); }
const ID = o.id;

const TRACK_COLS = `tracking_carrier, tracking_number, tracking_status, tracking_scenario,
  tracking_synced_at, tracking_kd100_subscribed,
  tracking_no_contact_event, tracking_no_contact_first_event, tracking_no_contact_seen_at,
  tracking_no_contact_cleared, tracking_no_contact_cleared_by, tracking_no_contact_cleared_at`;

console.log('\n══ 1 · order row (the legacy mirror) ══');
console.log(J(one(`SELECT id, order_no, status, fulfillment_type, channel, placed_at, dispatched_at,
  delivered_at, ${TRACK_COLS} FROM retail_orders WHERE id = ?`, ID)));

console.log('\n══ 2 · parcels ══');
console.log(J(all(`SELECT id, mode, waybill_product, waybill_product_no, dispatched_at, delivered_at,
  air_delay_cleared_at, running_late_contacted_at, ${TRACK_COLS}
  FROM retail_shipments WHERE order_id = ? ORDER BY id`, ID)));

console.log('\n══ 3 · each rule of the card, on this order ══');
const shift = businessDate.sqlDayShiftForShop(db);
console.log('shop day shift: ' + shift + ' · shop today: ' + J(one(`SELECT DATE('now', '${shift}') AS d`)));
const rules = {
  carrier_exception: `o.status = 'dispatched' AND o.tracking_status IN ('exception','returning','returned')
                      AND COALESCE(o.tracking_scenario, '') <> 'no_contact'`,
  no_contact_legacy_unstamped: `o.tracking_scenario = 'no_contact' AND o.tracking_no_contact_event IS NULL`,
  no_contact_on_order_row: `${alerts.noContactOpenSql('o')} AND COALESCE(o.tracking_status, '') <> 'delivered'`,
  no_contact_on_a_parcel: `EXISTS (SELECT 1 FROM retail_shipments snc WHERE snc.order_id = o.id
                            AND ${alerts.noContactOpenSql('snc')} AND snc.delivered_at IS NULL
                            AND COALESCE(snc.tracking_status, '') <> 'delivered')`,
  carrier_alert_whole: alerts.carrierAlertSql('o'),
  landed_late: alerts.airAlertSql('o', shift),
  running_late: alerts.runningLateAlertSql('o', shift),
  meituan: alerts.meituanAlertSql('o'),
};
for (const [name, sql] of Object.entries(rules)) {
  const r = one(`SELECT (${sql}) AS hit FROM retail_orders o WHERE o.id = ?`, ID);
  console.log(name.padEnd(30) + ' ' + (r && r.ERROR ? 'ERROR ' + r.ERROR : (r && r.hit ? 'YES' : 'no')));
}
const stuck = alerts.localStuckRows(db).some(r => r.id === ID);
console.log('local_rider_stuck'.padEnd(30) + ' ' + (stuck ? 'YES' : 'no'));

console.log('\n══ 4 · per parcel: late rules ══');
for (const s of all('SELECT id FROM retail_shipments WHERE order_id = ? ORDER BY id', ID)) {
  const r = one(`SELECT ${delayCase.lateAfterSql('s', shift)} AS due_day,
      (${delayCase.runningLateSql('s', null, shift)}) AS running_late,
      (${delayCase.lateShipmentSql('s', shift)}) AS landed_late
    FROM retail_shipments s WHERE s.id = ?`, s.id);
  console.log('parcel ' + s.id + ': ' + J(r));
}
// ── 5 · across the shop: which orders the §482 change takes off the card ──
// The old order-row clause, written out, against the new whole rule. Any order
// listed here is on the card today and would not be after the change.
console.log('\n══ 5 · orders on the card today that §482 takes off ══');
const OLD_ORDER_ROW = `${alerts.noContactOpenSql('o')} AND COALESCE(o.tracking_status, '') <> 'delivered'`;
const dropped = all(`SELECT o.id, o.order_no, o.tracking_number, o.tracking_status,
    o.tracking_no_contact_event,
    (SELECT GROUP_CONCAT(s.tracking_number || ':' || COALESCE(s.tracking_status, '-') || ':'
              || COALESCE(s.tracking_no_contact_event, '-'), ' | ')
       FROM retail_shipments s WHERE s.order_id = o.id) AS parcels
  FROM retail_orders o
 WHERE o.status = 'dispatched' AND (${OLD_ORDER_ROW})
   AND NOT (${alerts.carrierAlertSql('o')})
   AND NOT (${alerts.airAlertSql('o', shift)})
   AND NOT (${alerts.runningLateAlertSql('o', shift)})
   AND NOT (${alerts.meituanAlertSql('o')})
 ORDER BY o.id`);
console.log(Array.isArray(dropped) && !dropped.length ? '(none)' : J(dropped));
console.log('\ndone.');
