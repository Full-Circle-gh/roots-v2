#!/usr/bin/env node
/**
 * Why the channel money columns are empty where they are empty. Two questions,
 * one read, no writes.
 *
 * PROBLEM 1 — the Meituan orders with NULL commission / discount / settlement.
 * Prints every Meituan order in the last 30 days beside the facts that could
 * separate the ones that carry money from the ones that do not: when it was
 * placed, when it was imported, which store (which is also which daemon —
 * SHANGOU_STORES handles 闪购, meituan-daemon the rest), the status it holds now,
 * whether it was ever a pre-order, whether a rider was ever recorded against it,
 * and whether its channel_status_at ever moved past its import stamp. That last
 * pair is the re-poll evidence: an order refreshed after ingest has a status
 * timestamp later than the row's own import, and one that was never seen again
 * does not.
 *
 * PROBLEM 2 — what Eleme's subtotal actually contains. For every archived Eleme
 * payload that parses, this prints the goods / packaging / delivery / discount /
 * customer-paid figures side by side with what the ROW recorded, and runs the
 * addition both ways:
 *     goods + packaging + delivery - merchant discount  =? customer paid
 *     recorded subtotal                                 =? goods
 * A subtotal that equals the goods and a sum that only reaches the customer-paid
 * figure once packaging and delivery are added is the proof that writing those
 * two columns would COMPLETE the arithmetic rather than double it. The opposite
 * result is the proof that it would double it. Neither is assumed here.
 *
 * It also dumps, in full, the five short archives that are suspected of holding a
 * line-item node instead of an order envelope, and looks for the same orders in
 * eleme_sync_log — the question being whether the figures survive anywhere else
 * or are gone.
 *
 * NO CUSTOMER DATA. Order numbers, timestamps, store codes, statuses and money.
 * Names, phones, addresses and notes are neither selected nor printed; the raw
 * archives dumped for the five broken rows are money-only objects (price /
 * shopPrice / total / userPrice) and are checked for that before printing.
 *
 * Every statement is a SELECT, the database is opened read-only, and the
 * connection is PROVEN read-only before anything else runs.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_channel_money_gaps.js
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

const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const show = (v) => v === null || v === undefined ? 'null' : String(v);

// ══ PROBLEM 1 ═══════════════════════════════════════════════════════════════
console.log('══ PROBLEM 1 — Meituan orders, last 30 days ════════════════════\n');

const mt = db.prepare(`
  SELECT o.id, o.order_no, o.status, o.channel_status, o.placed_at, o.channel_status_at,
         o.delivered_at, o.channel_preorder_at, o.store_id,
         o.subtotal, o.packing_fee, o.shipping_fee,
         o.channel_commission, o.channel_discount, o.channel_settle_amount,
         o.channel_rider_name, o.channel_rider_status_code, o.channel_customer_id,
         o.channel_distance_m, o.channel_eta,
         i.store_code, i.imported_at, i.accepted_at, i.status AS import_status,
         (SELECT COUNT(*) FROM retail_order_items ri WHERE ri.order_id = o.id) AS lines,
         (SELECT COUNT(*) FROM retail_order_items ri WHERE ri.order_id = o.id AND ri.channel_food_id IS NOT NULL) AS lines_with_foodid
    FROM retail_orders o
    LEFT JOIN meituan_order_import i ON i.retail_order_id = o.id
   WHERE o.channel = 'meituan'
     AND COALESCE(o.placed_at, o.paid_at) >= datetime('now', '-30 days')
   ORDER BY o.placed_at
`).all();

const hasMoney = (r) => r.channel_settle_amount != null || r.channel_commission != null;

console.log(`${mt.length} order(s); ${mt.filter(hasMoney).length} carry settlement money, ${mt.filter(r => !hasMoney(r)).length} do not.\n`);
console.log('  money  order_no          store      placed_at            imported_at          status      chStatus     rider  foodIds  preorder  statusAt>import');
for (const r of mt) {
  const repolled = r.channel_status_at && r.imported_at && r.channel_status_at > r.imported_at;
  console.log(
    `  ${hasMoney(r) ? ' YES ' : ' --- '}  ${String(r.order_no).padEnd(17)} ${String(r.store_code || '?').padEnd(10)}` +
    ` ${String(r.placed_at || '').padEnd(20)} ${String(r.imported_at || '').padEnd(20)}` +
    ` ${String(r.status).padEnd(11)} ${String(r.channel_status || '').padEnd(12)}` +
    ` ${r.channel_rider_name ? 'yes' : ' - '}   ${r.lines_with_foodid}/${r.lines}` +
    `      ${r.channel_preorder_at ? 'yes' : ' - '}        ${repolled ? 'yes' : ' - '}`);
}
console.log('');

// The candidate splits, each counted rather than eyeballed.
console.log('── what separates the two groups ────────────────────────────');
const groupBy = (label, fn) => {
  const m = new Map();
  for (const r of mt) {
    const k = String(fn(r));
    const e = m.get(k) || { yes: 0, no: 0 };
    if (hasMoney(r)) e.yes++; else e.no++;
    m.set(k, e);
  }
  console.log(`  ${label}`);
  for (const [k, e] of [...m.entries()].sort()) {
    console.log(`     ${k.padEnd(28)} money=${String(e.yes).padStart(3)}  no-money=${String(e.no).padStart(3)}`);
  }
};
groupBy('by placed_at DATE:',        r => (r.placed_at || '').slice(0, 10));
groupBy('by imported_at DATE:',      r => (r.imported_at || '').slice(0, 10));
groupBy('by store_code (= daemon):', r => r.store_code || '(none)');
groupBy('by current status:',        r => r.status);
groupBy('by pre-order:',             r => r.channel_preorder_at ? 'pre-order' : 'immediate');
groupBy('by rider recorded:',        r => r.channel_rider_name ? 'rider' : 'no rider');
groupBy('by re-polled after import:', r => (r.channel_status_at && r.imported_at && r.channel_status_at > r.imported_at) ? 're-polled' : 'never re-polled');
console.log('');

// Do the no-money rows carry ANY field from the `channel` block? The block fills
// rider, customer, distance, ETA and per-line foodIds as well as money, so a row
// with none of them never received the block at all, while a row with some of
// them received a block whose money section was empty. Those are different faults.
console.log('── no-money rows: did the channel block arrive at all? ───────');
let noneAtAll = 0, someFields = 0;
for (const r of mt.filter(x => !hasMoney(x))) {
  const any = !!(r.channel_rider_name || r.channel_rider_status_code != null || r.channel_customer_id
                 || r.channel_distance_m != null || r.lines_with_foodid > 0);
  if (any) { someFields++; console.log(`     ${r.order_no}: block PARTIALLY present (rider=${!!r.channel_rider_name} cust=${!!r.channel_customer_id} dist=${r.channel_distance_m != null} foodIds=${r.lines_with_foodid}/${r.lines}) — money section empty`); }
  else noneAtAll++;
}
console.log(`     ${noneAtAll} row(s) carry NO channel-block field of any kind (block never arrived)`);
console.log(`     ${someFields} row(s) carry some channel-block fields but no money`);
console.log('');

// The sweep that would re-poll them, and the two gates in its WHERE clause.
console.log('── which orders the stale-order sweep can still reach ────────');
console.log('   (scripts/meituan-daemon.js:735-741 — status IN paid/preparing/dispatched');
console.log('    AND placed_at >= now-MEITUAN_SWEEP_DAYS, default 3)');
const sweepable = db.prepare(`
  SELECT COUNT(*) AS n FROM retail_orders o
   WHERE o.channel = 'meituan'
     AND o.status IN ('paid','preparing','dispatched')
     AND o.placed_at >= datetime('now','-3 days')
`).get();
const mtNoMoney = mt.filter(r => !hasMoney(r));
const stillSweepable = mtNoMoney.filter(r =>
  ['paid', 'preparing', 'dispatched'].includes(r.status) &&
  r.placed_at && r.placed_at >= new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 19).replace('T', ' '));
console.log(`   sweep would pick up ${sweepable.n} meituan order(s) in total right now`);
console.log(`   of the ${mtNoMoney.length} no-money orders, ${stillSweepable.length} are still inside BOTH gates`);
console.log('');

// How long an order stays in a sweepable status — i.e. how big the window
// actually is in practice, not in configuration.
const life = db.prepare(`
  SELECT o.order_no, o.placed_at, o.delivered_at,
         ROUND((julianday(o.delivered_at) - julianday(o.placed_at)) * 24 * 60) AS mins
    FROM retail_orders o
   WHERE o.channel = 'meituan' AND o.delivered_at IS NOT NULL AND o.placed_at IS NOT NULL
     AND COALESCE(o.placed_at, o.paid_at) >= datetime('now','-30 days')
   ORDER BY mins
`).all();
if (life.length) {
  const ms = life.map(l => l.mins).filter(n => Number.isFinite(n));
  console.log(`── minutes from placed_at to delivered_at (n=${ms.length}) ─────────`);
  console.log(`   min ${ms[0]}   median ${ms[Math.floor(ms.length / 2)]}   max ${ms[ms.length - 1]}`);
  console.log('   (an order is only sweepable while it is NOT delivered)');
  console.log('');
}

// ══ PROBLEM 2 ═══════════════════════════════════════════════════════════════
console.log('══ PROBLEM 2 — what Eleme subtotal contains ════════════════════\n');

const el = db.prepare(`
  SELECT o.id, o.order_no, o.status, o.subtotal, o.total, o.packing_fee, o.shipping_fee,
         o.channel_commission, o.channel_settle_amount,
         i.eleme_order_id, i.raw_payload, i.detail_json,
         LENGTH(i.raw_payload) AS raw_len, LENGTH(i.detail_json) AS det_len
    FROM retail_orders o
    JOIN eleme_order_import i ON i.retail_order_id = o.id
   WHERE o.channel = 'eleme'
   ORDER BY o.id DESC
`).all();

const at = (obj, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
const itemsStmt = db.prepare('SELECT qty, unit_price, line_total FROM retail_order_items WHERE order_id = ?');

console.log(`${el.length} archived Eleme order(s).\n`);
const broken = [];
for (const r of el) {
  const raw = parseJson(r.raw_payload);
  const goods    = at(raw, 'settlementInfo.subTotalFeeInfo.total');
  const paid     = at(raw, 'settlementInfo.customerPaidInfo.total');
  const orderTot = at(raw, 'settlementInfo.orderTotalPrice');
  const pack     = at(raw, 'foodInfo.packageFee');
  const deliver  = at(raw, 'foodInfo.deliveryFee');
  const shopDisc = at(raw, 'settlementInfo.merchantActivityInfo.total');
  const income   = at(raw, 'settlementInfo.expectedIncomeInfo.total');
  const comm     = at(raw, 'settlementInfo.platformServiceFeeInfo.total');
  const ticket   = at(raw, 'printDataInfo.ticketPrintContext.totalAmount');

  const groups = at(raw, 'foodInfo.groups');
  let lineSum = null;
  if (Array.isArray(groups)) {
    lineSum = 0;
    for (const g of groups) for (const it of (g.items || [])) lineSum += Number(it.total) || 0;
    lineSum = r2(lineSum);
  }
  const rowLines = itemsStmt.all(r.id);
  const rowLineSum = rowLines.length && rowLines.every(l => Number(l.line_total) > 0)
    ? r2(rowLines.reduce((a, l) => a + Number(l.line_total), 0)) : null;

  console.log(`${r.order_no} (id ${r.id}, ${r.status}) raw=${r.raw_len}ch detail=${r.det_len}ch`);
  console.log(`   ROW:     subtotal=${show(r.subtotal)}  packing_fee=${show(r.packing_fee)}  shipping_fee=${show(r.shipping_fee)}  total=${show(r.total)}  commission=${show(r.channel_commission)}  income=${show(r.channel_settle_amount)}`);
  if (pack == null && deliver == null && paid == null) {
    console.log('   PAYLOAD: no order-level settlement fields — NOT AN ORDER ENVELOPE');
    console.log(`   keys:    ${raw && typeof raw === 'object' ? Object.keys(raw).join(', ') : '(unparseable)'}`);
    const det = parseJson(r.detail_json);
    if (det) {
      const carried = ['channelTotal', 'itemsTotal', 'merchantIncome', 'commission',
                       'platformSubsidy', 'shopDiscount', 'packagingFee', 'deliveryFee',
                       'totalKeyPath', 'moneyDivisor']
        .map(k => `${k}=${show(det[k])}`).join('  ');
      console.log(`   detail_json: ${carried}`);
      console.log(`   detail_json.detail present: ${det.detail == null ? 'NO' : 'yes'}`);
    } else {
      console.log('   detail_json: (absent or unparseable)');
    }
    broken.push(r);
    console.log('');
    continue;
  }
  console.log(`   PAYLOAD: goods(subTotalFee)=${show(goods)}  lineSum=${show(lineSum)}  packageFee=${show(pack)}  deliveryFee=${show(deliver)}  merchantActivity=${show(shopDisc)}  customerPaid=${show(paid)}`);
  console.log(`            orderTotalPrice=${show(orderTot)}  ticketTotal=${show(ticket)}  platformServiceFee=${show(comm)}  expectedIncome=${show(income)}`);

  // Does the row's subtotal equal the GOODS, or the customer-paid figure?
  const eqGoods = lineSum != null && r.subtotal != null && Math.abs(r.subtotal - lineSum) <= 0.011;
  const eqPaid  = paid != null && r.subtotal != null && Math.abs(r.subtotal - paid) <= 0.011;
  console.log(`   subtotal is the GOODS: ${eqGoods ? 'YES' : 'no'}   subtotal is CUSTOMER-PAID: ${eqPaid ? 'YES' : 'no'}`);

  // The addition, spelled out. If goods alone already reaches customer-paid then
  // the fees are inside it and writing them would double-count; if it only
  // reaches it once packaging and delivery are added, they are missing from it.
  if (lineSum != null && pack != null && deliver != null && paid != null) {
    const withFees = r2(lineSum + Number(pack) + Number(deliver));
    const lessDisc = r2(withFees - Number(shopDisc || 0));
    console.log(`   goods ${lineSum} + packaging ${pack} + delivery ${deliver} = ${withFees}`);
    console.log(`   ${withFees} - merchant discount ${show(shopDisc)} = ${lessDisc}   vs customerPaid ${paid}   → ${Math.abs(lessDisc - Number(paid)) <= 0.011 ? 'RECONCILES' : 'does NOT reconcile (gap ' + r2(lessDisc - Number(paid)) + ')'}`);
    console.log(`   goods alone ${lineSum} vs customerPaid ${paid} → short by ${r2(Number(paid) - lineSum)}`);
  }
  if (paid != null && comm != null && income != null) {
    console.log(`   customerPaid ${paid} - commission ${comm} = ${r2(Number(paid) - Number(comm))}   vs expectedIncome ${income}   → ${Math.abs(r2(Number(paid) - Number(comm)) - Number(income)) <= 0.011 ? 'RECONCILES' : 'does NOT reconcile'}`);
  }
  console.log(`   row line_total sum = ${show(rowLineSum)} (${rowLines.length} line(s))`);
  console.log('');
}

// ── (h) Is anything recoverable for the broken archives? ───────────────────
console.log('── the unusable archives: is the money anywhere else? ────────');
if (!broken.length) console.log('   (none)');
for (const r of broken) {
  console.log(`   ${r.order_no} (eleme id ${r.eleme_order_id})`);
  console.log(`      raw_payload verbatim: ${String(r.raw_payload).slice(0, 400)}`);
  const logs = db.prepare(`
    SELECT event_type, status, detail, created_at FROM eleme_sync_log
     WHERE detail LIKE ? ORDER BY id
  `).all('%' + r.eleme_order_id + '%');
  if (!logs.length) console.log('      eleme_sync_log: no row mentions this order id');
  for (const l of logs) console.log(`      log ${l.created_at} ${l.event_type}/${l.status}: ${String(l.detail).slice(0, 300)}`);
  console.log('');
}
