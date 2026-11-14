#!/usr/bin/env node
/**
 * diagnose_coconut_yogurt_1190_today.js
 *
 * Shelf tag photographed 2026-11-08: "Probiotic Coconut Yogurt - Vanilla
 * Flavor" / 纯素椰子酸奶-香草味, ¥29, SKU 1-190. The catalogue has previously
 * recorded 1-190 as peach, so this prints every coconut-yogurt row that could
 * be that tub, then the full Guangzhou-day ledger for the SKU on the tag and
 * for any row whose name is vanilla.
 *
 * Read-only. Opens SQLite readonly and proves a write is rejected before any
 * SELECT. No customer names, phones or addresses.
 *
 *   node scripts/diagnose_coconut_yogurt_1190_today.js
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

function cols(table) {
  try { return new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name)); }
  catch (e) { return new Set(); }
}
const spCols = cols('store_products');
const ledCols = cols('retail_stock_ledger');
const stCols = cols('retail_store_stock');
const storeCols = cols('retail_stores');

function zoneOffsetMinutes(tz, at) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map(x => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - at.getTime()) / 60000);
}
function ymdIn(tz, at) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
}

let tz = 'Asia/Shanghai';
try {
  const row = db.prepare(
    `SELECT timezone FROM retail_stores
      WHERE is_active = 1 AND timezone IS NOT NULL AND TRIM(timezone) <> ''
      ORDER BY ${storeCols.has('sort_order') ? 'sort_order, ' : ''}id LIMIT 1`
  ).get();
  if (row && String(row.timezone).trim()) tz = String(row.timezone).trim();
} catch (e) { /* keep Shanghai */ }

const now = new Date();
const off = zoneOffsetMinutes(tz, now);
const shift = (off < 0 ? '-' : '+') + Math.abs(off) + ' minutes';
const today = ymdIn(tz, now);

console.log('DB        : ' + DB_PATH);
console.log('run at    : ' + now.toISOString());
console.log('shop zone : ' + tz + '  shift ' + shift);
console.log('shop today: ' + today);
console.log('ledger.actor_label: ' + (ledCols.has('actor_label') ? 'present' : 'MISSING'));
console.log('ledger.channel    : ' + (ledCols.has('channel') ? 'present' : 'MISSING'));
console.log('');

const priceExpr = spCols.has('sell_price') ? 'sell_price' : 'NULL';
const activeExpr = spCols.has('is_active') ? 'is_active' : 'NULL';
const pubExpr = spCols.has('is_published') ? 'is_published' : 'NULL';

const products = db.prepare(`
  SELECT id, sku, name_en, name_cn, ${priceExpr} AS sell_price,
         ${activeExpr} AS is_active, ${pubExpr} AS is_published
    FROM store_products
   WHERE UPPER(TRIM(sku)) IN ('1-190','1-150','1-160','1-180','1-130','1-140')
      OR (
        (COALESCE(name_en,'') LIKE '%ogurt%' OR COALESCE(name_cn,'') LIKE '%酸奶%')
        AND (
          COALESCE(name_en,'') LIKE '%anilla%' OR COALESCE(name_cn,'') LIKE '%香草%'
          OR COALESCE(name_en,'') LIKE '%each%' OR COALESCE(name_cn,'') LIKE '%桃%'
          OR COALESCE(name_en,'') LIKE '%Plain%' OR COALESCE(name_cn,'') LIKE '%原味%'
          OR UPPER(TRIM(sku)) = '1-190'
        )
      )
   ORDER BY sku, id
`).all();

console.log('══ 1 · coconut yogurt rows that could be the tub on the shelf ══');
console.log('  id | sku | ¥ | act | pub | name_en | name_cn');
for (const p of products) {
  console.log(`  ${p.id} | ${p.sku} | ${p.sell_price} | ${p.is_active} | ${p.is_published} | ${p.name_en || ''} | ${p.name_cn || ''}`);
}
if (!products.length) console.log('  (none)');

const tagSku = products.filter(p => String(p.sku || '').trim().toUpperCase() === '1-190');
const vanilla = products.filter(p => /vanilla/i.test(p.name_en || '') || /香草/.test(p.name_cn || ''));
const focusIds = [];
const seen = new Set();
for (const p of tagSku.concat(vanilla)) {
  if (seen.has(p.id)) continue;
  seen.add(p.id);
  focusIds.push(p.id);
}
console.log('\nFocus product ids (SKU 1-190 on the tag, plus any vanilla-named row): ' + (focusIds.join(', ') || '(none)'));

const storeName = storeCols.has('name_en')
  ? `COALESCE(NULLIF(TRIM(s.name_en),''), NULLIF(TRIM(s.name_cn),''), s.code, '#'||s.id)`
  : `COALESCE(s.code, '#'||s.id)`;

console.log('\n══ 2 · on-hand now, every store, for those rows ══');
if (focusIds.length) {
  const qMarks = focusIds.map(() => '?').join(',');
  const buf = stCols.has('safety_buffer') ? 'st.safety_buffer' : 'NULL';
  const upd = stCols.has('updated_at') ? 'st.updated_at' : 'NULL';
  const rows = db.prepare(`
    SELECT p.id AS product_id, p.sku, ${storeName} AS store, s.id AS store_id,
           st.physical_qty, ${buf} AS safety_buffer, ${upd} AS stock_updated_at
      FROM store_products p
      JOIN retail_store_stock st ON st.product_id = p.id
      JOIN retail_stores s ON s.id = st.store_id
     WHERE p.id IN (${qMarks})
     ORDER BY p.sku, s.id
  `).all(...focusIds);
  console.log('  sku | store | physical | buffer | stock_updated_at');
  for (const r of rows) {
    console.log(`  ${r.sku} | ${r.store} (#${r.store_id}) | ${r.physical_qty} | ${r.safety_buffer} | ${r.stock_updated_at || ''}`);
  }
  if (!rows.length) console.log('  (no retail_store_stock rows)');

  let holds = [];
  try {
    holds = db.prepare(`
      SELECT product_id, store_id, qty, status, expires_at
        FROM retail_stock_reservations
       WHERE product_id IN (${qMarks}) AND status = 'active'
         AND (expires_at IS NULL OR expires_at > datetime('now'))
    `).all(...focusIds);
  } catch (e) { console.log('  reservations: ' + e.message); }
  console.log('  active reservations: ' + (holds.length ? holds.map(h => `p${h.product_id}@store${h.store_id} qty=${h.qty} until ${h.expires_at}`).join('; ') : 'none'));
}

const actor = ledCols.has('actor_label') ? 'l.actor_label' : 'NULL';
const channel = ledCols.has('channel') ? 'l.channel' : 'NULL';
const note = ledCols.has('note') ? 'l.note' : 'NULL';
const refTable = ledCols.has('ref_table') ? 'l.ref_table' : 'NULL';
const refId = ledCols.has('ref_id') ? 'l.ref_id' : 'NULL';

function dumpDay(p) {
  console.log('\n' + '═'.repeat(78));
  console.log(`SKU ${p.sku}  #${p.id}  ${p.name_en || ''}  /  ${p.name_cn || ''}  ¥${p.sell_price}`);
  console.log('═'.repeat(78));

  const stores = db.prepare(`
    SELECT s.id AS store_id, ${storeName} AS store, st.physical_qty
      FROM retail_stores s
      LEFT JOIN retail_store_stock st ON st.store_id = s.id AND st.product_id = ?
     ORDER BY s.id
  `).all(p.id);

  for (const s of stores) {
    const prior = db.prepare(`
      SELECT id, balance_after, delta, reason, created_at,
             datetime(created_at, ?) AS local_ts
        FROM retail_stock_ledger
       WHERE product_id = ? AND store_id = ?
         AND datetime(created_at, ?) < ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1
    `).get(shift, p.id, s.store_id, shift, today + ' 00:00:00');

    const moves = db.prepare(`
      SELECT l.id, l.delta, l.balance_after, l.reason,
             ${actor} AS actor_label, ${channel} AS channel, ${note} AS note,
             ${refTable} AS ref_table, ${refId} AS ref_id,
             l.created_at,
             datetime(l.created_at, ?) AS local_ts,
             o.order_no
        FROM retail_stock_ledger l
        LEFT JOIN retail_orders o ON l.ref_table = 'retail_orders' AND o.id = l.ref_id
       WHERE l.product_id = ? AND l.store_id = ?
         AND date(datetime(l.created_at, ?)) = ?
       ORDER BY l.created_at, l.id
    `).all(shift, p.id, s.store_id, shift, today);

    if (s.physical_qty == null && !prior && !moves.length) continue;

    const morning = prior ? prior.balance_after : 0;
    const sumDelta = moves.reduce((a, m) => a + Number(m.delta), 0);
    const implied = Number(morning) + sumDelta;
    console.log(`\n  ${s.store} (#${s.store_id})`);
    console.log(`  morning (last balance before ${today} 00:00): ${morning}` +
      (prior ? `   [ledger #${prior.id} at ${prior.local_ts} ${prior.reason} delta ${prior.delta}]` : '   [no earlier ledger row — treated as 0]'));
    console.log(`  movements today: ${moves.length}    net today: ${sumDelta >= 0 ? '+' : ''}${sumDelta}`);
    console.log(`  implied now (morning + net): ${implied}    physical_qty on the shelf row: ${s.physical_qty == null ? '(no stock row)' : s.physical_qty}`);
    if (s.physical_qty != null && Number(s.physical_qty) !== implied) {
      console.log(`  !! shelf row disagrees with the ledger by ${Number(s.physical_qty) - implied}`);
    }
    if (!moves.length) {
      console.log('  (no movements today)');
      continue;
    }
    console.log('  local time | delta | balance | reason | channel | who | ref | note');
    let running = Number(morning);
    for (const m of moves) {
      const expect = running + Number(m.delta);
      const gap = Number(m.balance_after) !== expect ? `  !! chain gap, expected balance ${expect}` : '';
      running = Number(m.balance_after);
      const ref = m.order_no ? m.order_no : (m.ref_table ? `${m.ref_table}#${m.ref_id}` : '');
      const who = (m.actor_label || '').replace(/\s+/g, ' ').slice(0, 40);
      const n = (m.note || '').replace(/\s+/g, ' ').slice(0, 120);
      console.log(`  ${m.local_ts} | ${m.delta >= 0 ? '+' : ''}${m.delta} | ${m.balance_after} | ${m.reason} | ${m.channel || ''} | ${who} | ${ref} | ${n}${gap}`);
    }
  }
}

console.log('\n══ 3 · today\'s movements, morning through now ══');
for (const id of focusIds) dumpDay(products.find(p => p.id === id));

console.log('\n══ 4 · done ══');
