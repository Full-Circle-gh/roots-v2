#!/usr/bin/env node
/**
 * diagnose_channel_stock_damage.js — what is still owed to the shelf, and what
 * can be repaired without a human deciding anything.
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_channel_stock_damage.js
 *
 * READ-ONLY, and it proves that on the connection before reading anything.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every channel order line that resolved to no product was skipped by the
 * ingest's deduction loop, so its units were sold and never taken off the count.
 * That over-count is not historical: it is the number pushed back out to Eleme
 * and Meituan on the next sync, so it keeps causing oversells until it is fixed.
 *
 * The repair is not uniform, and the whole point of this survey is to split the
 * damage into the two halves that need different things:
 *
 *   REPAIRABLE — the line carries an "N-N" code that names exactly one product.
 *     PR #393 taught the Eleme resolver to read those, so a line like
 *     "…中230g 1-130" would resolve today. The order predates the fix, so its
 *     row still holds product_id NULL and its stock was never taken. Nothing
 *     needs deciding: the code says which product, and a repair can back-fill
 *     the row and deduct.
 *   BLOCKED — no code in the title, and the name matches several products or
 *     none. Which product the listing means is the merchant's call. A repair
 *     cannot guess it and this survey does not try; it names them so they can
 *     be mapped.
 *
 * It also reads the eleme_order_import rows whose retail_order_id is NULL. That
 * column is ON DELETE SET NULL, so a NULL there means the mirrored order was
 * DELETED after import — the money and the stock of a real order, gone from the
 * books with only the import row left behind saying it happened.
 *
 * Every read is bounded or index-seeking; the whole run is well under a second
 * on the live box (roots.db holds ~1.5k orders and ~10k ledger rows).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const APP = process.env.ROOTS_APP || '/root/roots-v2';
const FILE = process.env.ROOTS_DB || path.join(APP, 'data', 'roots.db');

let Database;
try { Database = require(path.join(APP, 'node_modules', 'better-sqlite3')); }
catch (e) { console.error('cannot load better-sqlite3: ' + e.message); process.exit(2); }
if (!fs.existsSync(FILE)) { console.error(`no database at ${FILE}`); process.exit(2); }

let db;
try { db = new Database(FILE, { readonly: true, fileMustExist: true }); }
catch (e) { console.error(`cannot open ${FILE} read-only: ${e.message}`); process.exit(2); }
let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); } catch (_) { proven = true; }
if (!proven) { console.error('FATAL: the connection accepted a write — reading nothing'); process.exit(2); }

const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { console.error(`  ! ${e.message}`); return []; } };
const one = (sql, ...a) => { try { return db.prepare(sql).get(...a) || null; } catch (e) { console.error(`  ! ${e.message}`); return null; } };

console.log(`${FILE}`);
console.log('='.repeat(78));

// ── 1. Every channel order line that resolved to nothing ─────────────────────
// ALL of history, not the recent window: the over-count on the shelf is the sum
// of every line ever skipped, and an old one is costing exactly as much as a new
// one. `channel` has no index but retail_orders is small.
const orphanLines = all(`
  SELECT oi.id AS line_id, oi.order_id, oi.name_cn, oi.name_en, oi.qty,
         COALESCE(oi.pack_units, 1) AS pack_units, oi.sku,
         o.order_no, o.channel, o.status, o.placed_at, o.store_id,
         o.channel_stock_restored
    FROM retail_order_items oi
    JOIN retail_orders o ON o.id = oi.order_id
   WHERE oi.product_id IS NULL
     AND o.channel IN ('eleme','meituan')
   ORDER BY o.id DESC
`);

console.log(`\n${orphanLines.length} channel order line(s) resolved to no product, all time.\n`);

// What the LIVE resolver would do with each name now. Mirrors branch 1 of
// routes/eleme-internal.js matchProductForLine as it stands after PR #393 — a
// copy, named as one, because the route cannot be loaded under this harness.
function tokenMatch(name, sku) {
  const token = sku || (String(name || '').match(/\d+-\d+/) || [])[0] || null;
  if (!token) return { token: null, rows: [] };
  const rows = all('SELECT id, name_cn, name_en, is_active FROM store_products WHERE sku = ?', token);
  return { token, rows };
}

const repairable = [];
const blocked = [];

for (const l of orphanLines) {
  const name = l.name_en || l.name_cn || '(unnamed)';
  const { token, rows } = tokenMatch(name, l.sku);
  const want = (parseInt(l.qty, 10) || 0) * (parseInt(l.pack_units, 10) || 1);
  // A line on a voided order was never meant to deduct — channel_stock_restored
  // = 1 says its stock is deliberately NOT out of our count. Repairing it would
  // take units for an order nobody was charged for.
  const voided = l.channel_stock_restored === 1
                 || l.status === 'cancelled' || l.status === 'refunded';
  const entry = { ...l, name, token, want, voided,
                  product: rows.length === 1 ? rows[0] : null, candidates: rows.length };
  if (voided) blocked.push({ ...entry, why: 'order is void — must NOT deduct' });
  else if (rows.length === 1) repairable.push(entry);
  else if (token && rows.length > 1) blocked.push({ ...entry, why: `code ${token} matches ${rows.length} products` });
  else if (token) blocked.push({ ...entry, why: `code ${token} matches no product` });
  else blocked.push({ ...entry, why: 'no code in the title — needs an eleme_product_map row' });
}

// ── 2. The repair plan ───────────────────────────────────────────────────────
console.log('-'.repeat(78));
console.log(`REPAIRABLE WITHOUT A DECISION — ${repairable.length} line(s)\n`);
if (!repairable.length) console.log('  (none)');
const perProduct = new Map();
for (const r of repairable) {
  const stock = one('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?',
                    r.store_id, r.product.id);
  const have = stock ? stock.physical_qty : 0;
  console.log(`  ${r.order_no}  [${r.channel}]  line #${r.line_id}  ${r.placed_at}`);
  console.log(`    "${r.name}" x${r.qty} pack=${r.pack_units}`);
  console.log(`    code ${r.token} → product #${r.product.id} ${r.product.name_en}` +
              `${r.product.is_active ? '' : '  (INACTIVE)'}`);
  console.log(`    shelf now ${have} → would become ${have - r.want}  (owes ${r.want})`);
  const k = `${r.store_id}:${r.product.id}`;
  perProduct.set(k, (perProduct.get(k) || 0) + r.want);
}
if (perProduct.size) {
  console.log('\n  Net effect per product:');
  for (const [k, units] of perProduct) {
    const [storeId, productId] = k.split(':');
    const stock = one('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?', storeId, productId);
    const p = one('SELECT name_en FROM store_products WHERE id = ?', productId);
    console.log(`    store ${storeId} product ${productId} ${p ? p.name_en : '?'}: ` +
                `${stock ? stock.physical_qty : 0} − ${units} = ${(stock ? stock.physical_qty : 0) - units}`);
  }
}

// ── 3. What a repair must not touch ──────────────────────────────────────────
console.log('\n' + '-'.repeat(78));
console.log(`BLOCKED — ${blocked.length} line(s), each needing a decision or nothing at all\n`);
const byReason = new Map();
for (const b of blocked) {
  if (!byReason.has(b.why)) byReason.set(b.why, []);
  byReason.get(b.why).push(b);
}
for (const [why, rows] of byReason) {
  console.log(`  ${why}  (${rows.length})`);
  for (const b of rows) {
    console.log(`    ${b.order_no} [${b.channel}] "${b.name}" x${b.qty}  ${b.placed_at}` +
                (b.voided ? `  status=${b.status} restored=${b.channel_stock_restored}` : ''));
  }
  console.log('');
}

// ── 4. Imports whose order no longer exists ──────────────────────────────────
// retail_order_id is ON DELETE SET NULL, so NULL here means the mirrored order
// was DELETED after import — a real order's money and stock off the books.
console.log('-'.repeat(78));
console.log('IMPORT ROWS WHOSE MIRRORED ORDER IS GONE\n');
for (const [table, key, stamp] of [['eleme_order_import', 'eleme_order_id', 'imported_at'],
                                   ['meituan_order_import', 'meituan_order_no', 'imported_at']]) {
  const rows = all(`
    SELECT id, ${key} AS ref, store_code, status, ${stamp} AS at,
           LENGTH(COALESCE(raw_payload,'')) AS payload_bytes,
           substr(COALESCE(raw_payload,''), 1, 300) AS payload_head
      FROM ${table}
     WHERE retail_order_id IS NULL
     ORDER BY id DESC
  `);
  console.log(`  ${table}: ${rows.length} row(s) with no order`);
  for (const r of rows) {
    console.log(`    #${r.id}  ref ${r.ref}  store ${r.store_code}  status=${r.status}  ${r.at}`);
    console.log(`      payload ${r.payload_bytes} bytes: ${String(r.payload_head).replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  // The totals a deleted order took with it, as far as the import row still says.
  console.log('');
}

// ── 5. Is anything else deducting wrong? The oversell clamp ──────────────────
// A channel line whose product was already at 0 records delta 0 and moves on —
// lib/inventory.js's callers clamp with Math.max(0, …). The ledger row is the
// only trace, and it looks like a no-op rather than a shortfall.
console.log('-'.repeat(78));
console.log('ZERO-DELTA CHANNEL LEDGER ROWS — a sale that took nothing off the shelf\n');
const zeroRows = all(`
  SELECT id, store_id, product_id, reason, balance_after, created_at, note
    FROM retail_stock_ledger
   WHERE delta = 0
     AND reason IN ('eleme_order','meituan_order')
   ORDER BY id DESC
   LIMIT 30
`);
console.log(`  ${zeroRows.length} row(s) (most recent 30)`);
for (const z of zeroRows) {
  console.log(`    #${z.id} ${z.reason} store ${z.store_id} product ${z.product_id} ` +
              `balance ${z.balance_after}  ${z.created_at}`);
  console.log(`      ${String(z.note || '').slice(0, 110)}`);
}

console.log('\ndone');
try { db.close(); } catch (_) {}
