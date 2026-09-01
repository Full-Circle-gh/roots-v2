// Repair the money on Eleme orders that were mirrored in before the ingest told
// the two figures apart (routes/eleme-internal.js).
//
// THE BUG THIS CLEANS UP AFTER. The ingest used to write ONE number — the single
// total read off Eleme's payload — into BOTH retail_orders.subtotal and
// retail_orders.total, while the order's line items carried their own, real,
// per-line money. Nothing ever compared them. On EL20260901417897 that produced a
// drawer whose hero banner read "¥17.50 · subtotal ¥17.50 · shipping ¥0.00"
// directly above ¥38.00 + ¥29.00 + ¥200.00 of goods.
//
// WHAT IT REPAIRS, AND WHAT IT DELIBERATELY WILL NOT.
//
//   subtotal — repaired freely. It means "the value of the goods" on every other
//     order in the table, the lines are the only thing that knows it, and no
//     money decision anywhere reads this column (refund ceilings read `total`).
//
//   total — the platform's claim about what the customer was charged, and the
//     refund ceiling (routes/retail.js orderTenders). NEVER rewritten on a guess.
//     Two exceptions, both evidence-led:
//       · it is 0 or missing and the lines are priced — 0 is not a claim, it is
//         the absence of one, and it makes the order unreportable and
//         unrefundable either way;
//       · --adopt-corroborated-total AND the order's own stored Eleme payload
//         contains a field equal to the line sum (in 元 or in 分). That is the
//         signature of a wrong-key read: the right number WAS on the wire, under
//         a key TOTAL_KEYS did not reach first. The script names the field it
//         found, so the decision is reviewable rather than trusted.
//     It never LOWERS a total. Lowering one silently shrinks the refund ceiling
//     on an order someone may already be part-way through refunding.
//
// Dry run unless --apply is passed; the dry run prints exactly what --apply would
// do. Safe to re-run — it is a convergence, not an increment.
//
// Usage, on the box (cd /root/roots-v2):
//   node scripts/fix_eleme_order_money.js                          # survey every Eleme order
//   node scripts/fix_eleme_order_money.js --order EL20260901417897 # survey one
//   node scripts/fix_eleme_order_money.js --order EL20260901417897 --apply
//   node scripts/fix_eleme_order_money.js --apply --adopt-corroborated-total

'use strict';

const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));

const argv    = process.argv.slice(2);
const APPLY   = argv.includes('--apply');
const ADOPT   = argv.includes('--adopt-corroborated-total');
const orderAt = argv.indexOf('--order');
const ONE     = orderAt >= 0 ? argv[orderAt + 1] : null;

function money(n) { return (Math.round(Number(n) * 100) / 100).toFixed(2); }
function round2(n) { return Math.round(Number(n) * 100) / 100; }

// Every numeric leaf in a stored payload, with the path that reaches it. The
// paths are the point: "the basket value was sitting in feeInfo.totalAmount all
// along" is a finding; "some field somewhere matched" is not.
function numericLeaves(value, path = '', out = []) {
  if (value == null) return out;
  if (typeof value === 'number' && Number.isFinite(value)) { out.push({ path, value }); return out; }
  if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) {
    out.push({ path, value: Number(value) });
    return out;
  }
  if (typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => numericLeaves(v, `${path}[${i}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(value)) numericLeaves(v, path ? `${path}.${k}` : k, out);
  return out;
}

function parseJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

// Fields in this order's own archived payload that hold the line sum, in 元 or in
// 分. A hit is evidence the total was read from the wrong key; no hit means the
// basket value was never on the wire we captured, and the disagreement is
// something else (a real discount, a partial payload) that a script must not
// paper over.
const OUR_OWN_FIELDS = new Set(['detail.itemsTotal', 'detail.channelTotal', 'detail.moneyDivisor']);

function corroboratingFields(imp, itemsSum) {
  if (!imp || !(itemsSum > 0)) return [];
  const leaves = []
    .concat(numericLeaves(parseJson(imp.raw_payload), 'raw'))
    .concat(numericLeaves(parseJson(imp.detail_json), 'detail'));
  const want = round2(itemsSum);
  const wantFen = Math.round(itemsSum * 100);
  return leaves.filter(l => round2(l.value) === want || Math.round(l.value) === wantFen)
    // A line's own totalPrice equalling the basket is not corroboration on a
    // single-line order — it is the same fact restated. Only order-level fields
    // count, so anything sitting inside an array (every items list is one) is out.
    .filter(l => !/\[\d+\]/.test(l.path))
    // Nor is OUR OWN arithmetic. eleme_order_import.detail_json carries the
    // fields the daemon computed (archiveFields in scripts/eleme-daemon.js), and
    // detail.itemsTotal is this very line sum written back down. Counting it
    // would make every order corroborate itself and turn
    // --adopt-corroborated-total into a rubber stamp. Only what Eleme sent
    // counts as evidence about what Eleme charged.
    .filter(l => !OUR_OWN_FIELDS.has(l.path));
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

let examined = 0, subtotalFixes = 0, totalFixes = 0, flagged = 0;
const plan = [];

for (const o of rows) {
  examined++;
  const items = itemStmt.all(o.id);
  const priced = items.length > 0 && items.every(it => Number(it.line_total) > 0);
  const itemsSum = priced ? round2(items.reduce((a, it) => a + Number(it.line_total), 0)) : null;
  if (itemsSum == null) continue;                 // nothing to reason from

  const subtotalWrong = round2(o.subtotal) !== itemsSum;
  const gap = round2(itemsSum - Number(o.total));
  const disagrees = Math.abs(gap) > Math.max(5, itemsSum * 0.3);

  if (!subtotalWrong && !disagrees) continue;

  const imp = impStmt.get(o.id);
  const hits = disagrees ? corroboratingFields(imp, itemsSum) : [];
  const zeroTotal = !(Number(o.total) > 0);
  const adoptable = zeroTotal || (ADOPT && hits.length > 0);
  const raising = itemsSum > Number(o.total);

  plan.push({ o, items, itemsSum, gap, disagrees, hits, subtotalWrong,
              // Never lower a total: that shrinks a refund ceiling under an
              // operator who may already be mid-refund.
              setTotal: adoptable && raising ? itemsSum : null });

  console.log(`\n${o.order_no}  (id ${o.id}, ${o.status})`);
  console.log(`  items  ¥${money(itemsSum)}   ${items.length} line(s): ` +
    items.map(i => `${i.name_en || i.name_cn} ×${i.qty} @¥${money(i.unit_price)}`).join(' · '));
  console.log(`  stored subtotal ¥${money(o.subtotal)}   total ¥${money(o.total)}`);
  if (subtotalWrong) { subtotalFixes++; console.log(`  → subtotal ¥${money(o.subtotal)} → ¥${money(itemsSum)}  (goods value, from the lines)`); }
  if (disagrees) {
    flagged++;
    console.log(`  ! total disagrees with the items by ¥${money(Math.abs(gap))}` +
      (Number(o.total) > 0 ? ` (items are ${round2(itemsSum / Number(o.total))}× the total)` : ' (no total recorded)'));
    if (imp && imp.detail_json) {
      const d = parseJson(imp.detail_json) || {};
      if (d.totalKeyPath) console.log(`    total was read from payload field: ${d.totalKeyPath}`);
      if (d.moneyDivisor != null) console.log(`    money divisor applied: ${d.moneyDivisor}`);
    }
    if (hits.length) {
      console.log(`    payload fields holding ¥${money(itemsSum)} (evidence the total came off the wrong key):`);
      for (const h of hits.slice(0, 8)) console.log(`      ${h.path} = ${h.value}`);
      if (!ADOPT && !zeroTotal) console.log('    (pass --adopt-corroborated-total to move `total` onto this figure)');
    } else if (!imp) {
      console.log('    no archived payload for this order — nothing to corroborate against');
    } else {
      console.log(`    no payload field holds ¥${money(itemsSum)} — the gap is NOT a wrong-key read.`);
      console.log('    Leave `total` alone and check the order on Eleme: a real discount looks exactly like this.');
    }
  }
  const p = plan[plan.length - 1];
  if (p.setTotal != null) { totalFixes++; console.log(`  → total ¥${money(o.total)} → ¥${money(p.setTotal)}  (${zeroTotal ? 'no total was recorded' : 'corroborated by the stored payload'})`); }
}

console.log(`\n${examined} Eleme order(s) examined · ${subtotalFixes} subtotal repair(s) · ${totalFixes} total repair(s) · ${flagged} still disagreeing`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to write the repairs above.');
  process.exit(0);
}

const write = db.transaction(() => {
  for (const p of plan) {
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
          corroboratedBy: p.hits.map(h => h.path).slice(0, 8),
        }),
        `subtotal ${money(p.o.subtotal)} → ${money(p.subtotalWrong ? p.itemsSum : p.o.subtotal)}` +
          (p.setTotal != null ? `, total ${money(p.o.total)} → ${money(p.setTotal)}` : '')
      );
    } catch (e) { console.error('  (log write failed:', e.message, ')'); }
  }
});
write();
console.log(`\nAPPLIED — ${subtotalFixes} subtotal(s) and ${totalFixes} total(s) written, each recorded in eleme_sync_log as order_money_repair.`);
