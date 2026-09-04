// Production — what the kitchen MADE, recorded where the kitchen actually is.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
//
// production_batches has been in the schema since the beginning and is empty.
// Not because anybody forgot: the only two screens that write it (public/
// kitchen.html's Production tab and app.html's Production Log) are gated on the
// `kitchen` PERMISSION, which lives on the `users` table — the old realm. The
// people who actually cook are Tacet `tenant_users` with CAPABILITIES. They
// have no login for either screen. The log was unreachable by the only people
// with anything to put in it.
//
// So the door is here, in the realm they are already in, and it takes what they
// can actually count: jars of a store_product, not batches of a recipe. The
// recipe is resolved behind them from store_products.recipe_id where that link
// exists, so the desktop log and its yield stats keep working without a kitchen
// operator ever being shown the word "recipe".
//
// ── WHAT MAKES IT WORTH A RECORD AT ALL ──────────────────────────────────────
//
// Made and shelved are two numbers. Make 20, break 2, shelve 18: the stock
// ledger only ever sees 18 arrive, and has no way to know 20 existed. The two
// broken jars are invisible — not "recorded as a small loss", invisible, with
// nothing anywhere disagreeing with the idea that 18 were made.
//
// This endpoint records both, and refuses to accept a gap without a reason,
// because an unexplained gap is worse than no gap: 20 asked, 18 shelved reads
// identically whether two broke or the batch simply came out small, and those
// are different facts about the kitchen. The vocabulary is the waste module's
// own (routes/retail-waste REASONS) rather than a second list invented here —
// that file's header records how a private reason list is exactly how the old
// kitchen screen ended up with codes that existed only in a browser.
//
// ── WHAT IT DELIBERATELY DOES NOT DO YET ─────────────────────────────────────
//
// A loss recorded here does NOT yet write a waste_records row. It should: a
// broken jar is a real cost and belongs in the ledger where every other loss
// already lives. Doing it properly means reusing retail-waste's costing
// (productUnitCostYuan / resolveCostCents / linkLedgerToWaste), which are
// private to that file — so it is either an extraction from a money-touching
// module, or a second copy of cost logic that will drift. Neither belongs in
// the same change that first moves stock from this route. The gap and its
// reason are recorded here in the meantime, so nothing is lost while the link
// is built; see gap_reason on production_batches.
//
// NOTE FOR WHOEVER BUILDS THAT: the arithmetic changes when it lands. Today
// this adds qty_shelved. With waste wired it must add qty_MADE and then waste
// the gap, because waste_records SUBTRACTS — add 18 and waste 2 and the shelf
// ends at 16. Same net, different ledger, and the ledger is the honest one.

const express = require('express');
const { tdb } = require('../lib/tenant-db');
const inventory = require('../lib/inventory');
const { logActivity } = require('../middleware/auth');
const { requireRetailAdmin } = require('./retail');
const { REASONS } = require('./retail-waste');

const router = express.Router();

/* THE GAP VOCABULARY. The waste codes, plus one that is NOT a loss.
 *
 * `made_fewer` is the whole reason this is a picker rather than a checkbox.
 * "20 asked, 18 shelved" is two different mornings — two jars broke, or the
 * batch came out at eighteen — and they are the same two numbers. Merging them
 * would make every yield figure a guess and every waste total an overstatement.
 * It must never be summed as a loss. */
const NOT_A_LOSS = 'made_fewer';
const GAP_REASONS = REASONS.map(r => r.code).concat([NOT_A_LOSS]);
const GAP_CODES = new Set(GAP_REASONS);

// Kitchen operators are add-only everywhere else (routes/retail-inventory
// answers `kitchen_add_only` to anything but a delta) and this route keeps that
// shape: it only ever adds. There is no negative path here at all — a
// correction to a shelf is a recount, which is a different job and a different
// capability.
function positiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function zeroOrMore(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// GET the reason list, so the screen reads it from the server rather than
// keeping a copy that drifts out of step with the waste module's.
router.get('/api/retail-admin/production/reasons', requireRetailAdmin, (req, res) => {
  res.json({ success: true, data: REASONS.concat([
    { code: NOT_A_LOSS, en: 'Made fewer', cn: '实际制作较少' },
  ]) });
});

/* POST a batch: what was made, what went on the shelf, and why they differ.
 *
 * ONE TRANSACTION, and that is the point of the endpoint existing at all rather
 * than the screen making two calls. A phone on a kitchen wifi that writes the
 * production row and then loses the connection before the stock call has
 * recorded a batch that never reached the shelf — and the operator, who saw a
 * spinner, has no way to tell which half landed. Both, or neither.
 */
router.post('/api/retail-admin/production', requireRetailAdmin, express.json(), (req, res) => {
  const b = req.body || {};
  const storeId = parseInt(b.store_id, 10);
  const productId = parseInt(b.product_id, 10);
  const qtyMade = positiveNumber(b.qty_made);
  // Absent means "all of it reached the shelf" — the normal morning, and the
  // one the screen should never make anybody confirm twice.
  const qtyShelved = b.qty_shelved == null ? qtyMade : zeroOrMore(b.qty_shelved);

  if (!storeId || !inventory.getStore(storeId)) {
    return res.status(404).json({ success: false, error: 'store_not_found' });
  }
  if (qtyMade == null) {
    return res.status(400).json({
      success: false, error: 'qty_made_required',
      message: 'Say how many were made — it must be more than zero.',
    });
  }
  if (qtyShelved == null) {
    return res.status(400).json({ success: false, error: 'qty_shelved_invalid' });
  }
  // MORE ON THE SHELF THAN WAS MADE IS NOT A TYPO WORTH ABSORBING. Silently
  // clamping would put units on a shelf that this record then denies exist.
  if (qtyShelved > qtyMade) {
    return res.status(400).json({
      success: false, error: 'shelved_exceeds_made',
      message: 'More went on the shelf than was made. Check the two numbers.',
    });
  }

  const product = tdb().prepare(
    'SELECT id, name_en, name_cn, sku, recipe_id FROM store_products WHERE id = ?'
  ).get(productId);
  if (!product) return res.status(404).json({ success: false, error: 'product_not_found' });

  // A GAP WITHOUT A REASON IS REFUSED, not stored as a mystery. This is the one
  // question this screen asks that the old flow never did, and answering it is
  // what makes the difference between a yield figure and a shrug.
  const gap = qtyMade - qtyShelved;
  let gapReason = null;
  if (gap > 0) {
    gapReason = String(b.gap_reason || '').trim();
    if (!GAP_CODES.has(gapReason)) {
      return res.status(400).json({
        success: false, error: 'gap_reason_required',
        message: 'Some of what was made did not reach the shelf — say why.',
        reasons: GAP_REASONS,
      });
    }
  }

  // Store scope, the same rule the stock route keeps: a restricted operator
  // acts on their own store and nobody else's.
  const backendRole = req.backendUser && req.backendUser.role;
  const restricted = backendRole === 'kitchen' || backendRole === 'store_stock';
  if (restricted && storeId !== req.backendUser.retail_store_id) {
    return res.status(403).json({ success: false, error: 'store_not_assigned' });
  }

  const conn = tdb();
  const actorId = req.user?.id || null;
  const actorLabel = req.user?.display_name || req.user?.username || null;
  // The name is snapshotted into recipe_name because that column is NOT NULL
  // and is what the desktop log prints. For a product-shaped row the honest
  // snapshot is the product's own name — it is what was made.
  const madeName = product.name_en || product.name_cn || ('#' + product.id);
  const requestId = parseInt(b.request_id, 10) || null;
  const today = new Date().toISOString().slice(0, 10);

  try {
    const out = conn.transaction(() => {
      const ins = conn.prepare(`
        INSERT INTO production_batches
          (date, recipe_id, recipe_name, recipe_sku, servings_made, notes, created_by,
           store_id, product_id, qty_made, qty_shelved, gap_reason, request_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        today, product.recipe_id || null, madeName, product.sku || null,
        qtyMade, b.note || null, actorId,
        storeId, product.id, qtyMade, qtyShelved, gapReason, requestId
      );
      const batchId = Number(ins.lastInsertRowid);

      // The shelf. Reuses adjustStock exactly as the Add stock screen does, so
      // this lands in the same ledger and fans out to Meituan / Eleme /
      // gzgrocery through enqueueChannelSync — stock that rises here and not
      // there is live underselling.
      let stock = null;
      if (qtyShelved > 0) {
        stock = inventory.adjustStock({
          storeId, productId: product.id, deltaQty: qtyShelved,
          actorUserId: actorId, actorLabel,
          reason: 'kitchen_add',
          // Names the batch, so a ledger row can be traced back to the morning
          // it came from rather than matched by eye on a timestamp.
          note: `production #${batchId}`,
        });
      }
      return { batchId, stock };
    })();

    logActivity(actorId, actorLabel, 'log_production', 'production_batch', out.batchId,
      { store_id: storeId, product: madeName, qty_made: qtyMade, qty_shelved: qtyShelved,
        gap_reason: gapReason, request_id: requestId }, req.ip);

    res.json({ success: true, data: {
      id: out.batchId,
      qty_made: qtyMade, qty_shelved: qtyShelved,
      gap, gap_reason: gapReason,
      // A kitchen operator is never sent a shelf total (routes/retail-inventory
      // strips quantities from their product list for the same reason) — what
      // comes back is what THEY just did, not what the shelf now holds.
      product: { id: product.id, name_en: product.name_en, name_cn: product.name_cn, sku: product.sku },
    } });
  } catch (e) {
    res.status(500).json({ success: false, error: 'production_log_failed', message: e.message });
  }
});

module.exports = router;
module.exports.GAP_REASONS = GAP_REASONS;
module.exports.NOT_A_LOSS = NOT_A_LOSS;
