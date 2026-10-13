#!/usr/bin/env node
/**
 * Read-only: how long after the customer placed it did we first READ each
 * Meituan / Ele.me order — and so take its stock?
 *
 * Context (Ash, 2026-10-13, from staff): 美团 / 饿了么 预约单 do not come off the
 * stock count when they are placed, only around 出餐时间. The ingest routes take
 * stock the moment an order is ingested and never look at the pre-order time,
 * so any lag is between the customer placing the order and the daemon first
 * reading it. Two candidate causes, and this tells them apart:
 *
 *   A. The daemon's order poll is paused outside the store's sync window, so an
 *      order placed overnight waits for the window to open.
 *   B. The platform list the daemon reads does not show a pre-order until near
 *      its delivery time (Meituan: today-only date range; Ele.me: 进行中 list).
 *
 * If pre-orders placed DURING trading hours still lag by hours, it is B. If only
 * orders placed while the store is closed lag, it is A.
 *
 * Every statement here is a SELECT. The database is opened read-only and the
 * connection is PROVEN read-only before anything else runs.
 *
 *   Run through .github/workflows/ro-query.yml (manual dispatch).
 */
'use strict';

const DAYS = 30;

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
console.log('');

const all = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch (e) { return [{ ERROR: e.message }]; } };

// Times are stored UTC; everything printed is Shanghai (+8).
const SH = (col) => `strftime('%m-%d %H:%M', ${col}, '+8 hours')`;
const LAG = (a, b) => `CAST(ROUND((julianday(${a}) - julianday(${b})) * 1440) AS INTEGER)`;

const sources = [
  { name: 'meituan', table: 'meituan_order_import' },
  { name: 'eleme',   table: 'eleme_order_import' },
];

for (const { name, table } of sources) {
  console.log(`══ ${name} · last ${DAYS} days ══`);
  const rows = all(`
    SELECT o.order_no,
           i.store_code,
           ${SH('o.placed_at')}            AS placed_sh,
           ${SH('i.imported_at')}          AS read_sh,
           ${SH('o.channel_preorder_at')}  AS booked_sh,
           ${LAG('i.imported_at', 'o.placed_at')}          AS lag_min,
           ${LAG('o.channel_preorder_at', 'i.imported_at')} AS read_before_booked_min,
           o.status
      FROM ${table} i
      JOIN retail_orders o ON o.id = i.retail_order_id
     WHERE o.placed_at >= datetime('now', ?)
     ORDER BY o.placed_at`, `-${DAYS} days`);
  if (rows[0] && rows[0].ERROR) { console.log('ERROR: ' + rows[0].ERROR); console.log(''); continue; }

  const pre = rows.filter(r => r.booked_sh);
  const now = rows.filter(r => !r.booked_sh);
  const lags = (rs) => rs.map(r => r.lag_min).filter(x => x != null).sort((a, b) => a - b);
  const pct = (xs, p) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null;
  const sum = (label, rs) => {
    const xs = lags(rs);
    console.log(`${label}: ${rs.length} orders · lag placed→read (min) p50 ${pct(xs, 0.5)} · p90 ${pct(xs, 0.9)} · max ${xs.length ? xs[xs.length - 1] : null} · over 30 min: ${xs.filter(x => x > 30).length}`);
  };
  sum('normal orders', now);
  sum('pre-orders   ', pre);

  console.log('');
  console.log('every pre-order (Shanghai time):');
  for (const r of pre) {
    console.log(`  ${r.order_no}  ${r.store_code}  placed ${r.placed_sh}  read ${r.read_sh}  booked ${r.booked_sh}  lag ${r.lag_min}m  read ${r.read_before_booked_min}m before booked  ${r.status}`);
  }

  console.log('');
  console.log('normal orders read more than 30 min late (Shanghai time):');
  for (const r of now.filter(r => r.lag_min > 30)) {
    console.log(`  ${r.order_no}  ${r.store_code}  placed ${r.placed_sh}  read ${r.read_sh}  lag ${r.lag_min}m  ${r.status}`);
  }
  console.log('');
}

// Store hours, so each lag can be read against "was the shop open".
console.log('══ store hours as configured ══');
const hoursCols = all("SELECT name FROM pragma_table_info('retail_stores')").map(r => r.name);
const want = ['id', 'code', 'store_code', 'name', 'open_time', 'close_time', 'opens_at', 'closes_at', 'sync_start', 'hours'];
const cols = want.filter(c => hoursCols.includes(c));
console.log('columns read: ' + cols.join(', '));
if (cols.length) for (const r of all(`SELECT ${cols.join(', ')} FROM retail_stores`)) console.log('  ' + JSON.stringify(r));
console.log('retail_stores columns: ' + hoursCols.join(', '));

// ── Second pass: for each Meituan pre-order, every stock ledger row that names
// it, and what was then pushed to Meituan for those products. Settles whether
// the shelf actually dropped at read time and whether Meituan's own listing
// followed.
console.log('');
console.log('══ meituan pre-orders · ledger and push ══');
const preRows = all(`
  SELECT o.id, o.order_no, i.meituan_order_no, i.imported_at, o.channel_preorder_at, o.store_id
    FROM meituan_order_import i
    JOIN retail_orders o ON o.id = i.retail_order_id
   WHERE o.channel_preorder_at IS NOT NULL
     AND o.placed_at >= datetime('now', ?)
   ORDER BY o.placed_at`, `-${DAYS} days`);
for (const p of preRows) {
  if (p.ERROR) { console.log('ERROR: ' + p.ERROR); break; }
  console.log(`-- ${p.order_no} (meituan ${p.meituan_order_no}) read ${p.imported_at} UTC, booked ${p.channel_preorder_at} UTC`);
  const led = all(`
    SELECT id, ${SH('created_at')} AS at_sh, product_id, delta, balance_after, reason, ref_table, ref_id, note
      FROM retail_stock_ledger
     WHERE note LIKE ? OR note LIKE ? OR (ref_table = 'retail_orders' AND ref_id = ?)
     ORDER BY id`, `%${p.meituan_order_no}%`, `%${p.order_no}%`, p.id);
  for (const l of led) console.log('   ledger ' + JSON.stringify(l));
  if (!led.length) console.log('   ledger: NO ROWS name this order');
  const pids = [...new Set(led.map(l => l.product_id).filter(Boolean))];
  if (pids.length) {
    const q = all(`
      SELECT id, product_id, new_qty, status, ${SH('created_at')} AS queued_sh, ${SH('processed_at')} AS pushed_sh, last_error
        FROM meituan_sync_queue
       WHERE product_id IN (${pids.map(() => '?').join(',')})
         AND created_at BETWEEN datetime(?, '-10 minutes') AND datetime(?, '+30 minutes')
       ORDER BY id`, ...pids, p.imported_at, p.channel_preorder_at || p.imported_at);
    for (const r of q) console.log('   push   ' + JSON.stringify(r));
    if (!q.length) console.log('   push: nothing queued for these products between read and booked time (note: queue product_id may be a store_products id)');
  }
}

// ── Third pass: the exact Meituan status text behind each flip. The server
// keeps only the latest channel_status; the daemon prints every change as
// "order <no> status → <desc>" to its pm2 log. Read-only file reads.
console.log('');
console.log('══ meituan pre-orders · status text from the daemon log ══');
const fs = require('fs');
const path = require('path');
const PM2_LOGS = process.env.PM2_LOG_DIR || '/root/.pm2/logs';
let logFiles = [];
try { logFiles = fs.readdirSync(PM2_LOGS).filter(f => /meituan/i.test(f)).map(f => path.join(PM2_LOGS, f)); }
catch (e) { console.log('cannot list ' + PM2_LOGS + ': ' + e.message); }
console.log('log files: ' + logFiles.map(f => path.basename(f)).join(', '));
for (const p of preRows) {
  if (p.ERROR) break;
  const cur = all('SELECT status, channel_status, channel_status_at, channel_stock_restored FROM retail_orders WHERE id = ?', p.id);
  console.log(`-- ${p.order_no} (meituan ${p.meituan_order_no}) now: ${JSON.stringify(cur[0])}`);
  let hits = 0;
  for (const f of logFiles) {
    let txt = null;
    try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    for (const line of txt.split('\n')) {
      if (line.includes(p.meituan_order_no)) { console.log('   ' + path.basename(f) + ': ' + line.slice(0, 400)); hits++; }
    }
  }
  if (!hits) console.log('   no log lines name this order (logs may have rotated)');
}

// ── Fourth pass: every status text containing 取消 / 关闭 / 退 that the
// platforms have ever sent, with counts, so a rule that tells a delivery-leg
// cancel (配送已取消) from an order void is written against real wording.
console.log('');
console.log('══ every cancel-ish channel_status on file (latest per order) ══');
for (const r of all(`
  SELECT channel, channel_status, status, channel_stock_restored, COUNT(*) AS n
    FROM retail_orders
   WHERE channel_status LIKE '%取消%' OR channel_status LIKE '%关闭%' OR channel_status LIKE '%退%'
   GROUP BY channel, channel_status, status, channel_stock_restored
   ORDER BY channel, n DESC`)) console.log('  ' + JSON.stringify(r));

console.log('');
console.log('══ every cancel-ish status the daemons ever logged (all history in the logs) ══');
let allLogs = [];
try { allLogs = fs.readdirSync(PM2_LOGS).filter(f => /meituan|eleme|shangou/i.test(f) && /out/i.test(f)).map(f => path.join(PM2_LOGS, f)); } catch (_) {}
const seen = new Map();
for (const f of allLogs) {
  let txt = null;
  try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  for (const line of txt.split('\n')) {
    const m = line.match(/status → (.+)$/);
    if (!m || !/取消|关闭|退/.test(m[1])) continue;
    const k = path.basename(f) + ' :: ' + m[1].trim();
    seen.set(k, (seen.get(k) || 0) + 1);
  }
}
for (const [k, n] of [...seen.entries()].sort()) console.log(`  ${n}×  ${k}`);
if (!seen.size) console.log('  none');

console.log('');
console.log('══ meituan_cancel restores in the last 60 days, by order (did the order then go on to be delivered?) ══');
for (const r of all(`
  SELECT substr(l.note, 9, instr(substr(l.note, 9), ' ') - 1) AS mt_no,
         COUNT(*) AS restore_rows,
         MIN(${SH('l.created_at')}) AS first_restore_sh
    FROM retail_stock_ledger l
   WHERE l.reason = 'meituan_cancel' AND l.created_at >= datetime('now', '-60 days')
   GROUP BY mt_no ORDER BY first_restore_sh`)) {
  const o = all(`SELECT o.order_no, o.status, o.channel_status, o.channel_stock_restored, o.channel_preorder_at
                   FROM meituan_order_import i JOIN retail_orders o ON o.id = i.retail_order_id
                  WHERE i.meituan_order_no = ?`, r.mt_no)[0] || {};
  console.log('  ' + JSON.stringify({ ...r, ...o }));
}
