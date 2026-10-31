#!/usr/bin/env node
/**
 * diagnose_cost_coverage.js — can a cost-of-goods reader be built yet, and
 * what would it say if it were?
 *
 * WHY THIS EXISTS
 * ---------------
 * `docs/tacet-consolidation-decisions.md` §56 (Ash, 2026-09-07) holds
 * `cost_of_goods` and `gross_profit` null on the Finance summary, and gates
 * them on §31: "when §31 lands, these two rows fill from it and nothing else."
 * §31's storage HAS since landed — `product_build_lines` exists, and
 * `applyProductBuildCosts()` feeds `store_products.unit_cost` from it — so
 * whether that gate is open is now a question about the DATA rather than about
 * the code, and nobody has looked at the data.
 *
 * This script is that look. It answers three questions and nothing else:
 *
 *   1. What fraction of a window's sales can be costed at all?
 *   2. Of the part that can, how much is knowingly understated?
 *   3. Is the catalogue behind it complete enough to trust either answer?
 *
 * It decides nothing. §36's own precedent is the shape being followed here:
 * the cost-capture cutoff sat recorded for a month as "a production query that
 * HAS NOT BEEN RUN", and running it on 2026-09-02 replaced five guessed
 * per-channel boundaries with one measured date. Same discipline, same reason.
 *
 * WHY A COVERAGE FIGURE IS THE WHOLE POINT
 * -----------------------------------------
 * A cost reader is roughly a day's work and the arithmetic is not hard. The
 * risk is not that it fails — it is that it SUCCEEDS on partial data. Sum the
 * lines that carry a cost, divide into revenue that includes the lines that do
 * not, and the screen reports a gross margin that is confidently too high, in
 * the direction that flatters, with nothing on the page to say so. §56 refuses
 * exactly that ("a wrong margin at the top of the finance screen is worse than
 * a blank one, because a tenant will price from it"), and §31 rule 9 refuses
 * its sibling one level down. So: measure first, decide second, build third.
 *
 * READ-ONLY, AND IT PROVES IT. The database is opened `readonly: true` and a
 * write is attempted and REQUIRED to fail before any query runs. Nothing here
 * ships, restarts, or touches a process.
 *
 * THE PREDICATES ARE BORROWED, NOT RESTATED. `PAID_O` and `odateFor()` come
 * from lib/finance-window.js — the same two the Summary endpoint itself uses.
 * §36 records that the order allow-list is re-declared inline four times across
 * the existing aggregators and that four date conventions are live at once, and
 * warns that a cost reader "must not inherit one by copying whichever site is
 * nearest." A measurement taken under a different predicate from the screen it
 * is measuring for would answer a question nobody asked.
 *
 * HOW TO RUN IT
 *   .github/workflows/ro-query.yml (workflow_dispatch) with
 *     script = scripts/diagnose_cost_coverage.js
 *   Dispatch it against THIS BRANCH — the workflow checks out the ref it is
 *   given, and this file does not exist on main.
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || path.join(HOME, 'data', 'roots.db');

// The Summary's own predicates, from the staged tree — which is the CHECKOUT's
// lib/ rather than the deployed one, per ro-query.yml's own note on why that
// distinction is load-bearing.
//
// PAID_O, NOT PAID. The alias-qualified twin exists precisely so a query that
// joins retail_orders under an alias does not hand-write the allow-list a
// thirteenth time. Every query below joins, so every query below uses it.
const { PAID_O, odateFor } = require(path.join(HOME, 'lib', 'finance-window'));
const { sqlDayShiftForShop } = require(path.join(HOME, 'lib', 'business-date'));

// ── Output helpers ─────────────────────────────────────────────────────────
const out = (s = '') => console.log(s);
const rule = (t) => { out(); out('─'.repeat(78)); out(t); out('─'.repeat(78)); };
const yuan = (n) => '¥' + (Number(n) || 0).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (num, den) => (!Number(den) ? '—' : ((100 * Number(num)) / Number(den)).toFixed(1) + '%');
// One label width for every counted line, so the figures form a column an eye
// can run down. A report read once, to decide something, earns that.
const LBL = 46;
const item = (label, value, note) =>
  out('  ' + String(label).padEnd(LBL) + String(value).padStart(8) + (note ? '   ' + note : ''));

// ── Open read-only, and prove it ───────────────────────────────────────────
// A readonly flag that is not enforced is a comment. The write below must be
// REJECTED; if SQLite accepts it, this script holds a writable handle on
// production and must abort before it reads anything, not after.
let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error(`[cost-coverage] cannot open ${DB_PATH}: ${e && e.message}`);
  process.exit(1);
}
try {
  db.prepare('CREATE TABLE _cost_coverage_write_probe (x INTEGER)').run();
  console.error('[cost-coverage] ABORT: the connection accepted a write. Not read-only.');
  process.exit(1);
} catch (e) {
  if (!/readonly|read-only|attempt to write/i.test(String(e && e.message))) {
    console.error(`[cost-coverage] ABORT: write refused for an unexpected reason: ${e && e.message}`);
    process.exit(1);
  }
}

// ── Column introspection ───────────────────────────────────────────────────
// Every column this script touches was added by `addColumn()` rather than
// declared in a CREATE, so a box mid-migration can be missing any of them. A
// diagnostic that throws on a missing column tells you nothing; one that names
// what it could not read tells you where you are.
function cols(table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name)); }
  catch { return new Set(); }
}
const OI = cols('retail_order_items');
const OR = cols('retail_orders');
const SP = cols('store_products');

const missing = ['unit_cost_at_sale', 'refunded_qty', 'pack_units', 'line_total', 'qty', 'product_id']
  .filter(c => !OI.has(c)).map(c => `retail_order_items.${c}`);
if (missing.length) {
  console.error('[cost-coverage] ABORT: columns absent on this database: ' + missing.join(', '));
  process.exit(1);
}

// THE UNQUALIFIED DATE IS SAFE, AND THIS PROVES IT RATHER THAN ASSUMING IT.
// `odateFor()` has no alias-qualified twin — it returns
// `date(COALESCE(paid_at, placed_at), …)` bare. That is unambiguous inside the
// joins below only for as long as retail_order_items carries NEITHER column.
// Both are plausible future additions to a line (a per-line dispatch stamp, a
// split-shipment paid date), and the failure would be silent: SQLite would
// resolve to the line's column and every figure here would quietly re-date.
// So it is checked, once, and the script refuses rather than measuring wrongly.
for (const c of ['paid_at', 'placed_at', 'status', 'replacement_for_order_id']) {
  if (OI.has(c)) {
    console.error(`[cost-coverage] ABORT: retail_order_items now carries '${c}'. `
      + 'The unqualified order-date/status predicates in this script are no longer '
      + 'unambiguous — qualify them against lib/finance-window.js before re-running.');
    process.exit(1);
  }
}

const hasBuildLines = (() => {
  try { db.prepare('SELECT 1 FROM product_build_lines LIMIT 1').get(); return true; }
  catch { return false; }
})();

const SHIFT = sqlDayShiftForShop(db);
const ODATE = odateFor(SHIFT);

out('COST OF GOODS — COVERAGE MEASUREMENT');
out(`database   ${DB_PATH}`);
out(`run at     ${new Date().toISOString()}`);
out(`day shift  ${SHIFT}   (the shop's own boundary, not the +8 fallback)`);
out(`predicate  ${PAID_O}`);
out(`order date ${ODATE}`);

// ── The billable-quantity expression ───────────────────────────────────────
// §36's first two miscount traps, in one expression and deliberately together:
//
//   PACK UNITS. `unit_cost_at_sale` is per single unit; `line_total` is per
//   line. A Meituan qty of 1 against a 6瓶 listing is six units off the shelf
//   with pack_units = 6. So the COST half takes the multiplier and the REVENUE
//   half must NOT — a reader that treats them alike is wrong on one of them.
//
//   ITEMISED PARTIAL REFUNDS. `applyRefundedQty` stamps `refunded_qty` and
//   stops: status stays paid, qty is never reduced, and nothing in the codebase
//   subtracts it from any aggregate today.
//
// This is what a real reader would use, which is the point — the figures below
// are not an approximation of what the screen would show, they are it.
const COST_SQL = `COALESCE(i.unit_cost_at_sale,0)
                  * (COALESCE(i.qty,0) - COALESCE(i.refunded_qty,0))
                  * COALESCE(i.pack_units,1)`;
const REV_SQL = 'COALESCE(i.line_total,0)';
const WINDOW = `${PAID_O} AND ${ODATE} BETWEEN ? AND ?`;

// ── Windows ────────────────────────────────────────────────────────────────
// Fixed calendar windows plus the two that matter for the question being asked:
// one entirely before capture started, and one straddling the 31 August cutoff
// §36 measured. A reader that looks right on September alone has not been
// tested against the periods an operator will actually open — the screenshot
// that started this ran 17 Aug – 15 Sep, whose first fortnight has no cost at
// all and never will.
const today = new Date().toISOString().slice(0, 10);
const ago = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
const WINDOWS = [
  ['last 7 days', ago(7), today],
  ['last 30 days', ago(30), today],
  ['last 90 days', ago(90), today],
  ['August 2026 (straddles the 31 Aug cutoff)', '2026-08-01', '2026-08-31'],
  ['September 2026 so far', '2026-09-01', today],
  ['July 2026 (entirely before capture)', '2026-07-01', '2026-07-31'],
];
const W30 = WINDOWS[1];

// ══ SECTION 1 · Can a window be costed at all? ═════════════════════════════
rule('1 · COVERAGE — what fraction of a window can be costed');
out();
out('Two percentages, and the second is the one that matters. A line count');
out('treats a ¥4 sticker and a ¥400 hamper alike; the money column says what');
out('share of the REVENUE has a cost behind it, which is what a margin rests on.');
out();
const covHead = '  ' + 'window'.padEnd(42) + 'lines'.padStart(5) + 'costed'.padStart(8)
  + 'by line'.padStart(10) + 'by money'.padStart(11);
out(covHead);
out('  ' + '-'.repeat(covHead.length - 2));

const covStmt = db.prepare(`
  SELECT COUNT(*)                                                          AS lines,
         SUM(CASE WHEN i.unit_cost_at_sale IS NOT NULL THEN 1 ELSE 0 END)  AS costed,
         SUM(${REV_SQL})                                                   AS rev_all,
         SUM(CASE WHEN i.unit_cost_at_sale IS NOT NULL THEN ${REV_SQL} ELSE 0 END) AS rev_costed,
         SUM(CASE WHEN i.unit_cost_at_sale IS NOT NULL THEN ${COST_SQL} ELSE 0 END) AS cogs
    FROM retail_order_items i
    JOIN retail_orders o ON o.id = i.order_id
   WHERE ${WINDOW}`);

const coverage = {};
for (const [label, from, to] of WINDOWS) {
  const r = covStmt.get(from, to) || {};
  coverage[label] = { ...r, from, to };
  out('  ' + label.padEnd(42)
    + String(r.lines || 0).padStart(5)
    + String(r.costed || 0).padStart(8)
    + pct(r.costed, r.lines).padStart(10)
    + pct(r.rev_costed, r.rev_all).padStart(11));
}

// ══ SECTION 2 · Of what CAN be costed, how much is understated? ════════════
rule('2 · HONESTY — of the costed part, how much is knowingly low');
out();
out("§36 records that `store_products.cost_incomplete` NEVER REACHES THE LINE.");
out('The flag lives on the mutable product row, so it cannot be recovered for a');
out('past sale, and a line whose cost is knowingly understated is identical on');
out("disk to one that is right. The figures below therefore read TODAY's flag");
out('against a historic sale — the best available answer, and not the same');
out('question. Read them as a bound on trustworthiness, not a fact about what');
out('was true at the time of the sale.');
out();

if (!SP.has('cost_incomplete')) {
  out('  store_products.cost_incomplete is absent on this database — section skipped.');
} else {
  const incStmt = db.prepare(`
    SELECT COUNT(*)                                                      AS lines,
           SUM(CASE WHEN p.cost_incomplete = 1 THEN 1 ELSE 0 END)        AS flagged,
           SUM(${REV_SQL})                                               AS rev,
           SUM(CASE WHEN p.cost_incomplete = 1 THEN ${REV_SQL} ELSE 0 END) AS rev_flagged
      FROM retail_order_items i
      JOIN retail_orders o ON o.id = i.order_id
      LEFT JOIN store_products p ON p.id = i.product_id
     WHERE ${WINDOW} AND i.unit_cost_at_sale IS NOT NULL`);
  const incHead = '  ' + 'window'.padEnd(42) + 'costed'.padStart(6) + 'flagged'.padStart(9)
    + 'by line'.padStart(10) + 'by money'.padStart(11);
  out(incHead);
  out('  ' + '-'.repeat(incHead.length - 2));
  for (const [label, from, to] of WINDOWS) {
    const r = incStmt.get(from, to) || {};
    out('  ' + label.padEnd(42)
      + String(r.lines || 0).padStart(6)
      + String(r.flagged || 0).padStart(9)
      + pct(r.flagged, r.lines).padStart(10)
      + pct(r.rev_flagged, r.rev).padStart(11));
  }
}

// ══ SECTION 3 · Is the catalogue behind it ready? ══════════════════════════
rule('3 · CATALOGUE — is §31 complete enough to gate on');
out();
out('§31 records that the one-time pass is the real cost of the change, not the');
out('code: "65 products carry a packaging figure through their recipe today, and');
out('each one needs its packaging picked once." This counts how far that pass has');
out('actually got, because a cost reader over a half-migrated catalogue reports');
out('contents without packaging — a number that is low and looks plausible.');
out();

const activeCol = SP.has('is_active') ? 'is_active = 1' : '1 = 1';
const cat = db.prepare(`
  SELECT COUNT(*) AS n,
         SUM(CASE WHEN unit_cost IS NOT NULL AND unit_cost > 0 THEN 1 ELSE 0 END) AS costed
    FROM store_products WHERE ${activeCol}`).get() || {};
item('active products', cat.n || 0);
item('…carrying a unit_cost > 0', cat.costed || 0, pct(cat.costed, cat.n));

if (SP.has('cost_incomplete')) {
  const f = db.prepare(`SELECT COUNT(*) AS n FROM store_products
                         WHERE ${activeCol} AND cost_incomplete = 1`).get() || {};
  item('…flagged cost_incomplete', f.n || 0, pct(f.n, cat.n));
}
if (hasBuildLines) {
  const b = db.prepare(`
    SELECT COUNT(DISTINCT p.id) AS n
      FROM store_products p
      JOIN product_build_lines l ON l.product_id = p.id
     WHERE ${activeCol}`).get() || {};
  item('…carrying a §31 build list', b.n || 0, pct(b.n, cat.n));
  const orphan = db.prepare(
    'SELECT COUNT(*) AS n FROM product_build_lines WHERE ingredient_id IS NULL').get() || {};
  item('build lines whose material was deleted', orphan.n || 0, '(each blanks its whole product)');
} else {
  out('  product_build_lines is absent — §31 storage has NOT reached this box.');
}

// ══ SECTION 4 · The traps, counted ═════════════════════════════════════════
rule('4 · TRAPS — how much of the last 30 days each one touches');
out();
out('§36 lists six ways the reader miscounts, "each of these produces a plausible');
out('wrong number rather than an error". Three the expression above handles;');
out('three it cannot. Counted so the size of each hole is a figure rather than an');
out('adjective.');
out();

const scalar = (sql) => {
  try {
    return db.prepare(`SELECT ${sql} AS v
                         FROM retail_order_items i
                         JOIN retail_orders o ON o.id = i.order_id
                        WHERE ${WINDOW}`).get(W30[1], W30[2]).v || 0;
  } catch (e) { return `ERR ${e && e.message}`; }
};

out('  HANDLED by the reader — but only if it is written correctly:');
item('lines with pack_units > 1',
  scalar('SUM(CASE WHEN COALESCE(i.pack_units,1) > 1 THEN 1 ELSE 0 END)'),
  'their revenue, which must NOT take the multiplier: '
  + yuan(scalar(`SUM(CASE WHEN COALESCE(i.pack_units,1) > 1 THEN ${REV_SQL} ELSE 0 END)`)));
item('lines with an itemised partial refund',
  scalar('SUM(CASE WHEN COALESCE(i.refunded_qty,0) > 0 THEN 1 ELSE 0 END)'));
out();
out('  NOT HANDLED — these under- or over-count whatever the reader does:');

// Amount-only refunds. §36: "a reader working from order lines cannot see it at
// any level of sophistication." Counted at the ORDER level for that exact
// reason — there is nothing on the line to count.
if (OR.has('refund_amount_paid')) {
  const amtOnly = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(o.refund_amount_paid),0) AS amt
      FROM retail_orders o
     WHERE ${PAID_O} AND ${ODATE} BETWEEN ? AND ?
       AND COALESCE(o.refund_amount_paid,0) > 0
       AND NOT EXISTS (SELECT 1 FROM retail_order_items x
                        WHERE x.order_id = o.id AND COALESCE(x.refunded_qty,0) > 0)`)
    .get(W30[1], W30[2]) || {};
  item('orders refunded by AMOUNT, no line stamped', amtOnly.n || 0,
    `${yuan(amtOnly.amt)} invisible to any line-level read`);
} else {
  out('  retail_orders.refund_amount_paid absent — amount-only refunds not countable here.');
}

// Options carry price but no cost. The delta moved unit_price; nothing moved a
// cost, so cost is under-counted wherever a paid option costs the business.
item('lines whose options carry a price delta', scalar(
  "SUM(CASE WHEN i.options_json IS NOT NULL AND TRIM(i.options_json) NOT IN ('','[]','{}') "
  + "AND i.options_json LIKE '%price%' THEN 1 ELSE 0 END)"), 'cost side unrepresented');

// Bundles. Safe from double-counting; unsafe in that one unpriced component
// blanks the whole thing, so a bundle NULL is not the same fact as a plain NULL.
if (SP.has('bundle_items')) {
  try {
    const bn = db.prepare(`
      SELECT COUNT(*) AS n,
             SUM(CASE WHEN i.unit_cost_at_sale IS NULL THEN 1 ELSE 0 END) AS nulls
        FROM retail_order_items i
        JOIN retail_orders o ON o.id = i.order_id
        JOIN store_products p ON p.id = i.product_id
       WHERE ${WINDOW}
         AND p.bundle_items IS NOT NULL AND TRIM(p.bundle_items) NOT IN ('', '[]')`)
      .get(W30[1], W30[2]) || {};
    item('bundle lines', bn.n || 0,
      `${bn.nulls || 0} null — meaning one COMPONENT was unpriced, not the bundle`);
  } catch (e) { out(`  bundle lines — not countable: ${e && e.message}`); }
}

// Market and till sales. §36 decided they become orders; until then they carry
// revenue with no cost anywhere, which on the staircase reads as pure margin.
try {
  const se = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS amt '
    + 'FROM sales_entries WHERE date BETWEEN ? AND ?').get(W30[1], W30[2]) || {};
  item('sales_entries rows (market / till)', se.n || 0,
    `${yuan(se.amt)} — no cost column exists there at all`);
} catch {
  out('  sales_entries not readable here — market/till exposure not counted.');
}

// ══ SECTION 5 · Is the cost itself believable? ═════════════════════════════
rule('5 · SANITY — costs that are wrong at the source');
out();
out("§36's seventh trap, recorded separately because it is a different kind: a");
out('wrong number typed into the catalogue, snapshotted faithfully, read');
out('correctly. The measured instance was order 1494 — Jackfruit Chips at a');
out('¥990.00 cost against a ¥19.20 price, a ratio of 51.6 — and §36 records that');
out('product 3 still holds it, and that the true figure is a manual correction in');
out("the product editor, not a code fix. One row like this drags a whole period's");
out('margin down on its own.');
out();

if (!OI.has('unit_price')) {
  out('  retail_order_items.unit_price absent — sanity check skipped.');
} else {
  const bad = db.prepare(`
    SELECT i.order_id, i.product_id, i.name_en, i.unit_price, i.unit_cost_at_sale,
           (i.unit_cost_at_sale / NULLIF(i.unit_price,0)) AS ratio
      FROM retail_order_items i
      JOIN retail_orders o ON o.id = i.order_id
     WHERE ${WINDOW}
       AND i.unit_cost_at_sale IS NOT NULL
       AND i.unit_price > 0
       AND i.unit_cost_at_sale > i.unit_price
     ORDER BY ratio DESC LIMIT 15`).all(W30[1], W30[2]);
  if (!bad.length) {
    out('  No line in the last 30 days costs more than it sold for.');
  } else {
    out(`  ${bad.length} line(s) in the last 30 days cost MORE than they sold for:`);
    out();
    out('    order    product  name                        price        cost  ratio');
    out('    ' + '-'.repeat(68));
    for (const b of bad) {
      out('    ' + String(b.order_id).padEnd(9)
        + String(b.product_id ?? '—').padEnd(9)
        + String(b.name_en || '').slice(0, 24).padEnd(26)
        + yuan(b.unit_price).padStart(9)
        + yuan(b.unit_cost_at_sale).padStart(12)
        + (Number(b.ratio) || 0).toFixed(1).padStart(7));
    }
  }
  if (SP.has('price')) {
    const catBad = db.prepare(`SELECT COUNT(*) AS n FROM store_products
       WHERE ${activeCol} AND unit_cost IS NOT NULL AND price IS NOT NULL
         AND price > 0 AND unit_cost > price`).get() || {};
    out();
    out(`  Catalogue rows still holding a cost above their price: ${catBad.n || 0}`);
  }
}

// ══ SECTION 6 · The number ═════════════════════════════════════════════════
rule('6 · THE NUMBER — what the screen would say if this shipped today');
out();
out('The point of printing it: a percentage is easy to wave through, and a gross');
out('margin printed next to its own coverage is not. Where the coverage is low,');
out('the margin beside it is the flattering fiction §56 refuses — not a first');
out('draft of the right answer.');
out();
out("ONE CAVEAT, AND IT IS A REAL FINDING FOR THE BUILD. The Summary's revenue");
out('is SUM(retail_orders.total); the cost side can only be summed from order');
out('LINES. Those are not the same money — shipping, order-level discounts and');
out('tax sit on the header and never on a line — so a gross profit of');
out('header-revenue minus line-cost subtracts one basis from another. Both are');
out('printed so the gap is visible and sized. WHICH REVENUE THE GROSS PROFIT ROW');
out('IS BUILT ON IS A DECISION, not a detail to settle at the keyboard.');
out();

const hdrStmt = db.prepare(`
  SELECT COALESCE(SUM(o.total),0) AS rev, COUNT(*) AS orders
    FROM retail_orders o
   WHERE ${PAID_O} AND ${ODATE} BETWEEN ? AND ?`);

for (const [label, from, to] of WINDOWS) {
  const c = coverage[label] || {};
  const h = hdrStmt.get(from, to) || {};
  const cogs = Number(c.cogs) || 0;
  const revLines = Number(c.rev_all) || 0;
  const revHdr = Number(h.rev) || 0;
  const covMoney = pct(c.rev_costed, c.rev_all);
  out(`  ${label}   (${from} → ${to})`);
  out(`     revenue, order headers    ${yuan(revHdr).padStart(14)}   ${h.orders || 0} orders`);
  out(`     revenue, line totals      ${yuan(revLines).padStart(14)}   gap ${yuan(revHdr - revLines)}`);
  out(`     cost of goods, as read    ${yuan(cogs).padStart(14)}   covering ${covMoney} of line revenue`);
  if (revLines > 0) {
    out(`     gross profit  (on lines)  ${yuan(revLines - cogs).padStart(14)}   margin ${pct(revLines - cogs, revLines)}`);
    out(`     gross profit  (on header) ${yuan(revHdr - cogs).padStart(14)}   margin ${pct(revHdr - cogs, revHdr)}`);
    out(`     >> trustworthy only to the extent of that ${covMoney}.`);
  }
  out();
}

rule('WHAT THIS DOES NOT ANSWER');
out();
out("Whether to build it. §56 is Ash's decision and this script does not touch");
out('it — it exists so the decision is taken against measured numbers instead of');
out('an impression. The three questions it feeds:');
out();
out('  1. Does gross profit fill from `unit_cost_at_sale` now, or wait for full');
out('     catalogue coverage?');
out('  2. What does a PARTLY covered window show — all-or-nothing (blank unless');
out('     every line carries a cost), or a figure with a coverage disclosure?');
out("  3. Does the reader consult TODAY's `cost_incomplete` for a historic sale,");
out('     knowing that is the wrong question asked of the only data there is?');
out();

db.close();
