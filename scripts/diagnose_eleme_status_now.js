#!/usr/bin/env node
/**
 * Where every mirrored Eleme order actually stands, RIGHT NOW, and what the
 * daemon has been able to read since the stage fix shipped (dd3ccaa, deployed
 * 2026-09-04 11:42 +08).
 *
 * WHY THIS EXISTS. The fix made the parser read the order's lifecycle stage
 * instead of the "VALID" validity flag. The Orders screen still shows Eleme
 * orders sitting on Paid, so exactly one of four things is true, and they need
 * very different fixes:
 *
 *   1. Those rows are older than the deploy and simply were never re-read —
 *      expected, since history was deliberately not rewritten.
 *   2. The daemon is not polling at all (login lost, verification challenge),
 *      so nothing has been re-read since.
 *   3. The daemon IS polling and the payload still yields no stage — in which
 *      case order_status_unmapped rows now say so by name, with the field the
 *      label came out of. That is the log line the old code could not produce.
 *   4. A stage IS being read and written, and the rows on screen are the ones
 *      that have aged off Eleme's in-progress tab, which the ETA sweep should
 *      have landed — unless channel_eta is NULL on them, which makes that
 *      sweep inert by construction (it requires an ETA to compare against).
 *
 * Case 4 is the one the screenshot hints at: both stuck orders show "—" in the
 * Delivery column, which is an empty channel_eta. So the ETA counts are printed
 * per status, not just per order.
 *
 * Every statement is a SELECT, the database is opened read-only, and the
 * connection is PROVEN read-only before anything else runs.
 *
 * NO CUSTOMER DATA. Order numbers, platform ids, statuses, timestamps and
 * counts only — the same Tier 3 rule the other diagnostics here follow. Nothing
 * name-shaped or phone-shaped is selected at all.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_eleme_status_now.js
 */
'use strict';

const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require('/root/roots-v2/node_modules/better-sqlite3');

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

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
console.log('db: ' + DB_PATH);
console.log('now (UTC): ' + new Date().toISOString() + '\n');

const show = (v) => (v === null || v === undefined ? 'NULL' : String(v));

// ── 1. Every Eleme order, with the three things that decide its status ──────
console.log('── every eleme order ───────────────────────────────────────────');
const rows = db.prepare(`
  SELECT o.id, o.order_no, o.status, o.channel_status, o.channel_status_at,
         o.channel_eta, o.placed_at, o.preparing_at, o.dispatched_at, o.delivered_at,
         o.cancelled_at, o.channel_stock_restored,
         i.eleme_order_id, i.store_code, i.status AS import_status
    FROM retail_orders o
    LEFT JOIN eleme_order_import i ON i.retail_order_id = o.id
   WHERE o.channel = 'eleme'
   ORDER BY o.id DESC
   LIMIT 60
`).all();
console.log(`${rows.length} row(s), newest first\n`);
for (const r of rows) {
  console.log(`  ${r.order_no}  (id ${r.id})  store=${show(r.store_code)}  eleme_id=${show(r.eleme_order_id)}`);
  console.log(`     status=${r.status}   channel_status=${JSON.stringify(r.channel_status)}   at=${show(r.channel_status_at)}`);
  console.log(`     placed=${show(r.placed_at)}  eta=${show(r.channel_eta)}`);
  console.log(`     preparing_at=${show(r.preparing_at)}  dispatched_at=${show(r.dispatched_at)}  delivered_at=${show(r.delivered_at)}`);
}
console.log('');

// ── 2. The distribution, and the ETA sweep's own precondition ───────────────
// auto-deliver-past-eta only touches a row with a non-empty channel_eta. If the
// non-terminal rows have none, that endpoint can never land them however long
// they sit, and the "orders will reach Delivered" half of the fix is inert.
console.log('── status × channel_status, with ETA presence ──────────────────');
const dist = db.prepare(`
  SELECT status,
         COUNT(*) AS n,
         SUM(CASE WHEN channel_eta IS NULL OR channel_eta = '' THEN 1 ELSE 0 END) AS no_eta,
         SUM(CASE WHEN channel_status = 'VALID' THEN 1 ELSE 0 END) AS still_valid_flag
    FROM retail_orders
   WHERE channel = 'eleme'
   GROUP BY status
   ORDER BY n DESC
`).all();
for (const d of dist) {
  console.log(`  ${String(d.n).padStart(4)}  status=${d.status.padEnd(16)} without an ETA: ${d.no_eta}   channel_status still "VALID": ${d.still_valid_flag}`);
}
console.log('');

console.log('── the channel_status vocabulary we now hold ───────────────────');
const vocab = db.prepare(`
  SELECT channel_status, COUNT(*) AS n, MAX(channel_status_at) AS last_seen
    FROM retail_orders WHERE channel = 'eleme'
   GROUP BY channel_status ORDER BY n DESC
`).all();
for (const v of vocab) {
  console.log(`  ${String(v.n).padStart(4)}  ${JSON.stringify(v.channel_status)}   last written ${show(v.last_seen)}`);
}
console.log('');

// ── 3. What the daemon has actually done, and when ─────────────────────────
// A poll that is not running looks exactly like a poll that finds nothing, so
// the last row of EVERY event type is printed rather than only the interesting
// ones. order_status_unmapped is the fix's own instrument: a row there names a
// label we could not read AND the payload field it came out of.
console.log('── eleme_sync_log: last row per event type ────────────────────');
const kinds = db.prepare(`
  SELECT event_type, status, COUNT(*) AS n, MAX(created_at) AS last_at
    FROM eleme_sync_log
   GROUP BY event_type, status
   ORDER BY last_at DESC
`).all();
for (const k of kinds) {
  console.log(`  ${show(k.last_at)}  ${String(k.n).padStart(5)}×  ${k.event_type} [${k.status}]`);
}
console.log('');

console.log('── every order_status_unmapped row (the fix\'s own instrument) ──');
const unmapped = db.prepare(`
  SELECT created_at, store_code, detail, error_msg
    FROM eleme_sync_log WHERE event_type = 'order_status_unmapped'
   ORDER BY created_at DESC LIMIT 40
`).all();
if (!unmapped.length) console.log('  (none — either no unreadable label has been seen, or nothing has polled)');
for (const u of unmapped) {
  console.log(`  ${u.created_at}  ${show(u.store_code)}  ${show(u.error_msg)}`);
  console.log(`     ${show(u.detail)}`);
}
console.log('');

// ── 4. The last 40 log rows verbatim, so a poll failure is visible ─────────
console.log('── eleme_sync_log: last 40 rows ───────────────────────────────');
const recent = db.prepare(`
  SELECT created_at, store_code, event_type, status, error_msg, detail
    FROM eleme_sync_log ORDER BY id DESC LIMIT 40
`).all();
for (const r of recent) {
  const det = r.detail ? String(r.detail).slice(0, 220) : '';
  console.log(`  ${r.created_at}  ${show(r.store_code)}  ${r.event_type} [${r.status}]  ${show(r.error_msg)}`);
  if (det) console.log(`     ${det}`);
}
console.log('');

// ── 5. What the archive says about the READ, on the newest imports ─────────
// statusKeyPath / statusIsStage are written by the fixed parser
// (scripts/eleme-daemon.js archiveFields). Their ABSENCE on a row imported
// after the deploy would mean the box is not running the new code.
console.log('── newest imports: which field the status was read from ───────');
const imports = db.prepare(`
  SELECT rowid, eleme_order_id, retail_order_id, store_code, status, created_at,
         detail_json, LENGTH(raw_payload) AS raw_len
    FROM eleme_order_import ORDER BY rowid DESC LIMIT 12
`).all();
for (const im of imports) {
  let d = {};
  try { d = JSON.parse(im.detail_json || '{}'); } catch (_) { d = {}; }
  console.log(`  rowid ${im.rowid}  eleme_id=${show(im.eleme_order_id)}  order=${show(im.retail_order_id)}  ${show(im.created_at)}  import=${im.status}`);
  console.log(`     statusKeyPath=${show(d.statusKeyPath)}  statusIsStage=${show(d.statusIsStage)}  totalKeyPath=${show(d.totalKeyPath)}  raw=${im.raw_len} chars`);
}
console.log('');
console.log('done.');
