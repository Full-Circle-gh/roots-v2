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
           -- buy_price is carried so the SCREEN can tell two very different
           -- states apart: a material nobody has ever priced, and one with a
           -- real purchase price whose per-unit cost was never derived.
           -- Costing reads cost_per_unit and only that (this is not a second
           -- cost path); buy_price is here to make the second case say so
           -- instead of a bare "no cost". Found live on ROOTS Plastic Jar
           -- Stickers — buy_price ¥0.0975, cost_per_unit 0.
           i.buy_price AS material_buy_price,
           i.unit AS material_unit, i.free_by_design AS material_free_by_design,
           COALESCE(i.is_active, 1) AS material_is_active
      FROM product_build_lines pbl
      LEFT JOIN ingredients i ON i.id = pbl.ingredient_id
     WHERE pbl.product_id = ?
     ORDER BY pbl.sort_order
  `).all(id);

  const cost = computeProductBuildCost(id, db);

  // ── THE RECIPE BRIDGE ────────────────────────────────────────────────
  // A product whose contents are cooked reaches its cost through a build
  // line pointing at the MATERIAL its recipe makes (§29 + §31's addendum) —
  // never through recipe_id, which now only carries the allergen rollup.
  // But that material only exists once the recipe has been materialised,
  // and materialisation is opt-in-on-save: 9 of 76 recipe-linked products
  // had one the day this shipped, leaving 67 with no material to pick and
  // nothing on screen explaining why.
  //
  // So the route answers the screen's real question — "is this product's
  // recipe available as something I can add?" — in the three states the
  // screen has to tell apart:
  //   none        no recipe linked at all
  //   ready       linked, materialised, here is the material to add
  //   repack      linked, NOT materialised, and the recipe is a single line —
  //               "one unit is N of that material". Here is that material,
  //               with the recipe's own quantity. See below.
  //   unbuilt     linked, NOT materialised — the recipe must be saved once
  //               before its output can be picked
  // This is read-only. It never materialises anything on a GET, because a
  // screen opening must not write, and because §29's first addendum says a
  // name collision is a human's to resolve, never a side effect.
  //
  // WHY 'repack' EXISTS. 'unbuilt' tells the operator to open the recipe and
  // save it once. After the 2026-08-27 backfill
  // (scripts/backfill_materialize_recipes.js) that instruction is FALSE for
  // every product that still lands here, and reported as such: 122 of 138
  // active recipes now have a material, and all 12 products still without one
  // are a one-line recipe named after the very material it consumes — a
  // REPACK ("one 120g jar is 120g of the bulk turmeric we already buy").
  // ensureMaterialized() refuses those by design and always will: the name is
  // already taken by that same bulk material, and linking the two would make
  // the recipe need its own output (lib/recipe-graph.js's cycle guard). So
  // saving the recipe a hundred times changes nothing, and the bar was
  // sending people to do exactly that.
  //
  // A repack has no made thing to add because there is no made thing — the
  // contents are the bulk material, at the quantity the recipe already
  // states. That quantity is the better number than the product's net-weight
  // text: it is structured, and it is what the kitchen actually costed. So
  // this branch hands the screen the same {material} shape 'ready' does, plus
  // the qty, and the screen's add button does not have to know the difference.
  //
  // ONE LINE IS THE WHOLE TEST — not a name match. Two of the twelve (Coconut
  // Flakes ← "Coconut Flake", BioCurcumin+ (Organic) ← "BioCurcumin+") differ
  // by a plural or a suffix, and a name test would leave exactly those two
  // still reading the false instruction. A one-line recipe means "one unit is
  // N of that thing" whether or not the two share a name, and if the line is
  // a transformation with a yield loss, the recipe's own qty is STILL the
  // right cost — it is what goes in. A one-line recipe that DID materialise
  // never reaches here; it is 'ready' above.
  let recipe = { state: 'none' };
  const prow = db.prepare('SELECT recipe_id FROM store_products WHERE id = ?').get(id);
  if (prow && prow.recipe_id != null) {
    const r = db.prepare('SELECT id, name_en, name_cn, is_active FROM recipes WHERE id = ?').get(prow.recipe_id);
    const mat = db.prepare(
      'SELECT id, name_en, name_cn, sku, unit, cost_per_unit, free_by_design, item_kind FROM ingredients WHERE source_recipe_id = ?'
    ).get(prow.recipe_id);

    // The repack read, only when there is no material to offer already.
    let sole = null;
    if (!mat) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM recipe_ingredients WHERE recipe_id = ?').get(prow.recipe_id);
      if (n && n.n === 1) {
        // COALESCE(is_active,1) = 1 — a line pointing at an archived or
        // deleted material is not something to offer as this product's
        // contents; it falls through to 'unbuilt' and says so honestly.
        sole = db.prepare(`
          SELECT i.id, i.name_en, i.name_cn, i.sku, i.unit, i.cost_per_unit,
                 i.free_by_design, i.item_kind, ri.qty AS recipe_qty, ri.unit AS recipe_unit
            FROM recipe_ingredients ri
            JOIN ingredients i ON i.id = ri.ingredient_id
           WHERE ri.recipe_id = ? AND COALESCE(i.is_active, 1) = 1`).get(prow.recipe_id) || null;
      }
    }

    const offered = mat || sole;
    const already = offered ? lines.some(l => l.ingredient_id === offered.id) : false;
    recipe = {
      state: mat ? 'ready' : (sole ? 'repack' : 'unbuilt'),
      recipe_id: prow.recipe_id,
      name_en: r ? r.name_en : null,
      name_cn: r ? r.name_cn : null,
      recipe_active: r ? !!r.is_active : false,
      material: offered || null,
      // Only a repack carries one: it is the recipe's own line quantity, and
      // 'ready' has no equivalent fact to offer (a made material's fill
      // weight is the product's, not the recipe's).
      qty: sole ? sole.recipe_qty : null,
      qty_unit: sole ? (sole.recipe_unit || sole.unit || 'g') : null,
      // Already on the list — the screen must not offer to add it twice.
      already_in_list: already,
    };
  }

  res.json({
    success: true,
    data: { product_id: id, name_en: product.name_en, unit_cost: product.unit_cost, lines, cost, recipe },
  });
});

// ── The build-list material picker ───────────────────────────────────────
//
// Its OWN endpoint rather than a flag on /api/retail-admin/materials, because
// what it needs is a different ORDER, and ordering is the one thing a shared
// list route cannot be talked into changing for one caller without changing
// it for every caller.
//
// WHY NOT JUST ALPHABETICAL, WHICH IS WHAT THE SHARED ROUTE GIVES: a build
// list is mostly packaging, the packaging is the same dozen jars and labels
// over and over, and there are 630 materials to type past. Ash asked for
// either a packaging-only picker or "the most popular one on top". Popularity
// is the better of the two and it is why: a packaging-only mode needs the
// operator to declare which kind they are adding BEFORE they search, which is
// a mode, and modes are what §31's one-mechanism rule keeps out — a build line
// is a build line. Ranking by what this business actually builds with gets the
// same jars to the top without asking anybody anything, and it keeps a food
// material one keystroke away instead of behind a toggle.
//
// The rank is USE COUNT ACROSS EVERY BUILD LIST — the real signal, not a
// guess. A material nobody has built with yet sorts by name, so a first-time
// list is exactly as usable as it is today and gets better as it is used.
router.get('/api/retail-admin/product-build/materials', requireRetailAdmin, (req, res) => {
  const db = tdb();
  const q = String((req.query && req.query.search) || '').trim();
  if (!q) return res.json({ success: true, data: [], matched: 0 });

  const like = `%${q}%`;
  // source_recipe_id marks a material that only exists as a recipe's own
  // materialised stand-in (§29) — never something staff bought or would buy.
  // A search for a real ingredient's name easily collides with one of these
  // (a recipe and the material it's built from are often named alike, e.g.
  // "Dates (Nour)" the recipe stand-in vs "Nour Dates (retail)" the actual
  // purchasable item), and with no visual difference in the list the two read
  // as interchangeable when they are not — one has a supplier and a buy
  // price, the other cannot. Ranked after everything else (rather than
  // filtered out entirely: a stand-in IS occasionally the right pick, via
  // this same picker, for a product whose own recipe makes it) and flagged
  // so the front end can label it.
  const rows = db.prepare(`
    SELECT i.id, i.name_en, i.name_cn, i.sku, i.unit, i.cost_per_unit, i.buy_price,
           i.free_by_design, i.item_kind, i.source_recipe_id,
           (SELECT COUNT(*) FROM product_build_lines pbl WHERE pbl.ingredient_id = i.id) AS use_count
      FROM ingredients i
     WHERE COALESCE(i.is_active, 1) = 1
       AND (i.name_en LIKE ? OR i.name_cn LIKE ? OR i.sku LIKE ?)
     ORDER BY (i.source_recipe_id IS NOT NULL) ASC, use_count DESC, i.name_en COLLATE NOCASE
  `).all(like, like, like);

  // The screen shows 8. The count of what MATCHED is sent whole, so the hint
  // line can say "8 of 34" honestly rather than implying 34 is all there is.
  res.json({ success: true, data: rows.slice(0, 8), matched: rows.length });
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
