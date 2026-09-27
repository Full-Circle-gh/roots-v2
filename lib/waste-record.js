// Writing a loss: the row, the movement, and the link between them.
//
// EXTRACTED SO THERE IS ONE OF IT. This was private to routes/retail-waste.js,
// which was right while that file was the only thing that lost stock. Production
// is now a second: a batch of 20 that reaches the shelf as 18 has lost two jars,
// and they are a real cost that belongs in the same ledger as every other loss
// rather than in a private column nobody totals. The alternative was a second
// copy of the costing, which is precisely the drift routes/retail-waste's own
// header warns about — it records how the old kitchen screen ended up with a
// reason vocabulary that existed only in a browser.
//
// NO TRANSACTION OF ITS OWN. Every caller already has one, and it must: a waste
// row without its movement is a loss nobody deducted, and a movement without its
// row is stock that vanished with no reason attached. better-sqlite3 nests a
// transaction as a savepoint, so opening one here would work — but it would also
// let a caller believe this is atomic BY ITSELF, and the next person to call it
// outside a transaction would get exactly the half-write this is guarding.
'use strict';

const inventory = require('./inventory');
const { productUnitCostYuan } = require('./product-cost');
const { computeProductBuildCost } = require('./product-build-cost');

/* §281 — the reasons under which a packed-separately line is KEPT, not binned.
   A salad that expired or spoiled goes in the bin; its dressing, in its own pot
   and often frozen, goes back on the shelf. Damaged, a preparation error, staff
   taking one, a sample, "other": the whole thing is gone, dressing included, so
   those charge the full cost exactly as before. Decided by Ash, 2026-09-27. */
const KEPT_LINE_REASONS = new Set(['expired', 'spoiled']);

/* What ONE unit of this product costs as a loss under this reason, in yuan, or
   null when it cannot be established — productUnitCostYuan()'s contract, which
   this returns unchanged in every case but one.

   THE ONE CASE: the reason is expired or spoiled and the product's build list
   has a line ticked "packed separately". Then the loss is the build-list cost
   less those lines. `kept` lists what was left out, so a screen can say so
   rather than show a figure that silently disagrees with the product's cost.

   Everything else falls through to productUnitCostYuan(), deliberately:
     - a bundle is costed from its components, not a build list;
     - a product with no build list has no lines to tick;
     - a blocked build list (unitCost null) has no split to make, and its stored
       cost is already null, so the answer is "uncosted" either way.
   A remainder at or below zero — every line with a cost ticked kept — is null,
   not a loss of ¥0: §32 rule 10 keeps "cost nothing" and "could not price"
   apart, and nothing here can tell which the operator meant. */
function wasteUnitCostYuan(db, productId, reason) {
  const full = productUnitCostYuan(db, productId);
  const none = { unitYuan: full, kept: [] };
  if (!KEPT_LINE_REASONS.has(reason)) return none;

  const { bundleOwnsProductCost } = require('./bundle-cost');
  if (bundleOwnsProductCost(db, productId)) return none;

  let c = null;
  try { c = computeProductBuildCost(productId, db); } catch (e) { c = null; }
  if (!c || !c.hasBuildList || c.unitCost == null) return none;

  const keptLines = c.lines.filter(l => l.packedSeparately);
  if (!keptLines.length) return none;

  // A kept line's lineCost is never null here: any null line blocks the whole
  // list, and a blocked list returned above.
  const keptYuan = keptLines.reduce((a, l) => a + (Number(l.lineCost) || 0), 0);
  const rest = c.unitCost - keptYuan;
  return {
    unitYuan: rest > 0 ? rest : null,
    kept: keptLines.map(l => ({ name_en: l.name, name_cn: l.name_cn, yuan: l.lineCost })),
  };
}

/* Unit cost times quantity, ROUNDED ONCE, stored as whole cents. §24's exclusion
   of whole cents is about RATES that get multiplied downstream — a per-gram
   figure rounded to a cent and then multiplied by a thousand carries the error a
   thousand times. This is the product of that multiplication and nothing
   multiplies it again.

   THE SUB-CENT FLOOR. A real loss whose total rounds below one cent is stored as
   one cent, not zero. Zero is reserved for nothing at all: §32 rule 10 says a
   loss nobody could price and a loss that cost nothing must not render alike,
   and the table's CHECK enforces that a stored cost is strictly positive. */
function resolveCostCents(unitYuan, qty) {
  if (unitYuan == null) return { cents: null, uncosted: true };
  const cents = Math.round(unitYuan * qty * 100);
  return { cents: Math.max(1, cents), uncosted: false };
}

/* Point the movement at the row that caused it, so "why did this stock drop?" is
   a join rather than a guess. Best-effort by design: the movement and the record
   are both already correct, and an audit convenience must not roll back a loss
   that really happened. */
function linkLedgerToWaste(db, storeId, productId, wasteId) {
  try {
    const row = db.prepare(
      `SELECT MAX(id) AS id FROM retail_stock_ledger
        WHERE store_id = ? AND product_id = ? AND reason = 'waste'`
    ).get(storeId, productId);
    if (row && row.id) {
      db.prepare("UPDATE retail_stock_ledger SET ref_table = 'waste_records', ref_id = ? WHERE id = ?")
        .run(wasteId, row.id);
    }
  } catch (e) {
    console.error('[waste] ledger link failed:', e.message);
  }
}

/* Record one product loss. MUST be called inside the caller's transaction.
 *
 * Throws `insufficient_stock` (with .detail) rather than clamping. adjustStock's
 * delta path silently applies Math.max(0, old + delta) and discards the
 * shortfall — a behaviour §10 withdrew but which is still live — so reusing it
 * without this check would write a waste row saying 5 and a movement saying 3,
 * with no error anywhere. The read happens inside the caller's transaction so
 * the quantity it saw cannot move before the movement is applied.
 */
function recordProductWaste({ db, locationId, productId, qty, unit, reason, note, actor, businessDate }) {
  const onHand = db.prepare(
    'SELECT COALESCE(physical_qty, 0) AS q FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
  ).get(locationId, productId);
  const have = onHand ? onHand.q : 0;
  if (qty > have) {
    const e = new Error('insufficient_stock');
    e.detail = { on_hand: have, requested: qty };
    throw e;
  }

  // Through wasteUnitCostYuan, not productUnitCostYuan: an expired salad does
  // not lose the dressing the shop kept (§281). The preview route reads the
  // same function, so the figure shown and the figure stored still agree.
  const cost = resolveCostCents(wasteUnitCostYuan(db, productId, reason).unitYuan, qty);
  const ins = db.prepare(`
    INSERT INTO waste_records
      (location_id, subject_type, store_product_id, qty, unit, reason_code, note,
       cost_total_cents, is_uncosted, business_date, created_by, created_by_label)
    VALUES (?, 'product', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    locationId, productId, qty, unit || null, reason, note || null,
    cost.cents, cost.uncosted ? 1 : 0, businessDate,
    actor ? actor.id : null, actor ? actor.label : null
  );
  const wasteId = Number(ins.lastInsertRowid);

  // adjustStock is what fans the change out to Meituan, Eleme and gzgrocery
  // (enqueueChannelSync). Stock that drops here and not there is live
  // overselling, which is why this reuses it rather than writing its own row.
  inventory.adjustStock({
    storeId: locationId, productId, deltaQty: -qty,
    actorUserId: actor ? actor.id : null,
    actorLabel: actor ? actor.label : null,
    note: `waste #${wasteId} · ${reason}`,
    reason: 'waste',
  });

  linkLedgerToWaste(db, locationId, productId, wasteId);
  return wasteId;
}

module.exports = { resolveCostCents, linkLedgerToWaste, recordProductWaste, wasteUnitCostYuan, KEPT_LINE_REASONS };
