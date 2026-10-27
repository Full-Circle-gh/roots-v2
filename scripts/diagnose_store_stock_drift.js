#!/usr/bin/env node
/**
 * diagnose_store_stock_drift.js — where does a shop's stock count go wrong?
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_store_stock_drift.js
 *
 * READ-ONLY, and it proves that on each connection before reading anything.
 * It opens SQLite directly and requires no app module, because an app module
 * opens its own writable handle at load (see the memory note on read-only
 * probes that still wrote).
 *
 * WHAT WAS REPORTED
 * -----------------
 * One shop's count keeps parting from the shelf. The code has more than a dozen
 * writers to `retail_store_stock.physical_qty`; this asks the ledger which of
 * them is doing it, for EVERY active store, so the troubled shop can be read
 * against the others rather than alone.
 *
 * SECTIONS (per store, last DAYS days)
 *   1. Every ledger reason: rows, units in, units out.
 *   2. Recount corrections per product — the size and SIGN of what staff had to
 *      fix by hand. Positive = the system had too FEW (over-deducted somewhere);
 *      negative = it had too MANY (a sale not deducted, or added twice).
 *   3. Chain breaks: a ledger row whose previous balance + delta is not its own
 *      balance. Each one is stock that moved with no ledger row, or a ledger row
 *      that moved nothing — invisible writers.
 *   4. Shelf vs ledger: current physical_qty that disagrees with the last
 *      ledger balance for that product.
 *   5. Channel orders: per platform order and product, units taken vs units
 *      given back — restored more than taken (drifts UP), taken twice with no
 *      cancel (drifts DOWN).
 *   6. Rows that landed exactly on 0 while deducting — where a floor may have
 *      swallowed a shortfall that a later reversal then adds back in full.
 *   7. Rows below zero today.
 *
 * Window: STOCK_DRIFT_DAYS (default 60). The ro-query workflow passes no env, so
 * the default is what runs there.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const APP  = process.env.ROOTS_APP || '/root/roots-v2';
const DAYS = parseInt(process.env.STOCK_DRIFT_DAYS, 10) || 60;
const TOP  = 20;

let Database;
try { Database = require(path.join(APP, 'node_modules', 'better-sqlite3')); }
catch (e) { console.error('cannot load better-sqlite3: ' + e.message); process.exit(2); }

function candidates() {
  const list = [process.env.ROOTS_DB || path.join(APP, 'data', 'roots.db')];
  try {
    const d = path.join(APP, 'data', 'tenants');
    for (const f of fs.readdirSync(d)) if (f.endsWith('.db')) list.push(path.join(d, f));
  } catch (_) { /* single tenant */ }
  return list.filter(f => { try { return fs.statSync(f).isFile() && fs.statSync(f).size > 0; } catch (_) { return false; } });
}

// Reasons that SET a count rather than record a movement. Their delta is the
// correction a person had to make.
const RECOUNT = ['adjust', 'count', 'recount', 'kitchen_recount', 'stocktake', 'correction'];
const OUT_CH  = { meituan_order: 'Meituan', meituan_uncancel: 'Meituan', eleme_order: 'Eleme', eleme_uncancel: 'Eleme' };
const BACK_CH = { meituan_cancel: 'Meituan', eleme_cancel: 'Eleme' };

const pad = (s, n) => String(s).length >= n ? String(s) : String(s) + ' '.repeat(n - String(s).length);
const lpad = (s, n) => String(s).length >= n ? String(s) : ' '.repeat(n - String(s).length) + String(s);

const files = candidates();
console.log(`Databases to read (${files.length}): ${files.join(', ') || '(none found)'}`);
console.log(`Window: last ${DAYS} days\n`);

for (const file of files) {
  let db;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); }
  catch (e) { console.log(`${file}: cannot open read-only — ${e.message}`); continue; }
  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); } catch (_) { proven = true; }
  if (!proven) { console.error(`FATAL: ${file} accepted a write — reading nothing`); try { db.close(); } catch (_) {} continue; }

  // A failed statement must never read as an empty answer.
  const moan = (sql, e) => console.error(`  ! query failed: ${e.message}\n    ${sql.replace(/\s+/g, ' ').trim().slice(0, 90)}…`);
  const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { moan(sql, e); return []; } };
  const has = (t) => { try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t); } catch (_) { return false; } };
  if (!has('retail_stock_ledger') || !has('retail_stores')) { console.log(`${file}: no stock ledger — skipped\n`); db.close(); continue; }

  console.log(`════════ ${file} ════════`);
  const since = `-${DAYS} days`;
  const nameCols = all("SELECT name FROM pragma_table_info('retail_stores')").map(r => r.name);
  const label = ['name_en', 'name', 'name_cn', 'store_name'].find(c => nameCols.includes(c));
  const stores = all(`SELECT id, ${label ? label : "'store'"} AS label, COALESCE(is_active,1) AS active FROM retail_stores ORDER BY id`);
  // store_products has name_en / name_cn and no `name`; the first run asked for
  // `name` and printed every product as a bare id.
  const pname = (pid) => {
    const r = all(`SELECT COALESCE(NULLIF(name_en,''), name_cn, '') AS n FROM store_products WHERE id = ?`, pid)[0];
    return ('#' + pid + ' ' + (r && r.n ? r.n : '')).trim().slice(0, 38);
  };

  /* 0 · ARE CHANNEL ORDERS ARRIVING AT ALL, per store code. A store that sells
     on a platform but shows no imports in the window takes no stock for any of
     those sales. Printed once per database, before the per-store sections. */
  for (const [t, k] of [['meituan_order_import', 'Meituan'], ['eleme_order_import', 'Eleme']]) {
    if (!has(t)) continue;
    const rows = all(`SELECT store_code, COUNT(*) AS ever, MAX(imported_at) AS last_at,
                             SUM(imported_at >= datetime('now', ?)) AS recent
                        FROM ${t} GROUP BY store_code ORDER BY store_code`, since);
    console.log(`\n 0 · ${k} imports by store code: ${rows.map(r => `${r.store_code} ${r.recent || 0} in window / ${r.ever} ever, last ${r.last_at}`).join(' · ') || 'none ever'}`);
  }
  /* Is the platform reader alive for each store code, and what is it saying?
     A reader that polls and logs errors, or polls and finds nothing, reads very
     differently from one that stopped writing anything at all. */
  for (const t of ['meituan_sync_log', 'eleme_sync_log']) {
    if (!has(t)) continue;
    for (const c of all(`SELECT store_code, MAX(created_at) AS last_at FROM ${t} GROUP BY store_code`)) {
      const kinds = all(`SELECT event_type, status, COUNT(*) AS n, MAX(created_at) AS last_at FROM ${t}
                          WHERE store_code = ? AND created_at >= datetime('now', '-7 days')
                          GROUP BY event_type, status ORDER BY n DESC LIMIT 8`, c.store_code);
      console.log(`   ${t} ${c.store_code}: last row ${c.last_at} · last 7 days: ${kinds.map(k => `${k.event_type}/${k.status} ${k.n}`).join(', ') || 'nothing'}`);
      const ord = all(`SELECT event_type, status, created_at, substr(COALESCE(error_msg, detail, ''), 1, 140) AS msg FROM ${t}
                        WHERE store_code = ? AND (event_type LIKE '%order%' OR COALESCE(error_msg,'') <> '')
                        ORDER BY id DESC LIMIT 4`, c.store_code);
      for (const o of ord) console.log(`      ${o.created_at} ${o.event_type}/${o.status} ${o.msg}`);
    }
  }
  const byCh = all(`SELECT store_id, channel, COUNT(*) AS n, MAX(placed_at) AS last_at FROM retail_orders
                     WHERE placed_at >= datetime('now', ?) GROUP BY store_id, channel ORDER BY store_id, n DESC`, since);
  console.log(`   orders in window by store and channel: ${byCh.map(r => `store ${r.store_id} ${r.channel} ${r.n}`).join(' · ')}`);

  for (const s of stores) {
    const total = all(`SELECT COUNT(*) AS n FROM retail_stock_ledger WHERE store_id = ? AND created_at >= datetime('now', ?)`, s.id, since)[0];
    if (!total || !total.n) { console.log(`\n── store ${s.id} ${s.label}${s.active ? '' : ' (inactive)'}: no ledger rows in window`); continue; }
    console.log(`\n────────────────────────────────────────────────────────────`);
    console.log(`STORE ${s.id} · ${s.label}${s.active ? '' : ' (inactive)'} · ${total.n} ledger rows`);
    console.log(`────────────────────────────────────────────────────────────`);

    console.log('\n 1 · by reason                         rows      in     out');
    for (const r of all(`
      SELECT reason, COUNT(*) AS n,
             SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) AS units_in,
             SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) AS units_out
        FROM retail_stock_ledger WHERE store_id = ? AND created_at >= datetime('now', ?)
       GROUP BY reason ORDER BY n DESC`, s.id, since)) {
      console.log(`   ${pad(r.reason, 34)}${lpad(r.n, 6)}${lpad(r.units_in, 8)}${lpad(r.units_out, 8)}`);
    }

    const marks = RECOUNT.map(() => '?').join(',');
    const corr = all(`
      SELECT product_id, COUNT(*) AS n, SUM(delta) AS net,
             SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) AS up,
             SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) AS down
        FROM retail_stock_ledger
       WHERE store_id = ? AND created_at >= datetime('now', ?) AND reason IN (${marks}) AND delta <> 0
       GROUP BY product_id ORDER BY ABS(SUM(delta)) DESC, COUNT(*) DESC LIMIT ${TOP}`, s.id, since, ...RECOUNT);
    const corrTot = all(`
      SELECT COUNT(*) AS n, COUNT(DISTINCT product_id) AS products,
             SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) AS up,
             SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) AS down
        FROM retail_stock_ledger
       WHERE store_id = ? AND created_at >= datetime('now', ?) AND reason IN (${marks}) AND delta <> 0`, s.id, since, ...RECOUNT)[0] || {};
    console.log(`\n 2 · recount corrections: ${corrTot.n || 0} rows on ${corrTot.products || 0} products · +${corrTot.up || 0} found (system had too few) · −${corrTot.down || 0} missing (system had too many)`);
    for (const c of corr) {
      console.log(`   ${pad(pname(c.product_id), 40)} ${lpad(c.n, 3)}× net ${lpad((c.net > 0 ? '+' : '') + c.net, 5)}  (+${c.up} / −${c.down})`);
    }

    const breaks = all(`
      WITH seq AS (
        SELECT id, product_id, reason, delta, balance_after, created_at,
               LAG(balance_after) OVER (PARTITION BY product_id ORDER BY id) AS prev_bal,
               LAG(reason)        OVER (PARTITION BY product_id ORDER BY id) AS prev_reason
          FROM retail_stock_ledger WHERE store_id = ?)
      SELECT * FROM seq
       WHERE prev_bal IS NOT NULL AND prev_bal + delta <> balance_after
         AND created_at >= datetime('now', ?)
       ORDER BY id DESC`, s.id, since);
    const byPair = {};
    for (const b of breaks) { const k = b.prev_reason + ' → ' + b.reason; byPair[k] = (byPair[k] || 0) + 1; }
    const gapUnits = breaks.reduce((a, b) => a + (b.balance_after - b.delta - b.prev_bal), 0);
    console.log(`\n 3 · chain breaks: ${breaks.length} (unledgered movement totalling ${gapUnits > 0 ? '+' : ''}${gapUnits} units)`);
    for (const [k, n] of Object.entries(byPair).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`   ${lpad(n, 4)}×  ${k}`);
    for (const b of breaks.slice(0, 8)) {
      console.log(`   e.g. ${b.created_at} ${pad(pname(b.product_id), 32)} was ${b.prev_bal}, then ${b.reason} ${b.delta > 0 ? '+' : ''}${b.delta} → recorded ${b.balance_after} (gap ${b.balance_after - b.delta - b.prev_bal})`);
    }

    const tail = all(`
      SELECT rss.product_id, rss.physical_qty AS shelf, l.balance_after AS ledger, l.reason, l.created_at
        FROM retail_store_stock rss
        JOIN retail_stock_ledger l ON l.id = (SELECT MAX(id) FROM retail_stock_ledger WHERE store_id = rss.store_id AND product_id = rss.product_id)
       WHERE rss.store_id = ? AND rss.physical_qty <> l.balance_after`, s.id);
    console.log(`\n 4 · shelf disagrees with last ledger balance: ${tail.length} product(s)`);
    for (const t of tail.slice(0, 10)) console.log(`   ${pad(pname(t.product_id), 40)} shelf ${t.shelf} · ledger ${t.ledger} (last: ${t.reason} ${t.created_at})`);

    const chRows = all(`
      SELECT product_id, reason, delta, note FROM retail_stock_ledger
       WHERE store_id = ? AND created_at >= datetime('now', ?)
         AND reason IN ('meituan_order','meituan_uncancel','meituan_cancel','eleme_order','eleme_uncancel','eleme_cancel')`, s.id, since);
    const orders = {};
    for (const r of chRows) {
      const m = /^(Meituan|Eleme)\s+(\S+)/.exec(r.note || '');
      if (!m) continue;
      const k = `${m[1]} ${m[2]}|${r.product_id}`;
      const o = orders[k] || (orders[k] = { ch: m[1], ref: m[2], pid: r.product_id, out: 0, back: 0, outRows: 0, backRows: 0 });
      if (OUT_CH[r.reason]) { o.out += -r.delta; o.outRows++; }
      if (BACK_CH[r.reason]) { o.back += r.delta; o.backRows++; }
    }
    const list = Object.values(orders);
    const overBack = list.filter(o => o.back > o.out);
    const twice = list.filter(o => o.outRows > 1 && o.backRows === 0);
    const backOnly = list.filter(o => o.backRows > 0 && o.outRows === 0);
    console.log(`\n 5 · channel orders: ${list.length} order-lines · given back more than taken ${overBack.length} (+${overBack.reduce((a, o) => a + o.back - o.out, 0)} u) · taken twice, never cancelled ${twice.length} · given back with no deduction in window ${backOnly.length} (+${backOnly.reduce((a, o) => a + o.back, 0)} u)`);
    for (const o of [...overBack, ...twice].slice(0, 10)) {
      console.log(`   ${o.ch} ${pad(o.ref, 24)} ${pad(pname(o.pid), 32)} out ${o.out} (${o.outRows} rows) · back ${o.back} (${o.backRows} rows)`);
    }

    const zero = all(`
      SELECT reason, COUNT(*) AS n FROM retail_stock_ledger
       WHERE store_id = ? AND created_at >= datetime('now', ?) AND delta < 0 AND balance_after = 0
       GROUP BY reason ORDER BY n DESC`, s.id, since);
    console.log(`\n 6 · deductions that landed exactly on 0 (possible floor): ${zero.reduce((a, z) => a + z.n, 0)}`);
    for (const z of zero) console.log(`   ${pad(z.reason, 34)}${lpad(z.n, 6)}`);

    const neg = all(`SELECT product_id, physical_qty FROM retail_store_stock WHERE store_id = ? AND physical_qty < 0 ORDER BY physical_qty`, s.id);
    console.log(`\n 7 · below zero now: ${neg.length}`);
    for (const n of neg.slice(0, 10)) console.log(`   ${pad(pname(n.product_id), 40)} ${n.physical_qty}`);

    /* 8 · THE TILL'S FLOOR (§137) FOLLOWED BY A LATE RECEIPT. A counter sale
       that lands below zero is lifted back to 0 with a `counter_miscount` row.
       If the goods it sold were simply not booked in yet, the receipt that
       follows adds the FULL amount on top: shelf over-counts by the lift. */
    const lifts = all(`
      SELECT l.product_id, l.delta AS lift, l.created_at,
             (SELECT r.reason || ' +' || r.delta || ' at ' || r.created_at FROM retail_stock_ledger r
               WHERE r.store_id = l.store_id AND r.product_id = l.product_id AND r.id > l.id AND r.delta > 0
                 AND r.reason IN ('restock_transfer_in','kitchen_add','restock','production')
                 AND r.created_at <= datetime(l.created_at, '+3 days')
               ORDER BY r.id LIMIT 1) AS then_received
        FROM retail_stock_ledger l
       WHERE l.store_id = ? AND l.reason = 'counter_miscount' AND l.created_at >= datetime('now', ?)
       ORDER BY l.id DESC`, s.id, since);
    const lifted = lifts.filter(x => x.then_received);
    console.log(`\n 8 · till floor lifts (counter_miscount): ${lifts.length} totalling +${lifts.reduce((a, x) => a + x.lift, 0)} u · followed within 3 days by a receipt: ${lifted.length} (+${lifted.reduce((a, x) => a + x.lift, 0)} u likely counted twice)`);
    for (const x of lifted.slice(0, 10)) console.log(`   ${x.created_at} ${pad(pname(x.product_id), 34)} lifted +${x.lift} · then ${x.then_received}`);

    /* 9 · CHANNEL ORDERS THAT TOOK NOTHING OR TOO LITTLE. Lines left unmatched
       (product_id NULL) deduct nothing. A multi-pack sold on 闪购 carries no
       货号, so the pack-size match cannot fire and it takes 1 unit per pack:
       the names below are the ones that look like packs. */
    const chanOrd = `SELECT id FROM retail_orders WHERE store_id = ? AND channel IN ('meituan','eleme') AND placed_at >= datetime('now', ?)`;
    const unmatched = all(`
      SELECT o.channel, COUNT(*) AS n, SUM(i.qty) AS units FROM retail_order_items i JOIN retail_orders o ON o.id = i.order_id
       WHERE i.order_id IN (${chanOrd}) AND i.product_id IS NULL GROUP BY o.channel`, s.id, since);
    console.log(`\n 9 · channel lines matched to NO product (took no stock): ${unmatched.map(u => `${u.channel} ${u.n} lines / ${u.units} u`).join(' · ') || 'none'}`);
    const packs = all(`
      SELECT o.channel, i.name_cn, i.name_en, i.product_id, COUNT(*) AS n, SUM(i.qty) AS units
        FROM retail_order_items i JOIN retail_orders o ON o.id = i.order_id
       WHERE i.order_id IN (${chanOrd}) AND i.product_id IS NOT NULL
         AND (i.name_cn GLOB '*[0-9]瓶*' OR i.name_cn GLOB '*[0-9]袋*' OR i.name_cn GLOB '*[0-9]盒*' OR i.name_cn GLOB '*[0-9]包*'
           OR i.name_cn GLOB '*[0-9]罐*' OR i.name_cn GLOB '*[0-9]支*' OR i.name_cn GLOB '*[0-9]个装*' OR i.name_cn GLOB '*[xX×][0-9]*'
           OR i.name_cn LIKE '%整箱%' OR i.name_cn LIKE '%组合%' OR i.name_cn LIKE '%套餐%' OR i.name_cn LIKE '%装*%')
       GROUP BY o.channel, i.name_cn ORDER BY units DESC LIMIT ${TOP}`, s.id, since);
    console.log(`   lines whose name looks like a pack or combo: ${packs.length} distinct`);
    for (const p of packs) console.log(`   ${p.channel} ${pad((p.name_cn || p.name_en || '').slice(0, 30), 32)} → ${pad(pname(p.product_id), 30)} ${p.n} lines / ${p.units} packs sold`);

    /* 10 · ORDERS THE DAEMON SAW BUT NEVER MIRRORED, and whether Eleme is even
       read for this store. An import row with no retail order took no stock. */
    const code = all(`SELECT store_code FROM meituan_order_import mi JOIN retail_orders o ON o.id = mi.retail_order_id WHERE o.store_id = ? LIMIT 1`, s.id)[0]
              || all(`SELECT store_code FROM eleme_shops WHERE retail_store_id = ?`, s.id)[0];
    if (code) {
      for (const [t, k] of [['meituan_order_import', 'meituan_order_no'], ['eleme_order_import', 'eleme_order_id']]) {
        if (!has(t)) continue;
        const r = all(`SELECT COUNT(*) AS n, SUM(retail_order_id IS NULL) AS orphan,
                              GROUP_CONCAT(CASE WHEN retail_order_id IS NULL THEN status END) AS st
                         FROM ${t} WHERE store_code = ? AND imported_at >= datetime('now', ?)`, code.store_code, since)[0] || {};
        console.log(`\n10 · ${t} (${code.store_code}): ${r.n || 0} seen · ${r.orphan || 0} never mirrored (took no stock)${r.orphan ? ' · statuses: ' + String(r.st).split(',').slice(0, 8).join(',') : ''}`);
        void k;
      }
    }
    const eshop = all(`SELECT store_code, shop_id, shop_name FROM eleme_shops WHERE retail_store_id = ?`, s.id)[0];
    console.log(`    eleme_shops: ${eshop ? `${eshop.store_code} · shop_id ${eshop.shop_id || 'NONE — the daemon does not poll this store'}` : 'no row — Eleme not set up for this store'}`);

    /* 11 · TILL DOUBLE-SUBMITS and HELD BILLS THAT NEVER CAME BACK. Two counter
       orders at one store with the same total within 3 minutes are the shape of
       a retried "did not save". A held bill whose hold outweighs its returns,
       days old, is stock taken for a bill nobody will finish. */
    const dup = all(`
      SELECT a.id AS a, b.id AS b, a.total, a.placed_at FROM retail_orders a JOIN retail_orders b
        ON b.store_id = a.store_id AND b.id > a.id AND b.total = a.total AND b.fulfillment_type = 'counter'
       AND b.placed_at BETWEEN a.placed_at AND datetime(a.placed_at, '+3 minutes')
       WHERE a.store_id = ? AND a.fulfillment_type = 'counter' AND a.placed_at >= datetime('now', ?)
         AND COALESCE(a.status,'') NOT IN ('cancelled','refunded') AND COALESCE(b.status,'') NOT IN ('cancelled','refunded')
       ORDER BY a.id DESC`, s.id, since);
    console.log(`\n11 · counter orders with the same total within 3 minutes (possible double-submit): ${dup.length}`);
    for (const d of dup.slice(0, 8)) console.log(`   orders ${d.a} & ${d.b} · ¥${d.total} · ${d.placed_at}`);
    const held = all(`
      SELECT note, SUM(-delta) AS still_out, MIN(created_at) AS since_at FROM retail_stock_ledger
       WHERE store_id = ? AND reason IN ('till_hold','till_hold_return')
       GROUP BY note HAVING SUM(-delta) > 0 AND MIN(created_at) < datetime('now', '-1 day')
       ORDER BY since_at`, s.id);
    console.log(`    held till bills still holding stock after a day: ${held.length} (${held.reduce((a, h) => a + h.still_out, 0)} u)`);
    for (const h of held.slice(0, 6)) console.log(`   ${pad(String(h.note || '').slice(0, 40), 42)} ${h.still_out} u since ${h.since_at}`);

    /* 12 · WHICH PRODUCTS THE CHAIN BREAKS ARE ON. A sale recorded as "was 0,
       took 1, still 0" is a ledger row with no stock row under it. Is there a
       stock row now, is the product made here at this shop, and how many such
       sales — so a made-to-order drink can be told from a shelf product that
       was never set up at this store. */
    const brk = {};
    for (const b of breaks) {
      const k = b.product_id;
      const o = brk[k] || (brk[k] = { n: 0, units: 0, first: b.created_at, last: b.created_at });
      o.n++; o.units += (b.balance_after - b.delta - b.prev_bal); o.first = b.created_at < o.first ? b.created_at : o.first; o.last = b.created_at > o.last ? b.created_at : o.last;
    }
    const brkList = Object.entries(brk).sort((a, b) => b[1].n - a[1].n);
    console.log(`\n12 · chain breaks by product: ${brkList.length} product(s)`);
    for (const [pid, o] of brkList.slice(0, 15)) {
      const row = all(`SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?`, s.id, pid)[0];
      const mode = all(`SELECT sl.fulfilment_mode AS m FROM shop_listings sl JOIN shops sh ON sh.id = sl.shop_id
                         WHERE sh.location_id = ? AND sl.store_product_id = ?`, s.id, pid)[0];
      const kinds = all(`SELECT reason, COUNT(*) AS n FROM retail_stock_ledger WHERE store_id = ? AND product_id = ? GROUP BY reason ORDER BY n DESC`, s.id, pid)
        .map(r => `${r.reason} ${r.n}`).join(', ');
      console.log(`   ${pad(pname(pid), 40)} ${lpad(o.n, 3)}× (${o.units} u) ${o.first.slice(0, 10)}→${o.last.slice(0, 10)} · stock row: ${row ? row.physical_qty : 'NONE'} · listing: ${mode ? mode.m : 'none'} · ledger: ${kinds}`);
    }

    /* 13 · THE SAME-TOTAL PAIRS, COMPARED LINE BY LINE. Identical lines within
       three minutes is a retried submit; different lines is two customers. */
    const linesOf = (oid) => all(`SELECT product_id, qty FROM retail_order_items WHERE order_id = ? ORDER BY product_id, qty`, oid)
      .map(r => `${r.product_id}x${r.qty}`).join(',');
    const same = dup.filter(d => linesOf(d.a) === linesOf(d.b));
    console.log(`\n13 · same-total counter pairs with IDENTICAL lines: ${same.length} of ${dup.length}`);
    for (const d of same.slice(0, 8)) {
      const at = all(`SELECT placed_at, status FROM retail_orders WHERE id IN (?, ?) ORDER BY id`, d.a, d.b);
      console.log(`   orders ${d.a} & ${d.b} · ${linesOf(d.a)} · ${at.map(x => `${x.placed_at} ${x.status}`).join(' | ')}`);
    }

    /* 14 · RECOUNTS TAKEN WHILE SOLD GOODS WERE STILL ON THE SHELF. Stock comes
       off at payment; the goods leave at packing. A recount between the two
       counts those units again. For each recount, the units of that product on
       this store's orders that were paid before it and not yet dispatched,
       delivered or cancelled when it was saved. */
    const rc = all(`
      SELECT l.id, l.product_id, l.delta, l.created_at,
             (SELECT COALESCE(SUM(i.qty), 0) FROM retail_order_items i JOIN retail_orders o ON o.id = i.order_id
               WHERE o.store_id = l.store_id AND i.product_id = l.product_id
                 AND o.paid_at IS NOT NULL AND o.paid_at < l.created_at
                 AND COALESCE(o.fulfillment_type, '') <> 'counter'
                 AND (o.dispatched_at IS NULL OR o.dispatched_at > l.created_at)
                 AND (o.delivered_at  IS NULL OR o.delivered_at  > l.created_at)
                 AND (o.cancelled_at  IS NULL OR o.cancelled_at  > l.created_at)
                 AND o.paid_at >= datetime(l.created_at, '-3 days')) AS unpacked
        FROM retail_stock_ledger l
       WHERE l.store_id = ? AND l.created_at >= datetime('now', ?) AND l.reason IN (${marks}) AND l.delta <> 0`, s.id, since, ...RECOUNT);
    const hit = rc.filter(r => r.unpacked > 0);
    console.log(`\n14 · recounts saved while paid orders for that product were not yet out the door: ${hit.length} of ${rc.length} (${hit.reduce((a, r) => a + r.unpacked, 0)} u on those orders)`);
    for (const r of hit.slice(0, 10)) console.log(`   ${r.created_at} ${pad(pname(r.product_id), 36)} recount ${r.delta > 0 ? '+' : ''}${r.delta} · ${r.unpacked} u paid, not yet out`);
  }
  try { db.close(); } catch (_) {}
  console.log('');
}
console.log('done — read-only throughout');
