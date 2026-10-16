#!/usr/bin/env node
/**
 * diagnose_auto_deliver_backlog.js — what would the ETA auto-deliver sweep do
 * the moment it worked again?
 *
 * routes/retail.js autoDeliverLocalEtaForTenant has not run since #1076
 * (2026-10-09): its SELECT carries one unclosed bracket, SQLite refuses it with
 * "incomplete input", and the sweep logs a warning and returns, every minute.
 * Closing the bracket is one character, but the first tick after that deploy
 * would mark every order stranded since then as Delivered and send each its
 * status notification. This measures that, so the decision is made on a number.
 *
 *   1. when the sweep last delivered anything (activity_log, reason auto_eta),
 *      and how the drop-off sweep has been doing meanwhile;
 *   2. every order the FIXED query would select today, by status, placed day,
 *      and whether its ETA has passed — i.e. what the first tick would flip.
 *
 * The SELECT below is the sweep's own, with the bracket closed and nothing
 * else changed. Every statement is a SELECT. The database is opened read-only
 * and the connection is PROVEN read-only before anything is read. Order numbers
 * and dates are printed; no customer name, phone or address is.
 *
 *   node scripts/diagnose_auto_deliver_backlog.js   (via .github/workflows/ro-query.yml)
 */
'use strict';

const path = require('path');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';

function loadSqlite() {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require('/root/roots-v2/node_modules/better-sqlite3'); }
}
const Database = loadSqlite();
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
if (!proven) { console.error('FATAL: the connection accepted a write. Aborting.'); process.exit(2); }

const GZ = 'Asia/Shanghai';
const now = new Date();
const gzDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: GZ }).format(d);
const gzHHMM = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: GZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
console.log('run at: ' + now.toISOString() + '  (Guangzhou ' + gzDay(now) + ' ' + gzHHMM(now) + ')\n');

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 1 · when did the ETA sweep last deliver anything? ══');
{
  try {
    const rows = db.prepare(`
      SELECT date(created_at, '+8 hours') AS gz_day, COUNT(*) AS n
        FROM activity_log
       WHERE action = 'status_change' AND entity_type = 'retail_order'
         AND details LIKE '%"reason":"auto_eta"%'
       GROUP BY 1 ORDER BY 1 DESC LIMIT 20`).all();
    console.log('auto_eta deliveries by Guangzhou day (newest first):');
    for (const r of rows) console.log('  ' + r.gz_day + '  ' + r.n);
    if (!rows.length) console.log('  (none ever recorded)');
  } catch (e) { console.log('activity_log unreadable: ' + e.message); }
  try {
    const rows = db.prepare(`
      SELECT details, COUNT(*) AS n, MAX(date(created_at, '+8 hours')) AS last_day
        FROM activity_log
       WHERE action = 'status_change' AND entity_type = 'retail_order'
         AND details LIKE '%"to":"delivered"%' AND created_at >= datetime('now', '-14 days')
       GROUP BY CASE WHEN details LIKE '%"reason":%' THEN substr(details, instr(details, '"reason":'), 30) ELSE 'manual/other' END
       ORDER BY n DESC`).all();
    console.log('\nall moves to delivered in the last 14 days, by how they happened:');
    for (const r of rows) {
      const m = /"reason":"([^"]+)"/.exec(r.details || '');
      console.log('  ' + (m ? m[1] : 'no reason recorded (staff / other)').padEnd(40) + String(r.n).padStart(5) + '   last ' + r.last_day);
    }
  } catch (e) { console.log('activity_log unreadable: ' + e.message); }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 2 · what the FIRST tick of a fixed sweep would select ══');
{
  // The sweep's SELECT, bracket closed, nothing else changed.
  const FROM = "'paid','preparing','dispatched','rider_pickup'";
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT o.id AS id, o.order_no AS order_no, o.status AS status,
             o.scheduled_for AS scheduled_for, o.placed_at AS placed_at,
             (SELECT sh.local_eta FROM retail_shipments sh
               WHERE sh.order_id = o.id AND sh.mode = 'local'
                 AND sh.local_eta IS NOT NULL AND sh.local_eta != ''
               ORDER BY sh.id ASC LIMIT 1) AS local_eta,
             (SELECT sh.eta_source FROM retail_shipments sh
               WHERE sh.order_id = o.id AND sh.mode = 'local'
                 AND sh.local_eta IS NOT NULL AND sh.local_eta != ''
               ORDER BY sh.id ASC LIMIT 1) AS eta_source
        FROM retail_orders o
       WHERE o.fulfillment_type = 'delivery'
         AND o.status IN (${FROM})
         AND NOT EXISTS (
               SELECT 1 FROM delivery_jobs j
                WHERE j.retail_order_id = o.id
                  AND ( ( j.order_status IS NOT NULL
                          AND j.order_status < 50
                          AND j.updated_at > datetime('now','-30 minutes') )
                        OR j.cancelled_at IS NOT NULL ) )`).all();
  } catch (e) { console.log('the fixed SELECT failed: ' + e.message); }

  const today = gzDay(now);
  const nowMin = (() => { const [h, m] = gzHHMM(now).split(':').map(Number); return h * 60 + m; })();
  const flip = [], later = [], noEta = [];
  for (const r of rows) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(r.local_eta || '').trim());
    if (!m) { noEta.push(r); continue; }
    const s = r.scheduled_for ? String(r.scheduled_for).trim() : '';
    const schedDay = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : (s && !isNaN(new Date(s).getTime()) ? gzDay(new Date(s)) : null);
    if (schedDay && schedDay > today) { later.push(r); continue; }
    if (nowMin >= (+m[1]) * 60 + (+m[2]) + 20) flip.push(r); else later.push(r);
  }
  console.log('orders in the sweep\'s statuses with no live / cancelled courier job: ' + rows.length);
  console.log('  no usable ETA (never touched by this sweep):      ' + noEta.length);
  console.log('  ETA not passed yet, or booked for a later day:    ' + later.length);
  console.log('  WOULD BE MARKED DELIVERED ON THE FIRST TICK:      ' + flip.length);
  const byKey = (list, key) => list.reduce((a, r) => { const k = key(r); a[k] = (a[k] || 0) + 1; return a; }, {});
  const placedDay = (r) => (r.placed_at ? gzDay(new Date(String(r.placed_at).replace(' ', 'T') + 'Z')) : '?');
  console.log('\n  of those, by status: ' + JSON.stringify(byKey(flip, (r) => r.status)));
  console.log('  by ETA source:       ' + JSON.stringify(byKey(flip, (r) => r.eta_source || 'unset')));
  console.log('  by Guangzhou day placed:');
  for (const [d, n] of Object.entries(byKey(flip, placedDay)).sort()) console.log('    ' + d + '  ' + n);
  console.log('\n  each one (order, status, placed, ETA, booked for):');
  for (const r of flip.sort((a, b) => String(a.placed_at).localeCompare(String(b.placed_at)))) {
    console.log('    ' + String(r.order_no).padEnd(12) + String(r.status).padEnd(14) + placedDay(r) + '  eta ' + r.local_eta
      + '  ' + (r.scheduled_for ? 'for ' + r.scheduled_for : ''));
  }
}

console.log('\ndone — nothing was written.');
