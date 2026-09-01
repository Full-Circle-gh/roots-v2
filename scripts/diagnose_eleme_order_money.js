#!/usr/bin/env node
/**
 * Read-only survey of the money on live Eleme orders: what each order RECORDS
 * against what its own line items ADD UP TO, and — where the two disagree —
 * which fields of the order's archived Eleme payload hold the basket value.
 *
 * It answers the question EL20260901417897 raised and could not settle from a
 * checkout: the drawer showed a ¥17.50 total over ¥38 + ¥29 + ¥200 of goods,
 * both numbers came off the platform, and which one is wrong is a fact about
 * the stored payload rather than a judgement call.
 *
 *   A field of the order's own payload equal to the line sum means the total
 *     was read off the WRONG KEY (TOTAL_KEYS has seven candidates and the walk
 *     descends into sub-objects, so one tender's slice can read as the whole
 *     bill). That is the case
 *     scripts/fix_eleme_order_money.js --adopt-corroborated-total is for.
 *   No such field means the gap is something else — most likely a real platform
 *     discount — and `total` must be left exactly as it is.
 *
 * Every statement is a SELECT. The database is opened read-only and the
 * connection is PROVEN read-only before anything else runs, by attempting a
 * CREATE TABLE and aborting if the write is accepted. It writes nothing,
 * repairs nothing, and is safe to run against production at any time.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_eleme_order_money.js
 */
'use strict';

const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require('/root/roots-v2/node_modules/better-sqlite3');

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// ── Prove read-only, do not assume it ───────────────────────────────────────
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
console.log('db: ' + DB_PATH + '\n');

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const money  = (n) => round2(n).toFixed(2);

// Same rule the ingest and the repair use: our own computed archive fields are
// not evidence about what Eleme charged.
const OUR_OWN_FIELDS = new Set(['detail.itemsTotal', 'detail.channelTotal', 'detail.moneyDivisor']);

function numericLeaves(value, path = '', out = []) {
  if (value == null) return out;
  if (typeof value === 'number' && Number.isFinite(value)) { out.push({ path, value }); return out; }
  if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) { out.push({ path, value: Number(value) }); return out; }
  if (typeof value !== 'object') return out;
  if (Array.isArray(value)) { value.forEach((v, i) => numericLeaves(v, `${path}[${i}]`, out)); return out; }
  for (const [k, v] of Object.entries(value)) numericLeaves(v, path ? `${path}.${k}` : k, out);
  return out;
}
const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

const orders = db.prepare(`
  SELECT id, order_no, status, subtotal, total, placed_at, store_id, refund_amount_approved
    FROM retail_orders WHERE channel = 'eleme' ORDER BY id DESC
`).all();

console.log(`${orders.length} Eleme order(s) on this database\n`);

const itemStmt = db.prepare('SELECT name_en, name_cn, qty, unit_price, line_total FROM retail_order_items WHERE order_id = ? ORDER BY id');
const impStmt  = db.prepare('SELECT raw_payload, detail_json FROM eleme_order_import WHERE retail_order_id = ?');

let disagreeing = 0, subtotalStale = 0, unpriced = 0, wrongKey = 0;

for (const o of orders) {
  const items = itemStmt.all(o.id);
  if (!items.length || !items.every(it => Number(it.line_total) > 0)) { unpriced++; continue; }
  const itemsSum = round2(items.reduce((a, it) => a + Number(it.line_total), 0));
  const stale = round2(o.subtotal) !== itemsSum;
  if (stale) subtotalStale++;
  const gap = round2(itemsSum - Number(o.total));
  const disagrees = Math.abs(gap) > Math.max(5, itemsSum * 0.3);
  if (!disagrees && !stale) continue;
  if (disagrees) disagreeing++;

  console.log(`${o.order_no}  (id ${o.id}, ${o.status}, placed ${o.placed_at})`);
  console.log(`  items ¥${money(itemsSum)}  ·  recorded subtotal ¥${money(o.subtotal)}  ·  total ¥${money(o.total)}`);
  console.log('  ' + items.map(i => `${i.name_en || i.name_cn} ×${i.qty} @¥${money(i.unit_price)}`).join(' · '));
  if (stale) console.log(`  → subtotal is the old copy of the total; the repair sets it to ¥${money(itemsSum)}`);

  if (disagrees) {
    console.log(`  ! total disagrees by ¥${money(Math.abs(gap))}` +
      (Number(o.total) > 0 ? ` — items are ${round2(itemsSum / Number(o.total))}× the total` : ' — no total recorded'));
    if (Number(o.refund_amount_approved) > 0) {
      console.log(`    NOTE: ¥${money(o.refund_amount_approved)} has already been refunded on this order.`);
    }
    const imp = impStmt.get(o.id);
    if (!imp) {
      console.log('    no archived payload — nothing to corroborate against');
    } else {
      const d = parseJson(imp.detail_json) || {};
      if (d.totalKeyPath) console.log(`    total was read from: ${d.totalKeyPath}`);
      if (d.moneyDivisor != null) console.log(`    money divisor applied: ${d.moneyDivisor}`);
      const leaves = numericLeaves(parseJson(imp.raw_payload), 'raw')
        .concat(numericLeaves(d, 'detail'));
      const hits = leaves.filter(l => round2(l.value) === itemsSum || Math.round(l.value) === Math.round(itemsSum * 100))
        .filter(l => !/\[\d+\]/.test(l.path))
        .filter(l => !OUR_OWN_FIELDS.has(l.path));
      if (hits.length) {
        wrongKey++;
        console.log(`    WRONG-KEY READ — the payload does hold ¥${money(itemsSum)}:`);
        for (const h of hits.slice(0, 8)) console.log(`      ${h.path} = ${h.value}`);
      } else {
        console.log(`    no payload field holds ¥${money(itemsSum)} — NOT a wrong-key read.`);
        console.log('    Leave `total` alone; check the order on Eleme (a real discount looks like this).');
        // The nearest order-level money fields, so the gap can be recognised for
        // what it is rather than merely declared unexplained.
        const near = leaves.filter(l => !/\[\d+\]/.test(l.path) && Math.abs(l.value) > 0)
          .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 6);
        if (near.length) {
          console.log('    order-level money fields in the payload, largest first:');
          for (const n of near) console.log(`      ${n.path} = ${n.value}`);
        }
      }
    }
  }
  console.log('');
}

console.log('── summary ──────────────────────────────────────────────');
console.log(`  ${orders.length} Eleme order(s)`);
console.log(`  ${unpriced} with no usable line prices (nothing to compare)`);
console.log(`  ${subtotalStale} whose subtotal still mirrors the total — repairable with no judgement call`);
console.log(`  ${disagreeing} whose total disagrees with their items`);
console.log(`  ${wrongKey} of those corroborated by the payload as a wrong-key read`);
console.log('');
console.log('To repair, on the box (dry run first — it writes nothing without --apply):');
console.log('  cd /root/roots-v2 && node scripts/fix_eleme_order_money.js');
console.log('  cd /root/roots-v2 && node scripts/fix_eleme_order_money.js --apply');
if (wrongKey) console.log('  cd /root/roots-v2 && node scripts/fix_eleme_order_money.js --apply --adopt-corroborated-total');
