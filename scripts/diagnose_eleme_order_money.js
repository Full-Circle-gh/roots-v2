#!/usr/bin/env node
/**
 * Read-only survey of the money on live Eleme orders: what each order RECORDS,
 * what its own line items ADD UP TO, and what its archived Eleme payload says
 * the customer actually PAID.
 *
 * It is the read-only twin of scripts/fix_eleme_order_money.js — same rules,
 * same evidence, no writes — for answering "what would the repair do?" from
 * Actions, without a shell on the box.
 *
 * The three figures come apart because of a specific bug. The ingest wrote one
 * platform figure into both `subtotal` and `total`, and the figure it read was
 * not the bill: TOTAL_KEYS ends in a bare 'total', pick() walks the payload's
 * sub-objects trying every candidate at each one, and
 * settlementInfo.merchantActivityInfo — a SHOP-FUNDED PROMOTION — is reached
 * before settlementInfo.customerPaidInfo. On EL20260901417897 that recorded
 * ¥17.50 of promotion as the order total, over ¥267.00 of goods the customer
 * paid ¥269.00 for.
 *
 * Every statement is a SELECT. The database is opened read-only and the
 * connection is PROVEN read-only before anything else runs, by attempting a
 * CREATE TABLE and aborting if the write is accepted. It writes nothing and is
 * safe to run against production at any time.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_eleme_order_money.js
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
console.log('db: ' + DB_PATH + '\n');

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const money  = (n) => round2(n).toFixed(2);

// Kept in step with lib/eleme-browser.js TOTAL_PATHS and the repair script.
const TOTAL_PATHS = [
  'settlementInfo.customerPaidInfo.total',
  'printDataInfo.payAmount',
  'settlementInfo.subTotalFeeInfo.total',
];
const CONTEXT_PATHS = [
  'settlementInfo.merchantActivityInfo.total',
  'settlementInfo.platformServiceFeeInfo.total',
  'settlementInfo.expectedIncomeInfo.total',
  'settlementInfo.orderTotalPrice',
  'foodInfo.packageFee',
  'foodInfo.deliveryFee',
  'printDataInfo.ticketPrintContext.totalAmount',
];

function atPath(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return (cur === null || cur === '' || typeof cur === 'object') ? undefined : cur;
}
const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

function payloadsFor(imp) {
  if (!imp) return [];
  const out = [];
  const raw = parseJson(imp.raw_payload);
  if (raw) out.push({ src: 'raw_payload', doc: raw });
  const d = parseJson(imp.detail_json);
  if (d && d.detail) out.push({ src: 'detail_json.detail', doc: d.detail });
  return out;
}
function payloadTotal(imp) {
  for (const { src, doc } of payloadsFor(imp)) {
    for (const path of TOTAL_PATHS) {
      const n = Number(atPath(doc, path));
      if (Number.isFinite(n) && n > 0) return { value: round2(n), path, src };
    }
  }
  return null;
}

const orders = db.prepare(`
  SELECT id, order_no, status, subtotal, total, placed_at, refund_amount_approved
    FROM retail_orders WHERE channel = 'eleme' ORDER BY id DESC
`).all();

console.log(`${orders.length} Eleme order(s) on this database\n`);

const itemStmt = db.prepare('SELECT name_en, name_cn, qty, unit_price, line_total FROM retail_order_items WHERE order_id = ? ORDER BY id');
const impStmt  = db.prepare('SELECT raw_payload, detail_json FROM eleme_order_import WHERE retail_order_id = ?');

let subtotalStale = 0, totalStated = 0, unexplained = 0, unpriced = 0;

for (const o of orders) {
  const items = itemStmt.all(o.id);
  const priced = items.length > 0 && items.every(it => Number(it.line_total) > 0);
  const itemsSum = priced ? round2(items.reduce((a, it) => a + Number(it.line_total), 0)) : null;
  if (itemsSum == null) unpriced++;

  const imp = impStmt.get(o.id);
  const paid = payloadTotal(imp);
  const recorded = round2(o.total);
  const subtotalWrong = itemsSum != null && round2(o.subtotal) !== itemsSum;
  const totalWrong = paid != null && paid.value !== recorded;
  const gapNoEvidence = paid == null && itemsSum != null
    && Math.abs(itemsSum - recorded) > Math.max(5, itemsSum * 0.3);

  if (!subtotalWrong && !totalWrong && !gapNoEvidence) continue;
  if (subtotalWrong) subtotalStale++;
  if (totalWrong) totalStated++;
  if (gapNoEvidence) unexplained++;

  console.log(`${o.order_no}  (id ${o.id}, ${o.status}, placed ${o.placed_at})`);
  console.log(`  recorded subtotal ¥${money(o.subtotal)} · total ¥${money(o.total)}` +
    (itemsSum != null ? `   |   lines add up to ¥${money(itemsSum)}` : '   |   lines carry no prices'));
  if (itemsSum != null) {
    console.log('  ' + items.map(i => `${i.name_en || i.name_cn} ×${i.qty} @¥${money(i.unit_price)}`).join(' · '));
  }
  if (subtotalWrong) console.log(`  → subtotal becomes ¥${money(itemsSum)} (the goods)`);
  if (paid) {
    console.log(`  → total becomes ¥${money(paid.value)} — the payload states it at ${paid.src}: ${paid.path}`);
    if (Number(o.refund_amount_approved) > 0 && paid.value < recorded) {
      console.log(`    ! BLOCKED: that is LOWER than the recorded ¥${money(o.total)} and ` +
        `¥${money(o.refund_amount_approved)} is already refunded. The repair will not touch it.`);
    }
    const ctx = [];
    for (const { doc } of payloadsFor(imp)) {
      for (const p of CONTEXT_PATHS) {
        const n = Number(atPath(doc, p));
        if (Number.isFinite(n)) ctx.push(`${p} = ${n}`);
      }
      if (ctx.length) break;
    }
    if (ctx.length) {
      console.log('  the rest of that order\'s money, for review:');
      for (const c of ctx) console.log(`      ${c}`);
    }
  } else if (gapNoEvidence) {
    console.log(`  ! total ¥${money(o.total)} disagrees with the items and no payload can settle it.`);
    console.log('    The repair leaves it alone. Check the order on Eleme — a real discount looks like this.');
  }
  console.log('');
}

console.log('── summary ──────────────────────────────────────────────');
console.log(`  ${orders.length} Eleme order(s), ${unpriced} of them with no usable line prices`);
console.log(`  ${subtotalStale} subtotal(s) to repair — no judgement call, the lines know`);
console.log(`  ${totalStated} total(s) the payload states differently from what we recorded`);
console.log(`  ${unexplained} disagreement(s) with no evidence either way — left alone`);
console.log('');
console.log('To repair, on the box (dry run first — it writes nothing without --apply):');
console.log('  cd /root/roots-v2 && node scripts/fix_eleme_order_money.js');
if (totalStated) {
  console.log('  cd /root/roots-v2 && node scripts/fix_eleme_order_money.js --apply --adopt-payload-total');
} else {
  console.log('  cd /root/roots-v2 && node scripts/fix_eleme_order_money.js --apply');
}
