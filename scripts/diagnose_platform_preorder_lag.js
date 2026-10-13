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
