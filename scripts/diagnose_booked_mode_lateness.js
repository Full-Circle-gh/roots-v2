#!/usr/bin/env node
/**
 * §421 follow-up: which delivered parcels did judging by the BOOKED JD service
 * newly mark late, and which did it clear?
 *
 * Reported by Ash 2026-10-03 against TC000809 (placed 09-20, delivered, two
 * parcels): an old order started showing DELIVERY DELAYED after §421 shipped.
 * This compares, for every parcel in scope of the late predicate, the verdict
 * under the parcel's planned `mode` (before §421) with the verdict under its
 * booked service (after), and prints TC000809's parcels in full.
 *
 * Read-only, and proven so: the connection is opened readonly and a write is
 * attempted and must be refused. database.js and lib/ are never required; the
 * rule is restated in SQL here so nothing with a write path loads.
 *
 * Run: via .github/workflows/ro-query.yml
 */
'use strict';

const path = require('path');
const HOME = process.env.ROOTS_HOME || '/root/roots-v2';
const DB_PATH = process.env.ROOTS_DB || path.join(HOME, 'data', 'roots.db');
const Database = require(path.join(HOME, 'node_modules', 'better-sqlite3'));

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); } catch (e) { proven = true; console.log('read-only PROVEN — ' + e.message); }
if (!proven) { console.error('FATAL: the connection accepted a write.'); process.exit(2); }

const cols = db.prepare("SELECT name FROM pragma_table_info('retail_shipments')").all().map(r => r.name);
const hasBooked = cols.includes('waybill_product') && cols.includes('waybill_product_no');
console.log('booked columns present: ' + hasBooked);
console.log('backfill marker: ' + JSON.stringify(
  db.prepare("SELECT * FROM _migrations WHERE name = 'shipment_waybill_product_v1'").get() || null));

const DAYS = "CASE %M WHEN 'air' THEN '+1 day' WHEN 'local' THEN '+1 day' WHEN 'land' THEN '+3 day' ELSE NULL END";
const BOOKED = hasBooked
  ? `(CASE WHEN s.waybill_product_no = s.tracking_number THEN CASE s.waybill_product
        WHEN 'LL-HD-M' THEN 'land' WHEN 'ed-m-0001' THEN 'land'
        WHEN 'LL-SD-M' THEN 'air'  WHEN 'ed-m-0002' THEN 'air' ELSE s.mode END ELSE s.mode END)`
  : 's.mode';
const WHEN = 'DATE(COALESCE(s.delivered_at, s.tracking_synced_at))';
const lateBy = (m) => `(s.dispatched_at IS NOT NULL
   AND (s.delivered_at IS NOT NULL OR s.tracking_status = 'delivered')
   AND ${WHEN} > DATE(s.dispatched_at, ${DAYS.replace('%M', m)})
   AND (${WHEN} >= '2026-09-11' OR EXISTS (SELECT 1 FROM retail_delay_cases dc WHERE dc.shipment_id = s.id)))`;

const rows = db.prepare(`
  SELECT o.order_no, s.id, s.mode, ${hasBooked ? 's.waybill_product, s.waybill_product_no,' : ''}
         s.tracking_carrier, s.tracking_number, s.dispatched_at, s.delivered_at,
         s.tracking_status, s.tracking_synced_at, s.air_delay_cleared_at,
         ${BOOKED} AS booked_mode,
         ${lateBy('s.mode')} AS late_before, ${lateBy(BOOKED)} AS late_after,
         (SELECT id FROM retail_delay_cases dc WHERE dc.shipment_id = s.id) AS case_id
    FROM retail_shipments s JOIN retail_orders o ON o.id = s.order_id
   WHERE o.order_no = 'TC000809' ORDER BY s.id`).all();
console.log('\n── TC000809 parcels');
for (const r of rows) console.log(JSON.stringify(r));

const changed = db.prepare(`
  SELECT o.order_no, o.status, s.id, s.mode, ${BOOKED} AS booked_mode,
         ${hasBooked ? 's.waybill_product,' : ''}
         DATE(s.dispatched_at) AS out_day, ${WHEN} AS landed_day,
         ${lateBy('s.mode')} AS late_before, ${lateBy(BOOKED)} AS late_after,
         s.air_delay_cleared_at IS NOT NULL AS cleared
    FROM retail_shipments s JOIN retail_orders o ON o.id = s.order_id
   WHERE ${lateBy('s.mode')} <> ${lateBy(BOOKED)}
   ORDER BY landed_day`).all();
const newly = changed.filter(r => r.late_after && !r.late_before);
const lifted = changed.filter(r => !r.late_after && r.late_before);
console.log(`\n── NEWLY late under §421: ${newly.length}`);
for (const r of newly) console.log(JSON.stringify(r));
console.log(`\n── NO LONGER late under §421: ${lifted.length}`);
for (const r of lifted) console.log(JSON.stringify(r));
