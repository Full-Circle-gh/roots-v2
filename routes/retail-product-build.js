// Product build lines — Step 2 of docs/tacet-product-build-lines-design.md.
// The table and the write path only. No screen consumes this yet — Step 3 is
// a separate PR, briefed to Claude Design separately.
//
// §31's addendum (docs/tacet-consolidation-decisions.md): a build line is a
// product's ONLY cost source once it has one. This file writes
// product_build_lines and store_products.unit_cost follows through the
// existing lib/recipe-rollup.js recompute network — it never writes
// unit_cost directly, the same discipline the recipe-link route
// (routes/retail.js) already holds.
//
// recipe_id IS NOT TOUCHED HERE, EITHER DIRECTION. A product can have both a
// recipe_id (kept for the allergen rollup — §31's addendum) and build lines;
// this file's job is only the build list, never the link.
//
// tdb() (lib/tenant-db.js), not a bare `db`, matching routes/retail-waste.js
// — the closest real precedent, a table built the same way that also FKs
// into store_products, the tenant-scoped catalogue (B.5).

'use strict';

const express = require('express');
const { tdb } = require('../lib/tenant-db');
const { requireRetailAdmin } = require('./retail');
const { computeProductBuildCost } = require('../lib/product-build-cost');
const { fireRecompute } = require('../lib/recipe-rollup');

const router = express.Router();

// One product's build list plus a cost preview computed from the CURRENTLY
// STORED lines (never a form draft) — the identical figure
// applyProductBuildCosts() would write on the next recompute pass, so a
// screen showing this can never disagree with what unit_cost actually holds.
router.get('/api/retail-admin/products/:id/build-lines', requireRetailAdmin, (req, res) => {
  const db = tdb();
  const id = Number(req.params.id);
  const product = db.prepare('SELECT id, name_en, unit_cost FROM store_products WHERE id = ?').get(id);
  if (!product) return res.status(404).json({ success: false, error: 'not_found' });

  const lines = db.prepare(`
    SELECT pbl.id, pbl.ingredient_id, pbl.name_en, pbl.name_cn, pbl.sku, pbl.qty, pbl.unit,
           pbl.notes, pbl.sort_order,
           i.item_kind AS material_item_kind, i.cost_per_unit AS material_cost_per_unit,
           i.unit AS material_unit, i.free_by_design AS material_free_by_design,
           COALESCE(i.is_active, 1) AS material_is_active
      FROM product_build_lines pbl
      LEFT JOIN ingredients i ON i.id = pbl.ingredient_id
     WHERE pbl.product_id = ?
     ORDER BY pbl.sort_order
  `).all(id);

  const cost = computeProductBuildCost(id, db);
  res.json({
    success: true,
    data: { product_id: id, name_en: product.name_en, unit_cost: product.unit_cost, lines, cost },
  });
});

// Save — delete-all + reinsert, mirroring recipe_ingredients' own save
// pattern (routes/recipes.js, routes/retail-recipes.js). Simpler than
// diffing an existing list against a submitted one, and it is the
// established shape for exactly this parent/child relationship — Step 2
// should not invent a second one (design doc §1).
router.put('/api/retail-admin/products/:id/build-lines', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const id = Number(req.params.id);
  const product = db.prepare('SELECT id, name_en FROM store_products WHERE id = ?').get(id);
  if (!product) return res.status(404).json({ success: false, error: 'not_found' });

  const lines = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];
  for (const l of lines) {
    const qty = Number(l && l.qty);
    if (!(qty > 0)) {
      return res.status(400).json({ success: false, error: 'invalid_qty',
        message: `"${(l && l.name_en) || 'a line'}" needs a quantity greater than zero.` });
    }
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM product_build_lines WHERE product_id = ?').run(id);
    const ins = db.prepare(`INSERT INTO product_build_lines
      (product_id, ingredient_id, name_en, name_cn, sku, qty, unit, notes, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    lines.forEach((l, i) => {
      ins.run(id, l.ingredient_id || null, l.name_en || '', l.name_cn || null, l.sku || null,
        Number(l.qty), l.unit || 'g', l.notes || null, i);
    });
  });
  tx();

  // Recompute now, in the same request, so unit_cost reflects this save
  // immediately rather than waiting for an unrelated material price change
  // to trigger the next pass — the same discipline a recipe save already
  // follows via ensureMaterialized()'s neighbouring fireRecompute() call.
  const rollup = fireRecompute(db, { source: 'product-build.update', product_id: id });

  const row = db.prepare('SELECT id, unit_cost FROM store_products WHERE id = ?').get(id);
  res.json({ success: true, data: row, rollup });
});

module.exports = router;
