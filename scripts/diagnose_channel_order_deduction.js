#!/usr/bin/env node
/**
 * diagnose_channel_order_deduction.js — did the last channel orders take stock?
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_channel_order_deduction.js
 *
 * READ-ONLY, and it proves that on the connection before reading anything.
 *
 * WHY THIS EXISTS
 * ---------------
 * Eleme and Meituan orders are supposed to deduct at INGEST: routes/*-internal.js
 * `/ingest-order` walks the resolved lines and calls inventory.adjustStock once
 * per matched line, which writes a `retail_stock_ledger` row with reason
 * 'eleme_order' / 'meituan_order' and a note naming the platform's own order ref.
 *
 * Three ways an order can end up with no deduction, and the row alone cannot
 * tell them apart:
 *
 *   1. UNRESOLVED LINES — resolveProduct() found no store_products row, so the
 *      line has product_id NULL and the loop `continue`s. Logged as
 *      'order_unsynced' in the channel's sync log, and nowhere else.
 *   2. BORN VOID — the order's first sighting was already cancelled/refunded, so
 *      the ingest records it with channel_stock_restored = 1 and skips the
 *      deduction on purpose. Logged as 'order_born_void'.
 *   3. NEVER INGESTED — the daemon saw the order but the internal POST failed, so
 *      the import row landed with status 'error' and retail_order_id NULL.
 *
 * This prints, per recent channel order: its lines, whether each line resolved,
 * and whether a ledger row actually exists for it. The last column is the answer;
 * everything else is why.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const APP    = process.env.ROOTS_APP || '/root/roots-v2';
const LIMIT  = parseInt(process.env.DEDUCT_DIAG_LIMIT, 10) || 20;
const DAYS   = parseInt(process.env.DEDUCT_DIAG_DAYS, 10) || 14;

let Database;
try { Database = require(path.join(APP, 'node_modules', 'better-sqlite3')); }
catch (e) { console.error('cannot load better-sqlite3: ' + e.message); process.exit(2); }

function candidates() {
  const list = [process.env.ROOTS_DB || path.join(APP, 'data', 'roots.db')];
  try {
    const d = path.join(APP, 'data', 'tenants');
    for (const f of fs.readdirSync(d)) if (f.endsWith('.db')) list.push(path.join(d, f));
  } catch (_) { /* single tenant */ }
  return list.filter(f => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } });
}

const ago = (t) => {
  if (!t) return 'never';
  const ms = Date.now() - (Date.parse(String(t).replace(' ', 'T') + (String(t).includes('Z') ? '' : 'Z')) || 0);
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
};

// Which import table and which ledger reason belong to a channel.
// `key` and `at` are the real column names, which differ between the two tables
// (eleme_order_id vs meituan_order_no; both stamp imported_at, not created_at).
const CH = {
  eleme: {
    imp: 'eleme_order_import', key: 'eleme_order_id', at: 'imported_at',
    log: 'eleme_sync_log',
    reason: 'eleme_order', back: 'eleme_cancel', again: 'eleme_uncancel',
  },
  meituan: {
    imp: 'meituan_order_import', key: 'meituan_order_no', at: 'imported_at',
    log: 'meituan_sync_log',
    reason: 'meituan_order', back: 'meituan_cancel', again: 'meituan_uncancel',
  },
};

const files = candidates();
console.log(`Databases to read (${files.length}): ${files.join(', ') || '(none found)'}`);

let examined = 0;
for (const file of files) {
  let db;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); }
  catch (e) { console.log(`\n${file}: cannot open read-only — ${e.message}`); continue; }
  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); } catch (_) { proven = true; }
  if (!proven) { console.error(`FATAL: ${file} accepted a write — reading nothing`); try { db.close(); } catch (_) {} continue; }

  // A SWALLOWED ERROR READS EXACTLY LIKE AN EMPTY TABLE, and that cost a live
  // run: the first version returned [] on any SQL failure, so a column this
  // script had guessed wrong would print "no database on this box holds
  // eleme/meituan orders" — a confident answer about production drawn from a
  // typo. Failures are announced now, once per distinct statement, and the empty
  // result is still returned so one bad query never takes the whole survey down.
  const complained = new Set();
  const moan = (sql, e) => {
    const key = sql.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (complained.has(key)) return;
    complained.add(key);
    console.error(`  ! query failed: ${e.message}\n    ${key}…`);
  };
  const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { moan(sql, e); return []; } };
  const one = (sql, ...a) => { try { return db.prepare(sql).get(...a) || null; } catch (e) { moan(sql, e); return null; } };
  // sqlite_master lookups are the one place an "error" is an ordinary answer —
  // a table that isn't there is a fact, not a fault — so this one stays quiet.
  const has = (t) => { try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t); } catch (_) { return false; } };
  const col = (t, c) => { try { return db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c); } catch (_) { return false; } };
  if (!has('retail_orders')) { console.log(`\n${file}: no retail_orders table — skipped`); try { db.close(); } catch (_) {} continue; }

  // Where the time went. None of the reads below can use an index — a ledger
  // row's only link to its order is free text in `note` — so a run that gets
  // slow gets slow somewhere specific, and a job killed at the ten-minute mark
  // takes the answer with it. Printed, not silent, and only when it is worth
  // saying.
  let mark = Date.now();
  const step = (what, n) => {
    const ms = Date.now() - mark;
    mark = Date.now();
    if (ms > 250) console.log(`  [${what}: ${(ms / 1000).toFixed(1)}s${n != null ? `, ${n} rows` : ''}]`);
  };

  const orders = all(`
    SELECT id, order_no, channel, status, channel_status, placed_at, created_at,
           store_id, total, channel_stock_restored
      FROM retail_orders
     WHERE channel IN ('eleme','meituan')
     ORDER BY id DESC
     LIMIT ?
  `, LIMIT);
  examined++;
  console.log(`\n${file}`);
  console.log('='.repeat(78));

  // WHAT `channel` ACTUALLY HOLDS on this box, before anything is concluded from
  // filtering on two of its values. The ingests write 'eleme' and 'meituan'
  // (routes/*-internal.js), and 闪购 orders come through the Meituan ingest so
  // they land under 'meituan' too — but a census costs one grouped read and is
  // the difference between "no such orders" and "they are filed under a name
  // this script did not ask for".
  step('open + census read');
  console.log('\nOrders by channel (all time):');
  for (const r of all(`
    SELECT COALESCE(channel,'(null)') channel, COUNT(*) n, MAX(created_at) newest
      FROM retail_orders GROUP BY channel ORDER BY n DESC
  `)) {
    console.log(`  ${String(r.channel).padEnd(14)} ${String(r.n).padStart(6)}   newest ${ago(r.newest)}`);
  }

  if (!orders.length) {
    console.log('\nNo orders with channel eleme/meituan in this database.');
    try { db.close(); } catch (_) {}
    continue;
  }

  // ── ONE SCAN, NOT ONE PER LINE ─────────────────────────────────────────────
  // The only link from a ledger row back to the order that caused it is the free
  // text in `note` (adjustStock is called here with its default ref_table /
  // ref_id, so the indexed provenance columns are empty for these rows — see the
  // PROVENANCE note in lib/inventory.js). `note LIKE '%ref%'` cannot use an
  // index, so asking it once per order line is one full scan of the ledger per
  // line: the first version of this script ran for ten minutes against the live
  // database and was killed. Read the window ONCE, match the refs in JS.
  const PACK_COL = col('retail_order_items', 'pack_units') ? 'oi.pack_units' : '1 AS pack_units';

  const REASONS = ['eleme_order', 'eleme_cancel', 'eleme_uncancel',
                   'meituan_order', 'meituan_cancel', 'meituan_uncancel'];
  const ledgerWindow = has('retail_stock_ledger') ? all(`
    SELECT id, store_id, product_id, delta, reason, balance_after, created_at, note
      FROM retail_stock_ledger
     WHERE reason IN (${REASONS.map(() => '?').join(',')})
       AND created_at >= datetime('now', ?)
     ORDER BY id
  `, ...REASONS, `-${DAYS} days`) : [];
  step('ledger window', ledgerWindow.length);

  // Same argument for the two sync logs: read the window once, match in JS.
  //
  // NARROWED TO THE ORDER EVENTS, and that is not tidiness. These logs also carry
  // the queue drain, which runs every 10 seconds per daemon — on the order of
  // 10^5 rows over a fortnight, each with a JSON `detail` — and the unfiltered
  // window meant marshalling all of them into JS and then running a substring
  // scan over the lot once per order. `detail` is truncated for the same reason:
  // this only ever reads the ref out of it, and every one of these events puts
  // the ref in the first field it writes.
  const LOG_EVENTS = [
    'order_import', 'order_unsynced', 'order_born_void', 'order_oversold',
    'order_total_mismatch', 'order_settlement_mismatch', 'order_status_unmapped',
    'order_restocked', 'order_rededucted', 'order_void_restock', 'order_void_rededuct',
    'order_unparsed',
  ];
  const logWindow = {};
  for (const ch of Object.keys(CH)) {
    logWindow[ch] = has(CH[ch].log) ? all(`
      SELECT store_code, event_type, status,
             substr(detail, 1, 400) AS detail, substr(error_msg, 1, 400) AS error_msg,
             created_at
        FROM ${CH[ch].log}
       WHERE event_type IN (${LOG_EVENTS.map(() => '?').join(',')})
         AND created_at >= datetime('now', ?)
       ORDER BY id DESC
       LIMIT 2000
    `, ...LOG_EVENTS, `-${DAYS} days`) : [];
    step(`${ch} log window`, logWindow[ch].length);
  }

  // ── The headline: of the recent channel orders, how many took stock? ────────
  let noDeduct = 0;
  const verdicts = [];

  for (const o of orders) {
    const c = CH[o.channel];
    const impRow = c && has(c.imp)
      ? one(`SELECT ${c.key} AS ref, status FROM ${c.imp} WHERE retail_order_id = ?`, o.id)
      : null;
    const ref = impRow ? String(impRow.ref) : null;

    const items = all(`
      SELECT oi.id, oi.product_id, oi.name_cn, oi.name_en, oi.qty,
             ${PACK_COL},
             p.name_en AS prod_en, p.is_active AS prod_active
        FROM retail_order_items oi
        LEFT JOIN store_products p ON p.id = oi.product_id
       WHERE oi.order_id = ?
       ORDER BY oi.id
    `, o.id);

    // Ledger rows this order's ingest would have written. adjustStock stamps
    // ref_table 'retail_store_stock' / ref_id NULL (it is called with the
    // defaults here), so the ONLY link back to the order is the note — which
    // always carries the platform ref. Matched per product so a partially
    // deducted order is visible as such.
    //
    // All THREE reasons the channel writes, not just the ingest one: an order
    // that deducted at ingest and was handed back by a later 已取消 poll
    // (reason *_cancel) reads as "not deducted" on the shelf while having a
    // perfectly good ingest row, and the two are only distinguishable together.
    const mine = new Set([c && c.reason, c && c.back, c && c.again].filter(Boolean));
    const ledgerFor = (productId) => {
      if (!ref) return [];
      return ledgerWindow.filter(r =>
        mine.has(r.reason) && r.store_id === o.store_id && r.product_id === productId &&
        String(r.note || '').includes(ref));
    };

    const lines = items.map(it => {
      const led = it.product_id ? ledgerFor(it.product_id) : [];
      // `took` is the NET effect on the shelf; `ingested` is whether the ingest
      // itself ever ran for this line. A cancel that gave the units back leaves
      // took = 0 with ingested true, which is a different fault from never
      // having deducted at all.
      const took = led.reduce((a, r) => a + (r.delta || 0), 0);
      const ingested = led.some(r => r.reason === c.reason);
      return { it, led, took, ingested };
    });

    const anyDeduct = lines.some(l => l.ingested);
    const handedBack = lines.some(l => l.led.some(r => r.reason === c.back));
    const allMatched = items.length > 0 && items.every(i => i.product_id);
    if (!anyDeduct) noDeduct++;

    // The reason, in the order the ingest would have decided it.
    let why = 'DEDUCTED';
    if (!anyDeduct) {
      if (!impRow || !ref) why = 'NO IMPORT ROW — order not linked to a platform ref';
      else if (o.channel_stock_restored === 1) why = 'born void / restored — deduction skipped by design';
      else if (!items.length) why = 'order has no line items at all';
      else if (!items.some(i => i.product_id)) why = 'ALL LINES UNRESOLVED — no product matched';
      else why = 'LINES MATCHED BUT NO LEDGER ROW — ingest deduction did not run';
    } else if (handedBack) {
      why = 'DEDUCTED THEN RESTORED — a later poll read the order as voided';
    } else if (!allMatched) {
      why = 'PARTIAL — some lines unresolved';
    }
    verdicts.push({ o, ref, why });

    console.log(`\n#${o.id}  ${o.order_no}  [${o.channel}]  ${ref ? `ref ${ref}` : 'ref ?'}`);
    console.log(`   status=${o.status}  channel_status=${o.channel_status || '-'}  ` +
                `restored=${o.channel_stock_restored}  store=${o.store_id}  ¥${o.total}`);
    console.log(`   placed ${o.placed_at || '-'} (${ago(o.placed_at || o.created_at)})` +
                (impRow ? `  import=${impRow.status}` : '  import=(none)'));
    console.log(`   → ${why}`);
    for (const { it, led, took, ingested } of lines) {
      const name = it.name_en || it.name_cn || '(unnamed)';
      const pid  = it.product_id ? `product ${it.product_id}${it.prod_active === 0 ? ' (INACTIVE)' : ''}` : 'UNRESOLVED';
      const want = (parseInt(it.qty, 10) || 0) * (parseInt(it.pack_units, 10) || 1);
      console.log(`     · ${String(name).slice(0, 40).padEnd(40)} x${it.qty}` +
                  ` pack=${it.pack_units}  ${pid}`);
      if (it.product_id) {
        if (!led.length) console.log(`         NO LEDGER ROW (expected −${want})`);
        else for (const r of led) console.log(`         ledger #${r.id} ${r.reason} Δ${r.delta} → ${r.balance_after}  ${ago(r.created_at)}`);
        if (ingested && took !== -want) console.log(`         ⚠ net ${took} on the shelf, ingest expected −${want}`);
      }
    }

    // What the channel's own sync log said about this order, if anything.
    if (c && ref) {
      const logs = (logWindow[o.channel] || []).filter(l =>
        String(l.detail || '').includes(ref) || String(l.error_msg || '').includes(ref)
      ).slice(0, 6);
      for (const l of logs) {
        console.log(`     log  ${l.event_type} [${l.status}] ${String(l.error_msg || '').slice(0, 120)}  (${ago(l.created_at)})`);
      }
    }
  }

  console.log('\n' + '-'.repeat(78));
  console.log(`Of the last ${orders.length} eleme/meituan orders, ${noDeduct} have NO stock ledger row.`);
  for (const v of verdicts.filter(v => v.why !== 'DEDUCTED')) {
    console.log(`  #${v.o.id} ${v.o.order_no} [${v.o.channel}] ${v.ref || '?'} — ${v.why}`);
  }

  // ── Is this a per-order miss or has the whole path stopped? ────────────────
  console.log(`\nChannel stock ledger activity, last ${DAYS} days:`);
  for (const reason of REASONS) {
    const rows = ledgerWindow.filter(r => r.reason === reason);
    const newest = rows.length ? rows[rows.length - 1].created_at : null;
    console.log(`  ${reason.padEnd(16)} ${String(rows.length).padStart(5)} rows, newest ${ago(newest)}`);
  }
  console.log(`\nChannel orders mirrored, last ${DAYS} days:`);
  for (const ch of ['eleme', 'meituan']) {
    const r = one(`
      SELECT COUNT(*) n, MAX(created_at) newest
        FROM retail_orders
       WHERE channel = ? AND created_at >= datetime('now', ?)
    `, ch, `-${DAYS} days`);
    console.log(`  ${ch.padEnd(16)} ${String(r ? r.n : 0).padStart(5)} orders, newest ${ago(r && r.newest)}`);
  }

  // ── Import rows the daemon could not mirror at all ─────────────────────────
  for (const ch of ['eleme', 'meituan']) {
    const c = CH[ch];
    if (!has(c.imp)) continue;
    const bad = all(`
      SELECT ${c.key} AS ref, status, ${c.at} AS at
        FROM ${c.imp}
       WHERE (retail_order_id IS NULL OR status NOT IN ('imported','accepted'))
         AND ${c.at} >= datetime('now', ?)
       ORDER BY id DESC LIMIT 10
    `, `-${DAYS} days`);
    if (bad.length) {
      console.log(`\n${ch}: ${bad.length} import row(s) with no mirrored order:`);
      for (const b of bad) console.log(`  ${b.ref}  status=${b.status}  ${ago(b.at)}`);
    }
  }

  // ── Unresolved-line warnings, the most common cause ────────────────────────
  for (const ch of ['eleme', 'meituan']) {
    const rows = (logWindow[ch] || [])
      .filter(r => r.event_type === 'order_unsynced' || r.event_type === 'order_born_void')
      .slice(0, 12);
    if (rows.length) {
      console.log(`\n${ch} unsynced/born-void warnings (last ${DAYS}d, newest first):`);
      for (const r of rows) console.log(`  ${String(r.store_code || '-').padEnd(10)} ${String(r.error_msg || '').slice(0, 130)}  (${ago(r.created_at)})`);
    }
  }

  try { db.close(); } catch (_) {}
}

if (!examined) console.log('no database on this box could be opened with a retail_orders table');
console.log('');
