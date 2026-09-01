// Repair the money on Eleme orders that were mirrored in before the reader knew
// the platform's real field names (lib/eleme-browser.js) and before the ingest
// told the order total and the line items apart (routes/eleme-internal.js).
//
// WHAT WENT WRONG. The ingest wrote ONE number — the total read off Eleme's
// payload by candidate key — into BOTH retail_orders.subtotal and
// retail_orders.total, while the order's lines carried their own real per-line
// money. Nothing compared them. And the number it read was not the bill:
// TOTAL_KEYS ends in the bare 'total', pick() walks the payload's sub-objects
// trying every candidate at each one, and settlementInfo.merchantActivityInfo
// (a SHOP-FUNDED PROMOTION) is reached before settlementInfo.customerPaidInfo.
// On EL20260901417897 that put ¥17.50 of promotion where ¥269 of bill belonged,
// above ¥38 + ¥29 + ¥200 of goods.
//
// WHAT THIS REPAIRS.
//
//   subtotal — set to the line sum, freely. It means "the value of the goods" on
//     every other order in this table, the lines are the only thing that knows
//     it, and no money decision anywhere reads this column (refund ceilings read
//     `total`).
//
//   total — the customer-paid figure, and the refund ceiling
//     (routes/retail.js orderTenders). NEVER rewritten on a guess. It moves only
//     when the order's OWN archived payload states it, at one of the paths the
//     live capture confirmed:
//       settlementInfo.customerPaidInfo.total
//       printDataInfo.payAmount
//       settlementInfo.subTotalFeeInfo.total
//     No payload, or no such field, and the order is reported and left alone.
//     It will not LOWER a total on an order that already has an approved refund:
//     shrinking a ceiling under a refund someone is part-way through is the one
//     move here that could strand money.
//
// Dry run unless --apply is passed; the dry run prints exactly what --apply
// would do. Safe to re-run — it is a convergence, not an increment.
//
// Usage, on the box (cd /root/roots-v2):
//   node scripts/fix_eleme_order_money.js                          # survey every Eleme order
//   node scripts/fix_eleme_order_money.js --order EL20260901417897 # survey one
//   node scripts/fix_eleme_order_money.js --apply                  # subtotals only
//   node scripts/fix_eleme_order_money.js --apply --adopt-payload-total
//
// The read-only twin, runnable from Actions without a shell on the box, is
// scripts/diagnose_eleme_order_money.js.

'use strict';

const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));

const argv    = process.argv.slice(2);
const APPLY   = argv.includes('--apply');
// The old spelling, kept working: it meant the same thing and may be in a shell
// history somewhere.
const ADOPT   = argv.includes('--adopt-payload-total') || argv.includes('--adopt-corroborated-total');
const orderAt = argv.indexOf('--order');
const ONE     = orderAt >= 0 ? argv[orderAt + 1] : null;

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const money  = (n) => round2(n).toFixed(2);

// The paths a live Eleme payload actually carries the customer-paid total at,
// in the order lib/eleme-browser.js now reads them.
const TOTAL_PATHS = [
  'settlementInfo.customerPaidInfo.total',
  'printDataInfo.payAmount',
  'settlementInfo.subTotalFeeInfo.total',
];
// Read for context only, never adopted — these are what the mis-read was picking
// from, and seeing them beside the answer is what makes a repair reviewable.
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

// The order's own payload, from wherever it was archived. raw_payload is the
// list row; detail_json.detail is the Tier 1 read, which carries the same shape.
function payloadsFor(imp) {
  if (!imp) return [];
  const out = [];
  const raw = parseJson(imp.raw_payload);
  if (raw) out.push({ src: 'raw_payload', doc: raw });
  const d = parseJson(imp.detail_json);
  if (d && d.detail) out.push({ src: 'detail_json.detail', doc: d.detail });
  return out;
}

// What the payload says the customer paid, and which field said so.
function payloadTotal(imp) {
  for (const { src, doc } of payloadsFor(imp)) {
    for (const path of TOTAL_PATHS) {
      const v = atPath(doc, path);
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return { value: round2(n), path, src };
    }
  }
  return null;
}

function contextFor(imp) {
  const out = [];
  for (const { doc } of payloadsFor(imp)) {
    for (const path of CONTEXT_PATHS) {
      const n = Number(atPath(doc, path));
      if (Number.isFinite(n)) out.push({ path, value: n });
    }
    if (out.length) break;
  }
  return out;
}

const where = ONE ? 'AND o.order_no = ?' : '';
const rows = db.prepare(`
  SELECT o.id, o.order_no, o.status, o.subtotal, o.total,
         o.refund_amount_approved, o.store_id
    FROM retail_orders o
   WHERE o.channel = 'eleme' ${where}
   ORDER BY o.id DESC
`).all(...(ONE ? [ONE] : []));

if (!rows.length) {
  console.log(ONE ? `No Eleme order found with order_no = ${ONE}` : 'No Eleme orders in this database.');
  process.exit(0);
}

const itemStmt = db.prepare(
  'SELECT name_en, name_cn, qty, unit_price, line_total FROM retail_order_items WHERE order_id = ? ORDER BY id'
);
const impStmt = db.prepare(
  'SELECT eleme_order_id, raw_payload, detail_json FROM eleme_order_import WHERE retail_order_id = ?'
);

let examined = 0, subtotalFixes = 0, totalFixes = 0, unexplained = 0;
const plan = [];

for (const o of rows) {
  examined++;
  const items = itemStmt.all(o.id);
  const priced = items.length > 0 && items.every(it => Number(it.line_total) > 0);
  const itemsSum = priced ? round2(items.reduce((a, it) => a + Number(it.line_total), 0)) : null;

  const imp  = impStmt.get(o.id);
  const paid = payloadTotal(imp);
  const recordedTotal = round2(o.total);

  const subtotalWrong = itemsSum != null && round2(o.subtotal) !== itemsSum;
  const totalWrong    = paid != null && paid.value !== recordedTotal;
  const zeroTotal     = !(recordedTotal > 0);
  // A gap the lines and the recorded total cannot explain between them, with no
  // payload to settle it. Reported, never repaired.
  const gapNoEvidence = paid == null && itemsSum != null
    && Math.abs(itemsSum - recordedTotal) > Math.max(5, itemsSum * 0.3);

  if (!subtotalWrong && !totalWrong && !gapNoEvidence && !zeroTotal) continue;

  // Never shrink a ceiling under a refund already in flight.
  const wouldLower = paid != null && paid.value < recordedTotal;
  const refundInFlight = Number(o.refund_amount_approved) > 0;
  const blocked = wouldLower && refundInFlight;
  const setTotal = totalWrong && (ADOPT || zeroTotal) && !blocked ? paid.value : null;

  plan.push({ o, itemsSum, subtotalWrong, setTotal, paid });

  console.log(`\n${o.order_no}  (id ${o.id}, ${o.status})`);
  if (itemsSum != null) {
    console.log(`  items  ¥${money(itemsSum)}   ${items.length} line(s): ` +
      items.map(i => `${i.name_en || i.name_cn} ×${i.qty} @¥${money(i.unit_price)}`).join(' · '));
  } else {
    console.log(`  items  ${items.length} line(s), no usable prices`);
  }
  console.log(`  stored subtotal ¥${money(o.subtotal)}   total ¥${money(o.total)}`);

  if (subtotalWrong) {
    subtotalFixes++;
    console.log(`  → subtotal ¥${money(o.subtotal)} → ¥${money(itemsSum)}  (goods value, from the lines)`);
  }
  if (paid) {
    console.log(`  payload says the customer paid ¥${money(paid.value)}  (${paid.src}: ${paid.path})`);
    const ctx = contextFor(imp);
    if (ctx.length) {
      console.log('  the rest of that order\'s money, for review:');
      for (const c of ctx) console.log(`      ${c.path} = ${c.value}`);
    }
  } else if (imp) {
    console.log('  payload holds no customer-paid total at any known path');
  } else {
    console.log('  no archived payload for this order');
  }
  if (blocked) {
    console.log(`  ! NOT touching total: the payload figure ¥${money(paid.value)} is LOWER than the recorded ` +
      `¥${money(o.total)} and ¥${money(o.refund_amount_approved)} has already been refunded. Decide this one by hand.`);
  } else if (setTotal != null) {
    totalFixes++;
    console.log(`  → total ¥${money(o.total)} → ¥${money(setTotal)}  (${zeroTotal ? 'no total was recorded' : 'stated by the payload'})`);
  } else if (totalWrong) {
    console.log(`  → total would become ¥${money(paid.value)} — pass --adopt-payload-total to write it`);
  } else if (gapNoEvidence) {
    unexplained++;
    console.log(`  ! total ¥${money(o.total)} disagrees with ¥${money(itemsSum)} of items and no payload can settle it.`);
    console.log('    Left alone. Check the order on Eleme — a real discount looks exactly like this.');
  }
}

console.log(`\n${examined} Eleme order(s) examined · ${subtotalFixes} subtotal repair(s) · ` +
  `${totalFixes} total repair(s) · ${unexplained} disagreement(s) with no evidence either way`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to write the repairs above.');
  process.exit(0);
}

const write = db.transaction(() => {
  for (const p of plan) {
    if (!p.subtotalWrong && p.setTotal == null) continue;
    if (p.subtotalWrong) {
      db.prepare('UPDATE retail_orders SET subtotal = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(p.itemsSum, p.o.id);
    }
    if (p.setTotal != null) {
      db.prepare('UPDATE retail_orders SET total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(p.setTotal, p.o.id);
    }
    // The repair leaves its own record, in the log the admin's Eleme tab already
    // reads. An order whose money moved without a trace is the thing this whole
    // change exists to stop happening.
    try {
      db.prepare(`
        INSERT INTO eleme_sync_log (store_code, event_type, status, detail, error_msg)
        VALUES (?, 'order_money_repair', 'ok', ?, ?)
      `).run(
        String(p.o.store_id || ''),
        JSON.stringify({
          orderNo: p.o.order_no, itemsTotal: p.itemsSum,
          subtotalWas: p.o.subtotal, subtotalNow: p.subtotalWrong ? p.itemsSum : p.o.subtotal,
          totalWas: p.o.total, totalNow: p.setTotal != null ? p.setTotal : p.o.total,
          statedBy: p.setTotal != null && p.paid ? `${p.paid.src}:${p.paid.path}` : null,
        }),
        `subtotal ${money(p.o.subtotal)} → ${money(p.subtotalWrong ? p.itemsSum : p.o.subtotal)}` +
          (p.setTotal != null ? `, total ${money(p.o.total)} → ${money(p.setTotal)}` : '')
      );
    } catch (e) { console.error('  (log write failed:', e.message, ')'); }
  }
});
write();
console.log(`\nAPPLIED — ${subtotalFixes} subtotal(s) and ${totalFixes} total(s) written, each recorded in eleme_sync_log as order_money_repair.`);
