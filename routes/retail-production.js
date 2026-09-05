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
// ── A SHORT BATCH IS A LOSS, AND IT LANDS IN THE LOSS LEDGER ─────────────────
//
// Two of twenty jars broke. That is a real cost, and it belongs in
// waste_records beside every other loss rather than in a private column on this
// table that nothing totals. So a gap with a LOSS reason writes a waste row
// through lib/waste-record.js — the same costing, the same refuse-do-not-clamp
// guard and the same ledger link the waste screen uses, extracted rather than
// copied so the two cannot drift.
//
// WHICH MEANS THE ARITHMETIC IS: ADD WHAT WAS MADE, THEN WASTE THE GAP.
// waste_records SUBTRACTS — it is a movement off a shelf — so adding 18 and
// wasting 2 would land the shelf on 16. Adding 20 and wasting 2 lands it on 18,
// which is where it actually is, and leaves a ledger that reads the way the
// morning went: twenty arrived, two were destroyed. It also satisfies the
// insufficient_stock guard by construction, since the units are on the shelf
// before the loss is taken off it.
//
// `made_fewer` IS NOT A LOSS AND IS NORMALISED AWAY. If the batch simply came
// out at eighteen, nothing was destroyed and qty_made IS eighteen — so the
// server rewrites qty_made down to qty_shelved rather than recording twenty
// made and two lost. The shortfall against what was ASKED for is still there,
// on the request. This is the one place the client's numbers are overruled, and
// it is overruled because the client cannot know the difference: it sends
// max(asked, shelved) for both, and only the reason says which happened.

const express = require('express');
const { tdb } = require('../lib/tenant-db');
const inventory = require('../lib/inventory');
const { recordProductWaste } = require('../lib/waste-record');
const { businessDateForLocation } = require('../lib/business-date');
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

  /* A gap that is a LOSS, separated from a gap that is a smaller batch. Only the
     first destroys anything, and only the first belongs in the waste ledger. */
  const isLoss = gap > 0 && gapReason && gapReason !== NOT_A_LOSS;
  // Nothing was destroyed, so what was made IS what was shelved. See the header.
  const madeQty = (gap > 0 && gapReason === NOT_A_LOSS) ? qtyShelved : qtyMade;
  const lossQty = isLoss ? gap : 0;

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
        madeQty, b.note || null, actorId,
        storeId, product.id, madeQty, qtyShelved, gapReason, requestId
      );
      const batchId = Number(ins.lastInsertRowid);

      // EVERYTHING THAT WAS MADE GOES ON FIRST, including the part that is about
      // to be written off. Reuses adjustStock exactly as the Add stock screen
      // does, so this lands in the same ledger and fans out to Meituan / Eleme /
      // gzgrocery through enqueueChannelSync — stock that rises here and not
      // there is live underselling.
      if (madeQty > 0) {
        inventory.adjustStock({
          storeId, productId: product.id, deltaQty: madeQty,
          actorUserId: actorId, actorLabel,
          reason: 'kitchen_add',
          // Names the batch, so a ledger row can be traced back to the morning
          // it came from rather than matched by eye on a timestamp.
          note: `production #${batchId}`,
        });
      }

      // …and then the part that never reached the shelf comes straight back off
      // it, as a costed loss. Same transaction: a batch recorded as twenty with
      // no matching write-off would leave two jars on a shelf that does not have
      // them, which is worse than not recording the loss at all.
      let wasteId = null;
      if (lossQty > 0) {
        wasteId = recordProductWaste({
          db: conn, locationId: storeId, productId: product.id,
          qty: lossQty, unit: null, reason: gapReason,
          note: `production #${batchId}`,
          actor: { id: actorId, label: actorLabel },
          businessDate: businessDateForLocation(conn, storeId),
        });
      }
      return { batchId, wasteId };
    })();

    logActivity(actorId, actorLabel, 'log_production', 'production_batch', out.batchId,
      { store_id: storeId, product: madeName, qty_made: madeQty, qty_shelved: qtyShelved,
        gap_reason: gapReason, waste_id: out.wasteId, request_id: requestId }, req.ip);

    res.json({ success: true, data: {
      id: out.batchId,
      qty_made: madeQty, qty_shelved: qtyShelved,
      gap: madeQty - qtyShelved, gap_reason: gapReason,
      // Named so the screen can say the loss was filed, and so a caller can
      // follow it into the ledger. No COST comes back: a kitchen operator does
      // not hold waste:costs, and a figure they were sent is a figure that has
      // already left the server (routes/retail-waste says the same, at length).
      waste_id: out.wasteId,
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
