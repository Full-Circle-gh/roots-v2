#!/usr/bin/env node
/**
 * Why "Back to draft" is refused with cost_not_recoverable, order by order.
 *
 * THE REPORT THIS ANSWERS. A purchase order was taken off draft, and the screen
 * that says "return it to draft to change it" then refuses to, with a bare code
 * and no way forward. Leaving a postable state must give back everything the
 * order took — stock, expenses, and the ingredient cost its material lines
 * wrote — and planMaterialCostRollback (routes/retail-purchasing.js) refuses
 * the whole transition when it cannot prove what a material's cost was BEFORE
 * this order touched it. The proof it looks for is one activity_log row,
 * action='cost_update', carrying `from`, written by firePriceAlertsForPO.
 *
 * It asks for that row against EVERY material line with a price, and that is
 * the question this script exists to test, because two kinds of line can never
 * have one and neither needs one:
 *
 *   SKIPPED   — firePriceAlertsForPO refused to write the line's price at all
 *               (marked free, made-not-bought, unit mismatch, no derivable
 *               cost). It recorded the refusal in ingredient_cost_skips and
 *               moved on, so this order never touched that ingredient's cost
 *               and has nothing to give back.
 *   STALE     — a write did land, but the ingredient's buy_price has since
 *               moved off it: something newer (another order, a hand edit) is
 *               the standing price. rollbackMaterialCost already declines to
 *               clobber that case; the planner blocks on it anyway.
 *
 * What is left after those two is the genuine case: this order's price is still
 * the standing one and nothing recorded what preceded it.
 *
 * buy_price is compared rather than cost_per_unit deliberately. buy_price is
 * written STRAIGHT from po_line_items.cost_per_unit, so "is this order's write
 * still standing" is a comparison of two stored numbers. cost_per_unit is
 * derived through pack size and unit, and re-deriving it today would be a guess
 * about what the fields held then — the same guess the planner's own comment
 * refuses to make.
 *
 * Every statement is a SELECT. The database is opened read-only and the
 * connection is PROVEN read-only before anything else runs, by attempting a
 * CREATE TABLE and aborting if the write is accepted. It writes nothing and is
 * safe to run against production at any time.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_po_cost_rollback.js
 *      Optional: ROOTS_PO=PO-0021 to detail one order (all blocked ones by default).
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

const WANTED = (process.env.ROOTS_PO || '').trim();
const money = n => (Math.round(Number(n || 0) * 1e6) / 1e6).toString();
const near = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 1e-9;

// A table that may not exist on an older database — the price write-back
// guards its own use of it the same way (routes/purchases.js).
function has(table) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table);
}
const HAS_SKIPS = has('ingredient_cost_skips');
if (!HAS_SKIPS) console.log('NOTE: ingredient_cost_skips does not exist here — no line can be classified SKIPPED.\n');

// The orders the guard can fire on: anything a person could send back to draft
// or cancel. Cancelled and Requested orders are already out of a postable
// state, so the transition is not ahead of them.
const pos = db.prepare(`
  SELECT id, po_number, date, status, supplier, COALESCE(scope,'kitchen') AS scope
    FROM purchase_orders
   WHERE status IN ('Ordered','Delivered','Confirmed')
   ORDER BY date DESC, id DESC`).all();

const lines = db.prepare(`
  SELECT id, ingredient_id, name_en, name_cn, unit, cost_per_unit
    FROM po_line_items
   WHERE po_id = ? AND ingredient_id IS NOT NULL
     AND cost_per_unit IS NOT NULL AND cost_per_unit > 0
   ORDER BY sort_order, id`);
const ing = db.prepare('SELECT id, name_en, name_cn, buy_unit, buy_price, cost_per_unit, free_by_design, source_recipe_id FROM ingredients WHERE id = ?');
const logs = db.prepare(`
  SELECT details FROM activity_log
   WHERE action = 'cost_update' AND entity_type = 'ingredient' AND entity_id = ?
   ORDER BY id ASC`);
const skips = HAS_SKIPS ? db.prepare(`
  SELECT reason, resolved_at FROM ingredient_cost_skips
   WHERE ingredient_id = ? AND po_id = ?
   ORDER BY id ASC`) : null;

// One material line, classified. The four verdicts are the whole report.
function classify(po, l) {
  const master = ing.get(l.ingredient_id) || {};
  const logged = logs.all(l.ingredient_id)
    .map(r => { try { return JSON.parse(r.details); } catch (e) { return null; } })
    .filter(d => d && Number(d.po_id) === Number(po.id));
  const skipRows = skips ? skips.all(l.ingredient_id, po.id) : [];
  const standing = near(master.buy_price, l.cost_per_unit);

  let verdict, why;
  if (logged.length) {
    verdict = 'LOGGED';
    why = `prior value recorded: buy_price ${money(logged[0].from && logged[0].from.buy_price)} → ${money(logged[logged.length - 1].to && logged[logged.length - 1].to.buy_price)}`;
  } else if (skipRows.length) {
    verdict = 'SKIPPED';
    why = `this order never wrote a price — ${skipRows.map(s => s.reason).join(', ')}`;
  } else if (!standing) {
    verdict = 'STALE';
    why = `ingredient buy_price is ${money(master.buy_price)}, this line is ${money(l.cost_per_unit)} — not this order's write`;
  } else {
    verdict = 'UNRECOVERABLE';
    why = `buy_price ${money(master.buy_price)} matches this line and nothing recorded what preceded it`;
  }
  return { verdict, why, master, standing };
}

let blockedToday = 0, blockedAfter = 0, clean = 0;
const detail = [];

for (const po of pos) {
  const ls = lines.all(po.id);
  if (!ls.length) { clean++; continue; }
  const rows = ls.map(l => ({ l, ...classify(po, l) }));
  // Today: ANY line without a log row refuses the transition.
  const today = rows.filter(r => r.verdict !== 'LOGGED');
  // Proposed: only the genuine case refuses it.
  const after = rows.filter(r => r.verdict === 'UNRECOVERABLE');
  if (today.length) blockedToday++;
  if (after.length) blockedAfter++;
  if (!today.length) clean++;
  if (today.length || (WANTED && po.po_number === WANTED)) {
    detail.push({ po, rows, today: today.length, after: after.length });
  }
}

console.log('── Orders in a postable state ─────────────────────────────────');
console.log(`  ${pos.length} order(s) · ${blockedToday} refused today · ${blockedAfter} would still be refused · ${clean} unaffected\n`);

const show = WANTED ? detail.filter(d => d.po.po_number === WANTED) : detail;
if (WANTED && !show.length) {
  console.log(`ROOTS_PO=${WANTED} matched no order in a postable state with priced material lines.\n`);
}

for (const d of show) {
  const { po } = d;
  console.log(`── ${po.po_number} · ${po.date} · ${po.status} · scope=${po.scope}${po.supplier ? ' · ' + po.supplier : ''}`);
  console.log(`   refused today: ${d.today ? 'YES' : 'no'} · would still be refused: ${d.after ? 'YES' : 'no'}`);
  for (const r of d.rows) {
    const nm = r.l.name_en || r.l.name_cn || ('#' + r.l.ingredient_id);
    console.log(`   [${r.verdict.padEnd(13)}] ${nm} (ingredient ${r.l.ingredient_id})`);
    console.log(`                   line ${money(r.l.cost_per_unit)}/${r.l.unit || '?'} · ingredient buy_unit ${r.master.buy_unit || '?'}` +
                `${r.master.free_by_design ? ' · marked free' : ''}${r.master.source_recipe_id ? ' · made not bought' : ''}`);
    console.log(`                   ${r.why}`);
  }
  console.log('');
}

if (!WANTED && detail.length === 0) {
  console.log('No order in a postable state would be refused. Nothing to explain.\n');
}

console.log('── What the verdicts mean ─────────────────────────────────────');
console.log('  LOGGED         the prior cost is on record — rollback works, this line never blocked anything');
console.log('  SKIPPED        this order never wrote this ingredient\'s cost, so it has nothing to give back');
console.log('  STALE          a newer price is standing; rollbackMaterialCost would decline to touch it anyway');
console.log('  UNRECOVERABLE  this order\'s price is still standing and nothing recorded what came before it');
console.log('');
console.log('  SKIPPED and STALE are the false refusals. UNRECOVERABLE is the real one, and the');
console.log('  only honest way out of it is a person deciding what the price should be — setting');
console.log('  the material\'s cost by hand makes this order\'s write no longer the standing one.');
