#!/usr/bin/env node
/**
 * Is the Eleme order-locator still promoting LINE ITEMS to orders?
 *
 * Five rows in retail_orders (ids 1470, 1471, 1498, 1499, 1500) are not orders:
 * each holds one food object, its eleme_order_id is that food's own id, and its
 * sync-log line records items: 0. The rows themselves are not the worry — the
 * real orders behind them were never imported, and the question is whether that
 * is still happening.
 *
 * WHAT MAKES A ROW SUSPECT. Three independent marks, printed per row rather than
 * combined into one verdict, because any one of them can have an innocent
 * explanation and the combination is what convicts:
 *   • the archived payload has no order-level settlement/trip fields but does
 *     carry food fields (skuId / vfoodId / price / quantity) — a food object;
 *   • the import's sync-log line says items: 0 — nothing was resolved, so nothing
 *     was deducted;
 *   • subtotal == total AND the row has no priced lines — the shape a single
 *     food's own price produces.
 * A genuine one-line order can trip the third alone, which is why the first is
 * the one that decides and is printed as raw evidence.
 *
 * It also reconstructs each affected POLL: every eleme_sync_log row inside a
 * window around the suspect imports, so a poll that produced phantoms AND a real
 * order can be told apart from one that produced only phantoms, and the poll's
 * own order_poll / order_shape lines can say how many orders it believed it saw.
 *
 * NO CUSTOMER DATA. Order numbers, ids, timestamps, statuses, money, and payload
 * KEY NAMES. The one place a value is printed verbatim is the head of a suspect
 * archive, which is a food object (name, price, quantity) and is the evidence the
 * whole question turns on.
 *
 * Every statement is a SELECT, the database is opened read-only, and the
 * connection is PROVEN read-only before anything else runs.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_eleme_phantom_orders.js
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
console.log('now: ' + new Date().toISOString() + '\n');

const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const has = (o, k) => o && typeof o === 'object' && o[k] != null && o[k] !== '';

// Order-level facts a single food never carries.
const ORDER_MARKS = ['settlementInfo', 'printDataInfo', 'foodInfo', 'deliveryFee',
                     'consumerTotal', 'statusDesc', 'orderStatusDesc', 'address',
                     'expectArrivalTime', 'createdAt', 'daySn'];
// Food-level facts an order envelope never carries at its top level.
const FOOD_MARKS  = ['skuId', 'vfoodId', 'eleItemCode', 'mealPreparation', 'newSpecs',
                     'originalName', 'upcCode', 'shopPrice', 'userPrice', 'isCombo'];

// ══ 1. Every Eleme row, last 14 days ════════════════════════════════════════
console.log('══ 1. Every eleme row in retail_orders, last 14 days ═══════════\n');

const rows = db.prepare(`
  SELECT o.id, o.order_no, o.status, o.channel, o.subtotal, o.total, o.store_id,
         o.customer_id, o.placed_at, o.paid_at,
         o.channel_commission, o.channel_settle_amount,
         i.eleme_order_id, i.imported_at, i.status AS import_status,
         i.raw_payload, i.detail_json, LENGTH(i.raw_payload) AS raw_len,
         (SELECT COUNT(*) FROM retail_order_items ri WHERE ri.order_id = o.id) AS lines,
         (SELECT COUNT(*) FROM retail_order_items ri WHERE ri.order_id = o.id AND ri.line_total > 0) AS priced_lines
    FROM retail_orders o
    LEFT JOIN eleme_order_import i ON i.retail_order_id = o.id
   WHERE o.channel = 'eleme'
     AND COALESCE(o.placed_at, o.paid_at) >= datetime('now', '-14 days')
   ORDER BY COALESCE(i.imported_at, o.placed_at)
`).all();

const logForOrder = db.prepare(`
  SELECT event_type, status, detail, created_at FROM eleme_sync_log
   WHERE event_type = 'order_import' AND detail LIKE ? ORDER BY id
`);

const suspects = [];
console.log('  verdict  order_no          eleme_order_id        imported_at          status     sub/total    lines  raw   payload shape');
for (const r of rows) {
  const raw = parseJson(r.raw_payload);
  const orderMarks = raw ? ORDER_MARKS.filter(k => has(raw, k)) : [];
  const foodMarks  = raw ? FOOD_MARKS.filter(k => has(raw, k)) : [];
  const isFoodObject = !!raw && orderMarks.length === 0 && foodMarks.length > 0;

  const logs = r.eleme_order_id ? logForOrder.all('%' + r.eleme_order_id + '%') : [];
  let loggedItems = null;
  for (const l of logs) {
    const m = /"items"\s*:\s*(\d+)/.exec(String(l.detail || ''));
    if (m) loggedItems = Number(m[1]);
  }
  const subEqTotal = r.subtotal != null && r.total != null && Math.abs(r.subtotal - r.total) <= 0.011;

  const marks = [];
  if (isFoodObject)          marks.push('FOOD-OBJECT');
  if (loggedItems === 0)     marks.push('items:0');
  if (subEqTotal && r.priced_lines === 0) marks.push('sub==total,unpriced');

  const verdict = isFoodObject ? 'PHANTOM' : (marks.length ? 'suspect' : '  ok   ');
  if (marks.length) suspects.push({ r, raw, marks, orderMarks, foodMarks, loggedItems });

  console.log(
    `  ${verdict.padEnd(8)} ${String(r.order_no).padEnd(17)} ${String(r.eleme_order_id || '-').padEnd(21)}` +
    ` ${String(r.imported_at || '').padEnd(20)} ${String(r.status).padEnd(10)}` +
    ` ${String(r.subtotal)}/${String(r.total)}`.padEnd(13) +
    ` ${r.priced_lines}/${r.lines}` +
    `   ${String(r.raw_len || 0).padStart(5)}  ${isFoodObject ? 'FOOD: ' + foodMarks.slice(0, 5).join(',') : 'order: ' + orderMarks.slice(0, 5).join(',')}`);
}
console.log('');
console.log(`  ${rows.length} eleme row(s) in 14 days; ${suspects.length} carry at least one mark.`);
const phantoms = suspects.filter(s => s.marks.includes('FOOD-OBJECT'));
if (phantoms.length) {
  const last = phantoms[phantoms.length - 1];
  console.log(`  MOST RECENT phantom: ${last.r.order_no} imported ${last.r.imported_at}`);
} else {
  console.log('  No FOOD-OBJECT row in the last 14 days.');
}
// The newest eleme import of any kind — so "no phantoms" can be told apart from
// "no orders at all since the last phantom".
const newest = db.prepare(`SELECT eleme_order_id, imported_at FROM eleme_order_import ORDER BY imported_at DESC LIMIT 1`).get();
console.log(`  Newest eleme import of ANY kind: ${newest ? newest.eleme_order_id + ' at ' + newest.imported_at : '(none)'}`);
console.log('');

// ══ 2. The suspect rows, in detail ══════════════════════════════════════════
console.log('══ 2. Suspect rows in detail ═══════════════════════════════════\n');
for (const s of suspects) {
  console.log(`${s.r.order_no} (retail_orders id ${s.r.id}) — ${s.marks.join(' + ')}`);
  console.log(`   eleme_order_id=${s.r.eleme_order_id}  imported_at=${s.r.imported_at}  status=${s.r.status}  customer_id=${s.r.customer_id}  store_id=${s.r.store_id}`);
  console.log(`   subtotal=${s.r.subtotal} total=${s.r.total} lines=${s.r.lines} priced=${s.r.priced_lines} commission=${s.r.channel_commission} income=${s.r.channel_settle_amount}`);
  console.log(`   payload top-level keys: ${s.raw ? Object.keys(s.raw).join(', ') : '(unparseable)'}`);
  console.log(`   order-marks present: [${s.orderMarks.join(', ') || 'none'}]   food-marks present: [${s.foodMarks.join(', ') || 'none'}]`);
  console.log(`   sync-log items: ${s.loggedItems === null ? '(no line found)' : s.loggedItems}`);
  console.log('');
}

// ══ 3. The polls that produced them ═════════════════════════════════════════
// Every sync-log row inside a 4-minute window around each suspect import, so a
// poll that ALSO imported a real order is visible as such.
console.log('══ 3. The affected polls, reconstructed ════════════════════════\n');
const windows = [...new Set(suspects.map(s => s.r.imported_at))];
for (const w of windows) {
  console.log(`── poll window around ${w} ──────────────────────────`);
  const near = db.prepare(`
    SELECT id, store_code, event_type, status, detail, error_msg, created_at
      FROM eleme_sync_log
     WHERE created_at BETWEEN datetime(?, '-4 minutes') AND datetime(?, '+4 minutes')
     ORDER BY id
  `).all(w, w);
  if (!near.length) console.log('   (no sync-log rows in the window)');
  for (const l of near) {
    console.log(`   ${l.created_at} ${String(l.store_code).padEnd(8)} ${String(l.event_type).padEnd(20)} ${String(l.status).padEnd(6)} ${String(l.detail || l.error_msg || '').slice(0, 220)}`);
  }
  console.log('');
}

// ══ 4. Expected vs actual on the affected days ══════════════════════════════
console.log('══ 4. Orders per day: what the log saw vs what we hold ═════════\n');
console.log('   date        imports_logged  import_rows  retail_rows  phantom_rows');
const days = db.prepare(`
  SELECT DATE(created_at) AS d, COUNT(*) AS n
    FROM eleme_sync_log WHERE event_type = 'order_import' AND status = 'ok'
     AND created_at >= datetime('now','-14 days')
   GROUP BY d ORDER BY d
`).all();
const impByDay = db.prepare(`SELECT COUNT(*) AS n FROM eleme_order_import WHERE DATE(imported_at) = ?`);
const rowsByDay = db.prepare(`SELECT COUNT(*) AS n FROM retail_orders WHERE channel='eleme' AND DATE(COALESCE(placed_at,paid_at)) = ?`);
for (const d of days) {
  const ph = suspects.filter(s => s.marks.includes('FOOD-OBJECT') && String(s.r.imported_at || '').startsWith(d.d)).length;
  console.log(`   ${d.d}  ${String(d.n).padStart(14)}  ${String(impByDay.get(d.d).n).padStart(11)}  ${String(rowsByDay.get(d.d).n).padStart(11)}  ${String(ph).padStart(12)}`);
}
console.log('');

// order_poll / order_shape lines on the affected days say how many orders the
// poll believed it saw, which is the only independent count of "real orders".
console.log('── order_poll / order_shape lines, 29-31 Aug ────────────────');
const polls = db.prepare(`
  SELECT created_at, store_code, event_type, status, detail, error_msg
    FROM eleme_sync_log
   WHERE event_type IN ('order_poll','order_shape','order_poll_down','order_poll_recovered','order_rpc_requests')
     AND DATE(created_at) BETWEEN '2026-08-29' AND '2026-08-31'
   ORDER BY id
`).all();
if (!polls.length) console.log('   (none)');
for (const l of polls) {
  console.log(`   ${l.created_at} ${String(l.store_code).padEnd(8)} ${String(l.event_type).padEnd(20)} ${String(l.status).padEnd(6)} ${String(l.detail || l.error_msg || '').slice(0, 300)}`);
}
console.log('');

// ══ 5. Are the phantoms inside the revenue filters? ═════════════════════════
// The Dashboard's composition/revenue queries filter on
//   status IN ('paid','preparing','dispatched','delivered','awaiting_restock')
// with NO channel filter (routes/retail.js PAID). This prints whether each
// phantom satisfies that, and what it would contribute.
console.log('══ 5. Do the phantom rows fall inside the revenue filters? ═════\n');
const PAID = ['paid', 'preparing', 'dispatched', 'delivered', 'awaiting_restock'];
let sumTotal = 0, sumSub = 0, inPaid = 0;
for (const s of phantoms) {
  const within = PAID.includes(s.r.status);
  if (within) { inPaid++; sumTotal += Number(s.r.total) || 0; sumSub += Number(s.r.subtotal) || 0; }
  console.log(`   ${s.r.order_no}  status=${s.r.status}  inside PAID filter: ${within ? 'YES' : 'no'}  total=${s.r.total} subtotal=${s.r.subtotal} customer_id=${s.r.customer_id} store_id=${s.r.store_id} lines=${s.r.lines}`);
}
console.log(`   ${inPaid} of ${phantoms.length} phantom row(s) sit inside the PAID status filter.`);
console.log(`   they contribute total=${Math.round(sumTotal * 100) / 100}  subtotal=${Math.round(sumSub * 100) / 100} to any unfiltered sum over those columns.`);
console.log(`   per-product allocation (routes/retail.js) needs channel_settle_amount NOT NULL and priced lines:`);
for (const s of phantoms) {
  console.log(`      ${s.r.order_no}: channel_settle_amount=${s.r.channel_settle_amount} priced_lines=${s.r.priced_lines} → ${(s.r.channel_settle_amount != null && s.r.priced_lines > 0) ? 'WOULD be allocated' : 'excluded'}`);
}
console.log('');
